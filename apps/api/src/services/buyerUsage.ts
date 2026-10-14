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
 * Two words about a free trial. `trialEnded` says that what ended was the
 * buyer's own free trial, by the expression the access read uses. On a
 * running trial `perUseAfterTrial` says what one use costs this buyer once
 * the free uses are gone, and only when the metering would charge it without
 * asking them again (trialBilling, services/useMetering.ts): it is decided
 * from the functions that rule rests on, and when they do not say "charged"
 * it is null. What it tells is the listing's own price, which is public.
 *
 * Counts and cents come from the buyer's own settled charges per use
 * (`marketplace_revenue`): a charge that is still held, or was given back,
 * is not money spent and is not counted. They are read in ONE query for all
 * the listings, as windows of time: a charge inside the current period of a
 * plan is an extra use of it (an included use has no charge), and a charge
 * of this month outside that period was paid per use.
 *
 * Never in the answer: tokens, the model, the creator's organization, the
 * price the buyer agreed to, or anything of another buyer. Every read takes
 * the organization, and a row that is not this organization's is dropped
 * here whatever a read returned.
 *
 * Pure: the reads and the clock are passed in
 * (services/buildBuyerUsageDeps.ts binds them).
 */

import { onTrialPlan } from "./listingPlans.js";
import { accessPlanOf, planWillRenew, type PaidSubscription, type UseAccessPlan } from "./paidUse.js";
import type { AcceptedPricing } from "./subscriptionAccess.js";
import { onPlan, useAccess, useDecision, type UseAccess } from "./useAccess.js";
import { useUnitOf } from "./useListing.js";

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
    /** AgentListing.publisherId, the creator's organization. Read to know the buyer's own listing; never in the answer. */
    publisherId: string;
    /** The agent's address, /a/<handle>. null when the agent has no page. */
    handle: string | null;
    /** Agent.agentKind: a task agent's use is a run, any other a message. null when it could not be read. */
    agentKind: string | null;
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

/** What one use costs a buyer once their free trial's uses are gone. */
export interface PerUseAfterTrial {
  /** The listing's price per use now, in cents. Never the price the buyer agreed to. */
  priceCents: number;
  unit: "message" | "run";
}

export interface BuyerUsageRow {
  listingId: string;
  title: string;
  slug: string;
  /** The agent's address, /a/<handle>. */
  handle: string | null;
  access: UseAccess;
  /** True only when `access` is plan_ended and what ended was this buyer's own free trial. */
  trialEnded: boolean;
  /** The plan the buyer is on, while it gives uses. null otherwise. */
  plan: UseAccessPlan | null;
  /**
   * On a running free trial: what each use costs once the free uses are
   * gone, charged without asking the buyer again. null when such a use would
   * not be charged (the buyer is then stopped or asked first), and on every
   * row that is not on a trial.
   */
  perUseAfterTrial: PerUseAfterTrial | null;
  /**
   * On a plan: the end of the 30 days paid for, an ISO time. A page says it
   * as the day the plan ends when the plan will not renew (its `plan` then
   * has no `resetsAt`). null with no plan.
   */
  periodEndsAt: string | null;
  /** On a plan: its renewal did not go through and is being retried, so the period's end is behind the buyer. */
  renewalPastDue: boolean;
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

/**
 * What a use past a free trial's uses costs this buyer, or null when it is
 * not charged.
 *
 * It must say what trialBilling (services/useMetering.ts) charges, so it is
 * decided the way that rule is: the listing is not the buyer's own (the
 * creator's organization never pays itself, resolveUseBilling's first
 * refusal), the licence is active, the buyer agreed to a
 * price per use themselves, and the same licence and listing with NO
 * subscription are charged per use. That last part is useAccess and
 * useDecision, the two functions resolveUseBilling stands on: they hold the
 * comparison of the listing's price with the agreed one, so it is not
 * written again here. Anything they do not answer "charged" for is null.
 */
function perUseAfterTrialOf(licence: BuyerUsageLicence, now: Date): PerUseAfterTrial | null {
  const { listing } = licence;
  if (listing.publisherId === licence.buyerId) return null;
  if (licence.status !== "active" || licence.accepted.pricingModel !== "per_request") return null;
  const access = useAccess(
    { licence: { kind: "use", status: licence.status, accepted: licence.accepted }, listing, sub: null },
    now,
  );
  if (access !== "listing_pricing") return null;
  const decision = useDecision(access, listing);
  if (!decision.runs || !decision.charged) return null;
  // A price per use is never said by the month.
  const unit = useUnitOf(listing.agentKind, listing.pricingModel);
  if (unit === "month") return null;
  const price = listing.pricePerRequestCents;
  if (typeof price !== "bigint" || price <= 0n) return null;
  const priceCents = Number(price);
  return Number.isSafeInteger(priceCents) ? { priceCents, unit } : null;
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
    // The same expression as the access read (services/paidUse.ts).
    const trialEnded = access === "plan_ended" && sub !== null && onTrialPlan(sub);
    const perUseAfterTrial = held && onTrialPlan(held) ? perUseAfterTrialOf(licence, now) : null;
    return { listing, access, trialEnded, held, perUseAfterTrial, extraKey, perUseKey };
  });

  const sums =
    windows.length === 0 ? new Map<string, PaidUseSum>() : await deps.sumPaidUses({ buyerId: orgId, windows });

  return {
    balanceCents: Number(balance),
    listings: drawn.map(({ listing, access, trialEnded, held, perUseAfterTrial, extraKey, perUseKey }) => ({
      listingId: listing.id,
      title: listing.title,
      slug: listing.slug,
      handle: listing.handle,
      access,
      trialEnded,
      plan: held && accessPlanOf(held, planWillRenew(listing, held)),
      perUseAfterTrial,
      periodEndsAt: held ? held.currentPeriodEnd.toISOString() : null,
      renewalPastDue: held ? held.status === "past_due" : false,
      extraThisPeriod: held ? told(sums, extraKey) : null,
      perUseThisMonth: told(sums, perUseKey),
    })),
  };
}
