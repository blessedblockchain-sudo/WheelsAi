/**
 * job-runner queue: one entry per paid job (Offerings and Jobs).
 *
 * Hiring commits the funded job and its escrow first and adds an entry here
 * after; this worker claims the job and runs the publisher's product
 * (services/jobRunner.ts).
 *
 * Exactly-once is the job row's, not the queue's:
 *   - the entry id is derived from the job id, so a repeated add changes
 *     nothing while an entry for that job is waiting or active;
 *   - attempts is 1, so BullMQ never re-runs a product that may already
 *     have run (and used the publisher's model);
 *   - every delivery still has to win the funded -> running compare-and-set
 *     (or the lapsed-lease takeover), and a second one cannot.
 *
 * An add that fails after the hire committed is not an error for the buyer:
 * the sweeper finds the funded job and adds it again (`replaceFinished`
 * clears a finished entry that would otherwise make the add a no-op).
 *
 * JOB_RUNNER_CONCURRENCY=0 switches the worker off; hiring then answers
 * 501 instead of taking money for work nobody will pick up.
 *
 * DI on the queue instance lets the unit tests avoid Redis.
 */

import type { Queue, Worker } from "bullmq";

import { createLogger } from "../utils/logger.js";

const logger = createLogger("job-runner-queue");

export const JOB_RUNNER_QUEUE_NAME = "job-runner";
export const JOB_RUNNER_JOB_NAME = "job-run";

export interface JobRunPayload {
  jobId: string;
}

interface FinishedEntry {
  getState(): Promise<string>;
  remove(): Promise<void>;
}

export interface JobRunEnqueueDeps {
  queue?: Pick<Queue, "add"> & { getJob?(id: string): Promise<FinishedEntry | null | undefined> };
  /** The sweeper's add: an entry that already finished is replaced. */
  replaceFinished?: boolean;
}

/** BullMQ refuses ":" in a custom entry id. */
export function jobRunEntryId(jobId: string): string {
  return `job-run-${jobId}`;
}

let defaultQueue: Queue | null = null;

// Resolved lazily so tests importing this file don't touch Redis.
async function resolveQueue(): Promise<Queue> {
  if (defaultQueue) return defaultQueue;
  const { Queue } = await import("bullmq");
  const { getQueueConnectionOpts } = await import("./connection.js");
  const { connection } = getQueueConnectionOpts();
  defaultQueue = new Queue(JOB_RUNNER_QUEUE_NAME, { connection });
  return defaultQueue;
}

export async function enqueueJobRun(jobId: string, deps: JobRunEnqueueDeps = {}): Promise<void> {
  if (!jobId) throw new Error("job-runner: jobId is required");
  const queue = deps.queue ?? ((await resolveQueue()) as NonNullable<JobRunEnqueueDeps["queue"]>);
  const entryId = jobRunEntryId(jobId);
  if (deps.replaceFinished && queue.getJob) {
    const existing = await queue.getJob(entryId);
    const state = existing ? await existing.getState() : null;
    // A waiting or active entry is left alone: the job is already on its way.
    if (existing && (state === "completed" || state === "failed")) {
      await existing.remove().catch(() => {});
    }
  }
  const payload: JobRunPayload = { jobId };
  await queue.add(JOB_RUNNER_JOB_NAME, payload, {
    jobId: entryId, // dedup: one job, one entry
    attempts: 1, // never re-run a product that may already have run
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 5_000 },
  });
}

// ============================================
// Consumer lifecycle (production wiring)
// ============================================

let worker: Worker | null = null;
let shutdown: AbortController | null = null;

export async function startJobRunnerQueue(): Promise<void> {
  const [{ Worker }, { getQueueConnectionOpts }, { env }] = await Promise.all([
    import("bullmq"),
    import("./connection.js"),
    import("../config/env.js"),
  ]);
  if (env.JOB_RUNNER_CONCURRENCY <= 0) {
    logger.info("Job runner disabled (JOB_RUNNER_CONCURRENCY <= 0)");
    return;
  }
  const { buildJobRunnerDeps } = await import("../services/buildJobRunnerDeps.js");
  const { runJob } = await import("../services/jobRunner.js");
  const { connection } = getQueueConnectionOpts();

  const controller = new AbortController();
  shutdown = controller;
  const deps = buildJobRunnerDeps();

  worker = new Worker(
    JOB_RUNNER_QUEUE_NAME,
    async (entry) => {
      const { jobId } = entry.data as JobRunPayload;
      const result = await runJob({ jobId, shutdownSignal: controller.signal }, deps);
      logger.info({ jobId, result }, "Job handled");
    },
    {
      connection,
      concurrency: env.JOB_RUNNER_CONCURRENCY,
      // A job may run for JOB_MAX_RUN_MS; the entry's lock is renewed while
      // the process is alive, and the job's own lease covers a dead one.
      lockDuration: 60_000,
    },
  );
  worker.on("failed", (entry, error) => {
    logger.error({ entryId: entry?.id, error }, "Job run failed");
  });
  worker.on("error", (error) => {
    logger.error({ error }, "Job runner worker error");
  });
  logger.info(
    { queue: JOB_RUNNER_QUEUE_NAME, concurrency: env.JOB_RUNNER_CONCURRENCY },
    "Job runner started",
  );
}

export async function stopJobRunnerQueue(): Promise<void> {
  // In-flight jobs are aborted rather than awaited (one may have minutes
  // left). Each gives up its lease, and the sweeper hands it to a worker
  // that is still up.
  shutdown?.abort();
  shutdown = null;
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (defaultQueue) {
    await defaultQueue.close();
    defaultQueue = null;
  }
  logger.info("Job runner queue stopped");
}
