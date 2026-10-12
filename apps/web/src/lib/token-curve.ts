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
  type TokenTradeQuote,
} from "./api";

export const SOL_DECIMALS = 9;
/** Every token launched here has 6 decimals. */
export const TOKEN_DECIMALS = 6;
/** Every token launched here has a supply of 1,000,000,000, so one percent of it is 10,000,000 tokens. */
const TOKENS_PER_PERCENT_DECIMALS = 7;

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

/**
 * What a list of tokens says for a token on Meteora in place of a dollar
 * price nobody has read. Null for any other token, and for one that failed.
 */
export function curveListLabel(
  token: { launchpad?: string | null; status?: string | null } | null | undefined
): string | null {
  if (!isMeteoraToken(token)) return null;
  if (token?.status === "GRADUATED") return STATE_SENTENCES.graduated;
  if (token?.status === "FAILED") return null;
  return "On a Meteora curve";
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
 * takes and as raw units. Digits and one decimal mark only: no sign, no
 * exponent, no thousands separator. A comma on its own is the decimal mark,
 * as much of the world types it, so "1,5" is 1.5. A comma beside a point
 * ("1,234.5") or a second comma is refused, never guessed at.
 */
export function parseTypedAmount(text: string, decimals: number): TypedAmount {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  const typed = /^[^.,]*,[^.,]*$/.test(trimmed) ? trimmed.replace(",", ".") : trimmed;
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
      return "Type the amount as a number, with a point or a comma for decimals.";
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

/**
 * The line under a quote for a buy that would overfill the curve: the trade
 * takes only what fills it. Null when the whole amount is used, for a sell,
 * and when the API is older than the two members this reads.
 */
export function partialFillLine(
  quote: Pick<TokenTradeQuote, "side" | "amountInRaw" | "amountInUsedRaw">
): string | null {
  const asked = quote.amountInRaw;
  const used = quote.amountInUsedRaw;
  if (quote.side !== "buy") return null;
  if (typeof asked !== "string" || typeof used !== "string") return null;
  if (!/^\d+$/.test(asked) || !/^\d+$/.test(used)) return null;
  if (BigInt(used) >= BigInt(asked)) return null;
  const rest = (BigInt(asked) - BigInt(used)).toString();
  return `Only ${formatLamports(used)} SOL is needed to fill the curve. The other ${formatLamports(rest)} SOL stays in your wallet.`;
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

/** A token whose curve call answers 404: there is nothing to ask for again. */
export const NO_CURVE_SENTENCE = "This token has no curve here.";
export const NO_CURVE_NO_TRADE_SENTENCE =
  "This token has no curve here, so it cannot be traded in WheelsAI.";

/**
 * Why the curve could not be read. A 404 is a token with no curve: the page
 * says so and stops asking. Anything else (a 503 from a busy RPC, a network
 * that dropped) is worth asking again.
 */
export function curveReadFailure(err: unknown): "no_curve" | "unreadable" {
  return getApiErrorBody(err)?.status === 404 ? "no_curve" : "unreadable";
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
 * What a preset does with the creator's tokens, said before the launch is
 * signed: nothing locked, or how many are locked, how long nothing is
 * released after graduation, then in how many parts over how long.
 */
export function presetLockSentence(preset: Pick<CurvePreset, "creatorLocked">): string {
  const locked = preset.creatorLocked;
  if (!locked) return "This curve locks none of your tokens.";
  // A percentage of the supply as a count of tokens, in integers.
  const count = parseTypedAmount(locked.percentOfSupply, TOKENS_PER_PERCENT_DECIMALS);
  const howMany = count.ok
    ? `${groupThousands(count.raw)} tokens (${locked.percentOfSupply}% of the supply) are locked for you.`
    : `${locked.percentOfSupply}% of the supply is locked for you.`;
  const parts = `${locked.periods} equal part${locked.periods === 1 ? "" : "s"}`;
  return `${howMany} Nothing is released for ${durationWords(locked.cliffSeconds)} after graduation, then they are released in ${parts} over ${durationWords(locked.totalSeconds)}.`;
}

type CurvePoint = { soldPercent: number; priceSol: number };

/** Where a point of the curve sits in a box of `width` by `height`. Null when there is nothing to draw. */
function curveScale(points: ReadonlyArray<CurvePoint>, width: number, height: number, padding: number) {
  const usable = points.filter((p) => Number.isFinite(p.soldPercent) && Number.isFinite(p.priceSol));
  if (usable.length < 2) return null;
  const xs = usable.map((p) => p.soldPercent);
  const ys = usable.map((p) => p.priceSol);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX;
  const spanY = Math.max(...ys) - minY;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const place = (p: CurvePoint) => ({
    // A flat line (one price, or one share) sits in the middle of the box.
    x: padding + (spanX === 0 ? 0.5 : (p.soldPercent - minX) / spanX) * innerW,
    y: padding + innerH - (spanY === 0 ? 0.5 : (p.priceSol - minY) / spanY) * innerH,
  });
  return { usable, place };
}

/**
 * The line of a preset's drawing, as the `d` of an SVG path that fits a box
 * of `width` by `height`: sold share left to right, price bottom to top.
 * Empty when there is nothing to draw.
 */
export function curveSvgPath(
  points: ReadonlyArray<CurvePoint>,
  width: number,
  height: number,
  padding = 2
): string {
  const scale = curveScale(points, width, height, padding);
  if (!scale) return "";
  return scale.usable
    .map((p, i) => {
      const { x, y } = scale.place(p);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

/**
 * Where the mark for the current price goes on that same drawing: on the
 * line, at the place where the curve reaches `priceSol`. A price below the
 * curve's start sits at its start and one above its end at its end. Null
 * when there is no line, or no price that can be read.
 */
export function curveMarkPoint(
  points: ReadonlyArray<CurvePoint>,
  priceSol: string | null | undefined,
  width: number,
  height: number,
  padding = 2
): { x: number; y: number } | null {
  const scale = curveScale(points, width, height, padding);
  if (!scale) return null;
  if (typeof priceSol !== "string" || !/^\d+(\.\d+)?$/.test(priceSol)) return null;
  // A float is enough here: this places a dot on a drawing and decides nothing.
  const price = Number(priceSol);
  const line = [...scale.usable].sort((a, b) => a.soldPercent - b.soldPercent);
  const first = line[0]!;
  const last = line[line.length - 1]!;
  if (price <= first.priceSol) return scale.place(first);
  if (price >= last.priceSol) return scale.place(last);
  for (let i = 1; i < line.length; i++) {
    const from = line[i - 1]!;
    const to = line[i]!;
    if (price > to.priceSol) continue;
    const rise = to.priceSol - from.priceSol;
    const along = rise === 0 ? 0 : (price - from.priceSol) / rise;
    return scale.place({
      soldPercent: from.soldPercent + along * (to.soldPercent - from.soldPercent),
      priceSol: price,
    });
  }
  return scale.place(last);
}

// ============================================
// The picture link in the wizard
// ============================================

export type PictureLink =
  | { ok: true; url: string }
  | { ok: false; reason: "empty" | "not_a_link" };

/** What was typed into the picture link field: an http or https address, or why it is not one. */
export function readPictureLink(text: string): PictureLink {
  const typed = text.trim();
  if (typed === "") return { ok: false, reason: "empty" };
  if (/\s/.test(typed)) return { ok: false, reason: "not_a_link" };
  try {
    const url = new URL(typed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "not_a_link" };
    return { ok: true, url: typed };
  } catch {
    return { ok: false, reason: "not_a_link" };
  }
}

export const PICTURE_LINK_HELP =
  "The address of a PNG, JPG, GIF or WebP image that the server can fetch. It becomes the token's picture.";
export const PICTURE_LINK_NOT_A_LINK_SENTENCE =
  "Type the whole address of the image, starting with http:// or https://.";

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

/** A transaction that was sent and that nobody saw confirmed. */
export const SENT_NOT_CONFIRMED_SENTENCE =
  "The transaction was sent and Solana has not confirmed it yet.";
/** A transaction the chain took and refused. */
export const SENT_FAILED_SENTENCE =
  "Solana refused the transaction. Nothing was taken but the network fee.";

const REFUSAL_SENTENCES: Record<string, string> = {
  invalid_amount: "Type an amount above zero.",
  curve_full: "The curve is full, so buying and selling on it have stopped. It can graduate now.",
  curve_unreadable: "The curve could not be read from Solana just now. Try again in a moment.",
  not_a_curve_token: "This token is not on a Meteora curve.",
  not_the_creator: "Only the wallet that launched this token can claim its fees.",
  nothing_to_claim: "There are no fees to claim yet.",
  curve_not_full: "The curve is not full yet, so it cannot graduate.",
  already_graduated: "This token has already graduated.",
  transaction_not_confirmed: SENT_NOT_CONFIRMED_SENTENCE,
  transaction_failed: SENT_FAILED_SENTENCE,
  // The rules name the refusals above. These are the other codes the curve's
  // routes answer with; without a sentence a person would read the code.
  unauthenticated: "Sign in to do this.",
  token_not_found: "This token could not be found.",
  invalid_wallet: "This wallet's address could not be read. Connect the wallet again.",
  invalid_payload: "The request could not be read. Reload the page and try again.",
  transaction_mismatch:
    "The wallet sent back a different transaction from the one that was built, so it was not sent. Try again.",
  prepare_token_not_yours: "This transaction was prepared by another account. Prepare it again.",
  prepare_unavailable: "The transaction could not be built just now. Try again in a moment.",
  build_failed: "The transaction could not be built just now. Try again in a moment.",
  send_failed: "Solana refused the transaction, so nothing was sent. Try again.",
  persistence_failed:
    "The transaction went through on Solana, but it could not be saved here. Reload the page in a moment.",
};

export const NO_WALLET_SENTENCE = "Connect a wallet first.";
export const WALLET_CANNOT_SIGN_SENTENCE =
  "This wallet cannot sign a transaction here. Try a different wallet.";
export const NOT_ENOUGH_SOL_SENTENCE = "There is not enough SOL in this wallet.";
export const NOT_ENOUGH_TOKENS_SENTENCE = "This wallet does not hold that many tokens.";
export const QUOTE_EXPIRED_SENTENCE =
  "Signing took too long and the quote expired, so nothing was sent. Prepare the trade again.";
/** The same refusal for a claim or a step of graduation, where there is no quote. */
export const REQUEST_EXPIRED_SENTENCE =
  "Signing took too long and the request expired, so nothing was sent. Prepare it again.";
export const WALLET_SAID_NO_SENTENCE = "You cancelled the request in your wallet.";

// How Solana says a transaction was signed too late to be taken.
const OLD_BLOCKHASH = /blockhash not found|block ?height exceeded|blockhash (has )?expired|transaction (has )?expired/i;

function refusalParts(err: unknown): { status: number; code: string; detail: string } | null {
  const api = getApiErrorBody(err);
  if (!api) return null;
  return {
    status: api.status,
    code: typeof api.body.error === "string" ? api.body.error : "",
    detail: typeof api.body.message === "string" ? api.body.message : "",
  };
}

/**
 * True when an action failed only because signing took too long: the server
 * answers with an expired prepare token, or the chain refuses a blockhash
 * that is too old. Nothing was sent, and the way out is to prepare again.
 */
export function tookTooLongToSign(err: unknown): boolean {
  const refusal = refusalParts(err);
  if (!refusal) return false;
  // Sent is sent: a transaction with a signature to follow did not expire unsent.
  if (sentTransactionFromError(err)) return false;
  return (
    /expired/i.test(refusal.code) ||
    refusal.code === "prepare_token_invalid" ||
    OLD_BLOCKHASH.test(refusal.detail)
  );
}

/**
 * A failed call as a sentence: the API's refusals by their code, a wallet
 * that said no, and for anything else the fallback. The server's own text
 * and a wallet's own text are never what a person reads.
 */
function refusalSentence(
  err: unknown,
  fallback: string,
  expired: string,
  sentences: Record<string, string>
): string {
  const refusal = refusalParts(err);
  if (refusal) {
    const { code, detail } = refusal;
    // Solana's own words for an empty wallet travel inside a refused send.
    if (/insufficient/i.test(code) || /insufficient (funds|lamports)/i.test(detail)) {
      return NOT_ENOUGH_SOL_SENTENCE;
    }
    // The prepare token lives 90 seconds and a blockhash about as long.
    // Whatever the refusal is called, the way out is the same: prepare again.
    if (tookTooLongToSign(err)) return expired;
    const known = sentences[code];
    if (known) return known;
    if (refusal.status === 401) return "Sign in to do this.";
    return fallback;
  }
  // Not from the API, so it is the wallet speaking. Each wallet words a
  // refusal its own way ("User rejected the request", "Approval denied").
  const message = getErrorMessage(err, "");
  if (/reject|denied|declin|cancel/i.test(message)) return WALLET_SAID_NO_SENTENCE;
  if (/insufficient (funds|lamports)/i.test(message)) return NOT_ENOUGH_SOL_SENTENCE;
  return fallback;
}

/**
 * A failed action on the curve as a sentence. `expired` is what signing too
 * late reads as: a trade has a quote to ask for again, a claim and a
 * graduation do not.
 */
export function curveErrorSentence(
  err: unknown,
  fallback: string,
  expired: string = QUOTE_EXPIRED_SENTENCE
): string {
  return refusalSentence(err, fallback, expired, REFUSAL_SENTENCES);
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

/** A transaction the server sent and then answered a refusal about. */
export interface SentTransaction {
  /**
   * `not_confirmed`: it may still land, so it can be checked again.
   * `failed`: the chain refused it.
   * `not_saved`: it went through and the server could not write it down.
   */
  kind: "not_confirmed" | "failed" | "not_saved";
  signature: string;
}

/**
 * What a refusal says about a transaction that was already sent, or null
 * when nothing was sent. Any refusal that carries a signature is a sent
 * transaction; `transaction_failed` says the chain refused it, and
 * `persistence_failed` (a graduation that moved and was not written down)
 * says it went through.
 */
export function sentTransactionFromError(err: unknown): SentTransaction | null {
  const signature = sentSignatureFromError(err);
  if (signature === null) return null;
  const code = getApiErrorBody(err)?.body.error;
  const kind =
    code === "transaction_failed" ? "failed" : code === "persistence_failed" ? "not_saved" : "not_confirmed";
  return { kind, signature };
}

/**
 * True when posting the same body once more can still help: the server
 * records a transaction that has landed. Not for one the chain refused.
 */
export function canCheckAgain(sent: SentTransaction | null | undefined): boolean {
  return !!sent && sent.kind !== "failed";
}

/** A transaction that went through on Solana and that the server could not write down. */
export const SENT_NOT_SAVED_SENTENCE =
  "The transaction went through on Solana, but it could not be saved here. Check again to save it.";

/** "Check again" was pressed and the server still could not say the transaction landed. */
export const STILL_NOT_CONFIRMED_SENTENCE =
  "It is still not confirmed here. Follow the transaction on the explorer before you do this again.";

/** The sentence beside a sent transaction's link. */
export function sentTransactionSentence(sent: SentTransaction): string {
  if (sent.kind === "failed") return SENT_FAILED_SENTENCE;
  return sent.kind === "not_saved" ? SENT_NOT_SAVED_SENTENCE : SENT_NOT_CONFIRMED_SENTENCE;
}

// ============================================
// Errors of the launch
// ============================================

export const LAUNCH_EXPIRED_SENTENCE =
  "Signing took too long and the launch expired, so nothing was sent. Prepare it again. What you typed is kept.";
export const NO_LINKED_WALLET_SENTENCE =
  "This account has no linked wallet. Link one under Settings, in the Wallets tab.";

// The codes the launch routes answer with. The refusals a creator can fix
// say what to change; the rest say what happened and what to do next.
const LAUNCH_REFUSAL_SENTENCES: Record<string, string> = {
  ...REFUSAL_SENTENCES,
  wallet_required: NO_LINKED_WALLET_SENTENCE,
  invalid_preset: "That curve is not offered here. Go back and choose a curve again.",
  first_buy_not_supported:
    "A first buy cannot be part of this launch. Make it on the token's page after launch.",
  picture_required:
    "A token needs a picture. Add an icon to the agent's listing, or go back and type a picture link.",
  name_too_long:
    "The token's name is too long. It can take 32 bytes, and a letter with an accent or an emoji counts for more than one.",
  symbol_too_long:
    "The symbol is too long. It can take 10 bytes, and a letter with an accent or an emoji counts for more than one.",
  metadata_link_too_long:
    "The link to the token's uploaded details is too long for the launch transaction. It is the link that is too long, not the name. Try again, and contact support if it keeps happening.",
  picture_link_refused:
    "That picture link cannot be used. Use the public http or https address of an image.",
  picture_upload_failed:
    "The picture could not be uploaded just now. Check that the link opens a PNG, JPG, GIF or WebP image, then try again.",
  invalid_payload:
    "Some of the token's details could not be accepted. Check the name, the symbol and the picture link.",
  agent_not_found: "This agent could not be found.",
  not_eligible: "This agent cannot launch a token yet. The reasons are listed under it in the first step.",
  listing_required: "This agent needs a published marketplace listing before it can launch a token.",
  launch_prepare_failed: "The launch could not be prepared just now. Try again in a moment.",
  launch_submit_failed: "The launch could not be sent to Solana, so nothing was created. Prepare it again.",
  prepare_token_org_mismatch: "This launch was prepared in another organization. Prepare it again.",
  prepare_token_creator_mismatch:
    "This launch was prepared for a different wallet from the one this account is linked to now. Prepare it again.",
  prepare_token_launchpad_mismatch:
    "The launchpad changed while this launch was being signed. Reload the page and prepare it again.",
  mint_mismatch: "This token is not the one that was prepared, so it was not linked.",
  mint_not_on_chain: "The token is not on Solana yet. Check again in a moment.",
  mint_check_failed: "Solana could not be asked about the token just now. Try again in a moment.",
  reconcile_failed: "The token could not be linked to your dashboard. Try again, or contact support.",
};

/** A failed launch (prepare, submit or the check afterwards) as a sentence. */
export function launchErrorSentence(err: unknown, fallback: string): string {
  return refusalSentence(err, fallback, LAUNCH_EXPIRED_SENTENCE, LAUNCH_REFUSAL_SENTENCES);
}

/**
 * "Check again" on a launch that was sent and not seen confirmed asks
 * whether the token is on Solana and saves it if it is. When it is not
 * there yet, or the question could not be asked, this says so. It never
 * says nothing was sent: something was.
 */
export function launchCheckSentence(err: unknown, fallback: string = STILL_NOT_CONFIRMED_SENTENCE): string {
  const code = refusalParts(err)?.code ?? "";
  if (code === "mint_not_on_chain" || code === "mint_check_failed" || code === "reconcile_failed") {
    return LAUNCH_REFUSAL_SENTENCES[code]!;
  }
  return fallback;
}

/** The launch was refused because the account has no linked wallet: the page adds a link to Settings. */
export function isNoLinkedWalletRefusal(err: unknown): boolean {
  return refusalParts(err)?.code === "wallet_required";
}

/**
 * The address the launch was prepared for, when it is not the wallet
 * connected here. Null when they match, and when an older API named no
 * address to compare (the server still checks the signed transaction).
 */
export function preparedForAnotherWallet(
  prepared: { creatorAddress?: string | null; creatorPubkey?: string | null },
  connected: string | null | undefined
): string | null {
  const linked = prepared.creatorAddress || prepared.creatorPubkey;
  if (typeof linked !== "string" || linked === "") return null;
  return isSameAddress(linked, connected) ? null : linked;
}

/** Said in place of asking the wallet to sign a launch built for another wallet. */
export function linkedWalletMismatchSentence(
  linkedAddress: string,
  connectedAddress?: string | null
): string {
  const here = connectedAddress
    ? `the wallet connected here is ${connectedAddress}`
    : "a different wallet is connected here";
  return `This account is linked to the wallet ${linkedAddress}, and ${here}. Nothing was signed. Switch your wallet to the linked address, or change the account's wallet under Settings.`;
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
