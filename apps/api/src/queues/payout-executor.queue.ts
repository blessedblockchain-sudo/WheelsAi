import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { ensureSolanaCluster, getSolanaConnection } from "../lib/solana.js";
import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import {
  buildPayoutExecutorTickDeps,
  type PayoutExecutorDb,
} from "../services/buildPayoutExecutorTickDeps.js";
import { readSignatureFate } from "../services/buildSignatureFateDeps.js";
import { getSolQuote, getSolQuoteMarginBps } from "../services/buildSolPriceDeps.js";
import { derivePayoutKeypair } from "../services/payoutKeypair.js";
import {
  runPayoutExecutorTick,
  type PayoutTickEvent,
} from "../services/runPayoutExecutorTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "payout-executor";
const REPEATABLE_JOB_KEY = "payout-executor-tick";

const logger = createLogger("payout-executor-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * One line per thing a run did to a payout. The chain's and the node's own
 * words are in `detail`: they belong here and in failure_reason, and
 * nowhere a creator reads.
 */
function logPayoutEvent(event: PayoutTickEvent): void {
  switch (event.event) {
    case "failed":
    case "row_error":
      logger.error(event, "Payout executor");
      return;
    case "send_error":
    case "resend_error":
    case "fate_unknown":
    case "returned_to_pending":
      logger.warn(event, "Payout executor");
      return;
    default:
      logger.info(event, "Payout executor");
  }
}

/**
 * Starts the payout-executor BullMQ queue and worker. Each run settles the
 * open CreatorPayout rows: credits grants, and transfers of USDC or SOL
 * from the platform's paying wallet (services/runPayoutExecutorTick.ts has
 * the rules). Only starts when PAYOUTS_ENABLED and
 * PAYOUT_EXECUTOR_INTERVAL_MS > 0.
 *
 * The paying wallet is derived from WALLET_MASTER_KEY (env.ts makes the
 * key boot-fatal when the executor is scheduled) and its address is
 * logged so the operator knows where to send funds. It is filled by hand:
 * while it is short a payout waits, still pending, and is sent on the
 * first run after it is filled.
 *
 * A SOL payout is priced by SOL_PRICE_SOURCE at the moment it is signed.
 * There is no fallback price: with no live price it waits.
 */
export async function startPayoutExecutorQueue(): Promise<void> {
  if (!env.PAYOUTS_ENABLED || env.PAYOUT_EXECUTOR_INTERVAL_MS <= 0) {
    logger.info(
      "Payout executor disabled (PAYOUTS_ENABLED off or interval <= 0)",
    );
    return;
  }

  const payoutWallet = env.WALLET_MASTER_KEY
    ? derivePayoutKeypair(env.WALLET_MASTER_KEY)
    : undefined;
  if (payoutWallet) {
    logger.info(
      { payoutWallet: payoutWallet.publicKey.toBase58() },
      "Platform payout wallet: fund this address for payouts to a wallet",
    );
  } else {
    logger.warn(
      "Payouts enabled without WALLET_MASTER_KEY: credits payouts settle, payouts to a wallet wait",
    );
  }

  const usdcMint = usdcMintForNetwork(env.SOLANA_NETWORK);

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
      repeat: { every: env.PAYOUT_EXECUTOR_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const deps = buildPayoutExecutorTickDeps({
        prisma: prisma as unknown as PayoutExecutorDb,
        connection: getSolanaConnection(),
        payoutWallet,
        usdcMint,
        maxAttempts: env.PAYOUT_MAX_ATTEMPTS,
        platformMaxPerDayUsd: env.PAYOUT_PLATFORM_MAX_PER_DAY_USD,
        checkCluster: ensureSolanaCluster,
        getSolQuote,
        solQuoteMarginBps: getSolQuoteMarginBps,
        readSignatureFate,
        log: logPayoutEvent,
      });
      const result = await runPayoutExecutorTick(
        { limit: env.PAYOUT_EXECUTOR_BATCH_SIZE },
        deps,
      );
      if (result.claimable > 0) {
        logger.info(result, "Payout executor tick complete");
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Payout executor job failed");
  });

  logger.info(
    { intervalMs: env.PAYOUT_EXECUTOR_INTERVAL_MS },
    "Payout executor queue started",
  );
}

export async function stopPayoutExecutorQueue(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}
