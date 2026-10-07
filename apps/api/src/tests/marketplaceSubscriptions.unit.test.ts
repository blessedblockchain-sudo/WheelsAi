import assert from "node:assert/strict";
import test from "node:test";

import {
  InsufficientCreditsError,
  markPastDueOrExpire,
  renewSubscription,
  startMonthlySubscription,
  SubscriptionClaimLostError,
  type ListingForBilling,
  type SubscriptionRow,
  type SubscriptionTx,
} from "../services/marketplaceSubscriptions.js";
import { resolveInstallBilling } from "../services/marketplaceMetering.js";
import { runSubscriptionRenewalTick } from "../services/runSubscriptionRenewalTick.js";
import { installAccess, subscriptionGrantsAccess } from "../services/subscriptionAccess.js";

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
      async findUnique({ where }) {
        const key = where.listingId_subscriberId;
        const existing = [...state.subs.values()].find(
          (s) => s.listingId === key.listingId && s.subscriberId === key.subscriberId,
        );
        return existing ? { ...existing } : null;
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
    scanned: 4, renewed: 0, cancelled: 0, pastDue: 0, expired: 0, errors: 4,
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
