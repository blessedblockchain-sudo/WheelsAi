import assert from "node:assert/strict";
import test from "node:test";

import type { StepRecord } from "../services/runOrchestrationExecution.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Binding tests for the engine's production deps: what each step type is
// wired to, and what a step row stores.

async function build(over: Record<string, unknown> = {}) {
  setupEnv();
  const mod = await import("../services/buildOrchestrationExecutorDeps.js");
  const writes: Array<{ model: string; args: any }> = [];
  const chats: Array<{ agentId: string; prompt: string; mode?: string; signal?: AbortSignal }> = [];
  const deps = mod.buildOrchestrationExecutorDeps("exec-1", {
    prisma: {
      orchestrationStepResult: {
        create: async (args) => {
          writes.push({ model: "stepResult", args });
        },
      },
      orchestrationExecution: {
        updateMany: async (args) => {
          writes.push({ model: "execution", args });
        },
      },
    },
    executor: {
      loadAgent: async (agentId, orgId) =>
        orgId === "org-1"
          ? { id: agentId, orgId, name: "A", systemPrompt: null, tools: [], modelConfig: {}, env: {} }
          : null,
      runAgentChat: async ({ agent, prompt, mode, signal }) => {
        chats.push({ agentId: agent.id, prompt, mode, signal });
        return { content: "agent answer" };
      },
    },
    ...over,
  });
  return { deps, writes, chats, mod };
}

function record(over: Partial<StepRecord> = {}): StepRecord {
  return {
    stepId: "step-1",
    stepName: "a",
    stepType: "agent",
    agentId: "agent-1",
    resourceId: null,
    status: "success",
    iteration: null,
    input: { prompt: "hi" },
    output: "hello",
    truncated: false,
    error: null,
    startedAt: new Date(1),
    completedAt: new Date(2),
    durationMs: 1,
    attempt: 1,
    ...over,
  };
}

test("an agent step runs through the shared executor in job mode with the run's signal", async () => {
  const { deps, chats } = await build();
  const controller = new AbortController();
  const result = await deps.invokeAgent({
    agentId: "agent-1",
    orgId: "org-1",
    prompt: "hi",
    signal: controller.signal,
  });
  assert.equal(result.content, "agent answer");
  assert.deepEqual(chats, [{ agentId: "agent-1", prompt: "hi", mode: "job", signal: controller.signal }]);
});

test("an agent outside the organization is not found and is never invoked", async () => {
  const { deps, chats } = await build();
  await assert.rejects(
    deps.invokeAgent({ agentId: "agent-1", orgId: "org-2", prompt: "hi" }),
    /agent agent-1 not found in this organization/,
  );
  assert.equal(chats.length, 0);
});

test("a model step goes to the deployment chat service, in the run's organization, with its signal", async () => {
  const calls: unknown[] = [];
  const controller = new AbortController();
  const { deps, mod } = await build({
    chatWithDeployment: async (request: unknown) => {
      calls.push(request);
      return {
        content: "from the deployment",
        usage: { inputTokens: 3, outputTokens: 5 },
        finishReason: "stop",
        billing: { mode: "credits", chargedCents: 2 },
        requestId: "req-1",
      };
    },
  });
  // Nothing to warn about in a plan preview any more.
  assert.deepEqual(mod.modelStepCapability(), { available: true });

  const result = await deps.invokeModel!({
    deploymentId: "dep-1",
    modelId: "llama-3.1-8b",
    orgId: "org-1",
    prompt: "hi",
    signal: controller.signal,
  });
  assert.deepEqual(result, { content: "from the deployment", usage: { inputTokens: 3, outputTokens: 5 } });
  assert.deepEqual(calls, [
    {
      orgId: "org-1",
      deploymentId: "dep-1",
      modelId: "llama-3.1-8b",
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    },
  ]);
});

test("a model step the service refuses fails with the service's reason; unreported usage is not invented", async () => {
  const refused = await build({
    chatWithDeployment: async () => {
      throw new Error("model deployment dep-1 does not exist in this organization or is not running");
    },
  });
  await assert.rejects(
    refused.deps.invokeModel!({ deploymentId: "dep-1", modelId: null, orgId: "org-2", prompt: "hi" }),
    /does not exist in this organization or is not running/,
  );

  const silent = await build({
    chatWithDeployment: async () => ({
      content: "ok",
      usage: null,
      finishReason: "stop",
      billing: { mode: "gpu_included", chargedCents: 0 },
      requestId: "req-2",
    }),
  });
  assert.deepEqual(
    await silent.deps.invokeModel!({ deploymentId: "dep-1", modelId: null, orgId: "org-1", prompt: "hi" }),
    { content: "ok" },
  );
});

test("the default model invoker is the billed deployment chat, not a bare node call", async () => {
  setupEnv();
  const { readFileSync } = await import("node:fs");
  const read = (file: string) => readFileSync(new URL(`../services/${file}`, import.meta.url), "utf8");
  const wiring = read("buildOrchestrationExecutorDeps.ts");
  assert.match(wiring, /overrides\.chatWithDeployment \?\? defaultChatWithDeployment/);
  assert.doesNotMatch(wiring, /model steps cannot run|fetch\(/);
  const bound = read("buildDeploymentChatDeps.ts");
  assert.match(bound, /where: \{ id: deploymentId, orgId, status: "running" \}/);
  assert.match(bound, /gpuBillingBlock: \(deployment, orgId\) => gpuBillingBlock\(deployment, orgId\)/);
  assert.match(bound, /holdInferenceCredits\(tx as unknown as InferenceHoldPrisma, args\)/);
  assert.match(bound, /callNode: proxyToNode/);
  assert.match(bound, /redirect: "manual"/);
  // The /v1 route calls the node and counts usage through the same two functions.
  const route = readFileSync(new URL("../routes/inference.ts", import.meta.url), "utf8");
  assert.match(route, /import \{ proxyToNode, recordDeploymentUsage as recordUsage \} from "\.\.\/services\/buildDeploymentChatDeps\.js"/);
});

test("an injected model invoker is used as is", async () => {
  const { deps } = await build({
    invokeModel: async ({ deploymentId }: { deploymentId: string }) => ({
      content: `from ${deploymentId}`,
    }),
  });
  const result = await deps.invokeModel!({
    deploymentId: "dep-1",
    modelId: null,
    orgId: "org-1",
    prompt: "hi",
  });
  assert.equal(result.content, "from dep-1");
});

test("a text step row stores {content}; a structured one keeps its value too", async () => {
  const { deps, writes } = await build();
  await deps.recordStepResult(record());
  await deps.recordStepResult(
    record({
      stepType: "retrieval",
      agentId: null,
      resourceId: "kb-1",
      iteration: 2,
      output: { mode: "keyword", passages: [] },
    }),
  );
  await deps.recordStepResult(record({ output: "cut", truncated: true }));
  await deps.recordStepResult(record({ status: "skipped", input: null, output: null, error: "branch not taken" }));

  const [text, structured, truncated, skipped] = writes.map((w) => w.args.data);
  assert.equal(text.executionId, "exec-1");
  assert.deepEqual(text.output, { content: "hello" });
  assert.equal(text.stepType, "agent");

  assert.deepEqual(structured.output, {
    content: '{"mode":"keyword","passages":[]}',
    value: { mode: "keyword", passages: [] },
  });
  assert.equal(structured.agentId, null);
  assert.equal(structured.resourceId, "kb-1");
  assert.equal(structured.iteration, 2);

  assert.deepEqual(truncated.output, { content: "cut", truncated: true });
  assert.equal(skipped.output, undefined);
  assert.equal(skipped.input, undefined);
  assert.equal(skipped.error, "branch not taken");
});

test("progress is only written while the run is still running", async () => {
  const { deps, writes } = await build();
  await deps.reportProgress!(40);
  assert.deepEqual(writes[0]!.args, {
    where: { id: "exec-1", status: "running" },
    data: { progress: 40 },
  });
});
