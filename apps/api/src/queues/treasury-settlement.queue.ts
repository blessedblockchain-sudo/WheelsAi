import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { buildTreasurySettlementCycleDeps } from "../services/buildTreasurySettlementCycleDeps.js";
import { makeComputeCostProvider } from "../services/computeCostForDeployment.js";
import { getNosanaClient } from "../services/nosana.js";
import {
  fetchSolPriceFromCoinGecko,
  makeSolPriceProvider,
} from "../services/priceOracle.js";
import { runTreasurySettlementCycle } from "../services/treasurySettlementCycle.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "treasury-settlement";
const REPEATABLE_JOB_KEY = "treasury-settlement-tick";

const logger = createLogger("treasury-settlement-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

const SOL_PRICE_CACHE_TTL_MS = 60_000;
const SOL_PRICE_FALLBACK_USD = 100; // sane devnet default; mainnet hits CoinGecko

const getSolPriceUsd = makeSolPriceProvider({
  fetchPrice: () => fetchSolPriceFromCoinGecko(),
  cacheTtlMs: SOL_PRICE_CACHE_TTL_MS,
  fallbackUsd: SOL_PRICE_FALLBACK_USD,
});

export async function startTreasurySettlementQueue(): Promise<void> {
  if (env.TREASURY_SETTLEMENT_INTERVAL_MS <= 0) {
    logger.info(
      "Treasury settlement queue disabled (TREASURY_SETTLEMENT_INTERVAL_MS <= 0)",
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
      repeat: { every: env.TREASURY_SETTLEMENT_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  // Lazy-init Nosana SDK once on first tick — keeps queue boot cheap and
  // avoids holding an SDK handle in the no-tick (interval=0) case. After
  // the first call getNosanaClient is a Map lookup.
  const getComputeCost = makeComputeCostProvider({
    getJobStatus: async (jobId) => {
      const client = await getNosanaClient();
      return client.getJobStatus(jobId);
    },
  });

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const deps = buildTreasurySettlementCycleDeps({
        prisma,
        getComputeCost,
        getSolPriceUsd,
        intervalMs: env.TREASURY_SETTLEMENT_BATCH_INTERVAL_MS,
      });
      const result = await runTreasurySettlementCycle(deps);
      logger.info(result, "Treasury settlement tick complete");
    },
    {
      connection,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Treasury settlement job failed");
  });
  worker.on("error", (error) => {
    logger.error({ error }, "Treasury settlement worker error");
  });

  logger.info(
    {
      tickIntervalMs: env.TREASURY_SETTLEMENT_INTERVAL_MS,
      batchWindowMs: env.TREASURY_SETTLEMENT_BATCH_INTERVAL_MS,
      queue: QUEUE_NAME,
    },
    "Treasury settlement BullMQ queue started",
  );
}

export async function stopTreasurySettlementQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info("Treasury settlement BullMQ queue stopped");
}
