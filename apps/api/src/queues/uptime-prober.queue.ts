import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { buildUptimeProberTickDeps } from "../services/buildUptimeProberTickDeps.js";
import { runUptimeProberTick } from "../services/runUptimeProberTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "uptime-prober";
const REPEATABLE_JOB_KEY = "uptime-prober-tick";

const logger = createLogger("uptime-prober-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the uptime-prober queue (Wave 1) — the first caller
 * recordUptimeEvent ever had. Probes every due UptimeMonitor and feeds
 * the real recorder (status, uptime %, latency). Only starts when
 * `env.UPTIME_PROBER_INTERVAL_MS` is greater than 0. Each monitor still
 * honors its own checkIntervalSeconds inside the tick.
 */
export async function startUptimeProberQueue(): Promise<void> {
  if (env.UPTIME_PROBER_INTERVAL_MS <= 0) {
    logger.info("Uptime prober queue disabled (UPTIME_PROBER_INTERVAL_MS <= 0)");
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
      repeat: { every: env.UPTIME_PROBER_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const deps = buildUptimeProberTickDeps();
      const result = await runUptimeProberTick({ now: new Date() }, deps);
      logger.info(result, "Uptime prober tick complete");
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Uptime prober job failed");
  });
  worker.on("error", (error) => {
    logger.error({ error }, "Uptime prober worker error");
  });

  logger.info(
    { intervalMs: env.UPTIME_PROBER_INTERVAL_MS, queue: QUEUE_NAME },
    "Uptime prober BullMQ queue started",
  );
}

export async function stopUptimeProberQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info("Uptime prober queue stopped");
}
