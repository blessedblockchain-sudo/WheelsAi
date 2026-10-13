/**
 * What a buyer has used and spent on each listing they pay for.
 *
 * One read for the Usage page (GET /api/billing/marketplace-usage): the one
 * balance, then a row for each listing the organization has a licence for
 * use on. A row says the buyer's access, the plan they are on while it gives
 * uses, the extra uses of the plan's current period and what they cost, and
 * the uses paid per use in the current UTC month and what they cost.
 *
 * The plan is built by accessPlanOf (services/paidUse.ts), the function the
 * agent's page and the Installed page are answered with, so the three say
 * the same count. Its warning comes from the count, never from a stored
 * level.
 *
 * Counts and cents come from the buyer's own settled charges per use
 * (`marketplace_revenue`): a charge that is still held, or was given back,
 * is not money spent and is not counted. They are read in ONE query for all
 * the listings, as windows of time: a charge inside the current period of a
 * plan is an extra use of it (an included use has no charge), and a charge
 * of this month outside that period was paid per use.
 *
 * Never in the answer: tokens, the model, the creator's organization, or
 * anything of another buyer. Every read takes the organization, and a row
 * that is not this organization's is dropped here whatever a read returned.
 *
 * Pure: the reads and the clock are passed in
 * (services/buildBuyerUsageDeps.ts binds them).
 */

import { accessPlanOf, planWillRenew, type PaidSubscription, type UseAccessPlan } from "./paidUse.js";
import type { AcceptedPricing } from "./subscriptionAccess.js";
import { onPlan, useAccess, type UseAccess } from "./useAccess.js";

/** The most listings one answer carries, the newest licences first. */
export const BUYER_USAGE_MAX_LISTINGS = 200;

/** A licence for use, with the listing it is on and the buyer's subscription to it. */
export interface BuyerUsageLicence {
  /** AgentInstall.buyerId, as read. */
  buyerId: string;
  /** AgentInstall.status. */
  status: string;
  /** The pricing the buyer agreed to. */
  accepted: AcceptedPricing;
  listing: {
    id: string;
    title: string;
    slug: string;
    status: string;
    sells: string;
    pricingModel: string;
    pricePerRequestCents: bigint | null;
    /** The agent's address, /a/<handle>. null when the agent has no page. */
    handle: string | null;
  };
  /** AgentSubscription of this buyer on this listing, with `subscriberId` as read. */
  sub: (PaidSubscription & { subscriberId: string }) | null;
}

/** A stretch of time on one listing whose settled charges per use are summed. */
export interface PaidUseWindow {
  /** Names the window in the answer of the read. */
  key: string;
  listingId: string;
  /** From this moment on. */
  from: Date;
  /** Up to, and not including, this moment. null = no end. */
  until: Date | null;
}

export interface PaidUseSum {
  uses: number;
  cents: bigint;
}

export interface BuyerUsageDeps {
  /** credit_balances.balanceCents; 0 when the organization has no row. */
  readBalance(orgId: string): Promise<bigint>;
  /**
   * The organization's licences for use, newest first, at most `take`, each
   * with its listing and the organization's own subscription. ONE query.
   */
  loadLicences(args: { orgId: string; take: number }): Promise<BuyerUsageLicence[]>;
  /**
   * The buyer's settled charges per use inside each window, summed, by the
   * window's key. ONE query for all the windows. A window with no charge may
   * be left out.
   */
  sumPaidUses(args: { buyerId: string; windows: PaidUseWindow[] }): Promise<Map<string, PaidUseSum>>;
  now: () => Date;
}

/** Uses and what they cost, in cents. */
export interface UsesAndCents {
  uses: number;
  cents: number;
}

export interface BuyerUsageRow {
  listingId: string;
  title: string;
  slug: string;
  /** The agent's address, /a/<handle>. */
  handle: string | null;
  access: UseAccess;
  /** The plan the buyer is on, while it gives uses. null otherwise. */
  plan: UseAccessPlan | null;
  /** On a plan: the uses past its count in the current period, and what they cost. null with no plan. */
  extraThisPeriod: UsesAndCents | null;
  /** The uses paid per use in the current UTC month, and what they cost. */
  perUseThisMonth: UsesAndCents;
}

export interface BuyerUsageView {
  /** The organization's credits, in cents. One balance pays for every listing. */
  balanceCents: number;
  listings: BuyerUsageRow[];
}

/** The first moment of the UTC month a moment falls in. */
export function utcMonthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

const NOTHING: UsesAndCents = { uses: 0, cents: 0 };

function told(sums: Map<string, PaidUseSum>, key: string | null): UsesAndCents {
  const sum = key === null ? undefined : sums.get(key);
  if (!sum) return { ...NOTHING };
  // A sum that is not a count and an amount is told as nothing, not as a guess.
  const uses = Number.isSafeInteger(sum.uses) && sum.uses >= 0 ? sum.uses : 0;
  const cents = typeof sum.cents === "bigint" && sum.cents >= 0n ? Number(sum.cents) : 0;
  return { uses, cents };
}

/** GET /api/billing/marketplace-usage, for the caller's organization. */
export async function readBuyerUsage(deps: BuyerUsageDeps, orgId: string): Promise<BuyerUsageView> {
  const now = deps.now();
  const monthStart = utcMonthStart(now);

  const [balance, loaded] = await Promise.all([
    deps.readBalance(orgId),
    deps.loadLicences({ orgId, take: BUYER_USAGE_MAX_LISTINGS }),
  ]);
  // The read is asked for this organization's rows. One that is somebody
  // else's is never told, whatever came back.
  const licences = loaded.filter((licence) => licence.buyerId === orgId).slice(0, BUYER_USAGE_MAX_LISTINGS);

  const windows: PaidUseWindow[] = [];
  const drawn = licences.map((licence, index) => {
    const { listing } = licence;
    const sub = licence.sub && licence.sub.subscriberId === orgId ? licence.sub : null;
    const access = useAccess(
      { licence: { kind: "use", status: licence.status, accepted: licence.accepted }, listing, sub },
      now,
    );
    // On a plan, while it gives uses, as the agent's page reads it. One that
    // is over is told by `access`.
    const held = sub && onPlan(sub) && access === "subscribed" ? sub : null;
    const periodStart = held?.currentPeriodStart ?? null;

    // Inside the plan's period a charge per use is an extra use of the plan.
    // What this month holds outside it was paid per use.
    let extraKey: string | null = null;
    let perUseKey: string | null = null;
    if (held && periodStart) {
      extraKey = `extra:${index}`;
      windows.push({ key: extraKey, listingId: listing.id, from: periodStart, until: null });
      if (periodStart.getTime() > monthStart.getTime()) {
        perUseKey = `per_use:${index}`;
        windows.push({ key: perUseKey, listingId: listing.id, from: monthStart, until: periodStart });
      }
    } else {
      perUseKey = `per_use:${index}`;
      windows.push({ key: perUseKey, listingId: listing.id, from: monthStart, until: null });
    }
    return { listing, access, held, extraKey, perUseKey };
  });

  const sums =
    windows.length === 0 ? new Map<string, PaidUseSum>() : await deps.sumPaidUses({ buyerId: orgId, windows });

  return {
    balanceCents: Number(balance),
    listings: drawn.map(({ listing, access, held, extraKey, perUseKey }) => ({
      listingId: listing.id,
      title: listing.title,
      slug: listing.slug,
      handle: listing.handle,
      access,
      plan: held && accessPlanOf(held, planWillRenew(listing, held)),
      extraThisPeriod: held ? told(sums, extraKey) : null,
      perUseThisMonth: told(sums, perUseKey),
    })),
  };
}
