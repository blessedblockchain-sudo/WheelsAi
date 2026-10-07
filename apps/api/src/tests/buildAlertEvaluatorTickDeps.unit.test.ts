import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";
import {
  buildAlertEvaluatorTickDeps,
  type AlertEvaluatorDb,
} from "../services/buildAlertEvaluatorTickDeps.js";
import type { ScopedLatency } from "../services/buildLatencySampleDeps.js";
import type { ScopedWindow } from "../services/latencyQueries.js";
import type { AlertRuleRow } from "../services/runAlertEvaluatorTick.js";

// Binding test: what each alert metric actually reads. latency_p95 and
// latency_avg were accepted by the API and then skipped by the evaluator;
// these pin that they are computed from the per-request samples, inside the
// rule's organization, and that "no request" and "could not read" are never
// evaluated as 0 ms.

const NOW = new Date("2026-10-07T12:00:00.000Z");
const ORG = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT = "33333333-3333-4333-8333-333333333333";
const AGENT_DEPLOYMENT = "44444444-4444-4444-8444-444444444444";
const FOREIGN = "99999999-9999-4999-8999-999999999999";

function rule(overrides: Partial<AlertRuleRow> = {}): AlertRuleRow {
  return {
    id: "rule_1",
    orgId: ORG,
    name: "slow answers",
    metric: "latency_p95",
    operator: "gt",
    threshold: 2_000,
    windowMinutes: 15,
    severity: "warning",
    cooldownMinutes: 60,
    lastTriggeredAt: null,
    resourceType: "organization",
    resourceId: null,
    ...overrides,
  };
}

const measured: ScopedLatency = { sampleCount: 37, avgMs: 840, p50Ms: 600, p95Ms: 2_140, p99Ms: 3_000 };
const nothing: ScopedLatency = { sampleCount: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null };

function build(
  options: {
    latency?: ScopedLatency | Error;
    agentDeployments?: Array<{ modelDeploymentId: string | null }>;
    usage?: { requestCount: number | null; errorCount: number | null; costCents: bigint | null; actualCostCents: bigint | null };
    uptime?: Array<{ status: string }>;
  } = {},
) {
  const calls = {
    windows: [] as ScopedWindow[],
    agentDeployments: [] as any[],
    usage: [] as any[],
    uptime: [] as any[],
    rules: [] as any[],
    triggered: [] as unknown[][],
    webhooks: [] as unknown[][],
  };
  const prisma: AlertEvaluatorDb = {
    alertRule: {
      findMany: async (args) => {
        calls.rules.push(args);
        return [rule()];
      },
    },
    agentDeployment: {
      findMany: async (args) => {
        calls.agentDeployments.push(args);
        return options.agentDeployments ?? [];
      },
    },
    usageRecord: {
      aggregate: async (args) => {
        calls.usage.push(args);
        return {
          _sum: options.usage ?? { requestCount: 200, errorCount: 10, costCents: 500n, actualCostCents: 0n },
        };
      },
    },
    uptimeEvent: {
      findMany: async (args) => {
        calls.uptime.push(args);
        return options.uptime ?? [];
      },
    },
  };
  const deps = buildAlertEvaluatorTickDeps({
    prisma,
    loadScopedLatency: async (window) => {
      calls.windows.push(window);
      const answer = options.latency ?? measured;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    triggerAlert: async (...args) => {
      calls.triggered.push(args);
      return { id: "alert_1", title: "slow answers triggered" };
    },
    triggerWebhook: (async (...args: unknown[]) => {
      calls.webhooks.push(args);
    }) as never,
  });
  return { deps, calls };
}

// ============================================
// Latency
// ============================================

test("latency_p95 on the organization is the p95 of the samples in [now - window, now)", async () => {
  const { deps, calls } = build();
  assert.deepEqual(await deps.computeMetric(rule(), NOW), {
    kind: "value",
    value: 2_140,
    detail: "ms over 37 requests",
  });
  assert.deepEqual(calls.windows, [
    {
      orgId: ORG,
      since: new Date("2026-10-07T11:45:00.000Z"),
      until: NOW,
      outcomes: ["ok", "error", "timeout"],
    },
  ]);
  assert.equal(calls.usage.length, 0, "not read from the hourly usage sums");
});

test("latency_avg is the mean of the same samples", async () => {
  const { deps } = build();
  assert.deepEqual(await deps.computeMetric(rule({ metric: "latency_avg" }), NOW), {
    kind: "value",
    value: 840,
    detail: "ms over 37 requests",
  });
});

test("a caller who hung up is not counted: the alert is on answered, failed and timed-out requests", async () => {
  const { deps, calls } = build();
  await deps.computeMetric(rule(), NOW);
  assert.ok(!calls.windows[0]!.outcomes.includes("cancelled"));
});

test("a deployment rule narrows to that deployment inside the rule's organization", async () => {
  const { deps, calls } = build();
  await deps.computeMetric(rule({ resourceType: "deployment", resourceId: DEPLOYMENT }), NOW);
  assert.equal(calls.windows[0]!.orgId, ORG);
  assert.deepEqual(calls.windows[0]!.deploymentIds, [DEPLOYMENT]);
  assert.equal(calls.windows[0]!.agentId, undefined);
});

test("an agent rule is the agent's own chats plus its model deployments", async () => {
  const { deps, calls } = build({
    agentDeployments: [
      { modelDeploymentId: AGENT_DEPLOYMENT },
      { modelDeploymentId: AGENT_DEPLOYMENT },
      { modelDeploymentId: null },
    ],
  });
  await deps.computeMetric(rule({ resourceType: "agent", resourceId: AGENT }), NOW);
  assert.deepEqual(calls.agentDeployments[0].where, { agentId: AGENT });
  assert.equal(calls.windows[0]!.orgId, ORG);
  assert.equal(calls.windows[0]!.agentId, AGENT);
  assert.deepEqual(calls.windows[0]!.deploymentIds, [AGENT_DEPLOYMENT]);
});

test("an agent with no model deployment is still measured by its chats", async () => {
  const { deps, calls } = build({ agentDeployments: [] });
  const computation = await deps.computeMetric(rule({ resourceType: "agent", resourceId: AGENT }), NOW);
  assert.equal(computation.kind, "value");
  assert.equal(calls.windows[0]!.agentId, AGENT);
  assert.deepEqual(calls.windows[0]!.deploymentIds, []);
});

test("another organization's resource id cannot widen the scope: the org stays bound", async () => {
  const { deps, calls } = build({ latency: nothing });
  const computation = await deps.computeMetric(
    rule({ resourceType: "deployment", resourceId: FOREIGN }),
    NOW,
  );
  // The window is the rule's org AND that id; the foreign deployment's rows
  // are in neither, so the rule reads nothing.
  assert.equal(calls.windows[0]!.orgId, ORG);
  assert.deepEqual(calls.windows[0]!.deploymentIds, [FOREIGN]);
  assert.deepEqual(computation, { kind: "no_data" });
});

test("no request in the window is no_data, so an lt rule cannot breach on a missing value", async () => {
  const { deps } = build({ latency: nothing });
  for (const metric of ["latency_p95", "latency_avg"]) {
    assert.deepEqual(
      await deps.computeMetric(rule({ metric, operator: "lt", threshold: 500 }), NOW),
      { kind: "no_data" },
    );
  }
});

test("one request says so in the singular", async () => {
  const { deps } = build({ latency: { sampleCount: 1, avgMs: 900, p50Ms: 900, p95Ms: 900, p99Ms: 900 } });
  const computation = await deps.computeMetric(rule(), NOW);
  assert.equal(computation.kind === "value" && computation.detail, "ms over 1 request");
});

test("a failed read propagates: it is never turned into 0 ms", async () => {
  const { deps } = build({ latency: new Error("connection refused") });
  await assert.rejects(deps.computeMetric(rule(), NOW), /connection refused/);
});

// ============================================
// The other metrics, as before
// ============================================

test("an unknown metric is still unsupported", async () => {
  const { deps, calls } = build();
  const computation = await deps.computeMetric(rule({ metric: "latency_p99" }), NOW);
  assert.equal(computation.kind, "unsupported");
  assert.equal(calls.windows.length, 0);
});

test("error_rate, request_count and cost still come from usage records in the rule's org", async () => {
  const { deps, calls } = build();
  assert.deepEqual(await deps.computeMetric(rule({ metric: "error_rate" }), NOW), { kind: "value", value: 5 });
  assert.deepEqual(await deps.computeMetric(rule({ metric: "request_count" }), NOW), { kind: "value", value: 200 });
  assert.deepEqual(await deps.computeMetric(rule({ metric: "cost" }), NOW), { kind: "value", value: 500 });
  for (const call of calls.usage) {
    assert.equal(call.where.orgId, ORG);
    assert.deepEqual(call.where.periodEnd, { gte: new Date("2026-10-07T11:45:00.000Z") });
  }
  assert.equal(calls.windows.length, 0);
});

test("error_rate with no requests is no_data", async () => {
  const { deps } = build({ usage: { requestCount: 0, errorCount: 0, costCents: null, actualCostCents: null } });
  assert.deepEqual(await deps.computeMetric(rule({ metric: "error_rate" }), NOW), { kind: "no_data" });
});

test("uptime is the share of up checks of the org's monitors, no_data without checks", async () => {
  const up = build({ uptime: [{ status: "up" }, { status: "up" }, { status: "down" }, { status: "up" }] });
  assert.deepEqual(await up.deps.computeMetric(rule({ metric: "uptime" }), NOW), { kind: "value", value: 75 });
  assert.equal(up.calls.uptime[0].where.monitor.orgId, ORG);
  assert.deepEqual(await build().deps.computeMetric(rule({ metric: "uptime" }), NOW), { kind: "no_data" });
});

// ============================================
// Firing
// ============================================

test("only enabled rules are loaded", async () => {
  const { deps, calls } = build();
  await deps.loadEnabledRules();
  assert.deepEqual(calls.rules[0].where, { isEnabled: true });
});

test("firing hands the trigger the value and what it is of, and emits the webhook for the org", async () => {
  const { deps, calls } = build();
  const r = rule();
  const alert = await deps.fireAlert(r, 2_140, "ms over 37 requests");
  assert.deepEqual(alert, { id: "alert_1", title: "slow answers triggered" });
  assert.deepEqual(calls.triggered, [[r, 2_140, undefined, "ms over 37 requests"]]);

  await deps.emitAlertTriggered(r, alert!, 2_140);
  assert.equal(calls.webhooks[0]![0], ORG);
  assert.equal(calls.webhooks[0]![1], "alert.triggered");
});
