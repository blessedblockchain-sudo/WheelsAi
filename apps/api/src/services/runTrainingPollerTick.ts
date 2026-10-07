/**
 * One tick of the training poller: reconcile every job that is not over.
 *
 * Nosana never calls us, and a container's callbacks may never arrive, so
 * this tick is what ends a job: it moves queued jobs to running, applies the
 * queue timeout, reads the result of a run that ended, finalises, confirms
 * cancels, and recovers rows left in pending, submitting or finalizing by a
 * process that died (services/trainingJobs.ts: reconcileTrainingJob).
 *
 * One job that throws does not stop the others. A tick with no job to look
 * at touches nothing else (no Nosana call).
 *
 * Pure: everything is injected (services/buildTrainingPollerTickDeps.ts).
 */

import type { ReconcileResult } from "./trainingJobs.js";

/**
 * Jobs reconciled per tick. They are taken least recently examined first and
 * stamped as taken, so with N active jobs each is reached within
 * ceil(N / TRAINING_POLLER_BATCH) ticks.
 */
export const TRAINING_POLLER_BATCH = 200;

export interface TrainingPollerTickDeps {
  /** Ids of jobs in a non-terminal state, least recently examined first; marks them examined. */
  listActiveJobIds(limit: number): Promise<string[]>;
  reconcile(jobId: string): Promise<ReconcileResult>;
  onError(jobId: string, error: unknown): void;
}

export interface TrainingPollerTickResult {
  examined: number;
  /** Jobs whose status changed in this tick. */
  transitions: number;
  failed: number;
  /** Ended in this tick, by terminal status. */
  completed: number;
  ended: number;
}

export async function runTrainingPollerTick(
  deps: TrainingPollerTickDeps,
): Promise<TrainingPollerTickResult> {
  const result: TrainingPollerTickResult = {
    examined: 0,
    transitions: 0,
    failed: 0,
    completed: 0,
    ended: 0,
  };
  const jobIds = await deps.listActiveJobIds(TRAINING_POLLER_BATCH);
  for (const jobId of jobIds) {
    result.examined += 1;
    try {
      const reconciled = await deps.reconcile(jobId);
      if (reconciled.to !== reconciled.from) result.transitions += 1;
      if (reconciled.to === "completed") result.completed += 1;
      if (reconciled.to === "completed" || reconciled.to === "failed" || reconciled.to === "cancelled") {
        result.ended += 1;
      }
    } catch (error) {
      result.failed += 1;
      deps.onError(jobId, error);
    }
  }
  return result;
}
