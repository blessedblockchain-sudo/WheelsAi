/**
 * report: a usage report for the organization or one agent, optionally
 * summarised by the agent and delivered.
 *
 * Sections come from injected loaders, each of which returns null when
 * it found nothing for the period. A null section is written as
 * `{ no_data: true }`: a report must not show zero requests and zero cost
 * for a period nothing was measured in, as if that were a measurement.
 *
 * Delivery, when asked for:
 *   webhookEvent     a signed `report.generated` event to the
 *                    organization's webhooks (delivery is logged there)
 *   alertChannelId   one of the organization's alert channels. Slack,
 *                    Discord and webhook channels are posted to. An email
 *                    channel is used only when an email provider is
 *                    configured; otherwise the task FAILS saying so. The
 *                    report is never marked delivered on the strength of
 *                    a log line.
 *
 * A delivery failure fails the task, and the report itself is kept on
 * the failed execution.
 *
 * Pure: loaders, the summariser, the event emitter and the senders are
 * injected.
 */

import {
  EMAIL_UNAVAILABLE_REASON,
  type ReportPayload,
} from "../scheduledTaskTypes.js";
import type { ScheduledTaskForExecution, TaskResult, TaskRunContext } from "./context.js";
import { isAbort, permanentFailure, TaskError } from "./taskError.js";

export interface ReportWindow {
  orgId: string;
  /** Null: the whole organization. */
  agentId: string | null;
  since: Date;
  until: Date;
}

export interface ReportUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  errors: number;
  avgLatencyMs: number;
}

export interface ReportRuns {
  scheduledTasks: { total: number; success: number; failed: number };
  /** Null in an agent-scoped report: a workflow run belongs to no single agent. */
  workflows: { total: number; completed: number; failed: number } | null;
  graphs: { total: number; completed: number; failed: number };
}

export interface ReportConversations {
  conversations: number;
  messages: number;
  tokens: number;
}

export interface ReportRevenue {
  settledCents: number;
  pendingCents: number;
  refundedCents: number;
  requests: number;
}

export interface ReportChannel {
  id: string;
  name: string;
  type: string;
  isEnabled: boolean;
  config: unknown;
}

export interface ReportMessage {
  title: string;
  text: string;
}

export interface ReportDeps {
  /** Each loader: null when there is nothing for the window. */
  loadUsage: (window: ReportWindow) => Promise<ReportUsage | null>;
  loadCostByModel: (
    window: ReportWindow,
  ) => Promise<Array<{ modelId: string; costCents: number; requests: number }> | null>;
  loadRuns: (window: ReportWindow) => Promise<ReportRuns | null>;
  loadConversations: (window: ReportWindow) => Promise<ReportConversations | null>;
  loadRevenue: (window: ReportWindow) => Promise<ReportRevenue | null>;
  /** One model call through the shared agent chat (metered like any run). */
  summarize: (args: {
    agentId: string;
    orgId: string;
    prompt: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  emitReportEvent: (orgId: string, data: Record<string, unknown>) => Promise<void>;
  /** Org-scoped. */
  loadAlertChannel: (channelId: string, orgId: string) => Promise<ReportChannel | null>;
  emailConfigured: () => boolean;
  /** Posts to a Slack, Discord or webhook channel; throws on a non-2xx. */
  sendToChannel: (channel: ReportChannel, message: ReportMessage) => Promise<void>;
  /** Sends to every address of an email channel; throws when one fails. */
  sendEmail: (channel: ReportChannel, message: ReportMessage) => Promise<void>;
}

const NO_DATA = { no_data: true } as const;
const POSTABLE = new Set(["slack", "discord", "webhook"]);
/** The event payload is a notification, not an archive. */
const EVENT_SUMMARY_MAX = 4000;

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function renderText(report: {
  period: { days: number; since: string; until: string };
  scope: { type: string; agentId: string | null };
  no_data: boolean;
  usage: ReportUsage | typeof NO_DATA;
  costByModel: Array<{ modelId: string; costCents: number; requests: number }> | typeof NO_DATA;
  runs: ReportRuns | typeof NO_DATA;
  conversations: ReportConversations | typeof NO_DATA;
  revenue: ReportRevenue | typeof NO_DATA;
  summary: string | null;
}): string {
  const lines: string[] = [
    `Period: last ${report.period.days} day(s), ${report.period.since} to ${report.period.until}`,
    `Scope: ${report.scope.type === "agent" ? `agent ${report.scope.agentId}` : "organization"}`,
  ];
  if (report.no_data) {
    lines.push("No activity was recorded in this period.");
    return lines.join("\n");
  }
  const section = <T>(label: string, value: T | typeof NO_DATA, render: (v: T) => string) =>
    lines.push(`${label}: ${"no_data" in (value as object) ? "no data" : render(value as T)}`);

  section("Model usage", report.usage, (u) =>
    `${u.requests} requests, ${u.inputTokens + u.outputTokens} tokens, ${dollars(u.costCents)}, ${u.errors} errors`,
  );
  section("Cost by model", report.costByModel, (rows) =>
    rows.map((r) => `${r.modelId} ${dollars(r.costCents)} (${r.requests})`).join(", "),
  );
  section("Runs", report.runs, (r) =>
    [
      `scheduled ${r.scheduledTasks.success}/${r.scheduledTasks.total} ok`,
      ...(r.workflows ? [`workflows ${r.workflows.completed}/${r.workflows.total} ok`] : []),
      `graphs ${r.graphs.completed}/${r.graphs.total} ok`,
    ].join(", "),
  );
  section("Conversations", report.conversations, (c) =>
    `${c.conversations} conversations, ${c.messages} messages`,
  );
  section("Marketplace revenue", report.revenue, (r) =>
    `${dollars(r.settledCents)} settled, ${dollars(r.pendingCents)} pending, ${dollars(r.refundedCents)} refunded`,
  );
  if (report.summary) lines.push("", report.summary);
  return lines.join("\n");
}

export async function runReport(
  task: ScheduledTaskForExecution,
  payload: ReportPayload,
  ctx: TaskRunContext,
  deps: ReportDeps,
): Promise<TaskResult> {
  if (payload.scope === "agent" && !task.agentId) {
    throw permanentFailure("an agent-scoped report needs an agent on the task");
  }
  if (payload.summarize && !task.agentId) {
    throw permanentFailure("summarize needs an agent on the task: that agent writes the summary");
  }

  const window: ReportWindow = {
    orgId: task.orgId,
    agentId: payload.scope === "agent" ? task.agentId : null,
    since: new Date(ctx.now.getTime() - payload.periodDays * 86_400_000),
    until: ctx.now,
  };

  const [usage, costByModel, runs, conversations, revenue] = await Promise.all([
    deps.loadUsage(window),
    deps.loadCostByModel(window),
    deps.loadRuns(window),
    deps.loadConversations(window),
    deps.loadRevenue(window),
  ]);
  const nothing = [usage, costByModel, runs, conversations, revenue].every((s) => s === null);

  const report = {
    period: {
      days: payload.periodDays,
      since: window.since.toISOString(),
      until: window.until.toISOString(),
    },
    scope: { type: payload.scope, agentId: window.agentId },
    no_data: nothing,
    usage: usage ?? NO_DATA,
    costByModel: costByModel ?? NO_DATA,
    runs: runs ?? NO_DATA,
    conversations: conversations ?? NO_DATA,
    revenue: revenue ?? NO_DATA,
    summary: null as string | null,
    summaryNote: undefined as string | undefined,
  };

  if (payload.summarize && task.agentId) {
    if (nothing) {
      // No model call is spent describing an empty period.
      report.summaryNote = "not summarised: there was no activity to summarise";
    } else {
      if (ctx.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      report.summary = await deps.summarize({
        agentId: task.agentId,
        orgId: task.orgId,
        prompt:
          "Write a short plain-text summary (at most 150 words) of this usage report for the " +
          "team that owns it. State the figures that matter and anything unusual. Use only " +
          "the data given; a section marked no_data had no activity.\n\n" +
          JSON.stringify({ ...report, summary: undefined, summaryNote: undefined }),
        signal: ctx.signal,
      });
    }
  }

  const title = `Report: ${task.name}`;
  const text = renderText(report);
  const delivery: Array<Record<string, unknown>> = [];
  const output = { ...report, delivery };

  const deliver = payload.deliver;
  // The channel goes first: emitting the event cannot fail the task, so a
  // retry after a failed post does not send the event twice.
  if (deliver?.alertChannelId) {
    const channel = await deps.loadAlertChannel(deliver.alertChannelId, task.orgId);
    const undelivered = (reason: string) =>
      permanentFailure(`report was generated but not delivered: ${reason}`, output);
    if (!channel) throw undelivered("alert channel not found in this organization");
    if (!channel.isEnabled) throw undelivered(`alert channel "${channel.name}" is disabled`);

    if (channel.type === "email") {
      if (!deps.emailConfigured()) throw undelivered(EMAIL_UNAVAILABLE_REASON);
    } else if (!POSTABLE.has(channel.type)) {
      throw undelivered(`a ${channel.type} channel cannot carry a report`);
    }
    try {
      if (channel.type === "email") await deps.sendEmail(channel, { title, text });
      else await deps.sendToChannel(channel, { title, text });
    } catch (err) {
      if (isAbort(err, ctx.signal)) throw err;
      throw new TaskError(
        `report was generated but not delivered to "${channel.name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
        { output },
      );
    }
    delivery.push({
      via: "alert_channel",
      channelId: channel.id,
      type: channel.type,
      status: "sent",
    });
  }

  if (deliver?.webhookEvent) {
    await deps.emitReportEvent(task.orgId, {
      taskId: task.id,
      taskName: task.name,
      executionId: ctx.executionId,
      period: report.period,
      scope: report.scope,
      no_data: report.no_data,
      usage: report.usage,
      costByModel: report.costByModel,
      runs: report.runs,
      conversations: report.conversations,
      revenue: report.revenue,
      summary: report.summary ? report.summary.slice(0, EVENT_SUMMARY_MAX) : null,
    });
    delivery.push({ via: "webhook_event", event: "report.generated", status: "emitted" });
  }

  return { output };
}
