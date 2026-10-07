import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLatencySampleDeps,
  latencyConfigFromEnv,
  type LatencyPrisma,
} from "../services/buildLatencySampleDeps.js";
import { HISTOGRAM_EDGES_MS } from "../services/latencyQueries.js";
import { PUBLIC_LATENCY_SURFACES, buildLatencySample } from "../services/latencySamples.js";

// Binding test: the composition root must hand the pure parts the real
// database calls, in the driver's own shapes - a count that arrives as a
// bigint, a percentile that arrives as NULL - without ever turning "no data"
// into a number.

const ORG = "11111111-1111-4111-8111-111111111111";
const EXCLUDED = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-10-07T09:00:00.000Z");

const config = { windowHours: 24, excludedOrgIds: [EXCLUDED], maxSamplesPerOrg: 17, retentionDays: 30 };

function fakePrisma(answers: { rows?: unknown[]; executed?: number[] } = {}) {
  const calls = {
    createMany: [] as Array<{ data: unknown[] }>,
    queries: [] as Array<{ text: string; values: unknown[] }>,
    executes: [] as Array<{ text: string; values: unknown[] }>,
  };
  const executed = [...(answers.executed ?? [0])];
  const prisma: LatencyPrisma = {
    requestLatencySample: {
      createMany: async (args) => {
        calls.createMany.push(args);
        return { count: args.data.length };
      },
    },
    $queryRawUnsafe: (async (text: string, ...values: unknown[]) => {
      calls.queries.push({ text, values });
      return answers.rows ?? [];
    }) as LatencyPrisma["$queryRawUnsafe"],
    $executeRawUnsafe: async (text, ...values) => {
      calls.executes.push({ text, values });
      return executed.shift() ?? 0;
    },
  };
  return { prisma, calls };
}

const build = (answers: Parameters<typeof fakePrisma>[0] = {}) => {
  const { prisma, calls } = fakePrisma(answers);
  return { deps: buildLatencySampleDeps({ config, prisma, now: () => NOW }), calls };
};

test("every dependency a caller needs is bound", () => {
  const { deps } = build();
  assert.deepEqual(Object.keys(deps).sort(), [
    "close",
    "loadGroupedLatency",
    "loadLatencyHistogram",
    "loadOutcomeCounts",
    "loadPublicLatencyRow",
    "loadScopedLatency",
    "pruneLatencySamples",
    "recordLatency",
  ]);
});

test("a recorded sample is written by createMany, off the caller's path", async () => {
  const { deps, calls } = build();
  const sample = buildLatencySample(
    { orgId: ORG, surface: "v1", provider: "nosana", streamed: false, outcome: "ok", totalMs: 612 },
    NOW,
  );
  deps.recordLatency(sample);
  deps.recordLatency(null);
  assert.deepEqual(calls.createMany, [], "recording returns before anything is written");
  await deps.close();
  assert.deepEqual(calls.createMany, [{ data: [sample] }]);
});

test("the public window is the configured hours back from now, on the public surfaces, minus excluded orgs", async () => {
  const { deps, calls } = build({ rows: [{ n: 0, orgs: 0, p50: null, p95: null, first_token_n: 0, first_token_p50: null }] });
  await deps.loadPublicLatencyRow();
  assert.deepEqual(calls.queries[0]!.values, [
    new Date("2026-10-06T09:00:00.000Z"),
    [...PUBLIC_LATENCY_SURFACES],
    [EXCLUDED],
    17,
  ]);
});

test("the histogram and the error share are read under the same per-organization cap as the figure", async () => {
  const { deps, calls } = build({ rows: [] });
  await deps.loadPublicLatencyRow();
  await deps.loadLatencyHistogram();
  await deps.loadOutcomeCounts();
  assert.deepEqual(calls.queries.map((query) => query.values[3]), [17, 17, 17]);
  for (const query of calls.queries) assert.match(query.text, /org_rank <= \$4/);
});

test("driver shapes are mapped: bigint and numeric strings become numbers", async () => {
  const { deps } = build({
    rows: [
      { n: 1284n, orgs: 7n, p50: 612, p95: "2140", first_token_n: 402n, first_token_orgs: 5n, first_token_p50: 380 },
    ],
  });
  assert.deepEqual(await deps.loadPublicLatencyRow(), {
    windowHours: 24,
    sampleCount: 1284,
    orgCount: 7,
    p50Ms: 612,
    p95Ms: 2140,
    firstTokenSampleCount: 402,
    firstTokenOrgCount: 5,
    firstTokenP50Ms: 380,
    computedAt: NOW,
  });
});

test("an empty table yields counts of zero and NO latency number", async () => {
  for (const rows of [
    [{ n: 0, orgs: 0, p50: null, p95: null, first_token_n: 0, first_token_p50: null }],
    // Even a driver that answered a stray value for an empty set.
    [{ n: 0, orgs: 0, p50: 0, p95: 0, first_token_n: 0, first_token_p50: 0 }],
    [],
  ]) {
    const { deps } = build({ rows });
    const row = await deps.loadPublicLatencyRow();
    assert.deepEqual(
      [row.sampleCount, row.orgCount, row.p50Ms, row.p95Ms, row.firstTokenSampleCount, row.firstTokenP50Ms],
      [0, 0, null, null, 0, null],
    );
  }
});

test("answers without a first token leave that figure null beside a real p50", async () => {
  const { deps } = build({
    rows: [{ n: 80, orgs: 4, p50: 900, p95: 3000, first_token_n: 0, first_token_p50: null }],
  });
  const row = await deps.loadPublicLatencyRow();
  assert.deepEqual([row.p50Ms, row.firstTokenSampleCount, row.firstTokenP50Ms], [900, 0, null]);
});

test("outcome counts name every ending, zero where none was recorded", async () => {
  const { deps } = build({
    rows: [
      { outcome: "ok", n: 95n },
      { outcome: "timeout", n: 2 },
      { outcome: "something_else", n: 9 },
    ],
  });
  assert.deepEqual(await deps.loadOutcomeCounts(), { ok: 95, error: 0, timeout: 2, cancelled: 0 });
});

test("the histogram has every bucket, the last one open-ended", async () => {
  const { deps, calls } = build({ rows: [{ bucket: 0, n: 3n }, { bucket: 7, n: 1 }] });
  const histogram = await deps.loadLatencyHistogram();
  assert.deepEqual(
    histogram.map((bucket) => bucket.upToMs),
    [...HISTOGRAM_EDGES_MS, null],
  );
  assert.deepEqual(
    histogram.map((bucket) => bucket.count),
    [3, 0, 0, 0, 0, 0, 0, 1],
  );
  assert.deepEqual(calls.queries[0]!.values[4], [...HISTOGRAM_EDGES_MS]);
});

test("a scoped read passes the window through and rounds only the average", async () => {
  const { deps, calls } = build({ rows: [{ n: 12n, avg: 1234.56, p50: 900, p95: 4000, p99: 5000 }] });
  const since = new Date("2026-10-07T08:55:00.000Z");
  const latency = await deps.loadScopedLatency({
    orgId: ORG,
    since,
    until: NOW,
    outcomes: ["ok", "error", "timeout"],
    deploymentIds: ["33333333-3333-4333-8333-333333333333"],
  });
  assert.deepEqual(latency, { sampleCount: 12, avgMs: 1235, p50Ms: 900, p95Ms: 4000, p99Ms: 5000 });
  assert.deepEqual(calls.queries[0]!.values, [
    ORG,
    since,
    NOW,
    ["ok", "error", "timeout"],
    ["33333333-3333-4333-8333-333333333333"],
  ]);
});

test("a scope with no samples is all null, never 0 ms", async () => {
  const { deps } = build({ rows: [{ n: 0, avg: null, p50: null, p95: null, p99: null }] });
  assert.deepEqual(
    await deps.loadScopedLatency({ orgId: ORG, since: NOW, until: NOW, outcomes: ["ok"] }),
    { sampleCount: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
  );
});

test("a failing query propagates: a reader decides what an outage means, not a zero", async () => {
  const { prisma } = fakePrisma();
  prisma.$queryRawUnsafe = (async () => {
    throw new Error("connection refused");
  }) as LatencyPrisma["$queryRawUnsafe"];
  const deps = buildLatencySampleDeps({ config, prisma, now: () => NOW });
  await assert.rejects(deps.loadPublicLatencyRow(), /connection refused/);
  await assert.rejects(
    deps.loadScopedLatency({ orgId: ORG, since: NOW, until: NOW, outcomes: ["ok"] }),
    /connection refused/,
  );
});

test("prune deletes samples older than the retention, batch after batch until one comes back short", async () => {
  const { deps, calls } = build({ executed: [5_000, 5_000, 120] });
  assert.equal(await deps.pruneLatencySamples(), 10_120);
  assert.equal(calls.executes.length, 3);
  for (const call of calls.executes) {
    assert.match(call.text, /DELETE FROM request_latency_samples/);
    assert.deepEqual(call.values, [new Date("2026-09-07T09:00:00.000Z"), 5_000]);
  }
});

test("prune with nothing to delete runs one statement", async () => {
  const { deps, calls } = build({ executed: [0] });
  assert.equal(await deps.pruneLatencySamples(), 0);
  assert.equal(calls.executes.length, 1);
});

test("the settings come from the environment's own names", () => {
  assert.deepEqual(
    latencyConfigFromEnv({
      PUBLIC_LATENCY_WINDOW_HOURS: 48,
      PUBLIC_LATENCY_MIN_SAMPLES: 50,
      PUBLIC_LATENCY_MIN_ORGS: 3,
      PUBLIC_LATENCY_EXCLUDED_ORG_IDS: [EXCLUDED],
      LATENCY_SAMPLE_RETENTION_DAYS: 14,
    }),
    // The cap is an equal share of the minimum (50 / 3, rounded up), derived
    // rather than configured so it cannot drift from the thresholds.
    { windowHours: 48, excludedOrgIds: [EXCLUDED], maxSamplesPerOrg: 17, retentionDays: 14 },
  );
});

test("a breakdown maps each group and drops a key that has no sample", async () => {
  const { deps, calls } = build({
    rows: [
      { key: "dep-a", n: 3n, avg: "700.4", p50: 600, p95: 1200, p99: 1200 },
      { key: "dep-b", n: 0, avg: null, p50: null, p95: null, p99: null },
    ],
  });
  const groups = await deps.loadGroupedLatency(
    { orgId: ORG, since: NOW, until: NOW, outcomes: ["ok"] },
    "deployment",
  );
  assert.deepEqual([...groups.entries()], [
    ["dep-a", { sampleCount: 3, avgMs: 700, p50Ms: 600, p95Ms: 1200, p99Ms: 1200 }],
  ]);
  assert.match(calls.queries[0]!.text, /GROUP BY deployment_id/);
  assert.equal(calls.queries[0]!.values[0], ORG);
});
