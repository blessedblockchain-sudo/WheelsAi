import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import {
  buildProductionSweepDeps,
  sweepTickInputFromEnv,
} from "../services/buildSweepTickDeps.js";
import { runSweepTick, sweepsEnabled } from "../services/runSweepTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "deposit-sweep";
const REPEATABLE_JOB_KEY = "deposit-sweep-tick";

const logger = createLogger("deposit-sweep-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the deposit sweep BullMQ queue and worker (payments pass, batch
 * 6). It moves what customers paid off their deposit addresses: to the hot
 * wallet (the wallet that pays creators) while that is under its float,
 * and to the proven treasury otherwise. A hot wallet holding more than
 * twice a float sends the excess to the treasury. Every transfer is
 * written as a chain_transfers row before it is sent, and only the chain
 * ends a row.
 *
 * Only starts when SWEEPS_ENABLED and SWEEP_INTERVAL_MS > 0 (env.ts
 * refuses sweeps without deposits). A run does nothing while the node is
 * not on the cluster SOLANA_NETWORK names. Until the treasury is proven
 * (scripts/treasury-verify.ts) only sweeps to the hot wallet happen.
 */
export async function startDepositSweepQueue(): Promise<void> {
  const enabled = sweepsEnabled({
    sweepsEnabled: env.SWEEPS_ENABLED,
    intervalMs: env.SWEEP_INTERVAL_MS,
  });
  if (!enabled) {
    logger.info(
      "Deposit sweep worker disabled (SWEEPS_ENABLED off or interval <= 0)",
    );
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
      repeat: { every: env.SWEEP_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  const deps = buildProductionSweepDeps();

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const result = await runSweepTick(sweepTickInputFromEnv(), deps);
      if (result.reason === "chain_unavailable") {
        logger.warn(
          "Deposit sweep run skipped: the Solana cluster check is not ok",
        );
      } else if (result.errors > 0) {
        logger.error(result, "Deposit sweep run complete, with errors");
      } else if (
        result.settled.landed > 0 ||
        result.settled.failed > 0 ||
        result.settled.dead > 0 ||
        result.resent > 0 ||
        result.left > 0 ||
        result.planned > 0 ||
        result.sent > 0 ||
        result.skipped > 0 ||
        result.held > 0
      ) {
        logger.info(result, "Deposit sweep run complete");
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Deposit sweep job failed");
  });

  logger.info(
    { intervalMs: env.SWEEP_INTERVAL_MS },
    "Deposit sweep queue started",
  );
}

export async function stopDepositSweepQueue(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}
