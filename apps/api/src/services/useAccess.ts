/**
 * What a buyer may do with a creator's agent right now.
 *
 * A listing that sells use gives the buyer no copy: they use the creator's
 * own agent, per use or per month, and the licence row (AgentInstall, kind
 * "use") is all that says so. This answers, from the rows at each request,
 * whether a use runs. Nothing here is stored, so there is no window in
 * which a job that pauses licences has not run yet.
 *
 *   none                 no licence, an ended one, or a copy licence that
 *                        never accepted use
 *   subscribed           inside a paid month, whatever the listing says now
 *   listing_pricing      the listing sells use at or below the price the
 *                        buyer accepted; charged if it is per use
 *   pricing_changed      a higher per-use price, or another pricing model.
 *                        Nothing runs or is charged until the buyer accepts
 *   subscription_lapsed  monthly and not paid up
 *   not_offered          not published, or no longer sells use, and no paid
 *                        month left
 *
 * Built over installAccess (services/subscriptionAccess.ts), which decides
 * the same things for a copy, with one deliberate difference: a paid month
 * is checked BEFORE the listing's status. installAccess answers "unlisted"
 * for a listing that is no longer sold, which for a copy means it keeps
 * running at no charge. For use that would be free use for ever, so here a
 * subscriber keeps access to the end of the month they paid for and
 * everybody else is not_offered.
 *
 * Pure: no IO.
 */
import { installAccess, subscriptionGrantsAccess, type AcceptedPricing } from "./subscriptionAccess.js";

export type UseAccess =
  | "none"
  | "subscribed"
  | "listing_pricing"
  | "pricing_changed"
  | "subscription_lapsed"
  | "not_offered";

/** The buyer's licence row for this listing. */
export interface UseLicence {
  /** AgentInstall.kind: "use", or "copy" for a licence that never accepted use. */
  kind: string;
  /** AgentInstall.status. */
  status: string;
  /** The pricing the buyer agreed to when they started, or last accepted a change. */
  accepted: AcceptedPricing;
}

/** The listing as it is now. */
export interface UseListing {
  /** AgentListing.status. */
  status: string;
  /** AgentListing.sells: "use" or "copies". */
  sells: string;
  pricingModel: string;
  /** The listing's per-use price today. */
  pricePerRequestCents?: bigint | null;
}

export interface UseSubscription {
  status: string;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd?: boolean;
  endReason?: string | null;
}

export interface UseAccessInput {
  /** null = the buyer has no licence row for this listing. */
  licence: UseLicence | null;
  listing: UseListing;
  /** The buyer's subscription to this listing, if there is a row. */
  sub: UseSubscription | null;
}

/** The ways use is sold. Token-gated use is not sold in this pass. */
const USE_PRICING_MODELS = ["free", "per_request", "monthly"];

export function useAccess(input: UseAccessInput, now: Date = new Date()): UseAccess {
  const { licence, listing, sub } = input;
  // A copy licence is for the copy. Holding one is not an agreement to pay
  // for use, so it grants none until the buyer starts using.
  if (!licence || licence.kind !== "use") return "none";
  // Stopped by the buyer. That ends a subscription too, with nothing left
  // of the month.
  if (licence.status !== "active" && licence.status !== "suspended") return "none";
  // Before the listing's status, on purpose: the month was paid for.
  if (subscriptionGrantsAccess(sub, now)) return "subscribed";
  if (listing.status !== "published" || listing.sells !== "use") return "not_offered";
  if (!USE_PRICING_MODELS.includes(listing.pricingModel)) return "not_offered";

  const access = installAccess(
    {
      installStatus: licence.status,
      listingStatus: listing.status,
      pricingModel: listing.pricingModel,
      pricePerRequestCents: listing.pricePerRequestCents,
      accepted: licence.accepted,
      sub,
    },
    now,
  );
  switch (access) {
    case "subscribed":
    case "listing_pricing":
    case "pricing_changed":
    case "subscription_lapsed":
      return access;
    case "unlisted":
      return "not_offered";
    case "uninstalled":
      return "none";
  }
}

/** The error code of a start refused because the buyer's copy has a month paid for. */
export const COPY_MONTH_BLOCKS_USE = "copy_subscription_active";

/**
 * A copy licence whose month is paid for stops its holder from starting to
 * use the agent on its page. There is one licence row per listing and buyer:
 * turning it into a use licence would cancel the month paid for the copy, or
 * on a monthly listing could never succeed, because the copy's subscription
 * is already paid up. So the start is refused, and nothing is written,
 * cancelled or charged.
 *
 * Returns the day the copy's paid month ends, or null when nothing stands in
 * the way: no licence, a use licence, a stopped copy, or a copy with no
 * month running.
 */
export function copyMonthBlockingUse(
  licence: Pick<UseLicence, "kind" | "status"> | null,
  sub: UseSubscription | null,
  now: Date = new Date(),
): Date | null {
  if (!licence || licence.kind === "use") return null;
  if (licence.status !== "active" && licence.status !== "suspended") return null;
  return sub && subscriptionGrantsAccess(sub, now) ? sub.currentPeriodEnd : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** What the holder of such a copy is told, in place of a start. */
export function copyMonthBlockingUseMessage(until: Date, now: Date = new Date()): string {
  const wayOut =
    "To use the agent on its page instead, remove your copy (the month you paid for is not refunded), or cancel its renewal and start after that date.";
  // Past the date and still open: the renewal is being retried.
  if (until.getTime() <= now.getTime()) {
    return "You hold a copy of this agent whose subscription is still open. To use the agent on its page instead, remove your copy first.";
  }
  return `You hold a copy of this agent that is paid for until ${until.getUTCDate()} ${MONTHS[until.getUTCMonth()]}. ${wayOut}`;
}

/** Whether a use runs for an access, and if it does not, what the caller is told. */
export type UseDecision =
  | {
      runs: true;
      /** True only for a per-use price above zero: this use is charged before it runs. */
      charged: boolean;
    }
  | {
      runs: false;
      charged: false;
      status: 402 | 403 | 409;
      code: "use_not_started" | "pricing_changed" | "subscription_lapsed" | "not_offered";
    };

/**
 * What an access means for one use. A subscriber is never charged per use,
 * and a refusal never charges.
 */
export function useDecision(
  access: UseAccess,
  listing: Pick<UseListing, "pricingModel" | "pricePerRequestCents">,
): UseDecision {
  switch (access) {
    case "subscribed":
      return { runs: true, charged: false };
    case "listing_pricing":
      return {
        runs: true,
        charged: listing.pricingModel === "per_request" && (listing.pricePerRequestCents ?? 0n) > 0n,
      };
    case "none":
      return { runs: false, charged: false, status: 403, code: "use_not_started" };
    case "pricing_changed":
      return { runs: false, charged: false, status: 409, code: "pricing_changed" };
    case "subscription_lapsed":
      return { runs: false, charged: false, status: 402, code: "subscription_lapsed" };
    case "not_offered":
      return { runs: false, charged: false, status: 409, code: "not_offered" };
  }
}
