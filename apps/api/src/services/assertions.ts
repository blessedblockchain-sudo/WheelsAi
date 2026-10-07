/**
 * One assertion engine for what a model produced: an offering's deliverable
 * checks (a job's output must pass them before the buyer sees it) and the
 * test runner's regex and json_schema assertions.
 *
 * Checks are written by users and run inside the API process on text nobody
 * here controls, so every one of them is bounded:
 *
 *   contains / not_contains / exact   plain string comparison
 *   min_length / max_length           character counts
 *   regex                             the linear-time engine (safeRegex.ts);
 *                                     a match it refuses to attempt FAILS the
 *                                     check, with the reason
 *   json_schema                       real JSON Schema (jsonSchema.ts) on the
 *                                     JSON found in the output, inside one
 *                                     validation's work budget; a validation
 *                                     the budget stops FAILS the check
 *
 * `confidentiality` is not something a publisher writes. The job runner asks
 * for it on every job: the output must not repeat the offering's private
 * instructions or the agent's system prompt (detectInstructionLeak).
 *
 * Nothing here executes user code, and nothing reports a pass it did not
 * establish: a check that cannot be evaluated fails and says why.
 *
 * Pure: no IO.
 */

import { z } from "zod";

import { compileUserSchema, JsonSchemaError, type SchemaIssue } from "./jsonSchema.js";
import { compileSafeRegex, MAX_PATTERN_CHARS, UnsafeRegexError } from "./safeRegex.js";

export const MAX_CHECKS = 10;
/** A deliverable larger than this fails; nothing bigger is stored either. */
export const MAX_SUBJECT_BYTES = 512 * 1024;
const MAX_VALUE_CHARS = 500;
const MAX_LABEL_CHARS = 120;

// ============================================
// Check shapes
// ============================================

const label = z.string().trim().min(1).max(MAX_LABEL_CHARS).optional();
const text = z.string().min(1).max(MAX_VALUE_CHARS);

const checkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("contains"), value: text, caseSensitive: z.boolean().optional(), label }).strict(),
  z.object({ type: z.literal("not_contains"), value: text, caseSensitive: z.boolean().optional(), label }).strict(),
  z.object({ type: z.literal("exact"), value: z.string().min(1).max(10_000), label }).strict(),
  z
    .object({
      type: z.literal("regex"),
      pattern: z.string().min(1).max(MAX_PATTERN_CHARS),
      flags: z.string().max(3).optional(),
      label,
    })
    .strict(),
  z.object({ type: z.literal("json_schema"), schema: z.record(z.unknown()), label }).strict(),
  z.object({ type: z.literal("min_length"), value: z.number().int().min(1).max(MAX_SUBJECT_BYTES), label }).strict(),
  z.object({ type: z.literal("max_length"), value: z.number().int().min(1).max(MAX_SUBJECT_BYTES), label }).strict(),
]);

export type Check = z.infer<typeof checkSchema>;
export type CheckType = Check["type"];

export interface CheckResult {
  /** `run`: not a check - the job runner's note on a run that produced nothing to grade. */
  type: CheckType | "confidentiality" | "size" | "run";
  label: string;
  passed: boolean;
  /** Why, in words the publisher (and, without detail, the buyer) can read. */
  details: string;
}

export type ChecksValidation =
  | { ok: true; checks: Check[] }
  | { ok: false; issues: SchemaIssue[] };

/**
 * Validates checks as they are saved: shape, then that every pattern and
 * schema actually compiles. A check that would fail to compile at job time
 * would fail every job the offering ever ran.
 */
export function validateChecks(raw: unknown): ChecksValidation {
  if (!Array.isArray(raw)) {
    return { ok: false, issues: [{ path: "", message: "deliverable checks must be a list" }] };
  }
  if (raw.length > MAX_CHECKS) {
    return { ok: false, issues: [{ path: "", message: `at most ${MAX_CHECKS} deliverable checks are allowed` }] };
  }
  const issues: SchemaIssue[] = [];
  const checks: Check[] = [];
  raw.forEach((candidate, index) => {
    const parsed = checkSchema.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({ path: `/${[index, ...issue.path].join("/")}`, message: issue.message });
      }
      return;
    }
    const check = parsed.data;
    try {
      if (check.type === "regex") compileSafeRegex(check.pattern, check.flags ?? "");
      if (check.type === "json_schema") compileUserSchema(check.schema);
    } catch (err) {
      if (err instanceof UnsafeRegexError) {
        issues.push({ path: `/${index}/pattern`, message: err.message });
        return;
      }
      if (err instanceof JsonSchemaError) {
        for (const issue of err.issues) {
          issues.push({ path: `/${index}/schema${issue.path}`, message: issue.message });
        }
        return;
      }
      throw err;
    }
    checks.push(check);
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, checks };
}

// ============================================
// JSON in model output
// ============================================

export type ExtractedJson = { ok: true; value: unknown } | { ok: false };

/**
 * The JSON a model answered with. Models wrap JSON in a Markdown code fence
 * more often than not, so the whole text is tried first and then the first
 * fenced block. Nothing looser: prose with a JSON-looking fragment in it is
 * not a JSON deliverable.
 */
export function extractJson(output: string): ExtractedJson {
  const parse = (candidate: string): ExtractedJson => {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      return { ok: false };
    }
  };
  const whole = parse(output.trim());
  if (whole.ok) return whole;
  const open = output.indexOf("```");
  if (open === -1) return { ok: false };
  const bodyStart = output.indexOf("\n", open);
  const close = bodyStart === -1 ? -1 : output.indexOf("```", bodyStart);
  if (bodyStart === -1 || close === -1) return { ok: false };
  return parse(output.slice(bodyStart + 1, close).trim());
}

// ============================================
// Confidentiality
// ============================================

const SHINGLE_WORDS = 8;

function words(input: string): string[] {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * True when `output` repeats any run of eight consecutive words of a source
 * (the offering's private instructions, the agent's system prompt). Case,
 * punctuation and spacing are ignored, so re-flowed or re-punctuated text is
 * still caught.
 *
 * Limits, stated so nobody relies on more: a paraphrase, a translation or an
 * encoding is not detected, and a source shorter than eight words is not
 * checked at all (a phrase like "be concise" appears in honest output).
 */
export function detectInstructionLeak(
  output: string,
  sources: Array<string | null | undefined>,
): { leaked: boolean } {
  const shingles = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    const sourceWords = words(source);
    for (let i = 0; i + SHINGLE_WORDS <= sourceWords.length; i++) {
      shingles.add(sourceWords.slice(i, i + SHINGLE_WORDS).join(" "));
    }
  }
  if (shingles.size === 0) return { leaked: false };
  const outputWords = words(output);
  for (let i = 0; i + SHINGLE_WORDS <= outputWords.length; i++) {
    if (shingles.has(outputWords.slice(i, i + SHINGLE_WORDS).join(" "))) return { leaked: true };
  }
  return { leaked: false };
}

// ============================================
// Evaluation
// ============================================

function defaultLabel(check: Check): string {
  switch (check.type) {
    case "contains":
      return `Contains "${check.value}"`;
    case "not_contains":
      return `Does not contain "${check.value}"`;
    case "exact":
      return "Matches the expected text exactly";
    case "regex":
      return `Matches /${check.pattern}/${check.flags ?? ""}`;
    case "json_schema":
      return "Is JSON matching the schema";
    case "min_length":
      return `At least ${check.value} characters`;
    case "max_length":
      return `At most ${check.value} characters`;
  }
}

function includes(subject: string, value: string, caseSensitive: boolean | undefined): boolean {
  return caseSensitive ? subject.includes(value) : subject.toLowerCase().includes(value.toLowerCase());
}

/** One check against one output. Never throws for a check that cannot run. */
export function evaluateCheck(check: Check, subject: string): CheckResult {
  const result = (passed: boolean, details: string): CheckResult => ({
    type: check.type,
    label: check.label ?? defaultLabel(check),
    passed,
    details,
  });
  switch (check.type) {
    case "contains": {
      const found = includes(subject, check.value, check.caseSensitive);
      return result(found, found ? `Output contains "${check.value}"` : `Output does not contain "${check.value}"`);
    }
    case "not_contains": {
      const found = includes(subject, check.value, check.caseSensitive);
      return result(!found, found ? `Output contains "${check.value}"` : `Output does not contain "${check.value}"`);
    }
    case "exact": {
      // Trimmed on both sides: a trailing newline is not a different answer.
      const same = subject.trim() === check.value.trim();
      return result(same, same ? "Output matches exactly" : "Output differs from the expected text");
    }
    case "min_length": {
      const length = [...subject.trim()].length;
      return result(length >= check.value, `Output is ${length} characters (minimum ${check.value})`);
    }
    case "max_length": {
      const length = [...subject.trim()].length;
      return result(length <= check.value, `Output is ${length} characters (maximum ${check.value})`);
    }
    case "regex": {
      const shown = `/${check.pattern}/${check.flags ?? ""}`;
      try {
        const matched = compileSafeRegex(check.pattern, check.flags ?? "").check(subject);
        if (!matched.ok) return result(false, `Pattern ${shown} was not evaluated: ${matched.reason}`);
        return result(
          matched.matched,
          matched.matched ? `Output matches pattern ${shown}` : `Output does not match pattern ${shown}`,
        );
      } catch (err) {
        if (err instanceof UnsafeRegexError) return result(false, `Invalid regex pattern ${shown}: ${err.message}`);
        throw err;
      }
    }
    case "json_schema": {
      const json = extractJson(subject);
      if (!json.ok) return result(false, "Output is not valid JSON");
      try {
        const validation = compileUserSchema(check.schema).validate(json.value);
        if (validation.valid) return result(true, "Output matches the schema");
        if (validation.code) {
          // Stopped at the work budget: a failed check, and not a mismatch.
          return result(false, `The schema was not evaluated: ${validation.errors[0]?.message ?? "it takes too much work"}`);
        }
        const first = validation.errors[0];
        return result(
          false,
          first ? `Output does not match the schema: ${first.path || "(root)"} ${first.message}` : "Output does not match the schema",
        );
      } catch (err) {
        if (err instanceof JsonSchemaError) return result(false, `Invalid JSON Schema: ${err.message}`);
        throw err;
      }
    }
  }
}

export interface ChecksEvaluation {
  passed: boolean;
  results: CheckResult[];
}

/**
 * Every check against one deliverable, in order, all of them reported.
 *
 * `confidential`: text the output must not repeat. When given, a
 * `confidentiality` result is always present, so a job's record shows the
 * guard ran. Its details never quote what leaked.
 */
export function evaluateChecks(
  checks: Check[],
  deliverable: string,
  options: { confidential?: Array<string | null | undefined> } = {},
): ChecksEvaluation {
  if (Buffer.byteLength(deliverable, "utf8") > MAX_SUBJECT_BYTES) {
    return {
      passed: false,
      results: [
        {
          type: "size",
          label: "Deliverable size",
          passed: false,
          details: `The output is larger than ${MAX_SUBJECT_BYTES / 1024} KB and was not checked`,
        },
      ],
    };
  }
  const results = checks.map((check) => evaluateCheck(check, deliverable));
  if (options.confidential) {
    const { leaked } = detectInstructionLeak(deliverable, options.confidential);
    results.push({
      type: "confidentiality",
      label: "Does not repeat the publisher's private instructions",
      passed: !leaked,
      details: leaked
        ? "The output repeated part of the offering's private instructions or the agent's system prompt"
        : "No private instructions were found in the output",
    });
  }
  return { passed: results.every((r) => r.passed), results };
}
