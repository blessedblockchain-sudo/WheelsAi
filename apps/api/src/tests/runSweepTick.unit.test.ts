/**
 * Drives apps/api/src/services/runSweepTick.ts through its real binding
 * (services/buildSweepTickDeps.ts) and the real plan
 * (services/sweepPlan.ts), against an in-memory database and a node that
 * answers from maps. No database, no network.
 *
 * Pinning:
 *   - nothing runs while sweeps are off, the interval is 0 or the cluster
 *     check fails;
 *   - every "sent" row is settled from the chain before anything is
 *     planned, each fate ends or keeps the row as the house rule says, and
 *     in_flight sends the stored bytes unchanged;
 *   - the row is written before the broadcast; a P2002 sends nothing; a
 *     send error changes nothing;
 *   - a dead transfer's money is planned again by a later run, with a new
 *     signature;
 *   - a stored address that is not the derived one is never touched;
 *   - with no proven treasury only sweeps to the hot wallet happen;
 *   - one address that throws does not stop the others.
 */

import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { Transaction } from "@solana/web3.js";

import { SWEEP_READ_CHUNK, sweepsEnabled } from "../services/runSweepTick.js";
import { NO_TREASURY_ADDRESS } from "../services/sweepPlan.js";
import {
  DEVNET,
  FEE,
  HOT,
  KEEP,
  NOW,
  ORG_1,
  ORG_2,
  ORG_3,
  SOL,
  TREASURY,
  USDC,
  addressRow,
  depositAddressOf,
  fateAnswer,
  keypairOf,
  setupSweep,
  transferRow,
  treasuryRow,
  usdcAccountOf,
} from "./sweepStandIn.js";

const A1 = depositAddressOf(ORG_1);
const A2 = depositAddressOf(ORG_2);
const A3 = depositAddressOf(ORG_3);

const sentRows = (w: ReturnType<typeof setupSweep>) => w.state.transfers.filter((r) => r.status === "sent");

// ============================================
// Off
// ============================================

test("the worker is on only with sweeps on and an interval", () => {
  assert.equal(sweepsEnabled({ sweepsEnabled: true, intervalMs: 300_000 }), true);
  assert.equal(sweepsEnabled({ sweepsEnabled: false, intervalMs: 300_000 }), false);
  assert.equal(sweepsEnabled({ sweepsEnabled: true, intervalMs: 0 }), false);
  assert.equal(sweepsEnabled({ sweepsEnabled: true, intervalMs: Number.NaN }), false);
  assert.equal(SWEEP_READ_CHUNK, 50);
});

test("nothing runs while sweeps are off or the interval is 0: no read, no write, no send", async () => {
  for (const over of [{ enabled: false }, { intervalMs: 0 }]) {
    const w = setupSweep({
      addresses: [addressRow(ORG_1, 500n * USDC, 5n * SOL)],
      transfers: [transferRow({ fromAddress: A2 })],
      wallets: [treasuryRow()],
    });
    w.fates.set("sig_1", fateAnswer("sig_1", "landed_ok"));
    const res = await w.run(over);
    assert.equal(res.ran, false);
    assert.equal(res.reason, "disabled");
    assert.equal(res.planned, 0);
    assert.equal(w.knobs.clusterChecks, 0);
    assert.equal(w.calls.length, 0, "the database is not read");
    assert.deepEqual(w.order, [], "the node is not asked, nothing is sent");
    assert.equal(w.state.transfers[0]!.status, "sent");
  }
});

test("a transfer that reached the chain ends its row only once it is finalized, and its money is not signed for again meanwhile", async () => {
  // The address still shows, at "finalized", what the scan last accounted
  // for: the sweep landed a moment ago and its block is not final.
  const w = setupSweep({
    addresses: [addressRow(ORG_1, 500n * USDC, 0n)],
    transfers: [transferRow({ id: "ct-new", txSignature: "sig_new", fromAddress: A1, asset: "USDC", amountRaw: 500n * USDC })],
  });
  for (const [fate, error] of [["landed_ok", undefined], ["landed_failed", '{"InstructionError":[0,"Custom"]}']] as const) {
    w.fates.set("sig_new", fateAnswer("sig_new", fate, error, "confirmed"));
    const early = await w.run();
    assert.deepEqual(early.settled, { landed: 0, failed: 0, dead: 0 }, fate);
    assert.equal(early.left, 1, fate);
    assert.equal(early.resent, 0, "what reached the chain is not sent again");
    assert.equal(early.planned, 0, "the same money is not planned while its row is out");
    assert.equal(early.sent, 0);
    assert.equal(w.state.transfers.length, 1);
    assert.equal(w.state.transfers[0]!.status, "sent");
  }

  w.fates.set("sig_new", fateAnswer("sig_new", "landed_ok"));
  const final = await w.run();
  assert.deepEqual(final.settled, { landed: 1, failed: 0, dead: 0 });
  assert.equal(w.state.transfers[0]!.status, "landed");
});

test("nothing runs while the cluster check fails, not even the settling of sent rows", async () => {
  const w = setupSweep({
    addresses: [addressRow(ORG_1, 500n * USDC, 5n * SOL)],
    transfers: [transferRow({ fromAddress: A2 })],
    wallets: [treasuryRow()],
  });
  // On the wrong chain this signature would look as if it could never
  // land. It is not even asked about.
  w.fates.set("sig_1", fateAnswer("sig_1", "dead"));
  w.knobs.clusterOk = false;
  const res = await w.run();
  assert.equal(res.ran, false);
  assert.equal(res.reason, "chain_unavailable");
  assert.equal(w.knobs.clusterChecks, 1);
  assert.equal(w.calls.length, 0);
  assert.deepEqual(w.order, []);
  assert.equal(w.state.transfers[0]!.status, "sent");

  // A check that throws is a check that failed.
  const thrown = setupSweep({ addresses: [addressRow(ORG_1, 500n * USDC)] });
  thrown.deps.checkCluster = async () => {
    throw new Error("node is away");
  };
  const res2 = await thrown.run();
  assert.equal(res2.reason, "chain_unavailable");
  assert.deepEqual(thrown.order, []);
});

// ============================================
// Claim first
// ============================================

test("the row is written as sent, with everything the contract names, before the broadcast", async () => {
  const w = setupSweep({ addresses: [addressRow(ORG_1, 60n * USDC)], wallets: [treasuryRow()] });
  const res = await w.run();
  assert.deepEqual(
    { planned: res.planned, sent: res.sent, skipped: res.skipped, errors: res.errors },
    { planned: 1, sent: 1, skipped: 0, errors: 0 },
  );
  assert.equal(w.state.transfers.length, 1);
  const row = w.state.transfers[0]!;
  const tx = Transaction.from(Buffer.from(row.signedTxB64, "base64"));
  assert.deepEqual(
    { ...row, id: undefined, createdAt: undefined },
    {
      id: undefined,
      createdAt: undefined,
      failureReason: null,
      settledAt: null,
      kind: "sweep_to_hot",
      network: DEVNET,
      asset: "USDC",
      fromAddress: A1,
      toAddress: HOT,
      orgId: ORG_1,
      amountRaw: 60n * USDC,
      feeLamports: 10_000n,
      feePayer: HOT,
      status: "sent",
      txSignature: row.txSignature,
      signedTxB64: row.signedTxB64,
      lastValidBlockHeight: 5_001n,
    },
  );
  assert.equal(tx.verifySignatures(), true);
  // Reads, then the row, then the send: never a send before its row.
  assert.deepEqual(w.order.filter((step) => step !== "read" && step !== "payouts"), [`row:${row.txSignature}`, "send"]);
  assert.ok(w.order.indexOf(`row:${row.txSignature}`) < w.order.indexOf("send"));
  // What was sent is exactly the bytes on the row.
  assert.deepEqual(w.chain.calls.sendRawTransaction.map((c) => c.b64), [row.signedTxB64]);
  assert.deepEqual(w.chain.calls.sendRawTransaction[0]!.options, { skipPreflight: false, maxRetries: 3 });
});

test("a P2002 on the insert means another worker has that money: nothing is sent", async () => {
  const w = setupSweep({
    addresses: [addressRow(ORG_1, 60n * USDC)],
    // Another worker wrote this a moment after this run read the sent rows.
    transfers: [transferRow({ id: "ct-theirs", txSignature: "sig_theirs" })],
  });
  w.raw.chainTransfer.findMany = async () => [];
  const res = await w.run();
  assert.equal(res.planned, 1);
  assert.equal(res.sent, 0);
  assert.equal(res.skipped, 1);
  assert.equal(res.errors, 0);
  assert.equal(w.chain.calls.sendRawTransaction.length, 0);
  assert.equal(w.state.transfers.length, 1, "no second row");
  assert.deepEqual(w.events.filter((e) => e.event === "claim_lost").length, 1);
});

test("a database error that is not P2002 on the insert sends nothing and is an error", async () => {
  const w = setupSweep({ addresses: [addressRow(ORG_1, 60n * USDC)] });
  w.raw.chainTransfer.create = async () => {
    throw new Error("database is away");
  };
  const res = await w.run();
  assert.equal(res.sent, 0);
  assert.equal(res.skipped, 0);
  assert.equal(res.errors, 1);
  assert.equal(w.chain.calls.sendRawTransaction.length, 0);
});

test("a send error changes nothing: the row stays sent with its bytes, and the next run asks the chain", async () => {
  const w = setupSweep({ addresses: [addressRow(ORG_1, 60n * USDC)] });
  w.chain.failing.send = new Error("node said: blockhash not found");
  const res = await w.run();
  assert.equal(res.sent, 1);
  assert.equal(res.errors, 0);
  const row = w.state.transfers[0]!;
  assert.equal(row.status, "sent");
  assert.equal(row.settledAt, null);
  assert.equal(w.events.filter((e) => e.event === "send_error").length, 1);

  // The next run: the chain says it may still land, so the SAME bytes go
  // again, and no new signature is made for that money.
  w.chain.failing.send = null;
  w.fates.set(row.txSignature, fateAnswer(row.txSignature, "in_flight"));
  const again = await w.run();
  assert.equal(again.resent, 1);
  assert.equal(again.planned, 0);
  assert.equal(w.state.transfers.length, 1);
  assert.equal(w.chain.calls.sendRawTransaction.at(-1)!.b64, row.signedTxB64);
  assert.equal(w.chain.calls.getLatestBlockhash.length, 1, "nothing new was signed");
});

// ============================================
// Only the chain ends a row
// ============================================

test("every sent row is settled from the chain first, each fate as the house rule says", async () => {
  const w = setupSweep({
    addresses: [addressRow(ORG_3, 60n * USDC)],
    transfers: [
      transferRow({ id: "ct-landed", txSignature: "sig_landed", fromAddress: keypairOf("a").publicKey.toBase58(), lastValidBlockHeight: 111n }),
      transferRow({ id: "ct-failed", txSignature: "sig_failed", fromAddress: keypairOf("b").publicKey.toBase58() }),
      transferRow({ id: "ct-dead", txSignature: "sig_dead", fromAddress: keypairOf("c").publicKey.toBase58() }),
      transferRow({ id: "ct-flying", txSignature: "sig_flying", fromAddress: keypairOf("d").publicKey.toBase58(), signedTxB64: "Zmx5aW5nIGJ5dGVz" }),
      transferRow({ id: "ct-unknown", txSignature: "sig_unknown", fromAddress: keypairOf("e").publicKey.toBase58() }),
      // Not this chain's, and not sent: neither is asked about.
      transferRow({ id: "ct-mainnet", txSignature: "sig_mainnet", network: "solana:mainnet", fromAddress: keypairOf("f").publicKey.toBase58() }),
      transferRow({ id: "ct-old", txSignature: "sig_old", status: "landed", fromAddress: keypairOf("g").publicKey.toBase58() }),
    ],
  });
  w.fates.set("sig_landed", fateAnswer("sig_landed", "landed_ok"));
  w.fates.set("sig_failed", fateAnswer("sig_failed", "landed_failed", '{"InstructionError":[1,"Custom"]}'));
  w.fates.set("sig_dead", fateAnswer("sig_dead", "dead"));
  w.fates.set("sig_flying", fateAnswer("sig_flying", "in_flight"));
  w.fates.set("sig_unknown", fateAnswer("sig_unknown", "unknown", "node is away"));

  const res = await w.run();
  assert.deepEqual(res.settled, { landed: 1, failed: 1, dead: 1 });
  assert.equal(res.resent, 1);
  assert.equal(res.left, 1);
  assert.equal(res.errors, 0);

  const by = (id: string) => w.state.transfers.find((r) => r.id === id)!;
  assert.deepEqual([by("ct-landed").status, by("ct-landed").settledAt, by("ct-landed").failureReason], ["landed", NOW, null]);
  assert.equal(by("ct-failed").status, "failed");
  assert.equal(by("ct-failed").settledAt, NOW);
  assert.match(by("ct-failed").failureReason, /failed on the chain: \{"InstructionError":\[1,"Custom"\]\}/);
  assert.equal(by("ct-dead").status, "dead");
  assert.match(by("ct-dead").failureReason, /can no longer land/);
  for (const id of ["ct-flying", "ct-unknown", "ct-mainnet"]) {
    assert.equal(by(id).status, "sent", id);
    assert.equal(by(id).settledAt, null, id);
  }
  assert.equal(by("ct-old").status, "landed");

  // The chain was asked about each sent row of this chain, with its height.
  assert.deepEqual(
    w.fateCalls.map((c) => c.signature),
    ["sig_landed", "sig_failed", "sig_dead", "sig_flying", "sig_unknown"],
  );
  assert.equal(w.fateCalls[0]!.lastValidBlockHeight, 111n);

  // in_flight: the stored bytes, unchanged. Nothing else of the old rows is sent.
  assert.equal(w.chain.calls.sendRawTransaction[0]!.b64, "Zmx5aW5nIGJ5dGVz");

  // Settling comes before any read for the plan, and before any new row.
  const firstRead = w.order.indexOf("read");
  const lastFate = w.order.lastIndexOf("fate:sig_unknown");
  assert.ok(lastFate < firstRead, "every sent row is settled before the plan's reads");
  assert.equal(res.planned, 1);
  assert.equal(res.sent, 1);
});

test("ending a row is a compare-and-set: one another worker already ended is not counted, and not ended twice", async () => {
  const w = setupSweep({ transfers: [transferRow()] });
  w.fates.set("sig_1", fateAnswer("sig_1", "landed_ok"));
  const real = w.raw.chainTransfer.updateMany;
  w.raw.chainTransfer.updateMany = async (args) => {
    // The other worker gets there first.
    w.state.transfers[0]!.status = "dead";
    return real(args);
  };
  const res = await w.run();
  assert.deepEqual(res.settled, { landed: 0, failed: 0, dead: 0 });
  assert.equal(w.state.transfers[0]!.status, "dead");
  assert.deepEqual(w.calls.find((c) => c.op === "chainTransfer.updateMany")!.args.where, {
    id: "ct-1",
    status: "sent",
    txSignature: "sig_1",
  });
});

test("a resend that throws leaves the row sent; a row that throws does not stop the others", async () => {
  const w = setupSweep({
    transfers: [
      transferRow({ id: "ct-a", txSignature: "sig_a", fromAddress: keypairOf("a").publicKey.toBase58() }),
      transferRow({ id: "ct-b", txSignature: "sig_b", fromAddress: keypairOf("b").publicKey.toBase58() }),
      transferRow({ id: "ct-c", txSignature: "sig_c", fromAddress: keypairOf("c").publicKey.toBase58() }),
    ],
  });
  w.fates.set("sig_a", fateAnswer("sig_a", "in_flight"));
  w.fates.set("sig_b", fateAnswer("sig_b", "landed_ok"));
  w.fates.set("sig_c", fateAnswer("sig_c", "landed_ok"));
  w.chain.failing.send = new Error("node is away");
  const real = w.raw.chainTransfer.updateMany;
  w.raw.chainTransfer.updateMany = async (args) => {
    if (args.where.id === "ct-b") throw new Error("database hiccup");
    return real(args);
  };
  const res = await w.run();
  assert.equal(res.left, 1);
  assert.equal(res.resent, 0);
  assert.equal(res.errors, 1);
  assert.deepEqual(res.settled, { landed: 1, failed: 0, dead: 0 });
  assert.deepEqual(w.state.transfers.map((r) => r.status), ["sent", "sent", "landed"]);
});

test("when the sent rows cannot be read nothing new is signed", async () => {
  const w = setupSweep({ addresses: [addressRow(ORG_1, 60n * USDC)] });
  w.raw.chainTransfer.findMany = async () => {
    throw new Error("database is away");
  };
  const res = await w.run();
  assert.equal(res.ran, true);
  assert.equal(res.errors, 1);
  assert.equal(res.planned, 0);
  assert.deepEqual(w.order, []);
});

// ============================================
// A dead transfer's money
// ============================================

test("a dead transfer's money is planned again by a later run, with a new signature; a landed one's is not", async () => {
  const w = setupSweep({
    addresses: [addressRow(ORG_1, 60n * USDC), addressRow(ORG_2, 0n, 2n * SOL)],
    wallets: [treasuryRow()],
  });
  const first = await w.run();
  assert.equal(first.sent, 2);
  const [solRow, usdcRow] = [
    w.state.transfers.find((r) => r.asset === "SOL")!,
    w.state.transfers.find((r) => r.asset === "USDC")!,
  ];

  // The USDC transfer can never land; the SOL one landed and the scan has
  // since accounted for what it left.
  w.fates.set(usdcRow.txSignature, fateAnswer(usdcRow.txSignature, "dead"));
  w.fates.set(solRow.txSignature, fateAnswer(solRow.txSignature, "landed_ok"));
  w.chain.setBalance(A2, KEEP, null);
  w.state.addresses.find((r) => r.orgId === ORG_2)!.lastSeenLamports = KEEP;

  // The run that sees it die does not sign for it again in the same run.
  const second = await w.run();
  assert.deepEqual(second.settled, { landed: 1, failed: 0, dead: 1 });
  assert.equal(second.planned, 0);
  assert.equal(w.state.transfers.length, 2);

  // A later run does: the money is still there, read and accounted for.
  const third = await w.run();
  assert.equal(third.planned, 1);
  assert.equal(third.sent, 1);
  assert.equal(w.state.transfers.length, 3);
  const fresh = w.state.transfers[2]!;
  assert.equal(fresh.asset, "USDC");
  assert.equal(fresh.fromAddress, A1);
  assert.equal(fresh.amountRaw, 60n * USDC);
  assert.equal(fresh.status, "sent");
  assert.notEqual(fresh.txSignature, usdcRow.txSignature);
  assert.notEqual(fresh.signedTxB64, usdcRow.signedTxB64);
  assert.equal(usdcRow.status, "dead");
});

test("while a transfer is sent its money is not signed for again, run after run", async () => {
  const w = setupSweep({ addresses: [addressRow(ORG_1, 60n * USDC)] });
  await w.run();
  const row = w.state.transfers[0]!;
  w.fates.set(row.txSignature, fateAnswer(row.txSignature, "unknown", "node is away"));
  for (let i = 0; i < 3; i += 1) {
    const res = await w.run();
    assert.equal(res.planned, 0);
    assert.equal(res.left, 1);
  }
  assert.equal(w.state.transfers.length, 1);
  assert.equal(w.chain.calls.getLatestBlockhash.length, 1);
  assert.equal(w.chain.calls.sendRawTransaction.length, 1);
});

// ============================================
// Only what this server derives, only what has been read
// ============================================

test("a stored address that is not the derived one is never touched", async () => {
  const stranger = keypairOf("not-derived").publicKey.toBase58();
  const w = setupSweep({
    addresses: [
      addressRow(ORG_1, 900n * USDC, 9n * SOL, { address: stranger }),
      addressRow(ORG_2, 60n * USDC),
      // Another chain's row: the database is not even asked for it.
      addressRow(ORG_3, 900n * USDC, 9n * SOL, { network: "solana:mainnet" }),
    ],
  });
  const res = await w.run();
  assert.equal(res.errors, 1, "the wrong address is an error for an operator");
  assert.equal(res.addressesRead, 1);
  assert.equal(res.planned, 1);
  assert.deepEqual(w.state.transfers.map((r) => r.fromAddress), [A2]);
  const asked = w.chain.calls.getMultipleAccountsInfo.flatMap((c) => c.keys);
  assert.ok(!asked.includes(stranger), "it is not read");
  assert.ok(!asked.includes(A3));
  assert.match(String((w.errors()[0] as { detail: string }).detail), /not the one this server derives/);
});

test("a row of another chain is never touched, even when the database answers it", async () => {
  const w = setupSweep({
    addresses: [
      addressRow(ORG_2, 60n * USDC),
      addressRow(ORG_3, 900n * USDC, 9n * SOL, { network: "solana:mainnet" }),
    ],
  });
  // A database that ignores the chain in the question.
  w.raw.depositAddress.findMany = async () => w.state.addresses.map((r) => ({ ...r })) as never;
  const res = await w.run();
  assert.equal(res.addressesRead, 1);
  assert.equal(res.planned, 1);
  assert.deepEqual(w.state.transfers.map((r) => r.fromAddress), [A2]);
  const asked = w.chain.calls.getMultipleAccountsInfo.flatMap((c) => c.keys);
  assert.ok(!asked.includes(A3), "it is not read");
});

test("an address whose key cannot be derived is skipped, and the others still move", async () => {
  const w = setupSweep({ addresses: [addressRow(ORG_1, 90n * USDC), addressRow(ORG_2, 60n * USDC)] });
  w.knobs.deriveKeypair = (orgId) => {
    if (orgId === ORG_1) throw new Error("WALLET_MASTER_KEY required (empty or missing)");
    return keypairOf(`deposit:${orgId}`);
  };
  const res = await w.run();
  assert.equal(res.errors, 1);
  assert.deepEqual(w.state.transfers.map((r) => r.orgId), [ORG_2]);
});

test("a balance the scan has not accounted for is never moved; once it is, it moves", async () => {
  const w = setupSweep({ addresses: [addressRow(ORG_1, 60n * USDC, 2n * SOL)], wallets: [treasuryRow()] });
  // More arrived than the scan has seen, of both assets.
  w.chain.setBalance(A1, 3n * SOL, 100n * USDC);
  const res = await w.run();
  assert.equal(res.planned, 0);
  assert.equal(res.held, 2);
  assert.equal(w.state.transfers.length, 0);
  assert.equal(w.chain.calls.sendRawTransaction.length, 0);

  const row = w.state.addresses[0]!;
  row.lastSeenUsdcRaw = 100n * USDC;
  row.lastSeenLamports = 3n * SOL;
  const later = await w.run();
  assert.equal(later.sent, 2);
  assert.deepEqual(
    w.state.transfers.map((r) => [r.asset, r.amountRaw]).sort(),
    [
      ["SOL", 3n * SOL - KEEP - FEE],
      ["USDC", 100n * USDC],
    ],
  );
});

test("deposit addresses are read at finalized, 50 and their USDC accounts a call", async () => {
  const orgs = Array.from({ length: 120 }, (_, i) => `org-${String(i).padStart(3, "0")}`);
  const w = setupSweep({ addresses: orgs.map((org) => addressRow(org, 1n * USDC)) });
  const res = await w.run();
  assert.equal(res.addressesRead, 120);
  assert.equal(res.planned, 0, "a dollar each is under the threshold");
  const reads = w.chain.calls.getMultipleAccountsInfo.filter((c) => c.commitment === "finalized");
  // The hot wallet with its USDC account first, then the addresses.
  assert.deepEqual(reads.map((c) => c.keys.length), [2, 100, 100, 40]);
  assert.deepEqual(reads[0]!.keys, [HOT, usdcAccountOf(HOT)]);
  assert.equal(reads[1]!.keys[50], usdcAccountOf(reads[1]!.keys[0]!));
  // The only read at another level is the hot wallet's, at confirmed: it is
  // taken to hold the lower of the two.
  const others = w.chain.calls.getMultipleAccountsInfo.filter((c) => c.commitment !== "finalized");
  assert.deepEqual(others.map((c) => [c.commitment, c.keys]), [["confirmed", [HOT, usdcAccountOf(HOT)]]]);
});

test("what payouts need is read before the hot wallet, so a payout that completes in between is still held for", async () => {
  const w = setupSweep({ addresses: [addressRow(ORG_1, 60n * USDC)], wallets: [treasuryRow()] });
  await w.run();
  const payouts = w.order.indexOf("payouts");
  const firstRead = w.order.indexOf("read");
  assert.ok(payouts >= 0 && firstRead >= 0);
  assert.ok(payouts < firstRead, `payouts at ${payouts}, the first read of the chain at ${firstRead}`);
});

test("the hot wallet's excess is from the lower of what is confirmed and what is final; a payout that just left is gone from what it is filled against", async () => {
  // A payout has just left it: 900 USDC is still final, 500 is what is confirmed.
  // The float is $200, so the excess is 300, not the 700 the final figure alone would give.
  const paidOut = setupSweep({ wallets: [treasuryRow()] }, { hot: { lamports: SOL / 10n, usdcRaw: 900n * USDC } });
  paidOut.chain.setConfirmedBalance(HOT, SOL / 10n, 500n * USDC);
  await paidOut.run();
  assert.deepEqual(
    paidOut.state.transfers.map((t) => [t.kind, t.asset, t.amountRaw]),
    [["hot_to_treasury", "USDC", 300n * USDC]],
  );

  // A transfer to it has landed and is not final: 500 confirmed, 100 final, and its row still "sent".
  // It is counted once, from the row: 100 + 400 is 500, not the 900 the confirmed figure would make it.
  const arriving = setupSweep(
    {
      wallets: [treasuryRow()],
      transfers: [transferRow({ kind: "sweep_to_hot", asset: "USDC", toAddress: HOT, amountRaw: 400n * USDC })],
    },
    { hot: { lamports: SOL / 10n, usdcRaw: 100n * USDC } },
  );
  arriving.chain.setConfirmedBalance(HOT, SOL / 10n, 500n * USDC);
  arriving.fates.set(arriving.state.transfers[0]!.txSignature, fateAnswer(arriving.state.transfers[0]!.txSignature, "landed_ok", undefined, "confirmed"));
  await arriving.run();
  assert.deepEqual(
    arriving.state.transfers.filter((t) => t.kind === "hot_to_treasury"),
    [],
    "the final 100 is not more than twice the float: nothing is sent on from money that is not final",
  );

  // A payout of 150 has just left: 200 final, 50 confirmed, no row for it. A deposit
  // goes to the hot wallet, which holds 50 and not the 200 that is still final.
  const short = setupSweep({ addresses: [addressRow(ORG_1, 60n * USDC)], wallets: [treasuryRow()] }, { hot: { lamports: SOL / 10n, usdcRaw: 200n * USDC } });
  short.chain.setConfirmedBalance(HOT, SOL / 10n, 50n * USDC);
  await short.run();
  assert.deepEqual(
    short.state.transfers.map((t) => [t.kind, t.asset, t.toAddress]),
    [["sweep_to_hot", "USDC", HOT]],
  );
});

test("what open payouts need reaches the plan: USDC goes to the hot wallet past its float, and its excess is not taken", async () => {
  // Float $200 (the stand-in's settings). The hot wallet holds 250; a $300 payout is open.
  const filled = setupSweep({ addresses: [addressRow(ORG_1, 60n * USDC)], wallets: [treasuryRow()] }, { hot: { lamports: SOL, usdcRaw: 250n * USDC } });
  const waiting = { usdcCents: 30_000n, solCents: 0n };
  filled.knobs.openPayouts = { waiting, open: waiting };
  await filled.run();
  assert.deepEqual(
    filled.state.transfers.map((t) => [t.kind, t.asset, t.toAddress]),
    [["sweep_to_hot", "USDC", HOT]],
  );

  // The excess is measured above it too, to the unit: 650 held with 300 owed is
  // not more than twice the float on top of it; 701 sends 201 and keeps 500.
  const kept = setupSweep({ wallets: [treasuryRow()] }, { hot: { lamports: SOL, usdcRaw: 650n * USDC } });
  kept.knobs.openPayouts = { waiting, open: waiting };
  await kept.run();
  assert.deepEqual(kept.state.transfers, []);
  const over = setupSweep({ wallets: [treasuryRow()] }, { hot: { lamports: SOL, usdcRaw: 701n * USDC } });
  over.knobs.openPayouts = { waiting, open: waiting };
  await over.run();
  assert.deepEqual(
    over.state.transfers.map((t) => [t.kind, t.asset, t.amountRaw]),
    [["hot_to_treasury", "USDC", 201n * USDC]],
  );

  // A payout being sent is not filled for: nothing waits, 300 is open.
  const beingSent = setupSweep({ addresses: [addressRow(ORG_1, 60n * USDC)], wallets: [treasuryRow()] }, { hot: { lamports: SOL, usdcRaw: 250n * USDC } });
  beingSent.knobs.openPayouts = { waiting: { usdcCents: 0n, solCents: 0n }, open: waiting };
  await beingSent.run();
  assert.deepEqual(
    beingSent.state.transfers.map((t) => [t.kind, t.asset, t.toAddress]),
    [["sweep_to_treasury", "USDC", TREASURY]],
  );

  // The same with nothing open: at its float, so it goes to the treasury.
  const plain = setupSweep({ addresses: [addressRow(ORG_1, 60n * USDC)], wallets: [treasuryRow()] }, { hot: { lamports: SOL, usdcRaw: 250n * USDC } });
  await plain.run();
  assert.deepEqual(
    plain.state.transfers.map((t) => [t.kind, t.asset, t.toAddress]),
    [["sweep_to_treasury", "USDC", TREASURY]],
  );
});

test("when the open payouts cannot be read nothing is planned", async () => {
  const w = setupSweep({ addresses: [addressRow(ORG_1, 60n * USDC)], wallets: [treasuryRow()] }, { hot: { lamports: SOL, usdcRaw: 900n * USDC } });
  w.knobs.openPayouts = new Error("database said: connection refused");
  const res = await w.run();
  assert.equal(res.errors, 1);
  assert.equal(res.planned, 0, "not even the excess: it cannot be told from money a payout waits for");
  assert.match(w.errors()[0]!.detail ?? "", /open payouts could not be read/);
});

test("a failed read of a chunk plans nothing of it and is an error", async () => {
  const w = setupSweep({ addresses: [addressRow(ORG_1, 60n * USDC)] });
  const real = w.chain.connection.getMultipleAccountsInfo.bind(w.chain.connection);
  (w.chain.connection as any).getMultipleAccountsInfo = async (keys: any, commitment: any) => {
    // The chunk of addresses, not the hot wallet's own two accounts.
    if (keys[0].toBase58() !== HOT) throw new Error("node said: too many requests api-key=SECRET");
    return real(keys, commitment);
  };
  const res = await w.run();
  assert.equal(res.errors, 1);
  assert.equal(res.addressesRead, 0);
  assert.equal(res.planned, 0);
});

test("when the hot wallet cannot be read nothing is planned", async () => {
  const w = setupSweep({ addresses: [addressRow(ORG_1, 60n * USDC)] });
  w.chain.failing.read = new Error("node is away");
  const res = await w.run();
  assert.equal(res.errors, 1);
  assert.equal(res.planned, 0);
  assert.equal(w.state.transfers.length, 0);
});

// ============================================
// Where it goes
// ============================================

test("under the float it goes to the hot wallet; at the float to the proven treasury", async () => {
  const w = setupSweep(
    {
      addresses: [addressRow(ORG_1, 150n * USDC), addressRow(ORG_2, 90n * USDC), addressRow(ORG_3, 40n * USDC)],
      wallets: [treasuryRow()],
    },
    { hot: { lamports: 600_000_000n, usdcRaw: 0n } },
  );
  const res = await w.run();
  assert.equal(res.sent, 3);
  assert.deepEqual(
    w.state.transfers.map((r) => [r.kind, r.orgId, r.toAddress]),
    [
      ["sweep_to_hot", ORG_1, HOT],
      ["sweep_to_hot", ORG_2, HOT],
      ["sweep_to_treasury", ORG_3, TREASURY],
    ],
  );

  // The next run: all three are still out. What is on its way to the hot
  // wallet (240) counts, so a new deposit goes to the treasury.
  for (const row of w.state.transfers) w.fates.set(row.txSignature, fateAnswer(row.txSignature, "in_flight"));
  w.state.addresses.push(addressRow("org-late", 70n * USDC));
  w.fund("org-late");
  const next = await w.run();
  assert.equal(next.resent, 3);
  assert.equal(next.sent, 1);
  assert.deepEqual(
    w.state.transfers.slice(3).map((r) => [r.kind, r.orgId, r.toAddress]),
    [["sweep_to_treasury", "org-late", TREASURY]],
  );
});

test("with no proven treasury only sweeps to the hot wallet happen", async () => {
  const cases: Array<{ name: string; wallets: any[]; setting: string | null }> = [
    { name: "no row", wallets: [], setting: TREASURY },
    { name: "a row for another address", wallets: [treasuryRow(keypairOf("older").publicKey.toBase58())], setting: TREASURY },
    { name: "a row for another chain", wallets: [treasuryRow(TREASURY, { network: "solana:mainnet" })], setting: TREASURY },
    { name: "the default setting", wallets: [treasuryRow(NO_TREASURY_ADDRESS)], setting: NO_TREASURY_ADDRESS },
    { name: "no setting", wallets: [treasuryRow()], setting: null },
    { name: "the hot wallet", wallets: [treasuryRow(HOT)], setting: HOT },
    { name: "a deposit address", wallets: [treasuryRow(A3)], setting: A3 },
    { name: "a token account", wallets: [treasuryRow(usdcAccountOf(TREASURY))], setting: usdcAccountOf(TREASURY) },
    { name: "not an address", wallets: [treasuryRow("treasury")], setting: "treasury" },
  ];
  for (const c of cases) {
    const w = setupSweep(
      {
        addresses: [
          addressRow(ORG_1, 150n * USDC, 2n * SOL),
          addressRow(ORG_2, 90n * USDC, SOL),
          addressRow(ORG_3, 40n * USDC),
        ],
        wallets: c.wallets,
      },
      { treasurySetting: c.setting, hot: { lamports: 400_000_000n, usdcRaw: 0n } },
    );
    const res = await w.run();
    assert.equal(res.errors, 0, c.name);
    assert.deepEqual(
      w.state.transfers.map((r) => [r.kind, r.asset, r.orgId]),
      [
        ["sweep_to_hot", "SOL", ORG_1],
        ["sweep_to_hot", "USDC", ORG_1],
        ["sweep_to_hot", "USDC", ORG_2],
      ],
      c.name,
    );
    assert.ok(w.state.transfers.every((r) => r.toAddress === HOT), c.name);
    assert.equal(res.held, 2, c.name);
    assert.equal(w.chain.calls.sendRawTransaction.length, 3, c.name);
  }
});

test("a hot wallet far over its floats sends nothing back while no treasury is proven, and the excess once it is", async () => {
  const rich = { lamports: 9n * SOL, usdcRaw: 9_000n * USDC };
  const unproven = setupSweep({}, { hot: rich });
  assert.equal((await unproven.run()).planned, 0);
  assert.equal(unproven.chain.calls.sendRawTransaction.length, 0);

  const proven = setupSweep({ wallets: [treasuryRow()] }, { hot: rich });
  const res = await proven.run();
  assert.equal(res.sent, 2);
  assert.deepEqual(
    proven.state.transfers.map((r) => [r.kind, r.asset, r.fromAddress, r.toAddress, r.orgId, r.amountRaw, r.feeLamports, r.feePayer]),
    [
      ["hot_to_treasury", "USDC", HOT, TREASURY, null, 8_800n * USDC, 5_000n, HOT],
      ["hot_to_treasury", "SOL", HOT, TREASURY, null, 9n * SOL - 500_000_000n, 5_000n, HOT],
    ],
  );

  // While those are out, no second one leaves the hot wallet.
  for (const row of proven.state.transfers) {
    proven.fates.set(row.txSignature, fateAnswer(row.txSignature, "in_flight"));
  }
  const next = await proven.run();
  assert.equal(next.planned, 0);
  assert.equal(sentRows(proven).length, 2);
});

test("with no price no SOL moves in that run; USDC still does", async () => {
  const w = setupSweep({ addresses: [addressRow(ORG_1, 60n * USDC, 5n * SOL)], wallets: [treasuryRow()] });
  w.knobs.price = { ok: false, code: "stale" };
  const res = await w.run();
  assert.deepEqual(w.state.transfers.map((r) => r.asset), ["USDC"]);
  assert.equal(res.held, 1);

  // A price read that throws is no price.
  const thrown = setupSweep({ addresses: [addressRow(ORG_1, 0n, 5n * SOL)] });
  thrown.deps.getSolQuote = async () => {
    throw new Error("node is away");
  };
  assert.equal((await thrown.run()).planned, 0);
});

test("no USDC moves while the hot wallet is under HOT_WALLET_MIN_SOL; the SOL sweep that fills it does", async () => {
  const w = setupSweep(
    { addresses: [addressRow(ORG_1, 500n * USDC, SOL)] },
    { hot: { lamports: 10_000_000n, usdcRaw: 0n } },
  );
  const res = await w.run();
  assert.deepEqual(w.state.transfers.map((r) => [r.kind, r.asset]), [["sweep_to_hot", "SOL"]]);
  assert.equal(res.held, 1);
});

// ============================================
// One that throws does not stop the others
// ============================================

test("one transfer that cannot be signed does not stop the others", async () => {
  const w = setupSweep({
    addresses: [addressRow(ORG_1, 90n * USDC), addressRow(ORG_2, 60n * USDC), addressRow(ORG_3, 40n * USDC)],
  });
  let asked = 0;
  const real = w.chain.connection.getLatestBlockhash.bind(w.chain.connection);
  (w.chain.connection as any).getLatestBlockhash = async (commitment: any) => {
    asked += 1;
    if (asked === 2) throw new Error("node is away");
    return real(commitment);
  };
  const res = await w.run();
  assert.equal(res.planned, 3);
  assert.equal(res.sent, 2);
  assert.equal(res.errors, 1);
  assert.deepEqual(w.state.transfers.map((r) => r.orgId), [ORG_1, ORG_3]);
  assert.equal(w.chain.calls.sendRawTransaction.length, 2);
});

test("the run answers its counts for the log", async () => {
  const w = setupSweep({
    addresses: [addressRow(ORG_1, 60n * USDC), addressRow(ORG_2, 1n * USDC)],
    transfers: [transferRow({ fromAddress: A3, orgId: ORG_3 })],
  });
  w.fates.set("sig_1", fateAnswer("sig_1", "landed_ok"));
  assert.deepEqual(await w.run(), {
    ran: true,
    settled: { landed: 1, failed: 0, dead: 0 },
    resent: 0,
    left: 0,
    addressesRead: 2,
    planned: 1,
    sent: 1,
    skipped: 0,
    held: 0,
    errors: 0,
  });
});
