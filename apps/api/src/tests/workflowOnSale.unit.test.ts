import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

// A workflow on sale stays runnable, and a sold one is not deleted: the real
// workflow service over an in-memory database. What these pin: while its
// listing is published, or while anyone is still on a plan for it, a disable
// and a change that would leave it unsellable are refused with nothing
// changed; a delete reads the listing first, before any run is cancelled;
// a listing nobody bought goes with the workflow; and a workflow that is not
// listed is disabled, tooLong and deleted exactly as before.

const ORG = "org_creator";
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const COPY_AGENT_ID = "55555555-5555-4555-8555-555555555555";
const LISTING_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-14T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const UPDATED_AT = new Date("2026-10-01T00:00:00.000Z");

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond) return cond.in.includes(v);
      if ("not" in cond) return v !== cond.not;
      if ("gt" in cond) return v > cond.gt;
    }
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    return v === cond;
  });
}

function makeWorld(opts: {
  workflow?: Row;
  /** The workflow's listing, if it has one. */
  listing?: Row | null;
  plans?: Row[];
  subs?: Row[];
  installs?: Row[];
  runs?: Row[];
} = {}) {
  const state = {
    workflows: [
      { id: WORKFLOW_ID, orgId: ORG, name: "Digest", slug: "digest", isEnabled: true, timeout: 600_000, inputSchema: {}, updatedAt: UPDATED_AT, ...(opts.workflow ?? {}) },
    ] as Row[],
    steps: [{ orchestrationId: WORKFLOW_ID, name: "a", stepType: "agent", agentId: AGENT_ID, fallbackAgentId: null, deploymentId: null }] as Row[],
    listings: (opts.listing
      ? [{ id: LISTING_ID, agentId: null, orchestrationId: WORKFLOW_ID, publisherId: ORG, status: "published", sells: "use", pricingModel: "per_request", ...opts.listing }]
      : []) as Row[],
    plans: (opts.plans ?? []).map((plan) => ({ listingId: LISTING_ID, ...plan })) as Row[],
    subs: (opts.subs ?? []).map((sub) => ({ listingId: LISTING_ID, ...sub })) as Row[],
    installs: (opts.installs ?? []).map((install) => ({ listingId: LISTING_ID, ...install })) as Row[],
    runs: (opts.runs ?? [
      { id: "run_queued", orchestrationId: WORKFLOW_ID, status: "queued", cancelRequestedAt: null },
      { id: "run_running", orchestrationId: WORKFLOW_ID, status: "running", cancelRequestedAt: null },
    ]) as Row[],
    /** Every write, by name, in the order it was made. */
    writes: [] as string[],
    /** What was read, in order: a delete must read the listing before it writes to a run. */
    order: [] as string[],
    transactions: 0,
    /** Run once, just before the first write inside a transaction. */
    beforeDeleteInTransaction: null as (() => void) | null,
  };
  const collections = ["workflows", "steps", "listings", "plans", "subs", "installs", "runs"] as const;

  const models: Row = {
    orchestration: {
      findFirst: async ({ where }: Row) => {
        const row = state.workflows.find((w) => matches(w, where));
        return row ? { ...row, steps: state.steps.filter((s) => s.orchestrationId === row.id).map((s) => ({ ...s })) } : null;
      },
      findFirstOrThrow: async ({ where }: Row) => {
        const row = state.workflows.find((w) => matches(w, where));
        if (!row) throw new Error("No Orchestration found");
        return { ...row, steps: state.steps.filter((s) => s.orchestrationId === row.id).map((s) => ({ ...s })) };
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = state.workflows.filter((w) => matches(w, where));
        if (hit.length > 0) state.writes.push("orchestration.updateMany");
        for (const w of hit) Object.assign(w, data);
        return { count: hit.length };
      },
      deleteMany: async ({ where }: Row) => {
        const hit = state.workflows.filter((w) => matches(w, where));
        // The database's rule: a workflow that a listing still names is not deleted.
        if (hit.some((w) => state.listings.some((l) => l.orchestrationId === w.id))) {
          throw Object.assign(new Error("Foreign key constraint failed: agent_listings_orchestration_id_fkey"), { code: "P2003" });
        }
        state.writes.push("orchestration.deleteMany");
        state.workflows = state.workflows.filter((w) => !hit.includes(w));
        state.steps = state.steps.filter((s) => !hit.some((w) => w.id === s.orchestrationId));
        return { count: hit.length };
      },
    },
    orchestrationStep: {
      deleteMany: async ({ where }: Row) => {
        state.writes.push("orchestrationStep.deleteMany");
        state.steps = state.steps.filter((s) => !matches(s, where));
        return { count: 0 };
      },
      createMany: async ({ data }: Row) => {
        state.writes.push("orchestrationStep.createMany");
        state.steps.push(...data);
        return { count: data.length };
      },
    },
    orchestrationExecution: {
      updateMany: async ({ where, data }: Row) => {
        state.order.push("run.updateMany");
        const hit = state.runs.filter((r) => matches(r, where));
        if (hit.length > 0) state.writes.push(`run.${data.status ?? "cancelRequested"}`);
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    },
    agentListing: {
      findFirst: async ({ where, select }: Row) => {
        state.order.push("listing.findFirst");
        const row = state.listings.find((l) => matches(l, where));
        if (!row) return null;
        return select?._count
          ? {
              ...row,
              _count: {
                installs: state.installs.filter((i) => i.listingId === row.id).length,
                subscriptions: state.subs.filter((s) => s.listingId === row.id).length,
              },
            }
          : { ...row };
      },
      deleteMany: async ({ where }: Row) => {
        if (state.beforeDeleteInTransaction) {
          const hook = state.beforeDeleteInTransaction;
          state.beforeDeleteInTransaction = null;
          hook();
        }
        const hit = state.listings.filter((l) => matches(l, where));
        // The database's rule: a plan holds its listing.
        if (hit.some((l) => state.plans.some((p) => p.listingId === l.id))) {
          throw Object.assign(new Error("Foreign key constraint failed: listing_plans_listing_id_fkey"), { code: "P2003" });
        }
        if (hit.length > 0) state.writes.push("listing.deleteMany");
        state.listings = state.listings.filter((l) => !hit.includes(l));
        return { count: hit.length };
      },
    },
    listingPlan: {
      deleteMany: async ({ where }: Row) => {
        const hit = state.plans.filter((p) => matches(p, where));
        if (hit.length > 0) state.writes.push("listingPlan.deleteMany");
        state.plans = state.plans.filter((p) => !hit.includes(p));
        return { count: hit.length };
      },
    },
    agentSubscription: {
      count: async ({ where }: Row) => state.subs.filter((s) => matches(s, where)).length,
    },
    agentInstall: {
      count: async ({ where }: Row) => state.installs.filter((i) => matches(i, where)).length,
      // Whether an agent is a buyer's copy from the marketplace.
      findFirst: async ({ where }: Row) => ((where.clonedAgentId?.in ?? []).includes(COPY_AGENT_ID) ? { id: "ins_copy" } : null),
    },
    // Both agents are the organization's own; one of them is a marketplace copy.
    agent: {
      findMany: async ({ where }: Row) =>
        [AGENT_ID, COPY_AGENT_ID].filter((id) => where.id.in.includes(id) && where.orgId === ORG).map((id) => ({ id, modelConfig: {} })),
    },
    deployment: { findMany: async () => [] },
    knowledgeBase: { findMany: async () => [] },
  };
  models.$transaction = async (fn: (tx: Row) => Promise<unknown>) => {
    const snapshot = structuredClone(Object.fromEntries(collections.map((name) => [name, state[name]])));
    const writes = state.writes.length;
    state.transactions += 1;
    try {
      return await fn(models);
    } catch (err) {
      // A failed transaction leaves nothing behind.
      Object.assign(state, snapshot);
      state.writes.length = writes;
      throw err;
    }
  };
  return { state, models };
}

type World = ReturnType<typeof makeWorld>;
type Svc = typeof import("../services/orchestration.js");

async function withWorld<T>(world: World, body: (svc: Svc) => Promise<T>): Promise<T> {
  const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Row };
  const svc = await import("../services/orchestration.js");
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

/** The refusal of a call, or null when it went through. */
async function refusalOf(world: World, run: (svc: Svc) => Promise<unknown>) {
  const { WorkflowError } = await import("../services/workflowErrors.js");
  return withWorld(world, async (svc) => {
    try {
      await run(svc);
      return null;
    } catch (err) {
      assert.ok(err instanceof WorkflowError, String(err));
      return { status: err.status, code: err.code, message: err.message };
    }
  });
}

const definition = (over: Row = {}) => ({
  name: "Digest",
  executionMode: "sequential" as const,
  steps: [{ name: "a", agentId: AGENT_ID }],
  ...over,
});
const EMPTY = definition({ steps: [] });
/** A definition the editor accepts and a sale does not: an hour's time limit. */
const TOO_LONG = definition({ timeout: 3_600_000 });

const disable = (svc: Svc) => svc.updateOrchestration(WORKFLOW_ID, ORG, { isEnabled: false }, NOW);
const replace = (def: Row) => (svc: Svc) => svc.replaceOrchestration(WORKFLOW_ID, ORG, def as never, undefined, NOW);
const remove = (svc: Svc) => svc.deleteOrchestration(WORKFLOW_ID, ORG);

const runningPlan = (over: Row = {}) => ({ id: "sub_1", subscriberId: "org_buyer", status: "active", currentPeriodEnd: new Date(NOW.getTime() + 5 * DAY), ...over });

const ON_SALE = "This workflow is on sale. Stop selling it first.";
const ON_PLAN = "People are still on a plan for this workflow. It can be changed once their 30 days end.";

/** Everything a refusal must leave as it was. */
const snapshotOf = (world: World) =>
  structuredClone({
    workflows: world.state.workflows,
    steps: world.state.steps,
    listings: world.state.listings,
    plans: world.state.plans,
    subs: world.state.subs,
    runs: world.state.runs,
  });

async function assertRefusedUntouched(world: World, run: (svc: Svc) => Promise<unknown>, code: string, message: string) {
  const before = snapshotOf(world);
  const refusal = await refusalOf(world, run);
  assert.deepEqual(refusal, { status: 409, code, message });
  assert.deepEqual(snapshotOf(world), before);
  // No write at all: no run was cancelled or asked to stop.
  assert.deepEqual(world.state.writes, []);
}

// ============================================
// While its listing is published
// ============================================

test("a workflow whose listing is published is not disabled, and nothing of the patch is saved", async () => {
  const world = makeWorld({ listing: {} });
  await assertRefusedUntouched(
    world,
    (svc) => svc.updateOrchestration(WORKFLOW_ID, ORG, { isEnabled: false, name: "Renamed" }, NOW),
    "workflow_on_sale",
    ON_SALE,
  );
  assert.equal(world.state.workflows[0]!.name, "Digest");
});

test("a change that would leave a published workflow unsellable is refused with what would be wrong", async () => {
  const cases: Array<[Row, string]> = [
    [
      TOO_LONG,
      "A workflow on sale must finish within 10 minutes. Set its time limit to 10 minutes or less.",
    ],
    [
      definition({ timeout: 600_001 }),
      "A workflow on sale must finish within 10 minutes. Set its time limit to 10 minutes or less.",
    ],
    [
      definition({ steps: [{ name: "a", agentId: COPY_AGENT_ID }] }),
      "This workflow uses an agent installed from the marketplace. A workflow can be sold only when every agent in it is one you built.",
    ],
  ];
  for (const [def, problem] of cases) {
    const world = makeWorld({ listing: {} });
    await assertRefusedUntouched(
      world,
      replace(def),
      "workflow_on_sale",
      `This workflow is on sale, so this change cannot be saved. ${problem}`,
    );
    assert.equal(world.state.transactions, 0);
  }
});

test("an edit that keeps a listed workflow sellable is saved", async () => {
  const world = makeWorld({ listing: {} });
  const refusal = await refusalOf(
    world,
    replace(definition({ timeout: 300_000, steps: [{ name: "a", agentId: AGENT_ID }, { name: "b", agentId: AGENT_ID }] })),
  );
  assert.equal(refusal, null);
  assert.equal(world.state.workflows[0]!.timeout, 300_000);
  assert.deepEqual(world.state.steps.map((s) => s.name), ["a", "b"]);

  // A rename, a description and an enable are no change of what is sold.
  const meta = makeWorld({ listing: {} });
  assert.equal(await refusalOf(meta, (svc) => svc.updateOrchestration(WORKFLOW_ID, ORG, { name: "Renamed", isEnabled: true }, NOW)), null);
  assert.equal(meta.state.workflows[0]!.name, "Renamed");
});

// ============================================
// While somebody is still on a plan
// ============================================

test("a workflow cannot be tooLong of its steps at all: the definition's own rule says so first, listed or not", async () => {
  for (const listing of [undefined, {}, { status: "archived" }]) {
    const world = makeWorld({ listing, subs: listing ? [runningPlan()] : [] });
    const before = snapshotOf(world);
    const refusal = await refusalOf(world, replace(EMPTY));
    assert.deepEqual([refusal!.status, refusal!.code], [400, "invalid_workflow"]);
    assert.deepEqual(snapshotOf(world), before);
    assert.deepEqual(world.state.writes, []);
  }
});

test("a stopped listing with one running plan refuses a disable and a change that would leave it unsellable, with the plan sentence", async () => {
  for (const status of ["archived", "draft"]) {
    const disabled = makeWorld({ listing: { status }, subs: [runningPlan()] });
    await assertRefusedUntouched(disabled, disable, "workflow_on_sale", ON_PLAN);
    const tooLong = makeWorld({ listing: { status }, subs: [runningPlan()] });
    await assertRefusedUntouched(tooLong, replace(TOO_LONG), "workflow_on_sale", ON_PLAN);
  }
  // An edit that keeps it sellable is still saved.
  const kept = makeWorld({ listing: { status: "archived" }, subs: [runningPlan()] });
  assert.equal(await refusalOf(kept, replace(definition({ timeout: 120_000 }))), null);
  assert.equal(kept.state.workflows[0]!.timeout, 120_000);
});

test("with no plan, or with one whose period has ended or that is no longer active, both are saved", async () => {
  const over = [
    [],
    [runningPlan({ currentPeriodEnd: new Date(NOW.getTime() - 1) })],
    // The end of the period is the moment itself: the 30 days are over.
    [runningPlan({ currentPeriodEnd: new Date(NOW.getTime()) })],
    [runningPlan({ status: "cancelled" })],
    [runningPlan({ status: "past_due" })],
    // Somebody's plan on another listing holds nothing here.
    [runningPlan({ listingId: "another_listing" })],
  ];
  for (const subs of over) {
    const disabled = makeWorld({ listing: { status: "archived" }, subs });
    assert.equal(await refusalOf(disabled, disable), null, JSON.stringify(subs));
    assert.equal(disabled.state.workflows[0]!.isEnabled, false);
    const tooLong = makeWorld({ listing: { status: "archived" }, subs });
    assert.equal(await refusalOf(tooLong, replace(TOO_LONG)), null);
    assert.equal(tooLong.state.workflows[0]!.timeout, 3_600_000);
  }
});

test("the hold is read at the moment given: a plan that runs today holds, and stops holding once its period ends", async () => {
  const subs = [runningPlan()];
  const today = makeWorld({ listing: { status: "archived" }, subs });
  assert.equal((await refusalOf(today, disable))!.message, ON_PLAN);
  const later = makeWorld({ listing: { status: "archived" }, subs });
  const afterItEnds = new Date(NOW.getTime() + 6 * DAY);
  assert.equal(await refusalOf(later, (svc) => svc.updateOrchestration(WORKFLOW_ID, ORG, { isEnabled: false }, afterItEnds)), null);
});

// ============================================
// A workflow that is not listed
// ============================================

test("a workflow that is not listed can be disabled and changed as before", async () => {
  const disabled = makeWorld();
  assert.equal(await refusalOf(disabled, disable), null);
  assert.equal(disabled.state.workflows[0]!.isEnabled, false);
  const long = makeWorld();
  assert.equal(await refusalOf(long, replace(TOO_LONG)), null);
  assert.equal(long.state.workflows[0]!.timeout, 3_600_000);
  // An agent installed from the marketplace is the owner's to use in a workflow that is not sold.
  const copy = makeWorld();
  assert.equal(await refusalOf(copy, replace(definition({ steps: [{ name: "a", agentId: COPY_AGENT_ID }] }))), null);
  assert.equal(copy.state.steps[0]!.agentId, COPY_AGENT_ID);
});

test("another organization's listing or workflow is never what holds a change", async () => {
  // A listing row that names the workflow under another publisher is not this organization's.
  const world = makeWorld({ listing: { publisherId: "org_other" } });
  assert.equal(await refusalOf(world, disable), null);
  // And somebody else's workflow is simply not found.
  const theirs = makeWorld({ listing: {} });
  const refusal = await refusalOf(theirs, (svc) => svc.updateOrchestration(WORKFLOW_ID, "org_other", { isEnabled: false }, NOW));
  assert.deepEqual([refusal!.status, refusal!.code], [404, "not_found"]);
  assert.deepEqual(theirs.state.writes, []);
});

// ============================================
// Deleting
// ============================================

test("a workflow on sale is not deleted, and no run is cancelled or asked to stop", async () => {
  const world = makeWorld({ listing: {}, plans: [{ id: "plan_1" }] });
  await assertRefusedUntouched(world, remove, "workflow_on_sale", ON_SALE);
  // The listing was read before anything was done to a run.
  assert.deepEqual(world.state.order, ["listing.findFirst"]);
});

test("a workflow people have paid for is not deleted once its listing is stopped", async () => {
  const sentence =
    "People have paid for this workflow, so it cannot be deleted. Stop selling it instead: it leaves the marketplace, and buyers on a plan keep it until the 30 days they paid for end.";
  const cases: Array<Parameters<typeof makeWorld>[0]> = [
    { installs: [{ id: "ins_1", buyerId: "org_buyer", status: "active" }] },
    // Anyone who EVER started: an uninstalled licence and an ended plan count.
    { installs: [{ id: "ins_1", buyerId: "org_buyer", status: "uninstalled" }] },
    { subs: [runningPlan({ status: "cancelled", currentPeriodEnd: new Date(0) })] },
  ];
  for (const opts of cases) {
    for (const status of ["archived", "draft"]) {
      const world = makeWorld({ listing: { status }, plans: [{ id: "plan_1" }], ...opts });
      await assertRefusedUntouched(world, remove, "workflow_has_buyers", sentence);
      assert.deepEqual(world.state.order, ["listing.findFirst"]);
      assert.equal(world.state.transactions, 0);
    }
  }
});

test("a workflow with a draft or stopped listing and no buyer is deleted with it and its plans, in one transaction", async () => {
  for (const status of ["draft", "archived"]) {
    const world = makeWorld({ listing: { status }, plans: [{ id: "plan_1" }, { id: "plan_2", status: "retired" }] });
    assert.equal(await refusalOf(world, remove), null);
    assert.deepEqual(world.state.workflows, []);
    assert.deepEqual(world.state.listings, []);
    assert.deepEqual(world.state.plans, []);
    assert.equal(world.state.transactions, 1);
    // The plans first, then the listing, then the runs and the workflow.
    assert.deepEqual(world.state.writes, [
      "listingPlan.deleteMany",
      "listing.deleteMany",
      "run.cancelled",
      "run.cancelRequested",
      "orchestration.deleteMany",
    ]);
  }
});

test("a listing that is published or started on while the delete is in flight stays, and so does everything else", async () => {
  const published = makeWorld({ listing: { status: "draft" }, plans: [{ id: "plan_1" }] });
  published.state.beforeDeleteInTransaction = () => {
    published.state.listings[0]!.status = "published";
  };
  const before = snapshotOf(published);
  assert.deepEqual(await refusalOf(published, remove), { status: 409, code: "workflow_on_sale", message: ON_SALE });
  // Nothing of the transaction stayed: the plans it had removed are back, and no run was touched.
  assert.deepEqual(snapshotOf(published), before);
  assert.deepEqual(published.state.writes, []);

  const started = makeWorld({ listing: { status: "archived" }, plans: [{ id: "plan_1" }] });
  // A buyer's licence that was written between the first read and the transaction.
  const realFindFirst = started.models.agentListing.findFirst;
  started.models.agentListing.findFirst = async (args: Row) => {
    const row = await realFindFirst(args);
    started.state.installs.push({ id: "ins_late", listingId: LISTING_ID, buyerId: "org_buyer", status: "active" });
    return row;
  };
  const refusal = await refusalOf(started, remove);
  assert.deepEqual([refusal!.status, refusal!.code], [409, "workflow_has_buyers"]);
  assert.equal(started.state.workflows.length, 1);
  assert.equal(started.state.listings.length, 1);
  assert.equal(started.state.plans.length, 1);
  assert.deepEqual(started.state.writes, []);
});

test("a workflow with no listing is deleted exactly as before", async () => {
  const world = makeWorld();
  assert.deepEqual(await withWorld(world, remove), { success: true });
  assert.deepEqual(world.state.workflows, []);
  assert.deepEqual(world.state.writes, ["run.cancelled", "run.cancelRequested", "orchestration.deleteMany"]);
  assert.equal(world.state.transactions, 0);
  assert.deepEqual(
    world.state.runs.map((r) => [r.id, r.status, r.cancelRequestedAt instanceof Date]),
    [
      ["run_queued", "cancelled", false],
      ["run_running", "running", true],
    ],
  );
});
