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
 *   $.item / $.index            the current item of a for-each loop
 *   $.iteration                 the current pass of an until loop (from 1)
 *
 * Prompt templates use the same references inside `{{ }}`, without the
 * `$.` prefix: `Summarize: {{steps.research.output}}`. A template is
 * substitution only: each `{{ }}` holds one reference and at most one
 * named filter, and anything else between the braces is left as text.
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
  /** Set while a for-each loop runs one of its items. */
  item?: unknown;
  index?: number;
  /** Set while an until loop runs; the first pass is 1. */
  iteration?: number;
}

const REFERENCE_PREFIX = "$.";

function readPath(root: unknown, path: string[]): unknown {
  let current = root;
  for (const key of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    // Own properties only: `constructor`, `__proto__` and the rest of the
    // prototype chain are not data the author put there.
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
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
    if (head === "item") return readPath(ctx.item, rest);
    if (head === "index") return rest.length === 0 ? ctx.index : undefined;
    if (head === "iteration") return rest.length === 0 ? ctx.iteration : undefined;
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

// ============================================
// References and prompt templates
// ============================================

export type ReferenceKind =
  | "input"
  | "steps"
  | "previous"
  | "item"
  | "index"
  | "iteration";

export interface Reference {
  kind: ReferenceKind;
  /** The step named by a `steps.<name>` reference. */
  step?: string;
  /** The reference as written, without `$.` or braces. */
  raw: string;
}

const REFERENCE_HEADS = new Set<string>([
  "input",
  "steps",
  "previous",
  "item",
  "index",
  "iteration",
]);

const TEMPLATE_FILTERS = new Set(["json"]);

/** `{{ ... }}` with no nested braces; anything else is plain text. */
const TEMPLATE_TOKEN = /\{\{([^{}]*)\}\}/g;

export class PromptTemplateError extends Error {}

function parseReference(expression: string): Reference | null {
  const [head, ...rest] = expression.split(".");
  if (!head || !REFERENCE_HEADS.has(head)) return null;
  if (rest.some((segment) => segment.length === 0)) return null;
  if (head === "steps") {
    // steps.<name>.output[.path] is the only readable shape.
    if (rest.length < 2 || rest[1] !== "output") return null;
    return { kind: "steps", step: rest[0], raw: expression };
  }
  if (head === "previous" && rest[0] !== "output") return null;
  if ((head === "index" || head === "iteration") && rest.length > 0) return null;
  return { kind: head as ReferenceKind, raw: expression };
}

interface TemplateToken {
  reference: Reference;
  filter: string | null;
}

/**
 * Reads one `{{ }}` body. Null means "not a reference": the braces are
 * left in the prompt untouched, so text that merely looks like code
 * (`{{constructor.constructor('x')()}}`) is never interpreted.
 */
function parseTemplateToken(body: string): TemplateToken | null {
  const [expression = "", ...filters] = body.split("|").map((part) => part.trim());
  const reference = parseReference(expression);
  if (!reference) return null;
  if (filters.length > 1) {
    throw new PromptTemplateError(
      `template reference "{{${body.trim()}}}" has more than one filter`,
    );
  }
  const filter = filters[0] ?? null;
  if (filter !== null && !TEMPLATE_FILTERS.has(filter)) {
    throw new PromptTemplateError(
      `unknown template filter "${filter}" in "{{${body.trim()}}}" (supported: json)`,
    );
  }
  return { reference, filter };
}

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Fills a prompt template from the run context.
 *
 * Substitution goes through resolveValue, the same reader the mappings
 * use, so a template can read exactly what a mapping can and nothing is
 * ever evaluated. A reference that resolves to nothing renders as an
 * empty string and is listed in `missingRefs`, so the step record shows
 * which input was absent. The `json` filter renders a JSON literal
 * (strings quoted and escaped) for prompts that embed data.
 */
export function renderPromptTemplate(
  template: string,
  ctx: MappingContext,
): { text: string; missingRefs: string[] } {
  const missingRefs: string[] = [];
  const text = template.replace(TEMPLATE_TOKEN, (whole, body: string) => {
    const token = parseTemplateToken(body);
    if (!token) return whole;
    const value = resolveValue(`${REFERENCE_PREFIX}${token.reference.raw}`, ctx);
    if (value === undefined || value === null) missingRefs.push(token.reference.raw);
    if (token.filter === "json") return JSON.stringify(value ?? null);
    return renderValue(value);
  });
  return { text, missingRefs };
}

/** Every reference a prompt template makes. Throws on an unknown filter. */
export function collectTemplateReferences(template: string): Reference[] {
  const references: Reference[] = [];
  for (const match of template.matchAll(TEMPLATE_TOKEN)) {
    const token = parseTemplateToken(match[1] ?? "");
    if (token) references.push(token.reference);
  }
  return references;
}

/**
 * Every `$.` reference inside a mapping, condition or loop source, found
 * without resolving anything. A `$.` string that is not a readable
 * reference is reported with kind null so a save-time check can name it.
 */
export function collectReferences(
  value: unknown,
): Array<Reference | { kind: null; raw: string }> {
  if (typeof value === "string") {
    if (!value.startsWith(REFERENCE_PREFIX)) return [];
    const raw = value.slice(REFERENCE_PREFIX.length);
    return [parseReference(raw) ?? { kind: null, raw }];
  }
  if (Array.isArray(value)) return value.flatMap((v) => collectReferences(v));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((v) =>
      collectReferences(v),
    );
  }
  return [];
}

// ============================================
// Step output
// ============================================

export class StepOutputError extends Error {}

const CODE_FENCE = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/;

/**
 * Turns a step's raw text into the value later steps read. `text` keeps
 * the string. `json` parses it, after removing the code fence models
 * like to wrap JSON in, so `$.steps.x.output.field` can branch on it.
 * Invalid JSON is an error: a step that promised structure and returned
 * prose must fail rather than hand prose to a condition.
 */
export function parseStepOutput(content: string, format: string): unknown {
  if (format !== "json") return content;
  const trimmed = content.trim();
  const fenced = CODE_FENCE.exec(trimmed);
  const body = fenced ? (fenced[1] ?? "").trim() : trimmed;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new StepOutputError(
      `output is not valid JSON (outputFormat is json): ${body.slice(0, 120)}`,
    );
  }
}

/**
 * Builds the prompt a step sends when it has no prompt template.
 *
 * Precedence: an explicit `prompt` in the resolved input mapping wins.
 * Otherwise `pipeline` mode chains the previous step's output. Otherwise
 * the step gets the run input's `prompt`/`input`; that last fallback
 * applies to EVERY step, not only the first, so a sequential workflow
 * with no templates or mappings sends the same run prompt to each step.
 * When none of those exist the step has nothing to say, and returning
 * null lets the engine fail it with a specific message instead of
 * invoking a model with an empty string.
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
