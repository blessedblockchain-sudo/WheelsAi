/**
 * When a monthly marketplace subscription grants access. Shared by the
 * subscription engine and install-billing resolution (kept separate to
 * avoid an import cycle between them).
 */
export const SUBSCRIPTION_PERIOD_DAYS = 30;
export const PAST_DUE_GRACE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Paid period, plus a grace window for a failed renewal. A subscription
 * set to cancel gets no grace: it ends when the paid period ends, even if
 * the renewal worker has not run yet.
 */
export function subscriptionGrantsAccess(
  sub: { status: string; currentPeriodEnd: Date; cancelAtPeriodEnd?: boolean } | null,
  now: Date = new Date(),
): boolean {
  if (!sub) return false;
  if (sub.status !== "active" && sub.status !== "past_due") return false;
  const graceMs = sub.cancelAtPeriodEnd ? 0 : PAST_DUE_GRACE_DAYS * DAY_MS;
  return sub.currentPeriodEnd.getTime() + graceMs > now.getTime();
}

/**
 * Where a buyer's install stands, from the rows alone. Install billing
 * (resolveInstallBilling) and the Installed Agents list both read this, so
 * the page never says "lapsed" about an agent that runs, or the reverse.
 *
 *   uninstalled          the buyer removed it
 *   pricing_changed      the listing's pricing is not what the buyer agreed
 *                        to: their subscription is over and the listing left
 *                        monthly pricing (or came back after being
 *                        archived), or the listing now charges per request
 *                        more than the install accepted, or under a pricing
 *                        model it did not accept. Nothing runs or is charged
 *                        until the buyer accepts the listing's current
 *                        pricing
 *   subscription_lapsed  a monthly subscription is not paid up
 *   unlisted             the listing is no longer sold; the copy keeps
 *                        running at no charge
 *   subscribed           inside a paid period, whatever the listing's
 *                        pricing is now
 *   listing_pricing      the listing's current pricing applies: it is
 *                        what the buyer accepted, or cheaper
 */
export type InstallAccess =
  | "uninstalled"
  | "pricing_changed"
  | "subscription_lapsed"
  | "unlisted"
  | "subscribed"
  | "listing_pricing";

/** The pricing recorded on an install when the buyer installed or last accepted a change. */
export interface AcceptedPricing {
  /** null on a row no acceptance was ever recorded for. */
  pricingModel: string | null | undefined;
  pricePerRequestCents: bigint | null | undefined;
}

/**
 * Whether the listing's pricing today is covered by what the buyer accepted.
 *
 * A publisher can change a listing at any time, and a free or per-request
 * install is charged at each request, so without this a publisher could
 * raise the price under an install that agreed to less. The rule:
 *
 *   - free (or a per-request price of zero) is always covered: paying less
 *     needs nobody's consent
 *   - per request is covered up to the per-request price the buyer accepted;
 *     a lower price applies at once, a higher one does not
 *   - any other pricing model is covered only if it is the model the buyer
 *     accepted
 *
 * An install with no recorded acceptance is covered for free pricing only.
 */
export function acceptedPricingCovers(
  listing: { pricingModel: string; pricePerRequestCents?: bigint | null },
  accepted: AcceptedPricing,
): boolean {
  if (listing.pricingModel === "free") return true;
  if (listing.pricingModel === "per_request") {
    const price = listing.pricePerRequestCents ?? 0n;
    if (price <= 0n) return true;
    return (
      accepted.pricingModel === "per_request" &&
      accepted.pricePerRequestCents !== null &&
      accepted.pricePerRequestCents !== undefined &&
      price <= accepted.pricePerRequestCents
    );
  }
  return accepted.pricingModel === listing.pricingModel;
}

export function installAccess(
  args: {
    installStatus: string;
    listingStatus: string;
    pricingModel: string;
    /** The listing's per-request price today. */
    pricePerRequestCents?: bigint | null;
    /** From the install row. Required: every caller must say what was agreed. */
    accepted: AcceptedPricing;
    sub: { status: string; currentPeriodEnd: Date; cancelAtPeriodEnd?: boolean; endReason?: string | null } | null;
  },
  now: Date = new Date(),
): InstallAccess {
  const offMonthly = args.pricingModel !== "monthly";
  if (args.installStatus === "suspended") {
    // Only a subscription suspends an install. If the listing has left
    // monthly pricing since, coming back means new terms however the
    // subscription ended (non-payment included), so it is never a plain
    // resubscribe.
    return args.sub?.endReason || offMonthly ? "pricing_changed" : "subscription_lapsed";
  }
  if (args.installStatus !== "active") return "uninstalled";
  if (args.listingStatus !== "published") return "unlisted";
  if (subscriptionGrantsAccess(args.sub, now)) return "subscribed";
  // An active install whose subscription the publisher's side ended (an
  // archived listing that is published again) is not moved onto pricing
  // the buyer never accepted.
  if (args.sub?.endReason) return "pricing_changed";
  // A monthly listing with no paid-up subscription. For an install that
  // agreed to something else (the listing was free or per-request when it
  // was installed) that is new pricing to accept, not a lapse to make good.
  if (!offMonthly) {
    const agreed = args.accepted.pricingModel;
    return agreed && agreed !== "monthly" ? "pricing_changed" : "subscription_lapsed";
  }
  // A subscription that ran out but that the renewal worker has not closed
  // yet (it runs hourly, or not at all) still reads 'active' or 'past_due'
  // with no endReason. Decided here from the row, not from whether the
  // worker has got to it: otherwise the buyer is billed at the new
  // per-request price in the gap. A row the buyer's own uninstall or
  // acceptance closed is 'cancelled' and falls through.
  if (subscriptionIsOpen(args.sub)) return "pricing_changed";
  // Decided from the rows at each request, not by a job that pauses installs
  // when a listing is edited: there is no window in which the new price is
  // charged before such a job has run.
  return acceptedPricingCovers(
    { pricingModel: args.pricingModel, pricePerRequestCents: args.pricePerRequestCents },
    args.accepted,
  )
    ? "listing_pricing"
    : "pricing_changed";
}

/** Not yet closed by the renewal worker, the buyer's uninstall or an acceptance. */
export function subscriptionIsOpen(sub: { status: string } | null | undefined): boolean {
  return sub?.status === "active" || sub?.status === "past_due";
}
