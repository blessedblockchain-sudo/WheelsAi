/**
 * Adding credits from a wallet: what the Billing page offers, says and follows. Run with:
 *   cd apps/web && npx tsx --test src/lib/wallet-topup.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { BillingRails, TopupRecord, TopupStatus } from "./api";
import {
  CARRY_ON_WITHIN_MS,
  FOLLOW_FOR_MS,
  NOT_CONFIRMED,
  PAUSED,
  WALLET_DECLINED,
  WALLET_DID_NOT_SIGN,
  afterPrepareError,
  afterReconcileError,
  afterSettle,
  afterSignError,
  afterSubmitError,
  apiRefusal,
  assetToPayWith,
  isFinal,
  isInFlight,
  isWalletDecline,
  lineFor,
  lineForPrepared,
  lineWhileFollowing,
  shouldCarryOn,
  shouldKeepFollowing,
  topupsToFollow,
  walletAssetsOffered,
} from "./wallet-topup";
import * as sentences from "./wallet-topup";

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

function topup(id: string, status: TopupStatus, message = `sentence for ${id}`): TopupRecord {
  return {
    id,
    status,
    message,
    asset: "USDC",
    amountUsd: 10,
    bonusUsd: 0,
    depositAddress: "deposit",
    payerAddress: "payer",
    createdAt: "2026-10-10T00:00:00.000Z",
    expiresAt: "2026-10-10T00:02:00.000Z",
  };
}

/** The shape lib/api.ts throws for a refusal. */
function refusal(status: number, data: unknown): Error {
  return Object.assign(new Error(`API Error: ${status}`), { status, data });
}

const STATUS_WORDS = /\b(prepared|submitting|submitted|credited|failed|expired)\b/;

test("assets come from rails, USDC first, and only when the wallet rail is live", () => {
  assert.deepEqual(walletAssetsOffered(rails()), ["USDC"]);
  assert.deepEqual(walletAssetsOffered(rails({ walletAssets: ["SOL", "USDC"] })), ["USDC", "SOL"]);
  assert.deepEqual(walletAssetsOffered(rails({ walletAssets: ["SOL"] })), ["SOL"]);
  // An asset this page cannot pay with is not offered.
  assert.deepEqual(walletAssetsOffered(rails({ walletAssets: ["USDC", "BONK"] })), ["USDC"]);
  assert.deepEqual(walletAssetsOffered(rails({ wallet: false, walletAssets: ["USDC", "SOL"] })), []);
  assert.deepEqual(walletAssetsOffered(null), []);
  assert.deepEqual(walletAssetsOffered(undefined), []);
});

test("USDC is chosen first; a choice that is no longer offered falls back", () => {
  assert.equal(assetToPayWith(["USDC", "SOL"], null), "USDC");
  assert.equal(assetToPayWith(["USDC", "SOL"], "SOL"), "SOL");
  assert.equal(assetToPayWith(["USDC"], "SOL"), "USDC");
  assert.equal(assetToPayWith([], "SOL"), null);
});

test("in flight is submitting or submitted; final is credited, failed or expired", () => {
  const all: TopupStatus[] = ["prepared", "submitting", "submitted", "credited", "failed", "expired"];
  assert.deepEqual(all.filter(isInFlight), ["submitting", "submitted"]);
  assert.deepEqual(all.filter(isFinal), ["credited", "failed", "expired"]);
});

test("on opening the page only top-ups in flight are followed, the newest last", () => {
  const list = [
    topup("newest", "submitted"),
    topup("unsigned", "prepared"),
    topup("done", "credited"),
    topup("older", "submitting"),
    topup("gone", "expired"),
    topup("bad", "failed"),
  ];
  assert.deepEqual(topupsToFollow(list).map((t) => t.id), ["older", "newest"]);
  assert.deepEqual(topupsToFollow([]), []);
  assert.deepEqual(topupsToFollow(null), []);
});

test("the line at each step is the API's sentence, with a tone from the status", () => {
  const sol = "1 SOL = $110.25. This price holds for 60 seconds. Confirm the transfer in your wallet.";
  assert.deepEqual(lineForPrepared({ message: sol }), { message: sol, tone: "progress" });
  assert.deepEqual(lineFor({ status: "submitted", message: "On its way." }), { message: "On its way.", tone: "progress" });
  assert.deepEqual(lineFor({ status: "credited", message: "Added $10.00 in credits." }), {
    message: "Added $10.00 in credits.",
    tone: "success",
  });
  assert.deepEqual(lineFor({ status: "failed", message: "It failed." }), { message: "It failed.", tone: "error" });
  assert.deepEqual(lineFor({ status: "expired", message: "Out of time." }), { message: "Out of time.", tone: "error" });
});

test("an answer with no sentence never puts a status word in front of a person", () => {
  for (const status of ["prepared", "submitting", "submitted", "credited", "failed", "expired", "something_new"]) {
    for (const message of [undefined, "", "   ", 42]) {
      const line = lineFor({ status, message });
      assert.ok(line.message.length > 0);
      assert.doesNotMatch(line.message, STATUS_WORDS, `${status}: ${line.message}`);
      assert.doesNotMatch(line.message, /something_new/);
    }
  }
  assert.doesNotMatch(lineForPrepared({ message: "" }).message, STATUS_WORDS);
});

test("following stops at credited, failed and expired, and only credited reads the balance again", () => {
  assert.deepEqual(afterSettle({ status: "credited", message: "Added." }), {
    line: { message: "Added.", tone: "success" },
    follow: false,
    reloadBalance: true,
  });
  for (const status of ["failed", "expired"] as const) {
    const next = afterSettle({ status, message: "Ended." });
    assert.equal(next.follow, false);
    assert.equal(next.reloadBalance, false);
    assert.equal(next.line.tone, "error");
  }
  for (const status of ["submitting", "submitted", "prepared"] as const) {
    const next = afterSettle({ status, message: "Waiting." });
    assert.equal(next.follow, true, status);
    assert.equal(next.reloadBalance, false);
    assert.equal(next.line.tone, "progress");
  }
});

test("a refusal is read from the API error; anything else is not a refusal", () => {
  assert.deepEqual(apiRefusal(refusal(409, { error: "wallet_balance_short", message: "Too little." })), {
    status: 409,
    code: "wallet_balance_short",
    message: "Too little.",
  });
  assert.equal(apiRefusal(refusal(502, "<html>Bad Gateway</html>")), null);
  assert.equal(apiRefusal(refusal(500, null)), null);
  // The framework's own error body carries raw text, not a sentence for a customer.
  assert.equal(
    apiRefusal(refusal(500, { statusCode: 500, error: "Internal Server Error", message: "connect ECONNREFUSED 10.0.0.5:5432" })),
    null
  );
  assert.equal(apiRefusal(new TypeError("Failed to fetch")), null);
  assert.equal(apiRefusal("nope"), null);
  assert.equal(apiRefusal(null), null);
});

test("prepare refused: the API's sentence; no answer: payments are paused", () => {
  const price = "We could not get a current SOL price, so nothing was prepared. Pay with USDC, or try again in a minute.";
  assert.deepEqual(afterPrepareError(refusal(503, { error: "price_unavailable", message: price })), {
    message: price,
    tone: "error",
  });
  assert.deepEqual(afterPrepareError(new TypeError("Failed to fetch")), { message: PAUSED, tone: "error" });
  assert.deepEqual(
    afterPrepareError(refusal(500, { statusCode: 500, error: "Internal Server Error", message: "PrismaClientKnownRequestError" })),
    { message: PAUSED, tone: "error" }
  );
  // A code with no sentence is not shown as a code.
  assert.deepEqual(afterPrepareError(refusal(400, { error: "invalid_amount" })), { message: PAUSED, tone: "error" });
});

test("a wallet that declines gets the page's own sentence; its error text is never shown", () => {
  const declines = [
    Object.assign(new Error("User rejected the request."), { name: "WalletSignTransactionError" }),
    { code: 4001, message: "nope" },
    new Error("Transaction cancelled"),
    new Error("Approval Denied"),
    Object.assign(new Error("wrapped"), { error: { code: 4001 } }),
  ];
  for (const err of declines) {
    assert.equal(isWalletDecline(err), true);
    assert.deepEqual(afterSignError(err), { message: WALLET_DECLINED, tone: "error" });
  }
  assert.equal(WALLET_DECLINED, "You cancelled the transfer in your wallet. Nothing was taken.");

  const raw = new Error("Ledger device: UNKNOWN_ERROR (0x6511) at hid://1234");
  assert.equal(isWalletDecline(raw), false);
  assert.deepEqual(afterSignError(raw), { message: WALLET_DID_NOT_SIGN, tone: "error" });
  assert.equal(isWalletDecline(undefined), false);
  assert.equal(isWalletDecline("rejected"), false);
});

test("submit refused with a sentence ends the payment, unless it is already being confirmed", () => {
  const mismatch = "The signed transfer does not match the one we prepared, so it was not sent. Nothing was taken. Start the top-up again.";
  assert.deepEqual(afterSubmitError(refusal(400, { error: "message_mismatch", message: mismatch })), {
    line: { message: mismatch, tone: "error" },
    follow: false,
    reloadBalance: false,
  });
  const paused = "Wallet payments are paused for a moment. Nothing was taken. Try again shortly.";
  assert.equal(afterSubmitError(refusal(503, { error: "chain_unavailable", message: paused })).follow, false);
  const already = "This top-up is already being confirmed. You do not need to send it again.";
  for (const code of ["in_flight", "duplicate_signature"]) {
    assert.deepEqual(afterSubmitError(refusal(409, { error: code, message: already })), {
      line: { message: already, tone: "progress" },
      follow: true,
      reloadBalance: false,
    });
  }
});

test("submit with no answer decides nothing: the top-up is followed and no raw text is shown", () => {
  const lost = [
    new TypeError("Failed to fetch"),
    refusal(502, "<html>Bad Gateway</html>"),
    refusal(500, { error: "Internal Server Error" }),
    refusal(504, null),
    refusal(500, { statusCode: 500, error: "Internal Server Error", message: "connect ECONNREFUSED 10.0.0.5:5432" }),
    refusal(500, { error: "internal_error", message: "Something broke." }),
  ];
  for (const err of lost) {
    const next = afterSubmitError(err);
    assert.equal(next.follow, true);
    assert.deepEqual(next.line, { message: NOT_CONFIRMED, tone: "progress" });
  }
  // It was signed, so this sentence must not claim that nothing was taken.
  assert.doesNotMatch(NOT_CONFIRMED, /nothing was taken/i);
});

test("while following, only a refusal about this top-up stops it; a passing fault is asked again", () => {
  assert.deepEqual(afterReconcileError(refusal(404, { error: "topup_not_found", message: "Not found." })), {
    follow: false,
    line: { message: "Not found.", tone: "error" },
  });
  assert.deepEqual(afterReconcileError(refusal(403, { error: "forbidden" })), { follow: false, line: null });
  for (const err of [
    new TypeError("Failed to fetch"),
    refusal(503, { error: "chain_unavailable", message: "Paused." }),
    refusal(429, { error: "rate_limited", message: "Slow down." }),
    refusal(502, "<html>"),
  ]) {
    assert.deepEqual(afterReconcileError(err), { follow: true, line: null });
  }
});

test("a pack chosen before the wallet connected is paid for once it connects, within two minutes", () => {
  const askedAt = 1_000_000;
  assert.equal(shouldCarryOn({ askedAt }, true, askedAt + 5_000), true);
  assert.equal(shouldCarryOn({ askedAt }, false, askedAt + 5_000), false);
  assert.equal(shouldCarryOn(null, true, askedAt), false);
  assert.equal(shouldCarryOn({ askedAt }, true, askedAt + CARRY_ON_WITHIN_MS), true);
  // A wallet connected much later for something else does not start a payment.
  assert.equal(shouldCarryOn({ askedAt }, true, askedAt + CARRY_ON_WITHIN_MS + 1), false);
  assert.equal(shouldCarryOn({ askedAt }, true, askedAt - 1), false);
});

test("a top-up is not followed for ever: the page stops asking after ten minutes", () => {
  const since = 5_000_000;
  assert.equal(shouldKeepFollowing(since, since), true);
  assert.equal(shouldKeepFollowing(since, since + FOLLOW_FOR_MS - 1), true);
  assert.equal(shouldKeepFollowing(since, since + FOLLOW_FOR_MS), false);
  assert.equal(shouldKeepFollowing(since, since + FOLLOW_FOR_MS * 100), false);
  // A clock that went backwards does not keep it going.
  assert.equal(shouldKeepFollowing(since, since - 1), false);
  assert.equal(FOLLOW_FOR_MS, 10 * 60_000);
});

test("with one status line, a top-up still on its way never replaces another one's line", () => {
  const waiting = { line: { message: "Being confirmed.", tone: "progress" as const }, follow: true };
  const added = { line: { message: "Added $10.00 in credits.", tone: "success" as const }, follow: false };

  // Nothing shown, or its own line: the answer is written and tagged with the top-up.
  assert.deepEqual(lineWhileFollowing(null, "a", waiting), { ...waiting.line, topupId: "a" });
  assert.deepEqual(
    lineWhileFollowing({ message: "Sent.", tone: "progress", topupId: "a" }, "a", waiting),
    { ...waiting.line, topupId: "a" }
  );

  // The price about to be signed for another top-up, a line about no top-up, and another top-up's
  // "credits added" all stay.
  const price = { message: "1 SOL = $110.25. This price holds for 60 seconds.", tone: "progress" as const, topupId: "b" };
  assert.equal(lineWhileFollowing(price, "a", waiting), price);
  const declined = { message: WALLET_DECLINED, tone: "error" as const };
  assert.equal(lineWhileFollowing(declined, "a", waiting), declined);
  const done = { message: "Added $55.00 in credits.", tone: "success" as const, topupId: "b" };
  assert.equal(lineWhileFollowing(done, "a", waiting), done);

  // How a top-up ended is always shown.
  assert.deepEqual(lineWhileFollowing(price, "a", added), { ...added.line, topupId: "a" });
  assert.deepEqual(
    lineWhileFollowing(declined, "a", { line: { message: "Not found.", tone: "error" }, follow: false }),
    { message: "Not found.", tone: "error", topupId: "a" }
  );

  // A passing fault has no line: what is shown stays.
  assert.equal(lineWhileFollowing(price, "a", { line: null, follow: true }), price);
  assert.equal(lineWhileFollowing(null, "a", { line: null, follow: false }), null);
});

test("no sentence this file writes has an em dash or a status word", () => {
  const written: string[] = [];
  for (const value of Object.values(sentences) as unknown[]) {
    if (typeof value === "string") written.push(value);
  }
  assert.ok(written.length >= 6);
  for (const sentence of written) {
    assert.doesNotMatch(sentence, /—|–/, sentence);
    assert.doesNotMatch(sentence, STATUS_WORDS, sentence);
  }
});
