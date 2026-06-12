import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { buildDeploymentStatusTickDeps } from "../services/buildDeploymentStatusTickDeps.js";
import { getNosanaClient } from "../services/nosana.js";
import { runDeploymentStatusTick } from "../services/runDeploymentStatusTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "deployment-status";
const REPEATABLE_JOB_KEY = "deployment-status-tick";

const logger = createLogger("deployment-status-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the BullMQ-backed deployment-status queue and worker (plan D8).
 * Polls Nosana job state for non-terminal model/agent deployments and
 * persists OBSERVED transitions — replaces the deleted setTimeout
 * status simulation in routes/agents.ts / routes/deployments.ts.
 * Only starts if `env.DEPLOYMENT_STATUS_INTERVAL_MS` is greater than 0.
 */
export async function startDeploymentStatusQueue(): Promise<void> {
  if (env.DEPLOYMENT_STATUS_INTERVAL_MS <= 0) {
    logger.info(
      "Deployment status queue disabled (DEPLOYMENT_STATUS_INTERVAL_MS <= 0)",
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
      repeat: { every: env.DEPLOYMENT_STATUS_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const client = await getNosanaClient();
      const deps = buildDeploymentStatusTickDeps({
        prisma,
        // Strict read: throws on SDK/RPC failure so rows stay untouched
        // during an outage (getJobStatus's "running" stub would be the
        // exact fabrication D8 removes).
        getJobStatus: (jobId) => client.getJobStatusStrict(jobId),
        allowMock: env.ALLOW_NOSANA_MOCK,
      });
      const result = await runDeploymentStatusTick({ now: new Date() }, deps);
      logger.info(result, "Deployment status tick complete");
    },
    {
      connection,
      concurrency: 1,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Deployment status job failed");
  });
  worker.on("error", (error) => {
    logger.error({ error }, "Deployment status worker error");
  });

  logger.info(
    {
      intervalMs: env.DEPLOYMENT_STATUS_INTERVAL_MS,
      queue: QUEUE_NAME,
    },
    "Deployment status BullMQ queue started",
  );
}

/**
 * Stops the deployment-status worker and drains the queue gracefully.
 */
export async function stopDeploymentStatusQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info("Deployment status BullMQ queue stopped");
}
