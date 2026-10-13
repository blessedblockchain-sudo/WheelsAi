import assert from "node:assert/strict";
import test from "node:test";

// The renewal tick's composition root reaches the hosted-model resolver,
// which reads the environment when it is imported.
import "./unitEnv.js";
import {
  InsufficientCreditsError,
  markPastDueOrExpire,
  renewSubscription,
  startMonthlySubscription,
  startPlanSubscription,
  SubscriptionClaimLostError,
  type ListingForBilling,
  type PlanStartTx,
  type PlanTerms,
  type SubscriptionRow,
  type SubscriptionTx,
} from "../services/marketplaceSubscriptions.js";
import { resolveInstallBilling } from "../services/marketplaceMetering.js";
import { runSubscriptionRenewalTick } from "../services/runSubscriptionRenewalTick.js";
import { installAccess, subscriptionGrantsAccess } from "../services/subscriptionAccess.js";
import { useAccess } from "../services/useAccess.js";
import { earningsStandIn, type EarningsRow } from "./earningsStandIn.js";

// Monthly marketplace subscriptions (claims ledger M1). What these pin:
// the first period is paid at install, a period is never charged twice,
// an unpaid renewal degrades to past_due then expired (never free), and
// cancelling stops renewal at the end of the paid period.

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-01T00:00:00Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

const LISTING: ListingForBilling = {
  id: "lst_1",
  title: "Research Analyst",
  publisherId: "org_pub",
  monthlyPriceCents: 1500n,
};

// ============================================
// In-memory transaction surface
// ============================================

interface State {
  balances: Map<string, bigint>;
  subs: Map<string, SubscriptionRow & { cancelledAt?: Date | null; lastRenewalAttemptAt?: Date | null }>;
  revenue: Array<Record<string, unknown>>;
  ledger: Array<Record<string, unknown>>;
  /** What each publisher is owed. */
  accrued: Map<string, bigint>;
  /** Each publisher's lifetime revenue. */
  lifetime: Map<string, bigint>;
  /** The publishers' ledger: one row for every change to what they are owed. */
  earnings: EarningsRow[];
  installs: Array<{ listingId: string; buyerId: string; status: string }>;
}

/**
 * The pause marker of each listing as the database holds it at this moment,
 * which is what a relation filter in a claim reads (`listing: { pausedSince:
 * null }`). Absent = not paused. A test sets one to stand for a deployment
 * that stopped after the row was loaded.
 */
const listingMarkerNow = new Map<string, Date>();

/**
 * The status of each plan as the database holds it at this moment, which is
 * what the relation filter of a plan's renewal claim reads (`plan: { status:
 * "active" }`). Absent = active. A test sets one to stand for a creator who
 * ended the plan after the row was loaded.
 */
const planStatusNow = new Map<string, string>();

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "plan") {
      return (planStatusNow.get(String(row.planId)) ?? "active") === (cond as { status: string }).status;
    }
    if (k === "listing") {
      const wanted = (cond as { pausedSince?: Date | null }).pausedSince;
      const held = listingMarkerNow.get(String(row.listingId)) ?? null;
      return wanted === null ? held === null : held !== null && wanted instanceof Date && held.getTime() === wanted.getTime();
    }
    const v = row[k];
    if (cond && typeof cond === "object" && "in" in (cond as object)) {
      return ((cond as { in: unknown[] }).in).includes(v);
    }
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    return v === cond;
  });
}

function makeDb(opts: { balance?: bigint; noProfile?: boolean } = {}) {
  const state: State = {
    balances: new Map([["org_buyer", opts.balance ?? 10_000n]]),
    subs: new Map(),
    revenue: [],
    ledger: [],
    accrued: new Map(),
    lifetime: new Map(),
    earnings: [],
    installs: [{ listingId: "lst_1", buyerId: "org_buyer", status: "active" }],
  };
  let seq = 0;

  const tx: SubscriptionTx = {
    // The publisher is credited through the ledger (moveEarnings). Every
    // organization has a profile here unless `noProfile` says none does.
    ...earningsStandIn({
      pending: (orgId) => (opts.noProfile ? undefined : (state.accrued.get(orgId) ?? 0n)),
      add: (orgId, pending, total) => {
        state.accrued.set(orgId, (state.accrued.get(orgId) ?? 0n) + pending);
        state.lifetime.set(orgId, (state.lifetime.get(orgId) ?? 0n) + total);
      },
      write: (row) => state.earnings.push(row),
    }),
    creditBalance: {
      async updateMany({ where, data }) {
        const bal = state.balances.get(where.orgId) ?? 0n;
        if (bal < where.balanceCents.gte) return { count: 0 };
        state.balances.set(where.orgId, bal - data.balanceCents.decrement);
        return { count: 1 };
      },
      async findUnique({ where }) {
        const bal = state.balances.get(where.orgId);
        return bal === undefined ? null : { balanceCents: bal };
      },
    },
    creditTransaction: {
      async create({ data }) {
        state.ledger.push(data);
        return data;
      },
    },
    marketplaceRevenue: {
      async create({ data }) {
        const row = { id: `rev_${++seq}`, ...data };
        state.revenue.push(row);
        return row;
      },
    },
    agentSubscription: {
      async findUnique({ where, include }) {
        const key = where.listingId_subscriberId;
        const existing = [...state.subs.values()].find(
          (s) => s.listingId === key.listingId && s.subscriberId === key.subscriberId,
        );
        if (!existing) return null;
        // The row's plan, only for a read that asks for it.
        if (!include) return { ...existing };
        const planId = existing.planId ?? null;
        return { ...existing, plan: planId === null ? null : { status: planStatusNow.get(planId) ?? "active" } };
      },
      async create({ data }) {
        // The unique (listingId, subscriberId), as the database enforces it.
        const taken = [...state.subs.values()].some(
          (s) => s.listingId === data.listingId && s.subscriberId === data.subscriberId,
        );
        if (taken) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        const row = { id: `sub_${++seq}`, ...data } as unknown as SubscriptionRow;
        state.subs.set(row.id, row);
        return { ...row };
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const s of state.subs.values()) {
          if (matches(s as unknown as Record<string, unknown>, where)) {
            Object.assign(s, data);
            count++;
          }
        }
        return { count };
      },
    },
    agentInstall: {
      async updateMany({ where, data }) {
        let count = 0;
        for (const i of state.installs) {
          if (matches(i, where as Record<string, unknown>)) {
            i.status = data.status;
            count++;
          }
        }
        return { count };
      },
    },
  };

  // Snapshot/restore stands in for a database transaction's rollback.
  async function inTransaction<T>(fn: (t: SubscriptionTx) => Promise<T>): Promise<T> {
    const snapshot = structuredClone({
      balances: state.balances,
      subs: state.subs,
      revenue: state.revenue,
      ledger: state.ledger,
      accrued: state.accrued,
      lifetime: state.lifetime,
      earnings: state.earnings,
      installs: state.installs,
    });
    try {
      return await fn(tx);
    } catch (err) {
      Object.assign(state, snapshot);
      throw err;
    }
  }

  const first = () => [...state.subs.values()][0]!;
  const sub = (): SubscriptionRow => ({ ...first() });
  return { state, tx, inTransaction, sub, first };
}

// ============================================
// Start
// ============================================

test("subscribing charges the first period once and opens a 30-day period", async () => {
  const { state, inTransaction, sub } = makeDb();
  await inTransaction((tx) => startMonthlySubscription(tx, { listing: LISTING, buyerId: "org_buyer", installId: "ins_1", now: T0 }));

  assert.equal(state.balances.get("org_buyer"), 8_500n);
  assert.equal(state.revenue.length, 1);
  assert.deepEqual(
    {
      type: state.revenue[0]!.type,
      status: state.revenue[0]!.status,
      gross: state.revenue[0]!.grossAmountCents,
      fee: state.revenue[0]!.platformFeeCents,
      creator: state.revenue[0]!.creatorAmountCents,
      installId: state.revenue[0]!.installId,
    },
    { type: "subscription", status: "settled", gross: 1500n, fee: 150n, creator: 1350n, installId: "ins_1" },
  );
  assert.equal(state.accrued.get("org_pub"), 1350n);
  assert.equal(state.lifetime.get("org_pub"), 1350n);
  // The credit has its ledger row: a subscription, against the revenue row
  // the buyer's debit points at, with the balance it left.
  assert.deepEqual(state.earnings, [
    {
      orgId: "org_pub",
      amountCents: 1350n,
      type: "subscription",
      referenceId: state.revenue[0]!.id,
      description: "Subscription: Research Analyst",
      balanceAfter: 1350n,
    },
  ]);
  assert.equal(state.ledger[0]!.referenceId, state.revenue[0]!.id);
  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0]!.amountCents, -1500n);
  assert.equal(state.ledger[0]!.balanceAfter, 8_500n);
  assert.equal(state.ledger[0]!.type, "marketplace_subscription");

  const s = sub();
  assert.equal(s.status, "active");
  assert.equal(s.currentPeriodEnd.getTime(), at(30).getTime());
  assert.equal(s.cancelAtPeriodEnd, false);
});

test("a buyer who cannot pay gets no subscription and no charge", async () => {
  const { state, inTransaction } = makeDb({ balance: 1_499n });
  await assert.rejects(
    inTransaction((tx) => startMonthlySubscription(tx, { listing: LISTING, buyerId: "org_buyer", now: T0 })),
    (err: unknown) => err instanceof InsufficientCreditsError && err.requiredCents === 1500n,
  );
  assert.equal(state.balances.get("org_buyer"), 1_499n);
  assert.equal(state.subs.size, 0);
  assert.equal(state.revenue.length, 0);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.earnings.length, 0);
});

test("a period for a publisher with no profile throws, and the whole charge rolls back", async () => {
  const { state, inTransaction } = makeDb({ noProfile: true });
  await assert.rejects(
    inTransaction((tx) => startMonthlySubscription(tx, { listing: LISTING, buyerId: "org_buyer", now: T0 })),
    /No publisher profile to credit a subscription to \(organization org_pub\)/,
  );
  assert.equal(state.balances.get("org_buyer"), 10_000n);
  assert.equal(state.subs.size, 0);
  assert.equal(state.revenue.length, 0);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.earnings.length, 0);
  assert.equal(state.accrued.size, 0);
});

test("a listing without a monthly price cannot start a subscription", async () => {
  const { inTransaction } = makeDb();
  await assert.rejects(
    inTransaction((tx) =>
      startMonthlySubscription(tx, { listing: { ...LISTING, monthlyPriceCents: 0n }, buyerId: "org_buyer", now: T0 }),
    ),
    /no monthly price/,
  );
});

// ============================================
// Renew
// ============================================

async function subscribed(opts: { balance?: bigint } = {}) {
  const db = makeDb(opts);
  await db.inTransaction((tx) => startMonthlySubscription(tx, { listing: LISTING, buyerId: "org_buyer", now: T0 }));
  return db;
}

test("a subscription is not renewed before its period ends", async () => {
  const { state, inTransaction, sub } = await subscribed();
  const outcome = await inTransaction((tx) => renewSubscription(tx, { sub: sub(), listing: LISTING, now: at(29) }));
  assert.deepEqual(outcome, { kind: "not_due" });
  assert.equal(state.revenue.length, 1);
});

test("a due subscription renews from the old period end, charged as a renewal", async () => {
  const { state, inTransaction, sub } = await subscribed();
  const outcome = await inTransaction((tx) => renewSubscription(tx, { sub: sub(), listing: LISTING, now: at(30.5) }));

  assert.equal(outcome.kind, "renewed");
  const s = sub();
  // Anchored to the period, not to when the worker happened to run.
  assert.equal(s.currentPeriodStart.getTime(), at(30).getTime());
  assert.equal(s.currentPeriodEnd.getTime(), at(60).getTime());
  assert.equal(state.balances.get("org_buyer"), 7_000n);
  assert.equal(state.revenue[1]!.type, "subscription_renewal");
  assert.equal(state.accrued.get("org_pub"), 2_700n);
  assert.equal(state.lifetime.get("org_pub"), 2_700n);
  // The renewal is a second row, against its own revenue row, carrying
  // the balance the two periods left.
  assert.deepEqual(
    state.earnings.map((row) => [row.type, row.amountCents, row.referenceId, row.description, row.balanceAfter]),
    [
      ["subscription", 1350n, state.revenue[0]!.id, "Subscription: Research Analyst", 1350n],
      ["subscription", 1350n, state.revenue[1]!.id, "Renewal: Research Analyst", 2_700n],
    ],
  );
});

test("two workers renewing the same period charge it once", async () => {
  const { state, inTransaction, sub } = await subscribed();
  const stale = sub();
  const [a, b] = await Promise.all([
    inTransaction((tx) => renewSubscription(tx, { sub: stale, listing: LISTING, now: at(31) })),
    inTransaction((tx) => renewSubscription(tx, { sub: stale, listing: LISTING, now: at(31) })),
  ]);
  assert.deepEqual([a.kind, b.kind].sort(), ["lost_race", "renewed"]);
  assert.equal(state.balances.get("org_buyer"), 7_000n);
  assert.equal(state.revenue.length, 2);
  assert.equal(state.ledger.length, 2);
});

test("cancel at period end closes the subscription without charging and suspends the install", async () => {
  const { state, inTransaction, sub, first } = await subscribed();
  first().cancelAtPeriodEnd = true;

  const outcome = await inTransaction((tx) => renewSubscription(tx, { sub: sub(), listing: LISTING, now: at(30) }));
  assert.deepEqual(outcome, { kind: "cancelled" });
  assert.equal(sub().status, "cancelled");
  assert.equal(state.installs[0]!.status, "suspended");
  assert.equal(state.balances.get("org_buyer"), 8_500n);
  assert.equal(state.revenue.length, 1);
});

test("an unpaid renewal rolls back entirely — the period is not advanced for free", async () => {
  const { state, inTransaction, sub } = await subscribed({ balance: 1_500n });
  await assert.rejects(
    inTransaction((tx) => renewSubscription(tx, { sub: sub(), listing: LISTING, now: at(30) })),
    InsufficientCreditsError,
  );
  assert.equal(sub().currentPeriodEnd.getTime(), at(30).getTime());
  assert.equal(state.revenue.length, 1);
});

// ============================================
// Past due / expiry
// ============================================

test("an unpaid renewal goes past_due during grace, then expires and suspends the install", async () => {
  const { state, inTransaction, sub } = await subscribed({ balance: 1_500n });

  assert.equal(await inTransaction((tx) => markPastDueOrExpire(tx, { sub: sub(), now: at(31) })), "past_due");
  assert.equal(sub().status, "past_due");
  assert.equal(state.installs[0]!.status, "active");
  assert.equal(subscriptionGrantsAccess(sub(), at(31)), true);

  assert.equal(await inTransaction((tx) => markPastDueOrExpire(tx, { sub: sub(), now: at(33.5) })), "expired");
  assert.equal(sub().status, "expired");
  assert.equal(state.installs[0]!.status, "suspended");
  assert.equal(subscriptionGrantsAccess(sub(), at(33.5)), false);
});

// ============================================
// Tick
// ============================================

function tickDeps(db: Awaited<ReturnType<typeof subscribed>>, now: Date) {
  return {
    now: () => now,
    // No listing is paused in these tests unless one says so.
    reconcilePauses: async () => {},
    // Never-tried first, then least recently tried, then oldest period:
    // the order buildSubscriptionRenewalTickDeps asks the database for.
    loadDue: async ({ now: n, limit, excludeIds }: { now: Date; limit: number; excludeIds: string[] }) =>
      [...db.state.subs.values()]
        .filter((s) => s.currentPeriodEnd <= n && (s.status === "active" || s.status === "past_due"))
        .filter((s) => !excludeIds.includes(s.id))
        .sort(
          (a, b) =>
            (a.lastRenewalAttemptAt?.getTime() ?? -1) - (b.lastRenewalAttemptAt?.getTime() ?? -1) ||
            a.currentPeriodEnd.getTime() - b.currentPeriodEnd.getTime(),
        )
        .slice(0, limit)
        .map((s) => ({ sub: { ...s }, listing: LISTING })),
    inTransaction: db.inTransaction,
    recordAttempt: async (id: string, at: Date) => {
      const row = db.state.subs.get(id);
      if (row) row.lastRenewalAttemptAt = at;
    },
  };
}

test("the tick renews what is due and degrades what cannot pay", async () => {
  const funded = await subscribed();
  assert.deepEqual(await runSubscriptionRenewalTick(tickDeps(funded, at(30))), {
    scanned: 1, renewed: 1, cancelled: 0, paused: 0, pastDue: 0, expired: 0, errors: 0,
  });

  const broke = await subscribed({ balance: 1_500n });
  assert.deepEqual(await runSubscriptionRenewalTick(tickDeps(broke, at(30.1))), {
    scanned: 1, renewed: 0, cancelled: 0, paused: 0, pastDue: 1, expired: 0, errors: 0,
  });
  // Grace retries: topping up inside the window renews and restores active.
  broke.state.balances.set("org_buyer", 5_000n);
  assert.deepEqual(await runSubscriptionRenewalTick(tickDeps(broke, at(31))), {
    scanned: 1, renewed: 1, cancelled: 0, paused: 0, pastDue: 0, expired: 0, errors: 0,
  });
  assert.equal(broke.sub().status, "active");
  assert.equal(broke.sub().currentPeriodEnd.getTime(), at(60).getTime());
});

test("the tick expires a subscription still unpaid after grace", async () => {
  const db = await subscribed({ balance: 1_500n });
  await runSubscriptionRenewalTick(tickDeps(db, at(30.1)));
  const result = await runSubscriptionRenewalTick(tickDeps(db, at(34)));
  assert.equal(result.expired, 1);
  assert.equal(db.sub().status, "expired");
  assert.equal(db.state.installs[0]!.status, "suspended");
});

test("one failing subscription does not stop the batch", async () => {
  const db = await subscribed();
  let calls = 0;
  const deps = tickDeps(db, at(30));
  const result = await runSubscriptionRenewalTick({
    ...deps,
    loadDue: async (args: { now: Date; limit: number; excludeIds: string[] }) => {
      if (args.excludeIds.length > 0) return [];
      const [row] = await deps.loadDue(args);
      return [{ sub: { ...row!.sub, id: "sub_broken" }, listing: LISTING }, row!];
    },
    inTransaction: async (fn) => {
      if (calls++ === 0) throw new Error("connection reset");
      return db.inTransaction(fn);
    },
  });
  assert.equal(result.errors, 1);
  assert.equal(result.renewed, 1);
});

// ============================================
// Access
// ============================================

test("access: paid period plus grace, no grace once cancelled, never after expiry", () => {
  const base = { status: "active", currentPeriodEnd: at(30) };
  assert.equal(subscriptionGrantsAccess(null, at(1)), false);
  assert.equal(subscriptionGrantsAccess(base, at(29)), true);
  assert.equal(subscriptionGrantsAccess(base, at(32)), true);
  assert.equal(subscriptionGrantsAccess(base, at(33)), false);
  assert.equal(subscriptionGrantsAccess({ ...base, cancelAtPeriodEnd: true }, at(29)), true);
  assert.equal(subscriptionGrantsAccess({ ...base, cancelAtPeriodEnd: true }, at(30.01)), false);
  for (const status of ["cancelled", "expired"]) {
    assert.equal(subscriptionGrantsAccess({ ...base, status }, at(1)), false, status);
  }
});

function monthlyLookup(sub: { status: string; currentPeriodEnd: Date; cancelAtPeriodEnd: boolean } | null, withTable = true) {
  return {
    agentInstall: {
      findFirst: async () => ({
        id: "ins_1",
        listingId: "lst_1",
        buyerId: "org_buyer",
        status: "active",
        listing: { title: "Research Analyst", status: "published", publisherId: "org_pub", pricingModel: "monthly", pricePerRequestCents: null },
      }),
    },
    ...(withTable ? { agentSubscription: { findUnique: async () => sub } } : {}),
  };
}

test("a monthly install runs while its subscription grants access, and is revoked otherwise", async () => {
  const future = new Date(Date.now() + 10 * DAY);
  const past = new Date(Date.now() - 10 * DAY);
  const args = { agentId: "agent_clone", orgId: "org_buyer" };

  assert.deepEqual(
    await resolveInstallBilling(monthlyLookup({ status: "active", currentPeriodEnd: future, cancelAtPeriodEnd: false }) as never, args),
    { kind: "free" },
  );
  for (const sub of [
    null,
    { status: "expired", currentPeriodEnd: future, cancelAtPeriodEnd: false },
    { status: "past_due", currentPeriodEnd: past, cancelAtPeriodEnd: false },
  ]) {
    assert.deepEqual(
      await resolveInstallBilling(monthlyLookup(sub) as never, args),
      { kind: "revoked", listingTitle: "Research Analyst", reason: "subscription_lapsed" },
      JSON.stringify(sub),
    );
  }
  // A lookup surface without the subscription table fails closed.
  assert.deepEqual(await resolveInstallBilling(monthlyLookup(null, false) as never, args), {
    kind: "revoked",
    listingTitle: "Research Analyst",
    reason: "subscription_lapsed",
  });
});

test("a renewal after the listing left monthly pricing ends the subscription, names the pricing change and suspends the install", async () => {
  const { state, inTransaction, sub } = await subscribed();
  const outcome = await inTransaction((tx) =>
    renewSubscription(tx, { sub: sub(), listing: { ...LISTING, pricingModel: "per_request" }, now: at(30) }),
  );
  assert.deepEqual(outcome, { kind: "cancelled" });
  assert.equal(sub().status, "cancelled");
  assert.equal(sub().endReason, "pricing_changed");
  // Left active, the install would now be billed per request at a price
  // the buyer never accepted.
  assert.equal(state.installs[0]!.status, "suspended");
  assert.equal(state.revenue.length, 1);
  assert.equal(state.balances.get("org_buyer"), 8_500n);
});

// ============================================
// Review fixes: agreed price, archived listings, mid-tick cancel, backlog
// ============================================

test("renewals charge the price the buyer agreed to, not the listing's new price", async () => {
  const { state, inTransaction, sub } = await subscribed();
  assert.equal(sub().priceCents, 1500n);
  const raised = { ...LISTING, monthlyPriceCents: 10_000_000n };
  const outcome = await inTransaction((tx) => renewSubscription(tx, { sub: sub(), listing: raised, now: at(30) }));
  assert.equal(outcome.kind, "renewed");
  assert.equal(state.balances.get("org_buyer"), 7_000n);
  assert.equal(state.revenue[1]!.grossAmountCents, 1500n);
});

test("an archived listing stops renewing without a charge and keeps the install", async () => {
  const { state, inTransaction, sub } = await subscribed();
  assert.equal(sub().endReason, null);
  const outcome = await inTransaction((tx) =>
    renewSubscription(tx, { sub: sub(), listing: { ...LISTING, status: "archived" }, now: at(30) }),
  );
  assert.deepEqual(outcome, { kind: "cancelled" });
  assert.equal(state.revenue.length, 1);
  assert.equal(state.installs[0]!.status, "active");
  // Recorded, so publishing the listing again cannot start charging.
  assert.equal(sub().endReason, "listing_archived");
});

test("a cancel that lands after the tick loaded the row is not charged", async () => {
  const { state, inTransaction, sub, first } = await subscribed();
  const loaded = sub(); // the tick read it before the buyer cancelled
  first().cancelAtPeriodEnd = true;
  const outcome = await inTransaction((tx) => renewSubscription(tx, { sub: loaded, listing: LISTING, now: at(30) }));
  assert.deepEqual(outcome, { kind: "lost_race" });
  assert.equal(state.balances.get("org_buyer"), 8_500n);
  assert.equal(state.revenue.length, 1);
});

test("rows that keep failing cannot starve the rest of the backlog", async () => {
  const db = await subscribed();
  const brokenId = db.first().id;
  // A second, healthy due subscription for another listing, after the
  // broken one in load order.
  db.state.subs.set("sub_ok", { ...db.first(), id: "sub_ok", listingId: "lst_2" });
  const base = tickDeps(db, at(30));
  const result = await runSubscriptionRenewalTick(
    {
      ...base,
      // Every write to the broken subscription fails.
      inTransaction: (fn) =>
        db.inTransaction((tx) =>
          fn({
            ...tx,
            agentSubscription: {
              ...tx.agentSubscription,
              updateMany: async (args) => {
                if ((args.where as { id?: string }).id === brokenId) throw new Error("row is poisoned");
                return tx.agentSubscription.updateMany(args);
              },
            },
          }),
        ),
    },
    { batchSize: 1 },
  );
  assert.equal(result.errors, 1);
  assert.equal(result.renewed, 1);
  assert.equal(db.state.subs.get("sub_ok")!.currentPeriodEnd.getTime(), at(60).getTime());
});

test("a paid-up subscription keeps access after the listing leaves monthly pricing", async () => {
  const future = new Date(Date.now() + 10 * DAY);
  const lookup = {
    ...monthlyLookup({ status: "active", currentPeriodEnd: future, cancelAtPeriodEnd: false }),
    agentInstall: {
      findFirst: async () => ({
        id: "ins_1",
        listingId: "lst_1",
        buyerId: "org_buyer",
        status: "active",
        listing: { title: "Research Analyst", status: "published", publisherId: "org_pub", pricingModel: "per_request", pricePerRequestCents: 50n },
      }),
    },
  };
  assert.deepEqual(await resolveInstallBilling(lookup as never, { agentId: "a", orgId: "org_buyer" }), { kind: "free" });
});

// ============================================
// Fix pass: exclusive subscribe claim
// ============================================

/** A subscription that exists but grants no access (ended, or unpaid past grace). */
async function lapsed(status: "cancelled" | "expired" | "past_due" | "active", balance = 10_000n) {
  const db = await subscribed({ balance });
  Object.assign(db.first(), { status, currentPeriodEnd: at(30) });
  return db;
}

test("subscribing while already paid up is refused without a charge", async () => {
  const { state, inTransaction } = await subscribed();
  await assert.rejects(
    inTransaction((tx) => startMonthlySubscription(tx, { listing: LISTING, buyerId: "org_buyer", now: at(5) })),
    SubscriptionClaimLostError,
  );
  assert.equal(state.balances.get("org_buyer"), 8_500n);
  assert.equal(state.revenue.length, 1);
  assert.equal(state.ledger.length, 1);
});

test("two concurrent first subscribes charge once: the second create hits the unique constraint", async () => {
  const { state, tx } = makeDb();
  // Not through inTransaction: its snapshot rollback would also undo the
  // winner. Each call stops at its first failed write, before any debit.
  const results = await Promise.allSettled([
    startMonthlySubscription(tx, { listing: LISTING, buyerId: "org_buyer", now: T0 }),
    startMonthlySubscription(tx, { listing: LISTING, buyerId: "org_buyer", now: T0 }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  // Left to abort the transaction: never caught inside it.
  assert.equal((rejected.reason as { code?: string }).code, "P2002");
  assert.equal(state.balances.get("org_buyer"), 8_500n);
  assert.equal(state.revenue.length, 1);
  assert.equal(state.ledger.length, 1);
  assert.equal(state.subs.size, 1);
});

for (const status of ["cancelled", "expired", "past_due", "active"] as const) {
  test(`two concurrent resubscribes on a ${status} subscription charge once`, async () => {
    const { state, tx } = await lapsed(status);
    const now = at(40); // past the period end and the grace window
    const results = await Promise.allSettled([
      startMonthlySubscription(tx, { listing: LISTING, buyerId: "org_buyer", now }),
      startMonthlySubscription(tx, { listing: LISTING, buyerId: "org_buyer", now }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof SubscriptionClaimLostError);
    // One first period at T0, one resubscription: never a third debit.
    assert.equal(state.balances.get("org_buyer"), 7_000n);
    assert.equal(state.revenue.length, 2);
    assert.equal(state.ledger.length, 2);
    assert.equal([...state.subs.values()][0]!.currentPeriodEnd.getTime(), at(70).getTime());
  });
}

test("a resubscribe that read the row before the renewal worker renewed it does not charge again", async () => {
  const { state, tx, sub } = await lapsed("past_due");
  const now = at(40);
  // The worker renews between this request's read and its claim.
  const racing: SubscriptionTx = {
    ...tx,
    agentSubscription: {
      ...tx.agentSubscription,
      findUnique: async (args) => {
        const read = await tx.agentSubscription.findUnique(args);
        const renewed = await renewSubscription(tx, { sub: sub(), listing: LISTING, now });
        assert.equal(renewed.kind, "renewed");
        return read;
      },
    },
  };
  await assert.rejects(
    startMonthlySubscription(racing, { listing: LISTING, buyerId: "org_buyer", now }),
    SubscriptionClaimLostError,
  );
  // The first period and the renewal; the resubscribe added nothing and
  // did not overwrite the renewed period.
  assert.equal(state.balances.get("org_buyer"), 7_000n);
  assert.deepEqual(state.revenue.map((r) => r.type), ["subscription", "subscription_renewal"]);
  assert.equal(sub().currentPeriodEnd.getTime(), at(60).getTime());
});

test("the renewal worker loses to a resubscribe that claimed the row first", async () => {
  const { state, tx, sub } = await lapsed("past_due");
  const loaded = sub(); // the tick read it, then the buyer resubscribed
  await startMonthlySubscription(tx, { listing: LISTING, buyerId: "org_buyer", now: at(40) });
  assert.deepEqual(await renewSubscription(tx, { sub: loaded, listing: LISTING, now: at(40) }), { kind: "lost_race" });
  assert.equal(state.balances.get("org_buyer"), 7_000n);
  assert.equal(state.revenue.length, 2);
});

test("resubscribing after a pricing change clears the reason and stores the newly agreed price", async () => {
  const { tx, sub, first } = await lapsed("cancelled");
  first().endReason = "pricing_changed";
  await startMonthlySubscription(tx, {
    listing: { ...LISTING, monthlyPriceCents: 2_000n },
    buyerId: "org_buyer",
    now: at(40),
  });
  assert.equal(sub().endReason, null);
  assert.equal(sub().priceCents, 2_000n);
  assert.equal(sub().status, "active");
});

// ============================================
// Fix pass: no price, no renewal
// ============================================

test("a subscription with no agreed price is not renewed at the listing's current price", async () => {
  const { state, inTransaction, sub, first } = await subscribed();
  first().priceCents = null; // a row from before the price was stored
  const raised = { ...LISTING, pricingModel: "monthly", status: "published", monthlyPriceCents: 9_000n };
  const outcome = await inTransaction((tx) => renewSubscription(tx, { sub: sub(), listing: raised, now: at(30) }));
  assert.deepEqual(outcome, { kind: "cancelled" });
  assert.equal(sub().endReason, "pricing_changed");
  assert.equal(state.installs[0]!.status, "suspended");
  assert.equal(state.balances.get("org_buyer"), 8_500n);
  assert.equal(state.revenue.length, 1);
});

// ============================================
// Fix pass: starvation across ticks
// ============================================

test("rows that fail every tick rotate behind rows that have not been tried", async () => {
  const db = await subscribed();
  const template = db.first();
  db.state.subs.clear();
  // More always-failing rows than one tick can load (2 batches of 2), all
  // due before the healthy one.
  const poisoned = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const id = `sub_bad_${i}`;
    poisoned.add(id);
    db.state.subs.set(id, { ...template, id, listingId: `lst_bad_${i}`, currentPeriodEnd: at(20 + i) });
  }
  db.state.subs.set("sub_ok", { ...template, id: "sub_ok", listingId: "lst_ok", currentPeriodEnd: at(30) });

  const deps = (now: Date) => {
    const base = tickDeps(db, now);
    return {
      ...base,
      inTransaction: <T>(fn: (tx: SubscriptionTx) => Promise<T>) =>
        db.inTransaction((tx) =>
          fn({
            ...tx,
            agentSubscription: {
              ...tx.agentSubscription,
              updateMany: async (args) => {
                if (poisoned.has((args.where as { id?: string }).id ?? "")) throw new Error("row is poisoned");
                return tx.agentSubscription.updateMany(args);
              },
            },
          }),
        ),
    };
  };
  const opts = { batchSize: 2, maxBatches: 2 };

  // Tick 1 spends its whole budget on the four oldest failing rows.
  assert.deepEqual(await runSubscriptionRenewalTick(deps(at(31)), opts), {
    scanned: 4, renewed: 0, cancelled: 0, paused: 0, pastDue: 0, expired: 0, errors: 4,
  });
  assert.equal(db.state.subs.get("sub_ok")!.currentPeriodEnd.getTime(), at(30).getTime());

  // Tick 2 starts with the rows not yet tried, which include the healthy
  // one. Before, it reloaded the same four and never reached it.
  const second = await runSubscriptionRenewalTick(deps(at(31.1)), opts);
  assert.equal(second.renewed, 1);
  assert.equal(db.state.subs.get("sub_ok")!.currentPeriodEnd.getTime(), at(60).getTime());

  // And no failing row is dropped: every one was tried within two ticks.
  for (const id of poisoned) assert.ok(db.state.subs.get(id)!.lastRenewalAttemptAt, id);
});

test("a past_due row inside grace is stamped, and a renewed row is not left at the back", async () => {
  const db = await subscribed({ balance: 1_500n });
  await runSubscriptionRenewalTick(tickDeps(db, at(30.1)));
  assert.equal(db.first().lastRenewalAttemptAt?.getTime(), at(30.1).getTime());
  db.state.balances.set("org_buyer", 5_000n);
  await runSubscriptionRenewalTick(tickDeps(db, at(31)));
  assert.equal(db.first().status, "active");
  assert.equal(db.first().lastRenewalAttemptAt, null);
});

// ============================================
// Fix pass: one access rule for billing and the installs list
// ============================================

test("install access: what runs, what is paused, and why", () => {
  const paid = { status: "active", currentPeriodEnd: at(30), cancelAtPeriodEnd: false, endReason: null };
  const ended = (endReason: string | null) => ({ ...paid, status: "cancelled", endReason });
  const now = at(10);
  // The buyer here agreed to the listing's pricing model as it stands, so
  // what is decided is the subscription's part of the rule. The accepted
  // price is covered in "the pricing a buyer accepted" below.
  const agreedTo = (pricingModel: string) => ({ pricingModel, pricePerRequestCents: 5n });
  const access = (installStatus: string, listingStatus: string, pricingModel: string, sub: Parameters<typeof installAccess>[0]["sub"]) =>
    installAccess(
      { installStatus, listingStatus, pricingModel, pricePerRequestCents: 5n, accepted: agreedTo(pricingModel), sub },
      now,
    );

  assert.equal(access("uninstalled", "published", "monthly", paid), "uninstalled");
  assert.equal(access("active", "published", "monthly", paid), "subscribed");
  // A paid period outlives a switch away from monthly pricing.
  assert.equal(access("active", "published", "per_request", paid), "subscribed");
  assert.equal(access("active", "published", "monthly", null), "subscription_lapsed");
  assert.equal(access("active", "published", "monthly", ended(null)), "subscription_lapsed");
  assert.equal(access("suspended", "published", "monthly", ended(null)), "subscription_lapsed");
  assert.equal(access("suspended", "published", "per_request", ended("pricing_changed")), "pricing_changed");
  // An archived listing charges nobody and its installs keep running...
  assert.equal(access("active", "archived", "monthly", ended("listing_archived")), "unlisted");
  assert.equal(access("active", "archived", "monthly", null), "unlisted");
  // ...but publishing it again does not put the buyer on its pricing.
  assert.equal(access("active", "published", "per_request", ended("listing_archived")), "pricing_changed");
  assert.equal(access("active", "published", "monthly", ended("listing_archived")), "pricing_changed");
  assert.equal(access("active", "published", "per_request", null), "listing_pricing");
  assert.equal(access("active", "published", "free", ended(null)), "listing_pricing");

  // A period that ran out before the renewal worker closed the row: the
  // answer does not depend on the worker having run.
  const ranOut = { ...paid, currentPeriodEnd: at(9) };
  const after = (days: number, sub: Parameters<typeof installAccess>[0]["sub"], pricingModel = "per_request") =>
    installAccess(
      {
        installStatus: "active",
        listingStatus: "published",
        pricingModel,
        pricePerRequestCents: 5n,
        accepted: agreedTo(pricingModel),
        sub,
      },
      at(days),
    );
  // Cancelled renewal: no grace, so paused from the moment the period ends.
  assert.equal(after(9.001, { ...ranOut, cancelAtPeriodEnd: true }), "pricing_changed");
  // Otherwise the grace window is honoured, then paused, never billed.
  assert.equal(after(11, ranOut), "subscribed");
  assert.equal(after(12.001, ranOut), "pricing_changed");
  assert.equal(after(40, { ...ranOut, status: "past_due" }), "pricing_changed");
  assert.equal(after(40, ranOut, "free"), "pricing_changed");
  assert.equal(after(40, ranOut, "tokenized"), "pricing_changed");
  assert.equal(after(40, ranOut, "monthly"), "subscription_lapsed");
  // A suspended install on a listing that left monthly is new terms,
  // however the subscription ended.
  assert.equal(access("suspended", "published", "per_request", { ...ended(null), status: "expired" }), "pricing_changed");
  assert.equal(access("suspended", "published", "per_request", ended(null)), "pricing_changed");
  assert.equal(access("suspended", "published", "monthly", { ...ended(null), status: "expired" }), "subscription_lapsed");
});

test("install access: the pricing a buyer accepted", () => {
  const access = (
    listing: { pricingModel: string; pricePerRequestCents?: bigint | null },
    accepted: { pricingModel: string | null; pricePerRequestCents: bigint | null },
    sub: Parameters<typeof installAccess>[0]["sub"] = null,
  ) => installAccess({ installStatus: "active", listingStatus: "published", ...listing, accepted, sub }, at(10));
  const perRequest = (cents: bigint) => ({ pricingModel: "per_request", pricePerRequestCents: cents });

  // Per request: covered up to the accepted price, paused above it.
  assert.equal(access(perRequest(5n), perRequest(5n)), "listing_pricing");
  assert.equal(access(perRequest(4n), perRequest(5n)), "listing_pricing");
  assert.equal(access(perRequest(6n), perRequest(5n)), "pricing_changed");
  // A zero price is free in effect.
  assert.equal(access(perRequest(0n), { pricingModel: "free", pricePerRequestCents: null }), "listing_pricing");
  // A different model is new terms, except free.
  assert.equal(access(perRequest(1n), { pricingModel: "free", pricePerRequestCents: null }), "pricing_changed");
  assert.equal(access({ pricingModel: "tokenized" }, perRequest(5n)), "pricing_changed");
  assert.equal(access({ pricingModel: "tokenized" }, { pricingModel: "tokenized", pricePerRequestCents: null }), "listing_pricing");
  assert.equal(access({ pricingModel: "free" }, perRequest(5n)), "listing_pricing");
  assert.equal(access({ pricingModel: "free" }, { pricingModel: "tokenized", pricePerRequestCents: null }), "listing_pricing");
  // Monthly, for an install that agreed to something else: accept, not "lapsed".
  assert.equal(access({ pricingModel: "monthly" }, perRequest(5n)), "pricing_changed");
  assert.equal(access({ pricingModel: "monthly" }, { pricingModel: "monthly", pricePerRequestCents: null }), "subscription_lapsed");
  // A buyer who cancelled a monthly subscription themselves, on a listing
  // that has since gone per-request, used to fall straight onto it.
  const cancelledByBuyer = { status: "cancelled", currentPeriodEnd: at(5), cancelAtPeriodEnd: false, endReason: null };
  assert.equal(
    access(perRequest(5n), { pricingModel: "monthly", pricePerRequestCents: null }, cancelledByBuyer),
    "pricing_changed",
  );
  // Nothing on record: only free pricing runs.
  assert.equal(access(perRequest(5n), { pricingModel: null, pricePerRequestCents: null }), "pricing_changed");
  assert.equal(access({ pricingModel: "free" }, { pricingModel: null, pricePerRequestCents: null }), "listing_pricing");
  // A paid-up subscription still outranks all of it.
  const paid = { status: "active", currentPeriodEnd: at(30), cancelAtPeriodEnd: false, endReason: null };
  assert.equal(access(perRequest(900n), { pricingModel: "monthly", pricePerRequestCents: null }, paid), "subscribed");
});

function billingLookup(
  install: {
    status: string;
    listingStatus?: string;
    pricingModel: string;
    pricePerRequestCents?: bigint | null;
    /** What the buyer agreed to. Default: the listing as it stands. */
    acceptedPricingModel?: string | null;
    acceptedPricePerRequestCents?: bigint | null;
  },
  sub: { status: string; currentPeriodEnd: Date; cancelAtPeriodEnd: boolean; endReason?: string | null } | null,
) {
  return {
    agentInstall: {
      findFirst: async () => ({
        id: "ins_1",
        listingId: "lst_1",
        buyerId: "org_buyer",
        status: install.status,
        acceptedPricingModel: install.acceptedPricingModel ?? install.pricingModel,
        acceptedPricePerRequestCents:
          install.acceptedPricePerRequestCents !== undefined
            ? install.acceptedPricePerRequestCents
            : (install.pricePerRequestCents ?? null),
        listing: {
          title: "Research Analyst",
          status: install.listingStatus ?? "published",
          publisherId: "org_pub",
          pricingModel: install.pricingModel,
          pricePerRequestCents: install.pricePerRequestCents ?? null,
        },
      }),
    },
    agentSubscription: { findUnique: async () => sub },
  };
}

test("a subscriber is never billed per request after the listing switched: the clone is revoked until they accept", async () => {
  const past = new Date(Date.now() - 10 * DAY);
  const args = { agentId: "agent_clone", orgId: "org_buyer" };
  const ended = { status: "cancelled", currentPeriodEnd: past, cancelAtPeriodEnd: false };
  const perRequest = { pricingModel: "per_request", pricePerRequestCents: 100_000n };

  // What the renewal leaves behind: a suspended install and the reason.
  assert.deepEqual(
    await resolveInstallBilling(
      billingLookup({ status: "suspended", ...perRequest }, { ...ended, endReason: "pricing_changed" }) as never,
      args,
    ),
    { kind: "revoked", listingTitle: "Research Analyst", reason: "pricing_changed" },
  );
  // Even if the install row were still active, nothing is billable.
  assert.deepEqual(
    await resolveInstallBilling(
      billingLookup({ status: "active", ...perRequest }, { ...ended, endReason: "pricing_changed" }) as never,
      args,
    ),
    { kind: "revoked", listingTitle: "Research Analyst", reason: "pricing_changed" },
  );
  // An archived listing that comes back as per-request.
  assert.deepEqual(
    await resolveInstallBilling(
      billingLookup({ status: "active", ...perRequest }, { ...ended, endReason: "listing_archived" }) as never,
      args,
    ),
    { kind: "revoked", listingTitle: "Research Analyst", reason: "pricing_changed" },
  );
  // Once accepted (the reason is cleared) the listing's pricing applies.
  const accepted = await resolveInstallBilling(
    billingLookup({ status: "active", ...perRequest }, { ...ended, endReason: null }) as never,
    args,
  );
  assert.equal(accepted.kind, "billable");
});

test("before the renewal worker has closed the row, a run-out subscriber is still not billed at the new per-request price", async () => {
  const args = { agentId: "agent_clone", orgId: "org_buyer" };
  const perRequest = { status: "active", pricingModel: "per_request", pricePerRequestCents: 100_000n };
  const revoked = { kind: "revoked", listingTitle: "Research Analyst", reason: "pricing_changed" };
  const open = { status: "active", cancelAtPeriodEnd: false, endReason: null };

  // The buyer cancelled renewal; the period ended a minute ago and the
  // hourly tick has not run.
  assert.deepEqual(
    await resolveInstallBilling(
      billingLookup(perRequest, { ...open, cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() - 60_000) }) as never,
      args,
    ),
    revoked,
  );
  // The worker is not running at all and the grace window has passed.
  for (const status of ["active", "past_due"]) {
    assert.deepEqual(
      await resolveInstallBilling(
        billingLookup(perRequest, { ...open, status, currentPeriodEnd: new Date(Date.now() - 10 * DAY) }) as never,
        args,
      ),
      revoked,
    );
  }
  // A suspended install whose subscription expired for non-payment.
  assert.deepEqual(
    await resolveInstallBilling(
      billingLookup(
        { ...perRequest, status: "suspended" },
        { ...open, status: "expired", currentPeriodEnd: new Date(Date.now() - 10 * DAY) },
      ) as never,
      args,
    ),
    revoked,
  );
});

test("an archived monthly listing whose subscription closed keeps running free, and a plain lapse is still a lapse", async () => {
  const past = new Date(Date.now() - 10 * DAY);
  const args = { agentId: "agent_clone", orgId: "org_buyer" };
  assert.deepEqual(
    await resolveInstallBilling(
      billingLookup(
        { status: "active", listingStatus: "archived", pricingModel: "monthly" },
        { status: "cancelled", currentPeriodEnd: past, cancelAtPeriodEnd: false, endReason: "listing_archived" },
      ) as never,
      args,
    ),
    { kind: "free" },
  );
  assert.deepEqual(
    await resolveInstallBilling(
      billingLookup(
        { status: "suspended", pricingModel: "monthly" },
        { status: "expired", currentPeriodEnd: past, cancelAtPeriodEnd: false, endReason: null },
      ) as never,
      args,
    ),
    { kind: "revoked", listingTitle: "Research Analyst", reason: "subscription_lapsed" },
  );
});

// ============================================
// A month of use of the creator's agent, once use is no longer sold
// ============================================

for (const [name, change] of [
  ["sells copies now", { sells: "copies", status: "published" }],
  ["was archived", { sells: "use", status: "archived" }],
  ["went back to a draft", { sells: "use", status: "draft" }],
] as const) {
  test(`a use subscription ends at the close of the paid month and is not charged when the listing ${name}`, async () => {
    const { state, inTransaction, sub } = await subscribed();
    const useSub = () => ({ ...sub(), licenceKind: "use" });
    const listing = { ...LISTING, pricingModel: "monthly", ...change };

    // Inside the month that was paid for nothing happens: the buyer keeps it.
    assert.deepEqual(await inTransaction((tx) => renewSubscription(tx, { sub: useSub(), listing, now: at(29) })), {
      kind: "not_due",
    });
    assert.equal(sub().status, "active");

    const outcome = await inTransaction((tx) => renewSubscription(tx, { sub: useSub(), listing, now: at(30) }));
    assert.deepEqual(outcome, { kind: "cancelled" });
    assert.equal(sub().status, "cancelled");
    assert.equal(sub().endReason, "use_ended");
    // Only the first month was ever charged.
    assert.equal(state.revenue.length, 1);
    assert.equal(state.ledger.length, 1);
    assert.equal(state.balances.get("org_buyer"), 8_500n);
    // The licence row is left alone: access is decided from the rows.
    assert.equal(state.installs[0]!.status, "active");

    // A second worker on the same row does nothing.
    assert.deepEqual(await inTransaction((tx) => renewSubscription(tx, { sub: useSub(), listing, now: at(30) })), {
      kind: "lost_race",
    });
    assert.equal(state.revenue.length, 1);
  });
}

test("a use subscription whose listing still sells use renews as any subscription does", async () => {
  const { state, inTransaction, sub } = await subscribed();
  const outcome = await inTransaction((tx) =>
    renewSubscription(tx, {
      sub: { ...sub(), licenceKind: "use" },
      listing: { ...LISTING, pricingModel: "monthly", status: "published", sells: "use" },
      now: at(30),
    }),
  );
  assert.equal(outcome.kind, "renewed");
  assert.equal(state.revenue.length, 2);
  assert.equal(state.revenue[1]!.type, "subscription_renewal");
  assert.equal(state.balances.get("org_buyer"), 7_000n);
});

test("a copy subscription is untouched by what the listing sells: it renews, and an archived one ends as before", async () => {
  // The listing sells use now; this buyer subscribed to a copy.
  for (const licenceKind of ["copy", undefined]) {
    const { state, inTransaction, sub } = await subscribed();
    const outcome = await inTransaction((tx) =>
      renewSubscription(tx, {
        sub: { ...sub(), ...(licenceKind && { licenceKind }) },
        listing: { ...LISTING, pricingModel: "monthly", status: "published", sells: "use" },
        now: at(30),
      }),
    );
    assert.equal(outcome.kind, "renewed");
    assert.equal(state.balances.get("org_buyer"), 7_000n);
    assert.equal(sub().endReason, null);
  }

  const { state, inTransaction, sub } = await subscribed();
  const outcome = await inTransaction((tx) =>
    renewSubscription(tx, {
      sub: { ...sub(), licenceKind: "copy" },
      listing: { ...LISTING, status: "archived", sells: "copies" },
      now: at(30),
    }),
  );
  assert.deepEqual(outcome, { kind: "cancelled" });
  assert.equal(sub().endReason, "listing_archived");
  assert.equal(state.installs[0]!.status, "active");
});

test("the renewal tick's loader reads what the listing sells and the licence's kind", async () => {
  const { buildSubscriptionRenewalTickDeps } = await import("../services/buildSubscriptionRenewalTickDeps.js");
  const queries: Array<Record<string, any>> = [];
  const row = (id: string, listingId: string, sells: string) => ({
    id,
    listingId,
    subscriberId: "org_buyer",
    status: "active",
    currentPeriodStart: at(0),
    currentPeriodEnd: at(30),
    cancelAtPeriodEnd: false,
    priceCents: 1500n,
    endReason: null,
    listing: { id: listingId, title: "T", publisherId: "org_pub", monthlyPriceCents: 1500n, pricingModel: "monthly", status: "published", sells },
  });
  const fake = {
    agentSubscription: {
      findMany: async (args: Record<string, any>) => {
        queries.push({ model: "agentSubscription", ...args });
        return [row("sub_use", "lst_use", "copies"), row("sub_copy", "lst_copy", "copies"), row("sub_none", "lst_none", "use")];
      },
    },
    agentInstall: {
      findMany: async (args: Record<string, any>) => {
        queries.push({ model: "agentInstall", ...args });
        return [
          { listingId: "lst_use", buyerId: "org_buyer", kind: "use" },
          { listingId: "lst_copy", buyerId: "org_buyer", kind: "copy" },
        ];
      },
    },
  };
  const deps = buildSubscriptionRenewalTickDeps(fake as never);
  const due = await deps.loadDue({ now: at(31), limit: 10, excludeIds: [] });

  assert.equal(queries[0]!.include.listing.select.sells, true);
  assert.deepEqual(queries[1]!.where.OR[0], { listingId: "lst_use", buyerId: "org_buyer" });
  assert.deepEqual(
    due.map((d) => [d.sub.id, d.sub.licenceKind, d.listing.sells]),
    [
      ["sub_use", "use", "copies"],
      ["sub_copy", "copy", "copies"],
      // No licence row: read as a copy, which is how it renewed before.
      ["sub_none", "copy", "use"],
    ],
  );

  // Nothing due: the licences are not asked for.
  fake.agentSubscription.findMany = async () => [];
  queries.length = 0;
  assert.deepEqual(await deps.loadDue({ now: at(31), limit: 10, excludeIds: [] }), []);
  assert.equal(queries.length, 0);
});

// ============================================
// A paused listing: the subscribers' clock is stopped
// ============================================

const PAUSED_USE = { ...LISTING, pricingModel: "monthly", status: "published", sells: "use", pausedSince: at(20) };

/** Everything a renewal could have written. */
const written = (db: Awaited<ReturnType<typeof subscribed>>) =>
  structuredClone({
    subs: [...db.state.subs.values()],
    balances: [...db.state.balances],
    revenue: db.state.revenue,
    ledger: db.state.ledger,
    earnings: db.state.earnings,
    installs: db.state.installs,
  });

for (const [name, change, subChange] of [
  ["is due", {}, {}],
  ["no longer sells use", { sells: "copies" }, {}],
  ["was archived", { status: "archived" }, {}],
  ["left monthly pricing", { pricingModel: "per_request" }, {}],
  ["was cancelled by the buyer", {}, { cancelAtPeriodEnd: true }],
  ["has no agreed price", {}, { priceCents: null }],
  ["is past due", {}, { status: "past_due" }],
] as const) {
  test(`a use subscription on a paused listing that ${name} is left exactly as it is`, async () => {
    const db = await subscribed();
    Object.assign(db.first(), subChange);
    const before = written(db);
    // Any write at all would be a claim, a charge or a close.
    const writes: string[] = [];
    const watched = new Proxy(db.tx, {
      get: (target, model: string) =>
        new Proxy((target as unknown as Record<string, object>)[model]!, {
          get: (inner, method: string) => {
            const fn = (inner as Record<string, unknown>)[method];
            if (typeof fn !== "function") return fn;
            return (...a: unknown[]) => {
              writes.push(`${model}.${method}`);
              return (fn as (...x: unknown[]) => unknown).apply(inner, a);
            };
          },
        }),
    });
    const outcome = await renewSubscription(watched, {
      sub: { ...db.sub(), licenceKind: "use" },
      listing: { ...PAUSED_USE, ...change },
      now: at(31),
    });
    assert.deepEqual(outcome, { kind: "paused" });
    assert.deepEqual(writes, []);
    assert.deepEqual(written(db), before);
  });
}

test("the same due use subscription renews once the marker is cleared", async () => {
  const db = await subscribed();
  const outcome = await db.inTransaction((tx) =>
    renewSubscription(tx, { sub: { ...db.sub(), licenceKind: "use" }, listing: { ...PAUSED_USE, pausedSince: null }, now: at(31) }),
  );
  assert.equal(outcome.kind, "renewed");
  assert.equal(db.state.revenue.length, 2);
});

test("a month of use is not claimed or charged when the listing was marked paused after the row was loaded", async () => {
  // The tick loaded this row with no marker. Before its claim, the owner
  // stopped the deployment and the stop route set the marker.
  const db = makeDb();
  await startMonthlySubscription(db.tx, { listing: LISTING, buyerId: "org_buyer", now: at(0) });
  const before = { balance: db.state.balances.get("org_buyer"), revenue: db.state.revenue.length, sub: { ...db.sub() } };
  listingMarkerNow.set(LISTING.id, at(30));
  try {
    const outcome = await renewSubscription(db.tx, {
      sub: { ...db.sub(), licenceKind: "use" },
      listing: { ...LISTING, pricingModel: "monthly", status: "published", sells: "use", pausedSince: null },
      now: at(31),
    });
    assert.deepEqual(outcome, { kind: "lost_race" });
    assert.equal(db.state.balances.get("org_buyer"), before.balance, "nothing is charged");
    assert.equal(db.state.revenue.length, before.revenue, "no sale is recorded");
    assert.deepEqual(db.sub(), before.sub, "the month is not moved on");

    // A copy's month on the same listing is the buyer's own copy: it renews.
    const copy = await renewSubscription(db.tx, {
      sub: { ...db.sub(), licenceKind: "copy" },
      listing: { ...LISTING, pricingModel: "monthly", status: "published", sells: "use", pausedSince: null },
      now: at(31),
    });
    assert.equal(copy.kind, "renewed");
  } finally {
    listingMarkerNow.delete(LISTING.id);
  }
});

test("a copy subscription is never paused: it renews on a listing whose marker is set", async () => {
  for (const licenceKind of ["copy", undefined]) {
    const db = await subscribed();
    const outcome = await db.inTransaction((tx) =>
      renewSubscription(tx, { sub: { ...db.sub(), ...(licenceKind && { licenceKind }) }, listing: PAUSED_USE, now: at(30) }),
    );
    assert.equal(outcome.kind, "renewed");
    assert.equal(db.state.balances.get("org_buyer"), 7_000n);
  }
});

test("the tick counts a paused subscription, stamps it and charges nothing", async () => {
  const db = await subscribed();
  const before = written(db);
  const deps = tickDeps(db, at(31));
  const result = await runSubscriptionRenewalTick({
    ...deps,
    loadDue: async (args) =>
      (await deps.loadDue(args)).map((d) => ({ sub: { ...d.sub, licenceKind: "use" }, listing: PAUSED_USE })),
  });
  assert.deepEqual(result, { scanned: 1, renewed: 0, cancelled: 0, paused: 1, pastDue: 0, expired: 0, errors: 0 });
  // Only the attempt stamp moved, so the row rotates behind the others.
  assert.equal(db.first().lastRenewalAttemptAt?.getTime(), at(31).getTime());
  db.first().lastRenewalAttemptAt = null;
  assert.deepEqual(written(db), before);
});

test("the tick reconciles pauses before it loads what is due", async () => {
  const db = await subscribed();
  const order: string[] = [];
  const deps = tickDeps(db, at(30));
  await runSubscriptionRenewalTick({
    ...deps,
    reconcilePauses: async () => {
      order.push("reconcile");
    },
    loadDue: async (args) => {
      order.push("load");
      return deps.loadDue(args);
    },
  });
  assert.deepEqual(order, ["reconcile", "load", "load"]);
});

test("a reconcile that throws is logged and does not stop the tick: paused rows wait, the rest renew", async () => {
  const db = await subscribed();
  // A second subscriber, for use of a listing whose marker is set.
  db.state.balances.set("org_other", 10_000n);
  await db.inTransaction((tx) => startMonthlySubscription(tx, { listing: LISTING, buyerId: "org_other", now: T0 }));
  const logged: Array<Record<string, unknown>> = [];
  const failure = new Error("database unreachable");
  const deps = tickDeps(db, at(30));
  const result = await runSubscriptionRenewalTick({
    ...deps,
    reconcilePauses: async () => {
      throw failure;
    },
    logger: { error: (fields) => void logged.push(fields) },
    loadDue: async (args) =>
      (await deps.loadDue(args)).map((d) =>
        d.sub.subscriberId === "org_other"
          ? { sub: { ...d.sub, licenceKind: "use" }, listing: PAUSED_USE }
          : d,
      ),
  });
  assert.deepEqual(result, { scanned: 2, renewed: 1, cancelled: 0, paused: 1, pastDue: 0, expired: 0, errors: 0 });
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.error, failure);
  assert.equal(db.state.balances.get("org_other"), 8_500n);
  assert.equal(db.state.balances.get("org_buyer"), 7_000n);
});

test("the renewal tick's loader carries the listing's pause marker, and its reconcile covers every listing", async () => {
  const { buildSubscriptionRenewalTickDeps } = await import("../services/buildSubscriptionRenewalTickDeps.js");
  const selects: Array<Record<string, any>> = [];
  const listingQueries: Array<Record<string, any>> = [];
  const row = (id: string, pausedSince: Date | null) => ({
    id,
    listingId: `lst_${id}`,
    subscriberId: "org_buyer",
    status: "active",
    currentPeriodStart: at(0),
    currentPeriodEnd: at(30),
    cancelAtPeriodEnd: false,
    priceCents: 1500n,
    endReason: null,
    listing: { id: `lst_${id}`, title: "T", publisherId: "org_pub", monthlyPriceCents: 1500n, pricingModel: "monthly", status: "published", sells: "use", pausedSince },
  });
  const fake = {
    agentSubscription: {
      findMany: async (args: Record<string, any>) => {
        selects.push(args.include.listing.select);
        return [row("a", at(20)), row("b", null)];
      },
    },
    agentInstall: { findMany: async () => [] },
    agentListing: {
      findMany: async (args: Record<string, any>) => {
        listingQueries.push(args);
        return [];
      },
    },
  };
  const deps = buildSubscriptionRenewalTickDeps(fake as never);
  const due = await deps.loadDue({ now: at(31), limit: 10, excludeIds: [] });
  assert.equal(selects[0]!.pausedSince, true);
  assert.deepEqual(
    due.map((d) => d.listing.pausedSince),
    [at(20), null],
  );

  // The reconcile runs on the client it was given, over every listing: no
  // organization and no listing narrows it.
  assert.deepEqual(await deps.reconcilePauses(), { examined: 0, paused: 0, resumed: 0, extendedSubscriptions: 0, errors: 0 });
  assert.equal(listingQueries.length, 1);
  assert.deepEqual(listingQueries[0]!.where.AND[0], {});
});

// ============================================
// Plans: a subscription with a count of uses
// ============================================

/** The listing a plan lives on: use of the creator's agent, sold per request. */
const PLAN_LISTING = { ...LISTING, monthlyPriceCents: 0n, pricingModel: "per_request", status: "published", sells: "use" };
const STARTER: PlanTerms = { planId: "plan_1", priceCents: 900n, includedUses: 500, extraUsePriceCents: 4n };
const PLAN_COLUMNS = ["planId", "includedUses", "extraUsePriceCents", "usedInPeriod", "carriedUses", "warnedLevel"] as const;

type Licence = Record<string, unknown> & { id: string };

/** The transaction of a plan start: the subscription's own, and the buyer's licence rows with every write to them. */
function planStartTx(tx: SubscriptionTx, licences: Licence[], writes: Array<Record<string, unknown>>): PlanStartTx {
  return {
    ...tx,
    agentInstall: {
      ...tx.agentInstall,
      async create({ data }) {
        writes.push({ create: data });
        const row = { id: `ins_${licences.length + 1}`, ...data };
        licences.push(row);
        return { id: row.id };
      },
      async update({ where, data }) {
        writes.push({ update: data });
        const row = licences.find((l) => l.id === where.id)!;
        Object.assign(row, data);
        return { id: row.id, status: String(row.status) };
      },
    },
  };
}

/** A plan row as the renewal worker loads it: the licence is for use. */
const planRow = (db: ReturnType<typeof makeDb>, more: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  ...db.sub(),
  licenceKind: "use",
  ...more,
});
const planColumnsOf = (row: SubscriptionRow) => {
  const r = row as unknown as Record<string, unknown>;
  return Object.fromEntries(PLAN_COLUMNS.map((k) => [k, r[k]]));
};

/** A buyer on the Starter plan since T0, with `used` uses taken and a warning sent. */
async function onPlan(opts: { balance?: bigint; used?: number } = {}) {
  const db = makeDb(opts);
  await db.inTransaction((tx) =>
    startPlanSubscription(planStartTx(tx, [], []), { listing: PLAN_LISTING, plan: STARTER, buyerId: "org_buyer", licence: null, now: T0 }),
  );
  Object.assign(db.first(), { usedInPeriod: opts.used ?? 437, carriedUses: 20, warnedLevel: 85 });
  return db;
}

test("starting a plan writes the copy of the terms, charges the full 30 days once and never writes a price per use on the licence", async () => {
  const db = makeDb();
  const licences: Licence[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const started = await db.inTransaction((tx) =>
    startPlanSubscription(planStartTx(tx, licences, writes), {
      listing: PLAN_LISTING,
      plan: STARTER,
      buyerId: "org_buyer",
      licence: null,
      now: T0,
    }),
  );

  const { id, ...row } = db.sub() as unknown as Record<string, unknown>;
  assert.equal(id, started.subscription.id);
  assert.deepEqual(row, {
    listingId: "lst_1",
    subscriberId: "org_buyer",
    status: "active",
    currentPeriodStart: T0,
    currentPeriodEnd: at(30),
    cancelAtPeriodEnd: false,
    cancelledAt: null,
    priceCents: 900n,
    endReason: null,
    lastRenewalAttemptAt: null,
    planId: "plan_1",
    includedUses: 500,
    extraUsePriceCents: 4n,
    usedInPeriod: 0,
    carriedUses: 0,
    warnedLevel: 0,
  });

  // The month's money, on the path a monthly subscription takes: the platform keeps 10%.
  assert.equal(db.state.balances.get("org_buyer"), 9_100n);
  assert.deepEqual(
    db.state.revenue.map((r) => [r.type, r.status, r.grossAmountCents, r.platformFeeCents, r.creatorAmountCents, r.installId, r.subscriptionId]),
    [["subscription", "settled", 900n, 90n, 810n, "ins_1", started.subscription.id]],
  );
  assert.deepEqual(
    db.state.ledger.map((l) => [l.type, l.amountCents, l.description, l.balanceAfter]),
    [["marketplace_subscription", -900n, "Subscription: Research Analyst", 9_100n]],
  );
  assert.equal(db.state.accrued.get("org_pub"), 810n);

  // The licence it created: for use, and with no pricing agreed. Starting a
  // plan is not an agreement to the listing's price per use.
  assert.equal(started.licenceId, "ins_1");
  assert.deepEqual(writes, [
    { create: { listingId: "lst_1", buyerId: "org_buyer", clonedAgentId: null, kind: "use", status: "active" } },
  ]);
  assert.deepEqual(
    [licences[0]!.acceptedPricingModel ?? null, licences[0]!.acceptedPricePerRequestCents ?? null],
    [null, null],
  );
});

test("a plan start leaves a per-request agreement the licence already held exactly as it is", async () => {
  const db = makeDb();
  const agreedAt = at(-40);
  const licences: Licence[] = [
    {
      id: "ins_9",
      listingId: "lst_1",
      buyerId: "org_buyer",
      kind: "use",
      status: "active",
      acceptedPricingModel: "per_request",
      acceptedPricePerRequestCents: 5n,
      pricingAcceptedAt: agreedAt,
    },
  ];
  const writes: Array<Record<string, unknown>> = [];
  const started = await db.inTransaction((tx) =>
    startPlanSubscription(planStartTx(tx, licences, writes), {
      listing: PLAN_LISTING,
      plan: STARTER,
      buyerId: "org_buyer",
      licence: { id: "ins_9", kind: "use" },
      now: T0,
    }),
  );
  assert.equal(started.licenceId, "ins_9");
  assert.deepEqual(writes, [{ update: { kind: "use" } }]);
  assert.deepEqual(licences, [
    {
      id: "ins_9",
      listingId: "lst_1",
      buyerId: "org_buyer",
      kind: "use",
      status: "active",
      acceptedPricingModel: "per_request",
      acceptedPricePerRequestCents: 5n,
      pricingAcceptedAt: agreedAt,
    },
  ]);
  assert.equal(db.state.revenue[0]!.installId, "ins_9");
});

test("a plan started on a licence that was for a copy clears what the copy agreed to: the plan's end is never a charge per use", async () => {
  const db = makeDb();
  const licences: Licence[] = [
    {
      id: "ins_9",
      listingId: "lst_1",
      buyerId: "org_buyer",
      kind: "copy",
      status: "active",
      acceptedPricingModel: "per_request",
      acceptedPricePerRequestCents: 5n,
      pricingAcceptedAt: at(-40),
    },
  ];
  const writes: Array<Record<string, unknown>> = [];
  await db.inTransaction((tx) =>
    startPlanSubscription(planStartTx(tx, licences, writes), {
      listing: PLAN_LISTING,
      plan: STARTER,
      buyerId: "org_buyer",
      licence: { id: "ins_9", kind: "copy" },
      now: T0,
    }),
  );
  assert.deepEqual(writes, [
    { update: { kind: "use", acceptedPricingModel: null, acceptedPricePerRequestCents: null, pricingAcceptedAt: null } },
  ]);

  // The creator ends the plan and its period runs out, on a listing still
  // sold at the price the copy had agreed to. The buyer chooses; they are
  // not charged per use. With the copy's agreement kept, this read
  // "listing_pricing".
  const [licence] = licences;
  const accessAfter = (accepted: { pricingModel: string | null; pricePerRequestCents: bigint | null }) =>
    useAccess(
      {
        licence: { kind: String(licence!.kind), status: String(licence!.status), accepted },
        listing: { status: "published", sells: "use", pricingModel: "per_request", pricePerRequestCents: 5n },
        sub: { ...db.sub(), status: "cancelled", endReason: "plan_ended" },
      },
      at(31),
    );
  assert.deepEqual(
    [
      accessAfter({
        pricingModel: licence!.acceptedPricingModel as string | null,
        pricePerRequestCents: licence!.acceptedPricePerRequestCents as bigint | null,
      }),
      accessAfter({ pricingModel: "per_request", pricePerRequestCents: 5n }),
    ],
    ["plan_ended", "listing_pricing"],
  );
});

test("a plan start on a licence that is not active charges nothing and opens nothing", async () => {
  for (const status of ["uninstalled", "suspended"]) {
    const db = makeDb();
    const licences: Licence[] = [{ id: "ins_9", listingId: "lst_1", buyerId: "org_buyer", kind: "use", status }];
    await assert.rejects(
      db.inTransaction((tx) =>
        startPlanSubscription(planStartTx(tx, licences, []), {
          listing: PLAN_LISTING,
          plan: STARTER,
          buyerId: "org_buyer",
          licence: { id: "ins_9", kind: "use" },
          now: T0,
        }),
      ),
      /not active/,
    );
    assert.deepEqual([db.state.subs.size, db.state.revenue.length, db.state.balances.get("org_buyer")], [0, 0, 10_000n], status);
  }
});

test("a buyer whose plan the creator ended can start a plan the moment its period ends, before the renewal worker has closed the row", async () => {
  // One minute past the period: a row still open, as the worker has not run.
  const justAfter = new Date(at(30).getTime() + 60_000);
  const next: PlanTerms = { planId: "plan_2", priceCents: 2_900n, includedUses: 2_000, extraUsePriceCents: null };
  const start = (db: Awaited<ReturnType<typeof onPlan>>) =>
    db.inTransaction((tx) =>
      startPlanSubscription(planStartTx(tx, [], []), { listing: PLAN_LISTING, plan: next, buyerId: "org_buyer", licence: null, now: justAfter }),
    );

  // A plan that is still sold is being renewed: its days of grace hold the row.
  const renewing = await onPlan();
  await assert.rejects(start(renewing), SubscriptionClaimLostError);
  assert.deepEqual([renewing.state.revenue.length, renewing.state.balances.get("org_buyer")], [1, 9_100n]);

  const ended = await onPlan();
  planStatusNow.set("plan_1", "retired");
  try {
    // Inside the period it paid for, an ended plan is still paid up.
    await assert.rejects(
      ended.inTransaction((tx) =>
        startPlanSubscription(planStartTx(tx, [], []), { listing: PLAN_LISTING, plan: next, buyerId: "org_buyer", licence: null, now: at(29) }),
      ),
      SubscriptionClaimLostError,
    );
    const started = await start(ended);
    assert.equal("plan" in started.subscription, false);
  } finally {
    planStatusNow.delete("plan_1");
  }
  // Charged once for the new plan, on the same row, with a count from zero.
  assert.deepEqual(
    [ended.state.subs.size, ended.state.revenue.map((r) => r.grossAmountCents), ended.state.balances.get("org_buyer")],
    [1, [900n, 2_900n], 6_200n],
  );
  assert.deepEqual(
    { ...planColumnsOf(ended.sub()), status: ended.sub().status, start: ended.sub().currentPeriodStart },
    {
      planId: "plan_2",
      includedUses: 2_000,
      extraUsePriceCents: null,
      usedInPeriod: 0,
      carriedUses: 0,
      warnedLevel: 0,
      status: "active",
      start: justAfter,
    },
  );
});

test("a plan start that cannot be paid for, is already paid up, or has terms that are not terms leaves nothing behind", async () => {
  const broke = makeDb({ balance: 899n });
  await assert.rejects(
    broke.inTransaction((tx) =>
      startPlanSubscription(planStartTx(tx, [], []), { listing: PLAN_LISTING, plan: STARTER, buyerId: "org_buyer", licence: null, now: T0 }),
    ),
    InsufficientCreditsError,
  );
  assert.deepEqual([broke.state.subs.size, broke.state.revenue.length, broke.state.balances.get("org_buyer")], [0, 0, 899n]);

  // Already on a plan that is paid for: refused before any charge. The row keeps its count.
  const paid = await onPlan();
  await assert.rejects(
    paid.inTransaction((tx) =>
      startPlanSubscription(planStartTx(tx, [], []), {
        listing: PLAN_LISTING,
        plan: { ...STARTER, planId: "plan_2", includedUses: 2_000, priceCents: 2_900n },
        buyerId: "org_buyer",
        licence: null,
        now: at(10),
      }),
    ),
    SubscriptionClaimLostError,
  );
  assert.deepEqual([paid.state.revenue.length, paid.state.balances.get("org_buyer")], [1, 9_100n]);
  assert.deepEqual(planColumnsOf(paid.sub()), {
    planId: "plan_1",
    includedUses: 500,
    extraUsePriceCents: 4n,
    usedInPeriod: 437,
    carriedUses: 20,
    warnedLevel: 85,
  });

  for (const plan of [
    { ...STARTER, priceCents: 0n },
    { ...STARTER, includedUses: 0 },
    { ...STARTER, includedUses: 1.5 },
    { ...STARTER, extraUsePriceCents: 0n },
  ]) {
    const db = makeDb();
    const licences: Licence[] = [];
    await assert.rejects(
      db.inTransaction((tx) =>
        startPlanSubscription(planStartTx(tx, licences, []), { listing: PLAN_LISTING, plan, buyerId: "org_buyer", licence: null, now: T0 }),
      ),
    );
    assert.deepEqual([db.state.subs.size, db.state.revenue.length, licences.length], [0, 0, 0]);
  }
});

test("a start with no plan writes none of a plan's columns, and a row that was on a plan drops them", async () => {
  const legacy = await subscribed();
  assert.deepEqual(Object.keys(legacy.first()).sort(), [
    "cancelAtPeriodEnd",
    "cancelledAt",
    "currentPeriodEnd",
    "currentPeriodStart",
    "endReason",
    "id",
    "lastRenewalAttemptAt",
    "listingId",
    "priceCents",
    "status",
    "subscriberId",
  ]);

  // A lapsed month that is started again is claimed with the same columns as ever.
  Object.assign(legacy.first(), { status: "expired" });
  const claims: Array<Record<string, unknown>> = [];
  const watched = (tx: SubscriptionTx): SubscriptionTx => ({
    ...tx,
    agentSubscription: {
      ...tx.agentSubscription,
      updateMany: (args) => {
        claims.push(args.data);
        return tx.agentSubscription.updateMany(args);
      },
    },
  });
  await legacy.inTransaction((tx) => startMonthlySubscription(watched(tx), { listing: LISTING, buyerId: "org_buyer", now: at(40) }));
  assert.deepEqual(Object.keys(claims[0]!).sort(), [
    "cancelAtPeriodEnd",
    "cancelledAt",
    "currentPeriodEnd",
    "currentPeriodStart",
    "endReason",
    "lastRenewalAttemptAt",
    "priceCents",
    "status",
  ]);

  // A plan that ended, on a listing its creator then moved to a monthly
  // price: the new month has no count, so the old one must not stay on the row.
  const was = await onPlan();
  Object.assign(was.first(), { status: "cancelled", endReason: "pricing_changed" });
  await was.inTransaction((tx) => startMonthlySubscription(tx, { listing: LISTING, buyerId: "org_buyer", now: at(40) }));
  assert.deepEqual(planColumnsOf(was.sub()), {
    planId: null,
    includedUses: null,
    extraUsePriceCents: null,
    usedInPeriod: 0,
    carriedUses: 0,
    warnedLevel: 0,
  });
  assert.deepEqual([was.sub().status, was.sub().priceCents], ["active", 1500n]);
});

test("a plan renewal charges the agreed price and sets the count back to zero in the claim that moves the period start", async () => {
  const db = await onPlan();
  const statements: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const outcome = await db.inTransaction((tx) =>
    renewSubscription(
      {
        ...tx,
        agentSubscription: {
          ...tx.agentSubscription,
          updateMany: (args) => {
            statements.push(args);
            return tx.agentSubscription.updateMany(args);
          },
        },
      },
      { sub: planRow(db), listing: PLAN_LISTING, now: at(30.5) },
    ),
  );
  assert.deepEqual(outcome, { kind: "renewed", revenueId: db.state.revenue[1]!.id, newPeriodEnd: at(60) });

  // ONE statement moves the period and resets the count, the carried uses
  // and the warning: a take or a give-back keyed on the old period start
  // can never land in a period whose count it does not belong to.
  assert.deepEqual(statements, [
    {
      where: {
        id: db.sub().id,
        currentPeriodEnd: at(30),
        status: { in: ["active", "past_due"] },
        cancelAtPeriodEnd: false,
        listing: { pausedSince: null },
        plan: { status: "active" },
      },
      data: {
        currentPeriodStart: at(30),
        currentPeriodEnd: at(60),
        status: "active",
        lastRenewalAttemptAt: null,
        usedInPeriod: 0,
        carriedUses: 0,
        warnedLevel: 0,
      },
    },
  ]);
  // Unused uses do not carry over, and the terms are the ones agreed to.
  assert.deepEqual(planColumnsOf(db.sub()), {
    planId: "plan_1",
    includedUses: 500,
    extraUsePriceCents: 4n,
    usedInPeriod: 0,
    carriedUses: 0,
    warnedLevel: 0,
  });
  assert.deepEqual(
    db.state.revenue.map((r) => [r.type, r.grossAmountCents, r.platformFeeCents, r.creatorAmountCents]),
    [
      ["subscription", 900n, 90n, 810n],
      ["subscription_renewal", 900n, 90n, 810n],
    ],
  );
  assert.equal(db.state.balances.get("org_buyer"), 8_200n);

  // Not before its period ends: nothing is written.
  const early = await onPlan();
  assert.deepEqual(
    await early.inTransaction((tx) => renewSubscription(tx, { sub: planRow(early), listing: PLAN_LISTING, now: at(29) })),
    { kind: "not_due" },
  );
  assert.equal(planColumnsOf(early.sub()).usedInPeriod, 437);
});

test("a plan row is NOT closed because its listing is not monthly: it renews on a listing sold per request", async () => {
  const db = await onPlan();
  const outcome = await db.inTransaction((tx) =>
    renewSubscription(tx, { sub: planRow(db), listing: PLAN_LISTING, now: at(30) }),
  );
  assert.deepEqual(
    [outcome.kind, db.sub().status, db.sub().endReason, db.sub().currentPeriodEnd, db.state.installs[0]!.status, db.state.revenue.length],
    ["renewed", "active", null, at(60), "active", 2],
  );

  // The same listing, and a row with no count: that one did leave monthly
  // pricing, and ends as it always has.
  const legacy = await subscribed();
  const closed = await legacy.inTransaction((tx) =>
    renewSubscription(tx, { sub: { ...legacy.sub(), licenceKind: "use" }, listing: PLAN_LISTING, now: at(30) }),
  );
  assert.deepEqual(
    [closed.kind, legacy.sub().status, legacy.sub().endReason, legacy.state.installs[0]!.status, legacy.state.revenue.length],
    ["cancelled", "cancelled", "pricing_changed", "suspended", 1],
  );
});

test("a plan row is closed, uncharged, when its listing no longer sells use per request or is archived", async () => {
  for (const [listing, endReason, install] of [
    // Moved to a monthly price or to free: not what the buyer agreed to.
    [{ ...PLAN_LISTING, pricingModel: "monthly", monthlyPriceCents: 1500n }, "pricing_changed", "suspended"],
    [{ ...PLAN_LISTING, pricingModel: "free" }, "pricing_changed", "suspended"],
    // Taken off sale, or sells copies now: there is nothing left to charge for.
    [{ ...PLAN_LISTING, status: "archived" }, "use_ended", "active"],
    [{ ...PLAN_LISTING, sells: "copies" }, "use_ended", "active"],
  ] as const) {
    const db = await onPlan();
    const outcome = await db.inTransaction((tx) => renewSubscription(tx, { sub: planRow(db), listing, now: at(30) }));
    assert.deepEqual(
      [outcome.kind, db.sub().status, db.sub().endReason, db.state.installs[0]!.status, db.state.revenue.length, db.state.balances.get("org_buyer")],
      ["cancelled", "cancelled", endReason, install, 1, 9_100n],
      JSON.stringify(listing, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
    );
  }

  // A plan row whose licence is not for use has nothing it could pay for.
  const stray = await onPlan();
  const outcome = await stray.inTransaction((tx) =>
    renewSubscription(tx, { sub: planRow(stray, { licenceKind: "copy" }), listing: PLAN_LISTING, now: at(30) }),
  );
  assert.deepEqual([outcome.kind, stray.sub().endReason, stray.state.revenue.length], ["cancelled", "use_ended", 1]);
});

test("a plan its creator ended is not charged again: the row ends with its paid period, with plan_ended", async () => {
  const db = await onPlan();
  // Still inside the period paid for: nothing moves.
  assert.deepEqual(
    await db.inTransaction((tx) => renewSubscription(tx, { sub: planRow(db, { planRetired: true }), listing: PLAN_LISTING, now: at(29) })),
    { kind: "not_due" },
  );
  assert.equal(db.sub().status, "active");

  const outcome = await db.inTransaction((tx) =>
    renewSubscription(tx, { sub: planRow(db, { planRetired: true }), listing: PLAN_LISTING, now: at(30) }),
  );
  assert.deepEqual(outcome, { kind: "cancelled" });
  assert.deepEqual(
    [db.sub().status, db.sub().endReason, db.sub().currentPeriodEnd, db.state.revenue.length, db.state.balances.get("org_buyer")],
    ["cancelled", "plan_ended", at(30), 1, 9_100n],
  );
  // The licence is left as it is: a buyer who agreed to a price per use
  // themselves goes on at it, and everybody else chooses.
  assert.equal(db.state.installs[0]!.status, "active");

  // Ended after the worker loaded the row: the claim reads the plan as it
  // is at that moment, misses, and nothing is charged.
  const late = await onPlan();
  planStatusNow.set("plan_1", "retired");
  try {
    assert.deepEqual(
      await late.inTransaction((tx) => renewSubscription(tx, { sub: planRow(late), listing: PLAN_LISTING, now: at(30) })),
      { kind: "lost_race" },
    );
  } finally {
    planStatusNow.delete("plan_1");
  }
  assert.deepEqual(
    [late.sub().status, late.sub().currentPeriodEnd, planColumnsOf(late.sub()).usedInPeriod, late.state.revenue.length],
    ["active", at(30), 437, 1],
  );
});

test("a plan row found 4 days past its end expires and is not charged for a period that is already gone", async () => {
  const db = await onPlan();
  const outcome = await db.inTransaction((tx) => renewSubscription(tx, { sub: planRow(db), listing: PLAN_LISTING, now: at(34) }));
  assert.deepEqual(outcome, { kind: "expired" });
  assert.deepEqual(
    [db.sub().status, db.sub().currentPeriodEnd, planColumnsOf(db.sub()).usedInPeriod, db.state.installs[0]!.status, db.state.revenue.length, db.state.balances.get("org_buyer")],
    ["expired", at(30), 437, "suspended", 1, 9_100n],
  );

  // The tick counts it with the expired.
  const ticked = await onPlan();
  const deps = tickDeps(ticked, at(34));
  assert.deepEqual(
    await runSubscriptionRenewalTick({
      ...deps,
      loadDue: async (args) => (await deps.loadDue(args)).map((d) => ({ sub: { ...d.sub, licenceKind: "use" }, listing: PLAN_LISTING })),
    }),
    { scanned: 1, renewed: 0, cancelled: 0, paused: 0, pastDue: 0, expired: 1, errors: 0 },
  );
  assert.equal(ticked.state.revenue.length, 1);

  // Inside the days of grace it still renews, from the old period end.
  const inGrace = await onPlan();
  const renewed = await inGrace.inTransaction((tx) =>
    renewSubscription(tx, { sub: planRow(inGrace), listing: PLAN_LISTING, now: at(32.9) }),
  );
  assert.deepEqual([renewed.kind, inGrace.sub().currentPeriodEnd], ["renewed", at(60)]);

  // A row with no count is left alone in this slice: found late, it renews as it always has.
  const legacy = await subscribed();
  const late = await legacy.inTransaction((tx) => renewSubscription(tx, { sub: legacy.sub(), listing: LISTING, now: at(34) }));
  assert.deepEqual([late.kind, legacy.sub().status, legacy.state.revenue.length], ["renewed", "active", 2]);
});

test("credits short at a plan's renewal: the old count is kept through the grace and reset only when the renewal is paid", async () => {
  const db = await onPlan({ balance: 900n });
  const tick = (now: Date) => {
    const deps = tickDeps(db, now);
    return runSubscriptionRenewalTick({
      ...deps,
      loadDue: async (args) => (await deps.loadDue(args)).map((d) => ({ sub: { ...d.sub, licenceKind: "use" }, listing: PLAN_LISTING })),
    });
  };
  const kept = () => [db.sub().status, db.sub().currentPeriodStart, db.sub().currentPeriodEnd, planColumnsOf(db.sub()).usedInPeriod, planColumnsOf(db.sub()).carriedUses];

  assert.deepEqual(await tick(at(30.1)), { scanned: 1, renewed: 0, cancelled: 0, paused: 0, pastDue: 1, expired: 0, errors: 0 });
  // The claim rolled back with the charge: same period, same count.
  assert.deepEqual(kept(), ["past_due", T0, at(30), 437, 20]);
  assert.deepEqual(await tick(at(31.5)), { scanned: 1, renewed: 0, cancelled: 0, paused: 0, pastDue: 0, expired: 0, errors: 0 });
  assert.deepEqual(kept(), ["past_due", T0, at(30), 437, 20]);
  assert.equal(db.state.revenue.length, 1);

  // Paid inside the grace: a new period, and only now a new count.
  db.state.balances.set("org_buyer", 1_000n);
  assert.deepEqual(await tick(at(32)), { scanned: 1, renewed: 1, cancelled: 0, paused: 0, pastDue: 0, expired: 0, errors: 0 });
  assert.deepEqual(kept(), ["active", at(30), at(60), 0, 0]);
  assert.equal(db.state.balances.get("org_buyer"), 100n);

  // Never paid: after the grace it expires, uncharged, and the licence is suspended.
  const unpaid = await onPlan({ balance: 900n });
  const deps = tickDeps(unpaid, at(33));
  assert.deepEqual(
    await runSubscriptionRenewalTick({
      ...deps,
      loadDue: async (args) => (await deps.loadDue(args)).map((d) => ({ sub: { ...d.sub, licenceKind: "use" }, listing: PLAN_LISTING })),
    }),
    { scanned: 1, renewed: 0, cancelled: 0, paused: 0, pastDue: 0, expired: 1, errors: 0 },
  );
  assert.deepEqual([unpaid.sub().status, planColumnsOf(unpaid.sub()).usedInPeriod, unpaid.state.installs[0]!.status], ["expired", 437, "suspended"]);
});

test("a paused listing leaves a plan row alone: not renewed, not closed, and its count untouched", async () => {
  for (const more of [{}, { planRetired: true }, { cancelAtPeriodEnd: true }]) {
    const db = await onPlan();
    const before = structuredClone([...db.state.subs.values()]);
    assert.deepEqual(
      await db.inTransaction((tx) =>
        renewSubscription(tx, { sub: planRow(db, more), listing: { ...PLAN_LISTING, pausedSince: at(20) }, now: at(34) }),
      ),
      { kind: "paused" },
    );
    assert.deepEqual([...db.state.subs.values()], before);
    assert.equal(db.state.revenue.length, 1);
  }
});

test("a buyer who cancelled a plan's renewal keeps it to the end of the period and is not charged again", async () => {
  const db = await onPlan();
  Object.assign(db.first(), { cancelAtPeriodEnd: true });
  const outcome = await db.inTransaction((tx) => renewSubscription(tx, { sub: planRow(db), listing: PLAN_LISTING, now: at(30) }));
  assert.deepEqual([outcome.kind, db.sub().status, db.state.revenue.length], ["cancelled", "cancelled", 1]);
});

test("a row with no count renews with exactly the columns it always did", async () => {
  const db = await subscribed();
  const statements: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  await db.inTransaction((tx) =>
    renewSubscription(
      {
        ...tx,
        agentSubscription: {
          ...tx.agentSubscription,
          updateMany: (args) => {
            statements.push(args);
            return tx.agentSubscription.updateMany(args);
          },
        },
      },
      { sub: { ...db.sub(), licenceKind: "use", includedUses: null, planId: null, planRetired: false }, listing: { ...LISTING, pricingModel: "monthly", status: "published", sells: "use" }, now: at(30) },
    ),
  );
  assert.deepEqual(statements, [
    {
      where: {
        id: db.sub().id,
        currentPeriodEnd: at(30),
        status: { in: ["active", "past_due"] },
        cancelAtPeriodEnd: false,
        listing: { pausedSince: null },
      },
      data: { currentPeriodStart: at(30), currentPeriodEnd: at(60), status: "active", lastRenewalAttemptAt: null },
    },
  ]);
});

test("the renewal tick's loader reads the marker of a plan and whether its creator ended it", async () => {
  const { buildSubscriptionRenewalTickDeps } = await import("../services/buildSubscriptionRenewalTickDeps.js");
  const includes: Array<Record<string, any>> = [];
  const row = (id: string, plan: Record<string, unknown>) => ({
    id,
    listingId: "lst_1",
    subscriberId: `org_${id}`,
    status: "active",
    currentPeriodStart: at(0),
    currentPeriodEnd: at(30),
    cancelAtPeriodEnd: false,
    priceCents: 900n,
    endReason: null,
    planId: null,
    includedUses: null,
    plan: null,
    ...plan,
    listing: { id: "lst_1", title: "T", publisherId: "org_pub", monthlyPriceCents: null, pricingModel: "per_request", status: "published", sells: "use", pausedSince: null },
  });
  const fake = {
    agentSubscription: {
      findMany: async (args: Record<string, any>) => {
        includes.push(args.include);
        return [
          row("on", { planId: "plan_1", includedUses: 500, plan: { status: "active" } }),
          row("ended", { planId: "plan_2", includedUses: 100, plan: { status: "retired" } }),
          row("legacy", {}),
        ];
      },
    },
    agentInstall: { findMany: async () => [] },
  };
  const due = await buildSubscriptionRenewalTickDeps(fake as never).loadDue({ now: at(31), limit: 10, excludeIds: [] });
  assert.deepEqual(includes[0]!.plan, { select: { status: true } });
  assert.deepEqual(
    due.map((d) => [d.sub.id, d.sub.includedUses, d.sub.planId, d.sub.planRetired]),
    [
      ["on", 500, "plan_1", false],
      ["ended", 100, "plan_2", true],
      ["legacy", null, null, false],
    ],
  );
});

test("accepting a per-request price never closes a plan, and still closes a month with no count", async () => {
  const { settleLicenceSubscription } = await import("../services/marketplace.js");
  const listing = { id: "lst_1", title: "Research Analyst", publisherId: "org_pub", pricingModel: "per_request", pricePerRequestCents: 5n, monthlyPriceCents: null };
  const run = async (existingSub: Record<string, unknown>) => {
    const statements: unknown[] = [];
    const tx = {
      agentSubscription: {
        updateMany: async (args: unknown) => {
          statements.push(args);
          return { count: 1 };
        },
      },
    };
    const result = await settleLicenceSubscription(tx as never, { listing, buyerId: "org_buyer", installId: "ins_1", existingSub: existingSub as never });
    return { result, statements: statements.length };
  };
  const open = { id: "sub_1", status: "active", currentPeriodEnd: at(30), cancelAtPeriodEnd: false, endReason: null };

  // A plan that is paid for, one whose renewal is being retried, and one that has ended: none is written to.
  assert.deepEqual(await run({ ...open, includedUses: 500 }), { result: null, statements: 0 });
  assert.deepEqual(await run({ ...open, status: "past_due", includedUses: 500 }), { result: null, statements: 0 });
  assert.deepEqual(await run({ ...open, status: "cancelled", endReason: "plan_ended", includedUses: 500 }), { result: null, statements: 0 });
  // A month with no count is closed by the acceptance, as before.
  assert.deepEqual(await run({ ...open, includedUses: null }), { result: null, statements: 1 });
  assert.deepEqual(await run(open), { result: null, statements: 1 });
});
