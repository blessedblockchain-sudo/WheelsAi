import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "./unitEnv.js";

import { validationFailureFromFields } from "../lib/validationFailure.js";

// The creator's switch for paying from a wallet (agent_listings.x402_enabled),
// through the real listing services and routes over an in-memory database
// that holds the database's CHECK: the switch is on only on an agent's
// listing that sells use, per request, at a price of at least 5 cents.
//
// What these pin: the switch is saved on for an agent that answers when it
// is called and is sold per use; turning it on anywhere else is refused on its
// field, in its sentence, before anything is written; an edit that stops
// selling use per request turns it off in the same write, so the CHECK is
// never what refuses a creator, also when another request moved the listing
// a moment before; off is always saved; only the owner's reads carry it; and a
// create or a change that does not name it writes what it always wrote.

const ORG = "org_pub";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const LISTING_ID = "33333333-3333-4333-8333-333333333333";
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const STEP_AGENT_ID = "55555555-5555-4555-8555-555555555555";

const WORKFLOW_SENTENCE = "Paying from a wallet is offered on an agent's listing only.";
const NOT_PER_USE_SENTENCE = "Paying from a wallet is for an agent sold per use. Choose pay per use first.";
const NOT_CALLED_SENTENCE = "Paying from a wallet is for an agent that answers when it is called.";

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return cond.in.includes(v);
      if ("not" in cond) return v !== cond.not;
      if ("gte" in cond) return v !== null && v !== undefined && BigInt(v) >= BigInt(cond.gte);
    }
    return v === cond;
  });
}

/** agent_listings_x402_per_use_check, as the migration writes it. */
function breaksX402Check(row: Row): boolean {
  if (row.x402Enabled !== true) return false;
  return !(
    row.agentId != null &&
    row.sells === "use" &&
    row.pricingModel === "per_request" &&
    row.pricePerRequestCents != null &&
    BigInt(row.pricePerRequestCents) >= 5n
  );
}

const checkViolation = () =>
  Object.assign(new Error('new row for relation "agent_listings" violates check constraint "agent_listings_x402_per_use_check"'), {
    code: "P2010",
    clientVersion: "5.22.0",
  });

function makeWorld(opts: { agent?: Row; listing?: Row; workflowListing?: boolean } = {}) {
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
        isPublic: true,
        publicHandle: "analyst",
        publicResults: false,
        systemPrompt: "You are the analyst.",
        tools: [{ name: "calculator" }],
        modelConfig: {},
        ...(opts.agent ?? {}),
      },
      { id: STEP_AGENT_ID, orgId: ORG, name: "Step agent", modelConfig: {} },
    ] as Row[],
    workflows: [
      { id: WORKFLOW_ID, orgId: ORG, name: "Digest", slug: "digest", isEnabled: true, timeout: 600_000, inputSchema: {} },
    ] as Row[],
    listings: [] as Row[],
    keys: [{ id: "key_1", orgId: ORG, agentId: AGENT_ID, pageOfAgentId: AGENT_ID, revokedAt: null, dailyMessageCap: 100, enabled: false }] as Row[],
    /** Every write to a listing row, as it was asked. */
    writes: [] as Array<{ op: string; where?: Row; data: Row }>,
    /** How many writes the CHECK refused. */
    checkRefusals: 0,
  };
  if (opts.listing) {
    state.listings.push({
      id: LISTING_ID,
      agentId: AGENT_ID,
      orchestrationId: null,
      publisherId: ORG,
      publisherName: "Pub Org",
      title: "Research Analyst",
      slug: "research-analyst",
      shortDescription: "Reads filings and answers questions.",
      category: "research",
      status: "published",
      sells: "use",
      useAllowedTools: [],
      pricingModel: "per_request",
      pricePerRequestCents: 5n,
      monthlyPriceCents: null,
      x402Enabled: false,
      totalInstalls: 0,
      ...opts.listing,
    });
  }
  if (opts.workflowListing) {
    state.listings.push({
      id: LISTING_ID,
      agentId: null,
      orchestrationId: WORKFLOW_ID,
      publisherId: ORG,
      publisherName: "Pub Org",
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
      x402Enabled: false,
      totalInstalls: 0,
    });
  }

  const withAgent = (listing: Row, args: Row) =>
    args?.include?.agent ? { ...listing, agent: { ...state.agents.find((a) => a.id === listing.agentId)! } } : { ...listing };

  const models: Row = {
    orchestration: {
      findFirst: async ({ where }: Row) => {
        const row = state.workflows.find((w) => matches(w, where));
        return row
          ? { ...row, steps: [{ stepType: "agent", agentId: STEP_AGENT_ID, fallbackAgentId: null, deploymentId: null }] }
          : null;
      },
    },
    agent: {
      findFirst: async ({ where }: Row) => {
        const row = state.agents.find((a) => matches(a, where));
        return row ? { ...row } : null;
      },
      findMany: async ({ where }: Row) =>
        state.agents.filter((a) => where.id.in.includes(a.id) && a.orgId === where.orgId).map((a) => ({ ...a })),
      updateMany: async ({ where, data }: Row) => {
        const hit = state.agents.filter((a) => matches(a, where));
        for (const a of hit) Object.assign(a, data);
        return { count: hit.length };
      },
    },
    agentInstall: { findFirst: async () => null, findMany: async () => [] },
    agentSubscription: { findMany: async () => [] },
    listingPlan: { findMany: async () => [] },
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
        const row = { id: LISTING_ID, agentId: null, orchestrationId: null, x402Enabled: false, totalInstalls: 0, ...args.data };
        if (breaksX402Check(row)) {
          state.checkRefusals += 1;
          throw checkViolation();
        }
        state.writes.push({ op: "create", data: args.data });
        state.listings.push(row);
        return withAgent(row, args);
      },
      // A where with more than the id is a condition on the row: no row that
      // meets it is the Prisma error P2025, as an update by a unique key gives.
      update: async (args: Row) => {
        const row = state.listings.find((l) => matches(l, args.where));
        if (!row) throw Object.assign(new Error("Record to update not found."), { code: "P2025", clientVersion: "5.22.0" });
        const next = { ...row, ...args.data };
        if (breaksX402Check(next)) {
          state.checkRefusals += 1;
          throw checkViolation();
        }
        state.writes.push({ op: "update", where: args.where, data: args.data });
        Object.assign(row, args.data);
        return withAgent(row, args);
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = state.listings.filter((l) => matches(l, where));
        for (const l of hit) {
          if (breaksX402Check({ ...l, ...data })) {
            state.checkRefusals += 1;
            throw checkViolation();
          }
        }
        for (const l of hit) Object.assign(l, data);
        if (hit.length > 0) state.writes.push({ op: "updateMany", where, data });
        return { count: hit.length };
      },
      aggregate: async () => ({ _count: { id: 1 }, _sum: { totalInstalls: 0 } }),
    },
    widgetKey: {
      findFirst: async ({ where }: Row) => {
        const row = state.keys.find((k) => matches(k, where));
        return row ? { ...row } : null;
      },
      createMany: async () => ({ count: 0 }),
      updateMany: async ({ where, data }: Row) => {
        const hit = state.keys.filter((k) => matches(k, where));
        for (const k of hit) Object.assign(k, data);
        return { count: hit.length };
      },
    },
    orgSubscription: { findUnique: async () => null },
    organization: { findUnique: async () => ({ name: "Pub Org" }) },
    publisherProfile: { findUnique: async () => ({ orgId: ORG }), update: async () => ({}) },
  };

  models.$transaction = async (fn: (tx: Row) => Promise<unknown>) => {
    const snapshot = structuredClone({ agents: state.agents, listings: state.listings, keys: state.keys, writes: state.writes });
    try {
      return await fn(models);
    } catch (err) {
      Object.assign(state, snapshot);
      throw err;
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

const BASE = {
  agentId: AGENT_ID,
  title: "Research Analyst",
  shortDescription: "Reads filings and answers questions.",
  category: "research",
} as const;

const PER_USE = { pricingModel: "per_request", pricePerRequestCents: 5 } as const;

const listingOf = (world: World) => world.state.listings[0];

async function refusalOf(world: World, run: (svc: Svc) => Promise<unknown>) {
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

/** The refusal of the switch, on its field, in its sentence. */
const onItsField = (sentence: string) => ({
  status: 400,
  code: "validation_failed",
  message: sentence,
  body: validationFailureFromFields({ x402Enabled: sentence }),
});

/**
 * Lets another of the owner's edits run whole and commit between this
 * edit's read of the listing and its write.
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

// ============================================
// On
// ============================================

test("the switch is saved on for a conversation agent and a task agent sold per use at 5 cents", async () => {
  for (const agentKind of ["conversation", "task"]) {
    const created = makeWorld({ agent: { agentKind } });
    const listing = await withWorld(created, ({ createListing }) =>
      createListing(ORG, "Pub Org", { ...BASE, ...PER_USE, x402Enabled: true }),
    );
    assert.equal(listing.x402Enabled, true, agentKind);
    assert.equal(listingOf(created)!.x402Enabled, true);
    assert.equal(created.state.writes.length, 1);
    assert.equal(created.state.writes[0]!.data.x402Enabled, true);

    // And on a listing that is already on sale per use: one write, the switch
    // and nothing else, on a row that still sells use per request at a price.
    const edited = makeWorld({ agent: { agentKind }, listing: {} });
    const updated = await withWorld(edited, ({ updateListing }) => updateListing(LISTING_ID, ORG, { x402Enabled: true }));
    assert.equal(updated.x402Enabled, true);
    assert.deepEqual(edited.state.writes, [
      {
        op: "update",
        where: { id: LISTING_ID, sells: "use", pricingModel: "per_request", pricePerRequestCents: { gte: 5n } },
        data: { x402Enabled: true },
      },
    ]);
    assert.equal(listingOf(edited)!.x402Enabled, true);
  }
});

test("turned on with the price in the same edit, the write asks the row only for what it does not write", async () => {
  const world = makeWorld({ listing: { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900n } });
  await withWorld(world, ({ updateListing }) =>
    updateListing(LISTING_ID, ORG, { pricingModel: "per_request", pricePerRequestCents: 7, x402Enabled: true }),
  );
  assert.equal(world.state.writes.length, 1);
  assert.deepEqual(world.state.writes[0]!.where, { id: LISTING_ID, sells: "use" });
  assert.equal(world.state.writes[0]!.data.pricingModel, "per_request");
  assert.equal(world.state.writes[0]!.data.x402Enabled, true);
  assert.equal(listingOf(world)!.x402Enabled, true);
  assert.equal(listingOf(world)!.pricePerRequestCents, 7n);
});

// ============================================
// Refused, nothing saved
// ============================================

test("a workflow's listing never has the switch on: refused on its field and nothing is saved", async () => {
  const create = makeWorld();
  const created = await refusalOf(create, ({ createListing }) =>
    createListing(ORG, "Pub Org", {
      orchestrationId: WORKFLOW_ID,
      title: "Weekly Digest",
      shortDescription: "Reads the week and writes it up.",
      category: "research",
      pricingModel: "per_request",
      pricePerRequestCents: 25,
      x402Enabled: true,
    }),
  );
  assert.deepEqual(created, onItsField(WORKFLOW_SENTENCE));
  assert.equal(create.state.listings.length, 0);

  const edit = makeWorld({ workflowListing: true });
  const edited = await refusalOf(edit, ({ updateListing }) =>
    updateListing(LISTING_ID, ORG, { pricePerRequestCents: 30, x402Enabled: true }),
  );
  assert.deepEqual(edited, onItsField(WORKFLOW_SENTENCE));
  assert.equal(edit.state.writes.length, 0);
  assert.equal(listingOf(edit)!.pricePerRequestCents, 25n);

  // Off is what a workflow's listing already is: asked for, the edit is
  // saved and nothing of the switch is written.
  await withWorld(edit, ({ updateListing }) => updateListing(LISTING_ID, ORG, { pricePerRequestCents: 30, x402Enabled: false }));
  assert.equal(edit.state.writes.length, 1);
  assert.equal("x402Enabled" in edit.state.writes[0]!.data, false);
  assert.equal(listingOf(edit)!.x402Enabled, false);
});

test("a new listing that is free, monthly, token-gated or sells copies cannot have the switch on", async () => {
  const terms: Array<[string, Row]> = [
    ["free", { pricingModel: "free" }],
    ["monthly", { pricingModel: "monthly", monthlyPriceCents: 900 }],
    ["token-gated", { pricingModel: "tokenized" }],
    ["copies per request", { sells: "copies", ...PER_USE }],
    ["copies, token-gated", { sells: "copies", pricingModel: "tokenized" }],
  ];
  for (const [name, params] of terms) {
    const world = makeWorld();
    const refusal = await refusalOf(world, ({ createListing }) =>
      createListing(ORG, "Pub Org", { ...BASE, ...params, x402Enabled: true } as never),
    );
    assert.deepEqual(refusal, onItsField(NOT_PER_USE_SENTENCE), name);
    assert.equal(world.state.listings.length, 0, name);
  }
});

test("an agent that runs on its own cannot have the switch on, whatever its terms", async () => {
  for (const params of [PER_USE, { pricingModel: "monthly", monthlyPriceCents: 900 }, { pricingModel: "free" }] as Row[]) {
    const world = makeWorld({ agent: { agentKind: "scheduled" } });
    const refusal = await refusalOf(world, ({ createListing }) =>
      createListing(ORG, "Pub Org", { ...BASE, ...params, x402Enabled: true } as never),
    );
    assert.deepEqual(refusal, onItsField(NOT_CALLED_SENTENCE), params.pricingModel);
    assert.equal(world.state.listings.length, 0);
  }

  const edit = makeWorld({ agent: { agentKind: "scheduled" }, listing: { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900n } });
  const refusal = await refusalOf(edit, ({ updateListing }) => updateListing(LISTING_ID, ORG, { x402Enabled: true }));
  assert.deepEqual(refusal, onItsField(NOT_CALLED_SENTENCE));
  assert.deepEqual(edit.state.writes, []);
});

test("an edit that asks for the switch on terms that are not use per request is refused whole", async () => {
  const edits: Array<[string, Row, Row]> = [
    ["to free", {}, { pricingModel: "free", x402Enabled: true }],
    ["to monthly", {}, { pricingModel: "monthly", monthlyPriceCents: 900, x402Enabled: true }],
    ["to copies", {}, { sells: "copies", x402Enabled: true }],
    ["on a token-gated copies listing", { sells: "copies", pricingModel: "tokenized", pricePerRequestCents: null }, { x402Enabled: true }],
    ["on a monthly listing", { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900n }, { x402Enabled: true }],
    // Saved before the floor: the terms are use per request, the price is not enough.
    ["on a price under the floor", { pricePerRequestCents: 3n }, { x402Enabled: true, title: "Analyst Pro" }],
  ];
  for (const [name, listing, params] of edits) {
    const world = makeWorld({ listing });
    const before = structuredClone(listingOf(world));
    const refusal = await refusalOf(world, ({ updateListing }) => updateListing(LISTING_ID, ORG, params));
    assert.deepEqual(refusal, onItsField(NOT_PER_USE_SENTENCE), name);
    assert.deepEqual(world.state.writes, [], name);
    assert.deepEqual(listingOf(world), before, name);
  }
});

test("a price under the floor with the switch on is told the floor, by the sale rules that judge it", async () => {
  const world = makeWorld();
  const refusal = await refusalOf(world, ({ createListing }) =>
    createListing(ORG, "Pub Org", { ...BASE, pricingModel: "per_request", pricePerRequestCents: 4, x402Enabled: true }),
  );
  assert.deepEqual([refusal!.status, refusal!.code, refusal!.message], [400, "validation_failed", "The price per message must be at least $0.05."]);
  assert.deepEqual(Object.keys(refusal!.body!.fields), ["pricePerRequestCents"]);
  assert.equal(world.state.listings.length, 0);
});

// ============================================
// Off
// ============================================

test("a change that stops selling use per request saves the change and the switch off in one write", async () => {
  const changes: Array<[string, Row, Row]> = [
    ["to monthly", { pricingModel: "monthly", monthlyPriceCents: 900 }, { pricingModel: "monthly", monthlyPriceCents: 900n }],
    ["to free", { pricingModel: "free" }, { pricingModel: "free", pricePerRequestCents: null }],
    ["to copies", { sells: "copies" }, { sells: "copies" }],
    ["to token-gated copies", { sells: "copies", pricingModel: "tokenized" }, { sells: "copies", pricingModel: "tokenized" }],
  ];
  for (const [name, params, after] of changes) {
    for (const status of ["published", "draft"]) {
      const world = makeWorld({ listing: { status, x402Enabled: true } });
      const updated = await withWorld(world, ({ updateListing }) => updateListing(LISTING_ID, ORG, params));
      assert.equal(updated.x402Enabled, false, name);
      // The one write that moves the terms carries the switch off with it.
      assert.equal(world.state.writes.length, 1, name);
      assert.deepEqual(world.state.writes[0]!.where, { id: LISTING_ID }, name);
      assert.equal(world.state.writes[0]!.data.x402Enabled, false, name);
      for (const [key, value] of Object.entries(after)) {
        assert.equal(listingOf(world)![key], value, `${name}: ${key}`);
      }
      assert.equal(listingOf(world)!.x402Enabled, false, name);
      assert.equal(world.state.checkRefusals, 0, name);
    }
  }
});

test("a listing that sells copies per request at a price under the floor is saved with the switch off", async () => {
  const world = makeWorld({ listing: { sells: "copies", pricePerRequestCents: 5n } });
  await withWorld(world, ({ updateListing }) => updateListing(LISTING_ID, ORG, { pricePerRequestCents: 1 }));
  assert.equal(world.state.writes[0]!.data.x402Enabled, false);
  assert.equal(listingOf(world)!.pricePerRequestCents, 1n);
});

test("off is always saved, on any listing, and alone it writes the switch and nothing else", async () => {
  const on = makeWorld({ listing: { x402Enabled: true } });
  const updated = await withWorld(on, ({ updateListing }) => updateListing(LISTING_ID, ORG, { x402Enabled: false }));
  assert.equal(updated.x402Enabled, false);
  assert.deepEqual(on.state.writes, [{ op: "update", where: { id: LISTING_ID }, data: { x402Enabled: false } }]);

  for (const listing of [
    { pricingModel: "free", pricePerRequestCents: null },
    { sells: "copies", pricingModel: "tokenized", pricePerRequestCents: null },
  ]) {
    const world = makeWorld({ listing, agent: { agentKind: "scheduled" } });
    await withWorld(world, ({ updateListing }) => updateListing(LISTING_ID, ORG, { x402Enabled: false }));
    assert.equal(listingOf(world)!.x402Enabled, false);
  }

  // Sent off on a new listing, it is written as a listing that does not name it.
  const created = makeWorld();
  await withWorld(created, ({ createListing }) => createListing(ORG, "Pub Org", { ...BASE, pricingModel: "free", x402Enabled: false }));
  assert.equal("x402Enabled" in created.state.writes[0]!.data, false);
});

// ============================================
// Two edits at once
// ============================================

test("a switch turned on while another edit moved the listing to monthly is refused in its sentence, not by the database", async () => {
  const world = makeWorld({ listing: {} });
  const refusal = await withWorld(world, async (svc) => {
    meanwhile(world, (s) => s.updateListing(LISTING_ID, ORG, { pricingModel: "monthly", monthlyPriceCents: 900 }), svc);
    try {
      await svc.updateListing(LISTING_ID, ORG, { x402Enabled: true });
      return null;
    } catch (err) {
      assert.ok(err instanceof svc.ListingError, String(err));
      return { status: err.status, code: err.code, message: err.message, body: err.body };
    }
  });
  assert.deepEqual(refusal, onItsField(NOT_PER_USE_SENTENCE));
  assert.equal(world.state.checkRefusals, 0);
  assert.equal(listingOf(world)!.pricingModel, "monthly");
  assert.equal(listingOf(world)!.x402Enabled, false);
});

test("a change to monthly that read the switch off still writes it off, when another edit turned it on meanwhile", async () => {
  const world = makeWorld({ listing: {} });
  await withWorld(world, async (svc) => {
    meanwhile(world, (s) => s.updateListing(LISTING_ID, ORG, { x402Enabled: true }), svc);
    await svc.updateListing(LISTING_ID, ORG, { pricingModel: "monthly", monthlyPriceCents: 900 });
  });
  assert.equal(world.state.checkRefusals, 0);
  assert.deepEqual(
    world.state.writes.map((w) => w.data.x402Enabled),
    [true, false],
  );
  assert.equal(listingOf(world)!.pricingModel, "monthly");
  assert.equal(listingOf(world)!.x402Enabled, false);
});

// ============================================
// Who reads it
// ============================================

test("the owner's reads carry the switch; the public reads and getListingBySlug do not", async () => {
  const world = makeWorld({ listing: { x402Enabled: true } });
  await withWorld(world, async ({ getMyListings, getListingBySlug, getListingById }) => {
    const [mine] = await getMyListings(ORG, { listingPausedNow: async () => false });
    assert.equal(mine!.x402Enabled, true);

    const bySlug = (await getListingBySlug("research-analyst"))!;
    const byId = (await getListingById(LISTING_ID))!;
    for (const read of [bySlug, byId]) {
      assert.equal("x402Enabled" in read, false);
      assert.doesNotMatch(JSON.stringify(read, (_k, v) => (typeof v === "bigint" ? String(v) : v)), /x402/i);
    }
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, "../services/marketplace.ts"), "utf8");
  const start = source.indexOf("export async function getListingBySlug(");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.doesNotMatch(body, /x402/);
  const publicStart = source.indexOf("function formatListingForPublic(");
  const publicBody = source.slice(publicStart, source.indexOf("\n}\n", publicStart));
  assert.ok(publicStart > 0 && publicBody.length > 100);
  assert.doesNotMatch(publicBody, /x402/);
});

// ============================================
// What does not name it is what it was
// ============================================

test("an agent's create and change that do not name the switch write what they always wrote", async () => {
  const created = makeWorld();
  await withWorld(created, ({ createListing }) => createListing(ORG, "Pub Org", { ...BASE, ...PER_USE, allowedTools: ["calculator"] }));
  const { priorityPlacement: _p, ...data } = created.state.writes[0]!.data;
  assert.deepEqual(data, {
    agentId: AGENT_ID,
    title: "Research Analyst",
    slug: "research-analyst",
    shortDescription: "Reads filings and answers questions.",
    longDescription: undefined,
    category: "research",
    iconUrl: undefined,
    screenshots: [],
    readme: undefined,
    sells: "use",
    useAllowedTools: ["calculator"],
    pricingModel: "per_request",
    pricePerRequestCents: 5n,
    monthlyPriceCents: null,
    publisherId: ORG,
    publisherName: "Pub Org",
    status: "draft",
  });

  // Changes that keep use per request at a price, or move to it: the switch
  // is not written and the row is asked for by its id alone.
  const changes: Array<[Row, Row]> = [
    [{}, { title: "Analyst Pro" }],
    [{}, { pricePerRequestCents: 8 }],
    [{}, { allowedTools: ["calculator"] }],
    [{ x402Enabled: true }, { pricingModel: "per_request", pricePerRequestCents: 9, title: "Analyst Pro" }],
    [{ pricingModel: "free", pricePerRequestCents: null }, { pricingModel: "per_request", pricePerRequestCents: 5 }],
    [{ sells: "copies" }, { sells: "use" }],
  ];
  for (const [listing, params] of changes) {
    const world = makeWorld({ listing });
    const before = listingOf(world)!.x402Enabled;
    await withWorld(world, ({ updateListing }) => updateListing(LISTING_ID, ORG, params));
    assert.equal(world.state.writes.length, 1, JSON.stringify(params));
    assert.deepEqual(world.state.writes[0]!.where, { id: LISTING_ID });
    assert.equal("x402Enabled" in world.state.writes[0]!.data, false, JSON.stringify(params));
    assert.equal(listingOf(world)!.x402Enabled, before);
  }
});

// ============================================
// The routes
// ============================================

async function call(world: World, method: "POST" | "PATCH", url: string, payload: Row) {
  return withWorld(world, async () => {
    const Fastify = (await import("fastify")).default;
    const sensible = await import("@fastify/sensible");
    const { marketplaceRoutes } = await import("../routes/marketplace.js");
    const app = Fastify();
    await app.register(sensible.default);
    app.decorateRequest("auth", null);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { auth: unknown }).auth = { userId: "u1", orgId: ORG, type: "jwt", role: "owner" };
    });
    await app.register(marketplaceRoutes);
    try {
      const res = await app.inject({ method, url, payload });
      return { status: res.statusCode, body: res.json() as Row };
    } finally {
      await app.close();
    }
  });
}

test("POST and PATCH /listings take the switch and answer its refusal on its field", async () => {
  const created = makeWorld();
  const res = await call(created, "POST", "/listings", { ...BASE, ...PER_USE, x402Enabled: true });
  assert.equal(res.status, 201);
  assert.equal(res.body.listing.x402Enabled, true);

  const monthly = makeWorld({ listing: {} });
  const refused = await call(monthly, "PATCH", `/listings/${LISTING_ID}`, {
    pricingModel: "monthly",
    monthlyPriceCents: 900,
    x402Enabled: true,
  });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body, validationFailureFromFields({ x402Enabled: NOT_PER_USE_SENTENCE }));
  assert.equal(refused.body.message, NOT_PER_USE_SENTENCE);
  assert.deepEqual(refused.body.fields, { x402Enabled: NOT_PER_USE_SENTENCE });
  assert.equal(listingOf(monthly)!.pricingModel, "per_request");

  const off = makeWorld({ listing: { x402Enabled: true } });
  const saved = await call(off, "PATCH", `/listings/${LISTING_ID}`, { x402Enabled: false });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.listing.x402Enabled, false);
});

test("the field is read after the tools, outside the part of the schema the web reads, and a change takes it as it is", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const routes = readFileSync(path.join(here, "../routes/marketplace.ts"), "utf8");
  const pinned = routes.slice(routes.indexOf("const createListingSchema = z.object({"), routes.indexOf("pricingModel: z.enum("));
  assert.doesNotMatch(pinned, /x402/);
  const schema = routes.slice(routes.indexOf("const createListingSchema = z.object({"), routes.indexOf("\n});\n", routes.indexOf("const createListingSchema")));
  assert.match(schema, /allowedTools: z\.array\([^\n]*\n(\s+\/\/[^\n]*\n)+\s+x402Enabled: z\.boolean\(\)\.optional\(\),/);
  assert.match(routes, /const updateListingSchema = createListingSchema\.omit\(\{ agentId: true, orchestrationId: true \}\)\.partial\(\);/);
});
