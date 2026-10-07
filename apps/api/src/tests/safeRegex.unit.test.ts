import assert from "node:assert/strict";
import test from "node:test";

import {
  compileSafeRegex,
  MAX_MATCH_STEPS,
  MAX_PATTERN_CHARS,
  UnsafeRegexError,
} from "../services/safeRegex.js";

// User patterns (deliverable checks, JSON Schema `pattern`, test-suite regex
// assertions) run inside the API process. What these pin: a pattern that
// takes the JavaScript engine exponential time is answered in bounded time,
// and what the linear-time engine cannot do is refused by name, not run on
// the unsafe engine instead.

const elapsed = (fn: () => void): number => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

test("ordinary patterns match as a JavaScript author expects", () => {
  assert.equal(compileSafeRegex("#\\d{5}").test("order #12345 shipped"), true);
  assert.equal(compileSafeRegex("#\\d{5}").test("order #123 shipped"), false);
  assert.equal(compileSafeRegex("^total:", "im").test("items\nTOTAL: 4"), true);
  assert.equal(compileSafeRegex("^total:", "i").test("items\nTOTAL: 4"), false);
  assert.equal(compileSafeRegex("a.b", "s").test("a\nb"), true);
  assert.equal(compileSafeRegex("a.b").test("a\nb"), false);
  assert.equal(compileSafeRegex("(?<year>\\d{4})-\\d{2}").test("due 2026-10"), true);
  // JavaScript's \uXXXX spelling is accepted.
  assert.equal(compileSafeRegex("[\\u4e00-\\u9fff]+").test("漢字"), true);
});

test("the catastrophic pattern (a+)+$ answers within a bound", () => {
  const re = compileSafeRegex("(a+)+$");
  // On the JavaScript engine this input takes minutes.
  const input = "a".repeat(30) + "!";
  let matched = true;
  const ms = elapsed(() => {
    matched = re.test(input);
  });
  assert.equal(matched, false);
  assert.ok(ms < 50, `took ${ms.toFixed(1)}ms`);

  // And it stays bounded as the input grows, which is the point.
  const long = "a".repeat(50_000) + "!";
  const longMs = elapsed(() => re.test(long));
  assert.ok(longMs < 500, `took ${longMs.toFixed(1)}ms`);
});

test("backreferences and lookaround are refused with a message that says why", () => {
  for (const pattern of ["(a)\\1", "(?<q>a)\\k<q>"]) {
    assert.throws(
      () => compileSafeRegex(pattern),
      (err: unknown) => err instanceof UnsafeRegexError && /backreferences/.test(err.message),
      pattern,
    );
  }
  for (const pattern of ["(?<=a)b", "(?<!a)b", "a(?=b)", "a(?!b)"]) {
    assert.throws(
      () => compileSafeRegex(pattern),
      (err: unknown) => err instanceof UnsafeRegexError && /lookahead and lookbehind/.test(err.message),
      pattern,
    );
  }
});

test("a malformed pattern is refused, with the parser's reason", () => {
  assert.throws(
    () => compileSafeRegex("([unclosed"),
    (err: unknown) => err instanceof UnsafeRegexError && /missing closing/.test(err.message) && err.code === "invalid_regex",
  );
  assert.throws(() => compileSafeRegex(""), UnsafeRegexError);
  assert.throws(() => compileSafeRegex("((a{100}){100}){100}"), /repetition is too large/);
});

test("patterns over the length cap are refused", () => {
  assert.doesNotThrow(() => compileSafeRegex("a".repeat(MAX_PATTERN_CHARS)));
  assert.throws(
    () => compileSafeRegex("a".repeat(MAX_PATTERN_CHARS + 1)),
    (err: unknown) => err instanceof UnsafeRegexError && /at most 500 characters/.test(err.message),
  );
});

test("only the flags i, m and s are accepted, each once", () => {
  assert.equal(compileSafeRegex("a", "smi").flags, "ims");
  for (const flags of ["g", "y", "u", "d", "v", "ig"]) {
    assert.throws(() => compileSafeRegex("a", flags), /is not supported/, flags);
  }
  assert.throws(() => compileSafeRegex("a", "ii"), /repeated/);
});

test("a match whose cost is over the budget is refused, never reported as a match", () => {
  // A thousand instructions: cheap on a short string, not on a long one.
  const re = compileSafeRegex("[a-z]{1000}");
  assert.equal(re.test("a".repeat(1000)), true);

  const long = "a".repeat(Math.ceil(MAX_MATCH_STEPS / 500));
  let outcome: ReturnType<typeof re.check> | null = null;
  const ms = elapsed(() => {
    outcome = re.check(long);
  });
  assert.deepEqual(
    outcome && (outcome as { ok: boolean }).ok,
    false,
    "the match was not attempted",
  );
  assert.match((outcome as unknown as { reason: string }).reason, /too complex/);
  assert.equal(re.test(long), false, "a refused match is not a match");
  assert.ok(ms < 50, `refusing took ${ms.toFixed(1)}ms`);
});

test("matches that share a budget are refused once it cannot cover them, and stay refused", () => {
  const regex = compileSafeRegex("[a-z]{100}$");
  const budget = { stepsLeft: regex.instructions * 250 };
  const input = "a".repeat(100);
  assert.deepEqual(regex.check(input, budget), { ok: true, matched: true });
  assert.deepEqual(regex.check(input, budget), { ok: true, matched: true });
  assert.equal(budget.stepsLeft, regex.instructions * 50);
  const refused = regex.check(input, budget);
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.reason : "", /more matching than one validation is allowed/);
  // Spent: a match small enough for what was left is not let through after a refusal.
  assert.equal(regex.check("a".repeat(10), budget).ok, false);
  // Without a budget a match is bounded by itself, as before.
  assert.deepEqual(regex.check(input), { ok: true, matched: true });
});
