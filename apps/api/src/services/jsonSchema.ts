/**
 * JSON Schema written by users: an offering's input schema, and the
 * `json_schema` deliverable check and test assertion.
 *
 * The schema comes from a publisher and the data it validates from a buyer
 * (or from a model), so both sides are untrusted and validation runs inside
 * the API process. What keeps that bounded:
 *
 *   - `pattern` and `patternProperties` are matched by the linear-time engine
 *     (services/safeRegex.ts), never by `new RegExp`. A pattern RE2 cannot
 *     express fails the compile with its reason.
 *   - a schema is refused when it is over MAX_SCHEMA_BYTES, nests deeper than
 *     MAX_SCHEMA_DEPTH, has more than MAX_SUBSCHEMAS subschemas (compiling
 *     is quadratic in them), refers to anything outside itself (only "#..."
 *     references resolve; nothing is ever fetched), or asks for `uniqueItems`
 *     over objects or arrays with no `maxItems` (a quadratic deep comparison).
 *   - data nested deeper than MAX_DATA_DEPTH is refused before the validator
 *     (which recurses) sees it.
 *   - formats are ajv-formats' "fast" set, minus the ones that compile the
 *     DATA as a regular expression.
 *   - the first error stops validation (allErrors off), so a hostile document
 *     cannot make the validator enumerate thousands of failures.
 *   - ONE VALIDATION HAS A TOTAL WORK BUDGET. Each of the limits above bounds
 *     one thing; none bounds their product. A 3 KB schema whose definitions
 *     each apply the next one twice evaluates `{}` 2^45 times, and forty
 *     patterns over thirty strings are twelve hundred matches that are each
 *     inside the per-match limit. So every subschema carries a private
 *     keyword (WORK_KEYWORD) that is evaluated before anything else in it and
 *     charges the validation's meter for what evaluating it against this
 *     value can cost; every pattern match draws its steps from the same
 *     meter. A validation that would pass MAX_VALIDATION_WORK or
 *     MAX_MATCH_STEPS is stopped and answers `validation_too_expensive`: it
 *     is never reported as valid, and never as an ordinary mismatch.
 *   - what can be known without the data is refused when the schema is
 *     compiled, so its author is told at save time: references that multiply
 *     past MAX_REFERENCE_FAN_OUT evaluations of one value or loop without
 *     descending into the data, patterns that compile to more than
 *     MAX_SCHEMA_PATTERN_INSTRUCTIONS together, a reference that does not
 *     lead to a subschema of this document, and a nested `$id` (which would
 *     move where "#/..." points).
 *
 * Compiled validators are kept in a bounded least-recently-used cache keyed
 * by the schema's hash; an evicted schema is also removed from ajv's own
 * cache, which otherwise grows with every schema ever compiled.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { _, Ajv, type ErrorObject, type KeywordCxt, type Options, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import { compileSafeRegex, MAX_MATCH_STEPS, UnsafeRegexError, type MatchBudget } from "./safeRegex.js";

export const MAX_SCHEMA_BYTES = 32 * 1024;
export const MAX_SCHEMA_DEPTH = 16;
/**
 * Subschemas in one schema, counting boolean ones and each name in a
 * dependency list: what ajv generates a branch of code for. Its compile
 * time grows with the square of this: 500 compile in about a tenth of a
 * second, the 2,000 that fit in MAX_SCHEMA_BYTES took one to four (and then
 * overflowed the stack).
 */
export const MAX_SUBSCHEMAS = 500;
export const MAX_DATA_DEPTH = 64;
/**
 * Units of work one validation may do (chargeWork says what a unit is).
 * The largest documents the API accepts cost about half of it against an
 * ordinary schema.
 */
export const MAX_VALIDATION_WORK = 1_000_000;
/** Instructions all the patterns of one schema may compile to, together. */
export const MAX_SCHEMA_PATTERN_INSTRUCTIONS = 20_000;
/** Schema evaluations one value may cause through references applied in place. */
export const MAX_REFERENCE_FAN_OUT = 10_000;
/** The keyword the work meter rides under. Refused in a schema a user writes. */
export const WORK_KEYWORD = "x-wheelsai-work";
export const VALIDATION_TOO_EXPENSIVE = "validation_too_expensive";
const DEFAULT_CACHE_ENTRIES = 200;

/** Formats whose check is a fixed, simple expression over the value. */
const FORMATS = [
  "date",
  "time",
  "date-time",
  "duration",
  "uri",
  "uri-reference",
  "url",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
] as const;

export interface SchemaIssue {
  /** JSON pointer into the schema or the data ("" = the root). */
  path: string;
  message: string;
}

export class JsonSchemaError extends Error {
  readonly code = "invalid_json_schema";
  constructor(readonly issues: SchemaIssue[]) {
    super(issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; "));
    this.name = "JsonSchemaError";
  }
}

export type SchemaValidation =
  | { valid: true; code?: undefined }
  | {
      valid: false;
      errors: SchemaIssue[];
      /**
       * Set when the validation was STOPPED at its work budget rather than
       * decided: the data was not shown to match, or not to match.
       */
      code?: typeof VALIDATION_TOO_EXPENSIVE;
    };

export interface CompiledSchema {
  validate(data: unknown): SchemaValidation;
}

export interface CompileOptions {
  /**
   * "object": the schema must describe an object (`type: "object"`), as a
   * form's input does. "any" (default): any schema object.
   */
  root?: "object" | "any";
}

// ajv-formats is CommonJS with both `module.exports` and `exports.default`
// set to the plugin; which one a default import yields depends on the loader.
type FormatsPlugin = (ajv: Ajv, options: { mode: "fast"; formats: string[]; keywords: boolean }) => Ajv;
const addFormats: FormatsPlugin =
  (addFormatsModule as unknown as { default?: FormatsPlugin }).default ??
  (addFormatsModule as unknown as FormatsPlugin);

/** The version of ajv that was actually loaded (the repo root hoists ajv 6). */
export function ajvVersion(): string {
  const require = createRequire(import.meta.url);
  return (require("ajv/package.json") as { version: string }).version;
}

// ============================================
// The work meter
// ============================================

interface Meter extends MatchBudget {
  workLeft: number;
}

// Module state, because ajv's generated code cannot be handed an argument.
// Validation is synchronous, so exactly one validation owns the meter between
// the two lines that set and clear it.
let meter: Meter | null = null;
/** Set while one schema compiles: what its patterns may still add up to. */
let patternAllowance: { left: number } | null = null;

/** Thrown through ajv's generated code to stop a validation. Never leaves this module. */
class OverBudget extends Error {}

function nodeCount(data: unknown): number {
  let count = 0;
  const stack: unknown[] = [data];
  while (stack.length > 0) {
    const node = stack.pop();
    count++;
    if (typeof node !== "object" || node === null) continue;
    for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push(child);
  }
  return count;
}

/**
 * WORK_KEYWORD's implementation: charges for one evaluation of one subschema
 * against one value, before any other keyword of that subschema runs. A unit
 * is roughly one comparison; the evaluation itself is one.
 *
 *   own        everything the subschema lists itself, each of which ajv may
 *              visit once per evaluation: the members of enum, const and
 *              required, the names in properties and the other keyword
 *              maps, the entries of allOf, anyOf, oneOf and a tuple's items
 *              (a boolean schema in such a list is no subschema of its own,
 *              so it is paid for here).
 *   keywords   how many keywords it has; on a string each may read it end
 *              to end (a format, a length), so a long string costs that many
 *              passes.
 *   names      entries in properties and patternProperties: on an object
 *              every key may be compared with every one of them
 *              (`additionalProperties: false`). Those are string
 *              comparisons in one generated expression, far cheaper than an
 *              evaluation, so sixteen of them make a unit.
 *   pairwise   1 for a `uniqueItems` that ajv checks by comparing every pair
 *              of items in depth.
 *
 * Subschemas that are objects are not counted here: each charges for itself
 * when it runs.
 */
function chargeWork(own: number, keywords: number, names: number, pairwise: number, data: unknown): void {
  // No meter: this is not running inside validate(). Refuse rather than run unmetered.
  if (meter === null) throw new OverBudget();
  let units = 1 + own;
  if (typeof data === "string") {
    units += keywords * (data.length >> 5);
  } else if (Array.isArray(data)) {
    units += data.length;
    if (pairwise === 1 && data.length > 1) units += (data.length * nodeCount(data)) / 2;
  } else if (typeof data === "object" && data !== null) {
    const keys = Object.keys(data).length;
    units += keys + ((keys * names) >> 4);
  }
  meter.workLeft -= units;
  if (meter.workLeft < 0) throw new OverBudget();
}

// ajv keys its pattern cache on `rx.toString()`. Two patterns whose engine
// objects print alike would share ONE compiled pattern, so every `pattern` in
// a schema would be checked against the first. Each engine object therefore
// prints its own pattern and flags.
const safeEngine = Object.assign(
  (pattern: string, _unicodeFlag: string) => {
    const compiled = compileSafeRegex(pattern);
    if (patternAllowance) {
      patternAllowance.left -= compiled.instructions;
      if (patternAllowance.left < 0) {
        throw new UnsafeRegexError(
          `the patterns in this schema compile to more than ${MAX_SCHEMA_PATTERN_INSTRUCTIONS.toLocaleString("en-US")} instructions together; use fewer of them or smaller repetition counts`,
        );
      }
    }
    return {
      // A match the meter cannot cover stops the validation. Answering
      // "no match" instead would report a mismatch nobody established.
      test: (value: string) => {
        const match = meter ? compiled.check(value, meter) : null;
        if (!match?.ok) throw new OverBudget();
        return match.matched;
      },
      toString: () => `safe-regex:${JSON.stringify(pattern)}`,
    };
  },
  // Only read when ajv generates standalone code, which this never does.
  { code: "safeRegexEngine" },
);

function ajvOptions(): Options {
  return {
    // Unknown keywords are refused: a typo ("requried") must not silently
    // validate nothing. The remaining strict checks reject schemas that are
    // valid JSON Schema, so they stay off.
    strictSchema: true,
    strictNumbers: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    allowUnionTypes: true,
    allErrors: false,
    validateFormats: true,
    // A schema's $id must not register it under a name another
    // organization's schema could collide with, or resolve to.
    addUsedSchema: false,
    // ajv logs the whole generated function when one fails to compile:
    // hundreds of kilobytes per request, chosen by whoever sent the schema.
    logger: false,
    code: { regExp: safeEngine },
  };
}

interface Engines {
  draft07: Ajv;
  draft2020: Ajv;
}

/**
 * Registers the meter and moves it ahead of every other keyword.
 *
 * The order is what makes the budget hold. ajv stops a subschema at its
 * first failing keyword, and `anyOf`, `oneOf`, `not`, `if` and `contains`
 * carry on after a branch fails; a meter that ran after the keyword that
 * failed would let a schema whose every evaluation fails run uncharged.
 * ajv evaluates its rule groups in order and has no public way to put a
 * keyword first, so the group list is edited - and checked: if a future ajv
 * arranges its rules differently this throws at first use instead of
 * quietly metering nothing. The failing `anyOf` fan-out in the unit tests
 * pins the behaviour itself.
 */
function meterFirst(ajv: Ajv): void {
  ajv.addKeyword({
    keyword: WORK_KEYWORD,
    schemaType: "array",
    // Generated as a plain call with the four numbers written into it; a
    // `validate` keyword would build a context object for every evaluation.
    code(cxt: KeywordCxt) {
      const charge = cxt.gen.scopeValue("func", { ref: chargeWork });
      const [own, keywords, names, pairwise] = cxt.schema as number[];
      cxt.gen.code(_`${charge}(${own}, ${keywords}, ${names}, ${pairwise}, ${cxt.data})`);
    },
  });
  const groups = ajv.RULES.rules;
  for (const group of groups) {
    const at = group.rules.findIndex((rule) => rule.keyword === WORK_KEYWORD);
    if (at === -1) continue;
    groups.unshift({ rules: group.rules.splice(at, 1) });
    break;
  }
  if (groups[0]?.rules.length !== 1 || groups[0].rules[0]?.keyword !== WORK_KEYWORD || groups[0].type !== undefined) {
    throw new Error("JSON Schema validation is unavailable: the work meter could not be placed first");
  }
}

function buildEngines(): Engines {
  const draft07 = new Ajv(ajvOptions());
  const draft2020 = new Ajv2020(ajvOptions()) as unknown as Ajv;
  for (const ajv of [draft07, draft2020]) {
    addFormats(ajv, { mode: "fast", formats: [...FORMATS], keywords: false });
    meterFirst(ajv);
  }
  return { draft07, draft2020 };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keywords whose value is a map of name -> schema, not a schema. */
const SCHEMA_MAPS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
  // Draft-07: each value is a schema or a list of property names.
  "dependencies",
]);
/** Keywords whose value is data, never a schema. */
const DATA_KEYWORDS = new Set([
  "enum",
  "const",
  "default",
  "examples",
  "required",
  "dependentRequired",
  "$vocabulary",
]);
/** Keywords that apply a subschema to the SAME value, not to a part of it. */
const IN_PLACE_LISTS = ["allOf", "anyOf", "oneOf"];
const IN_PLACE_SCHEMAS = ["not", "if", "then", "else"];
const IN_PLACE_MAPS = ["dependentSchemas", "dependencies"];
const REFERENCES = ["$ref", "$dynamicRef", "$recursiveRef"];

function describesContainers(items: unknown): boolean {
  if (!isPlainObject(items)) return true; // unknown item type: assume the worst
  const type = items.type;
  if (type === undefined) return true;
  const types = Array.isArray(type) ? type : [type];
  return types.includes("object") || types.includes("array");
}

/**
 * The structural limits ajv does not enforce. Iterative, so a schema nested
 * a hundred thousand levels deep is refused instead of overflowing the stack.
 */
function structuralIssues(schema: Record<string, unknown>): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const stack: Array<{ node: unknown; path: string; depth: number; kind: "schema" | "map" }> = [
    { node: schema, path: "", depth: 1, kind: "schema" },
  ];
  // Everything ajv generates a branch for: subschemas, the boolean ones
  // among them, and each name in a dependency list.
  let subschemas = 0;
  const tooMany: SchemaIssue[] = [
    {
      path: "",
      message: `the schema has more than ${MAX_SUBSCHEMAS} subschemas (boolean schemas and the names in dependency lists count too)`,
    },
  ];
  while (stack.length > 0 && issues.length < 10) {
    if (subschemas > MAX_SUBSCHEMAS) return tooMany;
    const { node, path, depth, kind } = stack.pop()!;
    if (depth > MAX_SCHEMA_DEPTH) {
      issues.push({ path, message: `the schema nests deeper than ${MAX_SCHEMA_DEPTH} levels` });
      continue;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => stack.push({ node: child, path: `${path}/${i}`, depth, kind: "schema" }));
      continue;
    }
    if (!isPlainObject(node)) {
      // `true` or `false` where a schema goes, or a name in a `dependencies` list.
      subschemas++;
      continue;
    }
    if (kind === "map") {
      for (const [name, child] of Object.entries(node)) {
        stack.push({ node: child, path: `${path}/${name}`, depth: depth + 1, kind: "schema" });
      }
      continue;
    }
    subschemas++;

    for (const ref of REFERENCES) {
      const target = node[ref];
      if (target !== undefined && (typeof target !== "string" || !target.startsWith("#"))) {
        issues.push({
          path: `${path}/${ref}`,
          message: 'only references inside this schema ("#/...") are supported; nothing is fetched',
        });
      }
    }
    if (node.uniqueItems === true && node.maxItems === undefined && describesContainers(node.items)) {
      issues.push({
        path: `${path}/uniqueItems`,
        message: 'uniqueItems over objects or arrays needs "maxItems" (comparing them is quadratic)',
      });
    }
    for (const [keyword, child] of Object.entries(node)) {
      if (keyword === "dependentRequired") subschemas += leafCount(child);
      // A list of type names holds no schema.
      if (DATA_KEYWORDS.has(keyword) || keyword === "type") continue;
      if (SCHEMA_MAPS.has(keyword)) {
        stack.push({ node: child, path: `${path}/${keyword}`, depth, kind: "map" });
      } else if (isPlainObject(child) || Array.isArray(child)) {
        stack.push({ node: child, path: `${path}/${keyword}`, depth: depth + 1, kind: "schema" });
      }
    }
  }
  return subschemas > MAX_SUBSCHEMAS ? tooMany : issues;
}

function pointerSegment(name: string): string {
  return name.replace(/~/g, "~0").replace(/\//g, "~1");
}

function leafCount(value: unknown): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== "object" || node === null) count++;
    else for (const child of Array.isArray(node) ? node : Object.values(node)) stack.push(child);
  }
  return count;
}

/** The four numbers chargeWork is called with for this subschema. */
function workOf(node: Record<string, unknown>): [number, number, number, number] {
  let own = 0;
  let names = 0;
  for (const [keyword, value] of Object.entries(node)) {
    if (DATA_KEYWORDS.has(keyword)) {
      own += leafCount(value);
    } else if (SCHEMA_MAPS.has(keyword) && isPlainObject(value)) {
      const entries = Object.values(value);
      own += entries.length;
      // Draft-07 `dependencies` may map a property to a list of names.
      for (const entry of entries) if (Array.isArray(entry)) own += entry.length;
      if (keyword === "properties" || keyword === "patternProperties") names += entries.length;
    } else if (Array.isArray(value)) {
      own += value.length;
    }
  }
  const pairwise = node.uniqueItems === true && describesContainers(node.items) ? 1 : 0;
  return [own, Object.keys(node).length, names, pairwise];
}

/**
 * Puts the work meter on every subschema of `root` (a private copy, changed
 * in place) and refuses what would let an evaluation escape it or what is
 * too expensive whatever the data: see the header. Runs after
 * structuralIssues, so the depth is already bounded.
 */
function instrument(root: Record<string, unknown>): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const byPointer = new Map<string, Record<string, unknown>>();
  const byAnchor = new Map<string, Record<string, unknown>>();
  const paths = new Map<Record<string, unknown>, string>();
  const references: Array<{ from: Record<string, unknown>; path: string; target: string }> = [];

  const stack: Array<{ node: unknown; path: string; kind: "schema" | "map" }> = [
    { node: root, path: "", kind: "schema" },
  ];
  while (stack.length > 0) {
    const { node, path, kind } = stack.pop()!;
    if (Array.isArray(node)) {
      node.forEach((child, i) => stack.push({ node: child, path: `${path}/${i}`, kind: "schema" }));
      continue;
    }
    if (!isPlainObject(node)) continue;
    if (kind === "map") {
      for (const [name, child] of Object.entries(node)) {
        stack.push({ node: child, path: `${path}/${pointerSegment(name)}`, kind: "schema" });
      }
      continue;
    }

    byPointer.set(path, node);
    paths.set(node, path);
    if (WORK_KEYWORD in node) {
      issues.push({ path: `${path}/${WORK_KEYWORD}`, message: `unknown keyword: "${WORK_KEYWORD}"` });
    }
    const id = node.$id;
    if (typeof id === "string" && id.startsWith("#")) byAnchor.set(id, node);
    else if (id !== undefined && node !== root) {
      issues.push({
        path: `${path}/$id`,
        message: 'a nested "$id" is not supported: references are resolved against the whole schema',
      });
    }
    for (const anchor of ["$anchor", "$dynamicAnchor"]) {
      if (typeof node[anchor] === "string") byAnchor.set(`#${node[anchor]}`, node);
    }
    for (const ref of REFERENCES) {
      const target = node[ref];
      if (typeof target === "string") references.push({ from: node, path: `${path}/${ref}`, target });
    }
    for (const [keyword, child] of Object.entries(node)) {
      if (DATA_KEYWORDS.has(keyword)) continue;
      const at = `${path}/${pointerSegment(keyword)}`;
      if (SCHEMA_MAPS.has(keyword)) stack.push({ node: child, path: at, kind: "map" });
      else if (isPlainObject(child) || Array.isArray(child)) stack.push({ node: child, path: at, kind: "schema" });
    }
  }

  // Where each reference leads. A "#/..." pointer has to land on a subschema
  // found above: ajv would follow one into an enum member or a default just
  // as readily, and nothing there carries the meter.
  const referenced = new Map<Record<string, unknown>, Array<Record<string, unknown>>>();
  for (const { from, path, target } of references) {
    let found: Record<string, unknown> | undefined;
    if (target === "#") {
      found = root;
    } else if (target.startsWith("#/")) {
      let pointer = target.slice(1);
      try {
        pointer = decodeURIComponent(pointer);
      } catch {
        // Not percent-encoded after all: looked up as written.
      }
      found = byPointer.get(pointer);
      if (!found) {
        issues.push({
          path,
          message:
            'this reference does not lead to a subschema of this schema (a "#/..." pointer may not point into enum, const, default or examples, or at something that is not there)',
        });
      }
    } else {
      // A named anchor. One that does not exist fails ajv's own compile.
      found = byAnchor.get(target);
    }
    if (found) referenced.set(from, [...(referenced.get(from) ?? []), found]);
  }
  if (issues.length > 0) return issues.slice(0, 10);

  // How many subschema evaluations ONE value causes at each subschema,
  // through everything that is applied to the value itself. -1 marks a
  // subschema whose count is still being worked out: meeting it again means
  // the references loop without ever moving into the data.
  const counts = new Map<Record<string, unknown>, number>();
  let loops = false;
  const evaluations = (node: Record<string, unknown>): number => {
    const known = counts.get(node);
    if (known === -1) loops = true;
    if (known !== undefined) return known === -1 ? Infinity : known;
    counts.set(node, -1);
    let total = 1;
    const add = (child: unknown) => {
      if (isPlainObject(child)) total += evaluations(child);
    };
    for (const keyword of IN_PLACE_LISTS) if (Array.isArray(node[keyword])) (node[keyword] as unknown[]).forEach(add);
    for (const keyword of IN_PLACE_SCHEMAS) add(node[keyword]);
    for (const keyword of IN_PLACE_MAPS) if (isPlainObject(node[keyword])) Object.values(node[keyword]).forEach(add);
    (referenced.get(node) ?? []).forEach(add);
    counts.set(node, total);
    return total;
  };
  try {
    // In document order from the root, so the outermost offender is named.
    for (const [node, path] of paths) {
      if (evaluations(node) <= MAX_REFERENCE_FAN_OUT) continue;
      issues.push({
        path,
        message: loops
          ? "the references here loop back to where they started without moving into the data, so validating would never end"
          : `one value takes more than ${MAX_REFERENCE_FAN_OUT.toLocaleString("en-US")} schema evaluations here, because references inside allOf, anyOf, oneOf, not or if are applied again at every step; refer to each definition once per branch`,
      });
      break;
    }
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    issues.push({ path: "", message: "the schema's references are chained too deeply" });
  }
  if (issues.length > 0) return issues;

  for (const node of paths.keys()) node[WORK_KEYWORD] = workOf(node);
  return issues;
}

function dataDepthExceeds(data: unknown, limit: number): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: data, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (typeof node !== "object" || node === null) continue;
    if (depth > limit) return true;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (typeof child === "object" && child !== null) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return false;
}

/** ajv's errors as `{ path, message }`, the path being where in the DATA. */
export function formatAjvErrors(errors: ErrorObject[] | null | undefined): SchemaIssue[] {
  return (errors ?? []).map((err) => {
    let path = err.instancePath ?? "";
    let message = err.message ?? "is invalid";
    // "must have required property 'x'" is reported on the parent; a form
    // wants it on the field.
    if (err.keyword === "required" && typeof err.params?.missingProperty === "string") {
      path = `${path}/${err.params.missingProperty}`;
      message = "is required";
    } else if (err.keyword === "additionalProperties" && typeof err.params?.additionalProperty === "string") {
      message = `must not have the property "${err.params.additionalProperty}"`;
    } else if (err.keyword === "enum" && Array.isArray(err.params?.allowedValues)) {
      message = `must be one of: ${err.params.allowedValues.map((v: unknown) => JSON.stringify(v)).join(", ")}`;
    }
    return { path, message };
  });
}

function compileIssue(err: unknown): SchemaIssue {
  if (err instanceof UnsafeRegexError) return { path: "", message: `pattern: ${err.message}` };
  const message = err instanceof Error ? err.message : String(err);
  // ajv prefixes its own: "schema is invalid: data/properties/x/type must be..."
  return { path: "", message: message.replace(/^schema is invalid:\s*/i, "").slice(0, 500) };
}

export interface SchemaCompiler {
  /** Throws JsonSchemaError. */
  compile(schema: unknown, options?: CompileOptions): CompiledSchema;
  /** Compiled validators currently held. */
  size(): number;
}

export function createSchemaCompiler(options: { maxEntries?: number } = {}): SchemaCompiler {
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_CACHE_ENTRIES);
  let engines: Engines | null = null;
  // Insertion order is recency: a hit is deleted and set again.
  const cache = new Map<string, { schema: Record<string, unknown>; engine: Ajv; validate: ValidateFunction }>();

  const compileFresh = (schema: Record<string, unknown>, serialized: string) => {
    engines ??= buildEngines();
    const dialect = typeof schema.$schema === "string" ? schema.$schema : "";
    // Draft 2020-12 when the schema says so, draft-07 otherwise. Any other
    // dialect is refused by ajv by name (it has no such meta-schema).
    const engine = dialect.includes("2020-12") ? engines.draft2020 : engines.draft07;
    // Compiled from a private copy, so the object ajv keeps as its cache key
    // is one only this cache can hand back to removeSchema.
    const own = JSON.parse(serialized) as Record<string, unknown>;
    const unmeterable = instrument(own);
    if (unmeterable.length > 0) throw new JsonSchemaError(unmeterable);
    patternAllowance = { left: MAX_SCHEMA_PATTERN_INSTRUCTIONS };
    try {
      return { schema: own, engine, validate: engine.compile(own) };
    } catch (err) {
      engine.removeSchema(own);
      throw new JsonSchemaError([compileIssue(err)]);
    } finally {
      patternAllowance = null;
    }
  };

  return {
    size: () => cache.size,
    compile(schema, compileOptions = {}) {
      if (!isPlainObject(schema)) {
        throw new JsonSchemaError([{ path: "", message: "a JSON Schema must be an object" }]);
      }
      let serialized: string;
      try {
        serialized = JSON.stringify(schema);
      } catch {
        throw new JsonSchemaError([{ path: "", message: "the schema is not serializable JSON" }]);
      }
      if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_BYTES) {
        throw new JsonSchemaError([
          { path: "", message: `the schema is larger than ${MAX_SCHEMA_BYTES / 1024} KB` },
        ]);
      }
      if (compileOptions.root === "object" && schema.type !== "object") {
        throw new JsonSchemaError([{ path: "/type", message: 'the schema\'s root must have "type": "object"' }]);
      }
      const structural = structuralIssues(schema);
      if (structural.length > 0) throw new JsonSchemaError(structural);

      const key = createHash("sha256").update(serialized).digest("hex");
      let entry = cache.get(key);
      if (entry) {
        cache.delete(key);
      } else {
        entry = compileFresh(schema, serialized);
      }
      cache.set(key, entry);
      while (cache.size > maxEntries) {
        const oldestKey = cache.keys().next().value as string;
        const oldest = cache.get(oldestKey)!;
        cache.delete(oldestKey);
        oldest.engine.removeSchema(oldest.schema);
      }

      const { validate } = entry;
      return {
        validate(data: unknown): SchemaValidation {
          if (dataDepthExceeds(data, MAX_DATA_DEPTH)) {
            return {
              valid: false,
              errors: [{ path: "", message: `is nested deeper than ${MAX_DATA_DEPTH} levels` }],
            };
          }
          meter = { workLeft: MAX_VALIDATION_WORK, stepsLeft: MAX_MATCH_STEPS };
          try {
            if (validate(data)) return { valid: true };
            return { valid: false, errors: formatAjvErrors(validate.errors) };
          } catch (err) {
            // A RangeError is the stack running out under references chained
            // through a deep document: also work this validation may not do.
            if (!(err instanceof OverBudget) && !(err instanceof RangeError)) throw err;
            return {
              valid: false,
              code: VALIDATION_TOO_EXPENSIVE,
              errors: [
                {
                  path: "",
                  message:
                    "checking this against the schema takes more work than one validation is allowed; simplify the schema (fewer patterns, fewer repeated references) or send less data",
                },
              ],
            };
          } finally {
            meter = null;
          }
        },
      };
    },
  };
}

const shared = createSchemaCompiler();

/** Compiles through the process-wide cache. Throws JsonSchemaError. */
export function compileUserSchema(schema: unknown, options?: CompileOptions): CompiledSchema {
  return shared.compile(schema, options);
}
