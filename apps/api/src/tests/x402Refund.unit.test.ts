import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";
import {
  MICRO_USD_PER_CENT,
  X402_REFUNDED_REASON,
  returnX402Payment,
  x402RefundMicroUsd,
} from "../services/x402Refund.js";
import type { X402NewPayment } from "../services/x402Payments.js";
import { FakeX402Db } from "./x402StandIns.js";

// A payment that landed for a request that was not answered goes back to
// the payer's credits: once, in whole numbers, with one ledger row for the
// whole cents and the rest kept until it makes a cent.

const NOW = new Date("2026-10-11T12:00:00Z");
let n = 0;

function landed(db: FakeX402Db, over: Partial<X402NewPayment> = {}) {
  n += 1;
  return db.insert(
    {
      orgId: "org-1",
      deploymentId: "dep-1",
      requestId: `req-${n}`,
      network: "solana:devnet",
      asset: "USDC",
      amountRaw: "3000",
      amountUsd: 0.003,
      payerAddress: "payer",
      payeeAddress: "treasury",
      txSignature: `sig-${n}`,
      status: "verified",
      signedTxB64: "AA==",
      recentBlockhash: "hash",
      amountReceivedRaw: "3000",
      amountMicroUsd: 3000n,
      solMicroUsdPerSol: null,
      submittedAt: NOW,
      verifiedAt: NOW,
      ...over,
    },
    NOW,
  );
}

const give = (db: FakeX402Db, paymentId: string, from: Array<"submitted" | "verified"> = ["verified"]) =>
  returnX402Payment(db, { paymentId, from, now: NOW });

test("what goes back is what was sent: USDC base units are micro-dollars, SOL is lamports at the row's rate, rounded down", () => {
  assert.equal(x402RefundMicroUsd({ asset: "USDC", amountReceivedRaw: "3000", solMicroUsdPerSol: null }), 3000n);
  // 20,001 lamports at $150 a SOL is 3000.15 micro-dollars: 3000.
  assert.equal(
    x402RefundMicroUsd({ asset: "SOL", amountReceivedRaw: "20001", solMicroUsdPerSol: 150_000_000n }),
    3000n,
  );
  // Nothing is guessed: no amount, no rate for SOL, another asset, a number that is not whole.
  assert.equal(x402RefundMicroUsd({ asset: "USDC", amountReceivedRaw: null, solMicroUsdPerSol: null }), null);
  assert.equal(x402RefundMicroUsd({ asset: "SOL", amountReceivedRaw: "20001", solMicroUsdPerSol: null }), null);
  assert.equal(x402RefundMicroUsd({ asset: "SOL", amountReceivedRaw: "20001", solMicroUsdPerSol: 0n }), null);
  assert.equal(x402RefundMicroUsd({ asset: "NOS", amountReceivedRaw: "5", solMicroUsdPerSol: null }), null);
  assert.equal(x402RefundMicroUsd({ asset: "USDC", amountReceivedRaw: "1.5", solMicroUsdPerSol: null }), null);
  assert.equal(x402RefundMicroUsd({ asset: "USDC", amountReceivedRaw: "-5", solMicroUsdPerSol: null }), null);
});

test("a return under a cent grows the carry and writes no ledger row", async () => {
  const db = new FakeX402Db();
  const pay = landed(db);
  const result = await give(db, pay.id);

  assert.deepEqual(result, {
    returned: true,
    orgId: "org-1",
    refundMicroUsd: 3000n,
    creditedCents: 0n,
    carryMicroUsd: 3000n,
  });
  const row = db.payments.get(pay.id)!;
  assert.equal(row.status, "refunded");
  assert.equal(row.refundedAt, NOW);
  assert.equal(row.refundMicroUsd, 3000n);
  assert.equal(row.failureReason, X402_REFUNDED_REASON);
  assert.deepEqual(db.balances.get("org-1"), { balanceCents: 0n, x402RefundCarryMicroUsd: 3000n });
  assert.equal(db.ledger.length, 0);
});

test("several returns under a cent make no ledger row until a cent is crossed, then exactly one for the whole cents", async () => {
  const db = new FakeX402Db();
  db.balances.set("org-1", { balanceCents: 500n, x402RefundCarryMicroUsd: 0n });

  // 3,000 + 3,000 + 3,000 = 9,000: still under a cent.
  for (let i = 0; i < 3; i += 1) await give(db, landed(db).id);
  assert.equal(db.ledger.length, 0);
  assert.deepEqual(db.balances.get("org-1"), { balanceCents: 500n, x402RefundCarryMicroUsd: 9000n });

  // The fourth crosses it: 12,000 is one cent and 2,000 kept.
  const fourth = landed(db);
  const result = await give(db, fourth.id);
  assert.equal(result.returned && result.creditedCents, 1n);
  assert.equal(result.returned && result.carryMicroUsd, 2000n);
  assert.deepEqual(db.balances.get("org-1"), { balanceCents: 501n, x402RefundCarryMicroUsd: 2000n });
  assert.deepEqual(db.ledger, [
    {
      orgId: "org-1",
      amountCents: 1n,
      type: "x402_refund",
      description: "Paid request returned as credits",
      referenceId: fourth.id,
      balanceAfter: 501n,
    },
  ]);

  // And the next small one is quiet again.
  await give(db, landed(db).id);
  assert.equal(db.ledger.length, 1);
  assert.deepEqual(db.balances.get("org-1"), { balanceCents: 501n, x402RefundCarryMicroUsd: 5000n });
});

test("an overpaid amount is returned in full, with one row for all its whole cents", async () => {
  const db = new FakeX402Db();
  // The request asked for 3,000 and the payer sent 2,503,000.
  const pay = landed(db, { amountRaw: "3000", amountReceivedRaw: "2503000" });
  const result = await give(db, pay.id);

  assert.equal(result.returned && result.refundMicroUsd, 2_503_000n);
  assert.equal(result.returned && result.creditedCents, 250n);
  assert.deepEqual(db.balances.get("org-1"), { balanceCents: 250n, x402RefundCarryMicroUsd: 3000n });
  assert.equal(db.ledger.length, 1);
  assert.equal(db.ledger[0]!.amountCents, 250n);
  assert.equal(db.ledger[0]!.balanceAfter, 250n);
});

test("a SOL payment goes back at the rate it was quoted at", async () => {
  const db = new FakeX402Db();
  // 0.001 SOL at $150: 150,000 micro-dollars, fifteen cents.
  const pay = landed(db, {
    asset: "SOL",
    amountRaw: "1000000",
    amountReceivedRaw: "1000000",
    solMicroUsdPerSol: 150_000_000n,
  });
  const result = await give(db, pay.id);
  assert.equal(result.returned && result.refundMicroUsd, 150_000n);
  assert.deepEqual(db.balances.get("org-1"), { balanceCents: 15n, x402RefundCarryMicroUsd: 0n });
});

test("the carry is the first write, before the payment's row", async () => {
  const db = new FakeX402Db();
  const pay = landed(db, { amountReceivedRaw: "25000" });
  db.writes.length = 0;
  await give(db, pay.id);
  assert.deepEqual(db.writes, [
    "carry:org-1",
    `payment:${pay.id}:refunded`,
    "balance:org-1",
    "ledger:org-1",
  ]);
});

test("a payment is returned once: a second return gives nothing and leaves nothing behind", async () => {
  const db = new FakeX402Db();
  const pay = landed(db);
  assert.equal((await give(db, pay.id)).returned, true);
  const again = await give(db, pay.id);
  assert.deepEqual(again, { returned: false, reason: "already_ended" });
  // The carry the second call added first was rolled back with it.
  assert.deepEqual(db.balances.get("org-1"), { balanceCents: 0n, x402RefundCarryMicroUsd: 3000n });
});

test("two returns of the same payment at the same moment: one wins, the carry grows once", async () => {
  const db = new FakeX402Db();
  const pay = landed(db, { amountReceivedRaw: "12000" });
  const results = await Promise.all([give(db, pay.id), give(db, pay.id), give(db, pay.id)]);

  assert.equal(results.filter((r) => r.returned).length, 1);
  assert.deepEqual(db.balances.get("org-1"), { balanceCents: 1n, x402RefundCarryMicroUsd: 2000n });
  assert.equal(db.ledger.length, 1);
});

test("two returns at once for one organization lose nothing", async () => {
  const db = new FakeX402Db();
  const pays = [6000n, 7000n, 8000n, 9000n].map((amount) =>
    landed(db, { amountReceivedRaw: amount.toString() }),
  );
  const results = await Promise.all(pays.map((pay) => give(db, pay.id)));

  assert.ok(results.every((r) => r.returned));
  // 30,000 micro-dollars went back: every one of them is either in the
  // balance or in the carry, and each ledger row's balanceAfter is the
  // balance as that row left it.
  const balance = db.balances.get("org-1")!;
  assert.equal(balance.balanceCents * MICRO_USD_PER_CENT + balance.x402RefundCarryMicroUsd, 30_000n);
  assert.equal(balance.balanceCents, 3n);
  assert.ok(balance.x402RefundCarryMicroUsd < MICRO_USD_PER_CENT);
  let running = 0n;
  for (const row of db.ledger) {
    running += row.amountCents;
    assert.equal(row.balanceAfter, running);
  }
  assert.equal(running, 3n);
});

test("a served payment is never returned", async () => {
  const db = new FakeX402Db();
  const pay = landed(db);
  db.payments.set(pay.id, { ...pay, servedAt: NOW });

  assert.deepEqual(await give(db, pay.id), { returned: false, reason: "already_ended" });
  assert.equal(db.payments.get(pay.id)!.status, "verified");
  assert.deepEqual(db.balances.get("org-1"), undefined, "the organization's balance row was not even created");
  assert.equal(db.ledger.length, 0);
});

test("only the statuses the caller names can be returned from", async () => {
  const db = new FakeX402Db();
  const submitted = landed(db, { status: "submitted", verifiedAt: null });
  // A request's own return is for a payment that landed: "verified" only.
  assert.deepEqual(await give(db, submitted.id, ["verified"]), { returned: false, reason: "already_ended" });
  // The worker, having read that it landed, returns it from "submitted".
  assert.equal((await give(db, submitted.id, ["submitted"])).returned, true);

  for (const status of ["failed", "settled", "refunded", "pending"]) {
    const row = landed(db);
    db.payments.set(row.id, { ...row, status });
    assert.deepEqual(await give(db, row.id, ["submitted", "verified"]), {
      returned: false,
      reason: "already_ended",
    });
  }
});

test("a row that does not say what was sent returns nothing, and a missing row returns nothing", async () => {
  const db = new FakeX402Db();
  const old = landed(db);
  db.payments.set(old.id, { ...old, amountReceivedRaw: null });
  assert.deepEqual(await give(db, old.id), { returned: false, reason: "no_amount" });
  assert.equal(db.payments.get(old.id)!.status, "verified");
  assert.deepEqual(await give(db, "no-such-payment"), { returned: false, reason: "not_found" });
  assert.equal(db.balances.size, 0);
});

test("a database error is thrown with nothing written", async () => {
  const db = new FakeX402Db();
  const pay = landed(db, { amountReceivedRaw: "25000" });
  const transaction = db.$transaction.bind(db);
  db.$transaction = ((fn: any) =>
    transaction(async (tx: any) =>
      fn({
        ...tx,
        creditTransaction: {
          create: async () => {
            throw new Error("connection lost");
          },
        },
      }),
    )) as typeof db.$transaction;

  await assert.rejects(give(db, pay.id), /connection lost/);
  assert.equal(db.payments.get(pay.id)!.status, "verified");
  assert.equal(db.payments.get(pay.id)!.refundedAt, null);
  assert.equal(db.balances.get("org-1"), undefined);
  assert.equal(db.ledger.length, 0);
});
