/**
 * The workflow editor's working copy, and its conversion to and from the
 * API's WorkflowDefinition.
 *
 * Steps are tracked by a client-side `key` rather than by name, because a
 * name is editable and everything else (dependencies, canvas positions,
 * the selection) must survive a rename. Names are written back only when
 * the draft becomes a definition.
 *
 * Pure: no React, no fetch.
 */

import type {
  OrchestrationDetail,
  OrchestrationStep,
  WorkflowCondition,
  WorkflowConditionOp,
  WorkflowDefinitionInput,
  WorkflowExecutionMode,
  WorkflowLayout,
  WorkflowLoop,
  WorkflowStepInput,
  WorkflowStepType,
} from "@/lib/api";

// The server's bounds (services/workflowDefinition.ts WORKFLOW_LIMITS).
export const LIMITS = {
  maxSteps: 25,
  maxConcurrency: 10,
  minTimeoutSeconds: 10,
  maxTimeoutSeconds: 3600,
  maxRetries: 5,
  maxBackoffMs: 60_000,
  maxPromptChars: 20_000,
  minStepTimeoutSeconds: 1,
  maxStepTimeoutSeconds: 900,
  maxForEachItems: 50,
  maxUntilIterations: 10,
} as const;

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 84;
const COLUMN_GAP = 90;
const ROW_GAP = 36;

export const EXECUTION_MODES: Array<{
  value: WorkflowExecutionMode;
  label: string;
  description: string;
}> = [
  {
    value: "parallel",
    label: "Parallel",
    description:
      "Steps run as soon as the steps they depend on have finished; independent steps run together. Use this for branches and fan-out.",
  },
  {
    value: "sequential",
    label: "Sequential",
    description: "One step at a time, in dependency order, then in the order listed.",
  },
  {
    value: "pipeline",
    label: "Pipeline",
    description:
      "One step at a time; a step with no prompt of its own receives the previous step's output.",
  },
  {
    value: "conditional",
    label: "Conditional",
    description: "One step at a time; meant for workflows whose steps each carry a run-only-if condition.",
  },
];

export const CONDITION_OPS: Array<{ value: WorkflowConditionOp; label: string; unary?: boolean }> = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "exists", label: "exists", unary: true },
  { value: "not_exists", label: "does not exist", unary: true },
  { value: "gt", label: "is greater than" },
  { value: "gte", label: "is at least" },
  { value: "lt", label: "is less than" },
  { value: "lte", label: "is at most" },
];

export type RightType = "text" | "number" | "boolean";

/** A condition as the form holds it. `equals` is strict, so the type of the right side is the author's to state. */
export interface ConditionDraft {
  left: string;
  op: WorkflowConditionOp;
  right: string;
  rightType: RightType;
}

export type LoopDraft =
  | { kind: "forEach"; source: string; maxItems: string }
  | { kind: "until"; condition: ConditionDraft; maxIterations: string; onExhausted: "fail" | "continue" };

export interface StepDraft {
  key: string;
  name: string;
  stepType: WorkflowStepType;
  agentId: string;
  deploymentId: string;
  modelId: string;
  knowledgeBaseId: string;
  promptTemplate: string;
  outputFormat: "text" | "json";
  condition: ConditionDraft | null;
  loop: LoopDraft | null;
  onError: "fail" | "continue" | "fallback";
  fallbackAgentId: string;
  maxRetries: string;
  timeoutSeconds: string;
  /** Keys of the steps this one waits for. */
  dependsOn: string[];
  /** Edited as JSON text; kept verbatim so a legacy mapping is not lost. */
  inputMapping: string;
  outputMapping: string;
  position: { x: number; y: number };
}

export interface WorkflowDraft {
  name: string;
  description: string;
  executionMode: WorkflowExecutionMode;
  maxConcurrency: string;
  timeoutSeconds: string;
  retryMaxRetries: string;
  retryBackoffMs: string;
  inputSchema: string;
  outputSchema: string;
  steps: StepDraft[];
  viewport: { x: number; y: number; zoom: number };
}

export interface DraftIssue {
  message: string;
  /** Key of the step at fault, when there is one. */
  stepKey?: string;
  field?: string;
}

let keyCounter = 0;
export function newStepKey(): string {
  keyCounter += 1;
  return `step_${Date.now().toString(36)}_${keyCounter}`;
}

export function emptyCondition(): ConditionDraft {
  return { left: "", op: "equals", right: "", rightType: "text" };
}

export function newStep(existing: StepDraft[], position: { x: number; y: number }): StepDraft {
  const taken = new Set(existing.map((s) => s.name));
  let n = existing.length + 1;
  while (taken.has(`step ${n}`)) n += 1;
  return {
    key: newStepKey(),
    name: `step ${n}`,
    stepType: "agent",
    agentId: "",
    deploymentId: "",
    modelId: "",
    knowledgeBaseId: "",
    promptTemplate: "",
    outputFormat: "text",
    condition: null,
    loop: null,
    onError: "fail",
    fallbackAgentId: "",
    maxRetries: "0",
    timeoutSeconds: "",
    dependsOn: [],
    inputMapping: "",
    outputMapping: "",
    position,
  };
}

export function emptyDraft(): WorkflowDraft {
  return {
    name: "",
    description: "",
    executionMode: "parallel",
    maxConcurrency: "5",
    timeoutSeconds: "600",
    retryMaxRetries: "",
    retryBackoffMs: "",
    inputSchema: "",
    outputSchema: "",
    steps: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

/**
 * Dependency depth of every step (0 for a step with no dependencies). A
 * step inside a cycle gets the depth reached before the cycle closed; the
 * server reports the cycle itself.
 */
export function stepLevels(steps: Array<Pick<StepDraft, "key" | "dependsOn">>): Map<string, number> {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (key: string): number => {
    const known = levels.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const step = byKey.get(key);
    let level = 0;
    for (const dep of step?.dependsOn ?? []) {
      if (byKey.has(dep)) level = Math.max(level, depth(dep) + 1);
    }
    visiting.delete(key);
    levels.set(key, level);
    return level;
  };
  for (const step of steps) depth(step.key);
  return levels;
}

/** Every step `key` transitively depends on. */
export function ancestorsOf(steps: StepDraft[], key: string): Set<string> {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const seen = new Set<string>();
  const walk = (current: string) => {
    for (const dep of byKey.get(current)?.dependsOn ?? []) {
      if (seen.has(dep) || dep === key) continue;
      seen.add(dep);
      walk(dep);
    }
  };
  walk(key);
  return seen;
}

/** True when making `to` depend on `from` would close a loop. */
export function wouldCycle(steps: StepDraft[], from: string, to: string): boolean {
  return from === to || ancestorsOf(steps, from).has(to);
}

/**
 * The order steps run in, as the server plans it: by dependency level,
 * and within a level in the order listed.
 */
export function runOrder(steps: StepDraft[]): StepDraft[] {
  const levels = stepLevels(steps);
  return steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => (levels.get(a.step.key)! - levels.get(b.step.key)!) || a.index - b.index)
    .map((entry) => entry.step);
}

/**
 * The steps whose output `key` may read: its ancestors in parallel mode
 * (nothing else is guaranteed to have finished), every earlier step in the
 * one-at-a-time modes. The same rule the server enforces.
 */
export function readableSteps(draft: WorkflowDraft, key: string): StepDraft[] {
  if (draft.executionMode === "parallel") {
    const ancestors = ancestorsOf(draft.steps, key);
    return draft.steps.filter((s) => ancestors.has(s.key));
  }
  const order = runOrder(draft.steps);
  const at = order.findIndex((s) => s.key === key);
  return at <= 0 ? [] : order.slice(0, at);
}

/**
 * Positions for steps laid out by dependency level, left to right. In a
 * one-at-a-time mode with no dependencies drawn, the steps form a single
 * row in run order, which is how they execute.
 */
export function autoLayout(
  steps: Array<Pick<StepDraft, "key" | "dependsOn">>,
  mode: WorkflowExecutionMode
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const hasEdges = steps.some((s) => s.dependsOn.length > 0);
  if (!hasEdges && mode !== "parallel") {
    steps.forEach((step, index) => {
      positions.set(step.key, { x: 40 + index * (NODE_WIDTH + COLUMN_GAP), y: 60 });
    });
    return positions;
  }
  const levels = stepLevels(steps);
  const rows = new Map<number, number>();
  for (const step of steps) {
    const level = levels.get(step.key) ?? 0;
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    positions.set(step.key, {
      x: 40 + level * (NODE_WIDTH + COLUMN_GAP),
      y: 60 + row * (NODE_HEIGHT + ROW_GAP),
    });
  }
  return positions;
}

/** A free spot for a new step: to the right of everything on the canvas. */
export function nextPosition(steps: StepDraft[]): { x: number; y: number } {
  if (steps.length === 0) return { x: 40, y: 60 };
  const right = Math.max(...steps.map((s) => s.position.x));
  const column = steps.filter((s) => s.position.x === right);
  const bottom = Math.max(...column.map((s) => s.position.y));
  return column.length >= 4
    ? { x: right + NODE_WIDTH + COLUMN_GAP, y: 60 }
    : { x: right, y: bottom + NODE_HEIGHT + ROW_GAP };
}

// ---------------------------------------------------------------------------
// Renaming
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteReferences(text: string, from: string, to: string): string {
  if (!text) return text;
  // `steps.<name>.` inside {{ }} or after `$.`; the trailing dot keeps a
  // step called "a" from matching "ab".
  return text.replace(new RegExp(`(\\bsteps\\.)${escapeRegExp(from)}(\\.)`, "g"), `$1${to}$2`);
}

function rewriteCondition(condition: ConditionDraft | null, from: string, to: string): ConditionDraft | null {
  if (!condition) return condition;
  return {
    ...condition,
    left: rewriteReferences(condition.left, from, to),
    right: rewriteReferences(condition.right, from, to),
  };
}

/**
 * Renames a step and, when the old name was unambiguous, the references
 * other steps make to it, so a rename does not silently break a prompt.
 */
export function renameStep(draft: WorkflowDraft, key: string, name: string): WorkflowDraft {
  const target = draft.steps.find((s) => s.key === key);
  if (!target || target.name === name) return draft;
  const from = target.name;
  const unambiguous =
    from !== "" && name !== "" && draft.steps.filter((s) => s.name === from).length === 1;
  return {
    ...draft,
    steps: draft.steps.map((step) => {
      const renamed = step.key === key ? { ...step, name } : step;
      if (!unambiguous) return renamed;
      const loop = renamed.loop;
      return {
        ...renamed,
        promptTemplate: rewriteReferences(renamed.promptTemplate, from, name),
        inputMapping: rewriteReferences(renamed.inputMapping, from, name),
        outputMapping: rewriteReferences(renamed.outputMapping, from, name),
        condition: rewriteCondition(renamed.condition, from, name),
        loop:
          loop === null
            ? null
            : loop.kind === "forEach"
              ? { ...loop, source: rewriteReferences(loop.source, from, name) }
              : { ...loop, condition: rewriteCondition(loop.condition, from, name)! },
      };
    }),
  };
}

export function removeStep(draft: WorkflowDraft, key: string): WorkflowDraft {
  return {
    ...draft,
    steps: draft.steps
      .filter((s) => s.key !== key)
      .map((s) => (s.dependsOn.includes(key) ? { ...s, dependsOn: s.dependsOn.filter((d) => d !== key) } : s)),
  };
}

// ---------------------------------------------------------------------------
// Draft <-> definition
// ---------------------------------------------------------------------------

function conditionToDraft(condition: WorkflowCondition | null | undefined): ConditionDraft | null {
  if (!condition) return null;
  const right = condition.right;
  const rightType: RightType =
    typeof right === "number" ? "number" : typeof right === "boolean" ? "boolean" : "text";
  return {
    left: typeof condition.left === "string" ? condition.left : JSON.stringify(condition.left ?? ""),
    op: condition.op,
    right:
      right === undefined || right === null
        ? ""
        : typeof right === "string"
          ? right
          : JSON.stringify(right),
    rightType,
  };
}

function conditionFromDraft(condition: ConditionDraft): WorkflowCondition {
  const unary = CONDITION_OPS.find((o) => o.value === condition.op)?.unary;
  if (unary) return { left: condition.left.trim(), op: condition.op };
  let right: unknown = condition.right;
  if (condition.rightType === "number") {
    const n = Number(condition.right);
    right = Number.isFinite(n) && condition.right.trim() !== "" ? n : condition.right;
  } else if (condition.rightType === "boolean") {
    right = condition.right.trim().toLowerCase() === "true";
  }
  return { left: condition.left.trim(), op: condition.op, right };
}

function loopToDraft(loop: WorkflowLoop | null | undefined): LoopDraft | null {
  if (!loop) return null;
  if ("forEach" in loop) {
    return { kind: "forEach", source: loop.forEach, maxItems: loop.maxItems ? String(loop.maxItems) : "" };
  }
  return {
    kind: "until",
    condition: conditionToDraft(loop.until) ?? emptyCondition(),
    maxIterations: String(loop.maxIterations),
    onExhausted: loop.onExhausted ?? "fail",
  };
}

function jsonText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && Object.keys(value as object).length === 0) return "";
  return JSON.stringify(value, null, 2);
}

export function draftFromWorkflow(workflow: OrchestrationDetail): WorkflowDraft {
  const ordered = [...workflow.steps].sort((a, b) => a.stepOrder - b.stepOrder);
  const keyByName = new Map<string, string>();
  for (const step of ordered) keyByName.set(step.name, newStepKey());

  const partial = ordered.map((step: OrchestrationStep) => ({
    key: keyByName.get(step.name)!,
    dependsOn: (step.dependsOn ?? [])
      .map((name) => keyByName.get(name))
      .filter((k): k is string => Boolean(k)),
  }));
  const fallback = autoLayout(partial, workflow.executionMode);
  const stored = workflow.layout?.positions ?? {};

  const steps: StepDraft[] = ordered.map((step, index) => ({
    key: partial[index]!.key,
    name: step.name,
    stepType: step.stepType ?? "agent",
    agentId: step.agentId ?? "",
    deploymentId: step.deploymentId ?? "",
    modelId: step.modelId ?? "",
    knowledgeBaseId: step.knowledgeBaseId ?? "",
    promptTemplate: step.promptTemplate ?? "",
    outputFormat: step.outputFormat ?? "text",
    condition: conditionToDraft(step.condition),
    loop: loopToDraft(step.loop),
    onError: step.onError ?? "fail",
    fallbackAgentId: step.fallbackAgentId ?? "",
    maxRetries: String(step.maxRetries ?? 0),
    timeoutSeconds: step.timeoutMs ? String(Math.round(step.timeoutMs / 1000)) : "",
    dependsOn: partial[index]!.dependsOn,
    inputMapping: jsonText(step.inputMapping),
    outputMapping: jsonText(step.outputMapping),
    position: stored[step.name] ?? fallback.get(partial[index]!.key) ?? { x: 40, y: 60 },
  }));

  return {
    name: workflow.name,
    description: workflow.description ?? "",
    executionMode: workflow.executionMode,
    maxConcurrency: String(workflow.maxConcurrency ?? 5),
    timeoutSeconds: String(Math.round((workflow.timeout ?? 600_000) / 1000)),
    retryMaxRetries:
      workflow.retryPolicy?.maxRetries !== undefined ? String(workflow.retryPolicy.maxRetries) : "",
    retryBackoffMs:
      workflow.retryPolicy?.backoffMs !== undefined ? String(workflow.retryPolicy.backoffMs) : "",
    inputSchema: jsonText(workflow.inputSchema),
    outputSchema: jsonText(workflow.outputSchema),
    steps,
    viewport: workflow.layout?.viewport ?? { x: 0, y: 0, zoom: 1 },
  };
}

function parseJsonObject(text: string): { ok: true; value: Record<string, unknown> | undefined } | { ok: false } {
  if (text.trim() === "") return { ok: true, value: undefined };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function wholeNumber(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  return Number(text.trim());
}

function checkCondition(
  condition: ConditionDraft,
  what: string,
  stepKey: string,
  field: string,
  issues: DraftIssue[]
): void {
  if (condition.left.trim() === "") {
    issues.push({ message: `${what} needs something to test, for example $.steps.<name>.output`, stepKey, field });
  }
  const unary = CONDITION_OPS.find((o) => o.value === condition.op)?.unary;
  if (!unary && condition.rightType === "number" && !Number.isFinite(Number(condition.right || "x"))) {
    issues.push({ message: `${what} compares against a number, but "${condition.right}" is not one`, stepKey, field });
  }
}

/**
 * What the form itself can tell is wrong, before the server is asked:
 * missing required values, numbers out of range, JSON that does not parse.
 * The server's plan check then covers what needs the whole graph.
 */
export function localIssues(draft: WorkflowDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const name = draft.name.trim();
  if (name === "") issues.push({ message: "Give the workflow a name", field: "name" });
  else if (name.length > 80) issues.push({ message: "The workflow name is at most 80 characters", field: "name" });
  if (draft.description.length > 500) {
    issues.push({ message: "The description is at most 500 characters", field: "description" });
  }

  const concurrency = wholeNumber(draft.maxConcurrency);
  if (concurrency === null || concurrency < 1 || concurrency > LIMITS.maxConcurrency) {
    issues.push({ message: `Steps at once must be 1 to ${LIMITS.maxConcurrency}`, field: "maxConcurrency" });
  }
  const timeout = wholeNumber(draft.timeoutSeconds);
  if (timeout === null || timeout < LIMITS.minTimeoutSeconds || timeout > LIMITS.maxTimeoutSeconds) {
    issues.push({
      message: `The run time limit must be ${LIMITS.minTimeoutSeconds} to ${LIMITS.maxTimeoutSeconds} seconds`,
      field: "timeout",
    });
  }
  if (draft.retryMaxRetries.trim() !== "") {
    const retries = wholeNumber(draft.retryMaxRetries);
    if (retries === null || retries > LIMITS.maxRetries) {
      issues.push({ message: `Default retries must be 0 to ${LIMITS.maxRetries}`, field: "retryPolicy" });
    }
  }
  if (draft.retryBackoffMs.trim() !== "") {
    const backoff = wholeNumber(draft.retryBackoffMs);
    if (backoff === null || backoff > LIMITS.maxBackoffMs) {
      issues.push({ message: `Retry wait must be 0 to ${LIMITS.maxBackoffMs} ms`, field: "retryPolicy" });
    }
  }
  for (const field of ["inputSchema", "outputSchema"] as const) {
    if (!parseJsonObject(draft[field]).ok) {
      issues.push({ message: `The ${field === "inputSchema" ? "input" : "output"} schema is not a JSON object`, field });
    }
  }

  if (draft.steps.length === 0) issues.push({ message: "Add at least one step", field: "steps" });
  if (draft.steps.length > LIMITS.maxSteps) {
    issues.push({ message: `A workflow has at most ${LIMITS.maxSteps} steps`, field: "steps" });
  }

  const seen = new Map<string, number>();
  for (const step of draft.steps) seen.set(step.name, (seen.get(step.name) ?? 0) + 1);

  for (const step of draft.steps) {
    const at = (message: string, field: string) => issues.push({ message, stepKey: step.key, field });
    const label = step.name || "(unnamed step)";
    if (step.name === "") at("A step needs a name", "name");
    else if (step.name.length > 64) at(`Step "${label}": the name is at most 64 characters`, "name");
    else if (/[.{}|]/.test(step.name)) at(`Step "${label}": names cannot contain . { } or |`, "name");
    else if (step.name !== step.name.trim()) at(`Step "${label}": the name cannot start or end with a space`, "name");
    else if ((seen.get(step.name) ?? 0) > 1) at(`Two steps are named "${label}"`, "name");

    if (step.stepType === "agent" && !step.agentId) at(`Step "${label}": choose an agent`, "agentId");
    if (step.stepType === "model" && !step.deploymentId) at(`Step "${label}": choose a deployment`, "deploymentId");
    if (step.stepType === "retrieval" && !step.knowledgeBaseId) {
      at(`Step "${label}": choose a knowledge base`, "knowledgeBaseId");
    }
    if (step.promptTemplate.length > LIMITS.maxPromptChars) {
      at(`Step "${label}": the prompt is at most ${LIMITS.maxPromptChars} characters`, "promptTemplate");
    }
    if (step.onError === "fallback" && !step.fallbackAgentId) {
      at(`Step "${label}": choose the fallback agent`, "fallbackAgentId");
    }
    const retries = wholeNumber(step.maxRetries);
    if (retries === null || retries > LIMITS.maxRetries) {
      at(`Step "${label}": retries must be 0 to ${LIMITS.maxRetries}`, "maxRetries");
    }
    if (step.timeoutSeconds.trim() !== "") {
      const seconds = wholeNumber(step.timeoutSeconds);
      if (
        seconds === null ||
        seconds < LIMITS.minStepTimeoutSeconds ||
        seconds > LIMITS.maxStepTimeoutSeconds
      ) {
        at(
          `Step "${label}": the time limit must be ${LIMITS.minStepTimeoutSeconds} to ${LIMITS.maxStepTimeoutSeconds} seconds`,
          "timeoutMs"
        );
      }
    }
    if (step.condition) checkCondition(step.condition, `Step "${label}": the run-only-if rule`, step.key, "condition", issues);
    if (step.loop?.kind === "forEach") {
      if (!step.loop.source.trim().startsWith("$.")) {
        at(`Step "${label}": the list to loop over must be a reference such as $.steps.<name>.output`, "loop");
      }
      if (step.loop.maxItems.trim() !== "") {
        const max = wholeNumber(step.loop.maxItems);
        if (max === null || max < 1 || max > LIMITS.maxForEachItems) {
          at(`Step "${label}": the item limit must be 1 to ${LIMITS.maxForEachItems}`, "loop");
        }
      }
    }
    if (step.loop?.kind === "until") {
      checkCondition(step.loop.condition, `Step "${label}": the repeat-until rule`, step.key, "loop", issues);
      const max = wholeNumber(step.loop.maxIterations);
      if (max === null || max < 1 || max > LIMITS.maxUntilIterations) {
        at(`Step "${label}": passes must be 1 to ${LIMITS.maxUntilIterations}`, "loop");
      }
    }
    for (const field of ["inputMapping", "outputMapping"] as const) {
      if (!parseJsonObject(step[field]).ok) at(`Step "${label}": ${field} is not a JSON object`, field);
    }
  }
  return issues;
}

/**
 * The definition the API takes. Call only when localIssues() is empty;
 * values that would not parse are sent as typed so the server names them.
 */
export function definitionFromDraft(draft: WorkflowDraft): WorkflowDefinitionInput {
  const nameByKey = new Map(draft.steps.map((s) => [s.key, s.name]));
  const positions: NonNullable<WorkflowLayout["positions"]> = {};
  for (const step of draft.steps) {
    positions[step.name] = { x: Math.round(step.position.x), y: Math.round(step.position.y) };
  }

  const steps: WorkflowStepInput[] = draft.steps.map((step) => {
    const out: WorkflowStepInput = {
      name: step.name,
      stepType: step.stepType,
      onError: step.onError,
      maxRetries: wholeNumber(step.maxRetries) ?? 0,
      timeoutMs: step.timeoutSeconds.trim() === "" ? null : (wholeNumber(step.timeoutSeconds) ?? 0) * 1000,
      dependsOn: step.dependsOn.map((k) => nameByKey.get(k)).filter((n): n is string => n !== undefined),
      promptTemplate: step.promptTemplate.trim() === "" ? null : step.promptTemplate,
      condition: step.condition ? conditionFromDraft(step.condition) : null,
    };
    if (step.stepType === "agent") out.agentId = step.agentId || null;
    if (step.stepType === "model") {
      out.deploymentId = step.deploymentId || null;
      if (step.modelId.trim() !== "") out.modelId = step.modelId.trim();
    }
    if (step.stepType === "retrieval") out.knowledgeBaseId = step.knowledgeBaseId || null;
    else out.outputFormat = step.outputFormat;
    if (step.fallbackAgentId && step.stepType !== "retrieval") out.fallbackAgentId = step.fallbackAgentId;

    if (step.loop?.kind === "forEach") {
      const max = wholeNumber(step.loop.maxItems);
      out.loop = { forEach: step.loop.source.trim(), ...(max !== null ? { maxItems: max } : {}) };
    } else if (step.loop?.kind === "until") {
      out.loop = {
        until: conditionFromDraft(step.loop.condition),
        maxIterations: wholeNumber(step.loop.maxIterations) ?? 0,
        onExhausted: step.loop.onExhausted,
      };
    } else {
      out.loop = null;
    }

    const inputMapping = parseJsonObject(step.inputMapping);
    if (inputMapping.ok && inputMapping.value) out.inputMapping = inputMapping.value;
    const outputMapping = parseJsonObject(step.outputMapping);
    if (outputMapping.ok && outputMapping.value) out.outputMapping = outputMapping.value;
    return out;
  });

  const definition: WorkflowDefinitionInput = {
    name: draft.name.trim(),
    description: draft.description.trim() === "" ? null : draft.description,
    executionMode: draft.executionMode,
    maxConcurrency: wholeNumber(draft.maxConcurrency) ?? 5,
    timeout: (wholeNumber(draft.timeoutSeconds) ?? 600) * 1000,
    layout: { positions, viewport: draft.viewport },
    steps,
  };

  const retries = wholeNumber(draft.retryMaxRetries);
  const backoff = wholeNumber(draft.retryBackoffMs);
  if (retries !== null || backoff !== null) {
    definition.retryPolicy = {
      ...(retries !== null ? { maxRetries: retries } : {}),
      ...(backoff !== null ? { backoffMs: backoff } : {}),
    };
  }
  const inputSchema = parseJsonObject(draft.inputSchema);
  if (inputSchema.ok && inputSchema.value) definition.inputSchema = inputSchema.value;
  const outputSchema = parseJsonObject(draft.outputSchema);
  if (outputSchema.ok && outputSchema.value) definition.outputSchema = outputSchema.value;
  return definition;
}

/**
 * The definition with the canvas left out: what decides whether a save is
 * needed for the engine's sake, and what the plan check depends on.
 */
export function planSignature(definition: WorkflowDefinitionInput): string {
  return JSON.stringify({ ...definition, layout: undefined });
}

/** Top-level properties declared by a workflow's input schema, for the variable chips. */
export function inputSchemaProperties(schemaText: string): string[] {
  const parsed = parseJsonObject(schemaText);
  if (!parsed.ok || !parsed.value) return [];
  const properties = parsed.value.properties;
  if (typeof properties !== "object" || properties === null) return [];
  return Object.keys(properties).filter((k) => /^[^.{}|\s]+$/.test(k));
}

export interface VariableChip {
  /** Inserted into a prompt template. */
  template: string;
  /** The same value as a `$.` reference, for conditions and loop sources. */
  reference: string;
  label: string;
}

/** What a step may read, as insertable variables. */
export function variablesFor(draft: WorkflowDraft, key: string): VariableChip[] {
  const step = draft.steps.find((s) => s.key === key);
  const chips: VariableChip[] = [
    { template: "{{input.prompt}}", reference: "$.input.prompt", label: "run prompt" },
  ];
  for (const property of inputSchemaProperties(draft.inputSchema)) {
    if (property === "prompt") continue;
    chips.push({ template: `{{input.${property}}}`, reference: `$.input.${property}`, label: `input.${property}` });
  }
  const readable = readableSteps(draft, key);
  if (readable.length > 0 && draft.executionMode !== "parallel") {
    chips.push({ template: "{{previous.output}}", reference: "$.previous.output", label: "previous step" });
  }
  for (const other of readable) {
    if (other.name === "") continue;
    chips.push({
      template: `{{steps.${other.name}.output}}`,
      reference: `$.steps.${other.name}.output`,
      label: other.name,
    });
  }
  if (step?.loop?.kind === "forEach") {
    chips.push({ template: "{{item}}", reference: "$.item", label: "loop item" });
    chips.push({ template: "{{index}}", reference: "$.index", label: "loop index" });
  }
  if (step?.loop?.kind === "until") {
    chips.push({ template: "{{iteration}}", reference: "$.iteration", label: "pass number" });
  }
  return chips;
}
