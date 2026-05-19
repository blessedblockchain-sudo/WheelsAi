/**
 * Per-deployment runway aggregation (plan A8 + C1).
 *
 * Pure aggregation over UsageRecord rows + treasury balance + sol/USD price.
 * Returns the numbers the runway dashboard card renders and the auto-scaler
 * keys off:
 *   - totalCostCents in the lookback window
 *   - burn rate (lamports/second and lamports/day)
 *   - runwaySeconds  (treasury / burn)
 *   - alertLevel     (healthy/warning/critical/expired)
 *   - desiredReplicas (treasury-driven scaling target)
 *
 * Inputs are plain shapes — no Prisma coupling — so the runway dashboard
 * route, BullMQ workers, and unit tests all share the same call site.
 */

import {
  calculateRunwaySeconds,
  computeBurnRate,
  deriveDesiredReplicas,
  deriveRunwayAlertLevel,
  type RunwayAlertLevel,
} from "./treasury.js";

const DAY_SECONDS = 86_400;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const DEFAULT_LOOKBACK_SECONDS = 7 * DAY_SECONDS;

export interface UsageRecordInput {
  periodStart: Date;
  periodEnd: Date;
  computeSeconds: bigint;
  actualCostCents: bigint;
}

export interface RunwayInput {
  now: Date;
  treasuryBalanceLamports: bigint;
  usageRecords: UsageRecordInput[];
  /** USD per 1 SOL — used to convert metered cost into lamports burn. */
  solPriceUsd: number;
  currentReplicas: number;
  maxReplicas: number;
  /** Defaults to the last 7 days. Records older than this are ignored. */
  lookbackSeconds?: number;
}

export interface RunwayResult {
  totalCostCents: number;
  lookbackSeconds: number;
  burnRateLamportsPerSecond: bigint;
  burnLamportsPerDay: bigint;
  runwaySeconds: number;
  alertLevel: RunwayAlertLevel;
  desiredReplicas: number;
}

export function computeDeploymentRunway(input: RunwayInput): RunwayResult {
  if (!(input.solPriceUsd > 0)) {
    throw new Error(`solPriceUsd must be positive, got ${input.solPriceUsd}`);
  }

  const lookbackSeconds = input.lookbackSeconds ?? DEFAULT_LOOKBACK_SECONDS;
  const cutoff = new Date(input.now.getTime() - lookbackSeconds * 1000);

  const recentRecords = input.usageRecords.filter(
    (r) => r.periodEnd >= cutoff,
  );

  const totalCostCents = recentRecords.reduce(
    (sum, r) => sum + Number(r.actualCostCents),
    0,
  );

  // Cents → lamports: cents/100 = USD; USD / solPriceUsd = SOL; SOL * LAMPORTS_PER_SOL = lamports.
  // Floor to never overstate burn (favors longer-looking runway, which only triggers
  // alerts on real shortfall — auto-pay still uses the on-chain measurement).
  const totalLamports = BigInt(
    Math.floor(
      (totalCostCents / 100 / input.solPriceUsd) * Number(LAMPORTS_PER_SOL),
    ),
  );

  const burnRateLamportsPerSecond = computeBurnRate({
    lamportsSpentInPeriod: totalLamports,
    periodSeconds: lookbackSeconds,
  });
  // Compute daily directly from total/lookback so a small per-second rate
  // (lost to BigInt truncation) doesn't zero out the dashboard's daily figure.
  const burnLamportsPerDay =
    lookbackSeconds > 0
      ? (totalLamports * BigInt(DAY_SECONDS)) / BigInt(lookbackSeconds)
      : 0n;

  const runwaySeconds = calculateRunwaySeconds({
    solBalanceLamports: input.treasuryBalanceLamports,
    burnRateLamportsPerSecond,
  });

  const alertLevel = deriveRunwayAlertLevel(runwaySeconds);

  // Without a burn signal we have no basis to scale up. Hold replicas steady
  // (capped at maxReplicas in case currentReplicas drifted past the limit).
  const desiredReplicas =
    burnRateLamportsPerSecond <= 0n
      ? Math.min(input.currentReplicas, input.maxReplicas)
      : deriveDesiredReplicas({
          runwaySeconds,
          currentReplicas: input.currentReplicas,
          maxReplicas: input.maxReplicas,
        });

  return {
    totalCostCents,
    lookbackSeconds,
    burnRateLamportsPerSecond,
    burnLamportsPerDay,
    runwaySeconds,
    alertLevel,
    desiredReplicas,
  };
}
