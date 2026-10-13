/**
 * The plans a listing offers a buyer.
 *
 * A listing that is published and sells use per request can offer up to
 * four paid plans (services/listingPlans.ts). This is what a buyer is shown
 * of each: its id, its name and its terms. The same five fields go to the
 * agent's public page, to the buyer's access, to a refusal that asks them to
 * choose, and to a start that found the terms changed, so a plan reads the
 * same wherever it is told and its terms can be sent back as they were
 * shown.
 *
 * Never told: a plan that was ended, how many people are on a plan, or
 * anything of the organization that sells it.
 *
 * Pure apart from the one read, which takes whatever client or transaction
 * the caller holds.
 */

/** A plan on offer, as the database holds it. Cents are bigint. */
export interface PlanOfferRow {
  id: string;
  name: string;
  /** What 30 days cost. */
  priceCents: bigint;
  includedUses: number;
  /** What each use past the included ones costs. Null = the plan stops until it renews. */
  extraUsePriceCents: bigint | null;
}

/** The same as a buyer is told it: cents as numbers, like every price beside it. */
export interface PlanOffer {
  id: string;
  name: string;
  priceCents: number;
  includedUses: number;
  extraUsePriceCents: number | null;
}

export const PLAN_OFFER_COLUMNS = {
  id: true,
  name: true,
  priceCents: true,
  includedUses: true,
  extraUsePriceCents: true,
} as const;

export interface PlanOfferDb {
  listingPlan: {
    findMany(args: {
      where: { listingId: string; status: "active"; kind: "paid" };
      orderBy: { position: "asc" };
      select: typeof PLAN_OFFER_COLUMNS;
    }): Promise<PlanOfferRow[]>;
  };
}

/** The same read for several listings at once: each row says whose it is. */
export interface PlanOffersDb {
  listingPlan: {
    findMany(args: {
      where: { listingId: { in: string[] }; status: "active"; kind: "paid" };
      orderBy: { position: "asc" };
      select: typeof PLAN_OFFER_COLUMNS & { listingId: true };
    }): Promise<Array<PlanOfferRow & { listingId: string }>>;
  };
}

/** Whether a listing offers its plans now: published, selling use, at a price per request. */
export function offersPlans(listing: { status: string; sells: string; pricingModel: string }): boolean {
  return listing.status === "published" && listing.sells === "use" && listing.pricingModel === "per_request";
}

/** The listing's paid plans on offer, in the order a buyer sees them. */
export function readPlanOffers(db: PlanOfferDb, listingId: string): Promise<PlanOfferRow[]> {
  return db.listingPlan.findMany({
    where: { listingId, status: "active", kind: "paid" },
    orderBy: { position: "asc" },
    select: PLAN_OFFER_COLUMNS,
  });
}

/**
 * The plans on offer of several listings, in ONE query: a page of search
 * results, or a buyer's installs. Answers a list for each listing that
 * offers plans now (offersPlans), empty when it has none, each in the order
 * a buyer sees them. A listing that offers none is not asked about and is
 * not in the answer. Nothing is read when no listing offers plans.
 */
export async function readPlanOffersOf(
  db: PlanOffersDb,
  listings: Array<{ id: string; status: string; sells: string; pricingModel: string }>,
): Promise<Map<string, PlanOfferRow[]>> {
  const byListing = new Map<string, PlanOfferRow[]>();
  for (const listing of listings) {
    if (offersPlans(listing)) byListing.set(listing.id, []);
  }
  if (byListing.size === 0) return byListing;
  const rows = await db.listingPlan.findMany({
    where: { listingId: { in: [...byListing.keys()] }, status: "active", kind: "paid" },
    orderBy: { position: "asc" },
    select: { ...PLAN_OFFER_COLUMNS, listingId: true },
  });
  for (const row of rows) byListing.get(row.listingId)?.push(row);
  return byListing;
}

/** The smallest price for 30 days among plans on offer, in cents; null when there are none. */
export function plansFromCentsOf(rows: PlanOfferRow[]): number | null {
  if (rows.length === 0) return null;
  return Number(rows.reduce((least, row) => (row.priceCents < least ? row.priceCents : least), rows[0]!.priceCents));
}

/** Field by field: whatever else a row carries stays where it was read. */
export function planOfferOf(row: PlanOfferRow): PlanOffer {
  return {
    id: row.id,
    name: row.name,
    priceCents: Number(row.priceCents),
    includedUses: row.includedUses,
    extraUsePriceCents: row.extraUsePriceCents === null ? null : Number(row.extraUsePriceCents),
  };
}
