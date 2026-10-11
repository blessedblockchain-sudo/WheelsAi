/**
 * The Billing page's credit ledger: how amounts, spending, holds, tiles and export ranges are drawn.
 * Run with:
 *   cd apps/web && npx tsx --test src/lib/billing-view.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CreditHold } from "./api";
import {
  CREDIT_CLASS,
  DOWNLOAD_FAILED,
  HISTORY_FILTERS,
  HOLDS_NOT_READ,
  LIST_NOT_READ,
  MUTED_CLASS,
  NOT_LOADED,
  PLAIN_CLASS,
  appendPage,
  balanceAfterText,
  drawAmount,
  exportFailure,
  exportRangeFor,
  exportRanges,
  filterOf,
  formatUsd,
  heldShown,
  listFailure,
  spendingShown,
  tilesShown,
} from "./billing-view";

/** An error as the API client throws it. */
function thrown(status: number, data: unknown) {
  return Object.assign(new Error(`API Error: ${status}`), { status, statusText: "", data });
}

test("an amount is drawn by its own sign", () => {
  assert.deepEqual(drawAmount(5), { text: "+$5.00", className: CREDIT_CLASS, direction: "in" });
  assert.deepEqual(drawAmount(-5), { text: "-$5.00", className: PLAIN_CLASS, direction: "out" });
  assert.deepEqual(drawAmount(0), { text: "$0.00", className: MUTED_CLASS, direction: "none" });
  assert.equal(drawAmount(1234.5).text, "+$1,234.50");
  assert.equal(drawAmount(-0.01).text, "-$0.01");
});

test("zero is never drawn with a minus sign", () => {
  for (const amount of [-0, -0.001, 0.004, -0.004]) {
    const drawn = drawAmount(amount);
    assert.equal(drawn.text, "$0.00", String(amount));
    assert.equal(drawn.className, MUTED_CLASS);
    assert.equal(drawn.direction, "none");
  }
  assert.equal(formatUsd(-0), "$0.00");
  assert.equal(formatUsd(-0.004), "$0.00");
});

test("a figure that is not a number is drawn as zero, not as NaN", () => {
  assert.equal(drawAmount(Number.NaN).text, "$0.00");
  assert.equal(drawAmount(undefined as unknown as number).text, "$0.00");
});

test("the balance after keeps its own sign", () => {
  assert.equal(balanceAfterText(12.3), "Balance after $12.30");
  assert.equal(balanceAfterText(0), "Balance after $0.00");
  assert.equal(balanceAfterText(-1.5), "Balance after -$1.50");
});

test("spending shows one line per group that is not zero, in the API's order, and the API's total", () => {
  const shown = spendingShown({
    currentMonth: 13.5,
    spend: [
      { group: "gpu", label: "GPU time", amount: 12 },
      { group: "inference", label: "Inference", amount: 0 },
      { group: "fine_tuning", label: "Fine-tuning", amount: 3.5 },
      { group: "paid_use", label: "Paid use of listings", amount: -2 },
      { group: "subscriptions", label: "Subscriptions", amount: 0 },
      { group: "jobs", label: "Jobs", amount: 0 },
      { group: "try_it", label: "Try it messages you paid for", amount: 0 },
    ],
  });
  assert.equal(shown.empty, false);
  assert.deepEqual(
    shown.lines.map((l) => [l.key, l.label, l.text]),
    [
      ["gpu", "GPU time", "$12.00"],
      ["fine_tuning", "Fine-tuning", "$3.50"],
      ["paid_use", "Paid use of listings", "$2.00 returned"],
    ]
  );
  assert.deepEqual(shown.total, { text: "$13.50", className: PLAIN_CLASS, returned: false });
});

test("an amount below zero is shown as returned, in the colour of a credit", () => {
  const shown = spendingShown({
    currentMonth: -2,
    spend: [{ group: "paid_use", label: "Paid use of listings", amount: -2 }],
  });
  assert.equal(shown.lines[0]!.returned, true);
  assert.equal(shown.lines[0]!.className, CREDIT_CLASS);
  assert.equal(shown.lines[0]!.text, "$2.00 returned");
  assert.deepEqual(shown.total, { text: "$2.00 returned", className: CREDIT_CLASS, returned: true });
});

test("the total is the API's figure, never a sum worked out on the page", () => {
  const shown = spendingShown({
    currentMonth: 99,
    spend: [{ group: "gpu", label: "GPU time", amount: 1 }],
  });
  assert.equal(shown.total?.text, "$99.00");
});

test("nothing spent: no lines and no total", () => {
  const zero = spendingShown({
    currentMonth: 0,
    spend: [
      { group: "gpu", label: "GPU time", amount: 0 },
      { group: "jobs", label: "Jobs", amount: 0.001 },
    ],
  });
  assert.deepEqual(zero, { lines: [], total: null, empty: true });
  assert.deepEqual(spendingShown(null), { lines: [], total: null, empty: true });
  assert.deepEqual(spendingShown({ currentMonth: 0, spend: [] }), { lines: [], total: null, empty: true });
  // An older answer with no `spend` draws nothing, it does not throw.
  assert.equal(spendingShown({ currentMonth: 4 } as never).empty, true);
});

test("the tiles show the API's figures", () => {
  assert.deepEqual(
    tilesShown(
      { available: 42.5, held: 7, total: 49.5, pending: 7 },
      { currentMonth: 13.5, gpuHours: 3.25 }
    ),
    { available: "$42.50", spent: "$13.50", held: "$7.00", gpuHours: "3.3h" }
  );
  assert.equal(tilesShown({ available: 0, held: 0 }, { currentMonth: 0, gpuHours: 0 }).gpuHours, "0.0h");
});

test("a month in which more came back than was charged reads the same on the tile as on the card", () => {
  const tiles = tilesShown({ available: 10, held: 0 }, { currentMonth: -2, gpuHours: 0 });
  assert.equal(tiles.spent, "$2.00 returned");
  assert.equal(tilesShown({ available: 10, held: 0 }, { currentMonth: 0, gpuHours: 0 }).spent, "$0.00");
});

test("before data has loaded the tiles show no number", () => {
  assert.deepEqual(tilesShown(null, null), {
    available: NOT_LOADED,
    spent: NOT_LOADED,
    held: NOT_LOADED,
    gpuHours: NOT_LOADED,
  });
  assert.doesNotMatch(NOT_LOADED, /\d/);
  // A balance from an older API with no `held`: that tile stays unloaded, it is not shown as $0.00.
  const partial = tilesShown({ available: 3 }, null);
  assert.equal(partial.available, "$3.00");
  assert.equal(partial.held, NOT_LOADED);
});

const hold: CreditHold = {
  kind: "deployment",
  id: "dep_1",
  name: "llama-prod",
  amount: 5,
  since: "2026-10-10T08:00:00.000Z",
  note: "Held while this deployment runs. It comes back when the deployment stops.",
};

test("what is held: the list when there is one, nothing when nothing is held", () => {
  assert.deepEqual(heldShown({ held: 5 }, [hold]), { holds: [hold], notice: null });
  assert.deepEqual(heldShown({ held: 0 }, []), { holds: [], notice: null });
  assert.deepEqual(heldShown({ held: 0 }, null), { holds: [], notice: null });
  assert.deepEqual(heldShown(null, null), { holds: [], notice: null });
});

test("something held and no list: the page says the list could not be read", () => {
  assert.deepEqual(heldShown({ held: 5 }, null), { holds: [], notice: HOLDS_NOT_READ });
});

test("the filter has four choices and asks the API for the three it knows", () => {
  assert.deepEqual(
    HISTORY_FILTERS.map((c) => c.label),
    ["All", "Credits added", "Spending", "Holds"]
  );
  assert.equal(filterOf("all"), undefined);
  assert.equal(filterOf("added"), "added");
  assert.equal(filterOf("spent"), "spent");
  assert.equal(filterOf("held"), "held");
});

test("the three export ranges are UTC days", () => {
  const ranges = exportRanges(new Date("2026-10-11T15:30:00.000Z"));
  assert.deepEqual(ranges, [
    { key: "this_month", label: "This month", from: "2026-10-01", to: "2026-10-11" },
    { key: "last_month", label: "Last month", from: "2026-09-01", to: "2026-09-30" },
    { key: "last_90_days", label: "Last 90 days", from: "2026-07-14", to: "2026-10-11" },
  ]);
  // 90 days, both ends included.
  const days = (Date.parse("2026-10-11") - Date.parse("2026-07-14")) / 86_400_000 + 1;
  assert.equal(days, 90);
});

test("export ranges follow the UTC day, not the local one, and cross a year", () => {
  // 23:30 in New York on Dec 31 is already Jan 1 in UTC.
  const ranges = exportRanges(new Date("2026-12-31T23:30:00-05:00"));
  assert.deepEqual(ranges[0], { key: "this_month", label: "This month", from: "2027-01-01", to: "2027-01-01" });
  assert.deepEqual(ranges[1], { key: "last_month", label: "Last month", from: "2026-12-01", to: "2026-12-31" });
  assert.equal(ranges[2]!.to, "2027-01-01");
  assert.equal(ranges[2]!.from, "2026-10-04");
});

test("last month ends on its own last day, leap years included", () => {
  assert.equal(exportRanges(new Date("2028-03-15T00:00:00.000Z"))[1]!.to, "2028-02-29");
  assert.equal(exportRanges(new Date("2027-03-31T23:59:59.999Z"))[1]!.to, "2027-02-28");
  assert.equal(exportRanges(new Date("2027-03-31T23:59:59.999Z"))[1]!.from, "2027-02-01");
});

test("a range is worked out at the moment it is asked for, not when the menu was drawn", () => {
  // The page was drawn on Oct 31 and the choice is clicked after midnight UTC, on Nov 1.
  const drawn = exportRanges(new Date("2026-10-31T23:59:00.000Z"));
  const clicked = new Date("2026-11-01T00:01:00.000Z");
  assert.equal(drawn[0]!.to, "2026-10-31");
  assert.deepEqual(exportRangeFor("this_month", clicked), {
    key: "this_month",
    label: "This month",
    from: "2026-11-01",
    to: "2026-11-01",
  });
  assert.deepEqual(exportRangeFor("last_month", clicked), {
    key: "last_month",
    label: "Last month",
    from: "2026-10-01",
    to: "2026-10-31",
  });
  assert.equal(exportRangeFor("last_90_days", clicked).to, "2026-11-01");
  assert.equal(exportRangeFor("last_90_days", clicked).from, "2026-08-04");
});

test("a refused export shows the API's sentence", () => {
  const refusal = thrown(400, {
    error: "range_too_large",
    message: "That range holds more rows than one file can carry. Choose a shorter range.",
  });
  assert.equal(
    exportFailure(refusal),
    "That range holds more rows than one file can carry. Choose a shorter range."
  );
});

test("a failed download shows the page's sentence, never thrown text", () => {
  assert.equal(exportFailure(new TypeError("Failed to fetch")), DOWNLOAD_FAILED);
  assert.equal(exportFailure(thrown(502, null)), DOWNLOAD_FAILED);
  // The server framework's own error body is not a sentence written for a customer.
  assert.equal(
    exportFailure(thrown(500, { statusCode: 500, error: "Internal Server Error", message: "boom at x.ts:1" })),
    DOWNLOAD_FAILED
  );
  assert.equal(DOWNLOAD_FAILED, "The file could not be downloaded. Try again in a moment.");
});

test("a failed page of the history: the API's sentence, else the page's", () => {
  assert.equal(
    listFailure(thrown(400, { error: "invalid_request", message: "That list could not be read. Reload the page and try again." })),
    "That list could not be read. Reload the page and try again."
  );
  assert.equal(listFailure(new TypeError("Failed to fetch")), LIST_NOT_READ);
});

test("another page is added without drawing a row twice", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const c = { id: "c" };
  assert.deepEqual(appendPage([a, b], [b, c]), [a, b, c]);
  assert.deepEqual(appendPage([], [a]), [a]);
  assert.deepEqual(appendPage([a], []), [a]);
});

test("sentences written here carry no em dash", () => {
  for (const sentence of [DOWNLOAD_FAILED, HOLDS_NOT_READ, LIST_NOT_READ]) {
    assert.doesNotMatch(sentence, /—/);
  }
});
