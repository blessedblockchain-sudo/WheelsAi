import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

import { checkPlanSet, PLAN_MESSAGES } from "../services/listingPlans.js";
import { PLAN_STORE_MESSAGES } from "../services/listingPlanStore.js";

// A creator's plans on a listing: PUT /api/marketplace/listings/:id/plans and
// what GET /api/marketplace/my-listings shows of them, through the routes and
// the real services over an in-memory database. What these pin: the set
// replaces what the listing has (a plan sent with its id keeps it, one named
// as ended is retired and never deleted, a new one takes a free place), a
// plan is ended only when its creator says so (one that is neither sent nor
// named refuses the whole save), nothing is written unless the whole set
// passes, two saves at once give one 409 and never a 500, and no
// subscription row is ever touched. And the listing's one free trial: saved
// at its own place beside the four paid plans, changed in place and ended by
// its id, with no name but "Free trial".

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
  // A listing that sells a workflow has no agent.
  const withAgent = (listing: Row) => ({ ...listing, agent: listing.agentId === null ? null : { ...state.agent } });

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

test("a plan named as ended is retired and never deleted, and a new plan takes its place", async () => {
  const world = makeWorld();
  await withApp(world, async (call) => {
    const first = await call("PUT", PLANS_URL, { plans: [starter(), pro()] });
    const [starterId, proId] = first.body.plans.map((plan: Row) => plan.id);
    world.state.subs.push({ id: "sub_1", planId: starterId, status: "active" });
    const before = Date.now();

    const res = await call("PUT", PLANS_URL, {
      plans: [pro({ id: proId }), starter({ name: "Team", priceCents: 4900 })],
      ended: [starterId],
    });
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
    const teamId = res.body.plans[0].id;
    const back = await call("PUT", PLANS_URL, {
      plans: [starter({ id: starterId }), starter({ id: teamId, name: "Team", priceCents: 4900 }), pro({ id: proId })],
    });
    assert.deepEqual(fieldOf(back, "plans[0].id"), [400, "validation_failed", PLAN_MESSAGES.gone]);

    // An empty set with every plan on offer named ends them all.
    const none = await call("PUT", PLANS_URL, { plans: [], ended: [teamId, proId] });
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
    // A free trial is allowed; one with more than 50 uses is not.
    assert.deepEqual(
      fieldOf(await put([{ kind: "trial", name: "Try it", priceCents: 0, includedUses: 51, extraUsePriceCents: null }]), "plans[0].includedUses"),
      [400, "validation_failed", "A free trial includes between 1 and 50 uses."],
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

test("an empty set that names every plan ends the plans of a listing that left pay per use: retired, never deleted, and nobody on them is touched", async () => {
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
    const kept = await call("PUT", PLANS_URL, { plans: [{ id: PLAN_A, ...starter() }], ended: [PLAN_B] });
    assert.deepEqual([kept.status, kept.body.error], [409, "plans_not_available"]);
    const both = await call("PUT", PLANS_URL, { plans: [{ id: PLAN_A, ...starter() }, { id: PLAN_B, ...pro() }] });
    assert.deepEqual([both.status, both.body.error], [409, "plans_not_available"]);
    assert.equal(world.state.planWrites, 0);

    // An empty set alone ends nothing: the plans it does not name are still there.
    const alone = await call("PUT", PLANS_URL, { plans: [] });
    assert.deepEqual([alone.status, alone.body], [409, { error: "plans_changed", message: PLAN_STORE_MESSAGES.changedSincePageLoaded }]);
    const one = await call("PUT", PLANS_URL, { plans: [], ended: [PLAN_A] });
    assert.deepEqual([one.status, one.body.error], [409, "plans_changed"]);
    assert.equal(world.state.planWrites, 0);

    const res = await call("PUT", PLANS_URL, { plans: [], ended: [PLAN_B, PLAN_A] });
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
// A plan is ended only when its creator says so
// ============================================

const PLAN_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLAN_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLAN_3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PLAN_OLD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PLAN_THEIRS = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NEVER_A_PLAN = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const stored = (over: Row) => ({
  listingId: LISTING_ID,
  kind: "paid",
  name: "Starter",
  priceCents: 900n,
  includedUses: 500,
  extraUsePriceCents: 5n,
  status: "active",
  retiredAt: null,
  ...over,
});

/** Three plans on offer, one ended long ago, and one of another listing. */
const threePlans = () =>
  makeWorld({
    plans: [
      stored({ id: PLAN_1, position: 1 }),
      stored({ id: PLAN_2, name: "Pro", priceCents: 2900n, includedUses: 2000, extraUsePriceCents: null, position: 2 }),
      stored({ id: PLAN_3, name: "Team", priceCents: 9900n, includedUses: 5000, position: 3 }),
      stored({ id: PLAN_OLD, name: "Old", position: 4, status: "retired", retiredAt: new Date(0) }),
      stored({ id: PLAN_THEIRS, listingId: OTHER_LISTING_ID, name: "Theirs", position: 1 }),
    ],
    subs: [
      { id: "sub_1", listingId: LISTING_ID, subscriberId: "org_buyer", planId: PLAN_3, status: "active", includedUses: 5000, usedInPeriod: 40 },
      { id: "sub_2", listingId: LISTING_ID, subscriberId: "org_buyer_2", planId: PLAN_1, status: "past_due", includedUses: 500, usedInPeriod: 500 },
    ],
  });
const SENT_1 = starter({ id: PLAN_1 });
const SENT_2 = pro({ id: PLAN_2 });
const SENT_3 = starter({ id: PLAN_3, name: "Team", priceCents: 9900, includedUses: 5000 });
const PLANS_CHANGED = {
  error: "plans_changed",
  message: "These plans were changed somewhere else since this page was loaded. Reload the page and try again.",
};

test("a plan on offer that is neither sent nor named is 409, and nothing is written: not the plans that were sent either", async () => {
  const world = threePlans();
  const before = structuredClone(world.state.plans);
  const subs = structuredClone(world.state.subs);
  await withApp(world, async (call) => {
    // A page loaded before a teammate added the third plan: it changes one, adds one and knows two.
    const stale = await call("PUT", PLANS_URL, {
      plans: [starter({ id: PLAN_1, priceCents: 1200 }), SENT_2, starter({ name: "New" })],
    });
    assert.deepEqual([stale.status, stale.body], [409, PLANS_CHANGED]);
    // The same page ending one of the plans it does know of.
    const ending = await call("PUT", PLANS_URL, { plans: [SENT_1], ended: [PLAN_2] });
    assert.deepEqual([ending.status, ending.body], [409, PLANS_CHANGED]);
    // Naming some other id does not help: the plan it did not know of (the third) is still in neither list.
    const told = await call("PUT", PLANS_URL, { plans: [SENT_1], ended: [PLAN_2, NEVER_A_PLAN] });
    assert.deepEqual([told.status, told.body], [409, PLANS_CHANGED]);
    // Said before the rules of a plan: a set made from an old page is not argued with field by field.
    const alsoWrong = await call("PUT", PLANS_URL, { plans: [starter({ id: PLAN_1, priceCents: 1 }), SENT_2] });
    assert.deepEqual([alsoWrong.status, alsoWrong.body], [409, PLANS_CHANGED]);
  });
  assert.equal(world.state.planWrites, 0);
  assert.deepEqual(world.state.plans, before);
  assert.deepEqual(world.state.subs, subs);
});

test("a named plan is ended, the others are kept, and the rows of the people on it are untouched", async () => {
  const world = threePlans();
  const subs = structuredClone(world.state.subs);
  const before = Date.now();
  await withApp(world, async (call) => {
    const res = await call("PUT", PLANS_URL, { plans: [SENT_1, SENT_2], ended: [PLAN_3] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.plans.map((plan: Row) => [plan.id, plan.status, plan.subscribers]), [
      [PLAN_1, "active", 1],
      [PLAN_2, "active", 0],
    ]);
  });
  const byId = (id: string) => world.state.plans.find((p) => p.id === id)!;
  assert.equal(byId(PLAN_3).status, "retired");
  assert.ok(byId(PLAN_3).retiredAt instanceof Date && byId(PLAN_3).retiredAt.getTime() >= before);
  // Retired, never deleted, and its terms are as they were.
  assert.deepEqual([byId(PLAN_3).name, byId(PLAN_3).priceCents, byId(PLAN_3).position], ["Team", 9900n, 3]);
  assert.equal(world.state.plans.length, 5);
  // The people on the ended plan still hold its id and their own count.
  assert.deepEqual(world.state.subs, subs);
  // Another listing's plan and the one ended long ago are as they were.
  assert.deepEqual([byId(PLAN_THEIRS).status, byId(PLAN_OLD).retiredAt.getTime()], ["active", 0]);
});

test("a named id that is already ended, or was never this listing's, is no error and changes nothing", async () => {
  const world = threePlans();
  await withApp(world, async (call) => {
    // The same ids twice, an ended one, another listing's, and one that was never a plan.
    const res = await call("PUT", PLANS_URL, {
      plans: [SENT_1, SENT_2, SENT_3],
      ended: [PLAN_OLD, PLAN_THEIRS, NEVER_A_PLAN, PLAN_OLD],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.plans.map((plan: Row) => plan.id), [PLAN_1, PLAN_2, PLAN_3]);

    // A second tab ends a plan the first tab ended a moment ago: it is ended already.
    const first = await call("PUT", PLANS_URL, { plans: [SENT_1, SENT_2], ended: [PLAN_3] });
    assert.equal(first.status, 200);
    const retiredAt = world.state.plans.find((p) => p.id === PLAN_3)!.retiredAt;
    const again = await call("PUT", PLANS_URL, { plans: [SENT_1, SENT_2], ended: [PLAN_3] });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.plans.map((plan: Row) => plan.id), [PLAN_1, PLAN_2]);
    // Not ended a second time: the day it ended is the day it ended.
    assert.equal(world.state.plans.find((p) => p.id === PLAN_3)!.retiredAt, retiredAt);
  });
  const status = (id: string) => world.state.plans.find((p) => p.id === id)!.status;
  // Another organization's plan cannot be ended by naming it.
  assert.deepEqual([status(PLAN_THEIRS), status(PLAN_OLD), status(PLAN_1), status(PLAN_2)], ["active", "retired", "active", "active"]);
  assert.equal(world.state.plans.find((p) => p.id === PLAN_OLD)!.retiredAt.getTime(), 0);
});

test("an id in both lists is refused on its field, and nothing is written", async () => {
  const world = threePlans();
  const before = structuredClone(world.state.plans);
  const sentence = "This plan is in the list of plans to keep and in the list of plans to end. Choose one.";
  await withApp(world, async (call) => {
    const res = await call("PUT", PLANS_URL, { plans: [SENT_1, SENT_2], ended: [PLAN_3, PLAN_2] });
    assert.deepEqual(fieldOf(res, "ended[1]"), [400, "validation_failed", sentence]);
    assert.equal(res.body.message, sentence);
    assert.deepEqual(Object.keys(res.body.fields), ["ended[1]"]);
    assert.equal(sentence, PLAN_STORE_MESSAGES.keptAndEnded);
  });
  assert.equal(world.state.planWrites, 0);
  assert.deepEqual(world.state.plans, before);
});

test("ended is a list of at most 20 ids: anything else is refused before the listing is read", async () => {
  const world = threePlans();
  await withApp(world, async (call) => {
    const all = [SENT_1, SENT_2, SENT_3];
    for (const ended of ["all", [7], ["not-an-id"], [null], { 0: PLAN_3 }, Array.from({ length: 21 }, () => PLAN_OLD)]) {
      const res = await call("PUT", PLANS_URL, { plans: all, ended });
      assert.deepEqual([res.status, res.body.error], [400, "validation_failed"], JSON.stringify(ended).slice(0, 40));
    }
    // Twenty is allowed, and so is an empty list.
    const twenty = await call("PUT", PLANS_URL, { plans: all, ended: Array.from({ length: 20 }, () => PLAN_OLD) });
    assert.equal(twenty.status, 200);
    assert.equal((await call("PUT", PLANS_URL, { plans: all, ended: [] })).status, 200);
  });
  assert.equal(world.state.plans.filter((p) => p.status === "active" && p.listingId === LISTING_ID).length, 3);
});

test("ended left out with every plan sent is the save it always was", async () => {
  const world = threePlans();
  await withApp(world, async (call) => {
    const res = await call("PUT", PLANS_URL, { plans: [starter({ id: PLAN_1, priceCents: 1200 }), SENT_2, SENT_3] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.plans.map((plan: Row) => [plan.id, plan.priceCents, plan.status]), [
      [PLAN_1, 1200, "active"],
      [PLAN_2, 2900, "active"],
      [PLAN_3, 9900, "active"],
    ]);
  });
  // One row changed in place, none ended, none added.
  assert.equal(world.state.plans.length, 5);
  assert.equal(world.state.plans.filter((p) => p.status === "retired").length, 1);
});

test("an empty set that names every plan ends them all, and an empty set alone ends none", async () => {
  const world = threePlans();
  const subs = structuredClone(world.state.subs);
  await withApp(world, async (call) => {
    const alone = await call("PUT", PLANS_URL, { plans: [] });
    assert.deepEqual([alone.status, alone.body], [409, PLANS_CHANGED]);
    const empty = await call("PUT", PLANS_URL, { plans: [], ended: [] });
    assert.deepEqual([empty.status, empty.body], [409, PLANS_CHANGED]);
    const two = await call("PUT", PLANS_URL, { plans: [], ended: [PLAN_1, PLAN_2] });
    assert.deepEqual([two.status, two.body], [409, PLANS_CHANGED]);
    assert.equal(world.state.planWrites, 0);

    const res = await call("PUT", PLANS_URL, { plans: [], ended: [PLAN_1, PLAN_2, PLAN_3] });
    assert.deepEqual([res.status, res.body], [200, { plans: [] }]);
    // A listing with no plan on offer takes an empty set as before.
    assert.deepEqual((await call("PUT", PLANS_URL, { plans: [] })).body, { plans: [] });
  });
  assert.ok(world.state.plans.filter((p) => p.listingId === LISTING_ID).every((p) => p.status === "retired"));
  assert.equal(world.state.plans.find((p) => p.id === PLAN_THEIRS)!.status, "active");
  assert.deepEqual(world.state.subs, subs);
});

test("the plans on offer are judged as the save's own transaction reads them: a plan added a moment before refuses it", async () => {
  const world = threePlans();
  world.state.plans = world.state.plans.filter((p) => p.id !== PLAN_3);
  // A teammate's plan lands after the route took the request and before this save reads the plans.
  const readPlans = world.models.listingPlan.findMany;
  let landed = false;
  world.models.listingPlan.findMany = async (args: Row) => {
    if (!landed && args.where.kind === "paid") {
      landed = true;
      world.state.plans.push(stored({ id: PLAN_3, name: "Team", priceCents: 9900n, includedUses: 5000, position: 3 }));
    }
    return readPlans(args);
  };
  const res = await withApp(world, (call) => call("PUT", PLANS_URL, { plans: [SENT_1], ended: [PLAN_2] }));
  assert.deepEqual([res.status, res.body], [409, PLANS_CHANGED]);
  assert.equal(world.state.planWrites, 0);
  assert.deepEqual(
    world.state.plans.filter((p) => p.listingId === LISTING_ID && p.status === "active").map((p) => p.id),
    [PLAN_1, PLAN_2, PLAN_3],
  );
});

test("a save that does not know of a plan another save is adding at the same moment never ends it", async () => {
  const world = makeWorld({ plans: [stored({ id: PLAN_1, position: 1 })] });
  // Both saves read the plans on offer before either writes.
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
    const [adds, renames] = await Promise.all([
      call("PUT", PLANS_URL, { plans: [SENT_1, pro()] }),
      call("PUT", PLANS_URL, { plans: [starter({ id: PLAN_1, name: "Starter plus" })] }),
    ]);
    assert.deepEqual([adds.status, renames.status], [200, 200]);
  });
  // The plan one save added is on offer, though the other never named it.
  assert.deepEqual(
    world.state.plans.map((p) => [p.name, p.position, p.status]),
    [
      ["Starter plus", 1, "active"],
      ["Pro", 2, "active"],
    ],
  );
});

test("the route hands the ids to the service as they were sent, and an empty list when none were", async () => {
  const Fastify = (await import("fastify")).default;
  const { createListingPlanRoutes } = await import("../routes/listingPlans.js");
  const seen: Array<{ plans: number; ended: readonly string[] }> = [];
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { auth: unknown }).auth = OWNER;
  });
  await app.register(
    createListingPlanRoutes({
      guards: { auth: async () => {}, ownerOrAdmin: async () => {} },
      setPlans: async (_listingId, _orgId, plans, ended) => {
        seen.push({ plans: plans.length, ended });
        return [];
      },
    }),
  );
  try {
    await app.inject({ method: "PUT", url: PLANS_URL, payload: { plans: [starter()] } });
    await app.inject({ method: "PUT", url: PLANS_URL, payload: { plans: [], ended: [PLAN_2, PLAN_1] } });
    // A field the route does not know is not a reason to refuse, and is not passed on.
    await app.inject({ method: "PUT", url: PLANS_URL, payload: { plans: [], ended: [], retire: [PLAN_3] } });
  } finally {
    await app.close();
  }
  assert.deepEqual(seen, [
    { plans: 1, ended: [] },
    { plans: 0, ended: [PLAN_2, PLAN_1] },
    { plans: 0, ended: [] },
  ]);
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

// ============================================
// The free trial
// ============================================

const TRIAL_ID = "99999999-9999-4999-8999-999999999999";
const freeTrial = (over: Row = {}) => ({ kind: "trial", priceCents: 0, includedUses: 20, extraUsePriceCents: null, ...over });
const storedTrial = (over: Row = {}) =>
  stored({ id: TRIAL_ID, kind: "trial", name: "Free trial", priceCents: 0n, includedUses: 20, extraUsePriceCents: null, position: 0, ...over });
const onOfferOf = (world: World) =>
  world.state.plans
    .filter((p) => p.listingId === LISTING_ID && p.status === "active")
    .sort((a, b) => a.position - b.position)
    .map((p) => [p.kind, p.name, p.priceCents, p.includedUses, p.extraUsePriceCents, p.position]);

test("one free trial beside four paid plans is saved: at place 0, with no price, and named Free trial whatever was sent", async () => {
  const world = makeWorld();
  await withApp(world, async (call) => {
    const res = await call("PUT", PLANS_URL, {
      plans: [
        starter({ name: "One" }),
        // No name, and a name that is not kept.
        freeTrial({ name: "Try before you buy" }),
        starter({ name: "Two" }),
        starter({ name: "Three" }),
        starter({ name: "Four" }),
      ],
    });
    assert.equal(res.status, 200);
    // The creator reads the trial first, with its kind and the trials that run now.
    assert.deepEqual(
      res.body.plans.map((plan: Row) => [plan.kind, plan.name, plan.priceCents, plan.includedUses, plan.extraUsePriceCents, plan.status, plan.subscribers]),
      [
        ["trial", "Free trial", 0, 20, null, "active", 0],
        ["paid", "One", 900, 500, 5, "active", 0],
        ["paid", "Two", 900, 500, 5, "active", 0],
        ["paid", "Three", 900, 500, 5, "active", 0],
        ["paid", "Four", 900, 500, 5, "active", 0],
      ],
    );
    // A trial sent with no name at all is saved too.
    const alone = makeWorld();
    const bare = await withApp(alone, (c) => c("PUT", PLANS_URL, { plans: [freeTrial()] }));
    assert.equal(bare.status, 200);
    assert.deepEqual(onOfferOf(alone), [["trial", "Free trial", 0n, 20, null, 0]]);
  });
  assert.deepEqual(onOfferOf(world), [
    ["trial", "Free trial", 0n, 20, null, 0],
    ["paid", "One", 900n, 500, 5n, 1],
    ["paid", "Two", 900n, 500, 5n, 2],
    ["paid", "Three", 900n, 500, 5n, 3],
    ["paid", "Four", 900n, 500, 5n, 4],
  ]);
});

test("a free trial that breaks a rule is refused on its field, and nothing is saved: not the paid plan sent with it either", async () => {
  const world = makeWorld();
  await withApp(world, async (call) => {
    const put = (trial: Row, more: Row[] = []) => call("PUT", PLANS_URL, { plans: [starter(), trial, ...more] });
    assert.deepEqual(fieldOf(await put(freeTrial({ priceCents: 100 })), "plans[1].priceCents"), [
      400,
      "validation_failed",
      "A free trial has no price.",
    ]);
    assert.deepEqual(fieldOf(await put(freeTrial({ extraUsePriceCents: 5 })), "plans[1].extraUsePriceCents"), [
      400,
      "validation_failed",
      "A free trial has no price for an extra use. It stops when its uses are gone.",
    ]);
    for (const includedUses of [0, 51]) {
      assert.deepEqual(fieldOf(await put(freeTrial({ includedUses })), "plans[1].includedUses"), [
        400,
        "validation_failed",
        "A free trial includes between 1 and 50 uses.",
      ]);
    }
    assert.deepEqual(fieldOf(await put(freeTrial(), [freeTrial({ includedUses: 5 })]), "plans[2].kind"), [
      400,
      "validation_failed",
      "A listing can have one free trial.",
    ]);
    // A paid plan still needs its name.
    const unnamed = await call("PUT", PLANS_URL, { plans: [{ ...starter(), name: undefined }] });
    assert.deepEqual(fieldOf(unnamed, "plans[0].name"), [400, "validation_failed", "Give the plan a name."]);
  });
  assert.equal(world.state.plans.length, 0);
  assert.equal(world.state.planWrites, 0);
});

test("a free trial is changed in place by its id: it keeps its id and its place, and the people on it are not touched", async () => {
  const world = makeWorld({
    plans: [stored({ id: PLAN_1, position: 1 }), storedTrial()],
    subs: [{ id: "sub_t", listingId: LISTING_ID, subscriberId: "org_buyer", planId: TRIAL_ID, status: "active", includedUses: 20, usedInPeriod: 3, priceCents: 0n }],
  });
  const subs = structuredClone(world.state.subs);
  await withApp(world, async (call) => {
    const res = await call("PUT", PLANS_URL, { plans: [SENT_1, freeTrial({ id: TRIAL_ID, includedUses: 35, name: "Renamed" })] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.plans.map((plan: Row) => [plan.id, plan.kind, plan.name, plan.includedUses, plan.subscribers]), [
      [TRIAL_ID, "trial", "Free trial", 35, 1],
      [PLAN_1, "paid", "Starter", 500, 0],
    ]);

    // Its kind is not something that changes: the trial's id sent as a paid
    // plan, or a paid plan's id sent as the trial, is refused whole.
    const sentence = "A plan cannot be turned into a free trial, or a free trial into a plan. End it and add a new one.";
    const asPaid = await call("PUT", PLANS_URL, { plans: [SENT_1, starter({ id: TRIAL_ID, name: "Was a trial" })] });
    assert.deepEqual(fieldOf(asPaid, "plans[1].kind"), [400, "validation_failed", sentence]);
    const asTrial = await call("PUT", PLANS_URL, { plans: [freeTrial({ id: PLAN_1 })], ended: [TRIAL_ID] });
    assert.deepEqual(fieldOf(asTrial, "plans[0].kind"), [400, "validation_failed", sentence]);
  });
  assert.equal(world.state.plans.length, 2, "no row was added");
  assert.deepEqual(onOfferOf(world), [
    ["trial", "Free trial", 0n, 35, null, 0],
    ["paid", "Starter", 900n, 500, 5n, 1],
  ]);
  // The running trial keeps the uses it was started with.
  assert.deepEqual(world.state.subs, subs);
});

test("ending the free trial leaves the paid plans alone, and ending a paid plan leaves the trial alone", async () => {
  const world = makeWorld({
    plans: [stored({ id: PLAN_1, position: 1 }), stored({ id: PLAN_2, name: "Pro", priceCents: 2900n, includedUses: 2000, extraUsePriceCents: null, position: 2 }), storedTrial()],
    subs: [{ id: "sub_t", listingId: LISTING_ID, subscriberId: "org_buyer", planId: TRIAL_ID, status: "active", includedUses: 20, usedInPeriod: 3, priceCents: 0n }],
  });
  const subs = structuredClone(world.state.subs);
  const byId = (id: string) => world.state.plans.find((p) => p.id === id)!;
  await withApp(world, async (call) => {
    // A paid plan is ended: the trial stays on offer as it was.
    const paidEnded = await call("PUT", PLANS_URL, { plans: [SENT_1, freeTrial({ id: TRIAL_ID })], ended: [PLAN_2] });
    assert.equal(paidEnded.status, 200);
    assert.deepEqual([byId(PLAN_2).status, byId(TRIAL_ID).status, byId(TRIAL_ID).includedUses, byId(TRIAL_ID).position], ["retired", "active", 20, 0]);

    // The trial is ended by naming it: the paid plan is as it was.
    const before = structuredClone(byId(PLAN_1));
    const trialEnded = await call("PUT", PLANS_URL, { plans: [SENT_1], ended: [TRIAL_ID] });
    assert.equal(trialEnded.status, 200);
    assert.deepEqual(trialEnded.body.plans.map((plan: Row) => [plan.id, plan.kind]), [[PLAN_1, "paid"]]);
    assert.equal(byId(TRIAL_ID).status, "retired");
    assert.ok(byId(TRIAL_ID).retiredAt instanceof Date);
    // Retired, never deleted: the trials that are running still hold its id.
    assert.deepEqual([byId(TRIAL_ID).name, byId(TRIAL_ID).includedUses, byId(TRIAL_ID).position], ["Free trial", 20, 0]);
    assert.deepEqual(byId(PLAN_1), before);

    // A new trial takes the place the ended one held, and the ended one cannot be brought back by its id.
    const back = await call("PUT", PLANS_URL, { plans: [SENT_1, freeTrial({ id: TRIAL_ID })] });
    assert.deepEqual(fieldOf(back, "plans[1].id"), [400, "validation_failed", PLAN_MESSAGES.gone]);
    const again = await call("PUT", PLANS_URL, { plans: [SENT_1, freeTrial({ includedUses: 5 })] });
    assert.equal(again.status, 200);
    assert.deepEqual(onOfferOf(world), [
      ["trial", "Free trial", 0n, 5, null, 0],
      ["paid", "Starter", 900n, 500, 5n, 1],
    ]);
  });
  assert.equal(world.state.plans.length, 4);
  assert.deepEqual(world.state.subs, subs);
});

test("a free trial on offer that is neither sent nor named refuses the save, as a paid plan does", async () => {
  const world = makeWorld({ plans: [stored({ id: PLAN_1, position: 1 }), storedTrial()] });
  const before = structuredClone(world.state.plans);
  await withApp(world, async (call) => {
    // A page that does not know of the trial: nothing is ended behind its back.
    const stale = await call("PUT", PLANS_URL, { plans: [starter({ id: PLAN_1, priceCents: 1200 })] });
    assert.deepEqual([stale.status, stale.body], [409, PLANS_CHANGED]);
    // A second trial is not added beside the one on offer.
    const second = await call("PUT", PLANS_URL, { plans: [SENT_1, freeTrial()] });
    assert.deepEqual([second.status, second.body], [409, PLANS_CHANGED]);
  });
  assert.equal(world.state.planWrites, 0);
  assert.deepEqual(world.state.plans, before);
});

test("two saves that each add a free trial at the same moment leave one trial", async () => {
  const world = makeWorld();
  const readPlans = world.models.listingPlan.findMany;
  let readers = 0;
  let bothRead!: () => void;
  const bothHaveRead = new Promise<void>((resolve) => (bothRead = resolve));
  world.models.listingPlan.findMany = async (args: Row) => {
    const rows = await readPlans(args);
    if (args.where.kind === "trial") {
      if (++readers === 2) bothRead();
      await bothHaveRead;
    }
    return rows;
  };
  await withApp(world, async (call) => {
    const results = await Promise.all([
      call("PUT", PLANS_URL, { plans: [freeTrial()] }),
      call("PUT", PLANS_URL, { plans: [freeTrial({ includedUses: 10 })] }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(results.find((r) => r.status === 409)!.body.error, "plans_changed");
  });
  assert.equal(world.state.plans.filter((p) => p.kind === "trial" && p.status === "active").length, 1);
});

test("a listing that cannot have plans cannot have a free trial", async () => {
  for (const listing of [{ sells: "copies" }, { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 900n }]) {
    const world = makeWorld({ listing });
    const res = await withApp(world, (call) => call("PUT", PLANS_URL, { plans: [freeTrial()] }));
    assert.deepEqual([res.status, res.body.error], [409, "plans_not_available"]);
    assert.equal(world.state.planWrites, 0);
  }
});

test("my-listings carries the free trial first among a listing's plans, with its kind and the trials running now", async () => {
  const world = makeWorld({
    plans: [stored({ id: PLAN_1, position: 1 }), storedTrial(), storedTrial({ id: "trial_old", status: "retired", retiredAt: new Date(0) })],
    subs: [
      { id: "t1", subscriberId: "org_buyer_secret", planId: TRIAL_ID, status: "active" },
      { id: "t2", subscriberId: "org_buyer_2", planId: TRIAL_ID, status: "active" },
      // Over: stopped, or closed at the end of its 7 days.
      { id: "t3", subscriberId: "org_buyer_3", planId: TRIAL_ID, status: "cancelled" },
      { id: "t4", subscriberId: "org_buyer_4", planId: "trial_old", status: "active" },
    ].map((sub) => ({ listingId: LISTING_ID, currentPeriodEnd: new Date(Date.now() + 86_400_000), cancelAtPeriodEnd: true, ...sub })),
  });
  await withApp(world, async (call) => {
    const res = await call("GET", "/my-listings");
    assert.deepEqual(res.body.listings[0].plans, [
      { id: TRIAL_ID, kind: "trial", name: "Free trial", priceCents: 0, includedUses: 20, extraUsePriceCents: null, status: "active", subscribers: 2 },
      { id: PLAN_1, kind: "paid", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: 5, status: "active", subscribers: 0 },
    ]);
    assert.doesNotMatch(JSON.stringify(res.body), /org_buyer/);
  });
});

// ============================================
// A listing that sells a workflow
// ============================================

const WORKFLOW_LISTING = { agentId: null, orchestrationId: "33333333-3333-4333-8333-333333333333" };

test("plans are set on a workflow's listing as on an agent's, held to the same rules of a paid plan", async () => {
  const world = makeWorld({ listing: WORKFLOW_LISTING });
  await withApp(world, async (call) => {
    assert.deepEqual(fieldOf(await call("PUT", PLANS_URL, { plans: [starter({ priceCents: 99 })] }), "plans[0].priceCents"), [
      400,
      "validation_failed",
      "The price for 30 days must be at least $1.00.",
    ]);
    assert.equal(world.state.planWrites, 0);

    const res = await call("PUT", PLANS_URL, { plans: [starter(), pro()] });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.plans.map((plan: Row) => [plan.kind, plan.name, plan.priceCents, plan.includedUses, plan.extraUsePriceCents]),
      [
        ["paid", "Starter", 900, 500, 5],
        ["paid", "Pro", 2900, 2000, null],
      ],
    );
  });
  assert.deepEqual(
    world.state.plans.map((p) => [p.listingId, p.kind, p.position, p.status]),
    [
      [LISTING_ID, "paid", 1, "active"],
      [LISTING_ID, "paid", 2, "active"],
    ],
  );
});

test("a free trial is refused on a workflow's listing, on its field, and nothing is saved: not the paid plan sent with it either", async () => {
  const world = makeWorld({ listing: WORKFLOW_LISTING });
  await withApp(world, async (call) => {
    const res = await call("PUT", PLANS_URL, { plans: [starter(), freeTrial()] });
    assert.deepEqual(fieldOf(res, "plans[1].kind"), [
      400,
      "validation_failed",
      "A free trial can be offered on an agent only.",
    ]);
    assert.equal(res.body.message, "A free trial can be offered on an agent only.");
    // Only that field: the trial's own rules are not read out for a trial that cannot be.
    assert.deepEqual(Object.keys(res.body.fields), ["plans[1].kind"]);
    const broken = await call("PUT", PLANS_URL, { plans: [freeTrial({ priceCents: 500, includedUses: 999 })] });
    assert.deepEqual(broken.body.fields, { "plans[0].kind": "A free trial can be offered on an agent only." });
  });
  assert.equal(world.state.planWrites, 0);
  assert.deepEqual(world.state.plans, []);

  // The same set on an agent's listing is saved, trial and all.
  const agents = makeWorld();
  const saved = await withApp(agents, (call) => call("PUT", PLANS_URL, { plans: [starter(), freeTrial()] }));
  assert.equal(saved.status, 200);
  assert.deepEqual(agents.state.plans.map((p) => p.kind).sort(), ["paid", "trial"]);
});

test("a workflow's listing is never judged by a kind of agent, and one that is not sold per run is told so in its own words", async () => {
  // An agent that runs on its own cannot have plans. A workflow's listing has
  // no agent, so that rule is never applied to it, whatever row sits beside it.
  // This row names a workflow and still has an agent's id, so the fake joins
  // the scheduled agent to it: the save passes only if the agent is not read.
  const world = makeWorld({
    listing: { orchestrationId: WORKFLOW_LISTING.orchestrationId },
    agent: { agentKind: "scheduled" },
  });
  assert.equal((await withApp(world, (call) => call("PUT", PLANS_URL, { plans: [starter()] }))).status, 200);

  // The rule itself: the same terms beside a scheduled agent pass for a
  // workflow and are refused for an agent.
  const terms = { sells: "use", pricingModel: "per_request", agentKind: "scheduled" };
  const paid = [{ kind: "paid", name: "Starter", priceCents: 900n, includedUses: 500, extraUsePriceCents: 5n }];
  assert.equal(checkPlanSet({ ...terms, productKind: "workflow" }, paid).ok, true);
  const asAgent = checkPlanSet({ ...terms, productKind: "agent" }, paid);
  assert.deepEqual(
    asAgent.ok ? null : [asAgent.status, asAgent.message],
    [409, PLAN_MESSAGES.scheduled],
  );

  const monthly = makeWorld({ listing: { ...WORKFLOW_LISTING, pricingModel: "monthly" } });
  const res = await withApp(monthly, (call) => call("PUT", PLANS_URL, { plans: [starter()] }));
  assert.deepEqual([res.status, res.body.error, res.body.message], [
    409,
    "plans_not_available",
    "Plans are added to a workflow that is sold per run.",
  ]);
  assert.equal(PLAN_MESSAGES.workflowNotPerRun, res.body.message);
  assert.equal(monthly.state.planWrites, 0);
});
