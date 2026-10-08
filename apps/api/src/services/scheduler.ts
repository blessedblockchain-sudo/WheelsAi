/**
 * Scheduled-task service: tasks, their executions and "trigger now",
 * every query scoped to the caller's organization.
 *
 * A task is checked when it is saved, not when it first fires: its type
 * and payload against the task-type registry, every id it points at
 * against the organization, and its schedule against scheduleCalc. A task
 * that cannot run is a 400 naming the field.
 *
 * Expected failures are SchedulerErrors, which carry the status and code
 * the API contract names. Anything else is left to propagate so it is
 * logged and answered as a 500.
 */

import { Prisma, prisma } from "@wheelsai/db";

import { env } from "../config/env.js";
import { buildSchedulerTickDeps, effectiveMaxRetries } from "./buildSchedulerTickDeps.js";
import { finishScheduledExecution } from "./finishScheduledExecution.js";
import { runTaskFiring, type DueTaskRow, type TaskFiringDeps } from "./runSchedulerTick.js";
import { buildSchedulerExecutorDeps } from "./scheduledTaskExecutorProduction.js";
import { buildResultDeliveryDeps } from "./scheduledTasks/buildResultDeliveryDeps.js";
import { productionTaskTypeCapabilities } from "./scheduledTasks/buildScheduledTaskTypeDeps.js";
import {
  taskTypeCatalogue,
  validateTask,
  type TaskCandidate,
  type TaskOwnershipLoader,
  type TaskRefusal,
} from "./scheduledTaskTypes.js";
import { nextRun } from "./scheduleCalc.js";
import { triggerWebhook } from "./webhooks.js";

// ============================================
// Errors
// ============================================

export type SchedulerErrorCode =
  | "not_found"
  | "validation_failed"
  | "invalid_task"
  | "invalid_schedule"
  | "not_cancellable"
  | "already_running";

/**
 * An expected scheduler failure, with the status and code the API
 * contract names. Anything else a function here throws is unexpected and
 * is answered as a logged 500 by the global handler.
 */
export class SchedulerError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: SchedulerErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SchedulerError";
  }
}

const taskNotFound = () => new SchedulerError(404, "not_found", "Task not found");

function refused(refusal: TaskRefusal): SchedulerError {
  if (refusal.error === "validation_failed") {
    return new SchedulerError(400, "validation_failed", refusal.message, {
      details: refusal.details,
    });
  }
  if (refusal.error === "invalid_schedule") {
    return new SchedulerError(400, "invalid_schedule", refusal.message, {
      reason: refusal.reason,
      field: refusal.field,
    });
  }
  return new SchedulerError(400, "invalid_task", refusal.message, { field: refusal.field });
}

/** Lookups for what a task points at, each limited to one organization. */
function ownershipLoader(orgId: string): TaskOwnershipLoader {
  const byId = (id: string) => ({ where: { id, orgId }, select: { id: true } as const });
  return {
    agent: (id) =>
      prisma.agent.findFirst({ where: { id, orgId }, select: { knowledgeBaseId: true } }),
    orchestration: (id) => prisma.orchestration.findFirst(byId(id)),
    knowledgeBase: (id) => prisma.knowledgeBase.findFirst(byId(id)),
    deployment: (id) => prisma.deployment.findFirst(byId(id)),
    monitor: (id) => prisma.uptimeMonitor.findFirst(byId(id)),
    alertChannel: (id) =>
      prisma.alertChannel.findFirst({ where: { id, orgId }, select: { type: true } }),
  };
}

async function checkTask(orgId: string, candidate: TaskCandidate, checkSchedule: boolean) {
  const verdict = await validateTask(candidate, {
    now: new Date(),
    capabilities: productionTaskTypeCapabilities(),
    owns: ownershipLoader(orgId),
    checkSchedule,
  });
  if (!verdict.ok) throw refused(verdict.refusal);
  return verdict;
}

/**
 * Kept for callers that still compute a next run from loose fields;
 * scheduleCalc.ts is the implementation (all five cron fields, the
 * task's time zone). Null when there is no next run.
 */
export function calculateNextRun(
  scheduleType: string,
  cronExpression?: string | null,
  intervalSeconds?: number | null,
  scheduledAt?: Date | null,
  timezone: string = "UTC",
): Date | null {
  return nextRun(
    { scheduleType, cronExpression, intervalSeconds, scheduledAt, timezone },
    new Date(),
  );
}

// ============================================
// Task types
// ============================================

/** Whether a worker in this deployment fires schedules at all. */
function schedulerState() {
  return {
    schedulerEnabled: env.SCHEDULER_INTERVAL_MS > 0,
    intervalMs: env.SCHEDULER_INTERVAL_MS,
  };
}

/**
 * Every task type with its form fields and whether it can run on this
 * server (and why not). Also says whether schedules fire here at all, so
 * the dashboard never shows a "next run" nothing will act on unremarked.
 */
export function getTaskTypes() {
  return {
    ...schedulerState(),
    taskTypes: taskTypeCatalogue(productionTaskTypeCapabilities()),
  };
}

// ============================================
// CRUD
// ============================================

export interface ScheduledTaskInput {
  name: string;
  description?: string;
  taskType: string;
  agentId?: string | null;
  orchestrationId?: string | null;
  scheduleType: string;
  cronExpression?: string;
  intervalSeconds?: number;
  scheduledAt?: string;
  timezone?: string;
  payload?: Record<string, unknown>;
  timeout?: number;
  maxRetries?: number;
}

export async function createScheduledTask(orgId: string, input: ScheduledTaskInput) {
  const verdict = await checkTask(orgId, input, true);
  const schedule = verdict.schedule!;

  return prisma.scheduledTask.create({
    data: {
      orgId,
      agentId: input.agentId ?? null,
      orchestrationId: input.orchestrationId ?? null,
      name: input.name,
      description: input.description,
      scheduleType: input.scheduleType,
      cronExpression: input.cronExpression,
      intervalSeconds: input.intervalSeconds,
      scheduledAt: schedule.scheduledAt,
      timezone: schedule.timezone,
      taskType: input.taskType,
      payload: verdict.payload as Prisma.InputJsonValue,
      timeout: input.timeout ?? 300000,
      maxRetries: verdict.maxRetries,
      nextRunAt: schedule.nextRunAt,
    },
  });
}

export async function getScheduledTasks(orgId: string, options: {
  agentId?: string; orchestrationId?: string; taskType?: string; status?: string;
  isEnabled?: boolean; limit?: number; offset?: number;
} = {}) {
  const { agentId, orchestrationId, taskType, status, isEnabled, limit = 20, offset = 0 } = options;
  const where: Prisma.ScheduledTaskWhereInput = { orgId };
  if (agentId) where.agentId = agentId;
  if (orchestrationId) where.orchestrationId = orchestrationId;
  if (taskType) where.taskType = taskType;
  if (status) where.status = status;
  if (isEnabled !== undefined) where.isEnabled = isEnabled;

  const [tasks, total] = await Promise.all([
    prisma.scheduledTask.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
    prisma.scheduledTask.count({ where }),
  ]);
  return { tasks, total };
}

export async function getScheduledTask(id: string, orgId: string) {
  const task = await prisma.scheduledTask.findFirst({
    where: { id, orgId },
    include: { executions: { orderBy: { createdAt: "desc" }, take: 10 } },
  });
  if (!task) throw taskNotFound();
  return task;
}

export type ScheduledTaskPatch = Partial<Omit<ScheduledTaskInput, "description">> & {
  description?: string;
  isEnabled?: boolean;
};

const SCHEDULE_FIELDS = [
  "scheduleType",
  "cronExpression",
  "intervalSeconds",
  "scheduledAt",
  "timezone",
] as const;
const DEFINITION_FIELDS = ["taskType", "payload", "agentId", "orchestrationId", "maxRetries"] as const;

export async function updateScheduledTask(id: string, orgId: string, updates: ScheduledTaskPatch) {
  const task = await prisma.scheduledTask.findFirst({ where: { id, orgId } });
  if (!task) throw taskNotFound();

  const scheduleChanged = SCHEDULE_FIELDS.some((field) => updates[field] !== undefined);
  const definitionChanged = DEFINITION_FIELDS.some((field) => updates[field] !== undefined);

  const data: Prisma.ScheduledTaskUncheckedUpdateInput = {};
  if (updates.name !== undefined) data.name = updates.name;
  if (updates.description !== undefined) data.description = updates.description;
  if (updates.timeout !== undefined) data.timeout = updates.timeout;
  if (updates.agentId !== undefined) data.agentId = updates.agentId;
  if (updates.orchestrationId !== undefined) data.orchestrationId = updates.orchestrationId;
  if (updates.taskType !== undefined) data.taskType = updates.taskType;
  if (updates.scheduleType !== undefined) data.scheduleType = updates.scheduleType;
  if (updates.cronExpression !== undefined) data.cronExpression = updates.cronExpression;
  if (updates.intervalSeconds !== undefined) data.intervalSeconds = updates.intervalSeconds;

  const isEnabled = updates.isEnabled ?? task.isEnabled;
  if (updates.isEnabled !== undefined) {
    data.isEnabled = updates.isEnabled;
    if (!updates.isEnabled) data.status = "paused";
    else if (task.status === "paused") data.status = "active";
  }

  // The merged task is what would be stored, so it is what gets checked:
  // a PATCH cannot produce a task its type could not have been created
  // as. An edit that touches neither the definition nor the schedule
  // (a rename) is not held up by rules added after the task was saved.
  if (scheduleChanged || definitionChanged) {
    const taskType = updates.taskType ?? task.taskType;
    const verdict = await checkTask(
      orgId,
      {
        taskType,
        agentId: updates.agentId !== undefined ? updates.agentId : task.agentId,
        orchestrationId:
          updates.orchestrationId !== undefined ? updates.orchestrationId : task.orchestrationId,
        payload: updates.payload ?? task.payload,
        // A type that is not retried takes 0 unless the caller says
        // otherwise (and is then told why it cannot).
        maxRetries:
          updates.maxRetries ??
          (updates.taskType !== undefined
            ? effectiveMaxRetries(taskType, task.maxRetries)
            : task.maxRetries),
        scheduleType: updates.scheduleType ?? task.scheduleType,
        cronExpression: updates.cronExpression ?? task.cronExpression,
        intervalSeconds: updates.intervalSeconds ?? task.intervalSeconds,
        scheduledAt: updates.scheduledAt ?? task.scheduledAt,
        timezone: updates.timezone ?? task.timezone,
      },
      scheduleChanged,
    );
    if (definitionChanged) {
      data.payload = verdict.payload as Prisma.InputJsonValue;
      data.maxRetries = verdict.maxRetries;
    }
    if (verdict.schedule) {
      data.timezone = verdict.schedule.timezone;
      data.nextRunAt = verdict.schedule.nextRunAt;
      if (verdict.schedule.scheduledAt) data.scheduledAt = verdict.schedule.scheduledAt;
      // A new, valid schedule restarts a task that had finished its
      // one-off run or was stopped for an unreadable schedule.
      data.status = isEnabled ? "active" : "paused";
    }
  }

  return prisma.scheduledTask.update({ where: { id }, data });
}

export async function deleteScheduledTask(id: string, orgId: string) {
  const task = await prisma.scheduledTask.findFirst({ where: { id, orgId } });
  if (!task) throw taskNotFound();
  await prisma.scheduledTask.delete({ where: { id } });
  return { success: true };
}

export async function toggleScheduledTask(id: string, orgId: string, isEnabled: boolean) {
  const task = await prisma.scheduledTask.findFirst({ where: { id, orgId } });
  if (!task) throw taskNotFound();
  if (!isEnabled) {
    return prisma.scheduledTask.update({
      where: { id },
      data: { isEnabled: false, status: "paused" },
    });
  }

  // Enabling a task that has no next run (its one-off time passed, or
  // its schedule was stopped as unreadable) would show it active while
  // nothing ever fires it.
  const nextRunAt = task.nextRunAt ?? nextRun(task, new Date());
  if (!nextRunAt) {
    throw new SchedulerError(
      400,
      "invalid_schedule",
      "this task has no future run; edit its schedule to enable it",
      { reason: "no_next_run", field: "scheduleType" },
    );
  }
  return prisma.scheduledTask.update({
    where: { id },
    data: { isEnabled: true, status: "active", nextRunAt },
  });
}

// ============================================
// Run now, executions, cancel
// ============================================

function firingDeps() {
  return buildSchedulerTickDeps({
    prisma,
    executorDeps: buildSchedulerExecutorDeps(),
    emitEvent: async (eventOrgId, type, data) => {
      await triggerWebhook(eventOrgId, type, data);
    },
    // A "Run now" that succeeds is delivered like a scheduled run.
    resultDelivery: buildResultDeliveryDeps,
  });
}

/**
 * Runs the task once, now, through the same firing the scheduler worker
 * uses: the same executor, the same abortable timeout, the same
 * compare-and-set finish. It does not touch the schedule: nextRunAt and
 * status stay as they were, so a one-off task tested ahead of its time
 * still fires at that time.
 *
 * Synchronous types finish inside the call (bounded by the task's
 * timeout) and `deferred` is false. A workflow_run only starts its run:
 * the execution comes back still 'running' with `deferred` true, and the
 * workflow worker finishes it.
 *
 * A manual run is not retried; the person who asked is looking at the
 * result and can ask again.
 */
export async function triggerTask(
  id: string,
  orgId: string,
  /** The firing's dependencies; replaced in tests. */
  buildFiringDeps: () => TaskFiringDeps = firingDeps,
) {
  // Two requests that arrive together must not both read "none running" and
  // both run (and both charge). The task's row is locked first, so the read
  // and the creation of the execution row are one step per task: the second
  // request waits for the first and then sees its row.
  const { task, executionId } = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "scheduled_tasks"
      WHERE "id" = ${id}::uuid AND "org_id" = ${orgId}::uuid
      FOR UPDATE`);
    if (locked.length === 0) throw taskNotFound();
    const task = await tx.scheduledTask.findFirst({ where: { id, orgId } });
    if (!task) throw taskNotFound();

    const running = await tx.taskExecution.findFirst({
      where: { taskId: id, status: "running" },
      select: { id: true },
    });
    if (running) {
      throw new SchedulerError(
        409,
        "already_running",
        "This task is already running; wait for it to finish or cancel that execution",
        { executionId: running.id },
      );
    }
    // The row the firing would make for its first attempt
    // (buildSchedulerTickDeps, createExecution), made here under the lock.
    const execution = await tx.taskExecution.create({
      data: {
        taskId: task.id,
        status: "running",
        input: (task.payload ?? {}) as Prisma.InputJsonValue,
        triggeredBy: "manual",
        attempt: 1,
        startedAt: new Date(),
      },
      select: { id: true },
    });
    return { task, executionId: execution.id };
  });

  const row: DueTaskRow = {
    id: task.id,
    orgId: task.orgId,
    agentId: task.agentId,
    orchestrationId: task.orchestrationId,
    name: task.name,
    taskType: task.taskType,
    payload: task.payload,
    timeout: task.timeout,
    maxRetries: 0,
    scheduleType: task.scheduleType,
    cronExpression: task.cronExpression,
    intervalSeconds: task.intervalSeconds,
    scheduledAt: task.scheduledAt,
    timezone: task.timezone,
    nextRunAt: task.nextRunAt ?? new Date(),
  };
  const firing = await runTaskFiring(
    row,
    { triggeredBy: "manual", maxRetries: 0 },
    // A manual run has one attempt, and its row exists already.
    { ...buildFiringDeps(), createExecution: async () => ({ id: executionId }) },
  );
  if (!firing.executionId) {
    throw new Error(`could not record the execution: ${firing.error ?? "unknown error"}`);
  }

  const execution = await prisma.taskExecution.findFirst({
    where: { id: firing.executionId, taskId: id },
  });
  if (!execution) throw new SchedulerError(404, "not_found", "Execution not found");
  return { execution, deferred: firing.status === "deferred" };
}

export async function getTaskExecutions(taskId: string, orgId: string, options: {
  status?: string; limit?: number; offset?: number;
} = {}) {
  const task = await prisma.scheduledTask.findFirst({ where: { id: taskId, orgId } });
  if (!task) throw taskNotFound();
  const { status, limit = 20, offset = 0 } = options;
  const where: Prisma.TaskExecutionWhereInput = { taskId };
  if (status) where.status = status;
  const [executions, total] = await Promise.all([
    prisma.taskExecution.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
    prisma.taskExecution.count({ where }),
  ]);
  return { executions, total };
}

/**
 * Cancels an execution that has not finished.
 *
 * The row moves running → cancelled by compare-and-set, so a cancel never
 * rewrites a finished run. The worker running the task polls the row,
 * sees the change and aborts the in-flight call through the task's
 * signal; a row left 'running' by a worker that died is simply closed.
 *
 * A workflow_run execution is cancelled through its workflow run, whose
 * worker then finishes this row as cancelled too.
 */
export async function cancelExecution(executionId: string, taskId: string, orgId: string) {
  const task = await prisma.scheduledTask.findFirst({ where: { id: taskId, orgId } });
  if (!task) throw taskNotFound();
  // Constrain the execution to the verified task — checking only the task
  // lets a caller cancel another org's execution by id.
  const scope = { id: executionId, taskId };
  const execution = await prisma.taskExecution.findFirst({ where: scope });
  if (!execution) throw new SchedulerError(404, "not_found", "Execution not found");

  const notCancellable = (status: string) =>
    new SchedulerError(409, "not_cancellable", `This execution already ${status}`, { status });
  if (execution.status !== "running") throw notCancellable(execution.status);

  if (execution.orchestrationExecutionId && task.orchestrationId) {
    const { cancelExecution: cancelWorkflowRun } = await import("./orchestration.js");
    try {
      await cancelWorkflowRun(execution.orchestrationExecutionId, task.orchestrationId, orgId);
      // Queued: the run is cancelled and this row with it. Running: the
      // cancel is requested and the worker closes both shortly.
      return (await prisma.taskExecution.findFirst({ where: scope })) ?? execution;
    } catch (err) {
      // The run is already over (or gone) while this row still says
      // running: fall through and close the row itself.
      const code = (err as { code?: unknown }).code;
      if (code !== "execution_finished" && code !== "not_found") throw err;
    }
  }

  const now = new Date();
  const cancelled = await finishScheduledExecution(
    prisma,
    executionId,
    {
      status: "cancelled",
      durationMs: execution.startedAt ? now.getTime() - execution.startedAt.getTime() : 0,
      error: "cancelled",
    },
    now,
  );
  const current = (await prisma.taskExecution.findFirst({ where: scope })) ?? execution;
  if (!cancelled) throw notCancellable(current.status);
  return current;
}

export async function getSchedulerStats(orgId: string) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [totalTasks, activeTasks, pausedTasks, runsToday, successToday, failedToday, runningExecutions] = await Promise.all([
    prisma.scheduledTask.count({ where: { orgId } }),
    prisma.scheduledTask.count({ where: { orgId, isEnabled: true, status: "active" } }),
    prisma.scheduledTask.count({ where: { orgId, status: "paused" } }),
    prisma.taskExecution.count({ where: { task: { orgId }, createdAt: { gte: today } } }),
    prisma.taskExecution.count({ where: { task: { orgId }, createdAt: { gte: today }, status: "success" } }),
    prisma.taskExecution.count({ where: { task: { orgId }, createdAt: { gte: today }, status: "failed" } }),
    prisma.taskExecution.count({ where: { task: { orgId }, status: "running" } }),
  ]);

  const upcoming = await prisma.scheduledTask.findMany({
    where: { orgId, isEnabled: true, status: "active", nextRunAt: { gt: new Date() } },
    orderBy: { nextRunAt: "asc" }, take: 5,
    select: { id: true, name: true, nextRunAt: true },
  });

  return {
    // False when no worker fires schedules here: the upcoming runs below
    // are then times nothing will act on, and the dashboard says so.
    ...schedulerState(),
    totalTasks, activeTasks, pausedTasks, totalRunsToday: runsToday,
    successRateToday: runsToday > 0 ? (successToday / runsToday) * 100 : 0,
    failedRunsToday: failedToday,
    runningExecutions,
    upcomingRuns: upcoming.map(t => ({ taskId: t.id, taskName: t.name, nextRunAt: t.nextRunAt!.toISOString() })),
  };
}
