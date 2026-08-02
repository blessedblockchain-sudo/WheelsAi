/**
 * Composition root for the scheduler tick (Wave 1).
 *
 * Wires runSchedulerTick's abstract deps to Prisma + the scheduled-task
 * executor. The claim is a compare-and-set on {id, nextRunAt}: whichever
 * replica advances the schedule first owns the firing; the loser's
 * updateMany counts 0 and skips. 'once' schedules complete on claim
 * (nextRunAt=null, status=completed after the run finishes via stats).
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { calculateNextRun } from "./scheduler.js";
import {
  executeScheduledTask,
  type ExecuteScheduledTaskDeps,
} from "./executeScheduledTask.js";
import type {
  DueTaskRow,
  ExecutionOutcome,
  SchedulerTickDeps,
} from "./runSchedulerTick.js";

const DEFAULT_BATCH_LIMIT = 20;

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
      agentId: string;
      name: string;
      taskType: string;
      payload: unknown;
      timeout: number;
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
    data: { nextRunAt: Date | null; status?: string };
  }) => Promise<{ count: number }>;
  update: (args: {
    where: { id: string };
    data: Record<string, unknown>;
  }) => Promise<unknown>;
}

interface TaskExecutionDelegateStub {
  create: (args: {
    data: Record<string, unknown>;
    select: { id: true };
  }) => Promise<{ id: string }>;
  update: (args: {
    where: { id: string };
    data: Record<string, unknown>;
  }) => Promise<unknown>;
}

type SchedulerPrismaSurface =
  | Pick<PrismaClient, "scheduledTask" | "taskExecution" | "agent">
  | {
      scheduledTask: ScheduledTaskDelegateStub;
      taskExecution: TaskExecutionDelegateStub;
      agent: { findFirst: (args: unknown) => Promise<unknown> };
    };

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
const _argsCheck: [_FindArgsCheck, _UpdateArgsCheck] = [true, true];
void _argsCheck;

export interface BuildSchedulerTickDepsInput {
  prisma: SchedulerPrismaSurface;
  executorDeps: ExecuteScheduledTaskDeps;
  batchLimit?: number;
}

export function buildSchedulerTickDeps(
  input: BuildSchedulerTickDepsInput,
): SchedulerTickDeps {
  const prisma = input.prisma as {
    scheduledTask: ScheduledTaskDelegateStub;
    taskExecution: TaskExecutionDelegateStub;
  };
  const batchLimit = input.batchLimit ?? DEFAULT_BATCH_LIMIT;

  return {
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
        .map((r) => ({
          id: r.id,
          orgId: r.orgId,
          agentId: r.agentId,
          name: r.name,
          taskType: r.taskType,
          payload: r.payload,
          timeout: r.timeout,
          scheduleType: r.scheduleType,
          cronExpression: r.cronExpression,
          intervalSeconds: r.intervalSeconds,
          scheduledAt: r.scheduledAt,
          timezone: r.timezone,
          nextRunAt: r.nextRunAt,
        }));
    },

    claimTask: async (task) => {
      const nextRunAt =
        task.scheduleType === "once"
          ? null
          : calculateNextRun(
              task.scheduleType,
              task.cronExpression,
              task.intervalSeconds,
              task.scheduledAt,
              task.timezone,
            );
      const { count } = await prisma.scheduledTask.updateMany({
        // CAS on the exact due time this tick loaded — a replica that
        // already advanced it makes this a count=0 no-op.
        where: { id: task.id, nextRunAt: task.nextRunAt },
        data: { nextRunAt },
      });
      return count > 0;
    },

    createExecution: async (task, now) =>
      prisma.taskExecution.create({
        data: {
          taskId: task.id,
          status: "running",
          input: task.payload as never,
          triggeredBy: "schedule",
          startedAt: now,
        },
        select: { id: true },
      }),

    executeTask: (task) => executeScheduledTask(task, input.executorDeps),

    finishExecution: async (executionId, task, outcome) => {
      await prisma.taskExecution.update({
        where: { id: executionId },
        data: {
          status: outcome.status,
          completedAt: new Date(),
          durationMs: outcome.durationMs,
          ...(outcome.status === "success"
            ? { output: outcome.output as never }
            : { error: outcome.error }),
        },
      });
      await prisma.scheduledTask.update({
        where: { id: task.id },
        data: {
          lastRunAt: new Date(),
          lastRunStatus: outcome.status,
          lastRunDurationMs: outcome.durationMs,
          lastError: outcome.status === "failed" ? outcome.error : null,
          totalRuns: { increment: 1 },
          ...(outcome.status === "success"
            ? { successfulRuns: { increment: 1 } }
            : { failedRuns: { increment: 1 } }),
          // A finished 'once' schedule is complete (its claim already
          // nulled nextRunAt).
          ...(task.scheduleType === "once" ? { status: "completed" } : {}),
        },
      });
    },
  };
}
