import assert from "node:assert/strict";
import test from "node:test";

import type { NosanaJob } from "../services/nosana.js";
import type {
  BillingWindow,
  DeploymentForSettlement,
} from "../services/treasurySettlement.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/computeCostForDeployment.ts — the adapter
// the treasury-settlement worker wires into SettlementCycleDeps.
// Windowed since remediation D2: the provider receives the billing
// window and forwards it to calculateDeploymentComputeCostForWindow so
// the settlement path bills deltas, never cumulative job lifetime.

function makeJobFetcher(map: Record<string, NosanaJob | null>) {
  return async (jobId: string): Promise<NosanaJob | null> =>
    map[jobId] ?? null;
}

const baseDeployment: DeploymentForSettlement = {
  id: "deploy-1",
  orgId: "org-1",
  gpuTier: "4070",
  nosanaJobIds: [],
  replicas: 1,
  agentTokenId: "tok-1",
};

// A window with no lower bound that comfortably covers every fixture
// job — equivalent to "first-ever bill", so full-lifetime expectations
// from the pre-D2 tests still hold.
const OPEN_WINDOW: BillingWindow = {
  start: null,
  end: new Date(1_800_000_000_000),
};

test("makeComputeCostProvider: zero jobs → zero cost", async () => {
  setupEnv();
  const { makeComputeCostProvider } = await import(
    "../services/computeCostForDeployment.js"
  );

  const getComputeCost = makeComputeCostProvider({
    getJobStatus: makeJobFetcher({}),
  });

  const result = await getComputeCost(
    {
      ...baseDeployment,
      nosanaJobIds: [],
    },
    OPEN_WINDOW,
  );

  assert.equal(result.computeSeconds, 0);
  assert.equal(result.costUsd, 0);
});

test("makeComputeCostProvider: single job uses tier price-per-second", async () => {
  setupEnv();
  const { makeComputeCostProvider } = await import(
    "../services/computeCostForDeployment.js"
  );

  // 4070 = 0.00015 USD/sec; 60 seconds = 0.009 USD.
  const startTime = new Date(1_700_000_000_000);
  const endTime = new Date(startTime.getTime() + 60_000);

  const getComputeCost = makeComputeCostProvider({
    getJobStatus: makeJobFetcher({
      "job-a": {
        id: "job-a",
        market: "M",
        status: "completed",
        startTime,
        endTime,
      },
    }),
  });

  const result = await getComputeCost(
    {
      ...baseDeployment,
      gpuTier: "4070",
      nosanaJobIds: ["job-a"],
    },
    OPEN_WINDOW,
  );

  assert.equal(result.computeSeconds, 60);
  // floating point — close enough.
  assert.ok(
    Math.abs(result.costUsd - 0.009) < 1e-9,
    `expected ~0.009 got ${result.costUsd}`,
  );
});

test("makeComputeCostProvider: multi-job aggregates seconds and cost", async () => {
  setupEnv();
  const { makeComputeCostProvider } = await import(
    "../services/computeCostForDeployment.js"
  );

  // Two 30-second jobs on a 4070 (0.00015/sec) = 60s, 0.009 USD.
  const t0 = new Date(1_700_000_000_000);
  const mk = (offsetMs: number, durMs: number): NosanaJob => ({
    id: `job-${offsetMs}`,
    market: "M",
    status: "completed",
    startTime: new Date(t0.getTime() + offsetMs),
    endTime: new Date(t0.getTime() + offsetMs + durMs),
  });

  const getComputeCost = makeComputeCostProvider({
    getJobStatus: makeJobFetcher({
      "job-1": mk(0, 30_000),
      "job-2": mk(60_000, 30_000),
    }),
  });

  const result = await getComputeCost(
    {
      ...baseDeployment,
      gpuTier: "4070",
      nosanaJobIds: ["job-1", "job-2"],
    },
    OPEN_WINDOW,
  );

  assert.equal(result.computeSeconds, 60);
  assert.ok(Math.abs(result.costUsd - 0.009) < 1e-9);
});

test("makeComputeCostProvider: missing job is skipped (counts 0)", async () => {
  setupEnv();
  const { makeComputeCostProvider } = await import(
    "../services/computeCostForDeployment.js"
  );

  const getComputeCost = makeComputeCostProvider({
    getJobStatus: makeJobFetcher({}),
  });

  const result = await getComputeCost(
    {
      ...baseDeployment,
      nosanaJobIds: ["does-not-exist"],
    },
    OPEN_WINDOW,
  );

  assert.equal(result.computeSeconds, 0);
  assert.equal(result.costUsd, 0);
});

test("makeComputeCostProvider: SDK-reported cost is prorated over the window", async () => {
  setupEnv();
  const { makeComputeCostProvider } = await import(
    "../services/computeCostForDeployment.js"
  );

  // SDK reports cost=1.5 USD for a 60s job. With a window covering the
  // whole lifetime, the prorated cost is the full 1.5 — and
  // computeSeconds is the wall-clock seconds inside the window (60),
  // NOT back-derived from cost/rate: the windowed metering keeps
  // seconds and dollars independently window-clamped (D2).
  // (startTime must be > epoch — 0 is the metering's "not started yet"
  // sentinel.)
  const t0 = new Date(1_700_000_000_000);
  const getComputeCost = makeComputeCostProvider({
    getJobStatus: makeJobFetcher({
      "job-x": {
        id: "job-x",
        market: "M",
        status: "completed",
        startTime: t0,
        endTime: new Date(t0.getTime() + 60_000),
        cost: 1.5,
      },
    }),
  });

  const result = await getComputeCost(
    {
      ...baseDeployment,
      gpuTier: "4070",
      nosanaJobIds: ["job-x"],
    },
    OPEN_WINDOW,
  );

  assert.ok(
    Math.abs(result.costUsd - 1.5) < 1e-9,
    `expected ~1.5 got ${result.costUsd}`,
  );
  assert.equal(result.computeSeconds, 60);
});

test("makeComputeCostProvider: bills only the delta window, not cumulative lifetime", async () => {
  // The settlement-path regression D2 exists to prevent: a 2-hour job
  // with a cursor 1 hour ago must bill 1 hour.
  setupEnv();
  const { makeComputeCostProvider } = await import(
    "../services/computeCostForDeployment.js"
  );

  const jobStart = new Date("2026-01-01T10:00:00Z");
  const getComputeCost = makeComputeCostProvider({
    getJobStatus: makeJobFetcher({
      "job-long": {
        id: "job-long",
        market: "M",
        status: "running",
        startTime: jobStart,
        endTime: undefined,
      },
    }),
  });

  const result = await getComputeCost(
    {
      ...baseDeployment,
      gpuTier: "4070",
      nosanaJobIds: ["job-long"],
    },
    {
      start: new Date("2026-01-01T11:00:00Z"),
      end: new Date("2026-01-01T12:00:00Z"),
    },
  );

  assert.equal(result.computeSeconds, 3600);
  assert.ok(Math.abs(result.costUsd - 3600 * 0.00015) < 1e-9);
});
