import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { buildSchedulerTickDeps } from "../services/buildSchedulerTickDeps.js";
import { runSchedulerTick } from "../services/runSchedulerTick.js";
import { buildSchedulerExecutorDeps } from "../services/scheduledTaskExecutorProduction.js";
import { buildResultDeliveryDeps } from "../services/scheduledTasks/buildResultDeliveryDeps.js";
import { triggerWebhook } from "../services/webhooks.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "scheduler";
const REPEATABLE_JOB_KEY = "scheduler-tick";

const logger = createLogger("scheduler-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the scheduler BullMQ queue and worker (Wave 1). Fires due
 * ScheduledTask rows (nextRunAt <= now) through the real execution
 * engine — before this worker existed, nothing consumed nextRunAt and
 * no schedule ever fired. Only starts when
 * `env.SCHEDULER_INTERVAL_MS` is greater than 0.
 */
export async function startSchedulerQueue(): Promise<void> {
  if (env.SCHEDULER_INTERVAL_MS <= 0) {
    logger.info("Scheduler queue disabled (SCHEDULER_INTERVAL_MS <= 0)");
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
      repeat: { every: env.SCHEDULER_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const deps = buildSchedulerTickDeps({
        prisma,
        executorDeps: buildSchedulerExecutorDeps(),
        emitEvent: async (orgId, type, data) => {
          await triggerWebhook(orgId, type, data);
        },
        resultDelivery: buildResultDeliveryDeps,
      });
      const result = await runSchedulerTick(
        { now: new Date(), concurrency: env.SCHEDULER_CONCURRENCY },
        deps,
      );
      logger.info(result, "Scheduler tick complete");
    },
    {
      connection,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Scheduler job failed");
  });
  worker.on("error", (error) => {
    logger.error({ error }, "Scheduler worker error");
  });

  logger.info(
    { intervalMs: env.SCHEDULER_INTERVAL_MS, queue: QUEUE_NAME },
    "Scheduler BullMQ queue started",
  );
}

export async function stopSchedulerQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info("Scheduler queue stopped");
}
