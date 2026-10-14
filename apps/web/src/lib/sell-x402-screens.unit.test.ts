/**
 * The creator's switch for paying from a wallet, read off the screens'
 * source: "Who can use it?" draws it only through walletPaymentsShown, the
 * Sell tab passes it only when the capabilities say paying from a wallet is
 * available and sends it only through x402SaveOf, and no screen writes a
 * sentence of its own. Run with:
 *   cd apps/web && npx tsx --test src/lib/sell-x402-screens.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { WALLET_PAYMENT_WORDS, walletPaymentLines } from "./sell-x402";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, "..", path), "utf8");
/** The source with its comments taken out, so a word in a comment is never taken for a word on screen. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const QUESTION = source("components/dashboard/sell/who-can-use.tsx");
const SWITCH = source("components/dashboard/sell/wallet-payments.tsx");
const SELL_TAB = source("components/dashboard/agent-tabs/sell-tab.tsx");
const WIZARD = source("app/(dashboard)/dashboard/marketplace/publish/page.tsx");
const WORKFLOW_SELL = source("components/dashboard/workflows/workflow-sell.tsx");

test("the question draws the switch only through walletPaymentsShown, once, outside the box about people who pay", () => {
  assert.match(QUESTION, /import \{ WalletPayments \} from "\.\/wallet-payments";/);
  assert.match(
    QUESTION,
    /const walletShown = walletPaymentsShown\(\{ subject, sells: form\.sells, choice: form\.choice, available: walletPayments !== undefined \}\);/,
  );
  assert.match(QUESTION, /\{walletShown && walletPayments && \(\s+<WalletPayments\s+checked=\{walletPayments\.checked\}\s+onChange=\{walletPayments\.onChange\}/);
  assert.equal(QUESTION.split("<WalletPayments").length, 2);
  assert.equal(QUESTION.split("walletPaymentsShown(").length, 2);
  // The price its lines name is the pure file's reading of the typed price.
  assert.match(QUESTION, /priceCents=\{walletPaymentPriceCents\(form, limits\)\}/);
  // Not inside the box drawn for an agent's paid use: that box is about tools and keeping a copy.
  const boxStart = QUESTION.indexOf("{!workflow && paid && (");
  const boxEnd = QUESTION.indexOf("\n      )}\n", boxStart);
  assert.ok(boxStart > 0 && boxEnd > boxStart);
  const drawn = QUESTION.indexOf("<WalletPayments");
  assert.ok(drawn > boxEnd, "drawn after the box closes");
  assert.ok(drawn < QUESTION.indexOf("{words.moreOptions}"), "drawn above More options");
});

test("the switch's component says only the pure file's words", () => {
  assert.match(SWITCH, /\{WALLET_PAYMENT_WORDS\.label\}/);
  assert.match(SWITCH, /const lines = walletPaymentLines\(priceCents\);/);
  assert.match(SWITCH, /<Switch\s+id=\{`\$\{id\}-wallet`\}\s+checked=\{checked\}\s+onCheckedChange=\{onChange\}/);
  assert.equal(SWITCH.split("<Switch").length, 2);
});

test("no screen types a sentence of paying from a wallet", () => {
  const sentences = [
    WALLET_PAYMENT_WORDS.label,
    WALLET_PAYMENT_WORDS.price("$0.05"),
    WALLET_PAYMENT_WORDS.order,
    WALLET_PAYMENT_WORDS.noAnswer,
    WALLET_PAYMENT_WORDS.earn,
    WALLET_PAYMENT_WORDS.deadline(30),
    WALLET_PAYMENT_WORDS.on,
    ...walletPaymentLines(5),
  ];
  for (const screen of [QUESTION, SWITCH, SELL_TAB]) {
    for (const sentence of sentences) assert.equal(screen.includes(sentence), false, sentence);
    const drawn = code(screen);
    for (const word of ["Solana", "USDC", "x402 client", "Paying from a wallet", "no account"]) {
      assert.equal(drawn.includes(word), false, word);
    }
    assert.equal(/unlimited/i.test(screen), false);
  }
  assert.equal(/token/i.test(code(SWITCH)), false);
});

test("the Sell tab passes the switch only with the capability, and counts it in what changed", () => {
  assert.match(SELL_TAB, /const walletAvailable = capabilities\?\.x402\?\.available === true;/);
  assert.match(
    SELL_TAB,
    /walletPayments=\{walletAvailable \? \{ checked: walletPay, onChange: changeWalletPay, error: walletError \} : undefined\}/,
  );
  assert.equal(SELL_TAB.split("walletPayments=").length, 2);
  // Read from the listing as it was read, and back from the answer of the save.
  assert.match(SELL_TAB, /setWalletPay\(listing\?\.x402Enabled === true\);/);
  assert.match(SELL_TAB, /setWalletPay\(savedListing\.x402Enabled === true\);/);
  // A change of the switch alone enables Save changes.
  assert.match(SELL_TAB, /const walletUnchanged = x402SaveOf\(\{ form, walletPay, listing, available: walletAvailable \}\)\.x402Enabled === undefined;/);
  assert.match(SELL_TAB, /sameSellForm\(form, baseline\) && walletUnchanged &&/);
  // Its change clears a sentence like any other edit, and the offer that goes with it.
  assert.match(SELL_TAB, /function changeWalletPay\(checked: boolean\) \{\s+setWalletPay\(checked\);\s+setError\(null\);\s+setPlansStale\(false\);\s+setWalletError\(null\);/);
});

test("the Sell tab sends the switch only through x402SaveOf, for the answer being saved, in both bodies", () => {
  assert.match(SELL_TAB, /const walletSave = x402SaveOf\(\{ form: sent, walletPay, listing, available: walletAvailable \}\);/);
  assert.match(SELL_TAB, /marketplaceApi\.updateListing\(listing\.id, \{ \.\.\.sellUpdateOf\(built\.save, listing\), \.\.\.walletSave \}\)/);
  assert.match(SELL_TAB, /marketplaceApi\.createListing\(\{ \.\.\.firstListingOf\(agent, line \?\? "", built\.save\), \.\.\.walletSave \}\)/);
  // Never written by hand into a body.
  assert.equal(/x402Enabled:/.test(code(SELL_TAB)), false);
  // Built after the checks, so a form that cannot be saved sends nothing.
  assert.ok(SELL_TAB.indexOf("const walletSave = x402SaveOf(") > SELL_TAB.indexOf('plansSave.kind === "invalid"'));
  assert.ok(SELL_TAB.indexOf("const walletSave = x402SaveOf(") < SELL_TAB.indexOf("marketplaceApi.updateListing("));
});

test("the Sell tab of a listing on sale says the switch is on through the pure file", () => {
  assert.match(SELL_TAB, /const walletOnLine = walletPaymentsOnLine\(\{ listing, available: walletAvailable \}\);/);
  assert.match(SELL_TAB, /\{walletOnLine && <p className="text-sm text-foreground">\{walletOnLine\}<\/p>\}/);
  // On the card of a listing on sale, between its link and what it earned.
  const line = SELL_TAB.indexOf("{walletOnLine &&");
  assert.ok(line > SELL_TAB.indexOf("if (listing && status && onSale) {"));
  assert.ok(line < SELL_TAB.indexOf("{(earned || stats.length > 0) && ("));
});

test("the listing wizard and a workflow's Sell card do not pass the switch, so they draw nothing of it", () => {
  for (const screen of [WIZARD, WORKFLOW_SELL]) {
    assert.equal(screen.includes("walletPayments"), false);
    assert.equal(screen.includes("x402"), false);
  }
});

test("a refusal of the switch is drawn under the switch, in the API's own sentence, and not again above Save", () => {
  // The Sell tab reads the refusal off the field the API names and hands it to the question.
  assert.match(SELL_TAB, /const walletRefusal = fields\?\.x402Enabled \?\? null;\s+setWalletError\(walletRefusal\);/);
  assert.match(
    SELL_TAB,
    /if \(Object\.keys\(fieldErrors\)\.length === 0 && walletRefusal === null\) \{\s+setError\(getErrorMessage\(err, /,
  );
  // Cleared by an edit of the answer or of the switch, by a new save and by a read of the listing.
  assert.match(SELL_TAB, /function change\(next: SellForm\) \{\s+setForm\(next\);\s+setErrors\(\{\}\);\s+setError\(null\);\s+setPlansStale\(false\);\s+setWalletError\(null\);/);
  assert.match(SELL_TAB, /async function save\(sent: SellForm = form\) \{\s+setError\(null\);\s+setPlansStale\(false\);\s+setWalletError\(null\);/);
  assert.match(SELL_TAB, /setWalletPay\(listing\?\.x402Enabled === true\);\s+setWalletError\(null\);/);
  // The question passes it on, and the switch's component draws it under the switch and is described by it.
  assert.match(QUESTION, /error=\{walletPayments\.error \?\? null\}/);
  assert.match(SWITCH, /\{error && \(\s+<p id=\{`\$\{id\}-wallet-error`\} role="alert" className="text-sm text-danger">\s+\{error\}\s+<\/p>\s+\)\}/);
  assert.match(SWITCH, /const describedBy = error \? `\$\{id\}-wallet-error \$\{id\}-wallet-lines` : `\$\{id\}-wallet-lines`;/);
  assert.match(SWITCH, /aria-describedby=\{describedBy\}/);
  // Under the switch's row, above its lines.
  assert.ok(SWITCH.indexOf("{error && (") > SWITCH.indexOf("<Switch"));
  assert.ok(SWITCH.indexOf("{error && (") < SWITCH.indexOf("{lines.map("));
});
