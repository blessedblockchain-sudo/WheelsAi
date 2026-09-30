/**
 * Renewal tick for monthly marketplace subscriptions. For each due
 * subscription: renew (or close, if cancelled) inside one transaction;
 * when the buyer cannot pay, that transaction rolls back and a second one
 * marks the subscription past_due (or expired after the grace period).
 * Per-subscription isolation: one failure never stops the batch.
 */
import {
  InsufficientCreditsError,
  markPastDueOrExpire,
  renewSubscription,
  type ListingForBilling,
  type RenewalOutcome,
  type SubscriptionRow,
  type SubscriptionTx,
} from "./marketplaceSubscriptions.js";

export interface SubscriptionRenewalDeps {
  loadDue(args: { now: Date; limit: number }): Promise<Array<{ sub: SubscriptionRow; listing: ListingForBilling }>>;
  inTransaction<T>(fn: (tx: SubscriptionTx) => Promise<T>): Promise<T>;
  now?: () => Date;
}

export interface RenewalTickResult {
  scanned: number;
  renewed: number;
  cancelled: number;
  pastDue: number;
  expired: number;
  errors: number;
}

export async function runSubscriptionRenewalTick(
  deps: SubscriptionRenewalDeps,
  opts: { batchSize?: number } = {},
): Promise<RenewalTickResult> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await deps.loadDue({ now, limit: opts.batchSize ?? 200 });
  const result: RenewalTickResult = { scanned: due.length, renewed: 0, cancelled: 0, pastDue: 0, expired: 0, errors: 0 };

  for (const { sub, listing } of due) {
    try {
      let outcome: RenewalOutcome;
      try {
        outcome = await deps.inTransaction((tx) => renewSubscription(tx, { sub, listing, now }));
      } catch (err) {
        if (!(err instanceof InsufficientCreditsError)) throw err;
        const marked = await deps.inTransaction((tx) => markPastDueOrExpire(tx, { sub, now }));
        if (marked === "past_due") result.pastDue++;
        if (marked === "expired") result.expired++;
        continue;
      }
      if (outcome.kind === "renewed") result.renewed++;
      if (outcome.kind === "cancelled") result.cancelled++;
    } catch {
      result.errors++;
    }
  }
  return result;
}
