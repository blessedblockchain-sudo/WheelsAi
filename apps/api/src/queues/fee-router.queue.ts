/**
 * BullMQ shell for the fee-router worker.
 *
 * Disabled by default (FEE_ROUTER_INTERVAL_MS=0) because the worker
 * needs a funded platform-held wallet to spend out — without
 * FEE_ROUTER_WALLET_PRIVATE_KEY in env, every tick would fail at the
 * keypair-load step. We log + skip rather than crash so the rest of
 * the API boots cleanly in environments without the key.
 *
 * Production runbook (devnet first):
 *   1. Generate keypair: `solana-keygen new -o fee-router.json`
 *   2. Fund: `solana airdrop 5 <pubkey> --url devnet`
 *   3. Set FEE_ROUTER_WALLET_PRIVATE_KEY=$(cat fee-router.json)
 *      and FEE_ROUTER_INTERVAL_MS=60000
 *   4. The worker auto-tops-up the treasuries with 1% of unrouted
 *      trade volume on each tick.
 */

import { Keypair } from "@solana/web3.js";
import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { getSolanaConnection } from "../lib/solana.js";
import { buildFeeRouterTickDeps } from "../services/buildFeeRouterTickDeps.js";
import { runFeeRouterTick } from "../services/runFeeRouterTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "fee-router";
const REPEATABLE_JOB_KEY = "fee-router-tick";

const logger = createLogger("fee-router-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

function loadRouterKeypair(): Keypair | null {
  const raw = env.FEE_ROUTER_WALLET_PRIVATE_KEY;
  if (!raw) return null;
  try {
    const secretKey = Uint8Array.from(JSON.parse(raw));
    return Keypair.fromSecretKey(secretKey);
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "FEE_ROUTER_WALLET_PRIVATE_KEY is set but invalid JSON; fee-router disabled",
    );
    return null;
  }
}

export async function startFeeRouterQueue(): Promise<void> {
  if (env.FEE_ROUTER_INTERVAL_MS <= 0) {
    logger.info("Fee-router queue disabled (FEE_ROUTER_INTERVAL_MS <= 0)");
    return;
  }
  const routerKeypair = loadRouterKeypair();
  if (!routerKeypair) {
    logger.warn(
      "Fee-router queue disabled (FEE_ROUTER_WALLET_PRIVATE_KEY not set)",
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
      repeat: { every: env.FEE_ROUTER_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const deps = buildFeeRouterTickDeps({
        prisma,
        connection: getSolanaConnection(),
        routerKeypair,
      });
      const result = await runFeeRouterTick({ now: new Date() }, deps);
      logger.info(result, "Fee-router tick complete");
    },
    {
      connection,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Fee-router job failed");
  });
  worker.on("error", (error) => {
    logger.error({ error }, "Fee-router worker error");
  });

  logger.info(
    {
      intervalMs: env.FEE_ROUTER_INTERVAL_MS,
      routerPubkey: routerKeypair.publicKey.toBase58(),
      queue: QUEUE_NAME,
    },
    "Fee-router BullMQ queue started",
  );
}

export async function stopFeeRouterQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info("Fee-router BullMQ queue stopped");
}
