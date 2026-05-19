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

/**
 * Aggregate compute cost across every Nosana job attached to a deployment.
 * Used by billing + the treasury-settlement worker (plan A3) to figure out
 * how much the agent owes for the current period.
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
