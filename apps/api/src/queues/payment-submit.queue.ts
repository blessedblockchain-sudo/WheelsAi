import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { getSolanaConnection } from "../lib/solana.js";
import { buildSubmitPaymentsTickDeps } from "../services/buildSubmitPaymentsTickDeps.js";
import { getNosanaClient } from "../services/nosana.js";
import { makeNosanaRecipientResolver } from "../services/resolveNosanaRecipient.js";
import { runSubmitPaymentsTick } from "../services/runSubmitPaymentsTick.js";
import { makeTreasurySignerProvider } from "../services/treasuryKeypairs.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "payment-submit";
const REPEATABLE_JOB_KEY = "payment-submit-tick";

const logger = createLogger("payment-submit-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

export async function startPaymentSubmitQueue(): Promise<void> {
  if (env.PAYMENT_SUBMIT_INTERVAL_MS <= 0) {
    logger.info("Payment submit queue disabled (PAYMENT_SUBMIT_INTERVAL_MS <= 0)");
    return;
  }

  // Without WALLET_MASTER_KEY there is no way to derive the treasury
  // signer; skip booting the worker entirely so dev environments
  // without keypair material don't hit a per-row signer mismatch on
  // every tick. Production env.ts validation will surface the missing
  // key at startup; this is the dev-mode soft fail.
  if (!env.WALLET_MASTER_KEY) {
    logger.warn(
      "Payment submit queue disabled (WALLET_MASTER_KEY not set)",
    );
    return;
  }

  const { connection } = getQueueConnectionOpts();

  const treasurySignerFor = makeTreasurySignerProvider({
    masterKey: env.WALLET_MASTER_KEY,
  });

  const resolveRecipient = makeNosanaRecipientResolver({
    getJobStatus: async (jobId) => {
      const client = await getNosanaClient();
      return client.getJobStatus(jobId);
    },
  });

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
      repeat: { every: env.PAYMENT_SUBMIT_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const deps = buildSubmitPaymentsTickDeps({
        prisma,
        connection: getSolanaConnection(),
        treasurySignerFor,
        resolveRecipient,
        batchLimit: env.PAYMENT_BATCH_LIMIT,
        now: () => new Date(),
      });
      const result = await runSubmitPaymentsTick(
        { now: new Date() },
        deps,
      );
      logger.info(result, "Payment submit tick complete");
    },
    {
      connection,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Payment submit job failed");
  });
  worker.on("error", (error) => {
    logger.error({ error }, "Payment submit worker error");
  });

  logger.info(
    {
      intervalMs: env.PAYMENT_SUBMIT_INTERVAL_MS,
      batchLimit: env.PAYMENT_BATCH_LIMIT,
      queue: QUEUE_NAME,
    },
    "Payment submit BullMQ queue started",
  );
}

export async function stopPaymentSubmitQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info("Payment submit BullMQ queue stopped");
}
