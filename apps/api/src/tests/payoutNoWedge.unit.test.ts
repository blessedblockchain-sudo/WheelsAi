// A payout can no longer get stuck. End to end, on stand-ins for the
// database and the chain (tests/payoutStandIn.ts): the paying wallet is
// empty, the creator's payout waits, the creator cancels it and keeps the
// earnings, and a new request goes through.
//
// Before this batch the same story ended differently: the transfer was
// signed and its signature stored, the send was refused because the wallet
// was empty, and from then on every run only looked that signature up. The
// payout stayed `processing` for ever, the earnings stayed reserved, the
// payout could not be cancelled, and (one open payout per creator) no new
// one could be requested.
//
// The request here is the stand-in's: ONE transaction that creates the row
// and reserves through the earnings ledger, with the one-open-payout index,
// as THE CONTRACT has it. The worker, the cancel and the ledger are the
// real code.
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import { buildCancelPayoutDeps, cancelPayout } from "../services/payoutRequests.js";
import {
  STAND_IN_BLOCKHASH_LIFE,
  STAND_IN_MARGIN_BLOCKS,
  chainStandIn,
  payoutStandIn,
  standInWorker,
} from "./payoutStandIn.js";

const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const ORG = "org_creator";
const EARNED = 4_120n;

function setup() {
  const wallet = Keypair.generate();
  const creatorWallet = Keypair.generate().publicKey.toBase58();
  const store = payoutStandIn({ earnings: { [ORG]: EARNED } });
  const chain = chainStandIn({ payer: wallet.publicKey, usdcMint: DEVNET_USDC });
  const worker = standInWorker({ db: store.db, chain, payoutWallet: wallet, usdcMint: DEVNET_USDC, maxAttempts: 3 });
  const cancel = (payoutId: string) => cancelPayout(buildCancelPayoutDeps(store.db), { payoutId, orgId: ORG });
  const empty = () => {
    chain.chain.payerLamports = 0n;
    chain.chain.payerUsdcBaseUnits = 0n;
  };
  const fill = () => {
    chain.chain.payerLamports = 10_000_000_000n;
    chain.chain.payerUsdcBaseUnits = 1_000_000_000_000n;
  };
  return { store, chain, worker, creatorWallet, cancel, empty, fill };
}

for (const payoutMethod of ["crypto_usdc", "crypto_sol"]) {
  test(`${payoutMethod}: empty wallet, then cancel, then a new request succeeds and is paid`, async () => {
    const s = setup();
    s.empty();

    // The creator asks for everything earned.
    const first = await s.store.request({ orgId: ORG, payoutMethod, payoutAddress: s.creatorWallet, amountCents: EARNED });
    assert.equal(s.store.state.earnings[ORG], 0n, "reserved");

    // The worker runs, and runs again. The wallet is empty: nothing is
    // signed, nothing is sent, and the payout stays pending with the reason.
    for (let i = 0; i < 5; i++) {
      const res = await s.worker.run();
      assert.equal(res.waiting, 1);
      assert.equal(res.sent, 0);
    }
    let row = s.store.payout(first.id);
    assert.equal(row.status, "pending", "not processing: it was never claimed");
    assert.equal(row.waitingReason, "wallet_low");
    assert.equal(row.txSignature, null);
    assert.equal(row.attemptCount, 0);
    assert.equal(s.chain.chain.broadcasts.length, 0);
    assert.equal(s.chain.chain.blockhashesIssued, 0);

    // While it is open a second request is refused, and reserves nothing.
    await assert.rejects(
      s.store.request({ orgId: ORG, payoutMethod: "credits", amountCents: 500n }),
      (err: { code?: string }) => err.code === "P2002",
    );
    assert.equal(s.store.state.payouts.length, 1);

    // The creator cancels and has the earnings back.
    const cancelled = await s.cancel(first.id);
    assert.equal(cancelled.outcome, "cancelled");
    assert.equal(s.store.state.earnings[ORG], EARNED);
    assert.equal(s.store.restores(first.id).length, 1);

    // The worker has nothing left to do with it.
    const idle = await s.worker.run();
    assert.equal(idle.claimable, 0);
    assert.equal(s.store.payout(first.id).status, "cancelled");

    // A new request goes through: nothing is in its way.
    const second = await s.store.request({ orgId: ORG, payoutMethod, payoutAddress: s.creatorWallet, amountCents: EARNED });
    assert.notEqual(second.id, first.id);
    assert.equal(s.store.state.earnings[ORG], 0n);

    // The wallet is filled by hand, and the next run sends it.
    s.fill();
    const sent = await s.worker.run();
    assert.equal(sent.sent, 1);
    row = s.store.payout(second.id);
    assert.equal(row.status, "processing");
    assert.equal(s.chain.land(row.txSignature!), true);
    const done = await s.worker.run();
    assert.equal(done.completed, 1);
    assert.equal(s.store.payout(second.id).status, "completed");

    // The money moved once, and the books say so.
    assert.deepEqual(s.chain.landedOk(), [row.txSignature]);
    assert.equal(s.store.state.earnings[ORG], 0n);
    assert.deepEqual(
      s.store.state.earningsLedger.map((entry) => [entry.type, entry.amountCents, entry.referenceId]),
      [
        ["payout_reserved", -EARNED, first.id],
        ["payout_restored", EARNED, first.id],
        ["payout_reserved", -EARNED, second.id],
      ],
    );
  });
}

test("empty wallet, then filled: the same payout is sent with no one doing anything", async () => {
  const s = setup();
  s.empty();
  const payout = await s.store.request({
    orgId: ORG,
    payoutMethod: "crypto_usdc",
    payoutAddress: s.creatorWallet,
    amountCents: EARNED,
  });
  await s.worker.run();
  assert.equal(s.store.payout(payout.id).waitingReason, "wallet_low");

  s.fill();
  await s.worker.run();
  const row = s.store.payout(payout.id);
  assert.equal(row.status, "processing");
  assert.equal(row.waitingReason, null);
  assert.equal(s.chain.land(row.txSignature!), true);
  await s.worker.run();
  assert.equal(s.store.payout(payout.id).status, "completed");
  assert.equal(s.store.restores(payout.id).length, 0);
});

test("the old wedge itself: the wallet empties after the checks, the send is refused, and the payout still comes back", async () => {
  // The funds check passed and the transfer was signed and claimed; then the
  // node refuses the send. This is the state that used to last for ever.
  const s = setup();
  const payout = await s.store.request({
    orgId: ORG,
    payoutMethod: "crypto_usdc",
    payoutAddress: s.creatorWallet,
    amountCents: EARNED,
  });
  s.chain.chain.send = "refused";
  await s.worker.run();
  let row = s.store.payout(payout.id);
  assert.equal(row.status, "processing");
  const refused = row.txSignature!;
  s.empty();

  // Being sent, it cannot be cancelled: the transfer might still land.
  assert.deepEqual(await s.cancel(payout.id), { outcome: "not_cancellable", status: "processing" });
  assert.equal(s.store.state.earnings[ORG], 0n);

  // Runs inside the transfer's life change nothing.
  await s.worker.run();
  assert.equal(s.store.payout(payout.id).status, "processing");

  // Once the chain proves that transfer can never land, the payout is
  // pending again. The wallet is still empty, so it waits: cancellable.
  s.chain.advance(STAND_IN_BLOCKHASH_LIFE + STAND_IN_MARGIN_BLOCKS + 1n);
  const back = await s.worker.run();
  assert.equal(back.returned, 1);
  const waiting = await s.worker.run();
  assert.equal(waiting.waiting, 1);
  row = s.store.payout(payout.id);
  assert.equal(row.status, "pending");
  assert.equal(row.waitingReason, "wallet_low");
  assert.deepEqual(row.expiredSignatures, [refused]);

  const cancelled = await s.cancel(payout.id);
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(s.store.state.earnings[ORG], EARNED);

  // And a new request, this time as credits, is paid at once.
  const credits = await s.store.request({ orgId: ORG, payoutMethod: "credits", amountCents: EARNED });
  const res = await s.worker.run();
  assert.equal(res.completed, 1);
  assert.equal(s.store.payout(credits.id).status, "completed");
  assert.equal(s.store.state.credits[ORG], EARNED);
  assert.equal(s.store.state.creditLedger[0]!.type, "payout_credit");
  assert.equal(s.store.state.earnings[ORG], 0n);
  assert.equal(s.chain.landedOk().length, 0, "nothing was ever paid to the wallet");
});

test("left alone with a node that refuses every send, a payout ends by itself with the earnings back", async () => {
  const s = setup();
  const payout = await s.store.request({
    orgId: ORG,
    payoutMethod: "crypto_usdc",
    payoutAddress: s.creatorWallet,
    amountCents: EARNED,
  });
  s.chain.chain.send = "refused";

  let runs = 0;
  while (["pending", "processing"].includes(s.store.payout(payout.id).status)) {
    await s.worker.run();
    s.chain.advance(STAND_IN_BLOCKHASH_LIFE + STAND_IN_MARGIN_BLOCKS + 1n);
    runs += 1;
    assert.ok(runs < 20, "the payout must reach an end");
  }
  const row = s.store.payout(payout.id);
  assert.equal(row.status, "failed");
  assert.equal(row.failureCode, "could_not_send");
  assert.equal(row.attemptCount, 3);
  assert.equal(row.expiredSignatures.length, 3);
  assert.equal(s.store.state.earnings[ORG], EARNED);
  assert.equal(s.store.restores(payout.id).length, 1);

  // And the creator can ask again.
  const again = await s.store.request({ orgId: ORG, payoutMethod: "credits", amountCents: EARNED });
  await s.worker.run();
  assert.equal(s.store.payout(again.id).status, "completed");
});
