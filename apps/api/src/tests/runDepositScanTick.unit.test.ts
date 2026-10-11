/**
 * Drives apps/api/src/services/runDepositScanTick.ts through its real
 * binding (services/buildDepositScanTickDeps.ts) and the real crediting
 * (services/depositCredit.ts), against an in-memory database and a node
 * that answers from maps. No database, no network.
 *
 * Pinning:
 *   - off, interval 0 and a failed cluster check read nothing;
 *   - an unchanged balance costs no history call;
 *   - a transfer is found, credited once, and the cursor and lastSeen
 *     move only after it was processed;
 *   - lastSeen is what the transaction left, not what the watch read;
 *   - more than 20 pages changes nothing;
 *   - a transaction that will not load leaves the cursor;
 *   - a wrong stored address is never read, nor a row of another chain;
 *   - one throwing address does not stop the rest;
 *   - no price leaves the receipt detected and a later run credits it;
 *   - "Check now" for one organization.
 */

import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { buildDepositScanDeps } from "../services/buildDepositScanTickDeps.js";
import type { ChainLabel } from "../services/depositTypes.js";
import {
  DEPOSIT_HISTORY_MAX_PAGES,
  depositScanEnabled,
  runDepositCheck,
  runDepositScanTick,
  type DepositScanDeps,
  type DepositScanEvent,
  type DepositScanTickInput,
} from "../services/runDepositScanTick.js";
import type { SolPriceResult } from "../services/solPrice.js";
import { topupMemo } from "../services/walletTopup.js";
import {
  DEVNET,
  ORG_1,
  ORG_2,
  ORG_3,
  QUOTE_200,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOPUP_1,
  USDC_MINT,
  addressOf,
  addressRow,
  depositAddressOf,
  makeChain,
  makeDb,
  solTransfer,
  topupRow,
  usdcAccountOf,
  usdcTransfer,
} from "./depositStandIn.js";

const NOW = new Date("2026-10-11T09:00:00.000Z");
const A1 = depositAddressOf(ORG_1);
const A2 = depositAddressOf(ORG_2);
const A3 = depositAddressOf(ORG_3);
const SOL = 1_000_000_000n;

function setup(
  init: Parameters<typeof makeDb>[0] = {},
  opts: { price?: SolPriceResult; historyPageSize?: number } = {},
) {
  const data = makeDb(init);
  const chain = makeChain();
  const events: DepositScanEvent[] = [];
  const knobs = {
    price: opts.price ?? ({ ok: true, quote: QUOTE_200 } as SolPriceResult),
    clusterOk: true,
    clusterChecks: 0,
  };
  const deps: DepositScanDeps = buildDepositScanDeps({
    db: data.db,
    network: "solana:devnet",
    usdcMint: USDC_MINT,
    getConnection: () => chain.connection,
    checkCluster: async () => {
      knobs.clusterChecks += 1;
      return { ok: knobs.clusterOk };
    },
    deriveAddress: depositAddressOf,
    getSolQuote: async () => knobs.price,
    solMarginBps: () => 0,
    log: (event) => events.push(event),
    now: () => NOW,
    historyPageSize: opts.historyPageSize,
  });
  const input: DepositScanTickInput = {
    enabled: true,
    intervalMs: 60_000,
    network: "solana:devnet",
    maxAddresses: 500,
    now: () => NOW,
  };
  const run = (over: Partial<DepositScanTickInput> = {}) =>
    runDepositScanTick({ ...input, ...over }, deps);
  const check = (orgId: string, network: ChainLabel = "solana:devnet") =>
    runDepositCheck(orgId, { enabled: true, network, now: () => NOW }, deps);
  const row = (orgId: string) => data.state.addresses.find((r) => r.orgId === orgId)!;
  const errors = () => events.filter((e) => e.kind === "error");
  return { ...data, chain, events, errors, knobs, deps, run, check, row };
}

// ============================================
// When a run does nothing
// ============================================

test("a run does nothing while deposits are off or the interval is 0", async () => {
  assert.equal(depositScanEnabled({ depositsEnabled: true, intervalMs: 60_000 }), true);
  assert.equal(depositScanEnabled({ depositsEnabled: false, intervalMs: 60_000 }), false);
  assert.equal(depositScanEnabled({ depositsEnabled: true, intervalMs: 0 }), false);

  for (const over of [{ enabled: false }, { intervalMs: 0 }]) {
    const w = setup({ addresses: [addressRow(ORG_1)] });
    w.chain.setBalance(A1, SOL);
    const res = await w.run(over);
    assert.equal(res.ran, false);
    assert.equal(res.skipped, "disabled");
    assert.equal(w.knobs.clusterChecks, 0);
    assert.equal(w.chain.calls.getMultipleAccountsInfo.length, 0);
    assert.equal(w.calls.length, 0, "the database is not read either");
  }
});

test("a run is skipped when the cluster check is not ok", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] });
  w.knobs.clusterOk = false;
  const res = await w.run();
  assert.equal(res.ran, false);
  assert.equal(res.skipped, "chain_unavailable");
  assert.equal(w.chain.calls.getMultipleAccountsInfo.length, 0);
  assert.equal(w.calls.length, 0);
});

// ============================================
// The cheap watch
// ============================================

test("an unchanged balance costs no history call, and the chunk's scan time is ONE write", async () => {
  const w = setup({
    addresses: [
      addressRow(ORG_1, { lastSeenLamports: 2n * SOL, lastSeenUsdcRaw: 5_000_000n }),
      addressRow(ORG_2),
    ],
  });
  w.chain.setBalance(A1, 2n * SOL, 5_000_000n);
  const res = await w.run();
  assert.equal(res.addressesWatched, 2);
  assert.equal(res.historiesRead, 0);
  assert.equal(w.chain.calls.getMultipleAccountsInfo.length, 1);
  assert.equal(w.chain.calls.getSignaturesForAddress.length, 0);
  assert.equal(w.chain.calls.getTransaction.length, 0);
  const scanTimeWrites = w.calls.filter(
    (c) => c.op === "depositAddress.updateMany" && "lastScannedAt" in c.args.data,
  );
  assert.equal(scanTimeWrites.length, 1);
  assert.deepEqual(scanTimeWrites[0]!.args.where, { orgId: { in: [ORG_1, ORG_2] } });
  assert.deepEqual(w.row(ORG_1).lastScannedAt, NOW);
  assert.deepEqual(w.row(ORG_2).lastScannedAt, NOW);
});

test("a USDC account seen to exist is recorded once, while that is still unknown", async () => {
  const opened = new Date("2026-10-01T00:00:00.000Z");
  const w = setup({
    addresses: [
      addressRow(ORG_1),
      addressRow(ORG_2, { usdcAccountOpenedAt: opened, usdcAccountOpenedBy: "platform" }),
      addressRow(ORG_3),
    ],
  });
  w.chain.setBalance(A1, 0n, 0n);
  w.chain.setBalance(A2, 0n, 0n);
  await w.run();
  assert.deepEqual(w.row(ORG_1).usdcAccountOpenedAt, NOW);
  assert.equal(w.row(ORG_1).usdcAccountOpenedBy, null, "the scan does not say who opened it");
  assert.deepEqual(w.row(ORG_2).usdcAccountOpenedAt, opened);
  assert.equal(w.row(ORG_3).usdcAccountOpenedAt, null);
});

// ============================================
// Finding and crediting
// ============================================

test("a SOL transfer is found, credited once, and the cursor and lastSeen move past it", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] });
  w.chain.land("sig_a", solTransfer(A1, SOL / 2n));
  w.chain.setBalance(A1, SOL / 2n);

  const res = await w.run();
  assert.equal(res.historiesRead, 1);
  assert.equal(res.credited, 1);
  assert.equal(res.errors, 0);
  assert.equal(w.state.balances[ORG_1], 10_000n + 1_500n);
  assert.deepEqual(
    w.state.receipts.map((r) => [r.txSignature, r.asset, r.source, r.status, r.orgId, r.depositAddress]),
    [["sig_a", "SOL", "direct", "credited", ORG_1, A1]],
  );
  assert.deepEqual(w.state.receipts[0]!.senderAddresses, [addressOf("sender")]);
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_a");
  assert.equal(w.row(ORG_1).lastSeenLamports, SOL / 2n);
  assert.deepEqual(w.row(ORG_1).lastScannedAt, NOW);

  // Every read was at "finalized".
  assert.ok(w.chain.calls.getMultipleAccountsInfo.every((c) => c.commitment === "finalized"));
  assert.ok(w.chain.calls.getSignaturesForAddress.every((c) => c.commitment === "finalized"));
  assert.deepEqual(w.chain.calls.getTransaction[0]!.options, {
    commitment: "finalized",
    maxSupportedTransactionVersion: 0,
  });

  // The next run: the balance is what the cursor's transaction left.
  const before = w.chain.calls.getSignaturesForAddress.length;
  const again = await w.run();
  assert.equal(again.historiesRead, 0);
  assert.equal(again.credited, 0);
  assert.equal(w.chain.calls.getSignaturesForAddress.length, before);
  assert.equal(w.state.balances[ORG_1], 11_500n);
});

test("a USDC transfer that opens the account: credited, the USDC cursor moves, the account is recorded", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] });
  w.chain.land("sig_u", usdcTransfer(A1, 50_000_000n, null));
  w.chain.setBalance(A1, 0n, 50_000_000n);
  const res = await w.run();
  assert.equal(res.credited, 1);
  assert.equal(w.state.balances[ORG_1], 5_500n);
  assert.equal(w.row(ORG_1).lastUsdcSignature, "sig_u");
  assert.equal(w.row(ORG_1).lastSeenUsdcRaw, 50_000_000n);
  assert.equal(w.row(ORG_1).lastSolSignature, null);
  assert.deepEqual(w.row(ORG_1).usdcAccountOpenedAt, NOW);
  assert.deepEqual(
    w.chain.calls.getSignaturesForAddress.map((c) => c.account),
    [A1, usdcAccountOf(A1), usdcAccountOf(A1), usdcAccountOf(A1)],
    "both histories are read; a first read that found something goes back until the history is empty, asked for twice",
  );
});

test("a transaction in both histories is loaded once and credited once", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] });
  const usdc = usdcTransfer(A1, 20_000_000n, null);
  w.chain.land("sig_both", {
    ...usdc,
    keys: [...usdc.keys, A1, SYSTEM_PROGRAM],
    lamports: { ...usdc.lamports, [A1]: [0n, SOL] },
  });
  w.chain.setBalance(A1, SOL, 20_000_000n);
  const res = await w.run();
  assert.equal(res.credited, 2, "one credit an asset");
  assert.equal(w.chain.calls.getTransaction.length, 1);
  assert.equal(w.state.receipts.length, 2);
  assert.equal(w.state.balances[ORG_1], 2_000n + 20_000n + 1_500n);
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_both");
  assert.equal(w.row(ORG_1).lastUsdcSignature, "sig_both");
  assert.equal(w.row(ORG_1).lastSeenLamports, SOL);
  assert.equal(w.row(ORG_1).lastSeenUsdcRaw, 20_000_000n);
});

test("the same signature seen on a later run credits nothing more", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] });
  w.chain.land("sig_a", solTransfer(A1, SOL));
  w.chain.setBalance(A1, SOL);
  await w.run();
  // The cursor is lost (as a concurrent older write could leave it).
  w.row(ORG_1).lastSolSignature = null;
  w.row(ORG_1).lastSeenLamports = 0n;
  const res = await w.run();
  assert.equal(res.historiesRead, 1);
  assert.equal(res.credited, 0);
  assert.equal(w.state.receipts.length, 1);
  assert.equal(w.state.balances[ORG_1], 20_000n + 1_500n);
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_a");
});

test("history is read oldest first, page by page back to the cursor", async () => {
  const w = setup(
    { addresses: [addressRow(ORG_1, { lastSolSignature: "sig_0", lastSeenLamports: SOL })] },
    { historyPageSize: 2 },
  );
  let held = 0n;
  for (let i = 0; i <= 5; i += 1) {
    w.chain.land(`sig_${i}`, solTransfer(A1, SOL, held));
    held += SOL;
  }
  w.chain.setBalance(A1, held);
  const res = await w.run();
  assert.equal(res.credited, 5, "sig_0 is the cursor: it is not read again");
  assert.deepEqual(
    w.chain.calls.getTransaction.map((c) => c.signature),
    ["sig_1", "sig_2", "sig_3", "sig_4", "sig_5"],
  );
  const pages = w.chain.calls.getSignaturesForAddress.filter((c) => c.account === A1);
  assert.deepEqual(
    pages.map((c) => c.options),
    [
      // Only the first request names the cursor.
      { limit: 2, until: "sig_0" },
      // Then the one signature after the oldest found: were it the cursor, the read would be over.
      { limit: 1, before: "sig_4" },
      // It was not, so the read goes back until the cursor itself appears.
      { limit: 2, before: "sig_3" },
      { limit: 2, before: "sig_1" },
    ],
  );
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_5");
  assert.equal(w.row(ORG_1).lastSeenLamports, 6n * SOL);
});

test("a provider that hands back shorter pages than it was asked for hides no transfer", async () => {
  // Asked for 1,000 a page, this one gives 2. Five transfers are newer than the cursor.
  const w = setup({ addresses: [addressRow(ORG_1, { lastSolSignature: "sig_0", lastSeenLamports: SOL })] });
  w.chain.capPages(2);
  let held = 0n;
  for (let i = 0; i <= 5; i += 1) {
    w.chain.land(`sig_${i}`, solTransfer(A1, SOL, held));
    held += SOL;
  }
  w.chain.setBalance(A1, held);
  const res = await w.run();
  assert.equal(res.credited, 5, "every one of the five is read and credited");
  assert.deepEqual(
    w.chain.calls.getTransaction.map((c) => c.signature),
    ["sig_1", "sig_2", "sig_3", "sig_4", "sig_5"],
  );
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_5", "the cursor moves only past what was read");
  assert.equal(w.row(ORG_1).lastSeenLamports, 6n * SOL);
  assert.equal(w.errors().length, 0);
});

test("one new transfer costs two requests: the page, and the signature after it, which is the cursor", async () => {
  const w = setup({ addresses: [addressRow(ORG_1, { lastSolSignature: "sig_0", lastSeenLamports: SOL })] });
  w.chain.land("sig_0", solTransfer(A1, SOL, 0n));
  w.chain.land("sig_1", solTransfer(A1, SOL, SOL));
  w.chain.setBalance(A1, 2n * SOL);
  const res = await w.run();
  assert.equal(res.credited, 1);
  assert.deepEqual(
    w.chain.calls.getSignaturesForAddress.filter((c) => c.account === A1).map((c) => c.options),
    [
      { limit: 1000, until: "sig_0" },
      { limit: 1, before: "sig_1" },
    ],
  );
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_1");
  assert.equal(w.events.filter((e) => e.kind === "history_short").length, 0);
});

test("a node that does not know the signature it is asked to read back from answers with nothing: asked again, the read goes on", async () => {
  // Three transfers are new and the provider gives two a page. The request that
  // reads back from the second reaches a node that has not seen it yet.
  const w = setup({ addresses: [addressRow(ORG_1, { lastSolSignature: "sig_0", lastSeenLamports: SOL })] }, { historyPageSize: 2 });
  let held = 0n;
  for (let i = 0; i <= 3; i += 1) {
    w.chain.land(`sig_${i}`, solTransfer(A1, SOL, held));
    held += SOL;
  }
  w.chain.setBalance(A1, held);
  w.chain.forgetBefore(1);
  const res = await w.run();
  assert.equal(res.credited, 3, "the one empty answer hid nothing");
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_3");
  assert.equal(w.row(ORG_1).lastSeenLamports, 4n * SOL);
  assert.equal(w.errors().length, 0);
});

test("after a full page, two empty answers are not believed: nothing changes for the address, and the next run reads it all", async () => {
  const w = setup({ addresses: [addressRow(ORG_1, { lastSolSignature: "sig_0", lastSeenLamports: SOL })] }, { historyPageSize: 2 });
  let held = 0n;
  for (let i = 0; i <= 5; i += 1) {
    w.chain.land(`sig_${i}`, solTransfer(A1, SOL, held));
    held += SOL;
  }
  w.chain.setBalance(A1, held);
  // The first page comes back full. Every request after it reaches a node that does not know where to read back from.
  w.chain.forgetBefore(2);
  const res = await w.run();
  assert.equal(res.credited, 0, "the two it did read are not credited ahead of the three it could not");
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_0", "the cursor has not moved past anything");
  assert.equal(w.row(ORG_1).lastSeenLamports, SOL);
  assert.equal(w.errors().length, 1);
  assert.match(w.errors()[0]!.detail ?? "", /could not be read back to the cursor/);
  assert.ok(!/SECRET|api-key/.test(w.errors()[0]!.detail ?? ""));

  // The node has caught up.
  const again = await w.run();
  assert.equal(again.credited, 5);
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_5");
  assert.equal(w.row(ORG_1).lastSeenLamports, 6n * SOL);
});

test("a history that does not reach back to the cursor is read as far as it goes, and said in the log", async () => {
  // A node that keeps little history: the cursor's own transaction is gone from it, one newer transfer is there.
  const w = setup({ addresses: [addressRow(ORG_1, { lastSolSignature: "sig_gone", lastSeenLamports: SOL })] });
  w.chain.land("sig_new", solTransfer(A1, SOL, SOL));
  w.chain.setBalance(A1, 2n * SOL);
  const res = await w.run();
  assert.equal(res.credited, 1);
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_new");
  const short = w.events.filter((e) => e.kind === "history_short");
  assert.equal(short.length, 1);
  assert.equal(short[0]!.asset, "SOL");
  assert.match(short[0]!.detail ?? "", /ended before the cursor was seen/);
  assert.equal(w.errors().length, 0);
});

test(`exactly ${DEPOSIT_HISTORY_MAX_PAGES} pages' worth of new transfers is read in one run`, async () => {
  const w = setup({ addresses: [addressRow(ORG_1, { lastSolSignature: "sig_0", lastSeenLamports: SOL })] }, { historyPageSize: 2 });
  const count = 2 * DEPOSIT_HISTORY_MAX_PAGES;
  let held = 0n;
  for (let i = 0; i <= count; i += 1) {
    w.chain.land(`sig_${i}`, solTransfer(A1, SOL, held));
    held += SOL;
  }
  w.chain.setBalance(A1, held);
  const res = await w.run();
  assert.equal(res.credited, count);
  assert.equal(w.row(ORG_1).lastSolSignature, `sig_${count}`);
  assert.equal(w.errors().length, 0);
});

test("an account with nothing new costs one request, as before", async () => {
  const w = setup({ addresses: [addressRow(ORG_1, { lastSolSignature: "sig_0", lastSeenLamports: SOL })] });
  w.chain.land("sig_0", solTransfer(A1, SOL, 0n));
  w.chain.setBalance(A1, SOL + 1n); // the watch sees a change, the history has nothing newer
  await w.run();
  assert.equal(w.chain.calls.getSignaturesForAddress.filter((c) => c.account === A1).length, 1);
});

test("lastSeen is what the cursor's transaction left, not what the watch read", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] });
  w.chain.land("sig_a", solTransfer(A1, SOL));
  // The node answers the watch ahead of the history: it already shows a
  // second transfer the history does not have yet.
  w.chain.setBalance(A1, 3n * SOL);

  await w.run();
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_a");
  assert.equal(w.row(ORG_1).lastSeenLamports, SOL, "from the transaction's own balances");
  assert.equal(w.state.receipts.length, 1);

  const unexplained = () => w.events.filter((e) => e.kind === "unexplained");
  assert.equal(unexplained().length, 0, "a run that found a transfer says nothing more");

  // Nothing new in the history yet: one more read, nothing lost, and the
  // balance nothing explains is said, with both figures.
  const idle = await w.run();
  assert.equal(idle.historiesRead, 1);
  assert.equal(idle.credited, 0);
  assert.equal(idle.errors, 0);
  assert.equal(w.row(ORG_1).lastSeenLamports, SOL);
  assert.equal(unexplained().length, 1);
  assert.equal(unexplained()[0]!.orgId, ORG_1);
  assert.match(unexplained()[0]!.detail ?? "", /holds 3000000000 lamports/);
  assert.match(unexplained()[0]!.detail ?? "", /explains 1000000000 and 0\./);
  assert.equal(w.state.receipts.length, 1, "nothing is credited from a balance alone");

  // The history catches up: the transfer is found.
  w.chain.land("sig_b", solTransfer(A1, 2n * SOL, SOL));
  const caught = await w.run();
  assert.equal(caught.credited, 1);
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_b");
  assert.equal(w.row(ORG_1).lastSeenLamports, 3n * SOL);
  assert.equal((await w.run()).historiesRead, 0);
  assert.equal(unexplained().length, 1, "said only while it lasted");
});

test(`more than ${DEPOSIT_HISTORY_MAX_PAGES} pages changes nothing for that address, and says so`, async () => {
  const start = addressRow(ORG_1, { lastSolSignature: "sig_cursor", lastSeenLamports: 5n });
  const w = setup({ addresses: [start, addressRow(ORG_2)] }, { historyPageSize: 2 });
  const untouched = { ...start };
  w.chain.land("sig_cursor", solTransfer(A1, 5n));
  for (let i = 0; i < DEPOSIT_HISTORY_MAX_PAGES * 2 + 1; i += 1) {
    w.chain.land(`sig_many_${i}`, solTransfer(A1, SOL));
  }
  w.chain.setBalance(A1, 99n * SOL);
  w.chain.land("sig_other", solTransfer(A2, SOL));
  w.chain.setBalance(A2, SOL);

  const res = await w.run();
  assert.equal(res.errors, 1);
  assert.deepEqual(w.row(ORG_1), untouched, "not a column of the row changed");
  // The first page, the one signature after it, and the pages it took to pass 20 pages' worth.
  assert.equal(
    w.chain.calls.getSignaturesForAddress.filter((c) => c.account === A1).length,
    DEPOSIT_HISTORY_MAX_PAGES + 1,
  );
  assert.ok(!w.chain.calls.getTransaction.some((c) => c.signature.startsWith("sig_many")));
  assert.equal(w.state.balances[ORG_1], undefined);
  assert.equal(w.errors().length, 1);
  assert.match(w.errors()[0]!.detail ?? "", /more than 20 pages/);
  // The other address was still served.
  assert.equal(w.state.balances[ORG_2], 20_000n + 1_500n);
});

test("a transaction that will not load leaves the cursor at the last one processed", async () => {
  for (const unloadable of [null, new Error("node said: api-key=SECRET timeout")]) {
    const w = setup({ addresses: [addressRow(ORG_1)] });
    w.chain.land("sig_1", solTransfer(A1, SOL, 0n));
    w.chain.land("sig_2", solTransfer(A1, SOL, SOL));
    w.chain.land("sig_3", solTransfer(A1, SOL, 2n * SOL));
    w.chain.setBalance(A1, 3n * SOL);
    const real = w.chain.transactions.get("sig_2")!;
    w.chain.transactions.set("sig_2", unloadable);

    const res = await w.run();
    assert.equal(res.credited, 1);
    assert.equal(res.errors, 1);
    assert.equal(w.row(ORG_1).lastSolSignature, "sig_1");
    assert.equal(w.row(ORG_1).lastSeenLamports, SOL);
    assert.deepEqual(w.state.receipts.map((r) => r.txSignature), ["sig_1"]);
    assert.ok(
      !w.chain.calls.getTransaction.some((c) => c.signature === "sig_3"),
      "nothing after it is processed: no transfer is skipped",
    );

    w.chain.transactions.set("sig_2", real);
    const next = await w.run();
    assert.equal(next.credited, 2);
    assert.equal(next.errors, 0);
    assert.equal(w.row(ORG_1).lastSolSignature, "sig_3");
    assert.equal(w.row(ORG_1).lastSeenLamports, 3n * SOL);
    assert.deepEqual(w.state.receipts.map((r) => r.txSignature), ["sig_1", "sig_2", "sig_3"]);
  }
});

test("a credit that throws leaves the cursor before it; the next run credits it", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] });
  w.chain.land("sig_1", solTransfer(A1, SOL, 0n));
  w.chain.land("sig_2", solTransfer(A1, SOL, SOL));
  w.chain.setBalance(A1, 2n * SOL);
  const real = w.deps.creditFoundTransfer;
  let fail = true;
  w.deps.creditFoundTransfer = async (found) => {
    if (fail && found.txSignature === "sig_2") throw new Error("database unavailable");
    return real(found);
  };
  const res = await w.run();
  assert.equal(res.credited, 1);
  assert.equal(res.errors, 1);
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_1");
  fail = false;
  assert.equal((await w.run()).credited, 1);
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_2");
  assert.equal(w.state.receipts.length, 2);
});

test("a failed transaction is read for the balance it left, and credits nothing", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] });
  w.chain.land("sig_ok", solTransfer(A1, SOL, 0n));
  w.chain.land("sig_failed", {
    keys: [addressOf("sender"), A1, SYSTEM_PROGRAM],
    lamports: { [addressOf("sender")]: [SOL, SOL - 5_000n], [A1]: [SOL, SOL] },
    failed: true,
  });
  w.chain.setBalance(A1, SOL);
  const res = await w.run();
  assert.equal(res.credited, 1);
  assert.equal(w.state.receipts.length, 1);
  assert.equal(w.chain.calls.getTransaction.length, 2);
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_failed");
  assert.equal(w.row(ORG_1).lastSeenLamports, SOL);
});

test("a transfer out gets no receipt and is logged", async () => {
  const w = setup({
    addresses: [addressRow(ORG_1, { lastSolSignature: "sig_in", lastSeenLamports: SOL })],
  });
  w.chain.land("sig_in", solTransfer(A1, SOL));
  w.chain.land("sig_out", {
    keys: [A1, addressOf("elsewhere"), SYSTEM_PROGRAM],
    lamports: { [A1]: [SOL, 100n], [addressOf("elsewhere")]: [0n, SOL - 5_100n] },
  });
  w.chain.setBalance(A1, 100n);
  const res = await w.run();
  assert.equal(res.transfersOut, 1);
  assert.equal(res.credited, 0);
  assert.equal(w.state.receipts.length, 0);
  assert.equal(w.state.ledger.length, 0);
  assert.deepEqual(
    w.events.filter((e) => e.kind === "transfer_out").map((e) => [e.orgId, e.signature]),
    [[ORG_1, "sig_out"]],
  );
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_out");
  assert.equal(w.row(ORG_1).lastSeenLamports, 100n);
});

test("a transfer out that is a known sweep is not warned about; any other still is", async () => {
  const w = setup({
    addresses: [addressRow(ORG_1, { lastSolSignature: "sig_in", lastSeenLamports: 3n * SOL })],
    chainTransfers: [
      { id: "ct-1", network: DEVNET, fromAddress: A1, txSignature: "sig_sweep", status: "landed" },
      // A row of another chain with the same signature is not this server's sweep here.
      { id: "ct-2", network: "solana:mainnet", fromAddress: A1, txSignature: "sig_other_chain", status: "landed" },
    ],
  });
  const hot = addressOf("hot");
  w.chain.land("sig_in", solTransfer(A1, 3n * SOL));
  w.chain.land("sig_sweep", {
    keys: [A1, hot, SYSTEM_PROGRAM],
    lamports: { [A1]: [3n * SOL, 2n * SOL], [hot]: [0n, SOL - 5_000n] },
  });
  w.chain.land("sig_other_chain", {
    keys: [A1, hot, SYSTEM_PROGRAM],
    lamports: { [A1]: [2n * SOL, SOL], [hot]: [0n, SOL - 5_000n] },
  });
  w.chain.land("sig_stranger", {
    keys: [A1, addressOf("elsewhere"), SYSTEM_PROGRAM],
    lamports: { [A1]: [SOL, 890_880n], [addressOf("elsewhere")]: [0n, SOL - 895_880n] },
  });
  w.chain.setBalance(A1, 890_880n);
  const res = await w.run();
  assert.equal(res.transfersOut, 2, "only the transfers that are not this chain's sweeps are counted");
  assert.equal(res.errors, 0);
  assert.deepEqual(
    w.events.filter((e) => e.kind === "transfer_out").map((e) => e.signature),
    ["sig_other_chain", "sig_stranger"],
  );
  assert.deepEqual(
    w.events.filter((e) => e.kind === "swept").map((e) => [e.orgId, e.signature]),
    [[ORG_1, "sig_sweep"]],
  );
  // Known or not, no receipt is written and the cursor and balance move.
  assert.equal(w.state.receipts.length, 0);
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_stranger");
  assert.equal(w.row(ORG_1).lastSeenLamports, 890_880n);
});

test("a sweep lookup that throws proves nothing: the transfer out is warned about", async () => {
  const w = setup({
    addresses: [addressRow(ORG_1, { lastSolSignature: "sig_in", lastSeenLamports: SOL })],
    chainTransfers: [{ id: "ct-1", network: DEVNET, fromAddress: A1, txSignature: "sig_sweep", status: "landed" }],
  });
  w.raw.chainTransfer.findUnique = async () => {
    throw new Error("database is away");
  };
  w.chain.land("sig_in", solTransfer(A1, SOL));
  w.chain.land("sig_sweep", {
    keys: [A1, addressOf("hot"), SYSTEM_PROGRAM],
    lamports: { [A1]: [SOL, 890_880n], [addressOf("hot")]: [0n, SOL - 895_880n] },
  });
  w.chain.setBalance(A1, 890_880n);
  const res = await w.run();
  assert.equal(res.transfersOut, 1);
  assert.equal(res.errors, 0);
  assert.deepEqual(w.events.filter((e) => e.kind === "transfer_out").map((e) => e.signature), ["sig_sweep"]);
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_sweep");
});

test("a prepared top-up whose transfer landed without its submit is credited through its row", async () => {
  const topup = topupRow({ status: "expired", failureCode: "unsigned_expired" });
  const w = setup({ addresses: [addressRow(ORG_1)], topups: [topup] });
  w.chain.land("sig_self", usdcTransfer(A1, 50_000_000n, null, { memos: [topupMemo(TOPUP_1)] }));
  w.chain.setBalance(A1, 0n, 50_000_000n);
  const res = await w.run();
  assert.equal(res.credited, 1);
  assert.equal(topup.status, "credited");
  assert.equal(topup.txSignature, "sig_self");
  assert.deepEqual(
    w.state.receipts.map((r) => [r.source, r.topupId, r.status]),
    [["prepared", TOPUP_1, "credited"]],
  );
  assert.deepEqual(
    w.state.ledger.map((l) => [l.description, l.referenceId]),
    [
      ["[devnet] Wallet top-up (USDC)", TOPUP_1],
      ["[devnet] Bonus credits", TOPUP_1],
    ],
  );
  assert.equal(w.state.balances[ORG_1], 5_500n);
});

// ============================================
// Waiting for a price
// ============================================

test("no price leaves the receipt detected; a later run credits it, with no history call", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] }, { price: { ok: false, code: "stale" } });
  w.chain.land("sig_a", solTransfer(A1, SOL / 2n));
  w.chain.setBalance(A1, SOL / 2n);

  const first = await w.run();
  assert.equal(first.credited, 0);
  assert.equal(first.waiting, 1);
  assert.equal(w.state.receipts[0]!.status, "detected");
  assert.equal(w.state.ledger.length, 0);
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_a", "it was processed: the cursor moves");

  const still = await w.run();
  assert.equal(still.waiting, 1);
  assert.equal(still.historiesRead, 0);
  assert.equal(w.state.ledger.length, 0);

  w.knobs.price = { ok: true, quote: QUOTE_200 };
  const reads = w.chain.calls.getSignaturesForAddress.length;
  const later = await w.run();
  assert.equal(later.credited, 1);
  assert.equal(later.waiting, 0);
  assert.equal(w.chain.calls.getSignaturesForAddress.length, reads);
  assert.equal(w.state.receipts[0]!.status, "credited");
  assert.equal(w.state.balances[ORG_1], 11_500n);

  assert.equal((await w.run()).credited, 0);
  assert.equal(w.state.balances[ORG_1], 11_500n);
});

test("a waiting receipt of another chain is not tried here", async () => {
  const w = setup({
    receipts: [
      {
        id: "r_main",
        network: "solana:mainnet",
        txSignature: "sig_m",
        asset: "SOL",
        orgId: ORG_1,
        amountRaw: SOL,
        status: "detected",
        source: "direct",
        createdAt: new Date("2026-10-10T00:00:00.000Z"),
      },
    ],
  });
  const res = await w.run();
  assert.equal(res.credited, 0);
  assert.equal(w.state.receipts[0]!.status, "detected");
});

test("under one cent is ignored and counted", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] });
  w.chain.land("sig_dust", usdcTransfer(A1, 9_999n, null));
  w.chain.setBalance(A1, 0n, 9_999n);
  const res = await w.run();
  assert.equal(res.ignored, 1);
  assert.equal(res.credited, 0);
  assert.deepEqual(
    w.state.receipts.map((r) => [r.status, r.ignoredReason]),
    [["ignored", "below_one_cent"]],
  );
  assert.equal(w.state.ledger.length, 0);
  assert.equal(w.row(ORG_1).lastSeenUsdcRaw, 9_999n);
});

// ============================================
// Which rows are read
// ============================================

test("a wrong stored address is never read", async () => {
  const wrong = addressOf("not the derived one");
  const w = setup({ addresses: [addressRow(ORG_1, { address: wrong }), addressRow(ORG_2)] });
  const untouched = { ...w.row(ORG_1) };
  w.chain.land("sig_x", solTransfer(wrong, SOL));
  w.chain.setBalance(wrong, SOL);
  const res = await w.run();
  assert.equal(res.errors, 1);
  assert.equal(res.addressesWatched, 1);
  const asked = w.chain.calls.getMultipleAccountsInfo.flatMap((c) => c.keys);
  assert.ok(!asked.includes(wrong));
  assert.ok(!asked.includes(usdcAccountOf(wrong)));
  assert.equal(w.chain.calls.getSignaturesForAddress.length, 0);
  assert.equal(w.state.receipts.length, 0);
  assert.deepEqual(w.row(ORG_1), untouched);
  assert.match(w.errors()[0]!.detail ?? "", /not the one this server derives/);
});

test("a row of another network is never read", async () => {
  const w = setup({
    addresses: [addressRow(ORG_1, { network: "solana:mainnet" }), addressRow(ORG_2)],
  });
  w.chain.land("sig_x", solTransfer(A1, SOL));
  w.chain.setBalance(A1, SOL);
  const res = await w.run();
  assert.equal(res.addressesWatched, 1);
  assert.ok(!w.chain.calls.getMultipleAccountsInfo.flatMap((c) => c.keys).includes(A1));
  assert.equal(w.state.receipts.length, 0);
  assert.equal(w.row(ORG_1).lastScannedAt, null);

  // And when a database read hands one over anyway, the run still refuses it.
  const leaky = setup({ addresses: [addressRow(ORG_1, { network: "solana:mainnet" })] });
  leaky.chain.setBalance(A1, SOL);
  leaky.deps.loadAddresses = async () => [
    { ...(leaky.row(ORG_1) as any) },
  ];
  const second = await leaky.run();
  assert.equal(second.addressesWatched, 0);
  assert.equal(leaky.chain.calls.getMultipleAccountsInfo.length, 0);
});

test("one address that throws does not stop the rest", async () => {
  const w = setup({ addresses: [addressRow(ORG_1), addressRow(ORG_2), addressRow(ORG_3)] });
  for (const [sig, address] of [["sig_1", A1], ["sig_2", A2], ["sig_3", A3]] as const) {
    w.chain.land(sig, solTransfer(address, SOL));
    w.chain.setBalance(address, SOL);
  }
  w.chain.failing.history.add(A2);
  const before = { ...w.row(ORG_2) };
  const res = await w.run();
  assert.equal(res.credited, 2);
  assert.equal(res.errors, 1);
  assert.equal(w.state.balances[ORG_1], 21_500n);
  assert.equal(w.state.balances[ORG_2], undefined);
  assert.equal(w.state.balances[ORG_3], 21_500n);
  assert.deepEqual(w.row(ORG_2), before, "left exactly as it was, to be tried again");

  w.chain.failing.history.clear();
  assert.equal((await w.run()).credited, 1);
  assert.equal(w.state.balances[ORG_2], 21_500n);
});

test("a watch that fails leaves its addresses exactly as they were", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] });
  const before = { ...w.row(ORG_1) };
  w.chain.failing.watch = new Error("node down");
  const res = await w.run();
  assert.equal(res.ran, true);
  assert.equal(res.errors, 1);
  assert.equal(res.addressesWatched, 0);
  assert.deepEqual(w.row(ORG_1), before);
});

test("an owner who asked is read whatever the balance, and first; the request is cleared by the run that answers it", async () => {
  const asked = new Date("2026-10-11T08:59:30.000Z");
  const w = setup({
    addresses: [
      addressRow(ORG_1, { lastScannedAt: new Date("2026-10-11T08:00:00.000Z") }),
      addressRow(ORG_2, { lastScannedAt: new Date("2026-10-11T08:30:00.000Z") }),
      addressRow(ORG_3, {
        lastScannedAt: new Date("2026-10-11T08:59:00.000Z"),
        scanRequestedAt: asked,
      }),
    ],
  });
  const res = await w.run({ maxAddresses: 2 });
  assert.equal(res.addressesWatched, 2);
  assert.deepEqual(
    w.chain.calls.getMultipleAccountsInfo[0]!.keys.slice(0, 2),
    [A3, A1],
    "the one that asked, then the least recently scanned",
  );
  assert.equal(res.historiesRead, 1);
  assert.deepEqual(
    w.chain.calls.getSignaturesForAddress.map((c) => c.account),
    [A3, usdcAccountOf(A3)],
  );
  assert.equal(w.row(ORG_3).scanRequestedAt, null);
  assert.deepEqual(w.row(ORG_3).lastScannedAt, NOW);
  assert.deepEqual(w.row(ORG_2).lastScannedAt, new Date("2026-10-11T08:30:00.000Z"), "not this run");
});

test("a request made while the run was reading stays for the next run", async () => {
  const asked = new Date("2026-10-11T08:59:30.000Z");
  const w = setup({ addresses: [addressRow(ORG_1, { scanRequestedAt: asked })] });
  const real = w.deps.listSignatures;
  const again = new Date("2026-10-11T09:00:01.000Z");
  w.deps.listSignatures = async (args) => {
    w.row(ORG_1).scanRequestedAt = again;
    return real(args);
  };
  await w.run();
  assert.deepEqual(w.row(ORG_1).scanRequestedAt, again);
});

test("a run that could not read everything does not clear the request", async () => {
  const asked = new Date("2026-10-11T08:59:30.000Z");
  const w = setup({ addresses: [addressRow(ORG_1, { scanRequestedAt: asked })] });
  w.chain.land("sig_1", solTransfer(A1, SOL));
  w.chain.transactions.set("sig_1", null);
  await w.run();
  assert.deepEqual(w.row(ORG_1).scanRequestedAt, asked);
  assert.equal(w.row(ORG_1).lastSolSignature, null);
});

// ============================================
// "Check now"
// ============================================

test("check now: reads the history whatever the balance, and answers what this call credited", async () => {
  const w = setup({
    addresses: [addressRow(ORG_1, { scanRequestedAt: new Date("2026-10-11T08:59:59.000Z") }), addressRow(ORG_2)],
  });
  w.chain.land("sig_u", usdcTransfer(A1, 50_000_000n, null));
  w.chain.land("sig_other", solTransfer(A2, SOL));
  // The watch still shows nothing: the history is read all the same.
  const result = await w.check(ORG_1);
  assert.deepEqual(result, {
    outcome: "scanned",
    credited: [
      {
        asset: "USDC",
        amountRaw: 50_000_000n,
        creditedCents: 5_000n,
        bonusCents: 500n,
        txSignature: "sig_u",
      },
    ],
    waiting: [],
  });
  assert.equal(w.state.balances[ORG_1], 5_500n);
  assert.equal(w.state.balances[ORG_2], undefined, "only this organization's address is read");
  assert.deepEqual(w.chain.calls.getMultipleAccountsInfo[0]!.keys, [A1, usdcAccountOf(A1)]);
  assert.equal(w.row(ORG_1).scanRequestedAt, null);
  assert.equal(w.row(ORG_1).lastUsdcSignature, "sig_u");

  // Pressed again: nothing new, nothing granted.
  assert.deepEqual(await w.check(ORG_1), { outcome: "scanned", credited: [], waiting: [] });
  assert.equal(w.state.balances[ORG_1], 5_500n);
});

test("check now: a SOL transfer with no price waits, and is answered as waiting until it is credited", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] }, { price: { ok: false, code: "stale" } });
  w.chain.land("sig_s", solTransfer(A1, SOL / 2n));
  const waiting = [{ asset: "SOL", amountRaw: SOL / 2n, txSignature: "sig_s" }];
  assert.deepEqual(await w.check(ORG_1), { outcome: "scanned", credited: [], waiting });
  assert.deepEqual(await w.check(ORG_1), { outcome: "scanned", credited: [], waiting });
  assert.equal(w.state.ledger.length, 0);

  w.knobs.price = { ok: true, quote: QUOTE_200 };
  assert.deepEqual(await w.check(ORG_1), {
    outcome: "scanned",
    credited: [
      {
        asset: "SOL",
        amountRaw: SOL / 2n,
        creditedCents: 10_000n,
        bonusCents: 1_500n,
        txSignature: "sig_s",
      },
    ],
    waiting: [],
  });
  assert.equal(w.state.balances[ORG_1], 11_500n);
});

test("check now: not_issued with no row, or a row of another network", async () => {
  const w = setup({ addresses: [addressRow(ORG_2, { network: "solana:mainnet" })] });
  assert.deepEqual(await w.check(ORG_1), { outcome: "not_issued" });
  assert.deepEqual(await w.check(ORG_2), { outcome: "not_issued" });
  assert.equal(w.chain.calls.getMultipleAccountsInfo.length, 0);
  assert.equal(w.chain.calls.getSignaturesForAddress.length, 0);
});

test("check now: chain_unavailable when the cluster check fails, a read throws, or deposits are off", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] });
  w.knobs.clusterOk = false;
  assert.deepEqual(await w.check(ORG_1), { outcome: "chain_unavailable" });
  assert.equal(w.calls.length, 0);

  w.knobs.clusterOk = true;
  w.chain.failing.watch = new Error("node down");
  assert.deepEqual(await w.check(ORG_1), { outcome: "chain_unavailable" });

  w.chain.failing.watch = null;
  w.chain.failing.history.add(A1);
  assert.deepEqual(await w.check(ORG_1), { outcome: "chain_unavailable" });

  w.chain.failing.history.clear();
  w.chain.land("sig_1", solTransfer(A1, SOL));
  w.chain.transactions.set("sig_1", null);
  assert.deepEqual(await w.check(ORG_1), { outcome: "chain_unavailable" });
  assert.equal(w.row(ORG_1).lastSolSignature, null);

  const off = await runDepositCheck(ORG_1, { enabled: false, network: "solana:devnet" }, w.deps);
  assert.deepEqual(off, { outcome: "chain_unavailable" });

  const broken = setup({ addresses: [addressRow(ORG_1)] });
  broken.deps.loadAddress = async () => {
    throw new Error("database unavailable");
  };
  assert.deepEqual(await broken.check(ORG_1), { outcome: "chain_unavailable" });
});

test("check now: a wrong stored address is never read", async () => {
  const wrong = addressOf("not the derived one");
  const w = setup({ addresses: [addressRow(ORG_1, { address: wrong })] });
  assert.deepEqual(await w.check(ORG_1), { outcome: "chain_unavailable" });
  assert.equal(w.chain.calls.getMultipleAccountsInfo.length, 0);
  assert.equal(w.chain.calls.getSignaturesForAddress.length, 0);
  assert.equal(w.errors().length, 1);
});

test("check now: what was credited is answered even when a later transaction would not load", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] });
  w.chain.land("sig_1", solTransfer(A1, SOL, 0n));
  w.chain.land("sig_2", solTransfer(A1, SOL, SOL));
  w.chain.transactions.set("sig_2", null);
  const result = await w.check(ORG_1);
  assert.equal(result.outcome, "scanned");
  assert.ok(result.outcome === "scanned");
  assert.deepEqual(result.credited.map((c) => c.txSignature), ["sig_1"]);
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_1");
});

test("the USDC of another mint, and tokens sent to someone else, credit nothing", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] });
  const stranger = addressOf("stranger");
  w.chain.land(
    "sig_else",
    {
      keys: [addressOf("sender"), usdcAccountOf(stranger), A1, TOKEN_PROGRAM],
      tokens: [{ account: usdcAccountOf(stranger), owner: stranger, amounts: [0n, 9_000_000n] }],
    },
  );
  w.chain.setBalance(A1, 1n);
  const res = await w.run();
  assert.equal(res.historiesRead, 1);
  assert.equal(res.credited, 0);
  assert.equal(w.state.receipts.length, 0);
  assert.equal(w.row(ORG_1).lastSolSignature, "sig_else");
  assert.equal(w.row(ORG_1).lastSeenLamports, 0n);
  assert.equal(DEVNET, "solana:devnet");
});
