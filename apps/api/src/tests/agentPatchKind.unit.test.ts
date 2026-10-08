/**
 * PATCH /api/agents/:id with agentKind and kindConfig, and the kind on the
 * list: the two fields go through resolveKindConfig, a key inside kindConfig
 * replaces that key only, and a change bumps the patch version as a change of
 * the instructions does.
 *
 * Hermetic: the global prisma's `agent` delegate is replaced for each test.
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { Prisma, prisma } from "@wheelsai/db";

import { globalErrorHandler } from "../lib/errorHandler.js";
import { createAgentRoutes } from "../routes/agents.js";

const ORG = "0f1e2d3c-4b5a-4968-8776-655443322110";
const AGENT_ID = "11111111-2222-4333-8444-555555555555";

const FORM = { fields: [{ key: "code", label: "Code to review", type: "long_text", required: true }] };
const SUGGESTION = { schedule: { cronExpression: "0 9 * * *", timezone: "UTC" }, prompt: "Report the signals." };

function storedAgent(over: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    orgId: ORG,
    name: "Reviewer",
    slug: "reviewer",
    version: "1.2.3",
    systemPrompt: "Be brief.",
    tools: [],
    modelConfig: { temperature: 0.7, maxTokens: 4096 },
    entrypoint: "chat",
    env: null,
    agentKind: "conversation",
    kindConfig: null as unknown,
    ...over,
  };
}

async function appWith(row: ReturnType<typeof storedAgent>) {
  const writes: any[] = [];
  const saved = (prisma as any).agent;
  (prisma as any).agent = {
    findFirst: async () => row,
    findMany: async () => [{ ...row, deployments: [], tags: [], isPublic: false }],
    update: async ({ data }: any) => {
      writes.push(data);
      // What the database would hold afterwards: DbNull reads back as null.
      const next = { ...data, ...(data.kindConfig === Prisma.DbNull && { kindConfig: null }) };
      Object.assign(row, Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)));
      return row;
    },
  };
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(sensible);
  await app.register(
    createAgentRoutes({
      requireAuth: async (request) => {
        (request as { auth?: unknown }).auth = { orgId: ORG, userId: "user-1", type: "jwt", role: "owner" };
      },
      publicApiUrl: () => "https://api.example.test",
      prisma: (prisma as any) as never,
    }),
  );
  await app.ready();
  const patch = (payload: object) => app.inject({ method: "PATCH", url: `/${AGENT_ID}`, payload });
  return {
    app,
    writes,
    patch,
    close: async () => {
      await app.close();
      (prisma as any).agent = saved;
    },
  };
}

test("changing the kind stores it, gives a task agent its default form, and bumps the patch version", async () => {
  const { patch, writes, close } = await appWith(storedAgent());
  try {
    const res = await patch({ agentKind: "task" });
    assert.equal(res.statusCode, 200);
    assert.equal(writes[0].agentKind, "task");
    assert.deepEqual(writes[0].kindConfig, {
      task: { fields: [{ key: "your_request", label: "Your request", type: "long_text", required: true }] },
    });
    assert.equal(writes[0].version, "1.2.4");
    assert.equal(res.json().agent.agentKind, "task");
    assert.equal(res.json().agent.version, "1.2.4");
  } finally {
    await close();
  }
});

test("a save that resends the same kind and settings is not a new version", async () => {
  const { patch, writes, close } = await appWith(storedAgent({ agentKind: "task", kindConfig: { task: FORM } }));
  try {
    assert.equal((await patch({ agentKind: "task", kindConfig: { task: FORM }, name: "Renamed" })).statusCode, 200);
    assert.equal(writes[0].version, "1.2.3");
    assert.equal(writes[0].name, "Renamed");
    assert.deepEqual(writes[0].kindConfig, { task: FORM });
  } finally {
    await close();
  }
});

test("a key inside kindConfig replaces that key only; the other kind's settings stay", async () => {
  const { patch, writes, close } = await appWith(
    storedAgent({ agentKind: "task", kindConfig: { task: FORM, scheduled: SUGGESTION } }),
  );
  try {
    const newForm = { fields: [{ key: "topic", label: "Topic", type: "short_text", required: true }] };
    assert.equal((await patch({ kindConfig: { task: newForm } })).statusCode, 200);
    assert.deepEqual(writes[0].kindConfig, { task: newForm, scheduled: SUGGESTION });
    assert.equal(writes[0].agentKind, "task");
    assert.equal(writes[0].version, "1.2.4");

    // The kind changes and back: nothing of either kind's settings is lost.
    assert.equal((await patch({ agentKind: "scheduled" })).statusCode, 200);
    assert.deepEqual(writes[1].kindConfig, { task: newForm, scheduled: SUGGESTION });
    assert.equal(writes[1].version, "1.2.5");

    // null removes one key.
    assert.equal((await patch({ kindConfig: { task: null } })).statusCode, 200);
    assert.deepEqual(writes[2].kindConfig, { scheduled: SUGGESTION });
  } finally {
    await close();
  }
});

test("clearing the settings of a conversation agent writes a database NULL", async () => {
  const { patch, writes, close } = await appWith(
    storedAgent({ agentKind: "conversation", kindConfig: { scheduled: SUGGESTION } }),
  );
  try {
    assert.equal((await patch({ kindConfig: null })).statusCode, 200);
    assert.equal(writes[0].kindConfig, Prisma.DbNull);
    assert.equal(writes[0].version, "1.2.4");
  } finally {
    await close();
  }
});

test("a PATCH that names neither field leaves both alone and keeps today's version rule", async () => {
  const { patch, writes, close } = await appWith(storedAgent({ agentKind: "task", kindConfig: { task: FORM } }));
  try {
    assert.equal((await patch({ name: "Renamed" })).statusCode, 200);
    assert.equal("agentKind" in writes[0], false);
    assert.equal("kindConfig" in writes[0], false);
    assert.equal(writes[0].version, "1.2.3");

    assert.equal((await patch({ systemPrompt: "Be thorough." })).statusCode, 200);
    assert.equal(writes[1].version, "1.2.4");
    assert.equal("kindConfig" in writes[1], false);
  } finally {
    await close();
  }
});

test("a kind or a form that cannot be used is a 400 in plain words, and nothing is written", async () => {
  const { patch, writes, close } = await appWith(storedAgent());
  try {
    const kind = await patch({ agentKind: "chat" });
    assert.equal(kind.statusCode, 400);
    assert.equal(kind.json().error, "validation_failed");
    assert.equal(kind.json().message, "Choose how people use this agent: conversation, task or scheduled.");
    assert.deepEqual(kind.json().fields, {
      agentKind: "Choose how people use this agent: conversation, task or scheduled.",
    });

    const form = await patch({
      agentKind: "task",
      kindConfig: { task: { fields: [{ label: "Pick one", type: "choice", options: ["Only one"] }] } },
    });
    assert.equal(form.statusCode, 400);
    assert.equal(form.json().fields["kindConfig.task.fields[0].options"], "Add at least two options.");
    assert.deepEqual(form.json().details.fieldErrors.kindConfig, ["Add at least two options."]);

    const unknown = await patch({ kindConfig: { publicHandle: "mine" } });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.json().fields.kindConfig, "The settings of an agent are task and scheduled. Remove anything else.");

    assert.equal(writes.length, 0);
  } finally {
    await close();
  }
});

test("GET /api/agents carries agentKind on each agent", async () => {
  for (const [stored, shown] of [
    ["task", "task"],
    ["scheduled", "scheduled"],
    ["conversation", "conversation"],
    [undefined, "conversation"],
  ] as const) {
    const { app, close } = await appWith(storedAgent({ agentKind: stored }));
    try {
      const res = await app.inject({ method: "GET", url: "/" });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().agents[0].agentKind, shown);
    } finally {
      await close();
    }
  }
});
