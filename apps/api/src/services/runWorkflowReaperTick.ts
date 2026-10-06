/**
 * Workflow-run reaper: fails runs that will never finish on their own.
 *
 * A run is a row a worker is supposed to end. Two things break that: the
 * job behind a queued row is lost (Redis flushed, enqueue half-failed),
 * or the worker dies mid-run. Without this tick those rows stay 'queued'
 * or 'running' forever and keep counting against the organization's
 * concurrent-run cap.
 *
 *   queued  longer than the grace period, with no job waiting in the
 *           queue                                → failed, "never started"
 *   running longer than the workflow's timeout plus a grace period
 *                                                → failed, "run lost"
 *
 * A healthy run cannot be caught: the worker's own timeout aborts it at
 * `timeout`, well before `timeout + grace`. Every change is a
 * compare-and-set on the status the reaper saw, so a worker that finishes
 * at the same moment wins or loses cleanly and the run is never finished
 * twice.
 *
 * Pure: every IO surface is injected.
 */

import type { LinkedTaskOutcome, WorkflowEventType } from "./runWorkflowExecutionJob.js";

export interface ReapCandidate {
  id: string;
  status: "queued" | "running";
  orchestrationId: string;
  orgId: string;
  workflowName: string;
  /** The workflow's run timeout in ms. */
  timeout: number;
  createdAt: Date;
  startedAt: Date | null;
  taskExecutionId: string | null;
}

export interface WorkflowReaperTickDeps {
  loadCandidates: (args: {
    queuedBefore: Date;
    runningStartedBefore: Date;
  }) => Promise<ReapCandidate[]>;
  /** Whether a job for this run is still waiting or active in the queue. */
  isJobPending?: (executionId: string) => Promise<boolean>;
  /** `from` → failed, compare-and-set. False = the run moved on first. */
  failRun: (args: {
    executionId: string;
    from: "queued" | "running";
    error: string;
    now: Date;
    durationMs: number | null;
  }) => Promise<boolean>;
  recordRunStats: (
    orchestrationId: string,
    stats: { success: boolean; durationMs: number; at: Date },
  ) => Promise<void>;
  finishLinkedTaskExecution: (
    taskExecutionId: string,
    outcome: LinkedTaskOutcome,
  ) => Promise<void>;
  emitEvent: (
    orgId: string,
    type: WorkflowEventType,
    data: Record<string, unknown>,
  ) => Promise<void>;
  onSideEffectError?: (what: string, err: unknown) => void;
}

export interface WorkflowReaperTickResult {
  examined: number;
  reaped: number;
  /** Runs that finished or started between the read and the write. */
  lostRace: number;
  errors: number;
}

export async function runWorkflowReaperTick(
  input: { now: Date; queuedGraceMs: number; runningGraceMs: number },
  deps: WorkflowReaperTickDeps,
): Promise<WorkflowReaperTickResult> {
  const nowMs = input.now.getTime();
  const candidates = await deps.loadCandidates({
    queuedBefore: new Date(nowMs - input.queuedGraceMs),
    runningStartedBefore: new Date(nowMs - input.runningGraceMs),
  });

  const result: WorkflowReaperTickResult = {
    examined: candidates.length,
    reaped: 0,
    lostRace: 0,
    errors: 0,
  };

  for (const run of candidates) {
    try {
      let error: string;
      let durationMs: number | null = null;

      if (run.status === "queued") {
        if (nowMs - run.createdAt.getTime() <= input.queuedGraceMs) continue;
        // A long queue is not a lost job. Only a row with nothing behind
        // it is reaped; when the queue cannot be asked, leave the row.
        if (deps.isJobPending && (await deps.isJobPending(run.id))) continue;
        error = "never started: no worker picked this run up";
      } else {
        if (!run.startedAt) continue;
        durationMs = nowMs - run.startedAt.getTime();
        if (durationMs <= run.timeout + input.runningGraceMs) continue;
        error = "run lost: the worker stopped before the run finished";
      }

      const reaped = await deps.failRun({
        executionId: run.id,
        from: run.status,
        error,
        now: input.now,
        durationMs,
      });
      if (!reaped) {
        result.lostRace += 1;
        continue;
      }
      result.reaped += 1;

      const sideEffect = async (what: string, effect: () => Promise<void>) => {
        try {
          await effect();
        } catch (err) {
          deps.onSideEffectError?.(what, err);
        }
      };
      await sideEffect("stats", () =>
        deps.recordRunStats(run.orchestrationId, {
          success: false,
          durationMs: durationMs ?? 0,
          at: input.now,
        }),
      );
      if (run.taskExecutionId) {
        const taskExecutionId = run.taskExecutionId;
        await sideEffect("linked task execution", () =>
          deps.finishLinkedTaskExecution(taskExecutionId, {
            status: "failed",
            durationMs: durationMs ?? 0,
            error,
          }),
        );
      }
      await sideEffect("webhook event", () =>
        deps.emitEvent(run.orgId, "workflow.failed", {
          executionId: run.id,
          orchestrationId: run.orchestrationId,
          workflowName: run.workflowName,
          status: "failed",
          durationMs,
          error,
        }),
      );
    } catch {
      // One run's failure must not stop the others being examined.
      result.errors += 1;
    }
  }

  return result;
}
