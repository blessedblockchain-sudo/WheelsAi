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

function makeWorld(opts: {
  listings: Row[];
  plans?: Row[];
  installs?: Row[];
  subs?: Row[];
  /** Roles by user id, for the spend guard's lookup. "throws" = the lookup fails. */
  roles?: Record<string, string | null> | "throws";
}) {
  const plans = opts.plans ?? [];
  /** Every read of listing_plans, as it was asked. */
  const planReads: Row[] = [];
  /** Every read of a member's role. */
  const roleReads: Row[] = [];
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
          .filter(
            (p) =>
              ids.includes(p.listingId) &&
              p.status === args.where.status &&
              // One listing's read asks for the paid plans and the free trial together.
              (typeof args.where.kind === "string" ? p.kind === args.where.kind : args.where.kind.in.includes(p.kind)),
          )
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
    // A publisher's profile, with every listing of the world as theirs.
    publisherProfile: {
      findUnique: async ({ where }: Row) => ({
        displayName: "Pub",
        slug: where.slug,
        bio: null,
        avatarUrl: null,
        website: null,
        twitter: null,
        github: null,
        isVerified: false,
        totalListings: opts.listings.length,
        totalInstalls: 0,
        createdAt: new Date(0),
        org: { publishedListings: opts.listings.filter((l) => l.status === "published").map((l) => ({ ...l })) },
      }),
    },
    orgMember: {
      findUnique: async ({ where }: Row) => {
        roleReads.push(where.orgId_userId);
        if (opts.roles === "throws") throw new Error("db down");
        const role = opts.roles?.[where.orgId_userId.userId] ?? null;
        return role ? { role } : null;
      },
    },
  };
  return { models, planReads, roleReads };
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
    // One read, for the paid plans and the free trial together.
    assert.deepEqual(world.planReads[0]!.where, { listingId: "alpha", status: "active", kind: { in: ["paid", "trial"] } });
    assert.equal(alpha.freeTrial, null);

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
    trial: false,
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

test("an install says when what ended was the buyer's own free trial, and only then", async () => {
  const PAST = new Date(Date.now() - DAY);
  // The trial's row as its start writes it: a count, a price of nothing, set to end.
  const trial = { planId: "trial", includedUses: 20, usedInPeriod: 4, priceCents: 0n, cancelAtPeriodEnd: true };
  const rowOf = async (sub: Row | null, install: Row = {}) => {
    const world = makeWorld({
      listings: LISTINGS,
      plans: PLANS,
      installs: [installRow("alpha", install)],
      subs: sub ? [subRow("alpha", sub)] : [],
    });
    const [row] = (await withWorld(world, ({ getMyInstalls }) => getMyInstalls(BUYER))) as Row[];
    return row!;
  };
  const said = async (sub: Row | null, install: Row = {}) => {
    const row = await rowOf(sub, install);
    return [row.access, row.trialEnded];
  };

  // Its 7 days ran out, whether or not the renewal worker has closed the row.
  assert.deepEqual(await said({ ...trial, status: "expired", currentPeriodEnd: PAST }), ["plan_ended", true]);
  assert.deepEqual(await said({ ...trial, currentPeriodEnd: PAST }), ["plan_ended", true]);
  // A trial that runs.
  assert.deepEqual(await said(trial), ["subscribed", false]);
  // A paid plan that ended: the same row with a price.
  assert.deepEqual(await said({ ...trial, priceCents: 900n, status: "expired", currentPeriodEnd: PAST }), ["plan_ended", false]);
  // The trial ended, and the buyer agreed to pay per use: they go on, nothing ended for them.
  const agreed = { acceptedPricingModel: "per_request", acceptedPricePerRequestCents: 500n };
  assert.deepEqual(await said({ ...trial, status: "expired", currentPeriodEnd: PAST }, agreed), ["listing_pricing", false]);
  // A buyer who pays per use, with no subscription at all.
  assert.deepEqual(await said(null, agreed), ["listing_pricing", false]);
  // A month with no count that ran out.
  assert.equal((await rowOf({ status: "expired", currentPeriodEnd: PAST })).trialEnded, false);
  // A copy, even beside an ended trial row.
  const copy = await rowOf({ ...trial, status: "expired", currentPeriodEnd: PAST }, { kind: "copy", clonedAgentId: "agent_copy" });
  assert.equal(copy.kind, "copy");
  assert.equal(copy.trialEnded, false);

  // The word stands beside the access, and nothing else of the row moved.
  const keys = Object.keys(await rowOf(trial));
  assert.equal(keys[keys.indexOf("access") + 1], "trialEnded");
  assert.equal(keys.length, 14);
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
    trial: false,
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

// ============================================
// The featured row and a publisher's listings
// ============================================

test("the featured row says the smallest plan price of each listing, as the search does, in one query for the row", async () => {
  const world = makeWorld({ listings: LISTINGS, plans: PLANS });
  const featured = await withWorld(world, ({ getFeaturedListings }) => getFeaturedListings());
  const { listings: searched } = await withWorld(world, ({ searchListings }) => searchListings({}));
  assert.deepEqual(
    featured.map((l: Row) => [l.slug, l.plansFromCents]),
    [
      ["alpha", 900],
      ["beta", 700],
      // Sold by the month: it offers no plan, whatever rows it has left.
      ["gamma", null],
    ],
  );
  // The same listing reads the same in both.
  assert.deepEqual(
    featured.map((l: Row) => l.plansFromCents),
    searched.map((l: Row) => l.plansFromCents),
  );
  // One read each: the featured row, then the search.
  assert.equal(world.planReads.length, 2);
  assert.deepEqual(world.planReads[0]!.where, { listingId: { in: ["alpha", "beta"] }, status: "active", kind: "paid" });
  // A card carries the price and not the plans.
  assert.equal("plans" in featured[0]!, false);
});

test("a featured row with no plan on offer says null for each, and reads no plan when no listing offers any", async () => {
  const none = makeWorld({
    listings: [listingRow("alpha"), listingRow("beta")],
    plans: [planRow("gone", "beta", 1, 900n, { status: "retired" })],
  });
  const featured = await withWorld(none, ({ getFeaturedListings }) => getFeaturedListings());
  assert.deepEqual(featured.map((l: Row) => l.plansFromCents), [null, null]);

  const notOffering = makeWorld({
    listings: [listingRow("copies", { sells: "copies" }), LISTINGS[2]!],
    plans: [planRow("x", "copies", 1, 900n)],
  });
  const rows = await withWorld(notOffering, ({ getFeaturedListings }) => getFeaturedListings());
  assert.deepEqual(rows.map((l: Row) => l.plansFromCents), [null, null]);
  assert.equal(notOffering.planReads.length, 0);
});

test("a publisher's listings carry the smallest plan price too, in one query for all of them", async () => {
  const world = makeWorld({ listings: LISTINGS, plans: PLANS });
  const profile = await withWorld(world, ({ getPublisherProfile }) => getPublisherProfile("pub"));
  assert.deepEqual(
    profile!.listings.map((l: Row) => [l.slug, l.plansFromCents]),
    [
      ["alpha", 900],
      ["beta", 700],
      ["gamma", null],
    ],
  );
  assert.equal(world.planReads.length, 1);
  assert.equal("plans" in profile!.listings[0]!, false);
  // Never how many people are on a plan, or a plan that was ended.
  const text = JSON.stringify(profile, (_key, value) => (typeof value === "bigint" ? Number(value) : value));
  assert.equal(text.includes("retiredAt"), false);
  assert.equal(text.includes('"old"'), false);
});

// ============================================
// Whether the caller may start, move up or resume
// ============================================

const ROLES = { u_owner: "owner", u_admin: "admin", u_member: "member" };
const session = (userId: string | null): Row => ({ userId, orgId: BUYER, type: "jwt", role: "owner" });
const apiKey = (scopes: string[]): Row => ({ userId: null, orgId: BUYER, type: "api_key", scopes });

/** GET /my-installs over the world, as `principal`. */
async function myInstalls(world: World, principal: Row) {
  return withWorld(world, async () => {
    const Fastify = (await import("fastify")).default;
    const { marketplaceRoutes } = await import("../routes/marketplace.js");
    const app = Fastify();
    app.decorateRequest("auth", null);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { auth: unknown }).auth = principal;
    });
    await app.register(marketplaceRoutes);
    try {
      const res = await app.inject({ method: "GET", url: "/my-installs" });
      return { status: res.statusCode, body: res.json() as Row };
    } finally {
      await app.close();
    }
  });
}

test("my installs say whether the caller may start, move up or resume: an owner and an admin may, a plain member may not", async () => {
  const world = makeWorld({ listings: LISTINGS, plans: PLANS, installs: [installRow("alpha")], roles: ROLES });
  for (const [userId, expected] of [
    ["u_owner", true],
    ["u_admin", true],
    ["u_member", false],
    // No longer a member, whatever the token still claims.
    ["u_gone", false],
  ] as const) {
    const { status, body } = await myInstalls(world, session(userId));
    assert.equal(status, 200, userId);
    assert.equal(body.canSpend, expected, userId);
    // Beside the installs, which are what they were.
    assert.deepEqual(Object.keys(body), ["installs", "canSpend"]);
    assert.equal(body.installs.length, 1);
    assert.equal(body.installs[0].listingId, "alpha");
  }
  // The role is the membership's as it is now, read for this organization.
  assert.deepEqual(world.roleReads[0], { orgId: BUYER, userId: "u_owner" });
  // A session with nobody behind it.
  assert.equal((await myInstalls(world, session(null))).body.canSpend, false);
});

test("my installs for a key: it may only with the scope by name, never with * alone", async () => {
  const world = makeWorld({ listings: LISTINGS, plans: PLANS, installs: [installRow("alpha")], roles: ROLES });
  assert.equal((await myInstalls(world, apiKey(["marketplace:install"]))).body.canSpend, true);
  assert.equal((await myInstalls(world, apiKey(["*", "marketplace:install"]))).body.canSpend, true);
  assert.equal((await myInstalls(world, apiKey(["*"]))).body.canSpend, false);
  assert.equal((await myInstalls(world, apiKey([]))).body.canSpend, false);
  assert.equal((await myInstalls(world, apiKey(["agents:use", "jobs:hire"]))).body.canSpend, false);
  // A key has no member behind it: no role is read for one.
  assert.equal(world.roleReads.length, 0);
});

test("a role that cannot be read answers no, and the installs still come", async () => {
  const world = makeWorld({ listings: LISTINGS, plans: PLANS, installs: [installRow("alpha")], roles: "throws" });
  const { status, body } = await myInstalls(world, session("u_owner"));
  assert.equal(status, 200);
  assert.equal(body.canSpend, false);
  assert.equal(body.installs.length, 1);
});

test("canSpend is the guard's own answer: it says yes exactly when the guard lets the request through", async () => {
  const { createCanSpend, createRequireSpend } = await import("../middleware/auth.js");
  const deps = { getMemberRole: async (_orgId: string, userId: string) => (ROLES as Row)[userId] ?? null };
  const canSpend = createCanSpend(deps);
  const guard = createRequireSpend(deps)("marketplace:install");
  const callers = [
    session("u_owner"),
    session("u_admin"),
    session("u_member"),
    session("u_gone"),
    session(null),
    apiKey(["marketplace:install"]),
    apiKey(["*"]),
    apiKey([]),
  ];
  for (const caller of callers) {
    let refused = false;
    const reply: Row = { status: () => ((refused = true), reply), send: () => ((refused = true), reply) };
    await guard({ auth: { ...caller } } as never, reply as never);
    assert.equal(await canSpend(caller as never, "marketplace:install"), !refused, JSON.stringify(caller));
    // Asking changes nothing of the caller.
    assert.equal(caller.role, caller.type === "jwt" ? "owner" : undefined);
  }
  assert.equal(await canSpend(null, "marketplace:install"), false);
  assert.equal(await canSpend(undefined, "marketplace:install"), false);
  // Another spend scope does not stand in for this one.
  assert.equal(await canSpend(apiKey(["agents:use"]) as never, "marketplace:install"), false);
});

// ============================================
// The free trial on the page of one listing
// ============================================

test("the read of one listing carries its free trial beside the plans, and null when it has none, it was ended, or the listing offers no plans", async () => {
  const trial = (listingId: string, over: Row = {}) =>
    planRow(`trial_${listingId}`, listingId, 0, 0n, { kind: "trial", name: "Free trial", includedUses: 20, ...over });
  const world = makeWorld({
    listings: LISTINGS,
    plans: [...PLANS, trial("alpha"), trial("beta", { status: "retired" }), trial("gamma")],
  });
  await withWorld(world, async ({ getListingBySlug, searchListings }) => {
    const alpha = (await getListingBySlug("alpha"))!;
    // `freeTrial`: on a listing, `trial` is already "Try it".
    assert.deepEqual(alpha.freeTrial, { id: "trial_alpha", includedUses: 20, days: 7 });
    assert.deepEqual(alpha.trial, { enabled: true });
    // The paid plans are exactly what they were, and the trial is not among them.
    assert.deepEqual(alpha.plans, ALPHA_OFFERS);
    assert.doesNotMatch(JSON.stringify(alpha.plans), /trial/i);

    // Ended by its creator.
    assert.equal((await getListingBySlug("beta"))!.freeTrial, null);
    // Sold by the month: not asked about, and none.
    const reads = world.planReads.length;
    assert.equal((await getListingBySlug("gamma"))!.freeTrial, null);
    assert.equal(world.planReads.length, reads);

    // A card does not say: only the page of one listing looked.
    const { listings } = await searchListings({});
    assert.equal(listings.some((l: Row) => "freeTrial" in l), false);
    // And a trial is never the smallest plan price of a card.
    assert.ok(listings.every((l: Row) => l.plansFromCents === null || l.plansFromCents > 0));
  });
});
