import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";

import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance } from "fastify";

import type { AgentChatAgent, AgentChatDeps } from "../services/agentChat.js";
import type { ChatResult } from "../services/mastra-runtime.js";

// The unified OpenAI base URL: one `<api>/v1`, with `model` picking what
// answers. An OpenAI client configured once must reach an agent and a model
// deployment, and list both.

const ORG = "11111111-1111-4111-8111-111111111111";

const AGENT: AgentChatAgent = {
  id: "22222222-2222-4222-8222-222222222222",
  orgId: ORG,
  slug: "support-bot",
  name: "Support Bot",
  version: "1.0.0",
  systemPrompt: null,
  tools: [],
  modelConfig: { externalModel: "openai/gpt-4o-mini" },
  env: null,
  knowledgeBaseId: null,
};

const RESULT: ChatResult = {
  content: "hello from the agent",
  usage: { inputTokens: 3, outputTokens: 4 },
  reportedUsage: { inputTokens: 3, outputTokens: 4 },
  finishReason: "stop",
  toolCalls: [],
  clientToolCalls: [],
  transcript: [],
};

function agentChatDeps(calls: string[]): AgentChatDeps {
  return {
    loadAgent: async (where) =>
      where.orgId === ORG && "slug" in where && where.slug === AGENT.slug ? AGENT : null,
    openAgentEnv: () => ({ OPENAI_API_KEY: "sk-agent" }),
    availableFreeModelIds: () => [],
    isFreeModel: () => false,
    resolveModel: (modelId) => ({ apiKey: "k", baseUrl: "https://provider.example/v1", modelName: modelId }),
    checkFreeTierLimit: async () => {
      throw new Error("a BYOK model is not rate limited");
    },
    retrieveContext: async () => null,
    beginMetering: async () => null,
    resolveToolMode: async ({ base }) => base,
    skillKeys: () => [],
    runChat: async () => {
      calls.push("agent");
      return RESULT;
    },
    runChatStream: async () => {
      throw new Error("not used");
    },
    recordUsage: async () => {},
    deadlineMs: 1_000,
  };
}

interface Built {
  app: FastifyInstance;
  calls: string[];
  deploymentTargets: unknown[];
  metered: string[];
}

async function buildApp(opts: { realDeploymentHandler?: boolean } = {}): Promise<Built> {
  const { createOpenAiV1Routes } = await import("../routes/openaiV1.js");
  const { createOpenAiAuth, AGENTS_INVOKE_SCOPE } = await import("../middleware/openaiAuth.js");
  const built: Built = { app: Fastify(), calls: [], deploymentTargets: [], metered: [] };
  const meter = async (orgId: string) => void built.metered.push(orgId);
  const { app } = built;
  await app.register(sensible);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as { auth: unknown }).auth = { userId: null, orgId: ORG, type: "api_key", scopes: [] };
  });
  // The per-deployment route as index.ts mounts it: at the root, full path.
  app.post("/v1/:deploymentSlug/chat/completions", async (request) => {
    built.calls.push(`deployment-route:${(request.params as { deploymentSlug: string }).deploymentSlug}`);
    return { via: "deployment-route" };
  });
  await app.register(
    createOpenAiV1Routes({
      chatDeps: () => agentChatDeps(built.calls),
      auth: createOpenAiAuth({ scope: AGENTS_INVOKE_SCOPE, meter }),
      unifiedAuth: createOpenAiAuth({ meter }),
      ...(opts.realDeploymentHandler
        ? {}
        : {
            deploymentCompletion: async (_request, _reply, target) => {
              built.deploymentTargets.push(target);
              built.calls.push("deployment");
              return { id: "chatcmpl-node", object: "chat.completion", model: "x/y" };
            },
          }),
      findAgent: async () => null,
      listModels: async (orgId) => {
        assert.equal(orgId, ORG, "listing is scoped to the caller's organization");
        return {
          deployments: [{ slug: "llama-prod", createdAt: new Date("2026-09-01T00:00:00Z"), hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct" }],
          agents: [
            { slug: "support-bot", createdAt: new Date("2026-10-01T00:00:00Z") },
            { slug: "sales-bot", createdAt: new Date("2026-10-02T00:00:00Z") },
          ],
        };
      },
    }),
    { prefix: "/v1" },
  );
  await app.ready();
  return built;
}

const MESSAGES = [{ role: "user", content: "hi" }];
const complete = (app: FastifyInstance, model: unknown) =>
  app.inject({ method: "POST", url: "/v1/chat/completions", payload: { model, messages: MESSAGES } });

test("model agent/<slug> goes to the agent; a bare slug goes to the deployment, in OpenAI error mode", async () => {
  const { app, calls, deploymentTargets, metered } = await buildApp();
  try {
    const agent = await complete(app, "agent/support-bot");
    assert.equal(agent.statusCode, 200);
    assert.equal(agent.json().model, "agent/support-bot");
    assert.equal(agent.json().choices[0].message.content, "hello from the agent");

    const deployment = await complete(app, "llama-prod");
    assert.equal(deployment.statusCode, 200);
    assert.equal(deployment.json().id, "chatcmpl-node");
    assert.deepEqual(deploymentTargets, [{ deploymentSlug: "llama-prod" }]);

    assert.deepEqual(calls, ["agent", "deployment"]);
    assert.deepEqual(metered, [ORG, ORG], "one plan API call each, however the model was named");
  } finally {
    await app.close();
  }
});

test("an agent that does not exist, a missing model and a workflow each get their own OpenAI-shaped answer", async () => {
  const { app, calls } = await buildApp();
  try {
    const noAgent = await complete(app, "agent/nope");
    assert.equal(noAgent.statusCode, 404);
    assert.equal(noAgent.json().error.code, "agent_not_found");

    for (const model of [undefined, "", "   ", 7]) {
      const res = await complete(app, model);
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, "validation_failed");
      assert.equal(res.json().error.param, "model");
    }

    // Not built yet, and said so - never looked up as a deployment slug.
    const workflow = await complete(app, "workflow/nightly-report");
    assert.equal(workflow.statusCode, 501);
    assert.equal(workflow.json().error.code, "workflow_api_not_available");
    assert.equal(workflow.json().error.type, "server_error");
    assert.equal(workflow.headers["x-should-retry"], "false");

    assert.deepEqual(calls, []);
  } finally {
    await app.close();
  }
});

test("an unknown deployment slug is 404 model_not_found from the real deployment handler", async () => {
  const { prisma } = await import("@wheelsai/db");
  const p = prisma as any;
  const saved = p.deployment;
  const lookups: any[] = [];
  p.deployment = {
    findFirst: async (args: any) => {
      lookups.push(args.where);
      return null;
    },
  };
  const { app } = await buildApp({ realDeploymentHandler: true });
  try {
    const res = await complete(app, "gpt-4o");
    assert.equal(res.statusCode, 404);
    const { error } = res.json();
    assert.equal(error.type, "invalid_request_error");
    assert.equal(error.code, "model_not_found");
    assert.match(error.message, /gpt-4o/);
    assert.match(error.message, /agent\/<slug>/);
    assert.equal(res.headers["x-should-retry"], "false");
    assert.deepEqual(lookups, [{ slug: "gpt-4o", orgId: ORG, status: "running" }], "org-scoped, running only");

    // A body the deployment route cannot take is a 400, not a 500.
    const bad = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "llama-prod", messages: "hi" },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, "validation_failed");
    assert.equal(bad.json().error.param, "messages");
  } finally {
    p.deployment = saved;
    await app.close();
  }
});

test("GET /v1/models lists running deployments and agents with wheelsai.kind", async () => {
  const { app, metered } = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.object, "list");
    assert.deepEqual(
      body.data.map((m: any) => [m.id, m.object, m.owned_by, m.wheelsai.kind]),
      [
        ["llama-prod", "model", "wheelsai", "deployment"],
        ["agent/support-bot", "model", "wheelsai", "agent"],
        ["agent/sales-bot", "model", "wheelsai", "agent"],
      ],
    );
    assert.equal(body.data[0].root, "meta-llama/Meta-Llama-3.1-8B-Instruct");
    assert.equal(body.data[0].created, Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000));
    assert.deepEqual(metered, [], "listing models is a read: free");
  } finally {
    await app.close();
  }
});

test("deployments named 'agents', 'chat' or 'models' still resolve at /v1/<slug>/chat/completions", async () => {
  const { app, calls } = await buildApp();
  try {
    for (const slug of ["agents", "workflows", "chat", "models", "llama-prod"]) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/${slug}/chat/completions`,
        payload: { messages: MESSAGES },
      });
      assert.equal(res.statusCode, 200, slug);
      assert.equal(res.json().via, "deployment-route", slug);
    }
    assert.deepEqual(calls, [
      "deployment-route:agents",
      "deployment-route:workflows",
      "deployment-route:chat",
      "deployment-route:models",
      "deployment-route:llama-prod",
    ]);
  } finally {
    await app.close();
  }
});

test("routeModel: the prefix decides, and everything else is a deployment slug", async () => {
  const { routeModel } = await import("../routes/openaiV1.js");
  assert.deepEqual(routeModel("agent/support-bot"), { kind: "agent", slug: "support-bot" });
  assert.deepEqual(routeModel("workflow/nightly"), { kind: "workflow", slug: "nightly" });
  assert.deepEqual(routeModel("llama-prod"), { kind: "deployment", slug: "llama-prod" });
  // A deployment may be called "agent"; only the slash makes it an agent id.
  assert.deepEqual(routeModel("agent"), { kind: "deployment", slug: "agent" });
  assert.deepEqual(routeModel("agent/"), { kind: "agent", slug: "" });
});

test("a deployment refusal on the unified base is OpenAI-shaped and keeps its machine-readable reason", async () => {
  const { prisma } = await import("@wheelsai/db");
  const { getNosanaDeployConfig } = await import("../config/nosanaDeploy.js");
  const p = prisma as any;
  const saved = p.deployment;
  // A real (GPU-billed) deployment with no healthy node.
  p.deployment = {
    findFirst: async () => ({
      id: "dep-1",
      name: "llama-prod",
      slug: "llama-prod",
      gpuTier: "4090",
      replicas: 1,
      status: "running",
      engine: "vllm",
      nosanaJobIds: ["DeploymentManagerId1"],
      billedThroughAt: new Date(),
      model: { pricingTier: "small", hfId: "x/y" },
      nodes: [],
    }),
  };
  const { app } = await buildApp({ realDeploymentHandler: true });
  try {
    const res = await complete(app, "llama-prod");
    const billingOn = getNosanaDeployConfig().gpuBillingIntervalMs > 0;
    assert.equal(res.statusCode, 503);
    const { error } = res.json();
    assert.equal(error.type, "server_error");
    assert.equal(error.code, "service_unavailable");
    assert.equal(error.param, null);
    if (billingOn) {
      assert.equal(error.message, "No healthy nodes available for this deployment");
      assert.ok(!("reason" in error), "a status title is not repeated as a reason");
    } else {
      assert.equal(error.reason, "gpu_billing_disabled");
    }
  } finally {
    p.deployment = saved;
    await app.close();
  }
});
