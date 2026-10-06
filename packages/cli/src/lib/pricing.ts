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
}

export type Pricing =
  | { pricingModel: "free" }
  | { pricingModel: "tokenized" }
  | { pricingModel: "per_request"; pricePerRequestCents: number }
  | { pricingModel: "monthly"; monthlyPriceCents: number };

/** The API's bounds (its createListing schema), checked here so a bad price fails before anything is deployed. */
const PRICE_PER_REQUEST_CENTS = { min: 1, max: 100_000 };
const MONTHLY_PRICE_CENTS = { min: 100, max: 10_000_000 };

function parseCents(flag: string, value: string, bounds: { min: number; max: number }): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new CliError(`${flag} must be a whole number of cents, got "${value}".`);
  }
  const cents = Number.parseInt(value, 10);
  if (cents < bounds.min || cents > bounds.max) {
    throw new CliError(`${flag} must be between ${bounds.min} and ${bounds.max} cents, got ${cents}.`);
  }
  return cents;
}

/**
 * Read the pricing flags. Returns null when none was given, so the caller
 * can decide on a default. Giving more than one is an error.
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
  if (flags.pricePerRequest !== undefined) {
    return {
      pricingModel: "per_request",
      pricePerRequestCents: parseCents("--price-per-request", flags.pricePerRequest, PRICE_PER_REQUEST_CENTS),
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
