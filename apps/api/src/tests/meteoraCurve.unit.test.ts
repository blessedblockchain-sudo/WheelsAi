import assert from "node:assert/strict";
import test from "node:test";
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  CURVE_PREPARE_TTL_SECONDS,
  CURVE_QUOTE_MINT,
  CurveUnreadableError,
  buildTradeQuote,
  buildTradeRow,
  checkSignedTransaction,
  compileCurveTransaction,
  createCurveReader,
  deriveCurveState,
  describeCurve,
  formatUnits,
  marketCapLamportsFromSqrtPrice,
  messageHashOf,
  minimumOutFor,
  parseUnits,
  priceSolFromSqrtPrice,
  readTradeAmounts,
  signCurvePrepareToken,
  tokensGainedByWallet,
  unitsThatLeftAccount,
  verifyCurvePrepareToken,
  type ConfirmedTransactionRead,
  type CurvePreparePayload,
  type CurveSnapshot,
} from "../services/meteoraCurve.js";
import { signState } from "../services/signedState.js";

// Drives apps/api/src/services/meteoraCurve.ts: the curve's state from a
// pool reading, the quote's arithmetic, the prepare token, the check that a
// signed transaction is the one that was built, and what a confirmed
// transaction moved. Nothing here touches a network: every keypair is made
// in memory and the chain is a plain object.

const SECRET = "test-curve-secret-1234567890abcd";
const BLOCKHASH = "11111111111111111111111111111111";
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(11));
const position = Keypair.fromSeed(new Uint8Array(32).fill(12));
const MINT = Keypair.fromSeed(new Uint8Array(32).fill(13)).publicKey.toBase58();
const POOL = Keypair.fromSeed(new Uint8Array(32).fill(14)).publicKey.toBase58();
const CONFIG = Keypair.fromSeed(new Uint8Array(32).fill(15)).publicKey.toBase58();
const VAULT = Keypair.fromSeed(new Uint8Array(32).fill(16)).publicKey.toBase58();
const DAMM_POOL = Keypair.fromSeed(new Uint8Array(32).fill(17)).publicKey.toBase58();
const WALLET = wallet.publicKey.toBase58();

function snapshot(overrides: Partial<CurveSnapshot> = {}): CurveSnapshot {
  return {
    poolAddress: POOL,
    configAddress: CONFIG,
    mintAddress: MINT,
    creatorAddress: WALLET,
    quoteVault: VAULT,
    // 2^54: one raw token unit costs 2^-20 lamports.
    sqrtPrice: 1n << 54n,
    quoteReserve: 1_250_000_000n,
    migrationQuoteThreshold: 64_000_000_000n,
    isMigrated: false,
    creatorClaimableLamports: 2_329_499n,
    creatorFeeSharePercent: 70,
    lockedVesting: { amountPerPeriod: 0n, cliffUnlockAmount: 0n, cliffSeconds: 0, periods: 0, frequencySeconds: 0 },
    graduatedPoolAddress: DAMM_POOL,
    handle: null,
    ...overrides,
  };
}

function memo(signers: PublicKey[], text: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO,
    keys: signers.map((pubkey) => ({ pubkey, isSigner: true, isWritable: false })),
    data: Buffer.from(text, "utf8"),
  });
}

// ============================================
// Decimal strings
// ============================================

test("parseUnits: a typed amount becomes raw units, exactly", () => {
  assert.equal(parseUnits("0.1", 9), 100_000_000n);
  assert.equal(parseUnits("1", 9), 1_000_000_000n);
  assert.equal(parseUnits("4650000.12", 6), 4_650_000_120_000n);
  assert.equal(parseUnits("0.000000001", 9), 1n);
  assert.equal(parseUnits("0", 9), 0n);
});

test("parseUnits: anything that is not a plain amount is refused, and nothing is rounded", () => {
  for (const bad of ["", "abc", "-1", "1e3", "1,5", ".5", "1.", "0x10", " ", "1 2"]) {
    assert.equal(parseUnits(bad, 9), null, `"${bad}"`);
  }
  // One decimal more than the unit has.
  assert.equal(parseUnits("0.0000000001", 9), null);
  assert.equal(parseUnits("1.0000001", 6), null);
  // More than a u64 holds.
  assert.equal(parseUnits("18446744073709.551616", 6), null);
  assert.equal(parseUnits("18446744073709.551615", 6), 18_446_744_073_709_551_615n);
});

test("formatUnits: raw units as a decimal string without trailing zeros", () => {
  assert.equal(formatUnits(1_250_000_000n, 9), "1.25");
  assert.equal(formatUnits(64_000_000_000n, 9), "64");
  assert.equal(formatUnits(2_329_499n, 9), "0.002329499");
  assert.equal(formatUnits(0n, 9), "0");
  assert.equal(formatUnits(1n, 6), "0.000001");
});

test("price and market cap come from the square-root price in whole numbers", () => {
  // 2^64: one raw unit costs one lamport, so a token (1e6 units) costs 0.001 SOL.
  assert.equal(priceSolFromSqrtPrice(1n << 64n), "0.001");
  assert.equal(marketCapLamportsFromSqrtPrice(1n << 64n), 1_000_000_000_000_000n);
  // 2^54: 2^-20 lamports a unit; 1e12 / 2^20 = 953674.3 at 15 decimals.
  assert.equal(priceSolFromSqrtPrice(1n << 54n), "0.000000000953674");
  // 1e15 units / 2^20 = 953674316 lamports (rounded down).
  assert.equal(marketCapLamportsFromSqrtPrice(1n << 54n), 953_674_316n);
});

// ============================================
// The state of a curve
// ============================================

test("state: trading while the pool has raised less than its threshold", () => {
  assert.equal(deriveCurveState(snapshot()), "trading");
  assert.equal(deriveCurveState(snapshot({ quoteReserve: 63_999_999_999n })), "trading");
});

test("state: full once the threshold is reached and the pool has not moved", () => {
  assert.equal(deriveCurveState(snapshot({ quoteReserve: 64_000_000_000n })), "full");
  assert.equal(deriveCurveState(snapshot({ quoteReserve: 64_000_000_123n })), "full");
});

test("state: graduated when the pool says it has migrated, whatever it holds", () => {
  assert.equal(deriveCurveState(snapshot({ quoteReserve: 64_000_000_000n, isMigrated: true })), "graduated");
  assert.equal(deriveCurveState(snapshot({ quoteReserve: 0n, isMigrated: true })), "graduated");
});

test("describeCurve: a trading pool, every field of the answer", () => {
  const json = describeCurve(
    {
      snapshot: snapshot(),
      currentPoint: 1_800_000_000n,
      feeNumerator: 12_000_000n,
      readAt: new Date("2026-10-12T14:00:00.000Z"),
    },
    "devnet",
  );
  assert.deepEqual(json, {
    launchpad: "meteora",
    network: "devnet",
    mintAddress: MINT,
    poolAddress: POOL,
    configAddress: CONFIG,
    state: "trading",
    priceSol: "0.000000000953674",
    marketCapSol: "0.953674316",
    raisedLamports: "1250000000",
    raisedSol: "1.25",
    graduationLamports: "64000000000",
    graduationSol: "64",
    progress: 0.019531,
    feePercentNow: "1.2",
    creatorAddress: WALLET,
    creatorClaimableLamports: "2329499",
    creatorClaimableSol: "0.002329499",
    creatorFeeSharePercent: 70,
    creatorLocked: null,
    // Known before graduation, said only after it.
    graduatedPoolAddress: null,
    readAt: "2026-10-12T14:00:00.000Z",
  });
});

test("describeCurve: a full pool is at progress 1 and still names no graduated pool", () => {
  const json = describeCurve(
    {
      snapshot: snapshot({ quoteReserve: 64_000_000_500n }),
      currentPoint: 0n,
      feeNumerator: 10_000_000n,
      readAt: new Date("2026-10-12T14:00:00.000Z"),
    },
    "mainnet-beta",
  );
  assert.equal(json.state, "full");
  assert.equal(json.progress, 1);
  assert.equal(json.feePercentNow, "1");
  assert.equal(json.network, "mainnet-beta");
  assert.equal(json.graduatedPoolAddress, null);
});

test("describeCurve: a graduated pool names the DAMM v2 pool", () => {
  const json = describeCurve(
    {
      snapshot: snapshot({ quoteReserve: 64_000_000_000n, isMigrated: true }),
      currentPoint: 0n,
      feeNumerator: 10_000_000n,
      readAt: new Date("2026-10-12T14:00:00.000Z"),
    },
    "devnet",
  );
  assert.equal(json.state, "graduated");
  assert.equal(json.graduatedPoolAddress, DAMM_POOL);
});

test("describeCurve: the creator's locked tokens are read from the config", () => {
  const json = describeCurve(
    {
      snapshot: snapshot({
        lockedVesting: {
          // 100,000,000 tokens in 12 parts: what does not divide waits at the cliff.
          amountPerPeriod: 8_333_333_333_333n,
          cliffUnlockAmount: 4n,
          cliffSeconds: 2_592_000,
          periods: 12,
          frequencySeconds: 2_592_000,
        },
      }),
      currentPoint: 0n,
      feeNumerator: 10_000_000n,
      readAt: new Date("2026-10-12T14:00:00.000Z"),
    },
    "devnet",
  );
  assert.deepEqual(json.creatorLocked, {
    amount: "100000000",
    cliffSeconds: 2_592_000,
    periods: 12,
    totalSeconds: 31_104_000,
  });
});

// ============================================
// Reading a pool, a few seconds at a time
// ============================================

function countingChain(result: () => CurveSnapshot | null) {
  const calls = { readCurve: 0, currentPoint: 0 };
  return {
    calls,
    chain: {
      readCurve: async () => {
        calls.readCurve += 1;
        return result();
      },
      currentPoint: async () => {
        calls.currentPoint += 1;
        return 1_800_000_000n;
      },
      tradeFeeNumerator: () => 10_000_000n,
    },
  };
}

test("reader: a reading is kept for the cache time, then read again", async () => {
  let nowMs = Date.parse("2026-10-12T14:00:00.000Z");
  const { chain, calls } = countingChain(() => snapshot());
  const reader = createCurveReader({ chain, cacheMs: 5000, now: () => new Date(nowMs) });

  const first = await reader.read(POOL);
  nowMs += 4999;
  const second = await reader.read(POOL);
  assert.equal(calls.readCurve, 1);
  assert.equal(second, first);

  nowMs += 1;
  await reader.read(POOL);
  assert.equal(calls.readCurve, 2);
});

test("reader: fresh skips what is kept, and drop forgets it", async () => {
  const { chain, calls } = countingChain(() => snapshot());
  const reader = createCurveReader({ chain, cacheMs: 5000, now: () => new Date("2026-10-12T14:00:00.000Z") });

  await reader.read(POOL);
  await reader.read(POOL, { fresh: true });
  assert.equal(calls.readCurve, 2);
  await reader.read(POOL);
  assert.equal(calls.readCurve, 2);
  reader.drop(POOL);
  await reader.read(POOL);
  assert.equal(calls.readCurve, 3);
});

test("reader: calls that arrive during one read share it", async () => {
  const { chain, calls } = countingChain(() => snapshot());
  const reader = createCurveReader({ chain, cacheMs: 5000, now: () => new Date("2026-10-12T14:00:00.000Z") });
  const [a, b, c] = await Promise.all([reader.read(POOL), reader.read(POOL), reader.read(POOL)]);
  assert.equal(calls.readCurve, 1);
  assert.equal(a, b);
  assert.equal(b, c);
});

test("reader: no pool, or a failed read, is CurveUnreadableError and is not kept", async () => {
  let fail = true;
  const { chain, calls } = countingChain(() => {
    if (fail) throw new Error("429 Too Many Requests");
    return snapshot();
  });
  const reader = createCurveReader({ chain, cacheMs: 5000, now: () => new Date("2026-10-12T14:00:00.000Z") });
  await assert.rejects(reader.read(POOL), CurveUnreadableError);
  fail = false;
  const reading = await reader.read(POOL);
  assert.equal(reading.snapshot.poolAddress, POOL);
  assert.equal(calls.readCurve, 2);

  const missing = createCurveReader({
    chain: countingChain(() => null).chain,
    cacheMs: 5000,
    now: () => new Date(),
  });
  await assert.rejects(missing.read(POOL), CurveUnreadableError);
});

// ============================================
// A quote
// ============================================

test("quote: the least accepted is the amount out less the allowance, rounded down", () => {
  assert.equal(minimumOutFor(4_650_000_120_000n, 100), 4_603_500_118_800n);
  assert.equal(minimumOutFor(1_000n, 5000), 500n);
  assert.equal(minimumOutFor(999n, 1), 998n);
});

test("quote: a buy pays SOL and gets tokens", () => {
  const quote = buildTradeQuote({
    side: "buy",
    amountInRaw: 100_000_000n,
    slippageBps: 100,
    swap: { amountOut: 4_650_000_120_000n, feeLamports: 1_200_000n, nextSqrtPrice: 1n << 64n },
  });
  assert.deepEqual(quote, {
    side: "buy",
    amountIn: "0.1",
    amountInRaw: "100000000",
    amountOut: "4650000.12",
    amountOutRaw: "4650000120000",
    minimumOut: "4603500.1188",
    minimumOutRaw: "4603500118800",
    feeSol: "0.0012",
    priceSolAfter: "0.001",
  });
});

test("quote: a sell pays tokens and gets SOL", () => {
  const quote = buildTradeQuote({
    side: "sell",
    amountInRaw: 2_500_000_000n,
    slippageBps: 250,
    swap: { amountOut: 48_000_000n, feeLamports: 480_000n, nextSqrtPrice: 1n << 54n },
  });
  assert.deepEqual(quote, {
    side: "sell",
    amountIn: "2500",
    amountInRaw: "2500000000",
    amountOut: "0.048",
    amountOutRaw: "48000000",
    minimumOut: "0.0468",
    minimumOutRaw: "46800000",
    feeSol: "0.00048",
    priceSolAfter: "0.000000000953674",
  });
});

// ============================================
// The prepare token
// ============================================

const NOW = new Date("2026-10-12T14:00:00.500Z");

function tradePayload(overrides: Partial<CurvePreparePayload> = {}): CurvePreparePayload {
  return {
    kind: "trade",
    tokenId: "0b0f7c0e-6f1d-4d7c-9d55-1c5f0a2b3c4d",
    mintAddress: MINT,
    poolAddress: POOL,
    quoteVault: VAULT,
    wallet: WALLET,
    userId: "user_1",
    orgId: "org_1",
    messageHash: "ab".repeat(32),
    lastValidBlockHeight: 1234,
    trade: { side: "buy", solLamports: "100000000", tokenAmountRaw: "4650000120000" },
    ...overrides,
  };
}

test("prepare token: what was signed comes back, and it runs out 90 seconds later", () => {
  const payload = tradePayload();
  const { token, expiresAt } = signCurvePrepareToken({ payload, secret: SECRET, now: () => NOW });
  assert.equal(CURVE_PREPARE_TTL_SECONDS, 90);
  assert.equal(expiresAt.toISOString(), "2026-10-12T14:01:30.000Z");

  const verified = verifyCurvePrepareToken({ token, secret: SECRET, now: () => NOW });
  assert.ok(verified.ok);
  for (const [key, value] of Object.entries(payload)) {
    assert.deepEqual((verified.payload as unknown as Record<string, unknown>)[key], value, key);
  }

  const lastSecond = new Date("2026-10-12T14:01:29.999Z");
  assert.ok(verifyCurvePrepareToken({ token, secret: SECRET, now: () => lastSecond }).ok);
  const tooLate = new Date("2026-10-12T14:01:30.000Z");
  assert.deepEqual(verifyCurvePrepareToken({ token, secret: SECRET, now: () => tooLate }), {
    ok: false,
    reason: "expired",
  });
});

test("prepare token: a changed payload, another secret and a token of another purpose are refused", () => {
  const { token } = signCurvePrepareToken({ payload: tradePayload(), secret: SECRET, now: () => NOW });
  const [header, body, signature] = token.split(".") as [string, string, string];

  const forged = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  forged.wallet = Keypair.generate().publicKey.toBase58();
  const forgedBody = Buffer.from(JSON.stringify(forged), "utf8").toString("base64url");
  assert.deepEqual(verifyCurvePrepareToken({ token: `${header}.${forgedBody}.${signature}`, secret: SECRET, now: () => NOW }), {
    ok: false,
    reason: "bad_signature",
  });

  assert.deepEqual(
    verifyCurvePrepareToken({ token, secret: "another-secret-1234567890abcdef", now: () => NOW }),
    { ok: false, reason: "bad_signature" },
  );
  assert.deepEqual(verifyCurvePrepareToken({ token: "not-a-token", secret: SECRET, now: () => NOW }), {
    ok: false,
    reason: "malformed",
  });

  // Signed with the same secret by the same primitive, for something else.
  const other = signState({ payload: { ...tradePayload(), purpose: "slack-install" }, secret: SECRET, now: () => NOW });
  assert.deepEqual(verifyCurvePrepareToken({ token: other, secret: SECRET, now: () => NOW }), {
    ok: false,
    reason: "wrong_purpose",
  });
});

test("prepare token: a payload without what its kind must record is refused", () => {
  const cases: CurvePreparePayload[] = [
    tradePayload({ trade: undefined }),
    tradePayload({ trade: { side: "buy", solLamports: "1.5", tokenAmountRaw: "10" } }),
    tradePayload({ kind: "fees", trade: undefined }),
    tradePayload({ kind: "graduate", trade: undefined }),
    tradePayload({ messageHash: "short" }),
  ];
  for (const payload of cases) {
    const { token } = signCurvePrepareToken({ payload, secret: SECRET, now: () => NOW });
    assert.deepEqual(verifyCurvePrepareToken({ token, secret: SECRET, now: () => NOW }), {
      ok: false,
      reason: "payload_invalid",
    });
  }
  const fees = signCurvePrepareToken({
    payload: tradePayload({ kind: "fees", trade: undefined, fees: { claimableLamports: "2329499" } }),
    secret: SECRET,
    now: () => NOW,
  });
  assert.ok(verifyCurvePrepareToken({ token: fees.token, secret: SECRET, now: () => NOW }).ok);
  const graduate = signCurvePrepareToken({
    payload: tradePayload({
      kind: "graduate",
      trade: undefined,
      graduate: { step: "migrate", graduatedPoolAddress: DAMM_POOL },
    }),
    secret: SECRET,
    now: () => NOW,
  });
  assert.ok(verifyCurvePrepareToken({ token: graduate.token, secret: SECRET, now: () => NOW }).ok);
});

// ============================================
// Is the signed transaction the one that was built?
// ============================================

test("compile: an unsigned v0 transaction with the wallet paying", () => {
  const compiled = compileCurveTransaction({
    payer: WALLET,
    blockhash: BLOCKHASH,
    instructions: [memo([wallet.publicKey], "buy")],
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(compiled.base64, "base64"));
  assert.equal(tx.version, 0);
  assert.equal(tx.message.staticAccountKeys[0]?.toBase58(), WALLET);
  assert.equal(tx.message.header.numRequiredSignatures, 1);
  assert.ok(tx.signatures[0]?.every((byte) => byte === 0));
  assert.equal(compiled.messageHash, messageHashOf(tx));
  assert.match(compiled.messageHash, /^[0-9a-f]{64}$/);
});

test("compile: given signers are signed for, the payer's slot stays empty", () => {
  const compiled = compileCurveTransaction({
    payer: WALLET,
    blockhash: BLOCKHASH,
    instructions: [memo([wallet.publicKey, position.publicKey], "migrate")],
    signers: [position],
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(compiled.base64, "base64"));
  assert.equal(tx.message.header.numRequiredSignatures, 2);
  assert.ok(tx.signatures[0]?.every((byte) => byte === 0), "the payer has not signed");
  assert.ok(tx.signatures[1]?.some((byte) => byte !== 0), "the position keypair has");
});

test("compile: a transaction over 1,232 bytes is refused here, not at the wallet", () => {
  assert.throws(
    () =>
      compileCurveTransaction({
        payer: WALLET,
        blockhash: BLOCKHASH,
        instructions: [memo([wallet.publicKey], "x".repeat(1300))],
      }),
    /1232 bytes/,
  );
});

test("signed transaction: the one that was built, fully signed, passes", () => {
  const compiled = compileCurveTransaction({
    payer: WALLET,
    blockhash: BLOCKHASH,
    instructions: [memo([wallet.publicKey], "buy")],
  });
  compiled.tx.sign([wallet]);
  const signed = Buffer.from(compiled.tx.serialize()).toString("base64");
  const checked = checkSignedTransaction(signed, compiled.messageHash);
  assert.ok(checked.ok);
  assert.deepEqual(Buffer.from(checked.raw), Buffer.from(compiled.tx.serialize()));
});

test("signed transaction: another message is refused, however well it is signed", () => {
  const built = compileCurveTransaction({
    payer: WALLET,
    blockhash: BLOCKHASH,
    instructions: [memo([wallet.publicKey], "buy 0.1")],
  });
  const tampered = compileCurveTransaction({
    payer: WALLET,
    blockhash: BLOCKHASH,
    instructions: [memo([wallet.publicKey], "buy 9.9")],
  });
  tampered.tx.sign([wallet]);
  const signed = Buffer.from(tampered.tx.serialize()).toString("base64");
  assert.deepEqual(checkSignedTransaction(signed, built.messageHash), { ok: false, reason: "message_mismatch" });
});

test("signed transaction: an empty signature slot is refused", () => {
  const unsigned = compileCurveTransaction({
    payer: WALLET,
    blockhash: BLOCKHASH,
    instructions: [memo([wallet.publicKey], "buy")],
  });
  assert.deepEqual(checkSignedTransaction(unsigned.base64, unsigned.messageHash), {
    ok: false,
    reason: "missing_signature",
  });

  // Two signatures needed; only the server's is there.
  const half = compileCurveTransaction({
    payer: WALLET,
    blockhash: BLOCKHASH,
    instructions: [memo([wallet.publicKey, position.publicKey], "migrate")],
    signers: [position],
  });
  assert.deepEqual(checkSignedTransaction(half.base64, half.messageHash), {
    ok: false,
    reason: "missing_signature",
  });
  half.tx.sign([wallet]);
  assert.ok(checkSignedTransaction(Buffer.from(half.tx.serialize()).toString("base64"), half.messageHash).ok);
});

test("signed transaction: bytes that are no transaction are refused", () => {
  assert.deepEqual(checkSignedTransaction("", "ab".repeat(32)), { ok: false, reason: "undecodable" });
  assert.deepEqual(checkSignedTransaction("not base64 at all", "ab".repeat(32)), {
    ok: false,
    reason: "undecodable",
  });
});

// ============================================
// What a confirmed transaction moved
// ============================================

const OTHER = Keypair.fromSeed(new Uint8Array(32).fill(18)).publicKey.toBase58();

function confirmed(overrides: Partial<ConfirmedTransactionRead> = {}): ConfirmedTransactionRead {
  return {
    blockTime: 1_791_813_600,
    accountKeys: [WALLET, "WalletTokenAccount", VAULT, "BaseVault"],
    preTokenBalances: [],
    postTokenBalances: [],
    ...overrides,
  };
}

test("buy: the tokens are the wallet's balance change, from zero for a new account", () => {
  const tx = confirmed({
    preTokenBalances: [{ accountIndex: 3, mint: MINT, owner: "PoolAuthority", amountRaw: "900000000000000" }],
    postTokenBalances: [
      { accountIndex: 1, mint: MINT, owner: WALLET, amountRaw: "4649999000000" },
      { accountIndex: 3, mint: MINT, owner: "PoolAuthority", amountRaw: "895350001000000" },
    ],
  });
  assert.equal(tokensGainedByWallet(tx, WALLET, MINT), 4_649_999_000_000n);
  assert.equal(tokensGainedByWallet(tx, OTHER, MINT), null);

  const topUp = confirmed({
    preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: WALLET, amountRaw: "1000000" }],
    postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: WALLET, amountRaw: "3500000" }],
  });
  assert.equal(tokensGainedByWallet(topUp, WALLET, MINT), 2_500_000n);
});

test("sell: the SOL is what left the pool's vault", () => {
  const tx = confirmed({
    preTokenBalances: [{ accountIndex: 2, mint: CURVE_QUOTE_MINT, owner: "PoolAuthority", amountRaw: "1250000000" }],
    postTokenBalances: [{ accountIndex: 2, mint: CURVE_QUOTE_MINT, owner: "PoolAuthority", amountRaw: "1202500000" }],
  });
  assert.equal(unitsThatLeftAccount(tx, VAULT, CURVE_QUOTE_MINT), 47_500_000n);
  // The vault is not in the transaction, or it grew: not believed.
  assert.equal(unitsThatLeftAccount(tx, OTHER, CURVE_QUOTE_MINT), null);
  assert.equal(
    unitsThatLeftAccount(
      confirmed({
        preTokenBalances: [{ accountIndex: 2, mint: CURVE_QUOTE_MINT, owner: null, amountRaw: "1" }],
        postTokenBalances: [{ accountIndex: 2, mint: CURVE_QUOTE_MINT, owner: null, amountRaw: "2" }],
      }),
      VAULT,
      CURVE_QUOTE_MINT,
    ),
    null,
  );
});

test("trade amounts: the amount in is the prepared one, the amount out is the chain's", () => {
  const prepared = { solLamports: 100_000_000n, tokenAmountRaw: 4_650_000_120_000n };
  const buy = readTradeAmounts({
    side: "buy",
    prepared,
    confirmed: confirmed({
      postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: WALLET, amountRaw: "4649999000000" }],
    }),
    wallet: WALLET,
    mintAddress: MINT,
    quoteVault: VAULT,
  });
  assert.deepEqual(buy, { solLamports: 100_000_000n, tokenAmountRaw: 4_649_999_000_000n, fromChain: true });

  const sell = readTradeAmounts({
    side: "sell",
    prepared: { solLamports: 48_000_000n, tokenAmountRaw: 2_500_000_000n },
    confirmed: confirmed({
      preTokenBalances: [{ accountIndex: 2, mint: CURVE_QUOTE_MINT, owner: null, amountRaw: "1250000000" }],
      postTokenBalances: [{ accountIndex: 2, mint: CURVE_QUOTE_MINT, owner: null, amountRaw: "1202500000" }],
    }),
    wallet: WALLET,
    mintAddress: MINT,
    quoteVault: VAULT,
  });
  assert.deepEqual(sell, { solLamports: 47_500_000n, tokenAmountRaw: 2_500_000_000n, fromChain: true });
});

test("trade amounts: with no readable transaction the prepared quote's numbers stand in, and say so", () => {
  const prepared = { solLamports: 100_000_000n, tokenAmountRaw: 4_650_000_120_000n };
  for (const tx of [null, confirmed()]) {
    assert.deepEqual(
      readTradeAmounts({ side: "buy", prepared, confirmed: tx, wallet: WALLET, mintAddress: MINT, quoteVault: VAULT }),
      { ...prepared, fromChain: false },
    );
    assert.deepEqual(
      readTradeAmounts({ side: "sell", prepared, confirmed: tx, wallet: WALLET, mintAddress: MINT, quoteVault: VAULT }),
      { ...prepared, fromChain: false },
    );
  }
});

test("trade row: the float columns mirror the integers; no SOL price means a dollar price of 0", () => {
  const base = {
    tokenId: "tok",
    txSignature: "sig",
    traderAddress: WALLET,
    side: "buy" as const,
    amounts: { solLamports: 100_000_000n, tokenAmountRaw: 4_000_000_000_000n },
    timestamp: new Date("2026-10-12T14:00:00.000Z"),
  };
  const priced = buildTradeRow({ ...base, usdPerSol: 200 });
  assert.equal(priced.solLamports, 100_000_000n);
  assert.equal(priced.tokenAmountRaw, 4_000_000_000_000n);
  assert.equal(priced.solAmount, 0.1);
  assert.equal(priced.tokenAmount, 4_000_000);
  // 0.1 SOL for 4,000,000 tokens at 200 dollars a SOL.
  assert.ok(Math.abs(priced.priceUsd - 0.000005) < 1e-12);

  assert.equal(buildTradeRow({ ...base, usdPerSol: null }).priceUsd, 0);
  assert.equal(buildTradeRow({ ...base, usdPerSol: 0 }).priceUsd, 0);
});
