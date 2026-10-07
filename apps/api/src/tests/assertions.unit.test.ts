import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCheck,
  evaluateChecks,
  extractJson,
  MAX_CHECKS,
  MAX_SUBJECT_BYTES,
  validateChecks,
  type Check,
} from "../services/assertions.js";

// The checks a job's output must pass before the buyer sees it (and the
// test runner's regex and json_schema assertions). What these pin: each type
// grades what it says it grades, a check that cannot be evaluated fails
// instead of passing, and a bad check is refused when it is saved.

const pass = (check: Check, output: string) => evaluateCheck(check, output).passed;

test("contains and not_contains are case-insensitive unless asked otherwise", () => {
  assert.equal(pass({ type: "contains", value: "summary" }, "## SUMMARY\n..."), true);
  assert.equal(pass({ type: "contains", value: "summary", caseSensitive: true }, "## SUMMARY"), false);
  assert.equal(pass({ type: "contains", value: "risks" }, "no such section"), false);
  assert.equal(pass({ type: "not_contains", value: "as an ai" }, "As an AI, I cannot"), false);
  assert.equal(pass({ type: "not_contains", value: "as an ai" }, "Here is the report"), true);
});

test("exact ignores surrounding whitespace only; lengths count characters", () => {
  assert.equal(pass({ type: "exact", value: "APPROVED" }, "  APPROVED\n"), true);
  assert.equal(pass({ type: "exact", value: "APPROVED" }, "approved"), false);
  assert.equal(pass({ type: "min_length", value: 5 }, "  abcd  "), false);
  assert.equal(pass({ type: "min_length", value: 4 }, "  abcd  "), true);
  assert.equal(pass({ type: "max_length", value: 3 }, "漢字漢"), true);
  assert.equal(pass({ type: "max_length", value: 3 }, "漢字漢字"), false);
  assert.match(evaluateCheck({ type: "max_length", value: 3 }, "abcd").details, /4 characters \(maximum 3\)/);
});

test("regex runs on the linear-time engine, with the flags given", () => {
  assert.equal(pass({ type: "regex", pattern: "^total: \\d+$", flags: "im" }, "items\nTOTAL: 42"), true);
  assert.equal(pass({ type: "regex", pattern: "^total: \\d+$" }, "items\nTOTAL: 42"), false);

  // The pattern that stalls the JavaScript engine answers at once.
  const start = performance.now();
  const hostile = evaluateCheck({ type: "regex", pattern: "(a+)+$" }, "a".repeat(30) + "!");
  assert.equal(hostile.passed, false);
  assert.ok(performance.now() - start < 100);
});

test("a regex that is refused at match time fails the check and says why", () => {
  const result = evaluateCheck({ type: "regex", pattern: "[a-z]{1000}" }, "a".repeat(100_000));
  assert.equal(result.passed, false);
  assert.match(result.details, /was not evaluated: the pattern is too complex/);
});

test("json_schema grades the JSON in the output, raw or inside a code fence", () => {
  const check: Check = {
    type: "json_schema",
    schema: {
      type: "object",
      required: ["competitors"],
      properties: { competitors: { type: "array", minItems: 2, items: { type: "string" } } },
    },
  };
  assert.equal(pass(check, '{"competitors":["a","b"]}'), true);
  assert.equal(pass(check, 'Here you go:\n```json\n{"competitors":["a","b"]}\n```\nAnything else?'), true);
  assert.equal(pass(check, "```\n{\"competitors\":[\"a\",\"b\"]}\n```"), true);

  const short = evaluateCheck(check, '{"competitors":["a"]}');
  assert.equal(short.passed, false);
  assert.match(short.details, /\/competitors/);
  // Top-level keys present is not enough any more: the types are checked.
  assert.equal(pass(check, '{"competitors":"a, b"}'), false);
  const prose = evaluateCheck(check, "The competitors are a and b.");
  assert.equal(prose.passed, false);
  assert.equal(prose.details, "Output is not valid JSON");
});

test("extractJson takes the whole text or the first fenced block, nothing looser", () => {
  assert.deepEqual(extractJson(' [1, 2] '), { ok: true, value: [1, 2] });
  assert.deepEqual(extractJson("```json\n{\"a\":1}\n```"), { ok: true, value: { a: 1 } });
  assert.deepEqual(extractJson('The answer is {"a":1} as requested'), { ok: false });
  assert.deepEqual(extractJson("```json\n{not json}\n```"), { ok: false });
  assert.deepEqual(extractJson("```json\n{\"a\":1}"), { ok: false });
});

test("validateChecks accepts well-formed checks and returns them typed", () => {
  const raw = [
    { type: "contains", value: "Summary", label: "Has a summary" },
    { type: "regex", pattern: "\\d+ competitors", flags: "i" },
    { type: "json_schema", schema: { type: "object" } },
    { type: "min_length", value: 200 },
  ];
  const result = validateChecks(raw);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.checks, raw);
  assert.deepEqual(validateChecks([]), { ok: true, checks: [] });
});

test("validateChecks refuses a bad check, naming which one and why", () => {
  const issuesFor = (raw: unknown) => {
    const result = validateChecks(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    return result.ok ? [] : result.issues;
  };
  assert.match(issuesFor("nope")[0]!.message, /must be a list/);
  assert.match(
    issuesFor(Array.from({ length: MAX_CHECKS + 1 }, () => ({ type: "contains", value: "a" })))[0]!.message,
    /at most 10/,
  );
  // Custom code is not a check type: there is nothing here that runs it.
  assert.equal(issuesFor([{ type: "function", script: "return true" }])[0]!.path, "/0/type");
  assert.equal(issuesFor([{ type: "contains" }])[0]!.path, "/0/value");
  assert.equal(issuesFor([{ type: "contains", value: "x".repeat(501) }])[0]!.path, "/0/value");
  assert.equal(issuesFor([{ type: "contains", value: "a", extra: 1 }])[0]!.path, "/0");

  const regex = issuesFor([{ type: "contains", value: "ok" }, { type: "regex", pattern: "(a)\\1" }]);
  assert.deepEqual(
    regex.map((i) => i.path),
    ["/1/pattern"],
  );
  assert.match(regex[0]!.message, /backreferences/);
  assert.match(issuesFor([{ type: "regex", pattern: "a", flags: "g" }])[0]!.message, /flag "g"/);

  const schema = issuesFor([{ type: "json_schema", schema: { type: "object", properties: { a: { $ref: "https://x.test/s" } } } }]);
  assert.equal(schema[0]!.path, "/0/schema/properties/a/$ref");
  assert.match(issuesFor([{ type: "json_schema", schema: { type: "nope" } }])[0]!.path, /^\/0\/schema/);
});

test("evaluateChecks reports every check and passes only when all do", () => {
  const checks: Check[] = [
    { type: "contains", value: "summary", label: "Has a summary" },
    { type: "min_length", value: 1000 },
  ];
  const result = evaluateChecks(checks, "Summary: short.");
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.results.map((r) => [r.type, r.label, r.passed]),
    [
      ["contains", "Has a summary", true],
      ["min_length", "At least 1000 characters", false],
    ],
  );
  assert.deepEqual(evaluateChecks([], "anything"), { passed: true, results: [] });
});

test("an output over the size cap fails without being checked", () => {
  const result = evaluateChecks([{ type: "contains", value: "a" }], "a".repeat(MAX_SUBJECT_BYTES + 1));
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.results.map((r) => r.type),
    ["size"],
  );
  assert.match(result.results[0]!.details, /larger than 512 KB/);
});

test("the confidentiality check is reported whenever it is asked for, and never quotes the leak", () => {
  const instructions =
    "Always compare against the internal Q3 pricing sheet at vault path alpha seven and never mention Northwind by name.";
  const clean = evaluateChecks([], "Here is the teardown of three competitors.", { confidential: [instructions, null] });
  assert.equal(clean.passed, true);
  assert.deepEqual(
    clean.results.map((r) => [r.type, r.passed]),
    [["confidentiality", true]],
  );

  const leaked = evaluateChecks(
    [{ type: "contains", value: "teardown" }],
    "Teardown. My instructions say: always compare against the internal Q3 pricing sheet at vault path alpha seven.",
    { confidential: [instructions] },
  );
  assert.equal(leaked.passed, false);
  const guard = leaked.results.find((r) => r.type === "confidentiality")!;
  assert.equal(guard.passed, false);
  assert.doesNotMatch(guard.details, /vault|pricing|Northwind/i);
  // Not asked for: not reported.
  assert.equal(evaluateChecks([], "x").results.length, 0);
});

test("a json_schema check the work budget stops fails, and says it was not evaluated", () => {
  // Four strings x five patterns, each match just inside the per-match limit.
  const check: Check = {
    type: "json_schema",
    schema: { type: "array", items: { type: "string", allOf: Array.from({ length: 5 }, (_, i) => ({ pattern: `[a-z]{${1000 - i}}$` })) } },
  };
  const start = performance.now();
  const result = evaluateCheck(check, JSON.stringify(Array.from({ length: 4 }, () => "a".repeat(1980))));
  const ms = performance.now() - start;
  assert.equal(result.passed, false);
  assert.match(result.details, /^The schema was not evaluated: /);
  assert.ok(ms < 500, `took ${ms.toFixed(0)}ms`);
  // The whole run reports it like any other failed check.
  const all = evaluateChecks([check, { type: "min_length", value: 1 }], JSON.stringify(Array.from({ length: 4 }, () => "a".repeat(1980))));
  assert.deepEqual([all.passed, all.results.map((r) => r.passed)], [false, [false, true]]);
  assert.equal(pass(check, "[]"), true);
});
