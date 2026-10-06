import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_STORED_OUTPUT_CHARS,
  runOrchestrationExecution,
  type OrchestrationDef,
  type OrchestrationRunDeps,
  type OrchestrationStepDef,
  type StepRecord,
} from "../services/runOrchestrationExecution.js";

// Drives the orchestration engine (W2) — the thing that replaced Wave 0's
// honest refusal, which had replaced a setTimeout that fabricated
// per-step "success" rows. Every outcome asserted here is one the engine
// OBSERVED: real invocations, real failures, real skips.

function step(
  name: string,
  over: Partial<OrchestrationStepDef> = {},
): OrchestrationStepDef {
  return {
    id: `id-${name}`,
    name,
    stepOrder: 0,
    dependsOn: [],
    agentId: `agent-${name}`,
    inputMapping: {},
    outputMapping: {},
    condition: null,
    onError: "fail",
    fallbackAgentId: null,
    maxRetries: 0,
    timeoutMs: null,
    ...over,
  };
}

function orchestration(
  steps: OrchestrationStepDef[],
  over: Partial<OrchestrationDef> = {},
): OrchestrationDef {
  return {
    id: "orch-1",
    orgId: "org-1",
    executionMode: "sequential",
    maxConcurrency: 5,
    timeout: 60_000,
    steps: steps.map((s, i) => ({ ...s, stepOrder: s.stepOrder || i })),
    ...over,
  };
}

interface Rec {
  invocations: Array<{ agentId: string; prompt: string }>;
  records: StepRecord[];
  progress: number[];
}

/**
 * `handler` customizes what an agent returns; invocations are ALWAYS
 * recorded around it, so a test that overrides behavior still observes
 * which agents ran. (Overriding invokeAgent wholesale silently disabled
 * the recorder and made "no agent ran" assertions pass for free.)
 */
function makeDeps(
  handler?: (args: { agentId: string; prompt: string }) => Promise<{ content: string }>,
  over: Partial<OrchestrationRunDeps> = {},
): { deps: OrchestrationRunDeps; rec: Rec } {
  const rec: Rec = { invocations: [], records: [], progress: [] };
  let clock = 0;
  const deps: OrchestrationRunDeps = {
    invokeAgent: async ({ agentId, orgId, prompt }) => {
      rec.invocations.push({ agentId, prompt });
      void orgId;
      if (handler) return handler({ agentId, prompt });
      return { content: `${agentId} says hi` };
    },
    recordStepResult: async (r) => {
      rec.records.push(r);
    },
    reportProgress: async (p) => {
      rec.progress.push(p);
    },
    now: () => new Date(1_000 + clock++ * 10),
    ...over,
  };
  return { deps, rec };
}

test("a sequential run invokes each step and reports completion", async () => {
  const { deps, rec } = makeDeps();
  const result = await runOrchestrationExecution(
    orchestration([step("first"), step("second")]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "completed");
  assert.equal(result.stepsRun, 2);
  assert.deepEqual(rec.invocations.map((i) => i.agentId), [
    "agent-first",
    "agent-second",
  ]);
  assert.deepEqual(rec.records.map((r) => r.status), ["success", "success"]);
  assert.deepEqual(rec.progress, [50, 100]);
});

test("a step reads a prior step's output through its input mapping", async () => {
  const { deps, rec } = makeDeps();
  await runOrchestrationExecution(
    orchestration([
      step("classify"),
      step("answer", {
        dependsOn: ["classify"],
        inputMapping: { prompt: "$.steps.classify.output" },
      }),
    ]),
    { prompt: "go" },
    deps,
  );
  assert.equal(rec.invocations[1]!.prompt, "agent-classify says hi");
});

test("pipeline mode chains output to the next step without explicit mapping", async () => {
  const { deps, rec } = makeDeps();
  await runOrchestrationExecution(
    orchestration([step("a"), step("b", { dependsOn: ["a"] })], {
      executionMode: "pipeline",
    }),
    { prompt: "seed" },
    deps,
  );
  assert.equal(rec.invocations[0]!.prompt, "seed");
  assert.equal(rec.invocations[1]!.prompt, "agent-a says hi");
});

test("a false condition SKIPS the step and records it — not silently absent", async () => {
  const { deps, rec } = makeDeps();
  const result = await runOrchestrationExecution(
    orchestration([
      step("always"),
      step("maybe", {
        dependsOn: ["always"],
        condition: { left: "$.steps.always.output", op: "contains", right: "nope" },
      }),
    ]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "completed");
  assert.equal(result.stepsSkipped, 1);
  assert.equal(result.stepsRun, 1);
  const skipped = rec.records.find((r) => r.stepName === "maybe")!;
  assert.equal(skipped.status, "skipped");
  assert.equal(rec.invocations.length, 1, "a skipped step invokes no agent");
});

test("onError=fail aborts the run and names the failed step", async () => {
  const { deps, rec } = makeDeps(async ({ agentId }) => {
    if (agentId === "agent-boom") throw new Error("model exploded");
    return { content: "ok" };
  });
  const result = await runOrchestrationExecution(
    orchestration([step("boom"), step("never", { dependsOn: ["boom"] })]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /model exploded/);
  assert.equal(result.failedStepId, "id-boom");
  assert.equal(
    rec.invocations.filter((i) => i.agentId === "agent-never").length,
    0,
    "downstream steps do not run after an abort",
  );
});

test("onError=continue records the failure and keeps going", async () => {
  const { deps, rec } = makeDeps(async ({ agentId }) => {
    if (agentId === "agent-flaky") throw new Error("timeout");
    return { content: "ok" };
  });
  const result = await runOrchestrationExecution(
    orchestration([step("flaky", { onError: "continue" }), step("after")]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "completed");
  assert.equal(result.stepsFailed, 1);
  assert.equal(result.stepsRun, 1);
  assert.ok(rec.invocations.some((i) => i.agentId === "agent-after"));
});

test("maxRetries retries the SAME step before giving up", async () => {
  let attempts = 0;
  const { deps, rec } = makeDeps(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("transient");
    return { content: "third time lucky" };
  });
  const result = await runOrchestrationExecution(
    orchestration([step("retry", { maxRetries: 2 })]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "completed");
  assert.equal(attempts, 3);
  assert.equal(rec.records[0]!.attempt, 3, "the attempt count is recorded");
});

test("onError=fallback invokes the understudy, and a failing understudy still fails", async () => {
  const { deps, rec } = makeDeps(async ({ agentId }) => {
    if (agentId === "agent-primary") throw new Error("primary down");
    return { content: "fallback answer" };
  });
  const ok = await runOrchestrationExecution(
    orchestration([
      step("primary", { onError: "fallback", fallbackAgentId: "agent-backup" }),
    ]),
    { prompt: "go" },
    deps,
  );
  assert.equal(ok.status, "completed");
  assert.equal(rec.records[0]!.output, "fallback answer");

  const bothDown = makeDeps(async () => {
    throw new Error("everything down");
  });
  const failed = await runOrchestrationExecution(
    orchestration([
      step("primary", { onError: "fallback", fallbackAgentId: "agent-backup" }),
    ]),
    { prompt: "go" },
    bothDown.deps,
  );
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /fallback agent also failed/);
});

test("a step with no resolvable prompt fails specifically instead of prompting empty", async () => {
  const { deps, rec } = makeDeps();
  const result = await runOrchestrationExecution(
    orchestration([step("orphan")]),
    {}, // no run input, no mapping
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /has no prompt/);
  assert.equal(rec.invocations.length, 0, "no model is called with an empty prompt");
});

test("a step timeout is enforced per step", async () => {
  const { deps } = makeDeps(() => new Promise(() => {})); // never resolves
  const result = await runOrchestrationExecution(
    orchestration([step("hang", { timeoutMs: 20 })]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /timed out after 20ms/);
});

test("parallel mode fans out a level; sequential does not", async () => {
  let concurrent = 0;
  let peak = 0;
  const track = async () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 10));
    concurrent -= 1;
    return { content: "ok" };
  };

  const par = makeDeps(track);
  await runOrchestrationExecution(
    orchestration([step("a"), step("b"), step("c")], {
      executionMode: "parallel",
      maxConcurrency: 3,
    }),
    { prompt: "go" },
    par.deps,
  );
  assert.equal(peak, 3, "parallel runs an independent level together");

  concurrent = 0;
  peak = 0;
  const seq = makeDeps(track);
  await runOrchestrationExecution(
    orchestration([step("a"), step("b"), step("c")], {
      executionMode: "sequential",
    }),
    { prompt: "go" },
    seq.deps,
  );
  assert.equal(peak, 1, "sequential runs one at a time");
});

test("a failed step's output is never published to later steps", async () => {
  const { deps, rec } = makeDeps(async ({ agentId }) => {
    if (agentId === "agent-bad") throw new Error("nope");
    return { content: "fine" };
  });
  const result = await runOrchestrationExecution(
    orchestration([
      step("bad", { onError: "continue" }),
      // Not a dependent, so it runs; it just cannot read what `bad`
      // never published.
      step("reader", { inputMapping: { prompt: "$.steps.bad.output" } }),
    ]),
    {},
    deps,
  );
  // `reader` cannot resolve a prompt because `bad` published nothing —
  // it fails honestly instead of reading a half-written value.
  assert.equal(result.status, "failed");
  assert.match(result.error!, /has no prompt/);
  assert.equal(
    rec.invocations.filter((i) => i.agentId === "agent-reader").length,
    0,
  );
  const reader = rec.records.find((r) => r.stepName === "reader")!;
  assert.deepEqual(reader.input!.missingRefs, ["steps.bad.output"]);
});

test("output mapping projects the run's final output", async () => {
  const { deps } = makeDeps();
  const result = await runOrchestrationExecution(
    orchestration([
      step("classify", { outputMapping: { category: "$.steps.classify.output" } }),
    ]),
    { prompt: "go" },
    deps,
  );
  assert.deepEqual(result.output, { category: "agent-classify says hi" });
});

test("a plan error fails before any agent is invoked — nothing is charged", async () => {
  const { deps, rec } = makeDeps();
  await assert.rejects(
    runOrchestrationExecution(
      orchestration([
        step("a", { dependsOn: ["b"] }),
        step("b", { dependsOn: ["a"] }),
      ]),
      { prompt: "go" },
      deps,
    ),
    /cycle/,
  );
  assert.equal(rec.invocations.length, 0);
});

// ============================================
// Branches
// ============================================

test("a step whose every dependency was skipped is skipped: branch not taken", async () => {
  const { deps, rec } = makeDeps();
  const result = await runOrchestrationExecution(
    orchestration([
      step("gate"),
      step("left", {
        dependsOn: ["gate"],
        condition: { left: "$.steps.gate.output", op: "contains", right: "never" },
      }),
      step("after-left", { dependsOn: ["left"] }),
      step("deeper", { dependsOn: ["after-left"] }),
    ]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(rec.invocations.map((i) => i.agentId), ["agent-gate"]);
  const byName = Object.fromEntries(rec.records.map((r) => [r.stepName, r]));
  assert.equal(byName["left"]!.error, "condition not met");
  assert.equal(byName["after-left"]!.status, "skipped");
  assert.equal(byName["after-left"]!.error, "branch not taken");
  // The untaken branch stays untaken all the way down.
  assert.equal(byName["deeper"]!.error, "branch not taken");
  assert.equal(result.stepsSkipped, 3);
});

test("a join with one branch taken runs, and records what it could not read", async () => {
  const { deps, rec } = makeDeps();
  const result = await runOrchestrationExecution(
    orchestration([
      step("yes"),
      step("no", { condition: { left: "$.input.missing", op: "exists" } }),
      step("join", {
        dependsOn: ["yes", "no"],
        promptTemplate: "A: {{steps.yes.output}} B: {{steps.no.output}}",
      }),
    ]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "completed");
  const join = rec.records.find((r) => r.stepName === "join")!;
  assert.equal(join.status, "success");
  assert.equal(join.input!.prompt, "A: agent-yes says hi B: ");
  assert.deepEqual(join.input!.missingRefs, ["steps.no.output"]);
});

test("dependents of a step that failed under onError=continue are skipped", async () => {
  const { deps, rec } = makeDeps(async ({ agentId }) => {
    if (agentId === "agent-flaky") throw new Error("boom");
    return { content: "ok" };
  });
  const result = await runOrchestrationExecution(
    orchestration([
      step("flaky", { onError: "continue" }),
      step("needs-flaky", { dependsOn: ["flaky"] }),
      step("independent"),
    ]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "completed");
  const dependent = rec.records.find((r) => r.stepName === "needs-flaky")!;
  assert.equal(dependent.status, "skipped");
  assert.equal(dependent.error, "dependency failed: flaky");
  assert.deepEqual(
    rec.invocations.map((i) => i.agentId),
    ["agent-flaky", "agent-independent"],
  );
});

// ============================================
// Step types and prompts
// ============================================

test("model and retrieval steps call their own invokers, never an agent", async () => {
  const modelCalls: Array<{ deploymentId: string; modelId: string | null; prompt: string }> = [];
  const searches: Array<{ knowledgeBaseId: string; query: string; limit: number }> = [];
  const { deps, rec } = makeDeps(undefined, {
    invokeModel: async ({ deploymentId, modelId, prompt }) => {
      modelCalls.push({ deploymentId, modelId, prompt });
      return { content: "model answer" };
    },
    searchKnowledge: async ({ knowledgeBaseId, query, limit }) => {
      searches.push({ knowledgeBaseId, query, limit });
      return {
        passages: [
          { content: "first passage", documentTitle: "Doc", score: 0.9 },
          { content: "second passage" },
        ],
        mode: "keyword",
        fallbackReason: "no embedding provider configured",
      };
    },
  });

  const result = await runOrchestrationExecution(
    orchestration([
      step("search", {
        stepType: "retrieval",
        agentId: null,
        knowledgeBaseId: "kb-1",
        promptTemplate: "{{input.question}}",
        inputMapping: { limit: 3 },
      }),
      step("answer", {
        stepType: "model",
        agentId: null,
        deploymentId: "dep-1",
        modelId: "llama",
        dependsOn: ["search"],
        promptTemplate: "Context:\n{{steps.search.output.text}}\n\nQ: {{input.question}}",
      }),
    ]),
    { question: "what is it?" },
    deps,
  );

  assert.equal(result.status, "completed");
  assert.equal(rec.invocations.length, 0, "no agent was invoked");
  assert.deepEqual(searches, [{ knowledgeBaseId: "kb-1", query: "what is it?", limit: 3 }]);
  assert.deepEqual(modelCalls, [
    {
      deploymentId: "dep-1",
      modelId: "llama",
      prompt: "Context:\nfirst passage\n\nsecond passage\n\nQ: what is it?",
    },
  ]);

  const search = rec.records.find((r) => r.stepName === "search")!;
  assert.equal(search.stepType, "retrieval");
  assert.equal(search.agentId, null);
  assert.equal(search.resourceId, "kb-1");
  const found = search.output as { mode: string; fallbackReason: string; passages: unknown[] };
  // The output says which kind of search actually ran.
  assert.equal(found.mode, "keyword");
  assert.equal(found.fallbackReason, "no embedding provider configured");
  assert.equal(found.passages.length, 2);

  const answer = rec.records.find((r) => r.stepName === "answer")!;
  assert.equal(answer.stepType, "model");
  assert.equal(answer.resourceId, "dep-1");
  assert.equal(answer.output, "model answer");
});

test("a model step with no model invoker fails with a reason instead of pretending", async () => {
  const { deps, rec } = makeDeps();
  const result = await runOrchestrationExecution(
    orchestration([step("m", { stepType: "model", agentId: null, deploymentId: "dep-1" })]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /model steps are not available/);
  assert.equal(rec.invocations.length, 0);
});

test("promptTemplate takes precedence over the mapping prompt", async () => {
  const { deps, rec } = makeDeps();
  await runOrchestrationExecution(
    orchestration([
      step("a", {
        promptTemplate: "Template for {{input.topic}}",
        inputMapping: { prompt: "mapped prompt", extra: "$.input.topic" },
      }),
    ]),
    { topic: "tides", prompt: "run prompt" },
    deps,
  );
  assert.equal(rec.invocations[0]!.prompt, "Template for tides");
  // The record shows the prompt that was actually sent.
  assert.deepEqual(rec.records[0]!.input, { prompt: "Template for tides", extra: "tides" });
});

test("outputFormat json publishes a parsed object that a later condition can branch on", async () => {
  const { deps, rec } = makeDeps(async ({ agentId }) => {
    if (agentId === "agent-classify") {
      return { content: '```json\n{"label": "urgent", "score": 0.93}\n```' };
    }
    return { content: "handled" };
  });
  const result = await runOrchestrationExecution(
    orchestration([
      step("classify", { outputFormat: "json" }),
      step("escalate", {
        dependsOn: ["classify"],
        condition: { left: "$.steps.classify.output.label", op: "equals", right: "urgent" },
        promptTemplate: "Escalate (score {{steps.classify.output.score}})",
      }),
      step("ignore", {
        dependsOn: ["classify"],
        condition: { left: "$.steps.classify.output.label", op: "equals", right: "spam" },
      }),
    ]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(rec.records[0]!.output, { label: "urgent", score: 0.93 });
  assert.deepEqual(
    rec.invocations.map((i) => [i.agentId, i.prompt]),
    [
      ["agent-classify", "go"],
      ["agent-escalate", "Escalate (score 0.93)"],
    ],
  );
  assert.equal(rec.records.find((r) => r.stepName === "ignore")!.status, "skipped");
});

test("a json step that returns prose fails rather than handing prose to a condition", async () => {
  const { deps } = makeDeps(async () => ({ content: "Sure! Here you go." }));
  const result = await runOrchestrationExecution(
    orchestration([step("classify", { outputFormat: "json" })]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /not valid JSON/);
});

test("stored output is capped and marked truncated; later steps still read all of it", async () => {
  const big = "x".repeat(MAX_STORED_OUTPUT_CHARS + 500);
  const { deps, rec } = makeDeps(async ({ agentId }) => ({
    content: agentId === "agent-big" ? big : "ok",
  }));
  const result = await runOrchestrationExecution(
    orchestration([
      step("big"),
      step("reader", { dependsOn: ["big"], promptTemplate: "{{steps.big.output}}" }),
    ]),
    { prompt: "go" },
    deps,
  );
  const record = rec.records[0]!;
  assert.equal(record.truncated, true);
  assert.equal((record.output as string).length, MAX_STORED_OUTPUT_CHARS);
  assert.equal(rec.invocations[1]!.prompt.length, big.length);
  const stored = result.context.big as { output: string; truncated?: boolean };
  assert.equal(stored.truncated, true);
  assert.equal(stored.output.length, MAX_STORED_OUTPUT_CHARS);
});

// ============================================
// Loops
// ============================================

for (const [label, source] of [
  ["an array", ["alpha", "beta", "gamma"]],
  ["a JSON array in a string", '["alpha", "beta", "gamma"]'],
  ["a newline-separated list", "alpha\n\n beta \ngamma\n"],
] as const) {
  test(`forEach runs once per item of ${label}, with one record per iteration`, async () => {
    const { deps, rec } = makeDeps(async ({ prompt }) => ({ content: prompt.toUpperCase() }));
    const result = await runOrchestrationExecution(
      orchestration([
        step("each", {
          loop: { forEach: "$.input.items" },
          promptTemplate: "{{index}}:{{item}}",
          outputMapping: { all: "$.steps.each.output" },
        }),
      ]),
      { items: source },
      deps,
    );
    assert.equal(result.status, "completed");
    assert.deepEqual(rec.invocations.map((i) => i.prompt), ["0:alpha", "1:beta", "2:gamma"]);
    assert.deepEqual(rec.records.map((r) => r.iteration), [0, 1, 2]);
    assert.deepEqual(rec.records.map((r) => r.status), ["success", "success", "success"]);
    assert.deepEqual(rec.records[1]!.input, { prompt: "1:beta", item: "beta", index: 1 });
    // The step's output is the list of item outputs, in item order.
    assert.deepEqual(result.output, { all: ["0:ALPHA", "1:BETA", "2:GAMMA"] });
    assert.equal(result.stepsRun, 1);
  });
}

test("forEach over more items than maxItems fails without invoking anything", async () => {
  const { deps, rec } = makeDeps();
  const result = await runOrchestrationExecution(
    orchestration([
      step("each", { loop: { forEach: "$.input.items", maxItems: 2 }, promptTemplate: "{{item}}" }),
    ]),
    { items: ["a", "b", "c"] },
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /3 items, more than its limit of 2/);
  assert.equal(rec.invocations.length, 0, "nothing ran, so nothing is silently dropped");
  assert.equal(rec.records.length, 1);
  assert.equal(rec.records[0]!.status, "failed");
});

test("forEach over something that is not a list fails with the source named", async () => {
  const { deps, rec } = makeDeps();
  const result = await runOrchestrationExecution(
    orchestration([step("each", { loop: { forEach: "$.input.items" }, promptTemplate: "{{item}}" })]),
    { items: 42 },
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /\$\.input\.items did not resolve to a list/);
  assert.equal(rec.invocations.length, 0);
});

test("forEach items run concurrently in parallel mode, capped at maxConcurrency", async () => {
  let concurrent = 0;
  let peak = 0;
  const track = async () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 10));
    concurrent -= 1;
    return { content: "ok" };
  };
  const loopStep = step("each", { loop: { forEach: "$.input.items" }, promptTemplate: "{{item}}" });
  const items = ["a", "b", "c", "d", "e", "f"];

  const par = makeDeps(track);
  await runOrchestrationExecution(
    orchestration([loopStep], { executionMode: "parallel", maxConcurrency: 2 }),
    { items },
    par.deps,
  );
  assert.equal(peak, 2);
  assert.equal(par.rec.invocations.length, 6);

  concurrent = 0;
  peak = 0;
  const seq = makeDeps(track);
  await runOrchestrationExecution(orchestration([loopStep]), { items }, seq.deps);
  assert.equal(peak, 1, "sequential mode loops one item at a time");
});

test("a failed forEach item fails the step and stops further items", async () => {
  const { deps, rec } = makeDeps(async ({ prompt }) => {
    if (prompt === "b") throw new Error("bad item");
    return { content: "ok" };
  });
  const result = await runOrchestrationExecution(
    orchestration([
      step("each", { loop: { forEach: "$.input.items" }, promptTemplate: "{{item}}" }),
      step("after", { dependsOn: ["each"] }),
    ]),
    { items: ["a", "b", "c"] },
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /item 1: bad item/);
  assert.deepEqual(rec.invocations.map((i) => i.prompt), ["a", "b"]);
});

test("until re-runs the step until its condition holds", async () => {
  let pass = 0;
  const { deps, rec } = makeDeps(async () => {
    pass += 1;
    return { content: pass < 3 ? "draft" : "FINAL draft" };
  });
  const result = await runOrchestrationExecution(
    orchestration([
      step("refine", {
        loop: {
          until: { left: "$.steps.refine.output", op: "contains", right: "FINAL" },
          maxIterations: 5,
        },
        promptTemplate: "pass {{iteration}}",
        outputMapping: { result: "$.steps.refine.output" },
      }),
    ]),
    {},
    deps,
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(rec.invocations.map((i) => i.prompt), ["pass 1", "pass 2", "pass 3"]);
  assert.deepEqual(rec.records.map((r) => r.iteration), [1, 2, 3]);
  assert.deepEqual(result.output, { result: "FINAL draft" });
});

test("until that never holds fails when exhausted, or continues if configured", async () => {
  const never = { left: "$.steps.refine.output", op: "contains", right: "FINAL" };

  const failing = makeDeps(async () => ({ content: "draft" }));
  const failed = await runOrchestrationExecution(
    orchestration([step("refine", { loop: { until: never, maxIterations: 2 } })]),
    { prompt: "go" },
    failing.deps,
  );
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /until condition was not met after 2 iterations/);
  assert.equal(failing.rec.invocations.length, 2, "bounded: it stops at maxIterations");

  const continuing = makeDeps(async () => ({ content: "draft" }));
  const continued = await runOrchestrationExecution(
    orchestration([
      step("refine", {
        loop: { until: never, maxIterations: 2, onExhausted: "continue" },
        outputMapping: { result: "$.steps.refine.output" },
      }),
    ]),
    { prompt: "go" },
    continuing.deps,
  );
  assert.equal(continued.status, "completed");
  assert.deepEqual(continued.output, { result: "draft" });
});

// ============================================
// Stopping and retries
// ============================================

test("a cancel mid-run ends the run 'cancelled' and makes no further invocations", async () => {
  const controller = new AbortController();
  const signals: Array<AbortSignal | undefined> = [];
  const rec: Rec = { invocations: [], records: [], progress: [] };
  const deps: OrchestrationRunDeps = {
    invokeAgent: ({ agentId, prompt, signal }) => {
      rec.invocations.push({ agentId, prompt });
      signals.push(signal);
      if (agentId === "agent-slow") {
        // Honours its signal the way a real model call does.
        return new Promise((_, reject) => {
          signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          setTimeout(() => controller.abort("cancel"), 5);
        });
      }
      return Promise.resolve({ content: "ok" });
    },
    recordStepResult: async (r) => {
      rec.records.push(r);
    },
    signal: controller.signal,
  };

  const result = await runOrchestrationExecution(
    orchestration([step("first"), step("slow"), step("never")]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "cancelled");
  assert.deepEqual(rec.invocations.map((i) => i.agentId), ["agent-first", "agent-slow"]);
  assert.ok(signals[1]!.aborted, "the in-flight call received the abort");
  const slow = rec.records.find((r) => r.stepName === "slow")!;
  assert.equal(slow.status, "failed");
  assert.equal(slow.error, "cancelled while running");
  // What finished before the cancel is kept.
  assert.ok("first" in result.context);
});

test("a cancel requested between steps stops before the next one", async () => {
  let asked = 0;
  const { deps, rec } = makeDeps(undefined, {
    isCancelRequested: async () => ++asked > 1,
  });
  const result = await runOrchestrationExecution(
    orchestration([step("first"), step("second")]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "cancelled");
  assert.deepEqual(rec.invocations.map((i) => i.agentId), ["agent-first"]);
});

test("an abort with reason 'timeout' ends the run failed with a timeout message", async () => {
  const controller = new AbortController();
  const { deps, rec } = makeDeps(
    () =>
      new Promise(() => {
        // Ignores its signal: the engine must still let go of it.
        setTimeout(() => controller.abort("timeout"), 5);
      }),
    { signal: controller.signal },
  );
  const result = await runOrchestrationExecution(
    orchestration([step("hang"), step("never")], { timeout: 12_345 }),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error, "workflow timed out after 12345ms");
  assert.equal(rec.invocations.length, 1);
});

test("an aborted step is not retried and does not fall back", async () => {
  const controller = new AbortController();
  const { deps, rec } = makeDeps(
    async () => {
      controller.abort("cancel");
      throw new Error("aborted");
    },
    { signal: controller.signal },
  );
  const result = await runOrchestrationExecution(
    orchestration([
      step("s", { maxRetries: 3, onError: "fallback", fallbackAgentId: "agent-understudy" }),
    ]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "cancelled");
  assert.equal(rec.invocations.length, 1);
});

test("a step timeout aborts the call's own signal", async () => {
  let seen: AbortSignal | undefined;
  const rec: StepRecord[] = [];
  const result = await runOrchestrationExecution(
    orchestration([step("hang", { timeoutMs: 15 })]),
    { prompt: "go" },
    {
      invokeAgent: ({ signal }) => {
        seen = signal;
        return new Promise(() => {});
      },
      recordStepResult: async (r) => {
        rec.push(r);
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.ok(seen!.aborted, "the callee was told to stop, not just abandoned");
});

test("retryPolicy supplies default retries and backs off through the injected sleep", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const { deps, rec } = makeDeps(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("flaky");
      return { content: "third time" };
    },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  const result = await runOrchestrationExecution(
    orchestration([step("s")], { retryPolicy: { maxRetries: 2, backoffMs: 100 } }),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "completed");
  assert.equal(rec.records[0]!.attempt, 3);
  assert.deepEqual(sleeps, [100, 200]);
});

test("a step's own maxRetries overrides the workflow default", async () => {
  const { deps, rec } = makeDeps(async () => {
    throw new Error("always");
  });
  const result = await runOrchestrationExecution(
    orchestration([step("s", { maxRetries: 1 })], { retryPolicy: { maxRetries: 4 } }),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "failed");
  assert.equal(rec.invocations.length, 2);
});

test("$.previous follows plan order in parallel mode, not finish order", async () => {
  // `a` finishes LAST but `b` is last in plan order: previous must be b's.
  const { deps, rec } = makeDeps(async ({ agentId }) => {
    if (agentId === "agent-a") await new Promise((r) => setTimeout(r, 20));
    return { content: `from ${agentId}` };
  });
  await runOrchestrationExecution(
    orchestration(
      [
        step("a"),
        step("b"),
        step("c", { dependsOn: ["a", "b"], inputMapping: { prompt: "$.previous.output" } }),
      ],
      { executionMode: "parallel", maxConcurrency: 5 },
    ),
    { prompt: "go" },
    deps,
  );
  assert.equal(rec.invocations.find((i) => i.agentId === "agent-c")!.prompt, "from agent-b");
});

test("a template that cannot render fails the run before anything is invoked", async () => {
  const { deps, rec } = makeDeps();
  await assert.rejects(
    runOrchestrationExecution(
      orchestration([step("a"), step("b", { promptTemplate: "{{input.x | shout}}" })]),
      { prompt: "go" },
      deps,
    ),
    /unknown template filter "shout"/,
  );
  assert.equal(rec.invocations.length, 0);
});

// ---------------------------------------------------------------------------
// Per-step usage
// ---------------------------------------------------------------------------

test("each pass records the tokens its model call reported", async () => {
  const { deps, rec } = makeDeps(undefined, {
    invokeAgent: async ({ agentId }) => ({
      content: `${agentId} answer`,
      usage: agentId === "agent-first" ? { inputTokens: 10, outputTokens: 4 } : { inputTokens: 7, outputTokens: 2 },
    }),
  });
  const result = await runOrchestrationExecution(
    orchestration([step("first"), step("second")]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(rec.records.map((r) => [r.stepName, r.usage]), [
    ["first", { inputTokens: 10, outputTokens: 4 }],
    ["second", { inputTokens: 7, outputTokens: 2 }],
  ]);
});

test("a model call that answers without a count is recorded as unreported, never as zero", async () => {
  const { deps, rec } = makeDeps(undefined, {
    invokeAgent: async () => ({ content: "answer" }),
    invokeModel: async () => ({ content: "model answer", usage: { inputTokens: "many" } }),
  });
  await runOrchestrationExecution(
    orchestration([
      step("agent"),
      step("model", { stepType: "model", agentId: null, deploymentId: "dep-1" }),
    ]),
    { prompt: "go" },
    deps,
  );
  assert.deepEqual(rec.records.map((r) => r.usage), ["unreported", "unreported"]);
});

test("a retrieval step, a skipped step and a failed step record no usage", async () => {
  const { deps, rec } = makeDeps(undefined, {
    invokeAgent: async ({ agentId }) => {
      if (agentId === "agent-broken") throw new Error("provider down");
      return { content: "ok", usage: { inputTokens: 1, outputTokens: 1 } };
    },
    searchKnowledge: async () => ({ passages: [{ content: "passage" }], mode: "keyword" }),
  });
  const result = await runOrchestrationExecution(
    orchestration([
      step("find", { stepType: "retrieval", agentId: null, knowledgeBaseId: "kb-1" }),
      step("broken", { onError: "continue" }),
      step("after", { dependsOn: ["broken"] }),
    ]),
    { prompt: "go" },
    deps,
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(rec.records.map((r) => [r.stepName, r.status, r.usage]), [
    ["find", "success", null],
    ["broken", "failed", null],
    ["after", "skipped", null],
  ]);
});

test("a step answered by its fallback agent records the fallback's usage", async () => {
  const { deps, rec } = makeDeps(undefined, {
    invokeAgent: async ({ agentId }) => {
      if (agentId === "agent-main") throw new Error("provider down");
      return { content: "understudy", usage: { inputTokens: 3, outputTokens: 9 } };
    },
  });
  await runOrchestrationExecution(
    orchestration([step("main", { onError: "fallback", fallbackAgentId: "agent-understudy" })]),
    { prompt: "go" },
    deps,
  );
  assert.deepEqual(rec.records.map((r) => [r.status, r.usage]), [["success", { inputTokens: 3, outputTokens: 9 }]]);
});

test("readStepUsage accepts only two non-negative token counts", async () => {
  const { readStepUsage } = await import("../services/runOrchestrationExecution.js");
  assert.deepEqual(readStepUsage({ inputTokens: 0, outputTokens: 5, extra: 1 }), { inputTokens: 0, outputTokens: 5 });
  for (const bad of [null, undefined, "12", {}, { inputTokens: 1 }, { inputTokens: -1, outputTokens: 1 }, { inputTokens: NaN, outputTokens: 1 }]) {
    assert.equal(readStepUsage(bad), null);
  }
});
