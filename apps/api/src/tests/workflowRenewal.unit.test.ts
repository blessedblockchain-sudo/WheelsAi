import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

import { buildSubscriptionRenewalTickDeps } from "../services/buildSubscriptionRenewalTickDeps.js";
import { readWorkflowCanRunNow, type WorkflowListingDb } from "../services/buildWorkflowListingDeps.js";
import { runSubscriptionRenewalTick } from "../services/runSubscriptionRenewalTick.js";
import { PAST_DUE_GRACE_DAYS } from "../services/subscriptionAccess.js";
import { earningsStandIn, type EarningsRow } from "./earningsStandIn.js";

// A plan on a workflow is not renewed while the workflow cannot run. Through
// the real tick, the real binding and the real renewSubscription, over an
// in-memory database. What these pin: a due plan of a workflow's listing is
// left exactly as a paused agent's row is left (not claimed, not charged,
// nobody credited, not marked past due) for as long as the workflow cannot
// run or cannot be read, and is charged once at the first tick at which it
// can, unless the days of grace are over by then, when it ends uncharged;
// the question is asked once for a listing in a page of rows, of the
// publisher's organization; and an agent's row is handed its column as before.

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-01T00:00:00Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

const PUBLISHER = "org_pub";
const WORKFLOW_ID = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const STEP_AGENT_ID = "33333333-3333-4333-8333-333333333333";

type Row = Record<string, any>;

const WORKFLOW_LISTING: Row = {
  id: "lst_flow",
  title: "Weekly Digest",
  publisherId: PUBLISHER,
  monthlyPriceCents: null,
  pricingModel: "per_request",
  status: "published",
  sells: "use",
  pausedSince: null,
  agentId: null,
  orchestrationId: WORKFLOW_ID,
};

const AGENT_LISTING: Row = {
  id: "lst_agent",
  title: "Research Analyst",
  publisherId: PUBLISHER,
  monthlyPriceCents: null,
  pricingModel: "per_request",
  status: "published",
  sells: "use",
  pausedSince: null,
  agentId: "agent_src",
  orchestrationId: null,
};

/** A plan row whose 30 days ended at day 30. */
const planSub = (id: string, listingId: string, subscriberId: string, over: Row = {}): Row => ({
  id,
  listingId,
  subscriberId,
  status: "active",
  currentPeriodStart: at(0),
  currentPeriodEnd: at(30),
  cancelAtPeriodEnd: false,
  cancelledAt: null,
  endReason: null,
  priceCents: 900n,
  planId: "plan_starter",
  includedUses: 500,
  extraUsePriceCents: 5n,
  usedInPeriod: 40,
  carriedUses: 0,
  warnedLevel: 0,
  lastRenewalAttemptAt: null,
  /** The status of the plan the row names, as its creator left it. */
  planStatus: "active",
  ...over,
});

function makeWorld(opts: {
  listings?: Row[];
  subs: Row[];
  /** The status of the deployment the workflow's model step runs on. */
  deployment?: string;
  balances?: Record<string, bigint>;
}) {
  const state = {
    listings: (opts.listings ?? [WORKFLOW_LISTING, AGENT_LISTING]).map((l) => ({ ...l })) as Row[],
    subs: opts.subs.map((s) => ({ ...s })) as Row[],
    installs: opts.subs.map((s) => ({ listingId: s.listingId, buyerId: s.subscriberId, kind: "use", status: "active" })) as Row[],
    deployments: [{ id: DEPLOYMENT_ID, orgId: PUBLISHER, status: opts.deployment ?? "running" }] as Row[],
    balances: new Map(Object.entries(opts.balances ?? { org_buyer: 10_000n, org_buyer_2: 10_000n })),
    ledger: [] as Row[],
    revenue: [] as Row[],
    accrued: 0n,
    earnings: [] as EarningsRow[],
    /** Every read of a workflow: the where it was made with. */
    workflowReads: [] as Row[],
    /** Every read of a listing's contributors. */
    contributorReads: 0,
    /** The read of the workflow throws. */
    readFails: false,
  };
  let seq = 0;
  const listingOf = (id: string) => state.listings.find((l) => l.id === id)!;

  function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([k, cond]) => {
      // The two relation filters of a renewal's claim, read as the database holds them now.
      if (k === "listing") return matches(listingOf(row.listingId), cond);
      if (k === "plan") return cond.status === "active";
      const v = row[k];
      if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
      if (cond && typeof cond === "object") {
        if ("in" in cond) return cond.in.includes(v);
        if ("notIn" in cond) return !cond.notIn.includes(v);
        if ("lte" in cond) return v <= cond.lte;
        if ("gte" in cond) return v >= cond.gte;
      }
      return v === cond;
    });
  }

  const earnings = earningsStandIn({
    pending: () => state.accrued,
    add: (_orgId, pending) => {
      state.accrued += pending;
    },
    write: (row) => state.earnings.push(row),
  });

  const models: Row = {
    agentSubscription: {
      findMany: async ({ where, take }: Row) =>
        state.subs
          .filter((s) => matches(s, where))
          .slice(0, take)
          .map((s) => ({ ...s, listing: { ...listingOf(s.listingId) }, plan: { status: s.planStatus ?? "active" } })),
      updateMany: async ({ where, data }: Row) => {
        const hit = state.subs.filter((s) => matches(s, where));
        for (const s of hit) Object.assign(s, data);
        return { count: hit.length };
      },
    },
    agentInstall: {
      findMany: async ({ where }: Row) =>
        state.installs.filter((i) => where.OR.some((w: Row) => matches(i, w))).map((i) => ({ ...i })),
      updateMany: async ({ where, data }: Row) => {
        const hit = state.installs.filter((i) => matches(i, where));
        for (const i of hit) Object.assign(i, data);
        return { count: hit.length };
      },
    },
    agentListing: {
      findUnique: async ({ where }: Row) => ({ agentId: listingOf(where.id).agentId }),
    },
    // An agent's contributors: none here, and never asked for a workflow.
    agentContributor: {
      findMany: async () => {
        state.contributorReads += 1;
        return [];
      },
    },
    organization: { findUnique: async () => null },
    contributorEarning: { create: async () => ({}) },
    creditBalance: {
      updateMany: async ({ where, data }: Row) => {
        const balance = state.balances.get(where.orgId) ?? 0n;
        if (balance < where.balanceCents.gte) return { count: 0 };
        state.balances.set(where.orgId, balance - data.balanceCents.decrement);
        return { count: 1 };
      },
      findUnique: async ({ where }: Row) => ({ balanceCents: state.balances.get(where.orgId) ?? 0n }),
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
    publisherProfile: earnings.publisherProfile,
    earningsTransaction: earnings.earningsTransaction,
    // The workflow behind the listing, as the question of whether it can run reads it.
    orchestration: {
      findFirst: async ({ where }: Row) => {
        state.workflowReads.push({ ...where });
        if (state.readFails) throw new Error("connection reset");
        if (where.id !== WORKFLOW_ID || where.orgId !== PUBLISHER) return null;
        return {
          id: WORKFLOW_ID,
          orgId: PUBLISHER,
          isEnabled: true,
          timeout: 600_000,
          inputSchema: {},
          steps: [
            { stepType: "agent", agentId: STEP_AGENT_ID, fallbackAgentId: null, deploymentId: null },
            { stepType: "model", agentId: null, fallbackAgentId: null, deploymentId: DEPLOYMENT_ID },
          ],
        };
      },
    },
    agent: { findMany: async () => [{ id: STEP_AGENT_ID, modelConfig: {} }] },
    deployment: {
      findMany: async ({ where }: Row) => state.deployments.filter((d) => matches(d, where)).map((d) => ({ id: d.id })),
    },
  };
  // A failed transaction leaves nothing behind.
  models.$transaction = async (fn: (tx: Row) => Promise<unknown>) => {
    const snapshot = structuredClone({
      subs: state.subs,
      installs: state.installs,
      balances: state.balances,
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
  };

  /** One tick at `now`: the real binding, with the real question asked of this world's rows. */
  const tick = (now: Date) =>
    runSubscriptionRenewalTick({
      ...buildSubscriptionRenewalTickDeps(models as never, {
        workflowCanRunNow: (ref) =>
          readWorkflowCanRunNow(ref, {
            db: models as unknown as WorkflowListingDb,
            anyMarketplaceCopy: async () => false,
            logger: { warn: () => {} },
          }),
      }),
      // The pause markers of agents' listings are another test's.
      reconcilePauses: async () => {},
      now: () => now,
    });
  const loadDue = (now: Date) =>
    buildSubscriptionRenewalTickDeps(models as never, {
      workflowCanRunNow: (ref) =>
        readWorkflowCanRunNow(ref, {
          db: models as unknown as WorkflowListingDb,
          anyMarketplaceCopy: async () => false,
          logger: { warn: () => {} },
        }),
    }).loadDue({ now, limit: 10, excludeIds: [] });
  return { state, tick, loadDue };
}

const counts = (r: Row) => [r.scanned, r.renewed, r.cancelled, r.paused, r.pastDue, r.expired, r.errors];

test("a due plan on a workflow whose step deployment is stopped is not charged, not marked past due, and counted as paused", async () => {
  // A buyer with no credits at all: were the row tried, it would be marked past due.
  const world = makeWorld({
    subs: [planSub("sub_1", "lst_flow", "org_buyer")],
    deployment: "stopped",
    balances: { org_buyer: 0n },
  });
  const result = await world.tick(at(31));
  assert.deepEqual(counts(result), [1, 0, 0, 1, 0, 0, 0]);

  const sub = world.state.subs[0]!;
  // Not claimed: the period, the count and the status are what they were.
  assert.deepEqual(
    [sub.status, sub.currentPeriodStart.getTime(), sub.currentPeriodEnd.getTime(), sub.usedInPeriod, sub.endReason],
    ["active", at(0).getTime(), at(30).getTime(), 40, null],
  );
  assert.deepEqual([world.state.ledger.length, world.state.revenue.length, world.state.accrued], [0, 0, 0n]);
  assert.equal(world.state.installs[0]!.status, "active");
  // Still due: it goes behind the rows that have not had their turn.
  assert.equal(sub.lastRenewalAttemptAt.getTime(), at(31).getTime());
});

test("the same row is charged once, with 90% to the publisher, at the first tick after the workflow runs again", async () => {
  const world = makeWorld({ subs: [planSub("sub_1", "lst_flow", "org_buyer")], deployment: "stopped" });
  assert.deepEqual(counts(await world.tick(at(31))), [1, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(counts(await world.tick(at(31.5))), [1, 0, 0, 1, 0, 0, 0]);
  assert.equal(world.state.balances.get("org_buyer"), 10_000n);

  // The creator deploys the model again.
  world.state.deployments[0]!.status = "running";
  assert.deepEqual(counts(await world.tick(at(32))), [1, 1, 0, 0, 0, 0, 0]);
  assert.equal(world.state.balances.get("org_buyer"), 9_100n);
  assert.deepEqual(
    world.state.revenue.map((row) => [row.type, row.grossAmountCents, row.creatorAmountCents, row.platformFeeCents, row.publisherId]),
    [["subscription_renewal", 900n, 810n, 90n, PUBLISHER]],
  );
  assert.deepEqual(world.state.earnings.map((row) => [row.orgId, row.amountCents]), [[PUBLISHER, 810n]]);
  // A workflow has no contributors: nobody's were asked for.
  assert.equal(world.state.contributorReads, 0);

  // No time is added to the period: it runs on from where it ended, with a fresh count.
  const sub = world.state.subs[0]!;
  assert.deepEqual(
    [sub.status, sub.currentPeriodStart.getTime(), sub.currentPeriodEnd.getTime(), sub.usedInPeriod],
    ["active", at(30).getTime(), at(60).getTime(), 0],
  );
  // Once: the next tick finds nothing due.
  assert.deepEqual(counts(await world.tick(at(33))), [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(world.state.balances.get("org_buyer"), 9_100n);
});

// The days of grace run from the end of the period that was paid for, and a
// workflow that cannot run does not stop them. A plan that comes due waits
// for those days and no longer: found at or past their end it is not
// renewed (that would charge for 30 days that began days ago) and it does
// not wait either, whether the workflow runs again by then or never does.
// So a row cannot stay active and due for good behind a workflow that is gone.
for (const [name, lastDay, runsAgain] of [
  ["the workflow runs again at the moment the days of grace end", 30 + PAST_DUE_GRACE_DAYS, true],
  ["the workflow runs again a day past the days of grace", 30 + PAST_DUE_GRACE_DAYS + 1, true],
  ["the workflow still cannot run when the days of grace end", 30 + PAST_DUE_GRACE_DAYS, false],
] as const) {
  test(`a plan on a workflow that could not run for the days of grace ends uncharged: ${name}`, async () => {
    const world = makeWorld({ subs: [planSub("sub_1", "lst_flow", "org_buyer")], deployment: "stopped" });
    // Stopped from the end of the period: inside the days of grace every tick leaves the row as it is.
    for (const day of [30, 31, 30 + PAST_DUE_GRACE_DAYS - 0.5]) {
      assert.deepEqual(counts(await world.tick(at(day))), [1, 0, 0, 1, 0, 0, 0], `day ${day}`);
    }
    assert.deepEqual([world.state.subs[0]!.status, world.state.installs[0]!.status], ["active", "active"]);

    if (runsAgain) world.state.deployments[0]!.status = "running";
    const askedBefore = world.state.workflowReads.length;
    // The first tick at or past the end of the days of grace: expired, not paused and not renewed.
    assert.deepEqual(counts(await world.tick(at(lastDay))), [1, 0, 0, 0, 0, 1, 0]);
    // A row that can no longer be charged is not worth a read of the workflow.
    assert.equal(world.state.workflowReads.length, askedBefore);

    // Not charged, and nobody credited: the buyer could have paid.
    assert.equal(world.state.balances.get("org_buyer"), 10_000n);
    assert.deepEqual(
      [world.state.ledger.length, world.state.revenue.length, world.state.accrued, world.state.earnings.length],
      [0, 0, 0n, 0],
    );
    // Ended as a plan found past its days of grace ends: expired, with no
    // reason written and no cancel date, its period and its count as they
    // were, and the licence suspended.
    const sub = world.state.subs[0]!;
    assert.deepEqual(
      [sub.status, sub.endReason, sub.cancelledAt, sub.currentPeriodStart.getTime(), sub.currentPeriodEnd.getTime(), sub.usedInPeriod],
      ["expired", null, null, at(0).getTime(), at(30).getTime(), 40],
    );
    assert.equal(world.state.installs[0]!.status, "suspended");

    // For good: the next tick finds nothing due, whatever the workflow can do.
    assert.deepEqual(counts(await world.tick(at(lastDay + 1))), [0, 0, 0, 0, 0, 0, 0]);
    assert.equal(world.state.balances.get("org_buyer"), 10_000n);
  });
}

test("a read of the workflow that throws charges nobody", async () => {
  const world = makeWorld({ subs: [planSub("sub_1", "lst_flow", "org_buyer")] });
  world.state.readFails = true;
  assert.deepEqual(counts(await world.tick(at(31))), [1, 0, 0, 1, 0, 0, 0]);
  assert.equal(world.state.balances.get("org_buyer"), 10_000n);
  assert.deepEqual([world.state.revenue.length, world.state.accrued], [0, 0n]);
  assert.equal(world.state.subs[0]!.status, "active");

  // The read works again: charged then.
  world.state.readFails = false;
  assert.deepEqual(counts(await world.tick(at(32))), [1, 1, 0, 0, 0, 0, 0]);
  assert.equal(world.state.balances.get("org_buyer"), 9_100n);
});

test("the workflow is asked about once for two due rows of one listing, by its id and the listing's publisher", async () => {
  const world = makeWorld({
    subs: [planSub("sub_1", "lst_flow", "org_buyer"), planSub("sub_2", "lst_flow", "org_buyer_2")],
  });
  assert.deepEqual(counts(await world.tick(at(31))), [2, 2, 0, 0, 0, 0, 0]);
  // The second read of the tick is the next page, which is empty: nothing is asked for it.
  assert.deepEqual(world.state.workflowReads, [{ id: WORKFLOW_ID, orgId: PUBLISHER }]);
  assert.deepEqual([world.state.balances.get("org_buyer"), world.state.balances.get("org_buyer_2")], [9_100n, 9_100n]);
  assert.equal(world.state.accrued, 1_620n);
});

test("a workflow's row is never handed the column: a date when it cannot run, null when it can", async () => {
  const cannot = makeWorld({ subs: [planSub("sub_1", "lst_flow", "org_buyer")], deployment: "stopped" });
  const held = await cannot.loadDue(at(31));
  assert.equal(held[0]!.listing.pausedSince?.getTime(), at(31).getTime());

  // A marker left on the row by mistake says nothing about a workflow that can run.
  const stray = makeWorld({
    listings: [{ ...WORKFLOW_LISTING, pausedSince: at(3) }],
    subs: [planSub("sub_1", "lst_flow", "org_buyer")],
  });
  assert.equal((await stray.loadDue(at(31)))[0]!.listing.pausedSince, null);

  // A listing with no agent that names no workflow has nothing that can run.
  const nameless = makeWorld({
    listings: [{ ...WORKFLOW_LISTING, orchestrationId: null }],
    subs: [planSub("sub_1", "lst_flow", "org_buyer")],
  });
  assert.equal((await nameless.loadDue(at(31)))[0]!.listing.pausedSince?.getTime(), at(31).getTime());
  assert.deepEqual(nameless.state.workflowReads, []);
});

// A row that is only closed is not held back by a workflow that cannot run:
// nothing ends "cannot run" for a workflow its creator stopped selling, and
// the row would stay active and due for good.
for (const [name, listing, sub, endReason, licence] of [
  ["its listing is no longer published", { status: "archived" }, {}, "use_ended", "active"],
  ["its listing no longer sells use", { sells: "copies" }, {}, "use_ended", "active"],
  ["the buyer cancelled", {}, { cancelAtPeriodEnd: true }, null, "suspended"],
  ["its creator ended the plan", {}, { planStatus: "retired" }, "plan_ended", "active"],
] as const) {
  test(`a due plan on a workflow that cannot run is closed and not charged when ${name}`, async () => {
    const world = makeWorld({
      listings: [{ ...WORKFLOW_LISTING, ...listing }],
      subs: [planSub("sub_1", "lst_flow", "org_buyer", sub)],
      deployment: "stopped",
    });
    world.state.readFails = true;
    assert.deepEqual(counts(await world.tick(at(31))), [1, 0, 1, 0, 0, 0, 0]);

    const row = world.state.subs[0]!;
    assert.deepEqual([row.status, row.endReason, row.cancelledAt.getTime()], ["cancelled", endReason, at(31).getTime()]);
    assert.equal(world.state.installs[0]!.status, licence);
    assert.equal(world.state.balances.get("org_buyer"), 10_000n);
    assert.deepEqual([world.state.ledger.length, world.state.revenue.length, world.state.accrued], [0, 0, 0n]);
    // Nothing of the workflow decides it, so nothing of it was read.
    assert.deepEqual(world.state.workflowReads, []);
    // Closed for good: the next tick finds nothing due.
    assert.deepEqual(counts(await world.tick(at(32))), [0, 0, 0, 0, 0, 0, 0]);
  });
}

test("a row that is closed and a row that waits, on one workflow that cannot run, each get their own outcome", async () => {
  const world = makeWorld({
    subs: [
      planSub("sub_1", "lst_flow", "org_buyer", { cancelAtPeriodEnd: true }),
      planSub("sub_2", "lst_flow", "org_buyer_2"),
    ],
    deployment: "stopped",
  });
  assert.deepEqual(counts(await world.tick(at(31))), [2, 0, 1, 1, 0, 0, 0]);
  assert.deepEqual(world.state.subs.map((s) => s.status), ["cancelled", "active"]);
  assert.deepEqual([world.state.balances.get("org_buyer"), world.state.balances.get("org_buyer_2")], [10_000n, 10_000n]);
  // Asked once, for the row that could be charged.
  assert.deepEqual(world.state.workflowReads, [{ id: WORKFLOW_ID, orgId: PUBLISHER }]);
});

test("a due row of an agent's listing that the buyer cancelled still waits while the listing is paused", async () => {
  const world = makeWorld({
    listings: [{ ...AGENT_LISTING, pausedSince: at(29) }],
    subs: [planSub("sub_1", "lst_agent", "org_buyer", { cancelAtPeriodEnd: true })],
  });
  assert.deepEqual(counts(await world.tick(at(31))), [1, 0, 0, 1, 0, 0, 0]);
  assert.equal(world.state.subs[0]!.status, "active");
});

test("a due row of an agent's listing, paused and not paused, is what it was", async () => {
  // Paused: the marker is the column, and the row waits.
  const paused = makeWorld({
    listings: [{ ...AGENT_LISTING, pausedSince: at(29) }],
    subs: [planSub("sub_1", "lst_agent", "org_buyer")],
  });
  assert.equal((await paused.loadDue(at(31)))[0]!.listing.pausedSince?.getTime(), at(29).getTime());
  assert.deepEqual(counts(await paused.tick(at(31))), [1, 0, 0, 1, 0, 0, 0]);
  assert.equal(paused.state.balances.get("org_buyer"), 10_000n);

  // Not paused: renewed and charged, with its contributors asked for.
  const running = makeWorld({ subs: [planSub("sub_1", "lst_agent", "org_buyer")], deployment: "stopped" });
  assert.equal((await running.loadDue(at(31)))[0]!.listing.pausedSince, null);
  assert.deepEqual(counts(await running.tick(at(31))), [1, 1, 0, 0, 0, 0, 0]);
  assert.equal(running.state.balances.get("org_buyer"), 9_100n);
  assert.deepEqual(running.state.earnings.map((row) => [row.orgId, row.amountCents]), [[PUBLISHER, 810n]]);
  assert.equal(running.state.contributorReads, 1);

  // Nothing of a workflow was read for either.
  assert.deepEqual([paused.state.workflowReads, running.state.workflowReads], [[], []]);
});
