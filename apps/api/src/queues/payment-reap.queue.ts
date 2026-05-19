import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { buildReapStuckTickDeps } from "../services/buildReapStuckTickDeps.js";
import { runReapStuckTick } from "../services/runReapStuckTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "payment-reap";
const REPEATABLE_JOB_KEY = "payment-reap-tick";

const logger = createLogger("payment-reap-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

export async function startPaymentReapQueue(): Promise<void> {
  if (env.PAYMENT_REAP_INTERVAL_MS <= 0) {
    logger.info("Payment reap queue disabled (PAYMENT_REAP_INTERVAL_MS <= 0)");
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
      repeat: { every: env.PAYMENT_REAP_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const deps = buildReapStuckTickDeps({
        prisma,
        batchLimit: env.PAYMENT_REAP_BATCH_LIMIT,
        maxAgeSeconds: env.PAYMENT_REAP_MAX_AGE_SECONDS,
      });
      const result = await runReapStuckTick(
        {
          now: new Date(),
          maxAgeSeconds: env.PAYMENT_REAP_MAX_AGE_SECONDS,
        },
        deps,
      );
      logger.info(result, "Payment reap tick complete");
    },
    {
      connection,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Payment reap job failed");
  });
  worker.on("error", (error) => {
    logger.error({ error }, "Payment reap worker error");
  });

  logger.info(
    {
      intervalMs: env.PAYMENT_REAP_INTERVAL_MS,
      maxAgeSeconds: env.PAYMENT_REAP_MAX_AGE_SECONDS,
      queue: QUEUE_NAME,
    },
    "Payment reap BullMQ queue started",
  );
}

export async function stopPaymentReapQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info("Payment reap BullMQ queue stopped");
}
