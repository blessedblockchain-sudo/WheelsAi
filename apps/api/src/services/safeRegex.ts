/**
 * Regular expressions written by users, matched in bounded time.
 *
 * A pattern from a publisher (a deliverable check, a JSON Schema `pattern`)
 * or from a test suite is matched inside the API process against text the
 * author does not control. On the JavaScript engine a pattern like `(a+)+$`
 * takes exponential time on a short input and stops the whole server, so no
 * user pattern is ever given to `new RegExp`. They are compiled by RE2 (the
 * pure-JS port), which matches in time linear in the input.
 *
 * Linear is not free: the cost is (input length x compiled program size),
 * and a pattern such as `[a-z]{1000}$` compiles to a thousand instructions.
 * So a match is also refused, before it runs, when that product is over
 * MAX_MATCH_STEPS. A refused match answers `false` from `test` and names
 * the reason from `check`: it never reports a match it did not make.
 *
 * One match being bounded does not bound a caller that makes many of them
 * (a JSON Schema with forty patterns over thirty strings). Such a caller
 * passes every match the same MatchBudget, and a match the budget cannot
 * cover is refused like one that is too large by itself.
 *
 * What RE2 cannot express - backreferences and lookaround - is refused at
 * compile time with a message that says so.
 */

import { RE2JS } from "re2js";

export const MAX_PATTERN_CHARS = 500;
/** About 150 ms of matching at worst on the server this was measured on. */
export const MAX_MATCH_STEPS = 2_000_000;

const ALLOWED_FLAGS = new Set(["i", "m", "s"]);

export class UnsafeRegexError extends Error {
  readonly code = "invalid_regex";
  constructor(message: string) {
    super(message);
    this.name = "UnsafeRegexError";
  }
}

export type SafeMatch =
  | { ok: true; matched: boolean }
  /** The match was not attempted. */
  | { ok: false; reason: string };

/** Steps that several matches share. A match takes its cost out before it runs. */
export interface MatchBudget {
  stepsLeft: number;
}

export interface SafeRegex {
  readonly source: string;
  readonly flags: string;
  /** Size of the compiled program: a match costs input length times this. */
  readonly instructions: number;
  /** True only for a match that was made; a refused match is false. */
  test(input: string): boolean;
  /** With a `budget`, also refused when the budget cannot cover the match. */
  check(input: string, budget?: MatchBudget): SafeMatch;
}

/** What the RE2 parser said, as something a pattern's author can act on. */
function syntaxMessage(pattern: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/invalid escape sequence: `\\(?:[1-9]|k)/.test(raw)) {
    return "backreferences (\\1, \\k<name>) are not supported: patterns run on a linear-time engine that cannot express them";
  }
  if (/`\(\?<?[=!]/.test(raw)) {
    return "lookahead and lookbehind ((?=, (?!, (?<=, (?<!) are not supported: patterns run on a linear-time engine that cannot express them";
  }
  if (/invalid repeat count/.test(raw)) {
    return "a repetition is too large (counts, nested ones multiplied together, may not exceed 1000)";
  }
  const detail = raw.replace(/^error parsing regexp:\s*/i, "");
  return detail.length > 0 && detail.length <= 200 ? detail : `the pattern could not be compiled: ${pattern.slice(0, 80)}`;
}

/**
 * Compiles a user pattern. Throws UnsafeRegexError for a pattern that is too
 * long, uses a flag other than i, m or s, or uses syntax RE2 does not have.
 */
export function compileSafeRegex(pattern: string, flags = ""): SafeRegex {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new UnsafeRegexError("a pattern is required");
  }
  if (pattern.length > MAX_PATTERN_CHARS) {
    throw new UnsafeRegexError(`a pattern may be at most ${MAX_PATTERN_CHARS} characters`);
  }
  let bits = 0;
  const seen = new Set<string>();
  for (const flag of flags) {
    if (!ALLOWED_FLAGS.has(flag)) {
      throw new UnsafeRegexError(`flag "${flag}" is not supported; use any of i, m, s`);
    }
    if (seen.has(flag)) throw new UnsafeRegexError(`flag "${flag}" is repeated`);
    seen.add(flag);
    bits |= flag === "i" ? RE2JS.CASE_INSENSITIVE : flag === "m" ? RE2JS.MULTILINE : RE2JS.DOTALL;
  }

  let compiled: RE2JS;
  let instructions: number;
  try {
    // JavaScript spellings RE2 writes differently (\uXXXX, \cJ, (?<name>).
    compiled = RE2JS.compile(RE2JS.translateRegExp(pattern), bits);
    instructions = Math.max(1, compiled.matcher("").numberOfInstructions);
  } catch (err) {
    throw new UnsafeRegexError(syntaxMessage(pattern, err));
  }

  const normalizedFlags = [...seen].sort().join("");
  const check = (input: string, budget?: MatchBudget): SafeMatch => {
    if (typeof input !== "string") return { ok: false, reason: "only text can be matched" };
    const steps = input.length * instructions;
    if (steps > MAX_MATCH_STEPS) {
      return {
        ok: false,
        reason: `the pattern is too complex to match against ${input.length} characters; simplify it or use a "contains" check`,
      };
    }
    if (budget) {
      if (steps > budget.stepsLeft) {
        // Spent as well: once one match is refused, no smaller one may slip
        // in after it and make the outcome depend on the order of matches.
        budget.stepsLeft = 0;
        return { ok: false, reason: "the patterns here need more matching than one validation is allowed" };
      }
      budget.stepsLeft -= steps;
    }
    return { ok: true, matched: compiled.matcher(input).find() };
  };
  return {
    source: pattern,
    flags: normalizedFlags,
    instructions,
    check,
    test: (input) => {
      const result = check(input);
      return result.ok && result.matched;
    },
  };
}
