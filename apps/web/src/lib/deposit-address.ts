/**
 * The organization's deposit address, as the Billing page shows it. Pure: what the panel shows for
 * each state, the line after each button, and the rows of the list.
 *
 * The API writes every sentence about a deposit (`message`); this file picks which one to show. The
 * sentences written here are the two warnings the panel always carries, the hint beside "Prepare
 * address", and the API's own wording for the cases where an answer carried no sentence at all.
 */
import type {
  BillingRails,
  DepositAddressResponse,
  DepositCheckResponse,
  DepositRecord,
  DepositUsdcAccountResponse,
} from "./api";
import { apiRefusal, type StatusLine } from "./wallet-topup";

export const PANEL_TITLE = "Send from an exchange or another wallet";
export const SHOW_ADDRESS = "Show my deposit address";
export const PREPARE_ADDRESS = "Prepare address";
export const CHECK_NOW = "Check now";

/** A call that failed with no sentence from the API (the server could not be reached, or a fault). */
export const PAUSED =
  "Deposits are paused for a moment. Nothing sent to your address is lost. Try again shortly.";
export const SOLANA_ONLY =
  "Send on the Solana network only. A transfer on another network cannot be recovered.";
export const ONLY_USDC_AND_SOL = "Only USDC and SOL are credited.";
export const ONLY_USDC = "Only USDC is credited.";
export const PREPARE_HINT =
  "If your exchange says this address cannot receive USDC yet, press Prepare address.";
/** A button pressed past the limit of requests for a minute: nothing is wrong with deposits. */
export const TOO_OFTEN = "That was asked a few times in a row. Wait a minute and try again.";
/** The browser would not copy: the one thing only the page can see. */
export const COPY_FAILED = "The address could not be copied. Select it and copy it by hand.";

// The API's wording, used only when an answer arrives without its sentence.
const NOT_ISSUED = "Your organization has no deposit address yet.";
const SHOWN = "Send USDC or SOL on Solana to this address. It belongs to your organization only.";
const SHOWN_USDC_ONLY = "Send USDC on Solana to this address. It belongs to your organization only.";
const HOW_CREDITED =
  "USDC is credited one dollar for one USDC. SOL is credited at its dollar value when we see your transfer, usually within a few minutes.";
const HOW_CREDITED_USDC_ONLY = "USDC is credited one dollar for one USDC, usually within a few minutes.";
const PREPARED = "Your address can now receive USDC.";
const NOTHING_NEW = "No new transfer yet. Transfers usually arrive within a few minutes.";
const TOO_SMALL = "This transfer was too small to credit.";

function said(message: unknown): string | null {
  return typeof message === "string" && message.trim() ? message : null;
}

function usd(dollars: number): string {
  return `$${dollars.toFixed(2)}`;
}

function amountOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** True when this deployment pays organizations at their own address. Off until the server says so. */
export function depositsOffered(rails: BillingRails | null | undefined): boolean {
  return rails?.deposits === true;
}

/** Whether SOL sent to the address is credited. Only an answer that says so counts. */
export function solOffered(answer: Pick<DepositAddressResponse, "assets"> | null | undefined): boolean {
  if (!Array.isArray(answer?.assets)) return false;
  return answer.assets.some((entry) => entry?.asset === "SOL" && entry.offered === true);
}

/**
 * Whether the address can receive USDC already. An answer that does not say is read as "not yet",
 * so "Prepare address" stays within reach: pressing it when the account is open spends nothing.
 */
export function usdcAccountOpen(answer: Pick<DepositAddressResponse, "assets"> | null | undefined): boolean {
  if (!Array.isArray(answer?.assets)) return false;
  return answer.assets.some((entry) => entry?.asset === "USDC" && entry.accountOpen === true);
}

// ---------------------------------------------------------------------------
// What the panel shows
// ---------------------------------------------------------------------------

export type DepositPanelView =
  /** No address on this network yet: one button, which issues it. */
  | { kind: "none" }
  | {
      kind: "address";
      /** In full, never shortened: it is what a person pastes into an exchange. */
      address: string;
      /** The API's sentence: what to send, and how it is credited. */
      message: string;
      /** The warnings under it, in order. */
      notes: string[];
      /** The hint beside "Prepare address"; null when the address can already receive USDC. */
      prepareHint: string | null;
    };

/** The panel for an answer of GET or POST deposit-address; null is "not read", shown as no address. */
export function panelView(answer: DepositAddressResponse | null | undefined): DepositPanelView {
  const address = said(answer?.address);
  if (!answer || address === null) return { kind: "none" };
  const sol = solOffered(answer);
  return {
    kind: "address",
    address,
    message:
      said(answer.message) ??
      (sol ? `${SHOWN} ${HOW_CREDITED}` : `${SHOWN_USDC_ONLY} ${HOW_CREDITED_USDC_ONLY}`),
    notes: [SOLANA_ONLY, sol ? ONLY_USDC_AND_SOL : ONLY_USDC],
    prepareHint: usdcAccountOpen(answer) ? null : PREPARE_HINT,
  };
}

/** The address answer once "Prepare address" said the USDC account is open. */
export function withUsdcAccountOpen(answer: DepositAddressResponse): DepositAddressResponse {
  return {
    ...answer,
    assets: answer.assets.map((entry) =>
      entry.asset === "USDC" ? { asset: "USDC", accountOpen: true } : entry
    ),
  };
}

/**
 * The address answer after it was read again (after "Check now": a transfer of USDC can open the
 * USDC account, and then "Prepare address" has nothing left to do). A fresh answer that shows no
 * address never takes away the one on the page: only a refusal that says so does that.
 */
export function refreshedAddress(
  current: DepositAddressResponse | null,
  fresh: DepositAddressResponse | null | undefined
): DepositAddressResponse | null {
  return fresh && panelView(fresh).kind === "address" ? fresh : current;
}

/** The line once the address was copied: a "could not be copied" line is no longer true. */
export function lineAfterCopied<T extends StatusLine>(line: T | null): T | null {
  return line?.message === COPY_FAILED ? null : line;
}

// ---------------------------------------------------------------------------
// The line after a button
// ---------------------------------------------------------------------------

/**
 * A refusal or a failed call: the API's sentence when it wrote one, else that deposits are paused.
 * Never a status code, the framework's own error body, or a thrown error's text.
 */
export function afterDepositError(err: unknown): StatusLine {
  const sentence = apiRefusal(err)?.message;
  if (sentence) return { message: sentence, tone: "error" };
  return { message: pressedTooOften(err) ? TOO_OFTEN : PAUSED, tone: "error" };
}

/** The server's own guard on requests a minute answered (429), with no sentence of the API's. */
function pressedTooOften(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: unknown }).status === 429;
}

/** These refusals mean there is no address to show: the panel stops showing the one it has. */
const NO_ADDRESS_TO_SHOW = new Set(["deposit_address_not_issued", "deposit_address_unavailable"]);

export function hidesAddress(err: unknown): boolean {
  const code = apiRefusal(err)?.code;
  return typeof code === "string" && NO_ADDRESS_TO_SHOW.has(code);
}

/** After "Show my deposit address" answered with no address after all. */
export function afterIssue(answer: DepositAddressResponse | null | undefined): StatusLine | null {
  if (panelView(answer).kind === "address") return null;
  return { message: said(answer?.message) ?? NOT_ISSUED, tone: "error" };
}

/** After "Prepare address". */
export function afterPrepare(answer: Pick<DepositUsdcAccountResponse, "message"> | null | undefined): StatusLine {
  return { message: said(answer?.message) ?? PREPARED, tone: "success" };
}

export interface AfterCheck {
  line: StatusLine;
  /** Something was credited: read the balance and the history again. */
  reloadBalance: boolean;
}

/** After "Check now". */
export function afterCheck(answer: DepositCheckResponse | null | undefined): AfterCheck {
  const credited = Array.isArray(answer?.credited) ? answer.credited.length : 0;
  return {
    line: {
      message: said(answer?.message) ?? NOTHING_NEW,
      tone: credited > 0 ? "success" : "progress",
    },
    reloadBalance: credited > 0,
  };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * Whether a deposit is credited now that the list read before did not show as credited. Transfers
 * are credited in the background, so the list can show one the page's balance has not caught up
 * with: the balance is then read again.
 */
export function creditedSince(
  before: readonly DepositRecord[] | null | undefined,
  after: readonly DepositRecord[] | null | undefined,
): boolean {
  const isCredited = (entry: DepositRecord | null | undefined): entry is DepositRecord =>
    entry?.status === "credited" && typeof entry.id === "string" && entry.id !== "";
  const known = new Set((Array.isArray(before) ? before : []).filter(isCredited).map((entry) => entry.id));
  return (Array.isArray(after) ? after : []).some((entry) => isCredited(entry) && !known.has(entry.id));
}

/** How many deposits the panel lists. */
export const DEPOSITS_SHOWN = 5;

export interface DepositRow {
  id: string;
  /** The API's sentence for this transfer. */
  message: string;
  /** What was sent, for example "50.00 USDC". */
  sent: string;
  /** When it arrived, as the API gave it; null when it gave no date that can be read. */
  arrivedAt: string | null;
  tone: StatusLine["tone"];
}

/** Used only when a row carries no sentence, so a status word is never what a person reads. */
function sentenceFor(deposit: DepositRecord): string {
  const sent = `${deposit.amount} ${deposit.asset}`;
  if (deposit.status === "credited") {
    const credited = amountOf(deposit.creditedUsd);
    const bonus = amountOf(deposit.bonusUsd);
    if (credited === 0) return `We credited your transfer of ${sent}.`;
    return bonus > 0
      ? `Credited ${usd(credited + bonus)}: ${usd(credited)} sent and a ${usd(bonus)} bonus.`
      : `Credited ${usd(credited)}.`;
  }
  if (deposit.status === "ignored") return TOO_SMALL;
  return deposit.asset === "SOL"
    ? `We have seen your transfer of ${sent}. It is credited as soon as we can get a current SOL price.`
    : `We have seen your transfer of ${sent}. It is not credited yet.`;
}

function toneFor(status: DepositRecord["status"] | string): StatusLine["tone"] {
  if (status === "credited") return "success";
  if (status === "ignored") return "error";
  return "progress";
}

/** The newest few deposits, in the order the API gives them (newest first). */
export function depositRows(
  deposits: readonly DepositRecord[] | null | undefined,
  limit: number = DEPOSITS_SHOWN
): DepositRow[] {
  if (!Array.isArray(deposits)) return [];
  return deposits
    .filter((deposit) => deposit && typeof deposit.id === "string" && deposit.id)
    .slice(0, Math.max(0, limit))
    .map((deposit) => ({
      id: deposit.id,
      message: said(deposit.message) ?? sentenceFor(deposit),
      sent: `${deposit.amount} ${deposit.asset}`,
      arrivedAt:
        typeof deposit.createdAt === "string" && !Number.isNaN(Date.parse(deposit.createdAt))
          ? deposit.createdAt
          : null,
      tone: toneFor(deposit.status),
    }));
}
