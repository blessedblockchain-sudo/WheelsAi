/**
 * Scheduled-task executor (Wave 1 — the engine behind the scheduler).
 *
 * Executes ONE task and returns its output, or throws with a message the
 * execution row records. Two task types are real:
 *
 *   agent_run / inference — invoke the task's agent through the same
 *     model-resolution + chat path the playground uses (real inference,
 *     real usage). The payload's `prompt` is the user message.
 *   webhook — POST the payload to the task's configured URL with a
 *     bounded timeout; non-2xx is a failure.
 *
 * Anything else throws "not supported" — the old UI advertised six task
 * types backed by a setTimeout that fabricated success rows (removed in
 * W0-2); we do not pretend the other four exist until they do.
 *
 * All IO is injected so unit tests run without models, fetch, or Prisma.
 */

import { safeFetch, SsrfBlockedError, type UrlGuardDeps } from "../lib/ssrfGuard.js";
import type { ToolMode } from "./skills/types.js";

export interface ScheduledTaskForExecution {
  id: string;
  orgId: string;
  agentId: string;
  name: string;
  taskType: string;
  payload: unknown;
  timeout: number;
}

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

export interface ExecuteScheduledTaskDeps {
  loadAgent: (agentId: string, orgId: string) => Promise<AgentForExecution | null>;
  /** Playground-parity inference: resolve + chat, non-streaming. */
  runAgentChat: (args: {
    agent: AgentForExecution;
    prompt: string;
    /** Where the run comes from; gates tools (default "scheduled"). */
    mode?: ToolMode;
  }) => Promise<{ content: string; usage?: unknown }>;
  fetchFn: typeof fetch;
  /** DNS seam for the SSRF guard; tests inject it, production uses real DNS. */
  guardDeps?: UrlGuardDeps;
}

const AGENT_TASK_TYPES = new Set(["agent_run", "inference"]);

function payloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

export async function executeScheduledTask(
  task: ScheduledTaskForExecution,
  deps: ExecuteScheduledTaskDeps,
): Promise<{ output: unknown }> {
  const payload = payloadRecord(task.payload);

  if (AGENT_TASK_TYPES.has(task.taskType)) {
    const agent = await deps.loadAgent(task.agentId, task.orgId);
    if (!agent) {
      throw new Error(`agent ${task.agentId} not found for scheduled task`);
    }
    const prompt =
      typeof payload.prompt === "string" && payload.prompt.trim() !== ""
        ? payload.prompt
        : `Run scheduled task: ${task.name}`;

    const result = await deps.runAgentChat({ agent, prompt });
    return {
      output: {
        content: result.content,
        usage: result.usage ?? null,
      },
    };
  }

  if (task.taskType === "webhook") {
    const url = payload.url;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
      throw new Error("webhook task requires a payload.url (http/https)");
    }
    // The URL is user-supplied, so it is an SSRF vector into our own network.
    // safeFetch validates it (DNS-resolved addresses, IPv6 forms included) and
    // does not auto-follow redirects: the old code validated the first URL and
    // then let `fetch` follow a 302 to wherever it pointed.
    let res: Response;
    try {
      res = await safeFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: task.id,
          taskName: task.name,
          firedAt: new Date().toISOString(),
          body: payload.body ?? null,
        }),
        timeoutMs: Math.min(task.timeout, 60_000),
        // A redirect would turn the POST into a GET (and drop the payload)
        // without anyone noticing; a webhook that moved should fail loudly.
        maxRedirects: 0,
        fetchImpl: deps.fetchFn,
        guardDeps: deps.guardDeps,
      });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        // The execution row is shown to the task's owner: no resolved
        // addresses in it (see SsrfBlockedError.publicMessage).
        throw new Error(
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

  throw new Error(
    `task type "${task.taskType}" is not supported yet — supported: agent_run, webhook`,
  );
}
