/**
 * What Earnings says of a payout, the request button and a row of earnings. Run with:
 *   cd apps/web && npx tsx --test src/lib/earnings.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EARNINGS_WORDS,
  PAYOUTS_UNAVAILABLE_MESSAGE,
  amountInputValue,
  cancelPayoutDescription,
  defaultAmountText,
  defaultPayoutMethod,
  formatCents,
  parseAmountCents,
  payoutCancelledMessage,
  payoutDialog,
  payoutRefusal,
  payoutRequest,
  payoutRequestedMessage,
  payoutRow,
  payoutSubmission,
  readPayoutLimits,
  revenueRow,
  type PayoutLimits,
} from "./earnings";

/** $41.20 in earnings, $120.00 already sent to a wallet today, every method offered. */
function limitsOf(over: Partial<PayoutLimits> = {}): PayoutLimits {
  return {
    minimumCents: 500,
    perPayoutCents: 50_000,
    perDayCents: 100_000,
    usedTodayCents: 12_000,
    largestNowCents: { credits: 4120, wallet: 4120 },
    methods: ["credits", "crypto_usdc", "crypto_sol"],
    ...over,
  };
}

test("a payout offers Cancel only when the API says it is cancellable", () => {
  assert.equal(payoutRow({ status: "pending", cancellable: true }).canCancel, true);
  assert.equal(payoutRow({ status: "pending", cancellable: false }).canCancel, false);
  // An older API answer without the field never offers it, whatever the status.
  assert.equal(payoutRow({ status: "pending" }).canCancel, false);
  assert.equal(payoutRow({ status: "pending", cancellable: null }).canCancel, false);
  assert.equal(payoutRow({ status: "processing", cancellable: false }).canCancel, false);
});

test("each payout status has its word, tone and icon", () => {
  assert.deepEqual(payoutRow({ status: "pending" }), {
    statusLabel: "Pending", tone: "secondary", icon: "waiting", canCancel: false, note: null,
  });
  assert.equal(payoutRow({ status: "processing" }).statusLabel, "Processing");
  assert.equal(payoutRow({ status: "processing" }).tone, "warning");
  assert.equal(payoutRow({ status: "completed" }).icon, "done");
  assert.equal(payoutRow({ status: "completed" }).tone, "success");
  const cancelled = payoutRow({ status: "cancelled", cancellable: false });
  assert.equal(cancelled.statusLabel, "Cancelled");
  assert.equal(cancelled.icon, "cancelled");
  assert.equal(cancelled.tone, "secondary");
});

test("a status the page does not know is shown as it comes, never as a crash", () => {
  assert.equal(payoutRow({ status: "on_hold" }).statusLabel, "On hold");
  assert.equal(payoutRow({ status: "toString" }).statusLabel, "ToString");
  assert.equal(payoutRow({ status: "on_hold" }).icon, "waiting");
});

test("a failed payout shows the API's sentence as it comes", () => {
  const sentence = "The wallet address could not receive this payout. Your earnings are back in your balance.";
  const row = payoutRow({ status: "failed", failureReason: sentence });
  assert.equal(row.statusLabel, "Failed");
  assert.equal(row.icon, "failed");
  assert.equal(row.note, sentence);
  assert.equal(payoutRow({ status: "failed", failureReason: null }).note, null);
  assert.equal(payoutRow({ status: "failed", failureReason: "   " }).note, null);
  // A reason left on a payout that is not failed is not shown.
  assert.equal(payoutRow({ status: "completed", failureReason: sentence }).note, null);
});

test("cancelling says where the amount goes", () => {
  assert.equal(cancelPayoutDescription(1234), "The $12.34 goes back to your earnings.");
  assert.equal(payoutCancelledMessage(1000), "Payout cancelled. $10.00 is back in your earnings.");
});

test("the request button is offered only while payouts are running", () => {
  const off = payoutRequest({ payoutsAvailable: false, availableCents: 5000, hasPendingPayout: false, limits: limitsOf() });
  assert.equal(off.offered, false);
  assert.equal(off.enabled, false);
  assert.equal(off.line, EARNINGS_WORDS.payoutsOff);

  for (const unknown of [null, undefined]) {
    const view = payoutRequest({ payoutsAvailable: unknown, availableCents: 5000, hasPendingPayout: false, limits: limitsOf() });
    assert.equal(view.offered, false);
    assert.equal(view.line, EARNINGS_WORDS.payoutsUnknown);
  }
});

test("while payouts run, the button follows the API's minimum and a payout in flight", () => {
  const limits = limitsOf({ largestNowCents: { credits: 500, wallet: 500 } });
  const ready = payoutRequest({ payoutsAvailable: true, availableCents: 500, hasPendingPayout: false, limits });
  assert.deepEqual(ready, {
    offered: true,
    enabled: true,
    buttonLabel: "Request Payout",
    line: "You have $5.00 available for withdrawal",
  });

  const short = payoutRequest({
    payoutsAvailable: true,
    availableCents: 310,
    hasPendingPayout: false,
    limits: limitsOf({ largestNowCents: { credits: 310, wallet: 310 } }),
  });
  assert.equal(short.offered, true);
  assert.equal(short.enabled, false);
  assert.equal(short.line, "The smallest payout is $5.00. You have $3.10 available.");

  const waiting = payoutRequest({ payoutsAvailable: true, availableCents: 4120, hasPendingPayout: true, limits: limitsOf() });
  assert.equal(waiting.enabled, false);
  assert.equal(waiting.buttonLabel, "Payout Pending");

  assert.equal(
    payoutRequest({ payoutsAvailable: true, availableCents: NaN, hasPendingPayout: false, limits: limitsOf() }).enabled,
    false,
  );
});

test("the minimum is the API's: a different one moves the button with it", () => {
  const at = (minimumCents: number) =>
    payoutRequest({
      payoutsAvailable: true,
      availableCents: 800,
      hasPendingPayout: false,
      limits: limitsOf({ minimumCents, largestNowCents: { credits: 800, wallet: 800 } }),
    });
  assert.equal(at(800).enabled, true);
  assert.equal(at(801).enabled, false);
  assert.equal(at(2000).line, "The smallest payout is $20.00. You have $8.00 available.");
});

test("without limits the page can read, no request is offered", () => {
  const view = payoutRequest({ payoutsAvailable: true, availableCents: 9000, hasPendingPayout: false, limits: null });
  assert.equal(view.offered, false);
  assert.equal(view.enabled, false);
  assert.equal(view.line, EARNINGS_WORDS.limitsUnknown);
});

test("enough earnings but no method that can take a payout: the button waits and says so", () => {
  const view = payoutRequest({
    payoutsAvailable: true,
    availableCents: 4120,
    hasPendingPayout: false,
    limits: limitsOf({ methods: [] }),
  });
  assert.equal(view.offered, true);
  assert.equal(view.enabled, false);
  assert.equal(view.line, EARNINGS_WORDS.noMethodNow);
});

test("money reads with two decimals and a comma at the thousands", () => {
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(5), "$0.05");
  assert.equal(formatCents(4120), "$41.20");
  assert.equal(formatCents(100_000), "$1,000.00");
  assert.equal(formatCents(123_456_789), "$1,234,567.89");
  assert.equal(formatCents(-250), "-$2.50");
  assert.equal(formatCents(NaN), "$0.00");
});

test("the limits are read whole or not at all", () => {
  const raw = limitsOf();
  assert.deepEqual(readPayoutLimits(raw), raw);
  assert.equal(readPayoutLimits(undefined), null);
  assert.equal(readPayoutLimits(null), null);
  assert.equal(readPayoutLimits("limits"), null);
  assert.equal(readPayoutLimits({ ...raw, minimumCents: undefined }), null);
  assert.equal(readPayoutLimits({ ...raw, minimumCents: "500" }), null);
  assert.equal(readPayoutLimits({ ...raw, perDayCents: 10.5 }), null);
  assert.equal(readPayoutLimits({ ...raw, usedTodayCents: -1 }), null);
  assert.equal(readPayoutLimits({ ...raw, largestNowCents: { credits: 1 } }), null);
  assert.equal(readPayoutLimits({ ...raw, largestNowCents: null }), null);
  assert.equal(readPayoutLimits({ ...raw, methods: "credits" }), null);
  // A method the page does not know is not offered; the rest keep the page's order, each once.
  assert.deepEqual(
    readPayoutLimits({ ...raw, methods: ["crypto_usdc", "wire", "credits", "credits"] })?.methods,
    ["credits", "crypto_usdc"],
  );
});

test("an amount is read from its digits", () => {
  assert.equal(parseAmountCents("41.20"), 4120);
  assert.equal(parseAmountCents("41.2"), 4120);
  assert.equal(parseAmountCents("41"), 4100);
  assert.equal(parseAmountCents("41."), 4100);
  assert.equal(parseAmountCents(".5"), 50);
  assert.equal(parseAmountCents(" $1,000.00 "), 100_000);
  assert.equal(parseAmountCents("0.07"), 7);
  assert.equal(parseAmountCents("19.99"), 1999);
  for (const bad of ["", " ", ".", "$", "41.205", "1,00", "12,34.00", "abc", "-5", "5e2", "1 000", "4..1"]) {
    assert.equal(parseAmountCents(bad), null, bad);
  }
  assert.equal(amountInputValue(4120), "41.20");
  assert.equal(amountInputValue(100_000), "1000.00");
  assert.equal(parseAmountCents(amountInputValue(123_456)), 123_456);
});

test("the dialog offers the API's methods and opens on the largest amount allowed", () => {
  const limits = limitsOf();
  assert.equal(defaultPayoutMethod(limits), "credits");
  assert.equal(defaultAmountText(limits, "credits"), "41.20");

  const view = payoutDialog({ limits, availableCents: 4120, method: "credits", amountText: "41.20" });
  assert.deepEqual(view.options.map((o) => [o.value, o.label, o.enabled]), [
    ["credits", "Platform Credits", true],
    ["crypto_usdc", "USDC (Solana)", true],
    ["crypto_sol", "SOL", true],
  ]);
  assert.equal(view.method, "credits");
  assert.equal(view.needsAddress, false);
  assert.equal(view.limitsLine, null);
  assert.equal(view.amountHelp, "The smallest payout is $5.00. You can request up to $41.20 now.");
  assert.equal(view.amountError, null);
  assert.equal(view.amountCents, 4120);
  assert.equal(view.canSubmit, true);
  assert.equal(view.submitLabel, "Request $41.20");

  // SOL is not offered: it is not drawn, and USDC and credits stay.
  const noSol = payoutDialog({
    limits: limitsOf({ methods: ["credits", "crypto_usdc"] }),
    availableCents: 4120,
    method: "crypto_sol",
    amountText: "41.20",
  });
  assert.deepEqual(noSol.options.map((o) => o.value), ["credits", "crypto_usdc"]);
  assert.equal(noSol.method, null);
  assert.equal(noSol.canSubmit, false);
});

test("a wallet method says the limits and what today has used, and asks for an address", () => {
  const limits = limitsOf({ largestNowCents: { credits: 74_000, wallet: 50_000 } });
  assert.equal(defaultAmountText(limits, "crypto_usdc"), "500.00");
  assert.equal(defaultAmountText(limits, "credits"), "740.00");
  const view = payoutDialog({ limits, availableCents: 74_000, method: "crypto_usdc", amountText: "500.00" });
  assert.equal(view.needsAddress, true);
  assert.equal(
    view.limitsLine,
    "Up to $500.00 a payout and $1,000.00 a day to a wallet. Used today: $120.00.",
  );
  assert.equal(view.amountHelp, "The smallest payout is $5.00. You can request up to $500.00 now.");
  assert.equal(view.submitLabel, "Request $500.00");
});

test("the amount is checked at each edge before anything is sent", () => {
  const limits = limitsOf({ usedTodayCents: 62_000, largestNowCents: { credits: 74_000, wallet: 38_000 } });
  const at = (method: "credits" | "crypto_usdc", amountText: string) =>
    payoutDialog({ limits, availableCents: 74_000, method, amountText });

  assert.equal(at("credits", "5.00").canSubmit, true);
  assert.equal(at("credits", "4.99").amountError, "The smallest payout is $5.00.");
  assert.equal(at("credits", "4.99").canSubmit, false);
  assert.equal(at("credits", "740.00").canSubmit, true);
  assert.equal(at("credits", "740.01").amountError, "You have $740.00 available. Request that amount or less.");

  assert.equal(at("crypto_usdc", "380.00").canSubmit, true);
  assert.equal(
    at("crypto_usdc", "380.01").amountError,
    "$380.00 is left of today's limit for payouts to a wallet. Request that amount or less.",
  );
  assert.equal(
    at("crypto_usdc", "500.01").amountError,
    "The most for one payout to a wallet is $500.00. Request that amount or less; the rest stays in your earnings.",
  );
  assert.equal(at("crypto_usdc", "740.01").amountError, "You have $740.00 available. Request that amount or less.");

  // Credits have no cap, but never more than the API says it would take now.
  const less = payoutDialog({
    limits: limitsOf({ largestNowCents: { credits: 70_000, wallet: 38_000 } }),
    availableCents: 74_000,
    method: "credits",
    amountText: "700.01",
  });
  assert.equal(less.amountError, "The most you can request now is $700.00.");
  assert.equal(less.canSubmit, false);
  assert.equal(less.amountCents, null);

  assert.equal(at("credits", "ten").amountError, EARNINGS_WORDS.amountUnreadable);
  assert.equal(at("credits", "ten").amountCents, null);
  assert.equal(at("credits", "ten").submitLabel, "Request payout");
  // An empty box is not yet a mistake, and cannot be sent.
  assert.equal(at("credits", "").amountError, null);
  assert.equal(at("credits", "").canSubmit, false);
});

test("a wallet method with nothing left of today's limit is drawn, closed, and says why", () => {
  const limits = limitsOf({ usedTodayCents: 100_000, largestNowCents: { credits: 4120, wallet: 0 } });
  assert.equal(defaultPayoutMethod(limits), "credits");
  const view = payoutDialog({ limits, availableCents: 4120, method: "crypto_usdc", amountText: "41.20" });
  const usdc = view.options.find((o) => o.value === "crypto_usdc");
  assert.equal(usdc?.enabled, false);
  assert.equal(usdc?.description, EARNINGS_WORDS.walletLimitReached);
  assert.equal(view.options.find((o) => o.value === "credits")?.enabled, true);
  assert.equal(view.method, null);
  assert.equal(view.canSubmit, false);

  // Credits are not offered and the wallet is closed: the dialog opens on what there is.
  assert.equal(defaultPayoutMethod(limitsOf({ methods: ["crypto_usdc"], largestNowCents: { credits: 0, wallet: 0 } })), "crypto_usdc");
  assert.equal(defaultPayoutMethod(limitsOf({ methods: [] })), null);
});

test("pressing the button sends the amount, and the address only for a wallet", () => {
  const limits = limitsOf();
  const credits = payoutDialog({ limits, availableCents: 4120, method: "credits", amountText: "20" });
  assert.deepEqual(payoutSubmission(credits, "  ignored  "), {
    ok: true,
    body: { payoutMethod: "credits", amountCents: 2000 },
  });

  const usdc = payoutDialog({ limits, availableCents: 4120, method: "crypto_usdc", amountText: "41.20" });
  assert.deepEqual(payoutSubmission(usdc, " So1anaWa11et "), {
    ok: true,
    body: { payoutMethod: "crypto_usdc", payoutAddress: "So1anaWa11et", amountCents: 4120 },
  });
  assert.deepEqual(payoutSubmission(usdc, "   "), {
    ok: false,
    refusal: { field: "address", message: "Enter the wallet address to send this payout to." },
  });

  const bad = payoutDialog({ limits, availableCents: 4120, method: "crypto_usdc", amountText: "1.00" });
  assert.deepEqual(payoutSubmission(bad, "So1anaWa11et"), {
    ok: false,
    refusal: { field: "amount", message: "The smallest payout is $5.00." },
  });
});

test("a refusal is the API's sentence, beside the field its code names", () => {
  const said = "That is not a Solana wallet address. Check it and try again.";
  assert.deepEqual(payoutRefusal("invalid_payout_address", said), { field: "address", message: said, reload: false });
  assert.equal(payoutRefusal("payout_address_required", "x").field, "address");
  for (const code of ["invalid_payload", "payout_below_minimum", "payout_above_balance", "payout_above_limit"]) {
    assert.equal(payoutRefusal(code, "x").field, "amount", code);
  }
  for (const code of ["payout_method_unavailable", "payout_daily_limit"]) {
    assert.equal(payoutRefusal(code, "x").field, "method", code);
  }
  for (const code of ["payout_check_unavailable", "payout_reservation_conflict", "payout_in_progress", "something_new", "toString"]) {
    assert.equal(payoutRefusal(code, "x").field, "form", code);
  }
});

test("a refusal with no sentence never shows a code or raw text", () => {
  assert.equal(payoutRefusal("something_new", "").message, EARNINGS_WORDS.requestFailed);
  assert.equal(payoutRefusal("something_new", null).message, EARNINGS_WORDS.requestFailed);
  // The client answers the code when there is no sentence.
  assert.equal(payoutRefusal("payout_above_limit", "payout_above_limit").message, EARNINGS_WORDS.requestFailed);
  // No answer at all: the page cannot say the payout was not requested.
  const lost = payoutRefusal(null, null);
  assert.deepEqual(lost, { field: "form", message: EARNINGS_WORDS.requestFailed, reload: true });
});

test("the earnings are read again after a refusal that changes what the dialog shows", () => {
  for (const code of ["invalid_payload", "payout_address_required", "invalid_payout_address", "payout_check_unavailable"]) {
    assert.equal(payoutRefusal(code, "x").reload, false, code);
  }
  for (const code of [
    "payout_method_unavailable", "payout_in_progress", "payout_below_minimum", "payout_above_balance",
    "payout_above_limit", "payout_daily_limit", "payout_reservation_conflict", "something_new",
  ]) {
    assert.equal(payoutRefusal(code, "x").reload, true, code);
  }
});

test("after a request the page says the API's sentence", () => {
  const capped = "Requested $500.00, the most for one payout to a wallet. $240.00 stays in your earnings.";
  assert.equal(payoutRequestedMessage(capped, 50_000), capped);
  assert.equal(payoutRequestedMessage(undefined, 4120), "Payout of $41.20 requested.");
  assert.equal(payoutRequestedMessage("  ", 4120), "Payout of $41.20 requested.");
});

test("a pending payout shows the API's sentence when it has one", () => {
  const waiting = "This payout is waiting to be sent. You can cancel it and keep your earnings.";
  const row = payoutRow({ status: "pending", cancellable: true, message: waiting });
  assert.equal(row.note, waiting);
  assert.equal(row.canCancel, true);
  assert.equal(payoutRow({ status: "pending", cancellable: true, message: null }).note, null);
  assert.equal(payoutRow({ status: "pending", cancellable: true }).note, null);
  // A failed payout keeps its sentence, from either field.
  assert.equal(payoutRow({ status: "failed", failureReason: "Why.", message: "Other." }).note, "Why.");
  assert.equal(payoutRow({ status: "failed", failureReason: null, message: "Why." }).note, "Why.");
  // A sentence left on a finished payout is not shown.
  assert.equal(payoutRow({ status: "completed", message: waiting }).note, null);
});

test("the refusal sentence is the API's, word for word", () => {
  assert.equal(
    PAYOUTS_UNAVAILABLE_MESSAGE,
    "Payouts are temporarily unavailable. Nothing was reserved and your earnings are unchanged. Try again later.",
  );
});

test("a per-use sale reads Paid use, with its model cost only when the row carries one", () => {
  assert.deepEqual(revenueRow({ type: "per_request", licenceKind: "use", modelCostCents: 1 }), {
    label: "Paid use", jobId: null, modelCostCents: 1,
  });
  assert.equal(revenueRow({ type: "per_request", modelCostCents: 0 }).modelCostCents, null);
  assert.equal(revenueRow({ type: "per_request" }).modelCostCents, null);
  assert.equal(revenueRow({ type: "per_request", modelCostCents: null }).modelCostCents, null);
  assert.equal(revenueRow({ type: "per_request", modelCostCents: NaN }).modelCostCents, null);
  assert.equal(revenueRow({ type: "per_request", modelCostCents: -3 }).modelCostCents, null);
});

test("the other kinds of earnings keep their names", () => {
  assert.equal(revenueRow({ type: "subscription" }).label, "Subscription");
  assert.equal(revenueRow({ type: "subscription_renewal" }).label, "Subscription renewal");
  const job = revenueRow({ type: "job", jobId: "j1", modelCostCents: 7 });
  assert.deepEqual(job, { label: "Job", jobId: "j1", modelCostCents: 7 });
  assert.equal(revenueRow({ type: "something_new" }).label, "Something new");
  assert.equal(revenueRow({ type: "constructor" }).label, "Constructor");
});

test("a use paid from a wallet reads Paid from a wallet, and every other label is what it was", () => {
  assert.deepEqual(revenueRow({ type: "x402", modelCostCents: 2 }), {
    label: "Paid from a wallet", jobId: null, modelCostCents: 2,
  });
  // It has no licence behind it; a row that says one keeps the same label.
  assert.equal(revenueRow({ type: "x402", licenceKind: null }).label, "Paid from a wallet");
  assert.equal(revenueRow({ type: "x402", licenceKind: "use" }).label, "Paid from a wallet");
  assert.equal(revenueRow({ type: "per_request" }).label, "Per request");
  assert.equal(revenueRow({ type: "per_request", licenceKind: "use" }).label, "Paid use");
  assert.equal(revenueRow({ type: "subscription" }).label, "Subscription");
  assert.equal(revenueRow({ type: "subscription_renewal" }).label, "Subscription renewal");
  assert.equal(revenueRow({ type: "job" }).label, "Job");
});

test("a request charged on a buyer's copy is not called a paid use", () => {
  assert.equal(revenueRow({ type: "per_request", licenceKind: "use" }).label, "Paid use");
  assert.equal(revenueRow({ type: "per_request", licenceKind: "copy" }).label, "Per request");
  // A row that does not say what its licence is for is not called a paid use.
  assert.equal(revenueRow({ type: "per_request" }).label, "Per request");
  assert.equal(revenueRow({ type: "per_request", licenceKind: null }).label, "Per request");
  // Only a per-request row is renamed: a copy's subscription keeps its own label.
  assert.equal(
    revenueRow({ type: "subscription", licenceKind: "copy" }).label,
    revenueRow({ type: "subscription" }).label,
  );
});
