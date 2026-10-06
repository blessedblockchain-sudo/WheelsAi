/**
 * Composition root for the workflow-run reaper: binds
 * runWorkflowReaperTick to Prisma.
 *
 * `failRun` is a compare-and-set on the status the reaper read
 * ({id, status: 'queued'} or {id, status: 'running'}), so a worker that
 * claims or finishes the run between the read and the write makes this a
 * count=0 no-op rather than a second ending.
 */

import type { PrismaClient } from "@prisma/client";

import {
  recordWorkflowRunStats,
  type WorkflowRunPrismaStub,
} from "./buildWorkflowRunDeps.js";
import { finishScheduledExecution } from "./finishScheduledExecution.js";
import type { WorkflowEventType } from "./runWorkflowExecutionJob.js";
import type { ReapCandidate, WorkflowReaperTickDeps } from "./runWorkflowReaperTick.js";

const DEFAULT_BATCH_LIMIT = 100;

interface ReaperRow {
  id: string;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  taskExecutionId: string | null;
  orchestration: { id: string; orgId: string; name: string; timeout: number };
}

interface ReaperExecutionDelegateStub {
  findMany: (args: {
    where: {
      OR: [
        { status: "queued"; createdAt: { lt: Date } },
        { status: "running"; startedAt: { lt: Date } },
      ];
    };
    orderBy: { createdAt: "asc" };
    take: number;
    select: Record<string, unknown>;
  }) => Promise<ReaperRow[]>;
}

export function buildWorkflowReaperTickDeps(input: {
  prisma: PrismaClient | WorkflowRunPrismaStub;
  isJobPending?: (executionId: string) => Promise<boolean>;
  emitEvent: (
    orgId: string,
    type: WorkflowEventType,
    data: Record<string, unknown>,
  ) => Promise<void>;
  onSideEffectError?: (what: string, err: unknown) => void;
  batchLimit?: number;
}): WorkflowReaperTickDeps {
  const prisma = input.prisma as unknown as WorkflowRunPrismaStub;
  const executions = prisma.orchestrationExecution as unknown as ReaperExecutionDelegateStub;

  return {
    loadCandidates: async ({ queuedBefore, runningStartedBefore }) => {
      const rows = await executions.findMany({
        where: {
          OR: [
            { status: "queued", createdAt: { lt: queuedBefore } },
            { status: "running", startedAt: { lt: runningStartedBefore } },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: input.batchLimit ?? DEFAULT_BATCH_LIMIT,
        select: {
          id: true,
          status: true,
          createdAt: true,
          startedAt: true,
          taskExecutionId: true,
          orchestration: { select: { id: true, orgId: true, name: true, timeout: true } },
        },
      });
      return rows.map(
        (row): ReapCandidate => ({
          id: row.id,
          status: row.status === "queued" ? "queued" : "running",
          orchestrationId: row.orchestration.id,
          orgId: row.orchestration.orgId,
          workflowName: row.orchestration.name,
          timeout: row.orchestration.timeout,
          createdAt: row.createdAt,
          startedAt: row.startedAt,
          taskExecutionId: row.taskExecutionId,
        }),
      );
    },

    isJobPending: input.isJobPending,

    failRun: async ({ executionId, from, error, now, durationMs }) => {
      const { count } = await prisma.orchestrationExecution.updateMany({
        where: { id: executionId, status: from },
        data: {
          status: "failed",
          error,
          completedAt: now,
          ...(durationMs === null ? {} : { durationMs }),
        },
      });
      return count > 0;
    },

    recordRunStats: (orchestrationId, stats) =>
      recordWorkflowRunStats(prisma, orchestrationId, stats),

    finishLinkedTaskExecution: async (taskExecutionId, outcome) => {
      await finishScheduledExecution(prisma, taskExecutionId, outcome);
    },

    emitEvent: input.emitEvent,
    onSideEffectError: input.onSideEffectError,
  };
}
