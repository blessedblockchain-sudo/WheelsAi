/**
 * Orchestration execution engine (W2) — runs one multi-agent workflow.
 *
 * Replaces the honest refusal Wave 0 left here, which itself replaced a
 * setTimeout that fabricated per-step "success" rows on random delays and
 * made every success-rate and duration statistic fiction.
 *
 * Per step:
 *   1. Evaluate `condition` — false ⇒ the step is recorded as SKIPPED,
 *      not silently absent. A skipped step is a real outcome the author
 *      needs to see.
 *   2. Resolve `inputMapping` against the run context (declarative data
 *      references; see orchestrationMapping.ts — no eval, ever).
 *   3. Invoke the step's agent through the SHARED executor path, so
 *      orchestration inference is identical to the playground's.
 *   4. Retry up to `maxRetries`, racing each attempt against the step's
 *      `timeoutMs`.
 *   5. On terminal failure apply `onError`:
 *        fail     — abort the run (default)
 *        continue — record the failure, keep going
 *        fallback — invoke `fallbackAgentId`; if that also fails, abort
 *   6. Record an OrchestrationStepResult and apply `outputMapping`.
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
  evaluateCondition,
  resolveStepPrompt,
  type MappingContext,
} from "./orchestrationMapping.js";
import {
  planOrchestration,
  type PlannableStep,
} from "./orchestrationPlan.js";

export interface OrchestrationStepDef extends PlannableStep {
  agentId: string;
  inputMapping: unknown;
  outputMapping: unknown;
  condition: unknown;
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
  steps: OrchestrationStepDef[];
}

export type StepStatus = "success" | "failed" | "skipped";

export interface StepRecord {
  stepId: string;
  stepName: string;
  agentId: string;
  status: StepStatus;
  input: Record<string, unknown> | null;
  output: unknown;
  error: string | null;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  attempt: number;
}

export interface OrchestrationRunDeps {
  /** Invokes one agent; the shared playground-parity path in production. */
  invokeAgent: (args: {
    agentId: string;
    orgId: string;
    prompt: string;
  }) => Promise<{ content: string; usage?: unknown }>;
  recordStepResult: (record: StepRecord) => Promise<void>;
  /** Progress as steps complete (0-100). */
  reportProgress?: (progress: number) => Promise<void>;
  now?: () => Date;
}

export interface OrchestrationRunResult {
  status: "completed" | "failed";
  output: Record<string, unknown>;
  context: Record<string, unknown>;
  error: string | null;
  failedStepId: string | null;
  stepsRun: number;
  stepsSkipped: number;
  stepsFailed: number;
}

function timeoutAfter(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
  );
}

async function invokeWithRetries(
  step: OrchestrationStepDef,
  agentId: string,
  prompt: string,
  orgId: string,
  deps: OrchestrationRunDeps,
): Promise<{ content: string; attempts: number }> {
  const maxAttempts = Math.max(1, step.maxRetries + 1);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const call = deps.invokeAgent({ agentId, orgId, prompt });
      const result = step.timeoutMs
        ? await Promise.race([call, timeoutAfter(step.timeoutMs, `step "${step.name}"`)])
        : await call;
      return { content: result.content, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error(`step "${step.name}" failed`);
}

export async function runOrchestrationExecution(
  orchestration: OrchestrationDef,
  runInput: Record<string, unknown>,
  deps: OrchestrationRunDeps,
): Promise<OrchestrationRunResult> {
  const now = deps.now ?? (() => new Date());

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
  const mappedOutput: Record<string, unknown> = {};

  let stepsRun = 0;
  let stepsSkipped = 0;
  let stepsFailed = 0;
  let completed = 0;
  const totalSteps = orchestration.steps.length;

  const runOne = async (
    planStep: PlannableStep,
  ): Promise<{ abort: boolean; error?: string; failedStepId?: string }> => {
    const step = stepsByName.get(planStep.name)!;
    const startedAt = now();

    const gate = evaluateCondition(step.condition, ctx);
    if (!gate.run) {
      stepsSkipped += 1;
      await deps.recordStepResult({
        stepId: step.id,
        stepName: step.name,
        agentId: step.agentId,
        status: "skipped",
        input: null,
        output: null,
        error: gate.reason ? `condition not met: ${gate.reason}` : "condition not met",
        startedAt,
        completedAt: now(),
        durationMs: 0,
        attempt: 0,
      });
      return { abort: false };
    }

    const resolvedInput = applyInputMapping(step.inputMapping, ctx);
    const prompt = resolveStepPrompt(resolvedInput, ctx, orchestration.executionMode);

    if (prompt === null) {
      const message = `step "${step.name}" has no prompt: its inputMapping resolved to nothing and no run input was provided`;
      stepsFailed += 1;
      await deps.recordStepResult({
        stepId: step.id,
        stepName: step.name,
        agentId: step.agentId,
        status: "failed",
        input: resolvedInput,
        output: null,
        error: message,
        startedAt,
        completedAt: now(),
        durationMs: 0,
        attempt: 0,
      });
      return step.onError === "continue"
        ? { abort: false }
        : { abort: true, error: message, failedStepId: step.id };
    }

    let content: string | null = null;
    let attempts = 0;
    let failure: Error | null = null;

    try {
      const result = await invokeWithRetries(
        step,
        step.agentId,
        prompt,
        orchestration.orgId,
        deps,
      );
      content = result.content;
      attempts = result.attempts;
    } catch (err) {
      failure = err instanceof Error ? err : new Error(String(err));
      attempts = Math.max(1, step.maxRetries + 1);
    }

    // onError=fallback: try the designated understudy once before giving
    // up. A fallback that also fails is a real failure, never masked.
    if (failure && step.onError === "fallback" && step.fallbackAgentId) {
      const primaryError = failure.message;
      try {
        const result = await invokeWithRetries(
          { ...step, maxRetries: 0 },
          step.fallbackAgentId,
          prompt,
          orchestration.orgId,
          deps,
        );
        content = result.content;
        failure = null;
      } catch (err) {
        failure = new Error(
          `${primaryError}; fallback agent also failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const completedAt = now();
    const durationMs = completedAt.getTime() - startedAt.getTime();

    if (failure) {
      stepsFailed += 1;
      await deps.recordStepResult({
        stepId: step.id,
        stepName: step.name,
        agentId: step.agentId,
        status: "failed",
        input: resolvedInput,
        output: null,
        error: failure.message,
        startedAt,
        completedAt,
        durationMs,
        attempt: attempts,
      });
      if (step.onError === "continue") {
        return { abort: false };
      }
      return { abort: true, error: failure.message, failedStepId: step.id };
    }

    // Success — publish to the context only now, so no later step can
    // read a partially-written value.
    stepsRun += 1;
    ctx.steps[step.name] = { output: content };
    ctx.previous = { output: content };

    await deps.recordStepResult({
      stepId: step.id,
      stepName: step.name,
      agentId: step.agentId,
      status: "success",
      input: resolvedInput,
      output: content,
      error: null,
      startedAt,
      completedAt,
      durationMs,
      attempt: attempts,
    });

    Object.assign(mappedOutput, applyOutputMapping(step.outputMapping, ctx));
    return { abort: false };
  };

  for (const level of plan.levels) {
    // Concurrency is bounded per level: `parallel` fans out up to
    // maxConcurrency, every other mode runs one at a time.
    const queue = [...level];
    let aborted: { error: string; failedStepId: string } | null = null;

    while (queue.length > 0 && !aborted) {
      const batch = queue.splice(0, plan.concurrency);
      const outcomes = await Promise.all(batch.map((s) => runOne(s)));
      completed += batch.length;
      if (deps.reportProgress) {
        await deps
          .reportProgress(Math.round((completed / totalSteps) * 100))
          .catch(() => {
            // Progress is cosmetic; never fail a run over it.
          });
      }
      const abort = outcomes.find((o) => o.abort);
      if (abort) {
        aborted = {
          error: abort.error ?? "step failed",
          failedStepId: abort.failedStepId ?? "",
        };
      }
    }

    if (aborted) {
      return {
        status: "failed",
        output: mappedOutput,
        context: ctx.steps as Record<string, unknown>,
        error: aborted.error,
        failedStepId: aborted.failedStepId || null,
        stepsRun,
        stepsSkipped,
        stepsFailed,
      };
    }
  }

  return {
    status: "completed",
    output: mappedOutput,
    context: ctx.steps as Record<string, unknown>,
    error: null,
    failedStepId: null,
    stepsRun,
    stepsSkipped,
    stepsFailed,
  };
}
