/**
 * The count of a plan.
 *
 * A buyer on a plan has a number of uses for each 30 days. The count is one
 * column, `agent_subscriptions.used_in_period`, and this is the only code
 * that moves it between renewals:
 *
 *   takeIncludedUse      one use, just before the model runs. A conditional
 *                        update that the database decides: of two requests
 *                        for the last use, one changes the row and the other
 *                        changes nothing.
 *   giveBackIncludedUse  the use back, when no answer was delivered. Only
 *                        into the period it was taken from: a renewal in
 *                        between has set the count to zero, and there is
 *                        nothing left to give back.
 *   warningLevel         whether a count has reached 85% or all of its uses.
 *
 * A use is tied to its period by `current_period_start`, which a renewal
 * moves in the same statement that sets the count back to zero. A pause
 * only makes the period longer and leaves its start alone, so a use taken
 * before a pause is still given back after it.
 *
 * Pure: it takes the transaction as an argument and imports nothing.
 */

/** The statuses of a subscription that the renewal worker, a stop or an acceptance has not closed. */
const OPEN_STATUSES = ["active", "past_due"];

/** The first warning: this share of the uses is gone. */
export const PLAN_WARNING_PERCENT = 85;

/** What the count needs of a transaction. Prisma's client satisfies it. */
export interface PlanUseTx {
  agentSubscription: {
    updateMany(args: {
      where: {
        id: string;
        currentPeriodStart: Date;
        status?: { in: string[] };
        includedUses?: number;
        carriedUses?: number;
        usedInPeriod: { lt: number } | { gt: number };
      };
      data: { usedInPeriod: { increment: number } | { decrement: number } };
    }): Promise<{ count: number }>;
  };
}

/** The plan row as it was read for this request (resolveUseBilling's `plan`). */
export interface PlanUseRead {
  subscriptionId: string;
  /** AgentSubscription.currentPeriodStart as read. */
  periodStart: Date;
  includedUses: number;
  carriedUses: number;
}

export type TakeIncludedUseResult =
  | {
      taken: true;
      /** The period the use was taken in. Hand it to giveBackIncludedUse. */
      periodStart: Date;
    }
  | { taken: false };

/**
 * Take one included use. It is taken only if, at the moment of the update,
 * the row is still open, still in the period that was read, still on the
 * terms that were read, and has a use left: used < included + carried.
 *
 * One statement, and the count of rows it changed is the answer. Nothing is
 * read first, so there is no moment between a check and the write in which
 * a second request could take the same use. The limit is worked out from
 * the terms that were read, and the statement requires the row to still hold
 * those terms: a row that changed in between (a renewal, a move to another
 * plan) takes nothing, and the caller decides again from a fresh read.
 *
 * `taken: false` means only that no use was taken. It does not say why: the
 * plan may be used up, or the row may have changed since it was read (a
 * renewal that set the count back to zero, a move to another plan, a close).
 * So before the caller charges the extra price or says the plan is used up,
 * it reads the row again, and does either only if the row is still in the
 * same period, on the same terms, with used >= included + carried. Otherwise
 * it decides again from the fresh row, once, or refuses with nothing
 * charged. The extra price was agreed to for uses past the count only.
 */
export async function takeIncludedUse(tx: PlanUseTx, read: PlanUseRead): Promise<TakeIncludedUseResult> {
  const changed = await tx.agentSubscription.updateMany({
    where: {
      id: read.subscriptionId,
      currentPeriodStart: read.periodStart,
      status: { in: OPEN_STATUSES },
      includedUses: read.includedUses,
      carriedUses: read.carriedUses,
      usedInPeriod: { lt: read.includedUses + read.carriedUses },
    },
    data: { usedInPeriod: { increment: 1 } },
  });
  return changed.count === 1 ? { taken: true, periodStart: read.periodStart } : { taken: false };
}

/**
 * Give one use back: no answer was delivered for it. The count goes down by
 * one only while the row is still in the period the use was taken in, and
 * never below zero. After a renewal the count started again from zero
 * without that use, so nothing is given back.
 *
 * It lowers the count each time it changes a row, so it must be called once
 * for a use that was taken: the caller's "settle or refund, whichever comes
 * first" is what holds that.
 */
export async function giveBackIncludedUse(
  tx: PlanUseTx,
  taken: { subscriptionId: string; periodStart: Date },
): Promise<{ givenBack: boolean }> {
  const changed = await tx.agentSubscription.updateMany({
    where: {
      id: taken.subscriptionId,
      currentPeriodStart: taken.periodStart,
      usedInPeriod: { gt: 0 },
    },
    data: { usedInPeriod: { decrement: 1 } },
  });
  return { givenBack: changed.count === 1 };
}

/**
 * The warning a count is at: 100 when every use of the period is gone, 85
 * when 85% of them are, otherwise 0. Carried uses are part of the period's
 * uses. Whole numbers only, so 84.9% is not 85%.
 */
export function warningLevel(used: number, included: number, carried: number): 0 | 85 | 100 {
  const limit = included + carried;
  if (used >= limit) return 100;
  return used * 100 >= limit * PLAN_WARNING_PERCENT ? 85 : 0;
}
