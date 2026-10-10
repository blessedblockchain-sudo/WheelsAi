// The payout worker's writes (services/buildPayoutExecutorTickDeps.ts), one
// by one, against a stand-in database that applies a `where` as the real one
// does. Each is a compare-and-set: it changes the row only from the state
// the run read, and from any other state it writes nothing.
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import { buildPayoutExecutorTickDeps } from "../services/buildPayoutExecutorTickDeps.js";
import type { ClaimablePayoutRow, PayoutClaim } from "../services/runPayoutExecutorTick.js";
import {
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
const STATUSES = ["pending", "processing", "completed", "failed", "cancelled"];

function setup(over: Partial<StandInPayout> = {}, earnings: Record<string, bigint> = { [ORG]: 300n }) {
  const wallet = Keypair.generate();
  const payout = standInPayout({
    publisherId: ORG,
    payoutAddress: Keypair.generate().publicKey.toBase58(),
    ...over,
  });
  const store = payoutStandIn({ payouts: [payout], earnings });
  const chain = chainStandIn({ payer: wallet.publicKey, usdcMint: DEVNET_USDC });
  const { deps } = standInWorker({ db: store.db, chain, payoutWallet: wallet, usdcMint: DEVNET_USDC, now: () => NOW });
  /** The row as a run would have read it. */
  const read = (changes: Partial<ClaimablePayoutRow> = {}): ClaimablePayoutRow => {
    const row = store.payout(payout.id);
    return {
      id: row.id,
      publisherId: row.publisherId,
      amountCents: row.amountCents,
      payoutMethod: row.payoutMethod,
      payoutAddress: row.payoutAddress,
      status: row.status,
      txSignature: row.txSignature,
      signedTxB64: row.signedTxB64,
      lastValidBlockHeight: row.lastValidBlockHeight,
      claimedAt: row.claimedAt,
      attemptCount: row.attemptCount,
      waitingReason: row.waitingReason,
      ...changes,
    };
  };
  return { wallet, store, chain, deps, id: payout.id, row: () => store.payout(payout.id), read };
}

const CLAIM: PayoutClaim = {
  txSignature: "sig_new",
  signedTxB64: "c2lnbmVkIGJ5dGVz",
  lastValidBlockHeight: 1_150n,
  amountRaw: 25_000_000n,
  quote: null,
  claimedAt: NOW,
};

const SENDING: Partial<StandInPayout> = {
  status: "processing",
  txSignature: "sig_out",
  signedTxB64: "c2lnbmVkIGJ5dGVz",
  lastValidBlockHeight: 1_150n,
  claimedAt: NOW,
  attemptCount: 1,
  amountRaw: "25000000",
  quotePriceMicroUsd: 200_000_000n,
  quotePublishTime: NOW,
  quoteSource: "pyth",
};

// ============================================
// The settings
// ============================================

test("the limit is whole dollars turned into cents, and the settings are refused when they are not numbers", () => {
  const wallet = Keypair.generate();
  const store = payoutStandIn();
  const chain = chainStandIn({ payer: wallet.publicKey, usdcMint: DEVNET_USDC });
  const base = {
    prisma: store.db,
    connection: chain.connection,
    usdcMint: DEVNET_USDC,
    checkCluster: async () => ({ ok: true }) as const,
    getSolQuote: async () => standInSolPrice(200),
    solQuoteMarginBps: () => 0,
    readSignatureFate: chain.readFate,
  };
  const deps = buildPayoutExecutorTickDeps({ ...base, maxAttempts: 3, platformMaxPerDayUsd: 5_000 });
  assert.equal(deps.platformMaxPerDayCents, 500_000n);
  assert.equal(deps.maxAttempts, 3);
  assert.throws(() => buildPayoutExecutorTickDeps({ ...base, maxAttempts: 3, platformMaxPerDayUsd: Number.NaN }));
  assert.throws(() => buildPayoutExecutorTickDeps({ ...base, maxAttempts: 3, platformMaxPerDayUsd: 12.5 }));
  assert.throws(() => buildPayoutExecutorTickDeps({ ...base, maxAttempts: 0, platformMaxPerDayUsd: 5_000 }));
});

// ============================================
// loadClaimablePayouts
// ============================================

test("load: open payouts only: those being sent, then those nothing is holding, then those waiting; each oldest first, each up to the limit", async () => {
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
  const store = payoutStandIn({
    payouts: [
      // Older than everything else, and waiting: they must not push the others out.
      standInPayout({ id: "waiting_old", publisherId: "h", requestedAt: at(-9), waitingReason: "wallet_low" }),
      standInPayout({ id: "waiting_new", publisherId: "i", requestedAt: at(-8), waitingReason: "daily_limit_reached" }),
      standInPayout({ id: "pending_new", publisherId: "a", requestedAt: at(5) }),
      standInPayout({ id: "pending_old", publisherId: "b", requestedAt: at(1) }),
      standInPayout({ id: "sending_new", publisherId: "c", status: "processing", txSignature: "s1", requestedAt: at(4) }),
      standInPayout({ id: "sending_old", publisherId: "d", status: "processing", txSignature: "s2", requestedAt: at(2) }),
      standInPayout({ id: "done", publisherId: "e", status: "completed", txSignature: "s3" }),
      standInPayout({ id: "failed", publisherId: "f", status: "failed" }),
      standInPayout({ id: "cancelled", publisherId: "g", status: "cancelled" }),
    ],
  });
  const wallet = Keypair.generate();
  const chain = chainStandIn({ payer: wallet.publicKey, usdcMint: DEVNET_USDC });
  const { deps } = standInWorker({ db: store.db, chain, payoutWallet: wallet, usdcMint: DEVNET_USDC });

  const all = await deps.loadClaimablePayouts({ limit: 10 });
  assert.deepEqual(all.map((r) => r.id), ["sending_old", "sending_new", "pending_old", "pending_new", "waiting_old", "waiting_new"]);
  assert.deepEqual(Object.keys(all[0]!).sort(), [
    "amountCents",
    "amountRaw",
    "attemptCount",
    "claimedAt",
    "id",
    "lastValidBlockHeight",
    "payoutAddress",
    "payoutMethod",
    "publisherId",
    "signedTxB64",
    "status",
    "txSignature",
    "waitingReason",
  ]);

  const one = await deps.loadClaimablePayouts({ limit: 1 });
  assert.deepEqual(one.map((r) => r.id), ["sending_old", "pending_old", "waiting_old"], "the limit is applied to each kind");
});

// ============================================
// claimWallet
// ============================================

test("claimWallet: one write moves pending to processing and stores the whole claim", async () => {
  const s = setup({ waitingReason: "wallet_low" });
  const quote = { priceMicroUsd: 201_500_000n, publishTime: new Date("2026-10-10T11:59:58.000Z"), source: "pyth" };

  assert.equal(await s.deps.claimWallet(s.read(), { ...CLAIM, quote }), true);
  const row = s.row();
  assert.equal(row.status, "processing");
  assert.equal(row.txSignature, "sig_new");
  assert.equal(row.signedTxB64, "c2lnbmVkIGJ5dGVz");
  assert.equal(row.lastValidBlockHeight, 1_150n);
  assert.equal(row.amountRaw, "25000000");
  assert.equal(row.quotePriceMicroUsd, 201_500_000n);
  assert.equal(row.quotePublishTime?.toISOString(), "2026-10-10T11:59:58.000Z");
  assert.equal(row.quoteSource, "pyth");
  assert.equal(row.claimedAt?.getTime(), NOW.getTime());
  assert.equal(row.attemptCount, 1);
  assert.equal(row.waitingReason, null, "the reason it was waiting is cleared");
  assert.equal(s.store.state.payoutWrites.length, 1, "one write");
  assert.equal(s.store.state.earnings[ORG], 300n, "a claim never touches the earnings");
});

test("claimWallet: only from pending", async () => {
  for (const status of STATUSES.filter((st) => st !== "pending")) {
    const s = setup({ status });
    // The run read it while it was still pending.
    assert.equal(await s.deps.claimWallet(s.read({ status: "pending" }), CLAIM), false, status);
    assert.equal(s.row().status, status);
    assert.equal(s.row().txSignature, null);
    assert.equal(s.store.state.payoutWrites.length, 0, "the loser writes nothing");
  }
});

test("claimWallet: never over a signature, and never from a stale count of attempts", async () => {
  // A pending row that somehow still has a signature is not claimable.
  let s = setup({ txSignature: "sig_old" });
  assert.equal(await s.deps.claimWallet(s.read({ txSignature: null }), CLAIM), false);
  assert.equal(s.row().txSignature, "sig_old");

  // Claimed and returned by another worker since this run read it.
  s = setup({ attemptCount: 1, expiredSignatures: ["sig_dead"] });
  assert.equal(await s.deps.claimWallet(s.read({ attemptCount: 0 }), CLAIM), false);
  assert.equal(s.row().status, "pending");
  assert.equal(s.row().attemptCount, 1);
});

test("claimWallet: two at once, one wins", async () => {
  const s = setup();
  const read = s.read();
  const results = await Promise.all([
    s.deps.claimWallet(read, { ...CLAIM, txSignature: "sig_a" }),
    s.deps.claimWallet(read, { ...CLAIM, txSignature: "sig_b" }),
  ]);
  assert.deepEqual([...results].sort(), [false, true]);
  assert.equal(s.row().attemptCount, 1);
  assert.equal(s.row().txSignature, results[0] ? "sig_a" : "sig_b");
});

test("claimWallet: a signature already on another row is a lost claim, and any other database error is thrown", async () => {
  const wallet = Keypair.generate();
  const mine = standInPayout({ publisherId: "a" });
  const other = standInPayout({ publisherId: "b", status: "processing", txSignature: "sig_new" });
  const store = payoutStandIn({ payouts: [mine, other] });
  const chain = chainStandIn({ payer: wallet.publicKey, usdcMint: DEVNET_USDC });
  const { deps } = standInWorker({ db: store.db, chain, payoutWallet: wallet, usdcMint: DEVNET_USDC });
  const read = (await deps.loadClaimablePayouts({ limit: 10 })).find((r) => r.id === mine.id)!;
  assert.equal(await deps.claimWallet(read, CLAIM), false);
  assert.equal(store.payout(mine.id).status, "pending");

  const failing = payoutStandIn(
    { payouts: [standInPayout({ id: "x" })] },
    { failStatement: (op) => (op === "creatorPayout.updateMany" ? new Error("connection reset") : null) },
  );
  const broken = standInWorker({ db: failing.db, chain, payoutWallet: wallet, usdcMint: DEVNET_USDC });
  await assert.rejects(broken.deps.claimWallet({ ...read, id: "x" }, CLAIM), /connection reset/);
});

// ============================================
// claimCredits
// ============================================

test("claimCredits: pending to processing, only for a credits payout, only once", async () => {
  const s = setup({ payoutMethod: "credits", payoutAddress: null, waitingReason: "wallet_low" });
  assert.equal(await s.deps.claimCredits(s.read()), true);
  assert.equal(s.row().status, "processing");
  assert.equal(s.row().waitingReason, null);
  assert.equal(await s.deps.claimCredits(s.read({ status: "pending" })), false, "the second claim loses");

  const wallet = setup({ payoutMethod: "crypto_usdc" });
  assert.equal(await wallet.deps.claimCredits(wallet.read()), false, "a wallet payout is never claimed without its signature");
  assert.equal(wallet.row().status, "pending");

  for (const status of STATUSES.filter((st) => st !== "pending")) {
    const other = setup({ payoutMethod: "credits", status });
    assert.equal(await other.deps.claimCredits(other.read({ status: "pending" })), false, status);
    assert.equal(other.row().status, status);
  }
});

test("settleCredits: completes and grants once, as payout_credit, with the run's clock", async () => {
  const s = setup({ payoutMethod: "credits", payoutAddress: null, status: "processing", amountCents: 4_120n });
  const first = await s.deps.settleCredits(s.read());
  assert.deepEqual(first, { outcome: "completed", balanceAfterCents: 4_120n });
  assert.equal(s.row().status, "completed");
  assert.equal(s.row().processedAt?.getTime(), NOW.getTime());
  assert.equal(s.store.state.creditLedger[0]!.type, "payout_credit");
  const second = await s.deps.settleCredits(s.read({ status: "processing" }));
  assert.deepEqual(second, { outcome: "already_settled" });
  assert.equal(s.store.state.creditLedger.length, 1);
  assert.equal(s.store.state.credits[ORG], 4_120n);
});

// ============================================
// markCompleted
// ============================================

test("markCompleted: processing to completed, on the signature the run judged", async () => {
  const s = setup(SENDING);
  assert.equal(await s.deps.markCompleted(s.read()), true);
  assert.equal(s.row().status, "completed");
  assert.equal(s.row().processedAt?.getTime(), NOW.getTime());
  assert.equal(s.row().txSignature, "sig_out", "the signature that paid stays on the row");
  assert.equal(await s.deps.markCompleted(s.read({ status: "processing" })), false, "once");
  assert.equal(s.store.state.payoutWrites.length, 1);
  assert.equal(s.store.state.earnings[ORG], 300n);
});

test("markCompleted: not on another signature, not without one, not from another status", async () => {
  let s = setup(SENDING);
  // The row moved on to a fresh transfer since the run read it.
  assert.equal(await s.deps.markCompleted(s.read({ txSignature: "sig_earlier" })), false);
  assert.equal(s.row().status, "processing");

  assert.equal(await s.deps.markCompleted(s.read({ txSignature: null })), false);
  assert.equal(s.row().status, "processing");

  for (const status of STATUSES.filter((st) => st !== "processing")) {
    s = setup({ ...SENDING, status });
    assert.equal(await s.deps.markCompleted(s.read({ status: "processing" })), false, status);
    assert.equal(s.row().status, status);
  }
});

// ============================================
// returnToPending
// ============================================

test("returnToPending: the claim is cleared and the signature joins the list", async () => {
  const s = setup({ ...SENDING, expiredSignatures: ["sig_first"], attemptCount: 2 });
  assert.equal(await s.deps.returnToPending(s.read()), true);
  const row = s.row();
  assert.equal(row.status, "pending");
  assert.equal(row.txSignature, null);
  assert.equal(row.signedTxB64, null);
  assert.equal(row.lastValidBlockHeight, null);
  assert.equal(row.claimedAt, null);
  assert.equal(row.amountRaw, null);
  assert.equal(row.quotePriceMicroUsd, null);
  assert.equal(row.quotePublishTime, null);
  assert.equal(row.quoteSource, null);
  assert.equal(row.waitingReason, null);
  assert.deepEqual(row.expiredSignatures, ["sig_first", "sig_out"]);
  assert.equal(row.attemptCount, 2, "attempts are never given back");
  assert.equal(s.store.state.earnings[ORG], 300n, "still reserved");
  assert.equal(s.store.state.earningsLedger.length, 0);

  assert.equal(await s.deps.returnToPending(s.read({ status: "processing", txSignature: "sig_out" })), false, "once");
  assert.deepEqual(s.row().expiredSignatures, ["sig_first", "sig_out"]);
});

test("returnToPending: only from processing, and only on the signature the run judged", async () => {
  let s = setup(SENDING);
  assert.equal(await s.deps.returnToPending(s.read({ txSignature: "sig_earlier" })), false);
  assert.equal(s.row().status, "processing");
  assert.equal(s.row().txSignature, "sig_out");

  for (const status of STATUSES.filter((st) => st !== "processing")) {
    s = setup({ ...SENDING, status });
    assert.equal(await s.deps.returnToPending(s.read({ status: "processing" })), false, status);
    assert.equal(s.row().status, status);
    assert.deepEqual(s.row().expiredSignatures, []);
  }
});

test("returnToPending: a row claimed with no signature goes back with nothing added to the list", async () => {
  const s = setup({ status: "processing", txSignature: null });
  assert.equal(await s.deps.returnToPending(s.read()), true);
  assert.equal(s.row().status, "pending");
  assert.deepEqual(s.row().expiredSignatures, []);

  // It is not a way round a signature: a row that has one is not touched.
  const signed = setup(SENDING);
  assert.equal(await signed.deps.returnToPending(signed.read({ txSignature: null })), false);
  assert.equal(signed.row().status, "processing");
});

// ============================================
// noteFirstSeen
// ============================================

test("noteFirstSeen: written once, on a payout being sent that has no claim time", async () => {
  const s = setup({ status: "processing", txSignature: "sig_legacy" });
  const first = new Date("2026-10-10T12:00:00.000Z");
  assert.equal(await s.deps.noteFirstSeen(s.read(), first), true);
  assert.equal(s.row().claimedAt?.getTime(), first.getTime());
  // A later run, or another worker, never moves it forward.
  const later = new Date("2026-10-10T12:20:00.000Z");
  assert.equal(await s.deps.noteFirstSeen(s.read({ claimedAt: null }), later), false);
  assert.equal(s.row().claimedAt?.getTime(), first.getTime());

  const pending = setup({ status: "pending" });
  assert.equal(await pending.deps.noteFirstSeen(pending.read({ status: "processing", txSignature: "x" }), later), false);
  assert.equal(pending.row().claimedAt, null);
});

// ============================================
// setWaiting
// ============================================

test("setWaiting: only while the payout is still pending", async () => {
  const s = setup();
  assert.equal(await s.deps.setWaiting(s.read(), "wallet_low"), true);
  assert.equal(s.row().waitingReason, "wallet_low");
  assert.equal(s.row().status, "pending");
  assert.equal(await s.deps.setWaiting(s.read(), "daily_limit_reached"), true);
  assert.equal(s.row().waitingReason, "daily_limit_reached");

  for (const status of STATUSES.filter((st) => st !== "pending")) {
    const other = setup({ status });
    assert.equal(await other.deps.setWaiting(other.read({ status: "pending" }), "wallet_low"), false, status);
    assert.equal(other.row().waitingReason, null);
  }
});

// ============================================
// failAndRestore
// ============================================

test("failAndRestore: failed with its code, the amount back through the earnings ledger, in one transaction", async () => {
  for (const status of ["pending", "processing"]) {
    const s = setup({ status, waitingReason: status === "pending" ? "wallet_low" : null });
    const won = await s.deps.failAndRestore(s.read(), { code: "invalid_address", reason: "invalid payout address" });
    assert.equal(won, true);
    const row = s.row();
    assert.equal(row.status, "failed");
    assert.equal(row.failureCode, "invalid_address");
    assert.equal(row.failureReason, "invalid payout address");
    assert.equal(row.waitingReason, null);
    assert.equal(s.store.state.earnings[ORG], 2_800n);
    assert.deepEqual(s.store.state.earningsLedger, [
      {
        orgId: ORG,
        amountCents: 2_500n,
        type: "payout_restored",
        referenceId: s.id,
        description: "Payout failed, amount returned",
        balanceAfter: 2_800n,
      },
    ]);

    // Again, with the row as it was first read: nothing more.
    assert.equal(await s.deps.failAndRestore(s.read({ status }), { code: "invalid_address", reason: "again" }), false);
    assert.equal(s.store.state.earnings[ORG], 2_800n);
    assert.equal(s.store.state.earningsLedger.length, 1, "restored once");
    assert.equal(s.row().failureReason, "invalid payout address");
  }
});

test("failAndRestore: a payout with a dead transfer keeps the signature in the list and nothing that could be sent", async () => {
  const s = setup({ ...SENDING, attemptCount: 3, expiredSignatures: ["sig_1", "sig_2"] });
  const chainWords = `transfer sig_out failed on the chain: ${"x".repeat(5_000)}`;
  assert.equal(await s.deps.failAndRestore(s.read(), { code: "could_not_send", reason: chainWords }), true);
  const row = s.row();
  assert.equal(row.status, "failed");
  assert.equal(row.failureCode, "could_not_send");
  assert.equal(row.txSignature, null);
  assert.equal(row.signedTxB64, null);
  assert.deepEqual(row.expiredSignatures, ["sig_1", "sig_2", "sig_out"]);
  assert.equal(row.failureReason?.length, 1_000, "the chain's words are kept, to a length");
  assert.equal(s.store.state.earnings[ORG], 2_800n);
});

test("failAndRestore: only from the status and signature the run judged", async () => {
  // Cancelled, completed or already failed since the run read it.
  for (const status of ["completed", "failed", "cancelled"]) {
    const s = setup({ status });
    assert.equal(await s.deps.failAndRestore(s.read({ status: "pending" }), { code: "invalid_address", reason: "r" }), false);
    assert.equal(s.row().status, status);
    assert.equal(s.store.state.earnings[ORG], 300n, "nothing is given back for a payout that went somewhere else");
    assert.equal(s.store.state.earningsLedger.length, 0);
  }

  // Judged dead on one signature; the row has since moved to a fresh one.
  let s = setup(SENDING);
  assert.equal(
    await s.deps.failAndRestore(s.read({ txSignature: "sig_earlier" }), { code: "could_not_send", reason: "r" }),
    false,
  );
  assert.equal(s.row().status, "processing");
  assert.equal(s.store.state.earningsLedger.length, 0);

  // Judged while pending; claimed since. A payout being sent is never failed from here.
  s = setup(SENDING);
  assert.equal(
    await s.deps.failAndRestore(s.read({ status: "pending", txSignature: null }), { code: "invalid_address", reason: "r" }),
    false,
  );
  assert.equal(s.row().status, "processing");
  assert.equal(s.store.state.earnings[ORG], 300n);
});

test("failAndRestore: if the earnings cannot be given back the failure rolls back", async () => {
  // No publisher profile for the organization: the restore cannot land.
  const s = setup({ status: "processing" }, {});
  await assert.rejects(
    s.deps.failAndRestore(s.read(), { code: "could_not_send", reason: "r" }),
    /earnings could not be restored/,
  );
  assert.equal(s.row().status, "processing", "never failed without its amount given back");
  assert.equal(s.row().failureCode, null);
  assert.equal(s.row().failureReason, null);
  assert.equal(s.store.state.earningsLedger.length, 0);
});

// ============================================
// The reads
// ============================================

test("walletCentsClaimedSince: wallet payouts being sent or sent, claimed at or after the moment given", async () => {
  const since = new Date("2026-10-10T00:00:00.000Z");
  const before = new Date(since.getTime() - 1);
  const store = payoutStandIn({
    payouts: [
      standInPayout({ publisherId: "a", status: "completed", txSignature: "1", claimedAt: since, amountCents: 100n }),
      standInPayout({ publisherId: "b", status: "processing", txSignature: "2", claimedAt: NOW, payoutMethod: "crypto_sol", amountCents: 20n }),
      standInPayout({ publisherId: "c", status: "completed", txSignature: "3", claimedAt: before, amountCents: 3_000n }),
      standInPayout({ publisherId: "d", status: "completed", payoutMethod: "credits", claimedAt: NOW, amountCents: 3_000n }),
      standInPayout({ publisherId: "e", status: "failed", claimedAt: NOW, amountCents: 3_000n }),
      standInPayout({ publisherId: "f", status: "pending", amountCents: 3_000n }),
      standInPayout({ publisherId: "g", status: "cancelled", amountCents: 3_000n }),
    ],
  });
  const wallet = Keypair.generate();
  const chain = chainStandIn({ payer: wallet.publicKey, usdcMint: DEVNET_USDC });
  const { deps } = standInWorker({ db: store.db, chain, payoutWallet: wallet, usdcMint: DEVNET_USDC });
  assert.equal(await deps.walletCentsClaimedSince(since), 120n);
  assert.equal(await deps.walletCentsClaimedSince(new Date(NOW.getTime() + 1)), 0n, "nothing yet is zero, not null");
});

test("prepare signs with the paying wallet and sends nothing; broadcast hands over exactly the stored bytes", async () => {
  const s = setup();
  const recipient = Keypair.generate().publicKey.toBase58();
  const artifact = await s.deps.prepare({ method: "crypto_usdc", recipient, amountRaw: 25_000_000n });
  assert.equal(s.chain.chain.broadcasts.length, 0, "signing is not sending");
  assert.equal(artifact.lastValidBlockHeight, 1_150n);

  await s.deps.broadcast(artifact.signedTxB64);
  assert.deepEqual(s.chain.chain.broadcasts, [{ signature: artifact.txSignature, bytesB64: artifact.signedTxB64 }]);
});

test("without a paying wallet nothing is signed, and the funds check says it is not covered", async () => {
  const wallet = Keypair.generate();
  const store = payoutStandIn();
  const chain = chainStandIn({ payer: wallet.publicKey, usdcMint: DEVNET_USDC });
  const { deps } = standInWorker({ db: store.db, chain, usdcMint: DEVNET_USDC });
  const recipient = Keypair.generate().publicKey.toBase58();
  const funds = await deps.checkFunds({
    method: "crypto_usdc",
    recipient,
    amountRaw: 1n,
    held: { usdcBaseUnits: 0n, lamports: 0n },
  });
  assert.equal(funds.covered, false);
  await assert.rejects(deps.prepare({ method: "crypto_usdc", recipient, amountRaw: 1n }), /no paying wallet/);
  assert.equal(chain.chain.blockhashesIssued, 0);
});

test("checkFunds takes what is held for transfers already out off what the wallet holds", async () => {
  const wallet = Keypair.generate();
  const store = payoutStandIn();
  const chain = chainStandIn({ payer: wallet.publicKey, usdcMint: DEVNET_USDC });
  const { deps } = standInWorker({ db: store.db, chain, payoutWallet: wallet, usdcMint: DEVNET_USDC });
  const recipient = Keypair.generate().publicKey.toBase58();
  chain.chain.payerUsdcBaseUnits = 30_000_000n;
  const ask = (heldUsdc: bigint) =>
    deps.checkFunds({
      method: "crypto_usdc",
      recipient,
      amountRaw: 25_000_000n,
      held: { usdcBaseUnits: heldUsdc, lamports: 0n },
    });
  assert.equal((await ask(0n)).covered, true);
  assert.equal((await ask(5_000_000n)).covered, true, "exactly what is left");
  assert.equal((await ask(5_000_001n)).covered, false);
});

test("the price read never throws into the run: a throw is no price", async () => {
  const wallet = Keypair.generate();
  const store = payoutStandIn();
  const chain = chainStandIn({ payer: wallet.publicKey, usdcMint: DEVNET_USDC });
  const deps = buildPayoutExecutorTickDeps({
    prisma: store.db,
    connection: chain.connection,
    payoutWallet: wallet,
    usdcMint: DEVNET_USDC,
    maxAttempts: 3,
    platformMaxPerDayUsd: 5_000,
    checkCluster: async () => ({ ok: true }),
    getSolQuote: async () => {
      throw new Error("ECONNRESET");
    },
    solQuoteMarginBps: () => 0,
    readSignatureFate: chain.readFate,
  });
  const amount = await deps.quoteSolAmount(5_000n);
  assert.equal(amount.ok, false);
});
