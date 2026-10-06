/**
 * Composition root for the workflow run lifecycle: binds startWorkflowRun
 * and runWorkflowExecutionJob to Prisma.
 *
 * Every status change here is a compare-and-set, spelled out in the
 * `where` clause:
 *
 *   start    insert 'queued'            (under the org's run-cap lock)
 *   claim    {id, status: 'queued'}  →  'running'
 *   finish   {id, status: 'running'} →  completed | failed | cancelled
 *   unqueue  {id, status: 'queued'}  →  'failed'   (enqueue failed)
 *
 * so a run cancelled while queued can never be claimed, and a run the
 * reaper already failed can never be overwritten by a late worker.
 *
 * The delegates are structural stubs with compile-time guards against the
 * generated Prisma types, the same pattern as buildSchedulerTickDeps: a
 * unit test can pass a fake, and a schema change that breaks a `where`
 * clause fails the type-check instead of failing at run time.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  finishScheduledExecution,
  type FinishScheduledExecutionPrisma,
} from "./finishScheduledExecution.js";
import type {
  ClaimedRun,
  RunOutcome,
  WorkflowEngineBindings,
  WorkflowEventType,
  WorkflowExecutionJobDeps,
} from "./runWorkflowExecutionJob.js";
import type { NewRunRow, QueuedRun, StartWorkflowRunDeps } from "./startWorkflowRun.js";
import {
  validateWorkflowDefinition,
  type LoadOwnership,
  type WorkflowCapabilities,
} from "./workflowDefinition.js";

export const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;

interface ExecutionDelegateStub {
  updateMany: (args: {
    where: { id: string; status: "queued" | "running" };
    data: Record<string, unknown>;
  }) => Promise<{ count: number }>;
  findUnique: (args: {
    where: { id: string };
    select?: Record<string, unknown>;
    include?: Record<string, unknown>;
  }) => Promise<unknown>;
  count: (args: {
    where: { status: { in: string[] }; orchestration: { orgId: string } };
  }) => Promise<number>;
  create: (args: {
    data: Record<string, unknown>;
    select: Record<string, true>;
  }) => Promise<QueuedRun>;
}

type _ExecutionUpdateManyCheck = Parameters<
  ExecutionDelegateStub["updateMany"]
>[0] extends Prisma.OrchestrationExecutionUpdateManyArgs
  ? true
  : never;
type _ExecutionCountCheck = Parameters<
  ExecutionDelegateStub["count"]
>[0] extends Prisma.OrchestrationExecutionCountArgs
  ? true
  : never;
const _argsCheck: [_ExecutionUpdateManyCheck, _ExecutionCountCheck] = [true, true];
void _argsCheck;

interface IdLookupStub {
  findMany: (args: {
    where: { id: { in: string[] }; orgId: string };
    select: { id: true };
  }) => Promise<Array<{ id: string }>>;
}

export interface WorkflowRunPrismaStub extends FinishScheduledExecutionPrisma {
  orchestration: {
    findFirst: (args: {
      where: { id: string; orgId: string };
      select: { id: true; isEnabled: true; inputSchema: true };
    }) => Promise<{ id: string; isEnabled: boolean; inputSchema: unknown } | null>;
  };
  orchestrationExecution: ExecutionDelegateStub;
  agent: IdLookupStub;
  deployment: IdLookupStub;
  knowledgeBase: IdLookupStub;
  $transaction: <T>(fn: (tx: WorkflowRunPrismaStub) => Promise<T>) => Promise<T>;
  $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
}

export type WorkflowRunPrismaSurface = PrismaClient | WorkflowRunPrismaStub;

function stub(prisma: WorkflowRunPrismaSurface): WorkflowRunPrismaStub {
  return prisma as unknown as WorkflowRunPrismaStub;
}

/** Which of the given resources belong to `orgId`. */
export function buildLoadOwnership(
  prismaSurface: WorkflowRunPrismaSurface,
  orgId: string,
): LoadOwnership {
  const prisma = stub(prismaSurface);
  const owned = async (delegate: IdLookupStub, ids: string[]) =>
    ids.length === 0
      ? []
      : (
          await delegate.findMany({ where: { id: { in: ids }, orgId }, select: { id: true } })
        ).map((row) => row.id);

  return async (ids) => {
    const [agentIds, deploymentIds, knowledgeBaseIds] = await Promise.all([
      owned(prisma.agent, ids.agentIds),
      owned(prisma.deployment, ids.deploymentIds),
      owned(prisma.knowledgeBase, ids.knowledgeBaseIds),
    ]);
    return { agentIds, deploymentIds, knowledgeBaseIds };
  };
}

/**
 * Rolls a workflow's counters forward in ONE statement. The average is a
 * running mean over total_runs, computed in SQL from the row's current
 * values, so two runs finishing together cannot both read the same stale
 * count. Raw SQL also leaves updated_at alone: that column is the
 * editor's optimistic-lock token, and a finished run is not an edit.
 */
export async function recordWorkflowRunStats(
  prismaSurface: WorkflowRunPrismaSurface,
  orchestrationId: string,
  stats: { success: boolean; durationMs: number; at: Date },
): Promise<void> {
  const prisma = stub(prismaSurface);
  const succeeded = stats.success ? 1 : 0;
  const failed = stats.success ? 0 : 1;
  await prisma.$executeRaw`
    UPDATE "orchestrations"
    SET "avg_duration_ms" = ROUND(
          (COALESCE("avg_duration_ms", 0)::numeric * "total_runs" + ${stats.durationMs})
          / ("total_runs" + 1)
        )::int,
        "total_runs" = "total_runs" + 1,
        "successful_runs" = "successful_runs" + ${succeeded},
        "failed_runs" = "failed_runs" + ${failed},
        "last_run_at" = ${stats.at}
    WHERE "id" = ${orchestrationId}::uuid`;
}

export function buildStartWorkflowRunDeps(input: {
  prisma: WorkflowRunPrismaSurface;
  enqueue: (executionId: string) => Promise<void>;
  runnerEnabled: boolean;
  maxActiveRunsPerOrg: number;
}): StartWorkflowRunDeps {
  const prisma = stub(input.prisma);

  return {
    runnerEnabled: input.runnerEnabled,
    maxActiveRunsPerOrg: input.maxActiveRunsPerOrg,

    loadWorkflow: (orchestrationId, orgId) =>
      prisma.orchestration.findFirst({
        where: { id: orchestrationId, orgId },
        select: { id: true, isEnabled: true, inputSchema: true },
      }),

    createQueuedRun: (row: NewRunRow, maxActive: number) =>
      prisma.$transaction(async (tx) => {
        // One start at a time per organization: without the lock two
        // requests could both count N-1 active runs and both insert.
        // Released when the transaction ends.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`workflow-runs:${row.orgId}`}))::text`;
        const active = await tx.orchestrationExecution.count({
          where: {
            status: { in: [...ACTIVE_RUN_STATUSES] },
            orchestration: { orgId: row.orgId },
          },
        });
        if (active >= maxActive) return null;
        return tx.orchestrationExecution.create({
          data: {
            orchestrationId: row.orchestrationId,
            status: "queued",
            input: row.input,
            triggeredBy: row.triggeredBy,
            triggeredById: row.triggeredById,
            scheduledTaskId: row.scheduledTaskId,
            taskExecutionId: row.taskExecutionId,
            jobId: row.jobId,
          },
          select: {
            id: true,
            status: true,
            triggeredBy: true,
            triggeredById: true,
            createdAt: true,
          },
        });
      }),

    enqueue: input.enqueue,

    failQueuedRun: async (executionId, error) => {
      await prisma.orchestrationExecution.updateMany({
        where: { id: executionId, status: "queued" },
        data: { status: "failed", error, completedAt: new Date() },
      });
    },
  };
}

interface StoredRun {
  id: string;
  input: unknown;
  triggeredBy: string;
  scheduledTaskId: string | null;
  taskExecutionId: string | null;
  jobId: string | null;
  orchestration: {
    id: string;
    orgId: string;
    name: string;
    executionMode: string;
    maxConcurrency: number;
    timeout: number;
    retryPolicy: unknown;
    inputSchema: unknown;
    outputSchema: unknown;
    steps: Array<{
      id: string;
      name: string;
      stepOrder: number;
      stepType: string;
      agentId: string | null;
      deploymentId: string | null;
      modelId: string | null;
      knowledgeBaseId: string | null;
      promptTemplate: string | null;
      inputMapping: unknown;
      outputMapping: unknown;
      outputFormat: string;
      condition: unknown;
      loop: unknown;
      onError: string;
      fallbackAgentId: string | null;
      maxRetries: number;
      timeoutMs: number | null;
      dependsOn: string[];
    }>;
  };
}

export function buildWorkflowExecutionJobDeps(input: {
  prisma: WorkflowRunPrismaSurface;
  engineBindings: (run: ClaimedRun, signal: AbortSignal) => WorkflowEngineBindings;
  emitEvent: (
    orgId: string,
    type: WorkflowEventType,
    data: Record<string, unknown>,
  ) => Promise<void>;
  capabilities?: WorkflowCapabilities;
  onSideEffectError?: (what: string, err: unknown) => void;
  cancelPollMs?: number;
}): WorkflowExecutionJobDeps {
  const prisma = stub(input.prisma);

  return {
    claimRun: async (executionId, startedAt) => {
      const { count } = await prisma.orchestrationExecution.updateMany({
        where: { id: executionId, status: "queued" },
        data: { status: "running", startedAt, progress: 0 },
      });
      return count > 0;
    },

    loadRun: async (executionId) => {
      const row = (await prisma.orchestrationExecution.findUnique({
        where: { id: executionId },
        include: {
          orchestration: { include: { steps: { orderBy: { stepOrder: "asc" } } } },
        },
      })) as StoredRun | null;
      if (!row) return null;
      const workflow = row.orchestration;
      return {
        id: row.id,
        input:
          typeof row.input === "object" && row.input !== null && !Array.isArray(row.input)
            ? (row.input as Record<string, unknown>)
            : {},
        triggeredBy: row.triggeredBy,
        scheduledTaskId: row.scheduledTaskId,
        taskExecutionId: row.taskExecutionId,
        jobId: row.jobId,
        workflow: {
          id: workflow.id,
          orgId: workflow.orgId,
          name: workflow.name,
          executionMode: workflow.executionMode,
          maxConcurrency: workflow.maxConcurrency,
          timeout: workflow.timeout,
          retryPolicy: workflow.retryPolicy,
          outputSchema: workflow.outputSchema,
          steps: workflow.steps.map((s) => ({ ...s })),
        },
      };
    },

    validateWorkflow: async (run) => {
      const validation = await validateWorkflowDefinition(run.workflow, {
        loadOwnership: buildLoadOwnership(prisma, run.workflow.orgId),
        capabilities: input.capabilities,
      });
      return validation.ok ? null : validation.issue.message;
    },

    engineBindings: input.engineBindings,

    isCancelRequested: async (executionId) => {
      const row = (await prisma.orchestrationExecution.findUnique({
        where: { id: executionId },
        select: { status: true, cancelRequestedAt: true },
      })) as { status: string; cancelRequestedAt: Date | null } | null;
      // A row that is gone (workflow deleted) or no longer running has
      // nothing left to run for.
      return !row || row.status !== "running" || row.cancelRequestedAt !== null;
    },

    finishRun: async (executionId, outcome: RunOutcome) => {
      const { count } = await prisma.orchestrationExecution.updateMany({
        where: { id: executionId, status: "running" },
        data: {
          status: outcome.status,
          ...(outcome.status === "completed" ? { progress: 100 } : {}),
          output: outcome.output,
          context: outcome.context,
          error: outcome.error,
          failedStepId: outcome.failedStepId,
          completedAt: outcome.completedAt,
          durationMs: outcome.durationMs,
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
    cancelPollMs: input.cancelPollMs,
  };
}
