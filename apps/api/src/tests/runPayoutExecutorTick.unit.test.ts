// One run of the payout worker (services/runPayoutExecutorTick.ts).
//
// First on the real binding over stand-ins for the database and the chain:
// what happens BEFORE anything is signed. A check that does not pass leaves
// the payout pending, so its creator can still cancel it, with the reason
// as a code. Then on hand-made deps: the order of the steps, and that one
// payout that throws does not stop the others.
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import { PAYING_WALLET_KEEP_LAMPORTS, PAYOUT_FEE_LAMPORTS } from "../services/payoutExecutor.js";
import { buildCancelPayoutDeps, cancelPayout } from "../services/payoutRequests.js";
import {
  runPayoutExecutorTick,
  utcDayStart,
  type ClaimablePayoutRow,
  type PayoutExecutorTickDeps,
} from "../services/runPayoutExecutorTick.js";
import type { SignatureFateAnswer } from "../services/signatureFate.js";
import type { SolPriceResult } from "../services/solPrice.js";
import {
  STAND_IN_TOKEN_ACCOUNT_RENT,
  chainStandIn,
  payoutStandIn,
  standInPayout,
  standInSolPrice,
  standInWorker,
  type StandInPayout,
} from "./payoutStandIn.js";

const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const ORG = "org_creator";
const NOW = new Date("2026-10-10T12:00:00.000Z");

function world(
  payouts: Array<Partial<StandInPayout>>,
  opts: {
    platformMaxPerDayUsd?: number;
    price?: () => SolPriceResult;
    cluster?: () => { ok: true } | { ok: false; reason: string };
    noWallet?: boolean;
  } = {},
) {
  const wallet = Keypair.generate();
  const rows = payouts.map((over, index) =>
    standInPayout({
      publisherId: `${ORG}_${index}`,
      payoutMethod: "crypto_usdc",
      payoutAddress: Keypair.generate().publicKey.toBase58(),
      amountCents: 2_500n,
      requestedAt: new Date(NOW.getTime() + index),
      ...over,
    }),
  );
  const store = payoutStandIn({
    payouts: rows,
    earnings: Object.fromEntries(rows.map((row) => [row.publisherId, 0n])),
  });
  const chain = chainStandIn({ payer: wallet.publicKey, usdcMint: DEVNET_USDC });
  const clock = { now: NOW };
  const worker = standInWorker({
    db: store.db,
    chain,
    payoutWallet: opts.noWallet ? undefined : wallet,
    usdcMint: DEVNET_USDC,
    platformMaxPerDayUsd: opts.platformMaxPerDayUsd,
    price: opts.price,
    cluster: opts.cluster,
    now: () => clock.now,
  });
  return { store, chain, worker, clock, ids: rows.map((row) => row.id), row: (i = 0) => store.payout(rows[i]!.id) };
}

/** Pending, nothing signed, nothing sent, nothing restored: and it can be cancelled. */
async function assertWaitingAndCancellable(w: ReturnType<typeof world>, reason: string) {
  const row = w.row();
  assert.equal(row.status, "pending");
  assert.equal(row.waitingReason, reason);
  assert.equal(row.txSignature, null);
  assert.equal(row.signedTxB64, null);
  assert.equal(row.attemptCount, 0, "no attempt was used");
  assert.equal(row.failureCode, null);
  assert.equal(w.chain.chain.broadcasts.length, 0, "nothing was sent");
  assert.equal(w.store.restores(row.id).length, 0);

  const cancel = await cancelPayout(buildCancelPayoutDeps(w.store.db), { payoutId: row.id, orgId: row.publisherId });
  assert.equal(cancel.outcome, "cancelled", "a payout that is waiting can still be cancelled");
  assert.equal(w.store.state.earnings[row.publisherId], row.amountCents);
  assert.equal(w.store.restores(row.id).length, 1);
}

// ============================================
// Before anything is signed
// ============================================

test("an empty paying wallet leaves the payout pending, cancellable and marked wallet_low", async () => {
  const w = world([{}]);
  w.chain.chain.payerLamports = 0n;
  w.chain.chain.payerUsdcBaseUnits = 0n;

  const res = await w.worker.run();
  assert.equal(res.waiting, 1);
  assert.equal(res.sent, 0);
  assert.equal(res.failed, 0);
  assert.equal(w.chain.chain.blockhashesIssued, 0, "nothing was even built");

  // Run after run it stays where it is: pending, never processing.
  for (let i = 0; i < 3; i++) await w.worker.run();
  assert.equal(
    w.store.state.payoutWrites.length,
    1,
    "the reason is written once, not on every run",
  );
  await assertWaitingAndCancellable(w, "wallet_low");
});

test("wallet_low at each edge: the USDC, the fee, the receiver's rent, the SOL amount", async () => {
  const keep = PAYOUT_FEE_LAMPORTS + PAYING_WALLET_KEEP_LAMPORTS;

  // USDC one base unit short.
  let w = world([{}]);
  w.chain.chain.payerUsdcBaseUnits = 25_000_000n - 1n;
  await w.worker.run();
  assert.equal(w.row().waitingReason, "wallet_low");
  // Exactly enough USDC, and exactly the fee and what the wallet keeps.
  w.chain.chain.payerUsdcBaseUnits = 25_000_000n;
  w.chain.chain.payerLamports = keep;
  await w.worker.run();
  assert.equal(w.row().status, "processing");
  assert.equal(w.row().waitingReason, null, "the reason is cleared by the claim");

  // The receiver has no USDC account: the rent to open one is needed too.
  w = world([{}]);
  w.chain.chain.recipientHasUsdcAccount = false;
  w.chain.chain.payerLamports = keep + BigInt(STAND_IN_TOKEN_ACCOUNT_RENT) - 1n;
  await w.worker.run();
  assert.equal(w.row().waitingReason, "wallet_low");
  w.chain.chain.payerLamports = keep + BigInt(STAND_IN_TOKEN_ACCOUNT_RENT);
  await w.worker.run();
  assert.equal(w.row().status, "processing");

  // SOL: $25 at $200 is 0.125 SOL.
  w = world([{ payoutMethod: "crypto_sol" }]);
  w.chain.chain.payerUsdcBaseUnits = 0n;
  w.chain.chain.payerLamports = 125_000_000n + keep - 1n;
  await w.worker.run();
  assert.equal(w.row().waitingReason, "wallet_low");
  w.chain.chain.payerLamports = 125_000_000n + keep;
  await w.worker.run();
  assert.equal(w.row().status, "processing");
  assert.equal(w.row().amountRaw, "125000000");
});

test("with no paying wallet a wallet payout waits as wallet_low, and a credits payout still settles", async () => {
  const w = world([{}, { payoutMethod: "credits", payoutAddress: null }], { noWallet: true });
  const res = await w.worker.run();
  assert.equal(res.waiting, 1);
  assert.equal(res.completed, 1);
  assert.equal(w.row(1).status, "completed");
  await assertWaitingAndCancellable(w, "wallet_low");
});

test("a read of the paying wallet that fails is chain_unavailable, never wallet_low", async () => {
  const w = world([{}]);
  w.chain.chain.readsFail = true;
  const res = await w.worker.run();
  assert.equal(res.waiting, 1);
  const waiting = w.worker.events.find((e) => e.event === "waiting");
  assert.ok(waiting && /getMultipleAccountsInfo failed/.test(waiting.detail), "the node's words are in the log");
  assert.doesNotMatch(JSON.stringify(w.row(), (_k, v) => (typeof v === "bigint" ? String(v) : v)), /stand-in/);
  await assertWaitingAndCancellable(w, "chain_unavailable");
});

test("a blockhash that cannot be fetched is chain_unavailable: nothing was stored", async () => {
  const w = world([{}]);
  const deps: PayoutExecutorTickDeps = {
    ...w.worker.deps,
    prepare: async () => {
      throw new Error("failed to get recent blockhash: 503");
    },
  };
  const res = await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.equal(res.waiting, 1);
  await assertWaitingAndCancellable(w, "chain_unavailable");
});

test("the chain not ok: the payout waits as chain_unavailable and nothing is read or signed", async () => {
  for (const reason of ["wrong_cluster", "unreachable"]) {
    const w = world([{}], { cluster: () => ({ ok: false, reason }) });
    const res = await w.worker.run();
    assert.equal(res.waiting, 1);
    assert.equal(w.chain.chain.blockhashesIssued, 0);
    await assertWaitingAndCancellable(w, "chain_unavailable");
  }
});

test("no price: a SOL payout waits as price_unavailable; a USDC payout needs no price", async () => {
  const w = world([{ payoutMethod: "crypto_sol" }, {}], { price: () => ({ ok: false, code: "stale" }) });
  const res = await w.worker.run();
  assert.equal(res.waiting, 1);
  assert.equal(res.sent, 1);
  assert.equal(w.row(1).status, "processing", "USDC is exact and went out");
  assert.equal(w.row(1).quotePriceMicroUsd, null);
  assert.equal(w.chain.chain.broadcasts.length, 1, "only the USDC transfer was sent");
  assert.equal(w.chain.chain.broadcasts[0]!.signature, w.row(1).txSignature);
  assert.equal(w.row(0).status, "pending");
  assert.equal(w.row(0).waitingReason, "price_unavailable");
  assert.equal(w.row(0).txSignature, null);
  assert.equal(w.row(0).attemptCount, 0);
});

test("a price source that is off is price_unavailable too", async () => {
  const w = world([{ payoutMethod: "crypto_sol" }], { price: () => ({ ok: false, code: "source_off" }) });
  await w.worker.run();
  await assertWaitingAndCancellable(w, "price_unavailable");
});

test("a SOL payout stores the lamports and the price they were worked out from", async () => {
  const w = world([{ payoutMethod: "crypto_sol", amountCents: 5_000n }], { price: () => standInSolPrice(200) });
  await w.worker.run();
  const row = w.row();
  assert.equal(row.status, "processing");
  assert.equal(row.amountRaw, "250000000");
  assert.equal(row.quotePriceMicroUsd, 200_000_000n);
  assert.equal(row.quoteSource, "static");
  assert.equal(row.quotePublishTime?.getTime(), 1_791_633_600_000);
});

test("the platform's day limit: what was claimed since midnight UTC, plus this one, must fit", async () => {
  const today = (minutes: number) => new Date(utcDayStart(NOW).getTime() + minutes * 60_000);
  const sentToday = (over: Partial<StandInPayout>): Partial<StandInPayout> => ({
    status: "completed",
    txSignature: `done_${Math.random()}`,
    claimedAt: today(5),
    ...over,
  });

  // $100 a day. $75 went out today; $25 more fits exactly.
  let w = world([sentToday({ amountCents: 7_500n }), { amountCents: 2_500n }], { platformMaxPerDayUsd: 100 });
  await w.worker.run();
  assert.equal(w.row(1).status, "processing", "exactly at the limit is within it");

  // One cent more does not.
  w = world([sentToday({ amountCents: 7_501n }), { amountCents: 2_500n }], { platformMaxPerDayUsd: 100 });
  const res = await w.worker.run();
  assert.equal(res.waiting, 1);
  assert.equal(w.row(1).status, "pending");
  assert.equal(w.row(1).waitingReason, "daily_limit_reached");
  assert.equal(w.chain.chain.blockhashesIssued, 0);

  // After midnight UTC it goes out.
  w.clock.now = new Date(utcDayStart(NOW).getTime() + 24 * 3_600_000 + 1);
  await w.worker.run();
  assert.equal(w.row(1).status, "processing");
  assert.equal(w.row(1).waitingReason, null);
});

test("the day limit counts wallet payouts being sent and sent today, and nothing else", async () => {
  const yesterday = new Date(utcDayStart(NOW).getTime() - 1);
  const w = world(
    [
      // Not counted: claimed yesterday; taken as credits; failed; cancelled.
      { status: "completed", txSignature: "a", claimedAt: yesterday, amountCents: 9_000n },
      { status: "completed", payoutMethod: "credits", payoutAddress: null, claimedAt: NOW, amountCents: 9_000n },
      { status: "failed", claimedAt: NOW, amountCents: 9_000n },
      { status: "cancelled", amountCents: 9_000n },
      // Counted: being sent now, in SOL.
      {
        status: "processing",
        payoutMethod: "crypto_sol",
        txSignature: "b",
        lastValidBlockHeight: 5_000n,
        signedTxB64: null,
        claimedAt: utcDayStart(NOW),
        amountCents: 6_000n,
      },
      { amountCents: 4_000n },
      { amountCents: 500n },
    ],
    { platformMaxPerDayUsd: 100 },
  );
  await w.worker.run();
  assert.equal(w.row(5).status, "processing", "$60 being sent plus $40 is the limit, and fits");
  assert.equal(w.row(6).status, "pending", "and then the day is full");
  assert.equal(w.row(6).waitingReason, "daily_limit_reached");
});

test("a waiting payout is sent on the first run after what held it is put right", async () => {
  const w = world([{}]);
  w.chain.chain.payerUsdcBaseUnits = 0n;
  await w.worker.run();
  assert.equal(w.row().waitingReason, "wallet_low");

  w.chain.chain.payerUsdcBaseUnits = 1_000_000_000n; // the wallet was filled by hand
  const res = await w.worker.run();
  assert.equal(res.sent, 1);
  assert.equal(w.row().status, "processing");
  assert.equal(w.row().waitingReason, null);
  assert.equal(w.row().attemptCount, 1);
});

test("payouts that are waiting never crowd out the ones being sent", async () => {
  // Three pending payouts fill a batch of two; the one being sent is older
  // than none of them and must still be followed.
  const w = world([{}, {}, {}, { requestedAt: new Date(NOW.getTime() + 60_000) }]);
  w.chain.chain.payerUsdcBaseUnits = 25_000_000n; // covers one
  await w.worker.run(1); // the oldest is claimed
  const sending = w.row(0);
  assert.equal(sending.status, "processing");
  w.chain.chain.payerUsdcBaseUnits = 0n;
  assert.equal(w.chain.land(sending.txSignature!), true);
  const res = await w.worker.run(2);
  assert.equal(res.completed, 1);
  assert.equal(w.row(0).status, "completed");
});

test("a paying wallet that covers one payout is signed against for one: the rest wait, with no attempt used", async () => {
  const w = world([{}, {}, {}]);
  w.chain.chain.payerUsdcBaseUnits = 25_000_000n; // covers exactly one of the three

  const first = await w.worker.run();
  assert.equal(first.sent, 1);
  assert.equal(first.waiting, 2);
  assert.equal(w.row(0).status, "processing");
  for (const i of [1, 2]) {
    assert.equal(w.row(i).status, "pending");
    assert.equal(w.row(i).waitingReason, "wallet_low");
    assert.equal(w.row(i).attemptCount, 0, "nothing was signed for it");
  }
  assert.equal(w.chain.chain.blockhashesIssued, 1);
  assert.equal(w.chain.chain.broadcasts.length, 1);

  // The next run: the first transfer is still out and the chain's books
  // still show the full balance. What it will take stays held.
  const second = await w.worker.run();
  assert.equal(second.sent, 0);
  assert.equal(second.resent, 1);
  assert.equal(w.chain.chain.blockhashesIssued, 1, "still one transfer signed");
  assert.equal(w.row(1).attemptCount, 0);

  // It lands and is completed: the balance read is the truth again, and
  // the next payout goes out on that same run.
  assert.equal(w.chain.land(w.row(0).txSignature!), true);
  const third = await w.worker.run();
  assert.equal(third.completed, 1);
  assert.equal(third.sent, 1);
  assert.equal(w.row(1).status, "processing");
  assert.equal(w.row(2).status, "pending");
});

test("SOL being sent is held too, and so is the fee of every transfer that is out", async () => {
  const keep = PAYOUT_FEE_LAMPORTS + PAYING_WALLET_KEEP_LAMPORTS;
  // Two SOL payouts of 0.125 SOL each; the wallet has one fee short of both.
  let w = world([{ payoutMethod: "crypto_sol" }, { payoutMethod: "crypto_sol" }]);
  w.chain.chain.payerLamports = 250_000_000n + keep + PAYOUT_FEE_LAMPORTS - 1n;
  let res = await w.worker.run();
  assert.equal(res.sent, 1);
  assert.equal(res.waiting, 1);
  assert.equal(w.row(1).waitingReason, "wallet_low");

  w = world([{ payoutMethod: "crypto_sol" }, { payoutMethod: "crypto_sol" }]);
  w.chain.chain.payerLamports = 250_000_000n + keep + PAYOUT_FEE_LAMPORTS;
  res = await w.worker.run();
  assert.equal(res.sent, 2, "exactly enough for both, with both fees");
});

// ============================================
// An address that cannot be a wallet's
// ============================================

test("a payout with no address, or one that is not a wallet's, fails with its code and the earnings go back", async () => {
  const [derived] = PublicKey.findProgramAddressSync([Buffer.from("x")], DEVNET_USDC);
  const cases: Array<[string | null, string]> = [
    [null, "missing_address"],
    ["", "missing_address"],
    ["not-a-pubkey", "invalid_address"],
    [derived.toBase58(), "invalid_address"],
  ];
  for (const [payoutAddress, code] of cases) {
    const w = world([{ payoutAddress }]);
    const res = await w.worker.run();
    assert.equal(res.failed, 1);
    const row = w.row();
    assert.equal(row.status, "failed");
    assert.equal(row.failureCode, code);
    assert.equal(w.store.state.earnings[row.publisherId], 2_500n);
    assert.equal(w.store.restores(row.id).length, 1);
    assert.equal(w.chain.chain.broadcasts.length, 0);
    // A second run finds nothing to do, and restores nothing more.
    await w.worker.run();
    assert.equal(w.store.restores(row.id).length, 1);
  }
});

test("an unsupported method fails the payout with its code, rather than dropping it", async () => {
  const w = world([{ payoutMethod: "carrier_pigeon" }]);
  const res = await w.worker.run();
  assert.equal(res.failed, 1);
  assert.equal(w.row().status, "failed");
  assert.equal(w.row().failureCode, "unsupported_method");
  assert.match(w.row().failureReason ?? "", /unsupported payout method: carrier_pigeon/);
  assert.equal(w.store.restores(w.row().id).length, 1);
});

// ============================================
// Credits
// ============================================

test("a credits payout is claimed, then completed and granted in one transaction, as payout_credit", async () => {
  const w = world([{ payoutMethod: "credits", payoutAddress: null, amountCents: 4_120n }]);
  const res = await w.worker.run();
  assert.equal(res.completed, 1);

  const row = w.row();
  assert.equal(row.status, "completed");
  assert.ok(row.processedAt);
  assert.equal(row.txSignature, null);
  assert.equal(w.store.state.credits[row.publisherId], 4_120n);
  assert.deepEqual(w.store.state.creditLedger, [
    {
      orgId: row.publisherId,
      amountCents: 4_120n,
      type: "payout_credit",
      description: "Creator payout (credits)",
      referenceId: row.id,
      balanceAfter: 4_120n,
    },
  ]);
  assert.equal(w.store.restores(row.id).length, 0, "the earnings were paid out, not given back");
  assert.equal(w.chain.chain.broadcasts.length, 0, "credits need no chain");

  // Seen again by any number of runs: granted once.
  await w.worker.run();
  await w.worker.run();
  assert.equal(w.store.state.creditLedger.length, 1);
  assert.equal(w.store.state.credits[row.publisherId], 4_120n);
});

test("a credits payout does not wait for the chain, the price or the paying wallet", async () => {
  const w = world([{ payoutMethod: "credits", payoutAddress: null }], {
    cluster: () => ({ ok: false, reason: "unreachable" }),
    price: () => ({ ok: false, code: "source_off" }),
    platformMaxPerDayUsd: 5,
  });
  w.chain.chain.readsFail = true;
  w.chain.chain.payerLamports = 0n;
  const res = await w.worker.run();
  assert.equal(res.completed, 1);
  assert.equal(w.row().status, "completed");
});

test("a credits payout left processing by a crash is completed and granted once by the next run", async () => {
  const w = world([{ payoutMethod: "credits", payoutAddress: null, status: "processing" }]);
  const [a, b] = await Promise.all([w.worker.run(), w.worker.run()]);
  assert.equal(a.completed + b.completed, 1);
  assert.equal(w.store.state.creditLedger.length, 1);
  assert.equal(w.row().status, "completed");
});

test("a credits grant that fails rolls the completion back: never completed without the credits", async () => {
  const wallet = Keypair.generate();
  const payout = standInPayout({ publisherId: ORG, payoutMethod: "credits", payoutAddress: null });
  let failing = true;
  const store = payoutStandIn(
    { payouts: [payout], earnings: { [ORG]: 0n } },
    { failStatement: (op) => (failing && op === "creditTransaction.create" ? new Error("connection reset") : null) },
  );
  const chain = chainStandIn({ payer: wallet.publicKey, usdcMint: DEVNET_USDC });
  const worker = standInWorker({ db: store.db, chain, payoutWallet: wallet, usdcMint: DEVNET_USDC });

  const res = await worker.run();
  assert.equal(res.errors, 1);
  assert.equal(store.payout(payout.id).status, "processing");
  assert.equal(store.state.credits[ORG] ?? 0n, 0n);
  assert.equal(store.state.creditLedger.length, 0);

  failing = false;
  const next = await worker.run();
  assert.equal(next.completed, 1);
  assert.equal(store.state.credits[ORG], 2_500n);
});

// ============================================
// The order of the steps, on hand-made deps
// ============================================

function row(over: Partial<ClaimablePayoutRow> = {}): ClaimablePayoutRow {
  return {
    id: "p1",
    publisherId: "org",
    amountCents: 5_000n,
    payoutMethod: "crypto_usdc",
    payoutAddress: Keypair.generate().publicKey.toBase58(),
    status: "pending",
    txSignature: null,
    signedTxB64: null,
    lastValidBlockHeight: null,
    claimedAt: null,
    attemptCount: 0,
    waitingReason: null,
    ...over,
  };
}

function fate(answer: SignatureFateAnswer["fate"], reason: SignatureFateAnswer["reason"]): SignatureFateAnswer {
  return {
    fate: answer,
    reason,
    signature: "sig",
    detail: {
      finalizedSlot: null,
      finalizedBlockHeight: null,
      lastValidBlockHeight: null,
      marginBlocks: 32,
      statusContextSlot: null,
      confirmationStatus: null,
      landedSlot: null,
      blockhashValid: null,
      blockhashContextSlot: null,
    },
  };
}

function recorded(rows: ClaimablePayoutRow[], over: Partial<PayoutExecutorTickDeps> = {}) {
  const calls: string[] = [];
  const note =
    <A extends unknown[], R>(name: string, answer: R) =>
    async (..._args: A): Promise<R> => {
      calls.push(name);
      return answer;
    };
  const deps: PayoutExecutorTickDeps = {
    now: () => NOW,
    maxAttempts: 3,
    platformMaxPerDayCents: 500_000n,
    loadClaimablePayouts: async () => rows,
    claimCredits: note("claimCredits", true),
    settleCredits: note("settleCredits", { outcome: "completed", balanceAfterCents: 0n } as const),
    checkCluster: note("checkCluster", { ok: true } as const),
    quoteSolAmount: note("quoteSolAmount", {
      ok: true,
      lamports: 1n,
      quote: { priceMicroUsd: 1n, publishTime: NOW, source: "static" },
    } as const),
    walletCentsClaimedSince: note("walletCentsClaimedSince", 0n),
    checkFunds: note("checkFunds", { covered: true } as const),
    prepare: note("prepare", { txSignature: "sig", signedTxB64: "Ynl0ZXM=", lastValidBlockHeight: 1_150n }),
    claimWallet: note("claimWallet", true),
    broadcast: note("broadcast", undefined),
    readFate: note("readFate", fate("in_flight", "absent_within_window")),
    markCompleted: note("markCompleted", true),
    returnToPending: note("returnToPending", true),
    noteFirstSeen: note("noteFirstSeen", true),
    failAndRestore: note("failAndRestore", true),
    setWaiting: note("setWaiting", true),
    ...over,
  };
  return { deps, calls };
}

test("a pending wallet payout: every check, then sign, then claim, then send, in that order", async () => {
  const { deps, calls } = recorded([row()]);
  const res = await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.deepEqual(calls, ["checkCluster", "walletCentsClaimedSince", "checkFunds", "prepare", "claimWallet", "broadcast"]);
  assert.equal(res.sent, 1);
  assert.equal(res.claimable, 1);
});

test("a SOL payout asks for a price before the limit and the funds", async () => {
  const { deps, calls } = recorded([row({ payoutMethod: "crypto_sol" })]);
  await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.deepEqual(calls.slice(0, 3), ["checkCluster", "quoteSolAmount", "walletCentsClaimedSince"]);
});

test("payouts being sent are looked at first, and what stays out is held back from the funds check", async () => {
  const asked: Array<{ usdcBaseUnits: bigint; lamports: bigint }> = [];
  const { deps, calls } = recorded(
    [
      // Loaded in the wrong order on purpose.
      row({ id: "waiting" }),
      row({
        id: "out",
        status: "processing",
        txSignature: "sig",
        signedTxB64: "Ynl0ZXM=",
        lastValidBlockHeight: 1_150n,
        attemptCount: 1,
        amountRaw: "70000000",
      }),
      row({
        id: "out-sol",
        payoutMethod: "crypto_sol",
        status: "processing",
        txSignature: "sig2",
        signedTxB64: "Ynl0ZXM=",
        lastValidBlockHeight: 1_150n,
        attemptCount: 1,
        amountRaw: "900",
      }),
      row({ id: "waiting-2" }),
    ],
    {
      checkFunds: async ({ held }) => {
        asked.push(held);
        return { covered: true };
      },
    },
  );
  await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.deepEqual(calls.slice(0, 4), ["readFate", "broadcast", "readFate", "broadcast"]);
  // Before the first waiting payout: the two transfers that are out.
  assert.deepEqual(asked[0], { usdcBaseUnits: 70_000_000n, lamports: 900n + 2n * PAYOUT_FEE_LAMPORTS });
  // Before the second: also the one this run just claimed ($50 of USDC).
  assert.deepEqual(asked[1], { usdcBaseUnits: 120_000_000n, lamports: 900n + 3n * PAYOUT_FEE_LAMPORTS });
});

test("a transfer that ended in this run holds nothing", async () => {
  const sending = (id: string) =>
    row({ id, status: "processing", txSignature: id, signedTxB64: "Ynl0ZXM=", lastValidBlockHeight: 1n, attemptCount: 1, amountRaw: "70000000" });
  for (const answer of [fate("landed_ok", "status_ok"), fate("dead", "absent_expired_by_height"), fate("landed_failed", "status_err")]) {
    const asked: Array<{ usdcBaseUnits: bigint; lamports: bigint }> = [];
    const { deps } = recorded([sending("a"), row({ id: "b" })], {
      readFate: async () => answer,
      checkFunds: async ({ held }) => {
        asked.push(held);
        return { covered: true };
      },
    });
    await runPayoutExecutorTick({ limit: 10 }, deps);
    assert.deepEqual(asked, [{ usdcBaseUnits: 0n, lamports: 0n }], answer.fate);
  }
  // Unknown is not an end: it may yet land, so it is held.
  const asked: Array<{ usdcBaseUnits: bigint; lamports: bigint }> = [];
  const { deps } = recorded([sending("a"), row({ id: "b" })], {
    readFate: async () => fate("unknown", "status_read_failed"),
    checkFunds: async ({ held }) => {
      asked.push(held);
      return { covered: true };
    },
  });
  await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.deepEqual(asked, [{ usdcBaseUnits: 70_000_000n, lamports: PAYOUT_FEE_LAMPORTS }]);
});

test("a lost claim sends nothing", async () => {
  const { deps, calls } = recorded([row()], { claimWallet: async () => false });
  const res = await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.equal(res.skipped, 1);
  assert.equal(res.sent, 0);
  assert.ok(!calls.includes("broadcast"), "the transfer that lost the claim is never broadcast");
});

test("a pending payout is never looked up on the chain, and one being sent is never signed again", async () => {
  const pending = recorded([row()]);
  await runPayoutExecutorTick({ limit: 10 }, pending.deps);
  assert.ok(!pending.calls.includes("readFate"));

  const sending = recorded([
    row({ status: "processing", txSignature: "sig", signedTxB64: "Ynl0ZXM=", lastValidBlockHeight: 1_150n, attemptCount: 1 }),
  ]);
  const res = await runPayoutExecutorTick({ limit: 10 }, sending.deps);
  assert.deepEqual(sending.calls, ["readFate", "broadcast"], "the chain is asked, and the stored bytes go out again");
  assert.equal(res.resent, 1);
});

test("the chain's answer decides a payout being sent", async () => {
  const sending = (over: Partial<ClaimablePayoutRow> = {}) =>
    row({ status: "processing", txSignature: "sig", signedTxB64: "Ynl0ZXM=", lastValidBlockHeight: 1_150n, attemptCount: 1, ...over });

  let run = recorded([sending()], { readFate: async () => fate("landed_ok", "status_ok") });
  assert.equal((await runPayoutExecutorTick({ limit: 10 }, run.deps)).completed, 1);
  assert.deepEqual(run.calls, ["markCompleted"]);

  for (const answer of [fate("dead", "absent_expired_by_height"), fate("landed_failed", "status_err")]) {
    run = recorded([sending()], { readFate: async () => answer });
    assert.equal((await runPayoutExecutorTick({ limit: 10 }, run.deps)).returned, 1);
    assert.deepEqual(run.calls, ["returnToPending"], "attempts remain: back to pending");

    run = recorded([sending({ attemptCount: 3 })], { readFate: async () => answer });
    assert.equal((await runPayoutExecutorTick({ limit: 10 }, run.deps)).failed, 1);
    assert.deepEqual(run.calls, ["failAndRestore"], "the last attempt: failed and restored");
  }

  run = recorded([sending()], { readFate: async () => fate("unknown", "status_read_failed") });
  assert.equal((await runPayoutExecutorTick({ limit: 10 }, run.deps)).left, 1);
  assert.deepEqual(run.calls, [], "unknown: nothing is done");
});

test("the code a failed payout carries is could_not_send, whatever the chain said", async () => {
  const failures: Array<{ code: string; reason: string }> = [];
  const answer = { ...fate("landed_failed", "status_err"), error: '{"InstructionError":[0,"AccountNotFound"]}' };
  const { deps } = recorded(
    [row({ status: "processing", txSignature: "sig", lastValidBlockHeight: 1n, attemptCount: 3 })],
    {
      readFate: async () => answer,
      failAndRestore: async (_row, failure) => {
        failures.push(failure);
        return true;
      },
    },
  );
  await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.code, "could_not_send");
  assert.match(failures[0]!.reason, /AccountNotFound/, "the chain's words go to failure_reason");
});

test("a lost race on any write is silent: counted as skipped, nothing else done", async () => {
  const sending = row({ status: "processing", txSignature: "sig", lastValidBlockHeight: 1n, attemptCount: 1 });
  let run = recorded([sending], { readFate: async () => fate("landed_ok", "status_ok"), markCompleted: async () => false });
  assert.equal((await runPayoutExecutorTick({ limit: 10 }, run.deps)).skipped, 1);

  run = recorded([sending], { readFate: async () => fate("dead", "absent_expired_by_height"), returnToPending: async () => false });
  assert.equal((await runPayoutExecutorTick({ limit: 10 }, run.deps)).skipped, 1);

  run = recorded([row({ payoutAddress: null })], { failAndRestore: async () => false });
  const res = await runPayoutExecutorTick({ limit: 10 }, run.deps);
  assert.equal(res.skipped, 1);
  assert.equal(res.failed, 0);

  run = recorded([row({ payoutMethod: "credits" })], { claimCredits: async () => false });
  assert.equal((await runPayoutExecutorTick({ limit: 10 }, run.deps)).skipped, 1);
  assert.ok(!run.calls.includes("settleCredits"));

  // The payout was cancelled while the run was deciding it had to wait.
  run = recorded([row()], { checkFunds: async () => ({ covered: false, detail: "empty" }), setWaiting: async () => false });
  const waited = await runPayoutExecutorTick({ limit: 10 }, run.deps);
  assert.equal(waited.skipped, 1);
  assert.equal(waited.waiting, 0);
});

test("one payout that throws does not stop the others", async () => {
  const events: string[] = [];
  const { deps } = recorded(
    [row({ id: "a" }), row({ id: "b", payoutMethod: "credits" }), row({ id: "c" })],
    {
      walletCentsClaimedSince: async () => {
        throw new Error("db hiccup");
      },
      log: (event) => events.push(`${event.event}:${event.payoutId}`),
    },
  );
  const res = await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.equal(res.errors, 2, "both wallet payouts threw");
  assert.equal(res.completed, 1, "and the credits payout between them still settled");
  assert.deepEqual(events, ["row_error:a", "completed:b", "row_error:c"]);
});

test("a log that throws changes nothing", async () => {
  const { deps } = recorded([row()], {
    log: () => {
      throw new Error("logger down");
    },
  });
  const res = await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.equal(res.sent, 1);
  assert.equal(res.errors, 0);
});

test("midnight UTC, whatever the hour", () => {
  assert.equal(utcDayStart(new Date("2026-10-10T23:59:59.999Z")).toISOString(), "2026-10-10T00:00:00.000Z");
  assert.equal(utcDayStart(new Date("2026-10-10T00:00:00.000Z")).toISOString(), "2026-10-10T00:00:00.000Z");
  assert.equal(utcDayStart(new Date("2026-10-11T00:00:00.001+14:00")).toISOString(), "2026-10-10T00:00:00.000Z");
});
