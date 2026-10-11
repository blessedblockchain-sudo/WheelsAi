/**
 * Drives apps/api/src/services/depositCredit.ts against an in-memory
 * database that keeps compare-and-set, the unique indexes and rollback.
 *
 * Pinning:
 *   - a transfer sent straight to the address: USDC exact and rounded
 *     down, SOL from the quote, the bonus ladder, the ledger description;
 *   - no price: the receipt is "detected" and nothing is granted, and a
 *     later try credits it at the price it then gets;
 *   - under one cent: "ignored";
 *   - the same transfer credits once, by the pre-check and by the unique
 *     index when two writers meet;
 *   - a prepared top-up found on the chain is credited THROUGH its row at
 *     the row's own amounts from each of its five uncredited statuses, and
 *     never a second time as direct;
 *   - an amount that does not match the row is direct;
 *   - the submit path and the scan racing on one transfer credit once,
 *     whichever is first.
 */

import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import {
  SOL_ROW_PRICE_GRACE_MS,
  UNCREDITED_TOPUP_STATUSES,
  depositBonusCents,
  makeDepositCredit,
  type FoundTransfer,
} from "../services/depositCredit.js";
import type { ChainLabel } from "../services/depositTypes.js";
import type { SolPriceResult } from "../services/solPrice.js";
import { makeCreditTopup, type TopupCreditDb } from "../services/walletTopup.js";
import {
  DEVNET,
  ORG_1,
  ORG_2,
  QUOTE_200,
  TOPUP_1,
  TOPUP_2,
  addressOf,
  depositAddressOf,
  makeDb,
  topupRow,
} from "./depositStandIn.js";

const NOW = new Date("2026-10-11T09:00:00.000Z");
const PRICED: SolPriceResult = { ok: true, quote: QUOTE_200 };
const NO_PRICE: SolPriceResult = { ok: false, code: "stale" };

function setup(
  init: Parameters<typeof makeDb>[0] = {},
  opts: { price?: SolPriceResult; network?: ChainLabel; marginBps?: number } = {},
) {
  const world = makeDb(init);
  const price = { current: opts.price ?? PRICED, asked: 0 };
  const credit = makeDepositCredit(world.db, {
    network: opts.network ?? "solana:devnet",
    getSolQuote: async () => {
      price.asked += 1;
      return price.current;
    },
    solMarginBps: () => opts.marginBps ?? 0,
    now: () => NOW,
  });
  return { ...world, credit, price };
}

function found(over: Partial<FoundTransfer> = {}): FoundTransfer {
  return {
    orgId: ORG_1,
    depositAddress: depositAddressOf(ORG_1),
    asset: "USDC",
    amountRaw: 50_000_000n,
    txSignature: "sig_1",
    topupId: null,
    slot: 1_000n,
    blockTime: new Date("2026-10-11T08:59:00.000Z"),
    senderAddresses: [addressOf("sender")],
    ...over,
  };
}

// ============================================
// Sent straight to the address
// ============================================

test("USDC sent straight to the address: one dollar for one USDC, the bonus, one receipt, one grant", async () => {
  const w = setup();
  const outcome = await w.credit.creditFoundTransfer(found());
  assert.deepEqual(outcome, {
    outcome: "credited",
    source: "direct",
    creditedCents: 5_000n,
    bonusCents: 500n,
  });
  assert.equal(w.state.balances[ORG_1], 5_500n);
  assert.equal(w.state.receipts.length, 1);
  const receipt = w.state.receipts[0]!;
  assert.equal(receipt.source, "direct");
  assert.equal(receipt.status, "credited");
  assert.equal(receipt.network, DEVNET);
  assert.equal(receipt.asset, "USDC");
  assert.equal(receipt.amountRaw, 50_000_000n);
  assert.equal(receipt.amountUsdCents, 5_000n);
  assert.equal(receipt.bonusCents, 500n);
  assert.equal(receipt.topupId, null);
  assert.equal(receipt.slot, 1_000n);
  assert.deepEqual(receipt.creditedAt, NOW);
  assert.deepEqual(receipt.senderAddresses, [addressOf("sender")]);
  assert.equal(receipt.quotePriceMicroUsd, null, "no price exists for USDC");
  assert.equal(w.price.asked, 0);
  assert.deepEqual(
    w.state.ledger.map((l) => [l.type, l.amountCents, l.description, l.referenceId, l.balanceAfter]),
    [
      ["purchase", 5_000n, "[devnet] Deposit (USDC)", receipt.id, 5_000n],
      ["bonus", 500n, "[devnet] Bonus credits", receipt.id, 5_500n],
    ],
  );
});

test("on mainnet the grant carries no devnet label", async () => {
  const w = setup({}, { network: "solana:mainnet" });
  await w.credit.creditFoundTransfer(found({ amountRaw: 10_000_000n }));
  assert.deepEqual(w.state.ledger.map((l) => l.description), ["Deposit (USDC)"]);
  assert.equal(w.state.receipts[0]!.network, "solana:mainnet");
});

test("USDC cents are base units divided by 10,000, rounded down", async () => {
  const w = setup();
  const outcome = await w.credit.creditFoundTransfer(found({ amountRaw: 12_349_999n }));
  assert.ok(outcome.outcome === "credited");
  assert.equal(outcome.creditedCents, 1_234n);
  assert.equal(outcome.bonusCents, 0n);
});

test("the bonus is the ladder on the whole dollars credited", () => {
  assert.equal(depositBonusCents(4_999n), 0n);
  assert.equal(depositBonusCents(5_000n), 500n);
  assert.equal(depositBonusCents(9_999n), 500n);
  assert.equal(depositBonusCents(10_000n), 1_500n);
  assert.equal(depositBonusCents(50_000n), 10_000n);
  assert.equal(depositBonusCents(10n ** 30n), 10_000n);
  assert.equal(depositBonusCents(0n), 0n);
});

test("SOL sent straight to the address is valued by the quote, and the quote is recorded", async () => {
  const w = setup();
  const outcome = await w.credit.creditFoundTransfer(
    found({ asset: "SOL", amountRaw: 500_000_000n }),
  );
  assert.deepEqual(outcome, {
    outcome: "credited",
    source: "direct",
    creditedCents: 10_000n,
    bonusCents: 1_500n,
  });
  const receipt = w.state.receipts[0]!;
  assert.equal(receipt.quotePriceMicroUsd, 200_000_000n);
  assert.deepEqual(receipt.quotePublishTime, new Date(QUOTE_200.publishTime * 1000));
  assert.equal(receipt.quoteSource, "static");
  assert.deepEqual(w.state.ledger.map((l) => l.description), [
    "[devnet] Deposit (SOL)",
    "[devnet] Bonus credits",
  ]);
});

test("SOL is valued low: the margin leans against the sender and the cents round down", async () => {
  const w = setup({}, { marginBps: 100 });
  // 0.123456789 SOL at $200 less 1% is $24.44444..., so 2444 cents.
  const outcome = await w.credit.creditFoundTransfer(
    found({ asset: "SOL", amountRaw: 123_456_789n }),
  );
  assert.ok(outcome.outcome === "credited");
  assert.equal(outcome.creditedCents, 2_444n);
  assert.equal(w.state.receipts[0]!.quotePriceMicroUsd, 198_000_000n);
});

test("with no price a SOL transfer is recorded and waits: nothing is granted at a guessed price", async () => {
  const w = setup({}, { price: NO_PRICE });
  const outcome = await w.credit.creditFoundTransfer(
    found({ asset: "SOL", amountRaw: 500_000_000n }),
  );
  assert.deepEqual(outcome, { outcome: "waiting" });
  assert.equal(w.state.receipts.length, 1);
  assert.equal(w.state.receipts[0]!.status, "detected");
  assert.equal(w.state.receipts[0]!.amountUsdCents, null);
  assert.equal(w.state.ledger.length, 0);
  assert.equal(w.state.balances[ORG_1], undefined);
});

test("a price source that throws is no price", async () => {
  const world = makeDb();
  const credit = makeDepositCredit(world.db, {
    network: "solana:devnet",
    getSolQuote: async () => {
      throw new Error("node down");
    },
    solMarginBps: () => 0,
  });
  assert.deepEqual(
    await credit.creditFoundTransfer(found({ asset: "SOL", amountRaw: 1_000_000_000n })),
    { outcome: "waiting" },
  );
  assert.equal(world.state.ledger.length, 0);
});

test("a waiting receipt is credited later at the price it then gets, once", async () => {
  const w = setup({}, { price: NO_PRICE });
  await w.credit.creditFoundTransfer(found({ asset: "SOL", amountRaw: 500_000_000n }));
  const receipt = w.state.receipts[0]!;
  const detected = {
    id: receipt.id,
    orgId: ORG_1,
    asset: "SOL",
    amountRaw: 500_000_000n,
    txSignature: "sig_1",
  };

  assert.deepEqual(await w.credit.creditDetectedReceipt(detected), { outcome: "waiting" });
  assert.equal(receipt.status, "detected");

  w.price.current = PRICED;
  assert.deepEqual(await w.credit.creditDetectedReceipt(detected), {
    outcome: "credited",
    creditedCents: 10_000n,
    bonusCents: 1_500n,
  });
  assert.equal(receipt.status, "credited");
  assert.equal(receipt.amountUsdCents, 10_000n);
  assert.equal(receipt.bonusCents, 1_500n);
  assert.equal(receipt.quotePriceMicroUsd, 200_000_000n);
  assert.deepEqual(receipt.creditedAt, NOW);
  assert.equal(w.state.balances[ORG_1], 11_500n);
  assert.deepEqual(
    w.state.ledger.map((l) => [l.description, l.referenceId]),
    [
      ["[devnet] Deposit (SOL)", receipt.id],
      ["[devnet] Bonus credits", receipt.id],
    ],
  );

  assert.deepEqual(await w.credit.creditDetectedReceipt(detected), { outcome: "already" });
  assert.equal(w.state.balances[ORG_1], 11_500n, "a second try grants nothing");
  assert.equal(w.state.ledger.length, 2);

  // And the transfer itself, seen again, is skipped.
  assert.deepEqual(
    await w.credit.creditFoundTransfer(found({ asset: "SOL", amountRaw: 500_000_000n })),
    { outcome: "already" },
  );
});

test("under one cent is ignored: recorded, never granted", async () => {
  const w = setup();
  assert.deepEqual(await w.credit.creditFoundTransfer(found({ amountRaw: 9_999n })), {
    outcome: "ignored",
  });
  assert.deepEqual(
    await w.credit.creditFoundTransfer(found({ asset: "SOL", amountRaw: 1n, txSignature: "sig_2" })),
    { outcome: "ignored" },
  );
  assert.deepEqual(
    w.state.receipts.map((r) => [r.asset, r.status, r.ignoredReason]),
    [
      ["USDC", "ignored", "below_one_cent"],
      ["SOL", "ignored", "below_one_cent"],
    ],
  );
  assert.equal(w.state.ledger.length, 0);

  // One waiting for a price that turns out to be too small.
  const late = setup({}, { price: NO_PRICE });
  await late.credit.creditFoundTransfer(found({ asset: "SOL", amountRaw: 1n }));
  late.price.current = PRICED;
  const receipt = late.state.receipts[0]!;
  assert.deepEqual(
    await late.credit.creditDetectedReceipt({
      id: receipt.id,
      orgId: ORG_1,
      asset: "SOL",
      amountRaw: 1n,
      txSignature: "sig_1",
    }),
    { outcome: "ignored" },
  );
  assert.equal(receipt.status, "ignored");
  assert.equal(receipt.ignoredReason, "below_one_cent");
  assert.equal(late.state.ledger.length, 0);
});

// ============================================
// Once
// ============================================

test("the same signature seen twice credits once", async () => {
  const w = setup();
  await w.credit.creditFoundTransfer(found());
  assert.deepEqual(await w.credit.creditFoundTransfer(found()), { outcome: "already" });
  assert.equal(w.state.balances[ORG_1], 5_500n);
  assert.equal(w.state.receipts.length, 1);
  assert.equal(w.state.ledger.length, 2);
});

test("two writers meeting: the unique index refuses the second, its transaction rolls back, nothing is granted twice", async () => {
  const w = setup();
  await w.credit.creditFoundTransfer(found());
  // The second writer's first look finds no receipt (the first had not
  // committed yet); only the index stands between it and a second grant.
  const real = w.raw.onchainReceipt.findUnique;
  let looks = 0;
  w.raw.onchainReceipt.findUnique = async (args) => {
    looks += 1;
    return looks === 1 ? null : real(args);
  };
  assert.deepEqual(await w.credit.creditFoundTransfer(found()), { outcome: "already" });
  assert.equal(w.state.balances[ORG_1], 5_500n);
  assert.equal(w.state.receipts.length, 1);
  assert.equal(w.state.ledger.length, 2);
});

test("one transaction carrying both assets has one receipt an asset", async () => {
  const w = setup();
  await w.credit.creditFoundTransfer(found());
  const sol = await w.credit.creditFoundTransfer(found({ asset: "SOL", amountRaw: 100_000_000n }));
  assert.ok(sol.outcome === "credited");
  assert.deepEqual(
    w.state.receipts.map((r) => [r.txSignature, r.asset, r.status]),
    [
      ["sig_1", "USDC", "credited"],
      ["sig_1", "SOL", "credited"],
    ],
  );
  assert.equal(w.state.balances[ORG_1], 5_500n + 2_000n);
});

test("a unique violation that is not this transfer's receipt is thrown, never read as credited", async () => {
  const w = setup();
  w.raw.$transaction = (async () => {
    throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  }) as typeof w.raw.$transaction;
  await assert.rejects(w.credit.creditFoundTransfer(found()));
});

test("a failed grant leaves no receipt behind: the transfer can be tried again", async () => {
  const w = setup();
  const real = w.raw.$transaction;
  let fail = true;
  w.raw.$transaction = (async (fn: (tx: any) => Promise<unknown>) =>
    real(async (tx) => {
      const out = await fn(tx);
      if (fail) throw new Error("connection lost at commit");
      return out;
    })) as typeof w.raw.$transaction;
  await assert.rejects(w.credit.creditFoundTransfer(found()), /connection lost/);
  assert.equal(w.state.receipts.length, 0);
  assert.equal(w.state.ledger.length, 0);
  assert.equal(w.state.balances[ORG_1], undefined);
  fail = false;
  assert.equal((await w.credit.creditFoundTransfer(found())).outcome, "credited");
  assert.equal(w.state.balances[ORG_1], 5_500n);
});

// ============================================
// A prepared top-up found on the chain
// ============================================

for (const status of UNCREDITED_TOPUP_STATUSES) {
  test(`a prepared top-up found on the chain is credited through its row from "${status}", at its own amounts`, async () => {
    // A SOL row prepared at another price: its own cents are granted,
    // not what the quote says today.
    const unsigned = status === "prepared" || status === "expired";
    const row = topupRow({
      asset: "SOL",
      status,
      amountRaw: "300000000",
      amountUsdCents: 4_500n,
      bonusCents: 0n,
      txSignature: unsigned ? null : "sig_1",
      failureCode: status === "failed" ? "failed_on_chain" : status === "expired" ? "unsigned_expired" : null,
      quotePriceMicroUsd: 150_000_000n,
      quotePublishTime: new Date("2026-10-10T10:00:00.000Z"),
      quoteSource: "pyth",
    });
    const w = setup({ topups: [row] });
    const transfer = found({
      asset: "SOL",
      amountRaw: 300_000_000n,
      // An unsigned row is found by the memo; a signed one by its signature.
      topupId: unsigned ? TOPUP_1 : null,
    });
    const outcome = await w.credit.creditFoundTransfer(transfer);
    assert.deepEqual(outcome, {
      outcome: "credited",
      source: "prepared",
      creditedCents: 4_500n,
      bonusCents: 0n,
    });
    assert.equal(row.status, "credited");
    assert.equal(row.txSignature, "sig_1", "the signature is stored on a row that had none");
    assert.deepEqual(row.creditedAt, NOW);
    assert.equal(row.failureCode, null);
    assert.equal(w.price.asked, 0, "no price is asked for: the row has its own");

    assert.equal(w.state.receipts.length, 1);
    const receipt = w.state.receipts[0]!;
    assert.equal(receipt.source, "prepared");
    assert.equal(receipt.topupId, TOPUP_1);
    assert.equal(receipt.status, "credited");
    assert.equal(receipt.amountUsdCents, 4_500n);
    assert.equal(receipt.quotePriceMicroUsd, 150_000_000n);
    assert.equal(receipt.quoteSource, "pyth");
    assert.deepEqual(
      w.state.ledger.map((l) => [l.type, l.amountCents, l.description, l.referenceId]),
      [["purchase", 4_500n, "[devnet] Wallet top-up (SOL)", TOPUP_1]],
    );

    // Seen again: never a second time, and never as a direct transfer.
    assert.deepEqual(await w.credit.creditFoundTransfer(transfer), { outcome: "already" });
    assert.equal(w.state.balances[ORG_1], 4_500n);
    assert.equal(w.state.receipts.length, 1);
  });
}

test("a top-up's grant reads the same whether the submit path or the scan made it", async () => {
  const viaScan = setup({ topups: [topupRow({ txSignature: "sig_1" })] });
  await viaScan.credit.creditFoundTransfer(found());

  const viaSubmit = makeDb({ topups: [topupRow({ txSignature: "sig_1" })] });
  await makeCreditTopup(viaSubmit.db as unknown as TopupCreditDb)({
    topupId: TOPUP_1,
    orgId: ORG_1,
    amountUsdCents: 5_000n,
    bonusCents: 500n,
    asset: "USDC",
    network: DEVNET,
    now: () => NOW,
  });
  assert.deepEqual(viaScan.state.ledger, viaSubmit.state.ledger);
  const strip = ({ id: _id, createdAt: _at, slot: _slot, blockTime: _time, senderAddresses: _s, ...rest }: any) => rest;
  assert.deepEqual(strip(viaScan.state.receipts[0]), strip(viaSubmit.state.receipts[0]));
});

test("an amount that does not match the row is a transfer sent straight to the address", async () => {
  const row = topupRow({ status: "prepared" });
  const w = setup({ topups: [row] });
  const outcome = await w.credit.creditFoundTransfer(
    found({ amountRaw: 49_000_000n, topupId: TOPUP_1 }),
  );
  assert.deepEqual(outcome, {
    outcome: "credited",
    source: "direct",
    creditedCents: 4_900n,
    bonusCents: 0n,
  });
  assert.equal(row.status, "prepared", "the row is not used");
  assert.equal(row.txSignature, null);
  assert.equal(w.state.receipts[0]!.source, "direct");
  assert.equal(w.state.receipts[0]!.topupId, null);
  assert.deepEqual(w.state.ledger.map((l) => l.description), ["[devnet] Deposit (USDC)"]);
});

test("the row's asset must be the one that arrived", async () => {
  const row = topupRow({ status: "submitted", txSignature: "sig_1", asset: "SOL", amountRaw: "50000000" });
  const w = setup({ topups: [row] });
  const outcome = await w.credit.creditFoundTransfer(found());
  assert.ok(outcome.outcome === "credited");
  assert.equal(outcome.source, "direct");
  assert.equal(row.status, "submitted");
});

test("a row that is already credited is not used: a second transfer naming it is direct", async () => {
  const row = topupRow({ status: "credited", txSignature: "sig_first" });
  const w = setup({
    topups: [row],
    receipts: [
      {
        id: "receipt-old",
        network: DEVNET,
        txSignature: "sig_first",
        asset: "USDC",
        source: "prepared",
        topupId: TOPUP_1,
        status: "credited",
        createdAt: new Date("2026-10-10T00:00:00.000Z"),
      },
    ],
  });
  const outcome = await w.credit.creditFoundTransfer(found({ txSignature: "sig_second", topupId: TOPUP_1 }));
  assert.ok(outcome.outcome === "credited");
  assert.equal(outcome.source, "direct");
  assert.equal(w.state.receipts.length, 2);
  assert.equal(row.txSignature, "sig_first");
});

test("a row of another organization, of another chain, or holding another signature is never used", async () => {
  const cases = [
    topupRow({ status: "prepared", orgId: ORG_2, depositAddress: depositAddressOf(ORG_2) }),
    topupRow({ status: "prepared", network: "solana:mainnet" }),
    topupRow({ status: "submitted", txSignature: "sig_other" }),
    topupRow({ status: "prepared", depositAddress: addressOf("an older address") }),
  ];
  for (const row of cases) {
    const w = setup({ topups: [row] });
    const before = { ...row };
    const outcome = await w.credit.creditFoundTransfer(found({ topupId: TOPUP_1 }));
    assert.ok(outcome.outcome === "credited");
    assert.equal(outcome.source, "direct");
    assert.deepEqual(row, before, "the row is left exactly as it was");
    assert.equal(w.state.balances[ORG_2], undefined);
  }
});

test("a row already credited for this signature whose receipt is missing: the transfer is never credited again", async () => {
  // A row credited by code older than the receipts (between the migration
  // and the new code starting): no receipt stands in the way, the row does.
  const row = topupRow({ status: "credited", txSignature: "sig_1" });
  const w = setup({ topups: [row], balances: { [ORG_1]: 5_500n } });
  assert.deepEqual(await w.credit.creditFoundTransfer(found()), { outcome: "already" });
  assert.deepEqual(await w.credit.creditFoundTransfer(found({ topupId: TOPUP_1 })), {
    outcome: "already",
  });
  assert.equal(w.state.balances[ORG_1], 5_500n, "nothing more is granted");
  assert.equal(w.state.ledger.length, 0);
  assert.equal(w.state.receipts.length, 0);

  // Another asset in the same transaction was not paid for by that row.
  const sol = await w.credit.creditFoundTransfer(found({ asset: "SOL", amountRaw: 100_000_000n }));
  assert.ok(sol.outcome === "credited");
  assert.equal(sol.source, "direct");
});

test("a SOL row's price is held only while it was held: a later transfer naming the row is credited at today's price", async () => {
  const expiresAt = new Date("2026-10-11T08:00:00.000Z");
  const sol = (over: Record<string, unknown> = {}) =>
    topupRow({
      asset: "SOL",
      status: "expired",
      amountRaw: "300000000",
      // Prepared when SOL was at 300; the quote today is 200.
      amountUsdCents: 9_000n,
      bonusCents: 500n,
      expiresAt,
      ...over,
    });
  const transfer = (blockTime: Date | null) =>
    found({ asset: "SOL", amountRaw: 300_000_000n, topupId: TOPUP_1, blockTime });

  // Landed long after the hold: today's price, and the row is left alone.
  for (const blockTime of [
    new Date(expiresAt.getTime() + SOL_ROW_PRICE_GRACE_MS + 1),
    new Date("2026-10-11T08:59:00.000Z"),
    null,
  ]) {
    const row = sol();
    const w = setup({ topups: [row] });
    assert.deepEqual(await w.credit.creditFoundTransfer(transfer(blockTime)), {
      outcome: "credited",
      source: "direct",
      creditedCents: 6_000n,
      bonusCents: 500n,
    });
    assert.equal(row.status, "expired");
    assert.equal(row.txSignature, null);
    assert.equal(w.state.balances[ORG_1], 6_500n);
  }

  // Landed within the hold, or the little after it: the row's price.
  for (const blockTime of [
    new Date(expiresAt.getTime() - 1_000),
    new Date(expiresAt.getTime() + SOL_ROW_PRICE_GRACE_MS),
  ]) {
    const row = sol();
    const w = setup({ topups: [row] });
    const outcome = await w.credit.creditFoundTransfer(transfer(blockTime));
    assert.ok(outcome.outcome === "credited");
    assert.equal(outcome.source, "prepared");
    assert.equal(outcome.creditedCents, 9_000n);
  }

  // The row's own signed transfer is the row's, whenever it is seen.
  const signed = sol({ status: "failed", txSignature: "sig_1" });
  const w = setup({ topups: [signed] });
  const outcome = await w.credit.creditFoundTransfer(
    found({ asset: "SOL", amountRaw: 300_000_000n, blockTime: new Date("2026-10-11T08:59:00.000Z") }),
  );
  assert.ok(outcome.outcome === "credited");
  assert.equal(outcome.source, "prepared");

  // USDC holds no price: a row named later is still used.
  const usdc = topupRow({ status: "expired", expiresAt });
  const u = setup({ topups: [usdc] });
  const late = await u.credit.creditFoundTransfer(found({ topupId: TOPUP_1 }));
  assert.ok(late.outcome === "credited");
  assert.equal(late.source, "prepared");
});

test("the row with this signature is preferred over the row the memo names", async () => {
  const signed = topupRow({ id: TOPUP_2, status: "submitted", txSignature: "sig_1" });
  const named = topupRow({ id: TOPUP_1, status: "prepared" });
  const w = setup({ topups: [named, signed] });
  await w.credit.creditFoundTransfer(found({ topupId: TOPUP_1 }));
  assert.equal(signed.status, "credited");
  assert.equal(named.status, "prepared");
  assert.equal(w.state.receipts[0]!.topupId, TOPUP_2);
});

// ============================================
// The submit path and the scan on one transfer
// ============================================

const SUBMIT_ARGS = {
  topupId: TOPUP_1,
  orgId: ORG_1,
  amountUsdCents: 5_000n,
  bonusCents: 500n,
  asset: "USDC",
  network: DEVNET,
};

test("the submit path first, then the scan: credited once", async () => {
  const row = topupRow({ status: "submitted", txSignature: "sig_1" });
  const w = setup({ topups: [row] });
  const submit = makeCreditTopup(w.db as unknown as TopupCreditDb);
  assert.ok((await submit(SUBMIT_ARGS)).credited);
  assert.deepEqual(await w.credit.creditFoundTransfer(found({ topupId: TOPUP_1 })), {
    outcome: "already",
  });
  assert.equal(w.state.balances[ORG_1], 5_500n);
  assert.equal(w.state.receipts.length, 1);
  assert.equal(w.state.ledger.length, 2);
});

test("the scan first, then the submit path: credited once", async () => {
  const row = topupRow({ status: "submitting", txSignature: "sig_1" });
  const w = setup({ topups: [row] });
  const submit = makeCreditTopup(w.db as unknown as TopupCreditDb);
  assert.equal((await w.credit.creditFoundTransfer(found())).outcome, "credited");
  assert.deepEqual(await submit(SUBMIT_ARGS), { credited: false });
  assert.equal(w.state.balances[ORG_1], 5_500n);
  assert.equal(w.state.receipts.length, 1);
  assert.equal(row.status, "credited");
});

test("the submit path credits between the scan's read and its write: credited once, never as direct", async () => {
  const row = topupRow({ status: "submitted", txSignature: "sig_1" });
  const w = setup({ topups: [row] });
  const submit = makeCreditTopup(w.db as unknown as TopupCreditDb);
  const real = w.raw.walletTopUp.findFirst;
  let reads = 0;
  w.raw.walletTopUp.findFirst = async (args) => {
    const read = await real(args);
    reads += 1;
    if (reads === 1) assert.ok((await submit(SUBMIT_ARGS)).credited);
    return read;
  };
  assert.deepEqual(await w.credit.creditFoundTransfer(found()), { outcome: "already" });
  assert.equal(w.state.balances[ORG_1], 5_500n);
  assert.equal(w.state.receipts.length, 1);
  assert.equal(w.state.receipts[0]!.source, "prepared");
  assert.equal(w.state.ledger.length, 2);
});

test("a submit that stores the signature between the scan's read and its write: the row is read again and used", async () => {
  const row = topupRow({ status: "prepared" });
  const w = setup({ topups: [row] });
  const real = w.raw.walletTopUp.findFirst;
  let reads = 0;
  w.raw.walletTopUp.findFirst = async (args) => {
    const read = await real(args);
    reads += 1;
    // After the scan found the row by its memo, the claim lands.
    if (reads === 2) {
      row.status = "submitting";
      row.txSignature = "sig_1";
    }
    return read;
  };
  const outcome = await w.credit.creditFoundTransfer(found({ topupId: TOPUP_1 }));
  assert.ok(outcome.outcome === "credited");
  assert.equal(outcome.source, "prepared");
  assert.equal(row.status, "credited");
  assert.equal(w.state.receipts.length, 1);
  assert.equal(w.state.balances[ORG_1], 5_500n);
});

test("nothing that did not arrive is credited", async () => {
  const w = setup();
  await assert.rejects(w.credit.creditFoundTransfer(found({ amountRaw: 0n })));
  assert.equal(w.state.receipts.length, 0);
});
