/**
 * trial-charge-reap queue: the repeatable tick that refunds publisher-funded
 * Try it messages left `held` by a process that died mid-chat
 * (services/runTrialChargeReapTick.ts).
 *
 * It always runs, also while TRIAL_FUNDED_MESSAGE_CENTS is unset: charges
 * held before the price was removed still have to go back.
 */

import { Queue, Worker } from "bullmq";

import { buildTrialChargeReapTickDeps } from "../services/buildTrialChargeReapTickDeps.js";
import { runTrialChargeReapTick } from "../services/runTrialChargeReapTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "trial-charge-reap";
const REPEATABLE_JOB_KEY = "trial-charge-reap-tick";
/** A held charge waits 15 minutes before it is stale; a minute more is nothing. */
const TICK_EVERY_MS = 60_000;

const logger = createLogger("trial-charge-reap-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

export async function startTrialChargeReapQueue(): Promise<void> {
  const { connection } = getQueueConnectionOpts();
  queue = new Queue(QUEUE_NAME, { connection });
  for (const job of await queue.getRepeatableJobs()) {
    if (job.key === REPEATABLE_JOB_KEY || job.name === REPEATABLE_JOB_KEY) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(REPEATABLE_JOB_KEY, {}, { repeat: { every: TICK_EVERY_MS }, jobId: REPEATABLE_JOB_KEY });

  const deps = buildTrialChargeReapTickDeps();
  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const result = await runTrialChargeReapTick(deps);
      if (result.scanned > 0) logger.info(result, "Trial charge reap tick complete");
    },
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, error) => logger.error({ jobId: job?.id, error }, "Trial charge reap failed"));
  worker.on("error", (error) => logger.error({ error }, "Trial charge reap worker error"));
  logger.info({ intervalMs: TICK_EVERY_MS, queue: QUEUE_NAME }, "Trial charge reaper started");
}

export async function stopTrialChargeReapQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
