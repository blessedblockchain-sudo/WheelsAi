import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

import { earningsStandIn, type EarningsRow } from "./earningsStandIn.js";

// Starting a plan on a creator's agent: POST /api/marketplace/listings/:id/use
// with `plan` in the body, through the route and the real services against an
// in-memory database. What these pin: the buyer's row gets its own copy of
// the terms, the 30 days are charged once and split 90 and 10, no agreement to
// a price per use is ever written by a plan start, terms that differ from the
// plan as it is now charge nothing and answer the plans as they are, and a
// body with no plan is the request it always was.

const DAY = 24 * 60 * 60 * 1000;
const LISTING_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_LISTING_ID = "22222222-2222-4222-8222-222222222222";
const STARTER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRO_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RETIRED_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const THEIRS_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const BUYER = "org_buyer";
const PUBLISHER = "org_pub";

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return cond.in.includes(v);
      if ("not" in cond) return v !== cond.not;
    }
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    return v === cond;
  });
}

const planRow = (over: Row): Row => ({
  listingId: LISTING_ID,
  kind: "paid",
  status: "active",
  retiredAt: null,
  ...over,
});

function makeWorld(opts: { listing?: Row; agent?: Row; install?: Row; sub?: Row; balance?: bigint; plans?: Row[] } = {}) {
  const state = {
    listing: {
      id: LISTING_ID,
      title: "Research Analyst",
      publisherId: PUBLISHER,
      status: "published",
      sells: "use",
      pricingModel: "per_request",
      pricePerRequestCents: 5n,
      monthlyPriceCents: null,
      pausedSince: null,
      totalInstalls: 0,
      activeInstalls: 0,
      ...opts.listing,
      agent: {
        id: "agent_src",
        orgId: PUBLISHER,
        name: "Analyst",
        publicHandle: "analyst",
        agentKind: "conversation",
        entrypoint: "chat",
        modelConfig: null,
        ...opts.agent,
      },
    } as Row,
    plans: (opts.plans ?? [
      planRow({ id: STARTER_ID, name: "Starter", priceCents: 900n, includedUses: 500, extraUsePriceCents: 5n, position: 1 }),
      planRow({ id: PRO_ID, name: "Pro", priceCents: 2900n, includedUses: 2000, extraUsePriceCents: null, position: 2 }),
      planRow({
        id: RETIRED_ID,
        name: "Old",
        priceCents: 500n,
        includedUses: 100,
        extraUsePriceCents: null,
        position: 3,
        status: "retired",
        retiredAt: new Date(0),
      }),
      planRow({ id: THEIRS_ID, listingId: OTHER_LISTING_ID, name: "Theirs", priceCents: 900n, includedUses: 500, extraUsePriceCents: 5n, position: 1 }),
    ]) as Row[],
    installs: (opts.install
      ? [
          {
            id: "ins_1",
            listingId: LISTING_ID,
            buyerId: BUYER,
            kind: "use",
            status: "active",
            clonedAgentId: null,
            uninstalledAt: null,
            totalRequests: 0n,
            totalSpentCents: 0n,
            acceptedPricingModel: null,
            acceptedPricePerRequestCents: null,
            pricingAcceptedAt: null,
            ...opts.install,
          },
        ]
      : []) as Row[],
    subs: (opts.sub
      ? [
          {
            id: "sub_1",
            listingId: LISTING_ID,
            subscriberId: BUYER,
            cancelAtPeriodEnd: false,
            cancelledAt: null,
            endReason: null,
            currentPeriodStart: new Date(Date.now() - 5 * DAY),
            ...opts.sub,
          },
        ]
      : []) as Row[],
    balance: opts.balance ?? 10_000n,
    ledger: [] as Row[],
    revenue: [] as Row[],
    accrued: 0n,
    earnings: [] as EarningsRow[],
  };
  let seq = 0;

  const earnings = earningsStandIn({
    pending: () => state.accrued,
    add: (_orgId, pending) => {
      state.accrued += pending;
    },
    write: (row) => state.earnings.push(row),
  });
  const planOf = (sub: Row) => state.plans.find((p) => p.id === sub.planId) ?? null;
  const subRead = (args: Row) => {
    const sub = state.subs[0];
    if (!sub) return null;
    const plan = planOf(sub);
    return { ...sub, ...((args?.include?.plan || args?.select?.plan) && { plan: plan && { status: plan.status, name: plan.name } }) };
  };

  const models: Row = {
    agentListing: {
      findUnique: async () => structuredClone(state.listing),
      update: async ({ data }: Row) => {
        for (const [k, v] of Object.entries<Row>(data)) {
          state.listing[k] += (v.increment ?? 0) - (v.decrement ?? 0);
        }
        return { ...state.listing };
      },
      aggregate: async () => ({ _count: { id: 1 }, _sum: { totalInstalls: state.listing.totalInstalls } }),
    },
    listingPlan: {
      findUnique: async ({ where }: Row) => {
        const row = state.plans.find((p) => p.id === where.id);
        return row ? { ...row } : null;
      },
      findMany: async ({ where }: Row) =>
        state.plans
          .filter((p) => matches(p, where))
          .sort((a, b) => a.position - b.position)
          .map((p) => ({ ...p })),
    },
    agentInstall: {
      findUnique: async () => (state.installs[0] ? { ...state.installs[0] } : null),
      updateMany: async ({ where, data }: Row) => {
        const hit = state.installs.filter((i) => matches(i, where));
        for (const i of hit) Object.assign(i, data);
        return { count: hit.length };
      },
      update: async ({ where, data }: Row) => {
        const row = state.installs.find((i) => i.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      },
      create: async ({ data }: Row) => {
        if (state.installs.length > 0) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        // Columns a start does not name are null, as the database leaves them.
        const row = {
          id: `ins_${++seq}`,
          uninstalledAt: null,
          totalRequests: 0n,
          totalSpentCents: 0n,
          acceptedPricingModel: null,
          acceptedPricePerRequestCents: null,
          pricingAcceptedAt: null,
          ...data,
        };
        state.installs.push(row);
        return { ...row };
      },
    },
    agentSubscription: {
      findUnique: async (args: Row) => subRead(args),
      create: async ({ data }: Row) => {
        if (state.subs.length > 0) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        const row = { id: `sub_${++seq}`, ...data };
        state.subs.push(row);
        return { ...row };
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = state.subs.filter((s) => matches(s, where));
        for (const s of hit) Object.assign(s, data);
        return { count: hit.length };
      },
    },
    creditBalance: {
      updateMany: async ({ where, data }: Row) => {
        if (state.balance < where.balanceCents.gte) return { count: 0 };
        state.balance -= data.balanceCents.decrement;
        return { count: 1 };
      },
      findUnique: async () => ({ balanceCents: state.balance }),
    },
    creditTransaction: {
      create: async ({ data }: Row) => {
        state.ledger.push(data);
        return data;
      },
    },
    marketplaceRevenue: {
      create: async ({ data }: Row) => {
        const row = { id: `rev_${++seq}`, ...data };
        state.revenue.push(row);
        return row;
      },
    },
    publisherProfile: {
      ...earnings.publisherProfile,
      findUnique: async (args: Row) =>
        args?.select?.pendingPayoutCents ? earnings.publisherProfile.findUnique(args as never) : null,
      update: async () => ({}),
    },
    earningsTransaction: earnings.earningsTransaction,
    // The spend guard reads the member's role as it is now.
    orgMember: { findUnique: async ({ where }: Row) => ({ role: where.orgId_userId.userId === "u_member" ? "member" : "owner" }) },
  };

  // One transaction at a time, as the row locks make it in Postgres; a
  // failed one leaves nothing behind.
  let tail: Promise<unknown> = Promise.resolve();
  models.$transaction = (fn: (tx: Row) => Promise<unknown>) => {
    const run = tail.then(async () => {
      const snapshot = structuredClone({
        listing: state.listing,
        installs: state.installs,
        subs: state.subs,
        balance: state.balance,
        ledger: state.ledger,
        revenue: state.revenue,
        accrued: state.accrued,
        earnings: state.earnings,
      });
      try {
        return await fn(models);
      } catch (err) {
        Object.assign(state, snapshot);
        throw err;
      }
    });
    tail = run.catch(() => {});
    return run;
  };
  return { state, models };
}

type World = ReturnType<typeof makeWorld>;

async function withWorld<T>(world: World, body: () => Promise<T>): Promise<T> {
  const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Row };
  const originals: Row = {};
  for (const [name, fake] of Object.entries(world.models)) {
    originals[name] = prisma[name];
    prisma[name] = fake;
  }
  try {
    const result = await body();
    // Let the fire-and-forget reputation recalculation settle on the fakes.
    await new Promise((resolve) => setImmediate(resolve));
    return result;
  } finally {
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

const OWNER = { userId: "u_owner", orgId: BUYER, type: "jwt", role: "owner" };

/** POST /listings/:id/use over the world, with the app's own spend guard. */
async function use(world: World, payload: Row, principal: Row = OWNER) {
  return withWorld(world, async () => {
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
    try {
      const res = await app.inject({ method: "POST", url: `/listings/${LISTING_ID}/use`, payload });
      return { status: res.statusCode, body: res.json() as Row };
    } finally {
      await app.close();
    }
  });
}

const STARTER = { id: STARTER_ID, priceCents: 900, includedUses: 500, extraUsePriceCents: 5 };
const PRO = { id: PRO_ID, priceCents: 2900, includedUses: 2000, extraUsePriceCents: null };
/** The plans on offer, as a refusal answers them. */
const ON_OFFER = [
  { id: STARTER_ID, name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: 5 },
  { id: PRO_ID, name: "Pro", priceCents: 2900, includedUses: 2000, extraUsePriceCents: null },
];
const PER_USE = { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null };
/** Nothing was charged and nothing was written. */
const untouched = (world: World, balance = 10_000n) => {
  assert.equal(world.state.balance, balance);
  assert.deepEqual([world.state.ledger.length, world.state.revenue.length, world.state.accrued], [0, 0, 0n]);
};

// ============================================
// A start
// ============================================

test("starting a plan copies its terms onto the buyer's row, charges the 30 days once, and splits them 90 and 10", async () => {
  const world = makeWorld();
  const before = Date.now();
  const res = await use(world, { plan: STARTER });
  assert.equal(res.status, 201);
  assert.equal(res.body.access, "subscribed");
  assert.equal(res.body.subscription.priceCents, 900);
  assert.equal(res.body.subscription.hasAccess, true);
  assert.deepEqual(res.body.agent, { handle: "analyst", name: "Analyst", agentKind: "conversation" });
  assert.equal("created" in res.body, false);

  // The buyer's own copy of the terms, and a count that starts at zero.
  const sub = world.state.subs[0]!;
  assert.deepEqual(
    [sub.status, sub.planId, sub.priceCents, sub.includedUses, sub.extraUsePriceCents, sub.usedInPeriod, sub.carriedUses, sub.warnedLevel],
    ["active", STARTER_ID, 900n, 500, 5n, 0, 0, 0],
  );
  assert.equal(sub.cancelAtPeriodEnd, false);
  // 30 days from now.
  const length = sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime();
  assert.equal(length, 30 * DAY);
  assert.ok(sub.currentPeriodStart.getTime() >= before);

  // Charged once, from credits, on the path a month takes.
  assert.equal(world.state.balance, 9_100n);
  assert.deepEqual(world.state.ledger.map((row) => [row.type, row.amountCents]), [["marketplace_subscription", -900n]]);
  assert.deepEqual(
    world.state.revenue.map((row) => [row.type, row.grossAmountCents, row.creatorAmountCents, row.platformFeeCents, row.installId]),
    [["subscription", 900n, 810n, 90n, world.state.installs[0]!.id]],
  );
  assert.deepEqual(
    world.state.earnings.map((row) => [row.orgId, row.type, row.amountCents]),
    [[PUBLISHER, "subscription", 810n]],
  );

  // A licence for use, with no copy and no agreement to a price per use.
  const licence = world.state.installs[0]!;
  assert.deepEqual([licence.kind, licence.status, licence.clonedAgentId], ["use", "active", null]);
  assert.equal(licence.acceptedPricingModel, null);
  assert.equal(licence.acceptedPricePerRequestCents, null);
  assert.equal(licence.pricingAcceptedAt, null);
  assert.deepEqual(res.body.acceptedPricing, { pricingModel: null, pricePerRequestCents: null, acceptedAt: null });
  assert.deepEqual([world.state.listing.totalInstalls, world.state.listing.activeInstalls], [1, 1]);
});

test("a plan that stops is started with no price for an extra use, and an API key granted the spend scope may start one", async () => {
  const world = makeWorld();
  const key = { userId: null, orgId: BUYER, type: "api_key", apiKeyId: "key_1", scopes: ["marketplace:install"] };
  const res = await use(world, { plan: PRO }, key);
  assert.equal(res.status, 201);
  assert.deepEqual(
    [world.state.subs[0]!.planId, world.state.subs[0]!.includedUses, world.state.subs[0]!.extraUsePriceCents],
    [PRO_ID, 2000, null],
  );
  assert.equal(world.state.balance, 7_100n);

  // A key without the scope, and a member who is not an owner or admin, start nothing.
  const scopeless = makeWorld();
  const refused = await use(scopeless, { plan: PRO }, { ...key, scopes: ["agents:use"] });
  assert.deepEqual([refused.status, refused.body.error], [403, "missing_scope"]);
  const member = await use(scopeless, { plan: PRO }, { userId: "u_member", orgId: BUYER, type: "jwt" });
  assert.deepEqual([member.status, member.body.error], [403, "insufficient_role"]);
  untouched(scopeless);
  assert.equal(scopeless.state.subs.length, 0);
});

test("a buyer who already agreed to a price per use keeps that agreement when they start a plan", async () => {
  const agreedAt = new Date("2026-10-01T00:00:00Z");
  const world = makeWorld({
    install: { acceptedPricingModel: "per_request", acceptedPricePerRequestCents: 5n, pricingAcceptedAt: agreedAt },
  });
  world.state.listing.totalInstalls = 1;
  world.state.listing.activeInstalls = 1;
  const res = await use(world, { plan: STARTER });
  assert.equal(res.status, 201);
  const licence = world.state.installs[0]!;
  assert.deepEqual(
    [licence.kind, licence.acceptedPricingModel, licence.acceptedPricePerRequestCents, licence.pricingAcceptedAt],
    ["use", "per_request", 5n, agreedAt],
  );
  assert.equal(world.state.balance, 9_100n);
  // Already counted as a buyer: not counted twice.
  assert.deepEqual([world.state.listing.totalInstalls, world.state.listing.activeInstalls], [1, 1]);
});

test("a licence that was stopped, and one whose plan lapsed, start again on the same rows", async () => {
  const stopped = makeWorld({
    install: { status: "uninstalled", uninstalledAt: new Date(0) },
    sub: { status: "cancelled", currentPeriodEnd: new Date(Date.now() + 10 * DAY), priceCents: 900n, planId: STARTER_ID, includedUses: 500, usedInPeriod: 400, carriedUses: 0, extraUsePriceCents: 5n },
  });
  assert.equal((await use(stopped, { plan: PRO })).status, 201);
  assert.equal(stopped.state.installs.length, 1);
  assert.equal(stopped.state.installs[0]!.status, "active");
  assert.equal(stopped.state.subs.length, 1);
  // The new plan's terms, and the count from zero: nothing of the old period is left.
  const sub = stopped.state.subs[0]!;
  assert.deepEqual([sub.status, sub.planId, sub.includedUses, sub.usedInPeriod, sub.extraUsePriceCents, sub.priceCents], ["active", PRO_ID, 2000, 0, null, 2900n]);
  assert.equal(stopped.state.balance, 7_100n);
  assert.equal(stopped.state.listing.activeInstalls, 1);

  const lapsed = makeWorld({
    install: { status: "suspended" },
    sub: { status: "expired", currentPeriodEnd: new Date(Date.now() - 10 * DAY), priceCents: 900n, planId: STARTER_ID, includedUses: 500, usedInPeriod: 500, carriedUses: 0, extraUsePriceCents: 5n },
  });
  assert.equal((await use(lapsed, { plan: STARTER })).status, 201);
  assert.deepEqual([lapsed.state.installs[0]!.status, lapsed.state.subs[0]!.status, lapsed.state.subs[0]!.usedInPeriod], ["active", "active", 0]);
  // A lapsed licence was never uncounted, so it is not counted again.
  assert.equal(lapsed.state.listing.activeInstalls, 0);
});

// ============================================
// Terms that are not the plan as it is now
// ============================================

test("terms that differ from the plan as it is now: 409 with the plans as they are, and nothing charged", async () => {
  for (const shown of [
    { ...STARTER, priceCents: 800 },
    // A cheaper plan than shown is also not what the person confirmed.
    { ...STARTER, priceCents: 1000 },
    { ...STARTER, includedUses: 400 },
    { ...STARTER, extraUsePriceCents: null },
    { ...STARTER, extraUsePriceCents: 6 },
    { ...PRO, extraUsePriceCents: 5 },
  ]) {
    const world = makeWorld();
    const res = await use(world, { plan: shown });
    assert.equal(res.status, 409, JSON.stringify(shown));
    assert.deepEqual(res.body, {
      error: "pricing_changed",
      message: 'The plans of "Research Analyst" are not what you were shown. Nothing was charged. Look at them again and choose.',
      pricing: PER_USE,
      plans: ON_OFFER,
    });
    untouched(world);
    assert.deepEqual([world.state.installs.length, world.state.subs.length], [0, 0]);
  }
});

test("a plan its creator ended, a plan of another listing and a plan that does not exist are each 409 pricing_changed with nothing charged", async () => {
  for (const id of [RETIRED_ID, THEIRS_ID, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]) {
    const world = makeWorld();
    // Sent with the terms that row really has: it is still not a plan this listing offers.
    const row = world.state.plans.find((p) => p.id === id);
    const res = await use(world, {
      plan: {
        id,
        priceCents: Number(row?.priceCents ?? 900n),
        includedUses: row?.includedUses ?? 500,
        extraUsePriceCents: row?.extraUsePriceCents == null ? null : Number(row.extraUsePriceCents),
      },
    });
    assert.deepEqual([res.status, res.body.error, res.body.plans], [409, "pricing_changed", ON_OFFER], id);
    // Neither the ended plan nor the other listing's is among what is offered.
    assert.doesNotMatch(JSON.stringify(res.body), /Old|Theirs/);
    untouched(world);
    assert.equal(world.state.subs.length, 0);
  }
});

test("a listing that is no longer sold per use offers no plan to start: 409 with its pricing as it is and no plans", async () => {
  const world = makeWorld({ listing: { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 1500n } });
  const res = await use(world, { plan: STARTER });
  assert.equal(res.status, 409);
  assert.deepEqual([res.body.error, res.body.pricing, res.body.plans], [
    "pricing_changed",
    { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 1500 },
    [],
  ]);
  untouched(world);
});

test("a plan changed between the look and the charge is refused inside the transaction, and the licence it claimed is rolled back", async () => {
  const world = makeWorld({ install: { status: "uninstalled", uninstalledAt: new Date(0) } });
  // The creator's save lands after the start's first look at the plan.
  const realFind = world.models.listingPlan.findUnique;
  let looks = 0;
  world.models.listingPlan.findUnique = async (args: Row) => {
    if (++looks === 2) world.state.plans.find((p) => p.id === STARTER_ID)!.priceCents = 1200n;
    return realFind(args);
  };
  const res = await use(world, { plan: STARTER });
  assert.deepEqual([res.status, res.body.error], [409, "pricing_changed"]);
  assert.equal(res.body.plans[0].priceCents, 1200);
  untouched(world);
  assert.equal(world.state.installs[0]!.status, "uninstalled");
  assert.equal(world.state.subs.length, 0);
});

// ============================================
// Refused before anything is charged
// ============================================

test("already on a plan: 409 already_on_plan in a plain sentence, and no second charge", async () => {
  const world = makeWorld();
  assert.equal((await use(world, { plan: STARTER })).status, 201);
  for (const plan of [STARTER, PRO]) {
    const again = await use(world, { plan });
    assert.deepEqual([again.status, again.body], [
      409,
      {
        error: "already_on_plan",
        message: "You already have a plan or a subscription for this agent that is still running. Nothing was charged.",
      },
    ]);
  }
  assert.equal(world.state.balance, 9_100n);
  assert.equal(world.state.ledger.length, 1);
  assert.equal(world.state.subs[0]!.planId, STARTER_ID);

  // A month paid for before the listing was sold per use still runs: the same answer.
  const month = makeWorld({
    install: { acceptedPricingModel: "monthly" },
    sub: { status: "active", currentPeriodEnd: new Date(Date.now() + 10 * DAY), priceCents: 900n },
  });
  const res = await use(month, { plan: STARTER });
  assert.deepEqual([res.status, res.body.error], [409, "already_on_plan"]);
  untouched(month);
});

test("two starts at the same moment charge one plan", async () => {
  const world = makeWorld();
  await withWorld(world, async () => {
    const { startPlan } = await import("../services/planStart.js");
    const shown = { id: STARTER_ID, priceCents: 900n, includedUses: 500, extraUsePriceCents: 5n };
    const results = await Promise.allSettled([startPlan(LISTING_ID, BUYER, shown), startPlan(LISTING_ID, BUYER, shown)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    const lost = (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
    assert.ok(["subscription_claim_lost", "already_on_plan"].includes(lost.code), String(lost));
  });
  assert.equal(world.state.balance, 9_100n);
  assert.deepEqual([world.state.ledger.length, world.state.revenue.length, world.state.subs.length, world.state.installs.length], [1, 1, 1, 1]);
  assert.equal(world.state.listing.activeInstalls, 1);
});

test("not enough credits: 402 worded for a plan, and no licence, subscription or charge is left", async () => {
  const world = makeWorld({ balance: 899n });
  const res = await use(world, { plan: STARTER });
  assert.deepEqual([res.status, res.body], [
    402,
    {
      error: "insufficient_credits",
      message: "You do not have enough credits for this plan ($9.00 for 30 days). Nothing was charged. Add credits to continue.",
      requiredCents: 900,
    },
  ]);
  untouched(world, 899n);
  assert.deepEqual([world.state.installs.length, world.state.subs.length, world.state.listing.activeInstalls], [0, 0, 0]);
});

test("a paused listing, the creator's own listing, a listing that sells copies and one that was taken down start no plan", async () => {
  const refusal = async (world: World, hooks: Row = {}, buyer = BUYER) =>
    withWorld(world, async () => {
      const { startPlan } = await import("../services/planStart.js");
      const { UseStartError } = await import("../services/marketplace.js");
      try {
        await startPlan(LISTING_ID, buyer, { id: STARTER_ID, priceCents: 900n, includedUses: 500, extraUsePriceCents: 5n }, hooks as never);
        return null;
      } catch (err) {
        assert.ok(err instanceof UseStartError, String(err));
        return [err.status, err.code, err.message];
      }
    });

  const paused = makeWorld();
  assert.deepEqual(await refusal(paused, { listingPausedNow: async () => true }), [
    409,
    "listing_paused",
    (await import("../services/marketplace.js")).USE_START_MESSAGES.paused,
  ]);
  untouched(paused);
  // When it cannot be asked, nobody is charged either.
  const unknown = makeWorld();
  const cannot = await refusal(unknown, {
    listingPausedNow: async () => {
      throw new Error("the model could not be asked");
    },
  });
  assert.deepEqual(cannot?.slice(0, 2), [503, "service_unavailable"]);
  untouched(unknown);
  // A pause that is over but still marked is cleared first; if that fails, nothing starts.
  const marked = makeWorld({ listing: { pausedSince: new Date(Date.now() - DAY) } });
  const stuck = await refusal(marked, { listingPausedNow: async () => false, reconcileListingPauses: async () => ({ errors: 1 }) });
  assert.deepEqual(stuck?.slice(0, 2), [503, "service_unavailable"]);
  untouched(marked);

  const own = makeWorld();
  assert.deepEqual(await refusal(own, {}, PUBLISHER), [409, "own_agent", "This is your agent. You do not pay to use it."]);
  const copies = makeWorld({ listing: { sells: "copies" } });
  assert.deepEqual((await refusal(copies))?.slice(0, 2), [409, "sells_copies"]);
  const archived = makeWorld({ listing: { status: "archived" } });
  assert.deepEqual((await refusal(archived))?.slice(0, 2), [404, "listing_not_found"]);
  const graph = makeWorld({ agent: { entrypoint: "graph" } });
  assert.deepEqual((await refusal(graph))?.slice(0, 2), [409, "not_offered"]);
  for (const world of [own, copies, archived, graph]) {
    untouched(world);
    assert.equal(world.state.subs.length, 0);
  }

  // The same through the route, for a buyer's page.
  const viaRoute = await use(makeWorld({ listing: { sells: "copies" } }), { plan: STARTER });
  assert.deepEqual([viaRoute.status, viaRoute.body.error], [409, "sells_copies"]);
});

test("a copy with a month paid for stops a plan start as it stops any start", async () => {
  const until = new Date(Date.now() + 10 * DAY);
  const world = makeWorld({
    install: { kind: "copy", clonedAgentId: "agent_copy", acceptedPricingModel: "monthly" },
    sub: { status: "active", currentPeriodEnd: until, priceCents: 900n },
  });
  const res = await use(world, { plan: STARTER });
  assert.deepEqual([res.status, res.body.error, res.body.until], [409, "copy_subscription_active", until.toISOString()]);
  untouched(world);
  assert.equal(world.state.installs[0]!.kind, "copy");
});

test("a plan started over a licence for a copy bought per request: the licence is for use, its agreement is cleared, and the copy stays on the row", async () => {
  const world = makeWorld({
    install: {
      kind: "copy",
      clonedAgentId: "agent_copy",
      acceptedPricingModel: "per_request",
      acceptedPricePerRequestCents: 5n,
      pricingAcceptedAt: new Date("2026-10-01T00:00:00Z"),
    },
  });
  world.state.listing.totalInstalls = 1;
  world.state.listing.activeInstalls = 1;
  const res = await use(world, { plan: STARTER });
  assert.equal(res.status, 201);
  const licence = world.state.installs[0]!;
  // The price per request was agreed to for the copy, not for use of the
  // creator's agent: it is not carried into what comes after the plan.
  assert.deepEqual(
    [licence.kind, licence.status, licence.acceptedPricingModel, licence.acceptedPricePerRequestCents, licence.pricingAcceptedAt],
    ["use", "active", null, null, null],
  );
  // The copy is still named on the row. What it may do while the plan runs
  // is the metering's to say (tests/marketplaceMetering.unit.test.ts).
  assert.equal(licence.clonedAgentId, "agent_copy");
  // The 30 days, once.
  assert.equal(world.state.balance, 9_100n);
  assert.deepEqual([world.state.ledger.length, world.state.revenue.length], [1, 1]);
  assert.deepEqual([world.state.subs.length, world.state.subs[0]!.planId, world.state.subs[0]!.includedUses], [1, STARTER_ID, 500]);
  // Already counted as a buyer: not counted twice.
  assert.deepEqual([world.state.listing.totalInstalls, world.state.listing.activeInstalls], [1, 1]);
});

// ============================================
// The body
// ============================================

test("a body that names switchNow never starts a plan, and a plan that is not sent whole is not guessed", async () => {
  const world = makeWorld();
  // A move is for a buyer who is on a plan. This one is not: nothing is
  // started for them under that word (tests/planMove.unit.test.ts has the move).
  const move = await use(world, { plan: PRO, switchNow: true });
  assert.deepEqual([move.status, move.body], [409, { error: "not_on_plan", message: "You are not on a plan. Start one first." }]);
  const notTrue = await use(world, { plan: PRO, switchNow: false });
  assert.deepEqual([notTrue.status, notTrue.body.error], [400, "invalid_plan_move"]);
  for (const plan of [
    { id: STARTER_ID, priceCents: 900, includedUses: 500 },
    { ...STARTER, priceCents: 9.5 },
    { ...STARTER, includedUses: 0 },
    { ...STARTER, id: "starter" },
    { ...STARTER, extraUsePriceCents: "5" },
    null,
    "starter",
  ]) {
    const res = await use(world, { plan, expected: PER_USE });
    assert.deepEqual([res.status, res.body.error], [400, "expected_terms_required"], JSON.stringify(plan));
    assert.match(res.body.message, /^Send the plan you were shown/);
  }
  untouched(world);
  assert.deepEqual([world.state.installs.length, world.state.subs.length], [0, 0]);
});

test("with no plan in the body the request is what it was: a price per use is agreed to and nothing is charged", async () => {
  const world = makeWorld();
  const res = await use(world, { expected: PER_USE });
  assert.equal(res.status, 201);
  assert.equal(res.body.access, "listing_pricing");
  assert.equal(res.body.subscription, null);
  assert.equal(world.state.installs[0]!.acceptedPricingModel, "per_request");
  assert.equal(world.state.installs[0]!.acceptedPricePerRequestCents, 5n);
  untouched(world);
  assert.equal(world.state.subs.length, 0);

  // And without the terms shown, nothing is agreed to, as before.
  const bare = await use(makeWorld(), {});
  assert.deepEqual([bare.status, bare.body.error], [400, "expected_terms_required"]);
  assert.match(bare.body.message, /^Send the price you were shown/);
});

test("a plan start sent with the price per use as well agrees to the plan only", async () => {
  const world = makeWorld();
  const res = await use(world, { plan: STARTER, expected: PER_USE, acceptNewPricing: true });
  assert.equal(res.status, 201);
  assert.equal(world.state.installs[0]!.acceptedPricingModel, null);
  assert.equal(world.state.installs[0]!.acceptedPricePerRequestCents, null);
  assert.equal(world.state.subs[0]!.planId, STARTER_ID);
});
