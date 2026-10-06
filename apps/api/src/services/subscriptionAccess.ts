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
 *   pricing_changed      the buyer's subscription is over and the listing's
 *                        pricing is not what they subscribed to (it left
 *                        monthly pricing, or came back after being
 *                        archived); nothing runs or is charged until the
 *                        buyer accepts the listing's current pricing
 *   subscription_lapsed  a monthly subscription is not paid up
 *   unlisted             the listing is no longer sold; the copy keeps
 *                        running at no charge
 *   subscribed           inside a paid period, whatever the listing's
 *                        pricing is now
 *   listing_pricing      the listing's current pricing applies
 */
export type InstallAccess =
  | "uninstalled"
  | "pricing_changed"
  | "subscription_lapsed"
  | "unlisted"
  | "subscribed"
  | "listing_pricing";

export function installAccess(
  args: {
    installStatus: string;
    listingStatus: string;
    pricingModel: string;
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
  if (!offMonthly) return "subscription_lapsed";
  // A subscription that ran out but that the renewal worker has not closed
  // yet (it runs hourly, or not at all) still reads 'active' or 'past_due'
  // with no endReason. Decided here from the row, not from whether the
  // worker has got to it: otherwise the buyer is billed at the new
  // per-request price in the gap. A row the buyer's own uninstall or
  // acceptance closed is 'cancelled' and falls through.
  if (subscriptionIsOpen(args.sub)) return "pricing_changed";
  return "listing_pricing";
}

/** Not yet closed by the renewal worker, the buyer's uninstall or an acceptance. */
export function subscriptionIsOpen(sub: { status: string } | null | undefined): boolean {
  return sub?.status === "active" || sub?.status === "past_due";
}
