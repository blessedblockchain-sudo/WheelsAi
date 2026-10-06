import assert from "node:assert/strict";
import test from "node:test";

// Env must be in place BEFORE the route module (and config/env.ts) is imported.
process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";

import sensible from "@fastify/sensible";
import Fastify from "fastify";

import {
  LATENCY_BUCKET_COUNT,
  LATENCY_BUCKETS_MS,
  addHistograms,
  histogramOf,
  latencyBucket,
  latencyPercentile,
  recordAgentUsage,
  summarizeAgentUsage,
  usageIncrement,
  usagePeriodStart,
  type AgentChatUsageEvent,
} from "../services/agentUsage.js";

// Agent chat traffic had no record of its own: no request count that
// included streamed chats, no tokens, no latency. services/agentUsage.ts is
// the hourly rollup; these tests pin what a chat adds to it and how the
// numbers are read back.

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const AT = new Date("2026-10-06T10:20:31.500Z");

const event = (over: Partial<AgentChatUsageEvent> = {}): AgentChatUsageEvent => ({
  orgId: ORG,
  agentId: AGENT_ID,
  source: "api",
  streamed: false,
  ok: true,
  clientGone: false,
  usage: { inputTokens: 100, outputTokens: 20 },
  toolCallCount: 0,
  latencyMs: 300,
  ...over,
});

test("latency buckets: a value falls in the first bucket whose bound holds it; slower than every bound is the last", () => {
  assert.equal(latencyBucket(0), 0);
  assert.equal(latencyBucket(250), 0);
  assert.equal(latencyBucket(251), 1);
  assert.equal(latencyBucket(120_000), LATENCY_BUCKETS_MS.length - 1);
  assert.equal(latencyBucket(120_001), LATENCY_BUCKETS_MS.length);
  assert.equal(histogramOf(300).length, LATENCY_BUCKET_COUNT);
  assert.equal(histogramOf(300)[1], 1);
});

test("a percentile is the ceiling of its bucket, and unknown when it cannot be bounded", () => {
  const h = addHistograms(addHistograms(histogramOf(100), histogramOf(300)), histogramOf(900));
  assert.equal(latencyPercentile(h, 0.5), 500, "2 of 3 samples are at or under 500 ms");
  assert.equal(latencyPercentile(h, 0.95), 1_000);
  assert.equal(latencyPercentile([], 0.5), null, "no sample is not zero milliseconds");
  assert.equal(
    latencyPercentile(histogramOf(500_000), 0.5),
    null,
    "slower than the last bound: no ceiling to state",
  );
  // A row written with fewer buckets still adds up.
  assert.equal(addHistograms([1, 2], histogramOf(100))[0], 2);
});

test("the period is the UTC hour", () => {
  assert.equal(usagePeriodStart(AT).toISOString(), "2026-10-06T10:00:00.000Z");
});

test("an answered chat adds its tokens and latency; unreported usage is counted, not zero-filled", () => {
  const answered = usageIncrement(event({ streamed: true, toolCallCount: 2 }), AT);
  assert.deepEqual(
    [answered.requestCount, answered.errorCount, answered.streamedCount, answered.usageUnreportedCount],
    [1, 0, 1, 0],
  );
  assert.deepEqual([answered.inputTokens, answered.outputTokens, answered.toolCallCount], [100, 20, 2]);
  assert.equal(answered.totalLatencyMs, 300);
  assert.equal(answered.latencyHistogram.reduce((a, b) => a + b, 0), 1);

  const unreported = usageIncrement(event({ usage: null }), AT);
  assert.equal(unreported.usageUnreportedCount, 1);
  assert.deepEqual([unreported.inputTokens, unreported.outputTokens], [0, 0]);
});

test("a failed chat is an error with no latency sample; a client that hung up is neither", () => {
  const failed = usageIncrement(event({ ok: false, usage: null, latencyMs: 20 }), AT);
  assert.deepEqual([failed.requestCount, failed.errorCount, failed.usageUnreportedCount], [1, 1, 0]);
  assert.equal(failed.totalLatencyMs, 0, "a fast failure must not make the agent look quick");
  assert.equal(failed.latencyHistogram.reduce((a, b) => a + b, 0), 0);
  assert.equal(failed.latencyHistogram.length, LATENCY_BUCKET_COUNT);

  const gone = usageIncrement(event({ ok: false, clientGone: true, usage: null }), AT);
  assert.deepEqual([gone.requestCount, gone.errorCount], [1, 0]);
});

test("recordAgentUsage writes one atomic upsert keyed by agent, source and hour", async () => {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  await recordAgentUsage(
    {
      $executeRaw: async (query) => {
        statements.push({ text: query.sql, values: query.values });
        return 1;
      },
    },
    event(),
    AT,
  );
  assert.equal(statements.length, 1);
  const { text, values } = statements[0]!;
  assert.match(text, /INSERT INTO "agent_usage_records"/);
  assert.match(text, /ON CONFLICT \("agent_id", "source", "period_start"\) DO UPDATE/);
  assert.match(text, /"request_count" = r\."request_count" \+ EXCLUDED\."request_count"/);
  assert.match(text, /unnest\(r\."latency_histogram", EXCLUDED\."latency_histogram"\)/);
  // Every value is a bound parameter: nothing from a chat is spliced into SQL.
  assert.ok(values.includes(ORG) && values.includes(AGENT_ID) && values.includes("api"));
  assert.ok(!text.includes(ORG) && !text.includes(AGENT_ID));
  assert.ok(values.some((v) => v instanceof Date && v.toISOString() === "2026-10-06T10:00:00.000Z"));
});

test("a summary averages latency over answered chats and keeps unreported usage visible", () => {
  const rows = [event({ latencyMs: 200 }), event({ latencyMs: 600, usage: null }), event({ ok: false, usage: null })].map(
    (e) => usageIncrement(e, AT),
  );
  const summary = summarizeAgentUsage(rows);
  assert.deepEqual(
    {
      requests: summary.requests,
      errors: summary.errors,
      answered: summary.answered,
      inputTokens: summary.inputTokens,
      usageUnreported: summary.usageUnreported,
      avgLatencyMs: summary.avgLatencyMs,
      p50LatencyMs: summary.p50LatencyMs,
    },
    { requests: 3, errors: 1, answered: 2, inputTokens: 100, usageUnreported: 1, avgLatencyMs: 400, p50LatencyMs: 250 },
  );
  assert.ok(Math.abs(summary.errorRate - 1 / 3) < 1e-9);

  const empty = summarizeAgentUsage([]);
  assert.equal(empty.avgLatencyMs, null, "no traffic is not a 0 ms average");
  assert.equal(empty.errorRate, 0);
});

test("getAgentChatUsage reads only the caller's organization and agent, and splits by source and hour", async () => {
  const { getAgentChatUsage } = await import("../services/analytics.js");
  const wheres: any[] = [];
  const stored = [
    { ...usageIncrement(event({ source: "api" }), AT) },
    { ...usageIncrement(event({ source: "playground", latencyMs: 2_500 }), AT) },
    { ...usageIncrement(event({ source: "api" }), new Date("2026-10-06T11:05:00Z")) },
  ];
  const usage = await getAgentChatUsage(ORG, AGENT_ID, "24h", {
    now: new Date("2026-10-06T12:00:00Z"),
    db: {
      agentUsageRecord: {
        findMany: async (args: any) => {
          wheres.push(args.where);
          return stored;
        },
      },
    } as never,
  });
  assert.deepEqual(wheres[0], {
    orgId: ORG,
    agentId: AGENT_ID,
    periodStart: { gte: new Date("2026-10-05T12:00:00Z") },
  });
  assert.equal(usage.total.requests, 3);
  assert.deepEqual(Object.keys(usage.bySource).sort(), ["api", "playground"]);
  assert.equal(usage.bySource.api!.requests, 2);
  assert.deepEqual(
    usage.series.map((p) => [p.periodStart, p.requests]),
    [
      ["2026-10-06T10:00:00.000Z", 2],
      ["2026-10-06T11:00:00.000Z", 1],
    ],
  );
});

// ============================================
// Routes
// ============================================

async function agentApp(opts: { owned: boolean }) {
  const { createAgentRoutes } = await import("../routes/agents.js");
  const usageCalls: unknown[] = [];
  const app = Fastify();
  await app.register(sensible);
  await app.register(
    createAgentRoutes({
      requireAuth: async (request) => {
        (request as { auth?: unknown }).auth = { orgId: ORG, userId: "user-1" };
      },
      prisma: {
        agent: {
          findFirst: async ({ where }: any) =>
            opts.owned && where.orgId === ORG && where.id === AGENT_ID ? { id: AGENT_ID } : null,
        },
        agentDeployment: {},
      } as never,
      agentUsage: async (orgId, agentId, period) => {
        usageCalls.push([orgId, agentId, period]);
        return { period, since: "x", total: summarizeAgentUsage([]), bySource: {}, series: [] };
      },
    }),
  );
  return { app, usageCalls };
}

test("GET /:agentId/usage answers for the caller's own agent and 404s for anyone else's", async () => {
  const mine = await agentApp({ owned: true });
  const ok = await mine.app.inject({ method: "GET", url: `/${AGENT_ID}/usage?period=7d` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().usage.period, "7d");
  assert.deepEqual(mine.usageCalls, [[ORG, AGENT_ID, "7d"]]);

  const bad = await mine.app.inject({ method: "GET", url: `/${AGENT_ID}/usage?period=1y` });
  assert.equal(bad.statusCode >= 400, true, "an unknown period is refused, not silently defaulted");
  await mine.app.close();

  const theirs = await agentApp({ owned: false });
  const missing = await theirs.app.inject({ method: "GET", url: `/${AGENT_ID}/usage` });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(theirs.usageCalls, [], "no usage is read for an agent the caller does not own");
  await theirs.app.close();
});

test("PATCH entrypoint=graph is refused until the agent has a graph, and bumps the version when it changes", async () => {
  const { prisma } = await import("@wheelsai/db");
  const { createAgentRoutes } = await import("../routes/agents.js");
  let graph: { nodes: unknown[] } | null = null;
  const updates: any[] = [];
  const row = {
    id: AGENT_ID,
    orgId: ORG,
    name: "Support Bot",
    slug: "support-bot",
    version: "1.0.0",
    entrypoint: "chat",
    env: null,
    modelConfig: {},
  };
  const patch: Record<string, unknown> = {
    agent: {
      findFirst: async ({ where }: any) => (where.orgId === ORG && where.id === AGENT_ID ? row : null),
      update: async ({ data }: any) => {
        updates.push(data);
        return { ...row, ...data };
      },
    },
    agentGraph: { findUnique: async () => graph },
    webhook: { findMany: async () => [] },
  };
  const saved: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = (prisma as any)[k];
    (prisma as any)[k] = patch[k];
  }
  const app = Fastify();
  await app.register(sensible);
  await app.register(
    createAgentRoutes({
      requireAuth: async (request) => {
        (request as { auth?: unknown }).auth = { orgId: ORG, userId: "user-1" };
      },
    }),
  );
  try {
    const refused = await app.inject({ method: "PATCH", url: `/${AGENT_ID}`, payload: { entrypoint: "graph" } });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().error, "agent_graph_missing");
    assert.equal(updates.length, 0);

    graph = { nodes: [] };
    const empty = await app.inject({ method: "PATCH", url: `/${AGENT_ID}`, payload: { entrypoint: "graph" } });
    assert.equal(empty.statusCode, 400, "an empty graph answers nothing either");

    graph = { nodes: [{ id: "n1", type: "llm" }] };
    const accepted = await app.inject({ method: "PATCH", url: `/${AGENT_ID}`, payload: { entrypoint: "graph" } });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().agent.entrypoint, "graph");
    assert.equal(updates[0].entrypoint, "graph");
    assert.equal(updates[0].version, "1.0.1", "what answers a chat changed: a new version");

    const unknown = await app.inject({ method: "PATCH", url: `/${AGENT_ID}`, payload: { entrypoint: "container" } });
    assert.equal(unknown.statusCode >= 400, true);
    assert.equal(updates.length, 1);
  } finally {
    await app.close();
    Object.assign(prisma as any, saved);
  }
});
