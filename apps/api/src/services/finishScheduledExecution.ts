/**
 * Finishes one scheduled-task execution: the single place a TaskExecution
 * leaves 'running'.
 *
 * Shared by everything that can end an execution (the scheduler tick,
 * "trigger now", a cancel, the workflow worker and its reaper), so they
 * agree on one thing: the execution row changes through a
 * compare-and-set on status 'running', and only the caller that wins it
 * touches the task's rolling statistics. Two finishers racing (a worker
 * and the reaper, a cancel and a completion) therefore count one run,
 * not two.
 *
 * A failed attempt that will be retried (`retryAt`) closes its own row
 * and stops there. The firing is not over, so the task's counters and
 * last-run fields are written once, by the final attempt.
 *
 * A one-off ('once') task is complete when its SCHEDULED firing ends.
 * Which firing this was is read from the execution row itself
 * (triggeredBy), not passed in, so every finisher agrees. A "Run now" on
 * a one-off task that is still waiting for its time (or a cancel of that
 * manual run) leaves the task active: marking it completed would take it
 * out of the due query and its scheduled firing would silently never
 * happen.
 *
 * Runs over a structural Prisma surface so it can be driven by a fake.
 */

export interface ScheduledExecutionOutcome {
  status: "success" | "failed" | "cancelled";
  durationMs: number;
  /** Stored on success, and on a failure that still produced something. */
  output?: unknown;
  error?: string;
  /** This failed attempt is followed by another at about this time. */
  retryAt?: Date;
}

export interface FinishScheduledExecutionPrisma {
  taskExecution: {
    findUnique: (args: {
      where: { id: string };
      select: {
        taskId: true;
        triggeredBy: true;
        task: { select: { scheduleType: true } };
      };
    }) => Promise<{
      taskId: string;
      triggeredBy: string;
      task: { scheduleType: string };
    } | null>;
    updateMany: (args: {
      where: { id: string; status: "running" };
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
  scheduledTask: {
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<unknown>;
  };
}

/** triggeredBy of an execution started by "Run now" (FiringTrigger). */
const MANUAL_TRIGGER = "manual";

/** Returns false when the execution was not 'running' (already finished). */
export async function finishScheduledExecution(
  prisma: FinishScheduledExecutionPrisma,
  executionId: string,
  outcome: ScheduledExecutionOutcome,
  now: Date = new Date(),
): Promise<boolean> {
  const execution = await prisma.taskExecution.findUnique({
    where: { id: executionId },
    select: { taskId: true, triggeredBy: true, task: { select: { scheduleType: true } } },
  });
  if (!execution) return false;

  const { count } = await prisma.taskExecution.updateMany({
    where: { id: executionId, status: "running" },
    data: {
      status: outcome.status,
      completedAt: now,
      durationMs: outcome.durationMs,
      ...(outcome.output === undefined || outcome.output === null
        ? {}
        : { output: outcome.output }),
      ...(outcome.status === "success" ? {} : { error: outcome.error ?? null }),
      ...(outcome.retryAt ? { nextRetryAt: outcome.retryAt } : {}),
    },
  });
  if (count === 0) return false;
  if (outcome.retryAt) return true;

  await prisma.scheduledTask.update({
    where: { id: execution.taskId },
    data: {
      lastRunAt: now,
      lastRunStatus: outcome.status,
      lastRunDurationMs: outcome.durationMs,
      lastError: outcome.status === "failed" ? (outcome.error ?? null) : null,
      // A cancelled run fired but is neither a success nor a failure.
      ...(outcome.status === "cancelled"
        ? {}
        : {
            totalRuns: { increment: 1 },
            ...(outcome.status === "success"
              ? { successfulRuns: { increment: 1 } }
              : { failedRuns: { increment: 1 } }),
          }),
      // A 'once' schedule is complete when the firing its schedule made
      // ends (the claim already cleared nextRunAt). A manual run is not
      // that firing and leaves the schedule as it was.
      ...(execution.task.scheduleType === "once" && execution.triggeredBy !== MANUAL_TRIGGER
        ? { status: "completed" }
        : {}),
    },
  });
  return true;
}
