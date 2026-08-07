import { Queue, Worker } from "bullmq";
import { PublicKey } from "@solana/web3.js";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { getSolanaConnection } from "../lib/solana.js";
import { buildPayoutExecutorTickDeps } from "../services/buildPayoutExecutorTickDeps.js";
import { derivePayoutKeypair } from "../services/payoutKeypair.js";
import { runPayoutExecutorTick } from "../services/runPayoutExecutorTick.js";
import { USDC_MINT } from "../services/x402.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "payout-executor";
const REPEATABLE_JOB_KEY = "payout-executor-tick";

const logger = createLogger("payout-executor-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the payout-executor BullMQ queue and worker (W2 money keystone).
 * Settles requested CreatorPayout rows — credits grants and/or on-chain
 * crypto transfers from the platform payout wallet. Only starts when
 * PAYOUTS_ENABLED and PAYOUT_EXECUTOR_INTERVAL_MS > 0.
 *
 * The payout wallet is derived from WALLET_MASTER_KEY (env.ts makes the
 * key boot-fatal when the executor is scheduled) and its address is
 * logged so the operator knows where to send funds.
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
      "Platform payout wallet — fund this address for crypto payouts",
    );
  } else {
    logger.warn(
      "Payouts enabled without WALLET_MASTER_KEY — only the credits rail will settle",
    );
  }

  const usdcMint =
    env.SOLANA_NETWORK === "mainnet-beta" ? USDC_MINT.mainnet : USDC_MINT.devnet;

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
        prisma,
        connection: getSolanaConnection(),
        payoutWallet,
        solPriceUsd: env.PAYOUT_SOL_PRICE_USD,
        usdcMint: new PublicKey(usdcMint.toBase58()),
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
