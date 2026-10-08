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
 *
 * After a run is closed as success, notifySuccess does three things in
 * this order, each on its own so a failure in one does not stop the next:
 *   1. emits scheduled_task.completed to the organization's webhooks (every
 *      task type);
 *   2. sends the result to the place the task names (agent_run and inference
 *      only; resultDelivery.ts decides, so a report is never sent twice);
 *   3. writes how that went to TaskExecution.delivery, when anything was
 *      tried, by a write that sets that one column.
 * None of it can change the run: the tick has already recorded it.
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
import { answerTextOf } from "./agentOwnSchedule.js";
import { getTaskType } from "./scheduledTaskTypes.js";
import {
  deliverResult,
  type DeliveryRecord,
  type ResultDeliveryDeps,
} from "./scheduledTasks/resultDelivery.js";
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
/** The same cut workflow.completed makes (runWorkflowExecutionJob.ts). */
const EVENT_OUTPUT_PREVIEW_CHARS = 2_000;

/**
 * The start of what a finished run produced, for the webhook event: the
 * answer text of an agent run; for a type that has no answer text (a
 * webhook's status, a sync's counts) the stored output as JSON, which is
 * what workflow.completed carries. Cut the way that event cuts it.
 */
export function outputPreviewOf(output: unknown): string {
  const text =
    answerTextOf(output) ??
    (output === undefined || output === null ? "" : (JSON.stringify(output) ?? ""));
  return text.length > EVENT_OUTPUT_PREVIEW_CHARS
    ? `${text.slice(0, EVENT_OUTPUT_PREVIEW_CHARS)}...`
    : text;
}

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

/**
 * The one write the delivery step makes: the delivery column of one
 * execution, and nothing else on the row. Its own surface, so the tick's
 * Prisma stub stays what it was for callers that deliver nothing.
 */
export interface DeliveryRecordPrisma {
  taskExecution: {
    update: (args: {
      where: { id: string };
      data: { delivery: Prisma.InputJsonValue };
      select: { id: true };
    }) => Promise<unknown>;
  };
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
type _DeliveryArgsCheck = Parameters<
  DeliveryRecordPrisma["taskExecution"]["update"]
>[0] extends Prisma.TaskExecutionUpdateArgs
  ? true
  : never;
const _argsCheck: [
  _FindArgsCheck,
  _UpdateArgsCheck,
  _CreateArgsCheck,
  _StatusArgsCheck,
  _ReapArgsCheck,
  _DeliveryArgsCheck,
] = [true, true, true, true, true, true];
void _argsCheck;

export interface BuildSchedulerTickDepsInput {
  prisma: SchedulerPrismaSurface;
  executorDeps: ExecuteScheduledTaskDeps;
  batchLimit?: number;
  /** Signed outbound webhook events; absent in tests that do not care. */
  emitEvent?: (
    orgId: string,
    type: SchedulerEventType,
    data: Record<string, unknown>,
  ) => Promise<void>;
  /**
   * How a finished agent run's result reaches the place its task names
   * (buildResultDeliveryDeps() in production). Absent: results are stored
   * and nothing is sent, which is what a test that does not care gets.
   */
  resultDelivery?: ResultDeliveryDeps | (() => ResultDeliveryDeps);
  /** Where the delivery outcome is written; defaults to `prisma`. */
  deliveryStore?: DeliveryRecordPrisma;
  cancelPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => Date;
}

export type SchedulerEventType = "scheduled_task.failed" | "scheduled_task.completed";

/** The retries a task type is allowed; a type that is not retried gets none. */
export function effectiveMaxRetries(taskType: string, maxRetries: number): number {
  return getTaskType(taskType)?.retryable ? Math.max(0, maxRetries) : 0;
}

export function buildSchedulerTickDeps(
  input: BuildSchedulerTickDepsInput,
): SchedulerTickDeps {
  const prisma = input.prisma as SchedulerPrismaStub;
  const batchLimit = input.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const deliveryStore = input.deliveryStore ?? (input.prisma as unknown as DeliveryRecordPrisma);
  // Built on first use, once: a tick whose tasks deliver nothing opens nothing.
  let deliveryDeps: ResultDeliveryDeps | null = null;
  const resultDelivery = (): ResultDeliveryDeps | null => {
    if (!input.resultDelivery) return null;
    return (deliveryDeps ??=
      typeof input.resultDelivery === "function" ? input.resultDelivery() : input.resultDelivery);
  };

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

    notifySuccess: async (task, success) => {
      // 1. The event, for every task type.
      try {
        await input.emitEvent?.(task.orgId, "scheduled_task.completed", {
          taskId: task.id,
          taskName: task.name,
          taskType: task.taskType,
          agentId: task.agentId,
          executionId: success.executionId,
          attempts: success.attempts,
          triggeredBy: success.triggeredBy,
          durationMs: success.durationMs,
          outputPreview: outputPreviewOf(success.output),
        });
      } catch {
        // An organization's webhooks being unreachable is not a reason to
        // keep the result from the place its owner chose.
      }

      // 2. The result, to the place the task names. deliverResult answers
      // [] without calling anything for a task that names none or is not an
      // agent run, and does not throw for a delivery that failed.
      let records: DeliveryRecord[] = [];
      try {
        const deps = resultDelivery();
        if (deps) {
          records = await deliverResult(deps, {
            orgId: task.orgId,
            task: { name: task.name, taskType: task.taskType, payload: task.payload },
            execution: { id: success.executionId, finishedAt: success.finishedAt },
            text: answerTextOf(success.output) ?? "",
          });
        }
      } catch {
        records = [];
      }

      // 3. How it went. Only the delivery column: the row's status, output
      // and times are the finish's, and stay as it wrote them.
      if (records.length === 0) return;
      try {
        await deliveryStore.taskExecution.update({
          where: { id: success.executionId },
          data: { delivery: records as unknown as Prisma.InputJsonValue },
          select: { id: true },
        });
      } catch {
        // The result was sent (or not) either way; the run is unchanged.
      }
    },

    sleep: input.sleep,
    clock: input.clock,
    cancelPollMs: input.cancelPollMs,
  };
}
