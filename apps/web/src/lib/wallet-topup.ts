/**
 * Adding credits from a wallet, as the Billing page shows it. Pure: which assets to offer, the line
 * to show at each step, and which top-ups to keep following.
 *
 * The API writes every sentence about a top-up (`message`); this file only picks which one to show.
 * The sentences written here cover what the API cannot see: a wallet that declined or could not sign,
 * and a request that got no answer at all.
 */
import type {
  BillingRails,
  TopupAsset,
  TopupPrepareResponse,
  TopupRecord,
  TopupSettleResponse,
  TopupStatus,
} from "./api";

/** The assets this page can pay with, in the order they are offered. */
const OFFER_ORDER: readonly TopupAsset[] = ["USDC", "SOL"];

/**
 * What "Pay with" offers: the assets `rails` reports that this page knows how to pay with, USDC
 * first. Empty when the wallet rail is off or not yet read.
 */
export function walletAssetsOffered(rails: BillingRails | null | undefined): TopupAsset[] {
  if (rails?.wallet !== true || !Array.isArray(rails.walletAssets)) return [];
  return OFFER_ORDER.filter((asset) => rails.walletAssets.includes(asset));
}

/** The asset a payment uses: the one chosen while it is still offered, else the first offered. */
export function assetToPayWith(
  offered: readonly TopupAsset[],
  chosen: TopupAsset | null | undefined
): TopupAsset | null {
  if (chosen && offered.includes(chosen)) return chosen;
  return offered[0] ?? null;
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/** Sent to the network and not yet confirmed. */
export function isInFlight(status: TopupStatus | string): boolean {
  return status === "submitting" || status === "submitted";
}

/** Nothing more will happen to it: stop following. */
export function isFinal(status: TopupStatus | string): boolean {
  return status === "credited" || status === "failed" || status === "expired";
}

/**
 * Of the organization's recent top-ups, the ones to follow when the page opens: those in flight,
 * oldest first so the newest one's sentence is the last one written to the status line.
 */
export function topupsToFollow(topups: readonly TopupRecord[] | null | undefined): TopupRecord[] {
  if (!Array.isArray(topups)) return [];
  return topups
    .filter((topup) => topup && typeof topup.id === "string" && isInFlight(topup.status))
    .slice()
    .reverse();
}

// ---------------------------------------------------------------------------
// The status line
// ---------------------------------------------------------------------------

export type StatusTone = "progress" | "success" | "error";

export interface StatusLine {
  message: string;
  tone: StatusTone;
}

/** A wallet that was asked to sign and said no. The one outcome only the page can see. */
export const WALLET_DECLINED = "You cancelled the transfer in your wallet. Nothing was taken.";
/** A wallet that was asked to sign and failed for any other reason. Nothing was sent. */
export const WALLET_DID_NOT_SIGN = "Your wallet did not sign the transfer. Nothing was taken. Try again.";
/** The connected wallet has no way to sign a transfer. */
export const WALLET_CANNOT_SIGN = "This wallet cannot sign a transfer. Connect a different wallet.";
/** Shown while the wallet list is open for a payment. The API's own sentence for a missing wallet. */
export const CONNECT_TO_PAY = "Connect a Solana wallet to pay. The wallet you connect signs the transfer.";
/** Prepare got no sentence back (the server could not be reached). Nothing was signed yet. */
export const PAUSED = "Wallet payments are paused for a moment. Nothing was taken. Try again shortly.";
/** Submit got no answer: the signed transfer may or may not have been sent on. */
export const NOT_CONFIRMED =
  "We could not confirm that the network took this transfer. If it goes through, your credits are added within a few minutes. If it does not, nothing is taken.";

const IN_FLIGHT =
  "Your transfer was sent and is being confirmed. Your credits appear as soon as it is, usually within a minute. You can leave this page.";
const DID_NOT_GO_THROUGH = "This top-up did not go through. Start it again.";

/** Used only when an answer carries no sentence, so a status word is never what a person reads. */
function sentenceFor(status: TopupStatus | string): string {
  if (status === "credited") return "Credits added.";
  if (status === "prepared") return "Confirm the transfer in your wallet.";
  if (status === "failed" || status === "expired") return DID_NOT_GO_THROUGH;
  return IN_FLIGHT;
}

function toneFor(status: TopupStatus | string): StatusTone {
  if (status === "credited") return "success";
  if (status === "failed" || status === "expired") return "error";
  return "progress";
}

function said(message: unknown): string | null {
  return typeof message === "string" && message.trim() ? message : null;
}

/** The line for anything that has a status and the API's sentence: a top-up in the list, or an answer. */
export function lineFor(answer: { status: TopupStatus | string; message?: unknown }): StatusLine {
  return { message: said(answer.message) ?? sentenceFor(answer.status), tone: toneFor(answer.status) };
}

/** After prepare: the API's sentence (for SOL, the price and how long it holds). */
export function lineForPrepared(prepared: Pick<TopupPrepareResponse, "message">): StatusLine {
  return { message: said(prepared.message) ?? sentenceFor("prepared"), tone: "progress" };
}

// ---------------------------------------------------------------------------
// What to do next
// ---------------------------------------------------------------------------

export interface NextStep {
  line: StatusLine;
  /** Keep asking reconcile about this top-up every few seconds. */
  follow: boolean;
  /** Credits were added: read the balance again. */
  reloadBalance: boolean;
}

/** After an answer from submit or reconcile. Following stops only at credited, failed or expired. */
export function afterSettle(answer: Pick<TopupSettleResponse, "status" | "message">): NextStep {
  return {
    line: lineFor(answer),
    follow: !isFinal(answer.status),
    reloadBalance: answer.status === "credited",
  };
}

interface Refusal {
  status: number | null;
  code: string | null;
  message: string | null;
}

/**
 * A refusal a route wrote (`{ error, message }`), read from a thrown API error; else null. The
 * server framework's own error body (`{ statusCode, error, message }`, as for an unhandled fault)
 * is not one: its message is not a sentence written for a customer.
 */
export function apiRefusal(err: unknown): Refusal | null {
  if (typeof err !== "object" || err === null || !("data" in err)) return null;
  const { data, status } = err as { data?: unknown; status?: unknown };
  if (typeof data !== "object" || data === null || "statusCode" in data) return null;
  const { error, message } = data as { error?: unknown; message?: unknown };
  const code = typeof error === "string" && error ? error : null;
  const sentence = said(message);
  if (code === null && sentence === null) return null;
  return { status: typeof status === "number" ? status : null, code, message: sentence };
}

/** Prepare failed: the API's sentence, or that payments are paused. Nothing has been signed. */
export function afterPrepareError(err: unknown): StatusLine {
  return { message: apiRefusal(err)?.message ?? PAUSED, tone: "error" };
}

/**
 * Signing failed. A wallet's own error text is never shown: it is either a decline, or a wallet
 * that did not sign. Either way nothing was sent.
 */
export function afterSignError(err: unknown): StatusLine {
  return { message: isWalletDecline(err) ? WALLET_DECLINED : WALLET_DID_NOT_SIGN, tone: "error" };
}

/** Wallets say no in several ways: code 4001, or a message that says rejected, denied or cancelled. */
export function isWalletDecline(err: unknown): boolean {
  for (let cause: unknown = err, depth = 0; cause && depth < 3; depth++) {
    if (typeof cause !== "object") break;
    const { code, message, error } = cause as { code?: unknown; message?: unknown; error?: unknown };
    if (code === 4001) return true;
    if (typeof message === "string" && /reject|denied|declin|cancel/i.test(message)) return true;
    cause = error;
  }
  return false;
}

/** These refusals mean the top-up is already on its way: keep following it. */
const STILL_ON_ITS_WAY = new Set(["in_flight", "duplicate_signature"]);

/**
 * Submit threw. A refusal with a sentence ends it, unless it says the top-up is already being
 * confirmed. No answer at all (the request was lost, or a proxy answered) decides nothing: the
 * signed transfer may have been sent on, so the top-up is followed until the API says how it ended.
 */
export function afterSubmitError(err: unknown): NextStep {
  const refusal = apiRefusal(err);
  // A fault part way through (500, 502, 504) is not a decision about the transfer.
  const decided = refusal?.status == null || refusal.status < 500 || refusal.status === 501 || refusal.status === 503;
  if (refusal?.message && decided) {
    const onItsWay = refusal.code !== null && STILL_ON_ITS_WAY.has(refusal.code);
    return {
      line: { message: refusal.message, tone: onItsWay ? "progress" : "error" },
      follow: onItsWay,
      reloadBalance: false,
    };
  }
  return { line: { message: NOT_CONFIRMED, tone: "progress" }, follow: true, reloadBalance: false };
}

/**
 * Reconcile threw while a top-up is followed. A refusal the API wrote for this top-up (a 4xx with a
 * sentence) ends the following and is shown; anything else is a passing fault and is asked again.
 */
export function afterReconcileError(err: unknown): { follow: boolean; line: StatusLine | null } {
  const refusal = apiRefusal(err);
  const refused =
    refusal !== null && refusal.status !== null && refusal.status >= 400 && refusal.status < 500 && refusal.status !== 429;
  if (!refused) return { follow: true, line: null };
  return { follow: false, line: refusal.message ? { message: refusal.message, tone: "error" } : null };
}

// ---------------------------------------------------------------------------
// Following and carrying on
// ---------------------------------------------------------------------------

/** How often a followed top-up is asked about. */
export const FOLLOW_EVERY_MS = 3_000;

/** A payment waiting for a wallet to connect is carried on only this long after it was asked for. */
export const CARRY_ON_WITHIN_MS = 2 * 60_000;

/**
 * A top-up is followed from this page for at most this long. One the API cannot end in that time
 * (it keeps failing to answer) is left to the server, which finishes it by itself; it is picked up
 * again the next time the page opens. Without this a page left open would ask for ever.
 */
export const FOLLOW_FOR_MS = 10 * 60_000;

/** True while a top-up followed since `since` should still be asked about. */
export function shouldKeepFollowing(since: number, now: number): boolean {
  const age = now - since;
  return age >= 0 && age < FOLLOW_FOR_MS;
}

/** The status line, with the top-up it is about when it is about one. */
export interface ShownLine extends StatusLine {
  topupId?: string;
}

/**
 * The status line after a followed top-up was asked about. There is one line and there can be
 * several top-ups: news that a top-up ended is always shown, but "still being confirmed" is written
 * only over nothing or over that same top-up's line. So an older top-up still on its way never
 * replaces the price a person is about to sign, a refusal, or another top-up's "credits added".
 */
export function lineWhileFollowing(
  shown: ShownLine | null,
  topupId: string,
  next: { line: StatusLine | null; follow: boolean }
): ShownLine | null {
  if (!next.line) return shown;
  if (next.follow && shown !== null && shown.topupId !== topupId) return shown;
  return { ...next.line, topupId };
}

/** True when the pack chosen before the wallet connected should now be paid for. */
export function shouldCarryOn(
  waiting: { askedAt: number } | null | undefined,
  walletConnected: boolean,
  now: number
): boolean {
  if (!waiting || !walletConnected) return false;
  const age = now - waiting.askedAt;
  return age >= 0 && age <= CARRY_ON_WITHIN_MS;
}
