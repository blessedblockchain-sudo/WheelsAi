import assert from "node:assert/strict";
import test from "node:test";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import {
  COMPUTE_BUDGET_PROGRAM_ID,
  CURVE_PREPARE_GRACE_SECONDS,
  CURVE_PREPARE_TTL_SECONDS,
  CURVE_QUOTE_MINT,
  CurveUnreadableError,
  LIGHTHOUSE_PROGRAM_ID,
  accountBalanceChange,
  buildTradeQuote,
  buildTradeRow,
  checkSignedTransaction,
  compileCurveTransaction,
  createCurveReader,
  creatorLockupEndOf,
  deriveCurveState,
  describeCurve,
  formatUnits,
  marketCapLamportsFromSqrtPrice,
  messageHashOf,
  minimumOutFor,
  nextGraduationStep,
  parseUnits,
  priceSolFromSqrtPrice,
  readTradeAmounts,
  signCurvePrepareToken,
  signatureOfTransaction,
  unitsThatEnteredAccount,
  unitsThatLeftAccount,
  verifyCurvePrepareToken,
  withComputeBudget,
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
const BASE_VAULT = Keypair.fromSeed(new Uint8Array(32).fill(19)).publicKey.toBase58();
const WALLET = wallet.publicKey.toBase58();

// A drawing's points are passed through as they are; two are enough to see it.
const POINTS = [
  { soldPercent: 0, priceSol: 0.00000002 },
  { soldPercent: 80, priceSol: 0.00000032 },
];
const LOCKED = {
  amountPerPeriod: 10_000_000_000_000n,
  cliffUnlockAmount: 0n,
  cliffSeconds: 2_592_000,
  periods: 10,
  frequencySeconds: 2_592_000,
};

function snapshot(overrides: Partial<CurveSnapshot> = {}): CurveSnapshot {
  return {
    poolAddress: POOL,
    configAddress: CONFIG,
    mintAddress: MINT,
    creatorAddress: WALLET,
    quoteVault: VAULT,
    baseVault: BASE_VAULT,
    // 2^54: one raw token unit costs 2^-20 lamports.
    sqrtPrice: 1n << 54n,
    quoteReserve: 1_250_000_000n,
    migrationQuoteThreshold: 64_000_000_000n,
    isMigrated: false,
    migrationProgress: 0,
    finishCurveTimestamp: 0,
    tradingFeesLamports: 15_000_123n,
    creatorClaimableLamports: 2_329_499n,
    creatorFeeSharePercent: 70,
    lockedVesting: { amountPerPeriod: 0n, cliffUnlockAmount: 0n, cliffSeconds: 0, periods: 0, frequencySeconds: 0 },
    graduatedPoolAddress: DAMM_POOL,
    curvePoints: POINTS,
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

test("state: the pool's own progress decides, whatever else it holds", () => {
  // Full by its progress, though the reserve reads a little short.
  assert.equal(deriveCurveState(snapshot({ quoteReserve: 63_999_999_999n, migrationProgress: 1 })), "full");
  assert.equal(deriveCurveState(snapshot({ quoteReserve: 64_000_000_000n, migrationProgress: 2 })), "full");
  // The DAMM v2 pool is created: graduated, with or without the other flag.
  assert.equal(deriveCurveState(snapshot({ quoteReserve: 64_000_000_000n, migrationProgress: 3 })), "graduated");
});

test("graduation: the locker is next only when tokens are locked and the progress says it is not made", () => {
  assert.equal(nextGraduationStep(snapshot({ migrationProgress: 1, lockedVesting: LOCKED })), "locker");
  assert.equal(nextGraduationStep(snapshot({ migrationProgress: 2, lockedVesting: LOCKED })), "migrate");
  // Nothing is locked: there is no locker to make, whatever the progress.
  assert.equal(nextGraduationStep(snapshot({ migrationProgress: 1 })), "migrate");
  assert.equal(nextGraduationStep(snapshot({ migrationProgress: 2 })), "migrate");
});

test("the creator's lock date is the moment the curve was finished plus the config's wait", () => {
  const finished = 1_791_813_600;
  assert.equal(
    creatorLockupEndOf(snapshot({ finishCurveTimestamp: finished, lockedVesting: LOCKED }))?.toISOString(),
    new Date((finished + 2_592_000) * 1000).toISOString(),
  );
  // Nothing locked, or a pool that does not say when its curve was finished: no date.
  assert.equal(creatorLockupEndOf(snapshot({ finishCurveTimestamp: finished })), null);
  assert.equal(creatorLockupEndOf(snapshot({ finishCurveTimestamp: 0, lockedVesting: LOCKED })), null);
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
    // The pool's lifetime trading fees as the chain counts them.
    tradingFeesLamports: "15000123",
    tradingFeesSol: "0.015000123",
    // The line of the pool's own config, as it was read.
    curvePoints: POINTS,
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
    swap: {
      amountInUsed: 100_000_000n,
      amountOut: 4_650_000_120_000n,
      feeLamports: 1_200_000n,
      nextSqrtPrice: 1n << 64n,
    },
  });
  assert.deepEqual(quote, {
    side: "buy",
    amountIn: "0.1",
    amountInRaw: "100000000",
    amountInUsed: "0.1",
    amountInUsedRaw: "100000000",
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
    swap: { amountInUsed: 2_500_000_000n, amountOut: 48_000_000n, feeLamports: 480_000n, nextSqrtPrice: 1n << 54n },
  });
  assert.deepEqual(quote, {
    side: "sell",
    amountIn: "2500",
    amountInRaw: "2500000000",
    amountInUsed: "2500",
    amountInUsedRaw: "2500000000",
    amountOut: "0.048",
    amountOutRaw: "48000000",
    minimumOut: "0.0468",
    minimumOutRaw: "46800000",
    feeSol: "0.00048",
    priceSolAfter: "0.000000000953674",
  });
});

test("quote: a buy that would fill the curve says how much of the amount it takes", () => {
  const quote = buildTradeQuote({
    side: "buy",
    amountInRaw: 100_000_000_000n,
    slippageBps: 100,
    swap: {
      amountInUsed: 63_512_000_000n,
      amountOut: 300_000_000_000_000n,
      feeLamports: 762_000_000n,
      nextSqrtPrice: 1n << 64n,
    },
  });
  assert.equal(quote.amountIn, "100");
  assert.equal(quote.amountInRaw, "100000000000");
  assert.equal(quote.amountInUsed, "63.512");
  assert.equal(quote.amountInUsedRaw, "63512000000");
  // The least accepted is for what the trade takes: 1% off the amount out.
  assert.equal(quote.minimumOutRaw, "297000000000000");
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
    baseVault: BASE_VAULT,
    wallet: WALLET,
    userId: "user_1",
    orgId: "org_1",
    messageHash: "ab".repeat(32),
    message: Buffer.from("a compiled message").toString("base64"),
    strict: false,
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
  assert.equal(verified.expired, false);
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

test("prepare token: with a grace, one that ran out less than ten minutes ago comes through marked expired", () => {
  const { token } = signCurvePrepareToken({ payload: tradePayload(), secret: SECRET, now: () => NOW });
  assert.equal(CURVE_PREPARE_GRACE_SECONDS, 600);
  const at = (iso: string) =>
    verifyCurvePrepareToken({ token, secret: SECRET, now: () => new Date(iso), graceSeconds: CURVE_PREPARE_GRACE_SECONDS });

  // Still good: the grace changes nothing, and it is not marked.
  const live = at("2026-10-12T14:01:29.999Z");
  assert.ok(live.ok);
  assert.equal(live.expired, false);

  // It ran out at 14:01:30. Until 14:11:30 it comes through, marked.
  for (const iso of ["2026-10-12T14:01:30.000Z", "2026-10-12T14:11:29.999Z"]) {
    const late = at(iso);
    assert.ok(late.ok, iso);
    assert.equal(late.expired, true, iso);
    assert.equal(late.payload.tokenId, tradePayload().tokenId);
  }
  assert.deepEqual(at("2026-10-12T14:11:30.000Z"), { ok: false, reason: "expired" });

  // A grace lets nothing else through.
  const [header, body, signature] = token.split(".") as [string, string, string];
  const forged = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  forged.exp += 10_000;
  const forgedToken = `${header}.${Buffer.from(JSON.stringify(forged), "utf8").toString("base64url")}.${signature}`;
  assert.deepEqual(
    verifyCurvePrepareToken({
      token: forgedToken,
      secret: SECRET,
      now: () => new Date("2026-10-12T14:05:00.000Z"),
      graceSeconds: CURVE_PREPARE_GRACE_SECONDS,
    }),
    { ok: false, reason: "bad_signature" },
  );
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
    tradePayload({ message: "" }),
    tradePayload({ strict: undefined as unknown as boolean }),
    tradePayload({ baseVault: undefined as unknown as string }),
    tradePayload({
      kind: "graduate",
      trade: undefined,
      graduate: { step: "migrate", graduatedPoolAddress: DAMM_POOL, creatorLockupEnd: "not a date" },
    }),
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
      graduate: { step: "migrate", graduatedPoolAddress: DAMM_POOL, creatorLockupEnd: "2026-11-11T14:00:00.000Z" },
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

test("compile: a compute budget goes in front, and the message itself is handed back", () => {
  const compiled = compileCurveTransaction({
    payer: WALLET,
    blockhash: BLOCKHASH,
    instructions: [memo([wallet.publicKey], "buy")],
    computeBudget: { unitLimit: 200_000, microLamports: 1 },
  });
  const decoded = TransactionMessage.decompile(compiled.tx.message);
  assert.equal(decoded.instructions.length, 3);
  assert.deepEqual(
    decoded.instructions.map((instruction) => instruction.programId.toBase58()),
    [COMPUTE_BUDGET_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, MEMO.toBase58()],
  );
  assert.deepEqual(
    Buffer.from(decoded.instructions[0]!.data),
    Buffer.from(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }).data),
  );
  assert.deepEqual(
    Buffer.from(decoded.instructions[1]!.data),
    Buffer.from(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }).data),
  );
  assert.deepEqual(Buffer.from(compiled.messageBase64, "base64"), Buffer.from(compiled.tx.message.serialize()));
});

test("compute budget: only what is missing is added, and the SDK's own limit keeps its value and its place", () => {
  const programs = (instructions: TransactionInstruction[]) =>
    instructions.map((instruction) =>
      instruction.programId.toBase58() === COMPUTE_BUDGET_PROGRAM_ID ? `budget:${instruction.data[0]}` : "other",
    );
  const work = memo([wallet.publicKey], "work");
  const budget = { unitLimit: 200_000, microLamports: 1 };

  assert.deepEqual(programs(withComputeBudget([work], budget)), ["budget:2", "budget:3", "other"]);

  // The SDK set a limit of its own, after its instruction: one limit, still the SDK's.
  const sdkLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
  const withLimit = withComputeBudget([work, sdkLimit], budget);
  assert.deepEqual(programs(withLimit), ["budget:3", "other", "budget:2"]);
  assert.equal(withLimit[2], sdkLimit);

  const sdkPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 });
  const withPrice = withComputeBudget([sdkPrice, work], budget);
  assert.deepEqual(programs(withPrice), ["budget:2", "budget:3", "other"]);
  assert.equal(withPrice[1], sdkPrice);

  // Both there already: nothing is added, so neither is ever there twice.
  const both = [sdkLimit, sdkPrice, work];
  assert.deepEqual(withComputeBudget(both, budget), both);
});

/** What was prepared for a wallet that signs alone: our compute budget, then the work. */
const WORK = [memo([wallet.publicKey], "swap buy 100000000"), memo([wallet.publicKey], "close the wrapped SOL account")];

function preparedForWallet() {
  return compileCurveTransaction({
    payer: WALLET,
    blockhash: BLOCKHASH,
    instructions: WORK,
    computeBudget: { unitLimit: 200_000, microLamports: 1 },
  });
}

/** The instructions the prepared message holds, as a wallet would see them. */
function preparedInstructions(): TransactionInstruction[] {
  return TransactionMessage.decompile(preparedForWallet().tx.message).instructions;
}

/** A transaction a wallet made of its own instructions and signed. */
function signedBy(
  signer: Keypair,
  instructions: TransactionInstruction[],
  options: { blockhash?: string; tables?: AddressLookupTableAccount[]; extraSigners?: Keypair[] } = {},
): string {
  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: options.blockhash ?? BLOCKHASH,
    instructions,
  }).compileToV0Message(options.tables);
  const tx = new VersionedTransaction(message);
  tx.sign([signer, ...(options.extraSigners ?? [])]);
  return Buffer.from(tx.serialize()).toString("base64");
}

function lighthouse(text: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(LIGHTHOUSE_PROGRAM_ID),
    keys: [{ pubkey: wallet.publicKey, isSigner: false, isWritable: false }],
    data: Buffer.from(text, "utf8"),
  });
}

function check(signedBase64: string, strict = false) {
  return checkSignedTransaction({ signedBase64, preparedMessageBase64: preparedForWallet().messageBase64, strict });
}

test("signed transaction: the one that was built, fully signed, passes", () => {
  const compiled = preparedForWallet();
  compiled.tx.sign([wallet]);
  const signed = Buffer.from(compiled.tx.serialize()).toString("base64");
  for (const strict of [false, true]) {
    const checked = check(signed, strict);
    assert.ok(checked.ok);
    assert.equal(checked.identical, true);
    assert.deepEqual(Buffer.from(checked.raw), Buffer.from(compiled.tx.serialize()));
    // The signature the chain will know the transaction by.
    assert.equal(checked.signature, bs58.encode(compiled.tx.signatures[0]!));
    assert.equal(checked.signature, signatureOfTransaction(compiled.tx));
  }
  // The same instructions compiled again are the same bytes.
  const again = check(signedBy(wallet, preparedInstructions()));
  assert.ok(again.ok);
  assert.equal(again.identical, true);
});

test("signed transaction: a wallet's own compute-budget and Lighthouse instructions pass when it alone signs", () => {
  const ours = preparedInstructions();
  const walletLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const walletPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_000 });
  const variants: Record<string, TransactionInstruction[]> = {
    "a compute-budget instruction in front": [walletPrice, ...ours],
    "two in front": [walletLimit, walletPrice, ...ours],
    "a Lighthouse assertion at the end": [...ours, lighthouse("the wallet's balance did not fall by more than expected")],
    "both, and one in the middle": [walletPrice, ours[0]!, ours[1]!, ours[2]!, lighthouse("mid"), ours[3]!, lighthouse("end")],
  };
  for (const [name, instructions] of Object.entries(variants)) {
    const checked = check(signedBy(wallet, instructions));
    assert.ok(checked.ok, name);
    assert.equal(checked.identical, false, name);
  }
});

test("signed transaction: a fresher blockhash alone passes when the wallet alone signs", () => {
  const fresher = Keypair.generate().publicKey.toBase58();
  const checked = check(signedBy(wallet, preparedInstructions(), { blockhash: fresher }));
  assert.ok(checked.ok);
  assert.equal(checked.identical, false);
  assert.equal(checked.tx.message.recentBlockhash, fresher);
});

test("signed transaction: anything else a wallet could have changed is refused", () => {
  const ours = preparedInstructions();
  const [limit, price, swap, close] = ours as [
    TransactionInstruction,
    TransactionInstruction,
    TransactionInstruction,
    TransactionInstruction,
  ];
  const stranger = Keypair.fromSeed(new Uint8Array(32).fill(31));
  const transfer = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: stranger.publicKey, lamports: 5_000_000_000 });
  const swapWith = (change: Partial<{ data: Buffer; keys: TransactionInstruction["keys"]; programId: PublicKey }>) =>
    new TransactionInstruction({ programId: swap.programId, keys: swap.keys, data: swap.data, ...change });

  const refused: Array<[string, string, string]> = [
    [
      "a changed amount",
      signedBy(wallet, [limit, price, swapWith({ data: Buffer.from("swap buy 9900000000", "utf8") }), close]),
      "instruction_not_allowed",
    ],
    ["an added transfer", signedBy(wallet, [...ours, transfer]), "instruction_not_allowed"],
    ["an added transfer in front", signedBy(wallet, [transfer, ...ours]), "instruction_not_allowed"],
    [
      "an unknown extra program",
      signedBy(wallet, [...ours, new TransactionInstruction({ programId: stranger.publicKey, keys: [], data: Buffer.alloc(0) })]),
      "instruction_not_allowed",
    ],
    ["a reordered pair", signedBy(wallet, [limit, price, close, swap]), "instruction_not_allowed"],
    ["a removed instruction", signedBy(wallet, [limit, price, swap]), "instruction_missing"],
    // The work is then not where it was prepared: the first thing met is not ours in its place.
    ["our own compute budget taken out", signedBy(wallet, [swap, close]), "instruction_not_allowed"],
    [
      "another account in an instruction of ours",
      signedBy(wallet, [
        limit,
        price,
        swapWith({ keys: [...swap.keys, { pubkey: stranger.publicKey, isSigner: false, isWritable: true }] }),
        close,
      ]),
      "instruction_not_allowed",
    ],
    [
      "another program for an instruction of ours",
      signedBy(wallet, [limit, price, swapWith({ programId: stranger.publicKey }), close]),
      "instruction_not_allowed",
    ],
    [
      "another fee payer",
      signedBy(stranger, [limit, price, memo([stranger.publicKey], "swap buy 100000000"), close], { extraSigners: [wallet] }),
      "fee_payer",
    ],
    [
      "a second signer",
      signedBy(wallet, [...ours, lighthouseWithSigner(stranger.publicKey)], { extraSigners: [stranger] }),
      "signers",
    ],
  ];
  for (const [name, signed, difference] of refused) {
    assert.deepEqual(check(signed), { ok: false, reason: "message_mismatch", difference }, name);
  }
});

function lighthouseWithSigner(signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(LIGHTHOUSE_PROGRAM_ID),
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from("assert"),
  });
}

test("signed transaction: an account of ours whose flags a wallet's instruction raised is refused", () => {
  // The prepared swap names the pool read-only. A "Lighthouse" instruction
  // that names it writable makes it writable for the whole transaction.
  const pool = new PublicKey(POOL);
  const reading = new TransactionInstruction({
    programId: MEMO,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: false },
    ],
    data: Buffer.from("read the pool"),
  });
  const prepared = compileCurveTransaction({ payer: WALLET, blockhash: BLOCKHASH, instructions: [reading] });
  const raising = new TransactionInstruction({
    programId: new PublicKey(LIGHTHOUSE_PROGRAM_ID),
    keys: [{ pubkey: pool, isSigner: false, isWritable: true }],
    data: Buffer.from("assert"),
  });
  assert.deepEqual(
    checkSignedTransaction({
      signedBase64: signedBy(wallet, [reading, raising]),
      preparedMessageBase64: prepared.messageBase64,
      strict: false,
    }),
    { ok: false, reason: "message_mismatch", difference: "instruction_not_allowed" },
  );
  // The same instruction naming it read-only changes nothing of ours.
  const harmless = new TransactionInstruction({
    programId: new PublicKey(LIGHTHOUSE_PROGRAM_ID),
    keys: [{ pubkey: pool, isSigner: false, isWritable: false }],
    data: Buffer.from("assert"),
  });
  assert.ok(
    checkSignedTransaction({
      signedBase64: signedBy(wallet, [reading, harmless]),
      preparedMessageBase64: prepared.messageBase64,
      strict: false,
    }).ok,
  );
});

test("signed transaction: an address lookup table we did not put there is refused", () => {
  const ours = preparedInstructions();
  const pool = new PublicKey(POOL);
  const table = new AddressLookupTableAccount({
    key: Keypair.fromSeed(new Uint8Array(32).fill(32)).publicKey,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: [pool],
    },
  });
  // A Lighthouse instruction whose account comes out of a table.
  const viaTable = new TransactionInstruction({
    programId: new PublicKey(LIGHTHOUSE_PROGRAM_ID),
    keys: [{ pubkey: pool, isSigner: false, isWritable: false }],
    data: Buffer.from("assert"),
  });
  const signed = signedBy(wallet, [...ours, viaTable], { tables: [table] });
  const tx = VersionedTransaction.deserialize(Buffer.from(signed, "base64"));
  assert.equal(tx.message.addressTableLookups.length, 1, "the transaction does use a table");
  assert.deepEqual(check(signed), { ok: false, reason: "message_mismatch", difference: "lookup_tables" });
});

test("signed transaction: one the server signed first must come back byte for byte", () => {
  const ours = preparedInstructions();
  // Everything a wallet may add to what it alone signs is refused here.
  const added = [
    signedBy(wallet, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_000 }), ...ours]),
    signedBy(wallet, [...ours, lighthouse("assert")]),
    signedBy(wallet, ours, { blockhash: Keypair.generate().publicKey.toBase58() }),
  ];
  for (const signed of added) {
    assert.deepEqual(check(signed, true), { ok: false, reason: "message_mismatch", difference: "not_identical" });
  }

  // Graduation's move: the position keypair has signed, the payer signs last.
  const half = compileCurveTransaction({
    payer: WALLET,
    blockhash: BLOCKHASH,
    instructions: [memo([wallet.publicKey, position.publicKey], "migrate")],
    signers: [position],
  });
  const strictly = (signedBase64: string) =>
    checkSignedTransaction({ signedBase64, preparedMessageBase64: half.messageBase64, strict: true });
  assert.deepEqual(strictly(half.base64), { ok: false, reason: "missing_signature" });
  half.tx.sign([wallet]);
  assert.ok(strictly(Buffer.from(half.tx.serialize()).toString("base64")).ok);
});

test("signed transaction: an empty signature slot is refused", () => {
  const unsigned = preparedForWallet();
  assert.deepEqual(check(unsigned.base64), { ok: false, reason: "missing_signature" });

  // The wallet added its own instruction and did not sign: still refused.
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [...preparedInstructions(), lighthouse("assert")],
  }).compileToV0Message();
  const notSigned = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
  assert.deepEqual(check(notSigned), { ok: false, reason: "missing_signature" });
});

test("signed transaction: a signature that is not the signer's own over this message is refused", () => {
  // The slot is filled, but with the signature of ANOTHER transaction: one
  // that may well have succeeded on chain. It says nothing about this one.
  const other = VersionedTransaction.deserialize(
    Buffer.from(signedBy(wallet, [memo([wallet.publicKey], "something else")]), "base64"),
  );
  const borrowed = preparedForWallet().tx;
  borrowed.signatures[0] = other.signatures[0]!;
  const withBorrowed = Buffer.from(borrowed.serialize()).toString("base64");
  for (const strict of [false, true]) {
    assert.deepEqual(check(withBorrowed, strict), { ok: false, reason: "bad_signature" });
  }

  // Any 64 bytes that are not zeros.
  const filled = preparedForWallet().tx;
  filled.signatures[0] = new Uint8Array(64).fill(7);
  assert.deepEqual(check(Buffer.from(filled.serialize()).toString("base64")), { ok: false, reason: "bad_signature" });

  // A true signature, by a key that is not the fee payer's.
  const stranger = Keypair.fromSeed(new Uint8Array(32).fill(33));
  const byStranger = preparedForWallet().tx;
  const strangerSigned = new VersionedTransaction(
    new TransactionMessage({
      payerKey: stranger.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [memo([stranger.publicKey], "x")],
    }).compileToV0Message(),
  );
  strangerSigned.sign([stranger]);
  byStranger.signatures[0] = strangerSigned.signatures[0]!;
  assert.deepEqual(check(Buffer.from(byStranger.serialize()).toString("base64")), { ok: false, reason: "bad_signature" });

  // The wallet added an instruction and the signature is over the message
  // as prepared, not as sent: refused too.
  const added = VersionedTransaction.deserialize(
    Buffer.from(signedBy(wallet, [...preparedInstructions(), lighthouse("assert")]), "base64"),
  );
  const original = preparedForWallet().tx;
  original.sign([wallet]);
  added.signatures[0] = original.signatures[0]!;
  assert.deepEqual(check(Buffer.from(added.serialize()).toString("base64")), { ok: false, reason: "bad_signature" });

  // Graduation's move: the payer's own signature is true, a position slot is not.
  const half = compileCurveTransaction({
    payer: WALLET,
    blockhash: BLOCKHASH,
    instructions: [memo([wallet.publicKey, position.publicKey], "migrate")],
    signers: [position],
  });
  half.tx.sign([wallet]);
  half.tx.signatures[1] = new Uint8Array(64).fill(9);
  assert.deepEqual(
    checkSignedTransaction({
      signedBase64: Buffer.from(half.tx.serialize()).toString("base64"),
      preparedMessageBase64: half.messageBase64,
      strict: true,
    }),
    { ok: false, reason: "bad_signature" },
  );
});

test("signed transaction: a second instruction of our own program, and an account swapped in place, are refused", () => {
  const ours = preparedInstructions();
  const [limit, price, swap, close] = ours as [
    TransactionInstruction,
    TransactionInstruction,
    TransactionInstruction,
    TransactionInstruction,
  ];
  const stranger = Keypair.fromSeed(new Uint8Array(32).fill(34));
  const secondSwap = new TransactionInstruction({
    programId: swap.programId,
    keys: swap.keys,
    data: Buffer.from("swap buy 9900000000", "utf8"),
  });
  const pool = new PublicKey(POOL);
  const reading = new TransactionInstruction({
    programId: MEMO,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: false },
    ],
    data: Buffer.from("pay out of this account"),
  });
  const prepared = compileCurveTransaction({ payer: WALLET, blockhash: BLOCKHASH, instructions: [reading] });
  const replaced = new TransactionInstruction({
    programId: MEMO,
    keys: [reading.keys[0]!, { pubkey: stranger.publicKey, isSigner: false, isWritable: false }],
    data: reading.data,
  });
  const refused = { ok: false, reason: "message_mismatch", difference: "instruction_not_allowed" };
  assert.deepEqual(check(signedBy(wallet, [...ours, secondSwap])), refused, "a second swap at the end");
  assert.deepEqual(check(signedBy(wallet, [limit, price, swap, secondSwap, close])), refused, "a second swap in the middle");
  assert.deepEqual(check(signedBy(wallet, [limit, price, swap, swap, close])), refused, "the same swap twice");
  assert.deepEqual(
    checkSignedTransaction({
      signedBase64: signedBy(wallet, [replaced]),
      preparedMessageBase64: prepared.messageBase64,
      strict: false,
    }),
    refused,
    "another address in the same place",
  );
});

test("signed transaction: a legacy transaction is refused, whoever signs first", () => {
  const legacy = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: BLOCKHASH }).add(...preparedInstructions());
  legacy.sign(wallet);
  const signed = legacy.serialize().toString("base64");
  assert.equal(VersionedTransaction.deserialize(Buffer.from(signed, "base64")).message.version, "legacy");
  assert.deepEqual(check(signed), { ok: false, reason: "message_mismatch", difference: "malformed" });
  assert.deepEqual(check(signed, true), { ok: false, reason: "message_mismatch", difference: "not_identical" });
});

test("signed transaction: bytes that are no transaction are refused", () => {
  const prepared = preparedForWallet().messageBase64;
  for (const signedBase64 of ["", "not base64 at all", "AAAA"]) {
    assert.deepEqual(checkSignedTransaction({ signedBase64, preparedMessageBase64: prepared, strict: false }), {
      ok: false,
      reason: "undecodable",
    });
  }
  // A token whose message is no message vouches for nothing.
  const compiled = preparedForWallet();
  compiled.tx.sign([wallet]);
  assert.deepEqual(
    checkSignedTransaction({
      signedBase64: Buffer.from(compiled.tx.serialize()).toString("base64"),
      preparedMessageBase64: Buffer.from("no message").toString("base64"),
      strict: false,
    }),
    { ok: false, reason: "undecodable" },
  );
});

// ============================================
// What a confirmed transaction moved
// ============================================

const OTHER = Keypair.fromSeed(new Uint8Array(32).fill(18)).publicKey.toBase58();

function confirmed(overrides: Partial<ConfirmedTransactionRead> = {}): ConfirmedTransactionRead {
  return {
    blockTime: 1_791_813_600,
    accountKeys: [WALLET, "WalletTokenAccount", VAULT, BASE_VAULT],
    preTokenBalances: [],
    postTokenBalances: [],
    ...overrides,
  };
}

/** A confirmed trade as the chain reports it: the two vaults before and after. */
function vaults(sol: [string, string], tokens: [string, string]): ConfirmedTransactionRead {
  return confirmed({
    preTokenBalances: [
      { accountIndex: 2, mint: CURVE_QUOTE_MINT, owner: "PoolAuthority", amountRaw: sol[0] },
      { accountIndex: 3, mint: MINT, owner: "PoolAuthority", amountRaw: tokens[0] },
    ],
    postTokenBalances: [
      { accountIndex: 2, mint: CURVE_QUOTE_MINT, owner: "PoolAuthority", amountRaw: sol[1] },
      { accountIndex: 3, mint: MINT, owner: "PoolAuthority", amountRaw: tokens[1] },
    ],
  });
}

test("a vault's balance change is read from the confirmed transaction, either way", () => {
  const tx = vaults(["1250000000", "1202500000"], ["900000000000000", "900002500000000"]);
  assert.equal(accountBalanceChange(tx, VAULT, CURVE_QUOTE_MINT), -47_500_000n);
  assert.equal(unitsThatLeftAccount(tx, VAULT, CURVE_QUOTE_MINT), 47_500_000n);
  assert.equal(unitsThatEnteredAccount(tx, VAULT, CURVE_QUOTE_MINT), null);
  assert.equal(unitsThatEnteredAccount(tx, BASE_VAULT, MINT), 2_500_000_000n);
  assert.equal(unitsThatLeftAccount(tx, BASE_VAULT, MINT), null);
  // An account that is not in the transaction, another mint, a missing balance: not believed.
  assert.equal(accountBalanceChange(tx, OTHER, CURVE_QUOTE_MINT), null);
  assert.equal(accountBalanceChange(tx, VAULT, MINT), null);
  assert.equal(
    accountBalanceChange(
      confirmed({ postTokenBalances: [{ accountIndex: 2, mint: CURVE_QUOTE_MINT, owner: null, amountRaw: "2" }] }),
      VAULT,
      CURVE_QUOTE_MINT,
    ),
    null,
  );
});

test("trade amounts: both come from the pool's two vaults", () => {
  // A buy that asked to spend 100 SOL and filled the curve with 62.75.
  const buy = readTradeAmounts({
    side: "buy",
    prepared: { solLamports: 62_750_000_000n, tokenAmountRaw: 300_000_000_000_000n },
    confirmed: vaults(["1250000000", "64000000000"], ["900000000000000", "600000000500000"]),
    mintAddress: MINT,
    baseVault: BASE_VAULT,
    quoteVault: VAULT,
  });
  assert.deepEqual(buy, { solLamports: 62_750_000_000n, tokenAmountRaw: 299_999_999_500_000n, fromChain: true });

  const sell = readTradeAmounts({
    side: "sell",
    prepared: { solLamports: 48_000_000n, tokenAmountRaw: 2_500_000_000n },
    confirmed: vaults(["1250000000", "1202500000"], ["900000000000000", "900002500000000"]),
    mintAddress: MINT,
    baseVault: BASE_VAULT,
    quoteVault: VAULT,
  });
  assert.deepEqual(sell, { solLamports: 47_500_000n, tokenAmountRaw: 2_500_000_000n, fromChain: true });
});

test("trade amounts: when a vault cannot be read the prepared quote's numbers stand in, both of them, and say so", () => {
  const prepared = { solLamports: 100_000_000n, tokenAmountRaw: 4_650_000_120_000n };
  const onlyTheSolVault = confirmed({
    preTokenBalances: [{ accountIndex: 2, mint: CURVE_QUOTE_MINT, owner: null, amountRaw: "1250000000" }],
    postTokenBalances: [{ accountIndex: 2, mint: CURVE_QUOTE_MINT, owner: null, amountRaw: "1349000000" }],
  });
  // The vaults moved the wrong way round for a buy: not what a buy looks like.
  const backwards = vaults(["1250000000", "1202500000"], ["900000000000000", "900002500000000"]);
  for (const tx of [null, confirmed(), onlyTheSolVault, backwards]) {
    assert.deepEqual(
      readTradeAmounts({ side: "buy", prepared, confirmed: tx, mintAddress: MINT, baseVault: BASE_VAULT, quoteVault: VAULT }),
      { ...prepared, fromChain: false },
    );
  }
  for (const tx of [null, confirmed(), onlyTheSolVault]) {
    assert.deepEqual(
      readTradeAmounts({ side: "sell", prepared, confirmed: tx, mintAddress: MINT, baseVault: BASE_VAULT, quoteVault: VAULT }),
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
