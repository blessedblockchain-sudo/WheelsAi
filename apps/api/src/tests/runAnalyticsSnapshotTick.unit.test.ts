import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/runAnalyticsSnapshotTick.ts (Wave 1) —
// the first caller createDailySnapshot ever had.

const NOW = new Date("2026-08-02T15:00:00Z");

function makeDeps(opts: {
  orgIds: string[];
  results?: Record<string, unknown | null | Error>;
  prune?: number | Error;
}) {
  const calls: Array<{ orgId: string; day: string }> = [];
  const order: string[] = [];
  return {
    calls,
    order,
    deps: {
      pruneLatencySamples: async () => {
        order.push("prune");
        if (opts.prune instanceof Error) throw opts.prune;
        return opts.prune ?? 0;
      },
      loadActiveOrgIds: async () => opts.orgIds,
      snapshotOrgDay: async (orgId: string, day: Date) => {
        calls.push({ orgId, day: day.toISOString().slice(0, 10) });
        order.push("snapshot");
        const r = opts.results?.[orgId];
        if (r instanceof Error) throw r;
        return r === undefined ? { id: "snap" } : r;
      },
    },
  };
}

test("each active org snapshots yesterday AND today", async () => {
  setupEnv();
  const { runAnalyticsSnapshotTick } = await import(
    "../services/runAnalyticsSnapshotTick.js"
  );
  const { deps, calls } = makeDeps({ orgIds: ["org_a", "org_b"] });
  const result = await runAnalyticsSnapshotTick({ now: NOW }, deps);

  assert.deepEqual(result, {
    orgs: 2,
    snapshots: 4,
    empty: 0,
    failed: 0,
    prunedLatencySamples: 0,
    latencyPruneFailed: false,
  });
  assert.deepEqual(calls, [
    { orgId: "org_a", day: "2026-08-01" },
    { orgId: "org_a", day: "2026-08-02" },
    { orgId: "org_b", day: "2026-08-01" },
    { orgId: "org_b", day: "2026-08-02" },
  ]);
});

test("null snapshots (no usage that day) count as empty, not failures", async () => {
  const { runAnalyticsSnapshotTick } = await import(
    "../services/runAnalyticsSnapshotTick.js"
  );
  const { deps } = makeDeps({ orgIds: ["org_quiet"], results: { org_quiet: null } });
  const result = await runAnalyticsSnapshotTick({ now: NOW }, deps);

  assert.deepEqual(result, {
    orgs: 1,
    snapshots: 0,
    empty: 2,
    failed: 0,
    prunedLatencySamples: 0,
    latencyPruneFailed: false,
  });
});

test("per-org isolation: one org's failure never stops the others", async () => {
  const { runAnalyticsSnapshotTick } = await import(
    "../services/runAnalyticsSnapshotTick.js"
  );
  const { deps, calls } = makeDeps({
    orgIds: ["org_bad", "org_good"],
    results: { org_bad: new Error("db hiccup") },
  });
  const result = await runAnalyticsSnapshotTick({ now: NOW }, deps);

  assert.equal(result.failed, 2); // both of org_bad's days
  assert.equal(result.snapshots, 2); // both of org_good's days
  assert.equal(calls.length, 4);
});

// ============================================
// Latency retention
// ============================================

test("each tick prunes latency samples once, after the snapshots are written", async () => {
  const { runAnalyticsSnapshotTick } = await import(
    "../services/runAnalyticsSnapshotTick.js"
  );
  const { deps, order } = makeDeps({ orgIds: ["org_a"], prune: 10_120 });
  const result = await runAnalyticsSnapshotTick({ now: NOW }, deps);

  assert.equal(result.prunedLatencySamples, 10_120);
  assert.equal(result.latencyPruneFailed, false);
  // A day is summarised before any of its samples can be deleted.
  assert.deepEqual(order, ["snapshot", "snapshot", "prune"]);
});

test("the prune runs even when no org had usage", async () => {
  const { runAnalyticsSnapshotTick } = await import(
    "../services/runAnalyticsSnapshotTick.js"
  );
  const { deps, order } = makeDeps({ orgIds: [], prune: 3 });
  const result = await runAnalyticsSnapshotTick({ now: NOW }, deps);
  assert.deepEqual(order, ["prune"]);
  assert.equal(result.prunedLatencySamples, 3);
});

test("a failed prune is reported and the snapshots are still written", async () => {
  const { runAnalyticsSnapshotTick } = await import(
    "../services/runAnalyticsSnapshotTick.js"
  );
  const { deps } = makeDeps({ orgIds: ["org_a"], prune: new Error("lock timeout") });
  const result = await runAnalyticsSnapshotTick({ now: NOW }, deps);

  assert.equal(result.snapshots, 2);
  assert.equal(result.failed, 0, "a snapshot did not fail");
  assert.equal(result.latencyPruneFailed, true);
  assert.equal(result.prunedLatencySamples, 0);
});

// ============================================
// The snapshot's latency (services/analytics.ts createDailySnapshot)
// ============================================

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

function snapshotDb(usage: { requestCount: number; totalLatencyMs: bigint }[]) {
  const upserts: any[] = [];
  const db = {
    usageRecord: {
      findMany: async () =>
        usage.map((u) => ({
          ...u,
          inputTokens: 10n,
          outputTokens: 20n,
          costCents: 1n,
          errorCount: 0,
        })),
    },
    agentUsageRecord: {
      findMany: async () => [
        {
          agentId: AGENT,
          requestCount: 2,
          errorCount: 0,
          streamedCount: 0,
          inputTokens: 5n,
          outputTokens: 5n,
          usageUnreportedCount: 0,
          totalLatencyMs: 1_000n,
          toolCallCount: 0,
          latencyHistogram: [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        },
      ],
    },
    deployment: { findMany: async () => [] },
    agentDeployment: { findMany: async () => [] },
    analyticsSnapshot: {
      upsert: async (args: any) => {
        upserts.push(args);
        return { id: "snap" };
      },
    },
  };
  return { db: db as never, upserts };
}

// Two hours whose MEANS are 100 ms and 900 ms: the old code stored
// "percentiles" of those two means.
const HOURLY_MEANS = [
  { requestCount: 10, totalLatencyMs: 1_000n },
  { requestCount: 10, totalLatencyMs: 9_000n },
];

test("a snapshot's avg and percentiles are the day's samples, not means of hourly means", async () => {
  setupEnv();
  const { createDailySnapshot } = await import("../services/analytics.js");
  const { db, upserts } = snapshotDb(HOURLY_MEANS);
  const windows: any[] = [];
  await createDailySnapshot(ORG, NOW, {
    db,
    latency: {
      loadScopedLatency: async (window) => {
        windows.push(window);
        return { sampleCount: 20, avgMs: 431, p50Ms: 212, p95Ms: 1_875, p99Ms: 4_020 };
      },
      loadGroupedLatency: async (window, groupBy) => {
        windows.push({ ...window, groupBy });
        return new Map([[AGENT, { sampleCount: 2, avgMs: 480, p50Ms: 455, p95Ms: 505, p99Ms: 505 }]]);
      },
    },
  });

  const measured = { avgLatencyMs: 431, p50LatencyMs: 212, p95LatencyMs: 1_875, p99LatencyMs: 4_020 };
  for (const write of [upserts[0].create, upserts[0].update]) {
    assert.deepEqual(
      {
        avgLatencyMs: write.avgLatencyMs,
        p50LatencyMs: write.p50LatencyMs,
        p95LatencyMs: write.p95LatencyMs,
        p99LatencyMs: write.p99LatencyMs,
      },
      measured,
    );
  }
  // The agent's chat latency in the same snapshot is its samples too, not the
  // 500 ms ceiling of its histogram bucket.
  assert.equal(upserts[0].create.agentStats[AGENT].chat.p50LatencyMs, 455);

  // One organization, one whole day, answered requests only.
  assert.equal(windows[0].orgId, ORG);
  assert.deepEqual(windows[0].outcomes, ["ok"]);
  assert.equal(windows[0].until.getTime() - windows[0].since.getTime(), 24 * 60 * 60 * 1000);
  assert.ok(windows[0].since <= NOW && NOW < windows[0].until);
  assert.equal(windows[1].groupBy, "agent");
  assert.equal(windows[1].orgId, ORG);
});

test("a day with usage and no latency sample stores NULL, never 0 and never the usage sums' mean", async () => {
  const { createDailySnapshot } = await import("../services/analytics.js");
  const { db, upserts } = snapshotDb(HOURLY_MEANS);
  await createDailySnapshot(ORG, NOW, {
    db,
    latency: {
      loadScopedLatency: async () => ({ sampleCount: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null }),
      loadGroupedLatency: async () => new Map(),
    },
  });
  for (const write of [upserts[0].create, upserts[0].update]) {
    assert.deepEqual(
      [write.avgLatencyMs, write.p50LatencyMs, write.p95LatencyMs, write.p99LatencyMs],
      [null, null, null, null],
    );
  }
  assert.equal(upserts[0].create.agentStats[AGENT].chat.p50LatencyMs, null);
  assert.equal(upserts[0].create.totalRequests, 20n, "the counts are untouched");
});

test("a failed latency read fails the snapshot rather than writing it without", async () => {
  const { createDailySnapshot } = await import("../services/analytics.js");
  const { db, upserts } = snapshotDb(HOURLY_MEANS);
  await assert.rejects(
    createDailySnapshot(ORG, NOW, {
      db,
      latency: {
        loadScopedLatency: async () => {
          throw new Error("connection refused");
        },
        loadGroupedLatency: async () => new Map(),
      },
    }),
    /connection refused/,
  );
  assert.equal(upserts.length, 0);
});
