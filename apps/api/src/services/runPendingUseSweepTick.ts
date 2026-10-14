/**
 * The sweeper for charges per use that a crash left pending
 * (services/marketplaceMetering.ts).
 *
 * A charge for one use is taken before the agent runs, as a `pending`
 * revenue row: the buyer is debited and the creator is not yet credited.
 * It is settled when the answer was delivered and refunded in every other
 * ending. A process that dies in between, or a settle or refund that could
 * not commit, leaves the row pending for ever and the buyer out of pocket.
 * Each tick gives back the charges that have been pending for longer than
 * any use can last.
 *
 * When we cannot tell whether an answer arrived, the buyer gets the price
 * back and the creator is credited nothing: that is the side this rule
 * takes, on purpose.
 *
 * The refund is the one a failed use makes (refundMarketplaceRequest), a
 * compare-and-set from `pending`. A use that finishes while the sweeper
 * looks at its charge cannot be both settled and refunded: whichever write
 * lands first wins, and the other changes nothing.
 *
 * One charge failing to refund does not stop the others; it is counted and
 * tried again later.
 *
 * What it does not do, on purpose: a key's daily allowance is not given
 * back (as a refund does not give it back today), and an included use of a
 * plan that a crash left taken is not given back (there is no row to find
 * it by).
 */

/**
 * Far longer than a paid use may run: it ends at its own time limit of two
 * minutes (services/paidUse.ts). This holds for a use only. A request of a
 * buyer's own copy can run for longer, with no deadline of its own, as a
 * scheduled task (services/sharedAgentChat.ts, up to the task's timeout of
 * an hour) or as a hired job (services/buildJobRunnerDeps.ts, up to
 * JOB_MAX_RUN_MS): the binding keeps those back until PENDING_COPY_MAX_MS.
 * A paid run of a workflow on sale can last ten minutes, and its answer may
 * be delivered two minutes after that: the binding keeps its charge back
 * until PENDING_WORKFLOW_MAX_MS.
 */
export const PENDING_USE_MAX_MS = 15 * 60_000;
export const PENDING_USE_SWEEP_BATCH = 100;
/** Written in the buyer's ledger line of a refunded request on their own copy. */
export const PENDING_USE_SWEEP_REASON = "no answer was delivered";

/** One charge per use that is still pending, as the refund needs it. */
export interface StalePendingUse {
  revenueId: string;
  buyerId: string;
  /** Exactly what was held from the buyer. */
  grossCents: bigint;
  createdAt: Date;
}

/** C is what the reads hand to the refund: the charge, and whatever else the refund was read with. */
export interface PendingUseSweepTickDeps<C extends StalePendingUse = StalePendingUse> {
  /** Charges per use still `pending` and created before the cutoff, oldest first. No other type of row. */
  findStalePending(args: { createdBefore: Date; take: number }): Promise<C[]>;
  /** How many such charges there are. Asked only after a full batch. */
  countStalePending(args: { createdBefore: Date }): Promise<number>;
  /** True when this call refunded it; false when it was settled or refunded meanwhile. */
  refund(charge: C, reason: string): Promise<boolean>;
  now?: () => Date;
  pendingMaxMs?: number;
  batch?: number;
  logger?: { error(obj: unknown, msg: string): void };
}

export interface PendingUseSweepTickResult {
  scanned: number;
  refunded: number;
  failed: number;
  /**
   * Stale charges still pending after this tick: 0 when the batch was not
   * full, null when a full batch could not be counted.
   */
  left: number | null;
}

export async function runPendingUseSweepTick<C extends StalePendingUse>(
  deps: PendingUseSweepTickDeps<C>,
): Promise<PendingUseSweepTickResult> {
  const now = (deps.now ?? (() => new Date()))();
  const createdBefore = new Date(now.getTime() - (deps.pendingMaxMs ?? PENDING_USE_MAX_MS));
  const take = Math.max(1, Math.trunc(deps.batch ?? PENDING_USE_SWEEP_BATCH));
  const found = await deps.findStalePending({ createdBefore, take });
  // The query's own promise, held again here: a read that answers with a
  // fresh row, or with more than was asked for, must not move money.
  const charges = found.filter((charge) => charge.createdAt.getTime() < createdBefore.getTime()).slice(0, take);

  const result: PendingUseSweepTickResult = { scanned: charges.length, refunded: 0, failed: 0, left: 0 };
  for (const charge of charges) {
    try {
      if (await deps.refund(charge, PENDING_USE_SWEEP_REASON)) result.refunded += 1;
    } catch (err) {
      result.failed += 1;
      deps.logger?.error(
        { err, revenueId: charge.revenueId, buyerId: charge.buyerId },
        "failed to refund a charge for a use that was left pending",
      );
    }
  }

  // A batch that came back full may have left some behind. They wait for
  // the next tick; the count is only so the log says how many.
  if (found.length >= take) {
    try {
      result.left = await deps.countStalePending({ createdBefore });
    } catch (err) {
      result.left = null;
      deps.logger?.error({ err }, "could not count the charges for a use still left pending");
    }
  }
  return result;
}
