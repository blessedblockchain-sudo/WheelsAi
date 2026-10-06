/**
 * workflow_run: start a run of the task's workflow.
 *
 * Starting is all this executor does. The run is queued for the workflow
 * worker, linked to this task execution in both directions, and the
 * result is `deferred`: the scheduler leaves the execution 'running' and
 * the workflow worker (or its reaper) finishes it with the run's real
 * outcome. A scheduled workflow therefore never shows as succeeded
 * because it was merely started.
 *
 * The workflow is looked up in the task's own organization by the start
 * service, so a task cannot run another organization's workflow.
 *
 * Pure: the start service and the link write are injected.
 */

import type { WorkflowRunPayload } from "../scheduledTaskTypes.js";
import type { ScheduledTaskForExecution, TaskResult, TaskRunContext } from "./context.js";
import { permanentFailure } from "./taskError.js";

export interface WorkflowRunDeps {
  /** Rejects with the start service's own error (not found, disabled, at the limit, ...). */
  startRun: (args: {
    orchestrationId: string;
    orgId: string;
    prompt?: string;
    input?: Record<string, unknown>;
    triggeredBy: "schedule" | "manual";
    scheduledTaskId: string;
    taskExecutionId: string;
  }) => Promise<{ id: string; status: string }>;
  /** Records the run on the task execution so the two can be followed. */
  linkExecution: (taskExecutionId: string, orchestrationExecutionId: string) => Promise<void>;
}

export async function runWorkflowTask(
  task: ScheduledTaskForExecution,
  payload: WorkflowRunPayload,
  ctx: TaskRunContext,
  deps: WorkflowRunDeps,
): Promise<TaskResult> {
  if (!task.orchestrationId) {
    throw permanentFailure('task type "workflow_run" needs a workflow and this task has none');
  }
  // Without an execution row there is nothing for the workflow worker to
  // finish, and the run's outcome would be lost to the schedule.
  if (!ctx.executionId) {
    throw permanentFailure("a workflow_run task can only run as a recorded execution");
  }

  let run: { id: string; status: string };
  try {
    run = await deps.startRun({
      orchestrationId: task.orchestrationId,
      orgId: task.orgId,
      prompt: payload.prompt,
      input: payload.input,
      triggeredBy: ctx.triggeredBy,
      scheduledTaskId: task.id,
      taskExecutionId: ctx.executionId,
    });
  } catch (err) {
    // The workflow is gone, disabled, over its run limit, or the queue is
    // down. The next firing is the retry; this one reports why.
    throw permanentFailure(
      `workflow run not started: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // The run already carries this execution's id, which is what finishes
  // it. Failing here would mark a queued run's execution failed while the
  // run goes on to succeed, so a lost back-link is tolerated.
  await deps.linkExecution(ctx.executionId, run.id).catch(() => {});
  return {
    output: { orchestrationExecutionId: run.id, status: run.status },
    deferred: true,
  };
}
