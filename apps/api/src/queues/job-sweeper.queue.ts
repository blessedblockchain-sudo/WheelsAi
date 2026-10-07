/**
 * job-sweeper queue: the repeatable tick that expires, auto-completes,
 * re-queues and hands over paid jobs (services/runJobSweepTick.ts).
 *
 * It runs whenever JOB_SWEEP_INTERVAL_MS > 0, also where the runner is
 * switched off: jobs hired before the switch still have to be refunded at
 * their deadline and settled when their review window closes.
 */

import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { buildJobNotifier } from "../services/buildJobNotifier.js";
import { buildJobSweepTickDeps } from "../services/buildJobSweepTickDeps.js";
import { ensureOrgPublisherProfile, recalculateReputationQuietly } from "../services/buildJobServiceDeps.js";
import { runJobSweepTick } from "../services/runJobSweepTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";
import { enqueueJobRun } from "./job-runner.queue.js";

const QUEUE_NAME = "job-sweeper";
const REPEATABLE_JOB_KEY = "job-sweeper-tick";

const logger = createLogger("job-sweeper-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

export async function startJobSweeperQueue(): Promise<void> {
  const every = env.JOB_SWEEP_INTERVAL_MS;
  if (every <= 0) {
    logger.info("Job sweeper disabled (JOB_SWEEP_INTERVAL_MS <= 0)");
    return;
  }
  const { connection } = getQueueConnectionOpts();
  queue = new Queue(QUEUE_NAME, { connection });
  for (const job of await queue.getRepeatableJobs()) {
    if (job.key === REPEATABLE_JOB_KEY || job.name === REPEATABLE_JOB_KEY) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(REPEATABLE_JOB_KEY, {}, { repeat: { every }, jobId: REPEATABLE_JOB_KEY });

  const notify = buildJobNotifier();
  const deps = buildJobSweepTickDeps({
    enqueue: (jobId) => enqueueJobRun(jobId, { replaceFinished: true }),
    ensurePublisherProfile: ensureOrgPublisherProfile,
    afterSettle: (row) => recalculateReputationQuietly(row.publisherId),
    notify,
  });

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const result = await runJobSweepTick(deps);
      if (result.scanned > 0) logger.info(result, "Job sweep tick complete");
    },
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, error) => logger.error({ jobId: job?.id, error }, "Job sweep failed"));
  worker.on("error", (error) => logger.error({ error }, "Job sweeper worker error"));
  logger.info({ intervalMs: every, queue: QUEUE_NAME }, "Job sweeper started");
}

export async function stopJobSweeperQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
