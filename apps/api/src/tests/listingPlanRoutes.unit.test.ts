import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

import { PLAN_MESSAGES } from "../services/listingPlans.js";
import { PLAN_STORE_MESSAGES } from "../services/listingPlanStore.js";

// A creator's plans on a listing: PUT /api/marketplace/listings/:id/plans and
// what GET /api/marketplace/my-listings shows of them, through the routes and
// the real services over an in-memory database. What these pin: the set
// replaces what the listing has (a plan sent with its id keeps it, one left
// out is retired and never deleted, a new one takes a free place), nothing
// is written unless the whole set passes, two saves at once give one 409 and
// never a 500, and no subscription row is ever touched.

const LISTING_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_LISTING_ID = "22222222-2222-4222-8222-222222222222";
const ORG = "org_creator";
const OTHER_ORG = "org_other";
const NOW_ISH = () => new Date();

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === "object" && "in" in cond) return cond.in.includes(v);
    return v === cond;
  });
}

function makeWorld(opts: { listing?: Row; agent?: Row; plans?: Row[]; subs?: Row[] } = {}) {
  const state = {
    listings: [
      {
        id: LISTING_ID,
        agentId: "agent_1",
        publisherId: ORG,
        title: "Research Analyst",
        slug: "research-analyst",
        status: "published",
        sells: "use",
        useAllowedTools: [],
        pricingModel: "per_request",
        pricePerRequestCents: 5n,
        monthlyPriceCents: null,
        pausedSince: null,
        ...opts.listing,
      },
      // Another organization's listing, sold the same way.
      {
        id: OTHER_LISTING_ID,
        agentId: "agent_2",
        publisherId: OTHER_ORG,
        title: "Somebody else's",
        slug: "somebody-elses",
        status: "published",
        sells: "use",
        useAllowedTools: [],
        pricingModel: "per_request",
        pricePerRequestCents: 5n,
        monthlyPriceCents: null,
        pausedSince: null,
      },
    ] as Row[],
    agent: {
      id: "agent_1",
      orgId: ORG,
      framework: "custom",
      agentKind: "conversation",
      tags: [],
      publicHandle: "analyst",
      modelConfig: null,
      ...opts.agent,
    } as Row,
    plans: (opts.plans ?? []).map((plan) => ({ ...plan })) as Row[],
    /** Subscriptions: read to be counted, and never written. */
    subs: (opts.subs ?? []).map((sub) => ({ ...sub })) as Row[],
    planWrites: 0,
  };
  let seq = 0;
  const withAgent = (listing: Row) => ({ ...listing, agent: { ...state.agent } });

  const models: Row = {
    agentListing: {
      findFirst: async ({ where }: Row) => {
        const row = state.listings.find((l) => matches(l, where));
        return row ? withAgent(row) : null;
      },
      findMany: async ({ where }: Row) => state.listings.filter((l) => matches(l, where)).map(withAgent),
    },
    listingPlan: {
      findMany: async ({ where, orderBy }: Row) => {
        const rows = state.plans.filter((p) => matches(p, where)).map((p) => ({ ...p }));
        return orderBy?.position ? rows.sort((a, b) => a.position - b.position) : rows;
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = state.plans.filter((p) => matches(p, where));
        for (const p of hit) Object.assign(p, data);
        state.planWrites += hit.length;
        return { count: hit.length };
      },
      create: async ({ data }: Row) => {
        // The partial unique index: one active plan per place on a listing.
        const taken = state.plans.some(
          (p) => p.status === "active" && p.listingId === data.listingId && p.position === data.position,
        );
        if (taken) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`listing_id`,`position`)"), {
            code: "P2002",
            clientVersion: "5",
          });
        }
        const row = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, retiredAt: null, ...data };
        state.plans.push(row);
        state.planWrites += 1;
        return { ...row };
      },
    },
    agentSubscription: {
      // No write exists here on purpose: a save that touched a subscription would throw.
      groupBy: async ({ where }: Row) => {
        const counts = new Map<string, number>();
        for (const sub of state.subs.filter((s) => matches(s, where))) {
          counts.set(sub.planId, (counts.get(sub.planId) ?? 0) + 1);
        }
        return [...counts].map(([planId, n]) => ({ planId, _count: { _all: n } }));
      },
      findMany: async ({ where }: Row) => state.subs.filter((s) => matches(s, where)).map((s) => ({ ...s })),
    },
    agentInstall: { findMany: async () => [] },
  };
  // Not one at a time: two saves that overlap both read before either
  // writes, as two transactions do, and the index decides between them.
  models.$transaction = (fn: (tx: Row) => Promise<unknown>) => fn(models);
  return { state, models };
}

type World = ReturnType<typeof makeWorld>;

const OWNER = { userId: "user_owner", orgId: ORG, type: "jwt" };
const ADMIN = { userId: "user_admin", orgId: ORG, type: "jwt" };
const MEMBER = { userId: "user_member", orgId: ORG, type: "jwt" };
const STRANGER = { userId: "user_owner_2", orgId: OTHER_ORG, type: "jwt" };
const ROLES: Record<string, string> = {
  user_owner: "owner",
  user_admin: "admin",
  user_member: "member",
  user_owner_2: "owner",
};

/** The routes over the world, with the production role guard on a fixed membership table. */
async function withApp<T>(world: World, body: (call: Call) => Promise<T>): Promise<T> {
  const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Row };
  const Fastify = (await import("fastify")).default;
  const sensible = await import("@fastify/sensible");
  const { createRequireRole } = await import("../middleware/auth.js");
  const { createListingPlanRoutes } = await import("../routes/listingPlans.js");
  const { marketplaceRoutes } = await import("../routes/marketplace.js");

  const originals: Row = {};
  for (const [name, fake] of Object.entries(world.models)) {
    originals[name] = prisma[name];
    prisma[name] = fake;
  }
  const app = Fastify();
  await app.register(sensible.default);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    const header = request.headers["x-test-auth"];
    if (typeof header === "string") (request as unknown as { auth: unknown }).auth = JSON.parse(header);
  });
  await app.register(
    createListingPlanRoutes({
      guards: {
        auth: async (request, reply) => {
          if (!request.auth) return reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
        },
        ownerOrAdmin: createRequireRole({ getMemberRole: async (_orgId, userId) => ROLES[userId] ?? null })(
          "owner",
          "admin",
        ),
      },
    }),
  );
  await app.register(marketplaceRoutes);

  const call: Call = async (method, url, payload, as = OWNER) => {
    const res = await app.inject({
      method,
      url,
      ...(as && { headers: { "x-test-auth": JSON.stringify(as) } }),
      ...(payload !== undefined && { payload: payload as never }),
    });
    return { status: res.statusCode, body: res.json() as Row };
  };
  try {
    return await body(call);
  } finally {
    await app.close();
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

type Call = (
  method: "PUT" | "GET",
  url: string,
  payload?: unknown,
  as?: Row | null,
) => Promise<{ status: number; body: Row }>;

const PLANS_URL = `/listings/${LISTING_ID}/plans`;
const starter = (over: Row = {}) => ({
  kind: "paid",
  name: "Starter",
  priceCents: 900,
  includedUses: 500,
  extraUsePriceCents: 5,
  ...over,
});
const pro = (over: Row = {}) => ({
  kind: "paid",
  name: "Pro",
  priceCents: 2900,
  includedUses: 2000,
  extraUsePriceCents: null,
  ...over,
});
/** One field wrong: its status, and the sentence under its field. */
const fieldOf = (res: { status: number; body: Row }, field: string) => [
  res.status,
  res.body.error,
  res.body.fields?.[field],
];

// ============================================
// Setting the plans
// ============================================

test("a creator sets two plans: each is stored in whole cents at its place, and answered as my-listings shows it", async () => {
  const world = makeWorld();
  await withApp(world, async (call) => {
    // An admin may, as an owner may.
    const res = await call("PUT", PLANS_URL, { plans: [starter({ name: "  Starter  " }), pro()] }, ADMIN);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ["plans"]);
    assert.deepEqual(
      res.body.plans.map((plan: Row) => ({ ...plan, id: typeof plan.id })),
      [
        {
          id: "string",
          kind: "paid",
          name: "Starter",
          priceCents: 900,
          includedUses: 500,
          extraUsePriceCents: 5,
          status: "active",
          subscribers: 0,
        },
        {
          id: "string",
          kind: "paid",
          name: "Pro",
          priceCents: 2900,
          includedUses: 2000,
          extraUsePriceCents: null,
          status: "active",
          subscribers: 0,
        },
      ],
    );
  });
  assert.deepEqual(
    world.state.plans.map((p) => [p.listingId, p.kind, p.name, p.priceCents, p.includedUses, p.extraUsePriceCents, p.position, p.status]),
    [
      [LISTING_ID, "paid", "Starter", 900n, 500, 5n, 1, "active"],
      [LISTING_ID, "paid", "Pro", 2900n, 2000, null, 2, "active"],
    ],
  );
});

test("changing a plan keeps its id and its place, and the people on it are not touched", async () => {
  const held = {
    id: "sub_1",
    listingId: LISTING_ID,
    status: "active",
    priceCents: 900n,
    includedUses: 500,
    usedInPeriod: 12,
    extraUsePriceCents: 5n,
  };
  const world = makeWorld();
  await withApp(world, async (call) => {
    const first = await call("PUT", PLANS_URL, { plans: [starter(), pro()] });
    const [starterId, proId] = first.body.plans.map((plan: Row) => plan.id);
    world.state.subs.push({ ...held, planId: starterId });

    // The second plan sent first, and the first with a new price, count and ending.
    const res = await call("PUT", PLANS_URL, {
      plans: [
        pro({ id: proId }),
        starter({ id: starterId, name: "Starter plus", priceCents: 1200, includedUses: 800, extraUsePriceCents: null }),
      ],
    });
    assert.equal(res.status, 200);
    // In the order of their places: a plan changed in place stays where it was.
    assert.deepEqual(
      res.body.plans.map((plan: Row) => [plan.id, plan.name, plan.priceCents, plan.includedUses, plan.extraUsePriceCents, plan.subscribers]),
      [
        [starterId, "Starter plus", 1200, 800, null, 1],
        [proId, "Pro", 2900, 2000, null, 0],
      ],
    );
    assert.equal(world.state.plans.length, 2, "no row was added");
    assert.deepEqual(world.state.plans.map((p) => [p.id, p.position, p.status]), [
      [starterId, 1, "active"],
      [proId, 2, "active"],
    ]);
    // The buyer's own copy of the terms is what they agreed to.
    assert.deepEqual(world.state.subs, [{ ...held, planId: starterId }]);
  });
});

test("a plan left out is retired and never deleted, and a new plan takes its place", async () => {
  const world = makeWorld();
  await withApp(world, async (call) => {
    const first = await call("PUT", PLANS_URL, { plans: [starter(), pro()] });
    const [starterId, proId] = first.body.plans.map((plan: Row) => plan.id);
    world.state.subs.push({ id: "sub_1", planId: starterId, status: "active" });
    const before = Date.now();

    const res = await call("PUT", PLANS_URL, { plans: [pro({ id: proId }), starter({ name: "Team", priceCents: 4900 })] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.plans.map((plan: Row) => [plan.name, plan.status]), [
      ["Team", "active"],
      ["Pro", "active"],
    ]);
    const retired = world.state.plans.find((p) => p.id === starterId)!;
    assert.equal(retired.status, "retired");
    assert.ok(retired.retiredAt instanceof Date && retired.retiredAt.getTime() >= before);
    // Its terms stay as they were: the people on it still hold its id.
    assert.deepEqual([retired.name, retired.priceCents, retired.position], ["Starter", 900n, 1]);
    assert.deepEqual(world.state.subs, [{ id: "sub_1", planId: starterId, status: "active" }]);
    const team = world.state.plans.find((p) => p.name === "Team")!;
    assert.deepEqual([team.position, team.status], [1, "active"]);

    // A retired plan cannot be brought back by its id: it is no longer on the listing.
    const back = await call("PUT", PLANS_URL, { plans: [starter({ id: starterId })] });
    assert.deepEqual(fieldOf(back, "plans[0].id"), [400, "validation_failed", PLAN_MESSAGES.gone]);

    // An empty set ends them all.
    const none = await call("PUT", PLANS_URL, { plans: [] });
    assert.deepEqual([none.status, none.body.plans], [200, []]);
    assert.equal(world.state.plans.length, 3);
    assert.ok(world.state.plans.every((p) => p.status === "retired"));
  });
});

// ============================================
// Refused, with nothing written
// ============================================

test("a set that breaks a rule is refused with a sentence under its field, and nothing is written", async () => {
  const world = makeWorld();
  await withApp(world, async (call) => {
    const put = (plans: unknown) => call("PUT", PLANS_URL, { plans });

    const five = await put([1, 2, 3, 4, 5].map((n) => starter({ name: `Plan ${n}` })));
    assert.deepEqual(fieldOf(five, "plans"), [400, "validation_failed", "A listing can have at most 4 plans."]);
    assert.equal(five.body.message, "A listing can have at most 4 plans.");

    assert.deepEqual(fieldOf(await put([starter({ priceCents: 99, includedUses: 50 })]), "plans[0].priceCents"), [
      400,
      "validation_failed",
      "The price for 30 days must be at least $1.00.",
    ]);
    // A cent for each included use: $9.00 holds 900 of them.
    assert.deepEqual(fieldOf(await put([starter({ includedUses: 901 })]), "plans[0].includedUses"), [
      400,
      "validation_failed",
      "At $9.00 a plan can include at most 900 uses.",
    ]);
    assert.deepEqual(fieldOf(await put([starter(), pro({ extraUsePriceCents: 4 })]), "plans[1].extraUsePriceCents"), [
      400,
      "validation_failed",
      "The price for each extra use must be at least $0.05.",
    ]);
    assert.deepEqual(
      fieldOf(await put([{ kind: "trial", name: "Try it", priceCents: 0, includedUses: 20, extraUsePriceCents: null }]), "plans[0].kind"),
      [400, "validation_failed", "Free trials are not available yet."],
    );

    // Cents and uses are whole numbers in JSON: anything else stops at the door.
    for (const wrong of [
      starter({ priceCents: 9.5 }),
      starter({ priceCents: "900" }),
      starter({ includedUses: 10.5 }),
      starter({ extraUsePriceCents: 4.5 }),
      starter({ id: "not-an-id" }),
      // The price for an extra use is said, as a price or as null: left out,
      // a plan changed in place would lose it unasked.
      starter({ extraUsePriceCents: undefined }),
    ]) {
      const res = await put([wrong]);
      assert.deepEqual([res.status, res.body.error], [400, "validation_failed"], JSON.stringify(wrong));
      assert.equal(typeof res.body.message, "string");
    }
    assert.equal((await call("PUT", PLANS_URL, {})).status, 400);
  });
  assert.equal(world.state.plans.length, 0);
  assert.equal(world.state.planWrites, 0);
});

test("a listing that cannot have plans is refused 409 with the reason, whatever is sent", async () => {
  const refusal = async (opts: Parameters<typeof makeWorld>[0]) => {
    const world = makeWorld(opts);
    const res = await withApp(world, (call) => call("PUT", PLANS_URL, { plans: [starter()] }));
    assert.equal(world.state.planWrites, 0);
    return [res.status, res.body.error, res.body.message];
  };
  assert.deepEqual(await refusal({ listing: { sells: "copies" } }), [
    409,
    "plans_not_available",
    "Plans are for a listing that sells use of the agent. This listing sells copies.",
  ]);
  assert.deepEqual(await refusal({ listing: { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900n } }), [
    409,
    "plans_not_available",
    "Plans are added to a listing that is sold per use. Change this listing to Pay per use first.",
  ]);
  assert.deepEqual(
    await refusal({
      agent: { agentKind: "scheduled" },
      listing: { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900n },
    }),
    [409, "plans_not_available", "An agent that runs on its own is sold by the month, so it cannot have plans."],
  );
});

test("an empty set ends the plans of a listing that left pay per use: retired, never deleted, and nobody on them is touched", async () => {
  const PLAN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PLAN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const world = makeWorld({
    listing: { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900n },
    plans: [
      { id: PLAN_A, listingId: LISTING_ID, kind: "paid", name: "Starter", priceCents: 900n, includedUses: 500, extraUsePriceCents: 5n, position: 1, status: "active", retiredAt: null },
      { id: PLAN_B, listingId: LISTING_ID, kind: "paid", name: "Pro", priceCents: 2900n, includedUses: 2000, extraUsePriceCents: null, position: 2, status: "active", retiredAt: null },
    ],
    subs: [{ id: "sub_1", listingId: LISTING_ID, subscriberId: "org_buyer", planId: PLAN_A, status: "active", includedUses: 500 }],
  });
  const before = structuredClone(world.state.subs);
  await withApp(world, async (call) => {
    // A plan is still not added, or kept, on such a listing.
    const kept = await call("PUT", PLANS_URL, { plans: [{ id: PLAN_A, ...starter() }] });
    assert.deepEqual([kept.status, kept.body.error], [409, "plans_not_available"]);
    assert.equal(world.state.planWrites, 0);

    const res = await call("PUT", PLANS_URL, { plans: [] });
    assert.deepEqual([res.status, res.body], [200, { plans: [] }]);
  });
  assert.equal(world.state.plans.length, 2);
  for (const plan of world.state.plans) {
    assert.equal(plan.status, "retired");
    assert.ok(plan.retiredAt instanceof Date);
  }
  assert.deepEqual(world.state.subs, before);
});

test("another organization's listing is not found, and a member who is not an owner or admin is refused", async () => {
  const world = makeWorld();
  await withApp(world, async (call) => {
    // Its own owner, asking for somebody else's listing: the same answer as for none.
    const theirs = await call("PUT", `/listings/${OTHER_LISTING_ID}/plans`, { plans: [starter()] });
    assert.deepEqual([theirs.status, theirs.body], [404, { error: "listing_not_found", message: PLAN_STORE_MESSAGES.listingNotFound }]);
    const stranger = await call("PUT", PLANS_URL, { plans: [starter()] }, STRANGER);
    assert.deepEqual([stranger.status, stranger.body.error, stranger.body.message], [404, "listing_not_found", "This listing was not found."]);
    const none = await call("PUT", "/listings/33333333-3333-4333-8333-333333333333/plans", { plans: [] });
    assert.equal(none.status, 404);

    const member = await call("PUT", PLANS_URL, { plans: [starter()] }, MEMBER);
    assert.deepEqual([member.status, member.body], [403, { error: "insufficient_role", message: "Requires role: owner or admin" }]);
    // Removed from the organization since the session began.
    const removed = await call("PUT", PLANS_URL, { plans: [starter()] }, { userId: "user_gone", orgId: ORG, type: "jwt" });
    assert.deepEqual([removed.status, removed.body.error], [403, "not_a_member"]);
    const signedOut = await call("PUT", PLANS_URL, { plans: [starter()] }, null);
    assert.equal(signedOut.status, 401);
  });
  assert.equal(world.state.planWrites, 0);
});

// ============================================
// Two saves at once
// ============================================

test("two saves at once: one is saved, the other is 409 with a sentence asking to reload, and one set is left", async () => {
  const world = makeWorld();
  // Both saves read the plans on offer before either writes, as two
  // transactions that overlap do.
  const readPlans = world.models.listingPlan.findMany;
  let readers = 0;
  let bothRead!: () => void;
  const bothHaveRead = new Promise<void>((resolve) => (bothRead = resolve));
  world.models.listingPlan.findMany = async (args: Row) => {
    const rows = await readPlans(args);
    if (args.where.kind === "paid") {
      if (++readers === 2) bothRead();
      await bothHaveRead;
    }
    return rows;
  };
  await withApp(world, async (call) => {
    const results = await Promise.all([
      call("PUT", PLANS_URL, { plans: [starter()] }),
      call("PUT", PLANS_URL, { plans: [pro()] }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const lost = results.find((r) => r.status === 409)!;
    assert.deepEqual(lost.body, {
      error: "plans_changed",
      message: "These plans were changed by another save at the same moment. Reload the page and try again.",
    });
    // Nothing of the database's own words reaches the creator.
    assert.doesNotMatch(JSON.stringify(lost.body), /constraint|P2002|position/i);
  });
  assert.deepEqual(world.state.plans.map((p) => [p.position, p.status]), [[1, "active"]]);
});

test("a plan another save retired in between is not changed: 409, never a 500", async () => {
  const world = makeWorld({
    plans: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        listingId: LISTING_ID,
        kind: "paid",
        name: "Starter",
        priceCents: 900n,
        includedUses: 500,
        extraUsePriceCents: 4n,
        position: 1,
        status: "active",
        retiredAt: null,
      },
    ],
  });
  // The other save lands after this one read the plans and before it writes.
  const realUpdate = world.models.listingPlan.updateMany;
  world.models.listingPlan.updateMany = async (args: Row) => {
    world.state.plans[0]!.status = "retired";
    world.state.plans[0]!.retiredAt = NOW_ISH();
    return realUpdate(args);
  };
  const res = await withApp(world, (call) =>
    call("PUT", PLANS_URL, { plans: [starter({ id: "44444444-4444-4444-8444-444444444444", priceCents: 1200 })] }),
  );
  assert.deepEqual([res.status, res.body.error], [409, "plans_changed"]);
  assert.equal(world.state.plans[0]!.priceCents, 900n);
});

// ============================================
// What the creator's list shows
// ============================================

test("my-listings shows each listing's plans on offer in order, with how many people are on each and none of them named", async () => {
  const plan = (over: Row) => ({
    listingId: LISTING_ID,
    kind: "paid",
    priceCents: 900n,
    includedUses: 500,
    extraUsePriceCents: null,
    status: "active",
    retiredAt: null,
    ...over,
  });
  const sub = (over: Row) => ({
    listingId: LISTING_ID,
    subscriberId: "org_buyer_secret",
    currentPeriodEnd: new Date(Date.now() + 86_400_000),
    cancelAtPeriodEnd: false,
    ...over,
  });
  const world = makeWorld({
    plans: [
      plan({ id: "plan_pro", name: "Pro", priceCents: 2900n, includedUses: 2000, extraUsePriceCents: 4n, position: 2 }),
      plan({ id: "plan_starter", name: "Starter", position: 1 }),
      plan({ id: "plan_old", name: "Old", position: 1, status: "retired", retiredAt: new Date(0) }),
      plan({ id: "plan_theirs", listingId: OTHER_LISTING_ID, name: "Theirs", position: 1 }),
    ],
    subs: [
      sub({ id: "s1", planId: "plan_starter", status: "active" }),
      // Being retried: still open.
      sub({ id: "s2", planId: "plan_starter", status: "past_due" }),
      // Over: not counted.
      sub({ id: "s3", planId: "plan_starter", status: "cancelled" }),
      sub({ id: "s4", planId: "plan_starter", status: "expired" }),
      sub({ id: "s5", planId: "plan_old", status: "active" }),
      sub({ id: "s6", planId: "plan_theirs", status: "active", listingId: OTHER_LISTING_ID }),
    ],
  });
  await withApp(world, async (call) => {
    const res = await call("GET", "/my-listings");
    assert.equal(res.status, 200);
    assert.equal(res.body.listings.length, 1);
    assert.deepEqual(res.body.listings[0].plans, [
      {
        id: "plan_starter",
        kind: "paid",
        name: "Starter",
        priceCents: 900,
        includedUses: 500,
        extraUsePriceCents: null,
        status: "active",
        subscribers: 2,
      },
      {
        id: "plan_pro",
        kind: "paid",
        name: "Pro",
        priceCents: 2900,
        includedUses: 2000,
        extraUsePriceCents: 4,
        status: "active",
        subscribers: 0,
      },
    ]);
    assert.doesNotMatch(JSON.stringify(res.body), /org_buyer_secret/);

    // A listing with no plan says so with an empty list.
    world.state.plans.length = 0;
    assert.deepEqual((await call("GET", "/my-listings")).body.listings[0].plans, []);
  });
});
