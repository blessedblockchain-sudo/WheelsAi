import assert from "node:assert/strict";
import test from "node:test";

import {
  applyInputMapping,
  applyOutputMapping,
  collectReferences,
  collectTemplateReferences,
  evaluateCondition,
  parseStepOutput,
  PromptTemplateError,
  renderPromptTemplate,
  resolveStepPrompt,
  resolveValue,
  StepOutputError,
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

// ============================================
// Prompt templates
// ============================================

test("a template substitutes run input, step outputs and the previous output", () => {
  const rendered = renderPromptTemplate(
    "Topic: {{input.topic}}. Class: {{ steps.classify.output }}. Before: {{previous.output}}.",
    ctx({
      input: { topic: "tides" },
      previous: { output: "earlier text" },
    }),
  );
  assert.equal(rendered.text, "Topic: tides. Class: science. Before: earlier text.");
  assert.deepEqual(rendered.missingRefs, []);
});

test("a template reads nested paths inside a JSON step output", () => {
  const rendered = renderPromptTemplate(
    "{{steps.extract.output.customer.name}} has {{steps.extract.output.items.1}}",
    ctx({
      steps: { extract: { output: { customer: { name: "Ada" }, items: ["pen", "ink"] } } },
    }),
  );
  assert.equal(rendered.text, "Ada has ink");
});

test("loop variables render: item, index and iteration", () => {
  const forEach = renderPromptTemplate(
    "#{{index}} {{item}} / {{item.title}}",
    ctx({ item: { title: "Row" }, index: 2 }),
  );
  assert.equal(forEach.text, '#2 {"title":"Row"} / Row');
  assert.equal(renderPromptTemplate("pass {{iteration}}", ctx({ iteration: 3 })).text, "pass 3");
});

test("objects render as JSON, and the json filter renders a quoted literal", () => {
  const context = ctx({ input: { name: 'Ada "the" Great', tags: ["a", "b"], count: 3 } });
  assert.equal(renderPromptTemplate("{{input.tags}}", context).text, '["a","b"]');
  assert.equal(renderPromptTemplate("{{input.count}}", context).text, "3");
  assert.equal(
    renderPromptTemplate("name = {{ input.name | json }}", context).text,
    'name = "Ada \\"the\\" Great"',
  );
  assert.equal(renderPromptTemplate("{{input.nope | json}}", context).text, "null");
});

test("a reference that resolves to nothing renders empty and is reported", () => {
  const rendered = renderPromptTemplate("A{{steps.ghost.output}}B{{input.nope}}C", ctx());
  assert.equal(rendered.text, "ABC");
  assert.deepEqual(rendered.missingRefs, ["steps.ghost.output", "input.nope"]);
});

test("JS-looking template text stays inert", () => {
  const hostile = [
    "{{constructor.constructor('return process')()}}",
    "{{ process.exit(1) }}",
    "{{ 1 + 1 }}",
    "{{input.x}}{{__proto__.polluted}}",
    "${input.question} {{ require('child_process') }}",
  ].join(" | ");
  const rendered = renderPromptTemplate(hostile, ctx({ input: { x: "X" } }));
  assert.equal(
    rendered.text,
    [
      "{{constructor.constructor('return process')()}}",
      "{{ process.exit(1) }}",
      "{{ 1 + 1 }}",
      "X{{__proto__.polluted}}",
      "${input.question} {{ require('child_process') }}",
    ].join(" | "),
  );
});

test("a reference cannot reach the prototype chain", () => {
  const context = ctx({ input: { safe: { a: 1 } } });
  assert.equal(resolveValue("$.input.constructor", context), undefined);
  assert.equal(resolveValue("$.input.safe.__proto__", context), undefined);
  assert.equal(resolveValue("$.input.safe.toString", context), undefined);
  assert.equal(renderPromptTemplate("{{input.safe.constructor.name}}", context).text, "");
});

test("an unknown filter is an error, not a silent no-op", () => {
  assert.throws(
    () => renderPromptTemplate("{{input.question | upper}}", ctx()),
    (err: unknown) =>
      err instanceof PromptTemplateError && /unknown template filter "upper"/.test(err.message),
  );
  assert.throws(() => renderPromptTemplate("{{input.question | json | json}}", ctx()), /more than one filter/);
});

test("references are collected statically from templates and mappings", () => {
  assert.deepEqual(
    collectTemplateReferences("{{steps.a.output}} {{input.x}} {{ not a ref }} {{steps.b.output.k | json}}").map(
      (r) => [r.kind, r.step ?? null],
    ),
    [
      ["steps", "a"],
      ["input", null],
      ["steps", "b"],
    ],
  );
  const found = collectReferences({
    prompt: "$.steps.a.output",
    nested: ["literal", "$.previous.output", { deep: "$.item.name" }],
    broken: "$.steps.a.result",
  });
  assert.deepEqual(
    found.map((r) => [r.kind, r.raw]),
    [
      ["steps", "steps.a.output"],
      ["previous", "previous.output"],
      ["item", "item.name"],
      [null, "steps.a.result"],
    ],
  );
});

// ============================================
// Step output
// ============================================

test("text output is kept as is; json output is parsed, code fence or not", () => {
  assert.equal(parseStepOutput('{"a":1}', "text"), '{"a":1}');
  assert.deepEqual(parseStepOutput('{"a":1}', "json"), { a: 1 });
  assert.deepEqual(parseStepOutput('```json\n{"a": [1, 2]}\n```', "json"), { a: [1, 2] });
  assert.deepEqual(parseStepOutput("  ```\n[true]\n```  ", "json"), [true]);
});

test("invalid json output is rejected", () => {
  assert.throws(
    () => parseStepOutput("Sure, here is the JSON you asked for", "json"),
    (err: unknown) => err instanceof StepOutputError && /not valid JSON/.test(err.message),
  );
});
