import assert from "node:assert/strict";

import { earningsStandIn, type EarningsRow } from "./earningsStandIn.js";

// An in-memory marketplace for the tests of a listing's free trial: one
// listing sold per use with a free trial and a paid plan on offer, one buyer,
// their licence and subscription rows, their credit ledger, and every money
// table a charge would write to. POST /listings/:id/use runs over it through
// the real route and services (tests/trialStart.unit.test.ts,
// tests/trialUse.unit.test.ts). A test file that imports this imports
// ./unitEnv.js first.

export const DAY = 24 * 60 * 60 * 1000;
export const LISTING_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_LISTING_ID = "22222222-2222-4222-8222-222222222222";
export const STARTER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const TRIAL_ID = "99999999-9999-4999-8999-999999999999";
export const OLD_TRIAL_ID = "88888888-8888-4888-8888-888888888888";
export const THEIR_TRIAL_ID = "77777777-7777-4777-8777-777777777777";
export const BUYER = "org_buyer";
export const PUBLISHER = "org_pub";

export type Row = Record<string, any>;

export function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    if (cond && typeof cond === "object") {
      if ("in" in cond) return cond.in.includes(v);
      if ("not" in cond) return v !== cond.not;
      if ("gt" in cond) return v > cond.gt;
    }
    return (v ?? null) === cond;
  });
}

export const planRow = (over: Row): Row => ({
  listingId: LISTING_ID,
  kind: "paid",
  status: "active",
  retiredAt: null,
  ...over,
});
export const trialRow = (over: Row = {}): Row =>
  planRow({ id: TRIAL_ID, kind: "trial", name: "Free trial", priceCents: 0n, includedUses: 20, extraUsePriceCents: null, position: 0, ...over });

/** A row of credit_transactions that says credits were bought. */
export const PURCHASE = { orgId: BUYER, type: "purchase", amountCents: 1_000n };

export function makeWorld(
  opts: {
    listing?: Row;
    agent?: Row;
    install?: Row;
    sub?: Row;
    balance?: bigint;
    plans?: Row[];
    /** The buyer's credit ledger as it was before the start. Default: one purchase. */
    credits?: Row[];
  } = {},
) {
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
      trialRow(),
      planRow({ id: STARTER_ID, name: "Starter", priceCents: 900n, includedUses: 500, extraUsePriceCents: 5n, position: 1 }),
      // Ended by its creator, and the trial of another listing.
      trialRow({ id: OLD_TRIAL_ID, includedUses: 10, status: "retired", retiredAt: new Date(0) }),
      trialRow({ id: THEIR_TRIAL_ID, listingId: OTHER_LISTING_ID }),
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
            // As the database leaves the plan's columns on a row that never named them.
            planId: null,
            includedUses: null,
            usedInPeriod: 0,
            carriedUses: 0,
            extraUsePriceCents: null,
            warnedLevel: 0,
            trialUsedAt: null,
            ...opts.sub,
          },
        ]
      : []) as Row[],
    balance: opts.balance ?? 1_000n,
    /** credit_transactions as they were before the start. */
    credits: (opts.credits ?? [PURCHASE]) as Row[],
    /** Every money row written since: there must be none. */
    ledger: [] as Row[],
    revenue: [] as Row[],
    accrued: 0n,
    earnings: [] as EarningsRow[],
    /** Every statement that changed the balance. */
    balanceWrites: 0,
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
        state.balanceWrites += 1;
        if (state.balance < where.balanceCents.gte) return { count: 0 };
        state.balance -= data.balanceCents.decrement;
        return { count: 1 };
      },
      findUnique: async () => ({ balanceCents: state.balance }),
    },
    creditTransaction: {
      findFirst: async ({ where }: Row) => {
        const row = state.credits.find((c) => matches(c, where));
        return row ? { id: "ct_1" } : null;
      },
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

export type World = ReturnType<typeof makeWorld>;
export type Send = (payload: Row, principal?: Row) => Promise<{ status: number; body: Row }>;

export const OWNER = { userId: "u_owner", orgId: BUYER, type: "jwt", role: "owner" };

/** POST /listings/:id/use over the world, with the app's own spend guard. Several requests can share one app. */
export async function withApp<T>(world: World, body: (send: Send) => Promise<T>): Promise<T> {
  const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Row };
  const originals: Row = {};
  for (const [name, fake] of Object.entries(world.models)) {
    originals[name] = prisma[name];
    prisma[name] = fake;
  }
  const Fastify = (await import("fastify")).default;
  const sensible = await import("@fastify/sensible");
  const { marketplaceRoutes } = await import("../routes/marketplace.js");
  const app = Fastify();
  await app.register(sensible.default);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    const header = request.headers["x-test-auth"];
    (request as unknown as { auth: unknown }).auth = typeof header === "string" ? JSON.parse(header) : OWNER;
  });
  await app.register(marketplaceRoutes);
  const send: Send = async (payload, principal) => {
    const res = await app.inject({
      method: "POST",
      url: `/listings/${LISTING_ID}/use`,
      payload,
      ...(principal && { headers: { "x-test-auth": JSON.stringify(principal) } }),
    });
    return { status: res.statusCode, body: res.json() as Row };
  };
  try {
    const result = await body(send);
    // Let the fire-and-forget reputation recalculation settle on the fakes.
    await new Promise((resolve) => setImmediate(resolve));
    return result;
  } finally {
    await app.close();
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

export const use = (world: World, payload: Row, principal?: Row) => withApp(world, (send) => send(payload, principal));

/** The trial as a buyer is shown it, and sends it back. */
export const TRIAL = { id: TRIAL_ID, priceCents: 0, includedUses: 20, extraUsePriceCents: null };
export const STARTER = { id: STARTER_ID, priceCents: 900, includedUses: 500, extraUsePriceCents: 5 };
export const ON_OFFER = [{ id: STARTER_ID, name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: 5 }];
export const PER_USE = { pricingModel: "per_request", pricePerRequestCents: 5, monthlyPriceCents: null };

/** No money moved: no revenue row, no credit transaction, no earnings row, and the balance was not written to. */
export const noMoney = (world: World, balance = 1_000n) => {
  assert.equal(world.state.balance, balance, "the balance moved");
  assert.equal(world.state.balanceWrites, 0, "the balance was written to");
  assert.deepEqual(world.state.revenue, [], "a revenue row was written");
  assert.deepEqual(world.state.ledger, [], "a credit transaction was written");
  assert.deepEqual(world.state.earnings, [], "an earnings row was written");
  assert.equal(world.state.accrued, 0n, "the creator was credited");
};
/** Nothing at all was written. */
export const untouched = (world: World, rows: [number, number] = [0, 0]) => {
  noMoney(world);
  assert.deepEqual([world.state.installs.length, world.state.subs.length], rows);
};

