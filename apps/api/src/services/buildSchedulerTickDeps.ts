/**
 * Composition root for the scheduler tick and for "trigger now", which
 * runs a firing through the same deps.
 *
 * Wires runSchedulerTick's abstract deps to Prisma + the scheduled-task
 * executor. The claim is a compare-and-set on {id, nextRunAt}: whichever
 * replica advances the schedule first owns the firing; the loser's
 * updateMany counts 0 and skips. 'once' schedules complete on claim
 * (nextRunAt=null, status=completed when that scheduled run finishes).
 *
 * Every execution row leaves 'running' through finishScheduledExecution,
 * a compare-and-set on that status, so a cancel and a completion (or a
 * worker and a reaper) can never both count the run.
 *
 * The reaper closes rows a dead worker left 'running'. A row is lost
 * once it is older than its task's timeout plus a grace period; a live
 * worker would have aborted and finished it by then. That only holds
 * because startedAt is the moment the attempt began (runTaskFiring's
 * clock), never the time of the tick that queued it. A workflow_run row
 * waits for the longest a workflow may run instead, because its worker
 * (and that worker's own reaper) normally finishes it.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import {
  executeScheduledTask,
  type ExecuteScheduledTaskDeps,
} from "./executeScheduledTask.js";
import {
  finishScheduledExecution,
  type FinishScheduledExecutionPrisma,
} from "./finishScheduledExecution.js";
import type { DueTaskRow, SchedulerTickDeps } from "./runSchedulerTick.js";
import { getTaskType } from "./scheduledTaskTypes.js";
import { nextRun } from "./scheduleCalc.js";

const DEFAULT_BATCH_LIMIT = 20;
const REAP_BATCH_LIMIT = 50;
/** How far past its timeout a running row must be before it is called lost. */
export const LOST_EXECUTION_GRACE_MS = 120_000;
/** The shortest timeout a task may have (routes/scheduler.ts). */
const MIN_TASK_TIMEOUT_MS = 5_000;
/** The longest a workflow run may take (workflowDefinition.ts). */
const MAX_WORKFLOW_TIMEOUT_MS = 3_600_000;
export const LOST_EXECUTION_ERROR =
  "run lost: the worker stopped before this execution finished";
/** Errors travel in a webhook payload; a stack-sized message does not belong there. */
const EVENT_ERROR_MAX = 2000;

interface ScheduledTaskDelegateStub {
  findMany: (args: {
    where: {
      isEnabled: true;
      status: "active";
      nextRunAt: { not: null; lte: Date };
    };
    orderBy: { nextRunAt: "asc" };
    take: number;
  }) => Promise<
    Array<{
      id: string;
      orgId: string;
      agentId: string | null;
      orchestrationId: string | null;
      name: string;
      taskType: string;
      payload: unknown;
      timeout: number;
      maxRetries: number;
      scheduleType: string;
      cronExpression: string | null;
      intervalSeconds: number | null;
      scheduledAt: Date | null;
      timezone: string;
      nextRunAt: Date | null;
    }>
  >;
  updateMany: (args: {
    where: { id: string; nextRunAt: Date };
    data: { nextRunAt: Date | null; status?: string; lastError?: string };
  }) => Promise<{ count: number }>;
}

interface TaskExecutionDelegateStub {
  create: (args: {
    data: {
      taskId: string;
      status: "running";
      input: Prisma.InputJsonValue;
      triggeredBy: string;
      attempt: number;
      startedAt: Date;
    };
    select: { id: true };
  }) => Promise<{ id: string }>;
  findFirst: (args: {
    where: { id: string };
    select: { status: true };
  }) => Promise<{ status: string } | null>;
  findMany: (args: {
    where: { status: "running"; startedAt: { lt: Date } };
    orderBy: { startedAt: "asc" };
    take: number;
    select: {
      id: true;
      startedAt: true;
      task: { select: { timeout: true; taskType: true } };
    };
  }) => Promise<
    Array<{
      id: string;
      startedAt: Date | null;
      task: { timeout: number; taskType: string };
    }>
  >;
}

export interface SchedulerPrismaStub {
  scheduledTask: ScheduledTaskDelegateStub & FinishScheduledExecutionPrisma["scheduledTask"];
  taskExecution: TaskExecutionDelegateStub & FinishScheduledExecutionPrisma["taskExecution"];
}

type SchedulerPrismaSurface =
  | Pick<PrismaClient, "scheduledTask" | "taskExecution">
  | SchedulerPrismaStub;

type _FindArgsCheck = Parameters<
  ScheduledTaskDelegateStub["findMany"]
>[0] extends Prisma.ScheduledTaskFindManyArgs
  ? true
  : never;
type _UpdateArgsCheck = Parameters<
  ScheduledTaskDelegateStub["updateMany"]
>[0] extends Prisma.ScheduledTaskUpdateManyArgs
  ? true
  : never;
type _CreateArgsCheck = Parameters<
  TaskExecutionDelegateStub["create"]
>[0] extends Prisma.TaskExecutionCreateArgs
  ? true
  : never;
type _StatusArgsCheck = Parameters<
  TaskExecutionDelegateStub["findFirst"]
>[0] extends Prisma.TaskExecutionFindFirstArgs
  ? true
  : never;
type _ReapArgsCheck = Parameters<
  TaskExecutionDelegateStub["findMany"]
>[0] extends Prisma.TaskExecutionFindManyArgs
  ? true
  : never;
const _argsCheck: [
  _FindArgsCheck,
  _UpdateArgsCheck,
  _CreateArgsCheck,
  _StatusArgsCheck,
  _ReapArgsCheck,
] = [true, true, true, true, true];
void _argsCheck;

export interface BuildSchedulerTickDepsInput {
  prisma: SchedulerPrismaSurface;
  executorDeps: ExecuteScheduledTaskDeps;
  batchLimit?: number;
  /** Signed outbound webhook events; absent in tests that do not care. */
  emitEvent?: (
    orgId: string,
    type: "scheduled_task.failed",
    data: Record<string, unknown>,
  ) => Promise<void>;
  cancelPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => Date;
}

/** The retries a task type is allowed; a type that is not retried gets none. */
export function effectiveMaxRetries(taskType: string, maxRetries: number): number {
  return getTaskType(taskType)?.retryable ? Math.max(0, maxRetries) : 0;
}

export function buildSchedulerTickDeps(
  input: BuildSchedulerTickDepsInput,
): SchedulerTickDeps {
  const prisma = input.prisma as SchedulerPrismaStub;
  const batchLimit = input.batchLimit ?? DEFAULT_BATCH_LIMIT;

  return {
    reapLostExecutions: async (now) => {
      // The index on (status, startedAt) serves this; the per-task
      // timeout is applied in memory because it lives on the task.
      const candidates = await prisma.taskExecution.findMany({
        where: {
          status: "running",
          startedAt: { lt: new Date(now.getTime() - MIN_TASK_TIMEOUT_MS - LOST_EXECUTION_GRACE_MS) },
        },
        orderBy: { startedAt: "asc" },
        take: REAP_BATCH_LIMIT,
        select: {
          id: true,
          startedAt: true,
          task: { select: { timeout: true, taskType: true } },
        },
      });
      let reaped = 0;
      for (const row of candidates) {
        if (!row.startedAt) continue;
        const budget = getTaskType(row.task.taskType)?.deferred
          ? MAX_WORKFLOW_TIMEOUT_MS
          : row.task.timeout;
        const age = now.getTime() - row.startedAt.getTime();
        if (age <= budget + LOST_EXECUTION_GRACE_MS) continue;
        const closed = await finishScheduledExecution(
          prisma,
          row.id,
          { status: "failed", durationMs: age, error: LOST_EXECUTION_ERROR },
          now,
        );
        if (closed) reaped += 1;
      }
      return reaped;
    },

    loadDueTasks: async ({ now }) => {
      const rows = await prisma.scheduledTask.findMany({
        where: {
          isEnabled: true,
          status: "active",
          nextRunAt: { not: null, lte: now },
        },
        orderBy: { nextRunAt: "asc" },
        take: batchLimit,
      });
      return rows
        .filter((r): r is typeof r & { nextRunAt: Date } => r.nextRunAt !== null)
        .map(
          (r): DueTaskRow => ({
            id: r.id,
            orgId: r.orgId,
            agentId: r.agentId,
            orchestrationId: r.orchestrationId,
            name: r.name,
            taskType: r.taskType,
            payload: r.payload,
            timeout: r.timeout,
            maxRetries: effectiveMaxRetries(r.taskType, r.maxRetries),
            scheduleType: r.scheduleType,
            cronExpression: r.cronExpression,
            intervalSeconds: r.intervalSeconds,
            scheduledAt: r.scheduledAt,
            timezone: r.timezone,
            nextRunAt: r.nextRunAt,
          }),
        );
    },

    claimTask: async (task, now) => {
      if (task.scheduleType === "once") {
        const { count } = await prisma.scheduledTask.updateMany({
          // CAS on the exact due time this tick loaded — a replica that
          // already advanced it makes this a count=0 no-op.
          where: { id: task.id, nextRunAt: task.nextRunAt },
          data: { nextRunAt: null },
        });
        return count > 0;
      }

      const nextRunAt = nextRun(task, now);
      if (!nextRunAt) {
        // A recurring schedule with no next run was saved before
        // schedules were validated (a cron expression the old parser
        // guessed at). It is stopped and says why, instead of firing at
        // a time nobody chose or sitting 'active' and never firing.
        await prisma.scheduledTask.updateMany({
          where: { id: task.id, nextRunAt: task.nextRunAt },
          data: {
            nextRunAt: null,
            status: "failed",
            lastError:
              "this task's schedule is not valid and was stopped; edit the schedule to restart it",
          },
        });
        return false;
      }
      const { count } = await prisma.scheduledTask.updateMany({
        where: { id: task.id, nextRunAt: task.nextRunAt },
        data: { nextRunAt },
      });
      return count > 0;
    },

    createExecution: async (task, { now, attempt, triggeredBy }) =>
      prisma.taskExecution.create({
        data: {
          taskId: task.id,
          status: "running",
          input: (task.payload ?? {}) as Prisma.InputJsonValue,
          triggeredBy,
          attempt,
          startedAt: now,
        },
        select: { id: true },
      }),

    executeTask: (task, ctx) => executeScheduledTask(task, input.executorDeps, ctx),

    finishExecution: (executionId, _task, outcome) =>
      finishScheduledExecution(prisma, executionId, outcome),

    isExecutionCancelled: async (executionId) => {
      const row = await prisma.taskExecution.findFirst({
        where: { id: executionId },
        select: { status: true },
      });
      // A row that vanished (its task was deleted) is as good as cancelled.
      return row === null || row.status === "cancelled";
    },

    notifyFailure: async (task, failure) => {
      await input.emitEvent?.(task.orgId, "scheduled_task.failed", {
        taskId: task.id,
        taskName: task.name,
        taskType: task.taskType,
        executionId: failure.executionId,
        attempts: failure.attempts,
        triggeredBy: failure.triggeredBy,
        error: failure.error.slice(0, EVENT_ERROR_MAX),
      });
    },

    sleep: input.sleep,
    clock: input.clock,
    cancelPollMs: input.cancelPollMs,
  };
}
