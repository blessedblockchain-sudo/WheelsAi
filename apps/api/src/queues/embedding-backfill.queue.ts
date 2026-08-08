import { Queue, Worker } from "bullmq";

import { resolveEmbeddingConfig } from "../config/embeddings.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { buildEmbeddingBackfillDeps } from "../services/buildEmbeddingBackfillDeps.js";
import { runEmbeddingBackfillTick } from "../services/runEmbeddingBackfillTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "embedding-backfill";
const REPEATABLE_JOB_KEY = "embedding-backfill-tick";

const logger = createLogger("embedding-backfill-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the embedding-backfill worker (W2 RAG). Embeds knowledge chunks
 * and memories that have no vector — content created before a provider
 * was configured, or while it was failing — and re-embeds rows whose
 * model no longer matches the configured one.
 *
 * Requires BOTH an interval and a configured provider: scheduling it
 * without a provider would spin a worker that can only ever no-op.
 */
export async function startEmbeddingBackfillQueue(): Promise<void> {
  if (env.EMBEDDING_BACKFILL_INTERVAL_MS <= 0) {
    logger.info("Embedding backfill disabled (EMBEDDING_BACKFILL_INTERVAL_MS <= 0)");
    return;
  }
  if (!resolveEmbeddingConfig()) {
    logger.warn(
      "Embedding backfill scheduled but no embedding provider is configured — not starting",
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
      repeat: { every: env.EMBEDDING_BACKFILL_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const result = await runEmbeddingBackfillTick(
        { limit: env.EMBEDDING_BACKFILL_BATCH_SIZE },
        buildEmbeddingBackfillDeps(prisma),
      );
      if (result.chunksEmbedded > 0 || result.memoriesEmbedded > 0 || result.failedBatches > 0) {
        logger.info(result, "Embedding backfill tick complete");
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Embedding backfill job failed");
  });

  logger.info(
    { intervalMs: env.EMBEDDING_BACKFILL_INTERVAL_MS },
    "Embedding backfill queue started",
  );
}

export async function stopEmbeddingBackfillQueue(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}
