import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

import { TRIAL_DAYS } from "../services/listingPlans.js";
import {
  CREDITS_ADDED_LEDGER_TYPES,
  hasAddedCredits,
  judgeTrial,
  startTrial,
  TRIAL_START_MESSAGES,
  trialUsed,
  type TrialStartDeps,
} from "../services/trialStart.js";
import { useAccess } from "../services/useAccess.js";

import {
  BUYER,
  DAY,
  LISTING_ID,
  makeWorld,
  matches,
  noMoney,
  OLD_TRIAL_ID,
  ON_OFFER,
  OTHER_LISTING_ID,
  PER_USE,
  STARTER,
  STARTER_ID,
  THEIR_TRIAL_ID,
  TRIAL,
  TRIAL_ID,
  untouched,
  use,
  withApp,
  type Row,
} from "./trialWorld.js";

// Starting a listing's free trial: POST /api/marketplace/listings/:id/use with
// the trial as `plan`, through the route and the real services against an
// in-memory database, and the rules of who may (services/trialStart.ts) by
// themselves. What these pin: a start moves no money at all (no revenue row,
// no credit transaction, no earnings, the balance where it was); the buyer's
// row holds the trial's uses, 7 days, no renewal and the day it was started;
// one organization starts one trial per listing, ever, whatever happened to
// the row since; an organization that never added credits is refused in a
// sentence; and every refusal writes nothing.

// ============================================
// A start
// ============================================

test("starting a free trial moves no money: no revenue row, no credit transaction, no earnings, and the balance stays where it was", async () => {
  const world = makeWorld({ balance: 37n });
  const res = await use(world, { plan: TRIAL });
  assert.equal(res.status, 201);
  noMoney(world, 37n);
  // The buyer is on it at once.
  assert.equal(res.body.access, "subscribed");
  assert.equal(res.body.subscription.priceCents, 0);
  assert.equal(res.body.subscription.hasAccess, true);
  assert.equal("created" in res.body, false);
});

test("the buyer's row holds the trial's terms, 7 days, no renewal and the moment it was started", async () => {
  const world = makeWorld();
  const before = Date.now();
  const res = await use(world, { plan: TRIAL });
  assert.equal(res.status, 201);

  const sub = world.state.subs[0]!;
  assert.deepEqual(
    [sub.status, sub.planId, sub.priceCents, sub.includedUses, sub.extraUsePriceCents, sub.usedInPeriod, sub.carriedUses, sub.warnedLevel],
    ["active", TRIAL_ID, 0n, 20, null, 0, 0, 0],
  );
  // Never renewed, never charged, no days of grace: the code that exists reads this flag.
  assert.equal(sub.cancelAtPeriodEnd, true);
  assert.equal(sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime(), 7 * DAY);
  assert.equal(TRIAL_DAYS, 7);
  assert.ok(sub.currentPeriodStart.getTime() >= before);
  assert.ok(sub.trialUsedAt instanceof Date);
  assert.equal(sub.trialUsedAt.getTime(), sub.currentPeriodStart.getTime());
  assert.equal(sub.endReason, null);

  // A licence for use, with no copy and no agreement to a price per use.
  const licence = world.state.installs[0]!;
  assert.deepEqual([licence.kind, licence.status, licence.clonedAgentId], ["use", "active", null]);
  assert.deepEqual(
    [licence.acceptedPricingModel, licence.acceptedPricePerRequestCents, licence.pricingAcceptedAt],
    [null, null, null],
  );
  assert.deepEqual(res.body.acceptedPricing, { pricingModel: null, pricePerRequestCents: null, acceptedAt: null });
  assert.deepEqual([world.state.listing.totalInstalls, world.state.listing.activeInstalls], [1, 1]);
});

test("a buyer who pays per use may start the trial, and keeps the price they agreed to", async () => {
  const agreedAt = new Date("2026-10-01T00:00:00Z");
  const world = makeWorld({
    install: { acceptedPricingModel: "per_request", acceptedPricePerRequestCents: 5n, pricingAcceptedAt: agreedAt },
  });
  world.state.listing.totalInstalls = 1;
  world.state.listing.activeInstalls = 1;
  const res = await use(world, { plan: TRIAL });
  assert.equal(res.status, 201);
  noMoney(world);
  const licence = world.state.installs[0]!;
  assert.deepEqual(
    [licence.kind, licence.acceptedPricingModel, licence.acceptedPricePerRequestCents, licence.pricingAcceptedAt],
    ["use", "per_request", 5n, agreedAt],
  );
  // Already counted as a buyer: not counted twice.
  assert.deepEqual([world.state.listing.totalInstalls, world.state.listing.activeInstalls], [1, 1]);
});

test("a buyer who agreed to a price per use and then stopped starts the trial with no agreement: the old price does not come back", async () => {
  const agreedAt = new Date("2026-10-01T00:00:00Z");
  for (const status of ["uninstalled", "suspended"]) {
    const world = makeWorld({
      install: {
        status,
        uninstalledAt: status === "uninstalled" ? new Date("2026-10-05T00:00:00Z") : null,
        acceptedPricingModel: "per_request",
        acceptedPricePerRequestCents: 5n,
        pricingAcceptedAt: agreedAt,
      },
    });
    const res = await use(world, { plan: TRIAL });
    assert.equal(res.status, 201, status);
    noMoney(world);
    const licence = world.state.installs[0]!;
    assert.deepEqual([licence.kind, licence.status], ["use", "active"], status);
    assert.deepEqual(
      [licence.acceptedPricingModel, licence.acceptedPricePerRequestCents, licence.pricingAcceptedAt],
      [null, null, null],
      status,
    );
    assert.deepEqual(res.body.acceptedPricing, { pricingModel: null, pricePerRequestCents: null, acceptedAt: null });

    // When the trial is over they are asked to choose, not charged per use.
    const sub = world.state.subs[0]!;
    const over = useAccess(
      {
        licence: {
          kind: licence.kind,
          status: licence.status,
          accepted: {
            pricingModel: licence.acceptedPricingModel,
            pricePerRequestCents: licence.acceptedPricePerRequestCents,
          },
        },
        listing: { status: "published", sells: "use", pricingModel: "per_request", pricePerRequestCents: 5n },
        sub: { ...sub } as never,
      },
      new Date(sub.currentPeriodEnd.getTime() + 1),
    );
    assert.equal(over, "plan_ended", status);
  }
});

test("an API key granted the spend scope may start a trial; a key without it and a plain member may not", async () => {
  const key = { userId: null, orgId: BUYER, type: "api_key", apiKeyId: "key_1", scopes: ["marketplace:install"] };
  const world = makeWorld();
  assert.equal((await use(world, { plan: TRIAL }, key)).status, 201);

  const refused = makeWorld();
  const scopeless = await use(refused, { plan: TRIAL }, { ...key, scopes: ["agents:use"] });
  assert.deepEqual([scopeless.status, scopeless.body.error], [403, "missing_scope"]);
  const member = await use(refused, { plan: TRIAL }, { userId: "u_member", orgId: BUYER, type: "jwt" });
  assert.deepEqual([member.status, member.body.error], [403, "insufficient_role"]);
  untouched(refused);
});

// ============================================
// Once
// ============================================

const ALREADY_USED = {
  error: "trial_already_used",
  message: "You have already used the free trial of this agent. Choose a plan or pay per use to keep using it.",
};

test("a second start is refused after the trial ended, and the day it was started is still on the row", async () => {
  const startedAt = new Date(Date.now() - 9 * DAY);
  for (const status of ["cancelled", "active"]) {
    // Closed by the renewal, and found past its 7 days before the renewal ran.
    const world = makeWorld({
      install: {},
      sub: {
        status,
        currentPeriodStart: startedAt,
        currentPeriodEnd: new Date(startedAt.getTime() + 7 * DAY),
        cancelAtPeriodEnd: true,
        priceCents: 0n,
        planId: TRIAL_ID,
        includedUses: 20,
        usedInPeriod: 4,
        trialUsedAt: startedAt,
      },
    });
    const before = structuredClone(world.state.subs);
    const res = await use(world, { plan: TRIAL });
    assert.deepEqual([res.status, res.body], [409, ALREADY_USED], status);
    untouched(world, [1, 1]);
    assert.deepEqual(world.state.subs, before);
    assert.equal(world.state.subs[0]!.trialUsedAt.getTime(), startedAt.getTime());
  }
});

test("a second start is refused after the buyer stopped using the agent", async () => {
  const world = makeWorld();
  await withApp(world, async (send) => {
    assert.equal((await send({ plan: TRIAL })).status, 201);
    const startedAt = world.state.subs[0]!.trialUsedAt as Date;
    // What stopping writes (uninstallAgent, services/marketplace.ts): the licence ends now, and the row with it.
    Object.assign(world.state.installs[0]!, { status: "uninstalled", uninstalledAt: new Date() });
    Object.assign(world.state.subs[0]!, { status: "cancelled", cancelledAt: new Date(), cancelAtPeriodEnd: false });

    const res = await send({ plan: TRIAL });
    assert.deepEqual([res.status, res.body], [409, ALREADY_USED]);
    assert.equal(world.state.installs[0]!.status, "uninstalled", "the licence was not started again");
    assert.equal(world.state.subs[0]!.status, "cancelled");
    assert.equal(world.state.subs[0]!.trialUsedAt, startedAt);
  });
  noMoney(world);
});

test("a second start is refused after a paid plan took the row over, and that plan keeps the day the trial was started", async () => {
  const world = makeWorld({ balance: 10_000n });
  await withApp(world, async (send) => {
    assert.equal((await send({ plan: TRIAL })).status, 201);
    const startedAt = world.state.subs[0]!.trialUsedAt as Date;
    assert.equal((await send({ plan: STARTER })).status, 201);
    const sub = world.state.subs[0]!;
    assert.deepEqual([sub.planId, sub.priceCents, sub.includedUses], [STARTER_ID, 900n, 500]);
    assert.equal(sub.trialUsedAt, startedAt);

    const money = [world.state.balance, world.state.ledger.length, world.state.revenue.length];
    const res = await send({ plan: TRIAL });
    assert.deepEqual([res.status, res.body], [409, ALREADY_USED]);
    // The plan they pay for is as it was, and nothing more moved.
    assert.deepEqual([sub.planId, sub.priceCents, sub.includedUses, sub.cancelAtPeriodEnd], [STARTER_ID, 900n, 500, false]);
    assert.deepEqual([world.state.balance, world.state.ledger.length, world.state.revenue.length], money);
  });
});

test("a trial that is running refuses a second start as already used, and the count it has is not set back", async () => {
  const world = makeWorld();
  await withApp(world, async (send) => {
    assert.equal((await send({ plan: TRIAL })).status, 201);
    world.state.subs[0]!.usedInPeriod = 7;
    const end = world.state.subs[0]!.currentPeriodEnd;
    const res = await send({ plan: TRIAL });
    assert.deepEqual([res.status, res.body], [409, ALREADY_USED]);
    assert.deepEqual([world.state.subs[0]!.usedInPeriod, world.state.subs[0]!.currentPeriodEnd], [7, end]);
  });
  noMoney(world);
});

test("a row that was read without the day a trial was started offers no trial", () => {
  assert.equal(trialUsed(null), false);
  assert.equal(trialUsed(undefined), false);
  assert.equal(trialUsed({ trialUsedAt: null }), false);
  assert.equal(trialUsed({ trialUsedAt: new Date(0) }), true);
  // A reader that forgot the column: counted as used.
  assert.equal(trialUsed({}), true);
});

// ============================================
// Credits added at least once
// ============================================

const NEEDS_CREDITS = {
  error: "trial_needs_credits",
  message: "Add credits to your account once to start a free trial. The trial itself costs nothing.",
};

test("an organization that never added credits is refused in a sentence, with nothing written", async () => {
  const world = makeWorld({ credits: [] });
  const res = await use(world, { plan: TRIAL });
  assert.deepEqual([res.status, res.body], [409, NEEDS_CREDITS]);
  untouched(world);
});

test("a bonus for verifying an address, a grant, earnings taken as credits and somebody else's purchase do not count as credits added", async () => {
  const notAdded: Row[][] = [
    [{ orgId: BUYER, type: "bonus", amountCents: 500n }],
    [{ orgId: BUYER, type: "payout_credit", amountCents: 5_000n }],
    [{ orgId: BUYER, type: "refund", amountCents: 900n }],
    // A purchase that was taken back, and a purchase of another organization.
    [{ orgId: BUYER, type: "purchase", amountCents: -1_000n }],
    [{ orgId: "org_somebody_else", type: "purchase", amountCents: 1_000n }],
    [
      { orgId: BUYER, type: "bonus", amountCents: 500n },
      { orgId: BUYER, type: "payout_credit", amountCents: 5_000n },
    ],
  ];
  for (const credits of notAdded) {
    // A balance above zero is not the rule: where the credits came from is.
    const world = makeWorld({ credits, balance: 5_500n });
    const res = await use(world, { plan: TRIAL });
    assert.deepEqual([res.status, res.body], [409, NEEDS_CREDITS], JSON.stringify(credits, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
    noMoney(world, 5_500n);
    assert.equal(world.state.subs.length, 0);
  }
  // One purchase, however small and however long ago, is enough, with a balance of nothing left.
  const once = makeWorld({ credits: [{ orgId: BUYER, type: "bonus", amountCents: 500n }, { orgId: BUYER, type: "purchase", amountCents: 1n }], balance: 0n });
  assert.equal((await use(once, { plan: TRIAL })).status, 201);
  noMoney(once, 0n);
});

test("the ledger types that count as credits added are named once, and the read asks for exactly them", async () => {
  assert.deepEqual([...CREDITS_ADDED_LEDGER_TYPES], ["purchase"]);
  const asked: Row[] = [];
  const db = {
    creditTransaction: {
      findFirst: async (args: Row) => {
        asked.push(args);
        return asked.length === 1 ? { id: "ct_1" } : null;
      },
    },
  };
  assert.equal(await hasAddedCredits(db, "org_1"), true);
  assert.equal(await hasAddedCredits(db, "org_1"), false);
  assert.deepEqual(asked[0], {
    where: { orgId: "org_1", type: { in: ["purchase"] }, amountCents: { gt: 0n } },
    select: { id: true },
  });
  // A read that fails is the caller's to refuse on: it is not answered "yes".
  await assert.rejects(
    hasAddedCredits({ creditTransaction: { findFirst: async () => Promise.reject(new Error("down")) } }, "org_1"),
  );
});

// ============================================
// Two starts at the same moment
// ============================================

test("two first starts at the same moment make one trial", async () => {
  const world = makeWorld();
  await withApp(world, async (send) => {
    const results = await Promise.all([send({ plan: TRIAL }), send({ plan: TRIAL })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const lost = results.find((r) => r.status === 409)!;
    assert.ok(["subscription_claim_lost", "trial_already_used", "already_on_plan"].includes(lost.body.error), lost.body.error);
    assert.doesNotMatch(JSON.stringify(lost.body), /constraint|P2002/i);
  });
  assert.deepEqual([world.state.installs.length, world.state.subs.length], [1, 1]);
  assert.deepEqual([world.state.listing.totalInstalls, world.state.listing.activeInstalls], [1, 1]);
  noMoney(world);
});

test("two starts at the same moment on a row that is already there make one trial: the second finds it used", async () => {
  // A month that ended long ago left the buyer's rows behind.
  const world = makeWorld({
    install: { status: "suspended" },
    sub: { status: "expired", currentPeriodEnd: new Date(Date.now() - 40 * DAY), priceCents: 900n },
  });
  await withApp(world, async (send) => {
    const results = await Promise.all([send({ plan: TRIAL }), send({ plan: TRIAL })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.ok(
      ["subscription_claim_lost", "trial_already_used"].includes(results.find((r) => r.status === 409)!.body.error),
    );
  });
  const sub = world.state.subs[0]!;
  assert.deepEqual([world.state.subs.length, sub.planId, sub.priceCents, sub.usedInPeriod], [1, TRIAL_ID, 0n, 0]);
  noMoney(world);
});

test("the claim itself holds a trial to one start: a row that changed after it was read is not claimed, and one that was used is never claimed", async () => {
  const { startTrialSubscription, SubscriptionClaimLostError } = await import("../services/marketplaceSubscriptions.js");
  const { TrialAlreadyUsedError } = await import("../services/trialStart.js");
  const now = new Date("2026-10-13T12:00:00.000Z");
  const stored: Row = {
    id: "sub_1",
    listingId: LISTING_ID,
    subscriberId: BUYER,
    status: "cancelled",
    currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-08-31T00:00:00.000Z"),
    cancelAtPeriodEnd: false,
    priceCents: 900n,
    includedUses: null,
    trialUsedAt: null,
  };
  const writes: Row[] = [];
  const txOver = (read: Row | null) =>
    ({
      agentInstall: {
        create: async () => ({ id: "ins_1" }),
        update: async () => ({ id: "ins_1", status: "active" }),
      },
      agentSubscription: {
        findUnique: async () => (read ? { ...read, plan: null } : null),
        create: async ({ data }: Row) => {
          writes.push(data);
          return { id: "sub_new", ...data };
        },
        updateMany: async ({ where, data }: Row) => {
          if (!matches(stored, where)) return { count: 0 };
          Object.assign(stored, data);
          writes.push(data);
          return { count: 1 };
        },
      },
    }) as never;
  const args = { listing: { id: LISTING_ID }, trial: { planId: TRIAL_ID, includedUses: 20 }, buyerId: BUYER, licence: { id: "ins_1", kind: "use", status: "active" }, now };

  // The statement that claims names "never started": checked by the database, not only by the read.
  const stale = { ...stored };
  stored.trialUsedAt = new Date("2026-10-13T11:59:59.000Z");
  await assert.rejects(startTrialSubscription(txOver(stale), args), SubscriptionClaimLostError);
  assert.equal(writes.length, 0);

  // A row that says a trial was started is refused before any statement.
  await assert.rejects(startTrialSubscription(txOver({ ...stored }), args), TrialAlreadyUsedError);
  // And so is one read without the column.
  const { trialUsedAt: _column, ...withoutColumn } = stored;
  await assert.rejects(startTrialSubscription(txOver(withoutColumn), args), TrialAlreadyUsedError);
  assert.equal(writes.length, 0);

  // Never started, and nothing changed in between: claimed once, with what the row must hold.
  stored.trialUsedAt = null;
  const started = await startTrialSubscription(txOver({ ...stored }), args);
  assert.equal(started.licenceId, "ins_1");
  assert.deepEqual(writes, [
    {
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 7 * DAY),
      cancelAtPeriodEnd: true,
      cancelledAt: null,
      priceCents: 0n,
      endReason: null,
      lastRenewalAttemptAt: null,
      planId: TRIAL_ID,
      includedUses: 20,
      extraUsePriceCents: null,
      usedInPeriod: 0,
      carriedUses: 0,
      warnedLevel: 0,
      trialUsedAt: now,
    },
  ]);
  // A second claim on the same read misses: the row left the state that was read.
  await assert.rejects(startTrialSubscription(txOver({ ...stale }), args), SubscriptionClaimLostError);
  assert.equal(writes.length, 1);
  // A trial with no uses is never written as somebody's terms.
  await assert.rejects(startTrialSubscription(txOver(null), { ...args, trial: { planId: TRIAL_ID, includedUses: 0 } }), /no included uses/);
});

// ============================================
// A plan or a paid month that runs
// ============================================

test("a plan or a paid month that is running refuses the trial: 409 already_on_plan, and nothing written", async () => {
  const running: Row[] = [
    // On a paid plan.
    { status: "active", currentPeriodEnd: new Date(Date.now() + 10 * DAY), priceCents: 900n, planId: STARTER_ID, includedUses: 500, usedInPeriod: 3 },
    // Its renewal is being retried: still theirs through the days of grace.
    { status: "past_due", currentPeriodEnd: new Date(Date.now() - 1 * DAY), priceCents: 900n, planId: STARTER_ID, includedUses: 500 },
    // A month paid for before the listing was sold per use.
    { status: "active", currentPeriodEnd: new Date(Date.now() + 10 * DAY), priceCents: 900n },
  ];
  for (const sub of running) {
    const world = makeWorld({ install: {}, sub });
    const before = structuredClone(world.state.subs);
    const res = await use(world, { plan: TRIAL });
    assert.deepEqual([res.status, res.body], [
      409,
      {
        error: "already_on_plan",
        message: "You already have a plan or a subscription for this agent that is still running. Nothing was charged.",
      },
    ]);
    untouched(world, [1, 1]);
    assert.deepEqual(world.state.subs, before);
  }
});

test("a plan that is over does not stand in the way of a first trial: the same row is claimed, and nothing is charged", async () => {
  const world = makeWorld({
    install: { status: "suspended" },
    sub: { status: "expired", currentPeriodEnd: new Date(Date.now() - 10 * DAY), priceCents: 900n, planId: STARTER_ID, includedUses: 500, usedInPeriod: 500, carriedUses: 30, extraUsePriceCents: 5n, warnedLevel: 100 },
  });
  const res = await use(world, { plan: TRIAL });
  assert.equal(res.status, 201);
  const sub = world.state.subs[0]!;
  assert.deepEqual(
    [world.state.subs.length, sub.status, sub.planId, sub.priceCents, sub.includedUses, sub.usedInPeriod, sub.carriedUses, sub.extraUsePriceCents, sub.warnedLevel, sub.cancelAtPeriodEnd],
    [1, "active", TRIAL_ID, 0n, 20, 0, 0, null, 0, true],
  );
  assert.equal(world.state.installs[0]!.status, "active");
  noMoney(world);
});

// ============================================
// Terms that are not the trial as it is now
// ============================================

test("terms that are not the trial's are refused with what is offered now, the trial beside the plans", async () => {
  for (const shown of [
    { ...TRIAL, includedUses: 50 },
    { ...TRIAL, includedUses: 19 },
    // A trial has no price and no extra price: anything else is not what is offered.
    { ...TRIAL, priceCents: 100 },
    { ...TRIAL, extraUsePriceCents: 5 },
  ]) {
    const world = makeWorld();
    const res = await use(world, { plan: shown });
    assert.equal(res.status, 409, JSON.stringify(shown));
    assert.deepEqual(res.body, {
      error: "pricing_changed",
      message: 'The plans of "Research Analyst" are not what you were shown. Nothing was charged. Look at them again and choose.',
      pricing: PER_USE,
      plans: ON_OFFER,
      trial: { id: TRIAL_ID, includedUses: 20, days: 7 },
    });
    untouched(world);
  }
});

test("a trial its creator ended starts nothing: 409 with no trial on offer, and a trial of another listing is not this listing's", async () => {
  const ended = makeWorld();
  ended.state.plans.find((p) => p.id === TRIAL_ID)!.status = "retired";
  const res = await use(ended, { plan: TRIAL });
  assert.deepEqual([res.status, res.body.error, res.body.plans, res.body.trial], [409, "pricing_changed", ON_OFFER, null]);
  untouched(ended);

  // Ended long ago, sent with the terms that row really has.
  const old = makeWorld();
  const oldRes = await use(old, { plan: { ...TRIAL, id: OLD_TRIAL_ID, includedUses: 10 } });
  assert.deepEqual([oldRes.status, oldRes.body.error, oldRes.body.trial], [409, "pricing_changed", { id: TRIAL_ID, includedUses: 20, days: 7 }]);
  untouched(old);

  // Another listing's trial is answered as a plan this listing does not offer, as any such id is.
  const theirs = makeWorld();
  const theirsRes = await use(theirs, { plan: { ...TRIAL, id: THEIR_TRIAL_ID } });
  assert.deepEqual([theirsRes.status, theirsRes.body.error], [409, "pricing_changed"]);
  assert.equal("trial" in theirsRes.body, false);
  untouched(theirs);
});

test("a listing that is no longer sold per use offers no trial to start", async () => {
  const world = makeWorld({ listing: { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 1500n } });
  const res = await use(world, { plan: TRIAL });
  assert.deepEqual(
    [res.status, res.body.error, res.body.pricing, res.body.plans, res.body.trial],
    [409, "pricing_changed", { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 1500 }, [], null],
  );
  untouched(world);
});

test("a trial changed between the look and the write is refused inside the transaction, and the licence it claimed is rolled back", async () => {
  const world = makeWorld({ install: { status: "uninstalled", uninstalledAt: new Date(0) } });
  // The creator's save lands after the start's first look at the trial.
  const realFind = world.models.listingPlan.findUnique;
  let looks = 0;
  world.models.listingPlan.findUnique = async (args: Row) => {
    if (++looks === 2) world.state.plans.find((p) => p.id === TRIAL_ID)!.includedUses = 5;
    return realFind(args);
  };
  const res = await use(world, { plan: TRIAL });
  assert.deepEqual([res.status, res.body.error, res.body.trial], [409, "pricing_changed", { id: TRIAL_ID, includedUses: 5, days: 7 }]);
  noMoney(world);
  assert.equal(world.state.installs[0]!.status, "uninstalled");
  assert.equal(world.state.subs.length, 0);
});

// ============================================
// What any start refuses, and reads that fail
// ============================================

test("the refusals of any start hold for a trial: the caller's own agent, a listing that is not on sale, one that sells copies, an agent that cannot answer", async () => {
  const own = makeWorld({ listing: { publisherId: BUYER } });
  const ownRes = await use(own, { plan: TRIAL });
  assert.deepEqual([ownRes.status, ownRes.body.error], [409, "own_agent"]);
  untouched(own);

  const archived = makeWorld({ listing: { status: "archived" } });
  assert.deepEqual([(await use(archived, { plan: TRIAL })).status], [404]);
  untouched(archived);

  const copies = makeWorld({ listing: { sells: "copies" } });
  const copiesRes = await use(copies, { plan: TRIAL });
  assert.deepEqual([copiesRes.status, copiesRes.body.error], [409, "sells_copies"]);
  untouched(copies);

  // An agent that answers through its graph cannot answer a paid use, or a trial of one.
  const graph = makeWorld({ agent: { entrypoint: "graph" } });
  const graphRes = await use(graph, { plan: TRIAL });
  assert.deepEqual([graphRes.status, graphRes.body.error], [409, "not_offered"]);
  untouched(graph);

  // A copy with a month paid for: one licence row for a listing and a buyer.
  const until = new Date(Date.now() + 10 * DAY);
  const copy = makeWorld({ install: { kind: "copy", clonedAgentId: "agent_copy" }, sub: { status: "active", currentPeriodEnd: until, priceCents: 900n } });
  const copyRes = await use(copy, { plan: TRIAL });
  assert.deepEqual([copyRes.status, copyRes.body.error, copyRes.body.until], [409, "copy_subscription_active", until.toISOString()]);
  untouched(copy, [1, 1]);
});

test("a paused listing starts no trial, and when the pause cannot be asked about nothing is started either", async () => {
  // The pause is asked of the model at the moment of the start, so it is handed in here as the plan start's tests hand it in.
  const refusal = async (world: ReturnType<typeof makeWorld>, listingPausedNow: () => Promise<boolean>) =>
    withApp(world, async () => {
      const { startPlan } = await import("../services/planStart.js");
      const { UseStartError } = await import("../services/marketplace.js");
      try {
        await startPlan(LISTING_ID, BUYER, { id: TRIAL_ID, priceCents: 0n, includedUses: 20, extraUsePriceCents: null }, { listingPausedNow } as never);
        return null;
      } catch (err) {
        assert.ok(err instanceof UseStartError, String(err));
        return [err.status, err.code, err.message];
      }
    });
  const { USE_START_MESSAGES } = await import("../services/marketplace.js");

  const paused = makeWorld();
  assert.deepEqual(await refusal(paused, async () => true), [409, "listing_paused", USE_START_MESSAGES.paused]);
  untouched(paused);

  const unknown = makeWorld();
  assert.deepEqual(
    await refusal(unknown, async () => {
      throw new Error("the model could not be asked");
    }),
    [503, "service_unavailable", USE_START_MESSAGES.cannotStart],
  );
  untouched(unknown);

  // The same start with the agent answering goes through: the refusals above are the pause's.
  const running = makeWorld();
  assert.equal(await refusal(running, async () => false), null);
  assert.deepEqual([running.state.subs.length, running.state.subs[0]?.planId], [1, TRIAL_ID]);
  noMoney(running);
});

test("a read that fails refuses and writes nothing: the ledger, and the buyer's own rows", async () => {
  const CANNOT_START = {
    error: "service_unavailable",
    message: "This agent cannot be started right now. Nothing was charged. Try again later.",
  };
  // Whether credits were added cannot be read: not answered "yes".
  const ledgerDown = makeWorld();
  ledgerDown.models.creditTransaction.findFirst = async () => {
    throw new Error("LEDGER_DOWN_NEVER_SHOWN");
  };
  const first = await use(ledgerDown, { plan: TRIAL });
  assert.deepEqual([first.status, first.body], [503, CANNOT_START]);
  untouched(ledgerDown);

  // Whether a trial was started before cannot be read: not answered "never".
  const rowsDown = makeWorld();
  rowsDown.models.agentSubscription.findUnique = async () => {
    throw new Error("ROWS_DOWN_NEVER_SHOWN");
  };
  const second = await use(rowsDown, { plan: TRIAL });
  assert.deepEqual([second.status, second.body], [503, CANNOT_START]);
  untouched(rowsDown);
});

// ============================================
// The rules by themselves
// ============================================

test("who may take a trial: offered, never used, nothing running, credits added, and each missing one says no in its own word", () => {
  const all = { offered: true, used: false, running: false, addedCredits: true };
  assert.deepEqual(judgeTrial(all), { available: true });
  assert.deepEqual(judgeTrial({ ...all, offered: false }), { available: false, reason: "not_offered" });
  assert.deepEqual(judgeTrial({ ...all, used: true }), { available: false, reason: "trial_already_used" });
  assert.deepEqual(judgeTrial({ ...all, running: true }), { available: false, reason: "already_on_plan" });
  assert.deepEqual(judgeTrial({ ...all, addedCredits: false }), { available: false, reason: "trial_needs_credits" });
  // "Add credits" is said only when it is the one thing missing.
  for (const other of [{ offered: false }, { used: true }, { running: true }]) {
    const standing = judgeTrial({ ...all, ...other, addedCredits: false });
    assert.equal(standing.available, false);
    if (!standing.available) assert.notEqual(standing.reason, "trial_needs_credits");
  }
  // A trial used and a plan running: told that the trial is used.
  assert.deepEqual(judgeTrial({ ...all, used: true, running: true }), { available: false, reason: "trial_already_used" });
});

test("the start by itself: nothing is claimed on any refusal, credits are asked about only when they decide, and a failed read claims nothing", async () => {
  const listing = { id: LISTING_ID, status: "published", sells: "use", pricingModel: "per_request", pricePerRequestCents: 5n };
  const trial = { id: TRIAL_ID, listingId: LISTING_ID, kind: "trial", status: "active", priceCents: 0n, includedUses: 20, extraUsePriceCents: null };
  const shown = { id: TRIAL_ID, priceCents: 0n, includedUses: 20, extraUsePriceCents: null };
  const now = new Date("2026-10-13T12:00:00.000Z");
  const run = async (over: Partial<TrialStartDeps> = {}, args: Row = {}) => {
    const calls: string[] = [];
    const deps: TrialStartDeps = {
      loadLicence: async () => {
        calls.push("loadLicence");
        return { licence: null, sub: null };
      },
      addedCredits: async () => {
        calls.push("addedCredits");
        return true;
      },
      termsChanged: async () => new Error("terms changed"),
      refuseIfItCannotAnswer: async () => {
        calls.push("canAnswer");
      },
      claim: async () => {
        calls.push("claim");
        return "sub_1";
      },
      now: () => now,
      ...over,
    };
    const result = await startTrial({ listing, trial, shown, ...args }, deps).catch((err: Error) => ({ threw: err.message }));
    return { result, calls };
  };

  assert.deepEqual(await run(), {
    result: { started: true, subscriptionId: "sub_1" },
    calls: ["loadLicence", "addedCredits", "canAnswer", "claim"],
  });

  // The terms first: nothing is read for a trial that is not the one on offer.
  for (const args of [
    { shown: { ...shown, includedUses: 21 } },
    { trial: { ...trial, status: "retired" } },
    { trial: { ...trial, kind: "paid" } },
    { trial: { ...trial, listingId: OTHER_LISTING_ID } },
    { trial: null },
    { listing: { ...listing, pricingModel: "monthly" } },
    { listing: { ...listing, status: "archived" } },
  ]) {
    assert.deepEqual(await run({}, args), { result: { threw: "terms changed" }, calls: [] });
  }

  const licence = { id: "ins_1", kind: "use", status: "active", clonedAgentId: null, acceptedPricingModel: null, acceptedPricePerRequestCents: null };
  const sub = (over: Row) => ({ status: "cancelled", currentPeriodEnd: new Date(now.getTime() - DAY), cancelAtPeriodEnd: false, includedUses: null, trialUsedAt: null, ...over });

  // Used before: credits are not asked about, and nothing is claimed.
  assert.deepEqual(await run({ loadLicence: async () => ({ licence, sub: sub({ trialUsedAt: new Date(0) }) }) }), {
    result: { started: false, refusal: { reason: "trial_already_used" } },
    calls: [],
  });
  // A row with no licence beside it still says a trial was used.
  assert.deepEqual(
    (await run({ loadLicence: async () => ({ licence: null, sub: sub({ trialUsedAt: new Date(0) }) }) })).result,
    { started: false, refusal: { reason: "trial_already_used" } },
  );
  // Something running.
  assert.deepEqual(
    await run({ loadLicence: async () => ({ licence, sub: sub({ status: "active", currentPeriodEnd: new Date(now.getTime() + DAY) }) }) }),
    { result: { started: false, refusal: { reason: "already_on_plan" } }, calls: [] },
  );
  // Credits never added.
  const noCredits = await run({ addedCredits: async () => false });
  assert.deepEqual(noCredits, { result: { started: false, refusal: { reason: "trial_needs_credits" } }, calls: ["loadLicence"] });

  // A read that fails: refused, and nothing claimed.
  const boom = async () => Promise.reject(new Error("down"));
  assert.deepEqual(await run({ loadLicence: boom }), {
    result: { started: false, refusal: { reason: "service_unavailable" } },
    calls: [],
  });
  assert.deepEqual(await run({ addedCredits: boom }), {
    result: { started: false, refusal: { reason: "service_unavailable" } },
    calls: ["loadLicence"],
  });
  // An agent that cannot answer: its own refusal, thrown, and nothing claimed.
  assert.deepEqual(await run({ refuseIfItCannotAnswer: async () => Promise.reject(new Error("paused")) }), {
    result: { threw: "paused" },
    calls: ["loadLicence", "addedCredits"],
  });
});

test("the sentences of a trial start are the ones a buyer is to read", () => {
  assert.equal(TRIAL_START_MESSAGES.alreadyUsed, ALREADY_USED.message);
  assert.equal(TRIAL_START_MESSAGES.needsCredits, NEEDS_CREDITS.message);
  for (const sentence of Object.values(TRIAL_START_MESSAGES)) assert.doesNotMatch(sentence, /_|\u2014|unlimited/);
});
