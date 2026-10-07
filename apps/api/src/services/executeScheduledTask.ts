/**
 * Scheduled-task executor: the engine behind the scheduler worker and
 * "trigger now".
 *
 * Executes ONE attempt of ONE task and returns its output, or throws with
 * the message the execution row records. The task's type is looked up in
 * the registry (scheduledTaskTypes.ts) and handed to that type's
 * executor:
 *
 *   agent_run / inference  the task's agent, through the same
 *                          model-resolution and chat path as the
 *                          playground (real inference, real usage)
 *   webhook                a POST to the task's URL
 *   data_sync              URLs into a knowledge base
 *   health_check           a probe that fails the task unless it is up
 *   report                 usage report, optionally summarised/delivered
 *   cleanup                scoped housekeeping, with a dry run
 *   custom                 the agent's visual-builder graph
 *   workflow_run           starts a workflow run (finished elsewhere)
 *
 * A type that is not registered refuses. A registered type whose
 * services were not wired into this process refuses too, naming itself:
 * the old scheduler advertised six types on top of a timer that wrote
 * success rows, and nothing here is allowed to do that again.
 *
 * All IO is injected so unit tests run without models, fetch, or Prisma.
 */

import type { z } from "zod";

import { safeFetch, SsrfBlockedError, type UrlGuardDeps } from "../lib/ssrfGuard.js";
import { getTaskType, TASK_TYPE_IDS } from "./scheduledTaskTypes.js";
import { runCleanup, type CleanupDeps } from "./scheduledTasks/cleanup.js";
import type {
  ScheduledTaskForExecution,
  TaskResult,
  TaskRunContext,
} from "./scheduledTasks/context.js";
import { runDataSync, type DataSyncDeps } from "./scheduledTasks/dataSync.js";
import { runGraphTask, type GraphRunDeps } from "./scheduledTasks/graphRun.js";
import { runHealthCheck, type HealthCheckDeps } from "./scheduledTasks/healthCheck.js";
import { runReport, type ReportDeps } from "./scheduledTasks/report.js";
import { isAbort, permanentFailure } from "./scheduledTasks/taskError.js";
import { runWorkflowTask, type WorkflowRunDeps } from "./scheduledTasks/workflowRun.js";
import { sanitizeOutboundHeaders } from "./skills/httpLimits.js";
import type { ToolMode } from "./skills/types.js";

export type { ScheduledTaskForExecution, TaskResult, TaskRunContext };

export interface AgentForExecution {
  id: string;
  /** Carried so downstream billing (marketplace metering) can scope. */
  orgId: string;
  name: string;
  systemPrompt: string | null;
  tools: unknown;
  modelConfig: unknown;
  env: unknown;
}

/** The services behind the task types that need more than a model or fetch. */
export interface ScheduledTaskTypeDeps {
  dataSync?: DataSyncDeps;
  healthCheck?: HealthCheckDeps;
  report?: ReportDeps;
  cleanup?: CleanupDeps;
  graphRun?: GraphRunDeps;
  workflowRun?: WorkflowRunDeps;
}

export interface ExecuteScheduledTaskDeps {
  loadAgent: (agentId: string, orgId: string) => Promise<AgentForExecution | null>;
  /** Playground-parity inference: resolve + chat, non-streaming. */
  runAgentChat: (args: {
    agent: AgentForExecution;
    prompt: string;
    /** Where the run comes from; gates tools (default "scheduled"). */
    mode?: ToolMode;
    /** Aborts the model call on a timeout or a cancel. */
    signal?: AbortSignal;
    /**
     * A paid job only (mode "hired"): the offering's private instructions,
     * sent as a system turn after the agent's own, and the tools the
     * offering allows. See services/sharedAgentChat.ts.
     */
    systemAddendum?: string;
    toolAllowlist?: string[];
  }) => Promise<{
    content: string;
    usage?: unknown;
    /** The resolved model id, and whether it ran on the platform's own keys. */
    model?: string | null;
    platformModel?: boolean;
    toolCallCount?: number;
  }>;
  fetchFn: typeof fetch;
  /** DNS seam for the SSRF guard; tests inject it, production uses real DNS. */
  guardDeps?: UrlGuardDeps;
  /**
   * Absent for callers that only chat with an agent (workflow steps, the
   * test runner); the scheduler's composition root supplies them all.
   */
  taskTypes?: ScheduledTaskTypeDeps;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

/** Stored payloads were validated when saved; this guards rows that predate that. */
function parsePayload<T>(taskType: string, payload: unknown): T {
  const schema = getTaskType(taskType)!.payload as z.ZodType<T>;
  const parsed = schema.safeParse(payloadRecord(payload));
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? `payload.${issue.path.join(".")}: ` : "";
  throw permanentFailure(
    `this task's payload is not valid for a ${taskType} task (${where}${issue?.message ?? "invalid"}); edit the task to fix it`,
  );
}

function wired<K extends keyof ScheduledTaskTypeDeps>(
  deps: ExecuteScheduledTaskDeps,
  key: K,
  taskType: string,
): NonNullable<ScheduledTaskTypeDeps[K]> {
  const service = deps.taskTypes?.[key];
  if (!service) {
    throw permanentFailure(
      `task type "${taskType}" cannot run here: its services are not connected in this process`,
    );
  }
  return service;
}

async function runAgentTask(
  task: ScheduledTaskForExecution,
  ctx: TaskRunContext,
  deps: ExecuteScheduledTaskDeps,
): Promise<TaskResult> {
  if (!task.agentId) {
    throw permanentFailure(`task type "${task.taskType}" needs an agent and this task has none`);
  }
  const agent = await deps.loadAgent(task.agentId, task.orgId);
  if (!agent) {
    throw permanentFailure(`agent ${task.agentId} not found for scheduled task`);
  }
  const payload = payloadRecord(task.payload);
  // Tasks saved before prompts were required have none; they keep running
  // with the prompt they have always been given.
  const prompt =
    typeof payload.prompt === "string" && payload.prompt.trim() !== ""
      ? payload.prompt
      : `Run scheduled task: ${task.name}`;

  const result = await deps.runAgentChat({ agent, prompt, signal: ctx.signal });
  return {
    output: {
      content: result.content,
      usage: result.usage ?? null,
    },
  };
}

async function runWebhookTask(
  task: ScheduledTaskForExecution,
  ctx: TaskRunContext,
  deps: ExecuteScheduledTaskDeps,
): Promise<TaskResult> {
  const payload = payloadRecord(task.payload);
  const url = payload.url;
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    throw permanentFailure("webhook task requires a payload.url (http/https)");
  }
  let headers: Record<string, string> | undefined;
  try {
    headers = sanitizeOutboundHeaders(
      typeof payload.headers === "object" && payload.headers !== null
        ? (payload.headers as Record<string, string>)
        : undefined,
    );
  } catch (err) {
    throw permanentFailure(
      `webhook headers refused: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // The URL is user-supplied, so it is an SSRF vector into our own network.
  // safeFetch validates it (DNS-resolved addresses, IPv6 forms included) and
  // does not auto-follow redirects: the old code validated the first URL and
  // then let `fetch` follow a 302 to wherever it pointed.
  let res: Response;
  try {
    res = await safeFetch(url, {
      method: "POST",
      headers: {
        // The body below is JSON whatever the task's headers say.
        ...Object.fromEntries(
          Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== "content-type"),
        ),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        taskId: task.id,
        taskName: task.name,
        // A retried firing posts again; these two let a receiver tell a
        // retry from a new firing and drop what it already handled.
        executionId: ctx.executionId,
        attempt: ctx.attempt,
        firedAt: ctx.now.toISOString(),
        body: payload.body ?? null,
      }),
      timeoutMs: Math.min(task.timeout, 60_000),
      // A redirect would turn the POST into a GET (and drop the payload)
      // without anyone noticing; a webhook that moved should fail loudly.
      maxRedirects: 0,
      signal: ctx.signal,
      fetchImpl: deps.fetchFn,
      guardDeps: deps.guardDeps,
    });
  } catch (err) {
    if (isAbort(err, ctx.signal)) throw err;
    if (err instanceof SsrfBlockedError) {
      // The execution row is shown to the task's owner: no resolved
      // addresses in it (see SsrfBlockedError.publicMessage). The URL will
      // be refused again, so the task's retries are not spent on it.
      throw permanentFailure(
        err.message === "too many redirects"
          ? "webhook URL redirected; redirects are not followed for webhooks - use the final URL"
          : `webhook URL refused: ${err.publicMessage}`,
      );
    }
    throw err;
  }
  await res.body?.cancel().catch(() => {});
  if (!res.ok) {
    throw new Error(`webhook responded ${res.status}`);
  }
  return { output: { status: res.status } };
}

export async function executeScheduledTask(
  task: ScheduledTaskForExecution,
  deps: ExecuteScheduledTaskDeps,
  context: Partial<TaskRunContext> = {},
): Promise<TaskResult> {
  const ctx: TaskRunContext = {
    executionId: context.executionId ?? null,
    attempt: context.attempt ?? 1,
    signal: context.signal,
    triggeredBy: context.triggeredBy ?? "schedule",
    now: context.now ?? new Date(),
  };

  const type = getTaskType(task.taskType);
  if (!type) {
    throw permanentFailure(
      `task type "${task.taskType}" is not supported; supported: ${TASK_TYPE_IDS.join(", ")}`,
    );
  }

  switch (type.type) {
    case "agent_run":
    case "inference":
      return runAgentTask(task, ctx, deps);
    case "webhook":
      return runWebhookTask(task, ctx, deps);
    case "data_sync":
      return runDataSync(
        task,
        parsePayload(type.type, task.payload),
        ctx,
        wired(deps, "dataSync", type.type),
      );
    case "health_check":
      return runHealthCheck(
        task,
        parsePayload(type.type, task.payload),
        ctx,
        wired(deps, "healthCheck", type.type),
      );
    case "report":
      return runReport(
        task,
        parsePayload(type.type, task.payload),
        ctx,
        wired(deps, "report", type.type),
      );
    case "cleanup":
      return runCleanup(
        task,
        parsePayload(type.type, task.payload),
        ctx,
        wired(deps, "cleanup", type.type),
      );
    case "custom":
      return runGraphTask(
        task,
        parsePayload(type.type, task.payload),
        ctx,
        wired(deps, "graphRun", type.type),
      );
    case "workflow_run":
      return runWorkflowTask(
        task,
        parsePayload(type.type, task.payload),
        ctx,
        wired(deps, "workflowRun", type.type),
      );
  }
}
