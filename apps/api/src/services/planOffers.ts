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
 * Such a listing can also offer one free trial. It is not one of the plans
 * and is never in their list: it is told beside them, by itself, as its id,
 * its uses and its days, wherever the plans are told one listing at a time.
 *
 * Never told: a plan that was ended, how many people are on a plan, or
 * anything of the organization that sells it.
 *
 * Pure apart from the one read, which takes whatever client or transaction
 * the caller holds.
 */
import { TRIAL_DAYS } from "./listingPlans.js";

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

/** A free trial on offer, as the database holds it. */
export interface TrialOfferRow {
  id: string;
  includedUses: number;
}

/** The same as a buyer is told it. A trial costs nothing, so no price is among its fields. */
export interface TrialOffer {
  id: string;
  includedUses: number;
  /** How many days it lasts from its start. */
  days: number;
}

export const TRIAL_OFFER_COLUMNS = { id: true, includedUses: true } as const;

export interface TrialOfferDb {
  listingPlan: {
    findFirst(args: {
      where: { listingId: string; status: "active"; kind: "trial" };
      select: typeof TRIAL_OFFER_COLUMNS;
    }): Promise<TrialOfferRow | null>;
  };
}

/** The read of a listing's paid plans and its free trial together: each row says which it is. */
export interface OffersDb {
  listingPlan: {
    findMany(args: {
      where: { listingId: string; status: "active"; kind: { in: ["paid", "trial"] } };
      orderBy: { position: "asc" };
      select: typeof PLAN_OFFER_COLUMNS & { kind: true };
    }): Promise<Array<PlanOfferRow & { kind: string }>>;
  };
}

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

/** The listing's free trial on offer, or null when it offers none. Asked only of a listing that offers plans. */
export function readTrialOffer(db: TrialOfferDb, listingId: string): Promise<TrialOfferRow | null> {
  return db.listingPlan.findFirst({
    where: { listingId, status: "active", kind: "trial" },
    select: TRIAL_OFFER_COLUMNS,
  });
}

/**
 * The listing's paid plans on offer, in the order a buyer sees them, and its
 * free trial, in ONE query. The paid plans are exactly what readPlanOffers
 * answers; the trial is never among them.
 */
export async function readOffers(
  db: OffersDb,
  listingId: string,
): Promise<{ plans: PlanOfferRow[]; trial: TrialOfferRow | null }> {
  const rows = await db.listingPlan.findMany({
    where: { listingId, status: "active", kind: { in: ["paid", "trial"] } },
    orderBy: { position: "asc" },
    select: { ...PLAN_OFFER_COLUMNS, kind: true },
  });
  const trial = rows.find((row) => row.kind === "trial") ?? null;
  return {
    // Field by field: the kind that told them apart stays here.
    plans: rows
      .filter((row) => row.kind === "paid")
      .map((row) => ({
        id: row.id,
        name: row.name,
        priceCents: row.priceCents,
        includedUses: row.includedUses,
        extraUsePriceCents: row.extraUsePriceCents,
      })),
    trial: trial && { id: trial.id, includedUses: trial.includedUses },
  };
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

/** A free trial as a buyer is told it: its id, its uses and its days. Null stays null. */
export function trialOfferOf(row: TrialOfferRow | null | undefined): TrialOffer | null {
  if (!row) return null;
  return { id: row.id, includedUses: row.includedUses, days: TRIAL_DAYS };
}
