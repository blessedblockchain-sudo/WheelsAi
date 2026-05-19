/**
 * BullMQ shell for the reputation-attestation worker (plan A4).
 *
 * Disabled by default (REPUTATION_ATTESTATION_INTERVAL_MS=0). When
 * enabled, the worker scans active tokenized agents whose
 * AgentReputation PDA has been initialized, computes the deltas since
 * each agent's `lastOnChainAttestationAt` cursor, posts an on-chain
 * submit_attestation, and mirrors the result into on_chain_attestations.
 *
 * Production runbook (devnet first):
 *   1. Generate keypair: `solana-keygen new -o reputation-attestor.json`
 *   2. Fund: `solana airdrop 5 <pubkey> --url devnet`
 *   3. Call add_attestor with this pubkey via the program's admin key.
 *   4. Set REPUTATION_ATTESTOR_PRIVATE_KEY=$(cat reputation-attestor.json)
 *      and REPUTATION_ATTESTATION_INTERVAL_MS=21600000  (6h)
 *   5. The worker posts an attestation per active agent on each tick.
 */

import { Keypair } from "@solana/web3.js";
import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { getSolanaConnection } from "../lib/solana.js";
import { buildAttestationTickDeps } from "../services/buildAttestationTickDeps.js";
import { runAttestationTick } from "../services/runAttestationTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "reputation-attestation";
const REPEATABLE_JOB_KEY = "reputation-attestation-tick";

const logger = createLogger("reputation-attestation-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

function loadAttestorKeypair(): Keypair | null {
  const raw = env.REPUTATION_ATTESTOR_PRIVATE_KEY;
  if (!raw) return null;
  try {
    const secretKey = Uint8Array.from(JSON.parse(raw));
    return Keypair.fromSecretKey(secretKey);
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "REPUTATION_ATTESTOR_PRIVATE_KEY is set but invalid JSON; worker disabled",
    );
    return null;
  }
}

export async function startReputationAttestationQueue(): Promise<void> {
  if (env.REPUTATION_ATTESTATION_INTERVAL_MS <= 0) {
    logger.info(
      "Reputation-attestation queue disabled (REPUTATION_ATTESTATION_INTERVAL_MS <= 0)",
    );
    return;
  }
  const attestorKeypair = loadAttestorKeypair();
  if (!attestorKeypair) {
    logger.warn(
      "Reputation-attestation queue disabled (REPUTATION_ATTESTOR_PRIVATE_KEY not set)",
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
      repeat: { every: env.REPUTATION_ATTESTATION_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const deps = buildAttestationTickDeps({
        prisma,
        connection: getSolanaConnection(),
        attestorKeypair,
      });
      const result = await runAttestationTick({ now: new Date() }, deps);
      logger.info(result, "Reputation-attestation tick complete");
    },
    {
      connection,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id, error },
      "Reputation-attestation job failed",
    );
  });
  worker.on("error", (error) => {
    logger.error({ error }, "Reputation-attestation worker error");
  });

  logger.info(
    {
      intervalMs: env.REPUTATION_ATTESTATION_INTERVAL_MS,
      attestorPubkey: attestorKeypair.publicKey.toBase58(),
      queue: QUEUE_NAME,
    },
    "Reputation-attestation BullMQ queue started",
  );
}

export async function stopReputationAttestationQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info("Reputation-attestation BullMQ queue stopped");
}
