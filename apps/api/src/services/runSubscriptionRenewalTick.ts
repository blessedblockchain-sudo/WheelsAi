/**
 * Renewal tick for monthly marketplace subscriptions. For each due
 * subscription: renew (or close, if cancelled) inside one transaction;
 * when the buyer cannot pay, that transaction rolls back and a second one
 * marks the subscription past_due (or expired after the grace period).
 * Per-subscription isolation: one failure never stops the batch.
 *
 * A row that was tried and is still due (it errored, or the buyer cannot
 * pay yet) is stamped with the attempt time, outside the transaction that
 * rolled back, and loadDue returns least-recently-tried rows first. So
 * however many rows keep failing, they rotate behind every row that has
 * not had its turn instead of filling each tick's batches again.
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
  /**
   * Due subscriptions, never-tried and least-recently-tried first,
   * skipping ids already handled in this tick.
   */
  loadDue(args: {
    now: Date;
    limit: number;
    excludeIds: string[];
  }): Promise<Array<{ sub: SubscriptionRow; listing: ListingForBilling }>>;
  inTransaction<T>(fn: (tx: SubscriptionTx) => Promise<T>): Promise<T>;
  /** Stamp a row that was tried and is still due. Must not throw. */
  recordAttempt(subscriptionId: string, at: Date): Promise<void>;
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
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<RenewalTickResult> {
  const now = (deps.now ?? (() => new Date()))();
  const result: RenewalTickResult = { scanned: 0, renewed: 0, cancelled: 0, pastDue: 0, expired: 0, errors: 0 };
  // Work through the backlog in batches, never revisiting a row within a
  // tick. Across ticks, recordAttempt moves the rows that stayed due to
  // the back of the load order.
  const handled: string[] = [];
  for (let batch = 0; batch < (opts.maxBatches ?? 10); batch++) {
    const due = await deps.loadDue({ now, limit: opts.batchSize ?? 200, excludeIds: handled });
    if (due.length === 0) break;
    result.scanned += due.length;
    for (const { sub } of due) handled.push(sub.id);
    await renewBatch(deps, due, now, result);
  }
  return result;
}

async function renewBatch(
  deps: SubscriptionRenewalDeps,
  due: Array<{ sub: SubscriptionRow; listing: ListingForBilling }>,
  now: Date,
  result: RenewalTickResult,
): Promise<void> {
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
        // Still due while in grace: it is retried, but after the rows
        // that have not been tried.
        if (marked !== "expired") await deps.recordAttempt(sub.id, now).catch(() => {});
        continue;
      }
      if (outcome.kind === "renewed") result.renewed++;
      if (outcome.kind === "cancelled") result.cancelled++;
    } catch {
      result.errors++;
      await deps.recordAttempt(sub.id, now).catch(() => {});
    }
  }
}
