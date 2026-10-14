/**
 * The Usage page (/dashboard/usage), as it is drawn: the one balance, then a
 * row for each listing the organization pays to use. Pure: no IO, no React.
 * The page passes what `GET /api/billing/marketplace-usage` said and draws
 * what comes back.
 *
 * A row on a plan has a bar of the period's uses (the included ones and any
 * brought in by a move), with marks at 85% and 100%. The bar is never the
 * only carrier of what it shows: the same numbers are a sentence beside it,
 * it has a text alternative, and the two warnings are words as well as a
 * colour.
 *
 * The count of what is left is said by `planCountLine` of lib/use-plans.ts,
 * the function the agent's page and the Installed page use, so the three
 * never count differently. Every number here was sent by the API, and no date
 * is worked out in this file.
 *
 * A row on a listing's free trial is named "Free trial" and its line is the
 * trial's own count (`trialCountLine`), which names the day the trial ends
 * and never a renewal.
 *
 * Never said here: tokens, the model, the organization that sells an agent,
 * anything of another buyer, or a count that has no end.
 */
import type { MarketplaceUsage, MarketplaceUsageRow, UsesAndCents } from "./api";
import { INSTALLED_WORDS } from "./installed-rows";
import { dollars, type PaidPrice } from "./paid-use";
import { TRIAL_WORDS, planCountLine, planCountOf, trialCountLine, type PlanCount } from "./use-plans";

// ---------------------------------------------------------------------------
// Words and addresses
// ---------------------------------------------------------------------------

/** The page's address. The warning emails link to it, so it never moves. */
export const USAGE_HREF = "/dashboard/usage";

/** Where Billing adds credits. */
export const ADD_CREDITS_HREF = "/dashboard/billing#add-credits";

export const USAGE_WORDS = {
  title: "Usage",
  description: "What you have used and spent on the agents you pay for.",
  /** The link to this page from Billing and from Installed. */
  linkLabel: "Usage of what you pay for",
  balanceLabel: "Credits",
  balanceNote: "One balance pays for every agent you use.",
  addCredits: "Add credits",
  listTitle: "Agents you pay for",
  /** An organization that uses nothing. */
  empty: "You do not pay to use any agent yet.",
  browse: "Browse the marketplace",
  /** A row with no plan and nothing paid per use this month. */
  nothingPerUse: "No uses paid per use this month.",
  /** A row paid by the month, with no count of uses. The usage read sends neither its price nor its day. */
  paidMonthly: "You pay for this agent by the month. Its renewal is on the Installed page.",
  /** A renewal that was not paid and is being retried. The count line follows it, with no day in it. */
  renewalNotThrough: "Your renewal did not go through. Add credits to keep access.",
  /** Said once under the rows: which month and which days the page counts in. */
  utcNote: "Days and months on this page are counted in UTC.",
  keysLink: "What each API key spent today",
  /** The two warnings, as words beside the bar. The first holds from 85% up to one use short of all. */
  level85: "85% or more used",
  level100: "All used",
  loadFailed: "Couldn't load your usage",
} as const;

/** The zone a plan's days are written in: the one the API and its emails write them in. */
const PLAN_DAY_ZONE = "UTC";

/** "500 uses", "1 use". */
function usesWord(count: number): string {
  return `${count} ${count === 1 ? "use" : "uses"}`;
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

/** Where the bar is marked, in percent of its width. */
export const USAGE_BAR_MARKS = [
  { at: 85, label: "85%" },
  { at: 100, label: "100%" },
] as const;

export interface UsageBar {
  /** Every use of the period: the included ones and any brought into it. */
  totalUses: number;
  usedUses: number;
  /** How much of the bar is filled: a whole number from 0 to 100. */
  percent: number;
  /** The warning the API gave: 85, 100, or none. */
  level: null | 85 | 100;
  /** The warning in words, drawn beside the bar: "85% or more used", "All used". Null below 85%. */
  levelLabel: string | null;
  /** The numbers in text beside the bar: "425 of 500 uses used". */
  usedText: string;
  /** The text alternative of the bar: "Starter: 425 of 500 uses used. 85% or more used." */
  label: string;
}

/** The bar of a plan's period. `name` is the plan's, for its text alternative. */
export function usageBar(plan: PlanCount, name: string): UsageBar {
  // As the count line counts them, so the bar and the line beside it never disagree.
  const totalUses = Math.max(plan.includedUses, plan.usedUses + plan.remainingUses);
  const usedUses = Math.min(totalUses, Math.max(0, totalUses - plan.remainingUses));
  const level = plan.warning === 100 || plan.remainingUses === 0 ? 100 : plan.warning;
  const share = totalUses > 0 ? Math.floor((usedUses / totalUses) * 100) : 0;
  const percent = level === 100 ? 100 : Math.max(0, Math.min(100, share));
  const levelLabel = level === 100 ? USAGE_WORDS.level100 : level === 85 ? USAGE_WORDS.level85 : null;
  const usedText = `${usedUses} of ${usesWord(totalUses)} used`;
  return {
    totalUses,
    usedUses,
    percent,
    level,
    levelLabel,
    usedText,
    label: `${name}: ${usedText}.${levelLabel ? ` ${levelLabel}.` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// A row
// ---------------------------------------------------------------------------

export type UsageTone = "ok" | "warn";

export interface UsageRowView {
  listingId: string;
  title: string;
  /** The agent's page, /a/<handle>. Null when it has none: the title is then plain text. */
  href: string | null;
  /** The plan's name. Null for a row with no plan, which has no bar and no count. */
  planName: string | null;
  bar: UsageBar | null;
  /** Said before the count while a renewal is being retried. */
  renewalLine: string | null;
  /** What is left of the plan, in the words of the agent's page. */
  countLine: string | null;
  /** `warn` at 85%, at 100%, while a renewal is retried, and when the plan will not renew. */
  countTone: UsageTone;
  /** "12 extra uses this period: $0.48." Null when there were none. */
  extraLine: string | null;
  /** "37 uses paid per use this month: $1.85." Null when there were none. */
  perUseLine: string | null;
  /** What a row with nothing else to show says. */
  statusLine: string | null;
}

/** A count of uses and their cost, as sent; null when it is not one, or counts nothing. */
function spent(raw: UsesAndCents | null | undefined): UsesAndCents | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { uses, cents } = raw;
  if (typeof uses !== "number" || !Number.isInteger(uses) || uses < 1) return null;
  if (typeof cents !== "number" || !Number.isFinite(cents) || cents < 0) return null;
  return { uses, cents };
}

/** "12 extra uses this period: $0.48." */
export function extraUsesLine(sum: UsesAndCents): string {
  return `${sum.uses} extra ${sum.uses === 1 ? "use" : "uses"} this period: ${dollars(sum.cents)}.`;
}

/** "37 uses paid per use this month: $1.85." */
export function perUseLine(sum: UsesAndCents): string {
  return `${usesWord(sum.uses)} paid per use this month: ${dollars(sum.cents)}.`;
}

/**
 * What a use past a trial's uses costs this buyer, as the API said it: a
 * price, null (the trial stops and they choose), or undefined when the API
 * did not say or what it sent cannot be read. Nothing is guessed from it.
 */
function perUseAfterTrial(row: MarketplaceUsageRow): PaidPrice | null | undefined {
  const said = row.perUseAfterTrial;
  if (said === null) return null;
  if (typeof said !== "object") return undefined;
  const { priceCents, unit } = said;
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) return undefined;
  if (unit !== "message" && unit !== "run") return undefined;
  return { model: "per_request", cents: priceCents, unit };
}

/** One row of the page. A row with no plan shows only what it has. */
export function usageRow(row: MarketplaceUsageRow): UsageRowView {
  const count = row.access === "subscribed" ? planCountOf(row.plan) : null;
  const perUse = spent(row.perUseThisMonth);
  const base = {
    listingId: row.listingId,
    title: row.title,
    href: row.handle ? `/a/${row.handle}` : null,
    perUseLine: perUse ? perUseLine(perUse) : null,
  };

  if (!count || !row.plan) {
    // A plan that is over is said as Installed says it, and a free trial that is over by its own
    // sentence when the API says that is what ended. A month with no count is said as one, so
    // nobody who pays by the month reads that nothing was paid. A plan whose count could not be
    // read says nothing. Any other row with nothing paid says so.
    const over = row.trialEnded === true ? INSTALLED_WORDS.trialEnded : INSTALLED_WORDS.planEnded;
    const ended = row.access === "plan_ended" ? over : null;
    const subscribed = row.access === "subscribed";
    const monthly = subscribed && !row.plan ? USAGE_WORDS.paidMonthly : null;
    const nothing = subscribed || perUse ? null : USAGE_WORDS.nothingPerUse;
    return {
      ...base,
      planName: null,
      bar: null,
      renewalLine: null,
      countLine: null,
      countTone: "ok",
      extraLine: null,
      statusLine: ended ?? monthly ?? nothing,
    };
  }

  const extra = spent(row.extraThisPeriod);
  if (row.plan.trial === true) {
    // A free trial has one name everywhere, and no renewal to be retried or to wait for. When its uses
    // are gone the line says what comes next from the API's own word: the price each use now costs a
    // buyer who agreed to it, or that they choose. Without that word it says only that the uses are gone.
    const perUse = perUseAfterTrial(row);
    return {
      ...base,
      planName: TRIAL_WORDS.name,
      bar: usageBar(count, TRIAL_WORDS.name),
      renewalLine: null,
      countLine: trialCountLine({
        plan: count,
        endsAt: row.periodEndsAt,
        ...(perUse === undefined ? {} : { perUse }),
        dates: { timeZone: PLAN_DAY_ZONE },
      }),
      // From 85% used the bar says so at its warning level, and the line beside it takes the same tone.
      countTone: count.remainingUses > 0 && count.warning === null ? "ok" : "warn",
      // The trial's own uses are never extra ones. Uses past them are charged only to a buyer who agreed
      // to the price per use, and what was charged is never left out of this page.
      extraLine: extra ? extraUsesLine(extra) : null,
      statusLine: null,
    };
  }

  const planName = row.plan.name.trim() || "Plan";
  const pastDue = row.renewalPastDue === true;
  // Quiet only while there are uses left, no warning, nothing being retried, and the plan will renew.
  const quiet = count.warning === null && count.remainingUses > 0 && Boolean(count.resetsAt) && !pastDue;
  return {
    ...base,
    planName,
    bar: usageBar(count, planName),
    renewalLine: pastDue ? USAGE_WORDS.renewalNotThrough : null,
    countLine: planCountLine({
      plan: count,
      endsAt: row.periodEndsAt,
      pastDue,
      dates: { timeZone: PLAN_DAY_ZONE },
    }),
    countTone: quiet ? "ok" : "warn",
    extraLine: extra ? extraUsesLine(extra) : null,
    statusLine: null,
  };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export interface UsageView {
  /** "$12.40". Null when the answer named no balance: nothing is drawn then, never $0.00. */
  balance: string | null;
  rows: UsageRowView[];
  /** The sentence of an organization that uses nothing. Null when there are rows. */
  empty: string | null;
}

/** The page, from the API's answer. Anything that is not a list of rows reads as no rows. */
export function usageView(usage: MarketplaceUsage | null | undefined): UsageView {
  const cents = usage?.balanceCents;
  const listings = Array.isArray(usage?.listings) ? usage.listings : [];
  const rows = listings.filter((row) => typeof row === "object" && row !== null).map(usageRow);
  return {
    balance: typeof cents === "number" && Number.isFinite(cents) ? dollars(cents) : null,
    rows,
    empty: rows.length === 0 ? USAGE_WORDS.empty : null,
  };
}
