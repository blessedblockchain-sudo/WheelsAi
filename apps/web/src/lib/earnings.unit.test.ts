/**
 * What Earnings says of a payout, the request button and a row of earnings. Run with:
 *   cd apps/web && npx tsx --test src/lib/earnings.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EARNINGS_WORDS,
  PAYOUTS_UNAVAILABLE_MESSAGE,
  cancelPayoutDescription,
  payoutCancelledMessage,
  payoutRequest,
  payoutRow,
  revenueRow,
} from "./earnings";

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
  const off = payoutRequest({ payoutsAvailable: false, availableCents: 5000, hasPendingPayout: false });
  assert.equal(off.offered, false);
  assert.equal(off.enabled, false);
  assert.equal(off.line, EARNINGS_WORDS.payoutsOff);

  for (const unknown of [null, undefined]) {
    const view = payoutRequest({ payoutsAvailable: unknown, availableCents: 5000, hasPendingPayout: false });
    assert.equal(view.offered, false);
    assert.equal(view.line, EARNINGS_WORDS.payoutsUnknown);
  }
});

test("while payouts run, the button follows the minimum and a payout in flight", () => {
  const ready = payoutRequest({ payoutsAvailable: true, availableCents: 1000, hasPendingPayout: false });
  assert.deepEqual(ready, {
    offered: true,
    enabled: true,
    buttonLabel: "Request Payout",
    line: "You have $10.00 available for withdrawal",
  });

  const short = payoutRequest({ payoutsAvailable: true, availableCents: 999, hasPendingPayout: false });
  assert.equal(short.offered, true);
  assert.equal(short.enabled, false);
  assert.equal(short.line, "Minimum payout amount is $10.00");

  const waiting = payoutRequest({ payoutsAvailable: true, availableCents: 4000, hasPendingPayout: true });
  assert.equal(waiting.enabled, false);
  assert.equal(waiting.buttonLabel, "Payout Pending");

  assert.equal(payoutRequest({ payoutsAvailable: true, availableCents: NaN, hasPendingPayout: false }).enabled, false);
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
