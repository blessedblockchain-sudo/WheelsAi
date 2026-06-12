import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import {
  createSnapshot,
  graduateToken,
  updateTokenStats,
} from "../services/agentToken.js";
import { buildTokenIndexerOuterTickDeps } from "../services/buildTokenIndexerOuterTickDeps.js";
import { getPumpFunClient } from "../services/pumpfun.js";
import { runTokenIndexerOuterTick } from "../services/runTokenIndexerOuterTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "token-indexer";
const REPEATABLE_JOB_KEY = "token-indexer-tick";

const logger = createLogger("token-indexer-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the BullMQ-backed token indexer queue and worker.
 * Only starts if `env.TOKEN_INDEXER_INTERVAL_MS` is greater than 0.
 * Registers a repeatable job that fires every `env.TOKEN_INDEXER_INTERVAL_MS`.
 */
export async function startTokenIndexerQueue(): Promise<void> {
  if (env.TOKEN_INDEXER_INTERVAL_MS <= 0) {
    logger.info("Token indexer queue disabled (TOKEN_INDEXER_INTERVAL_MS <= 0)");
    return;
  }

  const { connection } = getQueueConnectionOpts();

  queue = new Queue(QUEUE_NAME, { connection });

  // Remove stale repeatable jobs registered under this key before adding a
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
      repeat: { every: env.TOKEN_INDEXER_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    }
  );

  // Cursor-based indexer (plan D7): per-token Postgres high-water-mark
  // cursors with pagination-until-cursor, so bursts larger than one page
  // are not silently dropped. Composes the legacy per-token behaviors
  // (stats refresh, graduation check, price snapshot) after trade
  // indexing — see buildTokenIndexerOuterTickDeps.
  worker = new Worker(
    QUEUE_NAME,
    async (_job) => {
      const client = getPumpFunClient();
      const deps = buildTokenIndexerOuterTickDeps({
        prisma,
        getTradesPage: (mintAddress, limit, offset) =>
          client.getTokenTrades(mintAddress, limit, offset),
        stats: {
          getTokenInfo: (mintAddress) => client.getTokenInfo(mintAddress),
          updateTokenStats,
          graduateToken,
          createSnapshot,
        },
        now: () => new Date(),
      });
      const result = await runTokenIndexerOuterTick({ now: new Date() }, deps);
      logger.info(result, "Token indexer tick complete");
    },
    {
      connection,
      concurrency: 1,
    }
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Token indexer job failed");
  });

  worker.on("error", (error) => {
    logger.error({ error }, "Token indexer worker error");
  });

  logger.info(
    {
      intervalMs: env.TOKEN_INDEXER_INTERVAL_MS,
      queue: QUEUE_NAME,
    },
    "Token indexer BullMQ queue started"
  );
}

/**
 * Stops the token indexer worker and drains the queue gracefully.
 */
export async function stopTokenIndexerQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }

  if (queue) {
    await queue.close();
    queue = null;
  }

  logger.info("Token indexer BullMQ queue stopped");
}
