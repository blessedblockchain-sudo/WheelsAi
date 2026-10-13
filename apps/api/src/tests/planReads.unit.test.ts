import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

// What the buyer's pages read of plans: the plan in a buyer's installs and
// subscriptions, the plans of a listing on its own page, and the smallest
// plan price on the cards of a search. Through the real services against an
// in-memory database that counts its reads. What these pin: the plan is the
// one the access answer builds, a month with no count is answered as before
// with `plan: null`, plans are read only for a listing that offers them and
// in one query for a whole page, and nothing of another buyer is in any of it.

const DAY = 24 * 60 * 60 * 1000;
const BUYER = "org_buyer";
const OTHER_BUYER = "org_other";
const PUBLISHER = "org_pub";

type Row = Record<string, any>;

const listingRow = (id: string, over: Row = {}): Row => ({
  id,
  agentId: `agent_${id}`,
  title: `Listing ${id}`,
  slug: id,
  shortDescription: "",
  longDescription: null,
  category: "research",
  iconUrl: null,
  screenshots: [],
  readme: null,
  sells: "use",
  pricingModel: "per_request",
  pricePerRequestCents: 5n,
  monthlyPriceCents: null,
  publisherId: PUBLISHER,
  publisherName: "Pub",
  status: "published",
  isFeatured: false,
  totalInstalls: 3,
  activeInstalls: 2,
  avgRating: 0,
  reviewCount: 0,
  totalRequests: 0n,
  publishedAt: new Date(0),
  createdAt: new Date(0),
  updatedAt: new Date(0),
  agent: { id: `agent_${id}`, name: `Agent ${id}`, framework: "custom", agentKind: "conversation", tags: [], publicHandle: id },
  agentToken: null,
  ...over,
});

const planRow = (id: string, listingId: string, position: number, priceCents: bigint, over: Row = {}): Row => ({
  id,
  listingId,
  kind: "paid",
  status: "active",
  name: id,
  priceCents,
  includedUses: Number(priceCents),
  extraUsePriceCents: null,
  position,
  // What a buyer is never told.
  retiredAt: null,
  createdAt: new Date(0),
  ...over,
});

const installRow = (listingId: string, over: Row = {}): Row => ({
  id: `ins_${listingId}`,
  listingId,
  buyerId: BUYER,
  kind: "use",
  status: "active",
  clonedAgentId: null,
  totalRequests: 0n,
  totalSpentCents: 0n,
  installedAt: new Date(0),
  acceptedPricingModel: null,
  acceptedPricePerRequestCents: null,
  pricingAcceptedAt: null,
  ...over,
});

const END = new Date(Date.now() + 20 * DAY);

const subRow = (listingId: string, over: Row = {}): Row => ({
  id: `sub_${listingId}`,
  listingId,
  subscriberId: BUYER,
  status: "active",
  currentPeriodStart: new Date(END.getTime() - 30 * DAY),
  currentPeriodEnd: END,
  cancelAtPeriodEnd: false,
  cancelledAt: null,
  priceCents: 900n,
  endReason: null,
  planId: null,
  includedUses: null,
  usedInPeriod: 0,
  carriedUses: 0,
  extraUsePriceCents: null,
  warnedLevel: 0,
  ...over,
});

function makeWorld(opts: { listings: Row[]; plans?: Row[]; installs?: Row[]; subs?: Row[] }) {
  const plans = opts.plans ?? [];
  /** Every read of listing_plans, as it was asked. */
  const planReads: Row[] = [];
  const listingOf = (id: string) => opts.listings.find((l) => l.id === id)!;
  const models: Row = {
    agentListing: {
      findMany: async () => opts.listings.map((l) => ({ ...l })),
      count: async () => opts.listings.length,
      findUnique: async ({ where }: Row) => {
        const row = opts.listings.find((l) => l.slug === where.slug && l.status === where.status);
        return row ? { ...row } : null;
      },
    },
    listingPlan: {
      findMany: async (args: Row) => {
        planReads.push(args);
        const ids: string[] = typeof args.where.listingId === "string" ? [args.where.listingId] : args.where.listingId.in;
        return plans
          .filter((p) => ids.includes(p.listingId) && p.status === args.where.status && p.kind === args.where.kind)
          .sort((a, b) => a.position - b.position)
          .map((p) => ({ ...p }));
      },
    },
    agentInstall: {
      findMany: async ({ where }: Row) =>
        (opts.installs ?? [])
          .filter((i) => i.buyerId === where.buyerId && where.status.in.includes(i.status))
          .map((i) => ({ ...i, listing: { ...listingOf(i.listingId) } })),
    },
    agentSubscription: {
      findMany: async ({ where, include }: Row) =>
        (opts.subs ?? [])
          .filter((s) => s.subscriberId === where.subscriberId)
          .map((s) => {
            const plan = plans.find((p) => p.id === s.planId) ?? null;
            return {
              ...s,
              ...(include?.plan && { plan: plan && { status: plan.status, name: plan.name } }),
              ...(include?.listing && { listing: { ...listingOf(s.listingId) } }),
            };
          }),
    },
  };
  return { models, planReads };
}

type World = ReturnType<typeof makeWorld>;

async function withWorld<T>(world: World, body: (svc: typeof import("../services/marketplace.js")) => Promise<T>): Promise<T> {
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

/** Three listings: two that offer plans, one sold by the month that has none to offer. */
const LISTINGS = [
  listingRow("alpha"),
  listingRow("beta"),
  listingRow("gamma", { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 1500n }),
];
const PLANS = [
  planRow("starter", "alpha", 1, 900n, { extraUsePriceCents: 5n, includedUses: 500 }),
  planRow("pro", "alpha", 2, 2900n, { includedUses: 2000 }),
  planRow("old", "alpha", 3, 100n, { status: "retired", retiredAt: new Date(0) }),
  planRow("big", "beta", 1, 4900n),
  planRow("small", "beta", 2, 700n),
  // Left behind on a listing that went monthly: still marked active, and not on offer.
  planRow("stale", "gamma", 1, 300n),
];
const offer = (id: string, priceCents: number, includedUses: number, extraUsePriceCents: number | null = null) => ({
  id,
  name: id,
  priceCents,
  includedUses,
  extraUsePriceCents,
});
const ALPHA_OFFERS = [offer("starter", 900, 500, 5), offer("pro", 2900, 2000)];
const BETA_OFFERS = [offer("big", 4900, 4900), offer("small", 700, 700)];

/** A subscription's fields before plans existed, in the order they are answered. */
const SUBSCRIPTION_KEYS = [
  "id",
  "listingId",
  "status",
  "priceCents",
  "endReason",
  "currentPeriodStart",
  "currentPeriodEnd",
  "cancelAtPeriodEnd",
  "cancelledAt",
  "hasAccess",
  "graceEndsAt",
];

// ============================================
// The search that feeds the cards
// ============================================

test("the search says the smallest plan price of each listing, read in one query for the page", async () => {
  const world = makeWorld({ listings: LISTINGS, plans: PLANS });
  const { listings } = await withWorld(world, ({ searchListings }) => searchListings({}));
  assert.deepEqual(
    listings.map((l: Row) => [l.slug, l.plansFromCents]),
    [
      ["alpha", 900],
      // Not the first in the creator's order: the smallest.
      ["beta", 700],
      // Sold by the month: it offers no plan, whatever rows it has left.
      ["gamma", null],
    ],
  );
  // One read for the three listings, and only the listings that offer plans are asked about.
  assert.equal(world.planReads.length, 1);
  assert.deepEqual(world.planReads[0]!.where, { listingId: { in: ["alpha", "beta"] }, status: "active", kind: "paid" });
  // A card carries the price and not the plans.
  assert.equal("plans" in listings[0]!, false);
});

test("a page of results with no listing that offers plans reads no plan at all", async () => {
  const world = makeWorld({
    listings: [
      listingRow("copies", { sells: "copies" }),
      listingRow("free", { pricingModel: "free", pricePerRequestCents: null }),
      LISTINGS[2]!,
    ],
    plans: [planRow("x", "copies", 1, 900n), planRow("y", "free", 1, 900n)],
  });
  const { listings } = await withWorld(world, ({ searchListings }) => searchListings({}));
  assert.deepEqual(listings.map((l: Row) => l.plansFromCents), [null, null, null]);
  assert.equal(world.planReads.length, 0);
});

test("a listing with no plan on offer says null, and one whose plans were all ended says null", async () => {
  const world = makeWorld({
    listings: [listingRow("alpha"), listingRow("beta")],
    plans: [planRow("gone", "beta", 1, 900n, { status: "retired" })],
  });
  const { listings } = await withWorld(world, ({ searchListings }) => searchListings({}));
  assert.deepEqual(listings.map((l: Row) => l.plansFromCents), [null, null]);
});

// ============================================
// The page of one listing
// ============================================

test("the public read of a listing carries its plans on offer, field by field, and an empty list when it has none", async () => {
  const world = makeWorld({ listings: LISTINGS, plans: PLANS });
  await withWorld(world, async ({ getListingBySlug }) => {
    const alpha = (await getListingBySlug("alpha"))!;
    // In the creator's order, without the one that was ended, and nothing
    // but the five fields: no status, no dates, no count of subscribers.
    assert.deepEqual(alpha.plans, ALPHA_OFFERS);
    assert.equal("plansFromCents" in alpha, false);
    assert.equal(world.planReads.length, 1);
    assert.deepEqual(world.planReads[0]!.where, { listingId: "alpha", status: "active", kind: "paid" });

    // Sold by the month: not asked about, and none.
    const gamma = (await getListingBySlug("gamma"))!;
    assert.deepEqual(gamma.plans, []);
    assert.equal(world.planReads.length, 1);
  });
});

// ============================================
// A buyer's installs
// ============================================

test("an install on a plan carries the plan the access answer builds, and its listing the plans on offer", async () => {
  const mine = subRow("alpha", { planId: "starter", includedUses: 500, usedInPeriod: 430, carriedUses: 20, extraUsePriceCents: 5n });
  const world = makeWorld({
    listings: LISTINGS,
    plans: PLANS,
    installs: [installRow("alpha"), installRow("beta", { acceptedPricingModel: "per_request", acceptedPricePerRequestCents: 5n }), installRow("gamma")],
    subs: [
      mine,
      subRow("gamma", { priceCents: 1500n }),
      // Somebody else's row on the same listing, on another plan.
      subRow("alpha", { id: "sub_theirs", subscriberId: OTHER_BUYER, planId: "pro", includedUses: 2000, usedInPeriod: 1999 }),
    ],
  });
  const { accessPlanOf } = await import("../services/paidUse.js");
  const rows = await withWorld(world, ({ getMyInstalls }) => getMyInstalls(BUYER));
  const [alpha, beta, gamma] = rows as Row[];

  const expected = {
    id: "starter",
    name: "starter",
    includedUses: 500,
    carriedUses: 20,
    usedUses: 430,
    remainingUses: 90,
    extraUsePriceCents: 5,
    resetsAt: END.toISOString(),
    warning: null,
  };
  assert.equal(alpha!.access, "subscribed");
  assert.deepEqual(alpha!.subscription.plan, expected);
  // The same function, so the Installed page and the agent's page say the same count.
  assert.deepEqual(alpha!.subscription.plan, accessPlanOf({ ...mine, planName: "starter" } as never, true));
  assert.deepEqual(alpha!.listing.plans, ALPHA_OFFERS);
  // Every field a subscription had before, and the plan.
  assert.deepEqual(Object.keys(alpha!.subscription), [...SUBSCRIPTION_KEYS, "plan"]);

  // Pays per use, no subscription: no plan of their own, and the plans they could start.
  assert.equal(beta!.subscription, null);
  assert.deepEqual(beta!.listing.plans, BETA_OFFERS);

  // Today's monthly subscriber: what it was, with `plan: null`.
  assert.deepEqual(Object.keys(gamma!.subscription), [...SUBSCRIPTION_KEYS, "plan"]);
  assert.deepEqual(
    [gamma!.subscription.plan, gamma!.subscription.priceCents, gamma!.subscription.hasAccess, gamma!.access],
    [null, 1500, true, "subscribed"],
  );
  assert.deepEqual(gamma!.listing.plans, []);

  // One read of plans for the three installs, and only for the listings that offer them.
  assert.equal(world.planReads.length, 1);
  assert.deepEqual(world.planReads[0]!.where.listingId, { in: ["alpha", "beta"] });
  // Nothing of the other buyer, and nothing a buyer is never told.
  assert.doesNotMatch(JSON.stringify(rows), /sub_theirs|org_other|1999|subscribers|retiredAt|"old"|"stale"/);
  assert.equal("plansFromCents" in alpha!.listing, false);
});

test("what an install says of its plan: the warning, a renewal that will not come, and a plan that is over", async () => {
  const planOf = async (sub: Row, listing: Row = {}, plan: Row = {}) => {
    const world = makeWorld({
      listings: [listingRow("alpha", listing)],
      plans: [planRow("starter", "alpha", 1, 900n, { includedUses: 500, ...plan })],
      installs: [installRow("alpha")],
      subs: [subRow("alpha", { planId: "starter", includedUses: 500, usedInPeriod: 12, ...sub })],
    });
    const [row] = (await withWorld(world, ({ getMyInstalls }) => getMyInstalls(BUYER))) as Row[];
    return row!.subscription.plan as Row | null;
  };
  const resets = (plan: Row | null) => (plan && "resetsAt" in plan ? plan.resetsAt : "left out");

  assert.deepEqual([(await planOf({ usedInPeriod: 424 }))!.warning, (await planOf({ usedInPeriod: 425 }))!.warning], [null, 85]);
  const usedUp = (await planOf({ usedInPeriod: 500 }))!;
  assert.deepEqual([usedUp.remainingUses, usedUp.warning, usedUp.extraUsePriceCents], [0, 100, null]);

  assert.equal(resets(await planOf({})), END.toISOString());
  // The buyer cancelled the renewal, the creator ended the plan, or the
  // listing no longer offers plans: the count does not start again.
  assert.equal(resets(await planOf({ cancelAtPeriodEnd: true })), "left out");
  assert.equal(resets(await planOf({}, {}, { status: "retired" })), "left out");
  assert.equal(resets(await planOf({}, { pricingModel: "monthly", monthlyPriceCents: 900n })), "left out");
  // In its days of grace the buyer still has what was left.
  const late = { status: "past_due", currentPeriodEnd: new Date(Date.now() - DAY) };
  assert.equal((await planOf(late))!.remainingUses, 488);

  // A plan that is over is told by the row's status and reason, not as a count.
  assert.equal(await planOf({ status: "cancelled", endReason: "plan_ended" }), null);
  assert.equal(await planOf({ status: "expired" }), null);
  assert.equal(await planOf({ status: "past_due", currentPeriodEnd: new Date(Date.now() - 4 * DAY) }), null);
  // Ended by its creator and past its period: no days of grace.
  assert.equal(await planOf({ currentPeriodEnd: new Date(Date.now() - DAY) }, {}, { status: "retired" }), null);
});

test("a buyer's subscriptions carry the same plan, and a month has none", async () => {
  const world = makeWorld({
    listings: LISTINGS,
    plans: PLANS,
    subs: [
      subRow("alpha", { planId: "pro", includedUses: 2000, usedInPeriod: 100, carriedUses: 188, priceCents: 2900n }),
      subRow("gamma", { priceCents: 1500n }),
      subRow("beta", { id: "sub_theirs", subscriberId: OTHER_BUYER, planId: "big", includedUses: 4900 }),
    ],
  });
  const subs = (await withWorld(world, ({ getMySubscriptions }) => getMySubscriptions(BUYER))) as Row[];
  assert.deepEqual(subs.map((s) => s.listingId), ["alpha", "gamma"]);
  assert.deepEqual(subs[0]!.plan, {
    id: "pro",
    name: "pro",
    includedUses: 2000,
    carriedUses: 188,
    usedUses: 100,
    remainingUses: 2088,
    extraUsePriceCents: null,
    resetsAt: END.toISOString(),
    warning: null,
  });
  assert.equal(subs[1]!.plan, null);
  assert.deepEqual(Object.keys(subs[1]!.listing), ["id", "title", "slug", "iconUrl", "monthlyPriceCents"]);
});

// ============================================
// The read itself
// ============================================

test("the plans of several listings are one read, grouped by listing in the order a buyer sees them", async () => {
  const { readPlanOffersOf, plansFromCentsOf } = await import("../services/planOffers.js");
  const world = makeWorld({ listings: LISTINGS, plans: PLANS });
  const offers = await readPlanOffersOf(world.models as never, LISTINGS as never);
  assert.deepEqual([...offers.keys()], ["alpha", "beta"]);
  assert.deepEqual(offers.get("alpha")!.map((p) => p.id), ["starter", "pro"]);
  assert.deepEqual(offers.get("beta")!.map((p) => p.id), ["big", "small"]);
  assert.equal(world.planReads.length, 1);
  assert.deepEqual(world.planReads[0]!.select, {
    id: true,
    name: true,
    priceCents: true,
    includedUses: true,
    extraUsePriceCents: true,
    listingId: true,
  });

  assert.equal(plansFromCentsOf(offers.get("beta")!), 700);
  assert.equal(plansFromCentsOf([]), null);
  // No listing: nothing to ask.
  assert.equal((await readPlanOffersOf(world.models as never, [])).size, 0);
  assert.equal(world.planReads.length, 1);
});
