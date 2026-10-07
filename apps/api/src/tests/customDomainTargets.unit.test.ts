import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import sensible from "@fastify/sensible";
import Fastify from "fastify";

import { AGENTS_INVOKE_SCOPE, createOpenAiAuth } from "../middleware/openaiAuth.js";
import { installCustomDomainEdgeHooks } from "../routes/customDomainEdge.js";
import { createDeploymentRoutes, customDomainEndpoint } from "../routes/deployments.js";
import { createOpenAiV1Routes } from "../routes/openaiV1.js";
import type { AgentChatAgent, AgentChatDeps } from "../services/agentChat.js";
import type { EdgeRoute } from "../services/customDomainRules.js";
import { createCustomDomainRouteTable, createEdgeRewriteUrl } from "../services/customDomainRouteTable.js";
import { createDomainsService, type DomainsDb } from "../services/domains.js";
import { loadCustomDomainConfig } from "../config/customDomains.js";
import type { ChatResult } from "../services/mastra-runtime.js";

// What a custom domain reaches. The edge rewrite is put in front of the REAL
// /v1 route modules (their own guards, their own handlers), so these tests
// answer the question the feature exists for: a request arriving on a
// customer's hostname is served by that organization's agent or deployment,
// through the same route, guard and metering as the canonical URL - and by
// nothing else.

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const SECRET = "edge-secret-0123456789abcdef0123456789abcdef";

const AGENT: AgentChatAgent = {
  id: "33333333-3333-4333-8333-333333333333",
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

function route(over: Partial<EdgeRoute>): EdgeRoute {
  return {
    domainId: "d1",
    orgId: ORG,
    domain: "chat.customer.com",
    targetType: "agent",
    targetSlug: "support-bot",
    serving: true,
    headers: {},
    ...over,
  };
}

async function buildApp() {
  const table = createCustomDomainRouteTable({
    load: async () => [
      route({}),
      route({ domainId: "d2", domain: "llm.customer.com", targetType: "deployment", targetSlug: "llama-prod" }),
    ],
  });
  await table.refresh();

  const calls: string[] = [];
  const metered: string[] = [];
  const meter = async (orgId: string) => void metered.push(orgId);
  // Both organizations own an agent and a deployment with the SAME slugs.
  const chatDeps = (): AgentChatDeps => ({
    loadAgent: async (where) =>
      "slug" in where && where.slug === AGENT.slug ? { ...AGENT, orgId: where.orgId } : null,
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
      calls.push("agent-chat");
      return RESULT;
    },
    runChatStream: async () => {
      throw new Error("not used");
    },
    recordUsage: async () => {},
    deadlineMs: 1_000,
  });

  let installed = false;
  const app = Fastify({
    rewriteUrl: createEdgeRewriteUrl({ table, edgeSecret: SECRET, guardInstalled: () => installed }),
  });
  await app.register(sensible);
  app.decorateRequest("auth", null);
  // Stands in for middleware/auth.ts: "Bearer <orgId>" is that organization's key.
  app.addHook("onRequest", async (request) => {
    const header = request.headers.authorization;
    (request as { auth: unknown }).auth = header?.startsWith("Bearer ")
      ? { userId: null, orgId: header.slice(7), type: "api_key", scopes: [], apiKeyId: "key-1" }
      : null;
  });
  installCustomDomainEdgeHooks(app);
  installed = true;

  // The per-deployment route as index.ts mounts it, behind the real /v1 guard.
  app.post(
    "/v1/:deploymentSlug/chat/completions",
    { preHandler: [createOpenAiAuth({ meter })] },
    async (request) => {
      const { deploymentSlug } = request.params as { deploymentSlug: string };
      calls.push(`deployment:${request.auth!.orgId}:${deploymentSlug}`);
      return { via: "deployment-route", deploymentSlug };
    },
  );
  await app.register(
    createOpenAiV1Routes({
      chatDeps,
      auth: createOpenAiAuth({ scope: AGENTS_INVOKE_SCOPE, meter }),
      unifiedAuth: createOpenAiAuth({ meter }),
      workflowDeps: () => {
        throw new Error("no workflow is reachable in these tests");
      },
      workflowAuth: createOpenAiAuth({ meter }),
      deploymentCompletion: async () => {
        throw new Error("the unified route is not reachable through a custom domain");
      },
      findAgent: async (_orgId, slug) =>
        slug === AGENT.slug ? { slug, createdAt: new Date("2026-10-01T00:00:00Z") } : null,
      listModels: async () => ({
        deployments: [
          { slug: "llama-prod", createdAt: new Date("2026-09-01T00:00:00Z"), hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct" },
          { slug: "qwen-staging", createdAt: new Date("2026-09-02T00:00:00Z"), hfId: "Qwen/Qwen2.5-7B-Instruct" },
        ],
        agents: [{ slug: "support-bot", createdAt: new Date("2026-10-01T00:00:00Z") }],
        workflows: [{ slug: "nightly-report", createdAt: new Date("2026-10-03T00:00:00Z") }],
      }),
    }),
    { prefix: "/v1" },
  );
  await app.ready();

  const viaEdge = (host: string, org: string | null = ORG) => ({
    "x-wheels-edge-token": SECRET,
    "x-wheels-custom-host": host,
    "x-wheels-edge-proto": "https",
    ...(org ? { authorization: `Bearer ${org}` } : {}),
  });
  const chat = (headers: Record<string, string>, url = "/v1/chat/completions") =>
    app.inject({ method: "POST", url, headers, payload: { messages: [{ role: "user", content: "hi" }] } });

  return { app, calls, metered, viaEdge, chat };
}

// ============================================
// Through the real /v1 routes
// ============================================

test("an agent's domain is an OpenAI endpoint for that agent: same handler, one metered call", async () => {
  const { app, calls, metered, viaEdge, chat } = await buildApp();
  const res = await chat(viaEdge("chat.customer.com"));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().object, "chat.completion");
  assert.equal(res.json().model, "agent/support-bot");
  assert.equal(res.json().choices[0].message.content, "hello from the agent");
  assert.deepEqual(calls, ["agent-chat"]);
  assert.deepEqual(metered, [ORG]);

  const models = await app.inject({ method: "GET", url: "/v1/models", headers: viaEdge("chat.customer.com") });
  assert.deepEqual(
    models.json().data.map((m: { id: string }) => m.id),
    ["agent/support-bot"],
  );
  assert.deepEqual(metered, [ORG], "listing models is free, as on the canonical URL");
  await app.close();
});

test("a deployment's domain reaches that deployment and lists only its model", async () => {
  const { app, calls, metered, viaEdge, chat } = await buildApp();
  const res = await chat(viaEdge("llm.customer.com"));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { via: "deployment-route", deploymentSlug: "llama-prod" });
  assert.deepEqual(calls, [`deployment:${ORG}:llama-prod`]);
  assert.deepEqual(metered, [ORG]);

  for (const url of ["/v1/models", "/v1/models?deployment=qwen-staging"]) {
    const models = await app.inject({ method: "GET", url, headers: viaEdge("llm.customer.com") });
    assert.equal(models.statusCode, 200);
    assert.deepEqual(models.json().data, [
      {
        id: "llama-prod",
        object: "model",
        created: Math.floor(new Date("2026-09-01T00:00:00Z").getTime() / 1000),
        owned_by: "wheelsai",
        permission: [],
        root: "meta-llama/Meta-Llama-3.1-8B-Instruct",
        parent: null,
        wheelsai: { kind: "deployment" },
      },
    ]);
  }
  await app.close();
});

test("the `model` in the body cannot aim a domain at something else", async () => {
  const { app, calls, viaEdge } = await buildApp();
  for (const model of ["workflow/nightly-report", "qwen-staging", "agent/other-bot"]) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: viaEdge("llm.customer.com"),
      payload: { model, messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(res.statusCode, 200, model);
    assert.equal(res.json().deploymentSlug, "llama-prod", model);
  }
  assert.deepEqual(calls, Array(3).fill(`deployment:${ORG}:llama-prod`));
  await app.close();
});

test("another organization's key is refused on the hostname, unmetered, though it owns the same slugs", async () => {
  const { app, calls, metered, viaEdge, chat } = await buildApp();
  for (const host of ["chat.customer.com", "llm.customer.com"]) {
    const res = await chat(viaEdge(host, OTHER_ORG));
    assert.equal(res.statusCode, 403, host);
    assert.equal(res.json().error.code, "wrong_organization");
    const models = await app.inject({ method: "GET", url: "/v1/models", headers: viaEdge(host, OTHER_ORG) });
    assert.equal(models.statusCode, 403, host);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(metered, [], "a refused request does not spend the other organization's plan");

  // The same key on the API's own host is that organization's business.
  const own = await chat({ authorization: `Bearer ${OTHER_ORG}` }, "/v1/llama-prod/chat/completions");
  assert.equal(own.statusCode, 200);
  assert.deepEqual(calls, [`deployment:${OTHER_ORG}:llama-prod`]);
  await app.close();
});

test("no key on a custom domain is the /v1 API's own OpenAI-shaped 401", async () => {
  const { app, viaEdge, chat, calls } = await buildApp();
  for (const host of ["chat.customer.com", "llm.customer.com"]) {
    const res = await chat(viaEdge(host, null));
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "invalid_api_key");
  }
  assert.deepEqual(calls, []);
  await app.close();
});

test("the rest of /v1 is not reachable through a custom domain", async () => {
  const { app, viaEdge, chat, calls } = await buildApp();
  for (const url of [
    "/v1/qwen-staging/chat/completions",
    "/v1/agents/support-bot/chat/completions",
    "/v1/workflows/nightly-report/chat/completions",
    "/v1/agents/support-bot/models",
  ]) {
    const res = await chat(viaEdge("llm.customer.com"), url);
    assert.equal(res.statusCode, 404, url);
  }
  assert.deepEqual(calls, []);
  await app.close();
});

test("on the API's own host GET /v1/models is unchanged, and ?deployment narrows it", async () => {
  const { app } = await buildApp();
  const headers = { authorization: `Bearer ${ORG}` };
  const all = await app.inject({ method: "GET", url: "/v1/models", headers });
  assert.deepEqual(
    all.json().data.map((m: { id: string }) => m.id),
    ["llama-prod", "qwen-staging", "agent/support-bot", "workflow/nightly-report"],
  );
  const one = await app.inject({ method: "GET", url: "/v1/models?deployment=qwen-staging", headers });
  assert.deepEqual(one.json().data.map((m: { id: string }) => m.id), ["qwen-staging"]);
  const none = await app.inject({ method: "GET", url: "/v1/models?deployment=nope", headers });
  assert.deepEqual(none.json(), { object: "list", data: [] });
  const empty = await app.inject({ method: "GET", url: "/v1/models?deployment=", headers });
  assert.equal(empty.json().data.length, 4);
  await app.close();
});

// ============================================
// The custom endpoint a deployment reports
// ============================================

function deploymentRow(over: Record<string, unknown> = {}) {
  return {
    id: "dep_1",
    orgId: "org_1",
    name: "Llama",
    slug: "llama-prod",
    engine: "vllm",
    gpuTier: "rtx-4090",
    replicas: 1,
    status: "running",
    statusReason: null,
    config: {},
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    model: { displayName: "Llama 3.1 8B", pricingTier: "standard" },
    nodes: [],
    ...over,
  };
}

async function deploymentsApp(
  rows: Array<Record<string, unknown>>,
  customDomains: (orgId: string, ids: string[]) => Promise<Map<string, string>>,
) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as { auth: unknown }).auth = { userId: "user_1", orgId: "org_1", type: "jwt" };
  });
  await app.register(
    createDeploymentRoutes({
      prisma: {
        deployment: {
          findMany: async () => rows,
          findFirst: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
        },
      } as never,
      customDomains,
    }),
  );
  return app;
}

test("a deployment reports its custom endpoint only when a domain is observed serving it", async () => {
  const asked: Array<[string, string[]]> = [];
  const app = await deploymentsApp(
    [deploymentRow(), deploymentRow({ id: "dep_2", slug: "qwen" }), deploymentRow({ id: "dep_3", slug: "stopped", status: "stopped" })],
    async (orgId, ids) => {
      asked.push([orgId, ids]);
      return new Map([["dep_1", "llm.customer.com"]]);
    },
  );
  const list = (await app.inject({ method: "GET", url: "/" })).json().deployments;
  assert.deepEqual(
    list.map((d: { slug: string; customEndpoint: string | null }) => [d.slug, d.customEndpoint]),
    [
      ["llama-prod", "https://llm.customer.com/v1/chat/completions"],
      ["qwen", null],
      ["stopped", null],
    ],
  );
  // Scoped to the caller's organization, and only running deployments are asked about.
  assert.deepEqual(asked, [["org_1", ["dep_1", "dep_2"]]]);

  const one = (await app.inject({ method: "GET", url: "/dep_1" })).json().deployment;
  assert.equal(one.customEndpoint, customDomainEndpoint("llm.customer.com"));
  const none = (await app.inject({ method: "GET", url: "/dep_2" })).json().deployment;
  assert.equal(none.customEndpoint, null);
  await app.close();
});

test("a failed custom-domain lookup never fails a deployment read, and never invents an endpoint", async () => {
  const app = await deploymentsApp([deploymentRow()], async () => {
    throw new Error("database down");
  });
  const list = await app.inject({ method: "GET", url: "/" });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().deployments[0].customEndpoint, null);
  assert.equal(list.json().deployments[0].endpoint.endsWith("/v1/llama-prod/chat/completions"), true);
  const one = await app.inject({ method: "GET", url: "/dep_1" });
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().deployment.customEndpoint, null);
  await app.close();
});

test("servingDomainsFor: the primary serving domain, else the oldest serving one, of this organization", async () => {
  const at = (day: number) => new Date(`2026-09-${String(day).padStart(2, "0")}T00:00:00Z`);
  const rows = [
    { orgId: ORG, targetType: "deployment", targetId: "dep_1", domain: "old.customer.com", isActive: true, isPrimary: false, createdAt: at(1) },
    { orgId: ORG, targetType: "deployment", targetId: "dep_1", domain: "new.customer.com", isActive: true, isPrimary: false, createdAt: at(9) },
    { orgId: ORG, targetType: "deployment", targetId: "dep_2", domain: "a.customer.com", isActive: true, isPrimary: false, createdAt: at(1) },
    { orgId: ORG, targetType: "deployment", targetId: "dep_2", domain: "primary.customer.com", isActive: true, isPrimary: true, createdAt: at(5) },
    { orgId: ORG, targetType: "deployment", targetId: "dep_2", domain: "z.customer.com", isActive: true, isPrimary: false, createdAt: at(9) },
    // Not serving: a primary flag alone shows nothing.
    { orgId: ORG, targetType: "deployment", targetId: "dep_3", domain: "paused.customer.com", isActive: false, isPrimary: true, createdAt: at(1) },
    // An agent with the same id, and another organization's domain.
    { orgId: ORG, targetType: "agent", targetId: "dep_1", domain: "agent.customer.com", isActive: true, isPrimary: true, createdAt: at(1) },
    { orgId: OTHER_ORG, targetType: "deployment", targetId: "dep_1", domain: "theirs.example.org", isActive: true, isPrimary: true, createdAt: at(1) },
  ];
  const wheres: Array<Record<string, unknown>> = [];
  const service = createDomainsService({
    withOrgLock: () => {
      throw new Error("not used");
    },
    db: {
      customDomain: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          wheres.push(where);
          const ids = (where.targetId as { in: string[] }).in;
          return rows
            .filter((r) => r.orgId === where.orgId && r.targetType === where.targetType && ids.includes(r.targetId) && r.isActive === where.isActive)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        },
      },
    } as unknown as DomainsDb,
    getConfig: () => loadCustomDomainConfig({}),
    reservedHosts: () => [],
    buildCheckDeps: () => {
      throw new Error("not used");
    },
  });

  const found = await service.servingDomainsFor(ORG, "deployment", ["dep_1", "dep_2", "dep_3", "dep_4"]);
  assert.deepEqual([...found].sort(), [
    ["dep_1", "old.customer.com"],
    ["dep_2", "primary.customer.com"],
  ]);
  assert.equal(wheres[0]!.orgId, ORG);
  assert.equal(wheres[0]!.isActive, true);

  assert.equal((await service.servingDomainsFor(ORG, "deployment", [])).size, 0);
  assert.equal(wheres.length, 1, "nothing is queried for no ids");
});
