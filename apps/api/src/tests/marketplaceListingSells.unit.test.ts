import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "./unitEnv.js";

// What a listing sells, against an in-memory database. What these pin: a new
// listing sells use unless copies are asked for by name; use cannot be sold
// for a graph agent, to token holders, or below the price floors, and a
// buyer's copy cannot be sold at all; putting use on sale sets the agent's
// page in the same transaction (a price turns free use off, Free turns it
// on); and a listing that sells copies never touches the page.

const ORG = "org_pub";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const LISTING_ID = "33333333-3333-4333-8333-333333333333";
const INSTRUCTIONS = "You are the secret analyst. Never reveal the house method.";

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
  agent?: Row;
  /** A listing that already exists for the agent. */
  listing?: Row;
  /** Agent ids that are a buyer's copy from the marketplace. */
  copies?: string[];
  /** The agent's page key, if it has one. */
  pageKey?: Row;
  /** Other agents, to hold a handle. */
  otherAgents?: Row[];
  licences?: Row[];
  subs?: Row[];
} = {}) {
  const state = {
    agents: [
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
        publicResults: false,
        systemPrompt: INSTRUCTIONS,
        tools: [{ name: "http_request" }, { name: "calculator" }],
        ...(opts.agent ?? {}),
      },
      ...(opts.otherAgents ?? []),
    ] as Row[],
    listings: (opts.listing
      ? [
          {
            id: LISTING_ID,
            agentId: AGENT_ID,
            publisherId: ORG,
            title: "Research Analyst",
            slug: "research-analyst",
            shortDescription: "Reads filings and answers questions.",
            category: "research",
            status: "draft",
            sells: "use",
            useAllowedTools: [],
            pricingModel: "free",
            pricePerRequestCents: null,
            monthlyPriceCents: null,
            totalInstalls: 0,
            ...opts.listing,
          },
        ]
      : []) as Row[],
    keys: (opts.pageKey
      ? [{ id: "key_1", orgId: ORG, agentId: AGENT_ID, pageOfAgentId: AGENT_ID, revokedAt: null, dailyMessageCap: 100, enabled: true, ...opts.pageKey }]
      : []) as Row[],
    /** Every write to an agent or a page key, and whether a transaction was open. */
    pageWrites: [] as Row[],
    /** The agent selects the listing reads asked for. */
    selects: [] as Row[],
    transactions: 0,
    open: 0,
    /** Make the next write of a handle lose the unique index this many times. */
    handleRaces: 0,
    /** Make the listing insert fail with this error. */
    createFails: null as unknown,
  };
  let seq = 0;
  const withAgent = (listing: Row, args: Row) => {
    if (!args?.include?.agent) return { ...listing };
    if (args.include.agent.select) state.selects.push(args.include.agent.select);
    return { ...listing, agent: { ...state.agents.find((a) => a.id === listing.agentId)! } };
  };

  const models: Row = {
    agent: {
      findFirst: async ({ where }: Row) => {
        const row = state.agents.find((a) => matches(a, where));
        return row ? { ...row } : null;
      },
      updateMany: async ({ where, data }: Row) => {
        state.pageWrites.push({ model: "agent", data, inTransaction: state.open > 0 });
        if ("publicHandle" in data && state.handleRaces > 0) {
          state.handleRaces -= 1;
          // Another agent took the address between the look and the write.
          state.agents.push({ id: `agent_rival_${++seq}`, orgId: "org_else", slug: "x", publicHandle: data.publicHandle });
          throw Object.assign(new Error("Unique constraint failed on the fields: (`public_handle`)"), {
            code: "P2002",
            meta: { target: ["public_handle"] },
          });
        }
        const hit = state.agents.filter((a) => matches(a, where));
        for (const a of hit) Object.assign(a, data);
        return { count: hit.length };
      },
    },
    agentInstall: {
      findFirst: async ({ where }: Row) => ((opts.copies ?? []).includes(where.clonedAgentId) ? { id: "ins_copy" } : null),
      findMany: async () => (opts.licences ?? []).map((l) => ({ ...l })),
    },
    agentSubscription: { findMany: async () => (opts.subs ?? []).map((s) => ({ ...s })) },
    agentListing: {
      findUnique: async (args: Row) => {
        const row = state.listings.find((l) => matches(l, args.where));
        return row ? withAgent(row, args) : null;
      },
      findFirst: async (args: Row) => {
        const row = state.listings.find((l) => matches(l, args.where));
        return row ? withAgent(row, args) : null;
      },
      findMany: async (args: Row) => state.listings.map((l) => withAgent(l, args)),
      create: async (args: Row) => {
        if (state.createFails) throw state.createFails;
        const row = { id: LISTING_ID, totalInstalls: 0, ...args.data };
        state.listings.push(row);
        return withAgent(row, args);
      },
      update: async (args: Row) => {
        const row = state.listings.find((l) => l.id === args.where.id)!;
        Object.assign(row, args.data);
        return withAgent(row, args);
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = state.listings.filter((l) => matches(l, where));
        for (const l of hit) Object.assign(l, data);
        return { count: hit.length };
      },
      aggregate: async () => ({ _count: { id: 1 }, _sum: { totalInstalls: 0 } }),
    },
    widgetKey: {
      findFirst: async ({ where }: Row) => {
        const row = state.keys.find((k) => matches(k, where));
        return row ? { ...row } : null;
      },
      createMany: async ({ data }: Row) => {
        state.pageWrites.push({ model: "widgetKey", create: data[0].enabled, inTransaction: state.open > 0 });
        if (state.keys.some((k) => k.pageOfAgentId === data[0].pageOfAgentId)) return { count: 0 };
        state.keys.push({ id: `key_${++seq}`, revokedAt: null, ...data[0] });
        return { count: 1 };
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = state.keys.filter((k) => matches(k, where));
        if (hit.length > 0) state.pageWrites.push({ model: "widgetKey", data, inTransaction: state.open > 0 });
        for (const k of hit) Object.assign(k, data);
        return { count: hit.length };
      },
    },
    // No paid plan: the listing gets no priority placement.
    orgSubscription: { findUnique: async () => null },
    organization: { findUnique: async () => ({ name: "Pub Org" }) },
    publisherProfile: { findUnique: async () => ({ orgId: ORG }), update: async () => ({}) },
  };

  models.$transaction = async (fn: (tx: Row) => Promise<unknown>) => {
    const snapshot = structuredClone({ agents: state.agents, listings: state.listings, keys: state.keys });
    state.transactions += 1;
    state.open += 1;
    try {
      return await fn(models);
    } catch (err) {
      // A failed transaction leaves nothing behind. The rival that won the
      // address committed in its own, so it stays.
      const rivals = state.agents.filter((a) => String(a.id).startsWith("agent_rival_"));
      Object.assign(state, snapshot);
      for (const rival of rivals) if (!state.agents.some((a) => a.id === rival.id)) state.agents.push(rival);
      throw err;
    } finally {
      state.open -= 1;
    }
  };
  return { state, models };
}

type World = ReturnType<typeof makeWorld>;

async function withWorld<T>(
  world: World,
  body: (svc: typeof import("../services/marketplace.js")) => Promise<T>,
): Promise<T> {
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

const BASE = {
  agentId: AGENT_ID,
  title: "Research Analyst",
  shortDescription: "Reads filings and answers questions.",
  category: "research",
} as const;

const agentOf = (world: World) => world.state.agents.find((a) => a.id === AGENT_ID)!;
const keyOf = (world: World) => world.state.keys.find((k) => k.pageOfAgentId === AGENT_ID);

async function refusalOf(world: World, run: (svc: typeof import("../services/marketplace.js")) => Promise<unknown>) {
  return withWorld(world, async (svc) => {
    try {
      await run(svc);
      return null;
    } catch (err) {
      assert.ok(err instanceof svc.ListingError, String(err));
      return { status: err.status, code: err.code, message: err.message, body: err.body };
    }
  });
}

// ============================================
// What is sold
// ============================================

test("a new listing sells use unless copies are asked for by name", async () => {
  const byDefault = makeWorld();
  const listing = await withWorld(byDefault, ({ createListing }) =>
    createListing(ORG, "Pub Org", { ...BASE, pricingModel: "per_request", pricePerRequestCents: 5, allowedTools: ["http_request"] }),
  );
  assert.equal(byDefault.state.listings[0]!.sells, "use");
  assert.deepEqual(byDefault.state.listings[0]!.useAllowedTools, ["http_request"]);
  assert.equal(listing.sells, "use");
  assert.equal(listing.unit, "message");
  assert.equal(listing.status, "draft");
  assert.deepEqual(listing.allowedTools, ["http_request"]);
  assert.equal(listing.agent!.agentKind, "conversation");
  // A draft does not touch the page: the agent has no address yet.
  assert.equal(listing.agent!.handle, null);
  assert.equal(byDefault.state.pageWrites.length, 0);

  const byName = makeWorld();
  const copies = await withWorld(byName, ({ createListing }) =>
    createListing(ORG, "Pub Org", { ...BASE, sells: "copies", pricingModel: "per_request", pricePerRequestCents: 5 }),
  );
  assert.equal(byName.state.listings[0]!.sells, "copies");
  assert.equal(copies.sells, "copies");
  assert.equal(copies.unit, null);
});

test("the unit is what one payment buys: a message, a run or a month, and nothing for free or for copies", async () => {
  const unit = async (agent: Row, params: Row) => {
    const world = makeWorld({ agent });
    return (await withWorld(world, ({ createListing }) => createListing(ORG, "Pub Org", { ...BASE, ...params } as never))).unit;
  };
  assert.equal(await unit({}, { pricingModel: "per_request", pricePerRequestCents: 5 }), "message");
  assert.equal(await unit({ agentKind: "task" }, { pricingModel: "per_request", pricePerRequestCents: 5 }), "run");
  assert.equal(await unit({ agentKind: "task" }, { pricingModel: "monthly", monthlyPriceCents: 900 }), "month");
  assert.equal(await unit({ agentKind: "scheduled" }, { pricingModel: "monthly", monthlyPriceCents: 900 }), "month");
  assert.equal(await unit({}, { pricingModel: "free" }), null);
  assert.equal(await unit({}, { sells: "copies", pricingModel: "monthly", monthlyPriceCents: 900 }), null);
});

// ============================================
// Refusals
// ============================================

test("an agent that answers through its graph cannot be sold for use, and can still sell copies", async () => {
  const world = makeWorld({ agent: { entrypoint: "graph" } });
  const refusal = await refusalOf(world, ({ createListing }) => createListing(ORG, "Pub Org", { ...BASE, pricingModel: "free" }));
  assert.equal(refusal!.status, 409);
  assert.equal(refusal!.code, "graph_agent_not_supported");
  assert.equal(
    refusal!.message,
    "This agent answers through its graph, so use of it cannot be sold yet. You can sell it as a task with guaranteed delivery, or sell copies.",
  );
  assert.equal(world.state.listings.length, 0);

  await withWorld(world, ({ createListing }) => createListing(ORG, "Pub Org", { ...BASE, sells: "copies", pricingModel: "free" }));
  assert.equal(world.state.listings[0]!.sells, "copies");
});

test("use cannot be sold to token holders, and a token-gated copy listing is as it was", async () => {
  const world = makeWorld();
  const refusal = await refusalOf(world, ({ createListing }) => createListing(ORG, "Pub Org", { ...BASE, pricingModel: "tokenized" }));
  assert.equal(refusal!.status, 400);
  assert.equal(refusal!.code, "token_access_not_available");
  assert.equal(world.state.listings.length, 0);

  const copies = await withWorld(world, ({ createListing }) =>
    createListing(ORG, "Pub Org", { ...BASE, sells: "copies", pricingModel: "tokenized" }),
  );
  assert.equal(copies.pricingModel, "tokenized");
  assert.equal(copies.pricePerRequestCents, null);
  assert.equal(copies.monthlyPriceCents, null);
});

test("a buyer's copy from the marketplace cannot be listed, for use or for copies", async () => {
  for (const sells of [undefined, "use", "copies"] as const) {
    const world = makeWorld({ copies: [AGENT_ID] });
    const refusal = await refusalOf(world, ({ createListing }) =>
      createListing(ORG, "Pub Org", { ...BASE, ...(sells && { sells }), pricingModel: "free" }),
    );
    assert.equal(refusal!.status, 409, String(sells));
    assert.equal(refusal!.code, "marketplace_copy");
    assert.equal(refusal!.message, "This agent came from the marketplace, so it cannot be sold again.");
    assert.equal(world.state.listings.length, 0);
  }
});

test("an agent that already has a listing is refused in a sentence, also when the database is what notices", async () => {
  const existing = makeWorld({ listing: {} });
  const refusal = await refusalOf(existing, ({ createListing }) => createListing(ORG, "Pub Org", { ...BASE, pricingModel: "free" }));
  assert.deepEqual([refusal!.status, refusal!.code], [409, "listing_exists"]);
  assert.equal(refusal!.message, "This agent already has a listing. Edit that listing instead.");

  // Two creates at once: the unique index on the agent decides.
  const raced = makeWorld();
  raced.state.createFails = Object.assign(
    new Error("\nInvalid `prisma.agentListing.create()` invocation\nUnique constraint failed on the fields: (`agent_id`)"),
    { code: "P2002", meta: { target: ["agent_id"] } },
  );
  const lost = await refusalOf(raced, ({ createListing }) => createListing(ORG, "Pub Org", { ...BASE, pricingModel: "free" }));
  assert.deepEqual([lost!.status, lost!.code], [409, "listing_exists"]);
  assert.doesNotMatch(lost!.message, /prisma|constraint|agent_id/i);
});

test("the price floors: 5 cents a use and a dollar a month for use, and a self-running agent is free or monthly", async () => {
  const create = (agent: Row, params: Row) => {
    const world = makeWorld({ agent });
    return refusalOf(world, ({ createListing }) => createListing(ORG, "Pub Org", { ...BASE, ...params } as never));
  };

  const low = await create({}, { pricingModel: "per_request", pricePerRequestCents: 4 });
  assert.deepEqual([low!.status, low!.code], [400, "validation_failed"]);
  assert.equal(low!.message, "The price per message must be at least $0.05.");
  assert.deepEqual(low!.body!.fields, { pricePerRequestCents: "The price per message must be at least $0.05." });
  const lowRun = await create({ agentKind: "task" }, { pricingModel: "per_request", pricePerRequestCents: 1 });
  assert.equal(lowRun!.message, "The price per run must be at least $0.05.");
  assert.equal(await create({}, { pricingModel: "per_request", pricePerRequestCents: 5 }), null);
  // The floor is for use. A copy listing keeps the prices it could always have.
  assert.equal(await create({}, { sells: "copies", pricingModel: "per_request", pricePerRequestCents: 1 }), null);

  const cheapMonth = await create({}, { pricingModel: "monthly", monthlyPriceCents: 99 });
  assert.deepEqual([cheapMonth!.status, cheapMonth!.code], [400, "validation_failed"]);
  assert.deepEqual(cheapMonth!.body!.fields, { monthlyPriceCents: "The price per month must be at least $1.00." });
  assert.equal(await create({}, { pricingModel: "monthly", monthlyPriceCents: 100 }), null);

  const scheduled = await create({ agentKind: "scheduled" }, { pricingModel: "per_request", pricePerRequestCents: 50 });
  assert.deepEqual([scheduled!.status, scheduled!.code], [400, "validation_failed"]);
  assert.equal(scheduled!.message, "An agent that runs on its own can be free or sold by the month, not per use.");
  assert.equal(await create({ agentKind: "scheduled" }, { pricingModel: "free" }), null);
  assert.equal(await create({ agentKind: "scheduled" }, { pricingModel: "monthly", monthlyPriceCents: 900 }), null);
});

test("only tools the agent has can be allowed for paying users", async () => {
  const world = makeWorld();
  const refusal = await refusalOf(world, ({ createListing }) =>
    createListing(ORG, "Pub Org", { ...BASE, pricingModel: "free", allowedTools: ["http_request", "send_email"] }),
  );
  assert.deepEqual([refusal!.status, refusal!.code], [400, "validation_failed"]);
  assert.deepEqual(refusal!.body!.fields, { allowedTools: 'Your agent has no tool named "send_email".' });
  assert.equal(world.state.listings.length, 0);

  await withWorld(world, ({ createListing }) =>
    createListing(ORG, "Pub Org", { ...BASE, pricingModel: "free", allowedTools: ["http_request", "http_request"] }),
  );
  assert.deepEqual(world.state.listings[0]!.useAllowedTools, ["http_request"]);
});

// ============================================
// Publishing: the page follows the listing
// ============================================

test("publishing use at a price makes the page, gives it its key and pauses free use, all in the publish transaction", async () => {
  const world = makeWorld();
  const listing = await withWorld(world, ({ createListing }) =>
    createListing(ORG, "Pub Org", { ...BASE, pricingModel: "per_request", pricePerRequestCents: 5, publish: true }),
  );
  assert.equal(listing.status, "published");
  assert.equal(listing.agent!.handle, "analyst");
  assert.equal(world.state.listings[0]!.status, "published");
  assert.ok(world.state.listings[0]!.publishedAt instanceof Date);

  assert.equal(agentOf(world).isPublic, true);
  assert.equal(agentOf(world).publicHandle, "analyst");
  const key = keyOf(world)!;
  assert.equal(key.enabled, false, "a price turns free use on the page off");
  assert.equal(key.orgId, ORG);
  assert.equal(world.state.transactions, 1);
  assert.ok(world.state.pageWrites.length >= 3);
  assert.ok(world.state.pageWrites.every((w) => w.inTransaction), "no page write outside the publish transaction");
  // Not a self-running agent: its results switch is not written.
  assert.equal(world.state.pageWrites.some((w) => w.data && "publicResults" in w.data), false);
});

test("publishing free use turns the page on, also when its owner had paused it", async () => {
  const fresh = makeWorld({ listing: { pricingModel: "free" } });
  await withWorld(fresh, ({ publishListing }) => publishListing(LISTING_ID, ORG));
  assert.equal(agentOf(fresh).isPublic, true);
  assert.equal(keyOf(fresh)!.enabled, true);

  const paused = makeWorld({
    listing: { pricingModel: "free" },
    agent: { isPublic: true, publicHandle: "my-analyst" },
    pageKey: { enabled: false },
  });
  await withWorld(paused, ({ publishListing }) => publishListing(LISTING_ID, ORG));
  assert.equal(keyOf(paused)!.enabled, true);
  // The address it already had is kept, and so is its one key.
  assert.equal(agentOf(paused).publicHandle, "my-analyst");
  assert.equal(paused.state.keys.length, 1);
});

test("a price pauses a page that was on, and a self-running agent's results follow the price", async () => {
  const live = makeWorld({
    listing: { pricingModel: "monthly", monthlyPriceCents: 900n },
    agent: { isPublic: true, publicHandle: "analyst", agentKind: "scheduled", publicResults: true },
    pageKey: { enabled: true },
  });
  await withWorld(live, ({ publishListing }) => publishListing(LISTING_ID, ORG));
  assert.equal(keyOf(live)!.enabled, false);
  assert.equal(agentOf(live).publicResults, false, "subscribers read results through the paid routes");

  const free = makeWorld({ listing: { pricingModel: "free" }, agent: { agentKind: "scheduled", publicResults: false } });
  await withWorld(free, ({ publishListing }) => publishListing(LISTING_ID, ORG));
  assert.equal(keyOf(free)!.enabled, true);
  assert.equal(agentOf(free).publicResults, true);
});

test("publishing a listing that is already published succeeds and changes nothing", async () => {
  const world = makeWorld({ listing: { pricingModel: "per_request", pricePerRequestCents: 5n } });
  await withWorld(world, async ({ publishListing }) => {
    const first = await publishListing(LISTING_ID, ORG);
    assert.equal(first!.status, "published");
    const publishedAt = world.state.listings[0]!.publishedAt;
    const writes = world.state.pageWrites.length;
    // The owner turns nothing on in between; a second publish is a no-op.
    const second = await publishListing(LISTING_ID, ORG);
    assert.equal(second!.status, "published");
    assert.equal(world.state.listings[0]!.publishedAt, publishedAt);
    assert.equal(world.state.pageWrites.length, writes);
    assert.equal(world.state.transactions, 1);
  });
  assert.equal(keyOf(world)!.enabled, false);

  // Create with publish, then publish again: the same.
  const twice = makeWorld();
  await withWorld(twice, async ({ createListing, publishListing, updateListing }) => {
    await createListing(ORG, "Pub Org", { ...BASE, pricingModel: "free", publish: true });
    const publishedAt = twice.state.listings[0]!.publishedAt;
    const writes = twice.state.pageWrites.length;
    await publishListing(LISTING_ID, ORG);
    assert.equal(twice.state.transactions, 1, "a second publish opens no transaction");
    // An edit that names publish is saved in a transaction, where the page
    // is checked against the row as saved. It finds nothing to move.
    const updated = await updateListing(LISTING_ID, ORG, { publish: true });
    assert.equal(updated.status, "published");
    assert.equal(twice.state.listings[0]!.publishedAt, publishedAt);
    assert.equal(twice.state.pageWrites.length, writes);
  });
  assert.equal(twice.state.transactions, 2);
  assert.equal(keyOf(twice)!.enabled, true);
});

test("a lost race for the address reruns the whole publish transaction", async () => {
  const world = makeWorld({ listing: { pricingModel: "per_request", pricePerRequestCents: 5n } });
  world.state.handleRaces = 1;
  await withWorld(world, ({ publishListing }) => publishListing(LISTING_ID, ORG));

  assert.equal(world.state.transactions, 2);
  assert.equal(world.state.listings[0]!.status, "published");
  // "analyst" went to the other agent; this one took the next candidate.
  assert.notEqual(agentOf(world).publicHandle, "analyst");
  assert.match(agentOf(world).publicHandle, /^analyst-/);
  assert.equal(agentOf(world).isPublic, true);
  assert.equal(world.state.keys.length, 1);
  assert.equal(keyOf(world)!.enabled, false);
});

test("a race that never ends leaves the listing unpublished and the page as it was", async () => {
  const world = makeWorld({ listing: { pricingModel: "per_request", pricePerRequestCents: 5n } });
  world.state.handleRaces = 99;
  await withWorld(world, async ({ publishListing }) => {
    await assert.rejects(publishListing(LISTING_ID, ORG));
  });
  assert.equal(world.state.transactions, 3);
  assert.equal(world.state.listings[0]!.status, "draft");
  assert.equal(agentOf(world).isPublic, false);
  assert.equal(world.state.keys.length, 0);
});

test("publishing a listing that sells copies touches nothing of the agent's page", async () => {
  const world = makeWorld({
    listing: { sells: "copies", pricingModel: "per_request", pricePerRequestCents: 5n },
    agent: { isPublic: true, publicHandle: "analyst" },
    pageKey: { enabled: true },
  });
  await withWorld(world, async ({ publishListing, updateListing }) => {
    await publishListing(LISTING_ID, ORG);
    await updateListing(LISTING_ID, ORG, { pricingModel: "free" });
    await updateListing(LISTING_ID, ORG, { pricingModel: "monthly", monthlyPriceCents: 900 });
  });
  assert.equal(world.state.listings[0]!.status, "published");
  assert.deepEqual(world.state.pageWrites, []);
  assert.equal(keyOf(world)!.enabled, true);

  const bare = makeWorld();
  await withWorld(bare, ({ createListing }) =>
    createListing(ORG, "Pub Org", { ...BASE, sells: "copies", pricingModel: "free", publish: true }),
  );
  assert.equal(bare.state.listings[0]!.status, "published");
  assert.equal(agentOf(bare).isPublic, false);
  assert.equal(agentOf(bare).publicHandle, null);
  assert.equal(bare.state.keys.length, 0);
});

test("a draft whose agent has become a graph agent is not published for use", async () => {
  const world = makeWorld({ listing: { pricingModel: "free" }, agent: { entrypoint: "graph" } });
  const refusal = await refusalOf(world, ({ publishListing }) => publishListing(LISTING_ID, ORG));
  assert.deepEqual([refusal!.status, refusal!.code], [409, "graph_agent_not_supported"]);
  assert.equal(world.state.listings[0]!.status, "draft");
  assert.equal(world.state.pageWrites.length, 0);
});

// ============================================
// Updating
// ============================================

const published = (listing: Row, extra: Parameters<typeof makeWorld>[0] = {}) =>
  makeWorld({
    listing: { status: "published", ...listing },
    agent: { isPublic: true, publicHandle: "analyst", ...(extra?.agent ?? {}) },
    pageKey: { enabled: true, ...(extra?.pageKey ?? {}) },
  });

test("an update keeps what the listing sells unless it names it", async () => {
  const world = published({ sells: "copies", pricingModel: "free" });
  await withWorld(world, async ({ updateListing }) => {
    const renamed = await updateListing(LISTING_ID, ORG, { title: "Analyst Pro", pricingModel: "per_request", pricePerRequestCents: 1 });
    assert.equal(renamed.sells, "copies");
    assert.equal(renamed.pricePerRequestCents, 1);
  });
  assert.equal(world.state.listings[0]!.sells, "copies");
  assert.deepEqual(world.state.pageWrites, []);

  const use = published({ sells: "use", pricingModel: "per_request", pricePerRequestCents: 5n }, { pageKey: { enabled: false } });
  await withWorld(use, async ({ updateListing }) => {
    // An edit that names no price, nothing sold and no publish is a plain
    // write: no transaction, and nothing of the page is written.
    assert.equal((await updateListing(LISTING_ID, ORG, { title: "Analyst Pro" })).sells, "use");
    await updateListing(LISTING_ID, ORG, { allowedTools: ["calculator"] });
    assert.deepEqual(use.state.pageWrites, []);
    assert.equal(use.state.transactions, 0);
    // A change of price that stays a price leaves the page as it is: public,
    // at its address, its key paused. The pause is written again, in the
    // transaction that saves the price, and nothing else of the page is.
    await updateListing(LISTING_ID, ORG, { pricePerRequestCents: 8 });
  });
  assert.deepEqual(use.state.pageWrites, [{ model: "widgetKey", data: { enabled: false }, inTransaction: true }]);
  assert.equal(use.state.transactions, 1);
  assert.equal(keyOf(use)!.enabled, false);
  assert.equal(agentOf(use).publicHandle, "analyst");
  assert.deepEqual(use.state.listings[0]!.useAllowedTools, ["calculator"]);
});

test("turning a published listing into one that sells use sets the page with the same write", async () => {
  const world = published({ sells: "copies", pricingModel: "per_request", pricePerRequestCents: 5n });
  const updated = await withWorld(world, ({ updateListing }) => updateListing(LISTING_ID, ORG, { sells: "use" }));
  assert.equal(updated.sells, "use");
  assert.equal(updated.unit, "message");
  assert.equal(world.state.listings[0]!.sells, "use");
  assert.equal(keyOf(world)!.enabled, false);
  assert.equal(world.state.transactions, 1);
  assert.ok(world.state.pageWrites.every((w) => w.inTransaction));
});

test("moving a published use listing between free and a price moves the page key with it", async () => {
  const world = published({ sells: "use", pricingModel: "free" });
  await withWorld(world, async ({ updateListing }) => {
    await updateListing(LISTING_ID, ORG, { pricingModel: "monthly", monthlyPriceCents: 900 });
    assert.equal(keyOf(world)!.enabled, false);
    await updateListing(LISTING_ID, ORG, { pricingModel: "free" });
    assert.equal(keyOf(world)!.enabled, true);
  });
  assert.equal(world.state.listings[0]!.monthlyPriceCents, null);
});

test("saving a free listing again leaves hidden results hidden; free use that starts shows them", async () => {
  // On sale free, and the owner has since hidden the results on the page.
  const hidden = published({ sells: "use", pricingModel: "free" }, { agent: { agentKind: "scheduled", publicResults: false } });
  await withWorld(hidden, async ({ updateListing }) => {
    // The dashboard form sends the pricing with every save, a change of title included.
    await updateListing(LISTING_ID, ORG, { title: "Analyst Pro", pricingModel: "free" });
  });
  assert.equal(agentOf(hidden).publicResults, false, "a save of the listing does not undo the owner's choice");
  assert.equal(keyOf(hidden)!.enabled, true);

  // A price hides them, and going back to free is free use starting again: shown.
  const moved = published({ sells: "use", pricingModel: "free" }, { agent: { agentKind: "scheduled", publicResults: true } });
  await withWorld(moved, async ({ updateListing }) => {
    await updateListing(LISTING_ID, ORG, { pricingModel: "monthly", monthlyPriceCents: 900 });
    assert.equal(agentOf(moved).publicResults, false);
    await updateListing(LISTING_ID, ORG, { pricingModel: "monthly", monthlyPriceCents: 1200 });
    assert.equal(agentOf(moved).publicResults, false, "a price that stays a price keeps them for subscribers");
    await updateListing(LISTING_ID, ORG, { pricingModel: "free" });
  });
  assert.equal(agentOf(moved).publicResults, true);

  // A copies listing that starts selling use for free: free use starting.
  const turned = published({ sells: "copies", pricingModel: "free" }, { agent: { agentKind: "scheduled", publicResults: false } });
  await withWorld(turned, ({ updateListing }) => updateListing(LISTING_ID, ORG, { sells: "use" }));
  assert.equal(agentOf(turned).publicResults, true);
});

test("the sale rules of an update are judged on the agent as it is when the edit is saved", async () => {
  const world = published({ sells: "use", pricingModel: "free" });
  await withWorld(world, async ({ updateListing }) => {
    // The agent is switched to its graph after the update has read it: the
    // read inside the transaction is the one that decides.
    const original = world.models.agent.findFirst;
    let reads = 0;
    world.models.agent.findFirst = async (args: Row) => {
      reads += 1;
      if (reads === 1) agentOf(world).entrypoint = "graph";
      return original(args);
    };
    await assert.rejects(
      () => updateListing(LISTING_ID, ORG, { pricingModel: "monthly", monthlyPriceCents: 900 }),
      (err: unknown) => (err as { code?: string }).code === "graph_agent_not_supported",
    );
    world.models.agent.findFirst = original;
  });
  assert.equal(world.state.listings[0]!.pricingModel, "free", "the refused edit was rolled back");
});

test("an update is held to the same rules as a new listing", async () => {
  const toTokens = published({ sells: "use", pricingModel: "free" });
  const refused = await refusalOf(toTokens, ({ updateListing }) => updateListing(LISTING_ID, ORG, { pricingModel: "tokenized" }));
  assert.deepEqual([refused!.status, refused!.code], [400, "token_access_not_available"]);
  assert.equal(toTokens.state.listings[0]!.pricingModel, "free");

  const cheap = published({ sells: "copies", pricingModel: "per_request", pricePerRequestCents: 1n });
  const floor = await refusalOf(cheap, ({ updateListing }) => updateListing(LISTING_ID, ORG, { sells: "use" }));
  assert.deepEqual([floor!.status, floor!.code], [400, "validation_failed"]);
  assert.equal(cheap.state.listings[0]!.sells, "copies");
  assert.deepEqual(cheap.state.pageWrites, []);

  const graph = published({ sells: "copies", pricingModel: "free" }, { agent: { entrypoint: "graph" } });
  const noGraph = await refusalOf(graph, ({ updateListing }) => updateListing(LISTING_ID, ORG, { sells: "use" }));
  assert.deepEqual([noGraph!.status, noGraph!.code], [409, "graph_agent_not_supported"]);

  // A buyer's copy that was listed before this rule cannot change what it sells.
  const copy = makeWorld({ listing: { status: "published", sells: "copies" }, copies: [AGENT_ID] });
  const resale = await refusalOf(copy, ({ updateListing }) => updateListing(LISTING_ID, ORG, { sells: "use" }));
  assert.deepEqual([resale!.status, resale!.code], [409, "marketplace_copy"]);
});

test("when a listing stops selling use nothing is deleted, ended or switched: access is read from the rows", async () => {
  const world = published({ sells: "use", pricingModel: "monthly", monthlyPriceCents: 900n }, { pageKey: { enabled: false } });
  // Any write to a licence or a subscription would throw: the fakes have no such method.
  await withWorld(world, async ({ updateListing, archiveListing }) => {
    const updated = await updateListing(LISTING_ID, ORG, { sells: "copies" });
    assert.equal(updated.sells, "copies");
    assert.equal(updated.unit, null);
    await archiveListing(LISTING_ID, ORG);
  });
  assert.equal(world.state.listings[0]!.sells, "copies");
  assert.equal(world.state.listings[0]!.status, "archived");
  assert.deepEqual(world.state.pageWrites, []);
  // The edit names what is sold, so it is saved in a transaction; the row as
  // saved sells copies, and the page is left alone.
  assert.equal(world.state.transactions, 1);
  assert.equal(agentOf(world).isPublic, true);
});

// ============================================
// Two requests at once: the page follows the listing as saved
// ============================================

type Svc = typeof import("../services/marketplace.js");

/**
 * Lets another of the owner's requests run whole and commit between this
 * request's first read of the listing and its write. The read made before
 * is then behind the row.
 */
function meanwhile(world: World, between: (svc: Svc) => Promise<unknown>, svc: Svc): void {
  const real = world.models.agentListing.findFirst;
  let fired = false;
  world.models.agentListing.findFirst = async (args: Row) => {
    const stale = await real(args);
    if (!fired && args?.include?.agent) {
      fired = true;
      await between(svc);
    }
    return stale;
  };
}

/** Whether the listing is on sale at a price, and whether free use on the page is on. */
const pageAgainstListing = (world: World) => {
  const l = world.state.listings[0]!;
  const paid =
    l.status === "published" &&
    l.sells === "use" &&
    ((l.pricingModel === "per_request" && BigInt(l.pricePerRequestCents ?? 0) > 0n) ||
      (l.pricingModel === "monthly" && BigInt(l.monthlyPriceCents ?? 0) > 0n));
  return { status: l.status, pricingModel: l.pricingModel, paid, keyOn: keyOf(world)?.enabled === true };
};

test("two edits at once, one to free and one to a new price: the listing ends priced and its page key paused", async () => {
  const world = published({ pricingModel: "per_request", pricePerRequestCents: 10n }, { pageKey: { enabled: false } });
  await withWorld(world, async (svc) => {
    // The edit to free commits, and turns the key on, after the price edit read the listing as priced.
    meanwhile(world, (s) => s.updateListing(LISTING_ID, ORG, { pricingModel: "free" }), svc);
    await svc.updateListing(LISTING_ID, ORG, { pricePerRequestCents: 20 });
  });
  assert.deepEqual(pageAgainstListing(world), { status: "published", pricingModel: "per_request", paid: true, keyOn: false });
  assert.equal(world.state.listings[0]!.pricePerRequestCents, 20n);
  assert.ok(world.state.pageWrites.every((w) => w.inTransaction));
});

test("two edits at once, the other way round: the listing ends free and its page key on", async () => {
  const world = published({ pricingModel: "per_request", pricePerRequestCents: 10n }, { pageKey: { enabled: false } });
  await withWorld(world, async (svc) => {
    meanwhile(world, (s) => s.updateListing(LISTING_ID, ORG, { pricePerRequestCents: 20 }), svc);
    await svc.updateListing(LISTING_ID, ORG, { pricingModel: "free" });
  });
  assert.deepEqual(pageAgainstListing(world), { status: "published", pricingModel: "free", paid: false, keyOn: true });
});

test("a price saved on the draft while its publish is in flight is what gets published: the page key is paused", async () => {
  const world = makeWorld({
    agent: { isPublic: true, publicHandle: "analyst" },
    listing: { status: "draft", pricingModel: "free" },
    pageKey: { enabled: true },
  });
  await withWorld(world, async (svc) => {
    meanwhile(world, (s) => s.updateListing(LISTING_ID, ORG, { pricingModel: "per_request", pricePerRequestCents: 5 }), svc);
    await svc.publishListing(LISTING_ID, ORG);
  });
  assert.deepEqual(pageAgainstListing(world), { status: "published", pricingModel: "per_request", paid: true, keyOn: false });
});

test("the same pair in the other order: a price edit that read the draft before it was published still pauses the page", async () => {
  const world = makeWorld({
    agent: { isPublic: true, publicHandle: "analyst" },
    listing: { status: "draft", pricingModel: "free" },
    pageKey: { enabled: true },
  });
  await withWorld(world, async (svc) => {
    // The publish commits (free: key on) after the edit read the listing as a draft.
    meanwhile(world, (s) => s.publishListing(LISTING_ID, ORG), svc);
    await svc.updateListing(LISTING_ID, ORG, { pricingModel: "per_request", pricePerRequestCents: 5 });
  });
  assert.deepEqual(pageAgainstListing(world), { status: "published", pricingModel: "per_request", paid: true, keyOn: false });
});

test("a draft made free while its publish is in flight is published free, with its page key on", async () => {
  const world = makeWorld({
    agent: { isPublic: true, publicHandle: "analyst" },
    listing: { status: "draft", pricingModel: "per_request", pricePerRequestCents: 5n },
    pageKey: { enabled: false },
  });
  await withWorld(world, async (svc) => {
    meanwhile(world, (s) => s.updateListing(LISTING_ID, ORG, { pricingModel: "free" }), svc);
    await svc.publishListing(LISTING_ID, ORG);
  });
  assert.deepEqual(pageAgainstListing(world), { status: "published", pricingModel: "free", paid: false, keyOn: true });
});

test("the sale rules are run on the listing as it is published, so terms that changed under the publish are refused", async () => {
  const world = makeWorld({
    agent: { isPublic: true, publicHandle: "analyst" },
    listing: { status: "draft", pricingModel: "free" },
    pageKey: { enabled: true },
  });
  const refusal = await refusalOf(world, async (svc) => {
    // Another write lands after the publish read the draft as free.
    meanwhile(world, async () => Object.assign(world.state.listings[0]!, { pricingModel: "tokenized" }), svc);
    await svc.publishListing(LISTING_ID, ORG);
  });
  assert.deepEqual([refusal!.status, refusal!.code], [400, "token_access_not_available"]);
  assert.equal(world.state.listings[0]!.status, "draft", "the publish is rolled back whole");
  assert.equal(keyOf(world)!.enabled, true);
});

test("a price pauses the page key with a write that does not ask whether the key is on, and free turns it on by compare-and-set", async () => {
  const wheres = (world: World) => {
    const seen: Row[] = [];
    const real = world.models.widgetKey.updateMany;
    world.models.widgetKey.updateMany = async (args: Row) => {
      seen.push({ where: args.where, data: args.data });
      return real(args);
    };
    return seen;
  };
  const key = { pageOfAgentId: AGENT_ID, orgId: ORG, revokedAt: null };

  // The key already reads as paused. The pause is written all the same, so
  // it takes the key's row lock and queues behind a request turning it on.
  const priced = published({ pricingModel: "per_request", pricePerRequestCents: 10n }, { pageKey: { enabled: false } });
  const pricedWrites = wheres(priced);
  await withWorld(priced, ({ updateListing }) => updateListing(LISTING_ID, ORG, { pricePerRequestCents: 20 }));
  assert.deepEqual(pricedWrites, [{ where: key, data: { enabled: false } }]);

  const draft = makeWorld({
    agent: { isPublic: true, publicHandle: "analyst" },
    listing: { pricingModel: "monthly", monthlyPriceCents: 900n },
    pageKey: { enabled: false },
  });
  const publishWrites = wheres(draft);
  await withWorld(draft, ({ publishListing }) => publishListing(LISTING_ID, ORG));
  assert.deepEqual(publishWrites, [{ where: key, data: { enabled: false } }]);

  const free = published({ pricingModel: "monthly", monthlyPriceCents: 900n }, { pageKey: { enabled: false } });
  const freeWrites = wheres(free);
  await withWorld(free, ({ updateListing }) => updateListing(LISTING_ID, ORG, { pricingModel: "free" }));
  assert.deepEqual(freeWrites, [{ where: { ...key, enabled: false }, data: { enabled: true } }]);
  assert.equal(keyOf(free)!.enabled, true);
});

test("a draft's page is not touched by an edit of its price, and a plain edit of a published listing writes nothing to the page", async () => {
  const draft = makeWorld({
    agent: { isPublic: true, publicHandle: "analyst" },
    listing: { status: "draft", pricingModel: "free" },
    pageKey: { enabled: true },
  });
  await withWorld(draft, ({ updateListing }) =>
    updateListing(LISTING_ID, ORG, { pricingModel: "per_request", pricePerRequestCents: 5 }),
  );
  assert.equal(draft.state.listings[0]!.pricePerRequestCents, 5n);
  assert.deepEqual(draft.state.pageWrites, []);
  assert.equal(keyOf(draft)!.enabled, true, "the owner's free link stays on until the listing is on sale");

  const live = published({ pricingModel: "per_request", pricePerRequestCents: 10n }, { pageKey: { enabled: false } });
  await withWorld(live, async ({ updateListing }) => {
    await updateListing(LISTING_ID, ORG, { title: "Analyst Pro" });
    await updateListing(LISTING_ID, ORG, { shortDescription: "Reads filings.", readme: "How to use it." });
  });
  assert.equal(live.state.listings[0]!.title, "Analyst Pro");
  assert.deepEqual(live.state.pageWrites, []);
  assert.equal(live.state.transactions, 0);
});

// ============================================
// What a listing answers
// ============================================

test("a public listing says what it sells, its unit and its agent's handle and kind, and never asks for the instructions", async () => {
  const world = published({ sells: "use", pricingModel: "per_request", pricePerRequestCents: 5n }, { agent: { agentKind: "task" } });
  await withWorld(world, async ({ getListingBySlug, getListingById }) => {
    const bySlug = (await getListingBySlug("research-analyst"))!;
    assert.equal(bySlug.sells, "use");
    assert.equal(bySlug.unit, "run");
    assert.equal(bySlug.agent!.handle, "analyst");
    assert.equal(bySlug.agent!.agentKind, "task");
    assert.equal("allowedTools" in bySlug, false);
    assert.doesNotMatch(JSON.stringify(bySlug), /secret analyst|systemPrompt|http_request/);

    const byId = (await getListingById(LISTING_ID))!;
    assert.deepEqual([byId.sells, byId.unit, byId.agent!.handle], ["use", "run", "analyst"]);
  });
  assert.ok(world.state.selects.length >= 2);
  for (const select of world.state.selects) {
    assert.equal("systemPrompt" in select, false);
    assert.equal("tools" in select, false);
    assert.equal(select.publicHandle, true);
    assert.equal(select.agentKind, true);
  }
});

test("getListingBySlug's select no longer names the agent's instructions or tools", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, "..", "services", "marketplace.ts"), "utf8");
  const start = source.indexOf("export async function getListingBySlug(");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.ok(start > 0 && body.length > 100);
  assert.doesNotMatch(body, /systemPrompt/);
  assert.doesNotMatch(body, /\btools\b/);
  assert.match(body, /publicHandle: true/);
});

test("my listings count who holds what: copies, people using it, and subscriptions that grant access now", async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const world = makeWorld({
    listing: { status: "published", sells: "use", pricingModel: "monthly", monthlyPriceCents: 900n, useAllowedTools: ["calculator"] },
    licences: [
      { listingId: LISTING_ID, kind: "use" },
      { listingId: LISTING_ID, kind: "use" },
      { listingId: LISTING_ID, kind: "copy" },
      { listingId: "another", kind: "use" },
    ],
    subs: [
      { listingId: LISTING_ID, status: "active", currentPeriodEnd: new Date(Date.now() + 5 * DAY), cancelAtPeriodEnd: false },
      // Past due, inside the grace window: still has access.
      { listingId: LISTING_ID, status: "past_due", currentPeriodEnd: new Date(Date.now() - DAY), cancelAtPeriodEnd: false },
      // Ran out, and set to cancel: no grace.
      { listingId: LISTING_ID, status: "active", currentPeriodEnd: new Date(Date.now() - DAY), cancelAtPeriodEnd: true },
      { listingId: "another", status: "active", currentPeriodEnd: new Date(Date.now() + 5 * DAY), cancelAtPeriodEnd: false },
    ],
  });
  const [mine] = await withWorld(world, ({ getMyListings }) => getMyListings(ORG));
  assert.deepEqual(mine!.buyers, { copies: 1, using: 2, subscribed: 2 });
  assert.equal(mine!.sells, "use");
  assert.equal(mine!.unit, "month");
  assert.deepEqual(mine!.allowedTools, ["calculator"]);

  const none = makeWorld();
  assert.deepEqual(await withWorld(none, ({ getMyListings }) => getMyListings(ORG)), []);
});

// ============================================
// The routes
// ============================================

async function appAs(principal: Row) {
  const Fastify = (await import("fastify")).default;
  const sensible = await import("@fastify/sensible");
  const { marketplaceRoutes } = await import("../routes/marketplace.js");
  const app = Fastify();
  await app.register(sensible.default);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { auth: unknown }).auth = principal;
  });
  await app.register(marketplaceRoutes);
  return app;
}

async function call(world: World, method: "POST" | "PATCH" | "GET", url: string, payload?: Row) {
  return withWorld(world, async () => {
    const app = await appAs({ userId: "u1", orgId: ORG, type: "jwt", role: "owner" });
    try {
      const res = await app.inject({ method, url, ...(payload !== undefined && { payload }) });
      return { status: res.statusCode, body: res.json() as Row };
    } finally {
      await app.close();
    }
  });
}

test("POST /listings creates a listing that sells use, and publishes it in the same request when asked", async () => {
  const world = makeWorld();
  const res = await call(world, "POST", "/listings", {
    ...BASE,
    pricingModel: "monthly",
    monthlyPriceCents: 900,
    allowedTools: ["http_request"],
    publish: true,
  });
  assert.equal(res.status, 201);
  const { listing } = res.body;
  assert.equal(listing.sells, "use");
  assert.equal(listing.unit, "month");
  assert.equal(listing.status, "published");
  assert.equal(listing.monthlyPriceCents, 900);
  assert.deepEqual(listing.allowedTools, ["http_request"]);
  assert.deepEqual([listing.agent.handle, listing.agent.agentKind], ["analyst", "conversation"]);
  assert.equal(keyOf(world)!.enabled, false);

  const mine = await call(world, "GET", "/my-listings");
  assert.deepEqual(mine.body.listings[0].buyers, { copies: 0, using: 0, subscribed: 0 });
});

test("POST and PATCH /listings answer each refusal with its status, its code and a plain sentence", async () => {
  const create = (world: World, body: Row) => call(world, "POST", "/listings", { ...BASE, ...body });

  const copy = await create(makeWorld({ copies: [AGENT_ID] }), { pricingModel: "free" });
  assert.deepEqual([copy.status, copy.body.error], [409, "marketplace_copy"]);
  assert.equal(copy.body.message, "This agent came from the marketplace, so it cannot be sold again.");

  const graph = await create(makeWorld({ agent: { entrypoint: "graph" } }), { pricingModel: "free" });
  assert.deepEqual([graph.status, graph.body.error], [409, "graph_agent_not_supported"]);

  const tokens = await create(makeWorld(), { pricingModel: "tokenized" });
  assert.deepEqual([tokens.status, tokens.body.error], [400, "token_access_not_available"]);
  // By name, a token-gated copy listing is created as before.
  assert.equal((await create(makeWorld(), { sells: "copies", pricingModel: "tokenized" })).status, 201);

  const exists = await create(makeWorld({ listing: {} }), { pricingModel: "free" });
  assert.deepEqual([exists.status, exists.body.error], [409, "listing_exists"]);

  const floor = await create(makeWorld(), { pricingModel: "per_request", pricePerRequestCents: 4 });
  assert.equal(floor.status, 400);
  assert.equal(floor.body.error, "validation_failed");
  assert.equal(floor.body.message, "The price per message must be at least $0.05.");
  assert.deepEqual(floor.body.fields, { pricePerRequestCents: "The price per message must be at least $0.05." });

  const scheduled = await create(makeWorld({ agent: { agentKind: "scheduled" } }), {
    pricingModel: "per_request",
    pricePerRequestCents: 50,
  });
  assert.deepEqual([scheduled.status, scheduled.body.error], [400, "validation_failed"]);

  const patched = await call(
    makeWorld({ listing: { status: "published", sells: "copies", pricingModel: "tokenized" } }),
    "PATCH",
    `/listings/${LISTING_ID}`,
    { sells: "use" },
  );
  assert.deepEqual([patched.status, patched.body.error], [400, "token_access_not_available"]);

  const republished = await call(
    makeWorld({ listing: { status: "published", pricingModel: "free" } }),
    "POST",
    `/listings/${LISTING_ID}/publish`,
  );
  assert.equal(republished.status, 200);

  const draftGraph = await call(
    makeWorld({ listing: { pricingModel: "free" }, agent: { entrypoint: "graph" } }),
    "POST",
    `/listings/${LISTING_ID}/publish`,
  );
  assert.deepEqual([draftGraph.status, draftGraph.body.error], [409, "graph_agent_not_supported"]);
});

test("a database failure while saving a listing is never answered in the database's words", async () => {
  const world = makeWorld();
  world.state.createFails = Object.assign(
    new Error("\nInvalid `prisma.agentListing.create()` invocation in\n/srv/app/services/marketplace.ts:700:33\n\nForeign key constraint failed on the field: `agent_listings_agent_id_fkey`"),
    { code: "P2003", clientVersion: "5.22.0" },
  );
  const res = await call(world, "POST", "/listings", { ...BASE, pricingModel: "free" });
  assert.equal(res.status, 400);
  assert.equal(res.body.message, "The listing could not be saved. Please try again.");
  assert.doesNotMatch(JSON.stringify(res.body), /prisma|constraint|fkey|marketplace\.ts/i);

  // A sentence the service wrote itself still reaches the person.
  const gone = makeWorld();
  gone.state.agents.length = 0;
  const missing = await call(gone, "POST", "/listings", { ...BASE, pricingModel: "free" });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.message, "Agent not found or does not belong to your organization");
});
