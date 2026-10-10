import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { ON_SALE_FOR_USE_MESSAGES as PATCH_MESSAGES } from "../routes/agents.js";
import { ON_SALE_FOR_USE_MESSAGES } from "../services/useListing.js";

// A version rollback must not put an agent whose use is on sale into a state
// PATCH /api/agents/:id refuses with 409 on_sale_for_use: answering through
// its graph, or running on its own while sold at a price per use. Buyers of
// such an agent could do nothing with it, and a monthly start would still
// charge.
//
// The real rollbackToVersion and its route run over an in-memory Prisma,
// patched in the way agentKindThreading.unit.test.ts does it.

type Row = Record<string, any>;

const ORG = "org_1";
const AGENT_ID = "agent_1";
const SCOPE = { agentId: AGENT_ID, orgId: ORG };

function makeWorld(agent: Row, versions: Row[], listing: Row | null) {
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
      version: "1.1.0",
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
      agentKind: "conversation",
      kindConfig: null,
      isLatest: false,
      ...v,
    })) as Row[],
    listingReads: [] as Row[],
    /** Whether each listing read ran inside the rollback's transaction. */
    listingReadsInTransaction: [] as boolean[],
    listingReadFails: false,
    open: 0,
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
        for (const [key, value] of Object.entries(data)) state.agent[key] = value;
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
        const row = { id: `ver_${state.versions.length + 1}`, ...data };
        state.versions.push(row);
        return row;
      },
    },
    agentVersionDiff: { findUnique: async () => null, create: async ({ data }: Row) => data },
    agentGraph: { upsert: async () => ({}) },
    user: { findUnique: async () => ({ displayName: "Tester", email: null }) },
    scheduledTask: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    // The published listing that sells use of the agent, as findUseListing reads it.
    agentListing: {
      findFirst: async ({ where }: Row) => {
        state.listingReads.push(where);
        state.listingReadsInTransaction.push(state.open > 0);
        if (state.listingReadFails) throw new Error("the database is away");
        if (!listing) return null;
        const hit =
          (where.agentId === undefined || where.agentId === listing.agentId) &&
          (where.status === undefined || where.status === listing.status) &&
          (where.sells === undefined || where.sells === listing.sells);
        return hit ? listing : null;
      },
      findUnique: async () => listing,
      findMany: async () => (listing ? [listing] : []),
    },
  };
  // One transaction: what it changed on the agent is undone when it throws.
  models.$transaction = async (fn: (tx: Row) => Promise<unknown>) => {
    const before = { ...state.agent };
    const versions = state.versions.length;
    state.open += 1;
    try {
      return await fn(models);
    } catch (err) {
      for (const key of Object.keys(state.agent)) delete state.agent[key];
      Object.assign(state.agent, before);
      state.versions.length = versions;
      throw err;
    } finally {
      state.open -= 1;
    }
  };
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
    return await body();
  } finally {
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

const listingOf = (over: Row = {}): Row => ({
  id: "listing_1",
  slug: "reviewer",
  title: "Reviewer",
  agentId: AGENT_ID,
  publisherId: ORG,
  status: "published",
  sells: "use",
  pricingModel: "monthly",
  pricePerRequestCents: null,
  monthlyPriceCents: 500n,
  useAllowedTools: [],
  ...over,
});

type World = ReturnType<typeof makeWorld>;

async function rollback(world: World): Promise<unknown> {
  return withPrisma(world.models, async () => {
    const { rollbackToVersion } = await import("../services/versioning.js");
    try {
      return await rollbackToVersion(SCOPE, "1.0.0", "user_1");
    } catch (err) {
      return err;
    }
  });
}

/** The same rollback through POST /agents/:agentId/versions/:version/rollback. */
async function rollbackRoute(world: World) {
  return withPrisma(world.models, async () => {
    const { versioningRoutes } = await import("../routes/versioning.js");
    const app = Fastify({ logger: false });
    app.decorateRequest("auth", null);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { auth: unknown }).auth = { userId: "user_1", orgId: ORG, type: "jwt", role: "member" };
    });
    await app.register(versioningRoutes, { prefix: "/api/versioning" });
    try {
      return await app.inject({
        method: "POST",
        url: `/api/versioning/agents/${AGENT_ID}/versions/1.0.0/rollback`,
        payload: {},
      });
    } finally {
      await app.close();
    }
  });
}

const toGraph = (listing: Row | null) =>
  makeWorld({ entrypoint: "chat" }, [
    { version: "1.0.0", entrypoint: "graph" },
    { version: "1.1.0", entrypoint: "chat", isLatest: true },
  ], listing);

const toScheduled = (listing: Row | null, from = "conversation") =>
  makeWorld({ agentKind: from }, [
    { version: "1.0.0", agentKind: "scheduled", kindConfig: { scheduled: { prompt: "Report." } } },
    { version: "1.1.0", agentKind: from, isLatest: true },
  ], listing);

const PER_USE = { pricingModel: "per_request", pricePerRequestCents: 25n, monthlyPriceCents: null };
const FREE = { pricingModel: "free", pricePerRequestCents: null, monthlyPriceCents: null };

test("the sentences are the ones an edit of the agent is refused with", () => {
  assert.equal(PATCH_MESSAGES, ON_SALE_FOR_USE_MESSAGES, "one constant, re-exported by the route");
  for (const sentence of Object.values(ON_SALE_FOR_USE_MESSAGES)) {
    assert.ok(!sentence.includes("\u2014"), sentence);
  }
});

test("a rollback does not turn an agent whose use is on sale into a graph, whatever the listing charges", async () => {
  for (const listing of [listingOf(), listingOf(PER_USE), listingOf(FREE)]) {
    const world = toGraph(listing);
    const answer = await rollback(world);
    assert.ok(answer instanceof Error, "the rollback is refused");
    assert.equal((answer as Error).name, "OnSaleForUseError");
    assert.equal((answer as Error).message, ON_SALE_FOR_USE_MESSAGES.graph);
    assert.equal(world.state.agent.entrypoint, "chat", "the agent on sale still answers from its instructions");
    assert.equal(world.state.agent.version, "1.1.0", "nothing was restored");
    assert.equal(world.state.versions.length, 2, "no version records a rollback that did not happen");
    // Read the way every reader of the use listing reads it, inside the transaction.
    assert.deepEqual(world.state.listingReads, [{ agentId: AGENT_ID, status: "published", sells: "use" }]);
    assert.deepEqual(world.state.listingReadsInTransaction, [true]);
  }
});

test("a rollback does not make an agent sold at a price per use run on its own", async () => {
  for (const from of ["conversation", "task"]) {
    const world = toScheduled(listingOf(PER_USE), from);
    const answer = await rollback(world);
    assert.ok(answer instanceof Error, "the rollback is refused");
    assert.equal((answer as Error).name, "OnSaleForUseError");
    assert.equal((answer as Error).message, ON_SALE_FOR_USE_MESSAGES.scheduled);
    assert.equal(world.state.agent.agentKind, from, "a price per use buys a use by a person");
    assert.equal(world.state.versions.length, 2);
    assert.deepEqual(world.state.listingReadsInTransaction, [true]);
  }
});

test("the route answers 409 on_sale_for_use with the sentence, and restores nothing", async () => {
  const graph = toGraph(listingOf());
  const refusedGraph = await rollbackRoute(graph);
  assert.equal(refusedGraph.statusCode, 409, refusedGraph.body);
  assert.deepEqual(refusedGraph.json(), { error: "on_sale_for_use", message: ON_SALE_FOR_USE_MESSAGES.graph });
  assert.equal(graph.state.agent.entrypoint, "chat");

  const scheduled = toScheduled(listingOf(PER_USE));
  const refusedScheduled = await rollbackRoute(scheduled);
  assert.equal(refusedScheduled.statusCode, 409, refusedScheduled.body);
  assert.deepEqual(refusedScheduled.json(), { error: "on_sale_for_use", message: ON_SALE_FOR_USE_MESSAGES.scheduled });
  assert.equal(scheduled.state.agent.agentKind, "conversation");

  // With no listing the same request goes through, as it always has.
  const open = toGraph(null);
  const done = await rollbackRoute(open);
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(open.state.agent.entrypoint, "graph");
});

test("with no use listing the same rollbacks go through and are recorded", async () => {
  // None at all, a draft, an archived one, and a listing that sells copies:
  // the fake answers the read the way the database would, by its where.
  for (const listing of [null, listingOf({ status: "draft" }), listingOf({ status: "archived" }), listingOf({ sells: "copies", ...PER_USE })]) {
    const graph = toGraph(listing);
    assert.ok(!((await rollback(graph)) instanceof Error));
    assert.equal(graph.state.agent.entrypoint, "graph");
    assert.equal(graph.state.versions.at(-1)!.changeLog, "Rolled back to version 1.0.0");

    const scheduled = toScheduled(listing);
    assert.ok(!((await rollback(scheduled)) instanceof Error));
    assert.equal(scheduled.state.agent.agentKind, "scheduled");
    assert.equal(scheduled.state.versions.length, 3);
  }
});

test("a monthly or free listing lets a rollback restore scheduled", async () => {
  for (const listing of [listingOf(), listingOf(FREE), listingOf({ ...PER_USE, pricePerRequestCents: 0n })]) {
    const world = toScheduled(listing);
    const answer = await rollback(world);
    assert.ok(!(answer instanceof Error), String(answer));
    assert.equal(world.state.agent.agentKind, "scheduled");
    assert.deepEqual(world.state.agent.kindConfig, { scheduled: { prompt: "Report." } });
    assert.equal(world.state.listingReads.length, 1);
  }
});

test("a listing that cannot be read fails the rollback: nothing is restored", async () => {
  for (const world of [toGraph(null), toScheduled(null)]) {
    world.state.listingReadFails = true;
    const answer = await rollback(world);
    assert.ok(answer instanceof Error);
    assert.equal((answer as Error).name, "SaleCheckUnavailableError");
    assert.doesNotMatch((answer as Error).message, /database/);
    assert.equal(world.state.agent.entrypoint, "chat");
    assert.equal(world.state.agent.agentKind, "conversation");
    assert.equal(world.state.versions.length, 2);
  }
});

test("the route says a failed check in its own words, never the database's", async () => {
  const world = toGraph(null);
  world.state.listingReadFails = true;
  const res = await rollbackRoute(world);
  assert.equal(res.statusCode, 503, res.body);
  const body = res.json();
  assert.equal(body.error, "sale_check_unavailable");
  assert.match(body.message, /nothing was restored/);
  assert.doesNotMatch(res.body, /database is away/);
  assert.equal(world.state.agent.entrypoint, "chat");
});

test("the listing is read only for the two switches: every other rollback reads no listing", async () => {
  const cases: World[] = [
    // Already a graph, and stays one.
    makeWorld({ entrypoint: "graph" }, [
      { version: "1.0.0", entrypoint: "graph" },
      { version: "1.1.0", entrypoint: "graph", isLatest: true },
    ], listingOf()),
    // Back to chat from a graph.
    makeWorld({ entrypoint: "graph" }, [
      { version: "1.0.0", entrypoint: "chat" },
      { version: "1.1.0", entrypoint: "graph", isLatest: true },
    ], listingOf()),
    // A version from before the entrypoint was recorded.
    makeWorld({ entrypoint: "chat" }, [
      { version: "1.0.0", entrypoint: null },
      { version: "1.1.0", entrypoint: "chat", isLatest: true },
    ], listingOf()),
    // Already scheduled, and stays so.
    makeWorld({ agentKind: "scheduled" }, [
      { version: "1.0.0", agentKind: "scheduled" },
      { version: "1.1.0", agentKind: "scheduled", isLatest: true },
    ], listingOf(PER_USE)),
    // Away from scheduled.
    makeWorld({ agentKind: "scheduled" }, [
      { version: "1.0.0", agentKind: "task" },
      { version: "1.1.0", agentKind: "scheduled", isLatest: true },
    ], listingOf(PER_USE)),
    // Between two kinds a person uses.
    makeWorld({ agentKind: "task" }, [
      { version: "1.0.0", agentKind: "conversation" },
      { version: "1.1.0", agentKind: "task", isLatest: true },
    ], listingOf(PER_USE)),
  ];
  for (const [index, world] of cases.entries()) {
    // A read would throw: these rollbacks must not depend on the listing.
    world.state.listingReadFails = true;
    const answer = await rollback(world);
    assert.ok(!(answer instanceof Error), `case ${index}: ${String(answer)}`);
    assert.deepEqual(world.state.listingReads, [], `case ${index}`);
    assert.equal(world.state.versions.length, 3, `case ${index}`);
  }
});

test("the schedule-off rule is unchanged: leaving scheduled still turns the agent's own schedule off", async () => {
  const world = makeWorld({ agentKind: "scheduled" }, [
    { version: "1.0.0", agentKind: "task" },
    { version: "1.1.0", agentKind: "scheduled", isLatest: true },
  ], listingOf());
  const task = { id: "task_own", orgId: ORG, agentId: AGENT_ID, taskType: "agent_run", isEnabled: true, status: "active" };
  world.models.scheduledTask = {
    findMany: async () => [{ ...task }],
    updateMany: async ({ data }: Row) => {
      Object.assign(task, data);
      return { count: 1 };
    },
  };
  const answer = (await rollback(world)) as Row;
  assert.ok(!(answer instanceof Error), String(answer));
  assert.equal(answer.schedulePaused, true);
  assert.equal(task.isEnabled, false);
  assert.equal(world.state.agent.agentKind, "task");
});
