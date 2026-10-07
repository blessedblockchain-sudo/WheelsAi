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

test("regex assertions run on the linear-time engine: a catastrophic pattern answers at once", async () => {
  const { runAssertion } = await import("../services/testing.js");

  const started = performance.now();
  const result = await runAssertion("regex", "a".repeat(30) + "!", "(a+)+$", null, null);
  assert.equal(result.passed, false);
  assert.ok(performance.now() - started < 200, "new RegExp takes minutes on this input");

  // Syntax the engine cannot express is refused, not run on the unsafe one.
  const lookbehind = await runAssertion("regex", "ab", "(?<=a)b", null, null);
  assert.equal(lookbehind.passed, false);
  assert.match(lookbehind.details, /Invalid regex pattern.*lookahead and lookbehind/);
});

test("json_schema is real JSON Schema, graded on the answer's content", async () => {
  const { runAssertion } = await import("../services/testing.js");
  const schema = {
    type: "object",
    required: ["name", "age"],
    properties: { name: { type: "string" }, age: { type: "integer", minimum: 0 } },
  };

  // A chat answer is a { role, content } message; the JSON is its content.
  const message = (content: string) => ({ role: "assistant", content });
  const ok = await runAssertion("json_schema", message('{"name":"a","age":1}'), schema, null, null);
  assert.equal(ok.passed, true);
  const fenced = await runAssertion(
    "json_schema",
    message('Here it is:\n```json\n{"name":"a","age":1}\n```'),
    schema,
    null,
    null,
  );
  assert.equal(fenced.passed, true);

  // Keys present with the wrong types used to pass.
  const wrongType = await runAssertion("json_schema", message('{"name":"a","age":"old"}'), schema, null, null);
  assert.equal(wrongType.passed, false);
  assert.match(wrongType.details, /\/age/);
  // The message wrapper itself ({ role, content }) is not what is graded.
  const wrapper = await runAssertion(
    "json_schema",
    message("plain prose"),
    { type: "object", required: ["role", "content"] },
    null,
    null,
  );
  assert.equal(wrapper.passed, false);
  assert.match(wrapper.details, /not valid JSON/);

  // The dashboard form sends the expected value as text.
  const fromText = await runAssertion("json_schema", message('{"name":"a","age":1}'), JSON.stringify(schema), null, null);
  assert.equal(fromText.passed, true);
  const badText = await runAssertion("json_schema", message("{}"), "{not json", null, null);
  assert.equal(badText.passed, false);
  assert.match(badText.details, /not valid JSON: enter a JSON Schema/);
  const badSchema = await runAssertion("json_schema", message("{}"), { type: "objekt" }, null, null);
  assert.equal(badSchema.passed, false);
});

test("a legacy example object still means 'these keys are required'", async () => {
  const { runAssertion } = await import("../services/testing.js");

  const ok = await runAssertion(
    "json_schema",
    { name: "a", age: 1 },
    { name: "", age: 0 },
    null,
    null,
  );
  assert.equal(ok.passed, true);
  assert.match(ok.details, /example object/);

  const missing = await runAssertion("json_schema", { name: "a" }, { name: "", age: 0 }, null, null);
  assert.equal(missing.passed, false);
  assert.match(missing.details, /\/age is required/);

  const notJson = await runAssertion("json_schema", "not json at all", { a: 1 }, null, null);
  assert.equal(notJson.passed, false);

  // An example whose keys happen to be schema words but not schema values.
  const lookalike = await runAssertion(
    "json_schema",
    { type: "invoice", items: 3 },
    { type: "invoice", items: 0 },
    null,
    null,
  );
  assert.equal(lookalike.passed, true);
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
