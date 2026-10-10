/**
 * Every sentence a customer reads about a wallet top-up.
 *
 * Pure: a code and a few values in, a sentence out. The routes answer
 * with `{ error | status, message }`, and `message` always comes from
 * here. Nothing a node, the database or a thrown error said is ever part
 * of a sentence: that text goes to the log and to `failure_reason`.
 *
 * A row stores WHY it ended as a code (`failure_code`); `topupRowSentence`
 * picks the sentence from the row's status and that code.
 *
 * "Nothing was taken" is only written where that is certain at the moment
 * the sentence is chosen: a top-up that was never signed, a transfer the
 * chain proves can never land, or a refusal before anything was sent.
 */

/** Why a row ended, as stored in `failure_code`. */
export const TOPUP_FAILURE_CODES = {
  /** Prepared, never signed, and its time ran out. */
  unsignedExpired: "unsigned_expired",
  /** Signed and sent (or not), and the chain proves it can never land. */
  neverLanded: "never_landed",
  /** It is on the chain with an error, so it moved nothing. */
  failedOnChain: "failed_on_chain",
} as const;

export type TopupFailureCode =
  (typeof TOPUP_FAILURE_CODES)[keyof typeof TOPUP_FAILURE_CODES];

export type TopupSentenceCode =
  // A top-up's own states
  | "prepared_sol"
  | "prepared_usdc"
  | "prepared_usdc_opens_account"
  | "in_flight"
  | "send_unconfirmed"
  | "credited"
  | "expired_unsigned"
  | "expired_unsigned_sol"
  | "never_landed"
  | "failed_on_chain"
  | "did_not_go_through"
  // Refusals
  | "unauthenticated"
  | "invalid_payload"
  | "wallet_required"
  | "invalid_payer_address"
  | "invalid_amount"
  | "asset_unavailable"
  | "price_unavailable"
  | "wallet_balance_short"
  | "chain_unavailable"
  | "rpc_unavailable"
  | "wallet_topups_not_enabled"
  | "message_mismatch"
  | "unreadable_transaction"
  | "duplicate_signature"
  | "in_flight_conflict"
  | "topup_not_found"
  | "internal_error"
  // Linking a wallet
  | "wallet_in_use"
  | "invalid_nonce"
  | "invalid_signature"
  | "invalid_wallet_address"
  | "linked";

export interface TopupSentenceValues {
  /** prepared_sol: dollars per SOL, as shown. */
  solPriceUsd?: number;
  /** prepared_sol: how long the price holds. */
  holdSeconds?: number;
  /** credited: what was paid, in cents. */
  paidCents?: bigint;
  /** credited: the bonus on top, in cents. */
  bonusCents?: bigint;
  /** wallet_balance_short: what the wallet holds, in base units. */
  heldRaw?: bigint;
  /** wallet_balance_short: which asset the figure is in. */
  asset?: "SOL" | "USDC";
  /** invalid_amount: the bounds, in whole dollars. */
  minUsd?: number;
  maxUsd?: number;
}

const PAUSED =
  "Wallet payments are paused for a moment. Nothing was taken. Try again shortly.";
const ALREADY_CONFIRMING =
  "This top-up is already being confirmed. You do not need to send it again.";

function withThousands(whole: bigint): string {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Cents as "$55.00". Whole-number arithmetic; no float. */
export function formatUsdCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const text = `$${withThousands(abs / 100n)}.${(abs % 100n).toString().padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

/** A dollars-per-SOL figure for the screen, as "$110.25". */
export function formatUsdRate(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return "$0.00";
  return formatUsdCents(BigInt(Math.round(usd * 100)));
}

/**
 * Base units as a short figure, rounded DOWN so a wallet is never shown
 * holding more than it does: USDC to 2 places ("3.20"), SOL to 4.
 */
export function formatHeldAmount(raw: bigint, asset: "SOL" | "USDC"): string {
  const decimals = asset === "USDC" ? 6n : 9n;
  const shown = asset === "USDC" ? 2n : 4n;
  const safe = raw < 0n ? 0n : raw;
  const unit = 10n ** (decimals - shown);
  const scaled = safe / unit;
  const whole = scaled / 10n ** shown;
  const part = (scaled % 10n ** shown).toString().padStart(Number(shown), "0");
  return `${withThousands(whole)}.${part}`;
}

export function topupSentence(
  code: TopupSentenceCode,
  values: TopupSentenceValues = {},
): string {
  switch (code) {
    case "prepared_sol":
      return `1 SOL = ${formatUsdRate(values.solPriceUsd ?? 0)}. This price holds for ${values.holdSeconds ?? 60} seconds. Confirm the transfer in your wallet.`;
    case "prepared_usdc":
      return "Confirm the transfer in your wallet.";
    case "prepared_usdc_opens_account":
      return "Confirm the transfer in your wallet. This first USDC payment also opens your organization's USDC account, which costs your wallet about 0.002 SOL once.";
    case "in_flight":
      return "Your transfer was sent and is being confirmed. Your credits appear as soon as it is, usually within a minute. You can leave this page.";
    case "send_unconfirmed":
      return "We could not confirm that the network took this transfer. If it goes through, your credits are added within a few minutes. If it does not, nothing is taken.";
    case "credited": {
      const paid = values.paidCents ?? 0n;
      const bonus = values.bonusCents ?? 0n;
      if (bonus > 0n) {
        return `Added ${formatUsdCents(paid + bonus)} in credits: ${formatUsdCents(paid)} paid and a ${formatUsdCents(bonus)} bonus.`;
      }
      return `Added ${formatUsdCents(paid)} in credits.`;
    }
    case "expired_unsigned":
      return "This top-up ran out of time before it was sent. Nothing was taken. Start it again.";
    case "expired_unsigned_sol":
      return "This top-up ran out of time before it was sent. Nothing was taken. Start it again for a fresh price.";
    case "never_landed":
      return "The network did not take this transfer, so nothing was taken. Check your wallet balance and start the top-up again.";
    case "failed_on_chain":
      return "This transfer failed on the network, so no payment was taken. Check your wallet balance and start the top-up again.";
    case "did_not_go_through":
      return "This top-up did not go through. Start it again.";

    case "unauthenticated":
      return "Sign in to add credits.";
    case "invalid_payload":
      return "We could not read that request. Start the top-up again.";
    case "wallet_required":
      return "Connect a Solana wallet to pay. The wallet you connect signs the transfer.";
    case "invalid_payer_address":
      return "That is not a Solana wallet address. Connect a wallet and try again.";
    case "invalid_amount":
      return `Choose an amount between $${withThousands(BigInt(values.minUsd ?? 5))} and $${withThousands(BigInt(values.maxUsd ?? 10_000))}.`;
    case "asset_unavailable":
      return "SOL is not available here right now. Pay with USDC.";
    case "price_unavailable":
      return "We could not get a current SOL price, so nothing was prepared. Pay with USDC, or try again in a minute.";
    case "wallet_balance_short": {
      const asset = values.asset ?? "USDC";
      return `This wallet holds ${formatHeldAmount(values.heldRaw ?? 0n, asset)} ${asset}, which is less than this top-up needs. Choose a smaller amount or another wallet.`;
    }
    case "chain_unavailable":
    case "rpc_unavailable":
    case "wallet_topups_not_enabled":
      return PAUSED;
    case "message_mismatch":
      return "The signed transfer does not match the one we prepared, so it was not sent. Nothing was taken. Start the top-up again.";
    case "unreadable_transaction":
      return "We could not read the signed transfer, so it was not sent. Nothing was taken. Start the top-up again.";
    case "duplicate_signature":
    case "in_flight_conflict":
      return ALREADY_CONFIRMING;
    case "topup_not_found":
      return "We could not find that top-up. Start a new one.";
    case "internal_error":
      return "Something went wrong on our side. Check your top-ups before you try again.";

    case "wallet_in_use":
      return "This wallet already signs in to another WheelsAI account. Use that account, or link a different wallet.";
    case "invalid_nonce":
      return "That request to link a wallet has expired. Try again.";
    case "invalid_signature":
      return "The wallet's signature could not be checked. Try again.";
    case "invalid_wallet_address":
      return "That is not a Solana wallet address. Connect a wallet and try again.";
    case "linked":
      return "Wallet linked.";
  }
}

/** What a stored top-up needs to have its sentence chosen. */
export interface TopupRowForSentence {
  status: string;
  asset: string;
  amountUsdCents: bigint;
  bonusCents: bigint;
  quotedSolPriceUsd: number | null;
  txSignature: string | null;
  failureCode: string | null;
}

/**
 * The sentence for a stored top-up, from its status and its reason code.
 *
 * A row left in `submitting` is one whose send was not seen to succeed
 * (the send errored, or the process stopped between the claim and the
 * send), so it reads as "could not confirm", never as "was sent".
 *
 * An ended row with no code is from before the codes existed. Only one of
 * those is certain: an expired row that never held a signature was never
 * sent. Every other one gets the plain sentence.
 */
export function topupRowSentence(
  row: TopupRowForSentence,
  holdSeconds = 60,
): string {
  switch (row.status) {
    case "prepared":
      if (row.asset === "SOL" && row.quotedSolPriceUsd) {
        return topupSentence("prepared_sol", {
          solPriceUsd: row.quotedSolPriceUsd,
          holdSeconds,
        });
      }
      return topupSentence("prepared_usdc");
    case "submitting":
      return topupSentence("send_unconfirmed");
    case "submitted":
      return topupSentence("in_flight");
    case "credited":
      return topupSentence("credited", {
        paidCents: row.amountUsdCents,
        bonusCents: row.bonusCents,
      });
    case "expired":
      if (
        row.failureCode === TOPUP_FAILURE_CODES.unsignedExpired ||
        (row.failureCode === null && row.txSignature === null)
      ) {
        return topupSentence(
          row.asset === "SOL" ? "expired_unsigned_sol" : "expired_unsigned",
        );
      }
      if (row.failureCode === TOPUP_FAILURE_CODES.neverLanded) {
        return topupSentence("never_landed");
      }
      return topupSentence("did_not_go_through");
    case "failed":
      if (row.failureCode === TOPUP_FAILURE_CODES.failedOnChain) {
        return topupSentence("failed_on_chain");
      }
      if (row.failureCode === TOPUP_FAILURE_CODES.neverLanded) {
        return topupSentence("never_landed");
      }
      return topupSentence("did_not_go_through");
    default:
      return topupSentence("did_not_go_through");
  }
}
