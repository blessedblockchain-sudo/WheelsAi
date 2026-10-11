import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";
import { Keypair } from "@solana/web3.js";

import { X402_REFUSAL_MESSAGES, X402_RETURNED_MESSAGE, parsePaymentHeader } from "../services/x402.js";
import {
  X402_UNSERVED_AFTER_MS,
  bindX402Payments,
  markX402Served,
  returnUnservedX402Payment,
  settleX402Row,
  takeX402Payment,
  x402Requirement,
  type X402TakeInput,
} from "../services/x402Payments.js";
import {
  NODE_TEXT,
  OTHER_MINT_TEST,
  TREASURY,
  TREASURY_USDC_ACCOUNT,
  USDC_MINT_TEST,
  makeWorld,
  solPayment,
  usdcPayment,
  type World,
} from "./x402StandIns.js";

// The life of an x402 payment, with stand-ins for the chain and the
// database: the row is written before anything is sent, only the chain
// says what became of it, and a payment that landed is either served or
// returned, once.

const PRICE = 3_000n; // micro-dollars

function scope(over: Partial<X402TakeInput> = {}) {
  return { orgId: "org-1", deploymentId: "dep-1", requestId: "req-1", microUsd: PRICE, ...over };
}

function take(world: World, signedTx: string, over: Partial<X402TakeInput> = {}) {
  return takeX402Payment(
    {
      ...scope(),
      header: { signature: signedTx, network: "solana:devnet", quote: null },
      hasHealthyNode: true,
      ...over,
    },
    world.deps,
  );
}

// ============================================
// The challenge
// ============================================

test("the 402 for USDC names the treasury wallet, its token account and the mint, and carries no quote", async () => {
  const world = makeWorld();
  const payment = await x402Requirement(scope(), world.deps);
  assert.deepEqual(payment, {
    scheme: "exact",
    network: "solana:devnet",
    asset: "USDC",
    amount: "3000",
    amountUsd: 0.003,
    payTo: TREASURY,
    payToTokenAccount: TREASURY_USDC_ACCOUNT,
    mint: USDC_MINT_TEST,
    memo: "deployment:dep-1;request:req-1",
    validUntil: Math.floor(world.nowMs / 1000) + 120,
    quote: null,
  });
});

test("the 402 for SOL is in lamports at the rate of the moment, rounded up, with the rate lock", async () => {
  const world = makeWorld({ defaultAsset: "SOL" });
  world.solRate = 149_999_999n;
  const payment = await x402Requirement(scope(), world.deps);

  assert.equal(payment.asset, "SOL");
  // 3,000 micro-dollars * 1e9 / 149,999,999 = 20,000.0001...: 20,001.
  assert.equal(payment.amount, "20001");
  assert.equal(payment.amountUsd, 0.003);
  assert.equal(payment.payTo, TREASURY);
  assert.equal(payment.payToTokenAccount, null);
  assert.equal(payment.mint, null);
  assert.equal(typeof payment.quote, "string");
  assert.equal(
    world.deps.readQuote(payment.quote!, { orgId: "org-1", deploymentId: "dep-1" }),
    149_999_999n,
  );
});

test("with no SOL price at the moment of a challenge, the 402 asks for USDC", async () => {
  const world = makeWorld({ defaultAsset: "SOL" });
  world.solRate = null;
  const payment = await x402Requirement(scope(), world.deps);
  assert.equal(payment.asset, "USDC");
  assert.equal(payment.amount, "3000");
  assert.equal(payment.payToTokenAccount, TREASURY_USDC_ACCOUNT);
  assert.equal(payment.mint, USDC_MINT_TEST);
  assert.equal(payment.quote, null);
});

test("the X-Payment header carries the quote when there is one", () => {
  assert.deepEqual(parsePaymentHeader('{"signature":"AA==","network":"solana:devnet"}'), {
    signature: "AA==",
    network: "solana:devnet",
    quote: null,
  });
  assert.equal(
    parsePaymentHeader('{"signature":"AA==","network":"solana:devnet","quote":"a.b.c"}')?.quote,
    "a.b.c",
  );
  assert.equal(parsePaymentHeader('{"signature":7,"network":"solana:devnet"}'), null);
  assert.equal(parsePaymentHeader("not json"), null);
});

// ============================================
// Claim first
// ============================================

test("the row is written, with the signature and the signed bytes, before the transaction is sent", async () => {
  const world = makeWorld();
  const payer = Keypair.generate();
  // The payer sends more than was asked: what was sent is kept beside what was required.
  const signedTx = usdcPayment({ amount: 3_500n, payer });
  let rowAtBroadcast: any = null;
  const broadcast = world.deps.broadcast;
  world.deps.broadcast = async (bytes) => {
    rowAtBroadcast = { ...world.db.only() };
    return broadcast(bytes);
  };

  const result = await take(world, signedTx);

  assert.deepEqual(world.trail, ["insert:submitted", "broadcast", "fate"]);
  assert.equal(rowAtBroadcast.status, "submitted");
  assert.equal(rowAtBroadcast.signedTxB64, signedTx);
  assert.ok(rowAtBroadcast.txSignature);
  assert.deepEqual(world.broadcasts, [signedTx]);

  const row = world.db.only();
  assert.deepEqual(result, { outcome: "taken", paymentId: row.id });
  assert.equal(row.status, "verified");
  assert.equal(row.orgId, "org-1");
  assert.equal(row.deploymentId, "dep-1");
  assert.equal(row.requestId, "req-1");
  assert.equal(row.network, "solana:devnet");
  assert.equal(row.asset, "USDC");
  assert.equal(row.payerAddress, payer.publicKey.toBase58());
  assert.equal(row.payeeAddress, TREASURY);
  assert.equal(row.amountRaw, "3000");
  assert.equal(row.amountReceivedRaw, "3500");
  assert.equal(row.amountMicroUsd, 3_000n);
  assert.equal(row.solMicroUsdPerSol, null);
  assert.equal(typeof row.recentBlockhash, "string");
  assert.ok(row.submittedAt instanceof Date);
  assert.ok(row.verifiedAt instanceof Date);
  assert.equal(row.servedAt, null);
});

test("a plain (unchecked) USDC transfer to the token account is taken too", async () => {
  const world = makeWorld();
  const result = await take(world, usdcPayment({ amount: 3_000n, checked: false }));
  assert.equal(result.outcome, "taken");
});

test("a signature that already has a row is 'already used': nothing is written and nothing is sent", async () => {
  const world = makeWorld();
  const signedTx = usdcPayment({ amount: 3_000n });
  const first = await take(world, signedTx);
  assert.equal(first.outcome, "taken");
  world.trail.length = 0;

  const second = await take(world, signedTx, { requestId: "req-2" });
  assert.deepEqual(second, { outcome: "already_used", paymentId: world.db.only().id });
  assert.deepEqual(world.trail, []);
  assert.equal(world.broadcasts.length, 1);
});

test("a unique violation on the insert is the same answer, with nothing sent", async () => {
  const world = makeWorld();
  const signedTx = usdcPayment({ amount: 3_000n });
  await take(world, signedTx);
  world.trail.length = 0;
  // Two requests with one signature at the same moment: the second one's
  // read found no row, and the index refused its insert.
  world.deps.findPaymentBySignature = async () => null;

  const second = await take(world, signedTx, { requestId: "req-2" });
  assert.equal(second.outcome, "already_used");
  assert.deepEqual(world.trail, []);
  assert.equal(world.broadcasts.length, 1);
  assert.equal(world.db.payments.size, 1);
});

test("a database error on the insert is thrown, and nothing is sent", async () => {
  const world = makeWorld();
  world.deps.insertPayment = async () => {
    throw new Error("connection lost");
  };
  await assert.rejects(take(world, usdcPayment({ amount: 3_000n })), /connection lost/);
  assert.equal(world.broadcasts.length, 0);
  assert.equal(world.fateReads, 0);
});

// ============================================
// Only the chain says
// ============================================

test("a send error decides nothing: the payment that landed anyway is taken", async () => {
  const world = makeWorld();
  world.broadcastThrows = true;
  const result = await take(world, usdcPayment({ amount: 3_000n }));
  assert.equal(result.outcome, "taken");
  assert.equal(world.db.only().status, "verified");
  assert.equal(world.events.filter((e) => e.event === "send_error").length, 1);
});

test("a send error and a chain that says nothing: the row stays 'submitted' and the answer is 'not confirmed'", async () => {
  const world = makeWorld();
  world.broadcastThrows = true;
  world.fates = ["in_flight"];
  const result = await take(world, usdcPayment({ amount: 3_000n }));
  assert.deepEqual(result, { outcome: "refused", reason: "payment_not_confirmed" });
  const row = world.db.only();
  assert.equal(row.status, "submitted");
  assert.equal(row.failureReason, null);
  // The node's words are in the log's event and nowhere in the answer.
  assert.ok(!JSON.stringify(result).includes(NODE_TEXT));
});

test("the fate is read until it lands: in flight, unknown, then landed is taken", async () => {
  const world = makeWorld();
  world.fates = ["in_flight", "unknown", "landed_ok"];
  const started = world.nowMs;
  const result = await take(world, usdcPayment({ amount: 3_000n }));
  assert.equal(result.outcome, "taken");
  assert.equal(world.fateReads, 3);
  assert.equal(world.nowMs - started, 2_000);
  assert.equal(world.broadcasts.length, 1, "sent once, however often the fate is read");
});

test("landed and failed: the row is 'failed' and the answer says so", async () => {
  const world = makeWorld();
  world.fates = ["in_flight", "landed_failed"];
  const result = await take(world, usdcPayment({ amount: 3_000n }));
  assert.deepEqual(result, { outcome: "refused", reason: "payment_failed_on_chain" });
  const row = world.db.only();
  assert.equal(row.status, "failed");
  assert.equal(row.verifiedAt, null);
  assert.equal(world.db.balances.size, 0, "nothing was taken, so nothing is returned");
});

for (const fate of ["in_flight", "unknown", "dead"] as const) {
  test(`'${fate}' until the wait is over: the row stays 'submitted' for the settlement worker`, async () => {
    const world = makeWorld({ confirmWaitMs: 30_000 });
    world.fates = [fate];
    const started = world.nowMs;
    const result = await take(world, usdcPayment({ amount: 3_000n }));

    assert.deepEqual(result, { outcome: "refused", reason: "payment_not_confirmed" });
    assert.equal(world.db.only().status, "submitted");
    assert.ok(world.nowMs - started <= 30_000, "it does not wait past X402_CONFIRM_WAIT_MS");
    assert.ok(world.nowMs - started >= 29_000);
    assert.equal(world.fateReads, 31);
    assert.equal(world.broadcasts.length, 1);
  });
}

test("the worker got to the row first: this request does not serve it too", async () => {
  const world = makeWorld();
  // While this request reads the fate, the settlement worker returns the payment.
  world.onFateRead = async () => {
    world.onFateRead = null;
    const row = world.db.only();
    await world.deps.refund({ paymentId: row.id, from: ["submitted"], now: new Date(world.nowMs) });
  };
  const result = await take(world, usdcPayment({ amount: 3_000n }));
  assert.deepEqual(result, { outcome: "refused", reason: "payment_not_confirmed" });
  assert.equal(world.db.only().status, "refunded");
});

// ============================================
// Before any payment is looked at
// ============================================

test("no healthy node: no payment is read, written or sent", async () => {
  const world = makeWorld();
  const result = await take(world, usdcPayment({ amount: 3_000n }), { hasHealthyNode: false });
  assert.deepEqual(result, { outcome: "unavailable", why: "no_healthy_node" });
  assert.equal(world.decodes, 0);
  assert.equal(world.clusterChecks, 0);
  assert.equal(world.db.payments.size, 0);
  assert.equal(world.broadcasts.length, 0);
});

test("a failed cluster check: no payment is read, written or sent", async () => {
  const world = makeWorld();
  world.clusterOk = false;
  const result = await take(world, usdcPayment({ amount: 3_000n }));
  assert.deepEqual(result, { outcome: "unavailable", why: "chain_unavailable" });
  assert.equal(world.decodes, 0);
  assert.equal(world.db.payments.size, 0);
  assert.equal(world.broadcasts.length, 0);
  assert.equal(world.fateReads, 0);
});

// ============================================
// A refused payment broadcasts nothing
// ============================================

const refusals: Array<[string, () => string, Partial<X402TakeInput>?]> = [
  ["one base unit short", () => usdcPayment({ amount: 2_999n })],
  ["sent to the treasury wallet itself, not its token account", () => usdcPayment({ amount: 3_000n, to: TREASURY })],
  ["a checked transfer of another mint", () => usdcPayment({ amount: 3_000n, mint: OTHER_MINT_TEST })],
  ["SOL where USDC was asked for", () => solPayment({ lamports: 1_000_000_000n })],
  ["bytes that are not a transaction", () => Buffer.from("mock_signature").toString("base64")],
  [
    "a payment for another network",
    () => usdcPayment({ amount: 3_000n }),
    { header: { signature: usdcPayment({ amount: 3_000n }), network: "solana:mainnet", quote: null } },
  ],
];
for (const [name, build, over] of refusals) {
  test(`refused as payment_invalid, and nothing is broadcast: ${name}`, async () => {
    const world = makeWorld();
    const result = await take(world, build(), over);
    assert.deepEqual(result, { outcome: "refused", reason: "payment_invalid" });
    assert.equal(world.db.payments.size, 0);
    assert.equal(world.broadcasts.length, 0);
    assert.equal(world.fateReads, 0);
  });
}

// ============================================
// SOL and the rate lock
// ============================================

async function solChallenge(world: World) {
  const payment = await x402Requirement(scope(), world.deps);
  assert.equal(payment.asset, "SOL");
  return payment;
}

test("a SOL retry is priced at the token's rate, not the rate of the moment it arrives", async () => {
  const world = makeWorld({ defaultAsset: "SOL" });
  world.solRate = 150_000_000n;
  const challenge = await solChallenge(world);
  assert.equal(challenge.amount, "20000");

  // The price of SOL halves before the retry: at the live rate the same
  // request would cost 40,000 lamports. The lock holds it at 20,000.
  world.solRate = 75_000_000n;
  world.nowMs += 60_000;
  const result = await take(world, solPayment({ lamports: 20_000n }), {
    header: { signature: solPayment({ lamports: 20_000n }), network: "solana:devnet", quote: challenge.quote },
  });

  assert.equal(result.outcome, "taken");
  const row = world.db.only();
  assert.equal(row.asset, "SOL");
  assert.equal(row.amountRaw, "20000");
  assert.equal(row.amountReceivedRaw, "20000");
  assert.equal(row.amountMicroUsd, 3_000n);
  assert.equal(row.solMicroUsdPerSol, 150_000_000n);
});

test("a SOL retry a lamport short of the locked price is refused", async () => {
  const world = makeWorld({ defaultAsset: "SOL" });
  const challenge = await solChallenge(world);
  const signedTx = solPayment({ lamports: 19_999n });
  const result = await take(world, signedTx, {
    header: { signature: signedTx, network: "solana:devnet", quote: challenge.quote },
  });
  assert.deepEqual(result, { outcome: "refused", reason: "payment_invalid" });
  assert.equal(world.broadcasts.length, 0);
});

test("an expired, forged, foreign or missing rate lock is quote_expired, and nothing is broadcast", async () => {
  const world = makeWorld({ defaultAsset: "SOL" });
  const challenge = await solChallenge(world);
  const signedTx = solPayment({ lamports: 20_000n });
  const header = (quote: string | null) => ({ signature: signedTx, network: "solana:devnet", quote });

  // Missing.
  assert.deepEqual(await take(world, signedTx, { header: header(null) }), {
    outcome: "refused",
    reason: "quote_expired",
  });
  // Forged: one character of the signature changed. Not its last one: the
  // last character of a base64url signature carries bits that are not part
  // of it, so changing only those leaves the same signature and the token
  // is still the genuine one (about one run in twenty, this test then saw a
  // "forged" token accepted).
  const token = challenge.quote!;
  const at = token.length - 5;
  const forged = token.slice(0, at) + (token[at] === "A" ? "B" : "A") + token.slice(at + 1);
  assert.notDeepEqual(
    Buffer.from(forged.split(".")[2]!, "base64url"),
    Buffer.from(token.split(".")[2]!, "base64url"),
    "the forged token carries another signature",
  );
  assert.deepEqual(await take(world, signedTx, { header: header(forged) }), {
    outcome: "refused",
    reason: "quote_expired",
  });
  // Made for another organization, and for another deployment.
  assert.deepEqual(await take(world, signedTx, { orgId: "org-2", header: header(token) }), {
    outcome: "refused",
    reason: "quote_expired",
  });
  assert.deepEqual(await take(world, signedTx, { deploymentId: "dep-2", header: header(token) }), {
    outcome: "refused",
    reason: "quote_expired",
  });
  // Expired: a second past its life.
  world.nowMs += 121_000;
  assert.deepEqual(await take(world, signedTx, { header: header(token) }), {
    outcome: "refused",
    reason: "quote_expired",
  });

  assert.equal(world.db.payments.size, 0);
  assert.equal(world.broadcasts.length, 0);
  assert.equal(world.fateReads, 0);
});

test("USDC always works: where SOL is asked for, a USDC payment needs no rate lock", async () => {
  const world = makeWorld({ defaultAsset: "SOL" });
  world.solRate = null; // the challenge asked for USDC
  const result = await take(world, usdcPayment({ amount: 3_000n }));
  assert.equal(result.outcome, "taken");
  const row = world.db.only();
  assert.equal(row.asset, "USDC");
  assert.equal(row.solMicroUsdPerSol, null);
});

test("where USDC is asked for, a quote in the header is ignored", async () => {
  const world = makeWorld();
  const signedTx = usdcPayment({ amount: 3_000n });
  const result = await take(world, signedTx, {
    header: { signature: signedTx, network: "solana:devnet", quote: "not.a.token" },
  });
  assert.equal(result.outcome, "taken");
});

// ============================================
// Served, or returned: once
// ============================================

test("a served request sets servedAt and is never returned", async () => {
  const world = makeWorld();
  const taken = await take(world, usdcPayment({ amount: 3_000n }));
  assert.equal(taken.outcome, "taken");
  const id = world.db.only().id;

  assert.equal(await markX402Served(id, world.deps), true);
  assert.ok(world.db.only().servedAt instanceof Date);

  const result = await returnUnservedX402Payment(id, world.deps);
  assert.deepEqual(result, { returned: false, reason: "already_ended" });
  assert.equal(world.db.only().status, "verified");
  assert.equal(world.db.balances.size, 0);
});

test("a request that fails after its payment landed returns what was sent, in full, and cannot then be served", async () => {
  const world = makeWorld();
  await take(world, usdcPayment({ amount: 25_000n })); // overpaid: 3,000 was asked
  const id = world.db.only().id;

  const result = await returnUnservedX402Payment(id, world.deps);
  assert.equal(result.returned && result.refundMicroUsd, 25_000n);
  const row = world.db.only();
  assert.equal(row.status, "refunded");
  assert.equal(row.refundMicroUsd, 25_000n);
  assert.deepEqual(world.db.balances.get("org-1"), { balanceCents: 2n, x402RefundCarryMicroUsd: 5_000n });
  assert.equal(world.db.ledger.length, 1);
  assert.equal(world.db.ledger[0]!.type, "x402_refund");
  assert.equal(world.db.ledger[0]!.referenceId, id);

  assert.equal(await markX402Served(id, world.deps), false);
  assert.equal(world.db.only().servedAt, null);
});

test("the request and the worker reach an unserved payment at the same moment: it is returned once", async () => {
  for (let round = 0; round < 5; round += 1) {
    const world = makeWorld();
    await take(world, usdcPayment({ amount: 12_000n }));
    const row = world.db.only();
    // Old enough for the worker to call the request dead.
    world.nowMs += X402_UNSERVED_AFTER_MS;

    const racers = [
      () => returnUnservedX402Payment(row.id, world.deps).then((r) => r.returned),
      () => settleX402Row(world.db.only(), world.settlementDeps).then((o) => o === "returned"),
    ];
    if (round % 2 === 1) racers.reverse();
    const results = await Promise.all(racers.map((run) => run()));

    assert.equal(results.filter(Boolean).length, 1, `round ${round}`);
    assert.deepEqual(world.db.balances.get("org-1"), { balanceCents: 1n, x402RefundCarryMicroUsd: 2_000n });
    assert.equal(world.db.ledger.length, 1);
  }
});

test("served and returned at the same moment: exactly one of them happens", async () => {
  for (let round = 0; round < 6; round += 1) {
    const world = makeWorld();
    await take(world, usdcPayment({ amount: 12_000n }));
    const id = world.db.only().id;
    const racers = [
      () => markX402Served(id, world.deps),
      () => returnUnservedX402Payment(id, world.deps).then((r) => r.returned),
    ];
    if (round % 2 === 1) racers.reverse();
    const [a, b] = await Promise.all(racers.map((run) => run()));
    assert.notEqual(a, b, `round ${round}`);
    const row = world.db.only();
    assert.ok((row.servedAt !== null) !== (row.refundedAt !== null));
    assert.equal(world.db.ledger.length, row.refundedAt ? 1 : 0);
  }
});

// ============================================
// Broadcasting off (development only)
// ============================================

test("with broadcasting off nothing is sent and nothing is read from the chain; the row is 'verified' at once", async () => {
  const world = makeWorld({ submitTransactions: false });
  world.clusterOk = false; // not even asked
  const result = await take(world, usdcPayment({ amount: 3_000n }));

  assert.equal(result.outcome, "taken");
  assert.deepEqual(world.trail, ["insert:verified"]);
  assert.equal(world.broadcasts.length, 0);
  assert.equal(world.fateReads, 0);
  assert.equal(world.clusterChecks, 0);
  const row = world.db.only();
  assert.equal(row.status, "verified");
  assert.ok(row.verifiedAt instanceof Date);
  assert.ok(row.signedTxB64);

  // Everything else is the same: a payment that does not pay is refused...
  assert.deepEqual(await take(world, usdcPayment({ amount: 1n }), { requestId: "req-2" }), {
    outcome: "refused",
    reason: "payment_invalid",
  });
  // ...the request is served or the payment returned, and the worker settles a served row at once.
  assert.equal(await markX402Served(row.id, world.deps), true);
  assert.equal(await settleX402Row(world.db.only(), world.settlementDeps), "settled");
  assert.equal(world.db.only().status, "settled");
  assert.equal(world.fateReads, 0);
});

// ============================================
// The sentences
// ============================================

test("the sentences a payer reads are the contract's, word for word", () => {
  assert.equal(
    X402_RETURNED_MESSAGE,
    "Your payment for this request was returned to your credit balance. Amounts under a cent add up and appear once they reach a cent.",
  );
  assert.deepEqual(X402_REFUSAL_MESSAGES, {
    quote_expired: "The price for this request has expired. Send the request again to get a new one.",
    payment_invalid:
      "That payment does not match this request. Check the address, the asset and the amount, and send the request again.",
    payment_failed_on_chain: "Your payment failed on the chain and nothing was taken. Send the request again.",
    payment_not_confirmed:
      "Your payment was not confirmed in time. If it lands, it is returned to your credit balance. Send the request again.",
  });
});

test("the bound form is the same four steps", async () => {
  const world = makeWorld();
  const x402 = bindX402Payments(world.deps);
  const challenge = await x402.requirement(scope());
  const signedTx = usdcPayment({ amount: BigInt(challenge.amount) });
  const taken = await x402.take({
    ...scope(),
    header: { signature: signedTx, network: challenge.network, quote: challenge.quote },
    hasHealthyNode: true,
  });
  assert.equal(taken.outcome, "taken");
  const id = world.db.only().id;
  assert.equal(await x402.served(id), true);
  assert.equal((await x402.returned(id)).returned, false);
});

// ============================================
// The bindings to Prisma (services/buildX402PaymentsDeps.ts)
// ============================================

test("bound to Prisma: every change names the status it expects, and a taken signature is an answer with nothing thrown", async () => {
  const [{ buildX402PaymentsDeps }, { prisma }] = await Promise.all([
    import("../services/buildX402PaymentsDeps.js"),
    import("@wheelsai/db"),
  ]);
  const prismaAny = prisma as any;
  const saved = prismaAny.x402Payment;
  const updates: Array<{ where: any; data: any }> = [];
  let count = 1;
  let createError: unknown = null;
  let created: any = null;
  prismaAny.x402Payment = {
    updateMany: async (args: any) => {
      updates.push(args);
      return { count };
    },
    create: async ({ data }: any) => {
      if (createError) throw createError;
      created = data;
      return { id: "pay-new" };
    },
    findUnique: async () => ({ id: "pay-first" }),
  };

  try {
    const deps = buildX402PaymentsDeps();
    const at = new Date("2026-10-11T12:00:00Z");

    assert.equal(await deps.markVerified("p1", at), true);
    assert.deepEqual(updates.pop(), {
      where: { id: "p1", status: "submitted" },
      data: { status: "verified", verifiedAt: at, failureReason: null },
    });

    assert.equal(await deps.markFailedOnChain("p1"), true);
    const failed = updates.pop()!;
    assert.deepEqual(failed.where, { id: "p1", status: "submitted" });
    assert.equal(failed.data.status, "failed");
    assert.equal(failed.data.failureReason, "The payment failed on the chain. Nothing was taken.");

    assert.equal(await deps.markServed("p1", at), true);
    assert.deepEqual(updates.pop(), {
      where: { id: "p1", status: "verified", servedAt: null, refundedAt: null },
      data: { servedAt: at },
    });

    // A lost compare-and-set is "false", for each of them.
    count = 0;
    assert.equal(await deps.markVerified("p1", at), false);
    assert.equal(await deps.markFailedOnChain("p1"), false);
    assert.equal(await deps.markServed("p1", at), false);

    const row = {
      orgId: "org-1",
      deploymentId: "dep-1",
      requestId: "req-1",
      network: "solana:devnet",
      asset: "USDC" as const,
      amountRaw: "3000",
      amountUsd: 0.003,
      payerAddress: "payer",
      payeeAddress: TREASURY,
      txSignature: "sig-1",
      status: "submitted" as const,
      signedTxB64: "AAAA",
      recentBlockhash: "hash",
      amountReceivedRaw: "3000",
      amountMicroUsd: 3_000n,
      solMicroUsdPerSol: null,
      submittedAt: at,
      verifiedAt: null,
    };
    assert.deepEqual(await deps.insertPayment(row), { ok: true, id: "pay-new" });
    assert.deepEqual(created, row, "the claim holds the signature, the signed bytes, the blockhash and the amounts");

    createError = Object.assign(new Error(NODE_TEXT), { code: "P2002" });
    assert.deepEqual(await deps.insertPayment(row), {
      ok: false,
      reason: "duplicate_signature",
      id: "pay-first",
    });

    // Any other database error is thrown: the caller sends nothing.
    createError = Object.assign(new Error("connection lost"), { code: "P1001" });
    await assert.rejects(() => deps.insertPayment(row), /connection lost/);
  } finally {
    prismaAny.x402Payment = saved;
  }
});

test("a fate read that throws or does not come back is 'unknown', and the blockhash form is what is asked", async () => {
  const { readX402Fate } = await import("../services/buildX402PaymentsDeps.js");

  assert.deepEqual(
    await readX402Fate({ signature: "sig", blockhash: "hash" }, async () => {
      throw new Error(NODE_TEXT);
    }),
    { fate: "unknown" },
  );
  assert.deepEqual(
    await readX402Fate({ signature: "sig", blockhash: "hash" }, () => new Promise(() => {}), 5),
    { fate: "unknown" },
  );

  let asked: any = null;
  const reading = await readX402Fate({ signature: "sig", blockhash: "hash" }, async (input) => {
    asked = input;
    return {
      fate: "landed_ok",
      reason: "status_ok",
      signature: "sig",
      detail: { confirmationStatus: "finalized" },
    } as any;
  });
  assert.deepEqual(asked, { signature: "sig", lastValidBlockHeight: null, blockhash: "hash" });
  assert.deepEqual(reading, { fate: "landed_ok", confirmationStatus: "finalized" });
});
