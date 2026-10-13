import assert from "node:assert/strict";
import test from "node:test";

import {
  MarketplaceLicenceRevokedError,
  chargeMarketplaceRequest,
  refundMarketplaceRequest,
  resolveInstallBilling,
  settleMarketplaceRequest,
  splitRevenue,
  type MarketplaceCharge,
  type MeteredInstall,
} from "../services/marketplaceMetering.js";
import { earningsStandIn, type EarningsRow } from "./earningsStandIn.js";

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
    // The buyer agreed to the listing as it is here, unless a test says
    // otherwise (see "the pricing a buyer accepted" below).
    acceptedPricingModel: (over.pricingModel as string | undefined) ?? "per_request",
    acceptedPricePerRequestCents:
      "pricePerRequestCents" in over ? (over.pricePerRequestCents as bigint | null) : 250n,
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

// Monthly listings are covered by marketplaceSubscriptions.unit.test.ts:
// they run only while a subscription grants access.
test("free, unpublished and zero-priced listings are not billed", async () => {
  for (const over of [
    { pricingModel: "free" },
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
      { kind: "revoked", listingTitle: "Support Triage", reason: "uninstalled" },
      `expected revocation for install status ${installStatus}`,
    );
  }
});

test("revocation outranks pricing — even a free listing's clone stops", async () => {
  const { db } = makeLookup(listingRow({ pricingModel: "free" }, "uninstalled"));
  assert.deepEqual(
    await resolveInstallBilling(db as never, { agentId: "a", orgId: "o" }),
    { kind: "revoked", listingTitle: "Support Triage", reason: "uninstalled" },
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
  /** The creator's ledger: one row for every change to what they are owed. */
  earnings: EarningsRow[];
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
    earnings: [],
    installCounters: { requests: 0n, spent: 0n },
    listingCounters: { requests: 0n },
    nextRevenueId: 1,
  };

  const tx = {
    // The publisher is credited through the ledger (moveEarnings).
    ...earningsStandIn({
      pending: (orgId) => (orgId === INSTALL.publisherId ? state.publisher.pending : undefined),
      add: (_orgId, pending, total) => {
        state.publisher.pending += pending;
        state.publisher.total += total;
      },
      write: (row) => state.earnings.push(row),
    }),
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
  assert.deepEqual(state.earnings, []);
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
  // The credit has its ledger row: a sale, against the revenue row the
  // buyer's debit points at, with the balance it left.
  assert.deepEqual(state.earnings, [
    {
      orgId: "org_pub",
      amountCents: 225n,
      type: "sale",
      referenceId: "rev_1",
      description: "Sale: Support Triage",
      balanceAfter: 225n,
    },
  ]);
  assert.equal(state.earnings[0]!.referenceId, state.ledger[0]!.referenceId);
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
  assert.equal(state.earnings.length, 1);
  assert.equal(state.installCounters.requests, 1n);
});

test("a second sale's row carries the balance the two sales left", async () => {
  const { state, tx, charge } = await charged();
  await settleMarketplaceRequest(tx as never, { charge });
  const next = await chargeMarketplaceRequest(tx as never, { install: INSTALL });
  assert.equal(next.ok, true);
  if (!next.ok) throw new Error("unreachable");
  await settleMarketplaceRequest(tx as never, { charge: next.charge as MarketplaceCharge });

  assert.equal(state.publisher.pending, 450n);
  assert.deepEqual(
    state.earnings.map((row) => [row.type, row.amountCents, row.referenceId, row.balanceAfter]),
    [
      ["sale", 225n, "rev_1", 225n],
      ["sale", 225n, "rev_2", 450n],
    ],
  );
});

test("settling for a publisher with no profile throws, so the settle rolls back", async () => {
  const { state, tx, charge } = await charged();
  await assert.rejects(
    settleMarketplaceRequest(tx as never, {
      charge: { ...charge, install: { ...charge.install, publisherId: "org_gone" } },
    }),
    /No publisher profile to credit a sale to \(organization org_gone\)/,
  );
  assert.equal(state.publisher.pending, 0n);
  assert.deepEqual(state.earnings, []);
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
  // The publisher was never credited, so their ledger has nothing to undo.
  assert.deepEqual(state.earnings, []);
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
  assert.deepEqual(refundedFirst.state.earnings, []);
});

// ============================================
// The pricing a buyer accepted
// ============================================

test("a buyer is never charged a per-request price above the one they accepted", async () => {
  const args = { agentId: "agent_clone", orgId: "org_buyer" };
  const resolve = (row: Record<string, unknown>) => resolveInstallBilling(makeLookup(row).db as never, args);
  const accepted = (model: string | null, cents: bigint | null) => ({
    acceptedPricingModel: model,
    acceptedPricePerRequestCents: cents,
  });

  // Agreed to 250; the publisher raised it to 900. Not billable at any
  // price: the clone is paused until the buyer accepts.
  assert.deepEqual(await resolve({ ...listingRow({ pricePerRequestCents: 900n }), ...accepted("per_request", 250n) }), {
    kind: "revoked",
    listingTitle: "Support Triage",
    reason: "pricing_changed",
  });

  // Lowered to 100: charged the lower price at once.
  const lowered = await resolve({ ...listingRow({ pricePerRequestCents: 100n }), ...accepted("per_request", 250n) });
  assert.equal(lowered.kind, "billable");
  assert.equal(lowered.kind === "billable" && lowered.install.pricePerRequestCents, 100n);
  // Exactly the agreed price is charged as agreed.
  const same = await resolve({ ...listingRow(), ...accepted("per_request", 250n) });
  assert.equal(same.kind === "billable" && same.install.pricePerRequestCents, 250n);

  // Installed free; the listing started charging.
  assert.equal((await resolve({ ...listingRow(), ...accepted("free", null) })).kind, "revoked");
  // No acceptance on record (a row older than the column): fail closed.
  assert.equal((await resolve({ ...listingRow(), ...accepted(null, null) })).kind, "revoked");
  const { acceptedPricingModel: _m, acceptedPricePerRequestCents: _c, ...legacy } = listingRow();
  assert.equal((await resolve(legacy)).kind, "revoked");

  // Agreed to pay; the listing went free. Nothing to accept.
  assert.deepEqual(
    await resolve({ ...listingRow({ pricingModel: "free", pricePerRequestCents: null }), ...accepted("per_request", 250n) }),
    { kind: "free" },
  );
  // Token-gated now, which the buyer never agreed to.
  assert.equal(
    (await resolve({ ...listingRow({ pricingModel: "tokenized", pricePerRequestCents: null }), ...accepted("free", null) })).kind,
    "revoked",
  );
});

test("the refusal a paused buyer reads says what to do and that nothing is charged", () => {
  const message = new MarketplaceLicenceRevokedError("Support Triage", "pricing_changed").message;
  assert.match(message, /changed its pricing after you agreed to it/);
  assert.match(message, /nothing is charged/);
  assert.match(message, /accept the new pricing from Installed Agents/);
});

// ============================================
// A plan on the licence of a copy
// ============================================

test("a plan that is running is never a paid month for a copy left on the licence", async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const args = { agentId: "agent_clone", orgId: "org_buyer" };
  // The subscription read returns only the columns asked for, so a read
  // that leaves the count out sees a month with no count.
  const resolve = (install: Record<string, unknown>, sub: Record<string, unknown>) =>
    resolveInstallBilling(
      {
        ...makeLookup(install).db,
        agentSubscription: {
          findUnique: async ({ select }: { select: Record<string, true> }) =>
            Object.fromEntries(Object.keys(select).map((column) => [column, sub[column]])),
        },
      } as never,
      args,
    );
  const running = { status: "active", currentPeriodEnd: new Date(Date.now() + 20 * DAY), cancelAtPeriodEnd: false, endReason: null };
  const plan = { ...running, includedUses: 1 };

  // The licence was for a copy and a plan was started over it: the plan
  // start cleared the agreement to a price per request. The copy does not
  // run free for the 30 days; it waits for the buyer to agree to a price.
  assert.deepEqual(
    await resolve({ ...listingRow(), acceptedPricingModel: null, acceptedPricePerRequestCents: null }, plan),
    { kind: "revoked", listingTitle: "Support Triage", reason: "pricing_changed" },
  );
  // A buyer who agreed to a price per use themselves is charged it for the
  // copy, as before the plan.
  const charged = await resolve(listingRow(), plan);
  assert.equal(charged.kind === "billable" && charged.install.pricePerRequestCents, 250n);

  // A month with no count is what it was: paid up, so the copy is free.
  assert.deepEqual(await resolve(listingRow(), { ...running, includedUses: null }), { kind: "free" });
});
