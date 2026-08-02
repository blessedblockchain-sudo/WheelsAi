import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { buildAlertEvaluatorTickDeps } from "../services/buildAlertEvaluatorTickDeps.js";
import { runAlertEvaluatorTick } from "../services/runAlertEvaluatorTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "alert-evaluator";
const REPEATABLE_JOB_KEY = "alert-evaluator-tick";

const logger = createLogger("alert-evaluator-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the alert-evaluator queue (Wave 1) — the first caller
 * triggerAlert ever had. Evaluates every enabled AlertRule against real
 * usage/uptime data and fires alerts (cooldown, notifications, and the
 * alert.triggered webhook). Only starts when
 * `env.ALERT_EVALUATOR_INTERVAL_MS` is greater than 0.
 */
export async function startAlertEvaluatorQueue(): Promise<void> {
  if (env.ALERT_EVALUATOR_INTERVAL_MS <= 0) {
    logger.info(
      "Alert evaluator queue disabled (ALERT_EVALUATOR_INTERVAL_MS <= 0)",
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
      repeat: { every: env.ALERT_EVALUATOR_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const deps = buildAlertEvaluatorTickDeps();
      const result = await runAlertEvaluatorTick({ now: new Date() }, deps);
      logger.info(result, "Alert evaluator tick complete");
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Alert evaluator job failed");
  });
  worker.on("error", (error) => {
    logger.error({ error }, "Alert evaluator worker error");
  });

  logger.info(
    { intervalMs: env.ALERT_EVALUATOR_INTERVAL_MS, queue: QUEUE_NAME },
    "Alert evaluator BullMQ queue started",
  );
}

export async function stopAlertEvaluatorQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info("Alert evaluator queue stopped");
}
