import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { accessPlanOf, getUseAccess, planWillRenew, type PaidSubscription, type UseAccessView } from "../services/paidUse.js";
import { readOffers, readPlanOffers, readTrialOffer, trialOfferOf } from "../services/planOffers.js";
import {
  CREATOR_ORG,
  HANDLE,
  KEY_CALLER,
  LICENCE,
  LISTING,
  MONTHLY_LICENCE,
  MONTHLY_LISTING,
  NOW,
  PAID_MONTH,
  paidHarness,
  PLAN_LICENCE,
  PLAN_SUB,
  SESSION,
  type PaidHarness,
  type PaidHarnessOptions,
} from "./paidUseHarness.js";

// What is read about a listing's free trial: the trial on offer (told beside
// the paid plans, never among them), whether the caller's organization could
// start it now, and the plan object of a buyer who is on it. The access
// answer runs on the real paid service over tests/paidUseHarness.ts. What
// these pin: `trial` is null unless the listing offers one now;
// `trialAvailable` is true only when every rule holds and each missing one
// turns it false; "add credits" is said only when it is the one thing
// missing; nothing of another buyer is told; and the paid plans of every
// read are exactly what they were.

type Row = Record<string, any>;
const DAY_MS = 24 * 60 * 60 * 1000;

const OFFER_ROWS = [
  { id: "plan-1", name: "Starter", priceCents: 900n, includedUses: 500, extraUsePriceCents: 4n },
  { id: "plan-2", name: "Pro", priceCents: 2900n, includedUses: 2000, extraUsePriceCents: null },
];
const OFFERS = [
  { id: "plan-1", name: "Starter", priceCents: 900, includedUses: 500, extraUsePriceCents: 4 },
  { id: "plan-2", name: "Pro", priceCents: 2900, includedUses: 2000, extraUsePriceCents: null },
];
/** The trial as the database holds it, with more on the row than a buyer may see. */
const TRIAL_ROW = { id: "plan-trial", includedUses: 20, name: "Free trial", position: 0, status: "active", subscribers: 4_711 };
const TRIAL = { id: "plan-trial", includedUses: 20, days: 7 };

interface Reads {
  /** The listing's trial on offer; an Error is thrown. Default: the trial above. */
  trial?: Row | null | Error;
  /** Whether credits were ever added; an Error is thrown. Default: yes. */
  addedCredits?: boolean | Error;
}

/** The access answer of a caller, with the listing's plans, its trial and the credits read as production wires them. */
async function accessOf(options: PaidHarnessOptions = {}, reads: Reads = {}, caller = SESSION) {
  const h: PaidHarness = paidHarness(options);
  h.deps.loadPlans = async () => OFFER_ROWS;
  h.deps.loadTrial = async (listingId) => {
    h.log.push(`loadTrial:${listingId}`);
    if (reads.trial instanceof Error) throw reads.trial;
    return (reads.trial === undefined ? TRIAL_ROW : reads.trial) as never;
  };
  h.deps.addedCredits = async (orgId) => {
    h.log.push(`addedCredits:${orgId}`);
    if (reads.addedCredits instanceof Error) throw reads.addedCredits;
    return reads.addedCredits ?? true;
  };
  const result = await getUseAccess({ caller, handle: HANDLE }, h.deps);
  assert.equal(result.kind, "access");
  assert.ok(result.kind === "access");
  return { view: result.view, h };
}
const trialOf = (view: UseAccessView) => ({
  trial: view.trial,
  trialAvailable: view.trialAvailable,
  trialNeedsCredits: view.trialNeedsCredits,
  trialEnded: view.trialEnded,
});
const AVAILABLE = { trial: TRIAL, trialAvailable: true, trialNeedsCredits: false, trialEnded: false };
const NOT_AVAILABLE = { ...AVAILABLE, trialAvailable: false };

/** A buyer's row that says a trial was never started: a month that ended long ago. */
const OLD_MONTH: PaidSubscription = {
  status: "expired",
  currentPeriodEnd: new Date(NOW.getTime() - 40 * DAY_MS),
  cancelAtPeriodEnd: false,
  endReason: null,
  priceCents: 900n,
  trialUsedAt: null,
};
/** A buyer on the trial: 20 uses, 3 used, 5 days left. */
const ON_TRIAL: PaidSubscription = {
  status: "active",
  currentPeriodStart: new Date(NOW.getTime() - 2 * DAY_MS),
  currentPeriodEnd: new Date(NOW.getTime() + 5 * DAY_MS),
  cancelAtPeriodEnd: true,
  endReason: null,
  priceCents: 0n,
  id: "sub-1",
  planId: "plan-trial",
  includedUses: 20,
  usedInPeriod: 3,
  carriedUses: 0,
  extraUsePriceCents: null,
  planName: "Free trial",
  trialUsedAt: new Date(NOW.getTime() - 2 * DAY_MS),
};

// ============================================
// The trial on offer
// ============================================

test("the access answer tells the trial on offer as its id, its uses and its days, beside plans that are what they were", async () => {
  const { view } = await accessOf({ licence: null });
  assert.deepEqual(view.trial, TRIAL);
  assert.deepEqual(view.plans, OFFERS);
  // Nothing more of the row crosses, and the trial is not one of the plans.
  const text = JSON.stringify(view);
  for (const forbidden of ["4711", "subscribers", "position", "Free trial"]) assert.ok(!text.includes(forbidden), forbidden);
  assert.ok(!JSON.stringify(view.plans).includes("plan-trial"));

  // With no trial the same plans, to the field.
  const without = await accessOf({ licence: null }, { trial: null });
  assert.deepEqual(without.view.plans, view.plans);
  assert.deepEqual(trialOf(without.view), { trial: null, trialAvailable: false, trialNeedsCredits: false, trialEnded: false });
});

test("trial is null when the listing offers none, when the read of it fails, and when the listing does not offer plans", async () => {
  const none = { trial: null, trialAvailable: false, trialNeedsCredits: false, trialEnded: false };
  // None on offer: its creator never set one, or ended it (the read asks for a trial on offer only).
  const noTrial = await accessOf({ licence: null }, { trial: null });
  assert.deepEqual(trialOf(noTrial.view), none);
  // Credits are not asked about when there is no trial to take.
  assert.ok(!noTrial.h.log.some((entry) => entry.startsWith("addedCredits")));

  // The read fails: the answer that was decided goes out, with no trial.
  const failed = await accessOf({ licence: null }, { trial: new Error("TRIAL_READ_NEVER_SHOWN") });
  assert.deepEqual(trialOf(failed.view), none);
  assert.equal(failed.view.access, "none");
  assert.ok(!JSON.stringify(failed.view).includes("NEVER_SHOWN"));

  // Sold by the month, taken down, or selling copies: no plans, so no trial, and none is read.
  for (const listing of [MONTHLY_LISTING, { ...LISTING, status: "archived" }, { ...LISTING, sells: "copies" }]) {
    const { view, h } = await accessOf({ listing, licence: null });
    assert.deepEqual(trialOf(view), none, JSON.stringify([listing.pricingModel, listing.status, listing.sells]));
    assert.ok(!h.log.some((entry) => entry.startsWith("loadTrial")));
  }

  // A set of deps that reads no trial names none.
  const h = paidHarness({ licence: null });
  const bare = await getUseAccess({ caller: SESSION, handle: HANDLE }, h.deps);
  assert.deepEqual(bare.kind === "access" && trialOf(bare.view), none);
});

// ============================================
// Whether the caller could start it
// ============================================

test("trialAvailable is true only when the listing offers a trial, none was started, nothing runs, and credits were added once", async () => {
  // Never started on this listing: no rows at all, and rows that say "never".
  assert.deepEqual(trialOf((await accessOf({ licence: null })).view), AVAILABLE);
  assert.deepEqual(trialOf((await accessOf({ licence: { ...LICENCE, status: "suspended" }, sub: OLD_MONTH })).view), AVAILABLE);
  // A buyer who pays per use may take it too.
  const perUse = await accessOf({ licence: LICENCE });
  assert.equal(perUse.view.access, "listing_pricing");
  assert.deepEqual(trialOf(perUse.view), AVAILABLE);
  // A key reads the same answer for its organization: whether it may start is `canAccept`.
  const byKey = await accessOf({ licence: null }, {}, KEY_CALLER);
  assert.deepEqual([byKey.view.trialAvailable, byKey.view.canAccept], [true, false]);
  // The caller's organization, never one named in the request.
  assert.deepEqual(byKey.h.log.filter((entry) => entry.startsWith("addedCredits")), ["addedCredits:org-buyer"]);
});

test("each rule that is missing turns trialAvailable false: no trial on offer, already used, something running, no credits added", async () => {
  // No trial on offer.
  assert.equal((await accessOf({ licence: null }, { trial: null })).view.trialAvailable, false);

  // Already used: ended, stopped, and taken over by a paid plan. Credits are not asked about.
  const usedAt = new Date(NOW.getTime() - 9 * DAY_MS);
  const endedTrial = { ...ON_TRIAL, status: "cancelled", endReason: "plan_ended", currentPeriodEnd: new Date(NOW.getTime() - 2 * DAY_MS), trialUsedAt: usedAt };
  const used: Array<[string, PaidHarnessOptions]> = [
    ["ended", { licence: PLAN_LICENCE, sub: endedTrial }],
    ["stopped", { licence: { ...PLAN_LICENCE, status: "uninstalled" }, sub: { ...endedTrial, endReason: null } }],
    ["a paid plan since", { licence: PLAN_LICENCE, sub: { ...PLAN_SUB, trialUsedAt: usedAt } }],
    ["a paid plan that ended since", { licence: PLAN_LICENCE, sub: { ...PLAN_SUB, status: "cancelled", currentPeriodEnd: new Date(NOW.getTime() - DAY_MS), trialUsedAt: usedAt } }],
    // A row read without the column: counted as used.
    ["a row read without the day", { licence: PLAN_LICENCE, sub: { ...OLD_MONTH, trialUsedAt: undefined } }],
  ];
  for (const [what, options] of used) {
    const { view, h } = await accessOf(options);
    assert.deepEqual([view.trialAvailable, view.trialNeedsCredits], [false, false], what);
    assert.ok(!h.log.some((entry) => entry.startsWith("addedCredits")), what);
  }

  // Something running: the trial itself, a paid plan, a paid month.
  const running: Array<[string, PaidHarnessOptions]> = [
    ["the trial", { licence: PLAN_LICENCE, sub: ON_TRIAL }],
    ["a paid plan", { licence: PLAN_LICENCE, sub: { ...PLAN_SUB, trialUsedAt: null } }],
    ["a paid month", { listing: MONTHLY_LISTING, licence: MONTHLY_LICENCE, sub: { ...PAID_MONTH, trialUsedAt: null } }],
  ];
  for (const [what, options] of running) {
    const { view } = await accessOf(options);
    assert.equal(view.access, "subscribed", what);
    assert.deepEqual([view.trialAvailable, view.trialNeedsCredits], [false, false], what);
  }

  // Credits never added: the one thing missing, and said so.
  const noCredits = await accessOf({ licence: null }, { addedCredits: false });
  assert.deepEqual(trialOf(noCredits.view), { ...NOT_AVAILABLE, trialNeedsCredits: true });

  // The caller's own agent has nothing to try.
  const own = await accessOf({ agent: { orgId: SESSION.orgId } });
  assert.equal(own.view.access, "own_agent");
  assert.deepEqual([own.view.trialAvailable, own.view.trialNeedsCredits], [false, false]);
  assert.notEqual(CREATOR_ORG, SESSION.orgId);
});

test("trialNeedsCredits is true only when credits are the one thing missing, and never on a read that failed", async () => {
  // Used before and no credits: told nothing about credits.
  const used = await accessOf({ licence: PLAN_LICENCE, sub: { ...OLD_MONTH, trialUsedAt: new Date(0) } }, { addedCredits: false });
  assert.deepEqual([used.view.trialAvailable, used.view.trialNeedsCredits], [false, false]);
  // On a plan and no credits.
  const running = await accessOf({ licence: PLAN_LICENCE, sub: { ...PLAN_SUB, trialUsedAt: null } }, { addedCredits: false });
  assert.deepEqual([running.view.trialAvailable, running.view.trialNeedsCredits], [false, false]);
  // No trial on offer and no credits.
  const none = await accessOf({ licence: null }, { trial: null, addedCredits: false });
  assert.deepEqual([none.view.trialAvailable, none.view.trialNeedsCredits], [false, false]);

  // The ledger cannot be read: no trial is offered, and credits are not blamed.
  const failed = await accessOf({ licence: null }, { addedCredits: new Error("LEDGER_NEVER_SHOWN") });
  assert.deepEqual(trialOf(failed.view), NOT_AVAILABLE);
  assert.ok(!JSON.stringify(failed.view).includes("NEVER_SHOWN"));
  // A set of deps with no read of the ledger answers no.
  const h = paidHarness({ licence: null });
  h.deps.loadTrial = async () => TRIAL_ROW as never;
  const bare = await getUseAccess({ caller: SESSION, handle: HANDLE }, h.deps);
  assert.deepEqual(bare.kind === "access" && trialOf(bare.view), NOT_AVAILABLE);
});

test("a copy with a month paid for cannot start a trial either, and the page is told why by the block it already shows", async () => {
  const { view } = await accessOf({
    licence: { ...LICENCE, kind: "copy" },
    sub: { ...PAID_MONTH, trialUsedAt: null },
  });
  assert.equal(view.startBlocked?.code, "copy_subscription_active");
  assert.deepEqual([view.trialAvailable, view.trialNeedsCredits, view.canAccept], [false, false, false]);
});

// ============================================
// A buyer on the trial, and after it
// ============================================

test("a buyer on the trial reads it as their plan: named Free trial, marked as a trial, with no price past its uses and no time at which it starts again", async () => {
  const { view } = await accessOf({ licence: PLAN_LICENCE, sub: ON_TRIAL });
  assert.equal(view.access, "subscribed");
  assert.deepEqual(view.plan, {
    id: "plan-trial",
    name: "Free trial",
    trial: true,
    includedUses: 20,
    carriedUses: 0,
    usedUses: 3,
    remainingUses: 17,
    extraUsePriceCents: null,
    warning: null,
  });
  assert.equal(view.trialEnded, false);
  // Still shown what to choose next.
  assert.deepEqual(view.plans, OFFERS);
  assert.deepEqual(view.subscription, {
    status: "active",
    currentPeriodEnd: ON_TRIAL.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: true,
    graceEndsAt: null,
  });

  // A paid plan in the same place is marked as not a trial, and keeps its creator's name for it.
  const paid = await accessOf({ licence: PLAN_LICENCE, sub: { ...PLAN_SUB, planName: "Starter" } });
  assert.deepEqual([paid.view.plan?.trial, paid.view.plan?.name, typeof paid.view.plan?.resetsAt], [false, "Starter", "string"]);
});

test("the plan object every reader shares says a trial is a trial, whatever the row was read with", () => {
  // The same function builds the plan of the access answer, of my-installs and of the usage read.
  const trial = accessPlanOf({ ...ON_TRIAL, planName: "Renamed by hand", usedInPeriod: 17 }, true);
  assert.deepEqual([trial.name, trial.trial, trial.warning, "resetsAt" in trial ? "told" : "not told"], ["Free trial", true, 85, "told"]);
  // Whether a time is told is the caller's question, and for a trial the answer is always no.
  const listing = { status: "published", sells: "use", pricingModel: "per_request" };
  assert.equal(planWillRenew(listing, ON_TRIAL), false);
  // Even on a row whose flag was turned off by hand: a trial never renews.
  assert.equal(planWillRenew(listing, { ...ON_TRIAL, cancelAtPeriodEnd: false }), false);
  assert.equal("resetsAt" in accessPlanOf(ON_TRIAL, planWillRenew(listing, { ...ON_TRIAL, cancelAtPeriodEnd: false })), false);
  // A paid plan is as it was.
  assert.equal(planWillRenew(listing, PLAN_SUB), true);
  assert.equal(accessPlanOf({ ...PLAN_SUB, planName: "Starter" }, true).trial, false);
});

test("after the trial the access says a trial ended, and after a paid plan it does not", async () => {
  const over = { status: "cancelled", endReason: "plan_ended", currentPeriodEnd: new Date(NOW.getTime() - DAY_MS) };
  const trial = await accessOf({ licence: PLAN_LICENCE, sub: { ...ON_TRIAL, ...over } });
  assert.deepEqual([trial.view.access, trial.view.plan, trial.view.trialEnded], ["plan_ended", null, true]);
  // Used: not offered again.
  assert.equal(trial.view.trialAvailable, false);

  // Past its 7 days and not closed yet: over all the same, with no days of grace.
  const late = await accessOf({ licence: PLAN_LICENCE, sub: { ...ON_TRIAL, currentPeriodEnd: new Date(NOW.getTime() - 1000) } });
  assert.deepEqual([late.view.access, late.view.trialEnded], ["plan_ended", true]);

  const plan = await accessOf({ licence: PLAN_LICENCE, sub: { ...PLAN_SUB, ...over, trialUsedAt: null } });
  assert.deepEqual([plan.view.access, plan.view.trialEnded], ["plan_ended", false]);

  // A buyer who agreed to a price per use goes on at it: nothing ended for them to choose about.
  const agreed = await accessOf({ licence: LICENCE, sub: { ...ON_TRIAL, ...over } });
  assert.deepEqual([agreed.view.access, agreed.view.trialEnded], ["listing_pricing", false]);
});

// ============================================
// The read of the offers
// ============================================

const stored = (over: Row): Row => ({
  listingId: "lst-1",
  kind: "paid",
  status: "active",
  name: "Starter",
  priceCents: 900n,
  includedUses: 500,
  extraUsePriceCents: 4n,
  position: 1,
  retiredAt: null,
  ...over,
});
const ROWS = [
  stored({ id: "pro", name: "Pro", priceCents: 2900n, includedUses: 2000, extraUsePriceCents: null, position: 2 }),
  stored({ id: "starter" }),
  stored({ id: "trial", kind: "trial", name: "Free trial", priceCents: 0n, includedUses: 20, extraUsePriceCents: null, position: 0 }),
  stored({ id: "old-trial", kind: "trial", name: "Free trial", priceCents: 0n, includedUses: 10, extraUsePriceCents: null, position: 0, status: "retired" }),
  stored({ id: "old", status: "retired", position: 3 }),
  stored({ id: "theirs", listingId: "lst-2" }),
  stored({ id: "their-trial", listingId: "lst-2", kind: "trial", priceCents: 0n, includedUses: 5, extraUsePriceCents: null, position: 0 }),
];
function dbOver(rows: Row[]) {
  const asked: Row[] = [];
  const hit = (where: Row) =>
    rows
      .filter(
        (row) =>
          row.listingId === where.listingId &&
          row.status === where.status &&
          (typeof where.kind === "string" ? row.kind === where.kind : where.kind.in.includes(row.kind)),
      )
      .sort((a, b) => a.position - b.position);
  return {
    asked,
    listingPlan: {
      findMany: async (args: Row) => {
        asked.push(args);
        return hit(args.where) as never;
      },
      findFirst: async (args: Row) => {
        asked.push(args);
        return (hit(args.where)[0] ?? null) as never;
      },
    },
  };
}

test("one read answers a listing's paid plans, exactly as the read of plans alone does, and its trial beside them", async () => {
  const db = dbOver(ROWS);
  const offers = await readOffers(db, "lst-1");
  assert.equal(db.asked.length, 1);
  assert.deepEqual(db.asked[0]!.where, { listingId: "lst-1", status: "active", kind: { in: ["paid", "trial"] } });
  assert.deepEqual(offers.trial, { id: "trial", includedUses: 20 });
  assert.deepEqual(offers.plans.map((plan) => plan.id), ["starter", "pro"]);
  // Field for field what readPlanOffers selects: nothing of a row's kind, place or dates.
  assert.deepEqual(offers.plans, [
    { id: "starter", name: "Starter", priceCents: 900n, includedUses: 500, extraUsePriceCents: 4n },
    { id: "pro", name: "Pro", priceCents: 2900n, includedUses: 2000, extraUsePriceCents: null },
  ]);
  assert.deepEqual(
    (await readPlanOffers(db, "lst-1")).map((plan) => plan.id),
    offers.plans.map((plan) => plan.id),
  );

  // No trial on offer: ended, or never set. Another listing's is not this one's.
  assert.equal((await readOffers(dbOver(ROWS.filter((row) => row.id !== "trial")), "lst-1")).trial, null);
  assert.deepEqual((await readOffers(db, "lst-2")).trial, { id: "their-trial", includedUses: 5 });
  assert.deepEqual(await readOffers(dbOver([]), "lst-1"), { plans: [], trial: null });
});

test("the read of the trial alone asks for a trial on offer on this listing, and a buyer is told its id, its uses and its days", async () => {
  const db = dbOver(ROWS);
  const row = await readTrialOffer(db, "lst-1");
  assert.deepEqual(db.asked[0], {
    where: { listingId: "lst-1", status: "active", kind: "trial" },
    select: { id: true, includedUses: true },
  });
  assert.deepEqual(trialOfferOf(row), { id: "trial", includedUses: 20, days: 7 });
  assert.equal(await readTrialOffer(dbOver(ROWS.filter((r) => r.id !== "trial")), "lst-1"), null);
  assert.equal(trialOfferOf(null), null);
  assert.equal(trialOfferOf(undefined), null);
  // Whatever else a row carried stays where it was read.
  assert.deepEqual(trialOfferOf({ id: "t", includedUses: 3, name: "Free trial", subscribers: 9 } as never), {
    id: "t",
    includedUses: 3,
    days: 7,
  });
});

// ============================================
// A trial has no renewal to resume
// ============================================

test("resuming the renewal of a free trial changes nothing: the row stays set to end, and a plan or a month resumes as before", async () => {
  const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Row };
  const { setSubscriptionCancelAtPeriodEnd, SubscriptionNotFoundError } = await import("../services/marketplace.js");
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key === "OR") return (cond as Row[]).some((either) => matches(row, either));
      if (cond && typeof cond === "object") {
        if ("in" in cond) return cond.in.includes(row[key]);
        if ("gt" in cond) return row[key] != null && row[key] > cond.gt;
      }
      return (row[key] ?? null) === cond;
    });
  const base = {
    listingId: "lst-1",
    subscriberId: "org-buyer",
    status: "active",
    currentPeriodStart: new Date(NOW.getTime() - 2 * DAY_MS),
    currentPeriodEnd: new Date(Date.now() + 5 * DAY_MS),
    cancelledAt: null,
    endReason: null,
    carriedUses: 0,
    usedInPeriod: 3,
  };
  const run = async (row: Row, cancel: boolean) => {
    const stored: Row = { id: "sub-1", ...base, ...row };
    const original = prisma.agentSubscription;
    prisma.agentSubscription = {
      updateMany: async ({ where, data }: Row) => {
        if (!matches(stored, where)) return { count: 0 };
        Object.assign(stored, data);
        return { count: 1 };
      },
      findUnique: async () => ({
        ...stored,
        plan: stored.planId ? { status: "active", name: "Starter" } : null,
        listing: { status: "published", sells: "use", pricingModel: "per_request" },
      }),
    };
    try {
      const answer = await setSubscriptionCancelAtPeriodEnd("org-buyer", "lst-1", cancel).catch((err: unknown) => err);
      return { answer, stored };
    } finally {
      prisma.agentSubscription = original;
    }
  };
  const trial = { priceCents: 0n, planId: "plan-trial", includedUses: 20, extraUsePriceCents: null, cancelAtPeriodEnd: true };

  const resumed = await run(trial, false);
  assert.ok(resumed.answer instanceof SubscriptionNotFoundError);
  assert.equal(resumed.stored.cancelAtPeriodEnd, true);

  // Cancelling a trial's renewal is a no-op that answers the row as it is: a trial, set to end.
  const cancelled = await run(trial, true);
  assert.deepEqual(
    [(cancelled.answer as Row).cancelAtPeriodEnd, (cancelled.answer as Row).plan.trial, (cancelled.answer as Row).plan.name, "resetsAt" in (cancelled.answer as Row).plan],
    [true, true, "Free trial", false],
  );

  // A paid plan and a month with no count resume as they always did.
  const plan = await run({ priceCents: 900n, planId: "plan-1", includedUses: 500, extraUsePriceCents: 4n, cancelAtPeriodEnd: true }, false);
  assert.deepEqual([(plan.answer as Row).cancelAtPeriodEnd, plan.stored.cancelAtPeriodEnd, (plan.answer as Row).plan.trial], [false, false, false]);
  for (const priceCents of [900n, null]) {
    const month = await run({ priceCents, planId: null, includedUses: null, extraUsePriceCents: null, cancelAtPeriodEnd: true }, false);
    assert.deepEqual([(month.answer as Row).cancelAtPeriodEnd, month.stored.cancelAtPeriodEnd, (month.answer as Row).plan], [false, false, null]);
  }
});
