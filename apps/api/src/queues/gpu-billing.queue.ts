import { Queue, Worker } from "bullmq";

import { getNosanaDeployConfig } from "../config/nosanaDeploy.js";
import { prisma } from "../lib/prisma.js";
import { buildGpuBillingTickDeps } from "../services/buildGpuBillingTickDeps.js";
import { getNosanaClient } from "../services/nosana.js";
import { runGpuBillingTick } from "../services/runGpuBillingTick.js";
import { triggerWebhook } from "../services/webhooks.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "gpu-billing";
const REPEATABLE_JOB_KEY = "gpu-billing-tick";

const logger = createLogger("gpu-billing-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the BullMQ-backed GPU billing queue and worker.
 *
 * Nosana jobs are paid by the platform wallet for as long as they run, so this
 * worker charges each org for the GPU time of its RUNNING model deployments
 * (price(tier) x replicas x seconds, ledger type 'gpu_usage') and stops a
 * deployment whose org can no longer pay. See services/gpuBilling.ts.
 *
 * Only starts if `GPU_BILLING_INTERVAL_MS` (config/nosanaDeploy.ts, default
 * 60000) is greater than 0.
 */
export async function startGpuBillingQueue(): Promise<void> {
  const intervalMs = getNosanaDeployConfig().gpuBillingIntervalMs;
  if (intervalMs <= 0) {
    logger.info("GPU billing queue disabled (GPU_BILLING_INTERVAL_MS <= 0)");
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
      repeat: { every: intervalMs },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const client = await getNosanaClient();
      const deps = buildGpuBillingTickDeps({
        prisma,
        stopDeployment: (id) => client.stopDeployment(id),
        ensureRunway: ({ nosanaDeploymentId, gpuTier, replicas }) =>
          client.ensureDeploymentRunway(nosanaDeploymentId, gpuTier, replicas),
        emitStopped: async (row, reason) => {
          await triggerWebhook(
            row.orgId,
            "deployment.stopped",
            {
              deploymentId: row.id,
              deploymentKind: "model",
              toStatus: "stopped",
              reason,
            },
            "deployment",
            row.id,
          );
        },
      });
      const result = await runGpuBillingTick({ now: new Date() }, deps);
      logger.info(
        { ...result, chargedCents: result.chargedCents.toString() },
        "GPU billing tick complete",
      );
    },
    {
      connection,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "GPU billing job failed");
  });
  worker.on("error", (error) => {
    logger.error({ error }, "GPU billing worker error");
  });

  logger.info(
    { intervalMs, queue: QUEUE_NAME },
    "GPU billing BullMQ queue started",
  );
}

/**
 * Stops the GPU billing worker and drains the queue gracefully.
 */
export async function stopGpuBillingQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info("GPU billing BullMQ queue stopped");
}
