import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";
import { runX402SettlementTick } from "../services/x402Settlement.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "x402-settlement";
const REPEATABLE_JOB_KEY = "x402-settlement-tick";

const logger = createLogger("x402-settlement-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the BullMQ-backed x402 settlement queue and worker.
 * Only starts if `env.X402_SETTLEMENT_WORKER_ENABLED` is true.
 * Registers a repeatable job that fires every `env.X402_SETTLEMENT_INTERVAL_MS`.
 *
 * Each run finishes the payments a request left open, from what the chain
 * says and nothing else (services/x402Payments.ts `settleX402Row`): a
 * served payment that is final is settled; one that landed for a request
 * that was never answered is returned to the payer's credits; one that
 * failed or can never land is failed. One run at a time (concurrency 1,
 * and the run refuses to overlap itself); a run that throws is logged and
 * the next one starts from the rows as they are.
 */
export async function startX402Queue(): Promise<void> {
  if (!env.X402_SETTLEMENT_WORKER_ENABLED) {
    logger.info("X402 settlement queue disabled (X402_SETTLEMENT_WORKER_ENABLED=false)");
    return;
  }

  const { connection } = getQueueConnectionOpts();

  queue = new Queue(QUEUE_NAME, { connection });

  // Remove any stale repeatable job registered under this key before adding a
  // fresh one, so that interval changes take effect without leftover schedules.
  const existingRepeatables = await queue.getRepeatableJobs();
  for (const job of existingRepeatables) {
    if (job.key === REPEATABLE_JOB_KEY || job.name === REPEATABLE_JOB_KEY) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    REPEATABLE_JOB_KEY,
    {},
    {
      repeat: { every: env.X402_SETTLEMENT_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    }
  );

  worker = new Worker(
    QUEUE_NAME,
    async (_job) => {
      await runX402SettlementTick();
    },
    {
      connection,
      concurrency: 1,
    }
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "X402 settlement job failed");
  });

  worker.on("error", (error) => {
    logger.error({ error }, "X402 settlement worker error");
  });

  logger.info(
    {
      intervalMs: env.X402_SETTLEMENT_INTERVAL_MS,
      queue: QUEUE_NAME,
    },
    "X402 settlement BullMQ queue started"
  );
}

/**
 * Stops the x402 settlement worker and drains the queue gracefully.
 */
export async function stopX402Queue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }

  if (queue) {
    await queue.close();
    queue = null;
  }

  logger.info("X402 settlement BullMQ queue stopped");
}
