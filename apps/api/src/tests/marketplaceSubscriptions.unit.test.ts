import assert from "node:assert/strict";
import test from "node:test";

import {
  InsufficientCreditsError,
  markPastDueOrExpire,
  renewSubscription,
  startMonthlySubscription,
  type ListingForBilling,
  type SubscriptionRow,
  type SubscriptionTx,
} from "../services/marketplaceSubscriptions.js";
import { resolveInstallBilling } from "../services/marketplaceMetering.js";
import { runSubscriptionRenewalTick } from "../services/runSubscriptionRenewalTick.js";
import { subscriptionGrantsAccess } from "../services/subscriptionAccess.js";

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
  subs: Map<string, SubscriptionRow & { cancelledAt?: Date | null }>;
  revenue: Array<Record<string, unknown>>;
  ledger: Array<Record<string, unknown>>;
  accrued: Map<string, bigint>;
  installs: Array<{ listingId: string; buyerId: string; status: string }>;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === "object" && "in" in (cond as object)) {
      return ((cond as { in: unknown[] }).in).includes(v);
    }
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    return v === cond;
  });
}

function makeDb(opts: { balance?: bigint } = {}) {
  const state: State = {
    balances: new Map([["org_buyer", opts.balance ?? 10_000n]]),
    subs: new Map(),
    revenue: [],
    ledger: [],
    accrued: new Map(),
    installs: [{ listingId: "lst_1", buyerId: "org_buyer", status: "active" }],
  };
  let seq = 0;

  const tx: SubscriptionTx = {
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
    publisherProfile: {
      async update({ where, data }) {
        state.accrued.set(where.orgId, (state.accrued.get(where.orgId) ?? 0n) + data.pendingPayoutCents.increment);
        return {};
      },
    },
    agentSubscription: {
      async upsert({ where, create, update }) {
        const key = where.listingId_subscriberId;
        const existing = [...state.subs.values()].find(
          (s) => s.listingId === key.listingId && s.subscriberId === key.subscriberId,
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = { id: `sub_${++seq}`, ...create } as unknown as SubscriptionRow;
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
    loadDue: async ({ now: n }: { now: Date }) =>
      [...db.state.subs.values()]
        .filter((s) => s.currentPeriodEnd <= n && (s.status === "active" || s.status === "past_due"))
        .map((s) => ({ sub: { ...s }, listing: LISTING })),
    inTransaction: db.inTransaction,
  };
}

test("the tick renews what is due and degrades what cannot pay", async () => {
  const funded = await subscribed();
  assert.deepEqual(await runSubscriptionRenewalTick(tickDeps(funded, at(30))), {
    scanned: 1, renewed: 1, cancelled: 0, pastDue: 0, expired: 0, errors: 0,
  });

  const broke = await subscribed({ balance: 1_500n });
  assert.deepEqual(await runSubscriptionRenewalTick(tickDeps(broke, at(30.1))), {
    scanned: 1, renewed: 0, cancelled: 0, pastDue: 1, expired: 0, errors: 0,
  });
  // Grace retries: topping up inside the window renews and restores active.
  broke.state.balances.set("org_buyer", 5_000n);
  assert.deepEqual(await runSubscriptionRenewalTick(tickDeps(broke, at(31))), {
    scanned: 1, renewed: 1, cancelled: 0, pastDue: 0, expired: 0, errors: 0,
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
    loadDue: async (args: { now: Date; limit: number }) => {
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

test("a renewal after the listing left monthly pricing closes without charging and keeps the install", async () => {
  const { state, inTransaction, sub } = await subscribed();
  const outcome = await inTransaction((tx) =>
    renewSubscription(tx, { sub: sub(), listing: { ...LISTING, pricingModel: "per_request" }, now: at(30) }),
  );
  assert.deepEqual(outcome, { kind: "cancelled" });
  assert.equal(sub().status, "cancelled");
  assert.equal(state.installs[0]!.status, "active");
  assert.equal(state.revenue.length, 1);
  assert.equal(state.balances.get("org_buyer"), 8_500n);
});
