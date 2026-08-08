import assert from "node:assert/strict";
import test from "node:test";

import {
  REFUSED_NODE_TYPES,
  renderTemplate,
  runGraph,
  type GraphInterpreterDeps,
  type InterpretableEdge,
  type InterpretableNode,
} from "../services/graphInterpreter.js";

// Drives the linear graph interpreter (W2, stage 1 of the builder
// runtime). Before this, the visual builder could draw a graph and
// compile it to an ORDER, but nothing executed it — the canvas was a
// drawing. The property under test throughout: what the interpreter
// cannot honestly run, it REFUSES BY NAME rather than walking an
// arbitrary path and reporting success.

function node(
  id: string,
  type: string,
  config: Record<string, unknown> = {},
  label?: string,
): InterpretableNode {
  return { id, type, data: { label: label ?? id, config } };
}

function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string,
): InterpretableEdge {
  return { id, source, target, sourceHandle };
}

function makeDeps(
  over: Partial<GraphInterpreterDeps> = {},
): { deps: GraphInterpreterDeps; prompts: string[] } {
  const prompts: string[] = [];
  const deps: GraphInterpreterDeps = {
    runLlm: async ({ prompt }) => {
      prompts.push(prompt);
      return { content: `answered: ${prompt}` };
    },
    sleep: async () => {},
    now: () => 0,
    ...over,
  };
  return { deps, prompts };
}

// ============================================
// The happy path
// ============================================

test("a linear input -> llm -> output graph runs and returns the model's answer", async () => {
  const { deps, prompts } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("llm", "llm"), node("out", "output")],
    [edge("e1", "in", "llm"), edge("e2", "llm", "out")],
    "hello",
    deps,
  );
  assert.equal(result.status, "completed");
  assert.equal(result.output, "answered: hello");
  assert.deepEqual(prompts, ["hello"]);
  assert.deepEqual(
    result.trace.map((t) => `${t.nodeType}:${t.status}`),
    ["input:success", "llm:success", "output:success"],
  );
});

test("the trace records what entered and left every node", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("llm", "llm"), node("out", "output")],
    [edge("e1", "in", "llm"), edge("e2", "llm", "out")],
    "seed",
    deps,
  );
  const llmStep = result.trace.find((t) => t.nodeType === "llm")!;
  assert.equal(llmStep.input, "seed");
  assert.equal(llmStep.output, "answered: seed");
});

test("a node's own system prompt and model override the agent's", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const { deps } = makeDeps({
    runLlm: async (args) => {
      seen.push(args as unknown as Record<string, unknown>);
      return { content: "ok" };
    },
  });
  await runGraph(
    [
      node("in", "input"),
      node("llm", "llm", {
        systemPrompt: "Be terse.",
        model: "free/groq/llama-3.1-8b",
        temperature: 0.1,
      }),
      node("out", "output"),
    ],
    [edge("e1", "in", "llm"), edge("e2", "llm", "out")],
    "q",
    deps,
  );
  assert.equal(seen[0]!.systemPrompt, "Be terse.");
  assert.equal(seen[0]!.model, "free/groq/llama-3.1-8b");
  assert.equal(seen[0]!.temperature, 0.1);
});

// ============================================
// Refusals — the honest core
// ============================================

test("a `code` node refuses by name: it would be RCE in the API process", async () => {
  const { deps, prompts } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("code", "code"), node("out", "output")],
    [edge("e1", "in", "code"), edge("e2", "code", "out")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /remote-code-execution/);
  const refused = result.trace.find((t) => t.nodeType === "code")!;
  assert.equal(refused.status, "refused", "refusal is a distinct state, not a generic failure");
  assert.equal(prompts.length, 0);
});

test("non-linear node types refuse rather than silently taking one branch", async () => {
  for (const type of ["loop", "parallel", "merge"]) {
    const { deps } = makeDeps();
    const result = await runGraph(
      [node("in", "input"), node("n", type), node("out", "output")],
      [edge("e1", "in", "n"), edge("e2", "n", "out")],
      "x",
      deps,
    );
    assert.equal(result.status, "failed", type);
    assert.equal(result.trace.at(-1)!.status, "refused", type);
  }
});

test("every refusal carries a reason a builder can act on", () => {
  for (const [type, reason] of Object.entries(REFUSED_NODE_TYPES)) {
    assert.ok(reason.length > 40, `${type} needs a real explanation`);
  }
  assert.match(REFUSED_NODE_TYPES.api!, /SSRF/);
  assert.match(REFUSED_NODE_TYPES.code!, /sandbox/);
});

test("plain fan-out is refused — stage 1 walks exactly one path", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("a", "output"), node("b", "output")],
    [edge("e1", "in", "a"), edge("e2", "in", "b")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /2 outgoing edges/);
  assert.match(result.error!, /full graph engine/);
});

// ============================================
// Conditions
// ============================================

test("a condition takes the true branch and skips the false one", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [
      node("in", "input"),
      node("cond", "condition", { op: "contains", value: "urgent" }),
      node("yes", "transform", { template: "ESCALATED: {{value}}" }),
      node("no", "transform", { template: "routine: {{value}}" }),
      node("out", "output"),
    ],
    [
      edge("e1", "in", "cond"),
      edge("e2", "cond", "yes", "true"),
      edge("e3", "cond", "no", "false"),
      edge("e4", "yes", "out"),
      edge("e5", "no", "out"),
    ],
    "this is urgent",
    deps,
  );
  assert.equal(result.status, "completed");
  assert.equal(result.output, "ESCALATED: this is urgent");
  assert.ok(!result.trace.some((t) => t.nodeId === "no"), "false branch not walked");
});

test("a condition takes the false branch when it does not match", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [
      node("in", "input"),
      node("cond", "condition", { op: "contains", value: "urgent" }),
      node("yes", "transform", { template: "ESCALATED" }),
      node("no", "transform", { template: "routine" }),
      node("out", "output"),
    ],
    [
      edge("e1", "in", "cond"),
      edge("e2", "cond", "yes", "true"),
      edge("e3", "cond", "no", "false"),
      edge("e4", "yes", "out"),
      edge("e5", "no", "out"),
    ],
    "just saying hi",
    deps,
  );
  assert.equal(result.output, "routine");
});

// ============================================
// Transform + memory
// ============================================

test("transform is string templating, never code", () => {
  assert.equal(renderTemplate("Q: {{value}}", "hi", {}), "Q: hi");
  assert.equal(
    renderTemplate("{{nodes.step1}} then {{value}}", "b", { step1: "a" }),
    "a then b",
  );
  // An unknown reference renders empty rather than leaking or executing.
  assert.equal(renderTemplate("{{process.env.SECRET}}", "x", {}), "");
  // A JS-looking template is inert text.
  assert.equal(
    renderTemplate("${globalThis.process.exit(1)}", "x", {}),
    "${globalThis.process.exit(1)}",
  );
});

test("a memory node injects retrieved passages into the walk", async () => {
  const { deps, prompts } = makeDeps({
    searchKnowledge: async ({ query, limit }) => {
      assert.equal(query, "what is the refund policy?");
      assert.equal(limit, 2);
      return { text: "[1] Policy\nRefunds within 30 days.", mode: "semantic" };
    },
  });
  const result = await runGraph(
    [
      node("in", "input"),
      node("mem", "memory", { knowledgeBaseId: "kb-1", topK: 2 }),
      node("llm", "llm"),
      node("out", "output"),
    ],
    [edge("e1", "in", "mem"), edge("e2", "mem", "llm"), edge("e3", "llm", "out")],
    "what is the refund policy?",
    deps,
  );
  assert.equal(result.status, "completed");
  assert.match(prompts[0]!, /Refunds within 30 days/);
});

test("a memory node with no hits continues with the query rather than failing", async () => {
  const { deps, prompts } = makeDeps({
    searchKnowledge: async () => null,
  });
  const result = await runGraph(
    [
      node("in", "input"),
      node("mem", "memory", { knowledgeBaseId: "kb-1" }),
      node("llm", "llm"),
      node("out", "output"),
    ],
    [edge("e1", "in", "mem"), edge("e2", "mem", "llm"), edge("e3", "llm", "out")],
    "obscure question",
    deps,
  );
  assert.equal(result.status, "completed");
  assert.equal(prompts[0], "obscure question", "a miss is not a failure");
});

test("a memory node without a knowledge base fails with an actionable message", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("mem", "memory"), node("out", "output")],
    [edge("e1", "in", "mem"), edge("e2", "mem", "out")],
    "q",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /pick a knowledge base/);
});

// ============================================
// Structural errors
// ============================================

test("a graph with no input node, or several, is refused", async () => {
  const { deps } = makeDeps();
  const none = await runGraph([node("out", "output")], [], "x", deps);
  assert.match(none.error!, /no input node/);

  const many = await runGraph(
    [node("a", "input"), node("b", "input"), node("out", "output")],
    [edge("e1", "a", "out")],
    "x",
    deps,
  );
  assert.match(many.error!, /2 input nodes/);
});

test("a dangling path fails instead of quietly ending", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("llm", "llm")],
    [edge("e1", "in", "llm")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /no outgoing edge/);
});

test("a cycle hits the step budget rather than spinning forever", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("a", "transform"), node("b", "transform")],
    [edge("e1", "in", "a"), edge("e2", "a", "b"), edge("e3", "b", "a")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /step budget/);
});

test("an llm failure is recorded on its node, not swallowed", async () => {
  const { deps } = makeDeps({
    runLlm: async () => {
      throw new Error("provider 503");
    },
  });
  const result = await runGraph(
    [node("in", "input"), node("llm", "llm"), node("out", "output")],
    [edge("e1", "in", "llm"), edge("e2", "llm", "out")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /provider 503/);
  const failed = result.trace.find((t) => t.nodeType === "llm")!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.input, "x", "the failing node's input is preserved for debugging");
});

test("a delay is bounded — a graph cannot pin a worker for an hour", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("wait", "delay", { ms: 3_600_000 }), node("out", "output")],
    [edge("e1", "in", "wait"), edge("e2", "wait", "out")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /delay must be between/);
});

test("an unknown node type fails by name instead of being skipped", async () => {
  const { deps } = makeDeps();
  const result = await runGraph(
    [node("in", "input"), node("weird", "quantum_flux"), node("out", "output")],
    [edge("e1", "in", "weird"), edge("e2", "weird", "out")],
    "x",
    deps,
  );
  assert.equal(result.status, "failed");
  assert.match(result.error!, /unknown node type "quantum_flux"/);
});
