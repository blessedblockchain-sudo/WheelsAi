/**
 * Sends a report, or the result of a finished agent run, to one of an
 * organization's alert channels.
 *
 * The alert pipeline's own sender (monitoring.ts) is private to alerts
 * and its email branch only logs, so a report is delivered here instead,
 * with the same wire formats for Slack, Discord and signed webhooks, and
 * with email going through the real email service or not at all.
 *
 * The message says what it is (`kind`), so the note on a cut message, the
 * sender name and the webhook body fit a result as well as a report. A
 * message with no kind is a report and reads exactly as it always has.
 *
 * Channel URLs are user-supplied: every request goes through the SSRF
 * guard.
 */

import { createHmac } from "node:crypto";

import { safeFetch, SsrfBlockedError, type UrlGuardDeps } from "../../lib/ssrfGuard.js";
import { sanitizeOutboundHeaders } from "../skills/httpLimits.js";
import type { ReportChannel, ReportMessage } from "./report.js";

/** What is being delivered. */
export type DeliveryKind = "report" | "result";

/** A message for a channel. Without `kind` it is a report. */
export interface ChannelMessage extends ReportMessage {
  kind?: DeliveryKind;
  /** A result only: the run it came from, so a webhook receiver can drop a repeat. */
  executionId?: string;
  /** A result only: when that run finished, as an ISO instant. */
  finishedAt?: string;
}

/**
 * Why a send did not happen, for callers that tell the owner in plain words
 * (resultDelivery.ts). The message is the technical one a report's failed
 * execution has always recorded.
 *
 *   refused      the channel answered, and not with a success
 *   unreachable  the URL was refused by the guard
 *   not_set_up   the channel has no URL, or no address
 *   unsupported  this kind of channel cannot carry the message
 */
export type ChannelDeliveryFailure = "refused" | "unreachable" | "not_set_up" | "unsupported";

export class ChannelDeliveryError extends Error {
  constructor(
    readonly failure: ChannelDeliveryFailure,
    message: string,
  ) {
    super(message);
    this.name = "ChannelDeliveryError";
  }
}

export interface ReportDeliveryDeps {
  fetchFn?: typeof fetch;
  guardDeps?: UrlGuardDeps;
  sendEmail: (message: { to: string; subject: string; text: string; html: string }) => Promise<void>;
}

/** Slack and Discord both cut long messages; the cut is stated. */
const CHAT_TEXT_MAX = 3500;

const configOf = (channel: ReportChannel): Record<string, unknown> =>
  typeof channel.config === "object" && channel.config !== null
    ? (channel.config as Record<string, unknown>)
    : {};

const CUT_NOTE: Record<DeliveryKind, string> = {
  report: "\n... (cut; the full report is on the task execution)",
  result: "\n... (cut; the full result is saved on the run in WheelsAI)",
};

const SENDER_NAME: Record<DeliveryKind, string> = {
  report: "WheelsAI Reports",
  result: "WheelsAI Results",
};

function clip(text: string, kind: DeliveryKind): string {
  return text.length > CHAT_TEXT_MAX ? `${text.slice(0, CHAT_TEXT_MAX)}${CUT_NOTE[kind]}` : text;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

async function post(
  url: unknown,
  init: { method?: string; headers?: Record<string, string>; body: string },
  what: string,
  deps: ReportDeliveryDeps,
): Promise<void> {
  if (typeof url !== "string" || url === "") {
    throw new ChannelDeliveryError("not_set_up", `the ${what} channel has no URL configured`);
  }
  let res: Response;
  try {
    res = await safeFetch(url, {
      method: init.method ?? "POST",
      headers: { ...init.headers, "Content-Type": "application/json" },
      body: init.body,
      fetchImpl: deps.fetchFn,
      guardDeps: deps.guardDeps,
    });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      throw new ChannelDeliveryError("unreachable", `${what} URL refused: ${err.publicMessage}`);
    }
    throw err;
  }
  await res.body?.cancel().catch(() => {});
  if (!res.ok) throw new ChannelDeliveryError("refused", `${what} responded ${res.status}`);
}

export function buildReportDelivery(deps: ReportDeliveryDeps) {
  return {
    sendToChannel: async (channel: ReportChannel, message: ChannelMessage): Promise<void> => {
      const config = configOf(channel);
      const kind: DeliveryKind = message.kind ?? "report";
      if (channel.type === "slack") {
        return post(
          config.webhookUrl,
          {
            body: JSON.stringify({
              username: typeof config.username === "string" ? config.username : SENDER_NAME[kind],
              ...(typeof config.channel === "string" ? { channel: config.channel } : {}),
              attachments: [
                { color: "#3b82f6", title: message.title, text: clip(message.text, kind), footer: "WheelsAI" },
              ],
            }),
          },
          "Slack",
          deps,
        );
      }
      if (channel.type === "discord") {
        return post(
          config.webhookUrl,
          {
            body: JSON.stringify({
              embeds: [
                { title: message.title, description: clip(message.text, kind), color: 0x3b82f6, footer: { text: "WheelsAI" } },
              ],
            }),
          },
          "Discord",
          deps,
        );
      }
      if (channel.type === "webhook") {
        const body = JSON.stringify({
          type: kind,
          title: message.title,
          message: message.text,
          timestamp: new Date().toISOString(),
          // A result names its run; a report's body is as it always was.
          ...(kind === "result" && message.executionId ? { executionId: message.executionId } : {}),
          ...(kind === "result" && message.finishedAt ? { finishedAt: message.finishedAt } : {}),
        });
        const headers: Record<string, string> = {
          ...(sanitizeOutboundHeaders(
            typeof config.headers === "object" && config.headers !== null
              ? (config.headers as Record<string, string>)
              : undefined,
          ) ?? {}),
        };
        if (typeof config.secret === "string" && config.secret !== "") {
          // Same scheme as alert notifications to this channel.
          headers["X-Webhook-Signature"] = createHmac("sha256", config.secret)
            .update(body)
            .digest("hex");
        }
        // The message is a body; a channel configured for GET still gets a POST.
        return post(config.url, { headers, body }, "webhook", deps);
      }
      throw new ChannelDeliveryError("unsupported", `a ${channel.type} channel cannot carry a ${kind}`);
    },

    sendEmail: async (channel: ReportChannel, message: ChannelMessage): Promise<void> => {
      const emails = configOf(channel).emails;
      const recipients = Array.isArray(emails)
        ? emails.filter((e): e is string => typeof e === "string" && e.includes("@"))
        : [];
      if (recipients.length === 0) {
        throw new ChannelDeliveryError("not_set_up", "the email channel has no addresses configured");
      }
      for (const to of recipients) {
        await deps.sendEmail({
          to,
          subject: message.title,
          text: message.text,
          html: `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:pre-wrap">${escapeHtml(
            message.text,
          )}</pre>`,
        });
      }
    },
  };
}
