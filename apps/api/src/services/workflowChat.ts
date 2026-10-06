/**
 * A workflow answered as an OpenAI chat completion.
 *
 *   POST /v1/chat/completions                       model "workflow/<slug>"
 *   POST /v1/workflows/:workflowSlug/chat/completions
 *
 * The request starts ONE run through the same entry point as the dashboard,
 * the scheduler and POST /api/orchestrations/:id/execute (startWorkflowRun),
 * so the run is queued, claimed, executed and finished by the workflow
 * worker under the usual compare-and-set transitions, and every step is
 * billed by its own rules there. Nothing is executed or charged in this
 * file: it maps a chat request onto a run input, waits for that run, and
 * maps the finished run back onto an answer.
 *
 * A run that outlives the request is CANCELLED, never abandoned:
 *
 *   - the request waits for the workflow's own time limit plus a short
 *     allowance for the queue. The worker enforces the time limit itself, so
 *     normally the run ends first (a timed-out run is answered 504);
 *   - if the wait runs out anyway (the run sat in the queue), or the client
 *     disconnects, the run is cancelled through the same compare-and-set
 *     cancel the dashboard uses: a queued run never starts, a running one has
 *     its in-flight step aborted, which refunds or releases that step by its
 *     own rules. Steps that already finished stay billed - they ran.
 *
 * So there is no run left executing with nobody to answer, and no second run
 * either: the failure answers carry `x-should-retry: false`, because an SDK
 * that repeats the request would start, and pay for, a whole new run.
 *
 * Pure: every IO surface is injected (buildWorkflowChatDeps.ts binds them).
 */

import type { NormalizedMessage, OpenAiErrorCode, OpenAiErrorDetail, WireUsage } from "./openaiCompat.js";
import { WorkflowError } from "./workflowErrors.js";

/** The same limits POST /api/orchestrations/:id/execute applies to a run's input. */
export const MAX_WORKFLOW_PROMPT_CHARS = 20_000;
export const MAX_WORKFLOW_INPUT_BYTES = 65_536;

/** How long past the workflow's own time limit the request keeps waiting. */
export const DEFAULT_WAIT_GRACE_MS = 30_000;
const DEFAULT_POLL_MS = 500;
const MAX_ERROR_CHARS = 500;

export const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;

export interface WorkflowForChat {
  id: string;
  slug: string;
  name: string;
  isEnabled: boolean;
  /** The workflow's time limit, ms. The worker enforces it. */
  timeout: number;
  inputSchema: unknown;
  createdAt: Date;
}

export interface WorkflowRunStep {
  stepName: string;
  stepType: string;
  status: string;
  iteration: number | null;
  durationMs: number | null;
  error: string | null;
  /** The stored `usage` column: tokens, `{ unreported: true }`, or null. */
  usage: unknown;
}

export interface WorkflowRunSnapshot {
  id: string;
  status: string;
  /** The run's mapped output (`outputMapping` of its steps). */
  output: unknown;
  /** `{ [stepName]: { output } }` for every step that succeeded. */
  context: unknown;
  error: string | null;
  durationMs: number | null;
  /** Step names in plan order; picks the answer when nothing is mapped. */
  stepOrder: string[];
  failedStepName: string | null;
  steps: WorkflowRunStep[];
}

export interface WorkflowChatDeps {
  /** By (organization, slug); another organization's slug is null. */
  findWorkflow: (orgId: string, slug: string) => Promise<WorkflowForChat | null>;
  /** startWorkflowRun, triggered by 'api'. Throws WorkflowError when refused. */
  startRun: (args: {
    orchestrationId: string;
    orgId: string;
    prompt: string | undefined;
    input: Record<string, unknown>;
    triggeredById: string | null;
  }) => Promise<{ id: string }>;
  /** The run's status; null when the run (or its workflow) is gone. */
  runStatus: (executionId: string, orchestrationId: string, orgId: string) => Promise<string | null>;
  loadRun: (
    executionId: string,
    orchestrationId: string,
    orgId: string,
  ) => Promise<WorkflowRunSnapshot | null>;
  /**
   * Compare-and-set cancel: queued → cancelled, running → cancel requested.
   * Resolves when the run had already finished; it then stays as it ended.
   */
  cancelRun: (executionId: string, orchestrationId: string, orgId: string) => Promise<void>;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  pollMs?: number;
  graceMs?: number;
}

export interface WorkflowChatRefusal {
  ok: false;
  code: OpenAiErrorCode;
  detail: OpenAiErrorDetail;
}

const refuse = (code: OpenAiErrorCode, detail: OpenAiErrorDetail = {}): WorkflowChatRefusal => ({
  ok: false,
  code,
  detail,
});

// ============================================
// Request → run input
// ============================================

function hasSchema(schema: unknown): boolean {
  return (
    typeof schema === "object" && schema !== null && !Array.isArray(schema) && Object.keys(schema).length > 0
  );
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export type WorkflowRunInput =
  | { ok: true; prompt: string | undefined; input: Record<string, unknown> }
  | WorkflowChatRefusal;

/**
 * What a chat request means to a workflow.
 *
 * The LAST user message is the run's prompt (`{{input.prompt}}`, and what a
 * step with no prompt of its own falls back to); the whole conversation is
 * `input.messages` for workflows that want the history.
 *
 * A workflow that declares an input schema takes structured input: when the
 * last user message is a JSON object, that object IS the run input, checked
 * against the schema like any other run's.
 */
export function workflowRunInput(messages: NormalizedMessage[], inputSchema: unknown): WorkflowRunInput {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : "";
  if (text.trim().length === 0) {
    return refuse("validation_failed", {
      param: "messages",
      message: "A workflow run needs a user message: the last one is the run's input.",
    });
  }

  const structured = hasSchema(inputSchema) ? parseJsonObject(text) : null;
  const run: { prompt: string | undefined; input: Record<string, unknown> } = structured
    ? { prompt: undefined, input: structured }
    : {
        prompt: text,
        input: { messages: messages.map((m) => ({ role: m.role, content: m.content ?? "" })) },
      };

  if (run.prompt !== undefined && run.prompt.length > MAX_WORKFLOW_PROMPT_CHARS) {
    return refuse("messages_too_large", {
      param: "messages",
      message: `The last user message is the workflow's prompt and may be at most ${MAX_WORKFLOW_PROMPT_CHARS} characters.`,
    });
  }
  const bytes = Buffer.byteLength(JSON.stringify({ ...run.input, prompt: run.prompt }), "utf8");
  if (bytes > MAX_WORKFLOW_INPUT_BYTES) {
    return refuse("messages_too_large", {
      param: "messages",
      message: `A workflow run takes at most ${MAX_WORKFLOW_INPUT_BYTES} bytes of input, and this conversation is ${bytes}. Send only the messages the workflow needs.`,
    });
  }
  return { ok: true, ...run };
}

// ============================================
// Finished run → answer
// ============================================

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  return JSON.stringify(value) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The assistant message of a completed run:
 *
 *   1. the run's mapped output when it is one string (`{ answer: "..." }`);
 *   2. otherwise the mapped output as JSON, when anything was mapped;
 *   3. otherwise the output of the last step, in plan order, that succeeded.
 *
 * null when the run produced nothing at all.
 */
export function workflowAnswerText(
  run: Pick<WorkflowRunSnapshot, "output" | "context" | "stepOrder">,
): string | null {
  if (isRecord(run.output)) {
    const values = Object.values(run.output);
    if (values.length === 1 && typeof values[0] === "string" && values[0].length > 0) return values[0];
    if (values.length > 0) return JSON.stringify(run.output);
  }
  if (!isRecord(run.context)) return null;
  for (const name of [...run.stepOrder].reverse()) {
    const entry = run.context[name];
    if (!isRecord(entry)) continue;
    const text = asText(entry.output);
    if (text !== null) return text;
  }
  return null;
}

/**
 * Tokens summed over the run's steps. null (the answer then carries no
 * `usage`) when any model call answered without reporting a count, or when
 * no step reported anything: a partial sum would read as the whole cost.
 */
export function workflowUsage(steps: Array<Pick<WorkflowRunStep, "usage">>): WireUsage | null {
  let inputTokens = 0;
  let outputTokens = 0;
  let reported = 0;
  for (const { usage } of steps) {
    if (!isRecord(usage)) continue;
    if (usage.unreported === true) return null;
    if (typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number") return null;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    reported += 1;
  }
  return reported > 0 ? { inputTokens, outputTokens } : null;
}

/** The `wheelsai.workflow` object of an answer. */
export function workflowExtension(
  workflow: Pick<WorkflowForChat, "slug">,
  run: Pick<WorkflowRunSnapshot, "id" | "status" | "durationMs" | "steps">,
): Record<string, unknown> {
  return {
    workflow: {
      slug: workflow.slug,
      executionId: run.id,
      status: run.status,
      durationMs: run.durationMs,
      steps: run.steps.map((step) => ({
        name: step.stepName,
        type: step.stepType,
        status: step.status,
        ...(step.iteration !== null && { iteration: step.iteration }),
        durationMs: step.durationMs,
        error: step.error,
      })),
    },
  };
}

function clip(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}...` : text;
}

export type WorkflowChatOutcome =
  | {
      ok: true;
      content: string;
      usage: WireUsage | null;
      extension: Record<string, unknown>;
    }
  | (WorkflowChatRefusal & { clientGone?: true });

/** A finished run as an answer or a named failure. */
export function workflowOutcome(
  workflow: Pick<WorkflowForChat, "slug" | "timeout">,
  run: WorkflowRunSnapshot,
): WorkflowChatOutcome {
  const extra = { executionId: run.id, ...workflowExtension(workflow, run) };

  if (run.status === "completed") {
    const content = workflowAnswerText(run);
    if (content === null) {
      return refuse("workflow_failed", {
        message:
          "The workflow completed without producing an output: no step succeeded with a value, and nothing is mapped to the run's output.",
        extra,
      });
    }
    return {
      ok: true,
      content,
      usage: workflowUsage(run.steps),
      extension: workflowExtension(workflow, run),
    };
  }

  if (run.status === "cancelled") {
    return refuse("workflow_cancelled", {
      message: "The workflow run was cancelled before it finished.",
      extra,
    });
  }

  // The engine's own wording for a run its time limit stopped.
  if (run.error !== null && /^workflow timed out after \d+ms$/.test(run.error)) {
    return refuse("workflow_timeout", {
      message: `The workflow reached its time limit of ${workflow.timeout} ms and was stopped. Steps that finished were billed.`,
      extra,
    });
  }

  return refuse("workflow_failed", {
    message: run.failedStepName
      ? `Workflow step "${run.failedStepName}" failed: ${clip(run.error ?? "no reason recorded")}`
      : `The workflow run failed: ${clip(run.error ?? "no reason recorded")}`,
    extra: { ...extra, failedStep: run.failedStepName },
  });
}

// ============================================
// The request
// ============================================

export interface WorkflowChatInput {
  orgId: string;
  slug: string;
  messages: NormalizedMessage[];
  /** Whether the caller sent `tools` or `tool_choice`. */
  hasTools: boolean;
  /** The API key or user that asked; recorded on the run. */
  triggeredById: string | null;
  /** Aborts when the client disconnects. */
  signal: AbortSignal;
}

export interface WorkflowChatSession {
  ok: true;
  workflow: WorkflowForChat;
  executionId: string;
  /** Waits for the run and maps it. Never leaves the run going unattended. */
  finish: () => Promise<WorkflowChatOutcome>;
}

function startRefusal(err: WorkflowError): WorkflowChatRefusal {
  switch (err.code) {
    case "not_found":
      return refuse("workflow_not_found");
    case "workflow_disabled":
      return refuse("workflow_disabled", { message: err.message });
    case "input_schema_mismatch":
      return refuse("validation_failed", {
        param: "messages",
        message: `${err.message}: ${
          Array.isArray(err.extra.details) ? err.extra.details.join("; ") : "see the workflow's input schema"
        }. Send the input as a JSON object in the last user message.`,
        extra: { details: err.extra.details },
      });
    case "workflow_run_limit":
      return refuse("workflow_run_limit", { message: err.message, retryAfterSeconds: 10, extra: err.extra });
    case "workflow_runner_disabled":
      return refuse("workflow_runner_disabled", { message: err.message });
    case "workflow_queue_unavailable":
      return refuse("service_unavailable", { message: err.message, retryAfterSeconds: 5 });
    default:
      return refuse("internal_error");
  }
}

/**
 * Checks the request and starts the run. A refusal here means NO run exists.
 * On success the caller owns `finish()`: it must be awaited.
 */
export async function startWorkflowChat(
  input: WorkflowChatInput,
  deps: WorkflowChatDeps,
): Promise<WorkflowChatSession | WorkflowChatRefusal> {
  const workflow = await deps.findWorkflow(input.orgId, input.slug);
  if (!workflow) return refuse("workflow_not_found");

  // A workflow has no turn in which it could hand a function call back.
  if (input.hasTools) {
    return refuse("unsupported_parameter", {
      param: "tools",
      message:
        "A workflow cannot call functions on the caller's side. Remove tools and tool_choice, or call an agent.",
    });
  }
  if (!workflow.isEnabled) {
    return refuse("workflow_disabled", {
      message: "This workflow is disabled. Enable it in the dashboard to run it.",
    });
  }

  const run = workflowRunInput(input.messages, workflow.inputSchema);
  if (!run.ok) return run;
  // Nothing is started for a caller that has already left.
  if (input.signal.aborted) return refuse("client_closed_request");

  let executionId: string;
  try {
    const started = await deps.startRun({
      orchestrationId: workflow.id,
      orgId: input.orgId,
      prompt: run.prompt,
      input: run.input,
      triggeredById: input.triggeredById,
    });
    executionId = started.id;
  } catch (err) {
    if (err instanceof WorkflowError) return startRefusal(err);
    throw err;
  }

  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const startedAt = deps.now();
  const deadline = startedAt + workflow.timeout + (deps.graceMs ?? DEFAULT_WAIT_GRACE_MS);
  const isTerminal = (status: string) =>
    (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);

  const settle = async (): Promise<WorkflowChatOutcome> => {
    const finished = await deps.loadRun(executionId, workflow.id, input.orgId);
    // Deleted with its workflow while this request waited.
    if (!finished) return refuse("workflow_not_found", { extra: { executionId } });
    return workflowOutcome(workflow, finished);
  };

  const finish = async (): Promise<WorkflowChatOutcome> => {
    for (;;) {
      if (input.signal.aborted) {
        await deps.cancelRun(executionId, workflow.id, input.orgId);
        return { ...refuse("client_closed_request", { extra: { executionId } }), clientGone: true };
      }

      // A failed read is retried on the next pass; the deadline bounds it.
      const status = await deps.runStatus(executionId, workflow.id, input.orgId).catch(() => "unknown");
      if (status === null) return refuse("workflow_not_found", { extra: { executionId } });
      if (isTerminal(status)) return settle();

      if (deps.now() >= deadline) {
        await deps.cancelRun(executionId, workflow.id, input.orgId);
        // The run may have finished between the last read and the cancel;
        // it was billed, so its answer is delivered rather than dropped.
        const after = await deps.loadRun(executionId, workflow.id, input.orgId);
        if (after && after.status === "completed") return workflowOutcome(workflow, after);
        return refuse("workflow_timeout", {
          message: `The workflow did not finish within ${Math.round(
            (deps.now() - startedAt) / 1000,
          )} s of being started and was cancelled. Steps that finished were billed.`,
          extra: { executionId },
        });
      }

      await deps.sleep(pollMs, input.signal);
    }
  };

  return { ok: true, workflow, executionId, finish };
}
