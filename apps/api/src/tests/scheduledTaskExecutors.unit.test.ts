import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Drives the per-type executors in services/scheduledTasks/ through
// executeScheduledTask, the way the scheduler runs them: data_sync,
// health_check, report, cleanup, custom and workflow_run. These are the
// types the dashboard once advertised over an executor that could not
// run them. Every IO surface is a fake.

import {
  executeScheduledTask,
  type ExecuteScheduledTaskDeps,
  type ScheduledTaskForExecution,
  type ScheduledTaskTypeDeps,
} from "../services/executeScheduledTask.js";
import type { CleanupDeps } from "../services/scheduledTasks/cleanup.js";
import type { DataSyncDeps } from "../services/scheduledTasks/dataSync.js";
import type { HealthCheckDeps, ProbeResult } from "../services/scheduledTasks/healthCheck.js";
import type { ReportChannel, ReportDeps } from "../services/scheduledTasks/report.js";
import { buildReportDelivery } from "../services/scheduledTasks/reportDelivery.js";
import { isPermanentFailure } from "../services/scheduledTasks/taskError.js";
import {
  EMAIL_UNAVAILABLE_REASON,
  RESTART_UNAVAILABLE_REASON,
} from "../services/scheduledTaskTypes.js";

const ORG = "org_1";
const AGENT = "11111111-1111-4111-8111-111111111111";
const KB = "33333333-3333-4333-8333-333333333333";
const OTHER_KB = "99999999-9999-4999-8999-999999999999";
const DEPLOYMENT = "44444444-4444-4444-8444-444444444444";
const MONITOR = "55555555-5555-4555-8555-555555555555";
const CHANNEL = "66666666-6666-4666-8666-666666666666";
const WORKFLOW = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-06T12:00:00Z");

function task(overrides: Partial<ScheduledTaskForExecution>): ScheduledTaskForExecution {
  return {
    id: "task_1",
    orgId: ORG,
    agentId: null,
    orchestrationId: null,
    name: "nightly",
    taskType: "data_sync",
    payload: {},
    timeout: 10_000,
    ...overrides,
  };
}

function run(
  t: ScheduledTaskForExecution,
  taskTypes: ScheduledTaskTypeDeps,
  extra: Partial<ExecuteScheduledTaskDeps> = {},
  ctx: Parameters<typeof executeScheduledTask>[2] = {},
) {
  const deps: ExecuteScheduledTaskDeps = {
    loadAgent: async () => null,
    runAgentChat: async () => ({ content: "" }),
    fetchFn: fetch,
    taskTypes,
    ...extra,
  };
  return executeScheduledTask(t, deps, { executionId: "exec_1", now: NOW, ...ctx });
}

/** Resolves to the error a rejected run threw, with its attached output. */
async function failure(promise: Promise<unknown>): Promise<Error & { output?: any; permanent?: boolean }> {
  try {
    await promise;
  } catch (err) {
    return err as Error & { output?: any };
  }
  assert.fail("expected the task to fail");
}

const PUBLIC = { resolveHost: async () => ["93.184.216.34"] };

// ============================================
// data_sync
// ============================================

function dataSync(opts: {
  pages: Record<string, { status?: number; type?: string; body?: string } | Error>;
  stored?: Record<string, { id: string; contentHash: string | null }>;
  knowledgeBases?: string[];
  agentKb?: string | null;
  resolveHost?: (host: string) => Promise<string[]>;
}) {
  const added: Array<{ kb: string; orgId: string; title: string; content: string; sourceUrl: string; metadata: Record<string, unknown> }> = [];
  const deleted: string[] = [];
  const fetched: string[] = [];
  const order: string[] = [];
  const deps: DataSyncDeps = {
    loadAgentKnowledgeBaseId: async () => opts.agentKb ?? null,
    loadKnowledgeBase: async (id, orgId) =>
      orgId === ORG && (opts.knowledgeBases ?? [KB]).includes(id) ? { id } : null,
    findDocumentBySource: async (_kb, url) => opts.stored?.[url] ?? null,
    addDocument: async (kb, orgId, doc) => {
      order.push("add");
      added.push({ kb, orgId, ...doc });
      return { id: `doc_${added.length}`, chunkCount: 3 };
    },
    deleteDocument: async (id) => {
      order.push("delete");
      deleted.push(id);
    },
    embeddingMode: () => "keyword",
    hash: (text) => `h:${text}`,
    fetchFn: (async (url: string) => {
      fetched.push(String(url));
      const page = opts.pages[String(url)];
      if (!page) return new Response("nope", { status: 404 });
      if (page instanceof Error) throw page;
      // A string body would be given a text/plain type by Response itself;
      // bytes are how a server that sends no Content-Type is modelled.
      if (page.type === "") {
        return new Response(new TextEncoder().encode(page.body ?? ""), { status: page.status ?? 200 });
      }
      return new Response(page.body ?? "", {
        status: page.status ?? 200,
        headers: { "content-type": page.type ?? "text/html; charset=utf-8" },
      });
    }) as unknown as typeof fetch,
    guardDeps: { resolveHost: opts.resolveHost ?? PUBLIC.resolveHost },
  };
  return { deps, added, deleted, fetched, order };
}

const syncTask = (payload: Record<string, unknown>, overrides: Partial<ScheduledTaskForExecution> = {}) =>
  task({ taskType: "data_sync", payload, ...overrides });

test("data_sync adds a new source as text, with its hash and where it came from", async () => {
  const html =
    "<html><head><title>Pricing &amp; plans</title><script>track()</script></head><body><h1>Pricing</h1><p>From $5.</p></body></html>";
  const { deps, added } = dataSync({ pages: { "https://example.com/pricing": { body: html } } });
  const { output } = await run(
    syncTask({ knowledgeBaseId: KB, sources: [{ url: "https://example.com/pricing" }] }),
    { dataSync: deps },
  );

  assert.equal(added.length, 1);
  assert.equal(added[0]!.kb, KB);
  assert.equal(added[0]!.orgId, ORG);
  assert.equal(added[0]!.title, "Pricing & plans");
  assert.equal(added[0]!.content, "Pricing\n\nFrom $5.");
  assert.ok(!added[0]!.content.includes("track"), "script content is not ingested");
  assert.deepEqual(added[0]!.metadata, {
    contentHash: "h:Pricing\n\nFrom $5.",
    syncedAt: NOW.toISOString(),
    syncTaskId: "task_1",
  });
  assert.deepEqual(output, {
    knowledgeBaseId: KB,
    embeddingMode: "keyword",
    sources: [
      { url: "https://example.com/pricing", status: "added", documentId: "doc_1", chunks: 3, bytes: html.length },
    ],
  });
});

test("data_sync leaves unchanged content alone: nothing re-ingested, nothing deleted", async () => {
  const { deps, added, deleted } = dataSync({
    pages: { "https://example.com/a.txt": { type: "text/plain", body: "same text" } },
    stored: { "https://example.com/a.txt": { id: "doc_old", contentHash: "h:same text" } },
  });
  const { output } = await run(
    syncTask({ knowledgeBaseId: KB, sources: [{ url: "https://example.com/a.txt" }] }),
    { dataSync: deps },
  );
  assert.equal(added.length, 0);
  assert.equal(deleted.length, 0);
  assert.equal((output as any).sources[0].status, "unchanged");
  assert.equal((output as any).sources[0].documentId, "doc_old");
});

test("data_sync replaces a changed document, storing the new one before removing the old", async () => {
  const { deps, added, deleted, order } = dataSync({
    pages: { "https://example.com/a.txt": { type: "text/plain", body: "new text" } },
    stored: { "https://example.com/a.txt": { id: "doc_old", contentHash: "h:old text" } },
  });
  const { output } = await run(
    syncTask({ knowledgeBaseId: KB, sources: [{ url: "https://example.com/a.txt", title: "Notes" }] }),
    { dataSync: deps },
  );
  assert.deepEqual(order, ["add", "delete"]);
  assert.equal(added[0]!.title, "Notes");
  assert.deepEqual(deleted, ["doc_old"]);
  assert.equal((output as any).sources[0].status, "updated");
});

test("data_sync refuses a source that resolves to an internal address, without naming the address", async () => {
  const { deps, fetched, added } = dataSync({
    pages: {},
    resolveHost: async () => ["10.0.3.7"],
  });
  const err = await failure(
    run(syncTask({ knowledgeBaseId: KB, sources: [{ url: "https://wiki.corp.example/x" }] }), { dataSync: deps }),
  );
  assert.match(err.message, /source refused: blocked outbound request/);
  assert.ok(!err.message.includes("10.0.3.7"));
  assert.equal(fetched.length, 0);
  assert.equal(added.length, 0);
  assert.equal(err.output.sources[0].status, "failed");
});

test("data_sync fails a non-2xx source, an unsupported content type and an oversize body", async () => {
  const { deps, added } = dataSync({
    pages: {
      "https://example.com/gone": { status: 503, body: "down" },
      "https://example.com/logo.png": { type: "image/png", body: "PNG" },
      "https://example.com/untyped": { type: "", body: "who knows" },
      "https://example.com/huge": { type: "text/plain", body: "x".repeat(5000) },
    },
  });
  const err = await failure(
    run(
      syncTask({
        knowledgeBaseId: KB,
        maxBytes: 2048,
        sources: [
          { url: "https://example.com/gone" },
          { url: "https://example.com/logo.png" },
          { url: "https://example.com/untyped" },
          { url: "https://example.com/huge" },
        ],
      }),
      { dataSync: deps },
    ),
  );
  assert.match(err.message, /^4 of 4 sources failed/);
  const errors = err.output.sources.map((s: { error: string }) => s.error);
  assert.match(errors[0], /source responded 503/);
  assert.match(errors[1], /unsupported content type "image\/png"/);
  assert.match(errors[2], /unsupported content type "none"/);
  assert.match(errors[3], /larger than the 2048-byte limit/);
  assert.equal(added.length, 0, "an oversize source is never cut and stored as if complete");
});

test("data_sync keeps going past a failed source, then fails the task and still reports every source", async () => {
  const { deps, added } = dataSync({
    pages: {
      "https://example.com/ok": { type: "application/json", body: '{"a":1}' },
      "https://example.com/bad": new Error("socket hang up"),
    },
  });
  const err = await failure(
    run(
      syncTask({ knowledgeBaseId: KB, sources: [{ url: "https://example.com/bad" }, { url: "https://example.com/ok" }] }),
      { dataSync: deps },
    ),
  );
  assert.match(err.message, /^1 of 2 sources failed: https:\/\/example\.com\/bad \(could not be fetched: socket hang up\)/);
  assert.deepEqual(err.output.sources.map((s: { status: string }) => s.status), ["failed", "added"]);
  assert.equal(added.length, 1);
  assert.equal(isPermanentFailure(err), false, "a flaky source is worth a retry");
});

test("data_sync refuses a knowledge base from another organization, before fetching anything", async () => {
  const { deps, fetched } = dataSync({ pages: {}, knowledgeBases: [KB] });
  const err = await failure(
    run(syncTask({ knowledgeBaseId: OTHER_KB, sources: [{ url: "https://example.com/a" }] }), { dataSync: deps }),
  );
  assert.equal(err.message, "knowledge base not found in this organization");
  assert.equal(isPermanentFailure(err), true);
  assert.equal(fetched.length, 0);
});

test("data_sync falls back to the agent's knowledge base, and says so when there is none", async () => {
  const withKb = dataSync({ pages: { "https://example.com/a": { type: "text/plain", body: "hi" } }, agentKb: KB });
  const { output } = await run(
    syncTask({ sources: [{ url: "https://example.com/a" }] }, { agentId: AGENT }),
    { dataSync: withKb.deps },
  );
  assert.equal((output as any).knowledgeBaseId, KB);

  const without = dataSync({ pages: {}, agentKb: null });
  const err = await failure(
    run(syncTask({ sources: [{ url: "https://example.com/a" }] }, { agentId: AGENT }), { dataSync: without.deps }),
  );
  assert.match(err.message, /data sync has no knowledge base/);
});

// ============================================
// health_check
// ============================================

function healthCheck(opts: {
  probe?: ProbeResult;
  deployment?: { status: string; healthUrl: string | null } | null;
  runtime?: { healthUrl: string | null } | null;
  monitor?: { url: string | null; expectedStatus?: number } | null;
  restart?: "none" | "ok" | Error;
}) {
  const probes: Array<{ url: string; expectedStatus: number; timeoutSeconds: number }> = [];
  const events: Array<{ monitorId: string; status: string }> = [];
  const restarts: string[] = [];
  const lookups: Array<[string, string]> = [];
  const deps: HealthCheckDeps = {
    loadDeployment: async (id, orgId) => {
      lookups.push([id, orgId]);
      return opts.deployment ? { id, ...opts.deployment } : null;
    },
    loadAgentRuntime: async (id, orgId) => {
      lookups.push([id, orgId]);
      return opts.runtime ?? null;
    },
    loadMonitor: async (id, orgId) => {
      lookups.push([id, orgId]);
      return opts.monitor
        ? {
            id,
            url: opts.monitor.url,
            timeoutSeconds: 30,
            httpMethod: "HEAD",
            expectedStatus: opts.monitor.expectedStatus ?? 204,
            expectedBody: null,
            headers: null,
          }
        : null;
    },
    probe: async (spec, url) => {
      probes.push({ url, expectedStatus: spec.expectedStatus, timeoutSeconds: spec.timeoutSeconds });
      return opts.probe ?? { status: "up", statusCode: 200, latencyMs: 42 };
    },
    recordUptimeEvent: async (monitorId, result) => {
      events.push({ monitorId, status: result.status });
    },
    restartDeployment:
      !opts.restart || opts.restart === "none"
        ? null
        : async (id) => {
            restarts.push(id);
            if (opts.restart instanceof Error) throw opts.restart;
            return { status: "provisioning" };
          },
  };
  return { deps, probes, events, restarts, lookups };
}

const checkTask = (payload: Record<string, unknown>, overrides: Partial<ScheduledTaskForExecution> = {}) =>
  task({ taskType: "health_check", payload, ...overrides });

test("health_check: an up target succeeds with its latency", async () => {
  const { deps, probes, events } = healthCheck({});
  const { output } = await run(
    checkTask({ target: "url", url: "https://example.com/health", expectedStatus: 204, timeoutSeconds: 5 }),
    { healthCheck: deps },
  );
  assert.deepEqual(probes, [{ url: "https://example.com/health", expectedStatus: 204, timeoutSeconds: 5 }]);
  assert.deepEqual(output, {
    target: "url",
    url: "https://example.com/health",
    status: "up",
    statusCode: 200,
    latencyMs: 42,
    recordedToMonitor: false,
  });
  assert.equal(events.length, 0);
});

test("health_check: down, timeout and error each fail the task with the probe's own message", async () => {
  const cases: Array<[ProbeResult, RegExp]> = [
    [{ status: "down", statusCode: 500, latencyMs: 9, errorMessage: "expected status 200, got 500" }, /^health check down: expected status 200, got 500$/],
    [{ status: "timeout", latencyMs: 10_000, errorMessage: "no response within 10000ms" }, /^health check timeout: no response within 10000ms$/],
    [{ status: "error", errorMessage: "getaddrinfo ENOTFOUND" }, /^health check error: getaddrinfo ENOTFOUND$/],
  ];
  for (const [probe, message] of cases) {
    const { deps } = healthCheck({ probe });
    const err = await failure(run(checkTask({ target: "url", url: "https://example.com/health" }), { healthCheck: deps }));
    assert.match(err.message, message);
    assert.equal(err.output.status, probe.status);
    assert.equal(isPermanentFailure(err), true, "the check ran; retrying would only log it again");
  }
});

test("health_check: a target with nothing to probe fails honestly and is never probed", async () => {
  const noNode = healthCheck({ deployment: { status: "provisioning", healthUrl: null } });
  const err = await failure(
    run(checkTask({ target: "deployment", deploymentId: DEPLOYMENT }), { healthCheck: noNode.deps }),
  );
  assert.match(err.message, /health check error: the deployment has no node URL to probe \(status: provisioning\)/);
  assert.equal(noNode.probes.length, 0);
  assert.equal(err.output.url, null);

  const noRuntime = healthCheck({ runtime: { healthUrl: null } });
  const agentErr = await failure(
    run(checkTask({ target: "agent" }, { agentId: AGENT }), { healthCheck: noRuntime.deps }),
  );
  assert.match(agentErr.message, /the agent has no running runtime/);
  assert.equal(noRuntime.probes.length, 0);
});

test("health_check: a deployment, agent or monitor from another organization is refused", async () => {
  const { deps, probes, lookups } = healthCheck({ deployment: null, runtime: null, monitor: null });
  assert.equal(
    (await failure(run(checkTask({ target: "deployment", deploymentId: DEPLOYMENT }), { healthCheck: deps }))).message,
    "deployment not found in this organization",
  );
  assert.equal(
    (await failure(run(checkTask({ target: "agent" }, { agentId: AGENT }), { healthCheck: deps }))).message,
    "agent not found in this organization",
  );
  assert.equal(
    (await failure(run(checkTask({ target: "monitor", monitorId: MONITOR }), { healthCheck: deps }))).message,
    "uptime monitor not found in this organization",
  );
  assert.ok(lookups.every(([, orgId]) => orgId === ORG), "every lookup carried the task's organization");
  assert.equal(probes.length, 0);
});

test("health_check: a monitor target is probed with the monitor's own settings and recorded to it", async () => {
  const { deps, probes, events } = healthCheck({ monitor: { url: "https://status.example.com/ping", expectedStatus: 204 } });
  const { output } = await run(checkTask({ target: "monitor", monitorId: MONITOR }), { healthCheck: deps });
  assert.deepEqual(probes, [{ url: "https://status.example.com/ping", expectedStatus: 204, timeoutSeconds: 30 }]);
  assert.deepEqual(events, [{ monitorId: MONITOR, status: "up" }]);
  assert.equal((output as any).recordedToMonitor, true);
});

test("health_check: monitorId on another target records the result there too, including a failure", async () => {
  const { deps, events } = healthCheck({
    monitor: { url: "https://unused.example.com" },
    probe: { status: "down", statusCode: 502, errorMessage: "expected status 200, got 502" },
  });
  const err = await failure(
    run(checkTask({ target: "url", url: "https://example.com/health", monitorId: MONITOR }), { healthCheck: deps }),
  );
  assert.deepEqual(events, [{ monitorId: MONITOR, status: "down" }]);
  assert.equal(err.output.recordedToMonitor, true);
});

test("health_check: restart runs only for a stopped or failed deployment that is down", async () => {
  const payload = { target: "deployment", deploymentId: DEPLOYMENT, onDown: "restart_deployment" };
  const down: ProbeResult = { status: "down", statusCode: 500, errorMessage: "expected status 200, got 500" };

  // Up: nothing to remediate.
  const up = healthCheck({ deployment: { status: "running", healthUrl: "https://node/health" }, restart: "ok" });
  const ok = await run(checkTask(payload), { healthCheck: up.deps });
  assert.equal((ok.output as any).remediation, undefined);
  assert.equal(up.restarts.length, 0);

  // Down but still running: the restart is skipped, with the reason.
  const running = healthCheck({ deployment: { status: "running", healthUrl: "https://node/health" }, probe: down, restart: "ok" });
  const skipped = await failure(run(checkTask(payload), { healthCheck: running.deps }));
  assert.equal(running.restarts.length, 0);
  assert.equal(skipped.output.remediation.status, "skipped");
  assert.match(skipped.message, /restart skipped: the deployment is running/);

  // Stopped and failed: restarted, and the task still fails (it WAS down).
  for (const status of ["stopped", "failed"]) {
    const dead = healthCheck({ deployment: { status, healthUrl: null }, restart: "ok" });
    const err = await failure(run(checkTask(payload), { healthCheck: dead.deps }));
    assert.deepEqual(dead.restarts, [DEPLOYMENT], status);
    assert.deepEqual(err.output.remediation, {
      action: "restart_deployment",
      status: "restarted",
      deploymentStatus: "provisioning",
    });
    assert.match(err.message, /deployment restart started$/);
  }

  // onDown none never restarts.
  const none = healthCheck({ deployment: { status: "stopped", healthUrl: null }, restart: "ok" });
  await failure(run(checkTask({ target: "deployment", deploymentId: DEPLOYMENT }), { healthCheck: none.deps }));
  assert.equal(none.restarts.length, 0);
});

test("health_check: a restart that fails (no credits) surfaces its reason; no restart service is named as such", async () => {
  const payload = { target: "deployment", deploymentId: DEPLOYMENT, onDown: "restart_deployment" };
  const broke = healthCheck({
    deployment: { status: "stopped", healthUrl: null },
    restart: new Error("insufficient credits to restart"),
  });
  const err = await failure(run(checkTask(payload), { healthCheck: broke.deps }));
  assert.match(err.message, /restart failed: insufficient credits to restart/);

  const unwired = healthCheck({ deployment: { status: "failed", healthUrl: null }, restart: "none" });
  const unavailable = await failure(run(checkTask(payload), { healthCheck: unwired.deps }));
  assert.deepEqual(unavailable.output.remediation, {
    action: "restart_deployment",
    status: "unavailable",
    reason: RESTART_UNAVAILABLE_REASON,
  });
});

// ============================================
// report
// ============================================

const USAGE = { requests: 120, inputTokens: 4000, outputTokens: 6000, costCents: 345, errors: 2, avgLatencyMs: 800 };
const RUNS = {
  scheduledTasks: { total: 10, success: 9, failed: 1 },
  workflows: { total: 4, completed: 4, failed: 0 },
  graphs: { total: 0, completed: 0, failed: 0 },
};

function report(opts: {
  empty?: boolean;
  channel?: Partial<ReportChannel> | null;
  emailConfigured?: boolean;
  sendError?: Error;
} = {}) {
  const windows: Array<{ orgId: string; agentId: string | null; since: string; until: string }> = [];
  const summaries: Array<{ agentId: string; prompt: string }> = [];
  const events: Array<{ orgId: string; data: Record<string, any> }> = [];
  const posts: Array<{ channel: string; title: string; text: string }> = [];
  const emails: Array<{ channel: string; text: string }> = [];
  const seen = <T,>(value: T) => async (w: { orgId: string; agentId: string | null; since: Date; until: Date }) => {
    windows.push({ orgId: w.orgId, agentId: w.agentId, since: w.since.toISOString(), until: w.until.toISOString() });
    return opts.empty ? null : value;
  };
  const deps: ReportDeps = {
    loadUsage: seen(USAGE),
    loadCostByModel: seen([{ modelId: "llama-3.1-8b", costCents: 345, requests: 120 }]),
    loadRuns: seen(RUNS),
    loadConversations: seen({ conversations: 7, messages: 90, tokens: 12_000 }),
    loadRevenue: async () => null,
    summarize: async ({ agentId, prompt }) => {
      summaries.push({ agentId, prompt });
      return "Usage was steady.";
    },
    emitReportEvent: async (orgId, data) => {
      events.push({ orgId, data });
    },
    loadAlertChannel: async (id, orgId) =>
      opts.channel === null || orgId !== ORG
        ? null
        : { id, name: "ops", type: "slack", isEnabled: true, config: {}, ...opts.channel },
    emailConfigured: () => opts.emailConfigured ?? false,
    sendToChannel: async (channel, message) => {
      if (opts.sendError) throw opts.sendError;
      posts.push({ channel: channel.id, ...message });
    },
    sendEmail: async (channel, message) => {
      emails.push({ channel: channel.id, text: message.text });
    },
  };
  return { deps, windows, summaries, events, posts, emails };
}

const reportTask = (payload: Record<string, unknown>, overrides: Partial<ScheduledTaskForExecution> = {}) =>
  task({ taskType: "report", name: "Weekly report", payload, ...overrides });

test("report aggregates from the loaders over the requested period, for the organization", async () => {
  const { deps, windows } = report();
  const { output } = await run(reportTask({ periodDays: 7 }), { report: deps });
  const out = output as any;

  assert.deepEqual(out.period, { days: 7, since: "2026-09-29T12:00:00.000Z", until: NOW.toISOString() });
  assert.deepEqual(out.scope, { type: "org", agentId: null });
  assert.equal(out.no_data, false);
  assert.deepEqual(out.usage, USAGE);
  assert.deepEqual(out.costByModel, [{ modelId: "llama-3.1-8b", costCents: 345, requests: 120 }]);
  assert.deepEqual(out.runs, RUNS);
  // A section with nothing in it says so; it is not a row of zeros.
  assert.deepEqual(out.revenue, { no_data: true });
  assert.deepEqual(out.delivery, []);
  assert.ok(windows.every((w) => w.orgId === ORG && w.agentId === null && w.since === "2026-09-29T12:00:00.000Z"));
});

test("an agent-scoped report passes the agent to every loader", async () => {
  const { deps, windows } = report();
  const { output } = await run(reportTask({ scope: "agent", periodDays: 1 }, { agentId: AGENT }), { report: deps });
  assert.ok(windows.length > 0 && windows.every((w) => w.agentId === AGENT));
  assert.deepEqual((output as any).scope, { type: "agent", agentId: AGENT });
});

test("an empty period yields no_data, not zeros, and is not summarised", async () => {
  const { deps, summaries } = report({ empty: true });
  const { output } = await run(reportTask({ summarize: true }, { agentId: AGENT }), { report: deps });
  const out = output as any;
  assert.equal(out.no_data, true);
  for (const section of ["usage", "costByModel", "runs", "conversations", "revenue"]) {
    assert.deepEqual(out[section], { no_data: true }, section);
  }
  assert.equal(summaries.length, 0, "no model call is spent describing nothing");
  assert.equal(out.summary, null);
  assert.match(out.summaryNote, /no activity to summarise/);
});

test("summarize asks the task's agent once, with the report as data", async () => {
  const { deps, summaries } = report();
  const { output } = await run(reportTask({ summarize: true }, { agentId: AGENT }), { report: deps });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.agentId, AGENT);
  assert.match(summaries[0]!.prompt, /"requests":120/);
  assert.equal((output as any).summary, "Usage was steady.");
});

test("delivery emits report.generated to the organization's webhooks", async () => {
  const { deps, events } = report();
  const { output } = await run(reportTask({ deliver: { webhookEvent: true } }), { report: deps });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.orgId, ORG);
  assert.equal(events[0]!.data.taskId, "task_1");
  assert.equal(events[0]!.data.executionId, "exec_1");
  assert.deepEqual(events[0]!.data.usage, USAGE);
  assert.deepEqual((output as any).delivery, [
    { via: "webhook_event", event: "report.generated", status: "emitted" },
  ]);
});

test("delivery posts a readable report to a Slack, Discord or webhook channel", async () => {
  const { deps, posts } = report();
  const { output } = await run(reportTask({ deliver: { alertChannelId: CHANNEL } }), { report: deps });
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.title, "Report: Weekly report");
  assert.match(posts[0]!.text, /Model usage: 120 requests, 10000 tokens, \$3\.45, 2 errors/);
  assert.match(posts[0]!.text, /Marketplace revenue: no data/);
  assert.deepEqual((output as any).delivery, [
    { via: "alert_channel", channelId: CHANNEL, type: "slack", status: "sent" },
  ]);
});

test("email delivery while email is not configured fails with that reason; nothing is 'sent'", async () => {
  const { deps, emails, posts } = report({ channel: { type: "email", config: { emails: ["ops@example.com"] } } });
  const err = await failure(run(reportTask({ deliver: { alertChannelId: CHANNEL } }), { report: deps }));
  assert.equal(err.message, `report was generated but not delivered: ${EMAIL_UNAVAILABLE_REASON}`);
  assert.equal(emails.length + posts.length, 0);
  assert.equal(isPermanentFailure(err), true);
  // The report itself is kept on the failed execution.
  assert.deepEqual(err.output.usage, USAGE);
  assert.deepEqual(err.output.delivery, []);
});

test("email delivery goes through the email sender once a provider is configured", async () => {
  const { deps, emails } = report({
    channel: { type: "email", config: { emails: ["ops@example.com"] } },
    emailConfigured: true,
  });
  const { output } = await run(reportTask({ deliver: { alertChannelId: CHANNEL } }), { report: deps });
  assert.equal(emails.length, 1);
  assert.equal((output as any).delivery[0].type, "email");
});

test("a missing, disabled or PagerDuty channel, or a failed post, fails the task and keeps the report", async () => {
  const cases: Array<[Parameters<typeof report>[0], RegExp]> = [
    [{ channel: null }, /not delivered: alert channel not found in this organization/],
    [{ channel: { isEnabled: false } }, /not delivered: alert channel "ops" is disabled/],
    [{ channel: { type: "pagerduty" } }, /not delivered: a pagerduty channel cannot carry a report/],
    [{ sendError: new Error("Slack responded 404") }, /not delivered to "ops": Slack responded 404/],
  ];
  for (const [opts, message] of cases) {
    const { deps, events } = report(opts);
    const err = await failure(
      run(reportTask({ deliver: { alertChannelId: CHANNEL, webhookEvent: true } }), { report: deps }),
    );
    assert.match(err.message, message);
    assert.deepEqual(err.output.usage, USAGE);
    assert.equal(events.length, 0, "the event follows the channel, so a retry cannot send it twice");
  }
});

test("report refuses agent scope or summarize on a task with no agent", async () => {
  const { deps } = report();
  assert.match((await failure(run(reportTask({ scope: "agent" }), { report: deps }))).message, /needs an agent/);
  assert.match((await failure(run(reportTask({ summarize: true }), { report: deps }))).message, /summarize needs an agent/);
});

test("report delivery formats: Slack and Discord bodies, a signed webhook, and guarded URLs", async () => {
  const requests: Array<{ url: string; headers: Record<string, string>; body: any; raw: string }> = [];
  const sent: Array<{ to: string; subject: string }> = [];
  const delivery = buildReportDelivery({
    fetchFn: (async (url: string, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
        raw: String(init?.body),
      });
      return new Response(null, { status: String(url).includes("broken") ? 500 : 200 });
    }) as unknown as typeof fetch,
    guardDeps: { resolveHost: async (host) => (host.includes("internal") ? ["10.1.2.3"] : ["93.184.216.34"]) },
    sendEmail: async (message) => {
      sent.push({ to: message.to, subject: message.subject });
    },
  });
  const channel = (type: string, config: unknown): ReportChannel => ({ id: CHANNEL, name: "ops", type, isEnabled: true, config });
  const message = { title: "Report: Weekly", text: "Model usage: 1 requests" };

  await delivery.sendToChannel(channel("slack", { webhookUrl: "https://hooks.slack.example/T1", channel: "#ops" }), message);
  assert.equal(requests[0]!.body.channel, "#ops");
  assert.equal(requests[0]!.body.attachments[0].text, "Model usage: 1 requests");

  await delivery.sendToChannel(channel("discord", { webhookUrl: "https://discord.example/api/webhooks/1" }), message);
  assert.equal(requests[1]!.body.embeds[0].title, "Report: Weekly");

  await delivery.sendToChannel(channel("webhook", { url: "https://example.com/in", secret: "s3cret", headers: { "X-Team": "ops" } }), message);
  const { createHmac } = await import("node:crypto");
  assert.equal(requests[2]!.headers["X-Team"], "ops");
  assert.equal(
    requests[2]!.headers["X-Webhook-Signature"],
    createHmac("sha256", "s3cret").update(requests[2]!.raw).digest("hex"),
  );

  await assert.rejects(
    delivery.sendToChannel(channel("slack", { webhookUrl: "https://internal.corp.example/hook" }), message),
    /Slack URL refused: blocked outbound request/,
  );
  await assert.rejects(
    delivery.sendToChannel(channel("slack", { webhookUrl: "https://broken.example/hook" }), message),
    /Slack responded 500/,
  );
  await assert.rejects(delivery.sendToChannel(channel("slack", {}), message), /no URL configured/);
  await assert.rejects(delivery.sendToChannel(channel("pagerduty", {}), message), /cannot carry a report/);
  assert.equal(requests.length, 4, "the internal URL was never requested");

  await delivery.sendEmail(channel("email", { emails: ["a@example.com", "b@example.com"] }), message);
  assert.deepEqual(sent, [
    { to: "a@example.com", subject: "Report: Weekly" },
    { to: "b@example.com", subject: "Report: Weekly" },
  ]);
  await assert.rejects(delivery.sendEmail(channel("email", { emails: [] }), message), /no addresses configured/);
});

// ============================================
// cleanup
// ============================================

function cleanup(opts: { agentExists?: boolean } = {}) {
  const calls: Array<{ op: string; args: any }> = [];
  const record = <T,>(op: string, result: T) => async (args: unknown) => {
    calls.push({ op, args });
    return result;
  };
  const deps: CleanupDeps = {
    loadAgent: async (id, orgId) => (orgId === ORG && opts.agentExists !== false ? { id } : null),
    archiveConversations: record("archive", 12),
    deleteArchivedConversations: record("delete", 3),
    decayMemory: record("decay", { decayed: 40, deactivated: 5 }),
    pruneRunHistory: record("prune", { taskExecutions: 100, workflowRuns: 20, graphRuns: 0 }),
  };
  return { deps, calls };
}

const cleanupTask = (payload: Record<string, unknown>, overrides: Partial<ScheduledTaskForExecution> = {}) =>
  task({ taskType: "cleanup", payload, ...overrides });

test("cleanup refuses when no operation is configured, and touches nothing", async () => {
  const { deps, calls } = cleanup();
  const err = await failure(run(cleanupTask({ dryRun: true }), { cleanup: deps }));
  assert.match(err.message, /at least one operation/);
  assert.equal(isPermanentFailure(err), true);
  assert.equal(calls.length, 0);
});

test("cleanup runs only the configured operations, with cutoffs counted back from now", async () => {
  const { deps, calls } = cleanup();
  const { output } = await run(
    cleanupTask({ archiveConversationsOlderThanDays: 30, deleteArchivedOlderThanDays: 90 }),
    { cleanup: deps },
  );
  assert.deepEqual(calls.map((c) => c.op), ["archive", "delete"]);
  assert.equal(calls[0]!.args.idleBefore.toISOString(), "2026-09-06T12:00:00.000Z");
  assert.equal(calls[1]!.args.archivedBefore.toISOString(), "2026-07-08T12:00:00.000Z");
  assert.deepEqual(output, {
    dryRun: false,
    scope: { agentId: null },
    operations: {
      archiveConversations: { olderThanDays: 30, count: 12 },
      deleteArchivedConversations: { olderThanDays: 90, count: 3 },
    },
  });
});

test("cleanup is scoped to the organization and, where given, the agent, in every operation", async () => {
  const everything = {
    archiveConversationsOlderThanDays: 1,
    deleteArchivedOlderThanDays: 7,
    memoryDecay: { factor: 0.9, minImportance: 0.1, deactivateBelow: 0.15 },
    pruneRunHistoryOlderThanDays: 30,
  };
  const org = cleanup();
  await run(cleanupTask(everything), { cleanup: org.deps });
  assert.equal(org.calls.length, 4);
  assert.ok(org.calls.every((c) => c.args.scope.orgId === ORG && c.args.scope.agentId === null));

  const agent = cleanup();
  const { output } = await run(cleanupTask(everything, { agentId: AGENT }), { cleanup: agent.deps });
  assert.ok(agent.calls.every((c) => c.args.scope.orgId === ORG && c.args.scope.agentId === AGENT));
  assert.deepEqual((output as any).scope, { agentId: AGENT });

  const decay = agent.calls.find((c) => c.op === "decay")!.args;
  assert.deepEqual(
    { factor: decay.factor, minImportance: decay.minImportance, deactivateBelow: decay.deactivateBelow },
    { factor: 0.9, minImportance: 0.1, deactivateBelow: 0.15 },
  );
  // Only memories unread for a week decay.
  assert.equal(decay.staleBefore.toISOString(), "2026-09-29T12:00:00.000Z");
  assert.deepEqual((output as any).operations.memoryDecay, { factor: 0.9, minImportance: 0.1, decayed: 40, deactivated: 5 });
  assert.deepEqual((output as any).operations.pruneRunHistory, { olderThanDays: 30, taskExecutions: 100, workflowRuns: 20, graphRuns: 0 });
});

test("a cleanup task that outlived its agent does not widen to the whole organization", async () => {
  const { deps, calls } = cleanup({ agentExists: false });
  const err = await failure(
    run(cleanupTask({ deleteArchivedOlderThanDays: 7 }, { agentId: AGENT }), { cleanup: deps }),
  );
  assert.match(err.message, /agent not found in this organization; nothing was changed/);
  assert.equal(calls.length, 0);
});

test("a dry run passes dryRun to every operation and reports itself as one", async () => {
  const { deps, calls } = cleanup();
  const { output } = await run(
    cleanupTask({
      archiveConversationsOlderThanDays: 30,
      deleteArchivedOlderThanDays: 90,
      memoryDecay: { factor: 0.9, minImportance: 0.1 },
      pruneRunHistoryOlderThanDays: 30,
      dryRun: true,
    }),
    { cleanup: deps },
  );
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.args.dryRun === true));
  assert.equal((output as any).dryRun, true);

  const real = cleanup();
  await run(cleanupTask({ archiveConversationsOlderThanDays: 30 }), { cleanup: real.deps });
  assert.equal(real.calls[0]!.args.dryRun, false);
});

// ============================================
// custom (the agent's graph)
// ============================================

test("custom runs the agent's graph with the input and the run's signal", async () => {
  const calls: Array<{ agentId: string; orgId: string; input: string; signal?: AbortSignal }> = [];
  const controller = new AbortController();
  const { output } = await run(
    task({ taskType: "custom", agentId: AGENT, payload: { input: "weekly digest" } }),
    {
      graphRun: {
        runGraph: async (agentId, orgId, input, options) => {
          calls.push({ agentId, orgId, input, signal: options.signal });
          return { executionId: "graph_1", status: "completed", output: "done", durationMs: 12 };
        },
      },
    },
    {},
    { signal: controller.signal },
  );
  assert.deepEqual(calls, [{ agentId: AGENT, orgId: ORG, input: "weekly digest", signal: controller.signal }]);
  assert.deepEqual(output, { graphExecutionId: "graph_1", status: "completed", output: "done", durationMs: 12 });
});

test("custom runs the graph in the scheduled tool mode, not the builder's", async () => {
  const modes: string[] = [];
  await run(task({ taskType: "custom", agentId: AGENT, payload: { input: "weekly digest" } }), {
    graphRun: {
      runGraph: async (_agentId, _orgId, _input, options) => {
        modes.push(options.mode);
        return { executionId: "graph_1", status: "completed", output: "done", durationMs: 1 };
      },
    },
  });
  assert.deepEqual(modes, ["scheduled"]);

  // The production binding hands the mode on to the graph runner, which uses
  // it as the base of the run's tool mode.
  const read = (file: string) =>
    readFileSync(new URL(`../services/${file}`, import.meta.url), "utf8");
  assert.match(
    read("scheduledTasks/buildScheduledTaskTypeDeps.ts"),
    /runAgentGraph\(agentId, orgId, graphInput, options\)/,
  );
  const runner = read("runAgentGraph.ts");
  assert.match(runner, /mode: options\.mode \?\? "graph"/);
  assert.match(runner, /resolveToolMode\(\{ agentId, orgId, base: options\.mode \}\)/);
});

test("a failed graph run fails the task with the graph's error", async () => {
  const err = await failure(
    run(task({ taskType: "custom", agentId: AGENT, payload: { input: "" } }), {
      graphRun: {
        runGraph: async () => ({ executionId: "graph_2", status: "failed", output: null, error: "node llm_1 failed: provider 500", durationMs: 5 }),
      },
    }),
  );
  assert.equal(err.message, "graph run failed: node llm_1 failed: provider 500");
  assert.equal(err.output.graphExecutionId, "graph_2");
  assert.equal(isPermanentFailure(err), false);
});

test("custom: no graph, or no agent, is a permanent failure naming the cause", async () => {
  const noGraph = await failure(
    run(task({ taskType: "custom", agentId: AGENT, payload: { input: "" } }), {
      graphRun: {
        runGraph: async () => {
          throw new Error("This agent has no graph — build one first");
        },
      },
    }),
  );
  assert.match(noGraph.message, /has no graph/);
  assert.equal(isPermanentFailure(noGraph), true);

  const noAgent = await failure(
    run(task({ taskType: "custom", payload: { input: "" } }), { graphRun: { runGraph: async () => assert.fail("must not run") } }),
  );
  assert.match(noAgent.message, /this task has no agent/);
});

// ============================================
// workflow_run
// ============================================

function workflowRun(opts: { startError?: Error; linkError?: Error } = {}) {
  const starts: any[] = [];
  const links: Array<[string, string]> = [];
  return {
    starts,
    links,
    deps: {
      startRun: async (args: any) => {
        starts.push(args);
        if (opts.startError) throw opts.startError;
        return { id: "run_1", status: "queued" };
      },
      linkExecution: async (taskExecutionId: string, runId: string) => {
        if (opts.linkError) throw opts.linkError;
        links.push([taskExecutionId, runId]);
      },
    },
  };
}

const workflowTask = (payload: Record<string, unknown> = {}, overrides: Partial<ScheduledTaskForExecution> = {}) =>
  task({ taskType: "workflow_run", orchestrationId: WORKFLOW, payload, ...overrides });

test("workflow_run starts the run with the task execution's id and returns deferred", async () => {
  const { deps, starts, links } = workflowRun();
  const result = await run(workflowTask({ prompt: "weekly", input: { region: "eu" } }), { workflowRun: deps });

  assert.deepEqual(starts, [
    {
      orchestrationId: WORKFLOW,
      orgId: ORG,
      prompt: "weekly",
      input: { region: "eu" },
      triggeredBy: "schedule",
      scheduledTaskId: "task_1",
      taskExecutionId: "exec_1",
    },
  ]);
  assert.deepEqual(links, [["exec_1", "run_1"]]);
  assert.deepEqual(result, {
    output: { orchestrationExecutionId: "run_1", status: "queued" },
    deferred: true,
  });
});

test("workflow_run: a manual trigger starts the run as manual", async () => {
  const { deps, starts } = workflowRun();
  await run(workflowTask(), { workflowRun: deps }, {}, { triggeredBy: "manual" });
  assert.equal(starts[0].triggeredBy, "manual");
});

test("workflow_run: a workflow from another organization (or gone, or disabled) fails with the start service's reason", async () => {
  for (const reason of ["Workflow not found", "This workflow is disabled; enable it to run it"]) {
    const { deps, links } = workflowRun({ startError: new Error(reason) });
    const err = await failure(run(workflowTask(), { workflowRun: deps }));
    assert.equal(err.message, `workflow run not started: ${reason}`);
    assert.equal(isPermanentFailure(err), true, "re-running would only repeat the refusal");
    assert.equal(links.length, 0);
  }
});

test("workflow_run needs a workflow and a recorded execution to hand the outcome back to", async () => {
  const { deps, starts } = workflowRun();
  assert.match(
    (await failure(run(workflowTask({}, { orchestrationId: null }), { workflowRun: deps }))).message,
    /needs a workflow/,
  );
  assert.match(
    (await failure(
      executeScheduledTask(workflowTask(), {
        loadAgent: async () => null,
        runAgentChat: async () => ({ content: "" }),
        fetchFn: fetch,
        taskTypes: { workflowRun: deps },
      }),
    )).message,
    /only run as a recorded execution/,
  );
  assert.equal(starts.length, 0);
});

test("workflow_run: a lost back-link does not fail an execution whose run is already queued", async () => {
  const { deps } = workflowRun({ linkError: new Error("database blip") });
  const result = await run(workflowTask(), { workflowRun: deps });
  assert.equal(result.deferred, true);
});
