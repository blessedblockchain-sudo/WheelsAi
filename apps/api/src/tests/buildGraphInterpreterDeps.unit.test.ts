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

// ============================================
// The model an llm node runs on
// ============================================

test("an llm node picks its model as an agent chat does, hosted models included", async () => {
  const { resolveNodeModel } = await import("../services/buildGraphInterpreterDeps.js");
  const asked: unknown[] = [];
  const deps = {
    availableFreeModelIds: () => ["free/groq/llama-3.3-70b"],
    resolveModel: (modelId: string) => ({ apiKey: "k", baseUrl: "https://provider.example/v1", modelName: modelId }),
    resolveHostedModel: async (args: { orgId: string; modelId: string }) => {
      asked.push(args);
      return {
        ok: true as const,
        resolved: { apiKey: "", baseUrl: "https://node.example/v1", modelName: "meta/llama-3.1-8b" },
      };
    },
  };
  const agentOn = (modelConfig: Record<string, unknown>) => ({ orgId: "org-1", modelConfig, env: {} });

  // The node's own choice, then externalModel, then the legacy key, then free.
  assert.equal(
    (await resolveNodeModel({ model: "openai/gpt-4o", agent: agentOn({ externalModel: "x/y" }) }, deps)).modelId,
    "openai/gpt-4o",
  );
  assert.equal((await resolveNodeModel({ agent: agentOn({ externalModel: "x/y" }) }, deps)).modelId, "x/y");
  assert.equal((await resolveNodeModel({ agent: agentOn({ model: "a/b" }) }, deps)).modelId, "a/b");
  assert.equal((await resolveNodeModel({ agent: agentOn({}) }, deps)).modelId, "free/groq/llama-3.3-70b");

  const hosted = await resolveNodeModel({ agent: agentOn({ externalModel: "wheelsai/llama-3.1-8b" }) }, deps);
  assert.equal(hosted.model.baseUrl, "https://node.example/v1");
  assert.deepEqual(asked, [{ orgId: "org-1", modelId: "wheelsai/llama-3.1-8b" }], "scoped to the agent's organization");

  await assert.rejects(
    resolveNodeModel(
      { agent: agentOn({ externalModel: "wheelsai/llama-3.1-8b" }) },
      { ...deps, resolveHostedModel: async () => ({ ok: false as const, message: "no running deployment of it" }) },
    ),
    /no running deployment of it/,
  );
  await assert.rejects(
    resolveNodeModel({ agent: agentOn({}) }, { ...deps, availableFreeModelIds: () => [] }),
    /no model available/,
  );
});
