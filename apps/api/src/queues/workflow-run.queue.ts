/**
 * workflow-run queue: one job per workflow run, plus the reaper tick.
 *
 * A run used to execute inside the HTTP request that started it. Now the
 * request records a 'queued' row and enqueues a job here; this worker
 * claims the row and runs it (services/runWorkflowExecutionJob.ts).
 *
 * Exactly-once is the row's job, not the queue's:
 *   - the job id IS the execution id, so a repeated enqueue adds nothing;
 *   - attempts is 1, so BullMQ never retries a run that may already have
 *     invoked (and billed) agents;
 *   - a redelivered or stalled job still has to win the queued → running
 *     compare-and-set, and a second delivery cannot.
 *
 * WORKFLOW_RUN_CONCURRENCY=0 switches the worker off; starting a run then
 * answers 501 instead of queueing work nobody will pick up.
 *
 * DI on the queue instance lets the unit tests avoid Redis.
 */

import type { Queue, Worker } from "bullmq";

import { createLogger } from "../utils/logger.js";

const logger = createLogger("workflow-run-queue");

export const WORKFLOW_RUN_QUEUE_NAME = "workflow-run";
export const WORKFLOW_RUN_JOB_NAME = "workflow-run";
const REAPER_QUEUE_NAME = "workflow-run-reaper";
const REAPER_JOB_KEY = "workflow-run-reaper-tick";

/** A queued row older than this with no job behind it was lost. */
const QUEUED_GRACE_MS = 120_000;
/** How far past its own timeout a 'running' row may be before it is lost. */
const RUNNING_GRACE_MS = 120_000;

export interface WorkflowRunJobPayload {
  executionId: string;
}

export interface WorkflowRunEnqueueDeps {
  queue?: Pick<Queue, "add">;
}

let defaultQueue: Queue | null = null;

// Resolved lazily so tests importing this file don't touch Redis.
async function resolveQueue(): Promise<Queue> {
  if (defaultQueue) return defaultQueue;
  const { Queue } = await import("bullmq");
  const { getQueueConnectionOpts } = await import("./connection.js");
  const { connection } = getQueueConnectionOpts();
  defaultQueue = new Queue(WORKFLOW_RUN_QUEUE_NAME, { connection });
  return defaultQueue;
}

export async function enqueueWorkflowRun(
  executionId: string,
  deps: WorkflowRunEnqueueDeps = {},
): Promise<void> {
  if (!executionId) throw new Error("workflow-run: executionId is required");
  const queue = deps.queue ?? (await resolveQueue());
  const payload: WorkflowRunJobPayload = { executionId };
  await queue.add(WORKFLOW_RUN_JOB_NAME, payload, {
    jobId: executionId, // dedup: one run, one job
    attempts: 1, // never re-run work that may already have been billed
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 5_000 },
  });
}

/** Drops a queued run's job after the run was cancelled. Best-effort. */
export async function removeWorkflowRunJob(executionId: string): Promise<void> {
  const queue = await resolveQueue();
  const job = await queue.getJob(executionId);
  // An active job cannot be removed; its claim will fail instead.
  await job?.remove().catch(() => {});
}

async function isJobPending(executionId: string): Promise<boolean> {
  const queue = await resolveQueue();
  const job = await queue.getJob(executionId);
  if (!job) return false;
  const state = await job.getState();
  return state === "waiting" || state === "active" || state === "delayed" || state === "prioritized";
}

// ============================================
// Consumer lifecycle (production wiring)
// ============================================

let runWorker: Worker | null = null;
let reaperQueue: Queue | null = null;
let reaperWorker: Worker | null = null;
let shutdown: AbortController | null = null;

export async function startWorkflowRunQueue(): Promise<void> {
  const [{ Queue, Worker }, { getQueueConnectionOpts }, { env }] = await Promise.all([
    import("bullmq"),
    import("./connection.js"),
    import("../config/env.js"),
  ]);
  const { prisma } = await import("../lib/prisma.js");
  const { triggerWebhook } = await import("../services/webhooks.js");
  const { connection } = getQueueConnectionOpts();

  const emitEvent = async (
    orgId: string,
    type: "workflow.completed" | "workflow.failed",
    data: Record<string, unknown>,
  ) => {
    await triggerWebhook(orgId, type, data, "orchestration", String(data.orchestrationId));
  };
  const onSideEffectError = (what: string, err: unknown) => {
    logger.error({ err, what }, "Workflow run bookkeeping failed");
  };

  if (env.WORKFLOW_RUN_CONCURRENCY <= 0) {
    logger.info("Workflow run worker disabled (WORKFLOW_RUN_CONCURRENCY <= 0)");
  } else {
    const { buildWorkflowExecutionJobDeps } = await import(
      "../services/buildWorkflowRunDeps.js"
    );
    const { buildOrchestrationExecutorDeps, modelStepCapability } = await import(
      "../services/buildOrchestrationExecutorDeps.js"
    );
    const { runWorkflowExecutionJob } = await import(
      "../services/runWorkflowExecutionJob.js"
    );

    const controller = new AbortController();
    shutdown = controller;
    const deps = buildWorkflowExecutionJobDeps({
      prisma,
      engineBindings: (run) => buildOrchestrationExecutorDeps(run.id),
      emitEvent,
      capabilities: { modelSteps: modelStepCapability() },
      onSideEffectError,
    });

    runWorker = new Worker(
      WORKFLOW_RUN_QUEUE_NAME,
      async (job) => {
        const { executionId } = job.data as WorkflowRunJobPayload;
        const result = await runWorkflowExecutionJob(
          { executionId, shutdownSignal: controller.signal },
          deps,
        );
        logger.info({ executionId, result }, "Workflow run handled");
      },
      { connection, concurrency: env.WORKFLOW_RUN_CONCURRENCY },
    );
    runWorker.on("failed", (job, error) => {
      logger.error({ jobId: job?.id, error }, "Workflow run job failed");
    });
    runWorker.on("error", (error) => {
      logger.error({ error }, "Workflow run worker error");
    });
    logger.info(
      { queue: WORKFLOW_RUN_QUEUE_NAME, concurrency: env.WORKFLOW_RUN_CONCURRENCY },
      "Workflow run worker started",
    );
  }

  if (env.WORKFLOW_REAP_INTERVAL_MS <= 0) {
    logger.info("Workflow run reaper disabled (WORKFLOW_REAP_INTERVAL_MS <= 0)");
    return;
  }

  const { buildWorkflowReaperTickDeps } = await import(
    "../services/buildWorkflowReaperTickDeps.js"
  );
  const { runWorkflowReaperTick } = await import("../services/runWorkflowReaperTick.js");

  reaperQueue = new Queue(REAPER_QUEUE_NAME, { connection });
  const existing = await reaperQueue.getRepeatableJobs();
  for (const job of existing) {
    if (job.key === REAPER_JOB_KEY || job.name === REAPER_JOB_KEY) {
      await reaperQueue.removeRepeatableByKey(job.key);
    }
  }
  await reaperQueue.add(
    REAPER_JOB_KEY,
    {},
    { repeat: { every: env.WORKFLOW_REAP_INTERVAL_MS }, jobId: REAPER_JOB_KEY },
  );

  reaperWorker = new Worker(
    REAPER_QUEUE_NAME,
    async () => {
      const result = await runWorkflowReaperTick(
        { now: new Date(), queuedGraceMs: QUEUED_GRACE_MS, runningGraceMs: RUNNING_GRACE_MS },
        buildWorkflowReaperTickDeps({ prisma, isJobPending, emitEvent, onSideEffectError }),
      );
      if (result.reaped > 0 || result.errors > 0) {
        logger.warn(result, "Workflow run reaper tick");
      }
    },
    { connection, concurrency: 1 },
  );
  reaperWorker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Workflow run reaper job failed");
  });
  reaperWorker.on("error", (error) => {
    logger.error({ error }, "Workflow run reaper worker error");
  });
  logger.info(
    { intervalMs: env.WORKFLOW_REAP_INTERVAL_MS, queue: REAPER_QUEUE_NAME },
    "Workflow run reaper started",
  );
}

export async function stopWorkflowRunQueue(): Promise<void> {
  // In-flight runs are aborted rather than awaited: a run may have an
  // hour left, and each ends as failed ("worker shutting down") through
  // its own compare-and-set instead of being left for the reaper.
  shutdown?.abort();
  shutdown = null;
  if (runWorker) {
    await runWorker.close();
    runWorker = null;
  }
  if (reaperWorker) {
    await reaperWorker.close();
    reaperWorker = null;
  }
  if (reaperQueue) {
    await reaperQueue.close();
    reaperQueue = null;
  }
  if (defaultQueue) {
    await defaultQueue.close();
    defaultQueue = null;
  }
  logger.info("Workflow run queue stopped");
}
