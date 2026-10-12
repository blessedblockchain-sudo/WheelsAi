/**
 * How a token on WheelsAI's own Meteora curve is worded and worked out in the
 * dashboard. Run with:
 *   cd apps/web && npx tsx --test src/lib/token-curve.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ApiError, type CurvePreset, type TokenCurve, type TokenTradeQuote } from "./api";
import {
  GRADUATION_EXPLANATION,
  LAUNCH_EXPIRED_SENTENCE,
  NO_FIGURE,
  NO_LINKED_WALLET_SENTENCE,
  NOT_ENOUGH_SOL_SENTENCE,
  QUOTE_EXPIRED_SENTENCE,
  REQUEST_EXPIRED_SENTENCE,
  SENT_FAILED_SENTENCE,
  SENT_NOT_CONFIRMED_SENTENCE,
  SOL_DECIMALS,
  STILL_NOT_CONFIRMED_SENTENCE,
  TOKEN_DECIMALS,
  base64ToBytes,
  bytesToBase64,
  curveErrorSentence,
  curveListLabel,
  curveMarkPoint,
  curveReadFailure,
  curveStateSentence,
  curveSvgPath,
  durationWords,
  explorerAddressUrl,
  explorerTxUrl,
  formatDecimal,
  formatLamports,
  formatPriceSol,
  formatRawAmount,
  formatTokenUnits,
  graduationStepLabel,
  graduationStepSentence,
  isMeteoraToken,
  isNoLinkedWalletRefusal,
  isSameAddress,
  launchCheckSentence,
  launchErrorSentence,
  launchpadLabel,
  linkedWalletMismatchSentence,
  lockScheduleWords,
  parseTypedAmount,
  partialFillLine,
  preparedForAnotherWallet,
  presetFacts,
  presetLockSentence,
  progressLabel,
  progressPercent,
  progressPercentLabel,
  rawExceeds,
  readPictureLink,
  sentSignatureFromError,
  sentTransactionFromError,
  canCheckAgain,
  SENT_NOT_SAVED_SENTENCE,
  sentTransactionSentence,
  shareOfRaw,
  shortAddress,
  tookTooLongToSign,
  tradingClosedSentence,
  typedAmountProblem,
} from "./token-curve";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, "..", path), "utf8");

// The figures of the rules' own examples, so the tests invent none.
const COMMUNITY: CurvePreset = {
  id: "community",
  name: "Community",
  summary: "A summary written by the API.",
  startValueSol: "20",
  graduationValueSol: "320",
  raisedAtGraduationSol: "64",
  fee: { startPercent: "30", endPercent: "1", seconds: 300 },
  creatorFeeSharePercent: 70,
  creatorLocked: null,
  liquidityLockedPercent: 100,
  points: [
    { soldPercent: 0, priceSol: 0.00000002 },
    { soldPercent: 40, priceSol: 0.00000008 },
    { soldPercent: 80, priceSol: 0.00000032 },
  ],
};

const COMMITTED: CurvePreset = {
  ...COMMUNITY,
  id: "committed",
  name: "Committed creator",
  startValueSol: "30",
  graduationValueSol: "400",
  raisedAtGraduationSol: "77.395",
  creatorFeeSharePercent: 50,
  creatorLocked: { percentOfSupply: "10", cliffSeconds: 2_592_000, periods: 10, totalSeconds: 25_920_000 },
};

// ============================================
// Amounts from raw strings
// ============================================

test("lamports are shown as SOL with every digit there is", () => {
  assert.equal(formatLamports("1250000000"), "1.25");
  assert.equal(formatLamports("64000000000"), "64");
  assert.equal(formatLamports("2329499"), "0.002329499");
  assert.equal(formatLamports("0"), "0");
  assert.equal(formatLamports("1"), "0.000000001");
});

test("a large amount has its thousands grouped and loses no digit to a float", () => {
  assert.equal(formatRawAmount("4650000120000", TOKEN_DECIMALS), "4,650,000.12");
  // Past 2^53: a float would have changed the last digits.
  assert.equal(formatRawAmount("9007199254740993000001", TOKEN_DECIMALS), "9,007,199,254,740,993.000001");
  assert.equal(formatRawAmount("1000000000000000", TOKEN_DECIMALS), "1,000,000,000");
});

test("digits past the limit are cut, never rounded up", () => {
  assert.equal(formatTokenUnits("4603500118800"), "4,603,500.11");
  assert.equal(formatTokenUnits("1999999"), "1.99");
  assert.equal(formatLamports("1999999999", 4), "1.9999");
});

test("an amount too small to show is said to be small, not shown as zero", () => {
  assert.equal(formatTokenUnits("1"), "<0.01");
  assert.equal(formatLamports("5", 4), "<0.0001");
  assert.equal(formatRawAmount("1", 6, 0), "<1");
});

test("what cannot be read as raw units is shown as no figure, never as zero", () => {
  for (const bad of [null, undefined, "", "1.5", "-3", "abc", "1e9"]) {
    assert.equal(formatRawAmount(bad as string | null | undefined, SOL_DECIMALS), NO_FIGURE);
  }
});

test("a decimal string from the API keeps its digits and gains grouping", () => {
  assert.equal(formatDecimal("4650000.12"), "4,650,000.12");
  assert.equal(formatDecimal("0.000000021"), "0.000000021");
  assert.equal(formatDecimal("64"), "64");
  assert.equal(formatDecimal("1.250000", 4), "1.25");
  assert.equal(formatDecimal("21.456789", 4), "21.4567");
  assert.equal(formatDecimal("0.000000021", 4), "<0.0001");
  assert.equal(formatDecimal("0.0000", 4), "0");
  assert.equal(formatDecimal("abc"), NO_FIGURE);
  assert.equal(formatDecimal(null), NO_FIGURE);
});

test("a very small price keeps its zeros and a few digits after them, cut not rounded", () => {
  // Fifteen decimals, as the API sends a price.
  assert.equal(formatPriceSol("0.000000021345678"), "0.00000002134");
  assert.equal(formatPriceSol("0.000000021999999"), "0.00000002199");
  assert.equal(formatPriceSol("0.000000021"), "0.000000021");
  assert.equal(formatPriceSol("0.0005"), "0.0005");
  assert.equal(formatPriceSol("1234.123456789"), "1,234.123456");
  assert.equal(formatPriceSol("0"), "0");
  assert.equal(formatPriceSol("0.000"), "0");
  assert.equal(formatPriceSol("2.1e-8"), NO_FIGURE);
  assert.equal(formatPriceSol(undefined), NO_FIGURE);
});

// ============================================
// A typed amount
// ============================================

test("a typed amount becomes the decimal string the API takes and raw units", () => {
  assert.deepEqual(parseTypedAmount("0.1", SOL_DECIMALS), { ok: true, amount: "0.1", raw: "100000000" });
  assert.deepEqual(parseTypedAmount(" 1.50 ", SOL_DECIMALS), { ok: true, amount: "1.5", raw: "1500000000" });
  assert.deepEqual(parseTypedAmount(".5", SOL_DECIMALS), { ok: true, amount: "0.5", raw: "500000000" });
  assert.deepEqual(parseTypedAmount("2.", SOL_DECIMALS), { ok: true, amount: "2", raw: "2000000000" });
  assert.deepEqual(parseTypedAmount("007", TOKEN_DECIMALS), { ok: true, amount: "7", raw: "7000000" });
  assert.deepEqual(parseTypedAmount("4650000.12", TOKEN_DECIMALS), {
    ok: true,
    amount: "4650000.12",
    raw: "4650000120000",
  });
});

test("a typed amount that is not a plain positive number is refused with its reason", () => {
  assert.deepEqual(parseTypedAmount("", SOL_DECIMALS), { ok: false, reason: "empty" });
  assert.deepEqual(parseTypedAmount("   ", SOL_DECIMALS), { ok: false, reason: "empty" });
  for (const bad of ["abc", "-1", "+1", "1e3", "1.2.3", ".", "0x10", "1 000"]) {
    assert.deepEqual(parseTypedAmount(bad, SOL_DECIMALS), { ok: false, reason: "not_a_number" }, bad);
  }
  assert.deepEqual(parseTypedAmount("0", SOL_DECIMALS), { ok: false, reason: "zero" });
  assert.deepEqual(parseTypedAmount("0.000", SOL_DECIMALS), { ok: false, reason: "zero" });
  assert.deepEqual(parseTypedAmount("0.0000001", TOKEN_DECIMALS), { ok: false, reason: "too_many_decimals" });
  // Zeros at the end are not extra decimals.
  assert.equal(parseTypedAmount("0.1000000000", SOL_DECIMALS).ok, true);
});

test("a comma typed for the decimal point is read as a point", () => {
  assert.deepEqual(parseTypedAmount("1,5", SOL_DECIMALS), { ok: true, amount: "1.5", raw: "1500000000" });
  assert.deepEqual(parseTypedAmount("0,1", SOL_DECIMALS), { ok: true, amount: "0.1", raw: "100000000" });
  assert.deepEqual(parseTypedAmount(",5", SOL_DECIMALS), { ok: true, amount: "0.5", raw: "500000000" });
  assert.deepEqual(parseTypedAmount(" 2, ", SOL_DECIMALS), { ok: true, amount: "2", raw: "2000000000" });
  assert.deepEqual(parseTypedAmount("0,0000001", TOKEN_DECIMALS), { ok: false, reason: "too_many_decimals" });
  assert.deepEqual(parseTypedAmount("0,0", SOL_DECIMALS), { ok: false, reason: "zero" });
  // A comma beside a point, or two commas, could be thousands: refused, never guessed at.
  for (const bad of ["1,234.5", "1.234,5", "1,234,567", ",", "1,,5", "-1,5"]) {
    assert.deepEqual(parseTypedAmount(bad, SOL_DECIMALS), { ok: false, reason: "not_a_number" }, bad);
  }
  assert.match(typedAmountProblem(parseTypedAmount("1,2,3", 9), 9) ?? "", /a point or a comma/);
});

// The quote of the rules' example, with the two members round 2 adds.
const BUY_QUOTE: TokenTradeQuote = {
  side: "buy",
  amountIn: "0.1",
  amountInRaw: "100000000",
  amountOut: "4650000.12",
  amountOutRaw: "4650000120000",
  minimumOut: "4603500.11",
  minimumOutRaw: "4603500118800",
  feeSol: "0.0012",
  priceSolAfter: "0.0000000215",
  amountInUsed: "0.1",
  amountInUsedRaw: "100000000",
};

test("a buy that would overfill the curve says how much is needed and that the rest stays", () => {
  assert.equal(partialFillLine(BUY_QUOTE), null);
  assert.equal(
    partialFillLine({ ...BUY_QUOTE, amountInUsedRaw: "40000000" }),
    "Only 0.04 SOL is needed to fill the curve. The other 0.06 SOL stays in your wallet."
  );
  // One lamport short is still a partial fill: compared as integers.
  assert.equal(
    partialFillLine({ ...BUY_QUOTE, amountInUsedRaw: "99999999" }),
    "Only 0.099999999 SOL is needed to fill the curve. The other 0.000000001 SOL stays in your wallet."
  );
});

test("the partial-fill line is left out for a sell and for an API older than the two members", () => {
  assert.equal(partialFillLine({ ...BUY_QUOTE, side: "sell", amountInUsedRaw: "1" }), null);
  const { amountInUsed: _used, amountInUsedRaw: _usedRaw, ...older } = BUY_QUOTE;
  assert.equal(partialFillLine(older), null);
  assert.equal(partialFillLine({ ...BUY_QUOTE, amountInUsedRaw: "abc" }), null);
  // More used than asked is not a partial fill, and never a negative rest.
  assert.equal(partialFillLine({ ...BUY_QUOTE, amountInUsedRaw: "100000001" }), null);
});

test("each reason a typed amount is refused has a sentence, and an empty field has none", () => {
  assert.equal(typedAmountProblem(parseTypedAmount("", 9), 9), null);
  assert.equal(typedAmountProblem(parseTypedAmount("1", 9), 9), null);
  assert.equal(typedAmountProblem(parseTypedAmount("0", 9), 9), "Type an amount above zero.");
  assert.equal(typedAmountProblem(parseTypedAmount("1.1234567", 6), 6), "Use at most 6 decimal places.");
  assert.match(typedAmountProblem(parseTypedAmount("abc", 9), 9) ?? "", /as a number/);
});

test("a share of a balance is worked out in raw units", () => {
  assert.equal(shareOfRaw("4650000120000", 100, TOKEN_DECIMALS), "4650000.12");
  assert.equal(shareOfRaw("4650000120000", 50, TOKEN_DECIMALS), "2325000.06");
  assert.equal(shareOfRaw("3", 25, TOKEN_DECIMALS), "0");
  assert.equal(shareOfRaw("bad", 25, TOKEN_DECIMALS), "");
  // What the button fills in is something the field accepts.
  assert.equal(parseTypedAmount(shareOfRaw("4650000120001", 75, TOKEN_DECIMALS), TOKEN_DECIMALS).ok, true);
});

test("an amount is compared with a balance as integers, and an unread balance never says no", () => {
  assert.equal(rawExceeds("100000001", "100000000"), true);
  assert.equal(rawExceeds("100000000", "100000000"), false);
  assert.equal(rawExceeds("9007199254740993", "9007199254740992"), true);
  assert.equal(rawExceeds("1", null), false);
  assert.equal(rawExceeds("1", undefined), false);
  assert.equal(rawExceeds("1", "abc"), false);
});

// ============================================
// The curve
// ============================================

test("the progress label says the SOL raised and the SOL it graduates at", () => {
  assert.equal(progressLabel({ raisedSol: "1.25", graduationSol: "64" }), "1.25 of 64 SOL raised");
  assert.equal(progressLabel({ raisedSol: "0", graduationSol: "77.395" }), "0 of 77.395 SOL raised");
  assert.equal(progressLabel({ raisedSol: "1.39100001", graduationSol: "1.391" }), "1.391 of 1.391 SOL raised");
});

test("the bar's width stays between 0 and 100", () => {
  assert.equal(progressPercent(0.0195), 1.95);
  assert.equal(progressPercent(0), 0);
  assert.equal(progressPercent(1), 100);
  assert.equal(progressPercent(1.4), 100);
  assert.equal(progressPercent(-0.2), 0);
  assert.equal(progressPercent(Number.NaN), 0);
});

test("the percentage is cut, so a curve that is nearly full is not called full", () => {
  assert.equal(progressPercentLabel(0.0195), "1.9%");
  assert.equal(progressPercentLabel(0.5), "50%");
  assert.equal(progressPercentLabel(0.9996), "99.9%");
  assert.equal(progressPercentLabel(1), "100%");
  assert.equal(progressPercentLabel(0), "0%");
  assert.equal(progressPercentLabel(0.0004), "less than 0.1%");
});

test("the three states are said in the words of the rules", () => {
  assert.equal(curveStateSentence("trading"), "Trading on the curve");
  assert.equal(curveStateSentence("full"), "The curve is full: it can graduate");
  assert.equal(curveStateSentence("graduated"), "Graduated to a Meteora pool");
  // A state this page does not know is shown as it is.
  assert.equal(curveStateSentence("paused"), "paused");
});

test("the trade form is open only while the curve is trading", () => {
  assert.equal(tradingClosedSentence("trading"), null);
  assert.match(tradingClosedSentence("full") ?? "", /curve is full/);
  assert.match(tradingClosedSentence("graduated") ?? "", /graduated to a Meteora pool/);
  assert.notEqual(tradingClosedSentence("paused"), null);
});

test("the creator is the connected wallet only on an exact match", () => {
  const a = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  assert.equal(isSameAddress(a, a), true);
  assert.equal(isSameAddress(a, a.toLowerCase()), false);
  assert.equal(isSameAddress(a, null), false);
  assert.equal(isSameAddress("", ""), false);
  assert.equal(shortAddress(a), "7xKX...gAsU");
});

test("which launchpad a token is on", () => {
  assert.equal(launchpadLabel("meteora"), "Meteora");
  assert.equal(launchpadLabel("bags"), "Bags");
  assert.equal(launchpadLabel("pumpfun"), "pump.fun");
  assert.equal(launchpadLabel(undefined), "pump.fun");
  assert.equal(isMeteoraToken({ launchpad: "meteora" }), true);
  assert.equal(isMeteoraToken({ launchpad: "pumpfun" }), false);
  assert.equal(isMeteoraToken({}), false);
  assert.equal(isMeteoraToken(null), false);
});

test("a list says where a token on Meteora trades in place of a dollar price", () => {
  assert.equal(curveListLabel({ launchpad: "meteora", status: "BONDING" }), "On a Meteora curve");
  assert.equal(curveListLabel({ launchpad: "meteora" }), "On a Meteora curve");
  assert.equal(curveListLabel({ launchpad: "meteora", status: "GRADUATED" }), "Graduated to a Meteora pool");
  assert.equal(curveListLabel({ launchpad: "meteora", status: "FAILED" }), null);
  assert.equal(curveListLabel({ launchpad: "pumpfun", status: "BONDING" }), null);
  assert.equal(curveListLabel({ status: "GRADUATED" }), null);
  assert.equal(curveListLabel(null), null);
});

test("a curve call that answers 404 is a token with no curve, and anything else is asked again", () => {
  assert.equal(curveReadFailure(new ApiError(404, "Not Found", { error: "not_a_curve_token" })), "no_curve");
  assert.equal(curveReadFailure(new ApiError(404, "Not Found", null)), "no_curve");
  assert.equal(curveReadFailure(new ApiError(503, "Unavailable", { error: "curve_unreadable" })), "unreadable");
  assert.equal(curveReadFailure(new ApiError(500, "Server Error", null)), "unreadable");
  assert.equal(curveReadFailure(new TypeError("Failed to fetch")), "unreadable");
});

// ============================================
// Solana's explorer
// ============================================

test("explorer links carry the cluster on devnet and nothing on mainnet", () => {
  assert.equal(explorerAddressUrl("Abc", "devnet"), "https://explorer.solana.com/address/Abc?cluster=devnet");
  assert.equal(explorerAddressUrl("Abc", "mainnet-beta"), "https://explorer.solana.com/address/Abc");
  assert.equal(explorerTxUrl("Sig", "devnet"), "https://explorer.solana.com/tx/Sig?cluster=devnet");
  assert.equal(explorerTxUrl("Sig", "mainnet-beta"), "https://explorer.solana.com/tx/Sig");
});

// ============================================
// A preset in the wizard
// ============================================

test("a length of time is said in its largest whole unit", () => {
  assert.equal(durationWords(300), "5 minutes");
  assert.equal(durationWords(120), "2 minutes");
  assert.equal(durationWords(60), "1 minute");
  assert.equal(durationWords(3_600), "1 hour");
  assert.equal(durationWords(2_592_000), "30 days");
  assert.equal(durationWords(31_104_000), "360 days");
  assert.equal(durationWords(90), "90 seconds");
  assert.equal(durationWords(Number.NaN), NO_FIGURE);
});

test("a preset's card has four facts and every figure in them is the API's", () => {
  assert.deepEqual(presetFacts(COMMUNITY), [
    "The price starts with the whole supply valued at 20 SOL.",
    "It graduates when 64 SOL has been raised, with the supply valued at 320 SOL.",
    "The trading fee starts at 30% and falls to 1% over the first 5 minutes.",
    "You earn 70% of the trading fees. None of your tokens are locked.",
  ]);
  const committed = presetFacts(COMMITTED);
  assert.equal(committed.length, 4);
  assert.equal(committed[1], "It graduates when 77.395 SOL has been raised, with the supply valued at 400 SOL.");
  assert.equal(
    committed[3],
    "You earn 50% of the trading fees. 10% of the supply is locked for you: nothing for 30 days after graduation, then 10 equal parts over 300 days."
  );
});

test("how locked tokens are released, in the words of the rules", () => {
  assert.equal(
    lockScheduleWords({ cliffSeconds: 600, periods: 6, totalSeconds: 3_600 }),
    "nothing for 10 minutes after graduation, then 6 equal parts over 1 hour"
  );
  assert.equal(
    lockScheduleWords({ cliffSeconds: 2_592_000, periods: 1, totalSeconds: 2_592_000 }),
    "nothing for 30 days after graduation, then 1 equal part over 30 days"
  );
});

test("what a preset locks is said from its own figures", () => {
  assert.equal(presetLockSentence(COMMUNITY), "This curve locks none of your tokens.");
  assert.equal(
    presetLockSentence(COMMITTED),
    "100,000,000 tokens (10% of the supply) are locked for you. Nothing is released for 30 days after graduation, then they are released in 10 equal parts over 300 days."
  );
  // The rehearsal curve of round 2: 600 s of nothing, then 5 parts over 3,000 s.
  assert.equal(
    presetLockSentence({
      creatorLocked: { percentOfSupply: "10", cliffSeconds: 600, periods: 5, totalSeconds: 3_000 },
    }),
    "100,000,000 tokens (10% of the supply) are locked for you. Nothing is released for 10 minutes after graduation, then they are released in 5 equal parts over 50 minutes."
  );
  assert.match(
    presetLockSentence({
      creatorLocked: { percentOfSupply: "2.5", cliffSeconds: 600, periods: 1, totalSeconds: 600 },
    }),
    /^25,000,000 tokens \(2\.5% of the supply\) are locked for you\. .* in 1 equal part over 10 minutes\.$/
  );
  // A share that cannot be read as a number is said as it came, with no count made up.
  const odd = presetLockSentence({
    creatorLocked: { percentOfSupply: "about ten", cliffSeconds: 600, periods: 5, totalSeconds: 3_000 },
  });
  assert.match(odd, /^about ten% of the supply is locked for you\./);
  assert.doesNotMatch(odd, /NaN|undefined/);
});

test("the mark sits on the line where the curve reaches the price now", () => {
  // The same box as the drawing: start bottom left, end top right.
  assert.deepEqual(curveMarkPoint(COMMUNITY.points, "0.00000002", 120, 48), { x: 2, y: 46 });
  assert.deepEqual(curveMarkPoint(COMMUNITY.points, "0.00000032", 120, 48), { x: 118, y: 2 });
  // Half way up the first stretch (0.00000002 to 0.00000008) is half way along it.
  const mid = curveMarkPoint(COMMUNITY.points, "0.00000005", 120, 48)!;
  assert.ok(Math.abs(mid.x - 31) < 1e-6, String(mid.x));
  assert.ok(Math.abs(mid.y - 41.6) < 1e-6, String(mid.y));
  // On a point of the curve, the mark is that point of the path.
  const onPoint = curveMarkPoint(COMMUNITY.points, "0.00000008", 120, 48)!;
  assert.equal(`${onPoint.x.toFixed(2)} ${onPoint.y.toFixed(2)}`, "60.00 37.20");
});

test("a price off the ends of the curve is marked at the end, and no price is no mark", () => {
  assert.deepEqual(curveMarkPoint(COMMUNITY.points, "0", 120, 48), { x: 2, y: 46 });
  assert.deepEqual(curveMarkPoint(COMMUNITY.points, "1", 120, 48), { x: 118, y: 2 });
  for (const none of [null, undefined, "", "abc", "2.1e-8", "-1"]) {
    assert.equal(curveMarkPoint(COMMUNITY.points, none as string | null | undefined, 120, 48), null);
  }
  assert.equal(curveMarkPoint([], "0.00000005", 120, 48), null);
  assert.equal(curveMarkPoint([{ soldPercent: 0, priceSol: 1 }], "1", 120, 48), null);
  // A flat curve: the mark is on the line, never NaN.
  const flat = curveMarkPoint(
    [
      { soldPercent: 0, priceSol: 1 },
      { soldPercent: 100, priceSol: 1 },
    ],
    "1",
    100,
    40,
    0
  )!;
  assert.equal(Number.isFinite(flat.x) && Number.isFinite(flat.y), true);
  assert.equal(flat.y, 20);
});

test("a picture link is an http or https address and nothing else", () => {
  assert.deepEqual(readPictureLink(" https://example.com/a.png "), { ok: true, url: "https://example.com/a.png" });
  assert.deepEqual(readPictureLink("http://localhost:3100/icon.png"), { ok: true, url: "http://localhost:3100/icon.png" });
  assert.deepEqual(readPictureLink(""), { ok: false, reason: "empty" });
  assert.deepEqual(readPictureLink("   "), { ok: false, reason: "empty" });
  for (const bad of ["example.com/a.png", "ftp://example.com/a.png", "data:image/png;base64,AAAA", "https://exa mple.com/a.png", "javascript:void(0)", "file:///etc/hosts"]) {
    assert.deepEqual(readPictureLink(bad), { ok: false, reason: "not_a_link" }, bad);
  }
});

test("the drawing runs left to right and the price rises up the box", () => {
  const path = curveSvgPath(COMMUNITY.points, 120, 48);
  // Start: bottom left. End: top right. Padding of 2 on every side.
  assert.equal(path, "M2.00 46.00 L60.00 37.20 L118.00 2.00");
});

test("the drawing has nothing to draw from fewer than two usable points", () => {
  assert.equal(curveSvgPath([], 120, 48), "");
  assert.equal(curveSvgPath([{ soldPercent: 0, priceSol: 1 }], 120, 48), "");
  assert.equal(
    curveSvgPath(
      [
        { soldPercent: 0, priceSol: 1 },
        { soldPercent: Number.NaN, priceSol: 2 },
      ],
      120,
      48
    ),
    ""
  );
});

test("a flat curve is a line through the middle, not a division by zero", () => {
  const path = curveSvgPath(
    [
      { soldPercent: 0, priceSol: 1 },
      { soldPercent: 100, priceSol: 1 },
    ],
    100,
    40,
    0
  );
  assert.equal(path, "M0.00 20.00 L100.00 20.00");
  assert.doesNotMatch(path, /NaN|Infinity/);
});

// ============================================
// Graduation
// ============================================

test("each step of graduation is numbered from how many follow it", () => {
  assert.equal(graduationStepLabel(0, 1), "Step 1 of 2");
  assert.equal(graduationStepLabel(1, 0), "Step 2 of 2");
  assert.equal(graduationStepLabel(0, 0), "Step 1 of 1");
  // A count that did not arrive never reads "of NaN".
  assert.equal(graduationStepLabel(0, undefined as unknown as number), "Step 1 of 1");
  assert.equal(graduationStepLabel(1, Number.NaN), "Step 2 of 2");
});

test("each step of graduation says what it does", () => {
  assert.match(graduationStepSentence("locker"), /locked tokens/);
  assert.match(graduationStepSentence("migrate"), /Meteora pool/);
  assert.match(graduationStepSentence("migrate"), /locks that liquidity for good/);
  assert.notEqual(graduationStepSentence("other"), "");
});

// ============================================
// Errors
// ============================================

const refusal = (status: number, error: string) => new ApiError(status, "Refused", { error });

test("every refusal the rules name is a sentence", () => {
  const codes = [
    "invalid_amount",
    "curve_full",
    "curve_unreadable",
    "not_a_curve_token",
    "not_the_creator",
    "nothing_to_claim",
    "curve_not_full",
    "already_graduated",
  ];
  for (const code of codes) {
    const sentence = curveErrorSentence(refusal(409, code), "fallback");
    assert.notEqual(sentence, "fallback", code);
    assert.notEqual(sentence, code, code);
    assert.match(sentence, /\.$/, code);
  }
  assert.match(curveErrorSentence(refusal(409, "curve_full"), "x"), /curve is full/);
  assert.match(curveErrorSentence(refusal(403, "not_the_creator"), "x"), /wallet that launched/);
});

test("an expired or refused prepare token asks the person to ask again", () => {
  assert.equal(curveErrorSentence(refusal(400, "prepare_token_expired"), "x"), QUOTE_EXPIRED_SENTENCE);
  assert.equal(curveErrorSentence(refusal(400, "prepare_token_invalid"), "x"), QUOTE_EXPIRED_SENTENCE);
  assert.equal(curveErrorSentence(refusal(400, "expired"), "x"), QUOTE_EXPIRED_SENTENCE);
});

test("a wallet that said no, a wallet without SOL and a missing login are sentences too", () => {
  assert.equal(
    curveErrorSentence(new Error("User rejected the request."), "x"),
    "You cancelled the request in your wallet."
  );
  assert.equal(
    curveErrorSentence(new Error("Transfer: insufficient lamports 5, need 10"), "x"),
    NOT_ENOUGH_SOL_SENTENCE
  );
  assert.equal(curveErrorSentence(refusal(400, "insufficient_sol"), "x"), NOT_ENOUGH_SOL_SENTENCE);
  assert.equal(curveErrorSentence(refusal(401, "unauthenticated"), "x"), "Sign in to do this.");
});

test("a claim or a graduation that expired does not speak of a quote", () => {
  assert.equal(
    curveErrorSentence(refusal(400, "prepare_token_invalid"), "x", REQUEST_EXPIRED_SENTENCE),
    REQUEST_EXPIRED_SENTENCE
  );
  assert.doesNotMatch(REQUEST_EXPIRED_SENTENCE, /quote/i);
});

test("a code is never shown to a person: the routes' other refusals are sentences, an unknown one is the fallback", () => {
  for (const code of [
    "token_not_found",
    "invalid_wallet",
    "transaction_mismatch",
    "transaction_not_confirmed",
    "prepare_unavailable",
    "build_failed",
    "send_failed",
  ]) {
    const sentence = curveErrorSentence(refusal(502, code), "fallback");
    assert.notEqual(sentence, code, code);
    assert.notEqual(sentence, "fallback", code);
    assert.doesNotMatch(sentence, /_/, code);
  }
  assert.equal(curveErrorSentence(refusal(400, "some_new_code"), "The trade did not go through."), "The trade did not go through.");
  // Solana's log lines stay out of the page, but an empty wallet is still named.
  assert.equal(
    curveErrorSentence(
      new ApiError(502, "Bad Gateway", { error: "send_failed", message: "Simulation failed. custom program error: 0x1774" }),
      "x"
    ),
    "Solana refused the transaction, so nothing was sent. Try again."
  );
  assert.equal(
    curveErrorSentence(
      new ApiError(502, "Bad Gateway", { error: "send_failed", message: "Transfer: insufficient lamports 5, need 10" }),
      "x"
    ),
    NOT_ENOUGH_SOL_SENTENCE
  );
});

test("each wallet's own words for a refusal read the same", () => {
  for (const said of ["User rejected the request.", "Approval Denied", "Transaction cancelled", "User declined"]) {
    assert.equal(curveErrorSentence(new Error(said), "x"), "You cancelled the request in your wallet.", said);
  }
});

test("a transaction that was sent but not seen confirmed keeps its signature for the page", () => {
  const err = new ApiError(502, "Bad Gateway", { error: "transaction_not_confirmed", signature: "Sig111" });
  assert.equal(sentSignatureFromError(err), "Sig111");
  assert.match(curveErrorSentence(err, "x"), /was sent/);
  assert.equal(sentSignatureFromError(refusal(409, "curve_full")), null);
  assert.equal(sentSignatureFromError(new Error("no")), null);
});

test("the server's own text and a wallet's own text are never what a person reads", () => {
  assert.equal(
    curveErrorSentence(new ApiError(500, "Server Error", { error: "odd_thing", message: "The network refused it." }), "The trade did not go through."),
    "The trade did not go through."
  );
  assert.equal(curveErrorSentence(new Error("WalletSignTransactionError: internal JSON-RPC error"), "The trade did not go through."), "The trade did not go through.");
  assert.equal(curveErrorSentence(new TypeError("Failed to fetch"), "The trade did not go through."), "The trade did not go through.");
  assert.equal(curveErrorSentence(new ApiError(500, "Server Error", null), "The trade did not go through."), "The trade did not go through.");
  assert.equal(curveErrorSentence("odd", "The trade did not go through."), "The trade did not go through.");
});

test("signing that took too long is told apart: an expired token, or a blockhash the chain no longer takes", () => {
  assert.equal(tookTooLongToSign(refusal(400, "prepare_token_invalid")), true);
  assert.equal(tookTooLongToSign(refusal(400, "prepare_token_expired")), true);
  assert.equal(tookTooLongToSign(new ApiError(502, "Bad Gateway", { error: "send_failed", message: "Blockhash not found" })), true);
  assert.equal(
    tookTooLongToSign(new ApiError(502, "Bad Gateway", { error: "launch_submit_failed", message: "TransactionExpiredBlockheightExceededError: block height exceeded" })),
    true
  );
  assert.equal(tookTooLongToSign(refusal(409, "curve_full")), false);
  assert.equal(tookTooLongToSign(refusal(403, "prepare_token_not_yours")), false);
  assert.equal(tookTooLongToSign(new Error("User rejected the request.")), false);
  // A transaction with a signature to follow was sent: it did not expire unsent.
  assert.equal(
    tookTooLongToSign(new ApiError(502, "Bad Gateway", { error: "transaction_not_confirmed", signature: "Sig111", message: "block height exceeded" })),
    false
  );
  // The sentence for each kind of action, and none says a server's words.
  const old = new ApiError(502, "Bad Gateway", { error: "send_failed", message: "Blockhash not found" });
  assert.equal(curveErrorSentence(old, "x"), QUOTE_EXPIRED_SENTENCE);
  assert.equal(curveErrorSentence(old, "x", REQUEST_EXPIRED_SENTENCE), REQUEST_EXPIRED_SENTENCE);
  assert.equal(launchErrorSentence(refusal(400, "prepare_token_invalid"), "x"), LAUNCH_EXPIRED_SENTENCE);
  for (const sentence of [QUOTE_EXPIRED_SENTENCE, REQUEST_EXPIRED_SENTENCE, LAUNCH_EXPIRED_SENTENCE]) {
    assert.match(sentence, /took too long/);
    assert.match(sentence, /[Pp]repare .*again/);
  }
});

test("a transaction that was sent is not confirmed yet or was refused by the chain, and keeps its signature", () => {
  const notConfirmed = new ApiError(502, "Bad Gateway", { error: "transaction_not_confirmed", signature: "Sig111" });
  const failed = new ApiError(409, "Conflict", { error: "transaction_failed", signature: "Sig222", message: "custom program error: 0x1774" });
  assert.deepEqual(sentTransactionFromError(notConfirmed), { kind: "not_confirmed", signature: "Sig111" });
  assert.deepEqual(sentTransactionFromError(failed), { kind: "failed", signature: "Sig222" });
  // The launch's not-confirmed answer: whatever its code, a signature means it was sent.
  assert.deepEqual(
    sentTransactionFromError(new ApiError(502, "Bad Gateway", { error: "launch_not_confirmed", signature: "Sig333" })),
    { kind: "not_confirmed", signature: "Sig333" }
  );
  // No signature (an older API, or nothing sent): nothing to follow.
  assert.equal(sentTransactionFromError(refusal(502, "transaction_not_confirmed")), null);
  assert.equal(sentTransactionFromError(refusal(409, "curve_full")), null);
  assert.equal(sentTransactionFromError(new Error("no")), null);

  assert.equal(sentTransactionSentence({ kind: "not_confirmed", signature: "Sig111" }), SENT_NOT_CONFIRMED_SENTENCE);
  assert.equal(sentTransactionSentence({ kind: "failed", signature: "Sig222" }), SENT_FAILED_SENTENCE);
  // A graduation that moved the pool and was not written down went through:
  // it is never said to be unconfirmed, and the same body can be posted again.
  const notSaved = new ApiError(500, "Internal Server Error", {
    error: "persistence_failed",
    signature: "Sig444",
    step: "migrate",
    message: "connection reset",
  });
  assert.deepEqual(sentTransactionFromError(notSaved), { kind: "not_saved", signature: "Sig444" });
  assert.equal(sentTransactionSentence({ kind: "not_saved", signature: "Sig444" }), SENT_NOT_SAVED_SENTENCE);
  assert.match(SENT_NOT_SAVED_SENTENCE, /went through/);
  assert.doesNotMatch(SENT_NOT_SAVED_SENTENCE, /not confirmed/);
  assert.equal(canCheckAgain({ kind: "not_saved", signature: "Sig444" }), true);
  assert.equal(canCheckAgain({ kind: "not_confirmed", signature: "Sig111" }), true);
  assert.equal(canCheckAgain({ kind: "failed", signature: "Sig222" }), false);
  assert.equal(canCheckAgain(null), false);
  assert.match(SENT_NOT_CONFIRMED_SENTENCE, /was sent .* not confirmed/);
  assert.match(SENT_FAILED_SENTENCE, /refused/);
  assert.match(SENT_FAILED_SENTENCE, /Nothing was taken but the network fee/);
  // The chain's log line is not what a person reads.
  assert.equal(curveErrorSentence(failed, "x"), SENT_FAILED_SENTENCE);
  assert.equal(launchErrorSentence(failed, "x"), SENT_FAILED_SENTENCE);
});

// ============================================
// Errors of the launch
// ============================================

test("every code the launch answers with is a sentence of its own", () => {
  const codes = [
    // Round 2's refusals a creator can fix, and the failed upload.
    "invalid_preset",
    "first_buy_not_supported",
    "picture_required",
    "name_too_long",
    "symbol_too_long",
    "metadata_link_too_long",
    "picture_link_refused",
    "picture_upload_failed",
    // What the launch routes answered before round 2.
    "wallet_required",
    "invalid_payload",
    "agent_not_found",
    "not_eligible",
    "listing_required",
    "launch_prepare_failed",
    "launch_submit_failed",
    "prepare_token_org_mismatch",
    "prepare_token_creator_mismatch",
    "prepare_token_launchpad_mismatch",
    "mint_mismatch",
    "mint_not_on_chain",
    "mint_check_failed",
    "reconcile_failed",
    "unauthenticated",
  ];
  const seen = new Set<string>();
  for (const code of codes) {
    const sentence = launchErrorSentence(
      new ApiError(400, "Bad Request", { error: code, message: "raw text from the server" }),
      "fallback"
    );
    assert.notEqual(sentence, "fallback", code);
    assert.doesNotMatch(sentence, /raw text|_/, code);
    assert.match(sentence, /\.$/, code);
    seen.add(sentence);
  }
  assert.equal(seen.size, codes.length);
  assert.match(launchErrorSentence(refusal(400, "name_too_long"), "x"), /32 bytes/);
  assert.match(launchErrorSentence(refusal(400, "symbol_too_long"), "x"), /10 bytes/);
  // It is the link that is too long, not the name.
  assert.match(launchErrorSentence(refusal(400, "metadata_link_too_long"), "x"), /the link that is too long, not the name/);
  assert.equal(launchErrorSentence(refusal(400, "some_new_code"), "The token could not be created."), "The token could not be created.");
  assert.equal(launchErrorSentence(new Error("User rejected the request."), "x"), "You cancelled the request in your wallet.");
});

test("a launch refused for want of a linked wallet says where to link one", () => {
  const err = refusal(400, "wallet_required");
  assert.equal(isNoLinkedWalletRefusal(err), true);
  assert.equal(isNoLinkedWalletRefusal(refusal(400, "not_eligible")), false);
  assert.equal(isNoLinkedWalletRefusal(new Error("no")), false);
  assert.equal(launchErrorSentence(err, "x"), NO_LINKED_WALLET_SENTENCE);
  assert.match(NO_LINKED_WALLET_SENTENCE, /Settings/);
});

test("a launch prepared for another wallet is not signed, and the linked address is named", () => {
  const linked = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const other = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  assert.equal(preparedForAnotherWallet({ creatorAddress: linked }, linked), null);
  assert.equal(preparedForAnotherWallet({ creatorAddress: linked }, other), linked);
  assert.equal(preparedForAnotherWallet({ creatorAddress: linked }, null), linked);
  // An API older than `creatorAddress` still says who the transaction is for.
  assert.equal(preparedForAnotherWallet({ creatorPubkey: linked }, other), linked);
  assert.equal(preparedForAnotherWallet({ creatorPubkey: linked }, linked), null);
  // Neither member: nothing to compare, so the wizard does not stop on a guess.
  assert.equal(preparedForAnotherWallet({}, other), null);
  const sentence = linkedWalletMismatchSentence(linked, other);
  // Both addresses are named whole, so a person can tell which wallet to switch to.
  assert.ok(sentence.includes(linked));
  assert.ok(sentence.includes(other));
  // With no connected address to name, the sentence still stands.
  assert.doesNotMatch(linkedWalletMismatchSentence(linked), /undefined|null/);
  assert.match(sentence, /Nothing was signed/);
  assert.match(sentence, /Switch your wallet .* or change the account's wallet under Settings/);
});

test("checking a sent launch again never says nothing was sent", () => {
  assert.match(launchCheckSentence(refusal(409, "mint_not_on_chain")), /not on Solana yet/);
  assert.match(launchCheckSentence(new ApiError(502, "Bad Gateway", { error: "mint_check_failed", message: "429" })), /could not be asked/);
  assert.equal(launchCheckSentence(refusal(400, "prepare_token_invalid")), STILL_NOT_CONFIRMED_SENTENCE);
  assert.equal(launchCheckSentence(new TypeError("Failed to fetch")), STILL_NOT_CONFIRMED_SENTENCE);
  assert.equal(launchCheckSentence(refusal(400, "prepare_token_invalid"), "The retry failed."), "The retry failed.");
  assert.doesNotMatch(STILL_NOT_CONFIRMED_SENTENCE, /nothing was sent/i);
});

// ============================================
// Members an older API does not send
// ============================================

test("a curve and a quote without round 2's members read without undefined or NaN", () => {
  // The curve of the rules' example, as round 1 answered it.
  const older = {
    raisedSol: "1.25",
    graduationSol: "64",
    priceSol: "0.000000021",
  } as Pick<TokenCurve, "raisedSol" | "graduationSol" | "priceSol" | "tradingFeesSol" | "curvePoints" | "creatorAddress">;
  assert.equal(formatDecimal(older.tradingFeesSol), NO_FIGURE);
  assert.equal(curveSvgPath(older.curvePoints ?? [], 700, 260, 12), "");
  assert.equal(curveMarkPoint(older.curvePoints ?? [], older.priceSol, 700, 260, 12), null);
  assert.equal(isSameAddress("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", older.creatorAddress), false);
  const said = [
    formatDecimal(older.tradingFeesSol),
    progressLabel(older),
    String(partialFillLine({ side: "buy", amountInRaw: "100000000" })),
  ].join(" ");
  assert.doesNotMatch(said, /undefined|NaN/);
});

// ============================================
// Transactions as text
// ============================================

test("a transaction survives base64 and back byte for byte", () => {
  const bytes = Uint8Array.from({ length: 1232 }, (_, i) => (i * 37) % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  assert.equal(bytesToBase64(Uint8Array.from([1, 2, 3])), "AQID");
});

// ============================================
// What a person reads
// ============================================

test("graduation is explained in the rules' words, once on each page it appears on", () => {
  assert.equal(
    GRADUATION_EXPLANATION,
    "Graduation: when enough SOL has been raised, the token moves to a Meteora pool where its liquidity is locked for good."
  );
  const wizard = source("app/(dashboard)/dashboard/marketplace/tokens/create/page.tsx");
  const card = source("components/dashboard/token-curve-card.tsx");
  assert.equal(wizard.split("{GRADUATION_EXPLANATION}").length - 1, 1);
  assert.equal(card.split("{GRADUATION_EXPLANATION}").length - 1, 1);
});

test("the new screens use no em dash and no exclamation mark in what they say", () => {
  const files = [
    "lib/token-curve.ts",
    "components/dashboard/token-curve-card.tsx",
    "components/dashboard/token-curve-trade-panel.tsx",
    "components/dashboard/curve-preset-card.tsx",
    "components/dashboard/token-curve-sign.ts",
    "components/dashboard/token-curve-chart.tsx",
    "components/dashboard/token-sent-notice.tsx",
  ];
  for (const file of files) {
    const text = source(file);
    assert.equal(text.includes(String.fromCharCode(0x2014)), false, `${file} has an em dash`);
    // "!" as a mark at the end of a sentence in a string or in JSX text.
    assert.doesNotMatch(text, /[A-Za-z]!["'`<\s]/, `${file} has an exclamation mark`);
  }
});

test("the wizard takes the launchpad from the API and keeps the build setting as the fallback only", () => {
  const wizard = source("app/(dashboard)/dashboard/marketplace/tokens/create/page.tsx");
  assert.match(wizard, /tokenApi\s*\.launchpadInfo\(\)/);
  assert.equal(wizard.split("NEXT_PUBLIC_LAUNCHPAD").length - 1, 1);
  assert.match(wizard, /FALLBACK_LAUNCHPAD_LABEL = launchpadLabel\(process\.env\.NEXT_PUBLIC_LAUNCHPAD\)/);
  // The chosen curve travels to prepare.
  assert.match(wizard, /preset: selectedPreset\?\.id/);
});

test("what graduation sent stays on the page after the curve reads graduated", () => {
  const card = source("components/dashboard/token-curve-card.tsx");
  // The section is kept once a walk has begun, and only the move into the pool counts as graduation.
  assert.match(card, /curve\.state === "full" \|\| walkBegun/);
  assert.doesNotMatch(card, /stepsLeftAfterThis <= 0/);
});

test("a token on Meteora is not shown pump.fun's supply split or a lockup nothing enforces", () => {
  const page = source("app/(dashboard)/dashboard/marketplace/tokens/[id]/page.tsx");
  const guarded = page.slice(page.indexOf("{!onCurve && (\n                  <>"));
  assert.match(guarded.slice(0, 1200), /Curve Supply[\s\S]*Reserved[\s\S]*Creator Lockup/);
});

// ============================================
// Round 2: what the screens do
// ============================================

test("the wizard prepares nothing until the launchpad has answered", () => {
  const wizard = source("app/(dashboard)/dashboard/marketplace/tokens/create/page.tsx");
  // Next is closed, and the launch itself stops, while the launchpad is not known.
  assert.match(wizard, /const canProceed = \(\): boolean => {\n    if \(!launchpad\) return false;/);
  assert.match(wizard, /if \(!launchpad\) return;\n\n    \/\/ Browser-partial-sign flow/);
  assert.match(wizard, /Reading the launchpad&apos;s details\./);
});

test("the wizard compares the wallet before it asks for a signature", () => {
  const wizard = source("app/(dashboard)/dashboard/marketplace/tokens/create/page.tsx");
  const compare = wizard.indexOf("preparedForAnotherWallet(prepared, connectedAddress)");
  const sign = wizard.indexOf("await signPreparedTransaction(");
  assert.ok(compare > 0 && sign > compare);
  // The picture link travels as the image when the listing has no icon.
  // An icon saved as an empty string is a missing icon too: `||`, never `??`.
  assert.match(wizard, /imageUri: selectedListing\.iconUrl \|\| \(picture\.ok \? picture\.url : undefined\)/);
  // The sentence names the connected wallet beside the linked one.
  assert.match(wizard, /linkedWalletMismatchSentence\(linkedElsewhere, connectedAddress\)/);
  // The 30-day sentence stays for the other launchpads only.
  assert.match(wizard, /\{isMeteora \? \([\s\S]*presetLockSentence\(selectedPreset\)[\s\S]*\) : \([\s\S]*creatorLockupDays\}-day creator lockup period/);
});

test("the token page stops asking for a curve that is not there", () => {
  const page = source("app/(dashboard)/dashboard/marketplace/tokens/[id]/page.tsx");
  assert.match(page, /enabled: onCurve && !curveMissing/);
  assert.match(page, /curveReadFailure\(err\) === "no_curve"/);
  // With no price history, a token on Meteora is drawn from its curve.
  assert.match(page, /onCurve && chartData\.length < 2 \? \(\s*<TokenCurveChart points=\{liveCurve\?\.curvePoints\}/);
});

test("no link on these screens goes to an explorer without the network", () => {
  for (const file of [
    "app/(dashboard)/dashboard/marketplace/tokens/create/page.tsx",
    "components/dashboard/token-curve-card.tsx",
    "components/dashboard/token-curve-trade-panel.tsx",
    "components/dashboard/token-curve-chart.tsx",
    "components/dashboard/token-sent-notice.tsx",
  ]) {
    const text = source(file);
    assert.doesNotMatch(text, /solscan\.io|explorer\.solana\.com/, file);
  }
});

// The wizard tells a creator whose connected wallet is not the linked one to
// change the account's wallet under Settings: that advice needs a control.
test("Settings lets a different connected wallet replace the linked one", () => {
  const settings = source("app/(dashboard)/dashboard/settings/page.tsx");
  assert.match(settings, /connectedAddress !== profile\.walletAddress/);
  assert.match(settings, /Link this wallet instead/);
  assert.match(settings, /replaces the wallet above for this account/);
});
