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

// Drives apps/api/src/services/runway.ts — the function the runway dashboard
// card (plan A8) calls and the auto-scaler (plan C1) keys off. Pure
// aggregation over UsageRecord rows + treasury balance + sol/USD price.
//
// Inputs are plain shapes (not Prisma rows) so callers can come from API
// routes, workers, or tests without coupling. Currency math is in lamports;
// USD enters only via solPriceUsd at the boundary.

const LAMPORTS_PER_SOL = 1_000_000_000n;
const DAY_SECONDS = 86_400;

function usage({
  start,
  computeSeconds,
  actualCostCents,
}: {
  start: string;
  computeSeconds: number;
  actualCostCents: number;
}) {
  return {
    periodStart: new Date(start),
    periodEnd: new Date(new Date(start).getTime() + 60 * 60 * 1000),
    computeSeconds: BigInt(computeSeconds),
    actualCostCents: BigInt(actualCostCents),
  };
}

// ============================================
// computeDeploymentRunway — happy path
// ============================================

test("computeDeploymentRunway returns runway + alert level + scaling target", async () => {
  setupEnv();
  const { computeDeploymentRunway } = await import("../services/runway.js");

  // 7 days of usage at $1/day = $7 burned over 7d.
  // Burn rate = $1/day = 100 cents/day = ~0.00115740... cents/sec.
  // At 200 USD/SOL → 0.005 SOL/day ≈ 5_000_000 lamports/day.
  // Treasury holds 1 SOL = 1_000_000_000 lamports.
  // Runway ≈ 1_000_000_000 / (5_000_000/86400) ≈ 17_280_000 seconds = 200 days.
  const usageRecords = Array.from({ length: 7 }, (_, i) =>
    usage({
      start: `2026-04-${String(17 + i).padStart(2, "0")}T00:00:00Z`,
      computeSeconds: 8640, // 0.1d worth = $1 at 4090 (8640 * 0.00025 = $2.16) — values for shape; aggregation does not require per-tier math
      actualCostCents: 100,
    }),
  );

  const result = computeDeploymentRunway({
    now: new Date("2026-04-24T00:00:00Z"),
    treasuryBalanceLamports: LAMPORTS_PER_SOL,
    usageRecords,
    solPriceUsd: 200,
    currentReplicas: 1,
    maxReplicas: 10,
  });

  // Lookback default 7d → total $7 → daily $1 → 0.005 SOL/day → 5_000_000 lamports/day
  assert.equal(result.totalCostCents, 700);
  assert.equal(result.lookbackSeconds, 7 * DAY_SECONDS);
  assert.equal(result.burnRateLamportsPerSecond, 5_000_000n / BigInt(DAY_SECONDS));
  // Runway: 1_000_000_000 lamports / (5_000_000 / 86400) lamports/sec
  // = 1_000_000_000 / 57 (truncated) = ~17_543_859 seconds ≈ 203 days
  assert.ok(result.runwaySeconds > 90 * DAY_SECONDS, `expected >90d, got ${result.runwaySeconds}s`);
  assert.equal(result.alertLevel, "healthy");
  // Plush runway → scale up 1 → 3
  assert.equal(result.desiredReplicas, 3);
});

test("computeDeploymentRunway flags critical when treasury is nearly empty", async () => {
  const { computeDeploymentRunway } = await import("../services/runway.js");

  const usageRecords = [
    usage({
      start: "2026-04-23T00:00:00Z",
      computeSeconds: 86_400,
      actualCostCents: 50_000, // $500 in 1 day → very high burn
    }),
  ];

  const result = computeDeploymentRunway({
    now: new Date("2026-04-24T00:00:00Z"),
    treasuryBalanceLamports: 5_000_000n, // 0.005 SOL ≈ $1 at 200 USD/SOL
    usageRecords,
    solPriceUsd: 200,
    currentReplicas: 4,
    maxReplicas: 10,
    lookbackSeconds: DAY_SECONDS,
  });

  assert.equal(result.totalCostCents, 50_000);
  // 0.005 SOL of treasury, $500/day burn = $2.5 SOL/day → runway < 1 day
  assert.ok(result.runwaySeconds < DAY_SECONDS, `expected <1d, got ${result.runwaySeconds}s`);
  assert.equal(result.alertLevel, "critical");
  assert.equal(result.desiredReplicas, 1);
});

test("computeDeploymentRunway treats zero-burn as infinite runway", async () => {
  const { computeDeploymentRunway } = await import("../services/runway.js");

  const result = computeDeploymentRunway({
    now: new Date("2026-04-24T00:00:00Z"),
    treasuryBalanceLamports: LAMPORTS_PER_SOL,
    usageRecords: [],
    solPriceUsd: 200,
    currentReplicas: 1,
    maxReplicas: 10,
  });

  assert.equal(result.totalCostCents, 0);
  assert.equal(result.burnRateLamportsPerSecond, 0n);
  assert.equal(result.runwaySeconds, Number.POSITIVE_INFINITY);
  assert.equal(result.alertLevel, "healthy");
  // No burn → no need to scale
  assert.equal(result.desiredReplicas, 1);
});

test("computeDeploymentRunway clamps the lookback window so old records don't dilute burn rate", async () => {
  const { computeDeploymentRunway } = await import("../services/runway.js");

  // 10-day-old single record + recent silence.
  const usageRecords = [
    usage({
      start: "2026-04-14T00:00:00Z",
      computeSeconds: 86_400,
      actualCostCents: 50_000,
    }),
  ];

  // With default 7-day lookback, the old record is excluded → burn = 0.
  const result = computeDeploymentRunway({
    now: new Date("2026-04-24T00:00:00Z"),
    treasuryBalanceLamports: LAMPORTS_PER_SOL,
    usageRecords,
    solPriceUsd: 200,
    currentReplicas: 1,
    maxReplicas: 10,
  });
  assert.equal(result.totalCostCents, 0);
  assert.equal(result.runwaySeconds, Number.POSITIVE_INFINITY);
});

test("computeDeploymentRunway returns 0 runway when treasury is exhausted", async () => {
  const { computeDeploymentRunway } = await import("../services/runway.js");

  // $1000 over the 7-day lookback at 200 USD/SOL = 5 SOL = 5e9 lamports total
  // → ~8264 lamports/sec, comfortably above BigInt truncation.
  const result = computeDeploymentRunway({
    now: new Date("2026-04-24T00:00:00Z"),
    treasuryBalanceLamports: 0n,
    usageRecords: [
      usage({
        start: "2026-04-23T00:00:00Z",
        computeSeconds: 86_400,
        actualCostCents: 100_000,
      }),
    ],
    solPriceUsd: 200,
    currentReplicas: 2,
    maxReplicas: 10,
  });

  assert.equal(result.runwaySeconds, 0);
  assert.equal(result.alertLevel, "expired");
  assert.equal(result.desiredReplicas, 1);
});

test("computeDeploymentRunway throws on a non-positive sol price", async () => {
  const { computeDeploymentRunway } = await import("../services/runway.js");
  assert.throws(
    () =>
      computeDeploymentRunway({
        now: new Date(),
        treasuryBalanceLamports: 0n,
        usageRecords: [],
        solPriceUsd: 0,
        currentReplicas: 1,
        maxReplicas: 10,
      }),
    /solPriceUsd/,
  );
});

test("computeDeploymentRunway exposes daily and per-second burn in lamports for the dashboard", async () => {
  const { computeDeploymentRunway } = await import("../services/runway.js");

  // $1/day at 200 USD/SOL = 0.005 SOL/day = 5_000_000 lamports/day
  const usageRecords = [
    usage({
      start: "2026-04-23T00:00:00Z",
      computeSeconds: 100,
      actualCostCents: 100,
    }),
  ];

  const result = computeDeploymentRunway({
    now: new Date("2026-04-24T00:00:00Z"),
    treasuryBalanceLamports: LAMPORTS_PER_SOL,
    usageRecords,
    solPriceUsd: 200,
    currentReplicas: 1,
    maxReplicas: 10,
    lookbackSeconds: DAY_SECONDS,
  });

  assert.equal(result.burnLamportsPerDay, 5_000_000n);
  assert.equal(result.burnRateLamportsPerSecond, 5_000_000n / BigInt(DAY_SECONDS));
});
