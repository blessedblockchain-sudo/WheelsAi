/**
 * Every sentence a creator reads about a payout.
 *
 * A payout row stores a code (`failure_code`, `waiting_reason`) and a
 * refusal is a code; the sentence is chosen from the code here and from a
 * few amounts, and from nothing else. Text from an RPC node, from Prisma or
 * from a thrown error never picks a word of it: `failure_reason` holds that
 * text for operators and is only ever matched against, never sent.
 *
 * Pure: no database, no settings, no clock.
 */

import { MIN_PAYOUT_CENTS } from "@wheelsai/shared/payouts";

// ============================================
// Money
// ============================================

/**
 * Whole cents as dollars: 4120 is "$41.20", 100000 is "$1,000.00". Whole
 * cents only: an amount that is not a whole number of cents is written as
 * "$0.00" rather than rounded into a number nobody stored.
 */
export function formatUsd(cents: bigint | number): string {
  let value: bigint;
  if (typeof cents === "bigint") value = cents;
  else if (typeof cents === "number" && Number.isSafeInteger(cents)) value = BigInt(cents);
  else value = 0n;
  const negative = value < 0n;
  if (negative) value = -value;
  const dollars = (value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = (value % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars}.${rest}`;
}

// ============================================
// Refusals of a request
// ============================================

export const PAYOUTS_UNAVAILABLE_CODE = "payouts_unavailable";
export const PAYOUTS_UNAVAILABLE_MESSAGE =
  "Payouts are temporarily unavailable. Nothing was reserved and your earnings are unchanged. Try again later.";

/** Why a wallet address was refused. Each has its own sentence. */
export type PayoutAddressProblem =
  /** Not 32 bytes of base58, or not on the curve. */
  | "not_an_address"
  /** A token account or a program, by the chain's own account. */
  | "not_a_wallet"
  /** The paying wallet, the treasury or this organization's deposit address. */
  | "platform";

/**
 * A request that was refused: the code the answer carries, with the amounts
 * its sentence needs. Nothing was reserved for any of them.
 */
export type PayoutRefusal =
  | { code: "payouts_unavailable" }
  | { code: "invalid_payload" }
  | { code: "payout_method_unavailable" }
  | { code: "payout_in_progress" }
  /** `balanceCents` is given when the balance itself is below the minimum. */
  | { code: "payout_below_minimum"; balanceCents?: bigint }
  | { code: "payout_above_balance"; balanceCents: bigint }
  | { code: "payout_above_limit"; perPayoutCents: bigint }
  | { code: "payout_daily_limit" }
  | { code: "payout_address_required" }
  | { code: "invalid_payout_address"; problem: PayoutAddressProblem }
  | { code: "payout_check_unavailable" }
  | { code: "payout_reservation_conflict" };

export type PayoutRefusalCode = PayoutRefusal["code"];

/** The HTTP status each refusal answers with. */
export const PAYOUT_REFUSAL_STATUS: Readonly<Record<PayoutRefusalCode, number>> = {
  payouts_unavailable: 503,
  invalid_payload: 400,
  payout_method_unavailable: 400,
  payout_in_progress: 409,
  payout_below_minimum: 400,
  payout_above_balance: 400,
  payout_above_limit: 400,
  payout_daily_limit: 409,
  payout_address_required: 400,
  invalid_payout_address: 400,
  payout_check_unavailable: 503,
  payout_reservation_conflict: 409,
};

const ADDRESS_SENTENCES: Readonly<Record<PayoutAddressProblem, string>> = {
  not_an_address: "That is not a Solana wallet address. Check it and try again.",
  not_a_wallet:
    "That address is a token account or a program, not a wallet. Enter the wallet address itself.",
  platform: "That address belongs to WheelsAI, not to you. Enter your own wallet address.",
};

/** The sentence for a refusal. */
export function payoutRefusalMessage(refusal: PayoutRefusal): string {
  switch (refusal.code) {
    case "payouts_unavailable":
      return PAYOUTS_UNAVAILABLE_MESSAGE;
    case "invalid_payload":
      return "We could not read that request. Check the amount and try again.";
    case "payout_method_unavailable":
      return "SOL payouts are not available right now. Choose USDC or credits.";
    case "payout_in_progress":
      return "You already have a payout in progress. Wait for it to finish, or cancel it if it has not been sent.";
    case "payout_below_minimum": {
      const smallest = `The smallest payout is ${formatUsd(MIN_PAYOUT_CENTS)}.`;
      return typeof refusal.balanceCents === "bigint"
        ? `${smallest} You have ${formatUsd(refusal.balanceCents)} available.`
        : smallest;
    }
    case "payout_above_balance":
      return `You have ${formatUsd(refusal.balanceCents)} available. Request that amount or less.`;
    case "payout_above_limit":
      return `The most for one payout to a wallet is ${formatUsd(refusal.perPayoutCents)}. Request that amount or less; the rest stays in your earnings.`;
    case "payout_daily_limit":
      return "You have reached today's limit for payouts to a wallet. You can request more after midnight UTC, or take a payout as credits now.";
    case "payout_address_required":
      return "Enter the wallet address to send this payout to.";
    case "invalid_payout_address":
      return ADDRESS_SENTENCES[refusal.problem] ?? ADDRESS_SENTENCES.not_an_address;
    case "payout_check_unavailable":
      return "Payouts to a wallet are paused for a moment. Nothing was reserved and your earnings are unchanged. Try again shortly.";
    case "payout_reservation_conflict":
      return "Your payout balance changed while this request was processing. Please try again.";
  }
}

/** A request the service did not expect to fail. Never the error's own text. */
export const PAYOUT_REQUEST_FAILED_CODE = "payout_request_failed";
export const PAYOUT_REQUEST_FAILED_MESSAGE =
  "We could not request this payout. Check your payouts before trying again.";

/** The same, for the cancel and for the list. */
export const PAYOUT_ACTION_FAILED_CODE = "internal_error";
export const PAYOUT_ACTION_FAILED_MESSAGE = "Something went wrong on our side. Try again shortly.";

// ============================================
// A request that went through
// ============================================

export interface PayoutRequestedValues {
  payoutMethod: string;
  amountCents: bigint;
  /** What is left in the creator's earnings after the reservation. */
  remainingCents: bigint;
  /** The amount is the most one payout to a wallet may be. */
  atCap: boolean;
}

export function payoutRequestedMessage(values: PayoutRequestedValues): string {
  const amount = formatUsd(values.amountCents);
  if (values.payoutMethod === "credits") return `Payout of ${amount} requested as credits.`;
  if (values.atCap && values.remainingCents > 0n) {
    return `Requested ${amount}, the most for one payout to a wallet. ${formatUsd(values.remainingCents)} stays in your earnings.`;
  }
  return `Payout of ${amount} requested. It is usually sent within a few minutes.`;
}

// ============================================
// A payout that is waiting
// ============================================

/** Why the worker has not sent a pending wallet payout yet. */
export const PAYOUT_WAITING_REASONS = [
  "wallet_low",
  "daily_limit_reached",
  "price_unavailable",
  "chain_unavailable",
] as const;
export type PayoutWaitingReason = (typeof PAYOUT_WAITING_REASONS)[number];

export const PAYOUT_WAITING_MESSAGE =
  "This payout is waiting to be sent. You can cancel it and keep your earnings.";

/**
 * The sentence for a pending payout that is being held, whatever is holding
 * it: the reason is the operator's business, the creator is told what they
 * can do. Null when nothing is holding it.
 */
export function payoutWaitingMessage(waitingReason: string | null | undefined): string | null {
  return typeof waitingReason === "string" && waitingReason.trim().length > 0 ? PAYOUT_WAITING_MESSAGE : null;
}

// ============================================
// A payout that failed
// ============================================

/** Why a payout failed, as the worker records it. */
export const PAYOUT_FAILURE_CODES = [
  "could_not_send",
  "invalid_address",
  "missing_address",
  "unsupported_method",
] as const;
export type PayoutFailureCode = (typeof PAYOUT_FAILURE_CODES)[number];

const BACK_IN_EARNINGS = "The amount is back in your earnings.";

const GENERAL_FAILURE = `This payout could not be sent. ${BACK_IN_EARNINGS} You can request it again.`;
const TRANSFER_FAILURE = `The transfer did not go through. ${BACK_IN_EARNINGS} You can request it again.`;
const MISSING_ADDRESS = `This payout had no wallet address. ${BACK_IN_EARNINGS} Request it again with a wallet address.`;
const INVALID_ADDRESS = `The wallet address on this payout is not valid. ${BACK_IN_EARNINGS} Check the address and request it again.`;
const UNSUPPORTED_METHOD = `This payout method is not supported. ${BACK_IN_EARNINGS} Request it again with another method.`;

/**
 * A failed payout always had its amount restored in the transaction that
 * failed it, so every sentence can say so.
 */
const FAILURE_CODE_SENTENCES: Readonly<Record<PayoutFailureCode, string>> = {
  could_not_send: `This payout could not be sent to that wallet address. ${BACK_IN_EARNINGS}`,
  invalid_address: INVALID_ADDRESS,
  missing_address: MISSING_ADDRESS,
  unsupported_method: UNSUPPORTED_METHOD,
};

/**
 * Rows from before the codes existed: the reasons the worker recorded then,
 * each with the sentence a creator reads. The recorded text only picks the
 * sentence.
 */
const OLDER_FAILURE_SENTENCES: ReadonlyArray<{ matches: (reason: string) => boolean; sentence: string }> = [
  { matches: (r) => r === "missing payout address", sentence: MISSING_ADDRESS },
  { matches: (r) => r === "invalid payout address", sentence: INVALID_ADDRESS },
  {
    matches: (r) => r.startsWith("crypto payouts not configured"),
    sentence: `Payouts to a wallet are not available right now. ${BACK_IN_EARNINGS} You can request it as platform credits, or try again later.`,
  },
  { matches: (r) => r.startsWith("unsupported payout method"), sentence: UNSUPPORTED_METHOD },
  {
    matches: (r) =>
      r.startsWith("payout tx failed on-chain") ||
      r.startsWith("prior payout tx failed on-chain") ||
      r === "payout tx did not sign",
    sentence: TRANSFER_FAILURE,
  },
];

/**
 * Why a payout did not go through, as a plain sentence for the creator.
 *
 * A row with a `failure_code` gets its sentence from the code. A row without
 * one (or with a code nobody knows) is an older row: its recorded reason
 * picks the sentence, and one that is not recognised, or is missing, gets
 * the general sentence. Never the processor's or the database's own words.
 */
export function payoutFailureMessage(
  reason: string | null | undefined,
  failureCode?: string | null,
): string {
  if (typeof failureCode === "string" && Object.hasOwn(FAILURE_CODE_SENTENCES, failureCode)) {
    return FAILURE_CODE_SENTENCES[failureCode as PayoutFailureCode];
  }
  if (typeof reason !== "string") return GENERAL_FAILURE;
  const recorded = reason.trim();
  for (const known of OLDER_FAILURE_SENTENCES) {
    if (known.matches(recorded)) return known.sentence;
  }
  return GENERAL_FAILURE;
}

// ============================================
// The one sentence a payout in the list carries
// ============================================

/**
 * The sentence for a payout as it is now: the waiting sentence for a pending
 * payout that is being held, the failure sentence for a failed one,
 * otherwise null.
 */
export function payoutStatusMessage(row: {
  status: string;
  waitingReason?: string | null;
  failureReason?: string | null;
  failureCode?: string | null;
}): string | null {
  if (row.status === "pending") return payoutWaitingMessage(row.waitingReason);
  if (row.status === "failed") return payoutFailureMessage(row.failureReason, row.failureCode);
  return null;
}
