import assert from "node:assert/strict";
import test from "node:test";

import {
  chargeMarketplaceRequest,
  refundMarketplaceRequest,
  resolveInstallBilling,
  settleMarketplaceRequest,
  splitRevenue,
  type MarketplaceCharge,
  type MeteredInstall,
} from "../services/marketplaceMetering.js";

// Marketplace per-request metering (W2) — the money-IN half. The thing
// these tests exist to prevent is the bug they replaced: revenue accrued
// to a publisher that was never collected from a buyer.

const INSTALL: MeteredInstall = {
  installId: "ins_1",
  listingId: "lst_1",
  listingTitle: "Support Triage",
  publisherId: "org_pub",
  buyerId: "org_buyer",
  pricePerRequestCents: 250n,
};

// ============================================
// Resolution
// ============================================

function makeLookup(row: unknown) {
  const wheres: unknown[] = [];
  return {
    wheres,
    db: {
      agentInstall: {
        findFirst: async (args: { where: unknown }) => {
          wheres.push(args.where);
          return row as never;
        },
      },
    },
  };
}

function listingRow(
  over: Record<string, unknown> = {},
  installStatus = "active",
) {
  return {
    id: "ins_1",
    listingId: "lst_1",
    buyerId: "org_buyer",
    status: installStatus,
    listing: {
      title: "Support Triage",
      status: "published",
      publisherId: "org_pub",
      pricingModel: "per_request",
      pricePerRequestCents: 250n,
      ...over,
    },
  };
}

test("a per-request install resolves to a billable charge target", async () => {
  const { db, wheres } = makeLookup(listingRow());
  const billing = await resolveInstallBilling(db as never, {
    agentId: "agent_clone",
    orgId: "org_buyer",
  });

  assert.deepEqual(billing, { kind: "billable", install: INSTALL });
  // Keyed on the CLONE in the buyer's org — the publisher's own agent has
  // no install row pointing at it, so publishers are never billed for
  // running their own work.
  assert.deepEqual(wheres[0], {
    clonedAgentId: "agent_clone",
    buyerId: "org_buyer",
  });
});

test("nothing is billable when there is no install", async () => {
  const { db } = makeLookup(null);
  assert.deepEqual(
    await resolveInstallBilling(db as never, { agentId: "a", orgId: "o" }),
    { kind: "free" },
  );
});

test("free, monthly, unpublished and zero-priced listings are not billed", async () => {
  for (const over of [
    { pricingModel: "free" },
    { pricingModel: "monthly" },
    { pricingModel: "tokenized" },
    { status: "archived" },
    { status: "draft" },
    { pricePerRequestCents: 0n },
    { pricePerRequestCents: null },
  ]) {
    const { db } = makeLookup(listingRow(over));
    assert.deepEqual(
      await resolveInstallBilling(db as never, { agentId: "a", orgId: "o" }),
      { kind: "free" },
      `expected no billing for ${JSON.stringify(over, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`,
    );
  }
});

test("uninstalling revokes the clone — it does not make it free", async () => {
  // The one-click bypass this closes: flip the install to `uninstalled`
  // and the metered lookup used to return "not billable", leaving the
  // publisher's agent fully runnable for nothing.
  for (const installStatus of ["uninstalled", "stopped"]) {
    const { db } = makeLookup(listingRow({}, installStatus));
    assert.deepEqual(
      await resolveInstallBilling(db as never, { agentId: "a", orgId: "o" }),
      { kind: "revoked", listingTitle: "Support Triage" },
      `expected revocation for install status ${installStatus}`,
    );
  }
});

test("revocation outranks pricing — even a free listing's clone stops", async () => {
  const { db } = makeLookup(listingRow({ pricingModel: "free" }, "uninstalled"));
  assert.deepEqual(
    await resolveInstallBilling(db as never, { agentId: "a", orgId: "o" }),
    { kind: "revoked", listingTitle: "Support Triage" },
  );
});

// ============================================
// Split
// ============================================

test("the split is exact at every price — fee + creator always equals gross", () => {
  for (const price of [1n, 3n, 7n, 99n, 250n, 1_000n, 12_345n]) {
    for (const count of [1, 2, 7]) {
      const s = splitRevenue(price, count);
      assert.equal(s.grossCents, price * BigInt(count));
      assert.equal(
        s.platformFeeCents + s.creatorCents,
        s.grossCents,
        `split did not sum at ${price}x${count}`,
      );
      assert.ok(s.platformFeeCents >= 0n && s.creatorCents >= 0n);
    }
  }
});

test("the platform takes 10% and the creator takes the rest", () => {
  const s = splitRevenue(250n, 1);
  assert.equal(s.grossCents, 250n);
  assert.equal(s.platformFeeCents, 25n);
  assert.equal(s.creatorCents, 225n);
});

// ============================================
// Fake DB
// ============================================

interface FakeState {
  balance: bigint;
  ledger: Array<{ type: string; amountCents: bigint; referenceId: string; balanceAfter: bigint }>;
  revenue: Map<string, { status: string; settledAt: Date | null; gross: bigint; creator: bigint }>;
  publisher: { total: bigint; pending: bigint };
  installCounters: { requests: bigint; spent: bigint };
  listingCounters: { requests: bigint };
  nextRevenueId: number;
}

function makeDb(startBalance: bigint) {
  const state: FakeState = {
    balance: startBalance,
    ledger: [],
    revenue: new Map(),
    publisher: { total: 0n, pending: 0n },
    installCounters: { requests: 0n, spent: 0n },
    listingCounters: { requests: 0n },
    nextRevenueId: 1,
  };

  const tx = {
    creditBalance: {
      updateMany: async (args: {
        where: { orgId: string; balanceCents: { gte: bigint } };
        data: { balanceCents: { decrement: bigint } };
      }) => {
        // The conditional decrement IS the concurrency guard.
        if (state.balance < args.where.balanceCents.gte) return { count: 0 };
        state.balance -= args.data.balanceCents.decrement;
        return { count: 1 };
      },
      findUnique: async () => ({ balanceCents: state.balance }),
      update: async (args: { data: { balanceCents: { increment: bigint } } }) => {
        state.balance += args.data.balanceCents.increment;
        return { balanceCents: state.balance };
      },
    },
    creditTransaction: {
      create: async (args: {
        data: {
          type: string;
          amountCents: bigint;
          referenceId: string;
          balanceAfter: bigint;
        };
      }) => {
        state.ledger.push({ ...args.data });
        return {};
      },
    },
    marketplaceRevenue: {
      create: async (args: {
        data: { grossAmountCents: bigint; creatorAmountCents: bigint; status: string };
      }) => {
        const id = `rev_${state.nextRevenueId++}`;
        state.revenue.set(id, {
          status: args.data.status,
          settledAt: null,
          gross: args.data.grossAmountCents,
          creator: args.data.creatorAmountCents,
        });
        return { id };
      },
      updateMany: async (args: {
        where: { id: string; status: string };
        data: { status: string; settledAt?: Date };
      }) => {
        const row = state.revenue.get(args.where.id);
        if (!row || row.status !== args.where.status) return { count: 0 };
        row.status = args.data.status;
        if (args.data.settledAt) row.settledAt = args.data.settledAt;
        return { count: 1 };
      },
    },
    publisherProfile: {
      update: async (args: {
        data: {
          totalRevenueCents: { increment: bigint };
          pendingPayoutCents: { increment: bigint };
        };
      }) => {
        state.publisher.total += args.data.totalRevenueCents.increment;
        state.publisher.pending += args.data.pendingPayoutCents.increment;
        return {};
      },
    },
    agentInstall: {
      update: async (args: {
        data: { totalRequests: { increment: bigint }; totalSpentCents: { increment: bigint } };
      }) => {
        state.installCounters.requests += args.data.totalRequests.increment;
        state.installCounters.spent += args.data.totalSpentCents.increment;
        return {};
      },
    },
    agentListing: {
      update: async (args: { data: { totalRequests: { increment: bigint } } }) => {
        state.listingCounters.requests += args.data.totalRequests.increment;
        return {};
      },
    },
  };

  return { state, tx };
}

// ============================================
// Charge
// ============================================

test("charging debits the buyer and opens a PENDING revenue row", async () => {
  const { state, tx } = makeDb(1_000n);
  const result = await chargeMarketplaceRequest(tx as never, { install: INSTALL });

  assert.equal(result.ok, true);
  assert.equal(state.balance, 750n);

  const entry = state.ledger[0]!;
  assert.equal(entry.type, "marketplace_usage");
  assert.equal(entry.amountCents, -250n);
  assert.equal(entry.balanceAfter, 750n);
  // The ledger row points at the revenue row, so the buyer's debit and
  // the creator's credit are correlatable from either side.
  assert.equal(entry.referenceId, "rev_1");

  const row = state.revenue.get("rev_1")!;
  assert.equal(row.status, "pending");
  assert.equal(row.settledAt, null);

  // Nothing has accrued to the publisher yet — the agent has not run.
  assert.equal(state.publisher.pending, 0n);
  assert.equal(state.installCounters.requests, 0n);
});

test("a buyer who cannot pay is refused BEFORE the agent runs", async () => {
  const { state, tx } = makeDb(100n);
  const result = await chargeMarketplaceRequest(tx as never, { install: INSTALL });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "insufficient_credits");
  assert.equal(result.requiredCents, 250n);
  assert.equal(result.balanceCents, 100n);

  // No debit, no revenue row, no ledger noise.
  assert.equal(state.balance, 100n);
  assert.equal(state.revenue.size, 0);
  assert.equal(state.ledger.length, 0);
});

test("concurrent requests against a balance that covers one cannot both pass", async () => {
  const { state, tx } = makeDb(250n);
  const [a, b] = await Promise.all([
    chargeMarketplaceRequest(tx as never, { install: INSTALL }),
    chargeMarketplaceRequest(tx as never, { install: INSTALL }),
  ]);

  assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
  assert.equal(state.balance, 0n);
});

test("a multi-request charge bills the multiple", async () => {
  const { state, tx } = makeDb(1_000n);
  const result = await chargeMarketplaceRequest(tx as never, {
    install: INSTALL,
    requestCount: 3,
  });
  assert.equal(result.ok, true);
  assert.equal(state.balance, 250n);
});

// ============================================
// Settle
// ============================================

async function charged(startBalance = 1_000n) {
  const db = makeDb(startBalance);
  const result = await chargeMarketplaceRequest(db.tx as never, { install: INSTALL });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return { ...db, charge: result.charge as MarketplaceCharge };
}

test("settling accrues the creator's share and counts the delivered request", async () => {
  const { state, tx, charge } = await charged();
  const result = await settleMarketplaceRequest(tx as never, { charge });

  assert.deepEqual(result, { settled: true, creatorCents: 225n });
  assert.equal(state.revenue.get("rev_1")!.status, "settled");
  assert.equal(state.publisher.pending, 225n);
  assert.equal(state.publisher.total, 225n);
  assert.equal(state.installCounters.requests, 1n);
  assert.equal(state.installCounters.spent, 250n);
  assert.equal(state.listingCounters.requests, 1n);

  // The invariant the old fabricating writer broke: every cent the
  // publisher can withdraw came out of a buyer's balance.
  assert.equal(state.publisher.pending + 25n, 1_000n - state.balance);
});

test("settling twice credits the publisher once", async () => {
  const { state, tx, charge } = await charged();
  await settleMarketplaceRequest(tx as never, { charge });
  const second = await settleMarketplaceRequest(tx as never, { charge });

  assert.deepEqual(second, { settled: false, reason: "not_pending" });
  assert.equal(state.publisher.pending, 225n);
  assert.equal(state.installCounters.requests, 1n);
});

// ============================================
// Refund
// ============================================

test("a failed request is refunded in full and never becomes revenue", async () => {
  const { state, tx, charge } = await charged();
  const result = await refundMarketplaceRequest(tx as never, {
    charge,
    reason: "model timeout",
  });

  assert.deepEqual(result, { refunded: true, amountCents: 250n });
  assert.equal(state.balance, 1_000n);
  assert.equal(state.revenue.get("rev_1")!.status, "refunded");
  assert.equal(state.publisher.pending, 0n);
  assert.equal(state.installCounters.requests, 0n);

  const refundEntry = state.ledger.at(-1)!;
  assert.equal(refundEntry.type, "marketplace_refund");
  assert.equal(refundEntry.amountCents, 250n);
  assert.equal(refundEntry.balanceAfter, 1_000n);
  assert.equal(refundEntry.referenceId, "rev_1");
});

test("refunding twice gives the money back once", async () => {
  const { state, tx, charge } = await charged();
  await refundMarketplaceRequest(tx as never, { charge, reason: "x" });
  const second = await refundMarketplaceRequest(tx as never, { charge, reason: "x" });

  assert.deepEqual(second, { refunded: false, reason: "not_pending" });
  assert.equal(state.balance, 1_000n);
});

test("a settled charge cannot then be refunded, and vice versa", async () => {
  const settledFirst = await charged();
  await settleMarketplaceRequest(settledFirst.tx as never, { charge: settledFirst.charge });
  const lateRefund = await refundMarketplaceRequest(settledFirst.tx as never, {
    charge: settledFirst.charge,
    reason: "late",
  });
  assert.deepEqual(lateRefund, { refunded: false, reason: "not_pending" });
  assert.equal(settledFirst.state.balance, 750n);

  const refundedFirst = await charged();
  await refundMarketplaceRequest(refundedFirst.tx as never, {
    charge: refundedFirst.charge,
    reason: "failed",
  });
  const lateSettle = await settleMarketplaceRequest(refundedFirst.tx as never, {
    charge: refundedFirst.charge,
  });
  assert.deepEqual(lateSettle, { settled: false, reason: "not_pending" });
  assert.equal(refundedFirst.state.publisher.pending, 0n);
});
