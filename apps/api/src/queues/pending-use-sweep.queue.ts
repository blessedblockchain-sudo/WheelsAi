/**
 * pending-use-sweep queue: the repeatable tick that gives back charges per
 * use left `pending` by a process that died between the debit and the
 * answer (services/runPendingUseSweepTick.ts).
 *
 * It runs whenever PENDING_USE_SWEEP_INTERVAL_MS > 0. With 0 nothing is
 * scheduled, and a repeatable job an earlier start left in Redis is removed
 * so no other process keeps being woken for it.
 */

import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { buildPendingUseSweepTickDeps } from "../services/buildPendingUseSweepTickDeps.js";
import { runPendingUseSweepTick } from "../services/runPendingUseSweepTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

export const PENDING_USE_SWEEP_QUEUE = "pending-use-sweep";
export const PENDING_USE_SWEEP_JOB_KEY = "pending-use-sweep-tick";

const logger = createLogger("pending-use-sweep-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/** What scheduling needs of a queue, so the rule can be held without Redis. */
export interface RepeatableSchedule {
  getRepeatableJobs(): Promise<Array<{ key: string; name: string }>>;
  removeRepeatableByKey(key: string): Promise<unknown>;
  add(name: string, data: object, opts: { repeat: { every: number }; jobId: string }): Promise<unknown>;
}

/**
 * Remove the tick an earlier start scheduled, then schedule it again at
 * `every` when that is above 0. True when a tick is scheduled.
 */
export async function schedulePendingUseSweep(target: RepeatableSchedule, every: number): Promise<boolean> {
  for (const job of await target.getRepeatableJobs()) {
    if (job.key === PENDING_USE_SWEEP_JOB_KEY || job.name === PENDING_USE_SWEEP_JOB_KEY) {
      await target.removeRepeatableByKey(job.key);
    }
  }
  if (!(every > 0)) return false;
  await target.add(PENDING_USE_SWEEP_JOB_KEY, {}, { repeat: { every }, jobId: PENDING_USE_SWEEP_JOB_KEY });
  return true;
}

export async function startPendingUseSweepQueue(): Promise<void> {
  const every = env.PENDING_USE_SWEEP_INTERVAL_MS;
  const { connection } = getQueueConnectionOpts();
  queue = new Queue(PENDING_USE_SWEEP_QUEUE, { connection });
  if (!(await schedulePendingUseSweep(queue, every))) {
    await queue.close();
    queue = null;
    logger.info("Pending use sweeper disabled (PENDING_USE_SWEEP_INTERVAL_MS <= 0)");
    return;
  }

  const deps = buildPendingUseSweepTickDeps();
  worker = new Worker(
    PENDING_USE_SWEEP_QUEUE,
    async () => {
      const result = await runPendingUseSweepTick(deps);
      if (result.scanned > 0) logger.info(result, "Pending use sweep tick complete");
    },
    { connection, concurrency: 1 },
  );
  worker.on("failed", (job, error) => logger.error({ jobId: job?.id, error }, "Pending use sweep failed"));
  worker.on("error", (error) => logger.error({ error }, "Pending use sweeper worker error"));
  logger.info({ intervalMs: every, queue: PENDING_USE_SWEEP_QUEUE }, "Pending use sweeper started");
}

export async function stopPendingUseSweepQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
