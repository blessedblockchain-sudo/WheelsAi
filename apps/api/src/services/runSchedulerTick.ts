/**
 * Scheduler tick (Wave 1) — one call = one pass of the BullMQ scheduler
 * worker. Pure orchestration; every IO surface is dependency-injected.
 *
 * Before this worker existed nothing consumed `nextRunAt` — schedules
 * were definitions that never fired (and "trigger now" wrote fabricated
 * success rows on a timer, removed in W0-2).
 *
 * Flow per due task:
 *   1. claimTask — CAS on {id, nextRunAt: <the loaded value>} that
 *      advances nextRunAt to the next occurrence (or ends a 'once'
 *      schedule). count=0 → another replica claimed this firing; skip.
 *      Claim-BEFORE-execute means a crash mid-run loses at most one
 *      firing — it never double-fires or tight-loops a broken task.
 *   2. createExecution (status=running)
 *   3. executeTask with the task's own timeout raced against it
 *   4. finishExecution — success/failed + the task's rolling stats
 *
 * Per-task isolation: an execute/persist throw fails THAT task's
 * execution; remaining due tasks still run.
 */

export interface DueTaskRow {
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
  /** The due time this tick loaded — the CAS guard for the claim. */
  nextRunAt: Date;
}

export interface ExecutionOutcome {
  status: "success" | "failed";
  durationMs: number;
  output?: unknown;
  error?: string;
}

export interface SchedulerTickDeps {
  loadDueTasks: (args: { now: Date }) => Promise<DueTaskRow[]>;
  /** CAS claim + schedule advance; false = another replica won. */
  claimTask: (task: DueTaskRow, now: Date) => Promise<boolean>;
  createExecution: (
    task: DueTaskRow,
    now: Date,
  ) => Promise<{ id: string }>;
  executeTask: (task: DueTaskRow) => Promise<{ output: unknown }>;
  finishExecution: (
    executionId: string,
    task: DueTaskRow,
    outcome: ExecutionOutcome,
  ) => Promise<void>;
}

export interface SchedulerTickResult {
  due: number;
  executed: number;
  failed: number;
  skipped: number;
}

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`task timed out after ${ms}ms`)), ms),
  );
}

export async function runSchedulerTick(
  input: { now: Date },
  deps: SchedulerTickDeps,
): Promise<SchedulerTickResult> {
  const due = await deps.loadDueTasks({ now: input.now });

  const result: SchedulerTickResult = {
    due: due.length,
    executed: 0,
    failed: 0,
    skipped: 0,
  };

  for (const task of due) {
    let claimed: boolean;
    try {
      claimed = await deps.claimTask(task, input.now);
    } catch {
      result.failed += 1;
      continue;
    }
    if (!claimed) {
      result.skipped += 1; // another replica owns this firing — benign
      continue;
    }

    let executionId: string;
    try {
      const execution = await deps.createExecution(task, input.now);
      executionId = execution.id;
    } catch {
      // The firing was claimed but never recorded; the schedule already
      // advanced, so this firing is lost — count it and move on rather
      // than re-running against an unclaimable nextRunAt.
      result.failed += 1;
      continue;
    }

    const startedAt = Date.now();
    try {
      const { output } = await Promise.race([
        deps.executeTask(task),
        timeoutAfter(task.timeout),
      ]);
      await deps.finishExecution(executionId, task, {
        status: "success",
        durationMs: Date.now() - startedAt,
        output,
      });
      result.executed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await deps.finishExecution(executionId, task, {
          status: "failed",
          durationMs: Date.now() - startedAt,
          error: message,
        });
      } catch {
        // Persist failure on top of execution failure — nothing more to
        // do for this row; the execution stays 'running' and is visibly
        // stale rather than falsely successful.
      }
      result.failed += 1;
    }
  }

  return result;
}
