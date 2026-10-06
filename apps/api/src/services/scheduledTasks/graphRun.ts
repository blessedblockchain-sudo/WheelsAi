/**
 * custom: run the graph drawn for the task's agent in the visual builder.
 *
 * The graph runner records its own execution row and does its own
 * marketplace metering (one run is one billable request, refunded when
 * the run fails), so this executor only starts it and reports what came
 * back. A graph run that ends `failed` fails the task with the graph's
 * error; it is never recorded as a successful task that "ran".
 *
 * Pure: the graph runner is injected.
 */

import type { CustomPayload } from "../scheduledTaskTypes.js";
import type { ScheduledTaskForExecution, TaskResult, TaskRunContext } from "./context.js";
import { isAbort, permanentFailure, TaskError } from "./taskError.js";

export interface GraphRunDeps {
  runGraph: (
    agentId: string,
    orgId: string,
    input: string,
    options: { signal?: AbortSignal },
  ) => Promise<{
    executionId: string;
    status: string;
    output: unknown;
    error?: string | null;
    durationMs: number;
  }>;
}

export async function runGraphTask(
  task: ScheduledTaskForExecution,
  payload: CustomPayload,
  ctx: TaskRunContext,
  deps: GraphRunDeps,
): Promise<TaskResult> {
  if (!task.agentId) {
    throw permanentFailure('task type "custom" runs an agent\'s graph and this task has no agent');
  }

  let run: Awaited<ReturnType<GraphRunDeps["runGraph"]>>;
  try {
    run = await deps.runGraph(task.agentId, task.orgId, payload.input, { signal: ctx.signal });
  } catch (err) {
    if (isAbort(err, ctx.signal)) throw err;
    // Thrown before a run exists: no agent, no graph, an empty graph, a
    // licence or balance refusal. None of them changes on a retry.
    throw permanentFailure(err instanceof Error ? err.message : String(err));
  }

  const output = {
    graphExecutionId: run.executionId,
    status: run.status,
    output: run.output ?? null,
    durationMs: run.durationMs,
  };
  if (run.status === "failed") {
    throw new TaskError(`graph run failed: ${run.error ?? "no error was recorded"}`, { output });
  }
  return { output };
}
