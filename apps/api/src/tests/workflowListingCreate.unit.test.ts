import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

import { installBigIntJsonSerializer } from "../lib/bigintJson.js";

// As the API does at start: a publish answers the listing's row, whose price is a bigint.
installBigIntJsonSerializer();

// A creator lists a workflow by run, through the routes and the real
// services over an in-memory database. What these pin: a workflow's listing
// has no agent, sells use and is per request; every refusal is told in its
// sentence and saves nothing; one workflow has one listing, by the read and
// by the database's index; publishing touches no agent and no page key; and
// an agent's listing is created as it always was.

const ORG = "org_creator";
const OTHER_ORG = "org_other";
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKFLOW_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const STEP_AGENT_ID = "55555555-5555-4555-8555-555555555555";
const LISTING_ID = "33333333-3333-4333-8333-333333333333";

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return cond.in.includes(v);
      if ("not" in cond) return v !== cond.not;
    }
    return v === cond;
  });
}

function makeWorld(opts: {
  workflow?: Row | null;
  steps?: Row[];
  /** A listing that already exists. */
  listing?: Row;
  /** Agent ids that are a buyer's copy from the marketplace. */
  copies?: string[];
  /** The agents of the creator's organization. */
  agents?: Row[];
} = {}) {
  const state = {
    workflows: (opts.workflow === null
      ? []
      : [
          {
            id: WORKFLOW_ID,
            orgId: ORG,
            name: "Weekly digest (internal name)",
            slug: "weekly-digest-internal",
            isEnabled: true,
            timeout: 600_000,
            inputSchema: {},
            ...(opts.workflow ?? {}),
          },
          // Another organization's workflow, as sellable as the first.
          { id: OTHER_WORKFLOW_ID, orgId: OTHER_ORG, name: "Theirs", slug: "theirs", isEnabled: true, timeout: 600_000, inputSchema: {} },
        ]) as Row[],
    steps: opts.steps ?? [{ stepType: "agent", agentId: STEP_AGENT_ID, fallbackAgentId: null, deploymentId: null }],
    agents: (opts.agents ?? [
      { id: STEP_AGENT_ID, orgId: ORG, name: "Step agent", modelConfig: {} },
      {
        id: AGENT_ID,
        orgId: ORG,
        name: "Analyst",
        slug: "analyst",
        framework: "custom",
        tags: [],
        entrypoint: "chat",
        agentKind: "conversation",
        isPublic: false,
        publicHandle: null,
        tools: [{ name: "http_request" }],
      },
    ]) as Row[],
    listings: (opts.listing
      ? [
          {
            id: LISTING_ID,
            agentId: null,
            orchestrationId: WORKFLOW_ID,
            publisherId: ORG,
            title: "Weekly Digest",
            slug: "weekly-digest",
            shortDescription: "Reads the week and writes it up.",
            category: "research",
            status: "draft",
            sells: "use",
            useAllowedTools: [],
            pricingModel: "per_request",
            pricePerRequestCents: 25n,
            monthlyPriceCents: null,
            totalInstalls: 0,
            ...opts.listing,
          },
        ]
      : []) as Row[],
    /** Every read or write of one agent as a listing's agent, and every touch of a page key. */
    agentCalls: [] as string[],
    /** The page keys of agents: none until an agent's listing that sells use is published. */
    pageKeys: [] as Row[],
    /** How many rows each compare-and-set of a listing moved, in order. */
    listingMoves: [] as number[],
    /** How many times the publisher's stats were brought up. */
    statsUpdates: 0,
    transactions: 0,
    /** Make the listing insert fail with this error. */
    createFails: null as unknown,
    /** Run just before the workflow is read inside a transaction. */
    beforeReadInTransaction: null as (() => void) | null,
    open: 0,
  };
  let seq = 0;

  const models: Row = {
    orchestration: {
      findFirst: async ({ where }: Row) => {
        if (state.open > 0 && state.beforeReadInTransaction) {
          const hook = state.beforeReadInTransaction;
          state.beforeReadInTransaction = null;
          hook();
        }
        const row = state.workflows.find((w) => matches(w, where));
        return row ? { ...row, steps: state.steps.map((s) => ({ ...s })) } : null;
      },
    },
    agent: {
      // The workflow's own agents, read to know they still exist.
      findMany: async ({ where }: Row) =>
        state.agents.filter((a) => where.id.in.includes(a.id) && a.orgId === where.orgId).map((a) => ({ ...a })),
      findFirst: async ({ where }: Row) => {
        state.agentCalls.push("agent.findFirst");
        const row = state.agents.find((a) => matches(a, where));
        return row ? { ...row } : null;
      },
      updateMany: async ({ where, data }: Row) => {
        state.agentCalls.push("agent.updateMany");
        const hit = state.agents.filter((a) => matches(a, where));
        for (const a of hit) Object.assign(a, data);
        return { count: hit.length };
      },
    },
    agentInstall: {
      findFirst: async ({ where }: Row) => {
        const ids: string[] = where.clonedAgentId?.in ?? [where.clonedAgentId];
        return ids.some((id) => (opts.copies ?? []).includes(id)) ? { id: "ins_copy" } : null;
      },
      findMany: async () => [],
    },
    agentSubscription: { findMany: async () => [] },
    listingPlan: { findMany: async () => [] },
    agentListing: {
      findUnique: async ({ where }: Row) => {
        const row = state.listings.find((l) => matches(l, where));
        return row ? { ...row } : null;
      },
      findFirst: async ({ where, include }: Row) => {
        const row = state.listings.find((l) => matches(l, where));
        if (!row) return null;
        return include?.agent ? { ...row, agent: state.agents.find((a) => a.id === row.agentId) ?? null } : { ...row };
      },
      findMany: async ({ include }: Row) =>
        state.listings.map((l) =>
          include?.agent ? { ...l, agent: state.agents.find((a) => a.id === l.agentId) ?? null } : { ...l },
        ),
      create: async ({ data, include }: Row) => {
        if (state.createFails) throw state.createFails;
        // The database's rule: an agent or a workflow, exactly one.
        assert.equal([data.agentId, data.orchestrationId].filter((id) => id != null).length, 1);
        const row = { id: seq++ === 0 ? LISTING_ID : `listing_${seq}`, agentId: null, orchestrationId: null, totalInstalls: 0, ...data };
        state.listings.push(row);
        return include?.agent ? { ...row, agent: state.agents.find((a) => a.id === row.agentId) ?? null } : { ...row };
      },
      update: async ({ where, data, include }: Row) => {
        const row = state.listings.find((l) => l.id === where.id)!;
        Object.assign(row, data);
        return include?.agent ? { ...row, agent: state.agents.find((a) => a.id === row.agentId) ?? null } : { ...row };
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = state.listings.filter((l) => matches(l, where));
        for (const l of hit) Object.assign(l, data);
        state.listingMoves.push(hit.length);
        return { count: hit.length };
      },
      aggregate: async () => ({ _count: { id: 1 }, _sum: { totalInstalls: 0 } }),
    },
    // The page keys, as an empty table behaves: one key for one agent's page.
    widgetKey: {
      findFirst: async ({ where }: Row) => {
        state.agentCalls.push("widgetKey.findFirst");
        const row = state.pageKeys.find((k) => matches(k, where));
        return row ? { ...row } : null;
      },
      createMany: async ({ data }: Row) => {
        state.agentCalls.push("widgetKey.createMany");
        let count = 0;
        for (const key of data as Row[]) {
          if (state.pageKeys.some((k) => k.pageOfAgentId === key.pageOfAgentId)) continue;
          state.pageKeys.push({ id: `key_${state.pageKeys.length + 1}`, revokedAt: null, ...key });
          count += 1;
        }
        return { count };
      },
      updateMany: async ({ where, data }: Row) => {
        state.agentCalls.push("widgetKey.updateMany");
        const hit = state.pageKeys.filter((k) => matches(k, where));
        for (const k of hit) Object.assign(k, data);
        return { count: hit.length };
      },
    },
    orgSubscription: { findUnique: async () => null },
    organization: { findUnique: async () => ({ name: "Creator Org" }) },
    publisherProfile: {
      findUnique: async () => ({ orgId: ORG }),
      update: async () => {
        state.statsUpdates += 1;
        return {};
      },
    },
  };

  models.$transaction = async (fn: (tx: Row) => Promise<unknown>) => {
    const snapshot = structuredClone(state.listings);
    state.transactions += 1;
    state.open += 1;
    try {
      return await fn(models);
    } catch (err) {
      // A failed transaction leaves nothing behind.
      state.listings.length = 0;
      state.listings.push(...snapshot);
      throw err;
    } finally {
      state.open -= 1;
    }
  };
  return { state, models };
}

type World = ReturnType<typeof makeWorld>;
type Svc = typeof import("../services/marketplace.js");

async function withWorld<T>(world: World, body: (svc: Svc) => Promise<T>): Promise<T> {
  const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Row };
  const svc = await import("../services/marketplace.js");
  const originals: Row = {};
  for (const [name, fake] of Object.entries(world.models)) {
    originals[name] = prisma[name];
    prisma[name] = fake;
  }
  try {
    return await body(svc);
  } finally {
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

async function call(world: World, method: "POST" | "PATCH" | "GET", url: string, payload?: Row, orgId = ORG) {
  return withWorld(world, async () => {
    const Fastify = (await import("fastify")).default;
    const sensible = await import("@fastify/sensible");
    const { marketplaceRoutes } = await import("../routes/marketplace.js");
    const app = Fastify();
    await app.register(sensible.default);
    app.decorateRequest("auth", null);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { auth: unknown }).auth = { userId: "u1", orgId, type: "jwt", role: "owner" };
    });
    await app.register(marketplaceRoutes);
    try {
      const res = await app.inject({ method, url, ...(payload !== undefined && { payload }) });
      return { status: res.statusCode, body: res.json() as Row };
    } finally {
      await app.close();
    }
  });
}

const BASE = {
  orchestrationId: WORKFLOW_ID,
  title: "Weekly Digest",
  shortDescription: "Reads the week and writes it up.",
  category: "research",
  pricingModel: "per_request",
  pricePerRequestCents: 25,
} as const;

const create = (world: World, over: Row = {}, orgId = ORG) => {
  const body: Row = { ...BASE, ...over };
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return call(world, "POST", "/listings", body, orgId);
};

// ============================================
// Listed and published
// ============================================

test("a workflow is listed per run: its row has no agent, sells use and is per request", async () => {
  const world = makeWorld();
  const res = await create(world);
  assert.equal(res.status, 201);
  const row = world.state.listings[0]!;
  assert.equal(row.agentId, null);
  assert.equal(row.orchestrationId, WORKFLOW_ID);
  assert.deepEqual(
    [row.sells, row.pricingModel, row.pricePerRequestCents, row.monthlyPriceCents, row.status, row.publisherId],
    ["use", "per_request", 25n, null, "draft", ORG],
  );
  assert.deepEqual(row.useAllowedTools, []);
  // The buyer's name for it is the listing's slug, made from the listing's title.
  assert.equal(row.slug, "weekly-digest");

  const { listing } = res.body;
  assert.equal(listing.productKind, "workflow");
  assert.equal(listing.agentId, null);
  assert.equal(listing.orchestrationId, WORKFLOW_ID);
  assert.equal(listing.unit, "run");
  assert.equal(listing.sells, "use");
  assert.equal(listing.pricePerRequestCents, 25);
  assert.equal(listing.agent, undefined);
  assert.deepEqual(listing.trial, { enabled: false });
  assert.deepEqual(listing.allowedTools, []);
  // Nothing of the workflow's own name or slug is in the answer.
  assert.doesNotMatch(JSON.stringify(res.body), /internal/);
  assert.deepEqual(world.state.agentCalls, []);
});

test("it is published in the same request when asked, and by its own publish, touching no agent and no page key", async () => {
  const atOnce = makeWorld();
  const res = await create(atOnce, { publish: true });
  assert.equal(res.status, 201);
  assert.equal(res.body.listing.status, "published");
  assert.equal(atOnce.state.listings[0]!.status, "published");
  assert.ok(atOnce.state.listings[0]!.publishedAt instanceof Date);
  assert.deepEqual(atOnce.state.agentCalls, []);

  const later = makeWorld({ listing: {} });
  const published = await call(later, "POST", `/listings/${LISTING_ID}/publish`);
  assert.equal(published.status, 200);
  assert.equal(later.state.listings[0]!.status, "published");
  assert.equal(later.state.listings[0]!.agentId, null);
  assert.deepEqual(later.state.agentCalls, []);

  // Publishing it again changes nothing and is not an error.
  const before = later.state.listings[0]!.publishedAt;
  const transactions = later.state.transactions;
  assert.equal((await call(later, "POST", `/listings/${LISTING_ID}/publish`)).status, 200);
  assert.equal(later.state.listings[0]!.publishedAt, before);
  assert.equal(later.state.transactions, transactions);

  const byEdit = makeWorld({ listing: {} });
  const edited = await call(byEdit, "PATCH", `/listings/${LISTING_ID}`, { publish: true });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.listing.status, "published");
  assert.deepEqual(byEdit.state.agentCalls, []);
});

test("of two publishes at once one moves the listing and the other finds nothing to do", async () => {
  const world = makeWorld({ listing: {} });
  // What the row's publishedAt was set to, each time it was written.
  const stamps: unknown[] = [];
  const updateMany = world.models.agentListing.updateMany;
  world.models.agentListing.updateMany = async (args: Row) => {
    const moved = await updateMany(args);
    if (moved.count > 0) stamps.push(args.data.publishedAt);
    return moved;
  };
  await withWorld(world, async ({ publishListing }) => {
    await Promise.all([publishListing(LISTING_ID, ORG), publishListing(LISTING_ID, ORG)]);
  });
  assert.equal(world.state.listings[0]!.status, "published");
  // Both read the draft and both asked to move it: the row moved once.
  assert.deepEqual([...world.state.listingMoves].sort(), [0, 1]);
  assert.equal(stamps.length, 1);
  assert.equal(world.state.listings[0]!.publishedAt, stamps[0]);
  // Only the one that moved it brought the publisher's stats up.
  assert.equal(world.state.statsUpdates, 1);
});

// ============================================
// Which product
// ============================================

test("a new listing names an agent or a workflow, exactly one", async () => {
  for (const ids of [{ agentId: AGENT_ID }, { orchestrationId: undefined }]) {
    const world = makeWorld();
    const res = await create(world, ids);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "validation_failed");
    assert.equal(res.body.message, "Send agentId or orchestrationId, one of them.");
    assert.equal(world.state.listings.length, 0);
    assert.deepEqual(world.state.agentCalls, []);
  }
  // The service says the same to a caller that is not the route.
  const world = makeWorld();
  await withWorld(world, async ({ createListing, ListingError }) => {
    for (const ids of [{ agentId: AGENT_ID, orchestrationId: WORKFLOW_ID }, {}]) {
      await assert.rejects(
        createListing(ORG, "Creator Org", { ...BASE, orchestrationId: undefined, ...ids }),
        (err: unknown) => err instanceof ListingError && err.status === 400 && err.message === "Send agentId or orchestrationId, one of them.",
      );
    }
  });
  assert.equal(world.state.listings.length, 0);
  assert.deepEqual(world.state.agentCalls, []);
});

test("a change of a listing names neither: what a listing sells is never changed by an edit", async () => {
  const world = makeWorld({ listing: {} });
  const res = await call(world, "PATCH", `/listings/${LISTING_ID}`, { orchestrationId: OTHER_WORKFLOW_ID, agentId: AGENT_ID, title: "Weekly Digest Two" });
  assert.equal(res.status, 200);
  const row = world.state.listings[0]!;
  assert.deepEqual([row.agentId, row.orchestrationId, row.title], [null, WORKFLOW_ID, "Weekly Digest Two"]);
});

// ============================================
// Refusals: the workflow
// ============================================

const refused = async (world: World, over: Row = {}, orgId = ORG) => {
  const res = await create(world, over, orgId);
  assert.equal(world.state.listings.length, 0, "nothing is saved");
  assert.deepEqual(world.state.agentCalls, []);
  return res;
};

test("a workflow of another organization is not found", async () => {
  const theirs = await refused(makeWorld(), { orchestrationId: OTHER_WORKFLOW_ID });
  assert.deepEqual([theirs.status, theirs.body.error, theirs.body.message], [404, "workflow_not_found", "Workflow not found."]);
  // And the creator's own is not found by anybody else.
  const mine = await refused(makeWorld(), {}, OTHER_ORG);
  assert.deepEqual([mine.status, mine.body.error], [404, "workflow_not_found"]);
  const none = await refused(makeWorld({ workflow: null }));
  assert.deepEqual([none.status, none.body.error], [404, "workflow_not_found"]);
});

test("a workflow that cannot be on sale is refused with the sentence of what is wrong", async () => {
  const cases: Array<[Parameters<typeof makeWorld>[0], string]> = [
    [{ workflow: { isEnabled: false } }, "This workflow is disabled. Enable it before selling it."],
    [{ steps: [] }, "This workflow has no steps yet."],
    [
      { copies: [STEP_AGENT_ID] },
      "This workflow uses an agent installed from the marketplace. A workflow can be sold only when every agent in it is one you built.",
    ],
    [
      { workflow: { timeout: 600_001 } },
      "A workflow on sale must finish within 10 minutes. Set its time limit to 10 minutes or less.",
    ],
    [{ agents: [] }, "This workflow has a step whose agent no longer exists. Choose another agent for that step."],
  ];
  for (const [opts, sentence] of cases) {
    const res = await refused(makeWorld(opts));
    assert.deepEqual([res.status, res.body.error, res.body.message], [409, "workflow_not_sellable", sentence]);
  }
  // Exactly 10 minutes is allowed.
  assert.equal((await create(makeWorld({ workflow: { timeout: 600_000 } }))).status, 201);
});

// ============================================
// Refusals: the terms
// ============================================

test("copies, every pricing model but per request, a price under the floor and allowed tools are each refused on their field", async () => {
  const cases: Array<[Row, string, string]> = [
    [{ sells: "copies" }, "sells", "A workflow is sold by use. Copies of a workflow are not sold."],
    [
      { pricingModel: "free", pricePerRequestCents: undefined },
      "pricingModel",
      "A workflow is sold per run. Add plans for buyers who want a number of uses for 30 days.",
    ],
    [
      { pricingModel: "monthly", pricePerRequestCents: undefined, monthlyPriceCents: 900 },
      "pricingModel",
      "A workflow is sold per run. Add plans for buyers who want a number of uses for 30 days.",
    ],
    [
      { pricingModel: "tokenized", pricePerRequestCents: undefined },
      "pricingModel",
      "A workflow is sold per run. Add plans for buyers who want a number of uses for 30 days.",
    ],
    [{ pricePerRequestCents: 4 }, "pricePerRequestCents", "The price per run must be at least $0.05."],
    [{ pricePerRequestCents: undefined }, "pricePerRequestCents", "The price per run must be at least $0.05."],
    [{ allowedTools: ["http_request"] }, "allowedTools", "A workflow listing has no tools to allow."],
  ];
  for (const [over, field, sentence] of cases) {
    const res = await refused(makeWorld(), over);
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.equal(res.body.error, "validation_failed");
    assert.equal(res.body.message, sentence);
    assert.deepEqual(res.body.fields, { [field]: sentence });
  }
  // The floor itself, and an empty list of tools, are allowed.
  assert.equal((await create(makeWorld(), { pricePerRequestCents: 5, allowedTools: [] })).status, 201);
});

test("a title with no letter or digit makes no slug, and is refused on the title", async () => {
  const res = await refused(makeWorld(), { title: "!!! ???" });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.fields, { title: "Give the listing a title with letters or numbers." });
});

test("a slug that is taken gets the next number, as an agent's listing does", async () => {
  const world = makeWorld({ listing: { id: "listing_other", orchestrationId: OTHER_WORKFLOW_ID, publisherId: OTHER_ORG } });
  const res = await create(world);
  assert.equal(res.status, 201);
  assert.equal(world.state.listings[1]!.slug, "weekly-digest-1");
});

// ============================================
// One listing for one workflow
// ============================================

test("a second listing for the same workflow is refused by the read", async () => {
  const world = makeWorld({ listing: {} });
  const res = await create(world, { title: "Another Name" });
  assert.deepEqual([res.status, res.body.error, res.body.message], [409, "listing_exists", "This workflow already has a listing."]);
  assert.equal(world.state.listings.length, 1);
});

test("and by the database's index when two requests arrive at once, told apart from an agent's and from a taken name", async () => {
  const violation = (target: unknown) =>
    Object.assign(new Error("Unique constraint failed"), { code: "P2002", clientVersion: "5.22.0", meta: { target } });

  for (const target of [["orchestration_id"], "agent_listings_orchestration_id_key", undefined]) {
    const world = makeWorld();
    world.state.createFails = violation(target);
    const res = await refused(world);
    assert.deepEqual([res.status, res.body.error, res.body.message], [409, "listing_exists", "This workflow already has a listing."]);
  }

  const name = makeWorld();
  name.state.createFails = violation(["slug"]);
  const taken = await refused(name);
  assert.deepEqual([taken.status, taken.body.error], [409, "listing_name_taken"]);

  // An agent's listing that loses the same race is told of the agent, as before.
  for (const target of [["agent_id"], undefined]) {
    const agents = makeWorld();
    agents.state.createFails = violation(target);
    const res = await call(agents, "POST", "/listings", { ...BASE, orchestrationId: undefined, agentId: AGENT_ID, pricingModel: "free", pricePerRequestCents: undefined });
    assert.deepEqual([res.status, res.body.error, res.body.message], [
      409,
      "listing_exists",
      "This agent already has a listing. Edit that listing instead.",
    ]);
  }
});

test("a database failure while saving a workflow's listing is never answered in the database's words", async () => {
  const world = makeWorld();
  world.state.createFails = Object.assign(
    new Error("\nInvalid `prisma.agentListing.create()` invocation\n\nForeign key constraint failed on the field: `agent_listings_orchestration_id_fkey`"),
    { code: "P2003", clientVersion: "5.22.0" },
  );
  const res = await refused(world);
  assert.equal(res.status, 400);
  assert.equal(res.body.message, "The listing could not be saved. Please try again.");
  assert.doesNotMatch(JSON.stringify(res.body), /prisma|constraint|fkey|orchestration/i);

  // A CHECK the database holds (a row with no product, or a workflow that sells copies).
  const check = makeWorld();
  check.state.createFails = Object.assign(
    new Error('new row for relation "agent_listings" violates check constraint "agent_listings_agent_or_workflow_check"'),
    { clientVersion: "5.22.0" },
  );
  const violated = await refused(check);
  assert.equal(violated.body.message, "The listing could not be saved. Please try again.");
  assert.doesNotMatch(JSON.stringify(violated.body), /check|constraint|agent_listings/i);
});

// ============================================
// Changing and publishing a listing that exists
// ============================================

const patch = (world: World, body: Row) => call(world, "PATCH", `/listings/${LISTING_ID}`, body);

test("the price per run and the words of a workflow's listing are changed; what it sells and how are not", async () => {
  const world = makeWorld({ listing: { status: "published" } });
  const saved = await patch(world, { pricePerRequestCents: 40, shortDescription: "A new line that says what it does." });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.listing.pricePerRequestCents, 40);
  assert.equal(saved.body.listing.productKind, "workflow");
  assert.equal(world.state.listings[0]!.pricePerRequestCents, 40n);

  const before = structuredClone(world.state.listings[0]);
  const cases: Array<[Row, string, string]> = [
    [{ sells: "copies" }, "sells", "A workflow is sold by use. Copies of a workflow are not sold."],
    [
      { pricingModel: "monthly", monthlyPriceCents: 900 },
      "pricingModel",
      "A workflow is sold per run. Add plans for buyers who want a number of uses for 30 days.",
    ],
    [{ pricingModel: "free" }, "pricingModel", "A workflow is sold per run. Add plans for buyers who want a number of uses for 30 days."],
    [{ pricingModel: "tokenized" }, "pricingModel", "A workflow is sold per run. Add plans for buyers who want a number of uses for 30 days."],
    [{ pricePerRequestCents: 4 }, "pricePerRequestCents", "The price per run must be at least $0.05."],
    [{ allowedTools: ["http_request"] }, "allowedTools", "A workflow listing has no tools to allow."],
  ];
  for (const [body, field, sentence] of cases) {
    const res = await patch(world, { ...body, title: "Must not be saved" });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(res.body.fields, { [field]: sentence });
    assert.deepEqual(world.state.listings[0], before);
  }
  assert.deepEqual(world.state.agentCalls, []);
});

test("a change or a publish is refused while the workflow cannot be on sale, and nothing is saved", async () => {
  for (const status of ["draft", "published"]) {
    const world = makeWorld({ listing: { status }, workflow: { isEnabled: false } });
    const before = structuredClone(world.state.listings[0]);
    const res = await patch(world, { title: "A new title", publish: true });
    assert.deepEqual([res.status, res.body.error, res.body.message], [
      409,
      "workflow_not_sellable",
      "This workflow is disabled. Enable it before selling it.",
    ]);
    assert.deepEqual(world.state.listings[0], before);
  }
  const draft = makeWorld({ listing: {}, steps: [] });
  const res = await call(draft, "POST", `/listings/${LISTING_ID}/publish`);
  assert.deepEqual([res.status, res.body.error, res.body.message], [409, "workflow_not_sellable", "This workflow has no steps yet."]);
  assert.equal(draft.state.listings[0]!.status, "draft");
  assert.equal(draft.state.transactions, 0);
});

test("the workflow is read again inside the transaction: one disabled after the first look is not published or edited", async () => {
  const disable = (world: World) => () => {
    world.state.workflows[0]!.isEnabled = false;
  };

  const edit = makeWorld({ listing: {} });
  edit.state.beforeReadInTransaction = disable(edit);
  const edited = await patch(edit, { title: "A new title", publish: true });
  assert.deepEqual([edited.status, edited.body.error], [409, "workflow_not_sellable"]);
  // The write that was made inside the transaction did not stay.
  assert.deepEqual([edit.state.listings[0]!.title, edit.state.listings[0]!.status], ["Weekly Digest", "draft"]);
  assert.equal(edit.state.transactions, 1);

  const publish = makeWorld({ listing: {} });
  publish.state.beforeReadInTransaction = disable(publish);
  const published = await call(publish, "POST", `/listings/${LISTING_ID}/publish`);
  assert.deepEqual([published.status, published.body.error], [409, "workflow_not_sellable"]);
  assert.equal(publish.state.listings[0]!.status, "draft");
  assert.equal(publish.state.transactions, 1);
});

test("terms that changed under a publish are refused as it goes on sale", async () => {
  // A draft whose row holds a price under the floor, however it got there:
  // the terms are judged on the row as it is read under the publish.
  const world = makeWorld({ listing: { pricePerRequestCents: 1n } });
  const res = await call(world, "POST", `/listings/${LISTING_ID}/publish`);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.fields, { pricePerRequestCents: "The price per run must be at least $0.05." });
  assert.equal(world.state.listings[0]!.status, "draft");
  // The compare-and-set had moved it inside the transaction, which did not commit.
  assert.equal(world.state.transactions, 1);
});

test("somebody else's workflow listing is not found by an edit or a publish", async () => {
  const world = makeWorld({ listing: {} });
  const before = structuredClone(world.state.listings[0]);
  const edited = await call(world, "PATCH", `/listings/${LISTING_ID}`, { title: "Taken over" }, OTHER_ORG);
  assert.equal(edited.status, 400);
  assert.equal(edited.body.message, "Listing not found or you don't have permission to edit");
  const published = await call(world, "POST", `/listings/${LISTING_ID}/publish`, undefined, OTHER_ORG);
  assert.equal(published.status, 400);
  assert.deepEqual(world.state.listings[0], before);
});

test("my listings says which listings sell a workflow, with the workflow's id for its publisher only", async () => {
  const world = makeWorld({ listing: { status: "published" } });
  const mine = await call(world, "GET", "/my-listings");
  assert.equal(mine.status, 200);
  const [listing] = mine.body.listings;
  assert.deepEqual(
    [listing.productKind, listing.agentId, listing.orchestrationId, listing.unit, listing.paused],
    ["workflow", null, WORKFLOW_ID, "run", null],
  );
  assert.deepEqual(listing.plans, []);
});

// ============================================
// An agent's listing is what it was
// ============================================

test("an agent's create, update and publish are what they were", async () => {
  const world = makeWorld();
  const created = await call(world, "POST", "/listings", {
    agentId: AGENT_ID,
    title: "Research Analyst",
    shortDescription: "Reads filings and answers questions.",
    category: "research",
    pricingModel: "per_request",
    pricePerRequestCents: 5,
    allowedTools: ["http_request"],
  });
  assert.equal(created.status, 201);
  const row = world.state.listings[0]!;
  assert.deepEqual(
    [row.agentId, row.orchestrationId, row.sells, row.pricingModel, row.pricePerRequestCents, row.slug],
    [AGENT_ID, null, "use", "per_request", 5n, "research-analyst"],
  );
  assert.deepEqual(row.useAllowedTools, ["http_request"]);
  assert.equal(created.body.listing.productKind, "agent");
  assert.equal(created.body.listing.orchestrationId, null);
  assert.equal(created.body.listing.unit, "message");
  assert.equal(created.body.listing.agent.agentKind, "conversation");
  // The agent was read, as it always was; no workflow rule was applied to it.
  assert.deepEqual(world.state.agentCalls, ["agent.findFirst"]);

  // The agent's own refusals are still the agent's.
  const floor = await call(makeWorld(), "POST", "/listings", {
    agentId: AGENT_ID,
    title: "Research Analyst",
    shortDescription: "Reads filings and answers questions.",
    category: "research",
    pricingModel: "per_request",
    pricePerRequestCents: 4,
  });
  assert.deepEqual(floor.body.fields, { pricePerRequestCents: "The price per message must be at least $0.05." });
  const noPrice = await call(makeWorld(), "POST", "/listings", {
    agentId: AGENT_ID,
    title: "Research Analyst",
    shortDescription: "Reads filings and answers questions.",
    category: "research",
    pricingModel: "per_request",
  });
  assert.equal(noPrice.status, 400);
  assert.equal(noPrice.body.message, "Price per request is required for per_request pricing model");

  // An edit of the agent's listing keeps the agent's rules: monthly is allowed.
  const edited = await call(world, "PATCH", `/listings/${LISTING_ID}`, { pricingModel: "monthly", monthlyPriceCents: 900 });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.listing.unit, "month");
  assert.equal(world.state.listings[0]!.pricingModel, "monthly");

  // Publishing it sets the agent's page: the agent and its page key are touched.
  world.state.agentCalls.length = 0;
  const published = await call(world, "POST", `/listings/${LISTING_ID}/publish`);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(world.state.listings[0]!.status, "published");
  assert.ok(world.state.listings[0]!.publishedAt instanceof Date);
  const agent = world.state.agents.find((a) => a.id === AGENT_ID)!;
  assert.equal(agent.isPublic, true);
  assert.equal(agent.publicHandle, "analyst");
  assert.ok(world.state.agentCalls.includes("agent.updateMany"));
  assert.ok(world.state.agentCalls.includes("widgetKey.createMany"));
  assert.equal(world.state.pageKeys.length, 1);
  assert.equal(world.state.pageKeys[0]!.pageOfAgentId, AGENT_ID);
});
