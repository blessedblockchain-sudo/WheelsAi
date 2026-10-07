/**
 * The Nosana side of a training job, with the access mode it was created with.
 *
 * A training job is one batch deployment. TrainingJob has no vault stamp and
 * a cancelled or failed row is never looked at again, so anything that may
 * still be running (or holding platform funds) is handed to the orphan sweep -
 * WITH the credential that created it. Without the mode the sweep reads the
 * record as the wallet's and can never stop a deployment the API key created.
 *
 * Pure: the Nosana client and the orphan writer are injected.
 */

import { rowAccessMode, type NosanaAccessMode } from "../config/nosanaAccess.js";
import type { RecordNosanaOrphanArgs } from "./nosanaOrphans.js";

export interface TrainingNosanaDeps {
  stopDeployment(
    id: string,
    mode?: NosanaAccessMode,
  ): Promise<{ reclaimed: boolean; stopped?: boolean }>;
  recordOrphan(args: RecordNosanaOrphanArgs): Promise<boolean>;
  onStopError?(err: unknown): void;
}

/** What to store on the row once Nosana created the deployment: the id AND its account. */
export function trainingSubmitStamp(nosanaJob: {
  id: string;
  accessMode?: NosanaAccessMode;
}): { nosanaJobId: string; nosanaAccessMode: NosanaAccessMode | null } {
  // Absent only on the dev mock, which was never on Nosana.
  return { nosanaJobId: nosanaJob.id, nosanaAccessMode: nosanaJob.accessMode ?? null };
}

/**
 * Stops a cancelled job's deployment through the credential that created it.
 * Unless the stop landed AND the funding is verified released, the id goes to
 * the sweep with that same credential's mode. Never throws.
 */
export async function stopCancelledTrainingJob(
  deps: TrainingNosanaDeps,
  job: { id: string; nosanaJobId: string; nosanaAccessMode?: string | null },
): Promise<{ settled: boolean }> {
  const accessMode = rowAccessMode(job.nosanaAccessMode);
  const settled = await deps
    .stopDeployment(job.nosanaJobId, accessMode)
    .then((stop) => stop.reclaimed)
    .catch((err) => {
      deps.onStopError?.(err);
      return false;
    });
  if (!settled) {
    await deps.recordOrphan({
      nosanaDeploymentId: job.nosanaJobId,
      sourceKind: "training",
      sourceId: job.id,
      reason: "training_cancelled",
      accessMode,
    });
  }
  return { settled };
}

/**
 * After a failed submit: a failure past creation carries the Nosana id (and
 * the mode the failed call used). Unless its cleanup verified it stopped and
 * released, keep it for the sweep. Returns whether a record was needed.
 */
export async function recordFailedTrainingSubmit(
  deps: Pick<TrainingNosanaDeps, "recordOrphan">,
  jobId: string,
  error: unknown,
): Promise<boolean> {
  const e = error as {
    deploymentId?: unknown;
    accessMode?: unknown;
    cleanup?: { stopped?: boolean; reclaimed?: boolean };
  } | null;
  if (!e || typeof e.deploymentId !== "string" || e.deploymentId === "") return false;
  if (e.cleanup?.stopped && e.cleanup.reclaimed) return false;
  await deps.recordOrphan({
    nosanaDeploymentId: e.deploymentId,
    sourceKind: "training",
    sourceId: jobId,
    reason: "submit_failed",
    ...(e.accessMode === "wallet" || e.accessMode === "api_key" ? { accessMode: e.accessMode } : {}),
  });
  return true;
}

export interface RetireTrainingDeploymentResult {
  /** The stop took effect (or the deployment had already stopped). */
  stopped: boolean;
  /** The funding is verified released: nothing is left for anyone to do. */
  reclaimed: boolean;
  /** The id was handed to the orphan sweep, with the credential that created it. */
  recorded: boolean;
  /**
   * True when the deployment is either fully retired or durably recorded for
   * the sweep. False means neither happened: the caller must not yet treat
   * the deployment as dealt with (and must not refund on the strength of it).
   */
  handled: boolean;
}

/**
 * Retires the Nosana deployment of a training job that is over (finished,
 * failed, timed out in the queue, or lost by its submitter): stop it through
 * the credential that created it and, unless the stop landed AND the funding
 * is verified released, record it for the sweep with that credential's mode.
 * Never throws.
 */
export async function retireTrainingDeployment(
  deps: TrainingNosanaDeps,
  job: { id: string; nosanaJobId: string; nosanaAccessMode?: string | null },
  reason: string,
): Promise<RetireTrainingDeploymentResult> {
  const accessMode = rowAccessMode(job.nosanaAccessMode);
  const stop = await deps
    .stopDeployment(job.nosanaJobId, accessMode)
    .then((result) => ({ stopped: result.stopped !== false, reclaimed: result.reclaimed }))
    .catch((err) => {
      deps.onStopError?.(err);
      return { stopped: false, reclaimed: false };
    });
  if (stop.stopped && stop.reclaimed) {
    return { stopped: true, reclaimed: true, recorded: false, handled: true };
  }
  const recorded = await deps.recordOrphan({
    nosanaDeploymentId: job.nosanaJobId,
    sourceKind: "training",
    sourceId: job.id,
    reason,
    accessMode,
  });
  return { stopped: stop.stopped, reclaimed: false, recorded, handled: recorded };
}
