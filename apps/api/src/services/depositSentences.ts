/**
 * Every sentence a customer reads about their deposit address.
 *
 * Pure: a code and a few values in, a sentence out. The routes answer
 * with `{ ..., message }` or `{ error, message }`, and `message` always
 * comes from here. Nothing a node, the database or a thrown error said is
 * ever part of a sentence: that text goes to the log.
 *
 * A receipt stores a status and, when it was not credited, a reason code;
 * `depositRowSentence` picks the sentence from those.
 */

import type {
  CreditedTransfer,
  DepositAsset,
  WaitingTransfer,
} from "./depositTypes.js";
import { formatUsdCents } from "./topupSentences.js";

// ============================================
// Amounts
// ============================================

const DECIMALS: Record<DepositAsset, number> = { USDC: 6, SOL: 9 };

/**
 * A transfer in whole units, as the answers carry it.
 *
 * USDC has two decimals ("50.00"), or up to six when the amount is not a
 * whole number of cents ("0.123456", "1.005"). SOL has its trailing zeros
 * dropped ("0.5", "1", "0.000001"). Whole-number arithmetic; no float.
 */
export function formatDepositAmount(raw: bigint, asset: DepositAsset): string {
  const decimals = DECIMALS[asset];
  const safe = raw < 0n ? 0n : raw;
  const unit = 10n ** BigInt(decimals);
  const whole = (safe / unit).toString();
  const part = (safe % unit).toString().padStart(decimals, "0");
  const trimmed = part.replace(/0+$/, "");
  if (asset === "USDC") return `${whole}.${trimmed.padEnd(2, "0")}`;
  return trimmed.length > 0 ? `${whole}.${trimmed}` : whole;
}

// ============================================
// Sentences chosen by a code alone
// ============================================

export type DepositSentenceCode =
  | "address_shown"
  | "how_credited"
  | "not_issued"
  | "check_nothing_new"
  | "ignored"
  | "prepared"
  // Refusals
  | "unauthenticated"
  | "not_eligible"
  | "daily_limit"
  | "unavailable"
  | "deposit_address_not_issued"
  | "deposit_address_unavailable"
  | "chain_unavailable"
  | "deposits_not_enabled"
  | "unexpected";

export interface DepositSentenceOptions {
  /** SOL is offered: SOL_PRICE_SOURCE is not "off". Default true. */
  solOffered?: boolean;
}

const NOT_ISSUED = "Your organization has no deposit address yet.";
const PAUSED =
  "Deposits are paused for a moment. Nothing sent to your address is lost. Try again shortly.";

export function depositSentence(
  code: DepositSentenceCode,
  options: DepositSentenceOptions = {},
): string {
  const solOffered = options.solOffered ?? true;
  switch (code) {
    case "address_shown":
      return solOffered
        ? "Send USDC or SOL on Solana to this address. It belongs to your organization only."
        : "Send USDC on Solana to this address. It belongs to your organization only.";
    case "how_credited":
      return solOffered
        ? "USDC is credited one dollar for one USDC. SOL is credited at its dollar value when we see your transfer, usually within a few minutes."
        : "USDC is credited one dollar for one USDC, usually within a few minutes.";
    case "not_issued":
    case "deposit_address_not_issued":
      return NOT_ISSUED;
    case "check_nothing_new":
      return "No new transfer yet. Transfers usually arrive within a few minutes.";
    case "ignored":
      return "This transfer was too small to credit.";
    case "prepared":
      return "Your address can now receive USDC.";

    case "unauthenticated":
      return "Sign in to add credits.";
    case "not_eligible":
      return "Verify your email or make one purchase first, then prepare the address.";
    case "daily_limit":
    case "unavailable":
      return solOffered
        ? "The address cannot be prepared right now. Send SOL, or try again later."
        : "The address cannot be prepared right now. Try again later.";
    case "deposit_address_unavailable":
    case "chain_unavailable":
    case "deposits_not_enabled":
    case "unexpected":
      return PAUSED;
  }
}

// ============================================
// The address
// ============================================

/**
 * What GET and POST /deposit-address say: with an address, how to use it
 * and how it is credited; without one, that there is none yet.
 */
export function depositAddressMessage(input: {
  hasAddress: boolean;
  solOffered: boolean;
}): string {
  if (!input.hasAddress) return depositSentence("not_issued");
  const options = { solOffered: input.solOffered };
  return `${depositSentence("address_shown", options)} ${depositSentence("how_credited", options)}`;
}

// ============================================
// Credited and waiting transfers
// ============================================

/** A transfer waiting for a SOL price, in the check and in the list. */
export function waitingSentence(input: {
  asset: DepositAsset;
  amountRaw: bigint;
}): string {
  return `We have seen your transfer of ${formatDepositAmount(input.amountRaw, input.asset)} ${input.asset}. It is credited as soon as we can get a current SOL price.`;
}

/** A credited deposit in the list. */
export function creditedDepositSentence(input: {
  creditedCents: bigint;
  bonusCents: bigint;
}): string {
  if (input.bonusCents > 0n) {
    return `Credited ${formatUsdCents(input.creditedCents + input.bonusCents)}: ${formatUsdCents(input.creditedCents)} sent and a ${formatUsdCents(input.bonusCents)} bonus.`;
  }
  return `Credited ${formatUsdCents(input.creditedCents)}.`;
}

/**
 * What "Check now" says. What this check credited comes first; with
 * nothing credited, the first transfer still waiting; otherwise that
 * nothing new has arrived.
 */
export function checkSentence(input: {
  credited: ReadonlyArray<Pick<CreditedTransfer, "creditedCents" | "bonusCents">>;
  waiting: ReadonlyArray<Pick<WaitingTransfer, "asset" | "amountRaw">>;
}): string {
  const { credited, waiting } = input;
  if (credited.length === 1) {
    const only = credited[0]!;
    const total = only.creditedCents + only.bonusCents;
    if (only.bonusCents > 0n) {
      return `Credited ${formatUsdCents(total)} from your transfer: ${formatUsdCents(only.creditedCents)} sent and a ${formatUsdCents(only.bonusCents)} bonus.`;
    }
    return `Credited ${formatUsdCents(total)} from your transfer.`;
  }
  if (credited.length > 1) {
    const total = credited.reduce(
      (sum, one) => sum + one.creditedCents + one.bonusCents,
      0n,
    );
    return `Credited ${formatUsdCents(total)} from ${credited.length} transfers.`;
  }
  if (waiting.length > 0) return waitingSentence(waiting[0]!);
  return depositSentence("check_nothing_new");
}

// ============================================
// A stored receipt
// ============================================

/** The three states a deposit is shown in. */
export type DepositListStatus = "credited" | "waiting" | "ignored";

/**
 * A receipt's status as the list shows it. "detected" is waiting; anything
 * that is not credited or detected was not credited, so it reads ignored.
 */
export function depositListStatus(status: string): DepositListStatus {
  if (status === "credited") return "credited";
  if (status === "detected") return "waiting";
  return "ignored";
}

/** What a stored receipt needs to have its sentence chosen. */
export interface DepositRowForSentence {
  status: string;
  asset: DepositAsset;
  amountRaw: bigint;
  amountUsdCents: bigint | null;
  bonusCents: bigint;
}

export function depositRowSentence(row: DepositRowForSentence): string {
  switch (depositListStatus(row.status)) {
    case "credited":
      return creditedDepositSentence({
        creditedCents: row.amountUsdCents ?? 0n,
        bonusCents: row.bonusCents,
      });
    case "waiting":
      return waitingSentence({ asset: row.asset, amountRaw: row.amountRaw });
    case "ignored":
      return depositSentence("ignored");
  }
}
