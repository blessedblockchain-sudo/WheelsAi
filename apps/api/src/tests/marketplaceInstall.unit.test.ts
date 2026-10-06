import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";

// installAgent against an in-memory database. What these pin: subscribing
// on an install that is already active never charges twice, a request
// that read a stale clone id cannot orphan a clone, a pricing change needs
// the buyer's explicit acceptance, and the installs list reports the
// agreed price and the access the billing path will actually apply.

const DAY = 24 * 60 * 60 * 1000;
const LISTING_ID = "lst_1";
const BUYER = "org_buyer";

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
  pricingModel: string;
  monthlyPriceCents?: bigint | null;
  pricePerRequestCents?: bigint | null;
  listingStatus?: string;
  install?: { status: string; clonedAgentId: string | null };
  sub?: Row;
  agents?: string[];
  balance?: bigint;
}) {
  const state = {
    listing: {
      id: LISTING_ID,
      title: "Research Analyst",
      publisherId: "org_pub",
      status: opts.listingStatus ?? "published",
      pricingModel: opts.pricingModel,
      monthlyPriceCents: opts.monthlyPriceCents ?? null,
      pricePerRequestCents: opts.pricePerRequestCents ?? null,
      totalInstalls: 0,
      activeInstalls: 0,
      agent: { id: "agent_src", name: "Analyst", slug: "analyst", tags: [], framework: "mastra" },
    } as Row,
    installs: (opts.install
      ? [{ id: "ins_1", listingId: LISTING_ID, buyerId: BUYER, uninstalledAt: null, ...opts.install }]
      : []) as Row[],
    subs: (opts.sub
      ? [{ id: "sub_1", listingId: LISTING_ID, subscriberId: BUYER, cancelAtPeriodEnd: false, endReason: null, ...opts.sub }]
      : []) as Row[],
    agents: (opts.agents ?? []).map((id) => ({ id, orgId: BUYER })) as Row[],
    balance: opts.balance ?? 10_000n,
    ledger: [] as Row[],
    revenue: [] as Row[],
  };
  let seq = 0;

  const models: Row = {
    agentListing: {
      findUnique: async () => ({ ...state.listing }),
      update: async ({ data }: Row) => {
        for (const [k, v] of Object.entries<Row>(data)) {
          state.listing[k] += (v.increment ?? 0) - (v.decrement ?? 0);
        }
        return { ...state.listing };
      },
      aggregate: async () => ({ _count: { id: 1 }, _sum: { totalInstalls: state.listing.totalInstalls } }),
    },
    agentInstall: {
      findUnique: async () => (state.installs[0] ? { ...state.installs[0] } : null),
      findMany: async () => state.installs.map((i) => ({ ...i, listing: { ...state.listing } })),
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
        const row = { id: `ins_${++seq}`, uninstalledAt: null, ...data };
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
    publisherProfile: { findUnique: async () => null, update: async () => ({}) },
  };

  // One transaction at a time, as the row locks make it in Postgres: the
  // second waits for the first to commit, then runs against what it left.
  // Reads made before the transaction stay as stale as they were.
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

async function withWorld<T>(
  world: ReturnType<typeof makeWorld>,
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

const outcomes = (results: PromiseSettledResult<unknown>[]) => results.map((r) => r.status).sort();

// ============================================
// Subscribing on an active install
// ============================================

test("two concurrent subscribes on an active install with no subscription charge once", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 1_000n,
    install: { status: "active", clonedAgentId: "agent_c0" },
    agents: ["agent_c0"],
  });
  await withWorld(world, async ({ installAgent }) => {
    const results = await Promise.allSettled([installAgent(LISTING_ID, BUYER), installAgent(LISTING_ID, BUYER)]);
    assert.deepEqual(outcomes(results), ["fulfilled", "rejected"]);
  });
  assert.equal(world.state.balance, 9_000n);
  assert.equal(world.state.ledger.length, 1);
  assert.equal(world.state.revenue.length, 1);
  assert.equal(world.state.subs.length, 1);
});

test("two concurrent resubscribes on an active install with a lapsed subscription charge once", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 1_000n,
    install: { status: "active", clonedAgentId: "agent_c0" },
    agents: ["agent_c0"],
    sub: { status: "past_due", currentPeriodEnd: new Date(Date.now() - 10 * DAY), priceCents: 1_000n },
  });
  await withWorld(world, async ({ installAgent }) => {
    const results = await Promise.allSettled([installAgent(LISTING_ID, BUYER), installAgent(LISTING_ID, BUYER)]);
    assert.deepEqual(outcomes(results), ["fulfilled", "rejected"]);
  });
  assert.equal(world.state.balance, 9_000n);
  assert.equal(world.state.ledger.length, 1);
  assert.equal(world.state.subs[0]!.status, "active");
});

test("with the clone deleted, concurrent subscribes create one clone and leave none orphaned", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 1_000n,
    install: { status: "active", clonedAgentId: "agent_deleted" },
  });
  await withWorld(world, async ({ installAgent }) => {
    const results = await Promise.allSettled([installAgent(LISTING_ID, BUYER), installAgent(LISTING_ID, BUYER)]);
    assert.deepEqual(outcomes(results), ["fulfilled", "rejected"]);
  });
  assert.equal(world.state.agents.length, 1);
  assert.equal(world.state.installs[0]!.clonedAgentId, world.state.agents[0]!.id);
  assert.equal(world.state.balance, 9_000n);
});

test("an install that runs cannot be installed again", async () => {
  const world = makeWorld({
    pricingModel: "per_request",
    pricePerRequestCents: 5n,
    install: { status: "active", clonedAgentId: "agent_c0" },
    agents: ["agent_c0"],
  });
  await withWorld(world, async ({ installAgent }) => {
    await assert.rejects(installAgent(LISTING_ID, BUYER), /already installed/);
  });

  const paidUp = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 1_000n,
    install: { status: "active", clonedAgentId: "agent_c0" },
    agents: ["agent_c0"],
    sub: { status: "active", currentPeriodEnd: new Date(Date.now() + 10 * DAY), priceCents: 1_000n },
  });
  await withWorld(paidUp, async ({ installAgent }) => {
    await assert.rejects(installAgent(LISTING_ID, BUYER), /already installed/);
  });
  assert.equal(paidUp.state.balance, 10_000n);
});

// ============================================
// Stale clone id
// ============================================

test("a request that read the install before another install repointed it cannot create a second clone", async () => {
  const world = makeWorld({
    pricingModel: "per_request",
    pricePerRequestCents: 5n,
    // Uninstalled, and the buyer has since deleted the old clone.
    install: { status: "uninstalled", clonedAgentId: "agent_deleted" },
  });
  await withWorld(world, async ({ installAgent, uninstallAgent }) => {
    // The stale request has read the row; before its transaction starts,
    // an install and an uninstall run to completion. The row is
    // 'uninstalled' again, but now points at the clone that install made.
    const realFind = world.models.agentSubscription.findUnique;
    let interleaved = false;
    world.models.agentSubscription.findUnique = async (args: Row) => {
      if (!interleaved) {
        interleaved = true;
        await installAgent(LISTING_ID, BUYER);
        await uninstallAgent(LISTING_ID, BUYER);
      }
      return realFind(args);
    };
    await assert.rejects(installAgent(LISTING_ID, BUYER), /already being installed/);
  });
  // One clone, and the install row still points at it.
  assert.equal(world.state.agents.length, 1);
  assert.equal(world.state.installs[0]!.clonedAgentId, world.state.agents[0]!.id);
  assert.equal(world.state.installs[0]!.status, "uninstalled");
});

// ============================================
// Pricing change
// ============================================

function repriced(install: { status: string }, endReason: string) {
  return makeWorld({
    pricingModel: "per_request",
    pricePerRequestCents: 100_000n,
    install: { ...install, clonedAgentId: "agent_c0" },
    agents: ["agent_c0"],
    sub: { status: "cancelled", currentPeriodEnd: new Date(Date.now() - DAY), priceCents: 100n, endReason },
  });
}

test("a repriced install stays paused until the buyer explicitly accepts the new pricing", async () => {
  const world = repriced({ status: "suspended" }, "pricing_changed");
  await withWorld(world, async ({ installAgent, PricingChangedError }) => {
    await assert.rejects(installAgent(LISTING_ID, BUYER), (err: unknown) => {
      assert.ok(err instanceof PricingChangedError);
      assert.deepEqual(err.pricing, {
        pricingModel: "per_request",
        pricePerRequestCents: 100_000,
        monthlyPriceCents: null,
      });
      return true;
    });
    assert.equal(world.state.installs[0]!.status, "suspended");
    assert.equal(world.state.subs[0]!.endReason, "pricing_changed");

    await installAgent(LISTING_ID, BUYER, { acceptNewPricing: true });
  });
  assert.equal(world.state.installs[0]!.status, "active");
  assert.equal(world.state.subs[0]!.endReason, null);
  // Accepting per-request pricing charges nothing by itself.
  assert.equal(world.state.balance, 10_000n);
  // A resumed install was never uncounted, so it is not counted again.
  assert.equal(world.state.listing.activeInstalls, 0);
});

test("accepting on an install that is still active is claimed once", async () => {
  // An archived listing published again as per-request: the install row
  // never left 'active', so the acceptance itself has to be exclusive.
  const world = repriced({ status: "active" }, "listing_archived");
  await withWorld(world, async ({ installAgent }) => {
    const results = await Promise.allSettled([
      installAgent(LISTING_ID, BUYER, { acceptNewPricing: true }),
      installAgent(LISTING_ID, BUYER, { acceptNewPricing: true }),
    ]);
    assert.deepEqual(outcomes(results), ["fulfilled", "rejected"]);
  });
  assert.equal(world.state.subs[0]!.endReason, null);
  assert.equal(world.state.agents.length, 1);
});

function ranOut(sub: Row, install = "active") {
  return makeWorld({
    pricingModel: "per_request",
    pricePerRequestCents: 100_000n,
    install: { status: install, clonedAgentId: "agent_c0" },
    agents: ["agent_c0"],
    sub: { currentPeriodStart: new Date(Date.now() - 40 * DAY), cancelledAt: null, priceCents: 100n, ...sub },
  });
}

for (const [name, sub] of [
  ["cancelled renewal, period just ended", { status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() - 60_000) }],
  ["worker not running, grace over", { status: "active", currentPeriodEnd: new Date(Date.now() - 10 * DAY) }],
] as const) {
  test(`a run-out subscription the renewal worker has not closed needs acceptance too (${name})`, async () => {
    const world = ranOut(sub);
    const periodEnd = world.state.subs[0]!.currentPeriodEnd;
    await withWorld(world, async ({ installAgent, getMyInstalls, PricingChangedError }) => {
      assert.equal((await getMyInstalls(BUYER))[0]!.access, "pricing_changed");
      await assert.rejects(installAgent(LISTING_ID, BUYER), PricingChangedError);
      assert.equal(world.state.subs[0]!.status, "active");

      const results = await Promise.allSettled([
        installAgent(LISTING_ID, BUYER, { acceptNewPricing: true }),
        installAgent(LISTING_ID, BUYER, { acceptNewPricing: true }),
      ]);
      assert.deepEqual(outcomes(results), ["fulfilled", "rejected"]);
      assert.equal((await getMyInstalls(BUYER))[0]!.access, "listing_pricing");
    });
    // Closed by the acceptance, so the worker's close (which matches an
    // open status) can no longer suspend the install.
    const row = world.state.subs[0]!;
    assert.equal(row.status, "cancelled");
    assert.equal(row.endReason, null);
    assert.equal(row.cancelAtPeriodEnd, false);
    assert.ok(row.cancelledAt instanceof Date);
    assert.equal(row.currentPeriodEnd.getTime(), periodEnd.getTime());
    assert.equal(world.state.installs[0]!.status, "active");
    assert.equal(world.state.agents.length, 1);
    assert.equal(world.state.balance, 10_000n);
    assert.equal(world.state.listing.activeInstalls, 0);
  });
}

test("an acceptance that read the row before the renewal worker closed it does not go through", async () => {
  const world = ranOut({ status: "active", currentPeriodEnd: new Date(Date.now() - 10 * DAY) });
  await withWorld(world, async ({ installAgent }) => {
    const realFind = world.models.agentSubscription.findUnique;
    world.models.agentSubscription.findUnique = async (args: Row) => {
      const read = await realFind(args);
      // The worker's close lands after the read: subscription ended with
      // the reason, install suspended.
      Object.assign(world.state.subs[0]!, { status: "cancelled", endReason: "pricing_changed" });
      world.state.installs[0]!.status = "suspended";
      return read;
    };
    await assert.rejects(installAgent(LISTING_ID, BUYER, { acceptNewPricing: true }), /already being installed/);
  });
  assert.equal(world.state.installs[0]!.status, "suspended");
  assert.equal(world.state.subs[0]!.endReason, "pricing_changed");
});

test("a suspended install whose subscription expired unpaid cannot be resubscribed onto per-request pricing without accepting it", async () => {
  const world = ranOut({ status: "expired", currentPeriodEnd: new Date(Date.now() - 10 * DAY) }, "suspended");
  await withWorld(world, async ({ installAgent, getMyInstalls, PricingChangedError }) => {
    assert.equal((await getMyInstalls(BUYER))[0]!.access, "pricing_changed");
    await assert.rejects(installAgent(LISTING_ID, BUYER), PricingChangedError);
    assert.equal(world.state.installs[0]!.status, "suspended");
    await installAgent(LISTING_ID, BUYER, { acceptNewPricing: true });
  });
  assert.equal(world.state.installs[0]!.status, "active");
  assert.equal(world.state.subs[0]!.status, "expired");
  assert.equal(world.state.balance, 10_000n);
});

// ============================================
// What the buyer is shown
// ============================================

test("the installs list reports the agreed price, not the listing's current one", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 100n, // lowered after the buyer subscribed at $100
    install: { status: "active", clonedAgentId: "agent_c0" },
    sub: {
      status: "active",
      currentPeriodStart: new Date(Date.now() - 20 * DAY),
      currentPeriodEnd: new Date(Date.now() + 10 * DAY),
      cancelledAt: null,
      priceCents: 10_000n,
    },
  });
  await withWorld(world, async ({ getMyInstalls }) => {
    const [install] = await getMyInstalls(BUYER);
    assert.equal(install!.subscription!.priceCents, 10_000);
    assert.equal(install!.listing.monthlyPriceCents, 100);
    assert.equal(install!.access, "subscribed");
  });
});

test("an archived monthly listing whose subscription closed is reported as unlisted, not lapsed", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 1_000n,
    listingStatus: "archived",
    install: { status: "active", clonedAgentId: "agent_c0" },
    sub: {
      status: "cancelled",
      currentPeriodStart: new Date(Date.now() - 40 * DAY),
      currentPeriodEnd: new Date(Date.now() - 10 * DAY),
      cancelledAt: new Date(),
      priceCents: 1_000n,
      endReason: "listing_archived",
    },
  });
  await withWorld(world, async ({ getMyInstalls }) => {
    const [install] = await getMyInstalls(BUYER);
    // The page offers Resubscribe only for 'subscription_lapsed'.
    assert.equal(install!.access, "unlisted");
    assert.equal(install!.subscription!.hasAccess, false);
  });
});

test("a legacy subscription with no stored price reports null, never the listing price", async () => {
  const world = makeWorld({
    pricingModel: "monthly",
    monthlyPriceCents: 9_000n,
    install: { status: "active", clonedAgentId: "agent_c0" },
    sub: {
      status: "active",
      currentPeriodStart: new Date(Date.now() - 20 * DAY),
      currentPeriodEnd: new Date(Date.now() + 10 * DAY),
      cancelledAt: null,
      priceCents: null,
    },
  });
  await withWorld(world, async ({ getMyInstalls }) => {
    const [install] = await getMyInstalls(BUYER);
    assert.equal(install!.subscription!.priceCents, null);
  });
});
