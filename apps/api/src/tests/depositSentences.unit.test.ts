/**
 * Drives apps/api/src/services/depositSentences.ts: every sentence a
 * customer reads about their deposit address, word for word, the choice of
 * sentence for a check and for a stored receipt, and how an amount is
 * written.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  checkSentence,
  creditedDepositSentence,
  depositAddressMessage,
  depositListStatus,
  depositRowSentence,
  depositSentence,
  formatDepositAmount,
  waitingSentence,
  type DepositSentenceCode,
} from "../services/depositSentences.js";

const NOT_ISSUED = "Your organization has no deposit address yet.";
const PAUSED =
  "Deposits are paused for a moment. Nothing sent to your address is lost. Try again shortly.";

// The wording of the contract: [with SOL offered, without].
const WORDING: Record<DepositSentenceCode, [string, string]> = {
  address_shown: [
    "Send USDC or SOL on Solana to this address. It belongs to your organization only.",
    "Send USDC on Solana to this address. It belongs to your organization only.",
  ],
  how_credited: [
    "USDC is credited one dollar for one USDC. SOL is credited at its dollar value when we see your transfer, usually within a few minutes.",
    "USDC is credited one dollar for one USDC, usually within a few minutes.",
  ],
  not_issued: [NOT_ISSUED, NOT_ISSUED],
  deposit_address_not_issued: [NOT_ISSUED, NOT_ISSUED],
  check_nothing_new: [
    "No new transfer yet. Transfers usually arrive within a few minutes.",
    "No new transfer yet. Transfers usually arrive within a few minutes.",
  ],
  ignored: [
    "This transfer was too small to credit.",
    "This transfer was too small to credit.",
  ],
  prepared: [
    "Your address can now receive USDC.",
    "Your address can now receive USDC.",
  ],
  unauthenticated: ["Sign in to add credits.", "Sign in to add credits."],
  not_eligible: [
    "Verify your email or make one purchase first, then prepare the address.",
    "Verify your email or make one purchase first, then prepare the address.",
  ],
  daily_limit: [
    "The address cannot be prepared right now. Send SOL, or try again later.",
    "The address cannot be prepared right now. Try again later.",
  ],
  unavailable: [
    "The address cannot be prepared right now. Send SOL, or try again later.",
    "The address cannot be prepared right now. Try again later.",
  ],
  deposit_address_unavailable: [PAUSED, PAUSED],
  chain_unavailable: [PAUSED, PAUSED],
  deposits_not_enabled: [PAUSED, PAUSED],
  unexpected: [PAUSED, PAUSED],
};

test("every sentence, word for word, with SOL offered and without", () => {
  for (const [code, [withSol, withoutSol]] of Object.entries(WORDING) as Array<
    [DepositSentenceCode, [string, string]]
  >) {
    assert.equal(depositSentence(code), withSol, `${code}, default`);
    assert.equal(depositSentence(code, { solOffered: true }), withSol, code);
    assert.equal(depositSentence(code, { solOffered: false }), withoutSol, code);
  }
});

test("no sentence has an em dash, and each ends with a full stop", () => {
  const all = [
    ...Object.values(WORDING).flat(),
    checkSentence({ credited: [{ creditedCents: 5_000n, bonusCents: 500n }], waiting: [] }),
    waitingSentence({ asset: "SOL", amountRaw: 500_000_000n }),
    creditedDepositSentence({ creditedCents: 5_000n, bonusCents: 500n }),
  ];
  for (const sentence of all) {
    assert.ok(!/[–—]/.test(sentence), sentence);
    assert.ok(sentence.endsWith("."), sentence);
  }
});

test("the address message: shown and how it is credited, joined by one space; or not issued yet", () => {
  assert.equal(
    depositAddressMessage({ hasAddress: true, solOffered: true }),
    "Send USDC or SOL on Solana to this address. It belongs to your organization only. USDC is credited one dollar for one USDC. SOL is credited at its dollar value when we see your transfer, usually within a few minutes.",
  );
  assert.equal(
    depositAddressMessage({ hasAddress: true, solOffered: false }),
    "Send USDC on Solana to this address. It belongs to your organization only. USDC is credited one dollar for one USDC, usually within a few minutes.",
  );
  assert.equal(depositAddressMessage({ hasAddress: false, solOffered: true }), NOT_ISSUED);
  assert.equal(depositAddressMessage({ hasAddress: false, solOffered: false }), NOT_ISSUED);
});

test("the check: one credited, with a bonus, several, waiting, nothing new", () => {
  assert.equal(
    checkSentence({ credited: [{ creditedCents: 5_000n, bonusCents: 0n }], waiting: [] }),
    "Credited $50.00 from your transfer.",
  );
  assert.equal(
    checkSentence({ credited: [{ creditedCents: 5_000n, bonusCents: 500n }], waiting: [] }),
    "Credited $55.00 from your transfer: $50.00 sent and a $5.00 bonus.",
  );
  assert.equal(
    checkSentence({
      credited: [
        { creditedCents: 5_000n, bonusCents: 500n },
        { creditedCents: 740n, bonusCents: 0n },
      ],
      waiting: [],
    }),
    "Credited $62.40 from 2 transfers.",
  );
  assert.equal(
    checkSentence({
      credited: [],
      waiting: [{ asset: "SOL", amountRaw: 500_000_000n }],
    }),
    "We have seen your transfer of 0.5 SOL. It is credited as soon as we can get a current SOL price.",
  );
  assert.equal(
    checkSentence({ credited: [], waiting: [] }),
    "No new transfer yet. Transfers usually arrive within a few minutes.",
  );
});

test("the check says what was credited even while another transfer waits", () => {
  assert.equal(
    checkSentence({
      credited: [{ creditedCents: 1_000n, bonusCents: 0n }],
      waiting: [{ asset: "SOL", amountRaw: 1n }],
    }),
    "Credited $10.00 from your transfer.",
  );
});

test("a stored deposit: credited, with a bonus, waiting, ignored", () => {
  const base = { asset: "USDC" as const, amountRaw: 50_000_000n, bonusCents: 0n };
  assert.equal(
    depositRowSentence({ ...base, status: "credited", amountUsdCents: 5_000n }),
    "Credited $50.00.",
  );
  assert.equal(
    depositRowSentence({ ...base, status: "credited", amountUsdCents: 5_000n, bonusCents: 500n }),
    "Credited $55.00: $50.00 sent and a $5.00 bonus.",
  );
  assert.equal(
    depositRowSentence({
      status: "detected",
      asset: "SOL",
      amountRaw: 500_000_000n,
      amountUsdCents: null,
      bonusCents: 0n,
    }),
    "We have seen your transfer of 0.5 SOL. It is credited as soon as we can get a current SOL price.",
  );
  assert.equal(
    depositRowSentence({ ...base, status: "ignored", amountUsdCents: null }),
    "This transfer was too small to credit.",
  );
});

test("a receipt's status as the list shows it", () => {
  assert.equal(depositListStatus("credited"), "credited");
  assert.equal(depositListStatus("detected"), "waiting");
  assert.equal(depositListStatus("ignored"), "ignored");
  // A status nobody wrote is never shown as credited.
  assert.equal(depositListStatus("something_else"), "ignored");
});

test("amounts: USDC with two decimals, or up to six when it is not whole cents", () => {
  assert.equal(formatDepositAmount(50_000_000n, "USDC"), "50.00");
  assert.equal(formatDepositAmount(50_500_000n, "USDC"), "50.50");
  assert.equal(formatDepositAmount(12_340_000n, "USDC"), "12.34");
  assert.equal(formatDepositAmount(1_005_000n, "USDC"), "1.005");
  assert.equal(formatDepositAmount(123_456n, "USDC"), "0.123456");
  assert.equal(formatDepositAmount(1n, "USDC"), "0.000001");
  assert.equal(formatDepositAmount(0n, "USDC"), "0.00");
  assert.equal(formatDepositAmount(12_345_678_900_000n, "USDC"), "12345678.90");
});

test("amounts: SOL with trailing zeros dropped", () => {
  assert.equal(formatDepositAmount(500_000_000n, "SOL"), "0.5");
  assert.equal(formatDepositAmount(1_000_000_000n, "SOL"), "1");
  assert.equal(formatDepositAmount(1_000n, "SOL"), "0.000001");
  assert.equal(formatDepositAmount(1n, "SOL"), "0.000000001");
  assert.equal(formatDepositAmount(12_250_000_000n, "SOL"), "12.25");
  assert.equal(formatDepositAmount(0n, "SOL"), "0");
});

test("an amount below zero is written as nothing, never as a negative", () => {
  assert.equal(formatDepositAmount(-5n, "USDC"), "0.00");
  assert.equal(formatDepositAmount(-5n, "SOL"), "0");
});
