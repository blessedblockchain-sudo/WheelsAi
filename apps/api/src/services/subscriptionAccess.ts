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
