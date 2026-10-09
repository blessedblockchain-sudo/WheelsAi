/**
 * routes/templates.ts and services/templates.ts: using a template goes
 * through the one create path. One template used twice gives two agents with
 * different slugs, the agent carries the template's kind and a copy of its
 * settings, and the answer is the one POST /api/agents gives: no
 * instructions, no variables, sealed or not.
 *
 * Hermetic: the global prisma's delegates are replaced with an in-memory
 * stand-in, so the real useTemplate and buildCreateAgentDeps run over it.
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { Prisma, prisma } from "@wheelsai/db";

import { globalErrorHandler } from "../lib/errorHandler.js";
import { createTemplateRoutes, templateRoutes } from "../routes/templates.js";
import { isSealedAgentEnv, openAgentEnv } from "../services/agentSecrets.js";
import { buildCreateAgentDeps } from "../services/buildCreateAgentDeps.js";
import { createAgent } from "../services/createAgent.js";
import { PlanLimitError } from "../services/plans.js";

const ORG = "0f1e2d3c-4b5a-4968-8776-655443322110";
const TASK_TEMPLATE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCHEDULED_TEMPLATE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHAT_TEMPLATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HIDDEN_TEMPLATE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const SECRET = "sk-template-secret-123";
const INSTRUCTIONS = "You are a meticulous senior reviewer.";

function templates() {
  const base = {
    isPublished: true,
    usageCount: 0,
    description: "From the catalog",
    framework: "mastra",
    systemPrompt: INSTRUCTIONS,
    tools: [],
    modelConfig: { externalModel: "openai/gpt-4", temperature: 0.3, maxTokens: 4096 },
    sourceType: "inline",
    sourceCode: "export const agent = {}",
    sourceUrl: null,
    env: { PROVIDER_KEY: SECRET },
    tags: ["starter"],
    graphNodes: null,
    graphEdges: null,
  };
  return [
    {
      ...base,
      id: TASK_TEMPLATE,
      slug: "code-review-assistant",
      agentKind: "task",
      kindConfig: {
        task: {
          fields: [
            { key: "code", label: "Code to review", type: "long_text", required: true, help: "Paste the code or the diff." },
            { key: "focus", label: "What to look for", type: "choice", required: false, options: ["Everything", "Bugs"] },
          ],
        },
      },
    },
    {
      ...base,
      id: SCHEDULED_TEMPLATE,
      slug: "trading-signal-agent",
      agentKind: "scheduled",
      kindConfig: {
        scheduled: { schedule: { cronExpression: "0 9 * * *", timezone: "UTC" }, prompt: "Report today's signals." },
      },
    },
    { ...base, id: CHAT_TEMPLATE, slug: "customer-support-bot", agentKind: "conversation", kindConfig: null },
    { ...base, id: HIDDEN_TEMPLATE, slug: "draft", isPublished: false, agentKind: "task", kindConfig: null },
  ] as Array<Record<string, any>>;
}

/** Replaces the delegates the template routes reach, over an in-memory catalog. */
function world() {
  const state = {
    templates: templates(),
    agents: [] as Array<Record<string, any>>,
    listed: [] as any[],
    maxAgents: null as number | null,
  };
  const matches = (t: Record<string, any>, where: Record<string, any>) =>
    Object.entries(where).every(([key, value]) => key === "OR" || t[key] === value);
  const patch: Record<string, unknown> = {
    agentTemplate: {
      findFirst: async ({ where }: any) => state.templates.find((t) => matches(t, where)) ?? null,
      findMany: async (args: any) => (state.listed.push(args), state.templates.filter((t) => matches(t, args.where))),
      count: async ({ where }: any) => state.templates.filter((t) => matches(t, where)).length,
      update: async ({ where, data }: any) => {
        const template = state.templates.find((t) => t.id === where.id)!;
        template.usageCount += data.usageCount.increment;
        return template;
      },
    },
    agent: {
      findUnique: async ({ where }: any) =>
        state.agents.find((a) => a.orgId === where.orgId_slug.orgId && a.slug === where.orgId_slug.slug) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `agent-${state.agents.length + 1}`, ...data };
        state.agents.push(row);
        return row;
      },
    },
    agentGraph: { create: async () => ({}) },
    $transaction: async (fn: any) => fn(prisma),
  };
  const saved: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    saved[key] = (prisma as any)[key];
    (prisma as any)[key] = patch[key];
  }
  return { state, restore: () => Object.assign(prisma as any, saved) };
}

async function appFor(state: ReturnType<typeof world>["state"]) {
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(sensible);
  await app.register(
    createTemplateRoutes({
      requireAuth: async (request) => {
        (request as { auth?: unknown }).auth = { orgId: ORG, userId: "user-1", type: "jwt", role: "owner" };
      },
      publicApiUrl: () => "https://api.example.test",
      // The real create path over the patched prisma. Only the plan read
      // (another table and Redis) and the webhook are stood in for.
      useTemplate: (templateId, orgId, body) =>
        createAgent(
          {
            ...buildCreateAgentDeps(),
            availableFreeModelIds: () => [],
            assertCanCreateAgent: async () => {
              if (state.maxAgents !== null && state.agents.length >= state.maxAgents) {
                throw new PlanLimitError("The Starter plan includes up to 3 agents. Upgrade to Pro for unlimited agents.", "starter", "maxAgents");
              }
            },
            announce: () => undefined,
          },
          { orgId, body, templateId },
        ),
    }),
    { prefix: "/api/templates" },
  );
  await app.ready();
  return app;
}

const use = (app: Awaited<ReturnType<typeof appFor>>, templateId: string, payload: object) =>
  app.inject({ method: "POST", url: `/api/templates/${templateId}/use`, payload });

test("one template used twice gives two agents with different slugs", async () => {
  const { state, restore } = world();
  const app = await appFor(state);
  try {
    const first = await use(app, TASK_TEMPLATE, { name: "Code Reviewer" });
    const second = await use(app, TASK_TEMPLATE, { name: "Code Reviewer" });
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(first.json().agent.slug, "code-reviewer");
    assert.equal(second.json().agent.slug, "code-reviewer-1");
    assert.notEqual(first.json().agent.id, second.json().agent.id);
    assert.equal(state.agents.length, 2);
    assert.equal(state.templates[0]!.usageCount, 2);
  } finally {
    await app.close();
    restore();
  }
});

test("the slug is optional; one that is sent is cleaned and made unique too", async () => {
  const { state, restore } = world();
  const app = await appFor(state);
  try {
    // The request the web sends today: name, slug and description.
    const first = await use(app, TASK_TEMPLATE, { name: "Reviewer", slug: "my-reviewer", description: "Mine" });
    const second = await use(app, TASK_TEMPLATE, { name: "Reviewer two", slug: "My Reviewer" });
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().agent.slug, "my-reviewer");
    assert.equal(second.statusCode, 201);
    assert.equal(second.json().agent.slug, "my-reviewer-1");
    assert.equal(state.agents[0]!.description, "Mine");
    assert.equal(state.agents[1]!.description, "From the catalog");
  } finally {
    await app.close();
    restore();
  }
});

test("the agent carries the template's kind and a copy of its settings", async () => {
  const { state, restore } = world();
  const app = await appFor(state);
  try {
    const task = await use(app, TASK_TEMPLATE, { name: "Code Reviewer" });
    const scheduled = await use(app, SCHEDULED_TEMPLATE, { name: "Morning Signals" });
    const chat = await use(app, CHAT_TEMPLATE, { name: "Helpdesk" });
    assert.equal(task.json().agent.agentKind, "task");
    assert.equal(scheduled.json().agent.agentKind, "scheduled");
    assert.equal(chat.json().agent.agentKind, "conversation");

    const [taskRow, scheduledRow, chatRow] = state.agents;
    assert.equal(taskRow!.agentKind, "task");
    assert.deepEqual(taskRow!.kindConfig, state.templates[0]!.kindConfig);
    assert.notEqual(taskRow!.kindConfig, state.templates[0]!.kindConfig);
    assert.notEqual(taskRow!.kindConfig.task.fields[1].options, state.templates[0]!.kindConfig.task.fields[1].options);

    assert.equal(scheduledRow!.agentKind, "scheduled");
    assert.deepEqual(scheduledRow!.kindConfig, state.templates[1]!.kindConfig);
    assert.notEqual(scheduledRow!.kindConfig.scheduled, state.templates[1]!.kindConfig.scheduled);

    assert.equal(chatRow!.agentKind, "conversation");
    assert.equal(chatRow!.kindConfig, Prisma.DbNull);

    // Editing the agent's copy cannot reach the template.
    taskRow!.kindConfig.task.fields[0].label = "changed";
    assert.equal(state.templates[0]!.kindConfig.task.fields[0].label, "Code to review");
  } finally {
    await app.close();
    restore();
  }
});

test("the answer has the shape of POST /api/agents and no secret values", async () => {
  const { state, restore } = world();
  const app = await appFor(state);
  try {
    const res = await use(app, TASK_TEMPLATE, { name: "Code Reviewer" });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.json(), {
      agent: {
        id: "agent-1",
        name: "Code Reviewer",
        slug: "code-reviewer",
        framework: "mastra",
        agentKind: "task",
        apiEndpoint: "https://api.example.test/v1/agents/code-reviewer/chat/completions",
        openaiBaseUrl: "https://api.example.test/v1/agents/code-reviewer",
        openaiModel: "agent/code-reviewer",
      },
      // A template never makes a schedule by itself.
      schedule: null,
      message: "Agent created successfully",
    });

    // The row it used to send back carried all of these.
    const row = state.agents[0]!;
    assert.ok(isSealedAgentEnv(row.env), "the template's variables are stored sealed");
    assert.deepEqual(openAgentEnv(row.env), { PROVIDER_KEY: SECRET });
    for (const leaked of [SECRET, "__sealed", row.env.__sealed, "PROVIDER_KEY", INSTRUCTIONS, "sourceCode", "systemPrompt", "env"]) {
      assert.ok(!res.body.includes(leaked), `the answer must not carry ${leaked}`);
    }
  } finally {
    await app.close();
    restore();
  }
});

test("refusals: a name is needed; a template that is gone, hidden or not an id is a 404; the plan limit is a 403", async () => {
  const { state, restore } = world();
  const app = await appFor(state);
  try {
    const noName = await use(app, TASK_TEMPLATE, {});
    assert.equal(noName.statusCode, 400);
    assert.equal(noName.json().error, "validation_failed");
    assert.equal(noName.json().message, "Give your agent a name of at least 3 characters.");
    assert.deepEqual(noName.json().fields, { name: "Give your agent a name of at least 3 characters." });

    for (const id of ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", HIDDEN_TEMPLATE, "code-review-assistant"]) {
      const res = await use(app, id, { name: "Code Reviewer" });
      assert.equal(res.statusCode, 404, id);
      assert.deepEqual(res.json(), {
        error: "template_not_found",
        message: "This template is no longer available. Choose another one.",
      });
    }
    assert.equal(state.agents.length, 0);

    state.maxAgents = 0;
    const over = await use(app, TASK_TEMPLATE, { name: "Code Reviewer" });
    assert.equal(over.statusCode, 403);
    assert.equal(over.json().error, "plan_limit_reached");
    assert.equal(over.json().upgradeUrl, "/dashboard/billing?upgrade=pro");
    assert.equal(state.agents.length, 0);
    assert.equal(state.templates[0]!.usageCount, 0);
  } finally {
    await app.close();
    restore();
  }
});

test("a failure of the database is a 500 with no database text, not a 400 that quotes it", async () => {
  const { state, restore } = world();
  (prisma as any).agent.create = async () => {
    throw new Error('relation "agents" violates check constraint "agents_agent_kind_check"');
  };
  const app = await appFor(state);
  try {
    const res = await use(app, TASK_TEMPLATE, { name: "Code Reviewer" });
    assert.equal(res.statusCode, 500);
    assert.ok(!res.body.includes("agents_agent_kind_check"));
  } finally {
    await app.close();
    restore();
  }
});

test("using a template needs a session or a key", async () => {
  const { restore } = world();
  const app = Fastify();
  app.decorateRequest("auth", null);
  await app.register(templateRoutes, { prefix: "/api/templates" });
  try {
    const res = await use(app as never, TASK_TEMPLATE, { name: "Code Reviewer" });
    assert.equal(res.statusCode, 401);
  } finally {
    await app.close();
    restore();
  }
});

test("GET /api/templates returns agentKind and kindConfig on each template", async () => {
  const { state, restore } = world();
  const app = await appFor(state);
  try {
    const res = await app.inject({ method: "GET", url: "/api/templates" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.total, 3);
    assert.deepEqual(
      body.templates.map((t: any) => [t.slug, t.agentKind]),
      [
        ["code-review-assistant", "task"],
        ["trading-signal-agent", "scheduled"],
        ["customer-support-bot", "conversation"],
      ],
    );
    assert.deepEqual(body.templates[0].kindConfig, state.templates[0]!.kindConfig);
    assert.equal(body.templates[2].kindConfig, null);
    assert.equal("agentKind" in state.listed[0].where, false, "no filter unless one is asked for");
  } finally {
    await app.close();
    restore();
  }
});

test("the public catalog never returns a variable's value, only its name", async () => {
  const { state, restore } = world();
  const app = await appFor(state);
  try {
    const list = await app.inject({ method: "GET", url: "/api/templates" });
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.includes(SECRET), false, "no value in the list");
    for (const template of list.json().templates) assert.deepEqual(template.env, { PROVIDER_KEY: "" });

    const one = await app.inject({ method: "GET", url: `/api/templates/${TASK_TEMPLATE}` });
    assert.equal(one.statusCode, 200);
    assert.equal(one.body.includes(SECRET), false, "no value in the detail");
    assert.deepEqual(one.json().env, { PROVIDER_KEY: "" });

    // What is stored is untouched: using the template still seals the real value.
    assert.deepEqual(state.templates[0]!.env, { PROVIDER_KEY: SECRET });
  } finally {
    await app.close();
    restore();
  }
});

test("GET /api/templates?agentKind= narrows the list to one kind and refuses a kind that does not exist", async () => {
  const { state, restore } = world();
  const app = await appFor(state);
  try {
    for (const [kind, slug] of [
      ["task", "code-review-assistant"],
      ["scheduled", "trading-signal-agent"],
      ["conversation", "customer-support-bot"],
    ]) {
      const res = await app.inject({ method: "GET", url: `/api/templates?agentKind=${kind}` });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().templates.map((t: any) => t.slug), [slug]);
      assert.equal(res.json().total, 1);
      assert.equal(state.listed.at(-1).where.agentKind, kind);
      assert.equal(state.listed.at(-1).where.isPublished, true);
    }

    // With the filters there already.
    const both = await app.inject({ method: "GET", url: "/api/templates?agentKind=task&framework=mastra" });
    assert.deepEqual(state.listed.at(-1).where, { isPublished: true, framework: "mastra", agentKind: "task" });
    assert.equal(both.json().total, 1);

    const listedBefore = state.listed.length;
    const bad = await app.inject({ method: "GET", url: "/api/templates?agentKind=chat" });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, "validation_failed");
    assert.equal(bad.json().fields.agentKind, "Choose a kind to filter by: conversation, task, scheduled.");
    assert.equal(state.listed.length, listedBefore, "nothing was read for it");
  } finally {
    await app.close();
    restore();
  }
});
