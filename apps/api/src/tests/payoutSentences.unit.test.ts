// Every sentence a creator reads about a payout (services/payoutSentences.ts),
// word for word, and that nothing recorded for operators can pick a word.
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import {
  formatUsd,
  payoutFailureMessage,
  payoutRefusalMessage,
  payoutRequestedMessage,
  payoutStatusMessage,
  payoutWaitingMessage,
  PAYOUT_FAILURE_CODES,
  PAYOUT_REFUSAL_STATUS,
  PAYOUT_WAITING_REASONS,
  PAYOUTS_UNAVAILABLE_MESSAGE,
  type PayoutRefusal,
} from "../services/payoutSentences.js";
import { payoutFailureMessage as fromRequests } from "../services/payoutRequests.js";

test("money is written as $41.20, from whole cents", () => {
  assert.equal(formatUsd(4120n), "$41.20");
  assert.equal(formatUsd(4120), "$41.20");
  assert.equal(formatUsd(500), "$5.00");
  assert.equal(formatUsd(310n), "$3.10");
  assert.equal(formatUsd(5n), "$0.05");
  assert.equal(formatUsd(0n), "$0.00");
  assert.equal(formatUsd(50_000n), "$500.00");
  assert.equal(formatUsd(100_000n), "$1,000.00");
  assert.equal(formatUsd(123_456_789n), "$1,234,567.89");
  assert.equal(formatUsd(-250n), "-$2.50");
  // Not a whole number of cents: nothing is rounded into a number nobody stored.
  for (const bad of [41.2, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(formatUsd(bad), "$0.00");
});

const REFUSALS: Array<{ refusal: PayoutRefusal; status: number; sentence: string }> = [
  { refusal: { code: "payouts_unavailable" }, status: 503, sentence: PAYOUTS_UNAVAILABLE_MESSAGE },
  { refusal: { code: "invalid_payload" }, status: 400, sentence: "We could not read that request. Check the amount and try again." },
  {
    refusal: { code: "payout_method_unavailable" },
    status: 400,
    sentence: "SOL payouts are not available right now. Choose USDC or credits.",
  },
  {
    refusal: { code: "payout_in_progress" },
    status: 409,
    sentence: "You already have a payout in progress. Wait for it to finish, or cancel it if it has not been sent.",
  },
  {
    refusal: { code: "payout_below_minimum", balanceCents: 310n },
    status: 400,
    sentence: "The smallest payout is $5.00. You have $3.10 available.",
  },
  { refusal: { code: "payout_below_minimum" }, status: 400, sentence: "The smallest payout is $5.00." },
  {
    refusal: { code: "payout_above_balance", balanceCents: 4120n },
    status: 400,
    sentence: "You have $41.20 available. Request that amount or less.",
  },
  {
    refusal: { code: "payout_above_limit", perPayoutCents: 50_000n },
    status: 400,
    sentence: "The most for one payout to a wallet is $500.00. Request that amount or less; the rest stays in your earnings.",
  },
  {
    refusal: { code: "payout_daily_limit" },
    status: 409,
    sentence:
      "You have reached today's limit for payouts to a wallet. You can request more after midnight UTC, or take a payout as credits now.",
  },
  { refusal: { code: "payout_address_required" }, status: 400, sentence: "Enter the wallet address to send this payout to." },
  {
    refusal: { code: "invalid_payout_address", problem: "not_an_address" },
    status: 400,
    sentence: "That is not a Solana wallet address. Check it and try again.",
  },
  {
    refusal: { code: "invalid_payout_address", problem: "not_a_wallet" },
    status: 400,
    sentence: "That address is a token account or a program, not a wallet. Enter the wallet address itself.",
  },
  {
    refusal: { code: "invalid_payout_address", problem: "platform" },
    status: 400,
    sentence: "That address belongs to WheelsAI, not to you. Enter your own wallet address.",
  },
  {
    refusal: { code: "payout_check_unavailable" },
    status: 503,
    sentence:
      "Payouts to a wallet are paused for a moment. Nothing was reserved and your earnings are unchanged. Try again shortly.",
  },
  {
    refusal: { code: "payout_reservation_conflict" },
    status: 409,
    sentence: "Your payout balance changed while this request was processing. Please try again.",
  },
];

test("every refusal has its status and its sentence, word for word", () => {
  for (const { refusal, status, sentence } of REFUSALS) {
    assert.equal(payoutRefusalMessage(refusal), sentence, refusal.code);
    assert.equal(PAYOUT_REFUSAL_STATUS[refusal.code], status, refusal.code);
  }
  // Every code in the table is covered above.
  assert.deepEqual(Object.keys(PAYOUT_REFUSAL_STATUS).sort(), [...new Set(REFUSALS.map((r) => r.refusal.code))].sort());
  // An address problem nobody knows still gets a sentence about the address.
  assert.equal(
    payoutRefusalMessage({ code: "invalid_payout_address", problem: "??" as any }),
    "That is not a Solana wallet address. Check it and try again.",
  );
});

test("the sentences are plain: no em dash, no code, no processor word", () => {
  const all = [
    ...REFUSALS.map((r) => payoutRefusalMessage(r.refusal)),
    payoutRequestedMessage({ payoutMethod: "crypto_usdc", amountCents: 4120n, remainingCents: 0n, atCap: false }),
    payoutRequestedMessage({ payoutMethod: "crypto_sol", amountCents: 50_000n, remainingCents: 24_000n, atCap: true }),
    payoutRequestedMessage({ payoutMethod: "credits", amountCents: 4120n, remainingCents: 0n, atCap: false }),
    payoutWaitingMessage("wallet_low")!,
    ...PAYOUT_FAILURE_CODES.map((code) => payoutFailureMessage(null, code)),
  ];
  for (const sentence of all) {
    assert.ok(sentence.length > 0);
    assert.ok(!sentence.includes("—") && !sentence.includes("–"), sentence);
    assert.doesNotMatch(sentence, /_|prisma|P2002|RPC|lamport|blockhash|undefined|null|NaN|\{|\}/i, sentence);
    assert.match(sentence, /\.$/, sentence);
  }
});

test("a request that went through", () => {
  assert.equal(
    payoutRequestedMessage({ payoutMethod: "crypto_usdc", amountCents: 4120n, remainingCents: 0n, atCap: false }),
    "Payout of $41.20 requested. It is usually sent within a few minutes.",
  );
  assert.equal(
    payoutRequestedMessage({ payoutMethod: "crypto_sol", amountCents: 4120n, remainingCents: 900n, atCap: false }),
    "Payout of $41.20 requested. It is usually sent within a few minutes.",
  );
  assert.equal(
    payoutRequestedMessage({ payoutMethod: "crypto_usdc", amountCents: 50_000n, remainingCents: 24_000n, atCap: true }),
    "Requested $500.00, the most for one payout to a wallet. $240.00 stays in your earnings.",
  );
  // At the cap with nothing left over: there is no "stays" to speak of.
  assert.equal(
    payoutRequestedMessage({ payoutMethod: "crypto_usdc", amountCents: 50_000n, remainingCents: 0n, atCap: true }),
    "Payout of $500.00 requested. It is usually sent within a few minutes.",
  );
  assert.equal(
    payoutRequestedMessage({ payoutMethod: "credits", amountCents: 4120n, remainingCents: 0n, atCap: false }),
    "Payout of $41.20 requested as credits.",
  );
  // Credits have no cap, whatever the flag says.
  assert.equal(
    payoutRequestedMessage({ payoutMethod: "credits", amountCents: 50_000n, remainingCents: 100n, atCap: true }),
    "Payout of $500.00 requested as credits.",
  );
});

test("a pending payout with any waiting reason gets the one waiting sentence", () => {
  const sentence = "This payout is waiting to be sent. You can cancel it and keep your earnings.";
  for (const reason of [...PAYOUT_WAITING_REASONS, "a reason added later"]) {
    assert.equal(payoutWaitingMessage(reason), sentence);
  }
  for (const none of [null, undefined, "", "  ", 3 as any]) assert.equal(payoutWaitingMessage(none), null);
  assert.deepEqual([...PAYOUT_WAITING_REASONS], ["wallet_low", "daily_limit_reached", "price_unavailable", "chain_unavailable"]);
});

test("a failed payout with a code gets the code's sentence, whatever was recorded", () => {
  const raw = 'SendTransactionError: 429 https://rpc.example {"InstructionError":[0,{"Custom":1}]}';
  assert.equal(
    payoutFailureMessage(raw, "could_not_send"),
    "This payout could not be sent to that wallet address. The amount is back in your earnings.",
  );
  assert.match(payoutFailureMessage(raw, "invalid_address"), /not valid/);
  assert.match(payoutFailureMessage(raw, "missing_address"), /no wallet address/);
  assert.match(payoutFailureMessage(raw, "unsupported_method"), /not supported/);
  assert.deepEqual([...PAYOUT_FAILURE_CODES], ["could_not_send", "invalid_address", "missing_address", "unsupported_method"]);
  for (const code of PAYOUT_FAILURE_CODES) {
    const sentence = payoutFailureMessage(raw, code);
    assert.match(sentence, /back in your earnings/);
    assert.ok(!sentence.includes("429") && !sentence.includes("InstructionError"));
    // The code decides even when the recorded text would match an older sentence.
    assert.equal(payoutFailureMessage("invalid payout address", code), payoutFailureMessage(null, code));
  }
});

test("a failed payout without a code is an older row: the older matcher, as before", () => {
  const general = "This payout could not be sent. The amount is back in your earnings. You can request it again.";
  for (const code of [undefined, null, "", "a_code_nobody_knows", "toString", "constructor"]) {
    assert.equal(payoutFailureMessage("something nobody has seen before", code), general);
    assert.match(payoutFailureMessage("missing payout address", code), /no wallet address/);
    assert.match(payoutFailureMessage("invalid payout address", code), /not valid/);
    assert.match(payoutFailureMessage("crypto payouts not configured (no payout wallet)", code), /not available right now/);
    assert.match(payoutFailureMessage("unsupported payout method: paypal", code), /not supported/);
    assert.match(payoutFailureMessage('payout tx failed on-chain: {"x":1}', code), /did not go through/);
    assert.equal(payoutFailureMessage(null, code), general);
  }
  // The one function, wherever it is imported from.
  assert.equal(fromRequests, payoutFailureMessage);
});

test("the sentence for a payout as it is now", () => {
  assert.equal(payoutStatusMessage({ status: "pending" }), null);
  assert.equal(
    payoutStatusMessage({ status: "pending", waitingReason: "chain_unavailable" }),
    "This payout is waiting to be sent. You can cancel it and keep your earnings.",
  );
  assert.equal(
    payoutStatusMessage({ status: "failed", failureCode: "could_not_send", failureReason: "raw text" }),
    "This payout could not be sent to that wallet address. The amount is back in your earnings.",
  );
  assert.equal(payoutStatusMessage({ status: "failed" }), payoutFailureMessage(null));
  for (const status of ["processing", "completed", "cancelled", ""]) {
    assert.equal(payoutStatusMessage({ status, waitingReason: "wallet_low", failureCode: "could_not_send" }), null);
  }
});
