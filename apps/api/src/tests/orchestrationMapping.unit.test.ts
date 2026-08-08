import assert from "node:assert/strict";
import test from "node:test";

import {
  applyInputMapping,
  applyOutputMapping,
  evaluateCondition,
  resolveStepPrompt,
  resolveValue,
  type MappingContext,
} from "../services/orchestrationMapping.js";

// Drives apps/api/src/services/orchestrationMapping.ts (W2) — how steps
// pass data to each other. This layer is DELIBERATELY not an expression
// evaluator: the test runner once shipped `new Function(userScript)`,
// which was RCE for any authenticated user. These tests pin that
// user-supplied strings stay DATA.

function ctx(over: Partial<MappingContext> = {}): MappingContext {
  return {
    input: { question: "why is the sky blue?", count: 3 },
    steps: { classify: { output: "science" } },
    ...over,
  };
}

test("$. references resolve from run input and prior step output", () => {
  const c = ctx();
  assert.equal(resolveValue("$.input.question", c), "why is the sky blue?");
  assert.equal(resolveValue("$.steps.classify.output", c), "science");
});

test("a plain string is a literal — prompts need no escaping", () => {
  assert.equal(
    resolveValue("Summarize this in $ terms.", ctx()),
    "Summarize this in $ terms.",
  );
});

test("references resolve recursively inside objects and arrays", () => {
  const resolved = applyInputMapping(
    {
      prompt: "$.input.question",
      meta: { topic: "$.steps.classify.output", fixed: "literal" },
      list: ["$.input.count", "raw"],
    },
    ctx(),
  );
  assert.deepEqual(resolved, {
    prompt: "why is the sky blue?",
    meta: { topic: "science", fixed: "literal" },
    list: [3, "raw"],
  });
});

test("an unresolvable reference yields undefined rather than throwing", () => {
  // The step then fails on its own missing input, which names the step —
  // far more debuggable than a mapping-layer stack trace.
  assert.equal(resolveValue("$.steps.nope.output", ctx()), undefined);
  assert.equal(resolveValue("$.input.missing.deep", ctx()), undefined);
  assert.equal(resolveValue("$.bogus.thing", ctx()), undefined);
});

test("no injected code path: a JS-looking string stays a string", () => {
  const attack = "${process.exit(1)}";
  assert.equal(resolveValue(attack, ctx()), attack);
  const mapped = applyInputMapping({ prompt: "require('fs')" }, ctx());
  assert.equal(mapped.prompt, "require('fs')");
});

// ============================================
// Prompt resolution
// ============================================

test("an explicit prompt in the mapping wins", () => {
  const prompt = resolveStepPrompt({ prompt: "explicit" }, ctx(), "sequential");
  assert.equal(prompt, "explicit");
});

test("pipeline mode chains the previous step's output when no prompt is mapped", () => {
  const c = ctx({
    input: { prompt: "the original ask" },
    previous: { output: "prior answer" },
  });
  assert.equal(resolveStepPrompt({}, c, "pipeline"), "prior answer");
  // Sequential does NOT chain implicitly — it falls back to the run
  // input's own prompt/input field.
  assert.equal(resolveStepPrompt({}, c, "sequential"), "the original ask");
});

test("with nothing to say, the prompt is null so the engine can fail specifically", () => {
  const c: MappingContext = { input: {}, steps: {} };
  assert.equal(resolveStepPrompt({}, c, "sequential"), null);
});

test("a structured explicit prompt is serialized rather than stringified to [object Object]", () => {
  const prompt = resolveStepPrompt(
    { prompt: { task: "classify", text: "hi" } },
    ctx(),
    "sequential",
  );
  assert.equal(prompt, '{"task":"classify","text":"hi"}');
});

// ============================================
// Output mapping
// ============================================

test("output mapping projects step outputs into the run output", () => {
  const mapped = applyOutputMapping(
    { category: "$.steps.classify.output", note: "done" },
    ctx(),
  );
  assert.deepEqual(mapped, { category: "science", note: "done" });
});

test("absent mapping yields an empty projection, not a crash", () => {
  assert.deepEqual(applyOutputMapping(null, ctx()), {});
  assert.deepEqual(applyOutputMapping(undefined, ctx()), {});
});

// ============================================
// Conditions
// ============================================

test("no condition means the step runs", () => {
  assert.equal(evaluateCondition(null, ctx()).run, true);
  assert.equal(evaluateCondition(undefined, ctx()).run, true);
});

test("equality, containment and existence conditions gate on real data", () => {
  const c = ctx();
  assert.equal(
    evaluateCondition({ left: "$.steps.classify.output", op: "equals", right: "science" }, c).run,
    true,
  );
  assert.equal(
    evaluateCondition({ left: "$.steps.classify.output", op: "equals", right: "sports" }, c).run,
    false,
  );
  assert.equal(
    evaluateCondition({ left: "$.input.question", op: "contains", right: "sky" }, c).run,
    true,
  );
  assert.equal(
    evaluateCondition({ left: "$.steps.missing.output", op: "exists" }, c).run,
    false,
  );
  assert.equal(
    evaluateCondition({ left: "$.steps.missing.output", op: "not_exists" }, c).run,
    true,
  );
});

test("numeric comparisons coerce numeric strings but refuse nonsense", () => {
  const c = ctx({ input: { score: "42" } });
  assert.equal(evaluateCondition({ left: "$.input.score", op: "gt", right: 40 }, c).run, true);
  assert.equal(evaluateCondition({ left: "$.input.score", op: "lt", right: 40 }, c).run, false);
  const bad = evaluateCondition(
    { left: "$.input.score", op: "gt", right: "banana" },
    c,
  );
  assert.equal(bad.run, false);
  assert.match(bad.reason!, /non-numeric/);
});

test("a MALFORMED condition skips the step rather than letting it run", () => {
  // A broken gate must not silently open — the author wrote a guard.
  const noOp = evaluateCondition({ left: "$.input.x" }, ctx());
  assert.equal(noOp.run, false);
  assert.match(noOp.reason!, /missing `op`/);

  const unknown = evaluateCondition({ left: 1, op: "sorta_equals", right: 1 }, ctx());
  assert.equal(unknown.run, false);
  assert.match(unknown.reason!, /unsupported condition operator/);

  assert.equal(evaluateCondition("truthy string", ctx()).run, false);
});
