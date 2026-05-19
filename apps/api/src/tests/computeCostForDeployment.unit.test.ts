import assert from "node:assert/strict";
import test from "node:test";

import type { NosanaJob } from "../services/nosana.js";
import type { DeploymentForSettlement } from "../services/treasurySettlement.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

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

test("makeComputeCostProvider: zero jobs → zero cost", async () => {
  setupEnv();
  const { makeComputeCostProvider } = await import(
    "../services/computeCostForDeployment.js"
  );

  const getComputeCost = makeComputeCostProvider({
    getJobStatus: makeJobFetcher({}),
  });

  const result = await getComputeCost({
    ...baseDeployment,
    nosanaJobIds: [],
  });

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

  const result = await getComputeCost({
    ...baseDeployment,
    gpuTier: "4070",
    nosanaJobIds: ["job-a"],
  });

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

  const result = await getComputeCost({
    ...baseDeployment,
    gpuTier: "4070",
    nosanaJobIds: ["job-1", "job-2"],
  });

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

  const result = await getComputeCost({
    ...baseDeployment,
    nosanaJobIds: ["does-not-exist"],
  });

  assert.equal(result.computeSeconds, 0);
  assert.equal(result.costUsd, 0);
});

test("makeComputeCostProvider: SDK-reported cost (USD) wins over wall-clock", async () => {
  setupEnv();
  const { makeComputeCostProvider } = await import(
    "../services/computeCostForDeployment.js"
  );

  // SDK reports cost=1.5 USD; tier price 0.00015 → implied seconds = 10000
  const getComputeCost = makeComputeCostProvider({
    getJobStatus: makeJobFetcher({
      "job-x": {
        id: "job-x",
        market: "M",
        status: "completed",
        startTime: new Date(0),
        endTime: new Date(60_000), // 60s wall clock — should be IGNORED
        cost: 1.5,
      },
    }),
  });

  const result = await getComputeCost({
    ...baseDeployment,
    gpuTier: "4070",
    nosanaJobIds: ["job-x"],
  });

  assert.equal(result.costUsd, 1.5);
  assert.equal(result.computeSeconds, 10_000);
});
