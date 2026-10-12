/**
 * How a token on WheelsAI's own Meteora curve is worded and worked out in the
 * dashboard.
 *
 * Pure: every figure a page shows comes from the API (the price, the SOL
 * raised, the fee, a quote) and passes through here only to be formatted.
 * Amounts arrive as strings and are handled as strings and bigints, so
 * nothing is rounded on its way to the page. The only floats are the
 * points of a preset's drawing and the progress of the bar.
 */

import {
  getApiErrorBody,
  getErrorMessage,
  type CurvePreset,
  type GraduationStep,
  type TokenCurve,
  type TokenCurveState,
} from "./api";

export const SOL_DECIMALS = 9;
/** Every token launched here has 6 decimals. */
export const TOKEN_DECIMALS = 6;

/** Shown where there is no figure to show. Never a zero that was not read. */
export const NO_FIGURE = "-";

/** Graduation is explained once on a page, where the word first appears. */
export const GRADUATION_EXPLANATION =
  "Graduation: when enough SOL has been raised, the token moves to a Meteora pool where its liquidity is locked for good.";

// ============================================
// Launchpads
// ============================================

const LAUNCHPAD_LABELS: Record<string, string> = {
  pumpfun: "pump.fun",
  bags: "Bags",
  meteora: "Meteora",
};

/** The launchpad's name as a page shows it. An unknown one falls back to pump.fun, the oldest. */
export function launchpadLabel(launchpad: string | null | undefined): string {
  return LAUNCHPAD_LABELS[launchpad ?? ""] ?? "pump.fun";
}

export function isMeteoraToken(token: { launchpad?: string | null } | null | undefined): boolean {
  return token?.launchpad === "meteora";
}

// ============================================
// Amounts
// ============================================

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Cuts a fraction to `max` digits (never rounds up) and drops the zeros at its end. */
function cutFraction(fraction: string, max: number): string {
  return fraction.slice(0, Math.max(0, max)).replace(/0+$/, "");
}

/** The smallest amount `max` digits can show, for an amount that is not zero and is smaller. */
function belowSmallest(max: number): string {
  return max > 0 ? `<0.${"0".repeat(max - 1)}1` : "<1";
}

function joinAmount(whole: string, fraction: string, max: number): string {
  const cut = cutFraction(fraction, max);
  const cleanWhole = whole.replace(/^0+(?=\d)/, "");
  if (cut === "" && /^0*$/.test(cleanWhole) && /[1-9]/.test(fraction)) {
    return belowSmallest(max);
  }
  return cut === "" ? groupThousands(cleanWhole) : `${groupThousands(cleanWhole)}.${cut}`;
}

/**
 * A string of raw units as a person reads it: "1250000000" with 9 decimals
 * is "1.25". Digits past `maxFractionDigits` are cut, never rounded up, so a
 * page never shows more than there is.
 */
export function formatRawAmount(
  raw: string | null | undefined,
  decimals: number,
  maxFractionDigits: number = decimals
): string {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return NO_FIGURE;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = decimals > 0 ? padded.slice(padded.length - decimals) : "";
  return joinAmount(whole, fraction, maxFractionDigits);
}

/** Lamports as SOL, with every digit there is unless a shorter form is asked for. */
export function formatLamports(raw: string | null | undefined, maxFractionDigits = SOL_DECIMALS): string {
  return formatRawAmount(raw, SOL_DECIMALS, maxFractionDigits);
}

/** A token's raw units as tokens, to two decimals unless more are asked for. */
export function formatTokenUnits(raw: string | null | undefined, maxFractionDigits = 2): string {
  return formatRawAmount(raw, TOKEN_DECIMALS, maxFractionDigits);
}

/**
 * A decimal string from the API ("4650000.12") with its thousands grouped.
 * With `maxFractionDigits` the fraction is cut to that length.
 */
export function formatDecimal(value: string | null | undefined, maxFractionDigits?: number): string {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) return NO_FIGURE;
  const [whole = "0", fraction = ""] = value.split(".");
  return joinAmount(whole, fraction, maxFractionDigits ?? fraction.length);
}

/**
 * A price in SOL as a person reads it. A token's price is far below one SOL
 * and arrives with fifteen decimals: the zeros after the point are kept and
 * the digits after them are cut to `significant`, so "0.000000021345678" is
 * "0.00000002134". Cut, never rounded up.
 */
export function formatPriceSol(value: string | null | undefined, significant = 4): string {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) return NO_FIGURE;
  const [whole = "0", fraction = ""] = value.split(".");
  if (/[1-9]/.test(whole)) return joinAmount(whole, fraction, 6);
  const zeros = fraction.length - fraction.replace(/^0+/, "").length;
  return joinAmount(whole, fraction, zeros + Math.max(1, significant));
}

export type TypedAmount =
  | { ok: true; /** The decimal string the API takes. */ amount: string; /** Raw units. */ raw: string }
  | { ok: false; reason: "empty" | "not_a_number" | "too_many_decimals" | "zero" };

/**
 * What a person typed into an amount field, as the decimal string the API
 * takes and as raw units. Digits and one point only: no sign, no exponent,
 * no thousands separator, so "1,5" is refused instead of read as 15 or 1.5.
 */
export function parseTypedAmount(text: string, decimals: number): TypedAmount {
  const typed = text.trim();
  if (typed === "") return { ok: false, reason: "empty" };
  if (!/^(\d+\.?\d*|\.\d+)$/.test(typed)) return { ok: false, reason: "not_a_number" };
  const [wholeTyped = "", fractionTyped = ""] = typed.split(".");
  const fraction = fractionTyped.replace(/0+$/, "");
  if (fraction.length > decimals) return { ok: false, reason: "too_many_decimals" };
  const whole = wholeTyped.replace(/^0+(?=\d)/, "") || "0";
  const raw = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (raw === BigInt(0)) return { ok: false, reason: "zero" };
  return {
    ok: true,
    amount: fraction === "" ? whole : `${whole}.${fraction}`,
    raw: raw.toString(),
  };
}

/** Why a typed amount cannot be used, as a sentence. Null for an empty field: nothing is wrong yet. */
export function typedAmountProblem(amount: TypedAmount, decimals: number): string | null {
  if (amount.ok) return null;
  switch (amount.reason) {
    case "empty":
      return null;
    case "not_a_number":
      return "Type the amount as a number, with a point for decimals.";
    case "too_many_decimals":
      return `Use at most ${decimals} decimal places.`;
    case "zero":
      return "Type an amount above zero.";
  }
}

/** A share of a raw balance, for the 25%, 50%, 75% and 100% buttons, as a decimal string. */
export function shareOfRaw(raw: string, percent: number, decimals: number): string {
  if (!/^\d+$/.test(raw)) return "";
  const part = (BigInt(raw) * BigInt(Math.round(percent))) / BigInt(100);
  const padded = part.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/** True when the first raw amount is larger than the second. False when either cannot be read. */
export function rawExceeds(raw: string, limit: string | null | undefined): boolean {
  if (typeof limit !== "string" || !/^\d+$/.test(raw) || !/^\d+$/.test(limit)) return false;
  return BigInt(raw) > BigInt(limit);
}

// ============================================
// The curve
// ============================================

/** The bar's width, 0 to 100. Anything that is not a number is an empty bar. */
export function progressPercent(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(100, Math.max(0, progress * 100));
}

/** "2%", "19.5%", "less than 0.1%": how far the curve is from full. */
export function progressPercentLabel(progress: number): string {
  const percent = progressPercent(progress);
  if (percent > 0 && percent < 0.1) return "less than 0.1%";
  // Cut, not rounded: a curve at 99.96% is not shown as full.
  const cut = Math.floor(percent * 10) / 10;
  return `${Number.isInteger(cut) ? cut.toFixed(0) : cut.toFixed(1)}%`;
}

/** "1.25 of 64 SOL raised": the line beside the bar. */
export function progressLabel(curve: Pick<TokenCurve, "raisedSol" | "graduationSol">): string {
  return `${formatDecimal(curve.raisedSol, 4)} of ${formatDecimal(curve.graduationSol)} SOL raised`;
}

const STATE_SENTENCES: Record<TokenCurveState, string> = {
  trading: "Trading on the curve",
  full: "The curve is full: it can graduate",
  graduated: "Graduated to a Meteora pool",
};

/** The curve's state in words. An unknown state is shown as it is, never guessed at. */
export function curveStateSentence(state: string): string {
  return STATE_SENTENCES[state as TokenCurveState] ?? state;
}

/** Why the trade form is closed, or null while the curve is trading. */
export function tradingClosedSentence(state: string): string | null {
  if (state === "trading") return null;
  if (state === "full") {
    return "The curve is full, so buying and selling on it have stopped. It can graduate now.";
  }
  if (state === "graduated") {
    return "This token has graduated to a Meteora pool. Trading on that pool is not available in WheelsAI.";
  }
  return "This token cannot be traded here right now.";
}

/** Two addresses are the same wallet. Base58 is case sensitive, so this is an exact match. */
export function isSameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a !== "" && a === b;
}

export function shortAddress(address: string): string {
  return address.length <= 10 ? address : `${address.slice(0, 4)}...${address.slice(-4)}`;
}

// ============================================
// Solana's explorer
// ============================================

function explorerUrl(kind: "address" | "tx", id: string, network: string | null | undefined): string {
  const url = `https://explorer.solana.com/${kind}/${id}`;
  return network === "devnet" ? `${url}?cluster=devnet` : url;
}

export function explorerAddressUrl(address: string, network: string | null | undefined): string {
  return explorerUrl("address", address, network);
}

export function explorerTxUrl(signature: string, network: string | null | undefined): string {
  return explorerUrl("tx", signature, network);
}

// ============================================
// A preset in the wizard
// ============================================

/** "5 minutes", "30 days", "1 hour": a length of time in its largest whole unit. */
export function durationWords(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return NO_FIGURE;
  const units: Array<[number, string]> = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0) {
      const count = seconds / size;
      return `${count.toLocaleString("en-US")} ${name}${count === 1 ? "" : "s"}`;
    }
  }
  return `${seconds.toLocaleString("en-US")} second${seconds === 1 ? "" : "s"}`;
}

/** "nothing for 30 days after graduation, then 12 equal parts over 360 days": how locked tokens are released. */
export function lockScheduleWords(locked: {
  cliffSeconds: number;
  periods: number;
  totalSeconds: number;
}): string {
  const parts = `${locked.periods} equal part${locked.periods === 1 ? "" : "s"}`;
  return `nothing for ${durationWords(locked.cliffSeconds)} after graduation, then ${parts} over ${durationWords(locked.totalSeconds)}`;
}

/** The four facts a preset's card shows, each one sentence, every figure from the API. */
export function presetFacts(preset: CurvePreset): string[] {
  const locked = preset.creatorLocked
    ? `${preset.creatorLocked.percentOfSupply}% of the supply is locked for you: ${lockScheduleWords(preset.creatorLocked)}.`
    : "None of your tokens are locked.";
  return [
    `The price starts with the whole supply valued at ${formatDecimal(preset.startValueSol)} SOL.`,
    `It graduates when ${formatDecimal(preset.raisedAtGraduationSol)} SOL has been raised, with the supply valued at ${formatDecimal(preset.graduationValueSol)} SOL.`,
    `The trading fee starts at ${preset.fee.startPercent}% and falls to ${preset.fee.endPercent}% over the first ${durationWords(preset.fee.seconds)}.`,
    `You earn ${preset.creatorFeeSharePercent}% of the trading fees. ${locked}`,
  ];
}

/**
 * The line of a preset's drawing, as the `d` of an SVG path that fits a box
 * of `width` by `height`: sold share left to right, price bottom to top.
 * Empty when there is nothing to draw.
 */
export function curveSvgPath(
  points: ReadonlyArray<{ soldPercent: number; priceSol: number }>,
  width: number,
  height: number,
  padding = 2
): string {
  const usable = points.filter((p) => Number.isFinite(p.soldPercent) && Number.isFinite(p.priceSol));
  if (usable.length < 2) return "";
  const xs = usable.map((p) => p.soldPercent);
  const ys = usable.map((p) => p.priceSol);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX;
  const spanY = Math.max(...ys) - minY;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  return usable
    .map((p, i) => {
      // A flat line (one price, or one share) sits in the middle of the box.
      const x = padding + (spanX === 0 ? 0.5 : (p.soldPercent - minX) / spanX) * innerW;
      const y = padding + innerH - (spanY === 0 ? 0.5 : (p.priceSol - minY) / spanY) * innerH;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

// ============================================
// Graduation
// ============================================

/** What a step of graduation does, said before the wallet is asked to sign it. */
export function graduationStepSentence(step: GraduationStep | string): string {
  if (step === "locker") {
    return "This step puts the creator's locked tokens into a lock that releases them on the schedule.";
  }
  if (step === "migrate") {
    return "This step moves the SOL raised and the remaining tokens into a Meteora pool and locks that liquidity for good.";
  }
  return "This step is part of graduation.";
}

/** "Step 1 of 2", from the step's place and how many follow it. */
export function graduationStepLabel(stepsDone: number, stepsLeftAfterThis: number): string {
  // A count that did not arrive is no step after this one, never "of NaN".
  const left = Number.isFinite(stepsLeftAfterThis) ? Math.max(0, stepsLeftAfterThis) : 0;
  return `Step ${stepsDone + 1} of ${stepsDone + 1 + left}`;
}

// ============================================
// Errors
// ============================================

const REFUSAL_SENTENCES: Record<string, string> = {
  invalid_amount: "Type an amount above zero.",
  curve_full: "The curve is full, so buying and selling on it have stopped. It can graduate now.",
  curve_unreadable: "The curve could not be read from Solana just now. Try again in a moment.",
  not_a_curve_token: "This token is not on a Meteora curve.",
  not_the_creator: "Only the wallet that launched this token can claim its fees.",
  nothing_to_claim: "There are no fees to claim yet.",
  curve_not_full: "The curve is not full yet, so it cannot graduate.",
  already_graduated: "This token has already graduated.",
  // The rules name the refusals above. These are the other codes the curve's
  // routes answer with; without a sentence a person would read the code.
  unauthenticated: "Sign in to do this.",
  token_not_found: "This token could not be found.",
  invalid_wallet: "This wallet's address could not be read. Connect the wallet again.",
  transaction_mismatch:
    "The wallet sent back a different transaction from the one that was built, so it was not sent. Try again.",
  transaction_not_confirmed:
    "The transaction was sent, but Solana has not confirmed it yet. Check it on the explorer before you try again.",
  prepare_unavailable: "The transaction could not be built just now. Try again in a moment.",
  build_failed: "The transaction could not be built just now. Try again in a moment.",
  send_failed: "Solana refused the transaction, so nothing was sent. Try again.",
};

export const NO_WALLET_SENTENCE = "Connect a wallet first.";
export const WALLET_CANNOT_SIGN_SENTENCE =
  "This wallet cannot sign a transaction here. Try a different wallet.";
export const NOT_ENOUGH_SOL_SENTENCE = "There is not enough SOL in this wallet.";
export const NOT_ENOUGH_TOKENS_SENTENCE = "This wallet does not hold that many tokens.";
export const QUOTE_EXPIRED_SENTENCE = "The quote expired before it was sent. Ask again.";
/** The same refusal for a claim or a step of graduation, where there is no quote. */
export const REQUEST_EXPIRED_SENTENCE = "The request expired before it was sent. Try again.";
export const WALLET_SAID_NO_SENTENCE = "You cancelled the request in your wallet.";

/**
 * A failed action on the curve as a sentence: the API's refusals by their
 * code, a wallet that said no, and anything else through the usual reader.
 * `expired` is what an expired prepare token reads as: a trade has a quote
 * to ask for again, a claim and a graduation do not.
 */
export function curveErrorSentence(
  err: unknown,
  fallback: string,
  expired: string = QUOTE_EXPIRED_SENTENCE
): string {
  const api = getApiErrorBody(err);
  if (api) {
    const code = typeof api.body.error === "string" ? api.body.error : "";
    const detail = typeof api.body.message === "string" ? api.body.message : "";
    // Solana's own words for an empty wallet travel inside a refused send.
    if (/insufficient/i.test(code) || /insufficient (funds|lamports)/i.test(detail)) {
      return NOT_ENOUGH_SOL_SENTENCE;
    }
    const known = REFUSAL_SENTENCES[code];
    if (known) return known;
    // The prepare token lives 90 seconds. Whatever the refusal is called,
    // the way out is the same: ask for the transaction again.
    if (/expired|prepare_token/i.test(code)) return expired;
    if (api.status === 401) return "Sign in to do this.";
    // A code with no sentence beside it is for a program, not for a person.
    if (code !== "" && detail.trim() === "") return fallback;
    return getErrorMessage(err, fallback);
  }
  const message = getErrorMessage(err, fallback);
  // Not from the API, so it is the wallet speaking. Each wallet words a
  // refusal its own way ("User rejected the request", "Approval denied").
  if (/reject|denied|declin|cancel/i.test(message)) return WALLET_SAID_NO_SENTENCE;
  if (/insufficient (funds|lamports)/i.test(message)) return NOT_ENOUGH_SOL_SENTENCE;
  return message;
}

/**
 * The signature inside a refusal, when the API sent the transaction and then
 * could not see it confirmed. The person needs it: the trade may have gone
 * through, and sending it again would do it twice.
 */
export function sentSignatureFromError(err: unknown): string | null {
  const api = getApiErrorBody(err);
  const signature = api?.body.signature;
  return typeof signature === "string" && signature !== "" ? signature : null;
}

// ============================================
// Transactions as text
// ============================================

/** A base64 transaction from the API as bytes, without Node's Buffer (the browser bundle stays small). */
export function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}
