import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import {
  createTokenCurveRoutes,
  type CurveTokenRow,
  type TokenCurveRouteDeps,
} from "../routes/tokenCurve.js";
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  CURVE_QUOTE_MINT,
  LIGHTHOUSE_PROGRAM_ID,
  type ConfirmedTransactionRead,
  type CurveChain,
  type CurveSnapshot,
  type CurveTradeRow,
  type SignatureStatus,
} from "../services/meteoraCurve.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/routes/tokenCurve.ts: the curve's state, a quote, a
// trade, the creator's fee claim and graduation. The chain is a fake of the
// one CurveChain interface, the database is three functions, and every
// keypair is made in memory, so nothing here reaches a network or a disk.

const SECRET = "test-curve-secret-1234567890abcd";
const BLOCKHASH = "11111111111111111111111111111111";
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const creator = Keypair.fromSeed(new Uint8Array(32).fill(21));
const trader = Keypair.fromSeed(new Uint8Array(32).fill(22));
const MINT = Keypair.fromSeed(new Uint8Array(32).fill(23)).publicKey.toBase58();
const POOL = Keypair.fromSeed(new Uint8Array(32).fill(24)).publicKey.toBase58();
const CONFIG = Keypair.fromSeed(new Uint8Array(32).fill(25)).publicKey.toBase58();
const VAULT = Keypair.fromSeed(new Uint8Array(32).fill(26)).publicKey.toBase58();
const DAMM_POOL = Keypair.fromSeed(new Uint8Array(32).fill(27)).publicKey.toBase58();
const BASE_VAULT = Keypair.fromSeed(new Uint8Array(32).fill(28)).publicKey.toBase58();
const CREATOR = creator.publicKey.toBase58();
const TRADER = trader.publicKey.toBase58();

const TOKEN_ID = "0b0f7c0e-6f1d-4d7c-9d55-1c5f0a2b3c4d";
const PUMP_ID = "1c1f7c0e-6f1d-4d7c-9d55-1c5f0a2b3c4d";
const OTHER_CURVE_ID = "2d2f7c0e-6f1d-4d7c-9d55-1c5f0a2b3c4d";

const THRESHOLD = 64_000_000_000n;
/** When the fake's full curves were finished, unix seconds. */
const FINISHED_AT = 1_791_813_000;

// A drawing's points are passed through as they are; two are enough to see it.
const POINTS = [
  { soldPercent: 0, priceSol: 0.00000002 },
  { soldPercent: 80, priceSol: 0.00000032 },
];

const NO_LOCK = { amountPerPeriod: 0n, cliffUnlockAmount: 0n, cliffSeconds: 0, periods: 0, frequencySeconds: 0 };
const LOCKED = {
  amountPerPeriod: 8_333_333_333_333n,
  cliffUnlockAmount: 4n,
  cliffSeconds: 2_592_000,
  periods: 12,
  frequencySeconds: 2_592_000,
};

function snapshot(overrides: Partial<CurveSnapshot> = {}): CurveSnapshot {
  return {
    poolAddress: POOL,
    configAddress: CONFIG,
    mintAddress: MINT,
    creatorAddress: CREATOR,
    quoteVault: VAULT,
    baseVault: BASE_VAULT,
    sqrtPrice: 1n << 54n,
    quoteReserve: 1_250_000_000n,
    migrationQuoteThreshold: THRESHOLD,
    isMigrated: false,
    migrationProgress: 0,
    finishCurveTimestamp: 0,
    tradingFeesLamports: 15_000_123n,
    creatorClaimableLamports: 2_329_499n,
    creatorFeeSharePercent: 70,
    lockedVesting: NO_LOCK,
    graduatedPoolAddress: DAMM_POOL,
    curvePoints: POINTS,
    handle: null,
    ...overrides,
  };
}

/** A pool whose curve is full, as the chain has it: 1 full, 2 the locker made or not needed. */
function fullPool(overrides: Partial<CurveSnapshot> = {}): CurveSnapshot {
  return snapshot({ quoteReserve: THRESHOLD, migrationProgress: 2, finishCurveTimestamp: FINISHED_AT, ...overrides });
}

/** A pool that has moved into its DAMM v2 pool. */
function graduatedPool(overrides: Partial<CurveSnapshot> = {}): CurveSnapshot {
  return fullPool({ isMigrated: true, migrationProgress: 3, ...overrides });
}

function memo(signers: PublicKey[], text: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO,
    keys: signers.map((pubkey) => ({ pubkey, isSigner: true, isWritable: false })),
    data: Buffer.from(text, "utf8"),
  });
}

/**
 * A transaction's signature as the chain has it: its first signature,
 * base58. (One byte says how many signatures follow; each is 64 bytes.)
 */
function signatureOf(raw: Uint8Array): string {
  return bs58.encode(raw.slice(1, 65));
}

interface World {
  /** What the pool reads as. null: no pool. A function may throw. */
  pool: CurveSnapshot | null | (() => CurveSnapshot);
  /** What the confirmed transaction reads back as. */
  confirmed: ConfirmedTransactionRead | null | (() => ConfirmedTransactionRead);
  sendError: Error | null;
  confirmError: Error | null;
  /** What the chain knows of each signature. One it has not heard of is "not_seen". */
  statuses: Record<string, SignatureStatus>;
  /** What a transaction becomes on the fake chain once it is sent. */
  statusAfterSend: SignatureStatus;
  /** When set, asking for a status fails. */
  statusError: Error | null;
  auth: { userId: string | null; orgId: string } | null;
  nowMs: number;
  tokens: Record<string, CurveTokenRow>;
  calls: {
    readCurve: number;
    quotes: Array<{ sell: boolean; amountIn: bigint; currentPoint: bigint }>;
    swaps: Array<{ poolAddress: string; wallet: string; sell: boolean; amountIn: bigint; minimumOut: bigint }>;
    claims: Array<{ poolAddress: string; creator: string }>;
    lockers: Array<{ poolAddress: string; payer: string }>;
    migrations: Array<{ payer: string; pool: string }>;
    sent: Uint8Array[];
    confirmedWith: Array<{ signature: string; blockhash: string; lastValidBlockHeight: number }>;
    readBack: string[];
    statusAsked: string[];
  };
  trades: CurveTradeRow[];
  graduations: Array<{ tokenId: string; graduatedPoolAddress: string; at: Date; creatorLockupEnd: Date | null }>;
  recordTradeError: Error | null;
  markGraduatedError: Error | null;
  positionKeypairs: Keypair[];
}

function makeWorld(overrides: Partial<World> = {}): World {
  return {
    pool: snapshot(),
    confirmed: null,
    sendError: null,
    confirmError: null,
    statuses: {},
    statusAfterSend: "succeeded",
    statusError: null,
    auth: { userId: "user_1", orgId: "org_1" },
    nowMs: Date.parse("2026-10-12T14:00:00.000Z"),
    tokens: {
      [TOKEN_ID]: { id: TOKEN_ID, mintAddress: MINT, launchpad: "meteora", poolAddress: POOL, status: "BONDING" },
      [PUMP_ID]: { id: PUMP_ID, mintAddress: "PumpMint", launchpad: "pumpfun", poolAddress: "PumpCurve", status: "BONDING" },
      [OTHER_CURVE_ID]: {
        id: OTHER_CURVE_ID,
        mintAddress: "AnotherMint",
        launchpad: "meteora",
        poolAddress: POOL,
        status: "BONDING",
      },
    },
    calls: {
      readCurve: 0,
      quotes: [],
      swaps: [],
      claims: [],
      lockers: [],
      migrations: [],
      sent: [],
      confirmedWith: [],
      readBack: [],
      statusAsked: [],
    },
    trades: [],
    graduations: [],
    recordTradeError: null,
    markGraduatedError: null,
    positionKeypairs: [],
    ...overrides,
  };
}

function fakeChain(world: World): CurveChain {
  return {
    readCurve: async () => {
      world.calls.readCurve += 1;
      return typeof world.pool === "function" ? world.pool() : world.pool;
    },
    currentPoint: async () => 1_800_000_000n,
    tradeFeeNumerator: () => 12_000_000n,
    quoteSwap: (snap, input) => {
      world.calls.quotes.push(input);
      if (input.sell && input.amountIn === 777_000_000n) throw new Error("Amount is too small");
      if (input.sell) {
        const amountOut = input.amountIn / 50n;
        return { amountInUsed: input.amountIn, amountOut, feeLamports: amountOut / 100n, nextSqrtPrice: 1n << 54n };
      }
      // As the SDK's partial fill does: a buy takes no more than the curve
      // has left to raise, and gives tokens for what it takes.
      const left = snap.migrationQuoteThreshold - snap.quoteReserve;
      const used = input.amountIn > left ? left : input.amountIn;
      return {
        amountInUsed: used,
        amountOut: used * 46_500n + 120_000n,
        feeLamports: (used * 12n) / 1000n,
        nextSqrtPrice: 1n << 64n,
      };
    },
    buildSwap: async (input) => {
      world.calls.swaps.push(input);
      return [memo([new PublicKey(input.wallet)], `swap ${input.sell ? "sell" : "buy"} ${input.amountIn} ${input.minimumOut}`)];
    },
    buildClaim: async (input) => {
      world.calls.claims.push(input);
      return [memo([new PublicKey(input.creator)], "claim")];
    },
    buildLocker: async (input) => {
      world.calls.lockers.push(input);
      return [memo([new PublicKey(input.payer)], "locker")];
    },
    buildMigration: async (snap, input) => {
      world.calls.migrations.push({ payer: input.payer, pool: snap.poolAddress });
      const first = Keypair.generate();
      const second = Keypair.generate();
      world.positionKeypairs = [first, second];
      return {
        instructions: [memo([new PublicKey(input.payer), first.publicKey, second.publicKey], "migrate")],
        signers: [first, second],
      };
    },
    latestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 500 }),
    send: async (raw) => {
      if (world.sendError) throw world.sendError;
      world.calls.sent.push(raw);
      world.statuses[signatureOf(raw)] = world.statusAfterSend;
      return signatureOf(raw);
    },
    confirm: async (signature, sentWith) => {
      world.calls.confirmedWith.push({ signature, ...sentWith });
      if (world.confirmError) throw world.confirmError;
    },
    readTransaction: async (signature) => {
      world.calls.readBack.push(signature);
      return typeof world.confirmed === "function" ? world.confirmed() : world.confirmed;
    },
    signatureStatus: async (signature) => {
      world.calls.statusAsked.push(signature);
      if (world.statusError) throw world.statusError;
      return world.statuses[signature] ?? "not_seen";
    },
  };
}

async function makeApp(world: World, depOverrides: Partial<TokenCurveRouteDeps> = {}) {
  setupEnv();
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (world.auth) request.auth = { ...world.auth, type: "jwt" };
  });
  const deps: TokenCurveRouteDeps = {
    chain: fakeChain(world),
    loadToken: async (id) => world.tokens[id] ?? null,
    recordTrade: async (row) => {
      if (world.recordTradeError) throw world.recordTradeError;
      // The table's unique signature: a repeat writes nothing.
      if (world.trades.some((trade) => trade.txSignature === row.txSignature)) return { created: false };
      world.trades.push(row);
      return { created: true };
    },
    markGraduated: async (input) => {
      if (world.markGraduatedError) throw world.markGraduatedError;
      // As the table does it: only a BONDING row graduates.
      const row = world.tokens[input.tokenId];
      if (!row || row.status !== "BONDING") return;
      world.tokens[input.tokenId] = { ...row, status: "GRADUATED" };
      world.graduations.push(input);
    },
    solUsd: async () => 200,
    network: "devnet",
    prepareTokenSecret: SECRET,
    cacheMs: 5000,
    now: () => new Date(world.nowMs),
    ...depOverrides,
  };
  await app.register(createTokenCurveRoutes(deps), { prefix: "/api/tokens" });
  await app.ready();
  return app;
}

type App = Awaited<ReturnType<typeof makeApp>>;

async function post(app: App, path: string, payload: unknown) {
  const response = await app.inject({ method: "POST", url: `/api/tokens/${path}`, payload: payload as object });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

async function get(app: App, path: string) {
  const response = await app.inject({ method: "GET", url: `/api/tokens/${path}` });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

/** The instructions of a prepared transaction, as a wallet that changes it would see them. */
function instructionsOf(transactionBase64: string): TransactionInstruction[] {
  const tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, "base64"));
  return TransactionMessage.decompile(tx.message).instructions;
}

/** A wallet that makes its own transaction of these instructions and signs it. */
function signOwn(signer: Keypair, instructions: TransactionInstruction[], blockhash = BLOCKHASH): string {
  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([signer]);
  return Buffer.from(tx.serialize()).toString("base64");
}

/** A confirmed trade as the chain reports it: the pool's two vaults before and after. */
function vaultsMoved(sol: [string, string], tokens: [string, string]): ConfirmedTransactionRead {
  return {
    blockTime: 1_791_813_700,
    accountKeys: [TRADER, "TraderTokenAccount", VAULT, BASE_VAULT],
    preTokenBalances: [
      { accountIndex: 2, mint: CURVE_QUOTE_MINT, owner: "PoolAuthority", amountRaw: sol[0] },
      { accountIndex: 3, mint: MINT, owner: "PoolAuthority", amountRaw: tokens[0] },
    ],
    postTokenBalances: [
      { accountIndex: 2, mint: CURVE_QUOTE_MINT, owner: "PoolAuthority", amountRaw: sol[1] },
      { accountIndex: 3, mint: MINT, owner: "PoolAuthority", amountRaw: tokens[1] },
    ],
  };
}

/** What the browser wallet does: sign the transaction it was handed, change nothing. */
function signAs(transactionBase64: string, signer: Keypair): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, "base64"));
  tx.sign([signer]);
  return Buffer.from(tx.serialize()).toString("base64");
}

const BUY = { side: "buy", amount: "0.1", slippageBps: 100 };
const SELL = { side: "sell", amount: "2500", slippageBps: 100 };

async function prepareBuy(app: App) {
  const prepared = await post(app, `${TOKEN_ID}/trade/prepare`, { ...BUY, wallet: TRADER });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  return prepared.body;
}

// ============================================
// 2.1 GET /:id/curve
// ============================================

test("curve: a trading pool is answered in full, without a login", async () => {
  const world = makeWorld({ auth: null });
  const app = await makeApp(world);
  const { status, body } = await get(app, `${TOKEN_ID}/curve`);
  assert.equal(status, 200);
  assert.deepEqual(body, {
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
    creatorAddress: CREATOR,
    creatorClaimableLamports: "2329499",
    creatorClaimableSol: "0.002329499",
    creatorFeeSharePercent: 70,
    creatorLocked: null,
    graduatedPoolAddress: null,
    // The pool's lifetime trading fees, and the line of its own config.
    tradingFeesLamports: "15000123",
    tradingFeesSol: "0.015000123",
    curvePoints: POINTS,
    readAt: "2026-10-12T14:00:00.000Z",
  });
});

test("curve: full when the threshold is reached, graduated when the pool has moved", async () => {
  const world = makeWorld({ pool: fullPool({ migrationProgress: 1, lockedVesting: LOCKED }) });
  const app = await makeApp(world);
  const full = await get(app, `${TOKEN_ID}/curve`);
  assert.equal(full.body.state, "full");
  assert.equal(full.body.progress, 1);
  assert.equal(full.body.graduatedPoolAddress, null);
  assert.deepEqual(full.body.creatorLocked, {
    amount: "100000000",
    cliffSeconds: 2_592_000,
    periods: 12,
    totalSeconds: 31_104_000,
  });

  world.pool = graduatedPool();
  world.nowMs += 5000;
  const graduated = await get(app, `${TOKEN_ID}/curve`);
  assert.equal(graduated.body.state, "graduated");
  assert.equal(graduated.body.graduatedPoolAddress, DAMM_POOL);
});

test("curve: a pool the chain says has graduated is graduated whatever our row says, and reading it repairs the row", async () => {
  // Meteora's own service moved the pool; our row still says BONDING.
  const world = makeWorld({ pool: graduatedPool({ lockedVesting: LOCKED }) });
  const app = await makeApp(world);
  const first = await get(app, `${TOKEN_ID}/curve`);
  assert.equal(first.status, 200);
  assert.equal(first.body.state, "graduated");
  assert.equal(first.body.graduatedPoolAddress, DAMM_POOL);
  // Status, when, the DAMM v2 pool, and the creator's lock date: the moment
  // the curve was finished plus the config's wait.
  assert.deepEqual(world.graduations, [
    {
      tokenId: TOKEN_ID,
      graduatedPoolAddress: DAMM_POOL,
      at: new Date(world.nowMs),
      creatorLockupEnd: new Date((FINISHED_AT + LOCKED.cliffSeconds) * 1000),
    },
  ]);
  assert.equal(world.tokens[TOKEN_ID]!.status, "GRADUATED");

  // The row is in line now: reading again writes nothing.
  world.nowMs += 6000;
  await get(app, `${TOKEN_ID}/curve`);
  await post(app, `${TOKEN_ID}/trade/quote`, BUY);
  assert.equal(world.graduations.length, 1);

  // Its progress alone says so too, before the other flag is read.
  const byProgress = makeWorld({ pool: fullPool({ migrationProgress: 3 }) });
  const answer = await get(await makeApp(byProgress), `${TOKEN_ID}/curve`);
  assert.equal(answer.body.state, "graduated");
  assert.equal(byProgress.graduations.length, 1);
  // Nothing is locked for the creator: no lock date is written.
  assert.equal(byProgress.graduations[0]!.creatorLockupEnd, null);
});

test("curve: a row that cannot be repaired does not spoil the answer, and is tried again", async () => {
  const world = makeWorld({ pool: graduatedPool(), markGraduatedError: new Error("database is down") });
  const app = await makeApp(world);
  const answer = await get(app, `${TOKEN_ID}/curve`);
  assert.equal(answer.status, 200);
  assert.equal(answer.body.state, "graduated");
  assert.equal(world.graduations.length, 0);

  world.markGraduatedError = null;
  await get(app, `${TOKEN_ID}/curve`);
  assert.equal(world.graduations.length, 1);
});

test("curve: the pool is read once for readers that arrive within the cache time", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  await get(app, `${TOKEN_ID}/curve`);
  world.nowMs += 4000;
  await get(app, `${TOKEN_ID}/curve`);
  await post(app, `${TOKEN_ID}/trade/quote`, BUY);
  assert.equal(world.calls.readCurve, 1);
  world.nowMs += 1000;
  await get(app, `${TOKEN_ID}/curve`);
  assert.equal(world.calls.readCurve, 2);
});

test("every route answers 404 not_a_curve_token for a token of another launchpad, and 404 for no token", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  const calls: Array<Promise<{ status: number; body: Record<string, any> }>> = [
    get(app, `${PUMP_ID}/curve`),
    post(app, `${PUMP_ID}/trade/quote`, BUY),
    post(app, `${PUMP_ID}/trade/prepare`, { ...BUY, wallet: TRADER }),
    post(app, `${PUMP_ID}/fees/prepare`, { wallet: CREATOR }),
    post(app, `${PUMP_ID}/graduate/prepare`, { wallet: TRADER }),
  ];
  for (const answer of await Promise.all(calls)) {
    assert.equal(answer.status, 404);
    assert.deepEqual(answer.body, { error: "not_a_curve_token" });
  }
  const missing = await get(app, "3e3f7c0e-6f1d-4d7c-9d55-1c5f0a2b3c4d/curve");
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: "token_not_found" });
  assert.equal(world.calls.readCurve, 0);
});

test("curve: a pool that cannot be read is 503 curve_unreadable, never a guess", async () => {
  const cases: Array<Partial<World>> = [
    { pool: null },
    {
      pool: () => {
        throw new Error("429 Too Many Requests");
      },
    },
  ];
  for (const overrides of cases) {
    const app = await makeApp(makeWorld(overrides));
    const { status, body } = await get(app, `${TOKEN_ID}/curve`);
    assert.equal(status, 503);
    assert.deepEqual(body, { error: "curve_unreadable" });
  }

  // The row points at a pool that holds another mint.
  const app = await makeApp(makeWorld());
  const wrongPool = await get(app, `${OTHER_CURVE_ID}/curve`);
  assert.equal(wrongPool.status, 503);
  assert.deepEqual(wrongPool.body, { error: "curve_unreadable" });

  // The row has no pool address and no config to derive one from.
  const world = makeWorld();
  world.tokens[TOKEN_ID] = { ...world.tokens[TOKEN_ID]!, poolAddress: null };
  const noPool = await get(await makeApp(world), `${TOKEN_ID}/curve`);
  assert.equal(noPool.status, 503);
  assert.deepEqual(noPool.body, { error: "curve_unreadable" });
});

// ============================================
// 2.2 POST /:id/trade/quote
// ============================================

test("quote: a buy, without a login", async () => {
  const world = makeWorld({ auth: null });
  const app = await makeApp(world);
  const { status, body } = await post(app, `${TOKEN_ID}/trade/quote`, BUY);
  assert.equal(status, 200);
  assert.deepEqual(body, {
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
  assert.deepEqual(world.calls.quotes, [{ sell: false, amountIn: 100_000_000n, currentPoint: 1_800_000_000n }]);
});

test("quote: a sell is in tokens, and the allowance defaults to 100 basis points", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  const { status, body } = await post(app, `${TOKEN_ID}/trade/quote`, { side: "sell", amount: "2500" });
  assert.equal(status, 200);
  assert.deepEqual(body, {
    side: "sell",
    amountIn: "2500",
    amountInRaw: "2500000000",
    amountInUsed: "2500",
    amountInUsedRaw: "2500000000",
    amountOut: "0.05",
    amountOutRaw: "50000000",
    minimumOut: "0.0495",
    minimumOutRaw: "49500000",
    feeSol: "0.0005",
    priceSolAfter: "0.000000000953674",
  });
  assert.equal(world.calls.quotes[0]?.sell, true);

  const wide = await post(app, `${TOKEN_ID}/trade/quote`, { side: "sell", amount: "2500", slippageBps: 5000 });
  assert.equal(wide.body.minimumOutRaw, "25000000");
});

test("quote: 400 invalid_amount for anything that is not a positive amount the curve can take", async () => {
  const app = await makeApp(makeWorld());
  for (const amount of ["0", "0.0", "abc", "-1", "", "0.0000000001", "1e3", 5, null]) {
    const { status, body } = await post(app, `${TOKEN_ID}/trade/quote`, { side: "buy", amount });
    assert.equal(status, 400, `amount ${JSON.stringify(amount)}`);
    assert.equal(body.error, "invalid_amount");
  }
  const missing = await post(app, `${TOKEN_ID}/trade/quote`, { side: "buy" });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "invalid_amount");

  // A sell of less than one lamport's worth gives nothing.
  const dust = await post(app, `${TOKEN_ID}/trade/quote`, { side: "sell", amount: "0.000001" });
  assert.equal(dust.status, 400);
  assert.equal(dust.body.error, "invalid_amount");

  // What the SDK itself refuses comes back with its own words.
  const refused = await post(app, `${TOKEN_ID}/trade/quote`, { side: "sell", amount: "777" });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body, { error: "invalid_amount", message: "Amount is too small" });
});

test("quote: a buy of more SOL than the curve has left is a partial fill, and says how much it takes", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  // 62.75 SOL are left to raise; 100 are offered.
  const { status, body } = await post(app, `${TOKEN_ID}/trade/quote`, { side: "buy", amount: "100" });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.amountIn, "100");
  assert.equal(body.amountInRaw, "100000000000");
  assert.equal(body.amountInUsed, "62.75");
  assert.equal(body.amountInUsedRaw, "62750000000");
  // What comes out, and the least accepted, are for the 62.75 that are taken.
  assert.equal(body.amountOutRaw, (62_750_000_000n * 46_500n + 120_000n).toString());
  assert.equal(body.minimumOutRaw, (((62_750_000_000n * 46_500n + 120_000n) * 9_900n) / 10_000n).toString());
  assert.equal(body.feeSol, "0.753");
});

test("buy that fills the curve: built with the whole amount typed, recorded with what the trade takes", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  const prepared = await post(app, `${TOKEN_ID}/trade/prepare`, { side: "buy", amount: "100", wallet: TRADER });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  assert.equal(prepared.body.quote.amountInUsedRaw, "62750000000");
  // The chain takes of the 100 only what the curve has left to sell.
  const minimumOut = ((62_750_000_000n * 46_500n + 120_000n) * 9_900n) / 10_000n;
  assert.deepEqual(world.calls.swaps, [
    { poolAddress: POOL, wallet: TRADER, sell: false, amountIn: 100_000_000_000n, minimumOut },
  ]);

  // The confirmed transaction cannot be read back: the quote's numbers are
  // written, and for the SOL that is what the trade takes, not what was typed.
  const sent = await post(app, `${TOKEN_ID}/trade/submit`, {
    prepareToken: prepared.body.prepareToken,
    signedTransaction: signAs(prepared.body.transaction, trader),
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(sent.body.trade, {
    side: "buy",
    solLamports: "62750000000",
    tokenAmountRaw: (62_750_000_000n * 46_500n + 120_000n).toString(),
  });
  assert.equal(world.trades[0]!.solLamports, 62_750_000_000n);
});

test("quote and prepare: a sell of more tokens than exist is refused before anything is quoted or built", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  // One raw unit above the whole supply, and a number that still fits a u64.
  for (const amount of ["1000000000.000001", "18000000000000"]) {
    const quote = await post(app, `${TOKEN_ID}/trade/quote`, { side: "sell", amount });
    assert.equal(quote.status, 400, `amount ${amount}`);
    assert.deepEqual(quote.body, { error: "invalid_amount" });
    const prepared = await post(app, `${TOKEN_ID}/trade/prepare`, { side: "sell", amount, wallet: TRADER });
    assert.equal(prepared.status, 400, `amount ${amount}`);
    assert.deepEqual(prepared.body, { error: "invalid_amount" });
  }
  assert.equal(world.calls.quotes.length, 0);
  assert.equal(world.calls.swaps.length, 0);

  // The whole supply itself is an amount the curve is asked about.
  const all = await post(app, `${TOKEN_ID}/trade/quote`, { side: "sell", amount: "1000000000" });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.amountInRaw, "1000000000000000");
});

test("quote: 400 invalid_payload for a wrong side or an allowance outside 1 to 5000", async () => {
  const app = await makeApp(makeWorld());
  for (const body of [
    { side: "hold", amount: "1" },
    { amount: "1" },
    { side: "buy", amount: "1", slippageBps: 0 },
    { side: "buy", amount: "1", slippageBps: 5001 },
    { side: "buy", amount: "1", slippageBps: 1.5 },
  ]) {
    const answer = await post(app, `${TOKEN_ID}/trade/quote`, body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(answer.body.error, "invalid_payload");
  }
});

test("quote: 409 curve_full when the curve is full or has graduated", async () => {
  for (const pool of [
    snapshot({ quoteReserve: THRESHOLD }),
    snapshot({ quoteReserve: THRESHOLD, isMigrated: true }),
  ]) {
    const world = makeWorld({ pool });
    const app = await makeApp(world);
    for (const body of [BUY, SELL]) {
      const answer = await post(app, `${TOKEN_ID}/trade/quote`, body);
      assert.equal(answer.status, 409);
      assert.deepEqual(answer.body, { error: "curve_full" });
    }
    const prepare = await post(app, `${TOKEN_ID}/trade/prepare`, { ...BUY, wallet: TRADER });
    assert.equal(prepare.status, 409);
    assert.deepEqual(prepare.body, { error: "curve_full" });
    assert.equal(world.calls.quotes.length, 0);
    assert.equal(world.calls.swaps.length, 0);
  }
});

// ============================================
// 2.3 trade/prepare and trade/submit
// ============================================

test("the login routes answer 401 without a login, before anything is read", async () => {
  const world = makeWorld({ auth: null });
  const app = await makeApp(world);
  const calls = await Promise.all([
    post(app, `${TOKEN_ID}/trade/prepare`, { ...BUY, wallet: TRADER }),
    post(app, `${TOKEN_ID}/trade/submit`, { prepareToken: "x", signedTransaction: "y" }),
    post(app, `${TOKEN_ID}/fees/prepare`, { wallet: CREATOR }),
    post(app, `${TOKEN_ID}/fees/submit`, { prepareToken: "x", signedTransaction: "y" }),
    post(app, `${TOKEN_ID}/graduate/prepare`, { wallet: TRADER }),
    post(app, `${TOKEN_ID}/graduate/submit`, { prepareToken: "x", signedTransaction: "y" }),
  ]);
  for (const answer of calls) {
    assert.equal(answer.status, 401);
    assert.deepEqual(answer.body, { error: "unauthenticated" });
  }
  assert.equal(world.calls.readCurve, 0);
});

test("the login routes answer 503 prepare_unavailable when the server has no secret; reads still work", async () => {
  const world = makeWorld();
  const app = await makeApp(world, { prepareTokenSecret: null });
  const prepare = await post(app, `${TOKEN_ID}/trade/prepare`, { ...BUY, wallet: TRADER });
  assert.equal(prepare.status, 503);
  assert.deepEqual(prepare.body, { error: "prepare_unavailable" });
  assert.equal((await get(app, `${TOKEN_ID}/curve`)).status, 200);
  assert.equal((await post(app, `${TOKEN_ID}/trade/quote`, BUY)).status, 200);
});

test("trade prepare: an unsigned transaction for the wallet, the quote, a token, and an expiry 90 seconds ahead", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  const body = await prepareBuy(app);

  assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "prepareToken", "quote", "transaction"]);
  assert.equal(body.expiresAt, "2026-10-12T14:01:30.000Z");
  assert.equal(body.quote.amountOutRaw, "4650000120000");
  assert.equal(body.quote.minimumOutRaw, "4603500118800");

  const tx = VersionedTransaction.deserialize(Buffer.from(body.transaction, "base64"));
  assert.equal(tx.version, 0);
  assert.equal(tx.message.staticAccountKeys[0]?.toBase58(), TRADER);
  assert.equal(tx.message.recentBlockhash, BLOCKHASH);
  assert.ok(tx.signatures.every((signature) => signature.every((byte) => byte === 0)), "nothing is signed");

  // It begins with its own compute budget, each instruction once, so the
  // wallet has no reason to add one: a limit of 200,000 units, a price of 1.
  const instructions = TransactionMessage.decompile(tx.message).instructions;
  assert.deepEqual(
    instructions.map((instruction) => instruction.programId.toBase58()),
    [COMPUTE_BUDGET_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, MEMO.toBase58()],
  );
  assert.deepEqual(
    Buffer.from(instructions[0]!.data),
    Buffer.from(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }).data),
  );
  assert.deepEqual(
    Buffer.from(instructions[1]!.data),
    Buffer.from(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }).data),
  );

  // The swap is built with the quote's amount in and the least accepted out.
  assert.deepEqual(world.calls.swaps, [
    { poolAddress: POOL, wallet: TRADER, sell: false, amountIn: 100_000_000n, minimumOut: 4_603_500_118_800n },
  ]);
});

test("trade prepare: refusals", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  const badWallet = await post(app, `${TOKEN_ID}/trade/prepare`, { ...BUY, wallet: "not-an-address" });
  assert.equal(badWallet.status, 400);
  assert.deepEqual(badWallet.body, { error: "invalid_wallet" });

  const noWallet = await post(app, `${TOKEN_ID}/trade/prepare`, BUY);
  assert.equal(noWallet.status, 400);
  assert.equal(noWallet.body.error, "invalid_payload");

  const badAmount = await post(app, `${TOKEN_ID}/trade/prepare`, { side: "buy", amount: "0", wallet: TRADER });
  assert.equal(badAmount.status, 400);
  assert.equal(badAmount.body.error, "invalid_amount");
  assert.equal(world.calls.swaps.length, 0);
});

test("buy: sent as signed, confirmed, one row with the chain's two amounts, and the pool is read again", async () => {
  const world = makeWorld({
    // The SOL vault gained 0.0999 SOL and the token vault lost 4,649,999 tokens.
    confirmed: vaultsMoved(["1250000000", "1349900000"], ["900000000000000", "895350001000000"]),
  });
  const app = await makeApp(world);
  await get(app, `${TOKEN_ID}/curve`);
  const prepared = await prepareBuy(app);
  assert.equal(world.calls.readCurve, 1);

  const signedTransaction = signAs(prepared.transaction, trader);
  const { status, body } = await post(app, `${TOKEN_ID}/trade/submit`, {
    prepareToken: prepared.prepareToken,
    signedTransaction,
  });
  assert.equal(status, 200, JSON.stringify(body));
  const signature = signatureOf(Buffer.from(signedTransaction, "base64"));
  assert.deepEqual(body, {
    signature,
    // Both from the pool's vaults: the SOL one gained, the tokens the other lost.
    trade: { side: "buy", solLamports: "99900000", tokenAmountRaw: "4649999000000" },
    recorded: true,
  });
  // The chain was asked once about the signature, before anything was sent.
  assert.deepEqual(world.calls.statusAsked, [signature]);

  assert.equal(world.calls.sent.length, 1);
  assert.deepEqual(Buffer.from(world.calls.sent[0]!), Buffer.from(signedTransaction, "base64"));
  assert.deepEqual(world.calls.confirmedWith, [{ signature, blockhash: BLOCKHASH, lastValidBlockHeight: 500 }]);
  assert.deepEqual(world.calls.readBack, [signature]);

  assert.equal(world.trades.length, 1);
  const row = world.trades[0]!;
  assert.equal(row.tokenId, TOKEN_ID);
  assert.equal(row.txSignature, signature);
  assert.equal(row.traderAddress, TRADER);
  assert.equal(row.side, "buy");
  assert.equal(row.solLamports, 99_900_000n);
  assert.equal(row.tokenAmountRaw, 4_649_999_000_000n);
  assert.equal(row.solAmount, 0.0999);
  assert.equal(row.tokenAmount, 4_649_999);
  assert.ok(Math.abs(row.priceUsd - (0.0999 / 4_649_999) * 200) < 1e-15);
  assert.equal(row.timestamp.toISOString(), new Date(1_791_813_700 * 1000).toISOString());

  // The remembered reading was dropped by the submit.
  await get(app, `${TOKEN_ID}/curve`);
  assert.equal(world.calls.readCurve, 2);
});

test("sell: tokens are what the pool's token vault gained, SOL is what left its SOL vault", async () => {
  const world = makeWorld({
    confirmed: vaultsMoved(["1250000000", "1200300000"], ["900000000000000", "900002500000000"]),
  });
  const app = await makeApp(world);
  const prepared = await post(app, `${TOKEN_ID}/trade/prepare`, { ...SELL, wallet: TRADER });
  assert.equal(prepared.status, 200);
  assert.deepEqual(world.calls.swaps, [
    { poolAddress: POOL, wallet: TRADER, sell: true, amountIn: 2_500_000_000n, minimumOut: 49_500_000n },
  ]);

  const { status, body } = await post(app, `${TOKEN_ID}/trade/submit`, {
    prepareToken: prepared.body.prepareToken,
    signedTransaction: signAs(prepared.body.transaction, trader),
  });
  assert.equal(status, 200);
  // The quote said 0.05 SOL; the vault paid out 0.0497.
  assert.deepEqual(body.trade, { side: "sell", solLamports: "49700000", tokenAmountRaw: "2500000000" });
  assert.equal(world.trades.length, 1);
  assert.equal(world.trades[0]!.side, "sell");
  assert.equal(world.trades[0]!.solLamports, 49_700_000n);
  assert.equal(world.trades[0]!.tokenAmountRaw, 2_500_000_000n);
});

test("trade: when the confirmed transaction cannot be read, the prepared quote's numbers are written", async () => {
  for (const confirmed of [
    null,
    () => {
      throw new Error("node is behind");
    },
  ] as Array<World["confirmed"]>) {
    const world = makeWorld({ confirmed });
    const app = await makeApp(world, { solUsd: async () => null });
    const prepared = await prepareBuy(app);
    const { status, body } = await post(app, `${TOKEN_ID}/trade/submit`, {
      prepareToken: prepared.prepareToken,
      signedTransaction: signAs(prepared.transaction, trader),
    });
    assert.equal(status, 200);
    assert.deepEqual(body.trade, { side: "buy", solLamports: "100000000", tokenAmountRaw: "4650000120000" });
    assert.equal(world.trades[0]!.tokenAmountRaw, 4_650_000_120_000n);
    // No SOL price to be had: 0, never an invented one.
    assert.equal(world.trades[0]!.priceUsd, 0);
    assert.equal(world.trades[0]!.timestamp.getTime(), world.nowMs);
  }
});

test("trade: the same signature a second time writes no second row", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  const prepared = await prepareBuy(app);
  const submission = {
    prepareToken: prepared.prepareToken,
    signedTransaction: signAs(prepared.transaction, trader),
  };
  const first = await post(app, `${TOKEN_ID}/trade/submit`, submission);
  const second = await post(app, `${TOKEN_ID}/trade/submit`, submission);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(world.trades.length, 1);
  // The second time the chain already has it: it is not sent again.
  assert.equal(world.calls.sent.length, 1);
});

test("trade: a row that cannot be written does not turn a confirmed trade into an error", async () => {
  const world = makeWorld({ recordTradeError: new Error("database is down") });
  const app = await makeApp(world);
  const prepared = await prepareBuy(app);
  const { status, body } = await post(app, `${TOKEN_ID}/trade/submit`, {
    prepareToken: prepared.prepareToken,
    signedTransaction: signAs(prepared.transaction, trader),
  });
  assert.equal(status, 200);
  assert.equal(body.recorded, false);
  assert.equal(typeof body.signature, "string");
});

// ============================================
// 2.6 What submit refuses before anything is sent
// ============================================

test("submit: a bad token and an expired token are refused; nothing is sent", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  const prepared = await prepareBuy(app);
  const signedTransaction = signAs(prepared.transaction, trader);

  const garbage = await post(app, `${TOKEN_ID}/trade/submit`, { prepareToken: "a.b.c", signedTransaction });
  assert.equal(garbage.status, 400);
  assert.equal(garbage.body.error, "prepare_token_invalid");

  const [header, payload, signature] = (prepared.prepareToken as string).split(".") as [string, string, string];
  const forged = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  forged.trade.solLamports = "1";
  const forgedToken = `${header}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`;
  const changed = await post(app, `${TOKEN_ID}/trade/submit`, { prepareToken: forgedToken, signedTransaction });
  assert.equal(changed.status, 400);
  assert.deepEqual(changed.body, { error: "prepare_token_invalid", reason: "bad_signature" });

  const missing = await post(app, `${TOKEN_ID}/trade/submit`, { signedTransaction });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "invalid_payload");

  world.nowMs += 90_000;
  const late = await post(app, `${TOKEN_ID}/trade/submit`, { prepareToken: prepared.prepareToken, signedTransaction });
  assert.equal(late.status, 400);
  assert.deepEqual(late.body, { error: "prepare_token_invalid", reason: "expired" });

  assert.equal(world.calls.sent.length, 0);
  assert.equal(world.trades.length, 0);
});

test("submit: another user's token is refused, and so is another organization's", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  const prepared = await prepareBuy(app);
  const submission = {
    prepareToken: prepared.prepareToken,
    signedTransaction: signAs(prepared.transaction, trader),
  };

  world.auth = { userId: "user_2", orgId: "org_1" };
  const otherUser = await post(app, `${TOKEN_ID}/trade/submit`, submission);
  assert.equal(otherUser.status, 403);
  assert.deepEqual(otherUser.body, { error: "prepare_token_not_yours" });

  world.auth = { userId: "user_1", orgId: "org_2" };
  const otherOrg = await post(app, `${TOKEN_ID}/trade/submit`, submission);
  assert.equal(otherOrg.status, 403);
  assert.deepEqual(otherOrg.body, { error: "prepare_token_not_yours" });

  assert.equal(world.calls.sent.length, 0);

  world.auth = { userId: "user_1", orgId: "org_1" };
  assert.equal((await post(app, `${TOKEN_ID}/trade/submit`, submission)).status, 200);
});

test("submit: a token of another kind or for another token is refused", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  const prepared = await prepareBuy(app);
  const submission = {
    prepareToken: prepared.prepareToken,
    signedTransaction: signAs(prepared.transaction, trader),
  };

  const asFees = await post(app, `${TOKEN_ID}/fees/submit`, submission);
  assert.equal(asFees.status, 400);
  assert.deepEqual(asFees.body, { error: "prepare_token_invalid", reason: "wrong_kind" });

  const asGraduation = await post(app, `${TOKEN_ID}/graduate/submit`, submission);
  assert.equal(asGraduation.status, 400);
  assert.deepEqual(asGraduation.body, { error: "prepare_token_invalid", reason: "wrong_kind" });

  const elsewhere = await post(app, `${OTHER_CURVE_ID}/trade/submit`, submission);
  assert.equal(elsewhere.status, 400);
  assert.deepEqual(elsewhere.body, { error: "prepare_token_invalid", reason: "wrong_token" });

  assert.equal(world.calls.sent.length, 0);
});

test("submit: a tampered transaction is never sent", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  const prepared = await prepareBuy(app);

  // The same wallet signs a transaction of its own making. Each is valid
  // and fully signed, and none is the one that was built.
  const built = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"));
  const ours = instructionsOf(prepared.transaction);
  const [limit, price, swap] = ours as [TransactionInstruction, TransactionInstruction, TransactionInstruction];
  const stranger = Keypair.fromSeed(new Uint8Array(32).fill(41));
  const variants: Record<string, string> = {
    "a bigger buy": signOwn(trader, [limit, price, memo([trader.publicKey], "swap buy 9900000000 0")]),
    "an added instruction": signOwn(trader, [...ours, memo([trader.publicKey], "and something else")]),
    "an unknown program in front": signOwn(trader, [
      new TransactionInstruction({ programId: stranger.publicKey, keys: [], data: Buffer.alloc(0) }),
      ...ours,
    ]),
    "the work taken out": signOwn(trader, [limit, price]),
    "a reordered pair": signOwn(trader, [limit, swap, price]),
    "another fee payer": signOwn(stranger, [limit, price, memo([stranger.publicKey], "swap buy 100000000 4603500118800")]),
  };
  for (const [name, signedTransaction] of Object.entries(variants)) {
    const { status, body } = await post(app, `${TOKEN_ID}/trade/submit`, {
      prepareToken: prepared.prepareToken,
      signedTransaction,
    });
    assert.equal(status, 400, name);
    assert.deepEqual(body, { error: "transaction_mismatch", reason: "message_mismatch" }, name);
  }

  const junk = await post(app, `${TOKEN_ID}/trade/submit`, {
    prepareToken: prepared.prepareToken,
    signedTransaction: "AAAA",
  });
  assert.equal(junk.status, 400);
  assert.deepEqual(junk.body, { error: "transaction_mismatch", reason: "undecodable" });

  assert.equal(world.calls.sent.length, 0);
  assert.equal(world.calls.statusAsked.length, 0);
  assert.equal(world.trades.length, 0);

  // The one that was built still goes through.
  built.sign([trader]);
  const honest = await post(app, `${TOKEN_ID}/trade/submit`, {
    prepareToken: prepared.prepareToken,
    signedTransaction: Buffer.from(built.serialize()).toString("base64"),
  });
  assert.equal(honest.status, 200);
  assert.equal(world.calls.sent.length, 1);
});

test("submit: what a wallet adds for itself is accepted, and the transaction is sent as the wallet signed it", async () => {
  // Phantom, asked to sign a transaction that carries no signature yet, may
  // add priority-fee instructions and Lighthouse assertions of its own.
  const assertion = new TransactionInstruction({
    programId: new PublicKey(LIGHTHOUSE_PROGRAM_ID),
    keys: [{ pubkey: trader.publicKey, isSigner: false, isWritable: false }],
    data: Buffer.from("the balance did not fall by more than expected", "utf8"),
  });
  const walletPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_000 });
  const changes: Array<(ours: TransactionInstruction[]) => string> = [
    (ours) => signOwn(trader, [walletPrice, ...ours]),
    (ours) => signOwn(trader, [...ours, assertion]),
    (ours) => signOwn(trader, [walletPrice, ...ours, assertion]),
    // A fresher blockhash, and nothing else.
    (ours) => signOwn(trader, ours, Keypair.generate().publicKey.toBase58()),
  ];
  for (const change of changes) {
    const world = makeWorld();
    const app = await makeApp(world);
    const prepared = await prepareBuy(app);
    const signedTransaction = change(instructionsOf(prepared.transaction));
    assert.notEqual(signedTransaction, signAs(prepared.transaction, trader));
    const { status, body } = await post(app, `${TOKEN_ID}/trade/submit`, {
      prepareToken: prepared.prepareToken,
      signedTransaction,
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(world.calls.sent.length, 1);
    assert.deepEqual(Buffer.from(world.calls.sent[0]!), Buffer.from(signedTransaction, "base64"));
    assert.equal(body.signature, signatureOf(Buffer.from(signedTransaction, "base64")));
    assert.equal(world.trades.length, 1);
    // Confirmed with the blockhash the wallet signed, whichever that is.
    const sentTx = VersionedTransaction.deserialize(world.calls.sent[0]!);
    assert.equal(world.calls.confirmedWith[0]!.blockhash, sentTx.message.recentBlockhash);
  }
});

test("submit: a transaction without its signature is never sent", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  const prepared = await prepareBuy(app);
  const { status, body } = await post(app, `${TOKEN_ID}/trade/submit`, {
    prepareToken: prepared.prepareToken,
    signedTransaction: prepared.transaction,
  });
  assert.equal(status, 400);
  assert.deepEqual(body, { error: "transaction_mismatch", reason: "missing_signature" });
  assert.equal(world.calls.sent.length, 0);
});

test("submit: a refusal by the node is 502 send_failed, an unconfirmed transaction is 502 with its signature; no row either way", async () => {
  const refused = makeWorld({ sendError: new Error("Transaction simulation failed: insufficient lamports") });
  const refusedApp = await makeApp(refused);
  const first = await prepareBuy(refusedApp);
  const sendFailed = await post(refusedApp, `${TOKEN_ID}/trade/submit`, {
    prepareToken: first.prepareToken,
    signedTransaction: signAs(first.transaction, trader),
  });
  assert.equal(sendFailed.status, 502);
  assert.deepEqual(sendFailed.body, {
    error: "send_failed",
    message: "Transaction simulation failed: insufficient lamports",
  });
  assert.equal(refused.trades.length, 0);

  const lost = makeWorld({ confirmError: new Error("block height exceeded"), statusAfterSend: "not_seen" });
  const lostApp = await makeApp(lost);
  const second = await prepareBuy(lostApp);
  const signedTransaction = signAs(second.transaction, trader);
  const notConfirmed = await post(lostApp, `${TOKEN_ID}/trade/submit`, {
    prepareToken: second.prepareToken,
    signedTransaction,
  });
  assert.equal(notConfirmed.status, 502);
  assert.deepEqual(notConfirmed.body, {
    error: "transaction_not_confirmed",
    signature: signatureOf(Buffer.from(signedTransaction, "base64")),
    message: "block height exceeded",
  });
  assert.equal(lost.trades.length, 0);
  assert.equal(lost.calls.readBack.length, 0);
  // Asked before the send, and once more when the wait failed.
  const lostSignature = signatureOf(Buffer.from(signedTransaction, "base64"));
  assert.deepEqual(lost.calls.statusAsked, [lostSignature, lostSignature]);

  // The same when the chain cannot even be asked.
  const mute = makeWorld({ confirmError: new Error("block height exceeded") });
  const muteApp = await makeApp(mute);
  const third = await prepareBuy(muteApp);
  mute.statusError = new Error("429 Too Many Requests");
  const unasked = await post(muteApp, `${TOKEN_ID}/trade/submit`, {
    prepareToken: third.prepareToken,
    signedTransaction: signAs(third.transaction, trader),
  });
  assert.equal(unasked.status, 502);
  assert.equal(unasked.body.error, "transaction_not_confirmed");
  assert.equal(typeof unasked.body.signature, "string");
  // A status that could not be asked before the send did not stop a live token from sending.
  assert.equal(mute.calls.sent.length, 1);
  assert.equal(mute.trades.length, 0);
});

// ============================================
// A sent transaction that was not seen confirmed, and a submit posted again
// ============================================

test("submit: the wait for the confirmation fails but the transaction succeeded: it is recorded as confirmed", async () => {
  const world = makeWorld({
    confirmError: new Error("block height exceeded"),
    statusAfterSend: "succeeded",
    confirmed: vaultsMoved(["1250000000", "1349900000"], ["900000000000000", "895350001000000"]),
  });
  const app = await makeApp(world);
  const prepared = await prepareBuy(app);
  const signedTransaction = signAs(prepared.transaction, trader);
  const { status, body } = await post(app, `${TOKEN_ID}/trade/submit`, {
    prepareToken: prepared.prepareToken,
    signedTransaction,
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body, {
    signature: signatureOf(Buffer.from(signedTransaction, "base64")),
    trade: { side: "buy", solLamports: "99900000", tokenAmountRaw: "4649999000000" },
    recorded: true,
  });
  assert.equal(world.trades.length, 1);
});

test("submit: a transaction that failed on chain is 409 transaction_failed with its signature, and nothing is recorded", async () => {
  const world = makeWorld({
    confirmError: new Error("the transaction failed on chain: {\"InstructionError\":[2,{\"Custom\":6001}]}"),
    statusAfterSend: "failed",
  });
  const app = await makeApp(world);
  const prepared = await prepareBuy(app);
  const submission = {
    prepareToken: prepared.prepareToken,
    signedTransaction: signAs(prepared.transaction, trader),
  };
  const signature = signatureOf(Buffer.from(submission.signedTransaction, "base64"));
  const { status, body } = await post(app, `${TOKEN_ID}/trade/submit`, submission);
  assert.equal(status, 409);
  assert.deepEqual(body, {
    error: "transaction_failed",
    signature,
    message: "The chain refused this transaction. Nothing was changed by it.",
  });
  assert.equal(world.trades.length, 0);
  assert.equal(world.calls.readBack.length, 0);

  // Posted again: the chain already says it failed, so it is not sent a second time.
  const again = await post(app, `${TOKEN_ID}/trade/submit`, submission);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "transaction_failed");
  assert.equal(again.body.signature, signature);
  assert.equal(world.calls.sent.length, 1);
  assert.equal(world.trades.length, 0);
});

test("submit is safe to post again: a transaction that landed after all is recorded once and never sent twice", async () => {
  const world = makeWorld({ confirmError: new Error("block height exceeded"), statusAfterSend: "not_seen" });
  const app = await makeApp(world);
  const prepared = await prepareBuy(app);
  const submission = {
    prepareToken: prepared.prepareToken,
    signedTransaction: signAs(prepared.transaction, trader),
  };
  const signature = signatureOf(Buffer.from(submission.signedTransaction, "base64"));
  const first = await post(app, `${TOKEN_ID}/trade/submit`, submission);
  assert.equal(first.status, 502);
  assert.equal(first.body.error, "transaction_not_confirmed");
  assert.equal(first.body.signature, signature);
  assert.equal(world.trades.length, 0);

  // It did land. Four minutes later the page asks again with the same body:
  // the token ran out long ago, and still vouches for what already succeeded.
  world.statuses[signature] = "succeeded";
  world.nowMs += 240_000;
  const second = await post(app, `${TOKEN_ID}/trade/submit`, submission);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.signature, signature);
  assert.equal(second.body.recorded, true);
  assert.equal(world.trades.length, 1);
  assert.equal(world.trades[0]!.txSignature, signature);

  const third = await post(app, `${TOKEN_ID}/trade/submit`, submission);
  assert.equal(third.status, 200);
  assert.equal(world.trades.length, 1);
  assert.equal(world.calls.sent.length, 1, "sent once, by the first call only");
});

test("submit: an expired token is never a reason to send, and its grace covers nothing but the clock", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  const prepared = await prepareBuy(app);
  const submission = {
    prepareToken: prepared.prepareToken,
    signedTransaction: signAs(prepared.transaction, trader),
  };
  const signature = signatureOf(Buffer.from(submission.signedTransaction, "base64"));

  // Ran out two minutes ago and the chain has not seen the transaction.
  world.nowMs += 210_000;
  const notSeen = await post(app, `${TOKEN_ID}/trade/submit`, submission);
  assert.equal(notSeen.status, 400);
  assert.deepEqual(notSeen.body, { error: "prepare_token_invalid", reason: "expired" });

  // The chain cannot be asked: the same, nothing is taken on trust.
  world.statusError = new Error("429 Too Many Requests");
  const unasked = await post(app, `${TOKEN_ID}/trade/submit`, submission);
  assert.equal(unasked.status, 400);
  assert.deepEqual(unasked.body, { error: "prepare_token_invalid", reason: "expired" });
  world.statusError = null;

  // The transaction did succeed (the wallet sent it itself, say). Every
  // other check still stands: the user, the kind, the token, the message.
  world.statuses[signature] = "succeeded";
  world.auth = { userId: "user_2", orgId: "org_1" };
  assert.equal((await post(app, `${TOKEN_ID}/trade/submit`, submission)).status, 403);
  world.auth = { userId: "user_1", orgId: "org_1" };
  const asFees = await post(app, `${TOKEN_ID}/fees/submit`, submission);
  assert.deepEqual(asFees.body, { error: "prepare_token_invalid", reason: "wrong_kind" });
  const elsewhere = await post(app, `${OTHER_CURVE_ID}/trade/submit`, submission);
  assert.deepEqual(elsewhere.body, { error: "prepare_token_invalid", reason: "wrong_token" });
  const other = signOwn(trader, [memo([trader.publicKey], "something else that succeeded")]);
  world.statuses[signatureOf(Buffer.from(other, "base64"))] = "succeeded";
  const crossed = await post(app, `${TOKEN_ID}/trade/submit`, {
    prepareToken: prepared.prepareToken,
    signedTransaction: other,
  });
  assert.deepEqual(crossed.body, { error: "transaction_mismatch", reason: "message_mismatch" });
  assert.equal(world.trades.length, 0);

  // With everything in order it is recorded, and nothing is sent.
  const recorded = await post(app, `${TOKEN_ID}/trade/submit`, submission);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.equal(world.trades.length, 1);

  // Ten minutes after it ran out the token is no good for anything.
  world.nowMs = Date.parse(prepared.expiresAt) + 600_000;
  const tooLate = await post(app, `${TOKEN_ID}/trade/submit`, submission);
  assert.equal(tooLate.status, 400);
  assert.deepEqual(tooLate.body, { error: "prepare_token_invalid", reason: "expired" });

  assert.equal(world.calls.sent.length, 0);
});

test("submit: the signature of another transaction that succeeded gets nothing recorded and nothing sent", async () => {
  // Someone else's buy has succeeded on chain; its signature is public.
  const world = makeWorld({ confirmed: vaultsMoved(["1250000000", "1350000000"], ["900000000000", "895000000000"]) });
  const app = await makeApp(world);
  const theirs = VersionedTransaction.deserialize(
    Buffer.from(signOwn(creator, [memo([creator.publicKey], "someone else's buy")]), "base64"),
  );
  world.statuses[bs58.encode(theirs.signatures[0]!)] = "succeeded";

  // Our own prepared transaction, never signed: the slot holds their signature.
  const withTheirs = (transactionBase64: string) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, "base64"));
    tx.signatures[0] = theirs.signatures[0]!;
    return Buffer.from(tx.serialize()).toString("base64");
  };
  const prepared = await prepareBuy(app);
  const trade = await post(app, `${TOKEN_ID}/trade/submit`, {
    prepareToken: prepared.prepareToken,
    signedTransaction: withTheirs(prepared.transaction),
  });
  assert.equal(trade.status, 400);
  assert.deepEqual(trade.body, { error: "transaction_mismatch", reason: "bad_signature" });
  assert.equal(world.trades.length, 0);

  // The same against the grace of a token that ran out.
  world.nowMs += 240_000;
  const late = await post(app, `${TOKEN_ID}/trade/submit`, {
    prepareToken: prepared.prepareToken,
    signedTransaction: withTheirs(prepared.transaction),
  });
  assert.deepEqual(late.body, { error: "transaction_mismatch", reason: "bad_signature" });
  assert.equal(world.trades.length, 0);

  // A full pool that has NOT moved must not be written as graduated.
  world.pool = fullPool();
  const move = await post(app, `${TOKEN_ID}/graduate/prepare`, { wallet: TRADER });
  assert.equal(move.status, 200, JSON.stringify(move.body));
  assert.equal(move.body.step, "migrate");
  const graduated = await post(app, `${TOKEN_ID}/graduate/submit`, {
    prepareToken: move.body.prepareToken,
    signedTransaction: withTheirs(move.body.transaction),
  });
  assert.deepEqual(graduated.body, { error: "transaction_mismatch", reason: "bad_signature" });
  assert.equal(world.graduations.length, 0);
  assert.equal(world.tokens[TOKEN_ID]!.status, "BONDING");

  assert.equal(world.calls.sent.length, 0);
  assert.deepEqual(world.calls.statusAsked, [], "the chain is not even asked about a signature that is not ours");
});

// ============================================
// 2.4 The creator's fee claim
// ============================================

test("fees prepare: only the pool's creator as the chain has it, and only when something waits", async () => {
  const world = makeWorld();
  const app = await makeApp(world);

  const stranger = await post(app, `${TOKEN_ID}/fees/prepare`, { wallet: TRADER });
  assert.equal(stranger.status, 403);
  assert.deepEqual(stranger.body, { error: "not_the_creator" });

  const badWallet = await post(app, `${TOKEN_ID}/fees/prepare`, { wallet: "nope" });
  assert.equal(badWallet.status, 400);
  assert.deepEqual(badWallet.body, { error: "invalid_wallet" });

  world.pool = snapshot({ creatorClaimableLamports: 0n });
  const nothing = await post(app, `${TOKEN_ID}/fees/prepare`, { wallet: CREATOR });
  assert.equal(nothing.status, 409);
  assert.deepEqual(nothing.body, { error: "nothing_to_claim" });

  assert.equal(world.calls.claims.length, 0);
});

test("fees prepare: reads the pool afresh, whatever is remembered", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  await get(app, `${TOKEN_ID}/curve`);
  // The creator changed on chain a moment ago.
  world.pool = snapshot({ creatorAddress: TRADER });
  const formerCreator = await post(app, `${TOKEN_ID}/fees/prepare`, { wallet: CREATOR });
  assert.equal(formerCreator.status, 403);
  assert.equal(world.calls.readCurve, 2);
});

test("fees: the claim is built for the creator, sent as signed, and answers what left the vault", async () => {
  const world = makeWorld({
    confirmed: {
      blockTime: 1_791_813_700,
      accountKeys: [CREATOR, VAULT],
      preTokenBalances: [{ accountIndex: 1, mint: CURVE_QUOTE_MINT, owner: "PoolAuthority", amountRaw: "1252329499" }],
      postTokenBalances: [{ accountIndex: 1, mint: CURVE_QUOTE_MINT, owner: "PoolAuthority", amountRaw: "1250000000" }],
    },
  });
  const app = await makeApp(world);
  const prepared = await post(app, `${TOKEN_ID}/fees/prepare`, { wallet: CREATOR });
  assert.equal(prepared.status, 200);
  assert.deepEqual(Object.keys(prepared.body).sort(), [
    "claimableLamports",
    "claimableSol",
    "expiresAt",
    "prepareToken",
    "transaction",
  ]);
  assert.equal(prepared.body.claimableLamports, "2329499");
  assert.equal(prepared.body.claimableSol, "0.002329499");
  assert.deepEqual(world.calls.claims, [{ poolAddress: POOL, creator: CREATOR }]);
  const tx = VersionedTransaction.deserialize(Buffer.from(prepared.body.transaction, "base64"));
  assert.equal(tx.message.staticAccountKeys[0]?.toBase58(), CREATOR);

  // Unsigned: refused. Signed by someone else: not the message's signer, so the slot stays empty.
  const unsigned = await post(app, `${TOKEN_ID}/fees/submit`, {
    prepareToken: prepared.body.prepareToken,
    signedTransaction: prepared.body.transaction,
  });
  assert.equal(unsigned.status, 400);
  assert.deepEqual(unsigned.body, { error: "transaction_mismatch", reason: "missing_signature" });
  assert.equal(world.calls.sent.length, 0);

  const signedTransaction = signAs(prepared.body.transaction, creator);
  const { status, body } = await post(app, `${TOKEN_ID}/fees/submit`, {
    prepareToken: prepared.body.prepareToken,
    signedTransaction,
  });
  assert.equal(status, 200);
  assert.deepEqual(body, {
    signature: signatureOf(Buffer.from(signedTransaction, "base64")),
    claimedLamports: "2329499",
  });
  assert.equal(world.calls.sent.length, 1);
  // A claim is not a trade.
  assert.equal(world.trades.length, 0);

  // The claim begins with its own compute budget too.
  assert.deepEqual(
    instructionsOf(prepared.body.transaction).map((instruction) => instruction.programId.toBase58()),
    [COMPUTE_BUDGET_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, MEMO.toBase58()],
  );

  // Posted again: the same answer, and the claim is not sent a second time.
  const again = await post(app, `${TOKEN_ID}/fees/submit`, {
    prepareToken: prepared.body.prepareToken,
    signedTransaction,
  });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, body);
  assert.equal(world.calls.sent.length, 1);
});

test("fees: when the confirmed transaction cannot be read, the prepared amount is answered", async () => {
  const world = makeWorld({ confirmed: null });
  const app = await makeApp(world);
  const prepared = await post(app, `${TOKEN_ID}/fees/prepare`, { wallet: CREATOR });
  const { status, body } = await post(app, `${TOKEN_ID}/fees/submit`, {
    prepareToken: prepared.body.prepareToken,
    signedTransaction: signAs(prepared.body.transaction, creator),
  });
  assert.equal(status, 200);
  assert.equal(body.claimedLamports, "2329499");
});

// ============================================
// 2.5 Graduation
// ============================================

test("graduate prepare: 409 curve_not_full while trading, 409 already_graduated after", async () => {
  const world = makeWorld();
  const app = await makeApp(world);
  const early = await post(app, `${TOKEN_ID}/graduate/prepare`, { wallet: TRADER });
  assert.equal(early.status, 409);
  assert.deepEqual(early.body, { error: "curve_not_full" });

  world.pool = graduatedPool();
  world.tokens[TOKEN_ID] = { ...world.tokens[TOKEN_ID]!, status: "GRADUATED" };
  const late = await post(app, `${TOKEN_ID}/graduate/prepare`, { wallet: TRADER });
  assert.equal(late.status, 409);
  assert.deepEqual(late.body, { error: "already_graduated", graduatedPoolAddress: DAMM_POOL });

  assert.equal(world.calls.lockers.length + world.calls.migrations.length, 0);
  assert.equal(world.graduations.length, 0);
});

test("graduate prepare: a pool that graduated without us brings the row in line", async () => {
  const world = makeWorld({ pool: graduatedPool() });
  const app = await makeApp(world);
  const { status, body } = await post(app, `${TOKEN_ID}/graduate/prepare`, { wallet: TRADER });
  assert.equal(status, 409);
  assert.equal(body.error, "already_graduated");
  assert.deepEqual(world.graduations, [
    { tokenId: TOKEN_ID, graduatedPoolAddress: DAMM_POOL, at: new Date(world.nowMs), creatorLockupEnd: null },
  ]);
});

test("graduation in two steps: the locker first when tokens are locked and the pool's progress says it is not made, then the move", async () => {
  // Progress 1: the curve is full and the locker is still to be made.
  const world = makeWorld({ pool: fullPool({ migrationProgress: 1, lockedVesting: LOCKED }) });
  const app = await makeApp(world);

  // Step 1: the locker. Any wallet may pay.
  const lockerStep = await post(app, `${TOKEN_ID}/graduate/prepare`, { wallet: TRADER });
  assert.equal(lockerStep.status, 200);
  assert.deepEqual(Object.keys(lockerStep.body).sort(), [
    "expiresAt",
    "prepareToken",
    "step",
    "stepsLeftAfterThis",
    "transaction",
  ]);
  assert.equal(lockerStep.body.step, "locker");
  assert.equal(lockerStep.body.stepsLeftAfterThis, 1);
  assert.deepEqual(world.calls.lockers, [{ poolAddress: POOL, payer: TRADER }]);
  assert.equal(world.calls.migrations.length, 0);
  // The wallet alone signs the locker: it carries its own compute budget,
  // 400,000 units because its cost was never measured.
  const lockerInstructions = instructionsOf(lockerStep.body.transaction);
  assert.deepEqual(
    lockerInstructions.map((instruction) => instruction.programId.toBase58()),
    [COMPUTE_BUDGET_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, MEMO.toBase58()],
  );
  assert.deepEqual(
    Buffer.from(lockerInstructions[0]!.data),
    Buffer.from(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }).data),
  );

  const lockerSigned = signAs(lockerStep.body.transaction, trader);
  const lockerSent = await post(app, `${TOKEN_ID}/graduate/submit`, {
    prepareToken: lockerStep.body.prepareToken,
    signedTransaction: lockerSigned,
  });
  assert.equal(lockerSent.status, 200);
  assert.deepEqual(lockerSent.body, {
    signature: signatureOf(Buffer.from(lockerSigned, "base64")),
    step: "locker",
  });
  // The locker alone graduates nothing.
  assert.equal(world.graduations.length, 0);

  // Step 2: the move. Progress 2: the locker is made. The server has signed
  // with both position keypairs.
  world.pool = fullPool({ migrationProgress: 2, lockedVesting: LOCKED });
  const migrateStep = await post(app, `${TOKEN_ID}/graduate/prepare`, { wallet: TRADER });
  assert.equal(migrateStep.status, 200);
  assert.equal(migrateStep.body.step, "migrate");
  assert.equal(migrateStep.body.stepsLeftAfterThis, 0);
  assert.deepEqual(world.calls.migrations, [{ payer: TRADER, pool: POOL }]);

  const tx = VersionedTransaction.deserialize(Buffer.from(migrateStep.body.transaction, "base64"));
  assert.equal(tx.message.header.numRequiredSignatures, 3);
  // Signed by the server first, so the wallet leaves it alone: it is as the
  // SDK made it, with no compute budget of ours in front.
  assert.deepEqual(
    instructionsOf(migrateStep.body.transaction).map((instruction) => instruction.programId.toBase58()),
    [MEMO.toBase58()],
  );
  const keys = tx.message.staticAccountKeys.map((key) => key.toBase58());
  assert.equal(keys[0], TRADER);
  assert.ok(tx.signatures[0]!.every((byte) => byte === 0), "the payer's slot is left for the wallet");
  for (const keypair of world.positionKeypairs) {
    const slot = keys.indexOf(keypair.publicKey.toBase58());
    assert.ok(slot > 0 && slot < 3);
    assert.ok(tx.signatures[slot]!.some((byte) => byte !== 0), "a position keypair has signed");
  }

  // Without the payer's signature it is refused.
  const halfSigned = await post(app, `${TOKEN_ID}/graduate/submit`, {
    prepareToken: migrateStep.body.prepareToken,
    signedTransaction: migrateStep.body.transaction,
  });
  assert.equal(halfSigned.status, 400);
  assert.deepEqual(halfSigned.body, { error: "transaction_mismatch", reason: "missing_signature" });
  assert.equal(world.calls.sent.length, 1);

  world.nowMs += 20_000;
  const migrateSigned = signAs(migrateStep.body.transaction, trader);
  const migrated = await post(app, `${TOKEN_ID}/graduate/submit`, {
    prepareToken: migrateStep.body.prepareToken,
    signedTransaction: migrateSigned,
  });
  assert.equal(migrated.status, 200, JSON.stringify(migrated.body));
  assert.deepEqual(migrated.body, {
    signature: signatureOf(Buffer.from(migrateSigned, "base64")),
    step: "migrate",
    graduatedPoolAddress: DAMM_POOL,
  });
  // What is written: the token, the DAMM v2 pool's address, when, and the
  // creator's lock date: the moment the curve was finished plus the wait.
  assert.deepEqual(world.graduations, [
    {
      tokenId: TOKEN_ID,
      graduatedPoolAddress: DAMM_POOL,
      at: new Date(world.nowMs),
      creatorLockupEnd: new Date((FINISHED_AT + LOCKED.cliffSeconds) * 1000),
    },
  ]);

  // Posted again: the same answer, nothing sent, nothing written twice.
  const again = await post(app, `${TOKEN_ID}/graduate/submit`, {
    prepareToken: migrateStep.body.prepareToken,
    signedTransaction: migrateSigned,
  });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, migrated.body);
  assert.equal(world.calls.sent.length, 2);
  assert.equal(world.graduations.length, 1);
});

test("graduation: the move must come back byte for byte, whatever a wallet would add", async () => {
  const world = makeWorld({ pool: fullPool() });
  const app = await makeApp(world);
  const step = await post(app, `${TOKEN_ID}/graduate/prepare`, { wallet: TRADER });
  assert.equal(step.body.step, "migrate");

  // The wallet rebuilds the move with a priority fee of its own in front.
  // The position keypairs sign it too, as they would if they could be asked.
  const message = new TransactionMessage({
    payerKey: trader.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_000 }),
      ...instructionsOf(step.body.transaction),
    ],
  }).compileToV0Message();
  const changed = new VersionedTransaction(message);
  changed.sign([trader, ...world.positionKeypairs]);
  const { status, body } = await post(app, `${TOKEN_ID}/graduate/submit`, {
    prepareToken: step.body.prepareToken,
    signedTransaction: Buffer.from(changed.serialize()).toString("base64"),
  });
  assert.equal(status, 400);
  assert.deepEqual(body, { error: "transaction_mismatch", reason: "message_mismatch" });
  assert.equal(world.calls.sent.length, 0);
  assert.equal(world.graduations.length, 0);
});

test("graduation in one step when the config locks nothing for the creator", async () => {
  const world = makeWorld({ pool: fullPool() });
  const app = await makeApp(world);
  const step = await post(app, `${TOKEN_ID}/graduate/prepare`, { wallet: TRADER });
  assert.equal(step.status, 200);
  assert.equal(step.body.step, "migrate");
  assert.equal(step.body.stepsLeftAfterThis, 0);
  assert.equal(world.calls.lockers.length, 0);
});

test("graduation: a tampered move is never sent, and a failed move graduates nothing", async () => {
  const world = makeWorld({ pool: fullPool() });
  const app = await makeApp(world);
  const step = await post(app, `${TOKEN_ID}/graduate/prepare`, { wallet: TRADER });

  // A second prepare makes new position keypairs: another message.
  const other = await post(app, `${TOKEN_ID}/graduate/prepare`, { wallet: TRADER });
  const crossed = await post(app, `${TOKEN_ID}/graduate/submit`, {
    prepareToken: step.body.prepareToken,
    signedTransaction: signAs(other.body.transaction, trader),
  });
  assert.equal(crossed.status, 400);
  assert.deepEqual(crossed.body, { error: "transaction_mismatch", reason: "message_mismatch" });
  assert.equal(world.calls.sent.length, 0);

  world.confirmError = new Error("the transaction failed on chain");
  world.statusAfterSend = "failed";
  const failed = await post(app, `${TOKEN_ID}/graduate/submit`, {
    prepareToken: other.body.prepareToken,
    signedTransaction: signAs(other.body.transaction, trader),
  });
  assert.equal(failed.status, 409);
  assert.equal(failed.body.error, "transaction_failed");
  assert.equal(world.graduations.length, 0);

  // Sent, and not seen confirmed: nothing is written, the signature is answered.
  world.statusAfterSend = "not_seen";
  world.confirmError = new Error("block height exceeded");
  const third = await post(app, `${TOKEN_ID}/graduate/prepare`, { wallet: TRADER });
  const thirdSigned = signAs(third.body.transaction, trader);
  const lost = await post(app, `${TOKEN_ID}/graduate/submit`, {
    prepareToken: third.body.prepareToken,
    signedTransaction: thirdSigned,
  });
  assert.equal(lost.status, 502);
  assert.equal(lost.body.error, "transaction_not_confirmed");
  assert.equal(lost.body.signature, signatureOf(Buffer.from(thirdSigned, "base64")));
  assert.equal(world.graduations.length, 0);
});

test("graduation: moved on chain but not written is 500 persistence_failed with everything the page needs", async () => {
  const world = makeWorld({
    pool: fullPool(),
    markGraduatedError: new Error("database is down"),
  });
  const app = await makeApp(world);
  const step = await post(app, `${TOKEN_ID}/graduate/prepare`, { wallet: TRADER });
  const signedTransaction = signAs(step.body.transaction, trader);
  const { status, body } = await post(app, `${TOKEN_ID}/graduate/submit`, {
    prepareToken: step.body.prepareToken,
    signedTransaction,
  });
  assert.equal(status, 500);
  assert.deepEqual(body, {
    error: "persistence_failed",
    signature: signatureOf(Buffer.from(signedTransaction, "base64")),
    step: "migrate",
    graduatedPoolAddress: DAMM_POOL,
    message: "database is down",
  });
});
