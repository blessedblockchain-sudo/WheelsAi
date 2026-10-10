/**
 * The live SOL/USD price: decoding, judging, and the whole-number money
 * arithmetic that stands on a judged price.
 *
 * Pure. Nothing here reads settings, the network or the wall clock; the
 * caller hands in the bytes of Pyth's price account, the bytes of the
 * chain's clock sysvar (read in the same call, so both are from one slot)
 * and the rules. services/buildSolPriceDeps.ts binds it to the real
 * connection and to config/env.ts.
 *
 * There is no fallback number. A price is a quote or a refusal with a code,
 * and every money helper answers with an amount above zero or a refusal.
 *
 * Money is bigint throughout: lamports, cents, and micro-dollars per SOL
 * (dollars * 1,000,000). The only floats are the figures meant for a screen
 * or a log line (solUsdRate).
 */

export const PYTH_SOL_USD_ACCOUNT_DEFAULT = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
export const PYTH_SOL_USD_FEED_ID_DEFAULT =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
export const PYTH_RECEIVER_PROGRAM_ID_DEFAULT = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
export const CLOCK_SYSVAR_ADDRESS = "SysvarC1ock11111111111111111111111111111111";

/** sha256("account:PriceUpdateV2")[0..8]. */
export const PRICE_UPDATE_V2_DISCRIMINATOR_HEX = "22f123639d7ef4cd";

/** A publish time this far ahead of the chain's clock is still accepted. */
export const SOL_PRICE_MAX_FUTURE_SECONDS = 5;

export const LAMPORTS_PER_SOL_BIGINT = 1_000_000_000n;
const MICRO_USD_PER_CENT = 10_000n;
const BPS = 10_000n;

const CLOCK_LENGTH = 40;
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32;
// Bytes up to and including posted_slot when the level is Full. Partial
// carries one more byte (the number of signatures) before the feed id.
const PRICE_UPDATE_FULL_LENGTH = 133;

export type SolPriceSource = "off" | "pyth" | "static";

export type SolPriceRefusalCode =
  | "source_off"
  | "account_missing"
  | "wrong_owner"
  | "wrong_account_type"
  | "not_fully_verified"
  | "wrong_feed"
  | "bad_price"
  | "bad_exponent"
  | "clock_missing"
  | "stale"
  | "clock_skew"
  | "too_uncertain"
  | "off_average"
  | "out_of_band"
  // Added by the binding (services/buildSolPriceDeps.ts).
  | "rpc_unavailable"
  | "static_not_set";

export interface SolQuote {
  source: "pyth" | "static";
  /** The price, micro-dollars per SOL, rounded down. */
  midMicroUsdPerSol: bigint;
  /** The price's stated uncertainty, micro-dollars per SOL, rounded up. */
  confMicroUsdPerSol: bigint;
  /** Unix seconds. */
  publishTime: number;
  /** By the chain's own clock, never below zero. */
  ageSeconds: number;
  /** The price account read, or null for a static quote. */
  account: string | null;
}

export type SolPriceResult =
  | { ok: true; quote: SolQuote }
  | { ok: false; code: SolPriceRefusalCode; detail?: string };

export interface PriceUpdateV2 {
  writeAuthority: Uint8Array;
  verification: "full" | "partial";
  /** Only for the Partial level. */
  numSignatures: number | null;
  feedIdHex: string;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
  prevPublishTime: bigint;
  emaPrice: bigint;
  emaConf: bigint;
  postedSlot: bigint;
}

export type DecodePriceUpdateResult =
  | { ok: true; update: PriceUpdateV2 }
  | { ok: false; code: "wrong_account_type" | "not_fully_verified"; detail: string };

export interface SolPriceRules {
  /** The address the account was read from; carried onto the quote. */
  accountAddress: string;
  /** Programs allowed to own the account, base58. */
  allowedOwners: readonly string[];
  /** 64 hex characters, with or without a leading 0x. */
  feedIdHex: string;
  maxAgeSeconds: number;
  maxConfBps: number;
  maxEmaDeviationBps: number;
  /** Optional sanity band, micro-dollars per SOL, both ends included. */
  minMicroUsdPerSol?: bigint | null;
  maxMicroUsdPerSol?: bigint | null;
}

export const DEFAULT_SOL_PRICE_RULES: SolPriceRules = {
  accountAddress: PYTH_SOL_USD_ACCOUNT_DEFAULT,
  allowedOwners: [PYTH_RECEIVER_PROGRAM_ID_DEFAULT],
  feedIdHex: PYTH_SOL_USD_FEED_ID_DEFAULT,
  maxAgeSeconds: 120,
  maxConfBps: 100,
  maxEmaDeviationBps: 1000,
  minMicroUsdPerSol: null,
  maxMicroUsdPerSol: null,
};

export interface JudgeSolPriceInput {
  /** "static" is not judged here: see staticSolQuote. */
  source: "off" | "pyth";
  account: { owner: string; data: Uint8Array } | null;
  /** The clock sysvar's bytes from the same read as the account. */
  clockData: Uint8Array | null;
  rules: SolPriceRules;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function refuse(code: SolPriceRefusalCode, detail?: string): SolPriceResult {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail };
}

/** The chain's unix time from the clock sysvar's bytes, or null. */
export function decodeClockUnixTimestamp(data: Uint8Array | null | undefined): bigint | null {
  if (!data || data.byteLength < CLOCK_LENGTH) return null;
  return viewOf(data).getBigInt64(CLOCK_UNIX_TIMESTAMP_OFFSET, true);
}

/**
 * Decode a PriceUpdateV2 account. A Partial account decodes (the judge
 * refuses it); a tag that is neither Full nor Partial cannot be laid out
 * and is refused here.
 */
export function decodePriceUpdateV2(data: Uint8Array): DecodePriceUpdateResult {
  if (data.byteLength < 8 || toHex(data.subarray(0, 8)) !== PRICE_UPDATE_V2_DISCRIMINATOR_HEX) {
    return { ok: false, code: "wrong_account_type", detail: "discriminator is not PriceUpdateV2" };
  }
  if (data.byteLength < 41) {
    return { ok: false, code: "wrong_account_type", detail: `only ${data.byteLength} bytes` };
  }
  const tag = data[40];
  if (tag !== 0 && tag !== 1) {
    return { ok: false, code: "not_fully_verified", detail: `unknown verification tag ${tag}` };
  }
  const shift = tag === 0 ? 1 : 0;
  if (data.byteLength < PRICE_UPDATE_FULL_LENGTH + shift) {
    return { ok: false, code: "wrong_account_type", detail: `only ${data.byteLength} bytes` };
  }
  const view = viewOf(data);
  const at = 41 + shift;
  return {
    ok: true,
    update: {
      writeAuthority: data.slice(8, 40),
      verification: tag === 1 ? "full" : "partial",
      numSignatures: tag === 0 ? (data[41] ?? null) : null,
      feedIdHex: toHex(data.subarray(at, at + 32)),
      price: view.getBigInt64(at + 32, true),
      conf: view.getBigUint64(at + 40, true),
      exponent: view.getInt32(at + 48, true),
      publishTime: view.getBigInt64(at + 52, true),
      prevPublishTime: view.getBigInt64(at + 60, true),
      emaPrice: view.getBigInt64(at + 68, true),
      emaConf: view.getBigUint64(at + 76, true),
      postedSlot: view.getBigUint64(at + 84, true),
    },
  };
}

/**
 * Scale a raw Pyth value to micro-dollars: raw * 10^(exponent + 6). The
 * caller has already checked the exponent is within -12..0.
 */
function toMicroUsd(raw: bigint, exponent: number, round: "down" | "up"): bigint {
  const power = exponent + 6;
  if (power >= 0) return raw * 10n ** BigInt(power);
  const divisor = 10n ** BigInt(-power);
  const floor = raw / divisor;
  return round === "up" && raw % divisor !== 0n ? floor + 1n : floor;
}

function isBps(value: number, min: number): boolean {
  return Number.isInteger(value) && value >= min && value <= 10_000;
}

/**
 * Judge one read of the price account and the clock. A quote, or the first
 * refusal met in the order below. Never throws.
 */
export function judgeSolPrice(input: JudgeSolPriceInput): SolPriceResult {
  try {
    return judge(input);
  } catch (err) {
    // Bytes that cannot be read are not a price account we know.
    return refuse("wrong_account_type", err instanceof Error ? err.message : String(err));
  }
}

function judge(input: JudgeSolPriceInput): SolPriceResult {
  const { rules } = input;
  if (input.source !== "pyth") return refuse("source_off");
  if (!input.account) return refuse("account_missing");
  if (!rules.allowedOwners.includes(input.account.owner)) {
    return refuse("wrong_owner", `owner ${input.account.owner}`);
  }

  const decoded = decodePriceUpdateV2(input.account.data);
  if (!decoded.ok) return refuse(decoded.code, decoded.detail);
  const update = decoded.update;
  if (update.verification !== "full") {
    return refuse("not_fully_verified", `partial, ${update.numSignatures} signatures`);
  }

  const wantedFeed = rules.feedIdHex.toLowerCase().replace(/^0x/, "");
  if (wantedFeed.length !== 64 || update.feedIdHex !== wantedFeed) {
    return refuse("wrong_feed", `feed ${update.feedIdHex}`);
  }

  if (update.price <= 0n) return refuse("bad_price", `price ${update.price}`);
  if (update.exponent < -12 || update.exponent > 0) {
    return refuse("bad_exponent", `exponent ${update.exponent}`);
  }

  const chainNow = decodeClockUnixTimestamp(input.clockData);
  if (chainNow === null) return refuse("clock_missing");
  const age = chainNow - update.publishTime;
  if (!Number.isFinite(rules.maxAgeSeconds) || rules.maxAgeSeconds < 0) {
    return refuse("stale", "the maximum age is not a usable number");
  }
  if (age > BigInt(Math.floor(rules.maxAgeSeconds))) return refuse("stale", `age ${age}s`);
  if (age < BigInt(-SOL_PRICE_MAX_FUTURE_SECONDS)) return refuse("clock_skew", `age ${age}s`);

  // conf / price above the maximum, on the raw values (same scale).
  if (!isBps(rules.maxConfBps, 0) || update.conf * BPS > update.price * BigInt(rules.maxConfBps)) {
    return refuse("too_uncertain", `conf ${update.conf} on price ${update.price}`);
  }

  // |price - ema| / ema above the maximum. An average that is not positive
  // cannot be compared against, so it refuses too.
  const gap = update.price > update.emaPrice ? update.price - update.emaPrice : update.emaPrice - update.price;
  if (
    update.emaPrice <= 0n ||
    !isBps(rules.maxEmaDeviationBps, 0) ||
    gap * BPS > update.emaPrice * BigInt(rules.maxEmaDeviationBps)
  ) {
    return refuse("off_average", `price ${update.price}, average ${update.emaPrice}`);
  }

  const mid = toMicroUsd(update.price, update.exponent, "down");
  const conf = toMicroUsd(update.conf, update.exponent, "up");
  // A price below one micro-dollar is not one money can be divided by.
  if (mid <= 0n) return refuse("bad_price", `price ${update.price} at exponent ${update.exponent}`);

  const min = rules.minMicroUsdPerSol ?? null;
  const max = rules.maxMicroUsdPerSol ?? null;
  if ((min !== null && mid < min) || (max !== null && mid > max)) {
    return refuse("out_of_band", `${mid} micro-dollars per SOL`);
  }

  return {
    ok: true,
    quote: {
      source: "pyth",
      midMicroUsdPerSol: mid,
      confMicroUsdPerSol: conf,
      publishTime: Number(update.publishTime),
      ageSeconds: age > 0n ? Number(age) : 0,
      account: rules.accountAddress,
    },
  };
}

/**
 * The operator-stated price for a local chain: no uncertainty, published
 * now. The setting is a decimal number of dollars, so this is the one place
 * a float becomes a price; it is rounded to a whole micro-dollar once.
 */
export function staticSolQuote(usdPerSol: number | null | undefined, nowUnixSeconds: number): SolPriceResult {
  if (usdPerSol === null || usdPerSol === undefined) return refuse("static_not_set");
  if (!Number.isFinite(usdPerSol) || usdPerSol <= 0) return refuse("static_not_set", "not a positive number");
  const micro = Math.round(usdPerSol * 1_000_000);
  if (!Number.isSafeInteger(micro) || micro <= 0) return refuse("static_not_set", "not a usable price");
  return {
    ok: true,
    quote: {
      source: "static",
      midMicroUsdPerSol: BigInt(micro),
      confMicroUsdPerSol: 0n,
      publishTime: Math.floor(nowUnixSeconds),
      ageSeconds: 0,
      account: null,
    },
  };
}

/** Dollars to micro-dollars for the optional band; null when not set. */
export function usdToMicroUsd(usd: number | null | undefined): bigint | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return null;
  const micro = Math.round(usd * 1_000_000);
  return Number.isSafeInteger(micro) ? BigInt(micro) : null;
}

// ---------------------------------------------------------------------------
// Money on a quote
// ---------------------------------------------------------------------------

/** "in": the customer pays us in SOL. "out": we pay SOL out. */
export type SolMoneyDirection = "in" | "out";

export type SolMoneyRefusalCode =
  /** The amount is not above zero. */
  | "bad_amount"
  /** The margin is not a whole number of basis points in 0..9999. */
  | "bad_margin"
  /** The quote values SOL at zero or less once it leans. */
  | "no_value"
  /** The answer rounds to zero. */
  | "rounds_to_zero";

export type LamportsResult = { ok: true; lamports: bigint } | { ok: false; code: SolMoneyRefusalCode };
export type CentsResult = { ok: true; cents: bigint } | { ok: false; code: SolMoneyRefusalCode };
export type SolUsdRateResult = { ok: true; usdPerSol: number } | { ok: false; code: SolMoneyRefusalCode };

/**
 * What one SOL is worth in a direction, as micro-dollars * 10,000 (the
 * basis-point scale is kept in so nothing is rounded before the one
 * division each helper makes).
 *   in:  (mid - conf) less the margin. We count the customer's SOL low.
 *   out: (mid + conf) plus the margin. We count the SOL we send high.
 * Both lean against the customer.
 */
function scaledValue(
  quote: SolQuote,
  direction: SolMoneyDirection,
  marginBps: number
): { ok: true; value: bigint } | { ok: false; code: SolMoneyRefusalCode } {
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps >= 10_000) {
    return { ok: false, code: "bad_margin" };
  }
  const { midMicroUsdPerSol: mid, confMicroUsdPerSol: conf } = quote;
  if (typeof mid !== "bigint" || typeof conf !== "bigint" || mid <= 0n || conf < 0n) {
    return { ok: false, code: "no_value" };
  }
  const margin = BigInt(marginBps);
  const value = direction === "in" ? (mid - conf) * (BPS - margin) : (mid + conf) * (BPS + margin);
  if (value <= 0n) return { ok: false, code: "no_value" };
  return { ok: true, value };
}

function isPositiveAmount(amount: bigint): boolean {
  return typeof amount === "bigint" && amount > 0n;
}

/**
 * Money in, dollars given: the lamports a customer must send to be credited
 * `cents`. Rounded up.
 */
export function lamportsToCollectForCents(quote: SolQuote, cents: bigint, marginBps: number): LamportsResult {
  if (!isPositiveAmount(cents)) return { ok: false, code: "bad_amount" };
  const value = scaledValue(quote, "in", marginBps);
  if (!value.ok) return value;
  const numerator = cents * MICRO_USD_PER_CENT * LAMPORTS_PER_SOL_BIGINT * BPS;
  const lamports = (numerator + value.value - 1n) / value.value;
  if (lamports <= 0n) return { ok: false, code: "rounds_to_zero" };
  return { ok: true, lamports };
}

/**
 * Money in, lamports given (a transfer that already arrived): the cents to
 * credit for it. Rounded down; a transfer worth less than one cent refuses.
 */
export function centsToCreditForLamports(quote: SolQuote, lamports: bigint, marginBps: number): CentsResult {
  if (!isPositiveAmount(lamports)) return { ok: false, code: "bad_amount" };
  const value = scaledValue(quote, "in", marginBps);
  if (!value.ok) return value;
  const cents = (lamports * value.value) / (LAMPORTS_PER_SOL_BIGINT * MICRO_USD_PER_CENT * BPS);
  if (cents <= 0n) return { ok: false, code: "rounds_to_zero" };
  return { ok: true, cents };
}

/**
 * Money out: the lamports to send for a debt of `cents`. Rounded down; a
 * debt worth less than one lamport refuses.
 */
export function lamportsToSendForCents(quote: SolQuote, cents: bigint, marginBps: number): LamportsResult {
  if (!isPositiveAmount(cents)) return { ok: false, code: "bad_amount" };
  const value = scaledValue(quote, "out", marginBps);
  if (!value.ok) return value;
  const lamports = (cents * MICRO_USD_PER_CENT * LAMPORTS_PER_SOL_BIGINT * BPS) / value.value;
  if (lamports <= 0n) return { ok: false, code: "rounds_to_zero" };
  return { ok: true, lamports };
}

/**
 * The dollars-per-SOL figure a direction used, to show and to store on a
 * row. A float: display only, never an input to an amount.
 */
export function solUsdRate(quote: SolQuote, direction: SolMoneyDirection, marginBps: number): SolUsdRateResult {
  const value = scaledValue(quote, direction, marginBps);
  if (!value.ok) return value;
  const usdPerSol = Number(value.value) / 10_000 / 1_000_000;
  if (!Number.isFinite(usdPerSol) || usdPerSol <= 0) return { ok: false, code: "no_value" };
  return { ok: true, usdPerSol };
}
