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

import { ApiError, type CurvePreset } from "./api";
import {
  GRADUATION_EXPLANATION,
  NO_FIGURE,
  NOT_ENOUGH_SOL_SENTENCE,
  QUOTE_EXPIRED_SENTENCE,
  REQUEST_EXPIRED_SENTENCE,
  SOL_DECIMALS,
  TOKEN_DECIMALS,
  base64ToBytes,
  bytesToBase64,
  curveErrorSentence,
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
  isSameAddress,
  launchpadLabel,
  lockScheduleWords,
  parseTypedAmount,
  presetFacts,
  progressLabel,
  progressPercent,
  progressPercentLabel,
  rawExceeds,
  sentSignatureFromError,
  shareOfRaw,
  shortAddress,
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
  creatorLocked: { percentOfSupply: "10", cliffSeconds: 2_592_000, periods: 12, totalSeconds: 31_104_000 },
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
  for (const bad of ["abc", "-1", "+1", "1e3", "1,5", "1.2.3", ".", "0x10", "1 000"]) {
    assert.deepEqual(parseTypedAmount(bad, SOL_DECIMALS), { ok: false, reason: "not_a_number" }, bad);
  }
  assert.deepEqual(parseTypedAmount("0", SOL_DECIMALS), { ok: false, reason: "zero" });
  assert.deepEqual(parseTypedAmount("0.000", SOL_DECIMALS), { ok: false, reason: "zero" });
  assert.deepEqual(parseTypedAmount("0.0000001", TOKEN_DECIMALS), { ok: false, reason: "too_many_decimals" });
  // Zeros at the end are not extra decimals.
  assert.equal(parseTypedAmount("0.1000000000", SOL_DECIMALS).ok, true);
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
    "You earn 50% of the trading fees. 10% of the supply is locked for you: nothing for 30 days after graduation, then 12 equal parts over 360 days."
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

test("anything else goes through the usual reader, down to the fallback", () => {
  assert.equal(
    curveErrorSentence(new ApiError(500, "Server Error", { error: "odd_thing", message: "The network refused it." }), "x"),
    "The network refused it."
  );
  assert.equal(curveErrorSentence(new ApiError(500, "Server Error", null), "The trade did not go through."), "The trade did not go through.");
  assert.equal(curveErrorSentence("odd", "The trade did not go through."), "The trade did not go through.");
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
