/**
 * Orchestration data mapping + conditions (W2).
 *
 * Steps wire into each other through DATA, never code. A step's
 * `inputMapping` says where each of its inputs comes from, and its
 * `condition` says whether it should run at all — both are declarative
 * structures this module interprets.
 *
 * THIS IS DELIBERATELY NOT AN EXPRESSION EVALUATOR. The test runner
 * shipped a `new Function(userScript)` assertion that was remote code
 * execution for any authenticated user (Wave 1 closed it); an
 * orchestration engine that evaluated user-supplied expressions would
 * reintroduce exactly that hole with a friendlier name. Anything not
 * expressible here is a feature request, not a reason to reach for eval.
 *
 * Reference syntax (strings beginning with `$.`):
 *   $.input                     the whole run input
 *   $.input.foo.bar             a path into the run input
 *   $.steps.<stepName>.output   another step's output
 *   $.steps.<stepName>.output.x a path into it
 *   $.previous.output           the previous step's output (pipeline)
 *
 * A string without the `$.` prefix is a literal, so plain prompts need no
 * escaping. An unresolvable reference yields `undefined` rather than
 * throwing — the step then fails on its own missing input with a message
 * naming the reference, which is far easier to debug than a mapping-layer
 * stack trace.
 */

export interface MappingContext {
  input: Record<string, unknown>;
  /** Completed step outputs, keyed by step name. */
  steps: Record<string, { output: unknown }>;
  /** Output of the immediately preceding step, if any. */
  previous?: { output: unknown };
}

const REFERENCE_PREFIX = "$.";

function readPath(root: unknown, path: string[]): unknown {
  let current = root;
  for (const key of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Resolves a single value: a `$.` reference against the context, or the
 * literal itself. Nested objects/arrays are resolved recursively so a
 * mapping can build a structured payload.
 */
export function resolveValue(value: unknown, ctx: MappingContext): unknown {
  if (typeof value === "string") {
    if (!value.startsWith(REFERENCE_PREFIX)) return value;
    const [head, ...rest] = value.slice(REFERENCE_PREFIX.length).split(".");

    if (head === "input") return readPath(ctx.input, rest);
    if (head === "previous") {
      if (!ctx.previous) return undefined;
      // $.previous.output[.path]
      const [field, ...tail] = rest;
      if (field !== "output") return undefined;
      return readPath(ctx.previous.output, tail);
    }
    if (head === "steps") {
      const [stepName, field, ...tail] = rest;
      if (!stepName) return undefined;
      const step = ctx.steps[stepName];
      if (!step) return undefined;
      if (field !== "output") return undefined;
      return readPath(step.output, tail);
    }
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, ctx));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, ctx);
    }
    return out;
  }
  return value;
}

export function applyInputMapping(
  mapping: unknown,
  ctx: MappingContext,
): Record<string, unknown> {
  if (mapping === null || mapping === undefined || typeof mapping !== "object") {
    return {};
  }
  return resolveValue(mapping, ctx) as Record<string, unknown>;
}

/**
 * Builds the prompt a step sends to its agent.
 *
 * Precedence: an explicit `prompt` in the resolved input mapping wins.
 * Otherwise `pipeline` mode chains the previous step's output, and the
 * first step falls back to the run input's `prompt`/`input`. When none of
 * those exist the step has nothing to say, and returning null lets the
 * engine fail it with a specific message instead of invoking a model with
 * an empty string.
 */
export function resolveStepPrompt(
  resolvedInput: Record<string, unknown>,
  ctx: MappingContext,
  mode: string,
): string | null {
  const explicit = resolvedInput.prompt;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit;
  }
  if (typeof explicit === "object" && explicit !== null) {
    return JSON.stringify(explicit);
  }

  if (mode === "pipeline" && ctx.previous !== undefined) {
    const prev = ctx.previous.output;
    if (typeof prev === "string" && prev.trim().length > 0) return prev;
    if (prev !== undefined && prev !== null) return JSON.stringify(prev);
  }

  const runPrompt = ctx.input.prompt ?? ctx.input.input;
  if (typeof runPrompt === "string" && runPrompt.trim().length > 0) {
    return runPrompt;
  }
  return null;
}

/**
 * Applies a step's outputMapping onto the shared context object.
 * `{"answer": "$.steps.classify.output"}` writes `answer` into the run
 * output. With no mapping the step's raw output is kept under its name,
 * which is what `$.steps.<name>.output` reads.
 */
export function applyOutputMapping(
  mapping: unknown,
  ctx: MappingContext,
): Record<string, unknown> {
  if (mapping === null || mapping === undefined || typeof mapping !== "object") {
    return {};
  }
  return resolveValue(mapping, ctx) as Record<string, unknown>;
}

// ============================================
// Conditions
// ============================================

export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "exists"
  | "not_exists"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export interface ConditionSpec {
  left: unknown;
  op: ConditionOperator;
  right?: unknown;
}

function asComparable(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Evaluates a step's `condition`. No condition ⇒ the step runs.
 *
 * An INVALID condition returns false (skip) rather than true: a
 * malformed gate must not silently let a step run that the author
 * intended to guard.
 */
export function evaluateCondition(
  condition: unknown,
  ctx: MappingContext,
): { run: boolean; reason?: string } {
  if (condition === null || condition === undefined) return { run: true };
  if (typeof condition !== "object") {
    return { run: false, reason: "condition is not an object" };
  }

  const spec = condition as Partial<ConditionSpec>;
  if (typeof spec.op !== "string") {
    return { run: false, reason: "condition is missing `op`" };
  }

  const left = resolveValue(spec.left, ctx);
  const right = resolveValue(spec.right, ctx);

  switch (spec.op) {
    case "exists":
      return { run: left !== undefined && left !== null };
    case "not_exists":
      return { run: left === undefined || left === null };
    case "equals":
      return { run: left === right };
    case "not_equals":
      return { run: left !== right };
    case "contains":
      return {
        run:
          typeof left === "string" && typeof right === "string"
            ? left.includes(right)
            : Array.isArray(left)
              ? left.includes(right)
              : false,
      };
    case "not_contains":
      return {
        run:
          typeof left === "string" && typeof right === "string"
            ? !left.includes(right)
            : Array.isArray(left)
              ? !left.includes(right)
              : false,
      };
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const l = asComparable(left);
      const r = asComparable(right);
      if (l === null || r === null) {
        return { run: false, reason: "non-numeric operand in a numeric comparison" };
      }
      if (spec.op === "gt") return { run: l > r };
      if (spec.op === "gte") return { run: l >= r };
      if (spec.op === "lt") return { run: l < r };
      return { run: l <= r };
    }
    default:
      return { run: false, reason: `unsupported condition operator: ${spec.op}` };
  }
}
