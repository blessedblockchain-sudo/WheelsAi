/**
 * The organization's deposit address: what the Billing page shows for each state. Run with:
 *   cd apps/web && npx tsx --test src/lib/deposit-address.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  BillingRails,
  DepositAddressResponse,
  DepositCheckResponse,
  DepositRecord,
} from "./api";
import {
  CHECK_NOW,
  COPY_FAILED,
  DEPOSITS_SHOWN,
  ONLY_USDC,
  ONLY_USDC_AND_SOL,
  PANEL_TITLE,
  PAUSED,
  PREPARE_ADDRESS,
  PREPARE_HINT,
  SHOW_ADDRESS,
  SOLANA_ONLY,
  TOO_OFTEN,
  afterCheck,
  afterDepositError,
  afterIssue,
  afterPrepare,
  creditedSince,
  depositRows,
  depositsOffered,
  hidesAddress,
  lineAfterCopied,
  panelView,
  refreshedAddress,
  solOffered,
  usdcAccountOpen,
  withUsdcAccountOpen,
} from "./deposit-address";
import * as sentences from "./deposit-address";

const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SHOWN_AND_HOW =
  "Send USDC or SOL on Solana to this address. It belongs to your organization only. USDC is credited one dollar for one USDC. SOL is credited at its dollar value when we see your transfer, usually within a few minutes.";
const SHOWN_AND_HOW_USDC_ONLY =
  "Send USDC on Solana to this address. It belongs to your organization only. USDC is credited one dollar for one USDC, usually within a few minutes.";

function rails(over: Partial<BillingRails> = {}): BillingRails {
  return {
    stripeCheckout: false,
    mockCheckout: false,
    wallet: true,
    walletAssets: ["USDC"],
    network: "devnet",
    ...over,
  };
}

function answer(over: Partial<DepositAddressResponse> = {}): DepositAddressResponse {
  return {
    address: ADDRESS,
    network: "devnet",
    assets: [
      { asset: "USDC", accountOpen: false },
      { asset: "SOL", offered: true },
    ],
    message: "the API's sentence",
    ...over,
  };
}

function deposit(id: string, over: Partial<DepositRecord> = {}): DepositRecord {
  return {
    id,
    asset: "USDC",
    amount: "50.00",
    status: "credited",
    creditedUsd: 50,
    bonusUsd: 5,
    txSignature: `sig-${id}`,
    createdAt: "2026-10-11T09:00:00.000Z",
    creditedAt: "2026-10-11T09:01:00.000Z",
    message: `sentence for ${id}`,
    ...over,
  };
}

/** A thrown API error, in the shape lib/api.ts throws. */
function apiError(status: number, data: unknown): Error {
  return Object.assign(new Error(`API Error: ${status} Whatever`), { status, data });
}

test("the panel is offered only when the server says deposits are live", () => {
  assert.equal(depositsOffered(rails({ deposits: true })), true);
  assert.equal(depositsOffered(rails({ deposits: false })), false);
  assert.equal(depositsOffered(rails()), false);
  assert.equal(depositsOffered(null), false);
  assert.equal(depositsOffered(undefined), false);
  // Anything but true is off.
  assert.equal(depositsOffered(rails({ deposits: "yes" as unknown as boolean })), false);
});

test("the wording of the panel", () => {
  assert.equal(PANEL_TITLE, "Send from an exchange or another wallet");
  assert.equal(SHOW_ADDRESS, "Show my deposit address");
  assert.equal(PREPARE_ADDRESS, "Prepare address");
  assert.equal(CHECK_NOW, "Check now");
  assert.equal(
    SOLANA_ONLY,
    "Send on the Solana network only. A transfer on another network cannot be recovered."
  );
  assert.equal(ONLY_USDC_AND_SOL, "Only USDC and SOL are credited.");
  assert.equal(ONLY_USDC, "Only USDC is credited.");
  assert.equal(
    PREPARE_HINT,
    "If your exchange says this address cannot receive USDC yet, press Prepare address."
  );
  assert.equal(
    PAUSED,
    "Deposits are paused for a moment. Nothing sent to your address is lost. Try again shortly."
  );
});

test("no sentence written here has an em dash", () => {
  for (const [name, value] of Object.entries(sentences)) {
    if (typeof value === "string") assert.equal(value.includes("—"), false, name);
  }
});

test("before an address exists the panel is one button", () => {
  assert.deepEqual(panelView(null), { kind: "none" });
  assert.deepEqual(panelView(undefined), { kind: "none" });
  assert.deepEqual(panelView(answer({ address: null })), { kind: "none" });
  assert.deepEqual(panelView(answer({ address: "" })), { kind: "none" });
  assert.deepEqual(panelView(answer({ address: "   " })), { kind: "none" });
});

test("with an address: the address in full, the API's sentence, then the two warnings", () => {
  const view = panelView(answer());
  assert.deepEqual(view, {
    kind: "address",
    address: ADDRESS,
    message: "the API's sentence",
    notes: [SOLANA_ONLY, ONLY_USDC_AND_SOL],
    prepareHint: PREPARE_HINT,
  });
});

test("when SOL is not offered the panel says only USDC is credited", () => {
  const usdcOnly = answer({
    assets: [
      { asset: "USDC", accountOpen: true },
      { asset: "SOL", offered: false },
    ],
  });
  const view = panelView(usdcOnly);
  assert.equal(view.kind, "address");
  if (view.kind !== "address") return;
  assert.deepEqual(view.notes, [SOLANA_ONLY, ONLY_USDC]);
  assert.equal(solOffered(usdcOnly), false);
  // An answer that does not mention SOL does not offer it.
  assert.equal(solOffered(answer({ assets: [{ asset: "USDC", accountOpen: true }] })), false);
  assert.equal(solOffered(null), false);
  assert.equal(solOffered(answer()), true);
});

test("Prepare address is offered only while the address cannot receive USDC", () => {
  const open = answer({
    assets: [
      { asset: "USDC", accountOpen: true },
      { asset: "SOL", offered: true },
    ],
  });
  const view = panelView(open);
  assert.equal(view.kind === "address" && view.prepareHint, null);
  assert.equal(usdcAccountOpen(open), true);
  assert.equal(usdcAccountOpen(answer()), false);
  // An answer that does not say leaves the button within reach.
  assert.equal(usdcAccountOpen(answer({ assets: [] })), false);
  assert.equal(usdcAccountOpen(answer({ assets: undefined as unknown as [] })), false);
  const unsaid = panelView(answer({ assets: [] }));
  assert.equal(unsaid.kind === "address" && unsaid.prepareHint, PREPARE_HINT);
});

test("an answer with no sentence gets the API's own wording, never nothing", () => {
  const both = panelView(answer({ message: "" }));
  assert.equal(both.kind === "address" && both.message, SHOWN_AND_HOW);
  const usdcOnly = panelView(
    answer({
      message: "  ",
      assets: [
        { asset: "USDC", accountOpen: true },
        { asset: "SOL", offered: false },
      ],
    })
  );
  assert.equal(usdcOnly.kind === "address" && usdcOnly.message, SHOWN_AND_HOW_USDC_ONLY);
});

test("once prepared, the answer says the USDC account is open and nothing else changes", () => {
  const before = answer();
  const after = withUsdcAccountOpen(before);
  assert.deepEqual(after, {
    ...before,
    assets: [
      { asset: "USDC", accountOpen: true },
      { asset: "SOL", offered: true },
    ],
  });
  assert.equal(usdcAccountOpen(before), false);
  const view = panelView(after);
  assert.equal(view.kind === "address" && view.prepareHint, null);
});

test("a refusal shows the API's sentence", () => {
  const refusal = apiError(403, {
    error: "not_eligible",
    message: "Verify your email or make one purchase first, then prepare the address.",
  });
  assert.deepEqual(afterDepositError(refusal), {
    message: "Verify your email or make one purchase first, then prepare the address.",
    tone: "error",
  });
  const off = apiError(501, { error: "deposits_not_enabled", message: PAUSED });
  assert.deepEqual(afterDepositError(off), { message: PAUSED, tone: "error" });
});

test("a failed call with no sentence says deposits are paused, never a code or an error's text", () => {
  const cases: unknown[] = [
    new Error("API Error: 500 Internal Server Error"),
    new TypeError("Failed to fetch"),
    apiError(502, "<html>Bad Gateway</html>"),
    // The framework's own body is not a sentence written for a customer.
    apiError(500, { statusCode: 500, error: "Internal Server Error", message: "connect ECONNREFUSED" }),
    apiError(503, { error: "chain_unavailable" }),
    apiError(503, { error: "chain_unavailable", message: "" }),
    null,
    undefined,
    "boom",
  ];
  for (const err of cases) {
    assert.deepEqual(afterDepositError(err), { message: PAUSED, tone: "error" });
  }
});

test("a button pressed past the limit for a minute says to wait, and the API's own 429 keeps its sentence", () => {
  // The framework's guard: its body is not a sentence written for a customer.
  const guard = apiError(429, { statusCode: 429, error: "Too Many Requests", message: "Rate limit exceeded, retry in 1 minute" });
  assert.deepEqual(afterDepositError(guard), { message: TOO_OFTEN, tone: "error" });
  assert.doesNotMatch(TOO_OFTEN, /429|limit exceeded/i);
  // The day's limit on opened accounts is the API's refusal, with its sentence.
  const daily = apiError(429, {
    error: "daily_limit",
    message: "The address cannot be prepared right now. Send SOL, or try again later.",
  });
  assert.deepEqual(afterDepositError(daily), {
    message: "The address cannot be prepared right now. Send SOL, or try again later.",
    tone: "error",
  });
});

test("a refusal that says there is no address stops the panel showing one", () => {
  assert.equal(
    hidesAddress(apiError(404, { error: "deposit_address_not_issued", message: "x" })),
    true
  );
  assert.equal(
    hidesAddress(apiError(503, { error: "deposit_address_unavailable", message: "x" })),
    true
  );
  assert.equal(hidesAddress(apiError(503, { error: "chain_unavailable", message: "x" })), false);
  assert.equal(hidesAddress(apiError(429, { error: "daily_limit", message: "x" })), false);
  assert.equal(hidesAddress(new Error("Failed to fetch")), false);
  assert.equal(hidesAddress(null), false);
});

test("issuing that gives an address needs no line; issuing that gives none says so", () => {
  assert.equal(afterIssue(answer()), null);
  assert.deepEqual(afterIssue(answer({ address: null, message: "the API's sentence" })), {
    message: "the API's sentence",
    tone: "error",
  });
  assert.deepEqual(afterIssue(answer({ address: null, message: "" })), {
    message: "Your organization has no deposit address yet.",
    tone: "error",
  });
  assert.deepEqual(afterIssue(null), {
    message: "Your organization has no deposit address yet.",
    tone: "error",
  });
});

test("Prepare address shows the API's sentence", () => {
  assert.deepEqual(afterPrepare({ message: "Your address can now receive USDC." }), {
    message: "Your address can now receive USDC.",
    tone: "success",
  });
  assert.deepEqual(afterPrepare({ message: "" }), {
    message: "Your address can now receive USDC.",
    tone: "success",
  });
  assert.equal(afterPrepare(null).message, "Your address can now receive USDC.");
});

test("Check now shows the API's sentence, and reads the balance again only when something was credited", () => {
  const nothing: DepositCheckResponse = {
    credited: [],
    waiting: [],
    message: "No new transfer yet. Transfers usually arrive within a few minutes.",
  };
  assert.deepEqual(afterCheck(nothing), {
    line: { message: nothing.message, tone: "progress" },
    reloadBalance: false,
  });

  const credited: DepositCheckResponse = {
    credited: [{ asset: "USDC", amount: "50.00", creditedUsd: 50, bonusUsd: 5, txSignature: "sig" }],
    waiting: [],
    message: "Credited $55.00 from your transfer: $50.00 sent and a $5.00 bonus.",
  };
  assert.deepEqual(afterCheck(credited), {
    line: { message: credited.message, tone: "success" },
    reloadBalance: true,
  });

  const waiting: DepositCheckResponse = {
    credited: [],
    waiting: [{ asset: "SOL", amount: "0.5", txSignature: "sig" }],
    message:
      "We have seen your transfer of 0.5 SOL. It is credited as soon as we can get a current SOL price.",
  };
  assert.deepEqual(afterCheck(waiting), {
    line: { message: waiting.message, tone: "progress" },
    reloadBalance: false,
  });

  // An answer that lost its parts still reads as a sentence and reloads nothing.
  assert.deepEqual(afterCheck(null), {
    line: {
      message: "No new transfer yet. Transfers usually arrive within a few minutes.",
      tone: "progress",
    },
    reloadBalance: false,
  });
  assert.equal(afterCheck({ message: "" } as unknown as DepositCheckResponse).reloadBalance, false);
});

test("the list shows the newest few deposits with the API's sentence and when each arrived", () => {
  const many = Array.from({ length: 8 }, (_, i) => deposit(`d${i}`));
  const rows = depositRows(many);
  assert.equal(rows.length, DEPOSITS_SHOWN);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["d0", "d1", "d2", "d3", "d4"]
  );
  assert.deepEqual(rows[0], {
    id: "d0",
    message: "sentence for d0",
    sent: "50.00 USDC",
    arrivedAt: "2026-10-11T09:00:00.000Z",
    tone: "success",
  });
  assert.equal(depositRows(many, 2).length, 2);
  assert.deepEqual(depositRows(null), []);
  assert.deepEqual(depositRows(undefined), []);
  assert.deepEqual(depositRows("nope" as unknown as DepositRecord[]), []);
});

test("a deposit credited since the list was last read means the balance is read again", () => {
  const waiting = { id: "d1", status: "waiting" } as DepositRecord;
  const credited = { id: "d1", status: "credited" } as DepositRecord;
  const other = { id: "d2", status: "credited" } as DepositRecord;
  // The background scan credited it between two reads of the list.
  assert.equal(creditedSince([], [credited]), true);
  assert.equal(creditedSince([waiting], [credited]), true);
  assert.equal(creditedSince([credited], [other, credited]), true);
  // Nothing new is credited: the balance is left alone.
  assert.equal(creditedSince([credited], [credited]), false);
  assert.equal(creditedSince([credited, other], [other]), false);
  assert.equal(creditedSince([], [waiting, { id: "d3", status: "ignored" } as DepositRecord]), false);
  // A list that could not be read, or a row without an id, never asks for a reload.
  assert.equal(creditedSince(null, undefined), false);
  assert.equal(creditedSince([], [{ status: "credited" } as DepositRecord]), false);
});

test("each status has its tone, and a date that cannot be read is left out", () => {
  const rows = depositRows([
    deposit("a", { status: "credited" }),
    deposit("b", { status: "waiting", creditedUsd: null, bonusUsd: null, creditedAt: null }),
    deposit("c", { status: "ignored", creditedUsd: null, bonusUsd: null, creditedAt: null }),
    deposit("d", { createdAt: "not a date" }),
  ]);
  assert.deepEqual(
    rows.map((row) => row.tone),
    ["success", "progress", "error", "success"]
  );
  assert.equal(rows[3]?.arrivedAt, null);
});

test("a deposit with no sentence gets the API's wording, never a status word", () => {
  const rows = depositRows([
    deposit("plain", { message: "", bonusUsd: 0 }),
    deposit("bonus", { message: "" }),
    deposit("small", { message: "", status: "ignored", creditedUsd: null, bonusUsd: null }),
    deposit("sol", {
      message: "",
      status: "waiting",
      asset: "SOL",
      amount: "0.5",
      creditedUsd: null,
      bonusUsd: null,
    }),
    deposit("usdc", { message: "", status: "waiting", creditedUsd: null, bonusUsd: null }),
    deposit("nofigure", { message: "", creditedUsd: null, bonusUsd: null }),
  ], 10);
  assert.deepEqual(
    rows.map((row) => row.message),
    [
      "Credited $50.00.",
      "Credited $55.00: $50.00 sent and a $5.00 bonus.",
      "This transfer was too small to credit.",
      "We have seen your transfer of 0.5 SOL. It is credited as soon as we can get a current SOL price.",
      "We have seen your transfer of 50.00 USDC. It is not credited yet.",
      "We credited your transfer of 50.00 USDC.",
    ]
  );
});

test("a row without an id is dropped", () => {
  const rows = depositRows([
    deposit("ok"),
    deposit("", {}),
    null as unknown as DepositRecord,
    { ...deposit("x"), id: 7 as unknown as string },
  ]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["ok"]
  );
});

test("the copy failure line is a sentence of the page's own", () => {
  assert.equal(COPY_FAILED, "The address could not be copied. Select it and copy it by hand.");
});

test("reading the address again takes the fresh answer, and never takes the address away", () => {
  const shown = answer();
  const open = answer({
    assets: [
      { asset: "USDC", accountOpen: true },
      { asset: "SOL", offered: true },
    ],
  });
  // A transfer of USDC opened the account: "Prepare address" goes away.
  const next = panelView(refreshedAddress(shown, open));
  assert.equal(next.kind === "address" && next.prepareHint, null);
  assert.equal(refreshedAddress(shown, open), open);
  // An answer with no address, or none at all, leaves what is on the page.
  assert.equal(refreshedAddress(shown, answer({ address: null })), shown);
  assert.equal(refreshedAddress(shown, null), shown);
  assert.equal(refreshedAddress(shown, undefined), shown);
  assert.equal(refreshedAddress(null, answer({ address: null })), null);
});

test("copying the address clears a line that said it could not be copied, and no other", () => {
  assert.equal(lineAfterCopied({ message: COPY_FAILED, tone: "error" }), null);
  const other = { message: "the API's sentence", tone: "error" as const };
  assert.equal(lineAfterCopied(other), other);
  assert.equal(lineAfterCopied(null), null);
});
