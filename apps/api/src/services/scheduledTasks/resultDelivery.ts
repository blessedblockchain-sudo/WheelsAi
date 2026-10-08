/**
 * Sends the result of a finished agent run to the one place its task names
 * (payload.deliver.alertChannelId), and says how that went.
 *
 * For the task types agent_run and inference only. A report delivers itself
 * (report.ts) and must never be sent twice, so any other type gets an empty
 * list and no call at all.
 *
 * What comes back is the list to store in TaskExecution.delivery: one record
 * per place, today at most one.
 *
 *   sent      the place took the message
 *   failed    the place refused it or could not be reached
 *   skipped   nothing was tried: email delivery is not configured here, or
 *             the place was removed or turned off
 *
 * A delivery is never part of the run. This function does not throw for a
 * delivery problem and returns nothing that could change a run's status or
 * cause another attempt: the caller stores the record and moves on. (A
 * report is the other way round: a failed delivery fails the task and so
 * re-runs it. That is left as it is and not copied here.)
 *
 * It takes the text as an argument and reads no execution, so the same
 * function serves "Send again": posting a stored result, running nothing.
 *
 * A reason is a short plain phrase written to follow "Not sent to <name>: ".
 * It is never a raw error, a link or an address: the record is shown on the
 * Runs tab and stored on the execution.
 *
 * Pure: the channel loader and the senders are injected.
 */

import type { ReportChannel } from "./report.js";
import { ChannelDeliveryError, type ChannelMessage } from "./reportDelivery.js";

export type DeliveryStatus = "sent" | "failed" | "skipped";

/** One entry of TaskExecution.delivery. */
export interface DeliveryRecord {
  channelId: string;
  /** The place's name when it was tried; "" when it could not be read. */
  name: string;
  /** slack, discord, webhook or email; "unknown" when it could not be read. */
  type: string;
  status: DeliveryStatus;
  /** Present unless the status is sent. */
  reason?: string;
  /** When this was tried, as an ISO instant. */
  at: string;
}

/** The phrases a record can carry. */
export const DELIVERY_REASONS = {
  emailOff: "email delivery is temporarily unavailable",
  removed: "this place was removed",
  turnedOff: "this place is turned off",
  unsupported: "this kind of place cannot receive results",
  empty: "the run produced no text to send",
  refused: "it did not accept the message",
  unreachable: "it could not be reached",
  notSetUp: "it is not set up completely",
  emailFailed: "the email could not be sent",
  lookupFailed: "the place could not be looked up just now",
} as const;

export interface ResultDeliveryDeps {
  /** Org-scoped: a channel of another organization is never returned. */
  loadAlertChannel: (channelId: string, orgId: string) => Promise<ReportChannel | null>;
  emailConfigured: () => boolean;
  /** Posts to a Slack, Discord or webhook channel; throws when it is not taken. */
  sendToChannel: (channel: ReportChannel, message: ChannelMessage) => Promise<void>;
  /** Sends to every address of an email channel; throws when one fails. */
  sendEmail: (channel: ReportChannel, message: ChannelMessage) => Promise<void>;
  now?: () => Date;
}

export interface DeliverResultArgs {
  orgId: string;
  task: { name: string; taskType: string; payload: unknown };
  /** `finishedAt` is the run's completedAt; null when it is not known. */
  execution: { id: string; finishedAt: Date | null };
  /** The run's answer (TaskExecution.output.content). */
  text: string;
}

/** The task types whose result this delivers. */
export const RESULT_DELIVERY_TASK_TYPES: readonly string[] = ["agent_run", "inference"];

const POSTABLE = new Set(["slack", "discord", "webhook"]);

/**
 * The channel a task sends its result to, or null: no deliver setting, or a
 * task type that is not delivered here.
 */
export function resultChannelIdOf(task: { taskType: string; payload: unknown }): string | null {
  if (!RESULT_DELIVERY_TASK_TYPES.includes(task.taskType)) return null;
  const payload = task.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const deliver = (payload as Record<string, unknown>).deliver;
  if (typeof deliver !== "object" || deliver === null) return null;
  const channelId = (deliver as Record<string, unknown>).alertChannelId;
  return typeof channelId === "string" && channelId !== "" ? channelId : null;
}

/** A sender's error as a phrase. Nothing of the error itself is kept. */
function failureReason(err: unknown, type: string): string {
  if (err instanceof ChannelDeliveryError) {
    if (err.failure === "refused") return DELIVERY_REASONS.refused;
    if (err.failure === "not_set_up") return DELIVERY_REASONS.notSetUp;
    if (err.failure === "unsupported") return DELIVERY_REASONS.unsupported;
    return DELIVERY_REASONS.unreachable;
  }
  return type === "email" ? DELIVERY_REASONS.emailFailed : DELIVERY_REASONS.unreachable;
}

/**
 * Delivers one result. Returns [] when the task asks for no delivery (and
 * then calls nothing); otherwise one record. Never throws.
 */
export async function deliverResult(
  deps: ResultDeliveryDeps,
  args: DeliverResultArgs,
): Promise<DeliveryRecord[]> {
  const channelId = resultChannelIdOf(args.task);
  if (!channelId) return [];

  const at = (deps.now?.() ?? new Date()).toISOString();
  const record = (
    place: { name: string; type: string },
    status: DeliveryStatus,
    reason?: string,
  ): DeliveryRecord[] => [
    { channelId, name: place.name, type: place.type, status, ...(reason ? { reason } : {}), at },
  ];
  const unread = { name: "", type: "unknown" };

  let channel: ReportChannel | null;
  try {
    channel = await deps.loadAlertChannel(channelId, args.orgId);
  } catch {
    return record(unread, "failed", DELIVERY_REASONS.lookupFailed);
  }
  // Removed, or another organization's: the loader cannot tell them apart
  // and neither may the record.
  if (!channel) return record(unread, "skipped", DELIVERY_REASONS.removed);

  const place = { name: channel.name, type: channel.type };
  try {
    if (!channel.isEnabled) return record(place, "skipped", DELIVERY_REASONS.turnedOff);
    if (channel.type === "email") {
      if (!deps.emailConfigured()) return record(place, "skipped", DELIVERY_REASONS.emailOff);
    } else if (!POSTABLE.has(channel.type)) {
      return record(place, "skipped", DELIVERY_REASONS.unsupported);
    }
    if (args.text.trim() === "") return record(place, "skipped", DELIVERY_REASONS.empty);

    const message: ChannelMessage = {
      kind: "result",
      title: `Result: ${args.task.name}`,
      text: args.text,
      executionId: args.execution.id,
      ...(args.execution.finishedAt
        ? { finishedAt: args.execution.finishedAt.toISOString() }
        : {}),
    };
    if (channel.type === "email") await deps.sendEmail(channel, message);
    else await deps.sendToChannel(channel, message);
    return record(place, "sent");
  } catch (err) {
    return record(place, "failed", failureReason(err, channel.type));
  }
}
