import assert from "node:assert/strict";
import test from "node:test";

import {
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
    orchestration([
      step("flaky", { onError: "continue" }),
      step("after", { dependsOn: ["flaky"] }),
    ]),
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
      step("reader", {
        dependsOn: ["bad"],
        inputMapping: { prompt: "$.steps.bad.output" },
      }),
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
