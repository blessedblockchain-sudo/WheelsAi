/**
 * PATCH /api/agents/:id with agentKind and kindConfig, and the kind on the
 * list: the two fields go through resolveKindConfig, a key inside kindConfig
 * replaces that key only, and a change bumps the patch version as a change of
 * the instructions does.
 *
 * Also the public page: a handle whenever isPublic becomes true, and the
 * page key turned off, in the same transaction, whenever a public agent is
 * made private.
 *
 * And the schedule: an agent whose kind leaves "scheduled" has its own
 * schedule turned off in the transaction of the update, and the answer says
 * so with schedulePaused.
 *
 * Hermetic: the global prisma's `agent`, `widgetKey` and `scheduledTask`
 * delegates and its `$transaction` are replaced for each test.
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { Prisma, prisma } from "@wheelsai/db";

import { globalErrorHandler } from "../lib/errorHandler.js";
import { createAgentRoutes } from "../routes/agents.js";
import { getPublicLink, type AgentPublicLinkDeps } from "../services/agentPublicLink.js";

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

/** The agent's page key (WidgetKey.pageOfAgentId), as the routes read and switch it. */
interface FakePageKey {
  id: string;
  orgId: string;
  pageOfAgentId: string;
  enabled: boolean;
  revokedAt: Date | null;
  dailyMessageCap: number | null;
}

const pageKeyOf = (over: Partial<FakePageKey> = {}): FakePageKey => ({
  id: "key-1",
  orgId: ORG,
  pageOfAgentId: AGENT_ID,
  enabled: true,
  revokedAt: null,
  dailyMessageCap: 100,
  ...over,
});

/** A scheduled_tasks row, as setOwnScheduleEnabled reads and switches it. */
interface FakeTask {
  id: string;
  orgId: string;
  agentId: string;
  taskType: string;
  isEnabled: boolean;
  status: string;
  createdAt: Date;
}

const taskOf = (over: Partial<FakeTask> = {}): FakeTask => ({
  id: "task-1",
  orgId: ORG,
  agentId: AGENT_ID,
  taskType: "agent_run",
  isEnabled: true,
  status: "active",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  ...over,
});

async function appWith(
  row: ReturnType<typeof storedAgent>,
  others: Array<Record<string, unknown>> = [],
  page: { key?: FakePageKey | null; keyWriteFails?: boolean; tasks?: FakeTask[]; taskWriteFails?: boolean } = {},
) {
  const writes: any[] = [];
  /** Every widget key write, and whether it ran inside a transaction. */
  const keyWrites: Array<{ where: any; data: any; inTransaction: boolean }> = [];
  /** Whether each agent update ran inside a transaction, in order. */
  const updatesInTransaction: boolean[] = [];
  let transactions = 0;
  let open = 0;
  const pageKey = page.key ?? null;
  const tasks = page.tasks ?? [];
  /** Every scheduled task read and write, and whether it ran inside a transaction. */
  const taskReads: Array<{ where: any; inTransaction: boolean }> = [];
  const taskWrites: Array<{ where: any; data: any; inTransaction: boolean }> = [];
  const savedTasks = (prisma as any).scheduledTask;
  const saved = (prisma as any).agent;
  const savedKeys = (prisma as any).widgetKey;
  const savedTransaction = (prisma as any).$transaction;
  const savedWebhooks = (prisma as any).webhook;
  // The PATCH announces "agent.updated" without waiting; no webhook is set up here,
  // and without this the lookup would reach for a real database.
  (prisma as any).webhook = { findMany: async () => [] };
  // One transaction: what its writes changed is undone when it throws.
  (prisma as any).$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    transactions += 1;
    const before = { row: { ...row }, key: pageKey && { ...pageKey }, tasks: tasks.map((task) => ({ ...task })) };
    open += 1;
    try {
      return await fn(prisma);
    } catch (err) {
      for (const name of Object.keys(row)) delete (row as any)[name];
      Object.assign(row, before.row);
      if (pageKey && before.key) Object.assign(pageKey, before.key);
      tasks.forEach((task, i) => Object.assign(task, before.tasks[i]));
      throw err;
    } finally {
      open -= 1;
    }
  };
  (prisma as any).widgetKey = {
    findFirst: async ({ where }: any) =>
      pageKey && pageKey.pageOfAgentId === where.pageOfAgentId && pageKey.orgId === where.orgId ? { ...pageKey } : null,
    // The compare-and-set of setPageUse: only a row that matches every column asked for.
    updateMany: async ({ where, data }: any) => {
      keyWrites.push({ where, data, inTransaction: open > 0 });
      if (page.keyWriteFails) throw new Error("the database went away");
      const matches =
        pageKey !== null &&
        pageKey.pageOfAgentId === where.pageOfAgentId &&
        pageKey.orgId === where.orgId &&
        (where.revokedAt !== null || pageKey.revokedAt === null) &&
        (where.enabled === undefined || pageKey.enabled === where.enabled);
      if (!matches) return { count: 0 };
      Object.assign(pageKey, data);
      return { count: 1 };
    },
  };
  (prisma as any).scheduledTask = {
    // The agent's own schedule: its oldest agent_run task in the organization.
    findMany: async ({ where, take }: any) => {
      taskReads.push({ where, inTransaction: open > 0 });
      return tasks
        .filter((t) => t.orgId === where.orgId && t.agentId === where.agentId && t.taskType === where.taskType)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        .slice(0, take)
        .map((t) => ({ ...t }));
    },
    // The compare-and-set of setOwnScheduleEnabled: only a row that matches every column asked for.
    updateMany: async ({ where, data }: any) => {
      taskWrites.push({ where, data, inTransaction: open > 0 });
      if (page.taskWriteFails) throw new Error("the database went away");
      const hit = tasks.filter(
        (t) => t.id === where.id && t.orgId === where.orgId && t.agentId === where.agentId && t.isEnabled === where.isEnabled,
      );
      for (const task of hit) Object.assign(task, data);
      return { count: hit.length };
    },
  };
  (prisma as any).agent = {
    // By handle across every agent (the address is platform-wide); else the agent itself.
    findFirst: async ({ where }: any = {}) =>
      where?.publicHandle !== undefined
        ? ([row, ...others].find((agent: any) => agent.publicHandle === where.publicHandle) ?? null)
        : row,
    // The handle write of assignPublicHandle: only into an agent that has none.
    updateMany: async ({ where, data }: any) => {
      if (where.id !== row.id || ((row as any).publicHandle ?? null) !== where.publicHandle) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
    findMany: async () => [{ ...row, deployments: [], tags: [], isPublic: false }],
    update: async ({ data }: any) => {
      writes.push(data);
      updatesInTransaction.push(open > 0);
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
  /** GET /api/agents/:id/public-link's own read (services/agentPublicLink.ts), over the same rows. */
  const publicLink = () =>
    getPublicLink(
      {
        db: prisma as unknown as AgentPublicLinkDeps["db"],
        transaction: (fn) => fn(prisma as unknown as AgentPublicLinkDeps["db"]),
        limiter: { peek: async () => 0 },
        pageUrl: (handle) => `https://app.example.test/a/${handle}`,
        toolOffForVisitors: () => false,
        keyDefaultDailyCap: 100,
      },
      ORG,
      AGENT_ID,
    );
  return {
    app,
    writes,
    keyWrites,
    updatesInTransaction,
    transactions: () => transactions,
    pageKey,
    tasks,
    taskReads,
    taskWrites,
    publicLink,
    patch,
    close: async () => {
      await app.close();
      (prisma as any).agent = saved;
      (prisma as any).widgetKey = savedKeys;
      (prisma as any).scheduledTask = savedTasks;
      (prisma as any).$transaction = savedTransaction;
      (prisma as any).webhook = savedWebhooks;
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

test("an agent made public gets its address from its slug, and the answers carry it", async () => {
  const { app, patch, writes, close } = await appWith(storedAgent({ isPublic: false, publicHandle: null }));
  const savedKeys = (prisma as any).widgetKey;
  // No page key is made here: an agent made public this way is view-only.
  (prisma as any).widgetKey = new Proxy({}, { get: () => () => assert.fail("PATCH must not touch widget keys") });
  try {
    const res = await patch({ isPublic: true });
    assert.equal(res.statusCode, 200);
    assert.equal(writes[0].isPublic, true);
    assert.equal(res.json().agent.publicHandle, "reviewer");
    assert.equal(res.json().agent.isPublic, true);

    const list = await app.inject({ method: "GET", url: "/" });
    assert.equal(list.json().agents[0].publicHandle, "reviewer");
  } finally {
    (prisma as any).widgetKey = savedKeys;
    await close();
  }
});

test("a handle another agent has is not taken: the next candidate carries the start of the id", async () => {
  const { patch, close } = await appWith(storedAgent({ isPublic: false, publicHandle: null }), [
    { id: "99999999-2222-4333-8444-555555555555", publicHandle: "reviewer" },
  ]);
  try {
    const res = await patch({ isPublic: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().agent.publicHandle, "reviewer-11111111");
  } finally {
    await close();
  }
});

test("a handle that exists is never changed, and making the agent private does not clear it", async () => {
  const { patch, writes, close } = await appWith(storedAgent({ isPublic: false, publicHandle: "my-reviewer" }));
  try {
    assert.equal((await patch({ isPublic: true })).json().agent.publicHandle, "my-reviewer");
    const hidden = await patch({ isPublic: false });
    assert.equal(hidden.json().agent.isPublic, false);
    assert.equal(hidden.json().agent.publicHandle, "my-reviewer");
    assert.ok(writes.every((data) => !("publicHandle" in data)), "the update itself never writes a handle");
  } finally {
    await close();
  }
});

test("a save that does not make the agent public gives it no address", async () => {
  const { patch, close } = await appWith(storedAgent({ isPublic: false, publicHandle: null }));
  try {
    assert.equal((await patch({ name: "Renamed" })).json().agent.publicHandle, null);
    assert.equal((await patch({ isPublic: false })).json().agent.publicHandle, null);
  } finally {
    await close();
  }
});

// ============================================
// Making a public agent private: its page key goes off with the page
// ============================================

test("making an agent private turns its page key off with the page, in one transaction; public again by PATCH reads paused", async () => {
  const row = storedAgent({ isPublic: true, publicHandle: "reviewer", publicResults: false });
  const { patch, writes, keyWrites, updatesInTransaction, transactions, pageKey, publicLink, close } = await appWith(
    row,
    [],
    { key: pageKeyOf() },
  );
  try {
    assert.equal((await publicLink()).state, "on");

    const hidden = await patch({ isPublic: false });
    assert.equal(hidden.statusCode, 200);
    assert.equal(hidden.json().agent.isPublic, false);
    assert.equal(writes[0].isPublic, false);
    // setPageUse's compare-and-set, scoped to the caller's organization.
    assert.deepEqual(keyWrites, [
      {
        where: { pageOfAgentId: AGENT_ID, orgId: ORG, revokedAt: null, enabled: true },
        data: { enabled: false },
        inTransaction: true,
      },
    ]);
    assert.equal(transactions(), 1);
    assert.deepEqual(updatesInTransaction, [true], "the agent update and the key write share the transaction");
    assert.equal(pageKey?.enabled, false);
    assert.equal((await publicLink()).state, "off");

    // Visible again: nobody can use it until its owner turns the link on.
    const shown = await patch({ isPublic: true });
    assert.equal(shown.statusCode, 200);
    assert.equal(shown.json().agent.publicHandle, "reviewer");
    assert.equal(keyWrites.length, 1, "making the page public writes no widget key");
    assert.equal(pageKey?.enabled, false);
    assert.equal((await publicLink()).state, "paused");
  } finally {
    await close();
  }
});

test("a public agent with no page key, or one already paused, is made private without an error", async () => {
  for (const key of [null, pageKeyOf({ enabled: false }), pageKeyOf({ revokedAt: new Date("2026-10-01T00:00:00Z"), enabled: false })]) {
    const { patch, keyWrites, pageKey, publicLink, close } = await appWith(
      storedAgent({ isPublic: true, publicHandle: "reviewer", publicResults: false }),
      [],
      { key },
    );
    try {
      const res = await patch({ isPublic: false });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().agent.isPublic, false);
      // Asked, and nothing to move: not an error.
      assert.equal(keyWrites.length, 1);
      assert.equal(pageKey?.enabled ?? false, false);
      assert.equal((await publicLink()).state, "off");
    } finally {
      await close();
    }
  }
});

test("when the page key cannot be turned off the agent stays public: no half of the change is kept", async () => {
  const row = storedAgent({ isPublic: true, publicHandle: "reviewer", publicResults: false });
  const { patch, pageKey, publicLink, close } = await appWith(row, [], { key: pageKeyOf(), keyWriteFails: true });
  try {
    const res = await patch({ isPublic: false, name: "Renamed" });
    assert.equal(res.statusCode, 500);
    assert.equal((row as any).isPublic, true);
    assert.equal(row.name, "Reviewer");
    assert.equal(pageKey?.enabled, true);
    assert.equal((await publicLink()).state, "on");
  } finally {
    await close();
  }
});

test("a PATCH that leaves isPublic alone, sets it true, or sets false on a private agent writes no widget key", async () => {
  const cases: Array<[string, boolean, object]> = [
    ["a rename of a public agent", true, { name: "Renamed" }],
    ["new instructions for a public agent", true, { systemPrompt: "Be thorough." }],
    ["public sent again for a public agent", true, { isPublic: true }],
    ["a private agent made public", false, { isPublic: true }],
    ["private sent again for a private agent", false, { isPublic: false }],
    ["a rename of a private agent", false, { name: "Renamed" }],
  ];
  for (const [name, isPublic, payload] of cases) {
    const { patch, keyWrites, transactions, pageKey, close } = await appWith(
      storedAgent({ isPublic, publicHandle: "reviewer", publicResults: false }),
      [],
      { key: pageKeyOf() },
    );
    try {
      assert.equal((await patch(payload)).statusCode, 200, name);
      assert.deepEqual(keyWrites, [], name);
      assert.equal(transactions(), 0, name);
      assert.equal(pageKey?.enabled, true, name);
    } finally {
      await close();
    }
  }
});

// ============================================
// Leaving "scheduled": the agent's own schedule goes off with the kind
// ============================================

test("leaving scheduled turns the agent's own schedule off in the update's transaction and answers schedulePaused", async () => {
  for (const to of ["conversation", "task"]) {
    const other = taskOf({ id: "task-other", agentId: "99999999-2222-4333-8444-555555555555" });
    const { patch, writes, tasks, taskWrites, updatesInTransaction, transactions, close } = await appWith(
      storedAgent({ agentKind: "scheduled", kindConfig: { scheduled: SUGGESTION } }),
      [],
      { tasks: [taskOf(), other] },
    );
    try {
      const res = await patch({ agentKind: to });
      assert.equal(res.statusCode, 200, to);
      assert.equal(res.json().schedulePaused, true, to);
      assert.equal(res.json().agent.agentKind, to, to);
      assert.equal(writes[0].agentKind, to, to);
      // The compare-and-set of setOwnScheduleEnabled, scoped to the caller's organization.
      assert.deepEqual(
        taskWrites,
        [
          {
            where: { id: "task-1", orgId: ORG, agentId: AGENT_ID, isEnabled: true },
            data: { isEnabled: false, status: "paused" },
            inTransaction: true,
          },
        ],
        to,
      );
      assert.equal(transactions(), 1, to);
      assert.deepEqual(updatesInTransaction, [true], "the agent update and the schedule write share the transaction");
      // The task stays, switched off; another agent's is untouched.
      assert.equal(tasks.length, 2, to);
      assert.deepEqual([tasks[0]!.isEnabled, tasks[0]!.status], [false, "paused"], to);
      assert.deepEqual([tasks[1]!.isEnabled, tasks[1]!.status], [true, "active"], to);
      // Its suggestion is kept, so the kind can be set back.
      assert.deepEqual(writes[0].kindConfig.scheduled, SUGGESTION, to);
    } finally {
      await close();
    }
  }
});

test("only the agent's own schedule is turned off: its oldest agent_run task", async () => {
  const own = taskOf({ id: "task-own", createdAt: new Date("2026-09-01T00:00:00Z") });
  const later = taskOf({ id: "task-later", createdAt: new Date("2026-10-02T00:00:00Z") });
  const report = taskOf({ id: "task-report", taskType: "report", createdAt: new Date("2026-08-01T00:00:00Z") });
  const { patch, tasks, close } = await appWith(storedAgent({ agentKind: "scheduled" }), [], { tasks: [later, report, own] });
  try {
    assert.equal((await patch({ agentKind: "conversation" })).json().schedulePaused, true);
    assert.deepEqual(
      tasks.map((t) => [t.id, t.isEnabled]),
      [
        ["task-later", true],
        ["task-report", true],
        ["task-own", false],
      ],
    );
  } finally {
    await close();
  }
});

test("moving the kind to scheduled turns nothing on, and staying scheduled touches no schedule", async () => {
  const off = taskOf({ isEnabled: false, status: "paused" });
  const to = await appWith(storedAgent({ agentKind: "conversation" }), [], { tasks: [off] });
  try {
    const res = await to.patch({ agentKind: "scheduled" });
    assert.equal(res.statusCode, 200);
    assert.equal("schedulePaused" in res.json(), false);
    assert.deepEqual(to.taskReads, []);
    assert.deepEqual(to.taskWrites, []);
    assert.equal(to.transactions(), 0);
    assert.equal(to.tasks[0]!.isEnabled, false);
  } finally {
    await to.close();
  }

  const stay = await appWith(storedAgent({ agentKind: "scheduled", kindConfig: { scheduled: SUGGESTION } }), [], {
    tasks: [taskOf()],
  });
  try {
    for (const payload of [
      { agentKind: "scheduled" },
      { kindConfig: { scheduled: { prompt: "Another line." } } },
      { name: "Renamed" },
      { systemPrompt: "Be thorough." },
    ]) {
      const res = await stay.patch(payload);
      assert.equal(res.statusCode, 200);
      assert.equal("schedulePaused" in res.json(), false);
    }
    assert.deepEqual(stay.taskReads, []);
    assert.deepEqual(stay.taskWrites, []);
    assert.equal(stay.transactions(), 0, "a PATCH that needs neither rule opens no transaction");
    assert.equal(stay.tasks[0]!.isEnabled, true);
  } finally {
    await stay.close();
  }
});

test("leaving scheduled with no schedule, or one already off, is not an error and says nothing was paused", async () => {
  for (const tasks of [[], [taskOf({ isEnabled: false, status: "paused" })], [taskOf({ taskType: "report" })]]) {
    const { patch, taskWrites, transactions, close } = await appWith(storedAgent({ agentKind: "scheduled" }), [], { tasks });
    try {
      const res = await patch({ agentKind: "task" });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().agent.agentKind, "task");
      assert.equal("schedulePaused" in res.json(), false);
      assert.deepEqual(taskWrites, []);
      assert.equal(transactions(), 1);
      assert.equal(tasks[0]?.isEnabled ?? false, tasks[0]?.taskType === "report");
    } finally {
      await close();
    }
  }
});

test("a PATCH that makes the agent private and leaves scheduled does both in one transaction", async () => {
  const { patch, keyWrites, taskWrites, updatesInTransaction, transactions, pageKey, tasks, publicLink, close } = await appWith(
    storedAgent({ agentKind: "scheduled", isPublic: true, publicHandle: "reviewer", publicResults: false }),
    [],
    { key: pageKeyOf(), tasks: [taskOf()] },
  );
  try {
    const res = await patch({ isPublic: false, agentKind: "conversation" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().schedulePaused, true);
    assert.equal(res.json().agent.isPublic, false);
    assert.equal(transactions(), 1, "one transaction for the update, the page key and the schedule");
    assert.deepEqual(updatesInTransaction, [true]);
    assert.deepEqual(keyWrites.map((w) => w.inTransaction), [true]);
    assert.deepEqual(taskWrites.map((w) => w.inTransaction), [true]);
    assert.equal(pageKey?.enabled, false);
    assert.equal(tasks[0]!.isEnabled, false);
    assert.equal((await publicLink()).state, "off");
  } finally {
    await close();
  }
});

test("when the schedule cannot be turned off the kind does not change: no half of the change is kept", async () => {
  const row = storedAgent({ agentKind: "scheduled", isPublic: true, publicHandle: "reviewer", publicResults: false });
  const { patch, pageKey, tasks, close } = await appWith(row, [], { key: pageKeyOf(), tasks: [taskOf()], taskWriteFails: true });
  try {
    const res = await patch({ agentKind: "conversation", isPublic: false, name: "Renamed" });
    assert.equal(res.statusCode, 500);
    assert.equal(row.agentKind, "scheduled");
    assert.equal(row.name, "Reviewer");
    assert.equal((row as any).isPublic, true);
    assert.equal(pageKey?.enabled, true, "the page key turned off in the same transaction is back on");
    assert.equal(tasks[0]!.isEnabled, true);
  } finally {
    await close();
  }
});
