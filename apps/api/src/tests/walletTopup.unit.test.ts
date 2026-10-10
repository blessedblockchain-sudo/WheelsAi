import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, Transaction } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/walletTopup.ts: the amount math (USDC
// exact, SOL from a quote in whole numbers), the payer check, the
// build→sign→accept round trip (simulating exactly what a browser wallet
// does: deserialize, sign, reserialize), and the exactly-once credit
// factory. What submit accepts beyond the exact bytes is in
// walletTopupAccept.unit.test.ts.

const PAYER = Keypair.fromSeed(new Uint8Array(32).fill(3));
const DEPOSIT = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58();
const STRANGER = Keypair.fromSeed(new Uint8Array(32).fill(5));
// Any 32-byte base58 string is a structurally valid blockhash.
const BLOCKHASH = Keypair.fromSeed(new Uint8Array(32).fill(6)).publicKey.toBase58();
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

async function importService() {
  setupEnv();
  return import("../services/walletTopup.js");
}

// ============================================
// Amount math
// ============================================

test("USDC amounts are exact integer math end to end", async () => {
  const { computeTopupAmounts } = await importService();
  const r = computeTopupAmounts({ asset: "USDC", amountUsd: 50 });
  assert.ok(r.ok);
  assert.equal(r.amountUsdCents, 5_000n);
  assert.equal(r.bonusCents, 500n, "$50 tier grants $5 bonus");
  assert.equal(r.amountRaw, "50000000", "$50 = 50_000_000 USDC base units");
  assert.equal(r.quotedSolPriceUsd, undefined, "no oracle in the USDC path");
});

const QUOTE_200 = {
  source: "static" as const,
  midMicroUsdPerSol: 200_000_000n,
  confMicroUsdPerSol: 0n,
  publishTime: 1_780_000_000,
  ageSeconds: 0,
  account: null,
};

test("SOL amounts come from the quote in whole numbers and record the price", async () => {
  const { computeTopupAmounts } = await importService();
  const r = computeTopupAmounts({ asset: "SOL", amountUsd: 50, quote: QUOTE_200, marginBps: 0 });
  assert.ok(r.ok);
  assert.equal(r.amountRaw, "250000000", "$50 at $200/SOL = 0.25 SOL");
  assert.equal(r.quotedSolPriceUsd, 200);
  assert.equal(r.quotePriceMicroUsd, 200_000_000n, "the exact price, micro-dollars per SOL");
  assert.equal(r.quotePublishTime?.toISOString(), new Date(1_780_000_000_000).toISOString());
  assert.equal(r.quoteSource, "static");
});

test("SOL is valued low and the lamports are rounded up", async () => {
  const { computeTopupAmounts } = await importService();
  const { lamportsToCollectForCents } = await import("../services/solPrice.js");
  // $150.00 mid with $0.75 of uncertainty and a 1% margin.
  const quote = {
    ...QUOTE_200,
    source: "pyth" as const,
    midMicroUsdPerSol: 150_000_000n,
    confMicroUsdPerSol: 750_000n,
  };
  const r = computeTopupAmounts({ asset: "SOL", amountUsd: 10, quote, marginBps: 100 });
  assert.ok(r.ok);
  // The amount is the money-in helper's, to the lamport.
  const helper = lamportsToCollectForCents(quote, 1_000n, 100);
  assert.ok(helper.ok);
  assert.equal(r.amountRaw, helper.lamports.toString());
  // (150 - 0.75) * 0.99 = 147.7575 dollars per SOL.
  assert.equal(r.quotePriceMicroUsd, 147_757_500n);
  assert.equal(r.quotedSolPriceUsd, 147.7575);
  // Rounded up: the lamports are worth at least the cents credited.
  const lamports = BigInt(r.amountRaw);
  assert.ok(lamports * 147_757_500n >= 1_000n * 10_000n * 1_000_000_000n);
  assert.ok((lamports - 1n) * 147_757_500n < 1_000n * 10_000n * 1_000_000_000n);
  assert.equal(r.quoteSource, "pyth");
});

test("solMicroUsdRate is the leaned price as a whole number", async () => {
  const { solMicroUsdRate, solUsdRate } = await import("../services/solPrice.js");
  const quote = { ...QUOTE_200, midMicroUsdPerSol: 110_250_000n, confMicroUsdPerSol: 0n };
  const exact = solMicroUsdRate(quote, "in", 0);
  assert.deepEqual(exact, { ok: true, microUsdPerSol: 110_250_000n });
  const shown = solUsdRate(quote, "in", 0);
  assert.ok(shown.ok);
  assert.equal(shown.usdPerSol, 110.25);
  // In counts SOL low, out counts it high.
  const leaning = { ...quote, confMicroUsdPerSol: 250_000n };
  assert.deepEqual(solMicroUsdRate(leaning, "in", 0), { ok: true, microUsdPerSol: 110_000_000n });
  assert.deepEqual(solMicroUsdRate(leaning, "out", 0), { ok: true, microUsdPerSol: 110_500_000n });
  // Rounded down when the margin leaves a fraction of a micro-dollar.
  assert.deepEqual(solMicroUsdRate({ ...quote, midMicroUsdPerSol: 3n }, "in", 1), {
    ok: true,
    microUsdPerSol: 2n,
  });
  // The refusals of the other helpers.
  assert.deepEqual(solMicroUsdRate(quote, "in", 10_000), { ok: false, code: "bad_margin" });
  assert.deepEqual(solMicroUsdRate({ ...quote, confMicroUsdPerSol: 110_250_000n }, "in", 0), {
    ok: false,
    code: "no_value",
  });
});

test("SOL without a quote, and out-of-bounds amounts, are refused with a code", async () => {
  const { computeTopupAmounts } = await importService();
  const noQuote = computeTopupAmounts({ asset: "SOL", amountUsd: 50 });
  assert.ok(!noQuote.ok && noQuote.code === "price_unavailable");
  const worthless = computeTopupAmounts({
    asset: "SOL",
    amountUsd: 50,
    quote: { ...QUOTE_200, confMicroUsdPerSol: 200_000_000n },
  });
  assert.ok(!worthless.ok && worthless.code === "price_unavailable");
  const tooSmall = computeTopupAmounts({ asset: "USDC", amountUsd: 2 });
  assert.ok(!tooSmall.ok && tooSmall.code === "invalid_amount");
  const tooBig = computeTopupAmounts({ asset: "USDC", amountUsd: 999_999 });
  assert.ok(!tooBig.ok && tooBig.code === "invalid_amount");
  // The amount is judged before the price: a bad amount is a bad amount
  // with or without a quote.
  const badBoth = computeTopupAmounts({ asset: "SOL", amountUsd: 2 });
  assert.ok(!badBoth.ok && badBoth.code === "invalid_amount");
});

test("USDC is cents times 10,000, for amounts with cents too", async () => {
  const { computeTopupAmounts } = await importService();
  const r = computeTopupAmounts({ asset: "USDC", amountUsd: 19.99 });
  assert.ok(r.ok);
  assert.equal(r.amountUsdCents, 1_999n);
  assert.equal(r.amountRaw, "19990000");
  assert.equal(r.quotePriceMicroUsd, undefined);
  assert.equal(r.quoteSource, undefined);
});

test("the hold is 60 seconds for SOL and 120 for USDC", async () => {
  const { topupTtlSeconds } = await importService();
  assert.equal(topupTtlSeconds("SOL"), 60);
  assert.equal(topupTtlSeconds("USDC"), 120);
});

// ============================================
// The payer
// ============================================

test("a payer is a wallet address on the curve and never one of ours", async () => {
  const { checkPayerAddress } = await importService();
  const { PublicKey } = await import("@solana/web3.js");
  const wallet = PAYER.publicKey.toBase58();
  assert.deepEqual(checkPayerAddress(wallet, []), { ok: true, address: wallet });
  assert.deepEqual(checkPayerAddress(`  ${wallet} `, []), { ok: true, address: wallet });
  assert.deepEqual(checkPayerAddress(wallet, [DEPOSIT, wallet]), {
    ok: false,
    reason: "platform_address",
  });
  for (const bad of ["", "not-base58-0OIl", "abc", wallet.slice(0, 20), `${wallet}${wallet}`]) {
    const r = checkPayerAddress(bad, []);
    assert.ok(!r.ok && r.reason === "not_an_address", bad);
  }
  // An address off the curve belongs to a program and cannot sign.
  const [offCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("x")],
    new PublicKey("11111111111111111111111111111111"),
  );
  assert.deepEqual(checkPayerAddress(offCurve.toBase58(), []), { ok: false, reason: "off_curve" });
});

// ============================================
// Build → sign → verify round trip
// ============================================

function buildArgs(over: Record<string, unknown> = {}) {
  return {
    asset: "SOL" as const,
    payerAddress: PAYER.publicKey.toBase58(),
    depositAddress: DEPOSIT,
    amountRaw: "250000000",
    topupId: "11111111-2222-4333-8444-555555555555",
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 1_000,
    usdcMint: DEVNET_USDC,
    ...over,
  };
}

/** What a browser wallet does: deserialize, sign, reserialize. */
function walletSign(unsignedTxBase64: string, signer: Keypair): string {
  const tx = Transaction.from(Buffer.from(unsignedTxBase64, "base64"));
  tx.sign(signer);
  return tx.serialize().toString("base64");
}

test("a correctly signed prepared tx passes the byte-equality gate", async () => {
  const { buildTopupTransaction, acceptSignedTopupTransaction } =
    await importService();
  const built = buildTopupTransaction(buildArgs());
  const signed = walletSign(built.unsignedTxBase64, PAYER);
  const verdict = acceptSignedTopupTransaction({
    signedTxBase64: signed,
    unsignedMessageB64: built.unsignedMessageB64,
    payerAddress: PAYER.publicKey.toBase58(),
  });
  assert.ok(verdict.ok, `expected ok, got ${JSON.stringify(verdict)}`);
  assert.ok(verdict.txSignatureB58.length > 60, "base58 signature extracted");
  assert.equal(verdict.rawTxBase64, signed);
  assert.equal(verdict.exact, true);
  assert.equal(verdict.addedInstructions, 0);
});

test("USDC build produces a signable tx (ATA create + transferChecked + memo)", async () => {
  const { buildTopupTransaction, acceptSignedTopupTransaction } =
    await importService();
  const built = buildTopupTransaction(
    buildArgs({ asset: "USDC", amountRaw: "50000000" }),
  );
  const signed = walletSign(built.unsignedTxBase64, PAYER);
  const verdict = acceptSignedTopupTransaction({
    signedTxBase64: signed,
    unsignedMessageB64: built.unsignedMessageB64,
    payerAddress: PAYER.publicKey.toBase58(),
  });
  assert.ok(verdict.ok, `expected ok, got ${JSON.stringify(verdict)}`);
});

test("a tx signed over DIFFERENT content is rejected as message_mismatch", async () => {
  const { buildTopupTransaction, acceptSignedTopupTransaction } =
    await importService();
  const built = buildTopupTransaction(buildArgs());
  // Attacker signs a look-alike paying a different amount…
  const tampered = buildTopupTransaction(buildArgs({ amountRaw: "1" }));
  const signed = walletSign(tampered.unsignedTxBase64, PAYER);
  // …and submits it against the original row.
  const verdict = acceptSignedTopupTransaction({
    signedTxBase64: signed,
    unsignedMessageB64: built.unsignedMessageB64,
    payerAddress: PAYER.publicKey.toBase58(),
  });
  assert.ok(!verdict.ok && verdict.code === "message_mismatch");
});

test("the memo pins the row id: same params, different row → different message", async () => {
  const { buildTopupTransaction } = await importService();
  const a = buildTopupTransaction(buildArgs());
  const b = buildTopupTransaction(
    buildArgs({ topupId: "99999999-8888-4777-8666-555555555555" }),
  );
  assert.notEqual(a.unsignedMessageB64, b.unsignedMessageB64);
});

test("an unsigned submission is refused as unreadable (missing signature)", async () => {
  const { buildTopupTransaction, acceptSignedTopupTransaction } =
    await importService();
  const built = buildTopupTransaction(buildArgs());
  const verdict = acceptSignedTopupTransaction({
    signedTxBase64: built.unsignedTxBase64,
    unsignedMessageB64: built.unsignedMessageB64,
    payerAddress: PAYER.publicKey.toBase58(),
  });
  assert.ok(!verdict.ok && verdict.code === "unreadable_transaction");
  assert.ok(!verdict.ok && verdict.reason === "missing_signature");
});

test("a signature from the WRONG key is rejected as invalid_signature", async () => {
  const { buildTopupTransaction, acceptSignedTopupTransaction } =
    await importService();
  const { VersionedTransaction } = await import("@solana/web3.js");
  const nacl = (await import("tweetnacl")).default;
  const built = buildTopupTransaction(buildArgs());
  const vtx = VersionedTransaction.deserialize(
    Buffer.from(built.unsignedTxBase64, "base64"),
  );
  // Forge: a real signature over the right bytes, from the wrong key.
  vtx.signatures[0] = nacl.sign.detached(
    vtx.message.serialize(),
    STRANGER.secretKey,
  );
  const verdict = acceptSignedTopupTransaction({
    signedTxBase64: Buffer.from(vtx.serialize()).toString("base64"),
    unsignedMessageB64: built.unsignedMessageB64,
    payerAddress: PAYER.publicKey.toBase58(),
  });
  assert.ok(!verdict.ok && verdict.code === "message_mismatch");
  assert.ok(!verdict.ok && verdict.reason === "invalid_signature");
});

test("garbage bytes are rejected as unparseable", async () => {
  const { acceptSignedTopupTransaction } = await importService();
  const verdict = acceptSignedTopupTransaction({
    signedTxBase64: Buffer.from("not a transaction").toString("base64"),
    unsignedMessageB64: "irrelevant",
    payerAddress: PAYER.publicKey.toBase58(),
  });
  assert.ok(!verdict.ok && verdict.code === "unreadable_transaction");
  assert.ok(!verdict.ok && verdict.reason === "unparseable");
});

test("blockhashFromMessageB64 recovers the pinned blockhash", async () => {
  const { buildTopupTransaction, blockhashFromMessageB64 } =
    await importService();
  const built = buildTopupTransaction(buildArgs());
  assert.equal(blockhashFromMessageB64(built.unsignedMessageB64), BLOCKHASH);
});

// ============================================
// Exactly-once crediting
// ============================================

interface LedgerRow {
  type: string;
  amountCents: bigint;
  balanceAfter: bigint;
  referenceId: string;
  description: string;
}

function makeCreditDb(initial = 0n, casCount = 1) {
  const state = {
    balance: initial,
    ledger: [] as LedgerRow[],
    casCalls: [] as unknown[],
  };
  const tx = {
    walletTopUp: {
      updateMany: async (args: unknown) => {
        state.casCalls.push(args);
        return { count: casCount };
      },
    },
    creditBalance: {
      upsert: async (args: { update: { balanceCents: { increment: bigint } } }) => {
        state.balance += args.update.balanceCents.increment;
        return { balanceCents: state.balance };
      },
      update: async (args: { data: { balanceCents: { increment: bigint } } }) => {
        state.balance += args.data.balanceCents.increment;
        return { balanceCents: state.balance };
      },
    },
    creditTransaction: {
      create: async (args: { data: LedgerRow }) => {
        state.ledger.push(args.data);
        return {};
      },
    },
  };
  const db = {
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };
  return { db, state };
}

test("winning the CAS grants once, with the topup id as the ledger reference", async () => {
  const { makeCreditTopup } = await importService();
  const { db, state } = makeCreditDb(1_000n, 1);
  const credit = makeCreditTopup(db as never);
  const result = await credit({
    topupId: "topup_row_1",
    orgId: "org_1",
    amountUsdCents: 5_000n,
    bonusCents: 500n,
    asset: "SOL",
    network: "solana:devnet",
  });
  assert.ok(result.credited);
  assert.equal(result.grantedCents, 5_500n);
  assert.equal(result.balanceAfterCents, 6_500n);
  assert.equal(state.ledger.length, 2, "purchase + bonus rows");
  assert.ok(state.ledger.every((r) => r.referenceId === "topup_row_1"));
  assert.ok(
    state.ledger.every((r) => r.description.startsWith("[devnet] ")),
    "devnet grants are labeled",
  );
  const cas = state.casCalls[0] as {
    where: { id: string; status: { in: string[] } };
    data: { status: string };
  };
  assert.deepEqual(cas.where.status.in, ["submitting", "submitted"]);
  assert.equal(cas.data.status, "credited");
});

test("losing the CAS moves NO money — the exactly-once barrier", async () => {
  const { makeCreditTopup } = await importService();
  const { db, state } = makeCreditDb(1_000n, 0);
  const credit = makeCreditTopup(db as never);
  const result = await credit({
    topupId: "topup_row_1",
    orgId: "org_1",
    amountUsdCents: 5_000n,
    bonusCents: 500n,
    asset: "SOL",
    network: "solana:devnet",
  });
  assert.equal(result.credited, false);
  assert.equal(state.balance, 1_000n, "balance untouched");
  assert.equal(state.ledger.length, 0, "no ledger rows");
});

test("mainnet grants carry no devnet label", async () => {
  const { makeCreditTopup } = await importService();
  const { db, state } = makeCreditDb(0n, 1);
  const credit = makeCreditTopup(db as never);
  await credit({
    topupId: "t2",
    orgId: "org_1",
    amountUsdCents: 10_000n,
    bonusCents: 0n,
    asset: "USDC",
    network: "solana:mainnet",
  });
  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0]!.description, "Wallet top-up (USDC)");
});
