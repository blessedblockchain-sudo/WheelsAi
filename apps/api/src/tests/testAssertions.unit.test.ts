import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives the assertion engine behind the test runner (Wave 1).
// Previously untested, and two branches were dishonest or dangerous:
//   - "function" ran user-supplied JS via new Function() in the API
//     process (RCE for any authenticated user)
//   - "semantic" reported word overlap as semantic similarity

test("exact / contains / regex assertions grade real output", async () => {
  setupEnv();
  const { runAssertion } = await import("../services/testing.js");

  const exactPass = await runAssertion("exact", "hello world", "hello world", null, null);
  assert.equal(exactPass.passed, true);
  const exactFail = await runAssertion("exact", "hello", "hello world", null, null);
  assert.equal(exactFail.passed, false);

  const containsPass = await runAssertion(
    "contains",
    { role: "assistant", content: "The ANSWER is 42" },
    "answer",
    null,
    null,
  );
  assert.equal(containsPass.passed, true, "contains is case-insensitive");

  const regexPass = await runAssertion("regex", "order #12345 shipped", "#\\d{5}", null, null);
  assert.equal(regexPass.passed, true);
  const regexBad = await runAssertion("regex", "anything", "([unclosed", null, null);
  assert.equal(regexBad.passed, false);
  assert.match(regexBad.details, /Invalid regex/);
});

test("custom function assertions REFUSE — no arbitrary code execution in the API process", async () => {
  const { runAssertion } = await import("../services/testing.js");

  // A script that would prove execution if it ran.
  const hostile = "globalThis.__RCE_MARKER__ = true; const result = true;";
  const result = await runAssertion("function", "actual", "expected", null, hostile);

  assert.equal(result.passed, false, "must fail closed, never execute");
  assert.match(result.details, /disabled/i);
  assert.equal(
    (globalThis as Record<string, unknown>).__RCE_MARKER__,
    undefined,
    "the script must never have run",
  );
});

test("word-overlap assertion labels itself honestly (not 'semantic')", async () => {
  const { runAssertion } = await import("../services/testing.js");

  const result = await runAssertion(
    "semantic",
    "the quick brown fox",
    "the quick brown fox",
    0.9,
    null,
  );
  assert.equal(result.passed, true);
  assert.match(
    result.details,
    /word-overlap/i,
    "must not claim embedding-based semantic similarity",
  );
  assert.equal(result.score, 1);
});

test("json_schema checks required keys and rejects non-JSON output", async () => {
  const { runAssertion } = await import("../services/testing.js");

  const ok = await runAssertion(
    "json_schema",
    { name: "a", age: 1 },
    { name: "", age: 0 },
    null,
    null,
  );
  assert.equal(ok.passed, true);

  const missing = await runAssertion("json_schema", { name: "a" }, { name: "", age: 0 }, null, null);
  assert.equal(missing.passed, false);

  const notJson = await runAssertion("json_schema", "not json at all", { a: 1 }, null, null);
  assert.equal(notJson.passed, false);
});

test("an unknown assertion type fails with a clear reason", async () => {
  const { runAssertion } = await import("../services/testing.js");
  const result = await runAssertion(
    "telepathy" as never,
    "a",
    "b",
    null,
    null,
  );
  assert.equal(result.passed, false);
  assert.match(result.details, /Unknown assertion type/);
});
