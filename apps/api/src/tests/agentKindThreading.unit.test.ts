import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { Prisma } from "@wheelsai/db";
import { DEFAULT_TASK_FIELDS, type KindConfig } from "@wheelsai/shared/agent-kind";

import { cloneAgentKind } from "../services/marketplaceClone.js";

// An agent's kind and its settings travel wherever the agent is copied: into
// a version snapshot, back out on a rollback, into the diff between two
// versions, and into a buyer's copy on install. Each copy is a deep one, and
// a version from before agents had a kind rolls back to a conversation.
//
// The real services run over an in-memory Prisma, patched in for the length
// of a test the way the tenancy and install tests do.

type Row = Record<string, any>;

const ORG = "org_1";
const AGENT_ID = "agent_1";
const SCOPE = { agentId: AGENT_ID, orgId: ORG };

const FORM: KindConfig = {
  task: {
    fields: [
      { key: "code", label: "Code to review", type: "long_text", required: true, help: "Paste the code or the diff." },
      { key: "focus", label: "What to look for", type: "choice", required: false, options: ["Everything", "Bugs"] },
    ],
  },
  scheduled: {
    schedule: { cronExpression: "0 9 * * *", timezone: "UTC" },
    prompt: "Report today's findings.",
  },
};

const copy = <T>(value: T): T => structuredClone(value);

/** What Postgres would hold for a written JSON column. */
function stored(value: unknown): unknown {
  return value === Prisma.DbNull || value === Prisma.JsonNull || value === undefined ? null : copy(value);
}

/** True when the two values share no object or array anywhere inside them. */
function sharesNothing(a: unknown, b: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (value: unknown, visit: (node: object) => boolean): boolean => {
    if (typeof value !== "object" || value === null) return true;
    if (!visit(value)) return false;
    return Object.values(value).every((inner) => walk(inner, visit));
  };
  walk(a, (node) => {
    seen.add(node);
    return true;
  });
  return walk(b, (node) => !seen.has(node));
}

// ============================================
// Versions
// ============================================

function makeVersionWorld(agent: Row, versions: Row[] = []) {
  const state = {
    agent: {
      id: AGENT_ID,
      orgId: ORG,
      name: "Reviewer",
      description: null,
      framework: "custom",
      systemPrompt: "Review code.",
      tools: [],
      modelConfig: {},
      sourceType: "inline",
      sourceUrl: null,
      sourceCode: null,
      env: {},
      entrypoint: "chat",
      version: "1.0.0",
      agentKind: "conversation",
      kindConfig: null,
      graph: null,
      ...agent,
    } as Row,
    versions: versions.map((v, i) => ({
      id: `ver_${i + 1}`,
      agentId: AGENT_ID,
      versionNumber: i + 1,
      name: "Reviewer",
      description: null,
      framework: "custom",
      systemPrompt: "Review code.",
      tools: [],
      modelConfig: {},
      sourceType: "inline",
      sourceUrl: null,
      sourceCode: null,
      env: {},
      graphNodes: null,
      graphEdges: null,
      entrypoint: "chat",
      isLatest: false,
      ...v,
    })) as Row[],
    diffs: [] as Row[],
    /** The `data` of every agent.update, as the service passed it. */
    agentUpdates: [] as Row[],
    /** The `data` of every agentVersion.create, as the service passed it. */
    versionCreates: [] as Row[],
  };

  const models: Row = {
    agent: {
      findFirst: async ({ where }: Row) =>
        where.id === state.agent.id && (where.orgId === undefined || where.orgId === state.agent.orgId)
          ? state.agent
          : null,
      updateMany: async ({ where }: Row) => ({
        count: where.id === state.agent.id && where.orgId === state.agent.orgId ? 1 : 0,
      }),
      update: async ({ data }: Row) => {
        state.agentUpdates.push(data);
        for (const [key, value] of Object.entries(data)) {
          state.agent[key] = key === "kindConfig" ? stored(value) : value;
        }
        return state.agent;
      },
    },
    agentVersion: {
      findFirst: async () => [...state.versions].sort((a, b) => b.versionNumber - a.versionNumber)[0] ?? null,
      findUnique: async ({ where }: Row) =>
        state.versions.find((v) => v.version === where.agentId_version.version) ?? null,
      updateMany: async ({ data }: Row) => {
        for (const v of state.versions) Object.assign(v, data);
        return { count: state.versions.length };
      },
      create: async ({ data }: Row) => {
        state.versionCreates.push(data);
        const row = { id: `ver_${state.versions.length + 1}`, ...data, kindConfig: stored(data.kindConfig) };
        state.versions.push(row);
        return row;
      },
    },
    agentVersionDiff: {
      findUnique: async () => null,
      create: async ({ data }: Row) => {
        state.diffs.push(data);
        return data;
      },
    },
    agentGraph: { upsert: async () => ({}) },
    user: { findUnique: async () => ({ displayName: "Tester", email: null }) },
  };
  models.$transaction = async (fn: (tx: Row) => Promise<unknown>) => fn(models);
  return { state, models };
}

async function withPrisma<T>(models: Row, body: () => Promise<T>): Promise<T> {
  const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Row };
  const originals: Row = {};
  for (const [name, fake] of Object.entries(models)) {
    originals[name] = prisma[name];
    prisma[name] = fake;
  }
  try {
    const result = await body();
    // Let fire-and-forget work (the install's reputation update) settle on the fakes.
    await new Promise((resolve) => setImmediate(resolve));
    return result;
  } finally {
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

const versioning = () => import("../services/versioning.js");

test("a version snapshot stores the agent's kind and a deep copy of its settings", async () => {
  const world = makeVersionWorld({ agentKind: "task", kindConfig: copy(FORM) });
  await withPrisma(world.models, async () => {
    const { createAgentVersion } = await versioning();
    await createAgentVersion(SCOPE, "user_1", { changeLog: "the form" });
  });

  const written = world.state.versionCreates[0]!;
  assert.equal(written.agentKind, "task");
  assert.deepEqual(written.kindConfig, FORM);
  assert.ok(sharesNothing(world.state.agent.kindConfig, written.kindConfig));

  // Editing the agent afterwards does not reach into the snapshot.
  world.state.agent.kindConfig.task.fields[0].label = "Changed";
  world.state.agent.kindConfig.task.fields.push({ key: "x", label: "X", type: "short_text", required: false });
  assert.deepEqual(written.kindConfig, FORM);
});

test("a snapshot of an agent with no settings stores a database null, and an unreadable kind is a conversation", async () => {
  const plain = makeVersionWorld({ agentKind: "scheduled", kindConfig: null });
  await withPrisma(plain.models, async () => {
    const { createAgentVersion } = await versioning();
    await createAgentVersion(SCOPE, "user_1", {});
  });
  assert.equal(plain.state.versionCreates[0]!.agentKind, "scheduled");
  assert.equal(plain.state.versionCreates[0]!.kindConfig, Prisma.DbNull);

  const odd = makeVersionWorld({ agentKind: "something_else", kindConfig: { task: { fields: "nope" }, extra: 1 } });
  await withPrisma(odd.models, async () => {
    const { createAgentVersion } = await versioning();
    await createAgentVersion(SCOPE, "user_1", {});
  });
  assert.equal(odd.state.versionCreates[0]!.agentKind, "conversation");
  // A form that does not read cleanly and a key nobody knows are not carried.
  assert.equal(odd.state.versionCreates[0]!.kindConfig, Prisma.DbNull);
});

test("a rollback restores the version's kind and a deep copy of its settings", async () => {
  const world = makeVersionWorld(
    { agentKind: "conversation", kindConfig: { scheduled: { prompt: "Something newer." } }, version: "1.1.0" },
    [
      { version: "1.0.0", agentKind: "task", kindConfig: copy(FORM) },
      { version: "1.1.0", agentKind: "conversation", kindConfig: { scheduled: { prompt: "Something newer." } }, isLatest: true },
    ],
  );
  const target = world.state.versions[0]!;
  await withPrisma(world.models, async () => {
    const { rollbackToVersion } = await versioning();
    await rollbackToVersion(SCOPE, "1.0.0", "user_1");
  });

  const update = world.state.agentUpdates[0]!;
  assert.equal(update.agentKind, "task");
  assert.deepEqual(update.kindConfig, FORM);
  assert.ok(sharesNothing(target.kindConfig, update.kindConfig));
  assert.equal(world.state.agent.agentKind, "task");
  assert.deepEqual(world.state.agent.kindConfig, FORM);

  // The version that records the rollback carries the restored kind too.
  const recorded = world.state.versionCreates[0]!;
  assert.deepEqual(recorded.tags, ["rollback"]);
  assert.equal(recorded.agentKind, "task");
  assert.deepEqual(recorded.kindConfig, FORM);
  // And the version rolled back to is left as it was.
  assert.deepEqual(target.kindConfig, FORM);
});

test("a rollback to a version with a kind and no settings clears the agent's settings", async () => {
  const world = makeVersionWorld({ agentKind: "task", kindConfig: copy(FORM), version: "1.1.0" }, [
    { version: "1.0.0", agentKind: "conversation", kindConfig: null },
    { version: "1.1.0", agentKind: "task", kindConfig: copy(FORM), isLatest: true },
  ]);
  await withPrisma(world.models, async () => {
    const { rollbackToVersion } = await versioning();
    await rollbackToVersion(SCOPE, "1.0.0", "user_1");
  });
  assert.equal(world.state.agentUpdates[0]!.agentKind, "conversation");
  assert.equal(world.state.agentUpdates[0]!.kindConfig, Prisma.DbNull);
  assert.equal(world.state.agent.kindConfig, null);
});

test("a version from before agents had a kind rolls back to a conversation and keeps the settings the agent has", async () => {
  const world = makeVersionWorld({ agentKind: "task", kindConfig: copy(FORM), version: "1.1.0" }, [
    // No agentKind and no kindConfig: the columns are null on an old row.
    { version: "1.0.0", agentKind: null, kindConfig: null },
    { version: "1.1.0", agentKind: "task", kindConfig: copy(FORM), isLatest: true },
  ]);
  await withPrisma(world.models, async () => {
    const { rollbackToVersion } = await versioning();
    await rollbackToVersion(SCOPE, "1.0.0", "user_1");
  });

  const update = world.state.agentUpdates[0]!;
  assert.equal(update.agentKind, "conversation");
  assert.ok(!("kindConfig" in update), "an old version recorded no settings, so none are written");
  assert.equal(world.state.agent.agentKind, "conversation");
  // Changing kind loses nothing: the form is still there if the kind is set back.
  assert.deepEqual(world.state.agent.kindConfig, FORM);
  assert.equal(world.state.versionCreates[0]!.agentKind, "conversation");
});

// The same rule a change of kind follows: a rollback that takes the agent
// away from "scheduled" turns its own schedule off, in its transaction.

/** scheduled_tasks rows over a version world, as setOwnScheduleEnabled reads and switches them. */
function withTasks(world: ReturnType<typeof makeVersionWorld>, tasks: Row[], opts: { writeFails?: boolean } = {}) {
  const log = { reads: [] as Row[], writes: [] as Row[], open: 0, transactions: 0 };
  world.models.scheduledTask = {
    findMany: async ({ where, take }: Row) => {
      log.reads.push({ where, inTransaction: log.open > 0 });
      return tasks
        .filter((t) => t.orgId === where.orgId && t.agentId === where.agentId && t.taskType === where.taskType)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        .slice(0, take)
        .map((t) => ({ ...t }));
    },
    updateMany: async ({ where, data }: Row) => {
      log.writes.push({ where, data, inTransaction: log.open > 0 });
      if (opts.writeFails) throw new Error("the database went away");
      const hit = tasks.filter(
        (t) => t.id === where.id && t.orgId === where.orgId && t.agentId === where.agentId && t.isEnabled === where.isEnabled,
      );
      for (const t of hit) Object.assign(t, data);
      return { count: hit.length };
    },
  };
  // No listing sells use of this agent: a rollback to scheduled or to a
  // graph reads that before it writes (versioningOnSale.unit.test.ts).
  world.models.agentListing = { findFirst: async () => null };
  // One transaction: what it changed on the agent is undone when it throws.
  world.models.$transaction = async (fn: (tx: Row) => Promise<unknown>) => {
    log.transactions += 1;
    const before = { agent: { ...world.state.agent }, versions: world.state.versions.length };
    log.open += 1;
    try {
      return await fn(world.models);
    } catch (err) {
      Object.assign(world.state.agent, before.agent);
      world.state.versions.length = before.versions;
      throw err;
    } finally {
      log.open -= 1;
    }
  };
  return log;
}

const ownTask = (over: Row = {}): Row => ({
  id: "task_own",
  orgId: ORG,
  agentId: AGENT_ID,
  taskType: "agent_run",
  isEnabled: true,
  status: "active",
  createdAt: new Date("2026-10-01T00:00:00Z"),
  ...over,
});

const SCHEDULED_NOW = { agentKind: "scheduled", kindConfig: { scheduled: { prompt: "Report." } }, version: "1.1.0" };

test("a rollback that takes the agent away from scheduled turns its own schedule off in the same transaction and says so", async () => {
  // A version that recorded another kind, and one from before agents had a kind.
  for (const [recorded, restored] of [
    ["task", "task"],
    ["conversation", "conversation"],
    [null, "conversation"],
  ] as const) {
    const world = makeVersionWorld(SCHEDULED_NOW, [
      { version: "1.0.0", agentKind: recorded, kindConfig: null },
      { ...SCHEDULED_NOW, isLatest: true },
    ]);
    const tasks = [
      ownTask(),
      ownTask({ id: "task_later", createdAt: new Date("2026-10-05T00:00:00Z") }),
      ownTask({ id: "task_other_agent", agentId: "agent_2" }),
    ];
    const log = withTasks(world, tasks);
    const answer = (await withPrisma(world.models, async () => {
      const { rollbackToVersion } = await versioning();
      return rollbackToVersion(SCOPE, "1.0.0", "user_1");
    })) as Row;

    assert.equal(world.state.agent.agentKind, restored);
    assert.equal(answer.schedulePaused, true, String(recorded));
    // Still the version that records the rollback, as before.
    assert.deepEqual(answer.tags, ["rollback"]);
    assert.equal(answer.agentKind, restored);
    assert.deepEqual(log.writes, [
      {
        where: { id: "task_own", orgId: ORG, agentId: AGENT_ID, isEnabled: true },
        data: { isEnabled: false, status: "paused" },
        inTransaction: true,
      },
    ]);
    assert.equal(log.transactions, 1);
    // The task stays, switched off; its other tasks and another agent's are untouched.
    assert.deepEqual(
      tasks.map((t) => [t.id, t.isEnabled]),
      [
        ["task_own", false],
        ["task_later", true],
        ["task_other_agent", true],
      ],
    );
  }
});

test("a rollback that keeps or restores scheduled touches no schedule, and one with nothing to turn off is not an error", async () => {
  // Stays scheduled: the schedule is left on.
  const stays = makeVersionWorld(SCHEDULED_NOW, [
    { version: "1.0.0", agentKind: "scheduled", kindConfig: null },
    { ...SCHEDULED_NOW, isLatest: true },
  ]);
  const staysTasks = [ownTask()];
  const staysLog = withTasks(stays, staysTasks);
  const kept = (await withPrisma(stays.models, async () => {
    const { rollbackToVersion } = await versioning();
    return rollbackToVersion(SCOPE, "1.0.0", "user_1");
  })) as Row;
  assert.equal("schedulePaused" in kept, false);
  assert.deepEqual([staysLog.reads, staysLog.writes], [[], []]);
  assert.equal(staysTasks[0]!.isEnabled, true);

  // Back to scheduled from another kind: nothing is turned on.
  const back = makeVersionWorld({ agentKind: "task", version: "1.1.0" }, [
    { version: "1.0.0", agentKind: "scheduled", kindConfig: null },
    { version: "1.1.0", agentKind: "task", kindConfig: null, isLatest: true },
  ]);
  const backTasks = [ownTask({ isEnabled: false, status: "paused" })];
  const backLog = withTasks(back, backTasks);
  const restored = (await withPrisma(back.models, async () => {
    const { rollbackToVersion } = await versioning();
    return rollbackToVersion(SCOPE, "1.0.0", "user_1");
  })) as Row;
  assert.equal(back.state.agent.agentKind, "scheduled");
  assert.equal("schedulePaused" in restored, false);
  assert.deepEqual([backLog.reads, backLog.writes], [[], []]);
  assert.equal(backTasks[0]!.isEnabled, false);

  // An agent that was never scheduled: a task made for it on the Scheduler page keeps running.
  const never = makeVersionWorld({ agentKind: "task", version: "1.1.0" }, [
    { version: "1.0.0", agentKind: "conversation", kindConfig: null },
    { version: "1.1.0", agentKind: "task", kindConfig: null, isLatest: true },
  ]);
  const neverTasks = [ownTask()];
  const neverLog = withTasks(never, neverTasks);
  await withPrisma(never.models, async () => {
    const { rollbackToVersion } = await versioning();
    await rollbackToVersion(SCOPE, "1.0.0", "user_1");
  });
  assert.deepEqual([neverLog.reads, neverLog.writes], [[], []]);
  assert.equal(neverTasks[0]!.isEnabled, true);

  // Leaving scheduled with no schedule, or one already off.
  for (const tasks of [[], [ownTask({ isEnabled: false, status: "paused" })]]) {
    const world = makeVersionWorld(SCHEDULED_NOW, [
      { version: "1.0.0", agentKind: "task", kindConfig: null },
      { ...SCHEDULED_NOW, isLatest: true },
    ]);
    const log = withTasks(world, tasks);
    const answer = (await withPrisma(world.models, async () => {
      const { rollbackToVersion } = await versioning();
      return rollbackToVersion(SCOPE, "1.0.0", "user_1");
    })) as Row;
    assert.equal(world.state.agent.agentKind, "task");
    assert.equal("schedulePaused" in answer, false);
    assert.deepEqual(log.writes, []);
  }
});

test("when the schedule cannot be turned off the rollback does not happen", async () => {
  const world = makeVersionWorld(SCHEDULED_NOW, [
    { version: "1.0.0", agentKind: "task", kindConfig: null },
    { ...SCHEDULED_NOW, isLatest: true },
  ]);
  const tasks = [ownTask()];
  withTasks(world, tasks, { writeFails: true });
  await withPrisma(world.models, async () => {
    const { rollbackToVersion } = await versioning();
    await assert.rejects(rollbackToVersion(SCOPE, "1.0.0", "user_1"), /database went away/);
  });
  assert.equal(world.state.agent.agentKind, "scheduled");
  assert.equal(world.state.versions.length, 2, "no version records a rollback that was undone");
  assert.equal(tasks[0]!.isEnabled, true);
});

test("the diff between two versions reports a changed kind and changed settings", async () => {
  const changedForm = copy(FORM);
  changedForm.task!.fields[0]!.label = "Your code";
  const world = makeVersionWorld({}, [
    { version: "1.0.0", agentKind: null, kindConfig: null },
    { version: "1.1.0", agentKind: "task", kindConfig: copy(FORM) },
    { version: "1.2.0", agentKind: "task", kindConfig: changedForm },
    { version: "1.3.0", agentKind: "scheduled", kindConfig: changedForm },
    { version: "1.4.0", agentKind: "scheduled", kindConfig: copy(changedForm) },
  ]);
  const diff = async (from: string, to: string) => {
    await withPrisma(world.models, async () => {
      const { compareVersions } = await versioning();
      await compareVersions(SCOPE, from, to);
    });
    return world.state.diffs.at(-1)!;
  };

  // From a version with no kind recorded: the kind was added, the settings changed.
  const first = await diff("1.0.0", "1.1.0");
  assert.deepEqual(first.changes.agentKind, { from: null, to: "task" });
  assert.deepEqual(first.changes.kindConfig, { from: null, to: FORM });
  assert.ok(first.addedFields.includes("agentKind"));
  assert.ok(first.modifiedFields.includes("kindConfig"));

  // Only the form changed.
  const second = await diff("1.1.0", "1.2.0");
  assert.ok(!("agentKind" in second.changes));
  assert.deepEqual(second.changes.kindConfig, { from: FORM, to: changedForm });
  assert.deepEqual(second.modifiedFields, ["kindConfig"]);

  // Only the kind changed.
  const third = await diff("1.2.0", "1.3.0");
  assert.deepEqual(third.changes, { agentKind: { from: "task", to: "scheduled" } });
  assert.deepEqual(third.modifiedFields, ["agentKind"]);

  // Nothing changed: equal settings in separate objects are not a change.
  const fourth = await diff("1.3.0", "1.4.0");
  assert.deepEqual(fourth.changes, {});
  assert.deepEqual(fourth.modifiedFields, []);
});

// ============================================
// The buyer's copy
// ============================================

test("the copy's kind and settings: the original's kind, a deep copy, nothing unknown", () => {
  const source = { agentKind: "task", kindConfig: copy(FORM) };
  const cloned = cloneAgentKind(source);
  assert.equal(cloned.agentKind, "task");
  assert.deepEqual(cloned.kindConfig, FORM);
  assert.ok(sharesNothing(source.kindConfig, cloned.kindConfig));

  assert.deepEqual(cloneAgentKind({ agentKind: "scheduled", kindConfig: null }), {
    agentKind: "scheduled",
    kindConfig: null,
  });
  // A row from before the column existed, or one that does not read.
  assert.deepEqual(cloneAgentKind({}), { agentKind: "conversation", kindConfig: null });
  assert.deepEqual(cloneAgentKind({ agentKind: "chat", kindConfig: "text" }), {
    agentKind: "conversation",
    kindConfig: null,
  });
  // Only the known settings travel: a handle or a delivery place slipped
  // into the JSON would stay with the publisher.
  const withExtras = cloneAgentKind({
    agentKind: "scheduled",
    kindConfig: {
      scheduled: { schedule: { cronExpression: "0 9 * * *" }, prompt: "Go.", deliverTo: ["chan_1"] },
      publicHandle: "acme",
    },
  });
  assert.deepEqual(withExtras.kindConfig, { scheduled: { schedule: { cronExpression: "0 9 * * *" }, prompt: "Go." } });
});

const LISTING_ID = "lst_1";
const BUYER = "org_buyer";

function makeInstallWorld(sourceAgent: Row) {
  const state = {
    listing: {
      id: LISTING_ID,
      title: "Code Reviewer",
      publisherId: "org_pub",
      status: "published",
      pricingModel: "free",
      monthlyPriceCents: null,
      pricePerRequestCents: null,
      totalInstalls: 0,
      activeInstalls: 0,
      agent: {
        id: "agent_src",
        name: "Reviewer",
        slug: "reviewer",
        description: "Reviews code.",
        framework: "custom",
        systemPrompt: "Review code.",
        tools: [],
        modelConfig: {},
        sourceType: "inline",
        sourceUrl: null,
        sourceCode: null,
        version: "1.0.0",
        tags: [],
        entrypoint: "chat",
        graph: null,
        ...sourceAgent,
      },
    } as Row,
    installs: [] as Row[],
    /** The `data` of every agent.create, as the service passed it. */
    agentCreates: [] as Row[],
  };
  const models: Row = {
    agentListing: {
      findUnique: async () => state.listing,
      update: async () => state.listing,
      aggregate: async () => ({ _count: { id: 1 }, _sum: { totalInstalls: 1 } }),
    },
    agentInstall: {
      findUnique: async () => null,
      create: async ({ data }: Row) => {
        const row = { id: "ins_1", uninstalledAt: null, ...data };
        state.installs.push(row);
        return row;
      },
    },
    agentSubscription: { findUnique: async () => null },
    agentToken: { findUnique: async () => null },
    agent: {
      findFirst: async () => null,
      create: async ({ data }: Row) => {
        state.agentCreates.push(data);
        return { id: "agent_copy", ...data };
      },
    },
    // No profile row: the reputation recalculation stops at its first read.
    publisherProfile: { findUnique: async () => null, update: async () => ({}) },
  };
  models.$transaction = async (fn: (tx: Row) => Promise<unknown>) => fn(models);
  return { state, models };
}

test("an install copies the agent's kind and a deep copy of its settings into the buyer's agent", async () => {
  const world = makeInstallWorld({ agentKind: "task", kindConfig: copy(FORM) });
  await withPrisma(world.models, async () => {
    const { installAgent } = await import("../services/marketplace.js");
    await installAgent(LISTING_ID, BUYER);
  });

  assert.equal(world.state.agentCreates.length, 1);
  const created = world.state.agentCreates[0]!;
  assert.equal(created.orgId, BUYER);
  assert.equal(created.agentKind, "task");
  assert.deepEqual(created.kindConfig, FORM);
  assert.ok(sharesNothing(world.state.listing.agent.kindConfig, created.kindConfig));

  // The publisher editing their form later does not change the buyer's copy.
  world.state.listing.agent.kindConfig.task.fields[0].label = "Changed";
  assert.deepEqual(created.kindConfig, FORM);
  // The rest of the install is as it was.
  assert.equal(created.entrypoint, "chat");
  assert.equal(created.isPublic, false);
  assert.equal(world.state.installs[0]!.clonedAgentId, "agent_copy");
});

test("an install of an agent with no settings writes a database null and keeps its kind", async () => {
  const scheduled = makeInstallWorld({ agentKind: "scheduled", kindConfig: null });
  await withPrisma(scheduled.models, async () => {
    const { installAgent } = await import("../services/marketplace.js");
    await installAgent(LISTING_ID, BUYER);
  });
  assert.equal(scheduled.state.agentCreates[0]!.agentKind, "scheduled");
  assert.equal(scheduled.state.agentCreates[0]!.kindConfig, Prisma.DbNull);

  // A task agent whose row holds no form: the copy holds none either, and
  // readers fall back to the default form the way they do for the original.
  const bare = makeInstallWorld({ agentKind: "task", kindConfig: null });
  await withPrisma(bare.models, async () => {
    const { installAgent } = await import("../services/marketplace.js");
    await installAgent(LISTING_ID, BUYER);
  });
  assert.equal(bare.state.agentCreates[0]!.agentKind, "task");
  assert.equal(bare.state.agentCreates[0]!.kindConfig, Prisma.DbNull);
  assert.equal(DEFAULT_TASK_FIELDS.length, 1);
});

test("a listing says what kind of agent it is", async () => {
  const selects: Row[] = [];
  const listingOf = (agent: Row) => ({
    id: LISTING_ID,
    slug: "code-reviewer",
    title: "Code Reviewer",
    status: "published",
    totalRequests: null,
    agent: { id: "agent_src", framework: "custom", tags: [], ...agent },
  });
  let agent: Row = { agentKind: "task" };
  const models: Row = {
    agentListing: {
      findUnique: async (args: Row) => {
        selects.push(args.include.agent.select);
        return listingOf(agent);
      },
    },
  };
  await withPrisma(models, async () => {
    const { getListingBySlug, getListingById } = await import("../services/marketplace.js");
    assert.equal((await getListingBySlug("code-reviewer"))!.agent!.agentKind, "task");
    assert.equal((await getListingById(LISTING_ID))!.agent!.agentKind, "task");
    agent = { agentKind: "scheduled" };
    assert.equal((await getListingById(LISTING_ID))!.agent!.agentKind, "scheduled");
    // A value the column cannot hold today still reads as something drawable.
    agent = { agentKind: undefined };
    assert.equal((await getListingById(LISTING_ID))!.agent!.agentKind, "conversation");
  });
  assert.equal(selects.length, 4);
  for (const select of selects) assert.equal(select.agentKind, true);
});
