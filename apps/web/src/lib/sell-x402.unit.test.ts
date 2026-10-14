/**
 * Paying from a wallet, for a creator: the switch's words, when it is drawn,
 * the price its lines name, what a save sends for it, and the line of a
 * listing on sale. Run with:
 *   cd apps/web && npx tsx --test src/lib/sell-x402.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_SELL_LIMITS, emptySellForm, type SellChoiceId, type SellForm, type SellWhat } from "./sell-choice";
import {
  WALLET_ANSWER_WITHIN_SECONDS,
  WALLET_PAYMENT_WORDS,
  walletPaymentLines,
  walletPaymentPriceCents,
  walletPaymentsOnLine,
  walletPaymentsShown,
  x402SaveOf,
} from "./sell-x402";

const here = dirname(fileURLToPath(import.meta.url));
const apiSource = (path: string) => readFileSync(join(here, "..", "..", "..", "api", "src", path), "utf8");

const perUse = (price: string): SellForm => ({ ...emptySellForm(), choice: "per_use", perUsePrice: price });

/** Every sentence the words can make, with a price and the seconds filled in. */
function allSentences(): string[] {
  return [
    WALLET_PAYMENT_WORDS.label,
    WALLET_PAYMENT_WORDS.price("$0.05"),
    WALLET_PAYMENT_WORDS.order,
    WALLET_PAYMENT_WORDS.noAnswer,
    WALLET_PAYMENT_WORDS.earn,
    WALLET_PAYMENT_WORDS.deadline(WALLET_ANSWER_WITHIN_SECONDS),
    WALLET_PAYMENT_WORDS.on,
    ...walletPaymentLines(5),
    ...walletPaymentLines(null),
  ];
}

// ============================================
// The words
// ============================================

test("the words are the lead's, with the price and the seconds filled in", () => {
  assert.equal(WALLET_PAYMENT_WORDS.label, "Let people with no account pay from a Solana wallet");
  assert.deepEqual(walletPaymentLines(5), [
    "Each use costs $0.05 in USDC, paid from their own wallet with an x402 client: no account and no key. " +
      "The request is answered first; the payment is sent only then, and the answer is released when Solana confirms it. " +
      "When there is no answer, nothing is sent and nothing is charged. You earn 90% of each use, as with any sale.",
    "An answer paid this way must be ready within 30 seconds, or it is stopped and nothing is charged.",
  ]);
  assert.equal(WALLET_PAYMENT_WORDS.on, "Paying from a wallet is on.");
  // The price is the app's own money format.
  assert.match(walletPaymentLines(1250)[0], /^Each use costs \$12\.50 in USDC,/);
  // The seconds are an argument, so the number comes from one place.
  assert.match(walletPaymentLines(5, 45)[1], /within 45 seconds/);
});

test("while no price can be read, the sentence that names one is left out and the rest stays", () => {
  const [about, deadline] = walletPaymentLines(null);
  assert.equal(about.includes("Each use costs"), false);
  assert.ok(about.startsWith(WALLET_PAYMENT_WORDS.order));
  assert.ok(about.endsWith(WALLET_PAYMENT_WORDS.earn));
  assert.equal(deadline, WALLET_PAYMENT_WORDS.deadline(30));
});

test("the 30 seconds are the API's own deadline for an answer paid from a wallet", () => {
  const rules = apiSource("services/x402DoorRules.ts");
  const [, written] = rules.match(/export const X402_ANSWER_DEADLINE_MS = ([\d_]+);/) ?? [];
  assert.ok(written, "the API names its deadline");
  assert.equal(Number(written.split("_").join("")), WALLET_ANSWER_WITHIN_SECONDS * 1000);
});

test("the creator's share is the one rule the API pays by", () => {
  // 100 minus the platform's 10 percent, never typed as a second number.
  assert.match(WALLET_PAYMENT_WORDS.earn, /^You earn 90% of each use/);
  const source = readFileSync(join(here, "sell-x402.ts"), "utf8");
  assert.equal(source.includes("90%"), false);
});

test("the sentences are plain ASCII, with no em dash, no token, nothing unlimited", () => {
  for (const sentence of allSentences()) {
    assert.equal(/^[\x20-\x7e]*$/.test(sentence), true, sentence);
    assert.equal(sentence.includes("\u2014"), false, sentence);
    assert.equal(/token/i.test(sentence), false, sentence);
    assert.equal(/unlimited/i.test(sentence), false, sentence);
  }
});

// ============================================
// When the switch is drawn
// ============================================

test("the switch is drawn only for an agent sold per use, and only when paying from a wallet is available", () => {
  assert.equal(walletPaymentsShown({ sells: "use", choice: "per_use", available: true }), true);
  assert.equal(walletPaymentsShown({ subject: "agent", sells: "use", choice: "per_use", available: true }), true);
  assert.equal(walletPaymentsShown({ subject: "workflow", sells: "use", choice: "per_use", available: true }), false);
  assert.equal(walletPaymentsShown({ sells: "use", choice: "per_use", available: false }), false);
  assert.equal(walletPaymentsShown({ sells: "copies", choice: "per_use", available: true }), false);
  for (const choice of ["free", "monthly", "token_holders"] as SellChoiceId[]) {
    assert.equal(walletPaymentsShown({ sells: "use", choice, available: true }), false, choice);
  }
});

// ============================================
// The price the lines name
// ============================================

test("the lines name the typed price only when it can be sold", () => {
  const limits = DEFAULT_SELL_LIMITS;
  assert.equal(walletPaymentPriceCents(perUse("0.05"), limits), 5);
  assert.equal(walletPaymentPriceCents(perUse("1"), limits), 100);
  assert.equal(walletPaymentPriceCents(perUse(""), limits), null);
  assert.equal(walletPaymentPriceCents(perUse("abc"), limits), null);
  assert.equal(walletPaymentPriceCents(perUse("0.001"), limits), null);
  // Below the floor, or above the most a use can cost: no line names it.
  assert.equal(walletPaymentPriceCents(perUse("0.04"), limits), null);
  assert.equal(walletPaymentPriceCents(perUse("0.09"), { minPerUseCents: 10 }), null);
  assert.equal(walletPaymentPriceCents(perUse("1000"), limits), 100_000);
  assert.equal(walletPaymentPriceCents(perUse("1000.01"), limits), null);
  // Another choice has no price of one use.
  assert.equal(walletPaymentPriceCents({ ...perUse("0.05"), choice: "monthly", monthlyPrice: "9" }, limits), null);
  assert.equal(walletPaymentPriceCents({ ...perUse("0.05"), sells: "copies" }, limits), null);
});

// ============================================
// What a save sends
// ============================================

const form = (sells: SellWhat, choice: SellChoiceId) => ({ sells, choice });

test("the switch is sent when it changes under pay per use, while it is available", () => {
  const on = { x402Enabled: true };
  const off = { x402Enabled: false };
  // Turned on: from no listing, a listing without the field, or one with it off.
  assert.deepEqual(x402SaveOf({ form: form("use", "per_use"), walletPay: true, listing: null, available: true }), on);
  assert.deepEqual(x402SaveOf({ form: form("use", "per_use"), walletPay: true, listing: {}, available: true }), on);
  assert.deepEqual(x402SaveOf({ form: form("use", "per_use"), walletPay: true, listing: off, available: true }), on);
  // Turned off.
  assert.deepEqual(x402SaveOf({ form: form("use", "per_use"), walletPay: false, listing: on, available: true }), off);
  // Unchanged: nothing is sent.
  assert.deepEqual(x402SaveOf({ form: form("use", "per_use"), walletPay: true, listing: on, available: true }), {});
  assert.deepEqual(x402SaveOf({ form: form("use", "per_use"), walletPay: false, listing: off, available: true }), {});
  assert.deepEqual(x402SaveOf({ form: form("use", "per_use"), walletPay: false, listing: null, available: true }), {});
});

test("while paying from a wallet is not available, the switch is never sent on and never changed under pay per use", () => {
  for (const listing of [null, { x402Enabled: false }, { x402Enabled: true }]) {
    for (const walletPay of [true, false]) {
      assert.deepEqual(x402SaveOf({ form: form("use", "per_use"), walletPay, listing, available: false }), {});
    }
  }
});

test("leaving pay per use while the switch is on sends it off, and never carries it on", () => {
  const leaving: Array<{ sells: SellWhat; choice: SellChoiceId }> = [
    form("use", "free"),
    form("use", "monthly"),
    form("use", "token_holders"),
    form("copies", "per_use"),
    form("copies", "free"),
  ];
  for (const next of leaving) {
    for (const available of [true, false]) {
      for (const walletPay of [true, false]) {
        const label = `${next.sells} ${next.choice} ${available} ${walletPay}`;
        // Saved on: turned off with the move.
        assert.deepEqual(x402SaveOf({ form: next, walletPay, listing: { x402Enabled: true }, available }), { x402Enabled: false }, label);
        // Saved off or no listing: nothing, even with the switch left on in the screen's state.
        assert.deepEqual(x402SaveOf({ form: next, walletPay, listing: { x402Enabled: false }, available }), {}, label);
        assert.deepEqual(x402SaveOf({ form: next, walletPay, listing: null, available }), {}, label);
      }
    }
  }
});

// ============================================
// The line of a listing on sale
// ============================================

test("a listing on sale says the switch is on only when it is, sold per use, while it is available", () => {
  const listing = { x402Enabled: true, sells: "use", pricingModel: "per_request" };
  assert.equal(walletPaymentsOnLine({ listing, available: true }), "Paying from a wallet is on.");
  // An older listing that does not say what it sells sells use.
  assert.equal(walletPaymentsOnLine({ listing: { x402Enabled: true, pricingModel: "per_request" }, available: true }), WALLET_PAYMENT_WORDS.on);
  assert.equal(walletPaymentsOnLine({ listing, available: false }), null);
  assert.equal(walletPaymentsOnLine({ listing: { ...listing, x402Enabled: false }, available: true }), null);
  assert.equal(walletPaymentsOnLine({ listing: { sells: "use", pricingModel: "per_request" }, available: true }), null);
  assert.equal(walletPaymentsOnLine({ listing: { ...listing, pricingModel: "monthly" }, available: true }), null);
  assert.equal(walletPaymentsOnLine({ listing: { ...listing, sells: "copies" }, available: true }), null);
  assert.equal(walletPaymentsOnLine({ listing: null, available: true }), null);
});
