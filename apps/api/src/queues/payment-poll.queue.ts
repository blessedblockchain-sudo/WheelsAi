import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { getSolanaConnection } from "../lib/solana.js";
import { buildPollPaymentsTickDeps } from "../services/buildPollPaymentsTickDeps.js";
import { runPollPaymentsTick } from "../services/runPollPaymentsTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "payment-poll";
const REPEATABLE_JOB_KEY = "payment-poll-tick";

const logger = createLogger("payment-poll-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

export async function startPaymentPollQueue(): Promise<void> {
  if (env.PAYMENT_POLL_INTERVAL_MS <= 0) {
    logger.info("Payment poll queue disabled (PAYMENT_POLL_INTERVAL_MS <= 0)");
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
      repeat: { every: env.PAYMENT_POLL_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const deps = buildPollPaymentsTickDeps({
        prisma,
        connection: getSolanaConnection(),
        batchLimit: env.PAYMENT_BATCH_LIMIT,
        now: () => new Date(),
      });
      const result = await runPollPaymentsTick({ now: new Date() }, deps);
      logger.info(result, "Payment poll tick complete");
    },
    {
      connection,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Payment poll job failed");
  });
  worker.on("error", (error) => {
    logger.error({ error }, "Payment poll worker error");
  });

  logger.info(
    {
      intervalMs: env.PAYMENT_POLL_INTERVAL_MS,
      batchLimit: env.PAYMENT_BATCH_LIMIT,
      queue: QUEUE_NAME,
    },
    "Payment poll BullMQ queue started",
  );
}

export async function stopPaymentPollQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info("Payment poll BullMQ queue stopped");
}
