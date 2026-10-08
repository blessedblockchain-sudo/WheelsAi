/**
 * services/createAgent.ts with services/buildCreateAgentDeps.ts, and the
 * route that uses them (POST /api/agents): one create path that needs only a
 * name, keeps the plan's agent limit, drops a free model the platform cannot
 * serve, and stores an old-style request exactly as the route did before.
 *
 * Hermetic: Prisma is an in-memory stand-in handed to buildCreateAgentDeps.
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { Prisma } from "@wheelsai/db";

import { globalErrorHandler } from "../lib/errorHandler.js";
import { createAgentRoutes } from "../routes/agents.js";
import { isSealedAgentEnv, openAgentEnv } from "../services/agentSecrets.js";
import { buildCreateAgentDeps, isAgentSlugConflict } from "../services/buildCreateAgentDeps.js";
import {
  createAgent,
  createAgentAnswer,
  createdAgentAnswer,
  type CreateAgentArgs,
  type CreateAgentDeps,
} from "../services/createAgent.js";
import { PlanLimitError } from "../services/plans.js";

const ORG = "0f1e2d3c-4b5a-4968-8776-655443322110";
const TEMPLATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GROQ = "free/groq/llama-3.3-70b";
const GEMINI = "free/gemini/gemini-2.5-flash";

interface World {
  agents: Array<Record<string, any>>;
  graphs: Array<Record<string, any>>;
  templates: Array<Record<string, any>>;
  knowledgeBases: Array<{ id: string; orgId: string }>;
  announced: Array<{ orgId: string; agent: Record<string, any> }>;
  transactions: number;
  /** The plan's agent limit; null is unlimited. */
  maxAgents: number | null;
  availableFreeModelIds: string[];
  /** Fail this many inserts as a lost race for the slug. */
  slugRaces: number;
}

function newWorld(over: Partial<World> = {}): World {
  return {
    agents: [],
    graphs: [],
    templates: [],
    knowledgeBases: [],
    announced: [],
    transactions: 0,
    maxAgents: null,
    availableFreeModelIds: [GROQ],
    slugRaces: 0,
    ...over,
  };
}

/** The Prisma calls the create path makes, over the world. A throw inside a transaction undoes its writes. */
function fakePrisma(world: World) {
  let ids = 0;
  const client = {
    agent: {
      findUnique: async ({ where }: any) =>
        world.agents.find((a) => a.orgId === where.orgId_slug.orgId && a.slug === where.orgId_slug.slug) ?? null,
      create: async ({ data }: any) => {
        if (world.slugRaces > 0) {
          world.slugRaces -= 1;
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target: ["org_id", "slug"] } });
        }
        const row = { id: `agent-${(ids += 1)}`, ...data };
        world.agents.push(row);
        return row;
      },
    },
    agentGraph: {
      create: async ({ data }: any) => (world.graphs.push(data), data),
    },
    agentTemplate: {
      findFirst: async ({ where }: any) =>
        world.templates.find((t) => t.id === where.id && t.isPublished === where.isPublished) ?? null,
      update: async ({ where, data }: any) => {
        const template = world.templates.find((t) => t.id === where.id)!;
        template.usageCount += data.usageCount.increment;
        return template;
      },
    },
    knowledgeBase: {
      findFirst: async ({ where }: any) =>
        world.knowledgeBases.find((kb) => kb.id === where.id && kb.orgId === where.orgId) ?? null,
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      world.transactions += 1;
      const before = {
        agents: [...world.agents],
        graphs: [...world.graphs],
        uses: world.templates.map((t) => t.usageCount),
      };
      try {
        return await fn(client);
      } catch (err) {
        world.agents = before.agents;
        world.graphs = before.graphs;
        world.templates.forEach((t, i) => (t.usageCount = before.uses[i]));
        throw err;
      }
    },
  };
  return client;
}

function depsFor(world: World): CreateAgentDeps<Prisma.TransactionClient> {
  return {
    ...buildCreateAgentDeps(fakePrisma(world) as never),
    availableFreeModelIds: () => world.availableFreeModelIds,
    // The real rule's shape (services/orgPlan.ts), over the world.
    assertCanCreateAgent: async (orgId) => {
      if (world.maxAgents === null) return;
      if (world.agents.filter((a) => a.orgId === orgId).length >= world.maxAgents) {
        throw new PlanLimitError(
          `The Starter plan includes up to ${world.maxAgents} agents. Upgrade to Pro for unlimited agents.`,
          "starter",
          "maxAgents",
        );
      }
    },
    announce: (orgId, agent) => void world.announced.push({ orgId, agent }),
    now: () => new Date("2026-10-08T12:00:00Z"),
  };
}

const create = (world: World, args: Omit<CreateAgentArgs<Prisma.TransactionClient>, "orgId"> & { orgId?: string }) =>
  createAgent(depsFor(world), { orgId: ORG, ...args });

async function appFor(world: World) {
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(sensible);
  await app.register(
    createAgentRoutes({
      requireAuth: async (request) => {
        (request as { auth?: unknown }).auth = { orgId: ORG, userId: "user-1", type: "jwt", role: "owner" };
      },
      publicApiUrl: () => "https://api.example.test",
      createAgent: (args) => createAgent(depsFor(world), args),
    }),
    { prefix: "/api/agents" },
  );
  await app.ready();
  return app;
}

const template = (over: Record<string, unknown> = {}) => ({
  id: TEMPLATE_ID,
  isPublished: true,
  usageCount: 0,
  description: "Reviews code",
  framework: "mastra",
  systemPrompt: "You review code.",
  tools: [],
  modelConfig: { externalModel: GROQ, temperature: 0.3, maxTokens: 4096 },
  sourceType: "inline",
  sourceCode: "export const agent = {}",
  sourceUrl: null,
  env: { REVIEW_DEPTH: "full" },
  tags: ["code"],
  graphNodes: null,
  graphEdges: null,
  agentKind: "task",
  kindConfig: { task: { fields: [{ key: "code", label: "Code to review", type: "long_text", required: true }] } },
  ...over,
});

// ============================================
// The service
// ============================================

test("a name is all it takes: the agent is stored with every default", async () => {
  const world = newWorld();
  const result = await create(world, { body: { name: "Support Bot" } });

  assert.ok(result.ok);
  assert.deepEqual(result.agent, {
    id: "agent-1",
    name: "Support Bot",
    slug: "support-bot",
    framework: "custom",
    agentKind: "conversation",
    kindConfig: null,
  });
  assert.equal(world.agents.length, 1);
  const { env, ...row } = world.agents[0]!;
  assert.deepEqual(row, {
    id: "agent-1",
    orgId: ORG,
    name: "Support Bot",
    slug: "support-bot",
    description: undefined,
    framework: "custom",
    systemPrompt: undefined,
    tools: [],
    modelConfig: { temperature: 0.7, maxTokens: 4096 },
    sourceType: "inline",
    sourceUrl: undefined,
    sourceCode: undefined,
    tags: [],
    isPublic: false,
    knowledgeBaseId: null,
    agentKind: "conversation",
    kindConfig: Prisma.DbNull,
  });
  assert.ok(isSealedAgentEnv(env), "even an empty set of variables is stored sealed, as before");
  assert.equal(world.transactions, 1);
  assert.deepEqual(world.announced, [{ orgId: ORG, agent: result.agent }]);
});

test("an old-style request with framework, sourceType and sourceCode stores the same agent as before", async () => {
  const world = newWorld();
  const body = {
    name: "Legacy Agent",
    description: "Answers questions",
    framework: "mastra",
    systemPrompt: "Be brief.",
    tools: [{ name: "search", type: "api", description: "Search the web" }],
    modelConfig: { externalModel: "openai/gpt-4", temperature: 0.2 },
    sourceType: "inline",
    sourceCode: "export default {}",
    env: { OPENAI_API_KEY: "sk-test-123" },
    tags: ["support"],
    isPublic: true,
  };
  const result = await create(world, { body });
  assert.ok(result.ok);

  const { id, env, ...row } = world.agents[0]!;
  // What routes/agents.ts wrote before the create path moved (its
  // prisma.agent.create data), plus the two new columns at their defaults.
  assert.deepEqual(row, {
    orgId: ORG,
    name: "Legacy Agent",
    slug: "legacy-agent",
    description: "Answers questions",
    framework: "mastra",
    systemPrompt: "Be brief.",
    tools: body.tools,
    modelConfig: { externalModel: "openai/gpt-4", temperature: 0.2, maxTokens: 4096 },
    sourceType: "inline",
    sourceUrl: undefined,
    sourceCode: "export default {}",
    tags: ["support"],
    isPublic: true,
    knowledgeBaseId: null,
    agentKind: "conversation",
    kindConfig: Prisma.DbNull,
  });
  assert.equal(id, result.agent.id);
  assert.ok(isSealedAgentEnv(env));
  assert.ok(!JSON.stringify(env).includes("sk-test-123"));
  assert.deepEqual(openAgentEnv(env), { OPENAI_API_KEY: "sk-test-123" });
});

test("a free model the platform cannot serve now is dropped, so the first available one answers", async () => {
  const world = newWorld({ availableFreeModelIds: [GROQ] });
  await create(world, { body: { name: "Wants Gemini", modelConfig: { externalModel: GEMINI } } });
  await create(world, { body: { name: "Wants Groq", modelConfig: { externalModel: GROQ } } });
  await create(world, { body: { name: "Own model", modelConfig: { externalModel: "openai/gpt-4" } } });

  assert.deepEqual(world.agents[0]!.modelConfig, { temperature: 0.7, maxTokens: 4096 });
  assert.equal(world.agents[1]!.modelConfig.externalModel, GROQ);
  assert.equal(world.agents[2]!.modelConfig.externalModel, "openai/gpt-4");
});

test("the plan limit holds: one agent too many is refused and nothing is written", async () => {
  const world = newWorld({ maxAgents: 2 });
  assert.ok((await create(world, { body: { name: "First" } })).ok);
  assert.ok((await create(world, { body: { name: "Second" } })).ok);
  const transactions = world.transactions;

  await assert.rejects(create(world, { body: { name: "Third" } }), (err: unknown) => {
    assert.ok(err instanceof PlanLimitError);
    assert.equal(err.code, "plan_limit_reached");
    assert.equal(err.limit, "maxAgents");
    return true;
  });
  assert.equal(world.agents.length, 2);
  assert.equal(world.transactions, transactions, "no transaction was opened");
  assert.equal(world.announced.length, 2);
});

test("a template counts toward the plan like any other create", async () => {
  const world = newWorld({ maxAgents: 1, templates: [template()] });
  assert.ok((await create(world, { body: { name: "First" } })).ok);
  await assert.rejects(create(world, { body: { name: "From template" }, templateId: TEMPLATE_ID }), PlanLimitError);
  assert.equal(world.templates[0]!.usageCount, 0);
});

test("an invalid request is refused before the plan is read or anything is written", async () => {
  const world = newWorld({ maxAgents: 0 });
  const result = await create(world, { body: { name: "ab" } });
  assert.ok(!result.ok);
  assert.equal(result.reason, "validation_failed");
  assert.ok(result.reason === "validation_failed" && result.failure.message === "Give your agent a name of at least 3 characters.");
  assert.equal(world.transactions, 0);
});

test("names that make the same slug get different slugs", async () => {
  const world = newWorld();
  const slugs: string[] = [];
  for (const name of ["Support Bot", "support bot", "Support-Bot!"]) {
    const result = await create(world, { body: { name } });
    assert.ok(result.ok);
    slugs.push(result.agent.slug);
  }
  assert.deepEqual(slugs, ["support-bot", "support-bot-1", "support-bot-2"]);
});

test("the same slug in another organization is free", async () => {
  const world = newWorld();
  await create(world, { body: { name: "Support Bot" } });
  const other = await create(world, { body: { name: "Support Bot" }, orgId: "other-org" });
  assert.ok(other.ok);
  assert.equal(other.agent.slug, "support-bot");
});

test("a create that loses a race for its slug picks again; the error is not shown to the caller", async () => {
  const world = newWorld({ slugRaces: 1 });
  const result = await create(world, { body: { name: "Support Bot" } });
  assert.ok(result.ok);
  assert.equal(world.agents.length, 1);
  assert.equal(world.transactions, 2);
  assert.equal(world.announced.length, 1);

  // It does not try for ever.
  const stuck = newWorld({ slugRaces: 99 });
  await assert.rejects(create(stuck, { body: { name: "Support Bot" } }), /Unique constraint/);
  assert.equal(stuck.transactions, 3);
});

test("isAgentSlugConflict: a unique violation on the slug, and nothing else", () => {
  assert.equal(isAgentSlugConflict({ code: "P2002", meta: { target: ["org_id", "slug"] } }), true);
  assert.equal(isAgentSlugConflict({ code: "P2002", meta: { target: "agents_org_id_slug_key" } }), true);
  assert.equal(isAgentSlugConflict({ code: "P2002" }), true);
  assert.equal(isAgentSlugConflict({ code: "P2002", meta: { target: ["public_handle"] } }), false);
  assert.equal(isAgentSlugConflict({ code: "P2003" }), false);
  assert.equal(isAgentSlugConflict(new Error("boom")), false);
  assert.equal(isAgentSlugConflict(null), false);
});

test("a knowledge base of another organization is refused and nothing is written", async () => {
  const world = newWorld({ knowledgeBases: [{ id: KB_ID, orgId: "someone-else" }] });
  const refused = await create(world, { body: { name: "Grounded", knowledgeBaseId: KB_ID } });
  assert.deepEqual(refused, { ok: false, reason: "knowledge_base_not_found" });
  assert.equal(world.agents.length, 0);

  world.knowledgeBases.push({ id: KB_ID, orgId: ORG });
  const bound = await create(world, { body: { name: "Grounded", knowledgeBaseId: KB_ID } });
  assert.ok(bound.ok);
  assert.equal(world.agents[0]!.knowledgeBaseId, KB_ID);
});

test("templateId in the body starts the agent from the template, with its kind and a copy of its settings", async () => {
  const stored = template({
    graphNodes: [{ id: "n1" }],
    graphEdges: [],
  });
  const world = newWorld({ templates: [stored] });
  const result = await create(world, { body: { name: "My Reviewer", templateId: TEMPLATE_ID } });

  assert.ok(result.ok);
  assert.equal(result.agent.agentKind, "task");
  const row = world.agents[0]!;
  assert.equal(row.framework, "mastra");
  assert.equal(row.systemPrompt, "You review code.");
  assert.equal(row.description, "Reviews code");
  assert.equal(row.agentKind, "task");
  assert.deepEqual(row.kindConfig, stored.kindConfig);
  assert.notEqual(row.kindConfig, stored.kindConfig, "a copy, not the template's own object");
  assert.deepEqual(openAgentEnv(row.env), { REVIEW_DEPTH: "full" });
  assert.deepEqual(world.graphs, [{ agentId: row.id, nodes: [{ id: "n1" }], edges: [], isValid: true }]);
  assert.equal(stored.usageCount, 1);
  assert.equal(world.transactions, 1, "the agent, its graph and the use count are one transaction");
});

test("a template that is gone or unpublished is a named refusal", async () => {
  const world = newWorld({ templates: [template({ isPublished: false })] });
  assert.deepEqual(await create(world, { body: { name: "My Reviewer", templateId: TEMPLATE_ID } }), {
    ok: false,
    reason: "template_not_found",
  });
  assert.deepEqual(await create(world, { body: { name: "My Reviewer" }, templateId: TEMPLATE_ID }), {
    ok: false,
    reason: "template_not_found",
  });
  const bad = await create(world, { body: { name: "My Reviewer", templateId: "not-an-id" } });
  assert.ok(!bad.ok && bad.reason === "validation_failed");
  assert.equal(world.agents.length, 0);
});

test("alsoInTransaction writes beside the agent, and a throw there undoes the agent too", async () => {
  const world = newWorld({ templates: [template()] });
  const seen: unknown[] = [];
  const ok = await create(world, {
    body: { name: "With more" },
    alsoInTransaction: async (tx, agent) => {
      assert.equal(typeof (tx as any).agent.create, "function", "the transaction's own client");
      seen.push(agent);
    },
  });
  assert.ok(ok.ok);
  assert.deepEqual(seen, [ok.agent]);

  await assert.rejects(
    create(world, {
      body: { name: "Half made", templateId: TEMPLATE_ID },
      alsoInTransaction: async () => {
        throw new Error("the schedule could not be saved");
      },
    }),
    /schedule could not be saved/,
  );
  assert.deepEqual(world.agents.map((a) => a.name), ["With more"]);
  assert.equal(world.templates[0]!.usageCount, 0);
  assert.equal(world.announced.length, 1, "nothing is announced for an agent that was not kept");
});

test("the 201 body: id, name, slug, framework, agentKind and the endpoints, and nothing else", () => {
  const answer = createdAgentAnswer(
    { id: "a1", name: "Support Bot", slug: "support-bot", framework: "custom", agentKind: "task", kindConfig: null },
    "https://api.example.test",
  );
  assert.deepEqual(answer, {
    agent: {
      id: "a1",
      name: "Support Bot",
      slug: "support-bot",
      framework: "custom",
      agentKind: "task",
      apiEndpoint: "https://api.example.test/v1/agents/support-bot/chat/completions",
      openaiBaseUrl: "https://api.example.test/v1/agents/support-bot",
      openaiModel: "agent/support-bot",
    },
    message: "Agent created successfully",
  });
  assert.deepEqual(createAgentAnswer({ ok: false, reason: "template_not_found" }, null), {
    status: 404,
    body: { error: "template_not_found", message: "This template is no longer available. Choose another one." },
  });
});

// ============================================
// POST /api/agents
// ============================================

test("POST /api/agents with only a name answers 201 with agentKind", async () => {
  const world = newWorld();
  const app = await appFor(world);
  try {
    const res = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "Support Bot" } });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.json(), {
      agent: {
        id: "agent-1",
        name: "Support Bot",
        slug: "support-bot",
        framework: "custom",
        agentKind: "conversation",
        apiEndpoint: "https://api.example.test/v1/agents/support-bot/chat/completions",
        openaiBaseUrl: "https://api.example.test/v1/agents/support-bot",
        openaiModel: "agent/support-bot",
      },
      message: "Agent created successfully",
    });
  } finally {
    await app.close();
  }
});

test("POST /api/agents accepts agentKind, kindConfig and templateId", async () => {
  const world = newWorld({ templates: [template()] });
  const app = await appFor(world);
  try {
    const task = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: "Summarizer",
        agentKind: "task",
        kindConfig: { task: { fields: [{ label: "Text to summarize", type: "long_text", required: true }] } },
      },
    });
    assert.equal(task.statusCode, 201);
    assert.equal(task.json().agent.agentKind, "task");
    assert.deepEqual(world.agents[0]!.kindConfig, {
      task: { fields: [{ key: "text_to_summarize", label: "Text to summarize", type: "long_text", required: true }] },
    });

    const fromTemplate = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "My Reviewer", templateId: TEMPLATE_ID },
    });
    assert.equal(fromTemplate.statusCode, 201);
    assert.equal(fromTemplate.json().agent.agentKind, "task");
    assert.equal(fromTemplate.json().agent.framework, "mastra");

    const gone = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "My Reviewer", templateId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    });
    assert.equal(gone.statusCode, 404);
    assert.equal(gone.json().error, "template_not_found");
  } finally {
    await app.close();
  }
});

test("POST /api/agents refusals: 400 validation_failed with message and fields; 403 plan_limit_reached", async () => {
  const world = newWorld({ maxAgents: 1 });
  const app = await appFor(world);
  try {
    const short = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "ab" } });
    assert.equal(short.statusCode, 400);
    assert.equal(short.json().error, "validation_failed");
    assert.equal(short.json().message, "Give your agent a name of at least 3 characters.");
    assert.deepEqual(short.json().fields, { name: "Give your agent a name of at least 3 characters." });
    assert.ok(short.json().details.fieldErrors.name, "details is still there for current clients");

    const kind = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "Fine name", agentKind: "chat" } });
    assert.equal(kind.statusCode, 400);
    assert.equal(kind.json().fields.agentKind, "Choose how people use this agent: conversation, task or scheduled.");

    assert.equal((await app.inject({ method: "POST", url: "/api/agents", payload: { name: "First" } })).statusCode, 201);
    const over = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "Second" } });
    assert.equal(over.statusCode, 403);
    assert.equal(over.json().error, "plan_limit_reached");
    assert.equal(over.json().limit, "maxAgents");
    assert.equal(world.agents.length, 1);

    const kb = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Grounded", knowledgeBaseId: KB_ID },
    });
    assert.equal(kb.statusCode, 400);
    assert.deepEqual(kb.json(), { statusCode: 400, error: "Bad Request", message: "Knowledge base not found" });
  } finally {
    await app.close();
  }
});
