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

// Drives the composition root for graph runs. The properties: the run's
// cancellation signal and tool mode reach the interpreter (a graph run used to
// have neither), and `tool` nodes are limited to the agent's own tools.

const agent = {
  agentId: "agent_1",
  orgId: "org_1",
  agentName: "A",
  systemPrompt: null,
  modelConfig: {},
  env: {},
  tools: [
    { name: "calculator", description: "calc" },
    { name: "web_search", description: "search" },
  ],
};

test("the caller's signal and the tool mode reach the interpreter", async () => {
  const { buildGraphInterpreterDeps } = await import("../services/buildGraphInterpreterDeps.js");
  const controller = new AbortController();
  const deps = buildGraphInterpreterDeps(agent, { signal: controller.signal, toolMode: "trial" });
  assert.equal(deps.signal, controller.signal);
  assert.equal(deps.toolMode, "trial");
  assert.deepEqual(deps.toolContext, { agentId: "agent_1", orgId: "org_1" });
});

test("tool nodes may use only the tools the agent has enabled", async () => {
  const { buildGraphInterpreterDeps } = await import("../services/buildGraphInterpreterDeps.js");
  const deps = buildGraphInterpreterDeps(agent);
  assert.deepEqual(deps.enabledTools, ["calculator", "web_search"]);
  assert.equal(deps.toolMode, "graph", "graph is the default mode");

  const none = buildGraphInterpreterDeps({ ...agent, tools: undefined });
  assert.deepEqual(none.enabledTools, []);
});
