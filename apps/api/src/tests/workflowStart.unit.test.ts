import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

import { earningsStandIn, type EarningsRow } from "./earningsStandIn.js";

// A buyer starts to use a workflow: POST /api/marketplace/listings/:id/use
// for a listing that sells a workflow, through the route and the real
// services over an in-memory database. What these pin: a start per run and
// a plan start write what an agent's write; before anything is claimed or
// charged the workflow is asked whether it can run at this moment, with the
// listing's publisher as its organization, and a workflow that cannot (or
// whose read fails) refuses the start, the plan start and the move with
// nothing written and nothing charged; every sentence is the workflow's; and
// an agent's start is word for word what it was.

const DAY = 24 * 60 * 60 * 1000;
const LISTING_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "22222222-2222-4222-8222-222222222222";
const STEP_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const STARTER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRO_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TRIAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BUYER = "org_buyer";
const PUBLISHER = "org_pub";

const NOT_OFFERED = "This workflow cannot be started right now. Nothing was charged. Try again later.";

type Row = Record<string, any>;

const onStarter = (): Row => ({
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
});

function makeWorld(
  opts: {
    /** "agent": the listing sells an agent, and nothing of a workflow may be read. */
    sells?: "workflow" | "agent";
    listing?: Row;
    workflow?: Row | null;
    steps?: Row[];
    /** The agents of the publisher's organization. */
    agents?: Row[];
    /** The publisher's deployments. */
    deployments?: Row[];
    /** The read of the workflow throws. */
    readFails?: boolean;
    /** The buyer is on the Starter plan already. */
    onPlan?: boolean;
    balance?: bigint;
  } = {},
) {
  const sellsAgent = opts.sells === "agent";
  const state = {
    listing: {
      id: LISTING_ID,
      agentId: sellsAgent ? "agent_src" : null,
      orchestrationId: sellsAgent ? null : WORKFLOW_ID,
      slug: "weekly-digest",
      title: "Weekly Digest",
      publisherId: PUBLISHER,
      status: "published",
      sells: "use",
      pricingModel: "per_request",
      pricePerRequestCents: 25n,
      monthlyPriceCents: null,
      pausedSince: null,
      totalInstalls: opts.onPlan ? 1 : 0,
      activeInstalls: opts.onPlan ? 1 : 0,
      ...opts.listing,
      agent: sellsAgent
        ? {
            id: "agent_src",
            orgId: PUBLISHER,
            name: "Analyst",
            publicHandle: "analyst",
            agentKind: "conversation",
            entrypoint: "chat",
            modelConfig: null,
          }
        : null,
    } as Row,
    workflows: (opts.workflow === null
      ? []
      : [{ id: WORKFLOW_ID, orgId: PUBLISHER, isEnabled: true, timeout: 600_000, inputSchema: {}, ...opts.workflow }]) as Row[],
    steps: opts.steps ?? [
      { stepType: "agent", agentId: STEP_AGENT_ID, fallbackAgentId: null, deploymentId: null },
      { stepType: "model", agentId: null, fallbackAgentId: null, deploymentId: DEPLOYMENT_ID },
    ],
    agents: (opts.agents ?? [{ id: STEP_AGENT_ID, orgId: PUBLISHER, modelConfig: {} }]) as Row[],
    deployments: (opts.deployments ?? [{ id: DEPLOYMENT_ID, orgId: PUBLISHER, status: "running" }]) as Row[],
    plans: [
      { id: STARTER_ID, listingId: LISTING_ID, kind: "paid", status: "active", retiredAt: null, name: "Starter", priceCents: 900n, includedUses: 500, extraUsePriceCents: 5n, position: 1 },
      { id: PRO_ID, listingId: LISTING_ID, kind: "paid", status: "active", retiredAt: null, name: "Pro", priceCents: 2900n, includedUses: 2000, extraUsePriceCents: null, position: 2 },
    ] as Row[],
    installs: (opts.onPlan
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
          },
        ]
      : []) as Row[],
    subs: (opts.onPlan
      ? [{ id: "sub_1", listingId: LISTING_ID, subscriberId: BUYER, cancelAtPeriodEnd: false, cancelledAt: null, endReason: null, ...onStarter() }]
      : []) as Row[],
    reviews: [] as Row[],
    balance: opts.balance ?? 10_000n,
    ledger: [] as Row[],
    revenue: [] as Row[],
    accrued: 0n,
    earnings: [] as EarningsRow[],
    /** Every read of a workflow: the where it was made with. */
    workflowReads: [] as Row[],
    /** Every read of the publisher's own deployment of a model a step agent is set to. */
    hostedModelReads: [] as Row[],
    /** Every write of a licence or a subscription, and every charge. */
    writes: [] as string[],
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
        if ("not" in cond) return v !== cond.not;
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
    // The workflow behind the listing, as the question of whether it can run reads it.
    orchestration: {
      findFirst: async ({ where }: Row) => {
        state.workflowReads.push({ ...where });
        if (opts.readFails) throw new Error("connection reset");
        const row = state.workflows.find((w) => matches(w, where));
        return row ? { ...row, steps: state.steps.map((s) => ({ ...s })) } : null;
      },
    },
    agent: {
      findMany: async ({ where }: Row) =>
        state.agents.filter((a) => where.id.in.includes(a.id) && a.orgId === where.orgId).map((a) => ({ ...a })),
    },
    deployment: {
      findMany: async ({ where }: Row) => state.deployments.filter((d) => matches(d, where)).map((d) => ({ id: d.id })),
      // The running deployment of a model an agent is set to. No deployment
      // of this world serves one, so the answer is always that there is none.
      findFirst: async ({ where }: Row) => {
        state.hostedModelReads.push({ ...where });
        return null;
      },
    },
    agentListing: {
      findUnique: async () => structuredClone(state.listing),
      update: async ({ data }: Row) => {
        write(state.listing, data);
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
      // No agent of this world is a buyer's copy from the marketplace.
      findFirst: async () => null,
      findUnique: async () => (state.installs[0] ? { ...state.installs[0] } : null),
      updateMany: async ({ where, data }: Row) => {
        const hit = state.installs.filter((i) => matches(i, where));
        for (const i of hit) write(i, data);
        if (hit.length > 0) state.writes.push("agentInstall.updateMany");
        return { count: hit.length };
      },
      update: async ({ where, data }: Row) => {
        state.writes.push("agentInstall.update");
        const row = state.installs.find((i) => i.id === where.id)!;
        write(row, data);
        return { ...row };
      },
      create: async ({ data }: Row) => {
        if (state.installs.length > 0) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        state.writes.push("agentInstall.create");
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
      findUnique: async (args: Row) => {
        const sub = state.subs[0];
        if (!sub) return null;
        const plan = planOf(sub);
        return {
          ...sub,
          ...((args?.include?.plan || args?.select?.plan) && { plan: plan && { status: plan.status, name: plan.name } }),
        };
      },
      create: async ({ data }: Row) => {
        if (state.subs.length > 0) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        state.writes.push("agentSubscription.create");
        const row = { id: `sub_${++seq}`, ...data };
        state.subs.push(row);
        return { ...row };
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = state.subs.filter((s) => matches(s, where));
        for (const s of hit) write(s, data);
        if (hit.length > 0) state.writes.push("agentSubscription.updateMany");
        return { count: hit.length };
      },
    },
    agentReview: {
      findUnique: async ({ where }: Row) =>
        state.reviews.find((r) => r.reviewerId === where.listingId_reviewerId.reviewerId) ?? null,
      create: async ({ data }: Row) => {
        state.reviews.push(data);
        return data;
      },
      aggregate: async () => ({ _avg: { rating: 5 }, _count: { id: state.reviews.length } }),
    },
    job: { findFirst: async () => null },
    creditBalance: {
      updateMany: async ({ where, data }: Row) => {
        if (state.balance < where.balanceCents.gte) return { count: 0 };
        state.writes.push("creditBalance.updateMany");
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
    orgSubscription: { findUnique: async () => null },
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

/** Runs `fn` with the world's models in the place of the database's. */
async function onWorld<T>(world: World, fn: () => Promise<T>): Promise<T> {
  const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Row };
  const originals: Row = {};
  for (const [name, fake] of Object.entries(world.models)) {
    originals[name] = prisma[name];
    prisma[name] = fake;
  }
  try {
    return await fn();
  } finally {
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

async function call(world: World, path: string, payload: Row, orgId = BUYER) {
  return onWorld(world, async () => {
    const Fastify = (await import("fastify")).default;
    const sensible = await import("@fastify/sensible");
    const { marketplaceRoutes } = await import("../routes/marketplace.js");
    const app = Fastify();
    await app.register(sensible.default);
    app.decorateRequest("auth", null);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { auth: unknown }).auth = { userId: "u_owner", orgId, type: "jwt", role: "owner" };
    });
    await app.register(marketplaceRoutes);
    try {
      const res = await app.inject({ method: "POST", url: `/listings/${LISTING_ID}/${path}`, payload });
      // Let the fire-and-forget reputation recalculation settle on the fakes.
      await new Promise((resolve) => setImmediate(resolve));
      return { status: res.statusCode, body: res.json() as Row };
    } finally {
      await app.close();
    }
  });
}

const PER_RUN = { expected: { pricingModel: "per_request", pricePerRequestCents: 25, monthlyPriceCents: null } };
const STARTER = { id: STARTER_ID, priceCents: 900, includedUses: 500, extraUsePriceCents: 5 };
const PRO = { id: PRO_ID, priceCents: 2900, includedUses: 2000, extraUsePriceCents: null };

/** The three ways a buyer starts paying for a workflow, each on the world it needs. */
const STARTS: Array<{ name: string; onPlan: boolean; body: Row }> = [
  { name: "a start per run", onPlan: false, body: PER_RUN },
  { name: "a plan start", onPlan: false, body: { plan: STARTER } },
  { name: "a move to a bigger plan", onPlan: true, body: { plan: PRO, switchNow: true } },
];

/** What a refusal must leave exactly as it was. */
const moneyAndRows = (world: World) =>
  structuredClone({
    installs: world.state.installs,
    subs: world.state.subs,
    balance: world.state.balance,
    ledger: world.state.ledger,
    revenue: world.state.revenue,
    accrued: world.state.accrued,
    earnings: world.state.earnings,
    counters: [world.state.listing.totalInstalls, world.state.listing.activeInstalls],
  });

// ============================================
// A workflow that can run
// ============================================

test("a start per run on a workflow that can run writes the licence an agent's start writes, and charges nothing", async () => {
  const world = makeWorld();
  const res = await call(world, "use", PER_RUN);
  assert.equal(res.status, 201);
  assert.equal(res.body.access, "listing_pricing");
  // What the buyer is told it is: a workflow, by the listing's slug, with no agent.
  assert.deepEqual([res.body.productKind, res.body.slug, res.body.agent], ["workflow", "weekly-digest", null]);

  const licence = world.state.installs[0]!;
  assert.deepEqual(
    [licence.kind, licence.status, licence.clonedAgentId, licence.acceptedPricingModel, licence.acceptedPricePerRequestCents],
    ["use", "active", null, "per_request", 25n],
  );
  assert.equal(world.state.subs.length, 0);
  assert.equal(world.state.balance, 10_000n);
  assert.deepEqual([world.state.ledger.length, world.state.revenue.length], [0, 0]);
  assert.deepEqual([world.state.listing.totalInstalls, world.state.listing.activeInstalls], [1, 1]);

  // Asked once, by the workflow's id AND the listing's publisher as its organization.
  assert.deepEqual(world.state.workflowReads, [{ id: WORKFLOW_ID, orgId: PUBLISHER }]);
});

test("a plan start on a workflow that can run charges the first 30 days once, with 90% to the publisher", async () => {
  const world = makeWorld();
  const res = await call(world, "use", { plan: STARTER });
  assert.equal(res.status, 201);
  assert.equal(res.body.access, "subscribed");
  assert.deepEqual([res.body.productKind, res.body.slug, res.body.agent], ["workflow", "weekly-digest", null]);

  const sub = world.state.subs[0]!;
  assert.deepEqual(
    [sub.status, sub.planId, sub.priceCents, sub.includedUses, sub.extraUsePriceCents, sub.usedInPeriod],
    ["active", STARTER_ID, 900n, 500, 5n, 0],
  );
  assert.equal(sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime(), 30 * DAY);

  assert.equal(world.state.balance, 9_100n);
  assert.deepEqual(world.state.ledger.map((row) => [row.type, row.amountCents]), [["marketplace_subscription", -900n]]);
  assert.deepEqual(
    world.state.revenue.map((row) => [row.type, row.grossAmountCents, row.creatorAmountCents, row.platformFeeCents]),
    [["subscription", 900n, 810n, 90n]],
  );
  // The whole creator amount to the publisher: a workflow has nobody to share it with.
  assert.deepEqual(
    world.state.earnings.map((row) => [row.orgId, row.type, row.amountCents]),
    [[PUBLISHER, "subscription", 810n]],
  );
  // A plan start is no agreement to the price per run.
  const licence = world.state.installs[0]!;
  assert.deepEqual([licence.kind, licence.status, licence.acceptedPricingModel], ["use", "active", null]);
  assert.deepEqual(world.state.workflowReads, [{ id: WORKFLOW_ID, orgId: PUBLISHER }]);
});

test("a move to a bigger plan on a workflow that can run charges the new 30 days", async () => {
  const world = makeWorld({ onPlan: true });
  const res = await call(world, "use", { plan: PRO, switchNow: true });
  assert.equal(res.status, 201);
  assert.deepEqual([world.state.subs[0]!.planId, world.state.subs[0]!.priceCents], [PRO_ID, 2900n]);
  assert.equal(world.state.balance, 7_100n);
  assert.deepEqual(world.state.earnings.map((row) => [row.orgId, row.amountCents]), [[PUBLISHER, 2610n]]);
  assert.deepEqual(world.state.workflowReads, [{ id: WORKFLOW_ID, orgId: PUBLISHER }]);
});

// ============================================
// A workflow that cannot run
// ============================================

const CANNOT_RUN: Array<{ name: string; world: Parameters<typeof makeWorld>[0] }> = [
  { name: "a disabled workflow", world: { workflow: { isEnabled: false } } },
  { name: "a workflow with no steps", world: { steps: [] } },
  { name: "a workflow with a step whose agent was deleted", world: { agents: [] } },
  {
    name: "a workflow whose model step's deployment is stopped",
    world: { deployments: [{ id: DEPLOYMENT_ID, orgId: PUBLISHER, status: "stopped" }] },
  },
  { name: "a workflow whose read fails", world: { readFails: true } },
  // The listing still says published, and the workflow is gone from its publisher's organization.
  { name: "a workflow that is no longer in the publisher's organization", world: { workflow: { orgId: "org_elsewhere" } } },
  { name: "a workflow with a time limit over ten minutes", world: { workflow: { timeout: 600_001 } } },
];

for (const broken of CANNOT_RUN) {
  for (const start of STARTS) {
    test(`${broken.name} refuses ${start.name}: nothing is written and nothing is charged`, async () => {
      const world = makeWorld({ ...broken.world, onPlan: start.onPlan });
      const before = moneyAndRows(world);
      const res = await call(world, "use", start.body);
      assert.deepEqual([res.status, res.body.error, res.body.message], [409, "not_offered", NOT_OFFERED]);
      assert.deepEqual(moneyAndRows(world), before);
      assert.deepEqual(world.state.writes, []);
      // It was asked, of the publisher's organization, and that is what refused.
      assert.deepEqual(world.state.workflowReads, [{ id: WORKFLOW_ID, orgId: PUBLISHER }]);
    });
  }
}

test("a step agent set to a model its organization runs, with no running deployment of it, refuses every start", async () => {
  for (const start of STARTS) {
    const world = makeWorld({
      agents: [{ id: STEP_AGENT_ID, orgId: PUBLISHER, modelConfig: { model: "wheelsai/llama-3.1-8b" } }],
      onPlan: start.onPlan,
    });
    const before = moneyAndRows(world);
    const res = await call(world, "use", start.body);
    assert.deepEqual([res.status, res.body.error, res.body.message], [409, "not_offered", NOT_OFFERED], start.name);
    assert.deepEqual(moneyAndRows(world), before);
    assert.deepEqual(world.state.writes, []);
    // What refused is the agent's model: the model step's deployment runs,
    // and the publisher's own deployment of the agent's model was asked for
    // and not found.
    assert.deepEqual(world.state.hostedModelReads, [
      { orgId: PUBLISHER, modelId: "llama-3.1-8b", status: "running", fineTunedModelId: null },
    ]);
  }
});

test("a question that throws refuses the start, the plan start and the move: nothing is written and nothing is charged", async () => {
  const { startUsing, UseStartError } = await import("../services/marketplace.js");
  const { startPlan } = await import("../services/planStart.js");
  const { movePlan } = await import("../services/planMove.js");
  type Hooks = NonNullable<Parameters<typeof startUsing>[3]>;
  const terms = (plan: typeof STARTER | typeof PRO) => ({
    id: plan.id,
    priceCents: BigInt(plan.priceCents),
    includedUses: plan.includedUses,
    extraUsePriceCents: plan.extraUsePriceCents === null ? null : BigInt(plan.extraUsePriceCents),
  });
  const starts: Array<{ name: string; onPlan: boolean; run: (hooks: Hooks) => Promise<unknown> }> = [
    { name: "a start per run", onPlan: false, run: (hooks) => startUsing(LISTING_ID, BUYER, PER_RUN, hooks) },
    { name: "a plan start", onPlan: false, run: (hooks) => startPlan(LISTING_ID, BUYER, terms(STARTER), hooks) },
    { name: "a move to a bigger plan", onPlan: true, run: (hooks) => movePlan(LISTING_ID, BUYER, terms(PRO), hooks) },
  ];
  for (const start of starts) {
    const world = makeWorld({ onPlan: start.onPlan });
    const before = moneyAndRows(world);
    const asked: Row[] = [];
    const hooks: Hooks = {
      workflowCanRunNow: async (ref) => {
        asked.push(ref);
        throw new Error("connection reset");
      },
    };
    await assert.rejects(
      onWorld(world, () => start.run(hooks)),
      (err: unknown) => {
        assert.ok(err instanceof UseStartError, start.name);
        assert.deepEqual([err.status, err.code, err.message], [409, "not_offered", NOT_OFFERED], start.name);
        return true;
      },
    );
    assert.deepEqual(moneyAndRows(world), before);
    assert.deepEqual(world.state.writes, []);
    // The question that was handed in is the one that was asked, once, and nothing else read the workflow.
    assert.deepEqual(asked, [{ workflowId: WORKFLOW_ID, orgId: PUBLISHER }]);
    assert.deepEqual(world.state.workflowReads, []);
  }
});

test("a listing that reads as a workflow's and names no workflow refuses every start, and reads nothing", async () => {
  for (const start of STARTS) {
    // No agent and no workflow: only a corrupt row can say so.
    const world = makeWorld({ listing: { orchestrationId: null }, onPlan: start.onPlan });
    assert.deepEqual([world.state.listing.agentId, world.state.listing.orchestrationId], [null, null]);
    const before = moneyAndRows(world);
    const res = await call(world, "use", start.body);
    assert.deepEqual([res.status, res.body.error, res.body.message], [409, "not_offered", NOT_OFFERED], start.name);
    assert.deepEqual(moneyAndRows(world), before);
    assert.deepEqual(world.state.writes, []);
    assert.deepEqual(world.state.workflowReads, []);
  }
});

test("the question is asked at every start, never remembered: a workflow disabled after one buyer started refuses the next", async () => {
  const world = makeWorld();
  assert.equal((await call(world, "use", { plan: STARTER })).status, 201);
  world.state.workflows[0]!.isEnabled = false;
  // The same buyer, on a plan now, asks to move up: the listing still says published.
  const before = moneyAndRows(world);
  const res = await call(world, "use", { plan: PRO, switchNow: true });
  assert.deepEqual([res.status, res.body.error, res.body.message], [409, "not_offered", NOT_OFFERED]);
  assert.deepEqual(moneyAndRows(world), before);
  assert.equal(world.state.workflowReads.length, 2);
});

test("a workflow's listing that is not sold per run starts nothing, in the workflow's words", async () => {
  for (const pricingModel of ["free", "monthly"]) {
    const world = makeWorld({ listing: { pricingModel, monthlyPriceCents: 900n } });
    const res = await call(world, "use", { expected: { pricingModel, pricePerRequestCents: null, monthlyPriceCents: 900 } });
    assert.deepEqual(
      [res.status, res.body.error, res.body.message],
      [409, "not_offered", "Use of this workflow is not on sale right now."],
    );
    assert.deepEqual(world.state.writes, []);
    assert.equal(world.state.balance, 10_000n);
  }
});

test("a free trial row found on a workflow's listing starts no trial: it is refused as a plan the listing does not offer", async () => {
  // A workflow's listing offers no free trial, so only a corrupt row can be one.
  const trialRow = { id: TRIAL_ID, listingId: LISTING_ID, kind: "trial", status: "active", retiredAt: null, name: "Free trial", priceCents: 0n, includedUses: 20, extraUsePriceCents: null, position: 0 };
  const world = makeWorld();
  world.state.plans.push({ ...trialRow });
  const before = moneyAndRows(world);
  // The row's own terms, as a page that listed it would send them.
  const res = await call(world, "use", { plan: { id: TRIAL_ID, priceCents: 0, includedUses: 20, extraUsePriceCents: null } });
  assert.deepEqual([res.status, res.body.error], [409, "pricing_changed"]);
  // The answer of a paid plan that is not offered: the plans on sale, and no word of a trial.
  assert.deepEqual(res.body.plans.map((plan: Row) => plan.id), [STARTER_ID, PRO_ID]);
  assert.equal("trial" in res.body, false);
  assert.deepEqual(moneyAndRows(world), before);
  assert.deepEqual(world.state.writes, []);
  assert.equal(world.state.balance, 10_000n);

  // Word for word what a plan this listing never had is answered.
  const other = makeWorld();
  other.state.plans.push({ ...trialRow });
  const unknown = await call(other, "use", {
    plan: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", priceCents: 0, includedUses: 20, extraUsePriceCents: null },
  });
  assert.deepEqual(res, unknown);
});

// ============================================
// The workflow's own words
// ============================================

test("the publisher's own start, plan start and move are refused in the workflow's words, before the workflow is read", async () => {
  for (const start of STARTS) {
    const world = makeWorld({ onPlan: start.onPlan });
    const before = moneyAndRows(world);
    const res = await call(world, "use", start.body, PUBLISHER);
    assert.deepEqual(
      [res.status, res.body.error, res.body.message],
      [409, "own_agent", "This is your workflow. You do not pay to use it."],
      start.name,
    );
    assert.deepEqual(moneyAndRows(world), before);
    assert.deepEqual(world.state.workflowReads, []);
  }
});

test("a buyer on a plan for a workflow who starts a plan again is told so in the workflow's words", async () => {
  const world = makeWorld({ onPlan: true });
  const res = await call(world, "use", { plan: PRO });
  assert.deepEqual(
    [res.status, res.body.error, res.body.message],
    [409, "already_on_plan", "You already have a plan for this workflow that is still running. Nothing was charged."],
  );
  assert.equal(world.state.balance, 10_000n);
});

test("installing a workflow's listing as a copy answers the workflow's sentence", async () => {
  const world = makeWorld();
  const res = await call(world, "install", {});
  assert.deepEqual(
    [res.status, res.body.error, res.body.message, res.body.handle],
    [409, "sells_use", "You use this workflow on its page. You do not get a copy.", null],
  );
  assert.deepEqual(world.state.writes, []);
  assert.doesNotMatch(JSON.stringify(res.body), /agent/i);
});

test("installing a workflow's listing that is not published answers that the workflow is not on sale", async () => {
  for (const status of ["draft", "archived"]) {
    const world = makeWorld({ listing: { status } });
    const res = await call(world, "install", {});
    assert.deepEqual([res.status, res.body.message], [400, "Use of this workflow is not on sale right now."], status);
    assert.deepEqual(world.state.writes, []);
    assert.doesNotMatch(JSON.stringify(res.body), /agent/i);
  }
});

test("the publisher installing their own workflow's listing is told it is theirs", async () => {
  const world = makeWorld();
  const res = await call(world, "install", {}, PUBLISHER);
  assert.deepEqual([res.status, res.body.message], [400, "This is your workflow. You do not pay to use it."]);
  assert.deepEqual(world.state.writes, []);
  assert.doesNotMatch(JSON.stringify(res.body), /agent/i);
});

test("a second review of a workflow's listing is refused in the workflow's words", async () => {
  const world = makeWorld();
  assert.equal((await call(world, "reviews", { rating: 5 })).status, 201);
  const again = await call(world, "reviews", { rating: 4 });
  assert.equal(again.status, 400);
  assert.equal(again.body.message, "You have already reviewed this workflow.");
});

// ============================================
// An agent's listing is what it was
// ============================================

test("an agent's start is word for word what it was, and reads nothing of a workflow", async () => {
  const own = makeWorld({ sells: "agent" });
  for (const start of STARTS) {
    const res = await call(own, "use", start.body, PUBLISHER);
    assert.deepEqual(
      [res.status, res.body.error, res.body.message],
      [409, "own_agent", "This is your agent. You do not pay to use it."],
      start.name,
    );
  }

  // A start per use writes the licence and never asks about a workflow.
  const world = makeWorld({ sells: "agent" });
  const started = await call(world, "use", PER_RUN);
  assert.equal(started.status, 201);
  assert.deepEqual(
    [started.body.productKind, started.body.agent],
    ["agent", { handle: "analyst", name: "Analyst", agentKind: "conversation" }],
  );
  assert.deepEqual([world.state.installs[0]!.kind, world.state.installs[0]!.acceptedPricePerRequestCents], ["use", 25n]);

  // A plan start too, and a second one is told in the agent's sentence.
  const plan = makeWorld({ sells: "agent" });
  assert.equal((await call(plan, "use", { plan: STARTER })).status, 201);
  assert.equal(plan.state.balance, 9_100n);
  const again = await call(plan, "use", { plan: PRO });
  assert.equal(
    again.body.message,
    "You already have a plan or a subscription for this agent that is still running. Nothing was charged.",
  );

  // A second review, in the agent's sentence.
  const reviewed = makeWorld({ sells: "agent" });
  await call(reviewed, "reviews", { rating: 5 });
  assert.equal((await call(reviewed, "reviews", { rating: 4 })).body.message, "You have already reviewed this agent");

  for (const w of [own, world, plan, reviewed]) assert.deepEqual(w.state.workflowReads, []);
});

// ============================================
// Stopping
// ============================================

test("stopping use of a workflow ends its licence and its plan in the workflow's words; an agent's are word for word what they were", async () => {
  const cases = [
    { sells: "workflow" as const, stopped: "You stopped using this workflow.", notInUse: "You are not using this workflow right now." },
    { sells: "agent" as const, stopped: "Agent uninstalled successfully", notInUse: "This agent is not currently installed" },
  ];
  for (const { sells, stopped, notInUse } of cases) {
    const world = makeWorld({ sells, onPlan: true });
    const res = await call(world, "uninstall", {});
    assert.deepEqual([res.status, res.body], [200, { message: stopped }], sells);
    // The same path for both: the licence ends now, the plan with it, and nothing is charged or refunded.
    assert.equal(world.state.installs[0]!.status, "uninstalled", sells);
    assert.deepEqual([world.state.subs[0]!.status, world.state.subs[0]!.cancelAtPeriodEnd], ["cancelled", false], sells);
    assert.equal(world.state.listing.activeInstalls, 0, sells);
    assert.equal(world.state.balance, 10_000n, sells);

    // Stopping again: nothing more to stop, in the same words' twin.
    const again = await call(world, "uninstall", {});
    assert.deepEqual([again.status, again.body.message], [400, notInUse], sells);
    assert.equal(world.state.listing.activeInstalls, 0, sells);

    // Stopping never asks whether the workflow can run.
    assert.deepEqual(world.state.workflowReads, [], sells);
    if (sells === "workflow") {
      assert.doesNotMatch(JSON.stringify([res.body, again.body]), /agent|install/i);
    }
  }
});
