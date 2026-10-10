// The payout worker's pieces (services/payoutExecutor.ts) and the life of a
// wallet payout from its claim to its end, on stand-ins for the database
// and the chain (tests/payoutStandIn.ts). Nothing here opens a socket.
//
// What is pinned: a send that throws leaves the payout processing WITH its
// signed bytes; recovery sends those same bytes; a transfer the chain
// proves dead returns the payout to pending with its signature kept; the
// last allowed attempt fails it and gives the earnings back exactly once; a
// landed transfer completes once however many runs see it; and no
// interleaving of runs, cancels and what the chain does produces two
// signatures that could both pay, or a payout both completed and restored.
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import {
  PAYING_WALLET_KEEP_LAMPORTS,
  PAYOUT_FEE_LAMPORTS,
  buildPayoutTransfer,
  makeSettleCreditsPayout,
  payingWalletCovers,
  readPayoutAddress,
  signPayoutTransfer,
  solPayoutAmount,
  usdcBaseUnitsForCents,
} from "../services/payoutExecutor.js";
import { buildCancelPayoutDeps, cancelPayout } from "../services/payoutRequests.js";
import { LEGACY_DEAD_AFTER_MS } from "../services/runPayoutExecutorTick.js";
import {
  STAND_IN_BLOCKHASH_LIFE,
  STAND_IN_MARGIN_BLOCKS,
  chainStandIn,
  payoutStandIn,
  seededRandom,
  standInPayout,
  standInSolPrice,
  standInWorker,
  type StandInPayout,
} from "./payoutStandIn.js";

const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const ORG = "org_creator";
/** Blocks after which a transfer made now is provably dead. */
const PAST_EXPIRY = STAND_IN_BLOCKHASH_LIFE + STAND_IN_MARGIN_BLOCKS + 1n;

// ============================================
// Credits
// ============================================

interface LedgerRow {
  type: string;
  amountCents: bigint;
  balanceAfter: bigint;
  referenceId: string;
  description: string;
}

function makeCreditsDb(startBalance: bigint, casCount: number) {
  const state = {
    balance: startBalance,
    ledger: [] as LedgerRow[],
    casWheres: [] as unknown[],
  };
  const tx = {
    creatorPayout: {
      updateMany: async (args: { where: unknown }) => {
        state.casWheres.push(args.where);
        return { count: casCount };
      },
    },
    creditBalance: {
      upsert: async (a: { update: { balanceCents: { increment: bigint } } }) => {
        state.balance += a.update.balanceCents.increment;
        return { balanceCents: state.balance };
      },
      update: async (a: { data: { balanceCents: { increment: bigint } } }) => {
        state.balance += a.data.balanceCents.increment;
        return { balanceCents: state.balance };
      },
    },
    creditTransaction: {
      create: async (a: { data: LedgerRow }) => {
        state.ledger.push(a.data);
        return {};
      },
    },
  };
  const db = { $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) };
  return { db, state };
}

test("credits payout: winning the compare-and-set grants once, as payout_credit, referenced to the payout", async () => {
  const { db, state } = makeCreditsDb(2_000n, 1);
  const settle = makeSettleCreditsPayout(db as never);
  const res = await settle({ payoutId: "payout_1", publisherId: "org_pub", amountCents: 4_500n });
  assert.deepEqual(res, { outcome: "completed", balanceAfterCents: 6_500n });
  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0]!.type, "payout_credit", "earned credits are not a purchase");
  assert.equal(state.ledger[0]!.referenceId, "payout_1");
  assert.equal(state.ledger[0]!.balanceAfter, 6_500n);
  assert.match(state.ledger[0]!.description, /Creator payout/);
  assert.equal((state.casWheres[0] as { status: string }).status, "processing");
});

test("credits payout: losing the compare-and-set grants nothing", async () => {
  const { db, state } = makeCreditsDb(2_000n, 0);
  const settle = makeSettleCreditsPayout(db as never);
  const res = await settle({ payoutId: "payout_1", publisherId: "org_pub", amountCents: 4_500n });
  assert.equal(res.outcome, "already_settled");
  assert.equal(state.balance, 2_000n, "balance untouched");
  assert.equal(state.ledger.length, 0);
});

// ============================================
// The amount
// ============================================

test("USDC is exact: cents times 10,000 base units", () => {
  assert.equal(usdcBaseUnitsForCents(5_000n), 50_000_000n);
  assert.equal(usdcBaseUnitsForCents(1n), 10_000n);
  assert.throws(() => usdcBaseUnitsForCents(0n));
  assert.throws(() => usdcBaseUnitsForCents(-5n));
});

test("a SOL amount comes from a quote, with the price it was worked out from", () => {
  const amount = solPayoutAmount(standInSolPrice(200), 5_000n, 0);
  assert.equal(amount.ok, true);
  if (!amount.ok) return;
  assert.equal(amount.lamports, 250_000_000n, "$50 at $200 is 0.25 SOL");
  assert.equal(amount.quote.priceMicroUsd, 200_000_000n);
  assert.equal(amount.quote.source, "static");
  assert.equal(amount.quote.publishTime.getTime(), 1_791_633_600_000);
});

test("a SOL amount leans against the payout: SOL valued high, lamports rounded down", () => {
  const price = standInSolPrice(200);
  if (!price.ok) throw new Error("stand-in price");
  price.quote.confMicroUsdPerSol = 1_000_000n; // $1 of uncertainty
  const amount = solPayoutAmount(price, 5_000n, 100); // and a 1% margin
  assert.equal(amount.ok, true);
  if (!amount.ok) return;
  // 50 / (201 * 1.01) SOL, rounded down.
  assert.equal(amount.lamports, (5_000n * 10_000n * 1_000_000_000n * 10_000n) / (201_000_000n * 10_100n));
  assert.ok(amount.lamports < 250_000_000n);
  assert.equal(amount.quote.priceMicroUsd, 203_010_000n);
});

test("no price is no amount: there is no fallback number", () => {
  for (const code of ["source_off", "stale", "rpc_unavailable"] as const) {
    const amount = solPayoutAmount({ ok: false, code }, 5_000n, 0);
    assert.equal(amount.ok, false);
    if (!amount.ok) assert.match(amount.detail, new RegExp(code));
  }
  // A price the amount cannot be worked out from is no amount either.
  const zero = standInSolPrice(200);
  if (!zero.ok) throw new Error("stand-in price");
  zero.quote.midMicroUsdPerSol = 0n;
  assert.equal(solPayoutAmount(zero, 5_000n, 0).ok, false);
  assert.equal(solPayoutAmount(standInSolPrice(200), 0n, 0).ok, false);
});

// ============================================
// The transfer
// ============================================

function freshBlockhash(): string {
  return Keypair.generate().publicKey.toBase58();
}

test("a SOL transfer carries exactly the lamports it was given", () => {
  const payer = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const tx = buildPayoutTransfer({
    method: "crypto_sol",
    payer,
    recipient,
    amountRaw: 250_000_000n,
    blockhash: freshBlockhash(),
    lastValidBlockHeight: 1_000,
  });
  assert.equal(tx.instructions.length, 1);
  // SystemProgram.transfer: [4-byte type=2][8-byte lamports LE].
  const ix = tx.instructions[0]!;
  assert.equal(ix.data.readBigUInt64LE(4), 250_000_000n);
  assert.ok(ix.keys.some((k) => k.pubkey.equals(recipient)));
});

test("a USDC transfer carries exactly the base units it was given, and opens the receiver's account if needed", () => {
  const tx = buildPayoutTransfer({
    method: "crypto_usdc",
    payer: Keypair.generate().publicKey,
    recipient: Keypair.generate().publicKey,
    amountRaw: usdcBaseUnitsForCents(5_000n),
    usdcMint: DEVNET_USDC,
    blockhash: freshBlockhash(),
    lastValidBlockHeight: 1_000,
  });
  // Instructions: [0] idempotent account create, [1] transferChecked.
  assert.equal(tx.instructions.length, 2);
  // transferChecked layout: [1-byte type=12][8-byte amount LE][1-byte decimals].
  const transfer = tx.instructions[1]!;
  assert.equal(transfer.data.readUInt8(0), 12);
  assert.equal(transfer.data.readBigUInt64LE(1), 50_000_000n);
  assert.equal(transfer.data.readUInt8(9), 6);
});

test("a transfer with no amount, or USDC with no mint, is refused", () => {
  const base = {
    payer: Keypair.generate().publicKey,
    recipient: Keypair.generate().publicKey,
    blockhash: freshBlockhash(),
    lastValidBlockHeight: 1_000,
  };
  assert.throws(() => buildPayoutTransfer({ ...base, method: "crypto_sol", amountRaw: 0n }));
  assert.throws(() => buildPayoutTransfer({ ...base, method: "crypto_usdc", amountRaw: 10_000n }), /usdcMint/);
});

test("signing sends nothing and gives the signature, the bytes and the height", () => {
  const wallet = Keypair.generate();
  const artifact = signPayoutTransfer(
    {
      method: "crypto_sol",
      payer: wallet.publicKey,
      recipient: Keypair.generate().publicKey,
      amountRaw: 1_000_000n,
      blockhash: freshBlockhash(),
      lastValidBlockHeight: 1_234,
    },
    wallet,
  );
  assert.equal(artifact.lastValidBlockHeight, 1_234n);
  assert.ok(artifact.txSignature.length > 80);
  assert.ok(Buffer.from(artifact.signedTxB64, "base64").length > 100);
  // A wallet that is not the payer cannot sign for it.
  assert.throws(() =>
    signPayoutTransfer(
      {
        method: "crypto_sol",
        payer: Keypair.generate().publicKey,
        recipient: Keypair.generate().publicKey,
        amountRaw: 1_000_000n,
        blockhash: freshBlockhash(),
        lastValidBlockHeight: 1_234,
      },
      wallet,
    ),
  );
});

// ============================================
// The address
// ============================================

test("a payout address is an ordinary wallet address or it is refused", () => {
  const wallet = Keypair.generate().publicKey;
  const read = readPayoutAddress(wallet.toBase58());
  assert.equal(read.ok, true);
  if (read.ok) assert.ok(read.recipient.equals(wallet));

  assert.deepEqual(readPayoutAddress(null), { ok: false, code: "missing_address" });
  assert.deepEqual(readPayoutAddress(undefined), { ok: false, code: "missing_address" });
  assert.deepEqual(readPayoutAddress("   "), { ok: false, code: "missing_address" });
  assert.deepEqual(readPayoutAddress("not-a-pubkey"), { ok: false, code: "invalid_address" });
  assert.deepEqual(readPayoutAddress("abc"), { ok: false, code: "invalid_address" }, "too short");
  // A program-derived address is off the curve: no key could ever move
  // what is sent to it.
  const [derived] = PublicKey.findProgramAddressSync([Buffer.from("payout-test")], DEVNET_USDC);
  assert.deepEqual(readPayoutAddress(derived.toBase58()), { ok: false, code: "invalid_address" });
});

// ============================================
// Does the paying wallet cover it
// ============================================

test("USDC: the wallet needs the USDC, and SOL for the fee, the receiver's rent and what it keeps", () => {
  const rent = 2_039_280n;
  const amount = 50_000_000n;
  const feeAndKeep = PAYOUT_FEE_LAMPORTS + PAYING_WALLET_KEEP_LAMPORTS;
  const funds = (over: Partial<Parameters<typeof payingWalletCovers>[2]> = {}) => ({
    solLamports: feeAndKeep,
    usdcBaseUnits: amount,
    recipientHasUsdcAccount: true,
    usdcAccountRentLamports: rent,
    ...over,
  });
  assert.equal(payingWalletCovers("crypto_usdc", amount, funds()).covered, true, "exactly enough");
  assert.equal(payingWalletCovers("crypto_usdc", amount, funds({ usdcBaseUnits: amount - 1n })).covered, false);
  assert.equal(payingWalletCovers("crypto_usdc", amount, funds({ solLamports: feeAndKeep - 1n })).covered, false);
  // The receiver has no USDC account yet: the rent to open one is needed too.
  assert.equal(payingWalletCovers("crypto_usdc", amount, funds({ recipientHasUsdcAccount: false })).covered, false);
  assert.equal(
    payingWalletCovers("crypto_usdc", amount, funds({ recipientHasUsdcAccount: false, solLamports: feeAndKeep + rent }))
      .covered,
    true,
  );
  assert.equal(payingWalletCovers("crypto_usdc", amount, funds({ solLamports: 0n, usdcBaseUnits: 0n })).covered, false);
});

test("SOL: the wallet needs the amount, the fee, and a little left", () => {
  const amount = 250_000_000n;
  const needed = amount + PAYOUT_FEE_LAMPORTS + PAYING_WALLET_KEEP_LAMPORTS;
  const funds = (solLamports: bigint) => ({
    solLamports,
    usdcBaseUnits: 0n,
    recipientHasUsdcAccount: false,
    usdcAccountRentLamports: 0n,
  });
  assert.equal(payingWalletCovers("crypto_sol", amount, funds(needed)).covered, true);
  assert.equal(payingWalletCovers("crypto_sol", amount, funds(needed - 1n)).covered, false);
  assert.equal(payingWalletCovers("crypto_sol", amount, funds(amount)).covered, false, "the amount alone is not enough");
  assert.equal(payingWalletCovers("crypto_sol", amount, funds(0n)).covered, false);
});

test("what transfers already out will take is not counted twice", () => {
  const feeAndKeep = PAYOUT_FEE_LAMPORTS + PAYING_WALLET_KEEP_LAMPORTS;
  const usdc = { solLamports: feeAndKeep + 5_000n, usdcBaseUnits: 80_000_000n, recipientHasUsdcAccount: true, usdcAccountRentLamports: 0n };
  // $50 is out and not yet on the chain's books: only $30 of the $80 is free.
  assert.equal(payingWalletCovers("crypto_usdc", 30_000_000n, usdc, { usdcBaseUnits: 50_000_000n, lamports: 5_000n }).covered, true);
  assert.equal(payingWalletCovers("crypto_usdc", 30_000_001n, usdc, { usdcBaseUnits: 50_000_000n, lamports: 5_000n }).covered, false);
  // The SOL held (fees, SOL being sent) comes off the SOL a USDC payout needs too.
  assert.equal(payingWalletCovers("crypto_usdc", 30_000_000n, usdc, { usdcBaseUnits: 0n, lamports: 5_001n }).covered, false);

  const sol = { solLamports: 300_000_000n + feeAndKeep, usdcBaseUnits: 0n, recipientHasUsdcAccount: false, usdcAccountRentLamports: 0n };
  assert.equal(payingWalletCovers("crypto_sol", 100_000_000n, sol, { usdcBaseUnits: 0n, lamports: 200_000_000n }).covered, true);
  assert.equal(payingWalletCovers("crypto_sol", 100_000_001n, sol, { usdcBaseUnits: 0n, lamports: 200_000_000n }).covered, false);
  // USDC that is held says nothing about SOL.
  assert.equal(payingWalletCovers("crypto_sol", 300_000_000n, sol, { usdcBaseUnits: 9n, lamports: 0n }).covered, true);
});

// ============================================
// The life of a wallet payout
// ============================================

function world(over: Partial<StandInPayout> = {}, opts: { maxAttempts?: number } = {}) {
  const wallet = Keypair.generate();
  const payout = standInPayout({
    publisherId: ORG,
    payoutMethod: "crypto_usdc",
    payoutAddress: Keypair.generate().publicKey.toBase58(),
    amountCents: 2_500n,
    ...over,
  });
  // The amount is reserved: it is in the payout, not in the earnings.
  const store = payoutStandIn({ payouts: [payout], earnings: { [ORG]: 0n } });
  const chain = chainStandIn({ payer: wallet.publicKey, usdcMint: DEVNET_USDC });
  const clock = { now: new Date("2026-10-10T12:00:00.000Z") };
  const worker = standInWorker({
    db: store.db,
    chain,
    payoutWallet: wallet,
    usdcMint: DEVNET_USDC,
    maxAttempts: opts.maxAttempts,
    now: () => clock.now,
  });
  return { wallet, store, chain, worker, clock, id: payout.id, row: () => store.payout(payout.id) };
}

test("a send that is refused leaves the payout processing, with its signed bytes stored", async () => {
  const w = world();
  w.chain.chain.send = "refused";

  const res = await w.worker.run();
  assert.equal(res.sent, 1);
  assert.equal(res.failed, 0);

  const row = w.row();
  assert.equal(row.status, "processing");
  assert.ok(row.txSignature, "the signature is stored");
  assert.ok(row.signedTxB64, "the signed bytes are stored");
  assert.equal(row.lastValidBlockHeight, 1_000n + STAND_IN_BLOCKHASH_LIFE);
  assert.equal(row.amountRaw, "25000000");
  assert.equal(row.attemptCount, 1);
  assert.ok(row.claimedAt);
  assert.equal(row.waitingReason, null);

  // Nothing is inferred from the error: not failed, nothing restored, and
  // the node's words are in the log only.
  assert.equal(row.failureCode, null);
  assert.equal(row.failureReason, null);
  assert.equal(w.store.restores(w.id).length, 0);
  assert.equal(w.store.state.earnings[ORG], 0n);
  const sendError = w.worker.events.find((e) => e.event === "send_error");
  assert.ok(sendError && /Attempt to debit/.test(sendError.detail));
  assert.doesNotMatch(JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? String(v) : v)), /Attempt to debit/);

  // What was handed to the node is what is stored.
  assert.equal(w.chain.chain.broadcasts.length, 1);
  assert.equal(w.chain.chain.broadcasts[0]!.signature, row.txSignature);
  assert.equal(w.chain.chain.broadcasts[0]!.bytesB64, row.signedTxB64);
});

test("the signature is stored BEFORE the send, by the same write that claims the payout", async () => {
  const w = world();
  const order: string[] = [];
  const deps = {
    ...w.worker.deps,
    claimWallet: async (...args: Parameters<typeof w.worker.deps.claimWallet>) => {
      const won = await w.worker.deps.claimWallet(...args);
      order.push(`claim:${w.row().status}:${w.row().txSignature === args[1].txSignature}`);
      return won;
    },
    broadcast: async (bytes: string) => {
      order.push(`broadcast:${w.row().signedTxB64 === bytes}`);
      await w.worker.deps.broadcast(bytes);
    },
  };
  const { runPayoutExecutorTick } = await import("../services/runPayoutExecutorTick.js");
  await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.deepEqual(order, ["claim:processing:true", "broadcast:true"]);
  // One write claimed it and stored everything.
  const claims = w.store.state.payoutWrites.filter((write) => (write.data as { status?: string }).status === "processing");
  assert.equal(claims.length, 1);
  assert.deepEqual(Object.keys(claims[0]!.data as object).sort(), [
    "amountRaw",
    "attemptCount",
    "claimedAt",
    "lastValidBlockHeight",
    "quotePriceMicroUsd",
    "quotePublishTime",
    "quoteSource",
    "signedTxB64",
    "status",
    "txSignature",
    "waitingReason",
  ]);
});

test("recovery sends the same bytes again, never a new transfer", async () => {
  const w = world();
  w.chain.chain.send = "throws_but_reached";

  await w.worker.run();
  const first = { ...w.row() };
  assert.equal(first.status, "processing");

  // Still able to land: the next runs send the stored bytes, unchanged.
  w.chain.chain.send = "accepted";
  const second = await w.worker.run();
  const third = await w.worker.run();
  assert.equal(second.resent, 1);
  assert.equal(third.resent, 1);

  const sends = w.chain.chain.broadcasts;
  assert.equal(sends.length, 3);
  assert.equal(sends[1]!.bytesB64, sends[0]!.bytesB64, "byte for byte the same transfer");
  assert.equal(sends[2]!.bytesB64, sends[0]!.bytesB64);
  assert.equal(sends[1]!.signature, first.txSignature);
  assert.equal(w.chain.chain.blockhashesIssued, 1, "nothing new was built or signed");
  assert.equal(w.chain.chain.transfers.size, 1, "one transfer exists for this payout");

  const row = w.row();
  assert.equal(row.status, "processing");
  assert.equal(row.txSignature, first.txSignature);
  assert.equal(row.signedTxB64, first.signedTxB64);
  assert.equal(row.attemptCount, 1);
});

test("a send error on the second sending changes nothing either", async () => {
  const w = world();
  await w.worker.run();
  w.chain.chain.send = "refused";
  const res = await w.worker.run();
  assert.equal(res.left, 1);
  assert.equal(res.resent, 0);
  assert.equal(w.row().status, "processing");
  assert.ok(w.worker.events.some((e) => e.event === "resend_error"));
  assert.equal(w.store.restores(w.id).length, 0);
});

test("a transfer that can no longer land returns the payout to pending, its signature kept in the list", async () => {
  const w = world();
  w.chain.chain.send = "refused";
  await w.worker.run();
  const dead = w.row().txSignature!;

  // Inside the window nothing is given up.
  w.chain.advance(STAND_IN_BLOCKHASH_LIFE + STAND_IN_MARGIN_BLOCKS);
  await w.worker.run();
  assert.equal(w.row().status, "processing", "expired, but not past the margin: not yet proven dead");

  w.chain.advance(1);
  const res = await w.worker.run();
  assert.equal(res.returned, 1);

  const row = w.row();
  assert.equal(row.status, "pending");
  assert.equal(row.txSignature, null);
  assert.equal(row.signedTxB64, null);
  assert.equal(row.lastValidBlockHeight, null);
  assert.equal(row.claimedAt, null);
  assert.equal(row.amountRaw, null);
  assert.deepEqual(row.expiredSignatures, [dead]);
  assert.equal(row.attemptCount, 1, "the attempt is still counted");
  assert.equal(row.failureCode, null);
  assert.equal(w.store.restores(w.id).length, 0, "still reserved: it will be tried again");

  // Pending again, so the creator can cancel it and keep the earnings.
  const cancel = await cancelPayout(buildCancelPayoutDeps(w.store.db), { payoutId: w.id, orgId: ORG });
  assert.equal(cancel.outcome, "cancelled");
  assert.equal(w.store.state.earnings[ORG], 2_500n);
});

test("after a dead transfer the next run makes a fresh one, and that one can complete", async () => {
  const w = world();
  w.chain.chain.send = "refused";
  await w.worker.run();
  const dead = w.row().txSignature!;
  w.chain.advance(PAST_EXPIRY);
  await w.worker.run(); // back to pending

  w.chain.chain.send = "accepted";
  await w.worker.run(); // a fresh attempt
  const fresh = w.row().txSignature!;
  assert.notEqual(fresh, dead);
  assert.equal(w.row().attemptCount, 2);
  assert.equal(w.chain.couldPay(dead), false, "the old one was dead before the new one existed");

  assert.equal(w.chain.land(fresh), true);
  const res = await w.worker.run();
  assert.equal(res.completed, 1);
  assert.equal(w.row().status, "completed");
  assert.deepEqual(w.row().expiredSignatures, [dead]);
  assert.deepEqual(w.chain.landedOk(), [fresh]);
  assert.equal(w.store.restores(w.id).length, 0);
});

test("the last allowed attempt fails the payout and gives the earnings back exactly once", async () => {
  const w = world({}, { maxAttempts: 2 });
  w.chain.chain.send = "refused";
  const signatures: string[] = [];

  await w.worker.run(); // attempt 1
  signatures.push(w.row().txSignature!);
  w.chain.advance(PAST_EXPIRY);
  await w.worker.run(); // dead: back to pending
  await w.worker.run(); // attempt 2
  signatures.push(w.row().txSignature!);
  assert.equal(w.row().attemptCount, 2);
  assert.equal(w.store.state.earnings[ORG], 0n, "still reserved while the last attempt is out");

  w.chain.advance(PAST_EXPIRY);
  const res = await w.worker.run(); // dead at the last attempt: failed
  assert.equal(res.failed, 1);

  const row = w.row();
  assert.equal(row.status, "failed");
  assert.equal(row.failureCode, "could_not_send");
  assert.match(row.failureReason ?? "", /can no longer land/);
  assert.equal(row.txSignature, null);
  assert.equal(row.signedTxB64, null, "a failed payout carries nothing that could be sent");
  assert.deepEqual(row.expiredSignatures, signatures);
  assert.equal(w.store.state.earnings[ORG], 2_500n);
  assert.equal(w.store.restores(w.id).length, 1);
  assert.equal(w.store.restores(w.id)[0]!.amountCents, 2_500n);
  assert.equal(w.store.restores(w.id)[0]!.description, "Payout failed, amount returned");

  // More runs, by this worker or another, do nothing more.
  for (let i = 0; i < 3; i++) {
    const again = await w.worker.run();
    assert.equal(again.claimable, 0);
  }
  assert.equal(w.store.state.earnings[ORG], 2_500n);
  assert.equal(w.store.restores(w.id).length, 1, "restored once");
  assert.equal(w.chain.chain.blockhashesIssued, 2, "two transfers were ever signed, the allowed number");
});

test("a transfer that failed on the chain is tried again, then given up with the chain's words kept for operators", async () => {
  const w = world({}, { maxAttempts: 2 });
  await w.worker.run();
  const first = w.row().txSignature!;
  assert.equal(w.chain.land(first, "failed"), true);
  const back = await w.worker.run();
  assert.equal(back.returned, 1);
  assert.equal(w.row().status, "pending");
  assert.deepEqual(w.row().expiredSignatures, [first]);

  await w.worker.run();
  const second = w.row().txSignature!;
  assert.equal(w.chain.land(second, "failed"), true);
  const res = await w.worker.run();
  assert.equal(res.failed, 1);
  const row = w.row();
  assert.equal(row.status, "failed");
  assert.equal(row.failureCode, "could_not_send", "the creator's sentence is chosen from this code");
  assert.match(row.failureReason ?? "", /InstructionError/, "the chain's own words, for operators");
  assert.equal(w.store.restores(w.id).length, 1);
  assert.equal(w.chain.landedOk().length, 0);
});

test("a landed transfer completes the payout once, however many runs see it", async () => {
  const w = world();
  await w.worker.run();
  const signature = w.row().txSignature!;
  assert.equal(w.chain.land(signature), true);

  const other = standInWorker({
    db: w.store.db,
    chain: w.chain,
    payoutWallet: w.wallet,
    usdcMint: DEVNET_USDC,
  });
  const results = await Promise.all([w.worker.run(), other.run(), w.worker.run(), other.run()]);
  await w.worker.run();
  await other.run();

  assert.equal(results.reduce((sum, r) => sum + r.completed, 0), 1, "one run completed it");
  const row = w.row();
  assert.equal(row.status, "completed");
  assert.equal(row.txSignature, signature);
  assert.ok(row.processedAt);
  const completions = w.store.state.payoutWrites.filter(
    (write) => (write.data as { status?: string }).status === "completed",
  );
  assert.equal(completions.length, 1);
  assert.equal(w.store.restores(w.id).length, 0);
  assert.equal(w.store.state.earnings[ORG], 0n);
  assert.equal(w.chain.chain.transfers.size, 1, "and nothing more was ever signed for it");
});

test("a transfer that landed although its send threw is completed, never sent again as a new one", async () => {
  const w = world();
  w.chain.chain.send = "throws_but_reached";
  await w.worker.run();
  const signature = w.row().txSignature!;
  assert.equal(w.chain.land(signature), true);
  // Long after: the blockhash is gone, and the chain still has the transfer.
  w.chain.advance(PAST_EXPIRY * 3n);
  const res = await w.worker.run();
  assert.equal(res.completed, 1);
  assert.equal(w.row().status, "completed");
  assert.equal(w.chain.chain.blockhashesIssued, 1);
  assert.equal(w.store.restores(w.id).length, 0);
});

test("while the chain cannot be read, a payout being sent is left exactly as it is", async () => {
  const w = world();
  await w.worker.run();
  const before = { ...w.row() };
  w.chain.chain.fateUnknown = true;
  w.chain.advance(PAST_EXPIRY * 2n);
  for (let i = 0; i < 3; i++) {
    const res = await w.worker.run();
    assert.equal(res.left, 1);
  }
  assert.deepEqual(w.row(), before, "silence proves nothing");
  assert.equal(w.chain.chain.broadcasts.length, 1);
});

test("a cancel that lands between the signing and the claim: nothing is sent", async () => {
  const w = world();
  const deps = {
    ...w.worker.deps,
    prepare: async (...args: Parameters<typeof w.worker.deps.prepare>) => {
      const artifact = await w.worker.deps.prepare(...args);
      const cancel = await cancelPayout(buildCancelPayoutDeps(w.store.db), { payoutId: w.id, orgId: ORG });
      assert.equal(cancel.outcome, "cancelled");
      return artifact;
    },
  };
  const { runPayoutExecutorTick } = await import("../services/runPayoutExecutorTick.js");
  const res = await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.equal(res.skipped, 1);
  assert.equal(res.sent, 0);
  assert.equal(w.chain.chain.broadcasts.length, 0, "the signed transfer was dropped unsent");
  assert.equal(w.row().status, "cancelled");
  assert.equal(w.row().txSignature, null);
  assert.equal(w.store.state.earnings[ORG], 2_500n);
  assert.equal(w.store.restores(w.id).length, 1);
});

test("two workers on one pending payout: one transfer is stored and sent", async () => {
  const w = world();
  const other = standInWorker({ db: w.store.db, chain: w.chain, payoutWallet: w.wallet, usdcMint: DEVNET_USDC });
  const [a, b] = await Promise.all([w.worker.run(), other.run()]);
  assert.equal(a.sent + b.sent, 1);
  assert.equal(w.row().attemptCount, 1);
  const stored = w.row().txSignature!;
  assert.ok(w.chain.chain.broadcasts.length >= 1);
  for (const send of w.chain.chain.broadcasts) {
    assert.equal(send.signature, stored, "only the stored transfer is ever broadcast");
  }
});

// ---- a payout from before the signed bytes were stored ----

test("a payout from before the height was stored: noted when first seen, given up only after 30 minutes absent", async () => {
  const w = world({ status: "processing", txSignature: "LegacySig1111", attemptCount: 0 });

  const first = await w.worker.run();
  assert.equal(first.left, 1);
  assert.equal(w.row().claimedAt?.getTime(), w.clock.now.getTime(), "first seen is noted");
  assert.equal(w.row().status, "processing");

  w.clock.now = new Date(w.clock.now.getTime() + LEGACY_DEAD_AFTER_MS - 1);
  await w.worker.run();
  assert.equal(w.row().status, "processing", "one millisecond short of the wait");
  assert.equal(w.chain.chain.broadcasts.length, 0, "there are no bytes to send again");

  w.clock.now = new Date(w.clock.now.getTime() + 1);
  const res = await w.worker.run();
  assert.equal(res.returned, 1);
  assert.equal(w.row().status, "pending");
  assert.deepEqual(w.row().expiredSignatures, ["LegacySig1111"]);
  assert.equal(w.row().txSignature, null);
  assert.equal(w.store.restores(w.id).length, 0);
});

test("a payout from before the height was stored completes when the chain has its transfer", async () => {
  const w = world({ status: "processing", txSignature: "LegacySig2222" });
  w.chain.chain.transfers.set("LegacySig2222", {
    signature: "LegacySig2222",
    bytesB64: "",
    lastValidBlockHeight: 0n,
    reached: true,
    landed: "ok",
  });
  // Even long after it was first seen: the chain's record decides.
  w.clock.now = new Date(w.clock.now.getTime() + LEGACY_DEAD_AFTER_MS * 10);
  const res = await w.worker.run();
  assert.equal(res.completed, 1);
  assert.equal(w.row().status, "completed");
  assert.equal(w.row().txSignature, "LegacySig2222");
});

test("a payout from before the height was stored is never given up on a read that failed", async () => {
  const w = world({
    status: "processing",
    txSignature: "LegacySig3333",
    claimedAt: new Date("2026-10-01T00:00:00.000Z"),
  });
  w.chain.chain.fateUnknown = true;
  const res = await w.worker.run();
  assert.equal(res.left, 1);
  assert.equal(w.row().status, "processing");
  assert.deepEqual(w.row().expiredSignatures, []);
});

// ============================================
// Any interleaving
// ============================================

const ORGS = ["org_a", "org_b"];
const START_CENTS = 10_000n;

interface Seen {
  completedToWallet: number;
  completedAsCredits: number;
  cancelled: number;
  failed: number;
  returnedToPending: number;
  signatures: number;
}

async function interleave(seed: number, rounds: number): Promise<{ violations: string[]; seen: Seen }> {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const pause = async () => {
    const gaps = Math.floor(random() * 3);
    for (let i = 0; i < gaps; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  const wallet = Keypair.generate();
  const addresses = ORGS.map(() => Keypair.generate().publicKey.toBase58());
  const violations: string[] = [];
  const stored = new Map<string, string[]>();
  const chain = chainStandIn({ payer: wallet.publicKey, usdcMint: DEVNET_USDC, pause });

  const store = payoutStandIn(
    { earnings: Object.fromEntries(ORGS.map((org) => [org, START_CENTS])) },
    {
      pause,
      onPayoutWrite: (before, after) => {
        if (after.txSignature && after.txSignature !== before.txSignature) {
          const earlier = stored.get(after.id) ?? [];
          for (const signature of earlier) {
            if (chain.couldPay(signature)) {
              violations.push(`${after.id}: ${after.txSignature} was stored while ${signature} could still pay`);
            }
          }
          if (before.status !== "pending") violations.push(`${after.id}: a signature was stored from ${before.status}`);
          stored.set(after.id, [...earlier, after.txSignature]);
        }
        const ended = after.status === "cancelled" || after.status === "failed";
        if (ended && before.status !== after.status) {
          for (const signature of stored.get(after.id) ?? []) {
            if (chain.couldPay(signature)) {
              violations.push(`${after.id}: ${after.status} while ${signature} could still pay`);
            }
          }
        }
        if (before.status === "processing" && after.status === "pending") {
          if (before.txSignature && chain.couldPay(before.txSignature)) {
            violations.push(`${after.id}: returned to pending while ${before.txSignature} could still pay`);
          }
        }
      },
    },
  );

  const clock = { now: new Date("2026-10-10T12:00:00.000Z") };
  const workers = [0, 1].map(() =>
    standInWorker({
      db: store.db,
      chain,
      payoutWallet: wallet,
      usdcMint: DEVNET_USDC,
      now: () => clock.now,
      platformMaxPerDayUsd: 1_000_000,
    }),
  );

  const open = () => store.state.payouts.filter((p) => p.status === "pending" || p.status === "processing");

  const actions: Array<() => Promise<void>> = [
    async () => void (await workers[0]!.run()),
    async () => void (await workers[1]!.run()),
    async () => void (await pick(workers).run()),
    async () => {
      const target = open().length ? pick(open()) : null;
      await pause();
      if (target) await cancelPayout(buildCancelPayoutDeps(store.db), { payoutId: target.id, orgId: target.publisherId });
    },
    async () => {
      const index = Math.floor(random() * ORGS.length);
      const amountCents = BigInt(500 + Math.floor(random() * 2_500));
      const payoutMethod = pick(["crypto_usdc", "crypto_usdc", "crypto_sol", "credits"]);
      try {
        await store.request({
          orgId: ORGS[index]!,
          payoutMethod,
          payoutAddress: payoutMethod === "credits" ? null : addresses[index]!,
          amountCents,
        });
      } catch {
        // One open payout per creator, or not enough left: refused, as it should be.
      }
    },
    async () => {
      await pause();
      chain.advance(Math.floor(random() * 120));
    },
    async () => {
      await pause();
      const landable = chain.landable();
      if (landable.length) chain.land(pick(landable), random() < 0.7 ? "ok" : "failed");
    },
    async () => {
      await pause();
      chain.chain.send = pick(["accepted", "accepted", "refused", "throws_but_reached"] as const);
    },
    async () => {
      await pause();
      const low = random() < 0.3;
      chain.chain.payerLamports = low ? 0n : 10_000_000_000n;
      chain.chain.payerUsdcBaseUnits = low ? 0n : 1_000_000_000_000n;
    },
    async () => {
      await pause();
      chain.chain.fateUnknown = random() < 0.25;
      chain.chain.readsFail = random() < 0.15;
    },
  ];

  const check = (when: string) => {
    for (const org of ORGS) {
      const held = store.state.payouts
        .filter((p) => p.publisherId === org && ["pending", "processing", "completed"].includes(p.status))
        .reduce((sum, p) => sum + p.amountCents, 0n);
      if ((store.state.earnings[org] ?? 0n) + held !== START_CENTS) {
        violations.push(`${when}: ${org} has ${store.state.earnings[org]} owed and ${held} in payouts, not ${START_CENTS}`);
      }
    }
    const everStored = new Set([...stored.values()].flat());
    for (const send of chain.chain.broadcasts) {
      if (!everStored.has(send.signature)) violations.push(`${when}: ${send.signature} was broadcast and never stored`);
    }
    for (const payout of store.state.payouts) {
      const restores = store.restores(payout.id).length;
      const ended = payout.status === "cancelled" || payout.status === "failed";
      if (restores !== (ended ? 1 : 0)) {
        violations.push(`${when}: ${payout.id} is ${payout.status} with ${restores} restores`);
      }
      const paid = (stored.get(payout.id) ?? []).filter((signature) => chain.landedOk().includes(signature));
      if (paid.length > 1) violations.push(`${when}: ${payout.id} was paid ${paid.length} times`);
      if (paid.length === 1 && restores > 0) violations.push(`${when}: ${payout.id} was paid and restored`);
      if (payout.status === "completed") {
        if (restores > 0) violations.push(`${when}: ${payout.id} is completed and restored`);
        if (payout.payoutMethod === "credits") {
          const grants = store.state.creditLedger.filter((row) => row.referenceId === payout.id);
          if (grants.length !== 1 || grants[0]!.type !== "payout_credit") {
            violations.push(`${when}: ${payout.id} completed with ${grants.length} credit grants`);
          }
        } else if (paid.length !== 1 || paid[0] !== payout.txSignature) {
          violations.push(`${when}: ${payout.id} is completed and its transfer did not land`);
        }
      }
    }
  };

  for (let round = 0; round < rounds; round++) {
    const together = 1 + Math.floor(random() * 3);
    await Promise.all(Array.from({ length: together }, () => pick(actions)()));
    clock.now = new Date(clock.now.getTime() + Math.floor(random() * 120_000));
    check(`seed ${seed} round ${round}`);
    if (violations.length) break;
  }

  // Then everything works again. Every payout that is still open must reach
  // an end: none is left stuck.
  chain.chain.send = "accepted";
  chain.chain.payerLamports = 10_000_000_000n;
  chain.chain.payerUsdcBaseUnits = 1_000_000_000_000n;
  chain.chain.fateUnknown = false;
  chain.chain.readsFail = false;
  for (let i = 0; i < 30 && open().length > 0 && violations.length === 0; i++) {
    await workers[0]!.run();
    for (const signature of chain.landable()) chain.land(signature);
    await workers[1]!.run();
    chain.advance(PAST_EXPIRY);
  }
  check(`seed ${seed} after the drain`);
  for (const payout of open()) violations.push(`seed ${seed}: ${payout.id} is still ${payout.status} after the drain`);

  const ended = (status: string) => store.state.payouts.filter((p) => p.status === status);
  return {
    violations,
    seen: {
      completedToWallet: ended("completed").filter((p) => p.payoutMethod !== "credits").length,
      completedAsCredits: ended("completed").filter((p) => p.payoutMethod === "credits").length,
      cancelled: ended("cancelled").length,
      failed: ended("failed").length,
      returnedToPending: store.state.payouts.reduce((sum, p) => sum + p.expiredSignatures.length, 0),
      signatures: [...stored.values()].flat().length,
    },
  };
}

test("no interleaving of runs, cancels and the chain pays twice, completes and restores, or leaves a payout stuck", async () => {
  const total: Seen = {
    completedToWallet: 0,
    completedAsCredits: 0,
    cancelled: 0,
    failed: 0,
    returnedToPending: 0,
    signatures: 0,
  };
  for (let seed = 1; seed <= 25; seed++) {
    const { violations, seen } = await interleave(seed, 60);
    assert.deepEqual(violations, [], `seed ${seed}`);
    for (const key of Object.keys(total) as Array<keyof Seen>) total[key] += seen[key];
  }
  // The runs went everywhere a payout can go, so the checks above had
  // something to check.
  for (const [what, count] of Object.entries(total)) {
    assert.ok(count > 0, `no run ever reached: ${what} (${JSON.stringify(total)})`);
  }
  assert.ok(total.signatures > total.completedToWallet, "some payouts needed more than one transfer");
});

test("the interleaving test can see a double payment: a worker that re-signs on a send error is caught", async () => {
  // The defect this batch removes, put back on purpose: a send error is
  // taken as "not sent", and the payout is returned to pending at once.
  const wallet = Keypair.generate();
  const payout = standInPayout({ publisherId: ORG, payoutAddress: Keypair.generate().publicKey.toBase58() });
  const chain = chainStandIn({ payer: wallet.publicKey, usdcMint: DEVNET_USDC });
  const caught: string[] = [];
  const store = payoutStandIn(
    { payouts: [payout], earnings: { [ORG]: 0n } },
    {
      onPayoutWrite: (before, after) => {
        if (before.status === "processing" && after.status === "pending" && before.txSignature) {
          if (chain.couldPay(before.txSignature)) caught.push(before.txSignature);
        }
      },
    },
  );
  const worker = standInWorker({ db: store.db, chain, payoutWallet: wallet, usdcMint: DEVNET_USDC });
  chain.chain.send = "throws_but_reached";
  const { runPayoutExecutorTick } = await import("../services/runPayoutExecutorTick.js");
  await runPayoutExecutorTick(
    { limit: 10 },
    {
      ...worker.deps,
      broadcast: async (bytes) => {
        try {
          await worker.deps.broadcast(bytes);
        } catch {
          await worker.deps.returnToPending(store.payout(payout.id) as never);
        }
      },
    },
  );
  assert.equal(caught.length, 1, "the check that guards the test above does fire");
});
