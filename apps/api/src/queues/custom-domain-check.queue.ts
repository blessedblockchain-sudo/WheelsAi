import { Queue, Worker } from "bullmq";

import { getCustomDomainConfig } from "../config/customDomains.js";
import { prisma } from "../lib/prisma.js";
import {
  buildCustomDomainCheckTickDeps,
  type CustomDomainCheckPrisma,
} from "../services/buildCustomDomainCheckTickDeps.js";
import { runCustomDomainCheckTick } from "../services/runCustomDomainCheckTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "custom-domain-check";
const REPEATABLE_JOB_KEY = "custom-domain-check-tick";
/**
 * A tick waits on DNS timeouts and on handshakes that are held open while the
 * edge obtains a certificate, so it can outlast BullMQ's default 30s lock; a
 * tick taken for stalled would be run a second time alongside the first.
 */
const LOCK_DURATION_MS = 5 * 60_000;

const logger = createLogger("custom-domain-check-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the custom-domain checker: every tick re-checks the domains whose
 * nextCheckAt is due (ownership record, DNS routing, plan, target, and the
 * certificate the edge presents). Each domain carries its own cadence in
 * nextCheckAt; the interval here is only how often due rows are looked for.
 *
 * It does not start, and opens no Redis connection, when the edge is not
 * configured (there is nothing to observe a certificate on) or when
 * CUSTOM_DOMAIN_CHECK_INTERVAL_MS is 0.
 */
export async function startCustomDomainCheckQueue(): Promise<void> {
  const config = getCustomDomainConfig();
  const edge = config.edge;
  if (!edge) {
    logger.info(
      { reason: config.unavailableReason },
      "Custom domain check queue disabled (custom domains are not configured)",
    );
    return;
  }
  if (config.checkIntervalMs <= 0) {
    logger.info("Custom domain check queue disabled (CUSTOM_DOMAIN_CHECK_INTERVAL_MS <= 0)");
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
      repeat: { every: config.checkIntervalMs },
      jobId: REPEATABLE_JOB_KEY,
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const deps = buildCustomDomainCheckTickDeps({
        prisma: prisma as unknown as CustomDomainCheckPrisma,
        edge,
        config,
      });
      const result = await runCustomDomainCheckTick({ now: new Date() }, deps);
      if (result.edgeOutageSuspected) {
        logger.warn(result, "Custom domain check tick: most handshakes could not reach the edge");
      } else if (result.due > 0) {
        logger.info(result, "Custom domain check tick complete");
      }
    },
    { connection, concurrency: 1, lockDuration: LOCK_DURATION_MS },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Custom domain check job failed");
  });
  worker.on("error", (error) => {
    logger.error({ error }, "Custom domain check worker error");
  });

  logger.info(
    { intervalMs: config.checkIntervalMs, queue: QUEUE_NAME, edge: edge.hostname },
    "Custom domain check BullMQ queue started",
  );
}

export async function stopCustomDomainCheckQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info("Custom domain check queue stopped");
}
