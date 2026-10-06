/**
 * Runs one queued workflow run. One call = one job delivered by the
 * workflow-run queue.
 *
 *   1. claimRun — compare-and-set queued → running. No row matched means
 *      another delivery owns this run, or it was cancelled while queued:
 *      return without invoking anything, so a duplicate delivery can
 *      never run, or bill, a workflow twice.
 *   2. Re-check the stored definition (resources may have been deleted
 *      since it was saved). A workflow that cannot complete fails before
 *      its first step is charged.
 *   3. Run the engine under an AbortController. The workflow's timeout
 *      aborts it with reason "timeout"; a cancel request, polled while
 *      the run is in flight, aborts it with reason "cancel". Either way
 *      the in-flight model call is aborted, not left running.
 *   4. Check the result against the workflow's outputSchema.
 *   5. finishRun — compare-and-set running → completed | failed |
 *      cancelled. If it matches no row (the reaper failed the run, or the
 *      workflow was deleted) this worker lost and records nothing more.
 *   6. Only the winner updates the workflow's statistics, finishes the
 *      scheduled-task execution that started the run (if any), and emits
 *      workflow.completed / workflow.failed.
 *
 * Pure: every IO surface is injected.
 */

import {
  runOrchestrationExecution,
  type OrchestrationDef,
  type OrchestrationRunDeps,
} from "./runOrchestrationExecution.js";
import { checkAgainstSchema } from "./workflowSchemaCheck.js";

export interface ClaimedRun {
  id: string;
  input: Record<string, unknown>;
  triggeredBy: string;
  scheduledTaskId: string | null;
  taskExecutionId: string | null;
  jobId: string | null;
  workflow: OrchestrationDef & { name: string; outputSchema: unknown };
}

export interface RunOutcome {
  status: "completed" | "failed" | "cancelled";
  output: Record<string, unknown>;
  context: Record<string, unknown>;
  error: string | null;
  failedStepId: string | null;
  completedAt: Date;
  durationMs: number;
}

export type WorkflowEventType = "workflow.completed" | "workflow.failed";

export interface LinkedTaskOutcome {
  status: "success" | "failed" | "cancelled";
  durationMs: number;
  output?: unknown;
  error?: string;
}

/** The engine surfaces a composition root supplies; the job adds the rest. */
export type WorkflowEngineBindings = Pick<
  OrchestrationRunDeps,
  "invokeAgent" | "invokeModel" | "searchKnowledge" | "recordStepResult" | "reportProgress" | "sleep"
>;

export interface WorkflowExecutionJobDeps {
  /** queued → running, compare-and-set. False = someone else has it. */
  claimRun: (executionId: string, startedAt: Date) => Promise<boolean>;
  loadRun: (executionId: string) => Promise<ClaimedRun | null>;
  /** Returns why the stored definition cannot run, or null when it can. */
  validateWorkflow?: (run: ClaimedRun) => Promise<string | null>;
  engineBindings: (run: ClaimedRun, signal: AbortSignal) => WorkflowEngineBindings;
  isCancelRequested: (executionId: string) => Promise<boolean>;
  /** running → terminal, compare-and-set. False = this worker lost. */
  finishRun: (executionId: string, outcome: RunOutcome) => Promise<boolean>;
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
  /** A post-finish bookkeeping step failed; the run's outcome stands. */
  onSideEffectError?: (what: string, err: unknown) => void;
  now?: () => Date;
  cancelPollMs?: number;
}

export type WorkflowJobResult =
  | { status: "skipped" }
  | { status: "superseded" }
  | { status: "completed" | "failed" | "cancelled"; error: string | null };

const DEFAULT_CANCEL_POLL_MS = 2_000;
const EVENT_OUTPUT_PREVIEW_CHARS = 2_000;

function preview(output: unknown): string {
  const json = JSON.stringify(output) ?? "";
  return json.length > EVENT_OUTPUT_PREVIEW_CHARS
    ? `${json.slice(0, EVENT_OUTPUT_PREVIEW_CHARS)}...`
    : json;
}

export async function runWorkflowExecutionJob(
  input: {
    executionId: string;
    /** Aborts the run when the worker process is shutting down. */
    shutdownSignal?: AbortSignal;
  },
  deps: WorkflowExecutionJobDeps,
): Promise<WorkflowJobResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();

  if (!(await deps.claimRun(input.executionId, startedAt))) return { status: "skipped" };
  let run: ClaimedRun | null;
  try {
    run = await deps.loadRun(input.executionId);
  } catch (err) {
    // Claimed but unreadable: end the row now rather than leave it
    // 'running' until the reaper's timeout.
    const completedAt = now();
    await deps
      .finishRun(input.executionId, {
        status: "failed",
        output: {},
        context: {},
        error: "the run could not be loaded",
        failedStepId: null,
        completedAt,
        durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      })
      .catch(() => {});
    throw err;
  }
  // Claimed and then gone: the workflow was deleted in between.
  if (!run) return { status: "skipped" };

  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort("timeout"), run.workflow.timeout);
  const onShutdown = () => controller.abort("worker shutting down");
  if (input.shutdownSignal?.aborted) onShutdown();
  input.shutdownSignal?.addEventListener("abort", onShutdown, { once: true });

  let polling = false;
  const cancelPoll = setInterval(() => {
    if (polling || controller.signal.aborted) return;
    polling = true;
    deps
      .isCancelRequested(run.id)
      .then((requested) => {
        if (requested) controller.abort("cancel");
      })
      .catch(() => {
        // A failed poll is retried on the next tick.
      })
      .finally(() => {
        polling = false;
      });
  }, deps.cancelPollMs ?? DEFAULT_CANCEL_POLL_MS);

  let engineResult: Awaited<ReturnType<typeof runOrchestrationExecution>> | null = null;
  let engineError: string | null = null;
  try {
    const invalid = deps.validateWorkflow ? await deps.validateWorkflow(run) : null;
    if (invalid !== null) {
      engineError = `workflow can no longer run: ${invalid}`;
    } else {
      engineResult = await runOrchestrationExecution(run.workflow, run.input, {
        ...deps.engineBindings(run, controller.signal),
        signal: controller.signal,
        isCancelRequested: () => deps.isCancelRequested(run.id),
        now,
      });
    }
  } catch (err) {
    // A plan error, a template that cannot render, or a step row that
    // could not be written. The run row records it.
    engineError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeoutTimer);
    clearInterval(cancelPoll);
    input.shutdownSignal?.removeEventListener("abort", onShutdown);
  }

  const completedAt = now();
  const outcome: RunOutcome = {
    status: engineResult?.status ?? "failed",
    output: engineResult?.output ?? {},
    context: engineResult?.context ?? {},
    error: engineResult ? engineResult.error : engineError,
    failedStepId: engineResult?.failedStepId ?? null,
    completedAt,
    durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
  };

  if (outcome.status === "completed") {
    const problems = checkAgainstSchema(run.workflow.outputSchema, outcome.output);
    if (problems.length > 0) {
      outcome.status = "failed";
      outcome.error = `output does not match the workflow's output schema: ${problems.join("; ")}`;
    }
  }

  if (!(await deps.finishRun(run.id, outcome))) return { status: "superseded" };

  const sideEffect = async (what: string, effect: () => Promise<void>) => {
    try {
      await effect();
    } catch (err) {
      deps.onSideEffectError?.(what, err);
    }
  };

  // A cancelled run is neither a success nor a failure of the workflow.
  if (outcome.status !== "cancelled") {
    await sideEffect("stats", () =>
      deps.recordRunStats(run.workflow.id, {
        success: outcome.status === "completed",
        durationMs: outcome.durationMs,
        at: completedAt,
      }),
    );
  }

  if (run.taskExecutionId) {
    const taskExecutionId = run.taskExecutionId;
    await sideEffect("linked task execution", () =>
      deps.finishLinkedTaskExecution(taskExecutionId, {
        status:
          outcome.status === "completed"
            ? "success"
            : outcome.status === "cancelled"
              ? "cancelled"
              : "failed",
        durationMs: outcome.durationMs,
        ...(outcome.status === "completed"
          ? { output: { orchestrationExecutionId: run.id, status: outcome.status, output: outcome.output } }
          : { error: outcome.error ?? `workflow run ${outcome.status}` }),
      }),
    );
  }

  if (outcome.status !== "cancelled") {
    await sideEffect("webhook event", () =>
      deps.emitEvent(
        run.workflow.orgId,
        outcome.status === "completed" ? "workflow.completed" : "workflow.failed",
        {
          executionId: run.id,
          orchestrationId: run.workflow.id,
          workflowName: run.workflow.name,
          status: outcome.status,
          triggeredBy: run.triggeredBy,
          durationMs: outcome.durationMs,
          error: outcome.error,
          outputPreview: preview(outcome.output),
        },
      ),
    );
  }

  return { status: outcome.status, error: outcome.error };
}
