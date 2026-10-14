import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import {
  X402_FAILED_ON_CHAIN_REASON,
  X402_NEVER_LANDED_REASON,
  buildX402DoorPaymentsDeps,
  doorClaimConflict,
  readX402Fate,
  x402DoorChainReads,
} from "../services/buildX402PaymentsDeps.js";
import { X402_DOOR_CONFIRM_MAX_MS, X402_DOOR_DEAD_TRUSTED_AFTER_MS } from "../services/x402DoorRules.js";
import { verifyExactSvmTransaction, type ExactSvmPayment } from "../services/x402ExactSvm.js";
import { signAsFeePayer, type FeePayerSigned } from "../services/x402FeePayer.js";
import {
  awaitDoorPayment,
  claimHeldPayment,
  failHeldPayment,
  findDoorPaymentByHash,
  markUnserved,
  submitHeldPayment,
  type X402DoorPaymentEvent,
  type X402DoorPaymentsDeps,
  type X402FateReading,
  type X402HeldClaim,
} from "../services/x402Payments.js";
import { X402_NEVER_LANDED_REASON as NAMED_IN_SETTLEMENT } from "../services/x402Settlement.js";
import { listingRequirements, makeX402Memo, type PaymentRequirements } from "../services/x402Wire.js";
import { doorChain, type DoorChain } from "./x402DoorChain.js";
import { exactPayment, keypairOf, signWithNonce, withSignature, type ExactPaymentInput } from "./x402DoorStandIns.js";
import { FakeX402Db, type PaymentRow } from "./x402StandIns.js";

// A payment at a listing's x402 door, from its claim to the chain's answer:
// held while its answer is made, with nothing that can land; signed and
// recorded as submitted by compare-and-set, and only then sent; waited for
// on the clock, never called failed while it can still land. The chain is
// the door's stand-in, reading the bytes a real client makes.

// Any key in memory: the fee payer is derived in its own file and the door's binding only.
const FEE_PAYER = keypairOf(9);
const MINT = usdcMintForNetwork("devnet");
const TREASURY = keypairOf(7).publicKey;
const LISTING = "4f8b1c2d-0000-4000-8000-0000000000aa";
const SELLER = "0f1e2d3c-4b5a-4968-8776-6554433221bb";
const SECRET = "a-test-secret-of-some-length";
const PRICE_ATOMIC = 50_000n;

interface DoorWorld {
  db: FakeX402Db;
  chain: DoorChain;
  deps: X402DoorPaymentsDeps;
  nowMs: number;
  events: X402DoorPaymentEvent[];
  /** Writes and sends, in order. */
  trail: string[];
}

/** The door's rows over the in-memory database, and its chain. Blocks pass with the clock (400 ms a slot). */
function doorWorld(options: { blocksPerSecond?: number } = {}): DoorWorld {
  const db = new FakeX402Db();
  const chain = doorChain({ mint: MINT });
  chain.fundSol(FEE_PAYER.publicKey, 50_000_000n);
  chain.openTokenAccount(TREASURY, 0n);
  const world: DoorWorld = {
    db,
    chain,
    nowMs: Date.UTC(2026, 9, 14, 12, 0, 0),
    events: [],
    trail: [],
    deps: undefined as unknown as X402DoorPaymentsDeps,
  };
  const now = () => new Date(world.nowMs);
  const blocksPerSecond = options.blocksPerSecond ?? 2.5;
  const door = (row: PaymentRow) => row.listingId !== null;
  world.deps = {
    now,
    pollIntervalMs: 1_000,
    sleep: async (ms) => {
      world.nowMs += ms;
      chain.advance(Math.floor((ms * blocksPerSecond) / 1_000));
    },
    findByMessageHash: async (messageHash) => {
      for (const row of db.payments.values()) {
        if (row.messageHash === messageHash) return { id: row.id, status: row.status };
      }
      return null;
    },
    insertHeld: async (row) => {
      try {
        const written = db.insert(row, now());
        world.trail.push(`insert:${written.status}`);
        return { ok: true, id: written.id };
      } catch (err) {
        // The binding's own reading of which index it was.
        const conflict = doorClaimConflict(err);
        if (conflict === null || conflict === "unknown") throw err;
        return { ok: false, reason: conflict };
      }
    },
    markHeldFailed: (id, reason) =>
      db.cas(id, (row) => row.status === "held" && door(row), { status: "failed", failureReason: reason }),
    markSubmitted: async (id, { messageHash, ...sent }) => {
      try {
        const changed = await db.cas(
          id,
          (row) => row.status === "held" && row.messageHash === messageHash && door(row),
          { status: "submitted", ...sent },
        );
        if (changed) world.trail.push("cas:submitted");
        return changed ? "submitted" : "not_held";
      } catch (err) {
        if ((err as { code?: string }).code === "P2002") return "duplicate_signature";
        throw err;
      }
    },
    broadcast: async (signedTxB64) => {
      world.trail.push("broadcast");
      await chain.connection.sendRawTransaction(Buffer.from(signedTxB64, "base64"));
    },
    readFate: (input) => readX402Fate(input, chain.readFate),
    markSentFailed: (id, why) =>
      db.cas(id, (row) => row.status === "submitted" && door(row), {
        status: "failed",
        failureReason: why === "failed_on_chain" ? X402_FAILED_ON_CHAIN_REASON : X402_NEVER_LANDED_REASON,
      }),
    markUnserved: (id) => db.cas(id, (row) => row.status === "submitted" && door(row), { status: "unserved" }),
    log: (event) => {
      world.events.push(event);
    },
  };
  return world;
}

interface Payment {
  b64: string;
  requirements: PaymentRequirements;
  checked: ExactSvmPayment;
  nonce: string;
  payer: Keypair;
}

/** A real client's payment for one use, on a blockhash the chain handed out, from a funded wallet. */
function pay(world: DoorWorld, payer: Keypair = keypairOf(3), over: Partial<ExactPaymentInput> = {}): Payment {
  const { memo, nonce } = makeX402Memo({ listingId: LISTING, amount: PRICE_ATOMIC.toString(), secret: SECRET });
  const requirements = listingRequirements({
    network: "devnet",
    priceCents: 5n,
    asset: MINT.toBase58(),
    payTo: TREASURY.toBase58(),
    feePayer: FEE_PAYER.publicKey.toBase58(),
    memo,
  });
  if (world.chain.usdcOf(payer.publicKey) === null) world.chain.openTokenAccount(payer.publicKey, 1_000_000n);
  const b64 = exactPayment({
    payer,
    feePayer: FEE_PAYER.publicKey,
    payTo: TREASURY,
    mint: MINT,
    amount: PRICE_ATOMIC,
    memo,
    blockhash: world.chain.issueBlockhash(),
    ...over,
  });
  const checked = verifyExactSvmTransaction(b64, requirements, { feePayer: FEE_PAYER.publicKey.toBase58() });
  assert.ok(checked.isValid, "the stand-in's payment is a valid one");
  return { b64, requirements, checked, nonce, payer };
}

function claimOf(payment: Payment): X402HeldClaim {
  return {
    listingId: LISTING,
    orgId: SELLER,
    messageHash: payment.checked.messageHash,
    requestId: payment.nonce,
    network: "solana:devnet",
    amountRaw: payment.requirements.amount,
    payerAddress: payment.checked.payer,
    payeeAddress: TREASURY.toBase58(),
    recentBlockhash: payment.checked.recentBlockhash,
  };
}

async function claimed(world: DoorWorld, payment: Payment): Promise<string> {
  const result = await claimHeldPayment(claimOf(payment), world.deps);
  assert.equal(result.claimed, true);
  return result.claimed ? result.paymentId : "";
}

function signedBy(payment: Payment): FeePayerSigned {
  const signed = signAsFeePayer(payment.b64, payment.requirements, FEE_PAYER);
  assert.ok("txSignature" in signed);
  return signed;
}

/** Claimed, signed and sent: what the wait starts from. */
async function sent(world: DoorWorld, payment: Payment = pay(world)) {
  const paymentId = await claimed(world, payment);
  const signed = signedBy(payment);
  const result = await submitHeldPayment({ paymentId, messageHash: payment.checked.messageHash, signed }, world.deps);
  assert.equal(result.outcome, "sent");
  const sentAt = result.outcome === "sent" ? result.sentAt : new Date(0);
  return { paymentId, signed, sentAt, blockhash: payment.checked.recentBlockhash };
}

function row(world: DoorWorld, id: string): PaymentRow {
  return world.db.payments.get(id)!;
}

// ============================================
// The claim
// ============================================

test("a claim holds the message's hash and nothing that can land: no signature, no bytes", async () => {
  const world = doorWorld();
  const payment = pay(world);
  const id = await claimed(world, payment);
  const held = row(world, id);

  assert.equal(held.status, "held");
  assert.equal(held.txSignature, null);
  assert.equal(held.signedTxB64, null);
  assert.equal(held.submittedAt, null);
  assert.equal(held.listingId, LISTING);
  assert.equal(held.orgId, SELLER, "a door payment's organization is the seller's");
  assert.equal(held.deploymentId, null);
  assert.equal(held.messageHash, payment.checked.messageHash);
  assert.equal(held.requestId, payment.nonce);
  // Today's network strings, never CAIP-2: the worker selects by them.
  assert.equal(held.network, "solana:devnet");
  assert.equal(held.asset, "USDC");
  assert.equal(held.amountRaw, "50000");
  assert.equal(held.amountMicroUsd, 50_000n);
  assert.equal(held.amountUsd, 0.05);
  assert.equal(held.amountReceivedRaw, null);
  assert.equal(held.payerAddress, payment.payer.publicKey.toBase58(), "the payer is the transfer's authority");
  assert.notEqual(held.payerAddress, FEE_PAYER.publicKey.toBase58());
  assert.equal(held.recentBlockhash, payment.checked.recentBlockhash);

  // Nothing of the transaction is stored: neither its bytes nor the payer's signature.
  const tx = VersionedTransaction.deserialize(Buffer.from(payment.b64, "base64"));
  const stored = JSON.stringify(held, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.equal(stored.includes(payment.b64), false);
  assert.equal(stored.includes(bs58.encode(tx.signatures[1]!)), false);
  assert.equal(stored.includes(Buffer.from(tx.signatures[1]!).toString("base64")), false);
  assert.equal(world.chain.chain.sends.length, 0);

  assert.deepEqual(await findDoorPaymentByHash(payment.checked.messageHash, world.deps), { id, status: "held" });
  assert.equal(await findDoorPaymentByHash("f".repeat(64), world.deps), null);
});

test("the same message claimed twice writes one row, even under another valid signature of the payer", async () => {
  const world = doorWorld();
  const payment = pay(world);
  await claimed(world, payment);

  // One message can carry many valid payer signatures: the key is the message.
  const tx = VersionedTransaction.deserialize(Buffer.from(payment.b64, "base64"));
  const other = withSignature(payment.b64, 1, signWithNonce(tx.message.serialize(), payment.payer, 987_654_321n));
  assert.notEqual(other, payment.b64);
  const again = verifyExactSvmTransaction(other, payment.requirements, { feePayer: FEE_PAYER.publicKey.toBase58() });
  assert.ok(again.isValid);
  assert.equal(again.messageHash, payment.checked.messageHash);

  for (const presented of [payment.checked, again]) {
    const result = await claimHeldPayment({ ...claimOf(payment), messageHash: presented.messageHash }, world.deps);
    assert.deepEqual(result, { claimed: false, reason: "duplicate" });
  }
  assert.equal(world.db.payments.size, 1);
});

test("one payment in flight per wallet: a second claim is wallet_busy while the first is held or submitted, and admitted once it failed", async () => {
  const world = doorWorld();
  const payer = keypairOf(3);
  const first = pay(world, payer);
  const firstId = await claimed(world, first);

  const second = pay(world, payer);
  assert.notEqual(second.checked.messageHash, first.checked.messageHash);
  assert.deepEqual(await claimHeldPayment(claimOf(second), world.deps), { claimed: false, reason: "wallet_busy" });

  // Another wallet is not held up by it.
  const stranger = pay(world, keypairOf(4));
  await claimed(world, stranger);

  // Submitted is still in flight.
  world.db.payments.set(firstId, { ...row(world, firstId), status: "submitted", txSignature: "in-flight-sig" });
  assert.deepEqual(await claimHeldPayment(claimOf(second), world.deps), { claimed: false, reason: "wallet_busy" });

  // Once it is over, the wallet may pay again.
  world.db.payments.set(firstId, { ...row(world, firstId), status: "failed" });
  const result = await claimHeldPayment(claimOf(second), world.deps);
  assert.equal(result.claimed, true);
  assert.equal(world.db.payments.size, 3);
});

test("a held payment fails with its reason and nothing signed; a row no longer held is not changed", async () => {
  const world = doorWorld();
  const id = await claimed(world, pay(world));
  assert.equal(await failHeldPayment(id, "answer_withheld", world.deps), true);
  assert.equal(row(world, id).status, "failed");
  assert.equal(row(world, id).failureReason, "answer_withheld");
  assert.equal(row(world, id).txSignature, null);
  assert.equal(await failHeldPayment(id, "model_error", world.deps), false);
  assert.equal(row(world, id).failureReason, "answer_withheld");
  assert.equal(world.chain.chain.sends.length, 0);
});

// ============================================
// The send
// ============================================

test("submit records the payment as submitted first, and sends only after that compare-and-set", async () => {
  const world = doorWorld();
  const payment = pay(world);
  const { paymentId, signed, sentAt } = await sent(world, payment);

  assert.deepEqual(world.trail, ["insert:held", "cas:submitted", "broadcast"]);
  const after = row(world, paymentId);
  assert.equal(after.status, "submitted");
  assert.equal(after.txSignature, signed.txSignature);
  assert.equal(after.signedTxB64, signed.signedTxB64);
  assert.deepEqual(after.submittedAt, sentAt);
  // What reached the chain is the bytes the fee payer signed, both signatures good.
  assert.deepEqual(world.chain.chain.sends, [{ signature: signed.txSignature, bytesB64: signed.signedTxB64 }]);
});

test("the payer's partial transaction alone never lands: the chain refuses it until the fee payer signs", async () => {
  const world = doorWorld();
  const payment = pay(world);
  await assert.rejects(world.chain.connection.sendRawTransaction(Buffer.from(payment.b64, "base64")), /signature verification/);
});

test("a row no longer held sends nothing", async () => {
  const world = doorWorld();
  const payment = pay(world);
  const paymentId = await claimed(world, payment);
  await failHeldPayment(paymentId, "client_closed_request", world.deps);
  const result = await submitHeldPayment(
    { paymentId, messageHash: payment.checked.messageHash, signed: signedBy(payment) },
    world.deps,
  );
  assert.deepEqual(result, { outcome: "not_claimed" });
  assert.equal(world.chain.chain.sends.length, 0);
  assert.equal(world.trail.includes("broadcast"), false);
  assert.equal(row(world, paymentId).status, "failed");
  assert.equal(row(world, paymentId).failureReason, "client_closed_request");
  assert.equal(row(world, paymentId).txSignature, null);
});

test("signed bytes of another message are never sent under this row, and the row is ended", async () => {
  const world = doorWorld();
  const payment = pay(world);
  const paymentId = await claimed(world, payment);
  const elsewhere = pay(world, keypairOf(5));
  const other = signedBy(elsewhere);
  // The write itself holds the row's own hash: bytes of another message are
  // refused by the compare-and-set even when the caller names the wrong row.
  assert.equal(
    await world.deps.markSubmitted(paymentId, {
      txSignature: other.txSignature,
      signedTxB64: other.signedTxB64,
      submittedAt: new Date(world.nowMs),
      messageHash: other.messageHash,
    }),
    "not_held",
  );
  assert.equal(row(world, paymentId).status, "held");
  assert.equal(row(world, paymentId).txSignature, null);
  const result = await submitHeldPayment(
    { paymentId, messageHash: payment.checked.messageHash, signed: other },
    world.deps,
  );
  assert.deepEqual(result, { outcome: "not_claimed" });
  assert.equal(world.chain.chain.sends.length, 0);
  assert.equal(row(world, paymentId).status, "failed");
  assert.equal(row(world, paymentId).failureReason, "never_sent");
  assert.equal(row(world, paymentId).txSignature, null);
});

test("a submit whose signature is already on another row is a duplicate: nothing sent, and the row is failed", async () => {
  const world = doorWorld();
  const payment = pay(world);
  const signed = signedBy(payment);
  // The same transaction id already recorded on another row.
  world.db.insert(
    {
      orgId: "org-1",
      deploymentId: "dep-1",
      requestId: "req-1",
      network: "solana:devnet",
      asset: "USDC",
      amountRaw: "50000",
      amountUsd: 0.05,
      payerAddress: "someone",
      payeeAddress: TREASURY.toBase58(),
      txSignature: signed.txSignature,
      status: "submitted",
      signedTxB64: "AA==",
      recentBlockhash: "hash",
      amountReceivedRaw: "50000",
      amountMicroUsd: 50_000n,
      solMicroUsdPerSol: null,
      submittedAt: new Date(world.nowMs),
      verifiedAt: null,
    },
    new Date(world.nowMs),
  );
  const paymentId = await claimed(world, payment);
  const result = await submitHeldPayment({ paymentId, messageHash: payment.checked.messageHash, signed }, world.deps);
  assert.deepEqual(result, { outcome: "duplicate" });
  assert.equal(world.chain.chain.sends.length, 0);
  assert.equal(world.trail.includes("broadcast"), false);
  assert.equal(row(world, paymentId).status, "failed");
  assert.equal(row(world, paymentId).failureReason, "presented_twice");
  assert.equal(row(world, paymentId).txSignature, null);
  assert.equal(row(world, paymentId).signedTxB64, null);
});

test("a send that throws decides nothing: a transaction that reached the chain is still waited for", async () => {
  const world = doorWorld();
  world.chain.chain.send = "throws_but_reached";
  const { paymentId, signed, sentAt, blockhash } = await sent(world);
  assert.ok(world.events.some((e) => e.event === "send_error"));
  assert.equal(row(world, paymentId).status, "submitted");
  assert.equal(await awaitDoorPayment({ paymentId, signature: signed.txSignature, blockhash, sentAt }, world.deps), "landed_ok");
});

// ============================================
// The wait
// ============================================

test("the wait answers landed_ok when the chain confirms it, and leaves the row for the sale", async () => {
  const world = doorWorld();
  const { paymentId, signed, sentAt, blockhash } = await sent(world);
  assert.equal(await awaitDoorPayment({ paymentId, signature: signed.txSignature, blockhash, sentAt }, world.deps), "landed_ok");
  assert.equal(row(world, paymentId).status, "submitted", "the sale moves it on, not the wait");
  assert.equal(world.chain.landed(signed.txSignature), "ok");
  assert.equal(world.chain.usdcOf(TREASURY), PRICE_ATOMIC);
  // The fee payer paid the fee of two signatures, and nothing else.
  assert.equal(world.chain.lamportsOf(FEE_PAYER.publicKey), 50_000_000n - 10_000n);
});

test("the wait answers landed_failed when it landed and failed, and fails the row in our words", async () => {
  const world = doorWorld();
  world.chain.chain.fate = "landed_failed";
  const { paymentId, signed, sentAt, blockhash } = await sent(world);
  assert.equal(
    await awaitDoorPayment({ paymentId, signature: signed.txSignature, blockhash, sentAt }, world.deps),
    "landed_failed",
  );
  assert.equal(row(world, paymentId).status, "failed");
  assert.equal(row(world, paymentId).failureReason, X402_FAILED_ON_CHAIN_REASON);
  assert.equal(world.chain.usdcOf(TREASURY), 0n, "nothing was taken");
});

test("a transaction that can still land is never called failed: unconfirmed after the longest wait, the row left submitted", async () => {
  // The chain stands still: its blockhash stays valid, and it neither lands nor dies.
  const world = doorWorld({ blocksPerSecond: 0 });
  world.chain.chain.fate = "never";
  const { paymentId, signed, sentAt, blockhash } = await sent(world);
  assert.equal(
    await awaitDoorPayment({ paymentId, signature: signed.txSignature, blockhash, sentAt }, world.deps),
    "unconfirmed",
  );
  assert.equal(row(world, paymentId).status, "submitted");
  assert.ok(world.nowMs - sentAt.getTime() >= X402_DOOR_CONFIRM_MAX_MS - 1_000);
  assert.ok(world.nowMs - sentAt.getTime() <= X402_DOOR_CONFIRM_MAX_MS);
  const last = world.events.at(-1);
  assert.equal(last?.event, "unconfirmed");
});

test("a transaction that never lands is dead once its blockhash has passed, and only then", async () => {
  const world = doorWorld();
  world.chain.chain.fate = "never";
  const { paymentId, signed, sentAt, blockhash } = await sent(world);
  assert.equal(await awaitDoorPayment({ paymentId, signature: signed.txSignature, blockhash, sentAt }, world.deps), "dead");
  assert.equal(row(world, paymentId).status, "failed");
  assert.equal(row(world, paymentId).failureReason, X402_NEVER_LANDED_REASON);
  assert.equal(X402_NEVER_LANDED_REASON, NAMED_IN_SETTLEMENT, "one sentence, named where it always was");
  // 150 blocks at 2.5 a second: a minute, never sooner.
  assert.ok(world.nowMs - sentAt.getTime() >= 60_000);
});

test("a dead read 10 seconds after the send is not believed; one 25 seconds after it is", async () => {
  const scripted = (world: DoorWorld, fates: X402FateReading[]) => {
    const reads: number[] = [];
    world.deps = {
      ...world.deps,
      readFate: async () => {
        reads.push(world.nowMs);
        return fates.length > 1 ? fates.shift()! : fates[0]!;
      },
    };
    return reads;
  };

  // Ten seconds after the send: dead is not believed, and the chain then says it landed.
  const early = doorWorld();
  const a = await sent(early);
  const earlyReads = scripted(early, [{ fate: "dead" }, { fate: "landed_ok", confirmationStatus: "confirmed" }]);
  const sentTenAgo = new Date(early.nowMs - 10_000);
  assert.equal(
    await awaitDoorPayment({ paymentId: a.paymentId, signature: a.signed.txSignature, blockhash: a.blockhash, sentAt: sentTenAgo }, early.deps),
    "landed_ok",
  );
  assert.equal(earlyReads.length, 2);
  assert.equal(row(early, a.paymentId).status, "submitted");

  // Twenty-five seconds after it: dead is believed at the first read.
  const late = doorWorld();
  const b = await sent(late);
  const lateReads = scripted(late, [{ fate: "dead" }]);
  const sentLongAgo = new Date(late.nowMs - 25_000);
  assert.equal(
    await awaitDoorPayment({ paymentId: b.paymentId, signature: b.signed.txSignature, blockhash: b.blockhash, sentAt: sentLongAgo }, late.deps),
    "dead",
  );
  assert.equal(lateReads.length, 1);
  assert.equal(row(late, b.paymentId).status, "failed");

  // Always dead from the send: believed exactly when the trusted age is reached.
  const always = doorWorld();
  const c = await sent(always);
  const alwaysReads = scripted(always, [{ fate: "dead" }]);
  assert.equal(
    await awaitDoorPayment({ paymentId: c.paymentId, signature: c.signed.txSignature, blockhash: c.blockhash, sentAt: new Date(always.nowMs) }, always.deps),
    "dead",
  );
  assert.equal(alwaysReads.at(-1)! - alwaysReads[0]!, X402_DOOR_DEAD_TRUSTED_AFTER_MS);
});

test("a confirmed payment whose answer is not released becomes unserved; nothing else does", async () => {
  const world = doorWorld();
  const { paymentId, signed, sentAt, blockhash } = await sent(world);
  await awaitDoorPayment({ paymentId, signature: signed.txSignature, blockhash, sentAt }, world.deps);
  assert.equal(await markUnserved(paymentId, world.deps), true);
  assert.equal(row(world, paymentId).status, "unserved");
  assert.equal(await markUnserved(paymentId, world.deps), false);

  const held = await claimed(world, pay(world, keypairOf(6)));
  assert.equal(await markUnserved(held, world.deps), false);
  assert.equal(row(world, held).status, "held");
});

// ============================================
// The bindings
// ============================================

test("which unique a claim ran into is read from the failure", () => {
  const p2002 = (target: unknown) => Object.assign(new Error("unique"), { code: "P2002", meta: { target } });
  assert.equal(doorClaimConflict(p2002(["message_hash"])), "duplicate");
  assert.equal(doorClaimConflict(p2002("x402_payments_message_hash_key")), "duplicate");
  assert.equal(doorClaimConflict(p2002(["messageHash"])), "duplicate");
  assert.equal(doorClaimConflict(p2002("x402_payments_one_open_door_payment_per_wallet")), "wallet_busy");
  assert.equal(doorClaimConflict(p2002(["payer_address"])), "wallet_busy");
  assert.equal(doorClaimConflict(p2002(undefined)), "unknown");
  assert.equal(doorClaimConflict(Object.assign(new Error("other"), { code: "P2003" })), null);
  assert.equal(doorClaimConflict(new Error("connection lost")), null);
});

test("bound to Prisma: the claim's uniques are answers, every change names the status it expects and a door row", async () => {
  const { prisma } = await import("@wheelsai/db");
  const prismaAny = prisma as any;
  const saved = prismaAny.x402Payment;
  const calls: Array<{ op: string; args: any }> = [];
  let createError: unknown = null;
  let updateError: unknown = null;
  let found: { id: string } | null = null;
  prismaAny.x402Payment = {
    create: async (args: any) => {
      calls.push({ op: "create", args });
      if (createError) throw createError;
      return { id: "pay-1" };
    },
    findUnique: async (args: any) => {
      calls.push({ op: "findUnique", args });
      return found;
    },
    updateMany: async (args: any) => {
      calls.push({ op: "updateMany", args });
      if (updateError) throw updateError;
      return { count: 1 };
    },
  };
  const p2002 = (target: unknown) => Object.assign(new Error("unique"), { code: "P2002", meta: { target } });
  try {
    const deps = buildX402DoorPaymentsDeps();
    const world = doorWorld();
    const payment = pay(world);
    const heldRow = {
      ...claimOf(payment),
      deploymentId: null,
      asset: "USDC" as const,
      amountUsd: 0.05,
      txSignature: null,
      status: "held" as const,
      signedTxB64: null,
      amountReceivedRaw: null,
      amountMicroUsd: 50_000n,
      solMicroUsdPerSol: null,
      submittedAt: null,
      verifiedAt: null,
    };

    assert.deepEqual(await deps.insertHeld(heldRow), { ok: true, id: "pay-1" });
    assert.equal(calls[0]!.args.data.txSignature, null);
    assert.equal(calls[0]!.args.data.signedTxB64, null);

    createError = p2002(["message_hash"]);
    assert.deepEqual(await deps.insertHeld(heldRow), { ok: false, reason: "duplicate" });
    createError = p2002("x402_payments_one_open_door_payment_per_wallet");
    assert.deepEqual(await deps.insertHeld(heldRow), { ok: false, reason: "wallet_busy" });
    // A failure that does not name its index: the message's row decides.
    createError = p2002(undefined);
    found = { id: "pay-0" };
    assert.deepEqual(await deps.insertHeld(heldRow), { ok: false, reason: "duplicate" });
    found = null;
    assert.deepEqual(await deps.insertHeld(heldRow), { ok: false, reason: "wallet_busy" });
    createError = new Error("connection lost");
    await assert.rejects(deps.insertHeld(heldRow), /connection lost/);

    calls.length = 0;
    const at = new Date(world.nowMs);
    const hash = "cd".repeat(32);
    assert.equal(
      await deps.markSubmitted("pay-1", { txSignature: "sig", signedTxB64: "AAEC", submittedAt: at, messageHash: hash }),
      "submitted",
    );
    assert.deepEqual(calls[0]!.args, {
      where: { id: "pay-1", status: "held", messageHash: hash, listingId: { not: null } },
      data: { status: "submitted", txSignature: "sig", signedTxB64: "AAEC", submittedAt: at },
    });
    updateError = p2002(["tx_signature"]);
    assert.equal(
      await deps.markSubmitted("pay-1", { txSignature: "sig", signedTxB64: "AAEC", submittedAt: at, messageHash: hash }),
      "duplicate_signature",
    );
    updateError = null;

    calls.length = 0;
    await deps.markHeldFailed("pay-1", "answer_timed_out");
    await deps.markSentFailed("pay-1", "failed_on_chain");
    await deps.markSentFailed("pay-1", "never_landed");
    await deps.markUnserved("pay-1");
    assert.deepEqual(
      calls.map((c) => c.args),
      [
        { where: { id: "pay-1", status: "held", listingId: { not: null } }, data: { status: "failed", failureReason: "answer_timed_out" } },
        {
          where: { id: "pay-1", status: "submitted", listingId: { not: null } },
          data: { status: "failed", failureReason: X402_FAILED_ON_CHAIN_REASON },
        },
        {
          where: { id: "pay-1", status: "submitted", listingId: { not: null } },
          data: { status: "failed", failureReason: X402_NEVER_LANDED_REASON },
        },
        { where: { id: "pay-1", status: "submitted", listingId: { not: null } }, data: { status: "unserved" } },
      ],
    );

    calls.length = 0;
    found = { id: "pay-9" };
    await deps.findByMessageHash("ab".repeat(32));
    assert.deepEqual(calls[0]!.args, { where: { messageHash: "ab".repeat(32) }, select: { id: true, status: true } });
  } finally {
    prismaAny.x402Payment = saved;
  }
});

test("the chain reads: one read of three accounts, the blockhash at confirmed, and a simulation of the partial transaction as it is", async () => {
  const world = doorWorld();
  const payment = pay(world);
  const reads = x402DoorChainReads(() => world.chain.connection);
  const accounts = {
    feePayer: FEE_PAYER.publicKey.toBase58(),
    source: payment.checked.source,
    destination: payment.checked.destination,
  };

  assert.deepEqual(await reads.accounts(accounts), {
    feePayerLamports: 50_000_000n,
    sourceExists: true,
    destinationExists: true,
  });
  assert.equal(await reads.blockhashValid(payment.checked.recentBlockhash), true);
  assert.deepEqual(world.chain.chain.blockhashChecks.at(-1)!.config, { commitment: "confirmed" });
  assert.deepEqual(await reads.simulate(payment.b64), { ok: true });
  assert.deepEqual(world.chain.chain.simulations, [
    { config: { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" } },
  ]);

  // Accounts that do not exist: the treasury's USDC account, an unfunded fee payer.
  world.chain.close(new PublicKey(payment.checked.destination));
  world.chain.close(FEE_PAYER.publicKey);
  assert.deepEqual(await reads.accounts(accounts), {
    feePayerLamports: null,
    sourceExists: true,
    destinationExists: false,
  });
  // A simulation's failure is an answer, never a throw.
  const failed = await reads.simulate(payment.b64);
  assert.equal(failed.ok, false);

  // Too little USDC in the payer's wallet.
  const poor = doorWorld();
  const poorPayer = keypairOf(8);
  poor.chain.openTokenAccount(poorPayer.publicKey, PRICE_ATOMIC - 1n);
  const short = pay(poor, poorPayer);
  const shortRead = await x402DoorChainReads(() => poor.chain.connection).simulate(short.b64);
  assert.deepEqual(shortRead, { ok: false, err: { InstructionError: [2, { Custom: 1 }] } });

  // An expired blockhash.
  const old = doorWorld();
  const stale = pay(old);
  old.chain.advance(151);
  const oldReads = x402DoorChainReads(() => old.chain.connection);
  assert.equal(await oldReads.blockhashValid(stale.checked.recentBlockhash), false);
  assert.deepEqual(await oldReads.simulate(stale.b64), { ok: false, err: "BlockhashNotFound" });
});

test("a chain read that fails or does not come back in time throws: it decides nothing", async () => {
  const world = doorWorld();
  const payment = pay(world);
  world.chain.chain.readsFail = true;
  const reads = x402DoorChainReads(() => world.chain.connection);
  await assert.rejects(reads.blockhashValid(payment.checked.recentBlockhash));
  await assert.rejects(reads.simulate(payment.b64));
  await assert.rejects(
    reads.accounts({ feePayer: FEE_PAYER.publicKey.toBase58(), source: payment.checked.source, destination: payment.checked.destination }),
  );

  // Answers long after the read's bound (the bound's own timer does not
  // hold the process open, so this one does).
  const late = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 500));
  const hanging = x402DoorChainReads(
    () => ({
      getMultipleAccountsInfo: () => late([]),
      isBlockhashValid: () => late({ value: true }),
      simulateTransaction: () => late({ value: { err: null } }),
    }),
    20,
  );
  await assert.rejects(hanging.blockhashValid(payment.checked.recentBlockhash), /in time/);
  await assert.rejects(hanging.simulate(payment.b64), /in time/);
});
