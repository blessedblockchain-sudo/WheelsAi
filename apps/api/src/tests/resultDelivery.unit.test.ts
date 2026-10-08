/**
 * services/scheduledTasks/resultDelivery.ts: sending a finished agent run's
 * result to the one place its task names, and the record of how that went.
 *
 * The senders are the real ones of reportDelivery.ts over a fake fetch and a
 * fake email service, so what a channel receives for a result is tested as
 * the bytes sent. A report's own messages are pinned here too: the sender
 * learned to say what it is delivering, and a report must read as it did.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ReportChannel } from "../services/scheduledTasks/report.js";
import { buildReportDelivery, ChannelDeliveryError } from "../services/scheduledTasks/reportDelivery.js";
import {
  DELIVERY_REASONS,
  deliverResult,
  resultChannelIdOf,
  type DeliverResultArgs,
  type DeliveryRecord,
  type ResultDeliveryDeps,
} from "../services/scheduledTasks/resultDelivery.js";

const ORG = "org-owner";
const OTHER_ORG = "org-other";
const CHANNEL = "66666666-6666-4666-8666-666666666666";
const EXECUTION = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-10-08T12:00:00Z");
const FINISHED = new Date("2026-10-08T11:59:30Z");
const SLACK_URL = "https://hooks.slack.example/T1/secret-path";

interface Request {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function world(
  over: {
    channel?: Partial<ReportChannel> | null;
    /** The organization the stored channel belongs to. */
    channelOrg?: string;
    emailConfigured?: boolean;
    fetchStatus?: number;
    fetchError?: Error;
    emailError?: Error;
    loadError?: Error;
  } = {},
) {
  const requests: Request[] = [];
  const emails: Array<{ to: string; subject: string; text: string }> = [];
  const loads: Array<{ channelId: string; orgId: string }> = [];
  const stored: ReportChannel | null =
    over.channel === null
      ? null
      : {
          id: CHANNEL,
          name: "Team Slack",
          type: "slack",
          isEnabled: true,
          config: { webhookUrl: SLACK_URL },
          ...over.channel,
        };
  const senders = buildReportDelivery({
    fetchFn: (async (url: string, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      if (over.fetchError) throw over.fetchError;
      return new Response(null, { status: over.fetchStatus ?? 200 });
    }) as unknown as typeof fetch,
    guardDeps: { resolveHost: async (host) => (host.includes("internal") ? ["10.1.2.3"] : ["93.184.216.34"]) },
    sendEmail: async (message) => {
      if (over.emailError) throw over.emailError;
      emails.push({ to: message.to, subject: message.subject, text: message.text });
    },
  });
  const deps: ResultDeliveryDeps = {
    // Scoped the way the production loader is: id AND organization.
    loadAlertChannel: async (channelId, orgId) => {
      loads.push({ channelId, orgId });
      if (over.loadError) throw over.loadError;
      return stored && channelId === stored.id && orgId === (over.channelOrg ?? ORG) ? stored : null;
    },
    emailConfigured: () => over.emailConfigured ?? true,
    sendToChannel: senders.sendToChannel,
    sendEmail: senders.sendEmail,
    now: () => NOW,
  };
  return { deps, requests, emails, loads, senders };
}

const args = (over: Partial<DeliverResultArgs> = {}): DeliverResultArgs => ({
  orgId: ORG,
  task: {
    name: "Daily briefing (schedule)",
    taskType: "agent_run",
    payload: { prompt: "Brief me.", deliver: { alertChannelId: CHANNEL } },
  },
  execution: { id: EXECUTION, finishedAt: FINISHED },
  text: "Three things happened today.",
  ...over,
});

const only = (records: DeliveryRecord[]): DeliveryRecord => {
  assert.equal(records.length, 1);
  return records[0]!;
};

/** Nothing a record says may carry a link, an address or an error's own text. */
function assertPlain(record: DeliveryRecord) {
  const text = JSON.stringify(record);
  assert.doesNotMatch(text, /https?:|hooks\.slack|secret-path|@example\.com|ECONN|responded \d|Error/);
}

test("sent: the place gets the result, and the record names the place", async () => {
  const { deps, requests } = world();
  const record = only(await deliverResult(deps, args()));
  assert.deepEqual(record, {
    channelId: CHANNEL,
    name: "Team Slack",
    type: "slack",
    status: "sent",
    at: "2026-10-08T12:00:00.000Z",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, SLACK_URL);
  assert.deepEqual(requests[0]!.body, {
    username: "WheelsAI Results",
    attachments: [
      {
        color: "#3b82f6",
        title: "Result: Daily briefing (schedule)",
        text: "Three things happened today.",
        footer: "WheelsAI",
      },
    ],
  });
});

test("sent: the older task type, a Discord place, a webhook place and an email place", async () => {
  const inference = world();
  assert.equal(only(await deliverResult(inference.deps, args({ task: { ...args().task, taskType: "inference" } }))).status, "sent");

  const discord = world({ channel: { type: "discord", config: { webhookUrl: "https://discord.example/api/webhooks/1" } } });
  assert.equal(only(await deliverResult(discord.deps, args())).type, "discord");
  assert.equal(discord.requests[0]!.body.embeds[0].description, "Three things happened today.");

  const hook = world({ channel: { type: "webhook", config: { url: "https://example.com/in" } } });
  assert.equal(only(await deliverResult(hook.deps, args())).status, "sent");
  const { timestamp, ...body } = hook.requests[0]!.body;
  assert.equal(typeof timestamp, "string");
  assert.deepEqual(body, {
    type: "result",
    title: "Result: Daily briefing (schedule)",
    message: "Three things happened today.",
    executionId: EXECUTION,
    finishedAt: "2026-10-08T11:59:30.000Z",
  });

  const email = world({ channel: { name: "Me", type: "email", config: { emails: ["owner@example.com"] } } });
  const sent = only(await deliverResult(email.deps, args()));
  assert.deepEqual([sent.status, sent.name, sent.type], ["sent", "Me", "email"]);
  assert.deepEqual(email.emails, [
    { to: "owner@example.com", subject: "Result: Daily briefing (schedule)", text: "Three things happened today." },
  ]);
  assertPlain(sent);
});

test("failed: the place refused it; the record says why in plain words and nothing is thrown", async () => {
  const refused = world({ fetchStatus: 404 });
  const record = only(await deliverResult(refused.deps, args()));
  assert.deepEqual(record, {
    channelId: CHANNEL,
    name: "Team Slack",
    type: "slack",
    status: "failed",
    reason: "it did not accept the message",
    at: "2026-10-08T12:00:00.000Z",
  });
  assertPlain(record);

  // The result is the caller's own argument: a failed delivery took nothing from it.
  const given = args();
  await deliverResult(world({ fetchStatus: 500 }).deps, given);
  assert.equal(given.text, "Three things happened today.");
});

test("failed: a place that cannot be reached, is not set up, or whose email fails", async () => {
  const down = only(
    await deliverResult(world({ fetchError: new Error("connect ECONNREFUSED 93.184.216.34:443") }).deps, args()),
  );
  assert.deepEqual([down.status, down.reason], ["failed", DELIVERY_REASONS.unreachable]);
  assertPlain(down);

  const guarded = world({ channel: { config: { webhookUrl: "https://internal.corp.example/hook" } } });
  const blocked = only(await deliverResult(guarded.deps, args()));
  assert.deepEqual([blocked.status, blocked.reason], ["failed", DELIVERY_REASONS.unreachable]);
  assert.equal(guarded.requests.length, 0, "the guarded address was never requested");
  assertPlain(blocked);

  const noLink = only(await deliverResult(world({ channel: { config: {} } }).deps, args()));
  assert.deepEqual([noLink.status, noLink.reason], ["failed", DELIVERY_REASONS.notSetUp]);

  const bounced = only(
    await deliverResult(
      world({
        channel: { type: "email", config: { emails: ["owner@example.com"] } },
        emailError: new Error("Resend 422: owner@example.com is not a valid recipient"),
      }).deps,
      args(),
    ),
  );
  assert.deepEqual([bounced.status, bounced.reason], ["failed", DELIVERY_REASONS.emailFailed]);
  assertPlain(bounced);
});

test("skipped: email delivery is not configured, and no email is attempted", async () => {
  const { deps, emails } = world({
    channel: { name: "Me", type: "email", config: { emails: ["owner@example.com"] } },
    emailConfigured: false,
  });
  const record = only(await deliverResult(deps, args()));
  assert.deepEqual(record, {
    channelId: CHANNEL,
    name: "Me",
    type: "email",
    status: "skipped",
    reason: "email delivery is temporarily unavailable",
    at: "2026-10-08T12:00:00.000Z",
  });
  assert.equal(emails.length, 0);
});

test("skipped: a deleted place, a disabled place, and a kind of place that cannot take a result", async () => {
  const deleted = world({ channel: null });
  assert.deepEqual(only(await deliverResult(deleted.deps, args())), {
    channelId: CHANNEL,
    name: "",
    type: "unknown",
    status: "skipped",
    reason: "this place was removed",
    at: "2026-10-08T12:00:00.000Z",
  });
  assert.equal(deleted.requests.length, 0);

  const disabled = world({ channel: { isEnabled: false } });
  const off = only(await deliverResult(disabled.deps, args()));
  assert.deepEqual([off.status, off.name, off.reason], ["skipped", "Team Slack", "this place is turned off"]);
  assert.equal(disabled.requests.length, 0);

  const pager = world({ channel: { type: "pagerduty", config: { routingKey: "k" } } });
  const unsupported = only(await deliverResult(pager.deps, args()));
  assert.deepEqual([unsupported.status, unsupported.reason], ["skipped", DELIVERY_REASONS.unsupported]);
  assert.equal(pager.requests.length, 0);

  const empty = world();
  assert.deepEqual(
    [only(await deliverResult(empty.deps, args({ text: "  \n" }))).reason, empty.requests.length],
    [DELIVERY_REASONS.empty, 0],
  );
});

test("another organization's channel is never loaded: it reads as a removed place", async () => {
  const { deps, requests, loads } = world({ channelOrg: OTHER_ORG });
  const record = only(await deliverResult(deps, args()));
  assert.deepEqual(loads, [{ channelId: CHANNEL, orgId: ORG }], "the lookup carries the run's own organization");
  assert.deepEqual([record.status, record.name, record.type, record.reason], ["skipped", "", "unknown", "this place was removed"]);
  assert.equal(requests.length, 0, "nothing was sent to the other organization's place");
});

test("no deliver setting means an empty list and no call at all", async () => {
  const payloads: unknown[] = [
    { prompt: "Brief me." },
    { prompt: "Brief me.", deliver: {} },
    { prompt: "Brief me.", deliver: { alertChannelId: "" } },
    { prompt: "Brief me.", deliver: null },
    null,
    "deliver",
  ];
  for (const payload of payloads) {
    const { deps, loads, requests, emails } = world();
    assert.deepEqual(await deliverResult(deps, args({ task: { ...args().task, payload } })), []);
    assert.deepEqual([loads.length, requests.length, emails.length], [0, 0, 0], JSON.stringify(payload));
  }
});

test("a report is never delivered here: it delivers itself and must not be sent twice", async () => {
  const payload = { deliver: { alertChannelId: CHANNEL } };
  for (const taskType of ["report", "webhook", "custom", "workflow_run", "cleanup", "data_sync", "health_check"]) {
    const { deps, loads, requests } = world();
    assert.deepEqual(await deliverResult(deps, args({ task: { name: "Weekly", taskType, payload } })), []);
    assert.deepEqual([loads.length, requests.length], [0, 0], taskType);
    assert.equal(resultChannelIdOf({ taskType, payload }), null);
  }
  assert.equal(resultChannelIdOf({ taskType: "agent_run", payload }), CHANNEL);
  assert.equal(resultChannelIdOf({ taskType: "inference", payload }), CHANNEL);
});

test("a long result is cut the way a report is, with a note that fits a result; email carries it whole", async () => {
  const long = "x".repeat(5000);
  const slack = world();
  assert.equal(only(await deliverResult(slack.deps, args({ text: long }))).status, "sent");
  const sentText: string = slack.requests[0]!.body.attachments[0].text;
  assert.equal(sentText, `${"x".repeat(3500)}\n... (cut; the full result is saved on the run in WheelsAI)`);

  // The same text as a report: the same cut, the report's own note.
  await slack.senders.sendToChannel(
    { id: CHANNEL, name: "ops", type: "slack", isEnabled: true, config: { webhookUrl: SLACK_URL } },
    { title: "Report: Weekly", text: long },
  );
  assert.equal(
    slack.requests[1]!.body.attachments[0].text,
    `${"x".repeat(3500)}\n... (cut; the full report is on the task execution)`,
  );

  const email = world({ channel: { type: "email", config: { emails: ["owner@example.com"] } } });
  await deliverResult(email.deps, args({ text: long }));
  assert.equal(email.emails[0]!.text.length, 5000);
});

test("nothing thrown by a sender or the loader escapes", async () => {
  const throwing: Array<Partial<ResultDeliveryDeps>> = [
    { sendToChannel: async () => { throw new Error(`POST ${SLACK_URL} failed`); } },
    { sendToChannel: async () => { throw "a string, not an error"; } },
    { sendToChannel: () => { throw new TypeError("sync throw"); } },
    { sendToChannel: async () => { throw new ChannelDeliveryError("refused", "Slack responded 410"); } },
    { emailConfigured: () => { throw new Error("config read failed"); } },
  ];
  for (const over of throwing) {
    const { deps } = world({ channel: over.emailConfigured ? { type: "email", config: { emails: ["a@example.com"] } } : {} });
    const record = only(await deliverResult({ ...deps, ...over }, args()));
    assert.equal(record.status, "failed");
    assertPlain(record);
  }

  const { deps, requests } = world({ loadError: new Error("connection to 10.0.0.5:5432 lost") });
  const record = only(await deliverResult(deps, args()));
  assert.deepEqual([record.status, record.reason, record.name], ["failed", DELIVERY_REASONS.lookupFailed, ""]);
  assert.doesNotMatch(JSON.stringify(record), /5432|connection/);
  assert.equal(requests.length, 0);
});

test("a report's own messages read exactly as they did before the sender learned about results", async () => {
  const { senders, requests, emails } = world();
  const channel = (type: string, config: unknown): ReportChannel => ({ id: CHANNEL, name: "ops", type, isEnabled: true, config });
  const message = { title: "Report: Weekly", text: "Model usage: 1 requests" };

  await senders.sendToChannel(channel("slack", { webhookUrl: SLACK_URL }), message);
  assert.deepEqual(requests[0]!.body, {
    username: "WheelsAI Reports",
    attachments: [{ color: "#3b82f6", title: "Report: Weekly", text: "Model usage: 1 requests", footer: "WheelsAI" }],
  });
  await senders.sendToChannel(channel("slack", { webhookUrl: SLACK_URL, username: "Ops Bot" }), { ...message, kind: "result" });
  assert.equal(requests[1]!.body.username, "Ops Bot", "a channel's own sender name wins for either kind");

  await senders.sendToChannel(channel("discord", { webhookUrl: "https://discord.example/api/webhooks/1" }), message);
  assert.deepEqual(requests[2]!.body, {
    embeds: [{ title: "Report: Weekly", description: "Model usage: 1 requests", color: 0x3b82f6, footer: { text: "WheelsAI" } }],
  });

  await senders.sendToChannel(channel("webhook", { url: "https://example.com/in" }), { ...message, kind: "report" });
  assert.deepEqual(Object.keys(requests[3]!.body), ["type", "title", "message", "timestamp"]);
  assert.equal(requests[3]!.body.type, "report");

  await assert.rejects(senders.sendToChannel(channel("pagerduty", {}), message), /^ChannelDeliveryError: a pagerduty channel cannot carry a report$/);
  await assert.rejects(senders.sendToChannel(channel("slack", {}), message), /the Slack channel has no URL configured/);
  await assert.rejects(senders.sendEmail(channel("email", { emails: [] }), message), /the email channel has no addresses configured/);

  await senders.sendEmail(channel("email", { emails: ["a@example.com"] }), message);
  assert.deepEqual(emails, [{ to: "a@example.com", subject: "Report: Weekly", text: "Model usage: 1 requests" }]);
});
