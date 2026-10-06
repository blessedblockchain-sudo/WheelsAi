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
setupEnv();

import { loadSkillsConfig } from "../config/skills.js";
import { planGraph, type InterpretableEdge, type InterpretableNode } from "../services/graphPlan.js";
import { runGraph, type GraphInterpreterDeps } from "../services/graphInterpreter.js";
import { createSkillRegistry } from "../services/skills/registry.js";

// The templates the builder offers must RUN on the interpreter. Two of them
// (rag_pipeline, tool_agent) shipped describing graphs the interpreter could
// never execute: fan-out from the input node, config keys nothing read.
// A template you can apply but not run is the first click on that screen.

async function templates() {
  const { graphTemplates } = await import("../services/agentGraph.js");
  return graphTemplates as Record<
    string,
    { nodes: InterpretableNode[]; edges: InterpretableEdge[] }
  >;
}

function registry() {
  const config = loadSkillsConfig({});
  return createSkillRegistry({
    getConfig: () => ({ config, error: null }),
    getFileStore: () => null,
    getSandbox: () => null,
    knowledge: {
      loadKnowledgeBaseId: async () => null,
      search: async () => ({ results: [], mode: "keyword", fallbackReason: null }),
    },
  });
}

test("every shipped template is a valid, plannable graph", async () => {
  for (const [id, graph] of Object.entries(await templates())) {
    const planned = planGraph(graph.nodes, graph.edges);
    assert.ok(planned.ok, `${id}: ${planned.ok ? "" : planned.error}`);
  }
});

test("tool_agent routes arithmetic to the calculator and merges the branch that ran", async () => {
  const { tool_agent } = await templates();
  const prompts: string[] = [];
  const deps = (plan: string): GraphInterpreterDeps => ({
    runLlm: async ({ prompt, systemPrompt }) => {
      prompts.push(prompt);
      if (systemPrompt?.includes("ONLY the arithmetic expression")) return { content: plan };
      return { content: `final<${prompt.replace(/\n/g, " | ")}>` };
    },
    skills: registry(),
    enabledTools: ["calculator"],
    toolContext: { agentId: "a", orgId: "o" },
  });

  const calc = await runGraph(tool_agent!.nodes, tool_agent!.edges, "what is 6 times 7?", deps("6*7"));
  assert.equal(calc.status, "completed", calc.error ?? "");
  assert.match(calc.output!, /The calculator returned: 42/);
  assert.match(calc.output!, /The user asked: what is 6 times 7\?/);
  assert.ok(calc.trace.some((t) => t.nodeId === "tool_calc" && t.status === "success"));
  assert.ok(!calc.trace.some((t) => t.nodeId === "llm_direct"), "the direct branch did not run");

  const direct = await runGraph(tool_agent!.nodes, tool_agent!.edges, "tell me a joke", deps("NONE"));
  assert.equal(direct.status, "completed", direct.error ?? "");
  assert.equal(direct.output, "final<tell me a joke>");
  assert.ok(!direct.trace.some((t) => t.nodeId === "tool_calc"), "the calculator did not run");
});

test("tool_agent on an agent WITHOUT the calculator tool enabled is refused with what to enable", async () => {
  const { tool_agent } = await templates();
  const result = await runGraph(tool_agent!.nodes, tool_agent!.edges, "what is 6 times 7?", {
    runLlm: async () => ({ content: "6*7" }),
    skills: registry(),
    enabledTools: [],
    toolContext: { agentId: "a", orgId: "o" },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.trace.find((t) => t.nodeId === "tool_calc")!.status, "refused");
  assert.match(result.error!, /tool "calculator" is not enabled on this agent/);
  // The fix it names is one the dashboard actually has (the builder's
  // "Enable on this agent"), not a tools editor that does not exist.
  assert.match(result.error!, /Enable on this agent/);
});

test("validation warns about tool nodes the agent has not enabled, instead of calling the graph fine", async () => {
  const { toolNodeWarnings } = await import("../services/agentGraph.js");
  const { tool_agent } = await templates();
  const nodes = tool_agent!.nodes as never;

  const warnings = toolNodeWarnings(nodes, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /"calculator", which is not enabled on this agent/);

  assert.deepEqual(toolNodeWarnings(nodes, ["calculator"]), []);
  // Every key the interpreter's tool node reads is checked, not just toolName.
  assert.equal(
    toolNodeWarnings(
      [{ type: "tool", data: { label: "T", config: { skill: "http_request" } } }],
      ["calculator"],
    ).length,
    1,
  );
  // An unconfigured tool node is the validator's own "no tool configured" error.
  assert.deepEqual(toolNodeWarnings([{ type: "tool", data: { label: "T", config: {} } }], []), []);
});

test("rag_pipeline is one path, asks for a knowledge base, and then grounds the answer", async () => {
  const { rag_pipeline } = await templates();
  const deps: GraphInterpreterDeps = {
    runLlm: async ({ prompt }) => ({ content: `answer(${prompt})` }),
    searchKnowledge: async () => ({ text: "[1] Policy\nRefunds within 30 days.", mode: "semantic" }),
  };

  const unconfigured = await runGraph(rag_pipeline!.nodes, rag_pipeline!.edges, "refunds?", deps);
  assert.equal(unconfigured.status, "failed");
  assert.match(unconfigured.error!, /pick a knowledge base/);

  const nodes = rag_pipeline!.nodes.map((n) =>
    n.type === "memory"
      ? { ...n, data: { ...n.data, config: { ...n.data.config, knowledgeBaseId: "kb_1" } } }
      : n,
  );
  const ok = await runGraph(nodes, rag_pipeline!.edges, "refunds?", deps);
  assert.equal(ok.status, "completed", ok.error ?? "");
  assert.match(ok.output!, /Context:\n\[1\] Policy\nRefunds within 30 days\.\n\nQuestion: refunds\?/);
});
