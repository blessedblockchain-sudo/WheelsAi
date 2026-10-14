import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "./unitEnv.js";
import { settleMarketplaceRequest, splitRevenue } from "../services/marketplaceMetering.js";
import { X402_SALE_TYPE, recordX402Sale, x402PricePaidCents, type X402SaleInput } from "../services/x402Sale.js";
import { earningsStandIn } from "./earningsStandIn.js";
import { FakeX402Db, TREASURY, type PaymentRow } from "./x402StandIns.js";

// The sale a confirmed payment at a listing's x402 door becomes: one
// transaction, one revenue row with no buyer, 90 and 10 of the price PAID,
// the creator credited once through the earnings ledger, and nothing that
// is anyone's credits.

const NOW = new Date("2026-10-14T12:00:00.000Z");
const LISTING = "4f8b1c2d-0000-4000-8000-0000000000aa";
const PUBLISHER = "0f1e2d3c-4b5a-4968-8776-6554433221bb";
const PAYER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

let payments = 0;

/** A door payment the chain has confirmed, still "submitted", as the request holds it. */
function confirmed(db: FakeX402Db, over: Partial<PaymentRow> = {}): PaymentRow {
  payments += 1;
  const row = db.insert(
    {
      orgId: PUBLISHER,
      deploymentId: null,
      listingId: LISTING,
      messageHash: `${payments}`.padStart(64, "c"),
      requestId: `nonce-${payments}`,
      network: "solana:devnet",
      asset: "USDC",
      amountRaw: "500000",
      amountUsd: 0.5,
      payerAddress: `${PAYER}${payments}`,
      payeeAddress: TREASURY,
      txSignature: `door-sig-${payments}`,
      status: "submitted",
      signedTxB64: "AAEC",
      recentBlockhash: "door-hash",
      amountReceivedRaw: null,
      amountMicroUsd: 500_000n,
      solMicroUsdPerSol: null,
      submittedAt: NOW,
      verifiedAt: null,
    },
    NOW,
  );
  if (Object.keys(over).length > 0) db.payments.set(row.id, { ...row, ...over });
  db.writes.length = 0;
  return db.payments.get(row.id)!;
}

function world(options: { profile?: boolean; listing?: boolean } = {}) {
  const db = new FakeX402Db();
  if (options.listing !== false) {
    db.listings.set(LISTING, { agentId: "agent-1", useModelCostMicros: 0n, totalRequests: 7n });
  }
  if (options.profile !== false) {
    db.profiles.set(PUBLISHER, { pendingPayoutCents: 100n, totalRevenueCents: 1_000n });
  }
  return db;
}

function saleOf(row: PaymentRow, over: Partial<X402SaleInput> = {}): X402SaleInput {
  return {
    paymentId: row.id,
    listingId: LISTING,
    listingTitle: "Code reviewer",
    publisherId: PUBLISHER,
    payerWallet: row.payerAddress,
    amountRaw: row.amountRaw,
    now: NOW,
    ...over,
  };
}

const sell = (db: FakeX402Db, input: X402SaleInput) => db.$saleTransaction((tx) => recordX402Sale(tx, input));

/** Nothing of a sale was written: the payment still waits, and no money moved. */
function nothingWritten(db: FakeX402Db, row: PaymentRow, listingTotal = 7n) {
  const after = db.payments.get(row.id)!;
  assert.equal(after.status, "submitted");
  assert.equal(after.servedAt, null);
  assert.equal(after.verifiedAt, null);
  assert.equal(after.amountReceivedRaw, null);
  assert.deepEqual(db.revenues, []);
  assert.deepEqual(db.earnings, []);
  if (db.profiles.has(PUBLISHER)) {
    assert.deepEqual(db.profiles.get(PUBLISHER), { pendingPayoutCents: 100n, totalRevenueCents: 1_000n });
  }
  if (db.listings.has(LISTING)) assert.equal(db.listings.get(LISTING)!.totalRequests, listingTotal);
}

// ============================================
// The sale
// ============================================

test("a confirmed payment becomes one sale with no buyer: the wallet, 90 and 10 of the price paid, credited through the ledger", async () => {
  const db = world();
  const row = confirmed(db);
  const result = await sell(db, saleOf(row));

  assert.equal(result.written, true);
  const revenueId = result.written ? result.revenueId : "";
  assert.deepEqual(result, {
    written: true,
    revenueId,
    split: { grossCents: 50n, platformFeeCents: 5n, creatorCents: 45n, modelCostCents: 0n },
  });
  assert.deepEqual(db.revenues, [
    {
      id: revenueId,
      listingId: LISTING,
      publisherId: PUBLISHER,
      buyerId: null,
      installId: null,
      payerWallet: row.payerAddress,
      x402PaymentId: row.id,
      type: "x402",
      grossAmountCents: 50n,
      platformFeeCents: 5n,
      creatorAmountCents: 45n,
      requestCount: 1,
      status: "settled",
      settledAt: NOW,
    },
  ]);
  // One sale in the earnings ledger, whose reference is that revenue row.
  assert.deepEqual(db.earnings, [
    {
      orgId: PUBLISHER,
      amountCents: 45n,
      type: "sale",
      referenceId: revenueId,
      description: "Sale: Code reviewer",
      balanceAfter: 145n,
    },
  ]);
  assert.deepEqual(db.profiles.get(PUBLISHER), { pendingPayoutCents: 145n, totalRevenueCents: 1_045n });

  // The payment is verified and served in the same transaction.
  const paid = db.payments.get(row.id)!;
  assert.equal(paid.status, "verified");
  assert.deepEqual(paid.servedAt, NOW);
  assert.deepEqual(paid.verifiedAt, NOW);
  assert.equal(paid.amountReceivedRaw, "500000");

  // The listing's count goes up by one; no install, no credit row, no balance.
  assert.equal(db.listings.get(LISTING)!.totalRequests, 8n);
  assert.deepEqual(db.ledger, []);
  assert.equal(db.balances.size, 0);
  assert.equal(X402_SALE_TYPE, "x402");
});

test("the split is every sale's split, of the price paid in whole cents", () => {
  for (const cents of [5n, 7n, 50n, 99n, 1_000n]) {
    assert.deepEqual(splitRevenue(x402PricePaidCents((cents * 10_000n).toString()), 1), splitRevenue(cents, 1));
  }
  assert.throws(() => x402PricePaidCents("50001"), /whole number of cents/);
  assert.throws(() => x402PricePaidCents("0"), /whole number/);
  assert.throws(() => x402PricePaidCents("-50000"), /whole number/);
  assert.throws(() => x402PricePaidCents("5e4"), /whole number/);
});

test("the price is the one paid on the row, never the listing's price read again", async () => {
  const db = world();
  // A 7-cent payment: the listing's price may have moved since.
  const row = confirmed(db, { amountRaw: "70000" });
  const result = await sell(db, saleOf(row));
  assert.equal(result.written && result.split.grossCents, 7n);
  assert.equal(db.revenues[0]!.grossAmountCents, 7n);
  assert.equal(db.revenues[0]!.platformFeeCents + db.revenues[0]!.creatorAmountCents, 7n);
});

test("an amount that is not whole cents throws, and nothing is written", async () => {
  const db = world();
  const row = confirmed(db, { amountRaw: "50001" });
  await assert.rejects(sell(db, saleOf(row)), /whole number of cents/);
  nothingWritten(db, row);
});

// ============================================
// Once
// ============================================

test("run twice for one payment it writes once: the second finds the payment no longer submitted", async () => {
  const db = world();
  const row = confirmed(db);
  assert.equal((await sell(db, saleOf(row))).written, true);
  assert.deepEqual(await sell(db, saleOf(row)), { written: false });
  assert.equal(db.revenues.length, 1);
  assert.equal(db.earnings.length, 1);
  assert.equal(db.profiles.get(PUBLISHER)!.pendingPayoutCents, 145n);
  assert.equal(db.listings.get(LISTING)!.totalRequests, 8n);
});

test("two sales of one payment at the same moment: one is written", async () => {
  const db = world();
  const row = confirmed(db);
  const results = await Promise.all([sell(db, saleOf(row)), sell(db, saleOf(row))]);
  assert.deepEqual(
    results.map((r) => r.written).sort(),
    [false, true],
  );
  assert.equal(db.revenues.length, 1);
  assert.equal(db.earnings.length, 1);
});

test("a second revenue row for the same payment is refused by the unique, and everything of that run rolls back", async () => {
  const db = world();
  const row = confirmed(db);
  assert.equal((await sell(db, saleOf(row))).written, true);
  // As if the payment's row had been put back to "submitted": the
  // compare-and-set passes, and the database's unique still holds.
  db.payments.set(row.id, { ...db.payments.get(row.id)!, status: "submitted", servedAt: null, verifiedAt: null });
  await assert.rejects(sell(db, saleOf(row)), (err: { code?: string; meta?: { target?: unknown } }) => {
    assert.equal(err.code, "P2002");
    assert.deepEqual(err.meta?.target, ["x402_payment_id"]);
    return true;
  });
  assert.equal(db.revenues.length, 1);
  assert.equal(db.earnings.length, 1);
  assert.equal(db.payments.get(row.id)!.status, "submitted", "the run that failed wrote nothing");
  assert.equal(db.listings.get(LISTING)!.totalRequests, 8n);
});

test("a payment that is not this one, as it was claimed, writes nothing", async () => {
  const cases: Array<[string, (row: PaymentRow) => Partial<PaymentRow>, Partial<X402SaleInput>]> = [
    ["still held", () => ({ status: "held", txSignature: null }), {}],
    ["already verified", () => ({ status: "verified" }), {}],
    ["already served", () => ({ servedAt: NOW }), {}],
    ["failed", () => ({ status: "failed" }), {}],
    ["another listing's", () => ({}), { listingId: "other-listing" }],
    ["another publisher's", () => ({}), { publisherId: "other-org" }],
    ["another wallet's", () => ({}), { payerWallet: "another-wallet" }],
    ["another amount", () => ({}), { amountRaw: "50000" }],
    ["a deployment's payment", () => ({ listingId: null, messageHash: null, deploymentId: "dep-1" }), {}],
  ];
  for (const [why, change, over] of cases) {
    const db = world();
    const base = confirmed(db);
    const row = { ...base, ...change(base) };
    db.payments.set(row.id, row);
    assert.deepEqual(await sell(db, saleOf(base, over)), { written: false }, why);
    assert.deepEqual(db.revenues, [], why);
    assert.deepEqual(db.earnings, [], why);
    assert.deepEqual(db.payments.get(row.id), row, why);
  }
});

// ============================================
// What rolls back, and what does not
// ============================================

test("a publisher with no profile rolls everything back and leaves the payment submitted", async () => {
  const db = world({ profile: false });
  const row = confirmed(db);
  await assert.rejects(sell(db, saleOf(row, { modelCostMicros: 3_000_000n })), /No publisher profile/);
  nothingWritten(db, row);
  assert.equal(db.listings.get(LISTING)!.useModelCostMicros, 0n, "the model cost's running total rolled back too");
});

test("the listing is gone (its agent deleted while the payment waited): the sale and the credit are still written", async () => {
  const db = world({ listing: false });
  const row = confirmed(db);
  const result = await sell(db, saleOf(row, { modelCostMicros: 3_000_000n }));
  // The payer paid for an answer that was made; the publisher is known from the row.
  assert.deepEqual(result, {
    written: true,
    revenueId: db.revenues[0]!.id,
    split: { grossCents: 50n, platformFeeCents: 5n, creatorCents: 45n, modelCostCents: 0n },
  });
  assert.equal(db.revenues[0]!.listingId, LISTING);
  assert.equal(db.earnings.length, 1);
  assert.equal(db.earnings[0]!.amountCents, 45n);
  assert.equal(db.payments.get(row.id)!.status, "verified");
  assert.equal(db.listings.size, 0, "no listing row was made up");
});

// ============================================
// The model cost
// ============================================

/** What settleMarketplaceRequest takes of the same uses, on a listing of its own. */
async function settleTakes(priceCents: bigint, costs: bigint[]) {
  let total = 0n;
  const taken: Array<{ modelCostCents: bigint; creatorCents: bigint; platformFeeCents: bigint }> = [];
  for (const cost of costs) {
    const split = splitRevenue(priceCents, 1);
    const revenue = { platformFeeCents: split.platformFeeCents, creatorAmountCents: split.creatorCents };
    const tx = {
      marketplaceRevenue: {
        updateMany: async () => ({ count: 1 }),
        update: async ({ data }: { data: { platformFeeCents: { increment: bigint }; creatorAmountCents: { decrement: bigint } } }) => {
          revenue.platformFeeCents += data.platformFeeCents.increment;
          revenue.creatorAmountCents -= data.creatorAmountCents.decrement;
          return {};
        },
      },
      agentListing: {
        update: async ({ data }: { data: { useModelCostMicros?: { increment: bigint } } }) => {
          if (data.useModelCostMicros) total += data.useModelCostMicros.increment;
          return { useModelCostMicros: total };
        },
      },
      agentInstall: { update: async () => ({}) },
      ...earningsStandIn({ pending: () => 0n, add: () => {}, write: () => {} }),
    };
    const result = await settleMarketplaceRequest(tx as unknown as Parameters<typeof settleMarketplaceRequest>[0], {
      charge: {
        ...split,
        revenueId: "rev",
        requestCount: 1,
        install: {
          installId: "install",
          listingId: "listing",
          listingTitle: "Code reviewer",
          publisherId: PUBLISHER,
          buyerId: "buyer-org",
          pricePerRequestCents: priceCents,
          kind: "use",
        },
      },
      modelCostMicros: cost,
    });
    assert.equal(result.settled, true);
    taken.push({
      modelCostCents: (result.settled && result.modelCostCents) || 0n,
      creatorCents: revenue.creatorAmountCents,
      platformFeeCents: revenue.platformFeeCents,
    });
  }
  return taken;
}

test("the model cost is taken as settleMarketplaceRequest takes it for the same uses: crossed cents, never more than the creator's", async () => {
  // 1.3 cents, then 1.3 (2.6 in all: one more cent crossed), then nothing,
  // then far more than the creator's amount.
  const costs = [1_300_000n, 1_300_000n, 0n, 900_000_000n];
  const want = await settleTakes(5n, costs);

  const db = world();
  const got: typeof want = [];
  for (const cost of costs) {
    const row = confirmed(db, { amountRaw: "50000" });
    const result = await sell(db, saleOf(row, { modelCostMicros: cost }));
    assert.equal(result.written, true);
    const revenue = db.revenues.at(-1)!;
    got.push({
      modelCostCents: result.written ? result.split.modelCostCents : -1n,
      creatorCents: revenue.creatorAmountCents,
      platformFeeCents: revenue.platformFeeCents,
    });
    // The sale's own answer says what its row says.
    assert.equal(result.written && result.split.creatorCents, revenue.creatorAmountCents);
    assert.equal(result.written && result.split.platformFeeCents, revenue.platformFeeCents);
  }
  assert.deepEqual(got, want);
  assert.deepEqual(
    got.map((g) => g.modelCostCents),
    [1n, 1n, 0n, 4n],
  );
  // What the creator was credited is what is left on each row.
  assert.deepEqual(
    db.earnings.map((e) => e.amountCents),
    got.map((g) => g.creatorCents).filter((c) => c > 0n),
  );
  assert.equal(db.listings.get(LISTING)!.useModelCostMicros, 902_600_000n);
});

// ============================================
// In the source
// ============================================

test("in the source: a sale from a wallet never touches credits, installs, or a creator's balance directly", () => {
  const source = readFileSync(fileURLToPath(new URL("../services/x402Sale.ts", import.meta.url)), "utf8");
  for (const forbidden of ["creditBalance", "creditTransaction", "agentInstall", "pendingPayoutCents", "process.env", "config/env"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(source, /\bmoveEarnings\(/);
  assert.match(source, /\bsplitRevenue\(/);
  assert.match(source, /\bcentsCrossed\(/);
  assert.match(source, /\bsplitCreatorRevenue\(/);
  assert.ok([...source].every((ch) => ch.charCodeAt(0) < 128), "ASCII");
});
