/**
 * Drives apps/api/src/services/topupSentences.ts: every sentence a
 * customer reads about a wallet top-up, word for word, and the choice of
 * sentence for a stored row.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  formatHeldAmount,
  formatUsdCents,
  formatUsdRate,
  TOPUP_FAILURE_CODES,
  topupRowSentence,
  topupSentence,
  type TopupRowForSentence,
  type TopupSentenceCode,
} from "../services/topupSentences.js";

const PAUSED =
  "Wallet payments are paused for a moment. Nothing was taken. Try again shortly.";
const ALREADY =
  "This top-up is already being confirmed. You do not need to send it again.";

// The wording of the contract, one entry per code.
const FIXED: Record<Exclude<TopupSentenceCode, "prepared_sol" | "credited" | "wallet_balance_short" | "invalid_amount">, string> = {
  prepared_usdc: "Confirm the transfer in your wallet.",
  prepared_usdc_opens_account:
    "Confirm the transfer in your wallet. This first USDC payment also opens your organization's USDC account, which costs your wallet about 0.002 SOL once.",
  in_flight:
    "Your transfer was sent and is being confirmed. Your credits appear as soon as it is, usually within a minute. You can leave this page.",
  send_unconfirmed:
    "We could not confirm that the network took this transfer. If it goes through, your credits are added within a few minutes. If it does not, nothing is taken.",
  expired_unsigned:
    "This top-up ran out of time before it was sent. Nothing was taken. Start it again.",
  expired_unsigned_sol:
    "This top-up ran out of time before it was sent. Nothing was taken. Start it again for a fresh price.",
  never_landed:
    "The network did not take this transfer, so nothing was taken. Check your wallet balance and start the top-up again.",
  failed_on_chain:
    "This transfer failed on the network, so no payment was taken. Check your wallet balance and start the top-up again.",
  did_not_go_through: "This top-up did not go through. Start it again.",
  unauthenticated: "Sign in to add credits.",
  invalid_payload: "We could not read that request. Start the top-up again.",
  wallet_required:
    "Connect a Solana wallet to pay. The wallet you connect signs the transfer.",
  invalid_payer_address:
    "That is not a Solana wallet address. Connect a wallet and try again.",
  asset_unavailable: "SOL is not available here right now. Pay with USDC.",
  price_unavailable:
    "We could not get a current SOL price, so nothing was prepared. Pay with USDC, or try again in a minute.",
  chain_unavailable: PAUSED,
  rpc_unavailable: PAUSED,
  wallet_topups_not_enabled: PAUSED,
  message_mismatch:
    "The signed transfer does not match the one we prepared, so it was not sent. Nothing was taken. Start the top-up again.",
  unreadable_transaction:
    "We could not read the signed transfer, so it was not sent. Nothing was taken. Start the top-up again.",
  duplicate_signature: ALREADY,
  in_flight_conflict: ALREADY,
  topup_not_found: "We could not find that top-up. Start a new one.",
  internal_error:
    "Something went wrong on our side. Check your top-ups before you try again.",
  wallet_in_use:
    "This wallet already signs in to another WheelsAI account. Use that account, or link a different wallet.",
  invalid_nonce: "That request to link a wallet has expired. Try again.",
  invalid_signature: "The wallet's signature could not be checked. Try again.",
  invalid_wallet_address:
    "That is not a Solana wallet address. Connect a wallet and try again.",
  linked: "Wallet linked.",
};

test("every fixed sentence is the contract's wording", () => {
  for (const [code, sentence] of Object.entries(FIXED)) {
    assert.equal(topupSentence(code as TopupSentenceCode), sentence, code);
  }
});

test("the sentences with values read as the contract writes them", () => {
  assert.equal(
    topupSentence("prepared_sol", { solPriceUsd: 110.25, holdSeconds: 60 }),
    "1 SOL = $110.25. This price holds for 60 seconds. Confirm the transfer in your wallet.",
  );
  assert.equal(
    topupSentence("credited", { paidCents: 5_000n, bonusCents: 500n }),
    "Added $55.00 in credits: $50.00 paid and a $5.00 bonus.",
  );
  assert.equal(
    topupSentence("credited", { paidCents: 1_000n, bonusCents: 0n }),
    "Added $10.00 in credits.",
  );
  assert.equal(
    topupSentence("invalid_amount", { minUsd: 5, maxUsd: 10_000 }),
    "Choose an amount between $5 and $10,000.",
  );
  assert.equal(
    topupSentence("wallet_balance_short", { heldRaw: 3_200_000n, asset: "USDC" }),
    "This wallet holds 3.20 USDC, which is less than this top-up needs. Choose a smaller amount or another wallet.",
  );
  assert.equal(
    topupSentence("wallet_balance_short", { heldRaw: 41_299_999n, asset: "SOL" }),
    "This wallet holds 0.0412 SOL, which is less than this top-up needs. Choose a smaller amount or another wallet.",
  );
});

test("no sentence carries an em dash, a raw status word or a blank", () => {
  const all = [
    ...Object.keys(FIXED).map((code) => topupSentence(code as TopupSentenceCode)),
    topupSentence("prepared_sol", { solPriceUsd: 200 }),
    topupSentence("credited", { paidCents: 5_000n, bonusCents: 500n }),
    topupSentence("invalid_amount"),
    topupSentence("wallet_balance_short"),
  ];
  for (const sentence of all) {
    assert.ok(sentence.length > 0);
    assert.ok(!/[–—]/.test(sentence), sentence);
    assert.ok(
      !/\b(submitting|submitted|unsigned_expired|never_landed|failed_on_chain|undefined|null|NaN)\b/.test(
        sentence,
      ),
      sentence,
    );
    assert.ok(/[.]$/.test(sentence), sentence);
  }
});

test("money is written as dollars and cents from whole numbers", () => {
  assert.equal(formatUsdCents(0n), "$0.00");
  assert.equal(formatUsdCents(5n), "$0.05");
  assert.equal(formatUsdCents(5_500n), "$55.00");
  assert.equal(formatUsdCents(1_000_000n), "$10,000.00");
  assert.equal(formatUsdCents(123_456_789n), "$1,234,567.89");
  assert.equal(formatUsdRate(110.25), "$110.25");
  assert.equal(formatUsdRate(199.999), "$200.00");
  assert.equal(formatUsdRate(Number.NaN), "$0.00");
});

test("a held amount is rounded down, never up", () => {
  assert.equal(formatHeldAmount(3_209_999n, "USDC"), "3.20");
  assert.equal(formatHeldAmount(0n, "USDC"), "0.00");
  assert.equal(formatHeldAmount(1_234_567_890_000n, "USDC"), "1,234,567.89");
  assert.equal(formatHeldAmount(999_999_999n, "SOL"), "0.9999");
  assert.equal(formatHeldAmount(2_500_000_000n, "SOL"), "2.5000");
  assert.equal(formatHeldAmount(-1n, "SOL"), "0.0000");
});

function row(over: Partial<TopupRowForSentence> = {}): TopupRowForSentence {
  return {
    status: "prepared",
    asset: "USDC",
    amountUsdCents: 5_000n,
    bonusCents: 500n,
    quotedSolPriceUsd: null,
    txSignature: null,
    failureCode: null,
    ...over,
  };
}

test("a stored row's sentence follows its status", () => {
  assert.equal(topupRowSentence(row()), FIXED.prepared_usdc);
  assert.equal(
    topupRowSentence(row({ asset: "SOL", quotedSolPriceUsd: 110.25 })),
    "1 SOL = $110.25. This price holds for 60 seconds. Confirm the transfer in your wallet.",
  );
  assert.equal(
    topupRowSentence(row({ status: "submitted", txSignature: "sig" })),
    FIXED.in_flight,
  );
  assert.equal(
    topupRowSentence(row({ status: "credited", txSignature: "sig" })),
    "Added $55.00 in credits: $50.00 paid and a $5.00 bonus.",
  );
});

test("a row left in submitting never claims the transfer was sent", () => {
  assert.equal(
    topupRowSentence(row({ status: "submitting", txSignature: "sig" })),
    FIXED.send_unconfirmed,
  );
});

test("an ended row's sentence follows its reason code", () => {
  const { unsignedExpired, neverLanded, failedOnChain } = TOPUP_FAILURE_CODES;
  assert.equal(
    topupRowSentence(row({ status: "expired", failureCode: unsignedExpired })),
    FIXED.expired_unsigned,
  );
  assert.equal(
    topupRowSentence(
      row({ status: "expired", asset: "SOL", failureCode: unsignedExpired }),
    ),
    FIXED.expired_unsigned_sol,
  );
  assert.equal(
    topupRowSentence(
      row({ status: "expired", txSignature: "sig", failureCode: neverLanded }),
    ),
    FIXED.never_landed,
  );
  assert.equal(
    topupRowSentence(
      row({ status: "failed", txSignature: "sig", failureCode: failedOnChain }),
    ),
    FIXED.failed_on_chain,
  );
});

test("an older row with no code only says nothing was taken when that is certain", () => {
  // Expired and never signed: nothing was ever sent.
  assert.equal(
    topupRowSentence(row({ status: "expired" })),
    FIXED.expired_unsigned,
  );
  // Expired with a signature and no code: the older code could expire a
  // transfer that had landed, so nothing is promised.
  assert.equal(
    topupRowSentence(row({ status: "expired", txSignature: "sig" })),
    FIXED.did_not_go_through,
  );
  assert.equal(
    topupRowSentence(row({ status: "failed", txSignature: "sig" })),
    FIXED.did_not_go_through,
  );
  assert.equal(
    topupRowSentence(row({ status: "failed", failureCode: "something_new" })),
    FIXED.did_not_go_through,
  );
  assert.equal(
    topupRowSentence(row({ status: "a_status_from_the_future" })),
    FIXED.did_not_go_through,
  );
});
