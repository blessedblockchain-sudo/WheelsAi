import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { buildProductionDepositScanDeps } from "../services/buildDepositScanTickDeps.js";
import { chainLabel } from "../services/depositTypes.js";
import {
  depositScanEnabled,
  runDepositScanTick,
} from "../services/runDepositScanTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "deposit-scan";
const REPEATABLE_JOB_KEY = "deposit-scan-tick";

const logger = createLogger("deposit-scan-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the deposit scan BullMQ queue and worker (payments pass, batch
 * 5). It finds transfers sent to an organization's deposit address (from
 * an exchange, from any wallet) and credits each once, at the "finalized"
 * commitment. It also credits a prepared top-up whose transfer landed
 * without its submit, and tries again every SOL transfer still waiting
 * for a price.
 *
 * Only starts when DEPOSITS_ENABLED and DEPOSIT_SCAN_INTERVAL_MS > 0
 * (env.ts refuses to start with deposits on and this worker off outside
 * development). A run is skipped while the node is not on the cluster
 * SOLANA_NETWORK names.
 */
export async function startDepositScanQueue(): Promise<void> {
  const enabled = depositScanEnabled({
    depositsEnabled: env.DEPOSITS_ENABLED,
    intervalMs: env.DEPOSIT_SCAN_INTERVAL_MS,
  });
  if (!enabled) {
    logger.info(
      "Deposit scan worker disabled (DEPOSITS_ENABLED off or interval <= 0)",
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
      repeat: { every: env.DEPOSIT_SCAN_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  const deps = buildProductionDepositScanDeps();

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const result = await runDepositScanTick(
        {
          enabled: env.DEPOSITS_ENABLED,
          intervalMs: env.DEPOSIT_SCAN_INTERVAL_MS,
          network: chainLabel(env.SOLANA_NETWORK),
          maxAddresses: env.DEPOSIT_SCAN_MAX_ADDRESSES,
        },
        deps,
      );
      if (result.skipped === "chain_unavailable") {
        logger.warn(
          "Deposit scan run skipped: the Solana cluster check is not ok",
        );
      } else if (result.errors > 0) {
        logger.error(result, "Deposit scan run complete, with errors");
      } else if (
        result.historiesRead > 0 ||
        result.credited > 0 ||
        result.waiting > 0 ||
        result.ignored > 0 ||
        result.transfersOut > 0
      ) {
        logger.info(result, "Deposit scan run complete");
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Deposit scan job failed");
  });

  logger.info(
    { intervalMs: env.DEPOSIT_SCAN_INTERVAL_MS },
    "Deposit scan queue started",
  );
}

export async function stopDepositScanQueue(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}
