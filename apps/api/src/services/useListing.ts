/**
 * The listing that sells USE of an agent, read the same way everywhere.
 *
 * An agent has at most one listing. Use of it is on sale while that listing
 * is published and sells use; it is PAID use while the pricing is a price
 * per use or a price per month. A free use listing is the agent's public
 * link plus a marketplace card: nobody pays and no licence is needed.
 *
 * Pure apart from the one read, which takes whatever client or transaction
 * the caller holds.
 */

export const USE_LISTING_COLUMNS = {
  id: true,
  slug: true,
  title: true,
  agentId: true,
  publisherId: true,
  status: true,
  sells: true,
  pricingModel: true,
  pricePerRequestCents: true,
  monthlyPriceCents: true,
  useAllowedTools: true,
  // The creator's switch for paying from a wallet: the x402 door judges a
  // listing by it (services/paidUseX402.ts). Never sent to anyone as it is.
  x402Enabled: true,
} as const;

export interface UseListingRow {
  id: string;
  slug: string;
  title: string;
  agentId: string;
  publisherId: string;
  status: string;
  sells: string;
  pricingModel: string;
  pricePerRequestCents: bigint | null;
  monthlyPriceCents: bigint | null;
  useAllowedTools: string[];
  /**
   * agent_listings.x402_enabled, the creator's switch for paying from a
   * wallet. Optional so a row read by hand without it reads as off.
   */
  x402Enabled?: boolean;
}

export interface UseListingDb {
  agentListing: {
    findFirst(args: {
      where: { agentId: string; status: "published"; sells: "use" };
      select: typeof USE_LISTING_COLUMNS;
    }): Promise<UseListingRow | null>;
  };
}

/** The published listing that sells use of this agent, or null. */
export function findUseListing(db: UseListingDb, agentId: string): Promise<UseListingRow | null> {
  return db.agentListing.findFirst({
    where: { agentId, status: "published", sells: "use" },
    select: USE_LISTING_COLUMNS,
  });
}

/**
 * What changing an agent is answered with (409 on_sale_for_use) while a
 * published listing sells use of it. Each says what to do first. The same
 * sentences whichever way the change arrives: an edit (PATCH
 * /api/agents/:id) or a rollback to an earlier version.
 */
export const ON_SALE_FOR_USE_MESSAGES = {
  page: "This agent is on sale, so its page stays on. Stop selling it first.",
  graph: "This agent is on sale, so it cannot be switched to answer through its graph. Stop selling it first.",
  scheduled:
    "This agent is sold per use, so it cannot be changed to run on its own. Sell it by the month or stop selling it first.",
} as const;

export type UseUnit = "message" | "run" | "month";

/** The smallest price for one use, so the platform's share never rounds to nothing. */
export const MIN_PRICE_PER_USE_CENTS = 5n;

/** True while a person has to pay to use the agent: a price per use, or a price per month. */
export function isPaidUse(listing: Pick<UseListingRow, "pricingModel" | "pricePerRequestCents" | "monthlyPriceCents">): boolean {
  if (listing.pricingModel === "per_request") return (listing.pricePerRequestCents ?? 0n) > 0n;
  if (listing.pricingModel === "monthly") return (listing.monthlyPriceCents ?? 0n) > 0n;
  return false;
}

/** What one payment buys: a message, a run, or a month. */
export function useUnitOf(agentKind: string | null | undefined, pricingModel: string): UseUnit {
  if (pricingModel === "monthly") return "month";
  return agentKind === "task" ? "run" : "message";
}

/** The price a page shows, in cents, for the listing's pricing model; null when use is free. */
export function usePriceCents(listing: Pick<UseListingRow, "pricingModel" | "pricePerRequestCents" | "monthlyPriceCents">): bigint | null {
  if (!isPaidUse(listing)) return null;
  return listing.pricingModel === "monthly" ? listing.monthlyPriceCents : listing.pricePerRequestCents;
}
