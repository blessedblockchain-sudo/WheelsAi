/**
 * The Billing page's credit ledger, as it is drawn. Pure: how an amount reads (its sign, its colour,
 * the zero case), which lines of the month's spending are shown, the three ranges Export offers as
 * UTC days, and what the tiles show before data has loaded.
 *
 * The API writes every label and every sentence about a row, a hold or a refusal; this file picks
 * what to show and how. Every figure drawn is one the API answered with: nothing is worked out here
 * but its sign and its format, and a figure that has not arrived is not drawn as a number.
 *
 * The sentences written here are for what only the page can see: a download that did not arrive, a
 * list that could not be read, and the headings and choices of the page itself.
 */
import type {
  CreditBalance,
  CreditHold,
  CreditTransactionFilter,
  UsageSpendLine,
  UsageSummary,
} from "./api";
import { apiRefusal } from "./wallet-topup";

/** The colour of credits arriving or coming back: the design token, right in both themes. */
export const CREDIT_CLASS = "text-success";
export const PLAIN_CLASS = "text-foreground";
export const MUTED_CLASS = "text-muted-foreground";

export const SPENDING_TITLE = "Spending this month";
export const NOTHING_SPENT = "Nothing spent yet this month.";
export const HELD_TITLE = "What is held";
/** The balance says something is held and the list of what did not arrive. */
export const HOLDS_NOT_READ = "What is held could not be listed. Reload the page to see it.";
/** A page of the history did not arrive, with no sentence from the API. */
export const LIST_NOT_READ = "That list could not be read. Reload the page and try again.";
/** The file did not arrive, with no sentence from the API. */
export const DOWNLOAD_FAILED = "The file could not be downloaded. Try again in a moment.";
/** Shown in a tile until its figure has arrived. Never a number. */
export const NOT_LOADED = "…";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Whole cents of a dollar figure the API sent; a figure that is not a number is 0 cents. */
function centsOf(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return 0;
  const cents = Math.round(amount * 100);
  return cents === 0 ? 0 : cents; // never -0
}

/** Dollars with their sign only when below zero: "$5.00", "-$5.00", and "$0.00" never "-$0.00". */
export function formatUsd(amount: number): string {
  const cents = centsOf(amount);
  return `${cents < 0 ? "-" : ""}${usd.format(Math.abs(cents) / 100)}`;
}

export interface DrawnAmount {
  text: string;
  className: string;
  /** Which way the row went, for the icon beside it. */
  direction: "in" | "out" | "none";
}

/**
 * A ledger amount by its own sign: "+$5.00" in the colour of a credit, "-$5.00" plain, "$0.00"
 * muted. An amount that rounds to no cents is zero, so "-$0.00" is never drawn.
 */
export function drawAmount(amount: number): DrawnAmount {
  const cents = centsOf(amount);
  const text = usd.format(Math.abs(cents) / 100);
  if (cents > 0) return { text: `+${text}`, className: CREDIT_CLASS, direction: "in" };
  if (cents < 0) return { text: `-${text}`, className: PLAIN_CLASS, direction: "out" };
  return { text, className: MUTED_CLASS, direction: "none" };
}

/** "Balance after $x", from the row's own figure. */
export function balanceAfterText(balanceAfter: number): string {
  return `Balance after ${formatUsd(balanceAfter)}`;
}

export interface SpendLineShown {
  key: string;
  label: string;
  /** "$12.40", or "$2.00 returned" when more came back than was charged. */
  text: string;
  className: string;
  returned: boolean;
}

function drawSpend(amount: number): Pick<SpendLineShown, "text" | "className" | "returned"> {
  const cents = centsOf(amount);
  if (cents < 0) {
    return { text: `${usd.format(-cents / 100)} returned`, className: CREDIT_CLASS, returned: true };
  }
  return { text: usd.format(cents / 100), className: PLAIN_CLASS, returned: false };
}

/**
 * The month's spending as the card shows it: one line per group whose amount is not zero, in the
 * API's order and with the API's label, and the total, which is the API's `currentMonth`. With no
 * line to show the card says nothing was spent.
 */
export function spendingShown(usage: Pick<UsageSummary, "spend" | "currentMonth"> | null): {
  lines: SpendLineShown[];
  total: Pick<SpendLineShown, "text" | "className" | "returned"> | null;
  empty: boolean;
} {
  const spend: UsageSpendLine[] = Array.isArray(usage?.spend) ? usage.spend : [];
  const lines = spend
    .filter((line) => centsOf(line.amount) !== 0)
    .map((line) => ({ key: line.group, label: line.label, ...drawSpend(line.amount) }));
  if (!usage || lines.length === 0) return { lines: [], total: null, empty: true };
  return { lines, total: drawSpend(usage.currentMonth), empty: false };
}

export interface TilesShown {
  available: string;
  spent: string;
  held: string;
  gpuHours: string;
}

/**
 * The four tiles. A figure that has not arrived (or is not a number) is drawn as NOT_LOADED, never
 * as zero: a zero on this page means the API said zero.
 */
export function tilesShown(
  balance: Partial<CreditBalance> | null,
  usage: Partial<Pick<UsageSummary, "currentMonth" | "gpuHours">> | null
): TilesShown {
  const money = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? formatUsd(value) : NOT_LOADED;
  const hours = usage?.gpuHours;
  // A month in which more came back than was charged reads as the spending card's total does.
  const spent = usage?.currentMonth;
  return {
    available: money(balance?.available),
    spent: typeof spent === "number" && Number.isFinite(spent) ? drawSpend(spent).text : NOT_LOADED,
    held: money(balance?.held),
    gpuHours: typeof hours === "number" && Number.isFinite(hours) ? `${hours.toFixed(1)}h` : NOT_LOADED,
  };
}

/**
 * "What is held": the list when there is one; the line that says it could not be listed when the
 * balance reports something held and the list did not arrive; nothing when nothing is held.
 */
export function heldShown(
  balance: Pick<CreditBalance, "held"> | null,
  holds: CreditHold[] | null
): { holds: CreditHold[]; notice: string | null } {
  if (holds && holds.length > 0) return { holds, notice: null };
  if (holds === null && balance !== null && centsOf(balance.held) > 0) {
    return { holds: [], notice: HOLDS_NOT_READ };
  }
  return { holds: [], notice: null };
}

/** The four choices of the history's filter. `filter` is what the API is asked for. */
export const HISTORY_FILTERS: ReadonlyArray<{
  key: "all" | CreditTransactionFilter;
  label: string;
  filter: CreditTransactionFilter | undefined;
}> = [
  { key: "all", label: "All", filter: undefined },
  { key: "added", label: "Credits added", filter: "added" },
  { key: "spent", label: "Spending", filter: "spent" },
  { key: "held", label: "Holds", filter: "held" },
];
export type HistoryFilterKey = (typeof HISTORY_FILTERS)[number]["key"];

export function filterOf(key: HistoryFilterKey): CreditTransactionFilter | undefined {
  return HISTORY_FILTERS.find((choice) => choice.key === key)?.filter;
}

export interface ExportRange {
  key: "this_month" | "last_month" | "last_90_days";
  label: string;
  /** UTC days, "YYYY-MM-DD"; `to` is included. */
  from: string;
  to: string;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The three ranges Export offers, as UTC days: this month up to today, the whole of last month, and
 * the 90 days that end today. "This month" is the UTC calendar month, as everywhere in billing.
 */
export function exportRanges(now: Date): ExportRange[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const today = Date.UTC(year, month, now.getUTCDate());
  return [
    { key: "this_month", label: "This month", from: utcDay(Date.UTC(year, month, 1)), to: utcDay(today) },
    {
      key: "last_month",
      label: "Last month",
      from: utcDay(Date.UTC(year, month - 1, 1)),
      // Day 0 of this month is the last day of the one before.
      to: utcDay(Date.UTC(year, month, 0)),
    },
    { key: "last_90_days", label: "Last 90 days", from: utcDay(today - 89 * DAY_MS), to: utcDay(today) },
  ];
}

/**
 * One of the three ranges, worked out at `now`. The page asks for it when a choice is clicked, so
 * a page left open past midnight (UTC) still exports up to today, and the month that is current.
 */
export function exportRangeFor(key: ExportRange["key"], now: Date): ExportRange {
  const ranges = exportRanges(now);
  return ranges.find((range) => range.key === key) ?? ranges[0]!;
}

/** Export failed: the API's sentence for a refusal, else that the file could not be downloaded. */
export function exportFailure(err: unknown): string {
  return apiRefusal(err)?.message ?? DOWNLOAD_FAILED;
}

/** A page of the history failed: the API's sentence for a refusal, else that it could not be read. */
export function listFailure(err: unknown): string {
  return apiRefusal(err)?.message ?? LIST_NOT_READ;
}

/**
 * The rows after another page arrives. A row already shown is not drawn twice (a page asked for
 * twice, or a row that arrived between two pages).
 */
export function appendPage<T extends { id: string }>(shown: T[], page: T[]): T[] {
  const seen = new Set(shown.map((row) => row.id));
  return [...shown, ...page.filter((row) => !seen.has(row.id))];
}
