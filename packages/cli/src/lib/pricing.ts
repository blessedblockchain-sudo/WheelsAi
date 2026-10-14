import { CliError } from "../errors.js";

/** Marketplace categories the API accepts (CreateListing `category`). */
export const LISTING_CATEGORIES = [
  "customer-support",
  "coding",
  "research",
  "automation",
  "creative",
  "other",
] as const;
export type ListingCategory = (typeof LISTING_CATEGORIES)[number];

export interface PricingFlags {
  pricePerRequest?: string;
  monthly?: string;
  free?: boolean;
  tokenized?: boolean;
  /** The listing sells copies of the agent. Without it a listing sells use of the agent. */
  copies?: boolean;
}

export type Pricing =
  | { pricingModel: "free" }
  | { pricingModel: "tokenized" }
  | { pricingModel: "per_request"; pricePerRequestCents: number }
  | { pricingModel: "monthly"; monthlyPriceCents: number };

/**
 * The API's bounds (its createListing schema), checked here so a bad price fails before anything is deployed.
 * A listing that sells use charges at least 5 cents a use; one that sells copies at least 1 cent a request.
 */
export const MIN_USE_PRICE_CENTS = 5;
const PRICE_PER_REQUEST_CENTS = { min: 1, max: 100_000 };
const USE_PRICE_PER_REQUEST_CENTS = { min: MIN_USE_PRICE_CENTS, max: 100_000 };
const MONTHLY_PRICE_CENTS = { min: 100, max: 10_000_000 };

function parseCents(flag: string, value: string, bounds: { min: number; max: number }, hint?: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new CliError(`${flag} must be a whole number of cents, got "${value}".`);
  }
  const cents = Number.parseInt(value, 10);
  if (cents < bounds.min || cents > bounds.max) {
    throw new CliError(`${flag} must be between ${bounds.min} and ${bounds.max} cents, got ${cents}.`, hint ? { hint } : {});
  }
  return cents;
}

/**
 * Read the pricing flags. Returns null when none was given, so the caller
 * can decide on a default. Giving more than one is an error.
 *
 * A listing sells use of the agent unless `copies` is set. A use listing charges at least 5 cents
 * per use, and cannot be token-gated: `--tokenized` needs `--copies`.
 */
export function parsePricing(flags: PricingFlags): Pricing | null {
  const chosen = [
    flags.pricePerRequest !== undefined ? "--price-per-request" : null,
    flags.monthly !== undefined ? "--monthly" : null,
    flags.free ? "--free" : null,
    flags.tokenized ? "--tokenized" : null,
  ].filter((name): name is string => name !== null);

  if (chosen.length > 1) {
    throw new CliError(`Choose one pricing option, not ${chosen.join(" and ")}.`);
  }
  if (flags.tokenized && !flags.copies) {
    throw new CliError("--tokenized needs --copies: a token-gated listing sells copies of the agent, not use of it.", {
      hint: "Add --copies. Buyers then get their own copy, including its instructions.",
    });
  }
  if (flags.pricePerRequest !== undefined) {
    return {
      pricingModel: "per_request",
      pricePerRequestCents: flags.copies
        ? parseCents("--price-per-request", flags.pricePerRequest, PRICE_PER_REQUEST_CENTS)
        : parseCents(
            "--price-per-request",
            flags.pricePerRequest,
            USE_PRICE_PER_REQUEST_CENTS,
            `A listing that sells use charges at least ${MIN_USE_PRICE_CENTS} cents per use. A listing that sells copies (--copies) can charge less.`,
          ),
    };
  }
  if (flags.monthly !== undefined) {
    return { pricingModel: "monthly", monthlyPriceCents: parseCents("--monthly", flags.monthly, MONTHLY_PRICE_CENTS) };
  }
  if (flags.free) return { pricingModel: "free" };
  if (flags.tokenized) return { pricingModel: "tokenized" };
  return null;
}

export function describePricing(pricing: Pricing | { pricingModel: string; pricePerRequestCents?: number | null; monthlyPriceCents?: number | null }): string {
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  switch (pricing.pricingModel) {
    case "free":
      return "free";
    case "tokenized":
      return "token-gated";
    case "per_request":
      return pricing.pricePerRequestCents ? `${dollars(pricing.pricePerRequestCents)} per request` : "per request";
    case "monthly":
      return pricing.monthlyPriceCents ? `${dollars(pricing.monthlyPriceCents)} per month` : "monthly";
    default:
      return pricing.pricingModel;
  }
}

/** A plan of a listing as the API sends it: on your own listings, and on a listing read by its slug. */
export interface ListingPlan {
  name: string;
  /** What 30 days cost, in cents. */
  priceCents: number;
  includedUses: number;
  /** What each use past the included ones costs, in cents. null: the plan stops until it renews. */
  extraUsePriceCents: number | null;
  /** On your own listings: "active" while the plan is on offer. */
  status?: string;
}

const isCents = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * One plan in the words buyers read on the agent's page: "$9.00 for 30 days", "500 uses", then either
 * "then $0.04 a use" or "then it stops until it renews".
 */
export function describePlan(plan: ListingPlan): string {
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const uses = `${plan.includedUses} ${plan.includedUses === 1 ? "use" : "uses"}`;
  const after =
    plan.extraUsePriceCents === null ? "then it stops until it renews" : `then ${dollars(plan.extraUsePriceCents)} a use`;
  return `${plan.name.trim()}: ${dollars(plan.priceCents)} for 30 days, ${uses}, ${after}`;
}

/**
 * The plans a listing offers, one line each, in the order buyers see them. Empty when it offers none.
 *
 * Only a listing that sells use per request offers plans, so any other listing has no line whatever it
 * carries. A plan that is no longer on offer, or that has a term missing, is left out: a line is what a
 * buyer would agree to, so one is never written from half a plan.
 */
export function describePlans(listing: { sells?: string | null; pricingModel?: string | null; plans?: unknown }): string[] {
  if (listing.sells !== "use" || listing.pricingModel !== "per_request" || !Array.isArray(listing.plans)) return [];
  const lines: string[] = [];
  for (const item of listing.plans as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { name, priceCents, includedUses, extraUsePriceCents, status } = item as Partial<ListingPlan>;
    if (status !== undefined && status !== "active") continue;
    if (typeof name !== "string" || name.trim() === "" || !isCents(priceCents)) continue;
    if (typeof includedUses !== "number" || !Number.isInteger(includedUses) || includedUses < 1) continue;
    if (extraUsePriceCents !== null && !isCents(extraUsePriceCents)) continue;
    lines.push(describePlan({ name, priceCents, includedUses, extraUsePriceCents }));
  }
  return lines;
}

/**
 * How many days a listing's free trial lasts: the API's TRIAL_DAYS. A listing read by its slug says the
 * days itself (`freeTrial.days`). Your own listing carries the trial among its plans, without its days.
 */
export const FREE_TRIAL_DAYS = 7;

const isWholeCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;

/**
 * A listing's free trial in one line, in the words buyers read: "Free trial: 20 uses for 7 days". null
 * when the listing offers none. A trial has no price, so the line never names one.
 *
 * It is not "Try it", the free preview chat every published listing has (`trial` on a listing).
 *
 * Only a listing that sells use per request offers a free trial, so any other listing has no line
 * whatever it carries. The trial is read where the API says it: `freeTrial` on a listing read by its
 * slug, or the entry of kind "trial" among the plans of your own listing while it is on offer. A trial
 * with a term missing, or one that carries a price, is left out: a line is never written from half a trial.
 */
export function describeFreeTrial(listing: {
  sells?: string | null;
  pricingModel?: string | null;
  freeTrial?: unknown;
  plans?: unknown;
}): string | null {
  if (listing.sells !== "use" || listing.pricingModel !== "per_request") return null;
  const line = (uses: number, days: number) =>
    `Free trial: ${uses} ${uses === 1 ? "use" : "uses"} for ${days} ${days === 1 ? "day" : "days"}`;

  const offered = listing.freeTrial;
  if (typeof offered === "object" && offered !== null) {
    const { id, includedUses, days } = offered as { id?: unknown; includedUses?: unknown; days?: unknown };
    if (typeof id !== "string" || id === "" || !isWholeCount(includedUses) || !isWholeCount(days)) return null;
    return line(includedUses, days);
  }

  if (!Array.isArray(listing.plans)) return null;
  for (const item of listing.plans as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { id, kind, priceCents, includedUses, extraUsePriceCents, status } = item as Record<string, unknown>;
    if (kind !== "trial") continue;
    if (status !== undefined && status !== "active") continue;
    if (typeof id !== "string" || id === "" || priceCents !== 0 || extraUsePriceCents !== null) continue;
    if (!isWholeCount(includedUses)) continue;
    return line(includedUses, FREE_TRIAL_DAYS);
  }
  return null;
}

/**
 * What a listing offers on top of its price per use, one line each: its free trial first, when it offers
 * one, then its plans in the order buyers see them. Empty when it offers neither.
 */
export function describeOffers(listing: {
  sells?: string | null;
  pricingModel?: string | null;
  freeTrial?: unknown;
  plans?: unknown;
}): string[] {
  const trial = describeFreeTrial(listing);
  return [...(trial === null ? [] : [trial]), ...describePlans(listing)];
}

/**
 * What a listing sells, in words: "use, per message", "use, per month", "use" or "copies".
 * `unit` is what one payment buys; the API sends it null for a free listing and for copies.
 */
export function describeSells(listing: { sells?: string | null; unit?: string | null }): string {
  if (listing.sells === "copies") return "copies";
  if (listing.sells === "use") return listing.unit ? `use, per ${listing.unit}` : "use";
  return "unknown";
}

/**
 * What a pricing model does not do by itself, or null. A tokenized listing is only gated
 * once a token has been launched for it; the CLI launches none, so until then it installs free.
 */
export function pricingNote(pricingModel: string): string | null {
  return pricingModel === "tokenized"
    ? "Token gating starts when a token is launched for this listing (in the dashboard). Until then anyone can install it for free."
    : null;
}

export function parseCategory(value: string | undefined): ListingCategory | undefined {
  if (value === undefined) return undefined;
  const category = value.trim().toLowerCase();
  if (!(LISTING_CATEGORIES as readonly string[]).includes(category)) {
    throw new CliError(`Unknown category "${value}".`, {
      hint: `Valid categories: ${LISTING_CATEGORIES.join(", ")}.`,
    });
  }
  return category as ListingCategory;
}
