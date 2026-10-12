/**
 * A token on a Meteora Dynamic Bonding Curve, after its launch: what the
 * curve's state is, what a buy or a sell would give, and the checks every
 * browser-signed transaction passes before it is sent.
 *
 * Nobody on our side holds a wallet. The server builds a transaction, the
 * browser wallet signs it, and `submit` sends it only when it is, byte for
 * byte, the message the server built:
 *
 *   prepare  compile the instructions to a v0 message, take the sha256 of
 *            the message's bytes, and put that hash in a short-lived signed
 *            token together with who asked and what is to be recorded.
 *   submit   verify the token, hash the message of the signed transaction
 *            that came back, compare the two hashes, check every signature
 *            slot is filled. Anything else is refused before it is sent.
 *
 * Everything that touches the chain sits behind ONE interface, CurveChain.
 * routes/tokenCurveBindings.ts implements it with Meteora's SDK and the
 * shared Solana connection; tests fake it. This file imports neither, so
 * nothing here can reach a network.
 *
 * Money is integers (lamports, raw token units) as bigint. A decimal string
 * is made once, at the edge, for people to read. The only floats are
 * `progress` (a bar on a page) and the display columns of a trade row.
 */

import { createHash } from "node:crypto";

import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";

import { signState, verifyState } from "./signedState.js";

// ============================================
// Facts
// ============================================

/** The curve is priced in SOL: the quote mint is wrapped SOL. */
export const CURVE_QUOTE_MINT = "So11111111111111111111111111111111111111112";
export const SOL_DECIMALS = 9;
/** Every token launched here: 6 decimals, a supply of 1,000,000,000. */
export const CURVE_TOKEN_DECIMALS = 6;
export const CURVE_TOKEN_SUPPLY_RAW = 1_000_000_000n * 10n ** BigInt(CURVE_TOKEN_DECIMALS);

/** A trading fee is a numerator over this, on chain and in the SDK. */
export const FEE_DENOMINATOR = 1_000_000_000n;

/** The most bytes a Solana transaction may be on the wire. */
export const MAX_TRANSACTION_BYTES = 1232;

export const SLIPPAGE_BPS_MIN = 1;
export const SLIPPAGE_BPS_MAX = 5000;
export const SLIPPAGE_BPS_DEFAULT = 100;

/** How long a prepared transaction may wait for its signature. */
export const CURVE_PREPARE_TTL_SECONDS = 90;

/** How many decimals a price in SOL is written with, before trailing zeros go. */
const PRICE_DECIMALS = 15;
const U64_MAX = (1n << 64n) - 1n;

export type SolanaNetwork = "devnet" | "mainnet-beta";
export type CurveState = "trading" | "full" | "graduated";
export type TradeSide = "buy" | "sell";

// ============================================
// The chain, behind one interface
// ============================================

/** The creator's tokens locked at graduation, as the config has them. */
export interface CurveLockedVesting {
  /** Raw token units released each period. */
  amountPerPeriod: bigint;
  /** Raw token units released when the cliff ends. */
  cliffUnlockAmount: bigint;
  /** Seconds from graduation during which nothing is released. */
  cliffSeconds: number;
  periods: number;
  /** Seconds one period lasts. */
  frequencySeconds: number;
}

/** One read of a pool and its config, as plain values. */
export interface CurveSnapshot {
  poolAddress: string;
  configAddress: string;
  mintAddress: string;
  /** The pool's creator as the chain has it. */
  creatorAddress: string;
  /** The pool's SOL vault. A sell and a fee claim are paid out of it. */
  quoteVault: string;
  /** The pool's price as the chain stores it: a square root, Q64.64. */
  sqrtPrice: bigint;
  /** Lamports raised so far. */
  quoteReserve: bigint;
  /** Lamports at which the curve is full. */
  migrationQuoteThreshold: bigint;
  isMigrated: boolean;
  /**
   * Lamports of trading fees the creator can claim now. This is the
   * `creator.unclaimedQuoteFee` of the SDK's fee breakdown, taken from the
   * pool account already read, so it costs no further request.
   */
  creatorClaimableLamports: bigint;
  /** The creator's share of trading fees, in percent. */
  creatorFeeSharePercent: number;
  lockedVesting: CurveLockedVesting;
  /** The DAMM v2 pool this curve graduates into; null when it cannot be derived. */
  graduatedPoolAddress: string | null;
  /** The implementation's own pool and config, handed back to it for a quote. */
  handle: unknown;
}

/** What a swap of `amountIn` would do, from the SDK's own arithmetic. */
export interface SwapQuoteRead {
  /** Raw units out, before any slippage allowance. */
  amountOut: bigint;
  /** Every fee the swap pays, in lamports (these curves take fees in SOL). */
  feeLamports: bigint;
  /** The pool's price after the swap, same form as CurveSnapshot.sqrtPrice. */
  nextSqrtPrice: bigint;
}

export interface CurveBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface TokenBalanceRead {
  /** Index into the transaction's account keys. */
  accountIndex: number;
  mint: string;
  owner: string | null;
  /** Raw units, as a string of digits. */
  amountRaw: string;
}

/** The parts of a confirmed transaction the trade row is read from. */
export interface ConfirmedTransactionRead {
  /** Unix seconds, or null when the node does not know. */
  blockTime: number | null;
  /** Every account of the transaction, lookups included, in order. */
  accountKeys: string[];
  preTokenBalances: TokenBalanceRead[];
  postTokenBalances: TokenBalanceRead[];
}

export interface CurveChain {
  /** A pool and its config. null when there is no pool at the address. */
  readCurve(poolAddress: string): Promise<CurveSnapshot | null>;
  /** The chain's clock in the unit the pool's fee schedule runs on. */
  currentPoint(snapshot: CurveSnapshot): Promise<bigint>;
  /** The trading fee at that point, over FEE_DENOMINATOR. No request. */
  tradeFeeNumerator(snapshot: CurveSnapshot, currentPoint: bigint): bigint;
  /** No request. Throws when the SDK refuses the amount. */
  quoteSwap(
    snapshot: CurveSnapshot,
    input: { sell: boolean; amountIn: bigint; currentPoint: bigint },
  ): SwapQuoteRead;
  buildSwap(input: {
    poolAddress: string;
    wallet: string;
    sell: boolean;
    amountIn: bigint;
    minimumOut: bigint;
  }): Promise<TransactionInstruction[]>;
  /** The creator claims every trading fee waiting for them, paid to themselves. */
  buildClaim(input: { poolAddress: string; creator: string }): Promise<TransactionInstruction[]>;
  /** Does the locker for the creator's locked tokens exist yet? */
  lockerExists(poolAddress: string): Promise<boolean>;
  buildLocker(input: { poolAddress: string; payer: string }): Promise<TransactionInstruction[]>;
  /** The move into a DAMM v2 pool. `signers` are the position keypairs the SDK makes. */
  buildMigration(
    snapshot: CurveSnapshot,
    input: { payer: string },
  ): Promise<{ instructions: TransactionInstruction[]; signers: Keypair[] }>;
  latestBlockhash(): Promise<CurveBlockhash>;
  /** Sends a signed transaction; returns its signature. */
  send(raw: Uint8Array): Promise<string>;
  /** Resolves once confirmed; throws when the transaction failed or expired. */
  confirm(signature: string, sentWith: CurveBlockhash): Promise<void>;
  readTransaction(signature: string): Promise<ConfirmedTransactionRead | null>;
}

// ============================================
// Decimal strings
// ============================================

/**
 * A typed amount ("0.1") as raw units. null for anything that is not a
 * plain non-negative decimal, for more decimals than the unit has (an
 * amount is never rounded behind someone's back), and for a number that
 * does not fit the chain's u64.
 */
export function parseUnits(text: string, decimals: number): bigint | null {
  if (typeof text !== "string" || text.length > 40) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  return raw > U64_MAX ? null : raw;
}

/** Raw units as a decimal string, without trailing zeros: 1250000000 is "1.25". */
export function formatUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * The price of one token in SOL, from the pool's square-root price. The
 * chain's number is lamports per raw token unit, Q64.64, as a square root;
 * the same formula as the SDK's getPriceFromSqrtPrice, in whole numbers.
 */
export function priceSolFromSqrtPrice(sqrtPrice: bigint): string {
  const scaled =
    (sqrtPrice * sqrtPrice * 10n ** BigInt(PRICE_DECIMALS + CURVE_TOKEN_DECIMALS - SOL_DECIMALS)) >> 128n;
  return formatUnits(scaled, PRICE_DECIMALS);
}

/** The whole supply at the pool's price, in lamports. */
export function marketCapLamportsFromSqrtPrice(sqrtPrice: bigint): bigint {
  return (sqrtPrice * sqrtPrice * CURVE_TOKEN_SUPPLY_RAW) >> 128n;
}

// ============================================
// The state of a curve
// ============================================

/**
 * Three states, from two facts of the pool. Graduated: the pool says it has
 * migrated. Full: it has raised its threshold and has not migrated.
 * Trading: anything else.
 */
export function deriveCurveState(snapshot: Pick<CurveSnapshot, "isMigrated" | "quoteReserve" | "migrationQuoteThreshold">): CurveState {
  if (snapshot.isMigrated) return "graduated";
  if (snapshot.quoteReserve >= snapshot.migrationQuoteThreshold) return "full";
  return "trading";
}

/** A snapshot with the chain's clock and the fee at that moment. */
export interface CurveReading {
  snapshot: CurveSnapshot;
  currentPoint: bigint;
  feeNumerator: bigint;
  readAt: Date;
}

export interface CurveCreatorLockedJson {
  /** Whole tokens. */
  amount: string;
  cliffSeconds: number;
  periods: number;
  totalSeconds: number;
}

/** The answer of GET /api/tokens/:id/curve. The web reads this shape. */
export interface CurveStateJson {
  launchpad: "meteora";
  network: SolanaNetwork;
  mintAddress: string;
  poolAddress: string;
  configAddress: string;
  state: CurveState;
  priceSol: string;
  marketCapSol: string;
  raisedLamports: string;
  raisedSol: string;
  graduationLamports: string;
  graduationSol: string;
  progress: number;
  feePercentNow: string;
  creatorAddress: string;
  creatorClaimableLamports: string;
  creatorClaimableSol: string;
  creatorFeeSharePercent: number;
  creatorLocked: CurveCreatorLockedJson | null;
  graduatedPoolAddress: string | null;
  readAt: string;
}

/** Raw token units the config locks for the creator at graduation. */
export function lockedVestingTotalRaw(vesting: CurveLockedVesting): bigint {
  return vesting.amountPerPeriod * BigInt(vesting.periods) + vesting.cliffUnlockAmount;
}

function describeLocked(vesting: CurveLockedVesting): CurveCreatorLockedJson | null {
  const total = lockedVestingTotalRaw(vesting);
  if (total <= 0n) return null;
  return {
    amount: formatUnits(total, CURVE_TOKEN_DECIMALS),
    cliffSeconds: vesting.cliffSeconds,
    periods: vesting.periods,
    totalSeconds: vesting.frequencySeconds * vesting.periods,
  };
}

/** A share between 0 and 1, for a progress bar only. */
function progressOf(raised: bigint, threshold: bigint): number {
  if (threshold <= 0n) return 1;
  if (raised >= threshold) return 1;
  if (raised <= 0n) return 0;
  return Number((raised * 1_000_000n) / threshold) / 1_000_000;
}

export function describeCurve(reading: CurveReading, network: SolanaNetwork): CurveStateJson {
  const { snapshot } = reading;
  const state = deriveCurveState(snapshot);
  return {
    launchpad: "meteora",
    network,
    mintAddress: snapshot.mintAddress,
    poolAddress: snapshot.poolAddress,
    configAddress: snapshot.configAddress,
    state,
    priceSol: priceSolFromSqrtPrice(snapshot.sqrtPrice),
    marketCapSol: formatUnits(marketCapLamportsFromSqrtPrice(snapshot.sqrtPrice), SOL_DECIMALS),
    raisedLamports: snapshot.quoteReserve.toString(),
    raisedSol: formatUnits(snapshot.quoteReserve, SOL_DECIMALS),
    graduationLamports: snapshot.migrationQuoteThreshold.toString(),
    graduationSol: formatUnits(snapshot.migrationQuoteThreshold, SOL_DECIMALS),
    progress: progressOf(snapshot.quoteReserve, snapshot.migrationQuoteThreshold),
    // numerator / 1e9 is a share; times 100 is a percentage.
    feePercentNow: formatUnits(reading.feeNumerator, 7),
    creatorAddress: snapshot.creatorAddress,
    creatorClaimableLamports: snapshot.creatorClaimableLamports.toString(),
    creatorClaimableSol: formatUnits(snapshot.creatorClaimableLamports, SOL_DECIMALS),
    creatorFeeSharePercent: snapshot.creatorFeeSharePercent,
    creatorLocked: describeLocked(snapshot.lockedVesting),
    graduatedPoolAddress: state === "graduated" ? snapshot.graduatedPoolAddress : null,
    readAt: reading.readAt.toISOString(),
  };
}

// ============================================
// Reading a pool, a few seconds at a time
// ============================================

/** The pool could not be read. The routes answer 503, never a guess. */
export class CurveUnreadableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CurveUnreadableError";
  }
}

export interface CurveReader {
  /** `fresh` skips what is remembered, for a decision that must not be stale. */
  read(poolAddress: string, options?: { fresh?: boolean }): Promise<CurveReading>;
  /** Forget a pool, after anything was sent that changes it. */
  drop(poolAddress: string): void;
}

/**
 * A public RPC limits requests, so a reading is kept for `cacheMs` and
 * calls that arrive while one is being made share it. A failed read is
 * never kept. A reading that was started before a drop is not kept either:
 * it may be from before the transaction that caused the drop.
 */
export function createCurveReader(deps: {
  chain: Pick<CurveChain, "readCurve" | "currentPoint" | "tradeFeeNumerator">;
  cacheMs: number;
  now: () => Date;
}): CurveReader {
  const kept = new Map<string, CurveReading>();
  const inFlight = new Map<string, Promise<CurveReading>>();
  const generation = new Map<string, number>();

  async function readNow(poolAddress: string): Promise<CurveReading> {
    let snapshot: CurveSnapshot | null;
    let currentPoint: bigint;
    let feeNumerator: bigint;
    try {
      snapshot = await deps.chain.readCurve(poolAddress);
      if (!snapshot) throw new Error("there is no pool at this address");
      currentPoint = await deps.chain.currentPoint(snapshot);
      feeNumerator = deps.chain.tradeFeeNumerator(snapshot, currentPoint);
    } catch (err) {
      throw new CurveUnreadableError(`pool ${poolAddress} could not be read: ${(err as Error).message}`, {
        cause: err,
      });
    }
    return { snapshot, currentPoint, feeNumerator, readAt: deps.now() };
  }

  return {
    read(poolAddress, options) {
      if (!options?.fresh) {
        const reading = kept.get(poolAddress);
        if (reading && deps.now().getTime() - reading.readAt.getTime() < deps.cacheMs) {
          return Promise.resolve(reading);
        }
        const pending = inFlight.get(poolAddress);
        if (pending) return pending;
      }
      const startedIn = generation.get(poolAddress) ?? 0;
      const pending: Promise<CurveReading> = readNow(poolAddress)
        .then((reading) => {
          if ((generation.get(poolAddress) ?? 0) === startedIn) kept.set(poolAddress, reading);
          return reading;
        })
        .finally(() => {
          if (inFlight.get(poolAddress) === pending) inFlight.delete(poolAddress);
        });
      inFlight.set(poolAddress, pending);
      return pending;
    },
    drop(poolAddress) {
      generation.set(poolAddress, (generation.get(poolAddress) ?? 0) + 1);
      kept.delete(poolAddress);
      inFlight.delete(poolAddress);
    },
  };
}

// ============================================
// A quote
// ============================================

/** The answer of POST /api/tokens/:id/trade/quote. The web reads this shape. */
export interface TradeQuoteJson {
  side: TradeSide;
  amountIn: string;
  amountInRaw: string;
  amountOut: string;
  amountOutRaw: string;
  minimumOut: string;
  minimumOutRaw: string;
  feeSol: string;
  priceSolAfter: string;
}

/** The least a trade may give: the quoted amount less the allowance, rounded down. */
export function minimumOutFor(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** A buy pays SOL and gets tokens; a sell is the other way round. */
export function buildTradeQuote(input: {
  side: TradeSide;
  amountInRaw: bigint;
  slippageBps: number;
  swap: SwapQuoteRead;
}): TradeQuoteJson {
  const inDecimals = input.side === "buy" ? SOL_DECIMALS : CURVE_TOKEN_DECIMALS;
  const outDecimals = input.side === "buy" ? CURVE_TOKEN_DECIMALS : SOL_DECIMALS;
  const minimumOut = minimumOutFor(input.swap.amountOut, input.slippageBps);
  return {
    side: input.side,
    amountIn: formatUnits(input.amountInRaw, inDecimals),
    amountInRaw: input.amountInRaw.toString(),
    amountOut: formatUnits(input.swap.amountOut, outDecimals),
    amountOutRaw: input.swap.amountOut.toString(),
    minimumOut: formatUnits(minimumOut, outDecimals),
    minimumOutRaw: minimumOut.toString(),
    feeSol: formatUnits(input.swap.feeLamports, SOL_DECIMALS),
    priceSolAfter: priceSolFromSqrtPrice(input.swap.nextSqrtPrice),
  };
}

// ============================================
// The prepare token
// ============================================

// signedState.ts fixes the token's first segment for every caller; what is
// this token's own is the purpose below, which verifyState requires to
// match. A token signed for anything else is refused as wrong_purpose.
const CURVE_PREPARE_PURPOSE = "wheelsai-curve-prep-v1";

export type CurvePrepareKind = "trade" | "fees" | "graduate";
export type GraduationStep = "locker" | "migrate";

export interface CurvePreparePayload {
  kind: CurvePrepareKind;
  /** AgentToken id. */
  tokenId: string;
  mintAddress: string;
  poolAddress: string;
  /** The pool's SOL vault: what a sell or a claim took is read from its balance. */
  quoteVault: string;
  /** The wallet the transaction was built for: its fee payer. */
  wallet: string;
  /** Who asked. null for an API key, which belongs to an organization only. */
  userId: string | null;
  orgId: string;
  /** sha256, in hex, of the compiled message's bytes. */
  messageHash: string;
  /** With the message's blockhash, what confirming the transaction needs. */
  lastValidBlockHeight: number;
  /** kind "trade": the quote's numbers, written when the transaction cannot be read back. */
  trade?: { side: TradeSide; solLamports: string; tokenAmountRaw: string };
  /** kind "fees": what could be claimed when the transaction was built. */
  fees?: { claimableLamports: string };
  /** kind "graduate": which step this is and, for the move, the pool it makes. */
  graduate?: { step: GraduationStep; graduatedPoolAddress: string | null };
}

export type CurvePrepareFailure =
  | "bad_secret"
  | "malformed"
  | "wrong_header"
  | "bad_signature"
  | "expired"
  | "wrong_purpose"
  | "payload_invalid";

export type CurvePrepareVerifyResult =
  | { ok: true; payload: CurvePreparePayload }
  | { ok: false; reason: CurvePrepareFailure };

export function signCurvePrepareToken(input: {
  payload: CurvePreparePayload;
  secret: string;
  now?: () => Date;
}): { token: string; expiresAt: Date } {
  const now = input.now ?? (() => new Date());
  const token = signState({
    payload: { ...input.payload, purpose: CURVE_PREPARE_PURPOSE },
    secret: input.secret,
    ttlSeconds: CURVE_PREPARE_TTL_SECONDS,
    now,
  });
  // The same second signState stamped: it floors the clock to seconds.
  const expiresAt = new Date((Math.floor(now().getTime() / 1000) + CURVE_PREPARE_TTL_SECONDS) * 1000);
  return { token, expiresAt };
}

const DIGITS = /^\d+$/;

function isDigits(value: unknown): value is string {
  return typeof value === "string" && DIGITS.test(value);
}

function payloadIsWhole(payload: Record<string, unknown>): boolean {
  if (
    typeof payload.tokenId !== "string" ||
    typeof payload.mintAddress !== "string" ||
    typeof payload.poolAddress !== "string" ||
    typeof payload.quoteVault !== "string" ||
    typeof payload.wallet !== "string" ||
    !(typeof payload.userId === "string" || payload.userId === null) ||
    typeof payload.orgId !== "string" ||
    typeof payload.messageHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(payload.messageHash) ||
    typeof payload.lastValidBlockHeight !== "number"
  ) {
    return false;
  }
  if (payload.kind === "trade") {
    const trade = payload.trade as Record<string, unknown> | undefined;
    return (
      typeof trade === "object" &&
      trade !== null &&
      (trade.side === "buy" || trade.side === "sell") &&
      isDigits(trade.solLamports) &&
      isDigits(trade.tokenAmountRaw)
    );
  }
  if (payload.kind === "fees") {
    const fees = payload.fees as Record<string, unknown> | undefined;
    return typeof fees === "object" && fees !== null && isDigits(fees.claimableLamports);
  }
  if (payload.kind === "graduate") {
    const graduate = payload.graduate as Record<string, unknown> | undefined;
    return (
      typeof graduate === "object" &&
      graduate !== null &&
      (graduate.step === "locker" || graduate.step === "migrate") &&
      (typeof graduate.graduatedPoolAddress === "string" || graduate.graduatedPoolAddress === null)
    );
  }
  return false;
}

export function verifyCurvePrepareToken(input: {
  token: string;
  secret: string;
  now?: () => Date;
}): CurvePrepareVerifyResult {
  const verified = verifyState({
    token: input.token,
    secret: input.secret,
    expectedPurpose: CURVE_PREPARE_PURPOSE,
    now: input.now,
  });
  if (!verified.ok) return verified;
  if (!payloadIsWhole(verified.payload)) return { ok: false, reason: "payload_invalid" };
  return { ok: true, payload: verified.payload as unknown as CurvePreparePayload };
}

// ============================================
// The transaction: built here, signed in the browser
// ============================================

export function messageHashOf(tx: VersionedTransaction): string {
  return createHash("sha256").update(tx.message.serialize()).digest("hex");
}

/**
 * The instructions as one v0 transaction with `payer` paying. Nothing is
 * signed here unless `signers` are given (graduation's position keypairs);
 * the payer's slot is always left for the browser wallet.
 */
export function compileCurveTransaction(input: {
  payer: string;
  blockhash: string;
  instructions: TransactionInstruction[];
  signers?: Keypair[];
}): { tx: VersionedTransaction; base64: string; messageHash: string } {
  const message = new TransactionMessage({
    payerKey: new PublicKey(input.payer),
    recentBlockhash: input.blockhash,
    instructions: input.instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  if (input.signers && input.signers.length > 0) tx.sign(input.signers);
  let bytes: Uint8Array;
  try {
    bytes = tx.serialize();
  } catch (err) {
    // web3.js gives up on a transaction far over the limit before it can be measured.
    throw new Error(
      `the transaction is larger than the ${MAX_TRANSACTION_BYTES} bytes a Solana transaction may be (${(err as Error).message})`,
    );
  }
  if (bytes.length > MAX_TRANSACTION_BYTES) {
    throw new Error(
      `the transaction is ${bytes.length} bytes and a Solana transaction may be ${MAX_TRANSACTION_BYTES} at most`,
    );
  }
  return { tx, base64: Buffer.from(bytes).toString("base64"), messageHash: messageHashOf(tx) };
}

export type SignedTransactionRefusal = "undecodable" | "message_mismatch" | "missing_signature";

export type SignedTransactionCheck =
  | { ok: true; tx: VersionedTransaction; raw: Uint8Array }
  | { ok: false; reason: SignedTransactionRefusal };

/**
 * Is this signed transaction the one that was built? Its message must hash
 * to the hash the prepare token carries: one changed account, amount,
 * instruction or blockhash gives another hash. Then every signature slot
 * must be filled. Whether a signature is VALID is the node's check when the
 * transaction is sent; a wrong one is refused there and nothing lands.
 */
export function checkSignedTransaction(signedBase64: string, expectedMessageHash: string): SignedTransactionCheck {
  let tx: VersionedTransaction;
  let hash: string;
  try {
    const bytes = new Uint8Array(Buffer.from(signedBase64, "base64"));
    if (bytes.length === 0) return { ok: false, reason: "undecodable" };
    tx = VersionedTransaction.deserialize(bytes);
    hash = messageHashOf(tx);
  } catch {
    return { ok: false, reason: "undecodable" };
  }
  if (hash !== expectedMessageHash) return { ok: false, reason: "message_mismatch" };
  const required = tx.message.header.numRequiredSignatures;
  if (tx.signatures.length < required) return { ok: false, reason: "missing_signature" };
  for (let slot = 0; slot < required; slot += 1) {
    const signature = tx.signatures[slot];
    if (!signature || signature.every((byte) => byte === 0)) {
      return { ok: false, reason: "missing_signature" };
    }
  }
  return { ok: true, tx, raw: tx.serialize() };
}

// ============================================
// What a confirmed transaction moved
// ============================================

function sumBalances(balances: TokenBalanceRead[], keep: (balance: TokenBalanceRead) => boolean): bigint | null {
  let sum: bigint | null = null;
  for (const balance of balances) {
    if (!keep(balance)) continue;
    if (!DIGITS.test(balance.amountRaw)) return null;
    sum = (sum ?? 0n) + BigInt(balance.amountRaw);
  }
  return sum;
}

/**
 * Raw units of `mint` that the wallet's token accounts gained in the
 * transaction. An account that did not exist before counts from zero. null
 * when the wallet holds none of the mint afterwards or gained nothing:
 * that is not what a confirmed buy looks like, so it is not believed.
 */
export function tokensGainedByWallet(tx: ConfirmedTransactionRead, wallet: string, mint: string): bigint | null {
  const mine = (balance: TokenBalanceRead) => balance.owner === wallet && balance.mint === mint;
  const after = sumBalances(tx.postTokenBalances, mine);
  if (after === null) return null;
  const before = sumBalances(tx.preTokenBalances, mine) ?? 0n;
  const gained = after - before;
  return gained > 0n ? gained : null;
}

/**
 * Raw units of `mint` that left one token account (the pool's SOL vault) in
 * the transaction. null when the account is not in the transaction, its
 * balances are missing, or nothing left it.
 */
export function unitsThatLeftAccount(tx: ConfirmedTransactionRead, account: string, mint: string): bigint | null {
  const index = tx.accountKeys.indexOf(account);
  if (index < 0) return null;
  const it = (balance: TokenBalanceRead) => balance.accountIndex === index && balance.mint === mint;
  const before = sumBalances(tx.preTokenBalances, it);
  const after = sumBalances(tx.postTokenBalances, it);
  if (before === null || after === null) return null;
  const left = before - after;
  return left > 0n ? left : null;
}

export interface TradeAmounts {
  solLamports: bigint;
  tokenAmountRaw: bigint;
  /** False when the prepared quote's numbers stand in for the chain's. */
  fromChain: boolean;
}

/**
 * The two amounts of a trade row. The amount in is what the transaction
 * was built with (the message is the one that was built, so it is exact).
 * The amount out is read from the confirmed transaction: for a buy the
 * wallet's token balance change, for a sell what left the pool's SOL
 * vault. When that cannot be read, the prepared quote's number is used.
 */
export function readTradeAmounts(input: {
  side: TradeSide;
  prepared: { solLamports: bigint; tokenAmountRaw: bigint };
  confirmed: ConfirmedTransactionRead | null;
  wallet: string;
  mintAddress: string;
  quoteVault: string;
}): TradeAmounts {
  const { prepared, confirmed } = input;
  if (confirmed) {
    if (input.side === "buy") {
      const gained = tokensGainedByWallet(confirmed, input.wallet, input.mintAddress);
      if (gained !== null) return { solLamports: prepared.solLamports, tokenAmountRaw: gained, fromChain: true };
    } else {
      const left = unitsThatLeftAccount(confirmed, input.quoteVault, CURVE_QUOTE_MINT);
      if (left !== null) return { solLamports: left, tokenAmountRaw: prepared.tokenAmountRaw, fromChain: true };
    }
  }
  return { ...prepared, fromChain: false };
}

/** A row of AgentTokenTrade, before it is written. */
export interface CurveTradeRow {
  tokenId: string;
  txSignature: string;
  traderAddress: string;
  side: TradeSide;
  solLamports: bigint;
  tokenAmountRaw: bigint;
  /** The Float columns mirror the integers; they are for charts only. */
  solAmount: number;
  tokenAmount: number;
  /** The price of one token in dollars, or 0 when no SOL price is to be had. */
  priceUsd: number;
  timestamp: Date;
}

export function buildTradeRow(input: {
  tokenId: string;
  txSignature: string;
  traderAddress: string;
  side: TradeSide;
  amounts: Pick<TradeAmounts, "solLamports" | "tokenAmountRaw">;
  usdPerSol: number | null;
  timestamp: Date;
}): CurveTradeRow {
  const solAmount = Number(input.amounts.solLamports) / 10 ** SOL_DECIMALS;
  const tokenAmount = Number(input.amounts.tokenAmountRaw) / 10 ** CURVE_TOKEN_DECIMALS;
  const usdPerSol = input.usdPerSol;
  const priceUsd =
    usdPerSol !== null && Number.isFinite(usdPerSol) && usdPerSol > 0 && tokenAmount > 0
      ? (solAmount / tokenAmount) * usdPerSol
      : 0;
  return {
    tokenId: input.tokenId,
    txSignature: input.txSignature,
    traderAddress: input.traderAddress,
    side: input.side,
    solLamports: input.amounts.solLamports,
    tokenAmountRaw: input.amounts.tokenAmountRaw,
    solAmount,
    tokenAmount,
    priceUsd,
    timestamp: input.timestamp,
  };
}
