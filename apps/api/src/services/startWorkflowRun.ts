/**
 * Starts a workflow run: the one entry point for every trigger (the
 * dashboard, the API, the scheduler, a marketplace job).
 *
 * A run used to execute inside the HTTP request that asked for it, for up
 * to ten minutes. Now starting a run only records it and hands it to a
 * worker:
 *
 *   1. Load the workflow in the caller's organization; refuse when it is
 *      missing, disabled, or the runner is switched off.
 *   2. Check the input against the workflow's inputSchema.
 *   3. Create the execution row with status 'queued', unless the
 *      organization already has its maximum of active runs. The count and
 *      the insert happen under one lock (see buildWorkflowRunDeps), so two
 *      simultaneous starts cannot both take the last slot.
 *   4. Enqueue a job whose id IS the execution id, so a duplicate enqueue
 *      or delivery cannot become a second run.
 *   5. If the enqueue fails, move the row queued → failed (compare-and-set)
 *      and report the queue as unavailable. A row is never left 'queued'
 *      with no job behind it.
 *
 * `triggeredBy` and `triggeredById` are arguments the caller derives from
 * authentication. They are never read from a request body.
 *
 * Pure: every IO surface is injected.
 */

import { WorkflowError } from "./workflowErrors.js";
import { checkAgainstSchema } from "./workflowSchemaCheck.js";

export type WorkflowTrigger = "manual" | "api" | "schedule" | "job";

export interface StartWorkflowRunArgs {
  orchestrationId: string;
  orgId: string;
  /** Becomes `input.prompt`, the run prompt steps fall back to. */
  prompt?: string;
  input?: Record<string, unknown>;
  triggeredBy: WorkflowTrigger;
  triggeredById?: string | null;
  scheduledTaskId?: string | null;
  taskExecutionId?: string | null;
  jobId?: string | null;
}

export interface QueuedRun {
  id: string;
  status: string;
  triggeredBy: string;
  triggeredById: string | null;
  createdAt: Date;
}

export interface NewRunRow {
  orchestrationId: string;
  orgId: string;
  input: Record<string, unknown>;
  triggeredBy: WorkflowTrigger;
  triggeredById: string | null;
  scheduledTaskId: string | null;
  taskExecutionId: string | null;
  jobId: string | null;
}

export interface StartWorkflowRunDeps {
  /** False when no worker will pick runs up (WORKFLOW_RUN_CONCURRENCY=0). */
  runnerEnabled: boolean;
  maxActiveRunsPerOrg: number;
  loadWorkflow: (
    orchestrationId: string,
    orgId: string,
  ) => Promise<{ id: string; isEnabled: boolean; inputSchema: unknown } | null>;
  /**
   * Counts the organization's queued and running runs and inserts the new
   * row, atomically. `null` means the organization is at its limit.
   */
  createQueuedRun: (row: NewRunRow, maxActive: number) => Promise<QueuedRun | null>;
  enqueue: (executionId: string) => Promise<void>;
  /** queued → failed, compare-and-set. */
  failQueuedRun: (executionId: string, error: string) => Promise<void>;
}

export async function startWorkflowRun(
  args: StartWorkflowRunArgs,
  deps: StartWorkflowRunDeps,
): Promise<QueuedRun> {
  const workflow = await deps.loadWorkflow(args.orchestrationId, args.orgId);
  if (!workflow) throw new WorkflowError("not_found", "Workflow not found");
  if (!workflow.isEnabled) {
    throw new WorkflowError("workflow_disabled", "This workflow is disabled; enable it to run it");
  }
  if (!deps.runnerEnabled) {
    throw new WorkflowError(
      "workflow_runner_disabled",
      "Workflow runs are temporarily unavailable. Nothing was started. Try again later.",
    );
  }

  const input: Record<string, unknown> = {
    ...(args.input ?? {}),
    ...(args.prompt !== undefined && args.prompt !== "" ? { prompt: args.prompt } : {}),
  };
  const problems = checkAgainstSchema(workflow.inputSchema, input);
  if (problems.length > 0) {
    throw new WorkflowError(
      "input_schema_mismatch",
      "The input does not match this workflow's input schema",
      { details: problems },
    );
  }

  const run = await deps.createQueuedRun(
    {
      orchestrationId: workflow.id,
      orgId: args.orgId,
      input,
      triggeredBy: args.triggeredBy,
      triggeredById: args.triggeredById ?? null,
      scheduledTaskId: args.scheduledTaskId ?? null,
      taskExecutionId: args.taskExecutionId ?? null,
      jobId: args.jobId ?? null,
    },
    deps.maxActiveRunsPerOrg,
  );
  if (!run) {
    throw new WorkflowError(
      "workflow_run_limit",
      `This organization already has ${deps.maxActiveRunsPerOrg} workflow runs queued or running; wait for one to finish`,
      { limit: deps.maxActiveRunsPerOrg },
    );
  }

  try {
    await deps.enqueue(run.id);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await deps
      .failQueuedRun(run.id, `could not be queued: ${reason}`)
      .catch(() => {
        // The reaper fails a queued row that never starts; the caller
        // still needs to hear that the queue is down.
      });
    throw new WorkflowError(
      "workflow_queue_unavailable",
      "The workflow queue is unavailable; the run was not started",
    );
  }

  return run;
}
