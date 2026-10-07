import { Queue, Worker } from "bullmq";

import { getTrainingConfig } from "../config/training.js";
import { prisma } from "../lib/prisma.js";
import { buildTrainingDeps } from "../services/buildTrainingDeps.js";
import { buildTrainingPollerTickDeps } from "../services/buildTrainingPollerTickDeps.js";
import { runTrainingPollerTick } from "../services/runTrainingPollerTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "training-poller";
const REPEATABLE_JOB_KEY = "training-poller-tick";

const logger = createLogger("training-poller-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the BullMQ-backed training poller queue and worker.
 *
 * Nosana never calls back, so this worker is what follows a fine-tuning run:
 * each tick reconciles every training job that is not over with Nosana and
 * with what its container reported, and settles the ones that ended. See
 * services/trainingJobs.ts.
 *
 * Only starts if `TRAINING_POLL_INTERVAL_MS` (config/training.ts, default
 * 15000) is greater than 0. With it off nothing would ever end a job, so
 * POST /api/training/jobs answers 503 training_poller_disabled.
 */
export async function startTrainingPollerQueue(): Promise<void> {
  const intervalMs = getTrainingConfig().pollIntervalMs;
  if (intervalMs <= 0) {
    logger.info("Training poller queue disabled (TRAINING_POLL_INTERVAL_MS = 0)");
    return;
  }

  const { connection } = getQueueConnectionOpts();

  queue = new Queue(QUEUE_NAME, { connection });

  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.key === REPEATABLE_JOB_KEY || job.name === REPEATABLE_JOB_KEY) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    REPEATABLE_JOB_KEY,
    {},
    {
      repeat: { every: intervalMs },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const deps = buildTrainingPollerTickDeps({
        prisma,
        training: buildTrainingDeps(prisma),
      });
      const result = await runTrainingPollerTick(deps);
      if (result.examined > 0) {
        logger.info({ ...result }, "Training poller tick complete");
      }
    },
    {
      connection,
      // One tick at a time: two would only race each other's compare-and-sets.
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Training poller job failed");
  });
  worker.on("error", (error) => {
    logger.error({ error }, "Training poller worker error");
  });

  logger.info(
    { intervalMs, queue: QUEUE_NAME },
    "Training poller BullMQ queue started",
  );
}

/**
 * Stops the training poller worker and drains the queue gracefully.
 */
export async function stopTrainingPollerQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info("Training poller BullMQ queue stopped");
}
