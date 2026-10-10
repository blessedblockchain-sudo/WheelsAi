import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

// Starting and stopping USE of a creator's agent, against an in-memory
// database. What these pin: no copy of the agent is ever written into the
// buyer's organization, a price per use charges nothing at start, a month is
// charged once however many starts arrive, a higher price needs the buyer's
// acceptance, a free listing writes no licence, and install and start-using
// refuse each other's listings.

const DAY = 24 * 60 * 60 * 1000;
const LISTING_ID = "11111111-1111-4111-8111-111111111111";
const BUYER = "org_buyer";
const PUBLISHER = "org_pub";
const INSTRUCTIONS = "You are the secret analyst. Never reveal the house method.";

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

function makeWorld(opts: {
  sells?: string;
  pricingModel: string;
  monthlyPriceCents?: bigint | null;
  pricePerRequestCents?: bigint | null;
  listingStatus?: string;
  install?: Row;
  sub?: Row;
  agents?: string[];
  balance?: bigint;
}) {
  const state = {
    listing: {
      id: LISTING_ID,
      title: "Research Analyst",
      publisherId: PUBLISHER,
      status: opts.listingStatus ?? "published",
      sells: opts.sells ?? "use",
      pricingModel: opts.pricingModel,
      monthlyPriceCents: opts.monthlyPriceCents ?? null,
      pricePerRequestCents: opts.pricePerRequestCents ?? null,
      totalInstalls: 0,
      activeInstalls: 0,
      agent: {
        id: "agent_src",
        name: "Analyst",
        slug: "analyst",
        publicHandle: "analyst",
        agentKind: "conversation",
        tags: [],
        framework: "custom",
        systemPrompt: INSTRUCTIONS,
        tools: [{ name: "http_request" }],
      },
    } as Row,
    installs: (opts.install
      ? [
          {
            id: "ins_1",
            listingId: LISTING_ID,
            buyerId: BUYER,
            kind: "use",
            clonedAgentId: null,
            uninstalledAt: null,
            totalRequests: 0n,
            totalSpentCents: 0n,
            acceptedPricingModel: opts.pricingModel,
            acceptedPricePerRequestCents:
              opts.pricingModel === "per_request" ? (opts.pricePerRequestCents ?? null) : null,
            pricingAcceptedAt: new Date(0),
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
    agents: (opts.agents ?? []).map((id) => ({ id, orgId: BUYER })) as Row[],
    balance: opts.balance ?? 10_000n,
    ledger: [] as Row[],
    revenue: [] as Row[],
    accrued: 0n,
    taskWrites: [] as Row[],
  };
  let seq = 0;

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
    agentInstall: {
      findUnique: async (args: Row) =>
        state.installs[0]
          ? { ...state.installs[0], ...(args?.include?.listing && { listing: structuredClone(state.listing) }) }
          : null,
      findMany: async ({ where }: Row) =>
        state.installs
          .filter((i) => matches(i, { status: where.status }))
          .map((i) => ({ ...i, listing: structuredClone(state.listing) })),
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
        const row = { id: `ins_${++seq}`, uninstalledAt: null, totalRequests: 0n, totalSpentCents: 0n, ...data };
        state.installs.push(row);
        return { ...row };
      },
    },
    agentSubscription: {
      findUnique: async () => (state.subs[0] ? { ...state.subs[0] } : null),
      findMany: async () => state.subs.map((s) => ({ ...s })),
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
    agentToken: { findUnique: async () => null },
    agent: {
      findFirst: async ({ where }: Row) => state.agents.find((a) => matches(a, where)) ?? null,
      create: async ({ data }: Row) => {
        const row = { id: `agent_new_${++seq}`, ...data };
        state.agents.push(row);
        return row;
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
    // No profile row: the reputation recalculation stops at its first read.
    publisherProfile: {
      findUnique: async () => null,
      update: async ({ data }: Row) => {
        state.accrued += data.pendingPayoutCents?.increment ?? 0n;
        return {};
      },
    },
    scheduledTask: {
      updateMany: async (args: Row) => {
        state.taskWrites.push(args);
        return { count: 0 };
      },
    },
    // The spend guard reads the member's role as it is now.
    orgMember: { findUnique: async () => ({ role: "owner" }) },
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
        agents: state.agents,
        balance: state.balance,
        ledger: state.ledger,
        revenue: state.revenue,
        accrued: state.accrued,
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
    const result = await body(svc);
    // Let the fire-and-forget reputation recalculation settle on the fakes.
    await new Promise((resolve) => setImmediate(resolve));
    return result;
  } finally {
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

const perUse = (cents: number) => ({ pricingModel: "per_request", pricePerRequestCents: cents, monthlyPriceCents: null });
const monthly = (cents: number) => ({ pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: cents });
const AGENT = { handle: "analyst", name: "Analyst", agentKind: "conversation" };

// ============================================
// Start
// ============================================

test("starting on a price per use writes a use licence, makes no copy and charges nothing", async () => {
  const world = makeWorld({ pricingModel: "per_request", pricePerRequestCents: 5n });
  const result = await withWorld(world, ({ startUsing }) => startUsing(LISTING_ID, BUYER, { expected: perUse(5) }));

  assert.equal(result.created, true);
  assert.equal(result.access, "listing_pricing");
  assert.equal(result.subscription, null);
  assert.deepEqual(result.agent, AGENT);
  assert.equal(result.acceptedPricing!.pricingModel, "per_request");
  assert.equal(result.acceptedPricing!.pricePerRequestCents, 5);
  assert.ok(result.acceptedPricing!.acceptedAt instanceof Date);

  const licence = world.state.installs[0]!;
  assert.equal(licence.kind, "use");
  assert.equal(licence.clonedAgentId, null);
  assert.equal(licence.status, "active");
  assert.equal(licence.acceptedPricePerRequestCents, 5n);
  // Nothing of the agent reached the buyer's organization, or the answer.
  assert.equal(world.state.agents.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /secret analyst|http_request/);
  // Each use is charged when it is sent, not here.
  assert.equal(world.state.balance, 10_000n);
  assert.equal(world.state.ledger.length, 0);
  assert.equal(world.state.revenue.length, 0);
  assert.equal(world.state.subs.length, 0);
  assert.equal(world.state.listing.totalInstalls, 1);
  assert.equal(world.state.listing.activeInstalls, 1);
});

test("starting on a monthly price charges the first 30 days once, with its ledger row, and makes no copy", async () => {
  const world = makeWorld({ pricingModel: "monthly", monthlyPriceCents: 900n });
  const result = await withWorld(world, ({ startUsing }) => startUsing(LISTING_ID, BUYER, { expected: monthly(900) }));

  assert.equal(result.created, true);
  assert.equal(result.access, "subscribed");
  assert.equal(result.subscription!.priceCents, 900);
  assert.equal(result.subscription!.hasAccess, true);
  assert.equal(world.state.balance, 9_100n);
  assert.equal(world.state.ledger.length, 1);
  assert.equal(world.state.ledger[0]!.amountCents, -900n);
  assert.equal(world.state.ledger[0]!.type, "marketplace_subscription");
  assert.equal(world.state.revenue.length, 1);
  assert.equal(world.state.revenue[0]!.type, "subscription");
  assert.equal(world.state.revenue[0]!.installId, world.state.installs[0]!.id);
  assert.equal(world.state.accrued, 810n);
  assert.equal(world.state.installs[0]!.kind, "use");
  assert.equal(world.state.installs[0]!.clonedAgentId, null);
  assert.equal(world.state.installs[0]!.acceptedPricingModel, "monthly");
  assert.equal(world.state.agents.length, 0);
});

test("two starts at the same moment charge one month", async () => {
  const world = makeWorld({ pricingModel: "monthly", monthlyPriceCents: 900n });
  await withWorld(world, async ({ startUsing }) => {
    const { SubscriptionClaimLostError } = await import("../services/marketplaceSubscriptions.js");
    const results = await Promise.allSettled([
      startUsing(LISTING_ID, BUYER, { expected: monthly(900) }),
      startUsing(LISTING_ID, BUYER, { expected: monthly(900) }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(lost.reason instanceof SubscriptionClaimLostError);
    assert.equal(lost.reason.code, "subscription_claim_lost");

    // A start after that finds the buyer already using it: no charge.
    const again = await startUsing(LISTING_ID, BUYER, { expected: monthly(900) });
    assert.equal(again.created, false);
    assert.equal(again.access, "subscribed");
  });
  assert.equal(world.state.balance, 9_100n);
  assert.equal(world.state.ledger.length, 1);
  assert.equal(world.state.revenue.length, 1);
  assert.equal(world.state.subs.length, 1);
  assert.equal(world.state.installs.length, 1);
  assert.equal(world.state.listing.activeInstalls, 1);
});

test("two resubscribes on a lapsed use licence charge one month", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 900n,
    install: { status: "suspended" },
    sub: { status: "expired", currentPeriodEnd: new Date(Date.now() - 10 * DAY), priceCents: 900n },
  });
  await withWorld(world, async ({ startUsing, getMyInstalls }) => {
    assert.equal((await getMyInstalls(BUYER))[0]!.access, "subscription_lapsed");
    const results = await Promise.allSettled([
      startUsing(LISTING_ID, BUYER, { expected: monthly(900) }),
      startUsing(LISTING_ID, BUYER, { expected: monthly(900) }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  });
  assert.equal(world.state.balance, 9_100n);
  assert.equal(world.state.ledger.length, 1);
  assert.equal(world.state.subs[0]!.status, "active");
  // A lapsed licence was never uncounted, so it is not counted again.
  assert.equal(world.state.listing.activeInstalls, 0);
});

test("a buyer who cannot pay the month gets no licence, no subscription and no charge", async () => {
  const world = makeWorld({ pricingModel: "monthly", monthlyPriceCents: 900n, balance: 100n });
  await withWorld(world, async ({ startUsing }) => {
    const { InsufficientCreditsError } = await import("../services/marketplaceSubscriptions.js");
    await assert.rejects(startUsing(LISTING_ID, BUYER, { expected: monthly(900) }), InsufficientCreditsError);
  });
  assert.equal(world.state.balance, 100n);
  assert.equal(world.state.installs.length, 0);
  assert.equal(world.state.subs.length, 0);
  assert.equal(world.state.ledger.length, 0);
  assert.equal(world.state.listing.activeInstalls, 0);
});

test("a free use listing needs no licence: its state is answered and no row is written", async () => {
  const world = makeWorld({ pricingModel: "free" });
  const result = await withWorld(world, ({ startUsing }) =>
    startUsing(LISTING_ID, BUYER, { expected: { pricingModel: "free", pricePerRequestCents: null, monthlyPriceCents: null } }),
  );
  assert.equal(result.created, false);
  assert.equal(result.acceptedPricing, null);
  assert.equal(result.subscription, null);
  assert.deepEqual(result.agent, AGENT);
  assert.equal(world.state.installs.length, 0);
  assert.equal(world.state.balance, 10_000n);
  assert.equal(world.state.listing.totalInstalls, 0);
});

// ============================================
// Consent
// ============================================

test("the terms the person was shown are required, and terms that moved are not agreed to for them", async () => {
  const world = makeWorld({ pricingModel: "per_request", pricePerRequestCents: 8n });
  await withWorld(world, async ({ startUsing, UseStartError, PricingChangedError }) => {
    await assert.rejects(startUsing(LISTING_ID, BUYER, {}), (err: unknown) => {
      assert.ok(err instanceof UseStartError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "expected_terms_required");
      return true;
    });
    // The page showed 5 cents; the listing says 8 now.
    await assert.rejects(startUsing(LISTING_ID, BUYER, { expected: perUse(5) }), (err: unknown) => {
      assert.ok(err instanceof PricingChangedError);
      assert.deepEqual(err.pricing, perUse(8));
      return true;
    });
    // The page showed a monthly price; the listing is per use now.
    await assert.rejects(startUsing(LISTING_ID, BUYER, { expected: monthly(900) }), PricingChangedError);
  });
  assert.equal(world.state.installs.length, 0);
  assert.equal(world.state.balance, 10_000n);
});

test("a higher price pauses use until the buyer accepts it, and accepting charges nothing", async () => {
  // Agreed to 5 cents; the owner now asks 8.
  const world = makeWorld({
    pricingModel: "per_request",
    pricePerRequestCents: 8n,
    install: { status: "active", acceptedPricePerRequestCents: 5n },
  });
  world.state.listing.activeInstalls = 1;
  await withWorld(world, async ({ startUsing, getMyInstalls, PricingChangedError }) => {
    assert.equal((await getMyInstalls(BUYER))[0]!.access, "pricing_changed");
    // Seeing the new price is not accepting it.
    await assert.rejects(startUsing(LISTING_ID, BUYER, { expected: perUse(8) }), (err: unknown) => {
      assert.ok(err instanceof PricingChangedError);
      assert.deepEqual(err.pricing, perUse(8));
      return true;
    });
    assert.equal(world.state.installs[0]!.acceptedPricePerRequestCents, 5n, "a refusal records nothing");
    // Accepting a price that has moved again is refused too.
    await assert.rejects(
      startUsing(LISTING_ID, BUYER, { expected: perUse(7), acceptNewPricing: true }),
      PricingChangedError,
    );

    const accepted = await startUsing(LISTING_ID, BUYER, { expected: perUse(8), acceptNewPricing: true });
    assert.equal(accepted.created, true);
    assert.equal(accepted.access, "listing_pricing");
    assert.equal(accepted.acceptedPricing!.pricePerRequestCents, 8);
  });
  assert.equal(world.state.installs[0]!.acceptedPricePerRequestCents, 8n);
  assert.equal(world.state.installs[0]!.clonedAgentId, null);
  assert.equal(world.state.balance, 10_000n);
  assert.equal(world.state.listing.activeInstalls, 1, "not counted twice");
});

test("a per-use buyer on a listing that became monthly subscribes only by accepting it", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 900n,
    install: { status: "active", acceptedPricingModel: "per_request", acceptedPricePerRequestCents: 5n },
  });
  await withWorld(world, async ({ startUsing, PricingChangedError }) => {
    await assert.rejects(startUsing(LISTING_ID, BUYER, { expected: monthly(900) }), PricingChangedError);
    assert.equal(world.state.balance, 10_000n);
    const accepted = await startUsing(LISTING_ID, BUYER, { expected: monthly(900), acceptNewPricing: true });
    assert.equal(accepted.access, "subscribed");
  });
  assert.equal(world.state.balance, 9_100n);
  assert.equal(world.state.ledger.length, 1);
  assert.equal(world.state.installs[0]!.acceptedPricingModel, "monthly");
});

test("starting again when already using answers the state as it is and writes nothing", async () => {
  const perUseWorld = makeWorld({
    pricingModel: "per_request",
    pricePerRequestCents: 5n,
    install: { status: "active" },
  });
  const state = await withWorld(perUseWorld, ({ startUsing }) =>
    startUsing(LISTING_ID, BUYER, { expected: perUse(5), acceptNewPricing: true }),
  );
  assert.equal(state.created, false);
  assert.equal(state.access, "listing_pricing");
  assert.equal(perUseWorld.state.installs[0]!.pricingAcceptedAt.getTime(), 0);
  assert.equal(perUseWorld.state.listing.totalInstalls, 0);

  const paidUp = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 900n,
    install: { status: "active" },
    sub: { status: "active", currentPeriodEnd: new Date(Date.now() + 10 * DAY), priceCents: 900n },
  });
  const sub = await withWorld(paidUp, ({ startUsing }) => startUsing(LISTING_ID, BUYER, { expected: monthly(900) }));
  assert.equal(sub.created, false);
  assert.equal(sub.access, "subscribed");
  assert.equal(paidUp.state.balance, 10_000n);
});

// ============================================
// Refusals
// ============================================

test("the publisher's own organization, a listing that sells copies and a listing that is not on sale are refused", async () => {
  const refusal = async (world: World, buyer: string) =>
    withWorld(world, async ({ startUsing, UseStartError }) => {
      try {
        await startUsing(LISTING_ID, buyer, { expected: perUse(5) });
        return null;
      } catch (err) {
        assert.ok(err instanceof UseStartError, String(err));
        return [err.status, err.code, err.message];
      }
    });

  const own = makeWorld({ pricingModel: "per_request", pricePerRequestCents: 5n });
  assert.deepEqual(await refusal(own, PUBLISHER), [409, "own_agent", "This is your agent. You do not pay to use it."]);
  assert.equal(own.state.installs.length, 0);

  const copies = makeWorld({ sells: "copies", pricingModel: "per_request", pricePerRequestCents: 5n });
  assert.deepEqual(await refusal(copies, BUYER), [
    409,
    "sells_copies",
    "This listing sells copies of the agent. Install it to get your own copy.",
  ]);
  assert.equal(copies.state.installs.length, 0);

  for (const listingStatus of ["draft", "archived"]) {
    const off = makeWorld({ pricingModel: "per_request", pricePerRequestCents: 5n, listingStatus });
    assert.deepEqual(await refusal(off, BUYER), [404, "listing_not_found", "Listing not found"]);
  }
});

test("someone who holds a copy keeps a metered copy and is not given use by holding it", async () => {
  // The listing sold copies when they installed; it sells use now.
  const world = makeWorld({
    pricingModel: "per_request",
    pricePerRequestCents: 5n,
    install: { status: "active", kind: "copy", clonedAgentId: "agent_c0" },
    agents: ["agent_c0"],
  });
  world.state.listing.activeInstalls = 1;
  await withWorld(world, async ({ getMyInstalls, checkInstallStatus, startUsing }) => {
    const { useAccess } = await import("../services/useAccess.js");
    const [row] = await getMyInstalls(BUYER);
    // Still their copy, still on the terms they accepted, still metered by this row.
    assert.equal(row!.kind, "copy");
    assert.equal(row!.clonedAgentId, "agent_c0");
    assert.equal(row!.access, "listing_pricing");
    assert.equal((await checkInstallStatus(LISTING_ID, BUYER)).install!.kind, "copy");
    // Holding a copy is not an agreement to pay for use.
    const licence = world.state.installs[0]!;
    assert.equal(
      useAccess({
        licence: {
          kind: licence.kind,
          status: licence.status,
          accepted: { pricingModel: licence.acceptedPricingModel, pricePerRequestCents: licence.acceptedPricePerRequestCents },
        },
        listing: world.state.listing as never,
        sub: null,
      }),
      "none",
    );

    // They can start using it like anyone else. The copy is left where it
    // is, still pointed at by the licence, so it never runs unmetered.
    const started = await startUsing(LISTING_ID, BUYER, { expected: perUse(5) });
    assert.equal(started.created, true);
    assert.equal(started.access, "listing_pricing");
  });
  assert.equal(world.state.installs[0]!.kind, "use");
  assert.equal(world.state.installs[0]!.clonedAgentId, "agent_c0");
  assert.equal(world.state.agents.length, 1, "no second copy, and the first is not removed");
  assert.equal(world.state.listing.activeInstalls, 1, "not counted twice");
  assert.equal(world.state.balance, 10_000n);
});

// A copy whose month is paid for: there is one licence row for a listing and
// a buyer, so a start over it would cancel that month (a per-use listing) or
// could never go through (a monthly one). It is refused before anything moves.

/** A buyer who installed a monthly copy and paid the month; the listing sells use now. */
function copyWithPaidMonth(listingNow: { pricingModel: string; pricePerRequestCents?: bigint; monthlyPriceCents?: bigint }, sub: Row = {}) {
  const world = makeWorld({
    ...listingNow,
    install: {
      status: "active",
      kind: "copy",
      clonedAgentId: "agent_c0",
      acceptedPricingModel: "monthly",
      acceptedPricePerRequestCents: null,
    },
    sub: { status: "active", currentPeriodEnd: new Date(Date.UTC(2099, 2, 14, 12)), priceCents: 900n, licenceKind: "copy", ...sub },
    agents: ["agent_c0"],
  });
  world.state.listing.activeInstalls = 1;
  return world;
}

/** Everything a start could move, to compare before and after. */
const moneyAndRows = (world: World) =>
  structuredClone({
    installs: world.state.installs,
    subs: world.state.subs,
    balance: world.state.balance,
    ledger: world.state.ledger,
    revenue: world.state.revenue,
    accrued: world.state.accrued,
    agents: world.state.agents,
    counters: [world.state.listing.totalInstalls, world.state.listing.activeInstalls],
  });

async function startRefusal(
  world: World,
  expected: { pricingModel: string; pricePerRequestCents: number | null; monthlyPriceCents: number | null },
) {
  return withWorld(world, async ({ startUsing, UseStartError }) => {
    try {
      await startUsing(LISTING_ID, BUYER, { expected, acceptNewPricing: true });
      return null;
    } catch (err) {
      assert.ok(err instanceof UseStartError, `refused as ${(err as Error)?.name}: ${(err as Error)?.message}`);
      return err;
    }
  });
}

test("a start over a copy whose month is paid for is refused, on a per-use listing and on a monthly one, and nothing moves", async () => {
  const { installAccess } = await import("../services/subscriptionAccess.js");
  for (const [listingNow, expected] of [
    [{ pricingModel: "per_request", pricePerRequestCents: 5n }, perUse(5)],
    [{ pricingModel: "monthly", monthlyPriceCents: 900n }, monthly(900)],
  ] as const) {
    const world = copyWithPaidMonth(listingNow);
    const before = moneyAndRows(world);

    const refused = await startRefusal(world, expected);
    assert.ok(refused, `${listingNow.pricingModel}: the start is refused`);
    assert.deepEqual([refused.status, refused.code], [409, "copy_subscription_active"]);
    assert.equal(refused.until?.toISOString(), "2099-03-14T12:00:00.000Z");
    assert.match(refused.message, /^You hold a copy of this agent that is paid for until 14 Mar\./);
    assert.match(refused.message, /remove your copy/);
    assert.doesNotMatch(refused.message, /—|another request/);

    // The licence, the subscription, the balance, the ledger and the counters are exactly as they were.
    assert.deepEqual(moneyAndRows(world), before, listingNow.pricingModel);
    const licence = world.state.installs[0]!;
    assert.equal(licence.kind, "copy");
    assert.equal(world.state.subs[0]!.status, "active");
    // And the copy is still covered by the month that was paid for.
    assert.equal(
      installAccess({
        installStatus: licence.status,
        listingStatus: "published",
        pricingModel: listingNow.pricingModel,
        pricePerRequestCents: world.state.listing.pricePerRequestCents,
        accepted: { pricingModel: licence.acceptedPricingModel, pricePerRequestCents: licence.acceptedPricePerRequestCents },
        sub: world.state.subs[0] as never,
      }),
      "subscribed",
    );
  }
});

test("a copy whose renewal is cancelled is still paid for until the month ends, so a start waits for that day", async () => {
  const world = copyWithPaidMonth({ pricingModel: "per_request", pricePerRequestCents: 5n }, { cancelAtPeriodEnd: true });
  const before = moneyAndRows(world);
  const refused = await startRefusal(world, perUse(5));
  assert.equal(refused?.code, "copy_subscription_active");
  assert.deepEqual(moneyAndRows(world), before);
});

test("a copy whose subscription no longer grants access does not stand in the way of a start", async () => {
  // Cancelled, or run out: the month is over, so there is nothing to protect.
  for (const sub of [
    { status: "cancelled", currentPeriodEnd: new Date(Date.now() + 20 * DAY) },
    { status: "expired", currentPeriodEnd: new Date(Date.now() - 2 * DAY) },
  ]) {
    const perUseWorld = copyWithPaidMonth({ pricingModel: "per_request", pricePerRequestCents: 5n }, sub);
    const started = await withWorld(perUseWorld, ({ startUsing }) =>
      startUsing(LISTING_ID, BUYER, { expected: perUse(5), acceptNewPricing: true }),
    );
    assert.equal(started.created, true, sub.status);
    assert.equal(started.access, "listing_pricing");
    assert.equal(perUseWorld.state.installs[0]!.kind, "use");
    assert.equal(perUseWorld.state.balance, 10_000n, "a price per use charges nothing at the start");

    const monthlyWorld = copyWithPaidMonth({ pricingModel: "monthly", monthlyPriceCents: 900n }, sub);
    const subscribed = await withWorld(monthlyWorld, ({ startUsing }) =>
      startUsing(LISTING_ID, BUYER, { expected: monthly(900) }),
    );
    assert.equal(subscribed.created, true, sub.status);
    assert.equal(subscribed.access, "subscribed");
    assert.equal(monthlyWorld.state.balance, 9_100n, "one new month");
    assert.equal(monthlyWorld.state.ledger.length, 1);
  }
});

test("once the copy is removed, a start goes through as a new agreement", async () => {
  const world = copyWithPaidMonth({ pricingModel: "monthly", monthlyPriceCents: 900n });
  await withWorld(world, async ({ startUsing, uninstallAgent, UseStartError }) => {
    await assert.rejects(startUsing(LISTING_ID, BUYER, { expected: monthly(900) }), UseStartError);
    assert.deepEqual(await uninstallAgent(LISTING_ID, BUYER), { success: true });
    assert.equal(world.state.subs[0]!.status, "cancelled");
    assert.equal(world.state.balance, 10_000n, "the copy's month is not refunded");

    const started = await startUsing(LISTING_ID, BUYER, { expected: monthly(900) });
    assert.equal(started.created, true);
    assert.equal(started.access, "subscribed");
  });
  assert.equal(world.state.installs[0]!.kind, "use");
  assert.equal(world.state.installs[0]!.status, "active");
  assert.equal(world.state.balance, 9_100n);
  assert.equal(world.state.ledger.length, 1);
});

test("no start, and no first month, on an agent that answers through its graph", async () => {
  // The listing rules refuse a graph agent, but a version rollback can put
  // one under a published listing. Such an agent cannot answer a paid use.
  for (const [listingNow, expected] of [
    [{ pricingModel: "monthly", monthlyPriceCents: 900n }, monthly(900)],
    [{ pricingModel: "per_request", pricePerRequestCents: 5n }, perUse(5)],
  ] as const) {
    const world = makeWorld(listingNow);
    world.state.listing.agent.entrypoint = "graph";
    const refused = await startRefusal(world, expected);
    assert.ok(refused, listingNow.pricingModel);
    assert.deepEqual(
      [refused.status, refused.code, refused.message],
      [409, "not_offered", "Use of this agent is not on sale right now."],
    );
    assert.equal(world.state.installs.length, 0);
    assert.equal(world.state.subs.length, 0);
    assert.equal(world.state.balance, 10_000n);
    assert.equal(world.state.ledger.length, 0);
  }

  // Someone already inside a paid month is answered as they stand: nothing is charged either way.
  const subscriber = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 900n,
    install: { status: "active" },
    sub: { status: "active", currentPeriodEnd: new Date(Date.now() + 20 * DAY), priceCents: 900n },
  });
  subscriber.state.listing.agent.entrypoint = "graph";
  const state = await withWorld(subscriber, ({ startUsing }) => startUsing(LISTING_ID, BUYER, { expected: monthly(900) }));
  assert.deepEqual([state.created, state.access], [false, "subscribed"]);
  assert.equal(subscriber.state.balance, 10_000n);

  // An agent that answers from its instructions starts as before.
  const chat = makeWorld({ pricingModel: "monthly", monthlyPriceCents: 900n });
  chat.state.listing.agent.entrypoint = "chat";
  const started = await withWorld(chat, ({ startUsing }) => startUsing(LISTING_ID, BUYER, { expected: monthly(900) }));
  assert.equal(started.created, true);
});

test("startUsing reads the agent's entrypoint with the listing, and never its instructions", async () => {
  const world = makeWorld({ pricingModel: "per_request", pricePerRequestCents: 5n });
  const seen: Row[] = [];
  world.models.agentListing.findUnique = async (args: Row) => {
    seen.push(args);
    return structuredClone(world.state.listing);
  };
  await withWorld(world, ({ startUsing }) => startUsing(LISTING_ID, BUYER, { expected: perUse(5) }));
  const select = seen[0]!.include.agent.select;
  assert.equal(select.entrypoint, true);
  assert.equal("systemPrompt" in select, false);
  assert.equal("tools" in select, false);
});

test("install on a listing that sells use is refused with the agent's handle, and so is install over an active use licence", async () => {
  const sellsUse = makeWorld({ pricingModel: "per_request", pricePerRequestCents: 5n });
  await withWorld(sellsUse, async ({ installAgent, InstallRefusedError }) => {
    await assert.rejects(installAgent(LISTING_ID, BUYER), (err: unknown) => {
      assert.ok(err instanceof InstallRefusedError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "sells_use");
      assert.equal(err.handle, "analyst");
      assert.equal(err.message, "You use this agent on its page. You do not get a copy.");
      return true;
    });
  });
  assert.equal(sellsUse.state.agents.length, 0);
  assert.equal(sellsUse.state.installs.length, 0);

  // The listing sells copies now; this buyer's month of use still runs.
  const stillUsing = makeWorld({
    sells: "copies",
    pricingModel: "monthly",
    monthlyPriceCents: 900n,
    install: { status: "active" },
    sub: { status: "active", currentPeriodEnd: new Date(Date.now() + 10 * DAY), priceCents: 900n },
  });
  await withWorld(stillUsing, async ({ installAgent, InstallRefusedError }) => {
    await assert.rejects(installAgent(LISTING_ID, BUYER, { acceptNewPricing: true }), (err: unknown) => {
      assert.ok(err instanceof InstallRefusedError);
      assert.equal(err.code, "already_using");
      assert.equal(err.handle, "analyst");
      return true;
    });
  });
  assert.equal(stillUsing.state.agents.length, 0);
  assert.equal(stillUsing.state.installs[0]!.kind, "use");
  assert.equal(stillUsing.state.balance, 10_000n);

  // Once they have stopped, a copy can be installed, and the row says so.
  const stopped = makeWorld({ sells: "copies", pricingModel: "free", install: { status: "uninstalled" } });
  await withWorld(stopped, ({ installAgent }) => installAgent(LISTING_ID, BUYER));
  assert.equal(stopped.state.installs[0]!.kind, "copy");
  assert.equal(stopped.state.installs[0]!.clonedAgentId, stopped.state.agents[0]!.id);
});

// ============================================
// Stop
// ============================================

test("stopping ends the licence and the subscription now, with no refund and nothing done to any copy", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 900n,
    install: { status: "active" },
    sub: { status: "active", currentPeriodEnd: new Date(Date.now() + 20 * DAY), priceCents: 900n },
  });
  world.state.listing.activeInstalls = 1;
  await withWorld(world, async ({ uninstallAgent, getMyInstalls, checkInstallStatus }) => {
    assert.deepEqual(await uninstallAgent(LISTING_ID, BUYER), { success: true });
    // Ended: off the list, and read as no licence.
    assert.deepEqual(await getMyInstalls(BUYER), []);
    const status = await checkInstallStatus(LISTING_ID, BUYER);
    assert.equal(status.isInstalled, false);
    assert.equal(status.install!.access, "none");
    // A second stop moves nothing.
    await assert.rejects(uninstallAgent(LISTING_ID, BUYER), /not currently installed/);
  });
  assert.equal(world.state.installs[0]!.status, "uninstalled");
  assert.ok(world.state.installs[0]!.uninstalledAt instanceof Date);
  assert.equal(world.state.subs[0]!.status, "cancelled");
  assert.equal(world.state.subs[0]!.cancelAtPeriodEnd, false);
  // The month is not refunded: no credit moves and no ledger row is written.
  assert.equal(world.state.balance, 10_000n);
  assert.equal(world.state.ledger.length, 0);
  assert.equal(world.state.listing.activeInstalls, 0);
  // There is no copy, so no schedule of one is looked for.
  assert.deepEqual(world.state.taskWrites, []);
  assert.equal(world.state.agents.length, 0);
});

test("after stopping, starting again is a new agreement and a new month", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 900n,
    install: { status: "uninstalled", uninstalledAt: new Date() },
    sub: { status: "cancelled", currentPeriodEnd: new Date(Date.now() + 20 * DAY), priceCents: 900n },
  });
  const result = await withWorld(world, ({ startUsing }) => startUsing(LISTING_ID, BUYER, { expected: monthly(900) }));
  assert.equal(result.created, true);
  assert.equal(result.access, "subscribed");
  assert.equal(world.state.balance, 9_100n);
  assert.equal(world.state.installs[0]!.status, "active");
  assert.equal(world.state.installs[0]!.uninstalledAt, null);
  assert.equal(world.state.listing.activeInstalls, 1);
});

// ============================================
// What the buyer is shown
// ============================================

test("a use row says it is use, names the agent's page, and takes its access from the use rules", async () => {
  const row = async (world: World) => withWorld(world, async ({ getMyInstalls }) => (await getMyInstalls(BUYER))[0]!);

  const running = await row(makeWorld({ pricingModel: "per_request", pricePerRequestCents: 5n, install: { status: "active" } }));
  assert.equal(running.kind, "use");
  assert.equal(running.clonedAgentId, null);
  assert.deepEqual(running.agent, AGENT);
  assert.equal(running.access, "listing_pricing");
  assert.equal(running.listing.sells, "use");
  assert.equal(running.listing.unit, "message");
  assert.equal(running.listing.agent!.handle, "analyst");
  assert.doesNotMatch(JSON.stringify(running), /secret analyst|systemPrompt/);

  // No longer sold for use, and no paid month: a copy would read "unlisted"
  // and keep running free. Use does not.
  for (const change of [{ sells: "copies" }, { listingStatus: "archived" }]) {
    const gone = await row(
      makeWorld({ pricingModel: "per_request", pricePerRequestCents: 5n, install: { status: "active" }, ...change }),
    );
    assert.equal(gone.access, "not_offered");
  }

  // A month that was paid for is honoured whatever the listing says now.
  const paid = await row(
    makeWorld({
      sells: "copies",
      listingStatus: "archived",
      pricingModel: "monthly",
      monthlyPriceCents: 900n,
      install: { status: "active" },
      sub: { status: "active", currentPeriodEnd: new Date(Date.now() + 10 * DAY), priceCents: 900n },
    }),
  );
  assert.equal(paid.access, "subscribed");
});

// ============================================
// The route
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

const OWNER = { userId: "u1", orgId: BUYER, type: "jwt", role: "owner" };

async function post(world: World, principal: Row, url: string, payload?: Row) {
  return withWorld(world, async () => {
    const app = await appAs(principal);
    try {
      const res = await app.inject({ method: "POST", url, ...(payload !== undefined && { payload }) });
      return { status: res.statusCode, body: res.json() as Row };
    } finally {
      await app.close();
    }
  });
}

const USE_URL = `/listings/${LISTING_ID}/use`;

test("POST /listings/:id/use answers 201 with the state, and 200 when already using", async () => {
  const world = makeWorld({ pricingModel: "monthly", monthlyPriceCents: 900n });
  const first = await post(world, OWNER, USE_URL, { expected: monthly(900) });
  assert.equal(first.status, 201);
  assert.deepEqual(Object.keys(first.body).sort(), ["acceptedPricing", "access", "agent", "subscription"]);
  assert.equal(first.body.access, "subscribed");
  assert.deepEqual(first.body.agent, AGENT);
  assert.equal(first.body.acceptedPricing.pricingModel, "monthly");
  assert.equal(first.body.subscription.priceCents, 900);
  assert.doesNotMatch(JSON.stringify(first.body), /secret analyst|http_request/);

  const second = await post(world, OWNER, USE_URL, { expected: monthly(900) });
  assert.equal(second.status, 200);
  assert.equal(second.body.access, "subscribed");
  assert.equal(world.state.balance, 9_100n);
  assert.equal(world.state.ledger.length, 1);
});

test("POST /listings/:id/use: each refusal has its status, its code and a plain sentence", async () => {
  const paid = () => makeWorld({ pricingModel: "per_request", pricePerRequestCents: 8n });

  for (const payload of [undefined, {}, { acceptNewPricing: true }, { expected: { pricingModel: "weekly" } }]) {
    const res = await post(paid(), OWNER, USE_URL, payload);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "expected_terms_required");
    assert.match(res.body.message, /price you were shown/);
  }

  const changed = await post(paid(), OWNER, USE_URL, { expected: perUse(5) });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "pricing_changed");
  assert.deepEqual(changed.body.pricing, perUse(8));

  const broke = makeWorld({ pricingModel: "monthly", monthlyPriceCents: 900n, balance: 10n });
  const unpaid = await post(broke, OWNER, USE_URL, { expected: monthly(900) });
  assert.equal(unpaid.status, 402);
  assert.equal(unpaid.body.error, "insufficient_credits");
  assert.equal(unpaid.body.requiredCents, 900);
  assert.equal(broke.state.installs.length, 0);

  const own = await post(paid(), { ...OWNER, orgId: PUBLISHER }, USE_URL, { expected: perUse(8) });
  assert.deepEqual([own.status, own.body.error], [409, "own_agent"]);

  const copies = await post(
    makeWorld({ sells: "copies", pricingModel: "per_request", pricePerRequestCents: 8n }),
    OWNER,
    USE_URL,
    { expected: perUse(8) },
  );
  assert.deepEqual([copies.status, copies.body.error], [409, "sells_copies"]);

  const missing = await post(
    makeWorld({ pricingModel: "per_request", pricePerRequestCents: 8n, listingStatus: "archived" }),
    OWNER,
    USE_URL,
    { expected: perUse(8) },
  );
  assert.deepEqual([missing.status, missing.body.error], [404, "listing_not_found"]);

  // A lost claim: the licence row moved between the read and the write.
  const raced = paid();
  raced.state.installs.push({
    id: "ins_1",
    listingId: LISTING_ID,
    buyerId: BUYER,
    kind: "use",
    status: "uninstalled",
    clonedAgentId: null,
    acceptedPricingModel: "per_request",
    acceptedPricePerRequestCents: 8n,
  });
  raced.models.agentInstall.updateMany = async () => ({ count: 0 });
  const lost = await post(raced, OWNER, USE_URL, { expected: perUse(8) });
  assert.deepEqual([lost.status, lost.body.error], [409, "subscription_claim_lost"]);
  assert.doesNotMatch(lost.body.message, /install/i);
});

test("POST /listings/:id/use answers 409 copy_subscription_active with the day the copy's month ends, and 409 not_offered for a graph agent", async () => {
  const world = copyWithPaidMonth({ pricingModel: "per_request", pricePerRequestCents: 5n });
  const before = moneyAndRows(world);
  const res = await post(world, OWNER, USE_URL, { expected: perUse(5) });
  assert.equal(res.status, 409);
  assert.deepEqual(Object.keys(res.body).sort(), ["error", "message", "until"]);
  assert.equal(res.body.error, "copy_subscription_active");
  assert.equal(res.body.until, "2099-03-14T12:00:00.000Z");
  assert.match(res.body.message, /paid for until 14 Mar/);
  assert.deepEqual(moneyAndRows(world), before);

  const graph = makeWorld({ pricingModel: "monthly", monthlyPriceCents: 900n });
  graph.state.listing.agent.entrypoint = "graph";
  const refused = await post(graph, OWNER, USE_URL, { expected: monthly(900) });
  assert.equal(refused.status, 409);
  // The other refusals carry no date.
  assert.deepEqual(refused.body, { error: "not_offered", message: "Use of this agent is not on sale right now." });
  assert.equal(graph.state.balance, 10_000n);
});

test("POST /listings/:id/use: only an owner or admin, or a key granted marketplace:install by name, may agree to a price", async () => {
  const attempt = async (principal: Row, currentRole?: string | null) => {
    const world = makeWorld({ pricingModel: "monthly", monthlyPriceCents: 900n });
    if (currentRole !== undefined) {
      world.models.orgMember.findUnique = async () => (currentRole ? { role: currentRole } : null);
    }
    const res = await post(world, principal, USE_URL, { expected: monthly(900) });
    return { res, world };
  };

  for (const role of ["owner", "admin"]) {
    const { res, world } = await attempt({ ...OWNER, role }, role);
    assert.equal(res.status, 201, role);
    assert.equal(world.state.balance, 9_100n);
  }
  // A member, and an admin who was demoted after the token was issued.
  for (const [tokenRole, currentRole] of [["member", "member"], ["admin", "member"], ["admin", null]] as const) {
    const { res, world } = await attempt({ ...OWNER, role: tokenRole }, currentRole);
    assert.equal(res.status, 403, `${tokenRole} now ${currentRole}`);
    assert.equal(world.state.balance, 10_000n);
    assert.equal(world.state.installs.length, 0);
  }

  const key = (scopes: string[]) => ({ userId: null, orgId: BUYER, type: "api_key", scopes });
  const granted = await attempt(key(["marketplace:install"]));
  assert.equal(granted.res.status, 201);
  for (const scopes of [["*"], [], ["agents:use"], ["agents:invoke"]]) {
    const { res, world } = await attempt(key(scopes));
    assert.equal(res.status, 403, JSON.stringify(scopes));
    assert.equal(world.state.balance, 10_000n);
    assert.equal(world.state.installs.length, 0);
  }
});

test("POST /listings/:id/install answers 409 sells_use with the handle on a listing that sells use", async () => {
  const world = makeWorld({ pricingModel: "per_request", pricePerRequestCents: 5n });
  const res = await post(world, OWNER, `/listings/${LISTING_ID}/install`, {});
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, {
    error: "sells_use",
    message: "You use this agent on its page. You do not get a copy.",
    handle: "analyst",
  });
  assert.equal(world.state.agents.length, 0);

  const using = makeWorld({
    sells: "copies",
    pricingModel: "monthly",
    monthlyPriceCents: 900n,
    install: { status: "active" },
    sub: { status: "active", currentPeriodEnd: new Date(Date.now() + 10 * DAY), priceCents: 900n },
  });
  const again = await post(using, OWNER, `/listings/${LISTING_ID}/install`, {});
  assert.deepEqual([again.status, again.body.error, again.body.handle], [409, "already_using", "analyst"]);
});

test("the stop route ends a use licence, and the install-status route reports the kind and the agent", async () => {
  const world = makeWorld({ pricingModel: "per_request", pricePerRequestCents: 5n, install: { status: "active" } });
  world.state.listing.activeInstalls = 1;
  const status = await withWorld(world, async () => {
    const app = await appAs(OWNER);
    try {
      return (await app.inject({ method: "GET", url: `/listings/${LISTING_ID}/install-status` })).json() as Row;
    } finally {
      await app.close();
    }
  });
  assert.equal(status.isInstalled, true);
  assert.equal(status.install.kind, "use");
  assert.equal(status.install.clonedAgentId, null);
  assert.deepEqual(status.install.agent, AGENT);
  assert.equal(status.install.access, "listing_pricing");

  const stopped = await post(world, OWNER, `/listings/${LISTING_ID}/uninstall`);
  assert.equal(stopped.status, 200);
  assert.equal(world.state.installs[0]!.status, "uninstalled");
  assert.equal(world.state.listing.activeInstalls, 0);
});
