/**
 * Orchestration execution engine (W2) — runs one workflow.
 *
 * Replaces the honest refusal Wave 0 left here, which itself replaced a
 * setTimeout that fabricated per-step "success" rows on random delays and
 * made every success-rate and duration statistic fiction.
 *
 * Per step:
 *   1. Check its dependencies. A step runs when at least one dependency
 *      succeeded. When none did it is recorded as SKIPPED ("branch not
 *      taken", or "dependency failed" when one failed under
 *      onError=continue), so a branch that was not taken stays not taken
 *      all the way down.
 *   2. Evaluate `condition` — false ⇒ the step is recorded as SKIPPED,
 *      not silently absent. A skipped step is a real outcome the author
 *      needs to see.
 *   3. Build the prompt: `promptTemplate` if set, else the input mapping's
 *      `prompt`, else (pipeline mode) the previous output, else the run
 *      prompt. Declarative data references only; see
 *      orchestrationMapping.ts — no eval, ever.
 *   4. Invoke by step type: an agent through the SHARED executor path (so
 *      orchestration inference is identical to the playground's), a
 *      deployed model, or a knowledge-base search.
 *   5. Loops: `forEach` runs the step once per item of a list, `until`
 *      re-runs it until a condition on its own output holds. Both are
 *      bounded, and one record is written per pass.
 *   6. Retry up to `maxRetries` (or the workflow's retryPolicy), each
 *      attempt bounded by the step's `timeoutMs`, which ABORTS the call.
 *   7. On terminal failure apply `onError`:
 *        fail     — abort the run (default)
 *        continue — record the failure, keep going
 *        fallback — invoke `fallbackAgentId`; if that also fails, abort
 *   8. Record an OrchestrationStepResult and apply `outputMapping`.
 *
 * Stopping: `deps.signal` is the run's abort signal. Its reason says how
 * the run ends — "cancel" ⇒ cancelled, "timeout" ⇒ failed with a timeout
 * message. It is checked before every batch and every loop pass and is
 * handed to every invocation, so an aborted run makes no further calls.
 *
 * Failure containment: a step's output is only published to the context
 * after it succeeds, so a later step can never read a half-written value.
 *
 * Every IO surface is injected — the engine is testable without models,
 * Prisma, or timers.
 */

import {
  applyInputMapping,
  applyOutputMapping,
  collectReferences,
  collectTemplateReferences,
  evaluateCondition,
  parseStepOutput,
  renderPromptTemplate,
  resolveStepPrompt,
  resolveValue,
  type MappingContext,
} from "./orchestrationMapping.js";
import {
  planOrchestration,
  type PlannableStep,
} from "./orchestrationPlan.js";

export interface OrchestrationStepDef extends PlannableStep {
  /** 'agent' (default), 'model' or 'retrieval'. */
  stepType?: string | null;
  agentId: string | null;
  deploymentId?: string | null;
  modelId?: string | null;
  knowledgeBaseId?: string | null;
  promptTemplate?: string | null;
  inputMapping: unknown;
  outputMapping: unknown;
  /** 'text' (default) or 'json'. */
  outputFormat?: string | null;
  condition: unknown;
  loop?: unknown;
  onError: string;
  fallbackAgentId: string | null;
  maxRetries: number;
  timeoutMs: number | null;
}

export interface OrchestrationDef {
  id: string;
  orgId: string;
  executionMode: string;
  maxConcurrency: number;
  timeout: number;
  /** Workflow-level defaults: `{ maxRetries, backoffMs }`. */
  retryPolicy?: unknown;
  steps: OrchestrationStepDef[];
}

export type StepStatus = "success" | "failed" | "skipped";

/** Tokens one model call reported. */
export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * What a call's `usage` says, when it says anything usable. A graph run, or
 * a provider that sent no count, returns none: that is "unreported", which
 * is not zero tokens.
 */
export function readStepUsage(raw: unknown): StepUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { inputTokens, outputTokens } = raw as Record<string, unknown>;
  const count = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  return count(inputTokens) && count(outputTokens) ? { inputTokens, outputTokens } : null;
}

export interface StepRecord {
  stepId: string;
  stepName: string;
  stepType: string;
  agentId: string | null;
  /** The deployment or knowledge base a non-agent step used. */
  resourceId: string | null;
  status: StepStatus;
  /** Loop pass: the item index (forEach) or the pass number (until). */
  iteration: number | null;
  input: Record<string, unknown> | null;
  /** The published value, cut to MAX_STORED_OUTPUT_CHARS when larger. */
  output: unknown;
  truncated: boolean;
  /**
   * Tokens of the model call that answered this pass; "unreported" when it
   * answered without a count; null when the pass made no model call that
   * answered (retrieval, skipped, failed).
   */
  usage: StepUsage | "unreported" | null;
  error: string | null;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  attempt: number;
}

export interface RetrievedPassage {
  content: string;
  documentTitle?: string | null;
  score?: number | null;
}

export interface OrchestrationRunDeps {
  /** Invokes one agent; the shared playground-parity path in production. */
  invokeAgent: (args: {
    agentId: string;
    orgId: string;
    prompt: string;
    signal?: AbortSignal;
  }) => Promise<{ content: string; usage?: unknown }>;
  /** Calls one of the organization's model deployments. */
  invokeModel?: (args: {
    deploymentId: string;
    modelId: string | null;
    orgId: string;
    prompt: string;
    signal?: AbortSignal;
  }) => Promise<{ content: string; usage?: unknown }>;
  /** Searches one of the organization's knowledge bases. */
  searchKnowledge?: (args: {
    knowledgeBaseId: string;
    orgId: string;
    query: string;
    limit: number;
    signal?: AbortSignal;
  }) => Promise<{
    passages: RetrievedPassage[];
    /** 'semantic' or 'keyword'; recorded so the output says which ran. */
    mode: string;
    fallbackReason?: string | null;
  }>;
  recordStepResult: (record: StepRecord) => Promise<void>;
  /** Progress as steps complete (0-100). */
  reportProgress?: (progress: number) => Promise<void>;
  /** The run's abort signal; reason "cancel" or "timeout". */
  signal?: AbortSignal;
  /** Polled at checkpoints for a cancel requested from outside. */
  isCancelRequested?: () => Promise<boolean>;
  /** Backoff between retries; resolves early when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
}

export interface OrchestrationRunResult {
  status: "completed" | "failed" | "cancelled";
  output: Record<string, unknown>;
  context: Record<string, unknown>;
  error: string | null;
  failedStepId: string | null;
  stepsRun: number;
  stepsSkipped: number;
  stepsFailed: number;
}

/** Stored step output is cut here; later steps still read the full value. */
export const MAX_STORED_OUTPUT_CHARS = 100_000;
const DEFAULT_FOR_EACH_ITEMS = 50;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_RETRIEVAL_LIMIT = 5;
const MAX_RETRIEVAL_LIMIT = 20;

/** The run was stopped from outside; `reason` is the abort reason. */
class RunAbortedError extends Error {
  constructor(public readonly reason: unknown) {
    super("run aborted");
  }
}

class StepTimeoutError extends Error {}

export function capStepOutput(value: unknown): { output: unknown; truncated: boolean } {
  if (value === undefined || value === null) return { output: null, truncated: false };
  if (typeof value === "string") {
    return value.length > MAX_STORED_OUTPUT_CHARS
      ? { output: value.slice(0, MAX_STORED_OUTPUT_CHARS), truncated: true }
      : { output: value, truncated: false };
  }
  const json = JSON.stringify(value) ?? "";
  return json.length > MAX_STORED_OUTPUT_CHARS
    ? { output: json.slice(0, MAX_STORED_OUTPUT_CHARS), truncated: true }
    : { output: value, truncated: false };
}

function readRetryPolicy(policy: unknown): { maxRetries: number; backoffMs: number } {
  const raw = typeof policy === "object" && policy !== null ? (policy as Record<string, unknown>) : {};
  const int = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return { maxRetries: int(raw.maxRetries), backoffMs: int(raw.backoffMs) };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * A for-each source as a list: an array as is, a JSON array in a string,
 * or one item per non-empty line. Anything else is not a list.
 */
function toItems(source: unknown): unknown[] | null {
  if (Array.isArray(source)) return source;
  if (typeof source !== "string") return null;
  const trimmed = source.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON after all; fall through to lines.
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

type StepOutcome = "success" | "failed" | "skipped";

type PassUsage = StepRecord["usage"];

interface PassSuccess {
  ok: true;
  value: unknown;
  usage: PassUsage;
  attempts: number;
  input: Record<string, unknown>;
}
interface PassFailure {
  ok: false;
  error: string;
  attempts: number;
  input: Record<string, unknown> | null;
}

export async function runOrchestrationExecution(
  orchestration: OrchestrationDef,
  runInput: Record<string, unknown>,
  deps: OrchestrationRunDeps,
): Promise<OrchestrationRunResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const runSignal = deps.signal;
  const retryPolicy = readRetryPolicy(orchestration.retryPolicy);

  // A plan error (cycle, unknown dependency, no steps) fails the run
  // before any agent is invoked — nothing is charged for a workflow that
  // could never have completed.
  const plan = planOrchestration(
    orchestration.steps,
    orchestration.executionMode,
    orchestration.maxConcurrency,
  );

  const stepsByName = new Map(orchestration.steps.map((s) => [s.name, s]));
  const ctx: MappingContext = { input: runInput, steps: {} };
  const outcomes = new Map<string, StepOutcome>();
  const mappedOutput: Record<string, unknown> = {};

  let stepsRun = 0;
  let stepsSkipped = 0;
  let stepsFailed = 0;
  let completed = 0;
  const totalSteps = orchestration.steps.length;

  const storedContext = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(ctx.steps)) {
      const capped = capStepOutput(entry.output);
      out[name] = capped.truncated ? { output: capped.output, truncated: true } : { output: capped.output };
    }
    return out;
  };

  const finish = (
    status: OrchestrationRunResult["status"],
    error: string | null,
    failedStepId: string | null,
  ): OrchestrationRunResult => ({
    status,
    output: mappedOutput,
    context: storedContext(),
    error,
    failedStepId,
    stepsRun,
    stepsSkipped,
    stepsFailed,
  });

  const finishAborted = (reason: unknown): OrchestrationRunResult => {
    if (reason === "cancel") return finish("cancelled", "cancelled", null);
    if (reason === "timeout") {
      return finish("failed", `workflow timed out after ${orchestration.timeout}ms`, null);
    }
    return finish("failed", `workflow run interrupted: ${String(reason)}`, null);
  };

  /** Throws when the run has been stopped; called before each unit of work. */
  const checkpoint = async (): Promise<void> => {
    if (runSignal?.aborted) throw new RunAbortedError(runSignal.reason);
    if (deps.isCancelRequested && (await deps.isCancelRequested())) {
      throw new RunAbortedError("cancel");
    }
    // The signal may have fired while the cancel check was in flight.
    if (runSignal?.aborted) throw new RunAbortedError(runSignal.reason);
  };

  const record = async (
    step: OrchestrationStepDef,
    fields: Pick<StepRecord, "status" | "input" | "error" | "startedAt" | "attempt"> & {
      output?: unknown;
      usage?: PassUsage;
      iteration?: number | null;
    },
  ): Promise<void> => {
    const completedAt = now();
    const stepType = step.stepType ?? "agent";
    const capped = capStepOutput(fields.output);
    await deps.recordStepResult({
      stepId: step.id,
      stepName: step.name,
      stepType,
      agentId: step.agentId ?? null,
      resourceId:
        stepType === "model"
          ? (step.deploymentId ?? null)
          : stepType === "retrieval"
            ? (step.knowledgeBaseId ?? null)
            : null,
      status: fields.status,
      iteration: fields.iteration ?? null,
      input: fields.input,
      output: capped.output,
      truncated: capped.truncated,
      usage: fields.usage ?? null,
      error: fields.error,
      startedAt: fields.startedAt,
      completedAt,
      durationMs:
        fields.attempt === 0 ? 0 : completedAt.getTime() - fields.startedAt.getTime(),
      attempt: fields.attempt,
    });
  };

  /** One bounded call. Aborts the callee on step timeout or run abort. */
  const callOnce = async <T>(
    step: OrchestrationStepDef,
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (runSignal?.aborted) throw new RunAbortedError(runSignal.reason);
    const attempt = new AbortController();
    const onRunAbort = () => attempt.abort(new RunAbortedError(runSignal?.reason));
    runSignal?.addEventListener("abort", onRunAbort, { once: true });
    const timer = step.timeoutMs
      ? setTimeout(
          () =>
            attempt.abort(
              new StepTimeoutError(`step "${step.name}" timed out after ${step.timeoutMs}ms`),
            ),
          step.timeoutMs,
        )
      : null;
    try {
      // Raced as well as signalled: a callee that ignores its signal must
      // not be able to hold the run past its timeout.
      return await Promise.race([
        call(attempt.signal),
        new Promise<never>((_, reject) => {
          attempt.signal.addEventListener("abort", () => reject(attempt.signal.reason), {
            once: true,
          });
        }),
      ]);
    } catch (err) {
      if (runSignal?.aborted) throw new RunAbortedError(runSignal.reason);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      runSignal?.removeEventListener("abort", onRunAbort);
    }
  };

  /** Dispatches by step type and returns the value later steps will read. */
  const invoke = async (
    step: OrchestrationStepDef,
    prompt: string,
    resolvedInput: Record<string, unknown>,
    signal: AbortSignal,
    agentOverride?: string,
  ): Promise<{ value: unknown; usage: PassUsage }> => {
    const stepType = agentOverride ? "agent" : (step.stepType ?? "agent");
    const format = step.outputFormat ?? "text";

    if (stepType === "retrieval") {
      if (!deps.searchKnowledge) {
        throw new Error("retrieval steps are not available in this run");
      }
      if (!step.knowledgeBaseId) {
        throw new Error(`step "${step.name}" has no knowledge base`);
      }
      const requested = resolvedInput.limit;
      const limit =
        typeof requested === "number" && requested >= 1
          ? Math.min(Math.floor(requested), MAX_RETRIEVAL_LIMIT)
          : DEFAULT_RETRIEVAL_LIMIT;
      const found = await deps.searchKnowledge({
        knowledgeBaseId: step.knowledgeBaseId,
        orgId: orchestration.orgId,
        query: prompt,
        limit,
        signal,
      });
      return {
        value: {
          query: prompt,
          mode: found.mode,
          fallbackReason: found.fallbackReason ?? null,
          passages: found.passages,
          // Ready to drop into a prompt: {{steps.<name>.output.text}}.
          text: found.passages.map((p) => p.content).join("\n\n"),
        },
        // No model call: nothing to report, and nothing missing.
        usage: null,
      };
    }

    if (stepType === "model") {
      if (!deps.invokeModel) {
        throw new Error("model steps are not available in this run");
      }
      if (!step.deploymentId) {
        throw new Error(`step "${step.name}" has no model deployment`);
      }
      const result = await deps.invokeModel({
        deploymentId: step.deploymentId,
        modelId: step.modelId ?? null,
        orgId: orchestration.orgId,
        prompt,
        signal,
      });
      return {
        value: parseStepOutput(result.content, format),
        usage: readStepUsage(result.usage) ?? "unreported",
      };
    }

    const agentId = agentOverride ?? step.agentId;
    if (!agentId) throw new Error(`step "${step.name}" has no agent`);
    const result = await deps.invokeAgent({
      agentId,
      orgId: orchestration.orgId,
      prompt,
      signal,
    });
    return {
      value: parseStepOutput(result.content, format),
      usage: readStepUsage(result.usage) ?? "unreported",
    };
  };

  const invokeWithRetries = async (
    step: OrchestrationStepDef,
    prompt: string,
    resolvedInput: Record<string, unknown>,
    options: { agentOverride?: string; retries: number },
  ): Promise<{ value: unknown; usage: PassUsage; attempts: number }> => {
    const maxAttempts = Math.max(1, options.retries + 1);
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const answered = await callOnce(step, (signal) =>
          invoke(step, prompt, resolvedInput, signal, options.agentOverride),
        );
        return { ...answered, attempts: attempt };
      } catch (err) {
        if (err instanceof RunAbortedError) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (attempt < maxAttempts && retryPolicy.backoffMs > 0) {
        await sleep(Math.min(retryPolicy.backoffMs * attempt, MAX_BACKOFF_MS), runSignal);
        if (runSignal?.aborted) throw new RunAbortedError(runSignal.reason);
      }
    }
    throw lastError ?? new Error(`step "${step.name}" failed`);
  };

  /** One pass of a step: build the prompt, invoke, retry, fall back. */
  const runPass = async (
    step: OrchestrationStepDef,
    passCtx: MappingContext,
  ): Promise<PassSuccess | PassFailure> => {
    const resolvedInput = applyInputMapping(step.inputMapping, passCtx);
    const missing = new Set<string>();
    for (const reference of collectReferences(step.inputMapping)) {
      if (reference.kind === "steps" && reference.step && !passCtx.steps[reference.step]) {
        missing.add(reference.raw);
      }
    }

    let prompt: string | null;
    if (typeof step.promptTemplate === "string" && step.promptTemplate.trim() !== "") {
      try {
        const rendered = renderPromptTemplate(step.promptTemplate, passCtx);
        for (const raw of rendered.missingRefs) missing.add(raw);
        prompt = rendered.text.trim() === "" ? null : rendered.text;
      } catch (err) {
        return {
          ok: false,
          error: `step "${step.name}": ${err instanceof Error ? err.message : String(err)}`,
          attempts: 0,
          input: resolvedInput,
        };
      }
    } else {
      prompt = resolveStepPrompt(resolvedInput, passCtx, orchestration.executionMode);
    }

    const input: Record<string, unknown> = {
      ...resolvedInput,
      ...(prompt === null ? {} : { prompt }),
      ...(passCtx.index === undefined ? {} : { item: passCtx.item, index: passCtx.index }),
      ...(passCtx.iteration === undefined ? {} : { iteration: passCtx.iteration }),
      ...(missing.size > 0 ? { missingRefs: [...missing] } : {}),
    };

    if (prompt === null) {
      return {
        ok: false,
        error: `step "${step.name}" has no prompt: its prompt template or inputMapping resolved to nothing and no run input was provided`,
        attempts: 0,
        input,
      };
    }

    const retries = step.maxRetries > 0 ? step.maxRetries : retryPolicy.maxRetries;
    let failure: Error;
    try {
      const result = await invokeWithRetries(step, prompt, resolvedInput, { retries });
      return { ok: true, value: result.value, usage: result.usage, attempts: result.attempts, input };
    } catch (err) {
      if (err instanceof RunAbortedError) throw err;
      failure = err instanceof Error ? err : new Error(String(err));
    }

    // onError=fallback: try the designated understudy once before giving
    // up. A fallback that also fails is a real failure, never masked.
    if (step.onError === "fallback" && step.fallbackAgentId) {
      try {
        const result = await invokeWithRetries(step, prompt, resolvedInput, {
          agentOverride: step.fallbackAgentId,
          retries: 0,
        });
        return { ok: true, value: result.value, usage: result.usage, attempts: retries + 2, input };
      } catch (err) {
        if (err instanceof RunAbortedError) throw err;
        failure = new Error(
          `${failure.message}; fallback agent also failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { ok: false, error: failure.message, attempts: retries + 1, input };
  };

  /** Runs one pass and records it. An aborted pass is recorded, then rethrown. */
  const runRecordedPass = async (
    step: OrchestrationStepDef,
    passCtx: MappingContext,
    iteration: number | null,
  ): Promise<PassSuccess | PassFailure> => {
    const startedAt = now();
    let pass: PassSuccess | PassFailure;
    try {
      pass = await runPass(step, passCtx);
    } catch (err) {
      if (err instanceof RunAbortedError) {
        await record(step, {
          status: "failed",
          input: null,
          error:
            err.reason === "cancel"
              ? "cancelled while running"
              : err.reason === "timeout"
                ? "stopped: the workflow timed out"
                : "stopped: the workflow run was interrupted",
          startedAt,
          attempt: 1,
          iteration,
        }).catch(() => {
          // The abort is the outcome that matters; never mask it.
        });
      }
      throw err;
    }
    await record(step, {
      status: pass.ok ? "success" : "failed",
      input: pass.input,
      output: pass.ok ? pass.value : undefined,
      usage: pass.ok ? pass.usage : null,
      error: pass.ok ? null : pass.error,
      startedAt,
      attempt: pass.attempts,
      iteration,
    });
    return pass;
  };

  type StepRun = { ok: true; value: unknown } | { ok: false; error: string };

  const runForEach = async (
    step: OrchestrationStepDef,
    loop: { forEach: unknown; maxItems?: unknown },
  ): Promise<StepRun> => {
    const startedAt = now();
    const refuse = async (error: string): Promise<StepRun> => {
      await record(step, { status: "failed", input: null, error, startedAt, attempt: 0 });
      return { ok: false, error };
    };

    const items = toItems(resolveValue(loop.forEach, ctx));
    if (items === null) {
      return refuse(
        `step "${step.name}" forEach source ${String(loop.forEach)} did not resolve to a list`,
      );
    }
    const maxItems =
      typeof loop.maxItems === "number" && loop.maxItems >= 1
        ? Math.floor(loop.maxItems)
        : DEFAULT_FOR_EACH_ITEMS;
    // Too many items FAILS rather than truncating: silently processing
    // the first N of a list reports success for work that was not done.
    if (items.length > maxItems) {
      return refuse(
        `step "${step.name}" forEach has ${items.length} items, more than its limit of ${maxItems}`,
      );
    }
    if (items.length === 0) {
      await record(step, { status: "success", input: null, output: [], error: null, startedAt, attempt: 0 });
      return { ok: true, value: [] };
    }

    const values: unknown[] = new Array(items.length);
    let firstError: string | null = null;
    let next = 0;
    const worker = async (): Promise<void> => {
      // A failed item stops new items from starting; ones already in
      // flight finish and are recorded.
      while (next < items.length && firstError === null) {
        const index = next++;
        await checkpoint();
        const pass = await runRecordedPass(step, { ...ctx, item: items[index], index }, index);
        if (pass.ok) values[index] = pass.value;
        else firstError ??= `item ${index}: ${pass.error}`;
      }
    };
    const workers = Array.from({ length: Math.min(plan.concurrency, items.length) }, worker);
    const settled = await Promise.allSettled(workers);
    const thrown = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (thrown) throw thrown.reason;

    return firstError === null ? { ok: true, value: values } : { ok: false, error: firstError };
  };

  const runUntil = async (
    step: OrchestrationStepDef,
    loop: { until: unknown; maxIterations?: unknown; onExhausted?: unknown },
  ): Promise<StepRun> => {
    const maxIterations =
      typeof loop.maxIterations === "number" && loop.maxIterations >= 1
        ? Math.floor(loop.maxIterations)
        : 1;
    let last: unknown;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      await checkpoint();
      const pass = await runRecordedPass(step, { ...ctx, iteration }, iteration);
      if (!pass.ok) return { ok: false, error: `iteration ${iteration}: ${pass.error}` };
      last = pass.value;

      // The condition reads this pass's output through a trial context;
      // the shared context is only written once the step has succeeded.
      const trial: MappingContext = {
        ...ctx,
        iteration,
        steps: { ...ctx.steps, [step.name]: { output: pass.value } },
      };
      if (evaluateCondition(loop.until, trial).run) return { ok: true, value: pass.value };
    }

    if (loop.onExhausted === "continue") return { ok: true, value: last };
    const error = `step "${step.name}" until condition was not met after ${maxIterations} iterations`;
    await record(step, { status: "failed", input: null, error, startedAt: now(), attempt: 0 });
    return { ok: false, error };
  };

  const runOne = async (
    planStep: PlannableStep,
  ): Promise<{ abort: boolean; error?: string; failedStepId?: string }> => {
    const step = stepsByName.get(planStep.name)!;
    const startedAt = now();

    const skip = async (reason: string) => {
      stepsSkipped += 1;
      outcomes.set(step.name, "skipped");
      await record(step, { status: "skipped", input: null, error: reason, startedAt, attempt: 0 });
      return { abort: false };
    };

    if (step.dependsOn.length > 0) {
      const states = step.dependsOn.map((dep) => outcomes.get(dep));
      if (!states.includes("success")) {
        const failedDeps = step.dependsOn.filter((dep) => outcomes.get(dep) === "failed");
        return skip(
          failedDeps.length > 0
            ? `dependency failed: ${failedDeps.join(", ")}`
            : "branch not taken",
        );
      }
    }

    const gate = evaluateCondition(step.condition, ctx);
    if (!gate.run) {
      return skip(gate.reason ? `condition not met: ${gate.reason}` : "condition not met");
    }

    const loop =
      typeof step.loop === "object" && step.loop !== null
        ? (step.loop as Record<string, unknown>)
        : null;
    let run: StepRun;
    if (loop && "forEach" in loop) {
      run = await runForEach(step, loop as { forEach: unknown });
    } else if (loop && "until" in loop) {
      run = await runUntil(step, loop as { until: unknown });
    } else {
      const pass = await runRecordedPass(step, ctx, null);
      run = pass.ok ? { ok: true, value: pass.value } : { ok: false, error: pass.error };
    }

    if (!run.ok) {
      stepsFailed += 1;
      outcomes.set(step.name, "failed");
      if (step.onError === "continue") return { abort: false };
      return { abort: true, error: run.error, failedStepId: step.id };
    }

    // Success — publish to the context only now, so no later step can
    // read a partially-written value.
    stepsRun += 1;
    outcomes.set(step.name, "success");
    ctx.steps[step.name] = { output: run.value };
    Object.assign(mappedOutput, applyOutputMapping(step.outputMapping, ctx));
    return { abort: false };
  };

  // Fail fast on a template that cannot render, before anything is invoked.
  for (const step of orchestration.steps) {
    if (typeof step.promptTemplate === "string") collectTemplateReferences(step.promptTemplate);
  }

  for (const level of plan.levels) {
    // Concurrency is bounded per level: `parallel` fans out up to
    // maxConcurrency, every other mode runs one at a time.
    const queue = [...level];

    while (queue.length > 0) {
      const batch = queue.splice(0, plan.concurrency);

      let settled: PromiseSettledResult<Awaited<ReturnType<typeof runOne>>>[];
      try {
        await checkpoint();
        // allSettled, not all: when the run is aborted every in-flight
        // step must finish unwinding before the run reports its outcome.
        settled = await Promise.allSettled(batch.map((s) => runOne(s)));
      } catch (err) {
        if (err instanceof RunAbortedError) return finishAborted(err.reason);
        throw err;
      }

      const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
      const aborted = rejected.find((s) => s.reason instanceof RunAbortedError);
      if (aborted) return finishAborted((aborted.reason as RunAbortedError).reason);
      if (rejected[0]) throw rejected[0].reason;

      // `previous` follows PLAN order, not finish order: inside a
      // parallel batch whichever step happened to finish last must not
      // decide what the next step reads.
      for (const planned of [...batch].reverse()) {
        const published = ctx.steps[planned.name];
        if (outcomes.get(planned.name) === "success" && published) {
          ctx.previous = { output: published.output };
          break;
        }
      }

      completed += batch.length;
      if (deps.reportProgress) {
        await deps
          .reportProgress(Math.round((completed / totalSteps) * 100))
          .catch(() => {
            // Progress is cosmetic; never fail a run over it.
          });
      }

      const abort = settled
        .map((s) => (s.status === "fulfilled" ? s.value : null))
        .find((o) => o?.abort);
      if (abort) {
        return finish("failed", abort.error ?? "step failed", abort.failedStepId || null);
      }
    }
  }

  return finish("completed", null, null);
}
