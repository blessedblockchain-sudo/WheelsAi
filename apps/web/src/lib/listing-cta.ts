/**
 * What a marketplace listing's price card says and which button it shows.
 *
 * A listing sells one of two things. Copies: the buyer installs their own
 * copy, and this file answers exactly what the page said before use could be
 * sold. Use: the buyer uses the creator's agent on its page, `/a/<handle>`,
 * and never gets a copy; the card says so, names the price with its unit and
 * opens that page.
 *
 * Pure: no IO, no React. The page draws what this returns.
 */
import type { MarketplaceInstallAccess, MarketplaceInstallKind, MarketplaceListing } from "./api";
import { formatCents } from "./agent-page";

type ListingPricing = Pick<
  MarketplaceListing,
  "sells" | "pricingModel" | "pricePerRequestCents" | "monthlyPriceCents" | "unit" | "plans" | "plansFromCents"
>;

/** The words of the listing page for a listing that sells use. */
export const LISTING_USE_WORDS = {
  button: "Use this agent",
  footnote: "You use it on its page. You do not get a copy.",
  inUse: "You use this agent.",
  open: "Open",
  free: "Free to use on its page.",
  people: "People using it",
} as const;

/** "message" or "run": what one paid use of this listing is called. */
export function unitWordOfUse(unit: MarketplaceListing["unit"]): "message" | "run" | "use" {
  if (unit === "message" || unit === "run") return unit;
  return "use";
}

/** "$0.05 per message", "$0.10 per run", "$9.00 a month", "Free": a use listing's price with its unit. */
export function priceTextForUse(listing: ListingPricing): string {
  if (listing.pricingModel === "per_request" && listing.pricePerRequestCents) {
    return `${formatCents(listing.pricePerRequestCents)} per ${unitWordOfUse(listing.unit)}`;
  }
  if (listing.pricingModel === "monthly" && listing.monthlyPriceCents) {
    return `${formatCents(listing.monthlyPriceCents)} a month`;
  }
  if (listing.pricingModel === "tokenized") return "Token Gated";
  return "Free";
}

/**
 * The smallest price among the plans a listing offers, in cents; null when it
 * offers none or the read did not say. The search says it outright
 * (`plansFromCents`); the reads that carry the plans themselves are measured
 * here.
 */
export function plansFromCentsOf(listing: Pick<ListingPricing, "plans" | "plansFromCents">): number | null {
  const isPrice = (cents: unknown): cents is number => typeof cents === "number" && Number.isFinite(cents) && cents > 0;
  if (isPrice(listing.plansFromCents)) return listing.plansFromCents;
  if (!Array.isArray(listing.plans)) return null;
  const prices = listing.plans.map((plan) => plan?.priceCents).filter(isPrice);
  return prices.length > 0 ? Math.min(...prices) : null;
}

/** "Plans from $9.00 for 30 days." */
export function plansFromLine(cents: number): string {
  return `Plans from ${formatCents(cents)} for 30 days.`;
}

/** The price of a listing that offers plans, in the two parts a card draws apart. */
export interface PriceWithPlans {
  /** "From $0.05 a message": the price per use, which stays the base. */
  from: string;
  /** "Plans from $9.00 for 30 days." */
  plans: string;
  /** Both, as the listing page says them: "From $0.05 a message. Plans from $9.00 for 30 days." */
  line: string;
}

/**
 * What a listing that sells use per request and offers plans says of its
 * price. Null for every other listing, which reads exactly as it did before
 * plans existed. Never said: how many people are on a plan.
 */
export function priceWithPlans(listing: ListingPricing): PriceWithPlans | null {
  if (listing.sells !== "use" || listing.pricingModel !== "per_request" || !listing.pricePerRequestCents) return null;
  const cents = plansFromCentsOf(listing);
  if (cents === null) return null;
  const from = `From ${formatCents(listing.pricePerRequestCents)} a ${unitWordOfUse(listing.unit)}`;
  const plans = plansFromLine(cents);
  return { from, plans, line: `${from}. ${plans}` };
}

/** A copies listing's price, as the listing page has always written it. */
export function copyPriceText(listing: ListingPricing): string {
  if (listing.pricingModel === "free") return "Free";
  if (listing.pricingModel === "tokenized") return "Token Gated";
  if (listing.pricingModel === "per_request" && listing.pricePerRequestCents) {
    return `$${(listing.pricePerRequestCents / 100).toFixed(4)} per request`;
  }
  if (listing.pricingModel === "monthly" && listing.monthlyPriceCents) {
    return `$${(listing.monthlyPriceCents / 100).toFixed(2)}/month`;
  }
  return "Free";
}

/** What the signed-in person's organization holds for this listing, from `install-status`. */
export interface ListingCtaInstall {
  /** `isInstalled`: the licence row is active. */
  installed: boolean;
  kind: MarketplaceInstallKind | null;
  access: MarketplaceInstallAccess | null;
  clonedAgentId: string | null;
}

export interface ListingCtaInput {
  listing: ListingPricing & { slug: string; agent?: { handle?: string | null } };
  authed: boolean;
  /** null while it is loading, and for someone signed out. */
  install: ListingCtaInstall | null;
  /** An install request is on its way. */
  installing?: boolean;
  /** The symbol of the listing's token, when it has one. */
  tokenSymbol?: string | null;
}

export type ListingCtaButton =
  | { type: "link"; label: string; href: string; tone: "primary" | "success"; icon: "play" | "check" }
  | { type: "install"; label: string; disabled: boolean };

export interface ListingCta {
  sellsUse: boolean;
  /** The large price. */
  price: string;
  /** Free is drawn in green. */
  priceIsFree: boolean;
  /** The line under the price; null when there is none. */
  priceNote: string | null;
  /** Said above the button when the person already uses the agent. */
  status: string | null;
  /** null when there is nowhere to send the person (a use listing whose agent has no page). */
  button: ListingCtaButton | null;
  /** A second, quieter link. */
  secondary: { label: string; href: string } | null;
  /** The small line under the buttons. */
  footnote: string;
}

/** The organization uses the creator's agent now: a use can run. */
export function usesAgent(install: ListingCtaInstall | null): boolean {
  return (
    !!install &&
    install.kind === "use" &&
    (install.access === "subscribed" || install.access === "listing_pricing")
  );
}

function ctaForUse(input: ListingCtaInput): ListingCta {
  const { listing, authed, install } = input;
  const handle = listing.agent?.handle ?? null;
  const page = handle ? `/a/${handle}` : null;
  const free = listing.pricingModel === "free";

  let price = priceTextForUse(listing);
  let priceNote: string | null = null;
  if (free) {
    priceNote = LISTING_USE_WORDS.free;
  } else if (listing.pricingModel === "per_request" && listing.pricePerRequestCents) {
    // With plans on offer the line names both ways to pay; without, it is what it has always been.
    priceNote = priceWithPlans(listing)?.line ?? `${price}, charged as you go.`;
    price = formatCents(listing.pricePerRequestCents);
  } else if (listing.pricingModel === "monthly" && listing.monthlyPriceCents) {
    priceNote = `${price} from your credits. Cancel at any time.`;
    price = formatCents(listing.monthlyPriceCents);
  }

  const inUse = authed && usesAgent(install);
  // Someone who took a copy before the listing changed to selling use keeps it.
  const copyId = authed && install?.installed && install.kind === "copy" ? install.clonedAgentId : null;

  return {
    sellsUse: true,
    price,
    priceIsFree: free,
    priceNote,
    status: inUse ? LISTING_USE_WORDS.inUse : null,
    button: page
      ? inUse
        ? { type: "link", label: LISTING_USE_WORDS.open, href: page, tone: "success", icon: "check" }
        : { type: "link", label: LISTING_USE_WORDS.button, href: page, tone: "primary", icon: "play" }
      : null,
    secondary: copyId ? { label: "Open your copy", href: `/dashboard/agents/${copyId}` } : null,
    footnote: LISTING_USE_WORDS.footnote,
  };
}

function copiesCta(input: ListingCtaInput): ListingCta {
  const { listing, authed, install, installing = false, tokenSymbol = null } = input;
  const isMonthly = listing.pricingModel === "monthly" && !!listing.monthlyPriceCents;
  const monthlyPrice = isMonthly ? `$${(listing.monthlyPriceCents! / 100).toFixed(2)}` : "";
  // A licence for use that is still active on a listing that now sells
  // copies: the organization uses the creator's agent and holds no copy, so
  // it is not "installed", and the API refuses an install until it stops.
  const holdsUse = authed && !!install?.installed && install.kind === "use";
  const installed = authed && !!install?.installed && !holdsUse;

  let button: ListingCtaButton;
  if (holdsUse) {
    button = {
      type: "link",
      label: "Open Installed",
      href: "/dashboard/marketplace/installs",
      tone: "primary",
      icon: "play",
    };
  } else if (installed) {
    button = {
      type: "link",
      label: "Installed — Open in Dashboard",
      href: install!.clonedAgentId ? `/dashboard/agents/${install!.clonedAgentId}` : "/dashboard/marketplace/installs",
      tone: "success",
      icon: "check",
    };
  } else if (authed) {
    button = {
      type: "install",
      label: installing
        ? isMonthly
          ? "Subscribing…"
          : "Installing…"
        : isMonthly
          ? `Subscribe · ${monthlyPrice}/month`
          : "Install Agent",
      disabled: installing || install === null,
    };
  } else {
    button = {
      type: "link",
      label: "Sign in to install",
      href: `/login?next=/marketplace/${listing.slug}`,
      tone: "primary",
      icon: "play",
    };
  }

  const footnote = holdsUse
    ? "You already use this agent on its page. Stop using it before you install a copy."
    : authed
    ? installed
      ? "Installed as a private copy in your workspace."
      : isMonthly
        ? `Charges ${monthlyPrice} from your credits now and every 30 days. Cancel anytime from Installed.`
        : listing.pricingModel === "tokenized" && tokenSymbol
          ? `Requires at least 1 ${tokenSymbol} in a wallet linked to your organization.`
          : "Installs a private copy of this agent into your workspace."
    : "Sign in to install this agent to your account.";

  return {
    sellsUse: false,
    price: copyPriceText(listing),
    priceIsFree: listing.pricingModel === "free",
    priceNote:
      listing.pricingModel === "free"
        ? null
        : listing.pricingModel === "per_request"
          ? "Pay only for what you use"
          : listing.pricingModel === "tokenized"
            ? "Free until this agent's token launches, then for token holders"
            : "Billed monthly",
    status: holdsUse ? "You use this agent." : null,
    button,
    secondary: null,
    footnote,
  };
}

/** The price card of a listing page: its price, its lines and its button. */
export function listingCta(input: ListingCtaInput): ListingCta {
  return input.listing.sells === "use" ? ctaForUse(input) : copiesCta(input);
}

type ListingCounts = Pick<MarketplaceListing, "sells" | "totalInstalls" | "activeInstalls">;

/**
 * The short count beside a listing's rating, on its page and on its card:
 * "1,204 installs" for copies, "37 using it" for use (the people who use it
 * now, not everyone who ever started). Numbers follow the reader's locale
 * unless one is given.
 */
export function listingCountText(listing: ListingCounts, locale?: string): string {
  return listing.sells === "use"
    ? `${listing.activeInstalls.toLocaleString(locale)} using it`
    : `${listing.totalInstalls.toLocaleString(locale)} installs`;
}

export interface ListingStat {
  key: "installs" | "active" | "using";
  label: string;
  value: string;
}

/** The install rows of the Statistics card. A use listing has one: the people using it now. */
export function listingInstallStats(listing: ListingCounts, locale?: string): ListingStat[] {
  if (listing.sells === "use") {
    return [{ key: "using", label: LISTING_USE_WORDS.people, value: listing.activeInstalls.toLocaleString(locale) }];
  }
  return [
    { key: "installs", label: "Total Installs", value: listing.totalInstalls.toLocaleString(locale) },
    { key: "active", label: "Active Users", value: listing.activeInstalls.toLocaleString(locale) },
  ];
}
