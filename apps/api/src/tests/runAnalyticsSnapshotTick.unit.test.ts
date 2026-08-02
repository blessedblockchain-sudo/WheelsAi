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
}) {
  const calls: Array<{ orgId: string; day: string }> = [];
  return {
    calls,
    deps: {
      loadActiveOrgIds: async () => opts.orgIds,
      snapshotOrgDay: async (orgId: string, day: Date) => {
        calls.push({ orgId, day: day.toISOString().slice(0, 10) });
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

  assert.deepEqual(result, { orgs: 2, snapshots: 4, empty: 0, failed: 0 });
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

  assert.deepEqual(result, { orgs: 1, snapshots: 0, empty: 2, failed: 0 });
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
