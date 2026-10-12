/**
 * A token on a Meteora Dynamic Bonding Curve, after its launch: what the
 * curve's state is, what a buy or a sell would give, and the checks every
 * browser-signed transaction passes before it is sent.
 *
 * Nobody on our side holds a wallet. The server builds a transaction, the
 * browser wallet signs it, and `submit` sends it only when it is the
 * transaction the server built:
 *
 *   prepare  compile the instructions to a v0 message and put that message
 *            in a short-lived signed token together with who asked and what
 *            is to be recorded.
 *   submit   verify the token, compare the message of the signed
 *            transaction that came back with the one in the token, check
 *            every signature slot is filled. Anything else is refused
 *            before it is sent.
 *
 * What "the transaction the server built" means depends on who signs first
 * (checkSignedTransaction has the whole rule). A transaction the server has
 * already signed must come back byte for byte. A transaction the wallet
 * alone signs may come back with instructions the wallet added for its own
 * priority fee or its own safety checks, and with nothing else changed.
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
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedMessage,
  VersionedTransaction,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

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
/**
 * How long after it ran out a prepare token still vouches for a transaction
 * that has ALREADY succeeded on chain, so that its record can be written.
 * It is never a reason to send anything.
 */
export const CURVE_PREPARE_GRACE_SECONDS = 600;

/** The two programs a wallet may add instructions of to what it alone signs. */
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const LIGHTHOUSE_PROGRAM_ID = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

/**
 * The compute budget every wallet-signed transaction is given here, so the
 * wallet has no reason to add its own. The devnet probe measured 63,000
 * units for a buy and 45,000 for a claim; the locker was never measured.
 */
export const CURVE_COMPUTE_UNIT_LIMIT = 200_000;
export const LOCKER_COMPUTE_UNIT_LIMIT = 400_000;
export const CURVE_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 1;

/**
 * The pool's `migrationProgress`, a u8. Meteora's SDK (1.5.12) and its IDL
 * give the field no named values and never read it, so these are the
 * numbers of the program's own source: 0 before the curve is full, 1 full,
 * 2 the locker made (or not needed, when the config locks nothing), 3 the
 * DAMM v2 pool created. Devnet agreed with 1 and 2 in simulation on
 * 2026-10-12 (scripts/meteora-bindings-probe.ts): a full pool reading 1
 * took the locker and refused the move, one reading 2 the reverse.
 */
export const MIGRATION_PROGRESS_CURVE_FULL = 1;
export const MIGRATION_PROGRESS_LOCKER_MADE = 2;
export const MIGRATION_PROGRESS_POOL_CREATED = 3;

/** How many decimals a price in SOL is written with, before trailing zeros go. */
const PRICE_DECIMALS = 15;
const U64_MAX = (1n << 64n) - 1n;

export type SolanaNetwork = "devnet" | "mainnet-beta";
export type CurveState = "trading" | "full" | "graduated";
export type TradeSide = "buy" | "sell";

// ============================================
// The chain, behind one interface
// ============================================

/** One point of a curve's drawing, the shape of a preset's `points`. */
export interface CurvePoint {
  soldPercent: number;
  priceSol: number;
}

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
  /** The pool's token vault. A buy is paid out of it. */
  baseVault: string;
  /** The pool's price as the chain stores it: a square root, Q64.64. */
  sqrtPrice: bigint;
  /** Lamports raised so far. */
  quoteReserve: bigint;
  /** Lamports at which the curve is full. */
  migrationQuoteThreshold: bigint;
  isMigrated: boolean;
  /** How far graduation has got, as the pool has it: see MIGRATION_PROGRESS_*. */
  migrationProgress: number;
  /** Unix seconds at which the curve became full; 0 while it is not. */
  finishCurveTimestamp: number;
  /** Lamports of trading fees over the pool's whole life, as the chain counts them. */
  tradingFeesLamports: bigint;
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
  /**
   * The curve as a line to draw, sampled from the pool's own config: the
   * share of the supply sold and the price in SOL at each point. Floats, for
   * a drawing only. Empty when the config could not be sampled.
   */
  curvePoints: CurvePoint[];
  /** The implementation's own pool and config, handed back to it for a quote. */
  handle: unknown;
}

/** What a swap of `amountIn` would do, from the SDK's own arithmetic. */
export interface SwapQuoteRead {
  /**
   * Raw units of the input the swap takes, fees included. A buy that would
   * run past the curve's threshold takes only what fills it, so this is
   * smaller than `amountIn` then; otherwise the two are equal.
   */
  amountInUsed: bigint;
  /** Raw units out for the amount used, before any slippage allowance. */
  amountOut: bigint;
  /** Every fee the swap pays, in lamports (these curves take fees in SOL). */
  feeLamports: bigint;
  /** The pool's price after the swap, same form as CurveSnapshot.sqrtPrice. */
  nextSqrtPrice: bigint;
}

export type SignatureStatus = "succeeded" | "failed" | "not_seen";

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
  /**
   * No request. Throws when the SDK refuses the amount. A buy is quoted as
   * a partial fill (it takes no more than the curve has left to sell), a
   * sell as an exact amount in.
   */
  quoteSwap(
    snapshot: CurveSnapshot,
    input: { sell: boolean; amountIn: bigint; currentPoint: bigint },
  ): SwapQuoteRead;
  /** A buy is built as a partial fill, a sell as an exact amount in, like the quote. */
  buildSwap(input: {
    poolAddress: string;
    wallet: string;
    sell: boolean;
    amountIn: bigint;
    minimumOut: bigint;
  }): Promise<TransactionInstruction[]>;
  /** The creator claims every trading fee waiting for them, paid to themselves. */
  buildClaim(input: { poolAddress: string; creator: string }): Promise<TransactionInstruction[]>;
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
  /**
   * What the chain knows of a signature, asked once: it succeeded, it
   * failed on chain, or it is not seen (not landed yet, or never will).
   */
  signatureStatus(signature: string): Promise<SignatureStatus>;
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
 * Three states, from the pool's own word. Graduated: the pool says it has
 * migrated, or its progress says the DAMM v2 pool is created. Full: it has
 * raised its threshold, or its progress says the curve is full, and it has
 * not graduated. Trading: anything else. Our own row is never asked.
 */
export function deriveCurveState(
  snapshot: Pick<CurveSnapshot, "isMigrated" | "migrationProgress" | "quoteReserve" | "migrationQuoteThreshold">,
): CurveState {
  if (snapshot.isMigrated || snapshot.migrationProgress >= MIGRATION_PROGRESS_POOL_CREATED) return "graduated";
  if (
    snapshot.quoteReserve >= snapshot.migrationQuoteThreshold ||
    snapshot.migrationProgress >= MIGRATION_PROGRESS_CURVE_FULL
  ) {
    return "full";
  }
  return "trading";
}

/**
 * The next step of graduating a full curve, from the pool's progress and
 * not from whether a locker account exists. The locker comes first when the
 * config locks tokens for the creator and the progress says it is not made.
 */
export function nextGraduationStep(
  snapshot: Pick<CurveSnapshot, "migrationProgress" | "lockedVesting">,
): GraduationStep {
  const locks = lockedVestingTotalRaw(snapshot.lockedVesting) > 0n;
  return locks && snapshot.migrationProgress < MIGRATION_PROGRESS_LOCKER_MADE ? "locker" : "migrate";
}

/**
 * When the creator's locked tokens start to be released: the moment the
 * curve became full plus the config's wait. null when the config locks
 * nothing, or the pool does not say when its curve was finished.
 */
export function creatorLockupEndOf(
  snapshot: Pick<CurveSnapshot, "finishCurveTimestamp" | "lockedVesting">,
): Date | null {
  if (lockedVestingTotalRaw(snapshot.lockedVesting) <= 0n) return null;
  if (!Number.isFinite(snapshot.finishCurveTimestamp) || snapshot.finishCurveTimestamp <= 0) return null;
  return new Date((snapshot.finishCurveTimestamp + snapshot.lockedVesting.cliffSeconds) * 1000);
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
  /** Trading fees over the pool's whole life, in SOL as the chain counts them. */
  tradingFeesLamports: string;
  tradingFeesSol: string;
  /** The curve of this token's own config, for a drawing. */
  curvePoints: CurvePoint[];
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
    tradingFeesLamports: snapshot.tradingFeesLamports.toString(),
    tradingFeesSol: formatUnits(snapshot.tradingFeesLamports, SOL_DECIMALS),
    curvePoints: snapshot.curvePoints,
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
  /** What the trade takes of `amountIn`: less for a buy that fills the curve, else the same. */
  amountInUsed: string;
  amountInUsedRaw: string;
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

/**
 * A buy pays SOL and gets tokens; a sell is the other way round. The amount
 * out, and so the least accepted, are for the amount the trade takes.
 */
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
    amountInUsed: formatUnits(input.swap.amountInUsed, inDecimals),
    amountInUsedRaw: input.swap.amountInUsed.toString(),
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
  /** The pool's two vaults: what a trade or a claim moved is read from their balances. */
  quoteVault: string;
  baseVault: string;
  /** The wallet the transaction was built for: its fee payer. */
  wallet: string;
  /** Who asked. null for an API key, which belongs to an organization only. */
  userId: string | null;
  orgId: string;
  /** sha256, in hex, of the compiled message's bytes. */
  messageHash: string;
  /**
   * The compiled message itself, base64. A hash can only say "the same
   * bytes or not"; with the message, submit can see WHAT a wallet changed.
   */
  message: string;
  /**
   * True when the server signed first (graduation's move): the message must
   * come back byte for byte. False when the wallet alone signs.
   */
  strict: boolean;
  /** With the message's blockhash, what confirming the transaction needs. */
  lastValidBlockHeight: number;
  /**
   * kind "trade": the quote's numbers (for a buy, the SOL the trade takes,
   * not the SOL that was typed), written when the transaction cannot be read back.
   */
  trade?: { side: TradeSide; solLamports: string; tokenAmountRaw: string };
  /** kind "fees": what could be claimed when the transaction was built. */
  fees?: { claimableLamports: string };
  /**
   * kind "graduate": which step this is and, for the move, the pool it makes
   * and when the creator's locked tokens start to be released (an ISO date,
   * null when nothing is locked).
   */
  graduate?: { step: GraduationStep; graduatedPoolAddress: string | null; creatorLockupEnd: string | null };
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
  /** `expired` is true only for a token let through by `graceSeconds`. */
  | { ok: true; payload: CurvePreparePayload; expired: boolean }
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
    typeof payload.baseVault !== "string" ||
    typeof payload.wallet !== "string" ||
    !(typeof payload.userId === "string" || payload.userId === null) ||
    typeof payload.orgId !== "string" ||
    typeof payload.messageHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(payload.messageHash) ||
    typeof payload.message !== "string" ||
    payload.message.length === 0 ||
    typeof payload.strict !== "boolean" ||
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
      (typeof graduate.graduatedPoolAddress === "string" || graduate.graduatedPoolAddress === null) &&
      (graduate.creatorLockupEnd === null ||
        (typeof graduate.creatorLockupEnd === "string" && !Number.isNaN(Date.parse(graduate.creatorLockupEnd))))
    );
  }
  return false;
}

/**
 * `graceSeconds` lets through a token that ran out less than that long ago,
 * marked `expired`. Everything else about it is checked the same. The caller
 * may use such a token only to record a transaction that has already
 * succeeded on chain, never to send one.
 */
export function verifyCurvePrepareToken(input: {
  token: string;
  secret: string;
  now?: () => Date;
  graceSeconds?: number;
}): CurvePrepareVerifyResult {
  const now = input.now ?? (() => new Date());
  let expired = false;
  let verified = verifyState({
    token: input.token,
    secret: input.secret,
    expectedPurpose: CURVE_PREPARE_PURPOSE,
    now,
  });
  const grace = input.graceSeconds ?? 0;
  if (!verified.ok && verified.reason === "expired" && grace > 0) {
    // The same check with the clock set back: it passes only when the token
    // ran out less than `grace` seconds ago.
    verified = verifyState({
      token: input.token,
      secret: input.secret,
      expectedPurpose: CURVE_PREPARE_PURPOSE,
      now: () => new Date(now().getTime() - grace * 1000),
    });
    expired = verified.ok;
  }
  if (!verified.ok) return verified;
  if (!payloadIsWhole(verified.payload)) return { ok: false, reason: "payload_invalid" };
  return { ok: true, payload: verified.payload as unknown as CurvePreparePayload, expired };
}

// ============================================
// The transaction: built here, signed in the browser
// ============================================

export function messageHashOf(tx: VersionedTransaction): string {
  return createHash("sha256").update(tx.message.serialize()).digest("hex");
}

/** A transaction's own signature, the name the chain knows it by: its first one, base58. */
export function signatureOfTransaction(tx: VersionedTransaction): string | null {
  const first = tx.signatures[0];
  if (!first || first.every((byte) => byte === 0)) return null;
  return bs58.encode(first);
}

// The first byte of a ComputeBudget instruction says which one it is.
const COMPUTE_REQUEST_UNITS_DEPRECATED = 0;
const COMPUTE_SET_UNIT_LIMIT = 2;
const COMPUTE_SET_UNIT_PRICE = 3;

/**
 * The instructions with a compute-unit limit and a compute-unit price in
 * front, so that a wallet asked to sign has no reason to add its own. A
 * transaction may hold each of the two only once (the chain refuses a
 * second), so only what is missing is added: a limit or a price the SDK
 * already set stays where it is, with its own value.
 */
export function withComputeBudget(
  instructions: TransactionInstruction[],
  budget: { unitLimit: number; microLamports: number },
): TransactionInstruction[] {
  const carries = (kind: number) =>
    instructions.some(
      (instruction) =>
        instruction.programId.toBase58() === COMPUTE_BUDGET_PROGRAM_ID &&
        // The old "request units" instruction sets both at once.
        (instruction.data[0] === kind || instruction.data[0] === COMPUTE_REQUEST_UNITS_DEPRECATED),
    );
  const added: TransactionInstruction[] = [];
  if (!carries(COMPUTE_SET_UNIT_LIMIT)) {
    added.push(ComputeBudgetProgram.setComputeUnitLimit({ units: budget.unitLimit }));
  }
  if (!carries(COMPUTE_SET_UNIT_PRICE)) {
    added.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: budget.microLamports }));
  }
  return [...added, ...instructions];
}

/**
 * The instructions as one v0 transaction with `payer` paying. Nothing is
 * signed here unless `signers` are given (graduation's position keypairs);
 * the payer's slot is always left for the browser wallet. `computeBudget`
 * is for a transaction the wallet alone signs: see withComputeBudget.
 */
export function compileCurveTransaction(input: {
  payer: string;
  blockhash: string;
  instructions: TransactionInstruction[];
  signers?: Keypair[];
  computeBudget?: { unitLimit: number; microLamports: number };
}): { tx: VersionedTransaction; base64: string; messageHash: string; messageBase64: string } {
  const message = new TransactionMessage({
    payerKey: new PublicKey(input.payer),
    recentBlockhash: input.blockhash,
    instructions: input.computeBudget
      ? withComputeBudget(input.instructions, input.computeBudget)
      : input.instructions,
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
  return {
    tx,
    base64: Buffer.from(bytes).toString("base64"),
    messageHash: messageHashOf(tx),
    messageBase64: Buffer.from(message.serialize()).toString("base64"),
  };
}

export type SignedTransactionRefusal = "undecodable" | "message_mismatch" | "missing_signature" | "bad_signature";

/** Which part of the rule a message that is not the prepared one broke. */
export type MessageDifference =
  /** The server signed first, and the bytes are not the same. */
  | "not_identical"
  /** Not a v0 message, or one whose indexes point at nothing. */
  | "malformed"
  | "fee_payer"
  | "signers"
  | "lookup_tables"
  /** An instruction that is neither one we prepared, in its place, nor a wallet's own. */
  | "instruction_not_allowed"
  /** An instruction we prepared is not there (or not where it was). */
  | "instruction_missing";

export type SignedTransactionCheck =
  | {
      ok: true;
      tx: VersionedTransaction;
      raw: Uint8Array;
      /** The transaction's own signature, base58: what the chain will know it by. */
      signature: string;
      /** False when the wallet added instructions of its own. */
      identical: boolean;
    }
  | { ok: false; reason: SignedTransactionRefusal; difference?: MessageDifference };

interface ResolvedInstruction {
  programId: string;
  /** One entry per account: its address and its signer and writable flags. */
  accounts: string[];
  data: Uint8Array;
}

/**
 * Every instruction of a message with its indexes resolved. An account that
 * comes from an address lookup table has no address in the message, so it
 * is named by its table and its place in it; that is the same account as
 * long as the tables are the same, which the caller checks. null when an
 * index points at nothing.
 */
function resolveInstructions(message: VersionedMessage): ResolvedInstruction[] | null {
  const names = message.staticAccountKeys.map((key) => key.toBase58());
  // After the static keys come the writable accounts of every table, then the read-only ones.
  for (const lookup of message.addressTableLookups) {
    for (const index of lookup.writableIndexes) names.push(`${lookup.accountKey.toBase58()}#${index}`);
  }
  for (const lookup of message.addressTableLookups) {
    for (const index of lookup.readonlyIndexes) names.push(`${lookup.accountKey.toBase58()}#${index}`);
  }
  const resolved: ResolvedInstruction[] = [];
  for (const instruction of message.compiledInstructions) {
    const programId = names[instruction.programIdIndex];
    if (programId === undefined) return null;
    const accounts: string[] = [];
    for (const index of instruction.accountKeyIndexes) {
      const name = names[index];
      if (name === undefined) return null;
      accounts.push(
        `${name}:${message.isAccountSigner(index) ? "signer" : "-"}:${message.isAccountWritable(index) ? "writable" : "-"}`,
      );
    }
    resolved.push({ programId, accounts, data: instruction.data });
  }
  return resolved;
}

function sameInstruction(a: ResolvedInstruction, b: ResolvedInstruction): boolean {
  return (
    a.programId === b.programId &&
    a.accounts.length === b.accounts.length &&
    a.accounts.every((account, index) => account === b.accounts[index]) &&
    Buffer.from(a.data).equals(Buffer.from(b.data))
  );
}

function lookupTablesOf(message: VersionedMessage): string {
  return JSON.stringify(
    message.addressTableLookups.map((lookup) => [
      lookup.accountKey.toBase58(),
      [...lookup.writableIndexes],
      [...lookup.readonlyIndexes],
    ]),
  );
}

/**
 * What a wallet may have done to a message it alone signs, and nothing
 * more. null when the signed message passes; otherwise the part it broke.
 *
 * A wallet (Phantom for one) adds its own priority-fee instructions and its
 * own Lighthouse assertions to a transaction that carries no signature yet.
 * Those can cost the signer a fee or make the transaction fail; they cannot
 * move anything. So the signed message passes when ALL of these hold:
 *
 *   - it is a v0 message, like the prepared one;
 *   - the fee payer is the same;
 *   - the set of required signers is the same;
 *   - it uses the same address lookup tables, in the same way (the prepared
 *     message uses none, so in practice: none);
 *   - every instruction that was prepared is there, in the same order, with
 *     the same program, the same accounts (addresses after resolving
 *     indexes, each with the same signer and writable flags) and the same
 *     data;
 *   - every OTHER instruction belongs to the ComputeBudget program or to
 *     Lighthouse.
 *
 * The recent blockhash is not compared: a wallet that puts in a fresher one
 * changes how long the transaction may wait and nothing else.
 */
function differenceFromPrepared(prepared: VersionedMessage, signed: VersionedMessage): MessageDifference | null {
  if (prepared.version !== 0 || signed.version !== 0) return "malformed";
  const payer = prepared.staticAccountKeys[0];
  const signedPayer = signed.staticAccountKeys[0];
  if (!payer || !signedPayer) return "malformed";
  if (!payer.equals(signedPayer)) return "fee_payer";

  const signersOf = (message: VersionedMessage) =>
    message.staticAccountKeys
      .slice(0, message.header.numRequiredSignatures)
      .map((key) => key.toBase58())
      .sort();
  const signers = signersOf(prepared);
  const signedSigners = signersOf(signed);
  if (
    signed.header.numRequiredSignatures !== signedSigners.length ||
    signers.length !== signedSigners.length ||
    signers.some((signer, index) => signer !== signedSigners[index])
  ) {
    return "signers";
  }

  if (lookupTablesOf(prepared) !== lookupTablesOf(signed)) return "lookup_tables";

  const ours = resolveInstructions(prepared);
  const theirs = resolveInstructions(signed);
  if (!ours || !theirs) return "malformed";
  // Walk the signed instructions once. Each is either the next one we
  // prepared, or an addition of a kind a wallet makes.
  let next = 0;
  for (const instruction of theirs) {
    const expected = ours[next];
    if (expected && sameInstruction(instruction, expected)) {
      next += 1;
      continue;
    }
    if (instruction.programId !== COMPUTE_BUDGET_PROGRAM_ID && instruction.programId !== LIGHTHOUSE_PROGRAM_ID) {
      return "instruction_not_allowed";
    }
  }
  return next === ours.length ? null : "instruction_missing";
}

/**
 * Is this signed transaction the one that was built?
 *
 * `strict` (the server signed first: graduation's move): its message must
 * be, byte for byte, the prepared one. One changed account, amount,
 * instruction or blockhash is refused.
 *
 * Not strict (the wallet alone signs: a trade, a fee claim, the locker):
 * the same bytes pass, and so does a message the wallet only added its own
 * compute-budget or Lighthouse instructions to; differenceFromPrepared has
 * the whole rule.
 *
 * Then every signature slot must be filled, and every signature must be a
 * true one: made by that slot's signer over this very message. The node
 * makes the same check when a transaction is sent, but a submit does not
 * always send: it first asks the chain whether the transaction's signature
 * has already succeeded, and records it when it has. Without the check here
 * any 64 bytes would do in the slot, and the signature of someone else's
 * transaction would get this one recorded without ever being sent. Nothing
 * here asks the chain anything.
 */
export function checkSignedTransaction(input: {
  signedBase64: string;
  /** The message that was prepared, base64, as the prepare token carries it. */
  preparedMessageBase64: string;
  strict: boolean;
}): SignedTransactionCheck {
  let tx: VersionedTransaction;
  let identical: boolean;
  let prepared: VersionedMessage;
  try {
    const bytes = new Uint8Array(Buffer.from(input.signedBase64, "base64"));
    if (bytes.length === 0) return { ok: false, reason: "undecodable" };
    tx = VersionedTransaction.deserialize(bytes);
    const preparedBytes = Buffer.from(input.preparedMessageBase64, "base64");
    identical = preparedBytes.length > 0 && preparedBytes.equals(Buffer.from(tx.message.serialize()));
    prepared = VersionedMessage.deserialize(new Uint8Array(preparedBytes));
  } catch {
    return { ok: false, reason: "undecodable" };
  }
  if (!identical) {
    if (input.strict) return { ok: false, reason: "message_mismatch", difference: "not_identical" };
    const difference = differenceFromPrepared(prepared, tx.message);
    if (difference) return { ok: false, reason: "message_mismatch", difference };
  }
  const required = tx.message.header.numRequiredSignatures;
  if (tx.signatures.length < required) return { ok: false, reason: "missing_signature" };
  for (let slot = 0; slot < required; slot += 1) {
    const signature = tx.signatures[slot];
    if (!signature || signature.every((byte) => byte === 0)) {
      return { ok: false, reason: "missing_signature" };
    }
  }
  const signedBytes = tx.message.serialize();
  for (let slot = 0; slot < required; slot += 1) {
    const signer = tx.message.staticAccountKeys[slot];
    const signature = tx.signatures[slot];
    if (!signer || !signature || signature.length !== nacl.sign.signatureLength) {
      return { ok: false, reason: "bad_signature" };
    }
    if (!nacl.sign.detached.verify(signedBytes, signature, signer.toBytes())) {
      return { ok: false, reason: "bad_signature" };
    }
  }
  const signature = signatureOfTransaction(tx);
  if (!signature) return { ok: false, reason: "missing_signature" };
  return { ok: true, tx, raw: tx.serialize(), signature, identical };
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
 * How much one token account's balance of `mint` changed in the
 * transaction, in raw units: above zero when it gained. null when the
 * account is not in the transaction or one of its two balances is missing.
 */
export function accountBalanceChange(tx: ConfirmedTransactionRead, account: string, mint: string): bigint | null {
  const index = tx.accountKeys.indexOf(account);
  if (index < 0) return null;
  const it = (balance: TokenBalanceRead) => balance.accountIndex === index && balance.mint === mint;
  const before = sumBalances(tx.preTokenBalances, it);
  const after = sumBalances(tx.postTokenBalances, it);
  if (before === null || after === null) return null;
  return after - before;
}

/**
 * Raw units of `mint` that left one token account (one of the pool's
 * vaults) in the transaction. null when that cannot be read, or nothing
 * left it.
 */
export function unitsThatLeftAccount(tx: ConfirmedTransactionRead, account: string, mint: string): bigint | null {
  const change = accountBalanceChange(tx, account, mint);
  return change !== null && change < 0n ? -change : null;
}

/** The other way: raw units of `mint` that one token account gained. */
export function unitsThatEnteredAccount(tx: ConfirmedTransactionRead, account: string, mint: string): bigint | null {
  const change = accountBalanceChange(tx, account, mint);
  return change !== null && change > 0n ? change : null;
}

export interface TradeAmounts {
  solLamports: bigint;
  tokenAmountRaw: bigint;
  /** False when the prepared quote's numbers stand in for the chain's. */
  fromChain: boolean;
}

/**
 * The two amounts of a trade row, both read from the pool's two vaults in
 * the confirmed transaction. A buy: the SOL is what the SOL vault gained
 * and the tokens what the token vault lost. A sell: the reverse. What the
 * wallet asked to spend is not used: a buy that fills the curve takes less
 * than was asked. When either vault cannot be read, both of the prepared
 * quote's numbers are used, never one of each.
 */
export function readTradeAmounts(input: {
  side: TradeSide;
  prepared: { solLamports: bigint; tokenAmountRaw: bigint };
  confirmed: ConfirmedTransactionRead | null;
  mintAddress: string;
  baseVault: string;
  quoteVault: string;
}): TradeAmounts {
  const { prepared, confirmed } = input;
  if (confirmed) {
    const buy = input.side === "buy";
    const moved = buy ? unitsThatEnteredAccount : unitsThatLeftAccount;
    const movedBack = buy ? unitsThatLeftAccount : unitsThatEnteredAccount;
    const solLamports = moved(confirmed, input.quoteVault, CURVE_QUOTE_MINT);
    const tokenAmountRaw = movedBack(confirmed, input.baseVault, input.mintAddress);
    if (solLamports !== null && tokenAmountRaw !== null) return { solLamports, tokenAmountRaw, fromChain: true };
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
