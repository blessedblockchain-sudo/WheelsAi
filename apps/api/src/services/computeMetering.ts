import { createLogger } from "../utils/logger.js";
import { getNosanaClient, MARKETS, type NosanaJob } from "./nosana.js";

const logger = createLogger("compute-metering");

export interface JobComputeCost {
  jobId: string;
  tier: string;
  computeSeconds: number;
  costUsd: number;
  pricePerSecondUsd: number;
  source: "on-chain" | "sdk-reported" | "unavailable";
}

// Thin dependency surface so tests can inject a deterministic job fetcher
// without touching the Nosana SDK or network. Production callers pass no
// deps and get the live client.
export interface MeteringDeps {
  getJobStatus?: (jobId: string) => Promise<NosanaJob | null>;
}

async function resolveJobFetcher(deps?: MeteringDeps) {
  if (deps?.getJobStatus) return deps.getJobStatus;
  const client = await getNosanaClient();
  return (jobId: string) => client.getJobStatus(jobId);
}

/**
 * Convert a GPU-tier key (3060/4070/4090/a100/h100) into the authoritative
 * `pricePerSecond` from nosana.ts:MARKETS. Unknown tiers fall back to the
 * cheapest market so we never undercount; callers should log when this happens.
 */
export function getPricePerSecond(tier: string): number {
  const market = MARKETS[tier];
  if (market) return market.pricePerSecond;
  const fallback = MARKETS["3060"];
  if (!fallback) {
    throw new Error("MARKETS['3060'] missing - nosana market config is corrupt");
  }
  logger.warn({ tier }, "Unknown GPU tier - falling back to 3060 pricing");
  return fallback.pricePerSecond;
}

/**
 * Compute the authoritative compute cost for a Nosana job by reading its
 * on-chain start/end timestamps. This replaces the estimated 70/10/20 split
 * previously used in routes/billing.ts.
 *
 * If the job has not ended yet we return the cost accrued so far (now - start).
 * If the SDK reports a `cost` directly (via sdkJob.price), we prefer that
 * because it accounts for Nosana's settlement math, not just wall-clock time.
 */
export async function calculateJobComputeCost(
  jobId: string,
  tier: string,
  deps?: MeteringDeps,
): Promise<JobComputeCost> {
  const getJobStatus = await resolveJobFetcher(deps);
  const pricePerSecondUsd = getPricePerSecond(tier);

  try {
    const job = await getJobStatus(jobId);
    if (!job) {
      return {
        jobId,
        tier,
        computeSeconds: 0,
        costUsd: 0,
        pricePerSecondUsd,
        source: "unavailable",
      };
    }

    if (job.cost !== undefined) {
      // SDK-reported cost is denominated in USD by the NOS/USD oracle the
      // Nosana SDK uses; treat it as authoritative.
      const inferredSeconds = pricePerSecondUsd > 0 ? job.cost / pricePerSecondUsd : 0;
      return {
        jobId,
        tier,
        computeSeconds: Math.round(inferredSeconds),
        costUsd: job.cost,
        pricePerSecondUsd,
        source: "sdk-reported",
      };
    }

    const start = job.startTime ? job.startTime.getTime() : 0;
    const end = job.endTime ? job.endTime.getTime() : Date.now();
    const computeSeconds = start > 0 ? Math.max(0, Math.round((end - start) / 1000)) : 0;
    const costUsd = computeSeconds * pricePerSecondUsd;

    return {
      jobId,
      tier,
      computeSeconds,
      costUsd,
      pricePerSecondUsd,
      source: "on-chain",
    };
  } catch (error) {
    logger.warn({ error, jobId, tier }, "Failed to compute job cost");
    return {
      jobId,
      tier,
      computeSeconds: 0,
      costUsd: 0,
      pricePerSecondUsd,
      source: "unavailable",
    };
  }
}

// ============================================
// Windowed (delta) metering — remediation D2
// ============================================

/** Billing window. `start: null` means "no lower bound" — bill from each
 * job's own start (the treasury has never been billed before). */
export interface MeteringWindow {
  start: Date | null;
  end: Date;
}

/**
 * Window-clamped compute cost for one Nosana job (remediation D2).
 *
 * The cumulative calculateJobComputeCost above bills the job's whole
 * lifetime — correct for one-shot billing display, but the settlement
 * loop runs every tick, so it must bill only the DELTA since the
 * treasury's lastComputeBillAt cursor. Billable seconds are the overlap
 * of [jobStart, jobEndOrWindowEnd] with [window.start ?? jobStart,
 * window.end]:
 *   - job ended before the window started        → 0 seconds
 *   - job started inside the window              → clamped to jobStart
 *   - job still running                          → clamped to window.end
 *
 * SDK-reported cost is cumulative for the whole job, so it is prorated
 * over the window (effective per-second rate = cost / lifetime seconds)
 * instead of being taken verbatim — taking it verbatim would re-bill the
 * full lifetime every tick, the exact bug this function exists to fix.
 */
export async function calculateJobComputeCostForWindow(
  jobId: string,
  tier: string,
  window: MeteringWindow,
  deps?: MeteringDeps,
): Promise<JobComputeCost> {
  const getJobStatus = await resolveJobFetcher(deps);
  const pricePerSecondUsd = getPricePerSecond(tier);

  try {
    const job = await getJobStatus(jobId);
    if (!job) {
      return {
        jobId,
        tier,
        computeSeconds: 0,
        costUsd: 0,
        pricePerSecondUsd,
        source: "unavailable",
      };
    }

    const jobStartMs = job.startTime ? job.startTime.getTime() : 0;
    if (jobStartMs <= 0) {
      // Not started yet (queued) — nothing billable in any window.
      return {
        jobId,
        tier,
        computeSeconds: 0,
        costUsd: 0,
        pricePerSecondUsd,
        source: "on-chain",
      };
    }

    const windowEndMs = window.end.getTime();
    // Running jobs accrue up to the window end (the tick's `now`), never
    // beyond — the next window picks up from there.
    const jobEndMs = job.endTime ? job.endTime.getTime() : windowEndMs;
    const fromMs = Math.max(jobStartMs, window.start?.getTime() ?? jobStartMs);
    const toMs = Math.min(jobEndMs, windowEndMs);
    const computeSeconds = Math.max(0, Math.round((toMs - fromMs) / 1000));

    if (job.cost !== undefined) {
      const lifetimeSeconds = Math.max(
        0,
        Math.round((jobEndMs - jobStartMs) / 1000),
      );
      const effectiveRate =
        lifetimeSeconds > 0 ? job.cost / lifetimeSeconds : 0;
      return {
        jobId,
        tier,
        computeSeconds,
        costUsd: computeSeconds * effectiveRate,
        pricePerSecondUsd,
        source: "sdk-reported",
      };
    }

    return {
      jobId,
      tier,
      computeSeconds,
      costUsd: computeSeconds * pricePerSecondUsd,
      pricePerSecondUsd,
      source: "on-chain",
    };
  } catch (error) {
    logger.warn({ error, jobId, tier }, "Failed to compute windowed job cost");
    return {
      jobId,
      tier,
      computeSeconds: 0,
      costUsd: 0,
      pricePerSecondUsd,
      source: "unavailable",
    };
  }
}

/**
 * Window-clamped aggregate across every Nosana job attached to a
 * deployment. This is the metering primitive the treasury-settlement
 * worker uses (remediation D2): the window's end becomes both the
 * payment row's periodEnd and the treasury's new lastComputeBillAt.
 */
export async function calculateDeploymentComputeCostForWindow(
  jobIds: string[],
  tier: string,
  window: MeteringWindow,
  deps?: MeteringDeps,
): Promise<{ computeSeconds: number; costUsd: number }> {
  if (jobIds.length === 0) return { computeSeconds: 0, costUsd: 0 };

  const results = await Promise.all(
    jobIds.map((id) => calculateJobComputeCostForWindow(id, tier, window, deps)),
  );

  return results.reduce(
    (acc, r) => ({
      computeSeconds: acc.computeSeconds + r.computeSeconds,
      costUsd: acc.costUsd + r.costUsd,
    }),
    { computeSeconds: 0, costUsd: 0 },
  );
}

/**
 * Aggregate compute cost across every Nosana job attached to a deployment.
 * Bills CUMULATIVE job lifetime — kept for one-shot billing display
 * surfaces. The treasury-settlement path must NOT use this; it uses
 * calculateDeploymentComputeCostForWindow (delta billing, D2).
 */
export async function calculateDeploymentComputeCost(
  jobIds: string[],
  tier: string,
  deps?: MeteringDeps,
): Promise<{ computeSeconds: number; costUsd: number }> {
  if (jobIds.length === 0) return { computeSeconds: 0, costUsd: 0 };

  const results = await Promise.all(
    jobIds.map((id) => calculateJobComputeCost(id, tier, deps)),
  );

  return results.reduce(
    (acc, r) => ({
      computeSeconds: acc.computeSeconds + r.computeSeconds,
      costUsd: acc.costUsd + r.costUsd,
    }),
    { computeSeconds: 0, costUsd: 0 },
  );
}
