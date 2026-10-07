import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createDailySnapshot } from "../services/analytics.js";
import {
  buildLatencySampleDeps,
  latencyConfigFromEnv,
} from "../services/buildLatencySampleDeps.js";
import { runAnalyticsSnapshotTick } from "../services/runAnalyticsSnapshotTick.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "analytics-snapshot";
const REPEATABLE_JOB_KEY = "analytics-snapshot-tick";

const logger = createLogger("analytics-snapshot-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the analytics-snapshot queue (Wave 1) — the first caller
 * createDailySnapshot ever had. Maintains today's rolling daily
 * snapshot and finalizes yesterday's for every org with recent usage, then
 * deletes per-request latency samples past LATENCY_SAMPLE_RETENTION_DAYS.
 * Only starts when `env.ANALYTICS_SNAPSHOT_INTERVAL_MS` is > 0.
 */
export async function startAnalyticsSnapshotQueue(): Promise<void> {
  if (env.ANALYTICS_SNAPSHOT_INTERVAL_MS <= 0) {
    logger.info(
      "Analytics snapshot queue disabled (ANALYTICS_SNAPSHOT_INTERVAL_MS <= 0)",
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
      repeat: { every: env.ANALYTICS_SNAPSHOT_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  const latency = buildLatencySampleDeps({ config: latencyConfigFromEnv(env) });

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const result = await runAnalyticsSnapshotTick(
        { now: new Date() },
        {
          loadActiveOrgIds: async ({ since }) => {
            const rows = await prisma.usageRecord.findMany({
              where: { periodEnd: { gte: since } },
              select: { orgId: true },
              distinct: ["orgId"],
            });
            // An org whose only traffic is agent chats has no UsageRecord,
            // and its day (latency included) belongs in the history too.
            const agentRows = await prisma.agentUsageRecord.findMany({
              where: { periodStart: { gte: since } },
              select: { orgId: true },
              distinct: ["orgId"],
            });
            return [...new Set([...rows, ...agentRows].map((r) => r.orgId))];
          },
          snapshotOrgDay: (orgId, day) => createDailySnapshot(orgId, day),
          pruneLatencySamples: latency.pruneLatencySamples,
        },
      );
      logger.info(result, "Analytics snapshot tick complete");
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Analytics snapshot job failed");
  });
  worker.on("error", (error) => {
    logger.error({ error }, "Analytics snapshot worker error");
  });

  logger.info(
    { intervalMs: env.ANALYTICS_SNAPSHOT_INTERVAL_MS, queue: QUEUE_NAME },
    "Analytics snapshot BullMQ queue started",
  );
}

export async function stopAnalyticsSnapshotQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
  logger.info("Analytics snapshot queue stopped");
}
