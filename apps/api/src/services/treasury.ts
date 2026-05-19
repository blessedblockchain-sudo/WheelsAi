/**
 * Pure treasury math used by:
 *   - treasury-settlement worker (plan A3) to decide when and how much to
 *     drain from a per-agent treasury PDA to the Nosana host
 *   - runway dashboard card (plan A8) to render earned / burned / days left
 *   - auto-scaling loop (plan C1) to adjust desired replicas by runway
 *
 * Everything in here is deterministic and side-effect-free. Anything that
 * talks to Solana, Prisma, or the network belongs in a different module.
 */

const DAY_SECONDS = 86_400;

export type RunwayAlertLevel = "healthy" | "warning" | "critical" | "expired";

// ============================================
// Runway math
// ============================================

export function calculateRunwaySeconds(input: {
  solBalanceLamports: bigint;
  burnRateLamportsPerSecond: bigint;
}): number {
  const { solBalanceLamports, burnRateLamportsPerSecond } = input;
  if (burnRateLamportsPerSecond <= 0n) return Number.POSITIVE_INFINITY;
  if (solBalanceLamports <= 0n) return 0;
  // BigInt division truncates toward zero — acceptable for runway seconds
  // since anything between 0 and 1 seconds of runway is effectively "gone".
  return Number(solBalanceLamports / burnRateLamportsPerSecond);
}

export function deriveRunwayAlertLevel(runwaySeconds: number): RunwayAlertLevel {
  if (runwaySeconds > 14 * DAY_SECONDS) return "healthy";
  if (runwaySeconds > 3 * DAY_SECONDS) return "warning";
  if (runwaySeconds > 0) return "critical";
  return "expired";
}

// ============================================
// Scaling policy
// ============================================

export interface ScalingInput {
  runwaySeconds: number;
  currentReplicas: number;
  maxReplicas: number;
}

export function deriveDesiredReplicas(input: ScalingInput): number {
  const { runwaySeconds, currentReplicas, maxReplicas } = input;
  const alert = deriveRunwayAlertLevel(runwaySeconds);

  // Plush (>90d) → 3x current, capped at maxReplicas
  if (runwaySeconds > 90 * DAY_SECONDS) {
    return Math.min(currentReplicas * 3, maxReplicas);
  }
  // Healthy middle (14d–90d) → hold steady
  if (alert === "healthy") {
    return Math.min(currentReplicas, maxReplicas);
  }
  // Warning (3d–14d) → halve, floor at 1
  if (alert === "warning") {
    return Math.max(1, Math.floor(currentReplicas / 2));
  }
  // Critical or expired → scale to 1
  return 1;
}

// ============================================
// Settlement scheduling
// ============================================

export interface SettlementScheduleInput {
  lastSettledAt: Date | null;
  intervalMs: number;
  now: Date;
}

export function shouldSettleNow(input: SettlementScheduleInput): boolean {
  const { lastSettledAt, intervalMs, now } = input;
  if (!lastSettledAt) return true;
  return now.getTime() - lastSettledAt.getTime() >= intervalMs;
}

// ============================================
// Burn rate
// ============================================

export interface BurnRateInput {
  lamportsSpentInPeriod: bigint;
  periodSeconds: number;
}

export function computeBurnRate(input: BurnRateInput): bigint {
  const { lamportsSpentInPeriod, periodSeconds } = input;
  if (periodSeconds <= 0) return 0n;
  return lamportsSpentInPeriod / BigInt(periodSeconds);
}
