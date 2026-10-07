import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { buildDeploymentStatusTickDeps } from "../services/buildDeploymentStatusTickDeps.js";
import { createEmitDeploymentTransition } from "../services/deploymentTransitionEvents.js";
import { getNosanaDeployConfig } from "../config/nosanaDeploy.js";
import { getNosanaClient, isNosanaMockEnabled } from "../services/nosana.js";
import { runDeploymentStatusTick } from "../services/runDeploymentStatusTick.js";
import { triggerWebhook } from "../services/webhooks.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "deployment-status";
const REPEATABLE_JOB_KEY = "deployment-status-tick";

const logger = createLogger("deployment-status-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the BullMQ-backed deployment-status queue and worker (plan D8).
 * Polls the Nosana Deployment Manager for non-terminal model/agent
 * deployments and persists OBSERVED transitions (and their real endpoints as
 * DeploymentNodes) — replaces the deleted setTimeout
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
        // Strict read of the Nosana Deployment-Manager deployment (status +
        // the real endpoints): throws on API failure so rows stay untouched
        // during an outage. `nosanaJobIds[0]` is a Deployment-Manager id, NOT
        // an on-chain job address, so jobs.get() cannot be used.
        // Each id is read through the credential that created it (the row's
        // access-mode stamp), whatever the primary mode is today. Events only
        // for a halted deployment: they are what explains the failure.
        getDeploymentStatus: (id, mode) =>
          client.getDeploymentStatus(id, mode, { jobs: false, events: "when_halted" }),
        checkNodeHealth: (nodeUrl, engine) => client.checkNodeHealth(nodeUrl, engine),
        // Retry vault.withdraw for stopped/failed deployments until the
        // platform's funds are verified recovered (with API-key access:
        // until Nosana reports the deployment no longer running).
        reclaimVault: (id, mode, options) => client.reclaimDeploymentVault(id, mode, options),
        // A row failed because Nosana halted it (ERROR, INSUFFICIENT_FUNDS) is
        // stopped in the same tick: INSUFFICIENT_FUNDS resumes after a top-up.
        stopDeployment: (id, mode) => client.stopDeployment(id, mode),
        // Once per tick: ids created by an access mode this process has no
        // credential for. They can be neither read nor stopped from here.
        reportAccessModeUnavailable: (skipped) =>
          logger.error(
            { count: skipped.length, skipped: skipped.slice(0, 50) },
            "Nosana deployments skipped: no credential in this process for the access mode that created them",
          ),
        reclaimMaxAgeHours: getNosanaDeployConfig().reclaimMaxAgeHours,
        allowMock: isNosanaMockEnabled(),
        // Tick-observed events: deployment.running / failed / stopped, plus
        // agent.deployed when an agent deployment starts running. degraded
        // has no event type.
        emitTransition: createEmitDeploymentTransition({
          loadDeployedAgent: async (deploymentId, orgId) => {
            const row = await prisma.agentDeployment.findFirst({
              where: { id: deploymentId, agent: { orgId } },
              select: { agent: { select: { id: true, name: true, slug: true } } },
            });
            return row ? { agentId: row.agent.id, name: row.agent.name, slug: row.agent.slug } : null;
          },
          triggerWebhook,
          onError: (err, eventType) => logger.error({ err, eventType }, "tick webhook emission failed"),
        }),
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
