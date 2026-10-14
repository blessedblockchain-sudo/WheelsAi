/**
 * One row of Installed: an agent the organization uses, or a copy it owns.
 *
 * Built from what the API reports for the licence: its kind, its access (the
 * same rule billing applies), the pricing the buyer accepted, the
 * subscription, the counters and the listing as it is now.
 *
 *   use   the creator's agent, used on its page `/a/<handle>`. There is no
 *         copy, so a use row never links into the dashboard's agents.
 *   copy  the buyer's own copy. Its row is what Installed has always shown.
 *
 * Pure: no IO, no React. The page draws what this returns and sends the
 * `terms` of the row (the pricing the person was shown) with an acceptance.
 *
 * A use row whose buyer is on a plan is worded by lib/installed-plans.ts:
 * its badge, the count of what is left, moving up, and what stopping gives
 * up. So is a row on the listing's free trial, which can only be stopped.
 * Every other row is what it was before plans existed.
 */
import type {
  MarketplaceAcceptedPricing,
  MarketplaceInstallAccess,
  MarketplaceInstallKind,
  MarketplaceLicenceAgent,
  MarketplaceListing,
  MarketplacePricingTerms,
  MarketplaceSubscription,
} from "./api";
import { formatCents } from "./agent-page";
import {
  INSTALLED_PLAN_WORDS,
  biggerPlans,
  planBadge,
  planLine,
  planOfInstall,
  planRenewal,
  planStopSentence,
  renewalNotThroughLine,
} from "./installed-plans";
import { priceTextForUse, unitWordOfUse } from "./listing-cta";

/** A row of `GET /api/marketplace/my-installs`. */
export interface InstalledLicence {
  id: string;
  listingId: string;
  kind: MarketplaceInstallKind;
  /** null for a "use" row: there is no copy to open. */
  clonedAgentId: string | null;
  agent: MarketplaceLicenceAgent;
  status: string;
  totalRequests: number;
  totalSpentCents: number;
  installedAt: string;
  access: MarketplaceInstallAccess;
  acceptedPricing: MarketplaceAcceptedPricing;
  listing: MarketplaceListing;
  subscription: MarketplaceSubscription | null;
}

export type InstalledTone = "ok" | "warn" | "bad";

export interface InstalledLine {
  text: string;
  tone: InstalledTone;
}

export type InstalledActionId =
  | "open"
  | "view_listing"
  | "accept_pricing"
  | "resubscribe"
  // On a plan: choose a bigger one. The page lists them, then asks before it charges.
  | "move_up"
  | "resume"
  | "cancel"
  | "review"
  | "uninstall";

export interface InstalledAction {
  id: InstalledActionId;
  label: string;
  /** Set for a link; the others are buttons the page handles. */
  href?: string;
  newTab?: boolean;
  destructive?: boolean;
}

export interface InstalledRow {
  kind: MarketplaceInstallKind;
  badge: "You use it" | "Your copy";
  /** The price in the row's badge. */
  priceLabel: string;
  /** Where the licence stands. A use row always has one. */
  line: InstalledLine | null;
  /** Where Open goes; null when there is nowhere to go. */
  openHref: string | null;
  /** The counters at the row's right; null when the line already gives them. */
  usage: { count: string; spent: string } | null;
  actions: InstalledAction[];
  /** The listing's pricing as this row shows it: what an acceptance sends as `expected`. */
  terms: MarketplacePricingTerms;
  /**
   * Set when the row holds back Move up or Resume renewal because the person
   * reading it may not spend for the organization. The page says it once for
   * the whole list (`askAdminOnce`). Absent from every other row, which is
   * exactly the row it was before this was said.
   */
  askAdmin?: string;
}

/** Who reads the page, as `GET /api/marketplace/my-installs` says it. */
export interface InstalledViewer {
  /**
   * Whether they may start, move up or resume: an owner or admin of the
   * organization. Only a clear "no" changes a row; true or absent leaves the
   * page what it has always been.
   */
  canSpend?: boolean;
}

export interface InstalledConfirm {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
}

export interface InstalledFormat {
  /** The time zone dates are written in; the reader's own when left out. */
  timeZone?: string;
  /** The locale a copy's request count is written in; the reader's own when left out. */
  locale?: string;
}

/** The words of Installed. */
export const INSTALLED_WORDS = {
  header: "Agents you use, and copies you own.",
  use: "You use it",
  copy: "Your copy",
  notOffered: "No longer offered. You will not be charged again.",
  lapsed: "Your subscription has ended. Subscribe again to keep using it.",
  planEnded: "Your plan ended. Choose a plan or pay per use to keep using it.",
  /** A free trial that is over. The plans and the price per use are chosen on the agent's page, where Open goes. */
  trialEnded: "Your free trial ended. Choose a plan or pay per use to keep using it.",
  stopped: "You have stopped using this agent.",
  nowFree: "This agent is now free to use on its page.",
  /** Said once to a member who may not move up or resume a renewal. */
  askAdmin: "Ask an owner or admin of your organization to move up a plan or to resume a renewal.",
} as const;

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export function termsOf(listing: MarketplaceListing): MarketplacePricingTerms {
  return {
    pricingModel: listing.pricingModel,
    pricePerRequestCents: listing.pricePerRequestCents,
    monthlyPriceCents: listing.monthlyPriceCents,
  };
}

/** Whether the listing can still be subscribed to or its pricing accepted. */
function stillSold(install: InstalledLicence): boolean {
  return install.listing.status === "published";
}

/** Inside a period the buyer already paid for, whatever the listing charges now. */
function paidUp(install: InstalledLicence): boolean {
  return install.access === "subscribed" && !!install.subscription?.hasAccess;
}

// ---------------------------------------------------------------------------
// A copy: exactly what Installed showed before use could be sold
// ---------------------------------------------------------------------------

function copyDate(iso: string, fmt: InstalledFormat): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(fmt.timeZone ? { timeZone: fmt.timeZone } : {}),
  });
}

function copyMonthly(cents: number): string {
  return `$${(cents / 100).toFixed(2)}/mo`;
}

function copyPrice(listing: Pick<MarketplaceListing, "pricingModel" | "pricePerRequestCents" | "monthlyPriceCents">): string {
  if (listing.pricingModel === "free") return "Free";
  if (listing.pricingModel === "tokenized") return "Token Gated";
  if (listing.pricingModel === "per_request" && listing.pricePerRequestCents) {
    return `$${(listing.pricePerRequestCents / 100).toFixed(4)}/req`;
  }
  if (listing.pricingModel === "monthly" && listing.monthlyPriceCents) {
    return `$${(listing.monthlyPriceCents / 100).toFixed(2)}/mo`;
  }
  return "Free";
}

/**
 * What the buyer agreed to when they installed or last accepted a change, in
 * the listing's own wording. Null when nothing is on record, or when a
 * subscription's agreed price says it better.
 */
function copyAgreedPricing(install: InstalledLicence): string | null {
  const agreed = install.acceptedPricing;
  if (!agreed?.pricingModel || agreed.pricingModel === "monthly") return null;
  return copyPrice({
    ...install.listing,
    pricingModel: agreed.pricingModel,
    pricePerRequestCents: agreed.pricePerRequestCents,
  });
}

/**
 * Driven by the access the API reports and the subscription's own agreed
 * price, never by the listing's current pricing model: a publisher can change
 * that while a paid period is still running.
 */
function copyLine(install: InstalledLicence, fmt: InstalledFormat): InstalledLine | null {
  const sub = install.subscription;
  if (install.access === "pricing_changed") {
    if (!stillSold(install)) {
      return { text: "Paused. This agent is no longer sold on the marketplace.", tone: "bad" };
    }
    const agreedTo = copyAgreedPricing(install);
    return {
      text: `The publisher changed this agent's pricing${agreedTo ? ` (you agreed to ${agreedTo}; it is now ${copyPrice(install.listing)})` : ""}. It is paused, and nothing is charged, until you accept the new pricing.`,
      tone: "bad",
    };
  }
  if (install.access === "subscription_lapsed") {
    return stillSold(install)
      ? { text: "Subscription lapsed. Resubscribe to use this agent again.", tone: "bad" }
      : { text: "Subscription ended. This agent is no longer sold on the marketplace.", tone: "bad" };
  }
  if (install.access === "unlisted") {
    return { text: "No longer sold on the marketplace. Your copy keeps running at no charge.", tone: "ok" };
  }
  if (!sub || !paidUp(install)) return null;

  const agreed = sub.priceCents !== null ? ` at ${copyMonthly(sub.priceCents)}` : "";
  if (install.listing.pricingModel !== "monthly") {
    return {
      text: `The publisher changed this agent's pricing. Your subscription${agreed} runs until ${copyDate(sub.currentPeriodEnd, fmt)}; after that it pauses until you accept the new pricing.`,
      tone: "warn",
    };
  }
  if (sub.status === "past_due") {
    return {
      text: `Renewal${agreed} failed: add credits before ${copyDate(sub.graceEndsAt ?? sub.currentPeriodEnd, fmt)} to keep access.`,
      tone: "warn",
    };
  }
  if (sub.cancelAtPeriodEnd) {
    return { text: `Cancelled. Access ends ${copyDate(sub.currentPeriodEnd, fmt)}.`, tone: "warn" };
  }
  if (sub.priceCents === null) {
    return {
      text: `Paid until ${copyDate(sub.currentPeriodEnd, fmt)}. You will be asked to confirm the price before it renews.`,
      tone: "warn",
    };
  }
  return { text: `Renews ${copyDate(sub.currentPeriodEnd, fmt)}${agreed}`, tone: "ok" };
}

function copyRow(install: InstalledLicence, fmt: InstalledFormat): InstalledRow {
  const openHref = install.clonedAgentId ? `/dashboard/agents/${install.clonedAgentId}` : null;
  // A subscriber sees the price they agreed to, which is what a renewal charges.
  const agreed = install.subscription?.priceCents;
  const priceLabel = paidUp(install) && agreed != null ? copyMonthly(agreed) : copyPrice(install.listing);

  const actions: InstalledAction[] = [];
  if (openHref) actions.push({ id: "open", label: "View Agent", href: openHref });
  actions.push({ id: "view_listing", label: "View Listing", href: `/marketplace/${install.listing.slug}`, newTab: true });
  if (install.access === "pricing_changed" && stillSold(install)) {
    actions.push({ id: "accept_pricing", label: "Accept new pricing" });
  }
  if (install.access === "subscription_lapsed" && stillSold(install)) {
    actions.push({ id: "resubscribe", label: "Resubscribe" });
  }
  if (paidUp(install) && install.listing.pricingModel === "monthly") {
    actions.push(
      install.subscription?.cancelAtPeriodEnd
        ? { id: "resume", label: "Resume renewal" }
        : { id: "cancel", label: "Cancel renewal" },
    );
  }
  actions.push({ id: "review", label: "Write Review" });
  actions.push({ id: "uninstall", label: "Uninstall", destructive: true });

  return {
    kind: "copy",
    badge: INSTALLED_WORDS.copy,
    priceLabel,
    line: copyLine(install, fmt),
    openHref,
    usage: {
      count: `${install.totalRequests.toLocaleString(fmt.locale)} requests`,
      spent: `$${(install.totalSpentCents / 100).toFixed(2)} spent`,
    },
    actions,
    terms: termsOf(install.listing),
  };
}

function copyConfirm(install: InstalledLicence, action: InstalledActionId, fmt: InstalledFormat): InstalledConfirm | null {
  const { listing } = install;
  if (action === "accept_pricing") {
    return {
      title: `Accept the new pricing for ${listing.title}?`,
      description:
        listing.pricingModel === "monthly"
          ? `The publisher now charges ${copyPrice(listing)}. Accepting starts a new subscription and charges the first month from your credits now.`
          : `The publisher changed this agent's pricing to: ${copyPrice(listing)}. Accepting turns your copy back on under that pricing.`,
      confirmLabel: "Accept new pricing",
    };
  }
  if (action === "uninstall") {
    // A paid-up period that uninstalling would give up without a refund.
    const forfeits = paidUp(install) ? install.subscription : null;
    return {
      title: `Uninstall ${listing.title}?`,
      description: forfeits
        ? listing.pricingModel === "monthly"
          ? `This ends your subscription now, and the current period (paid until ${copyDate(forfeits.currentPeriodEnd, fmt)}) is not refunded. To keep access until the period ends, cancel renewal instead.`
          : `You have paid for access until ${copyDate(forfeits.currentPeriodEnd, fmt)}. Uninstalling gives that up without a refund, and the publisher has since changed the pricing: reinstalling would be under the new pricing (${copyPrice(listing)}).`
        : "Its copy in your workspace stops working. You can reinstall it later.",
      confirmLabel: "Uninstall",
      destructive: true,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Use of the creator's agent
// ---------------------------------------------------------------------------

/** "12 Nov". */
export function shortDay(iso: string, fmt: InstalledFormat = {}): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(fmt.timeZone ? { timeZone: fmt.timeZone } : {}),
  }).format(new Date(iso));
}

/** "37 uses", "1 use". */
function usesText(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "use" : "uses"}`;
}

/** The listing sells use of this agent today. */
function sellsUseNow(install: InstalledLicence): boolean {
  return install.listing.status === "published" && install.listing.sells === "use";
}

/**
 * Whether the plan that is over on this row was the listing's free trial. A
 * trial is the one row with a count of uses that was agreed at no price, the
 * mark the API tells a trial by.
 */
function trialEnded(install: InstalledLicence): boolean {
  return install.access === "plan_ended" && install.subscription?.priceCents === 0;
}

/** What an acceptance of the listing's pricing would agree to; null when it names no price. */
function offerForUse(install: InstalledLicence): { sentence: string; button: string; monthly: boolean } | null {
  const { listing } = install;
  if (!sellsUseNow(install)) return null;
  if (listing.pricingModel === "per_request" && listing.pricePerRequestCents) {
    const unit = unitWordOfUse(listing.unit);
    const price = formatCents(listing.pricePerRequestCents);
    return {
      sentence: `Each ${unit} costs ${price}, paid from your credits. It is charged when you send it and refunded if the agent does not answer. You can stop at any time.`,
      button: `Accept ${price} per ${unit}`,
      monthly: false,
    };
  }
  if (listing.pricingModel === "monthly" && listing.monthlyPriceCents) {
    const price = formatCents(listing.monthlyPriceCents);
    return {
      sentence: `Charges ${price} from your credits now and every 30 days. Cancel at any time and keep access until the month you paid for ends.`,
      button: `Subscribe for ${price} a month`,
      monthly: true,
    };
  }
  return null;
}

function lineForUse(install: InstalledLicence, fmt: InstalledFormat): InstalledLine {
  const { listing, subscription: sub, access } = install;
  const offered = sellsUseNow(install);
  const notOffered: InstalledLine = { text: INSTALLED_WORDS.notOffered, tone: "bad" };

  if (access === "subscribed") {
    if (!sub) return { text: `You are subscribed. ${usesText(install.totalRequests)}.`, tone: "ok" };
    const until = shortDay(sub.currentPeriodEnd, fmt);
    if (!offered || sub.endReason === "use_ended") {
      return { text: `No longer offered. You keep access until ${until}.`, tone: "warn" };
    }
    if (sub.cancelAtPeriodEnd) {
      return { text: `Cancelled. You keep access until ${until}.`, tone: "warn" };
    }
    if (listing.pricingModel !== "monthly") {
      return {
        text: `The owner changed how this agent is sold. You keep access until ${until}. After that, nothing is charged until you accept the new price.`,
        tone: "warn",
      };
    }
    if (sub.status === "past_due") {
      const before = shortDay(sub.graceEndsAt ?? sub.currentPeriodEnd, fmt);
      return { text: renewalNotThroughLine(sub.priceCents, before), tone: "warn" };
    }
    if (sub.priceCents === null) return { text: `Paid until ${until}.`, tone: "ok" };
    return { text: `Renews ${until} at ${formatCents(sub.priceCents)} a month.`, tone: "ok" };
  }

  if (access === "listing_pricing") {
    const uses = usesText(install.totalRequests);
    if (listing.pricingModel === "per_request" && listing.pricePerRequestCents) {
      return {
        text: `${priceTextForUse(listing)}. ${uses}, ${formatCents(install.totalSpentCents)} spent.`,
        tone: "ok",
      };
    }
    if (listing.pricingModel === "free") return { text: `Free to use. ${uses}.`, tone: "ok" };
    return { text: `You use this agent. ${uses}.`, tone: "ok" };
  }

  if (access === "pricing_changed") {
    if (!offered) return notOffered;
    const agreed = install.acceptedPricing;
    if (listing.pricingModel === "per_request" && listing.pricePerRequestCents) {
      const unit = unitWordOfUse(listing.unit);
      const now = formatCents(listing.pricePerRequestCents);
      if (agreed?.pricingModel === "per_request" && agreed.pricePerRequestCents != null) {
        return {
          text: `The owner changed the price to ${now} per ${unit}. You agreed to ${formatCents(agreed.pricePerRequestCents)}. Nothing is charged until you accept the new price.`,
          tone: "bad",
        };
      }
      return {
        text: `This agent is now sold per ${unit} (${now}). Nothing is charged until you accept the new price.`,
        tone: "bad",
      };
    }
    if (listing.pricingModel === "monthly" && listing.monthlyPriceCents) {
      return {
        text: `This agent is now sold by the month (${formatCents(listing.monthlyPriceCents)}). Nothing is charged until you subscribe.`,
        tone: "bad",
      };
    }
    // An ended subscription to an agent that is free now: there is no price
    // to accept, and its page takes anyone.
    if (listing.pricingModel === "free") return { text: INSTALLED_WORDS.nowFree, tone: "ok" };
    return {
      text: "The owner changed how this agent is sold. Nothing is charged until you accept the new price.",
      tone: "bad",
    };
  }

  if (access === "subscription_lapsed") {
    return offered ? { text: INSTALLED_WORDS.lapsed, tone: "bad" } : notOffered;
  }
  // A plan that is over. The plans and the price per use are chosen on the agent's page, where Open goes.
  if (access === "plan_ended") {
    if (!offered) return notOffered;
    return { text: trialEnded(install) ? INSTALLED_WORDS.trialEnded : INSTALLED_WORDS.planEnded, tone: "bad" };
  }
  if (access === "not_offered" || access === "unlisted") return notOffered;
  // none, uninstalled: a licence that grants nothing.
  return { text: INSTALLED_WORDS.stopped, tone: "bad" };
}

/**
 * A buyer on a plan. The badge is the plan and the price they agreed to, the
 * line counts what is left, and the row offers what a plan can do: move up
 * (only when the listing offers a plan that costs more), cancel or resume
 * the renewal, stop. On the free trial the badge is "Free trial", the line
 * is the trial's count, and stopping is all a plan's actions leave: a trial
 * has no renewal and nobody moves up from one (lib/installed-plans.ts
 * answers so for each).
 */
function rowForPlan(install: InstalledLicence, fmt: InstalledFormat, viewer: InstalledViewer): InstalledRow {
  const { listing } = install;
  const openHref = install.agent.handle ? `/a/${install.agent.handle}` : null;
  const renewal = planRenewal(install);

  const actions: InstalledAction[] = [];
  if (openHref) actions.push({ id: "open", label: "Open", href: openHref });
  actions.push({ id: "view_listing", label: "View Listing", href: `/marketplace/${listing.slug}`, newTab: true });
  if (biggerPlans(install).length > 0) actions.push({ id: "move_up", label: INSTALLED_PLAN_WORDS.moveUp });
  if (renewal === "cancel") actions.push({ id: "cancel", label: "Cancel renewal" });
  if (renewal === "resume") actions.push({ id: "resume", label: "Resume renewal" });
  actions.push({ id: "review", label: "Write Review" });
  actions.push({ id: "uninstall", label: "Stop using", destructive: true });

  return {
    kind: "use",
    badge: INSTALLED_WORDS.use,
    priceLabel: planBadge(install) ?? priceTextForUse(listing),
    line: planLine(install, fmt, viewer) ?? lineForUse(install, fmt),
    openHref,
    usage: { count: usesText(install.totalRequests), spent: `${formatCents(install.totalSpentCents)} spent` },
    actions,
    terms: termsOf(listing),
  };
}

function rowForUse(install: InstalledLicence, fmt: InstalledFormat, viewer: InstalledViewer): InstalledRow {
  if (planOfInstall(install)) return rowForPlan(install, fmt, viewer);
  const { listing, subscription: sub, access } = install;
  const openHref = install.agent.handle ? `/a/${install.agent.handle}` : null;
  const offer = offerForUse(install);
  const subscribed = access === "subscribed" && !!sub;
  const renewable =
    subscribed && sellsUseNow(install) && listing.pricingModel === "monthly" && sub!.endReason !== "use_ended";

  // A subscriber sees the price they agreed to, which is what a renewal charges.
  const priceLabel =
    subscribed && sub!.priceCents !== null ? `${formatCents(sub!.priceCents)} a month` : priceTextForUse(listing);

  const actions: InstalledAction[] = [];
  if (openHref) actions.push({ id: "open", label: "Open", href: openHref });
  actions.push({ id: "view_listing", label: "View Listing", href: `/marketplace/${listing.slug}`, newTab: true });
  if (access === "pricing_changed" && offer) actions.push({ id: "accept_pricing", label: "Accept new price" });
  if (access === "subscription_lapsed" && offer?.monthly) actions.push({ id: "resubscribe", label: "Subscribe again" });
  if (renewable) {
    actions.push(
      sub!.cancelAtPeriodEnd ? { id: "resume", label: "Resume renewal" } : { id: "cancel", label: "Cancel renewal" },
    );
  }
  actions.push({ id: "review", label: "Write Review" });
  actions.push({ id: "uninstall", label: "Stop using", destructive: true });

  const perUse = access === "listing_pricing" && listing.pricingModel === "per_request" && !!listing.pricePerRequestCents;

  return {
    kind: "use",
    badge: INSTALLED_WORDS.use,
    priceLabel,
    line: lineForUse(install, fmt),
    openHref,
    usage: perUse
      ? null
      : { count: usesText(install.totalRequests), spent: `${formatCents(install.totalSpentCents)} spent` },
    actions,
    terms: termsOf(listing),
  };
}

function confirmForUse(install: InstalledLicence, action: InstalledActionId, fmt: InstalledFormat): InstalledConfirm | null {
  const { listing, subscription: sub } = install;
  if (action === "accept_pricing" || action === "resubscribe") {
    const offer = offerForUse(install);
    if (!offer) return null;
    return {
      title: offer.monthly ? `Subscribe to ${listing.title}?` : `Accept the new price for ${listing.title}?`,
      description: offer.sentence,
      confirmLabel: offer.button,
    };
  }
  if (action === "uninstall") {
    const title = `Stop using ${listing.title}?`;
    const confirmLabel = "Stop using";
    // A plan ends now too, and the 30 days paid for are not refunded: said in a plan's own words.
    const plan = planStopSentence(install, fmt);
    if (plan !== null) return { title, description: plan, confirmLabel, destructive: true };
    // A renewal that did not go through: the month paid for is already
    // over, so there is no date to keep access until and nothing to refund.
    if (paidUp(install) && sub && sub.status === "past_due") {
      return {
        title,
        description: "This ends your subscription and your access now. You are not charged again.",
        confirmLabel,
        destructive: true,
      };
    }
    if (paidUp(install) && sub) {
      const until = shortDay(sub.currentPeriodEnd, fmt);
      const canCancelInstead =
        !sub.cancelAtPeriodEnd && sellsUseNow(install) && listing.pricingModel === "monthly" && sub.endReason !== "use_ended";
      return {
        title,
        description: canCancelInstead
          ? `This ends your subscription now. The month you paid for (until ${until}) is not refunded. To keep access until then, cancel renewal instead.`
          : `This ends your access now. The month you paid for (until ${until}) is not refunded.`,
        confirmLabel,
        destructive: true,
      };
    }
    const usable = install.access === "listing_pricing";
    return {
      title,
      description: usable
        ? listing.pricingModel === "free"
          ? "It leaves this list. You can start using it again on its page."
          : "You are not charged again. You can start using it again on its page."
        : "It leaves this list. You are not charged again.",
      confirmLabel,
      destructive: true,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** The actions that turn a charge on, which the API refuses to someone who may not spend. */
const NEEDS_SPEND: ReadonlyArray<InstalledActionId> = ["move_up", "resume"];

/**
 * One row of Installed. For a member who may not spend (`viewer.canSpend` is
 * false) the row does not offer Move up or Resume renewal, its line does not
 * point at moving up, and `askAdmin` says who to ask. For everyone else it
 * is the row it has always been.
 */
export function installedRow(
  install: InstalledLicence,
  fmt: InstalledFormat = {},
  viewer: InstalledViewer = {},
): InstalledRow {
  const row = install.kind === "use" ? rowForUse(install, fmt, viewer) : copyRow(install, fmt);
  if (viewer.canSpend !== false) return row;
  const actions = row.actions.filter((action) => !NEEDS_SPEND.includes(action.id));
  if (actions.length === row.actions.length) return row;
  return { ...row, actions, askAdmin: INSTALLED_WORDS.askAdmin };
}

/**
 * "Ask an owner or admin of your organization to move up a plan or to resume a renewal.", once
 * for the whole list, when any row held something back. Null otherwise.
 */
export function askAdminOnce(rows: ReadonlyArray<Pick<InstalledRow, "askAdmin">>): string | null {
  return rows.find((row) => row.askAdmin !== undefined)?.askAdmin ?? null;
}

/**
 * The dialog shown before an action; null when the action needs none. An
 * acceptance's button names the price, because that click is the agreement.
 */
export function installedConfirm(
  install: InstalledLicence,
  action: InstalledActionId,
  fmt: InstalledFormat = {},
): InstalledConfirm | null {
  return install.kind === "use" ? confirmForUse(install, action, fmt) : copyConfirm(install, action, fmt);
}
