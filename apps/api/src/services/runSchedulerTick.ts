/**
 * Scheduler tick — one call = one pass of the BullMQ scheduler worker.
 * Pure orchestration; every IO surface is dependency-injected.
 *
 * Before this worker existed nothing consumed `nextRunAt` — schedules
 * were definitions that never fired (and "trigger now" wrote fabricated
 * success rows on a timer, removed in W0-2).
 *
 * First, executions a dead worker left 'running' are closed
 * (reapLostExecutions), so a crash never leaves a run looking alive
 * forever.
 *
 * Flow per due task:
 *   1. claimTask — CAS on {id, nextRunAt: <the loaded value>} that
 *      advances nextRunAt to the next occurrence (or ends a 'once'
 *      schedule). count=0 → another replica claimed this firing; skip.
 *      Claim-BEFORE-execute means a crash mid-run loses at most one
 *      firing — it never double-fires or tight-loops a broken task.
 *   2. runTaskFiring — the firing itself, shared with "trigger now":
 *        a. createExecution (status=running, attempt n, startedAt = the
 *           moment the attempt starts; the tick's `now` is for the claim
 *           only)
 *        b. executeTask under the task's own AbortController. The signal
 *           aborts on the task's timeout and when the execution row is
 *           cancelled, so a timed-out or cancelled model call stops
 *           instead of running on unobserved (and billed).
 *        c. finishExecution, compare-and-set on 'running'.
 *      A failed attempt is retried up to the task's maxRetries, each
 *      attempt its own execution row numbered 1..n, with a backoff
 *      between them. Not retried: a failure the executor marks permanent
 *      (nothing configured, a bad payload, a check that ran and found the
 *      target down), a timeout (the firing already used its whole
 *      budget), and a cancel.
 *      A `deferred` result (a queued workflow run) is left 'running':
 *      the worker that owns the work finishes the row.
 *
 * Due tasks run through a bounded pool, so one slow task no longer holds
 * up every task behind it. Per-task isolation: a throw anywhere fails
 * THAT firing; the rest still run.
 */

import { failureOutput, isPermanentFailure } from "./scheduledTasks/taskError.js";

export interface DueTaskRow {
  id: string;
  orgId: string;
  agentId: string | null;
  /** The workflow a workflow_run task starts. */
  orchestrationId: string | null;
  name: string;
  taskType: string;
  payload: unknown;
  timeout: number;
  /** Retries after the first attempt; 0 for types that are not retried. */
  maxRetries: number;
  scheduleType: string;
  cronExpression: string | null;
  intervalSeconds: number | null;
  scheduledAt: Date | null;
  timezone: string;
  /** The due time this tick loaded — the CAS guard for the claim. */
  nextRunAt: Date;
}

export interface ExecutionOutcome {
  status: "success" | "failed";
  durationMs: number;
  /** On a failure: whatever the task produced before it failed. */
  output?: unknown;
  error?: string;
  /**
   * Set on a failed attempt that will be retried. The attempt's row is
   * closed, but the firing is not over: the task's run counters and
   * last-run fields wait for the final attempt.
   */
  retryAt?: Date;
}

export type FiringTrigger = "schedule" | "manual";

export interface TaskAttemptContext {
  executionId: string;
  attempt: number;
  signal: AbortSignal;
  triggeredBy: FiringTrigger;
  /** When this attempt started (not when its tick did). */
  now: Date;
}

export interface TaskFiringDeps {
  /** `now` is the attempt's own start time and becomes the row's startedAt. */
  createExecution: (
    task: DueTaskRow,
    attempt: { now: Date; attempt: number; triggeredBy: FiringTrigger },
  ) => Promise<{ id: string }>;
  executeTask: (
    task: DueTaskRow,
    ctx: TaskAttemptContext,
  ) => Promise<{ output: unknown; deferred?: true }>;
  /** Compare-and-set on 'running'. False: someone else finished the row. */
  finishExecution: (
    executionId: string,
    task: DueTaskRow,
    outcome: ExecutionOutcome,
  ) => Promise<boolean | void>;
  /** True once the execution row was cancelled (it is no longer 'running'). */
  isExecutionCancelled?: (executionId: string) => Promise<boolean>;
  /** Told once per firing that ended failed, after its last attempt. */
  notifyFailure?: (
    task: DueTaskRow,
    failure: { executionId: string; error: string; attempts: number; triggeredBy: FiringTrigger },
  ) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** The wall clock; replaced in tests. */
  clock?: () => Date;
  cancelPollMs?: number;
}

export interface SchedulerTickDeps extends TaskFiringDeps {
  loadDueTasks: (args: { now: Date }) => Promise<DueTaskRow[]>;
  /** CAS claim + schedule advance; false = another replica won. */
  claimTask: (task: DueTaskRow, now: Date) => Promise<boolean>;
  /**
   * Fails executions still 'running' well past their task's timeout: the
   * worker that ran them is gone. Returns how many it closed.
   */
  reapLostExecutions?: (now: Date) => Promise<number>;
}

export interface SchedulerTickResult {
  due: number;
  executed: number;
  failed: number;
  skipped: number;
  /** Firings handed to another worker (workflow runs), still in progress. */
  deferred: number;
  cancelled: number;
  /** Extra attempts made across all firings. */
  retries: number;
  /** Executions closed because the worker running them had died. */
  reaped: number;
}

export interface FiringResult {
  status: "success" | "failed" | "deferred" | "cancelled" | "unrecorded";
  /** The last attempt's execution row; null when none could be created. */
  executionId: string | null;
  attempts: number;
  error?: string;
}

export const DEFAULT_SCHEDULER_CONCURRENCY = 4;
const DEFAULT_CANCEL_POLL_MS = 2_000;

/** 5 s, 10 s, 20 s, 40 s, then 60 s. */
export function retryBackoffMs(failedAttempt: number): number {
  return Math.min(60_000, 5_000 * 2 ** (failedAttempt - 1));
}

type AbortCause = { kind: "timeout" } | { kind: "cancel" };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs one attempt under its own AbortController. The executor is raced
 * against the abort as well as handed the signal: an executor that
 * ignores its signal must not be able to hold the tick past the timeout.
 */
async function runAttempt(
  task: DueTaskRow,
  ctx: Omit<TaskAttemptContext, "signal">,
  deps: TaskFiringDeps,
): Promise<
  | { kind: "done"; output: unknown; deferred: boolean }
  | { kind: "timeout" }
  | { kind: "cancel" }
  | { kind: "error"; error: unknown }
> {
  const controller = new AbortController();
  let cause: AbortCause | null = null;
  const abort = (why: AbortCause) => {
    if (cause) return;
    cause = why;
    controller.abort(new DOMException(`task ${why.kind}`, "AbortError"));
  };

  const timer = setTimeout(() => abort({ kind: "timeout" }), task.timeout);
  let polling = false;
  const poll = deps.isExecutionCancelled
    ? setInterval(() => {
        if (polling || cause) return;
        polling = true;
        deps.isExecutionCancelled!(ctx.executionId)
          .then((cancelled) => {
            if (cancelled) abort({ kind: "cancel" });
          })
          // A failed poll is not a cancel; the next one asks again.
          .catch(() => {})
          .finally(() => {
            polling = false;
          });
      }, deps.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS)
    : null;

  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
      once: true,
    });
  });
  const execution = deps.executeTask(task, { ...ctx, signal: controller.signal });
  // Whichever side loses the race still settles; neither may surface as
  // an unhandled rejection.
  execution.catch(() => {});
  aborted.catch(() => {});

  try {
    const result = await Promise.race([execution, aborted]);
    return { kind: "done", output: result.output, deferred: result.deferred === true };
  } catch (error) {
    // Read through a widening cast: TypeScript cannot see the timer and
    // the poll assigning `cause` while the race was pending.
    const why = cause as AbortCause | null;
    if (why) return { kind: why.kind };
    return { kind: "error", error };
  } finally {
    clearTimeout(timer);
    if (poll) clearInterval(poll);
  }
}

/**
 * One firing of one task: its attempts, their execution rows and the
 * final outcome. The schedule must already be claimed (the tick) or not
 * involved at all ("trigger now").
 *
 * Every attempt is stamped with the time it really starts. A firing can
 * wait minutes for a pool slot behind slower tasks, and the lost-run
 * reaper measures a row's age from its startedAt: stamped with the
 * tick's time, a healthy execution that started late looked older than
 * its timeout and another replica's tick failed it as "run lost" while
 * it was still running (and being billed).
 */
export async function runTaskFiring(
  task: DueTaskRow,
  firing: { triggeredBy: FiringTrigger; maxRetries?: number },
  deps: TaskFiringDeps,
): Promise<FiringResult> {
  const maxRetries = Math.max(0, firing.maxRetries ?? task.maxRetries);
  const sleep = deps.sleep ?? defaultSleep;
  const clock = deps.clock ?? (() => new Date());
  let lastExecutionId: string | null = null;

  for (let attempt = 1; ; attempt++) {
    const attemptNow = clock();
    let executionId: string;
    try {
      const execution = await deps.createExecution(task, {
        now: attemptNow,
        attempt,
        triggeredBy: firing.triggeredBy,
      });
      executionId = execution.id;
    } catch (err) {
      // No row means nothing to run against: a workflow run could not be
      // linked and a cancel could not be seen. The firing is lost, and
      // counted as such rather than run unrecorded.
      return {
        status: "unrecorded",
        executionId: lastExecutionId,
        attempts: attempt - 1,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    lastExecutionId = executionId;

    const startedAt = Date.now();
    const result = await runAttempt(
      task,
      { executionId, attempt, triggeredBy: firing.triggeredBy, now: attemptNow },
      deps,
    );
    const durationMs = Date.now() - startedAt;

    if (result.kind === "done" && result.deferred) {
      return { status: "deferred", executionId, attempts: attempt };
    }
    if (result.kind === "cancel") {
      // Whoever cancelled the row already closed it.
      return { status: "cancelled", executionId, attempts: attempt };
    }
    if (result.kind === "done") {
      try {
        await deps.finishExecution(executionId, task, {
          status: "success",
          durationMs,
          output: result.output,
        });
        return { status: "success", executionId, attempts: attempt };
      } catch (err) {
        // The work succeeded and could not be recorded. Re-running it
        // would do (and bill) it twice, so the row stays 'running',
        // visibly stale rather than falsely anything.
        return {
          status: "failed",
          executionId,
          attempts: attempt,
          error: `the task ran but its result could not be saved: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }

    const error =
      result.kind === "timeout"
        ? `task timed out after ${task.timeout}ms`
        : result.error instanceof Error
          ? result.error.message
          : String(result.error);
    const output = result.kind === "error" ? failureOutput(result.error) : undefined;
    const retry =
      result.kind === "error" && !isPermanentFailure(result.error) && attempt <= maxRetries;
    const backoff = retryBackoffMs(attempt);

    let finished: boolean | void = undefined;
    try {
      finished = await deps.finishExecution(executionId, task, {
        status: "failed",
        durationMs,
        error,
        ...(output === undefined ? {} : { output }),
        ...(retry ? { retryAt: new Date(Date.now() + backoff) } : {}),
      });
    } catch {
      // Persist failure on top of execution failure — nothing more to do
      // for this row; it stays 'running' and is visibly stale rather
      // than falsely successful.
    }

    if (retry) {
      await sleep(backoff);
      continue;
    }
    // `false` is a lost compare-and-set: the row was cancelled meanwhile
    // and the canceller's word stands.
    if (finished === false) {
      return { status: "cancelled", executionId, attempts: attempt };
    }
    await deps
      .notifyFailure?.(task, { executionId, error, attempts: attempt, triggeredBy: firing.triggeredBy })
      .catch(() => {
        // A notification is not part of the outcome.
      });
    return { status: "failed", executionId, attempts: attempt, error };
  }
}

export async function runSchedulerTick(
  input: { now: Date; concurrency?: number },
  deps: SchedulerTickDeps,
): Promise<SchedulerTickResult> {
  // Housekeeping never stops the tick: a failed reap is retried by the
  // next one.
  const reaped = (await deps.reapLostExecutions?.(input.now).catch(() => 0)) ?? 0;

  const due = await deps.loadDueTasks({ now: input.now });

  const result: SchedulerTickResult = {
    due: due.length,
    executed: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    cancelled: 0,
    retries: 0,
    reaped,
  };

  const fireOne = async (task: DueTaskRow): Promise<void> => {
    let claimed: boolean;
    try {
      claimed = await deps.claimTask(task, input.now);
    } catch {
      result.failed += 1;
      return;
    }
    if (!claimed) {
      result.skipped += 1; // another replica owns this firing — benign
      return;
    }

    let firing: FiringResult;
    try {
      firing = await runTaskFiring(task, { triggeredBy: "schedule" }, deps);
    } catch {
      result.failed += 1;
      return;
    }
    result.retries += Math.max(0, firing.attempts - 1);
    if (firing.status === "success") result.executed += 1;
    else if (firing.status === "deferred") result.deferred += 1;
    else if (firing.status === "cancelled") result.cancelled += 1;
    // 'unrecorded': the firing was claimed but never recorded; the
    // schedule already advanced, so it is lost. Counted, not re-run
    // against an unclaimable nextRunAt.
    else result.failed += 1;
  };

  const concurrency = Math.max(
    1,
    Math.min(input.concurrency ?? DEFAULT_SCHEDULER_CONCURRENCY, due.length || 1),
  );
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < due.length) {
      const task = due[next++]!;
      await fireOne(task);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  return result;
}
