import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { buildSubscriptionRenewalTickDeps } from "../services/buildSubscriptionRenewalTickDeps.js";
import { runSubscriptionRenewalTick } from "../services/runSubscriptionRenewalTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "subscription-renewal";
const REPEATABLE_JOB_KEY = "subscription-renewal-tick";

const logger = createLogger("subscription-renewal-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

export async function startSubscriptionRenewalQueue(): Promise<void> {
  const every = env.SUBSCRIPTION_RENEWAL_INTERVAL_MS;
  if (every <= 0) {
    logger.info("Subscription renewal queue disabled (SUBSCRIPTION_RENEWAL_INTERVAL_MS <= 0)");
    return;
  }
  const { connection } = getQueueConnectionOpts();
  queue = new Queue(QUEUE_NAME, { connection });
  for (const job of await queue.getRepeatableJobs()) {
    if (job.key === REPEATABLE_JOB_KEY || job.name === REPEATABLE_JOB_KEY) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(REPEATABLE_JOB_KEY, {}, { repeat: { every }, jobId: REPEATABLE_JOB_KEY });

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const result = await runSubscriptionRenewalTick(buildSubscriptionRenewalTickDeps(prisma));
      logger.info(result, "Subscription renewal tick complete");
    },
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, error) => logger.error({ jobId: job?.id, error }, "Subscription renewal job failed"));
  worker.on("error", (error) => logger.error({ error }, "Subscription renewal worker error"));
  logger.info({ intervalMs: every, queue: QUEUE_NAME }, "Subscription renewal BullMQ queue started");
}

export async function stopSubscriptionRenewalQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
