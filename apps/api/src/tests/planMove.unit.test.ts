import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

import { earningsStandIn, type EarningsRow } from "./earningsStandIn.js";

// Moving up to a bigger plan: POST /api/marketplace/listings/:id/use with
// `plan` and `switchNow: true`, through the route and the real services
// against an in-memory database, and the claim itself (movePlanSubscription)
// against a renewal, a use and another move that change the row under it.
// What these pin: one row claimed once; the new plan's price charged once
// and split 90 and 10; the uses that were left carried, capped at what the
// old plan included, and dropped by the next renewal; the buyer's choice
// about renewal kept; and nothing charged or changed by any refusal.

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const LISTING_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_LISTING_ID = "22222222-2222-4222-8222-222222222222";
const STARTER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRO_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RETIRED_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const THEIRS_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TWIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const MAX_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const BUYER = "org_buyer";
const PUBLISHER = "org_pub";

type Row = Record<string, any>;

const planRow = (over: Row): Row => ({
  listingId: LISTING_ID,
  kind: "paid",
  status: "active",
  retiredAt: null,
  ...over,
});

/** The buyer's row on Starter: 500 uses for $9.00, 312 of them taken, 25 days left. */
const onStarter = (over: Row = {}): Row => ({
  status: "active",
  currentPeriodStart: new Date(Date.now() - 5 * DAY),
  currentPeriodEnd: new Date(Date.now() + 25 * DAY),
  priceCents: 900n,
  planId: STARTER_ID,
  includedUses: 500,
  extraUsePriceCents: 5n,
  usedInPeriod: 312,
  carriedUses: 0,
  warnedLevel: 0,
  lastRenewalAttemptAt: null,
  ...over,
});

function makeWorld(opts: { listing?: Row; install?: Row | null; sub?: Row | null; balance?: bigint } = {}) {
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
      totalInstalls: 1,
      activeInstalls: 1,
      ...opts.listing,
      agent: {
        id: "agent_src",
        orgId: PUBLISHER,
        name: "Analyst",
        publicHandle: "analyst",
        agentKind: "conversation",
        entrypoint: "chat",
        modelConfig: null,
      },
    } as Row,
    plans: [
      planRow({ id: STARTER_ID, name: "Starter", priceCents: 900n, includedUses: 500, extraUsePriceCents: 5n, position: 1 }),
      planRow({ id: TWIN_ID, name: "Twin", priceCents: 900n, includedUses: 800, extraUsePriceCents: null, position: 2 }),
      planRow({ id: PRO_ID, name: "Pro", priceCents: 2900n, includedUses: 2000, extraUsePriceCents: null, position: 3 }),
      planRow({ id: MAX_ID, name: "Max", priceCents: 4900n, includedUses: 5000, extraUsePriceCents: 2n, position: 4 }),
      planRow({
        id: RETIRED_ID,
        name: "Old",
        priceCents: 9900n,
        includedUses: 100,
        extraUsePriceCents: null,
        position: 5,
        status: "retired",
        retiredAt: new Date(0),
      }),
      planRow({ id: THEIRS_ID, listingId: OTHER_LISTING_ID, name: "Theirs", priceCents: 2900n, includedUses: 2000, extraUsePriceCents: null, position: 1 }),
    ] as Row[],
    installs: (opts.install === null
      ? []
      : [
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
        ]) as Row[],
    subs: (opts.sub === null
      ? []
      : [
          {
            id: "sub_1",
            listingId: LISTING_ID,
            subscriberId: BUYER,
            cancelAtPeriodEnd: false,
            cancelledAt: null,
            endReason: null,
            ...onStarter(),
            ...opts.sub,
          },
        ]) as Row[],
    balance: opts.balance ?? 10_000n,
    ledger: [] as Row[],
    revenue: [] as Row[],
    accrued: 0n,
    earnings: [] as EarningsRow[],
  };
  let seq = 0;
  /** Run once, just after the next read of the buyer's row: what another writer does in between. */
  const between: { run: (() => Promise<void>) | null } = { run: null };

  const earnings = earningsStandIn({
    pending: () => state.accrued,
    add: (_orgId, pending) => {
      state.accrued += pending;
    },
    write: (row) => state.earnings.push(row),
  });
  const planOf = (sub: Row) => state.plans.find((p) => p.id === sub.planId) ?? null;

  /** A row against a where: equality, dates, `in`, `lt`, `gt`, `gte`, and the two relations a renewal names. */
  function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([k, cond]) => {
      if (k === "listing") return matches(state.listing, cond);
      if (k === "plan") {
        const plan = planOf(row);
        return plan !== null && matches(plan, cond);
      }
      const v = row[k];
      if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
      if (cond && typeof cond === "object") {
        if ("in" in cond) return cond.in.includes(v);
        if ("lt" in cond) return v < cond.lt;
        if ("gt" in cond) return v > cond.gt;
        if ("gte" in cond) return v >= cond.gte;
      }
      return v === cond;
    });
  }
  const write = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries<any>(data)) {
      if (v && typeof v === "object" && !(v instanceof Date) && ("increment" in v || "decrement" in v)) {
        row[k] += (v.increment ?? 0) - (v.decrement ?? 0);
      } else {
        row[k] = v;
      }
    }
  };

  const models: Row = {
    agentListing: {
      findUnique: async () => structuredClone(state.listing),
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
        for (const i of hit) write(i, data);
        return { count: hit.length };
      },
    },
    agentSubscription: {
      findUnique: async (args: Row) => {
        const sub = state.subs[0];
        const plan = sub ? planOf(sub) : null;
        const read = sub ? { ...sub, ...(args?.include?.plan && { plan: plan && { status: plan.status } }) } : null;
        const run = between.run;
        if (run) {
          between.run = null;
          await run();
        }
        return read;
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = state.subs.filter((s) => matches(s, where));
        for (const s of hit) write(s, data);
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
    // Asked for a caller with an API key; none here has a WheelsAI plan of its own.
    orgSubscription: { findUnique: async () => null },
    // The spend guard reads the member's role as it is now.
    orgMember: { findUnique: async ({ where }: Row) => ({ role: where.orgId_userId.userId === "u_member" ? "member" : "owner" }) },
  };

  // One transaction at a time, as the row locks make it in Postgres; a
  // failed one leaves nothing behind.
  let tail: Promise<unknown> = Promise.resolve();
  models.$transaction = (fn: (tx: Row) => Promise<unknown>) => {
    const run = tail.then(async () => {
      const snapshot = structuredClone({
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
  return { state, models, between };
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
    return await body();
  } finally {
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

const OWNER = { userId: "u_owner", orgId: BUYER, type: "jwt", role: "owner" };

/** POST /listings/:id/use over the world, with the app's own spend guard. Several bodies are sent at the same moment. */
async function useAll(world: World, payloads: Row[], principal: Row = OWNER) {
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
      return await Promise.all(
        payloads.map(async (payload) => {
          const res = await app.inject({ method: "POST", url: `/listings/${LISTING_ID}/use`, payload });
          return { status: res.statusCode, body: res.json() as Row };
        }),
      );
    } finally {
      await app.close();
    }
  });
}

const use = async (world: World, payload: Row, principal: Row = OWNER) => (await useAll(world, [payload], principal))[0]!;

const STARTER = { id: STARTER_ID, priceCents: 900, includedUses: 500, extraUsePriceCents: 5 };
const TWIN = { id: TWIN_ID, priceCents: 900, includedUses: 800, extraUsePriceCents: null };
const PRO = { id: PRO_ID, priceCents: 2900, includedUses: 2000, extraUsePriceCents: null };
const MAX = { id: MAX_ID, priceCents: 4900, includedUses: 5000, extraUsePriceCents: 2 };
const up = (plan: Row) => ({ plan, switchNow: true });

/** The terms of Pro and of Max, as the claim takes them. */
const PRO_TERMS = { planId: PRO_ID, priceCents: 2900n, includedUses: 2000, extraUsePriceCents: null };
const MAX_TERMS = { planId: MAX_ID, priceCents: 4900n, includedUses: 5000, extraUsePriceCents: 2n };
const LISTING = { id: LISTING_ID, title: "Research Analyst", publisherId: PUBLISHER };

/**
 * A refusal: the status and code, and that nothing was charged and the
 * buyer's rows are what they were.
 */
async function refused(world: World, payload: Row, principal: Row = OWNER) {
  const before = structuredClone({ subs: world.state.subs, installs: world.state.installs, balance: world.state.balance });
  const res = await use(world, payload, principal);
  assert.deepEqual(
    { subs: world.state.subs, installs: world.state.installs, balance: world.state.balance },
    before,
    `rows or balance changed by a refusal: ${JSON.stringify(res.body)}`,
  );
  assert.deepEqual([world.state.ledger.length, world.state.revenue.length, world.state.accrued], [0, 0, 0n]);
  return res;
}

// ============================================
// A move
// ============================================

test("moving up charges the new plan once, split 90 and 10, starts a fresh 30 days and carries the uses that were left", async () => {
  const world = makeWorld();
  const before = Date.now();
  const res = await use(world, up(PRO));
  assert.equal(res.status, 201);
  // The answer of a start: the buyer's state.
  assert.equal(res.body.access, "subscribed");
  assert.equal(res.body.subscription.priceCents, 2900);
  assert.equal(res.body.subscription.status, "active");
  assert.deepEqual(res.body.agent, { handle: "analyst", name: "Analyst", agentKind: "conversation" });
  assert.equal("created" in res.body, false);

  // The same row, on the new plan's terms, with a count of zero and the 188
  // uses that were left of 500.
  assert.equal(world.state.subs.length, 1);
  const sub = world.state.subs[0]!;
  assert.deepEqual(
    [sub.id, sub.status, sub.planId, sub.priceCents, sub.includedUses, sub.extraUsePriceCents, sub.usedInPeriod, sub.carriedUses, sub.warnedLevel],
    ["sub_1", "active", PRO_ID, 2900n, 2000, null, 0, 188, 0],
  );
  assert.equal(sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime(), 30 * DAY);
  assert.ok(sub.currentPeriodStart.getTime() >= before && sub.currentPeriodStart.getTime() <= Date.now());

  // The full price of the new plan, once. Nothing of the old period comes back.
  assert.equal(world.state.balance, 7_100n);
  assert.deepEqual(world.state.ledger.map((row) => [row.type, row.amountCents, row.balanceAfter]), [
    ["marketplace_subscription", -2900n, 7_100n],
  ]);
  assert.deepEqual(
    world.state.revenue.map((row) => [row.type, row.status, row.grossAmountCents, row.creatorAmountCents, row.platformFeeCents, row.installId, row.subscriptionId]),
    [["subscription", "settled", 2900n, 2610n, 290n, "ins_1", "sub_1"]],
  );
  assert.deepEqual(world.state.earnings.map((row) => [row.orgId, row.type, row.amountCents]), [[PUBLISHER, "subscription", 2610n]]);

  // The licence is what it was: a move agrees to no price per use.
  const licence = world.state.installs[0]!;
  assert.deepEqual(
    [licence.kind, licence.status, licence.acceptedPricingModel, licence.acceptedPricePerRequestCents, licence.pricingAcceptedAt],
    ["use", "active", null, null, null],
  );
  assert.deepEqual([world.state.listing.totalInstalls, world.state.listing.activeInstalls], [1, 1]);
});

test("carried uses are what was left, at most what the old plan included, and never below zero", async () => {
  const carriedAfter = async (sub: Row) => {
    const world = makeWorld({ sub });
    const res = await use(world, up(PRO));
    assert.equal(res.status, 201);
    return world.state.subs[0]!.carriedUses;
  };
  assert.equal(await carriedAfter({ usedInPeriod: 0 }), 500);
  assert.equal(await carriedAfter({ usedInPeriod: 499 }), 1);
  assert.equal(await carriedAfter({ usedInPeriod: 500 }), 0);
  // 100 uses came in with an earlier move. 550 are left, and 500 are carried:
  // a use that was carried once is not carried again.
  assert.equal(await carriedAfter({ usedInPeriod: 50, carriedUses: 100 }), 500);
  assert.equal(await carriedAfter({ usedInPeriod: 450, carriedUses: 100 }), 150);
  assert.equal(await carriedAfter({ usedInPeriod: 600, carriedUses: 100 }), 0);
  // A count that somehow ran past its limit carries nothing, not a negative number.
  assert.equal(await carriedAfter({ usedInPeriod: 700, carriedUses: 100 }), 0);

  // Two moves in a row: Starter to Pro carries 188, and 100 uses later Pro to
  // Max carries the 2,000 Pro included, not the 2,088 that were left.
  const world = makeWorld();
  assert.equal((await use(world, up(PRO))).status, 201);
  world.state.subs[0]!.usedInPeriod = 100;
  assert.equal((await use(world, up(MAX))).status, 201);
  const sub = world.state.subs[0]!;
  assert.deepEqual([sub.planId, sub.priceCents, sub.extraUsePriceCents, sub.usedInPeriod, sub.carriedUses], [MAX_ID, 4900n, 2n, 0, 2000]);
  assert.deepEqual(world.state.revenue.map((row) => row.grossAmountCents), [2900n, 4900n]);
});

test("the next renewal charges the new plan's price and drops the carried uses", async () => {
  const { renewSubscription } = await import("../services/marketplaceSubscriptions.js");
  const world = makeWorld();
  assert.equal((await use(world, up(PRO))).status, 201);
  const sub = world.state.subs[0]!;
  assert.equal(sub.carriedUses, 188);
  sub.usedInPeriod = 40;
  sub.warnedLevel = 85;

  const due = new Date(sub.currentPeriodEnd.getTime() + HOUR);
  const outcome = await renewSubscription(world.models as never, {
    sub: { ...sub, licenceKind: "use", planRetired: false } as never,
    listing: { ...LISTING, monthlyPriceCents: 0n, pricingModel: "per_request", status: "published", sells: "use", pausedSince: null },
    now: due,
  });
  assert.equal(outcome.kind, "renewed");
  assert.deepEqual(
    [sub.planId, sub.includedUses, sub.usedInPeriod, sub.carriedUses, sub.warnedLevel],
    [PRO_ID, 2000, 0, 0, 0],
  );
  assert.deepEqual(world.state.revenue.map((row) => [row.type, row.grossAmountCents]), [
    ["subscription", 2900n],
    ["subscription_renewal", 2900n],
  ]);
});

test("the buyer's choice about renewal survives the move, and a past-due row becomes active", async () => {
  const cancelled = makeWorld({ sub: { cancelAtPeriodEnd: true } });
  assert.equal((await use(cancelled, up(PRO))).status, 201);
  assert.deepEqual([cancelled.state.subs[0]!.cancelAtPeriodEnd, cancelled.state.subs[0]!.planId], [true, PRO_ID]);

  const renewing = makeWorld();
  assert.equal((await use(renewing, up(PRO))).status, 201);
  assert.equal(renewing.state.subs[0]!.cancelAtPeriodEnd, false);

  // In its days of grace: the renewal could not be paid yesterday. The buyer
  // kept what was left of the old count, and that is what is carried.
  const lateStart = new Date(Date.now() - 31 * DAY);
  const pastDue = makeWorld({
    sub: {
      status: "past_due",
      currentPeriodStart: lateStart,
      currentPeriodEnd: new Date(Date.now() - DAY),
      lastRenewalAttemptAt: new Date(Date.now() - HOUR),
    },
  });
  const before = Date.now();
  const res = await use(pastDue, up(PRO));
  assert.equal(res.status, 201);
  const sub = pastDue.state.subs[0]!;
  assert.deepEqual([sub.status, sub.planId, sub.carriedUses, sub.lastRenewalAttemptAt], ["active", PRO_ID, 188, null]);
  assert.ok(sub.currentPeriodStart.getTime() >= before);
  assert.equal(pastDue.state.revenue.length, 1);

  // A plan its creator ended, while the paid period still runs: the buyer
  // can move to one that is on offer.
  const ended = makeWorld({ sub: { planId: RETIRED_ID, includedUses: 100, usedInPeriod: 10, priceCents: 500n, extraUsePriceCents: null } });
  assert.equal((await use(ended, up(PRO))).status, 201);
  assert.deepEqual([ended.state.subs[0]!.planId, ended.state.subs[0]!.carriedUses], [PRO_ID, 90]);
});

// ============================================
// Who cannot move
// ============================================

test("a buyer who is not on a plan is told to start one, and nothing is charged", async () => {
  const notOnPlan = { error: "not_on_plan", message: "You are not on a plan. Start one first." };
  const cases: Array<[string, World]> = [
    ["no licence", makeWorld({ install: null, sub: null })],
    ["pays per use, no subscription", makeWorld({ install: { acceptedPricingModel: "per_request", acceptedPricePerRequestCents: 5n }, sub: null })],
    ["a plan that was closed", makeWorld({ sub: { status: "cancelled", cancelledAt: new Date() } })],
    ["a plan that expired", makeWorld({ sub: { status: "expired", currentPeriodEnd: new Date(Date.now() - 5 * DAY) } })],
    ["past its days of grace", makeWorld({ sub: { status: "past_due", currentPeriodEnd: new Date(Date.now() - 4 * DAY) } })],
    ["set not to renew, and over", makeWorld({ sub: { cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() - HOUR) } })],
    ["on a plan its creator ended, and over", makeWorld({ sub: { planId: RETIRED_ID, currentPeriodEnd: new Date(Date.now() - HOUR) } })],
    ["a licence that was stopped", makeWorld({ install: { status: "uninstalled" } })],
    ["a licence that lapsed", makeWorld({ install: { status: "suspended" } })],
    ["a licence for a copy", makeWorld({ install: { kind: "copy", clonedAgentId: "agent_copy" } })],
  ];
  for (const [name, world] of cases) {
    const res = await refused(world, up(PRO));
    assert.deepEqual([res.status, res.body], [409, notOnPlan], name);
  }
});

test("today's monthly subscriber cannot move: their row has no count, on a monthly listing or on one sold per use since", async () => {
  const monthlyRow = { planId: null, includedUses: null, extraUsePriceCents: null, usedInPeriod: 0, priceCents: 1500n };
  for (const listing of [{ pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 1500n }, {}]) {
    const world = makeWorld({ listing, install: { acceptedPricingModel: "monthly" }, sub: monthlyRow });
    const res = await refused(world, up(PRO));
    assert.deepEqual([res.status, res.body.error, res.body.message], [409, "not_on_plan", "You are not on a plan. Start one first."]);
  }
});

test("the plan the buyer is on, a smaller plan and one at the same price are each refused in a sentence", async () => {
  const same = await refused(makeWorld(), up(STARTER));
  assert.deepEqual([same.status, same.body], [409, { error: "same_plan", message: "You are already on this plan. Nothing was charged." }]);

  const smaller = {
    error: "not_a_bigger_plan",
    message: "To move to a smaller plan, cancel the renewal and choose it when your plan ends.",
  };
  const onPro = { planId: PRO_ID, priceCents: 2900n, includedUses: 2000, extraUsePriceCents: null, usedInPeriod: 10 };
  const down = await refused(makeWorld({ sub: onPro }), up(STARTER));
  assert.deepEqual([down.status, down.body], [409, smaller]);
  // More uses for the same price is not a bigger plan: it must cost more.
  const twin = await refused(makeWorld(), up(TWIN));
  assert.deepEqual([twin.status, twin.body], [409, smaller]);
  // The price that counts is the one this buyer agreed to, not the plan's
  // price today: they started Starter when it cost $30.00.
  const agreedMore = await refused(makeWorld({ sub: { priceCents: 3000n } }), up(PRO));
  assert.deepEqual([agreedMore.status, agreedMore.body], [409, smaller]);
  // And one cent more is more.
  const agreedLess = makeWorld({ sub: { priceCents: 2899n } });
  assert.equal((await use(agreedLess, up(PRO))).status, 201);
});

test("terms that are not the plan as it is now: 409 pricing_changed with the plans as they are, and nothing charged", async () => {
  const onOffer = [
    { id: STARTER_ID, name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: 5 },
    { id: TWIN_ID, name: "Twin", priceCents: 900, includedUses: 800, extraUsePriceCents: null },
    { id: PRO_ID, name: "Pro", priceCents: 2900, includedUses: 2000, extraUsePriceCents: null },
    { id: MAX_ID, name: "Max", priceCents: 4900, includedUses: 5000, extraUsePriceCents: 2 },
  ];
  for (const plan of [
    { ...PRO, priceCents: 2800 },
    { ...PRO, priceCents: 3000 },
    { ...PRO, includedUses: 2001 },
    { ...PRO, extraUsePriceCents: 4 },
    // Ended by its creator, another listing's, and one that does not exist.
    { id: RETIRED_ID, priceCents: 9900, includedUses: 100, extraUsePriceCents: null },
    { id: THEIRS_ID, priceCents: 2900, includedUses: 2000, extraUsePriceCents: null },
    { ...PRO, id: "99999999-9999-4999-8999-999999999999" },
  ]) {
    const res = await refused(makeWorld(), up(plan));
    assert.deepEqual([res.status, res.body.error], [409, "pricing_changed"], JSON.stringify(plan));
    assert.deepEqual(res.body.plans, onOffer);
    assert.deepEqual(res.body.pricing, { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null });
  }
});

test("a plan changed between the look and the charge is refused inside the transaction", async () => {
  const world = makeWorld();
  // The creator raises Pro's price after the move's first read of it.
  const readPlan = world.models.listingPlan.findUnique;
  let reads = 0;
  world.models.listingPlan.findUnique = async (args: Row) => {
    const row = await readPlan(args);
    if (++reads === 1) world.state.plans.find((p) => p.id === PRO_ID)!.priceCents = 3900n;
    return row;
  };
  const res = await refused(world, up(PRO));
  assert.deepEqual([res.status, res.body.error], [409, "pricing_changed"]);
  assert.equal(res.body.plans.find((p: Row) => p.id === PRO_ID).priceCents, 3900);
  assert.equal(reads, 2);
});

test("too few credits: 402 as a start answers it, and the row is what it was", async () => {
  const world = makeWorld({ balance: 2_899n });
  const res = await refused(world, up(PRO));
  assert.deepEqual([res.status, res.body], [
    402,
    {
      error: "insufficient_credits",
      message: "You do not have enough credits for this plan ($29.00 for 30 days). Nothing was charged. Add credits to continue.",
      requiredCents: 2900,
    },
  ]);
  assert.deepEqual([world.state.subs[0]!.planId, world.state.subs[0]!.usedInPeriod, world.state.subs[0]!.carriedUses], [STARTER_ID, 312, 0]);
  // With exactly the price, it moves.
  assert.equal((await use(makeWorld({ balance: 2_900n }), up(PRO))).status, 201);
});

test("a paused listing, the creator's own listing, one that sells copies and one taken down move nobody", async () => {
  const { movePlan } = await import("../services/planMove.js");
  const { UseStartError } = await import("../services/marketplace.js");
  const refusal = async (world: World, hooks: Row = {}, buyer = BUYER) => {
    const before = structuredClone({ subs: world.state.subs, balance: world.state.balance });
    const code = await withWorld(world, async () => {
      try {
        await movePlan(LISTING_ID, buyer, { id: PRO_ID, priceCents: 2900n, includedUses: 2000, extraUsePriceCents: null }, hooks as never);
        return "moved";
      } catch (err) {
        if (!(err instanceof UseStartError)) throw err;
        return [err.status, err.code];
      }
    });
    assert.deepEqual({ subs: world.state.subs, balance: world.state.balance }, before);
    assert.equal(world.state.revenue.length, 0);
    return code;
  };
  const running = { listingPausedNow: async () => false };
  assert.deepEqual(await refusal(makeWorld(), { listingPausedNow: async () => true }), [409, "listing_paused"]);
  assert.deepEqual(
    await refusal(makeWorld(), {
      listingPausedNow: async () => {
        throw new Error("the model could not be asked");
      },
    }),
    [503, "service_unavailable"],
  );
  // A pause marker that could not be cleared would make the new 30 days longer.
  assert.deepEqual(
    await refusal(makeWorld({ listing: { pausedSince: new Date(Date.now() - DAY) } }), {
      ...running,
      reconcileListingPauses: async () => ({ errors: 1 }),
    }),
    [503, "service_unavailable"],
  );
  assert.deepEqual(await refusal(makeWorld(), running, PUBLISHER), [409, "own_agent"]);
  assert.deepEqual(await refusal(makeWorld({ listing: { sells: "copies" } }), running), [409, "sells_copies"]);
  assert.deepEqual(await refusal(makeWorld({ listing: { status: "archived" } }), running), [404, "listing_not_found"]);
});

test("a member who may not spend, and a key without the spend scope by name, cannot move", async () => {
  const member = await refused(makeWorld(), up(PRO), { userId: "u_member", orgId: BUYER, type: "jwt" });
  assert.equal(member.status, 403);
  const key = await refused(makeWorld(), up(PRO), { orgId: BUYER, type: "api_key", scopes: ["*"] });
  assert.equal(key.status, 403);
  const granted = makeWorld();
  const ok = await use(granted, up(PRO), { orgId: BUYER, type: "api_key", scopes: ["marketplace:install"] });
  assert.equal(ok.status, 201);
});

// ============================================
// The body
// ============================================

test("switchNow that is not true, or comes without the plan sent whole, is refused and is never read as a start", async () => {
  const sentence = "To move to another plan, send the plan you were shown and set switchNow to true. Nothing was changed.";
  const perUse = { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null };
  for (const payload of [
    { plan: PRO, switchNow: false },
    { plan: PRO, switchNow: "true" },
    { plan: PRO, switchNow: 1 },
    { plan: PRO, switchNow: null },
    { switchNow: true },
    { switchNow: true, expected: perUse },
    { switchNow: true, plan: { id: PRO_ID, priceCents: 2900, includedUses: 2000 } },
    { switchNow: true, plan: { ...PRO, priceCents: "2900" } },
    { switchNow: true, plan: null },
  ]) {
    // On a plan: not moved. With no licence at all: nothing is started and no
    // price per use is agreed to.
    for (const world of [makeWorld(), makeWorld({ install: null, sub: null })]) {
      const res = await refused(world, payload);
      assert.deepEqual([res.status, res.body], [400, { error: "invalid_plan_move", message: sentence }], JSON.stringify(payload));
    }
  }
});

// ============================================
// One claim
// ============================================

test("two moves at the same moment: one is answered, one is refused, and one plan is charged", async () => {
  const world = makeWorld();
  const results = await useAll(world, [up(PRO), up(PRO)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const loser = results.find((r) => r.status === 409)!;
  assert.ok(["same_plan", "subscription_claim_lost"].includes(loser.body.error), loser.body.error);
  assert.equal(world.state.revenue.length, 1);
  assert.equal(world.state.balance, 7_100n);
  assert.deepEqual([world.state.subs[0]!.planId, world.state.subs[0]!.carriedUses], [PRO_ID, 188]);
});

test("a move whose row was moved by another move after it was read claims nothing and charges nothing", async () => {
  const { movePlanSubscription, SubscriptionClaimLostError } = await import("../services/marketplaceSubscriptions.js");
  const world = makeWorld();
  const now = new Date();
  const move = (plan: Row) =>
    movePlanSubscription(world.models as never, { listing: LISTING, plan: plan as never, buyerId: BUYER, licenceId: "ins_1", now });
  // The move to Max lands between this move's read of the row and its claim.
  world.between.run = async () => {
    await move(MAX_TERMS);
  };
  await assert.rejects(move(PRO_TERMS), SubscriptionClaimLostError);
  const sub = world.state.subs[0]!;
  assert.deepEqual([sub.planId, sub.priceCents, sub.includedUses, sub.carriedUses, sub.usedInPeriod], [MAX_ID, 4900n, 5000, 188, 0]);
  assert.deepEqual(world.state.revenue.map((row) => row.grossAmountCents), [4900n]);
  assert.equal(world.state.balance, 5_100n);
});

test("a move and a renewal of the same row cannot both charge, whichever is first", async () => {
  const { movePlanSubscription, renewSubscription, SubscriptionClaimLostError } = await import("../services/marketplaceSubscriptions.js");
  const now = new Date();
  // The period ended an hour ago and the worker is on its way: the row is
  // still open, so a move is allowed, and it is due, so a renewal is too.
  // No use was taken in it, so the renewal changes nothing of the row but
  // its period: the period start is what the move's claim must be held by.
  const due = {
    currentPeriodStart: new Date(now.getTime() - 30 * DAY - HOUR),
    currentPeriodEnd: new Date(now.getTime() - HOUR),
    usedInPeriod: 0,
  };
  const billing = { ...LISTING, monthlyPriceCents: 0n, pricingModel: "per_request", status: "published", sells: "use", pausedSince: null };
  const renew = (world: World, loaded: Row) =>
    renewSubscription(world.models as never, { sub: { ...loaded, licenceKind: "use", planRetired: false } as never, listing: billing, now });
  const move = (world: World) =>
    movePlanSubscription(world.models as never, { listing: LISTING, plan: PRO_TERMS, buyerId: BUYER, licenceId: "ins_1", now });

  // The renewal lands between the move's read and its claim: the move misses.
  const renewedFirst = makeWorld({ sub: due });
  const loaded = { ...renewedFirst.state.subs[0]! };
  renewedFirst.between.run = async () => {
    assert.equal((await renew(renewedFirst, loaded)).kind, "renewed");
  };
  await assert.rejects(move(renewedFirst), SubscriptionClaimLostError);
  assert.deepEqual(renewedFirst.state.revenue.map((row) => [row.type, row.grossAmountCents]), [["subscription_renewal", 900n]]);
  assert.deepEqual(
    [renewedFirst.state.subs[0]!.planId, renewedFirst.state.subs[0]!.usedInPeriod, renewedFirst.state.subs[0]!.carriedUses],
    [STARTER_ID, 0, 0],
  );
  assert.equal(renewedFirst.state.balance, 9_100n);

  // The move lands first: the renewal, holding the row as it loaded it, misses.
  const movedFirst = makeWorld({ sub: due });
  const stale = { ...movedFirst.state.subs[0]! };
  await move(movedFirst);
  assert.deepEqual(await renew(movedFirst, stale), { kind: "lost_race" });
  assert.deepEqual(movedFirst.state.revenue.map((row) => [row.type, row.grossAmountCents]), [["subscription", 2900n]]);
  assert.deepEqual(
    [movedFirst.state.subs[0]!.planId, movedFirst.state.subs[0]!.usedInPeriod, movedFirst.state.subs[0]!.carriedUses],
    [PRO_ID, 0, 500],
  );
  assert.equal(movedFirst.state.balance, 7_100n);
});

test("a move racing the take of the last use neither loses that use nor invents one", async () => {
  const { movePlanSubscription, SubscriptionClaimLostError } = await import("../services/marketplaceSubscriptions.js");
  const { takeIncludedUse } = await import("../services/planUse.js");
  const now = new Date();
  const move = (world: World) =>
    movePlanSubscription(world.models as never, { listing: LISTING, plan: PRO_TERMS, buyerId: BUYER, licenceId: "ins_1", now });
  const readOf = (sub: Row) => ({
    subscriptionId: sub.id,
    periodStart: sub.currentPeriodStart,
    includedUses: sub.includedUses,
    carriedUses: sub.carriedUses,
  });

  // The use is taken between the move's read and its claim. The move was
  // about to carry one use that is now gone: it misses, uncharged.
  const usedFirst = makeWorld({ sub: { usedInPeriod: 499 } });
  usedFirst.between.run = async () => {
    assert.deepEqual((await takeIncludedUse(usedFirst.models as never, readOf(usedFirst.state.subs[0]!))).taken, true);
  };
  await assert.rejects(move(usedFirst), SubscriptionClaimLostError);
  assert.deepEqual(
    [usedFirst.state.subs[0]!.planId, usedFirst.state.subs[0]!.usedInPeriod, usedFirst.state.subs[0]!.carriedUses],
    [STARTER_ID, 500, 0],
  );
  assert.equal(usedFirst.state.revenue.length, 0);
  // Asked again, it moves and carries nothing: the last use was used.
  await move(usedFirst);
  assert.deepEqual([usedFirst.state.subs[0]!.planId, usedFirst.state.subs[0]!.carriedUses], [PRO_ID, 0]);

  // The move lands first. The request that read the old row takes nothing
  // from it; the one use that was left is in the new period, once.
  const movedFirst = makeWorld({ sub: { usedInPeriod: 499 } });
  const stale = readOf(movedFirst.state.subs[0]!);
  await move(movedFirst);
  assert.deepEqual(await takeIncludedUse(movedFirst.models as never, stale), { taken: false });
  const sub = movedFirst.state.subs[0]!;
  assert.deepEqual([sub.planId, sub.usedInPeriod, sub.carriedUses], [PRO_ID, 0, 1]);
  // Decided again from the row as it is, the use is taken and counted.
  assert.equal((await takeIncludedUse(movedFirst.models as never, readOf(sub))).taken, true);
  assert.deepEqual([sub.usedInPeriod, sub.includedUses + sub.carriedUses], [1, 2001]);
});

test("a licence stopped between the look and the claim moves nothing", async () => {
  const { movePlanSubscription, PlanMoveRefusedError } = await import("../services/marketplaceSubscriptions.js");
  const world = makeWorld({ install: { status: "uninstalled" } });
  await assert.rejects(
    movePlanSubscription(world.models as never, { listing: LISTING, plan: PRO_TERMS, buyerId: BUYER, licenceId: "ins_1", now: new Date() }),
    (err: unknown) => err instanceof PlanMoveRefusedError && err.reason === "not_on_plan",
  );
  assert.deepEqual([world.state.subs[0]!.planId, world.state.revenue.length, world.state.balance], [STARTER_ID, 0, 10_000n]);
});
