/**
 * The reaper for publisher-funded Try it messages (services/trialFunding.ts).
 *
 * A charge is `held` from just before the model is called until the answer
 * was delivered (settled) or was not (refunded). A process that dies in
 * between leaves it held, and the publisher debited for a message nobody
 * got. Each tick refunds the charges that have been held for longer than any
 * chat can last.
 *
 * The refund is the same compare-and-set from `held` the chat itself uses,
 * so a chat that finishes while the reaper looks at its charge cannot be
 * both settled and refunded: whichever write lands first wins, and the
 * other changes nothing.
 *
 * One charge failing to refund does not stop the others; it is counted and
 * tried again next tick.
 */

/** Far longer than a chat may run (AGENT_CHAT_TIMEOUT_MS is at most 10 minutes). */
export const TRIAL_CHARGE_HELD_MAX_MS = 15 * 60_000;
export const TRIAL_CHARGE_REAP_BATCH = 100;
export const TRIAL_CHARGE_REAP_REASON = "the chat never finished (reaped)";

export interface TrialChargeReapTickDeps {
  /** Ids of charges still `held` and created before the cutoff, oldest first. */
  findStaleHeld(args: { createdBefore: Date; take: number }): Promise<string[]>;
  /** True when this call refunded it; false when it was already resolved. */
  refund(chargeId: string, reason: string): Promise<boolean>;
  now?: () => Date;
  heldMaxMs?: number;
  batch?: number;
  logger?: { error(obj: unknown, msg: string): void };
}

export interface TrialChargeReapTickResult {
  scanned: number;
  refunded: number;
  failed: number;
}

export async function runTrialChargeReapTick(deps: TrialChargeReapTickDeps): Promise<TrialChargeReapTickResult> {
  const now = (deps.now ?? (() => new Date()))();
  const createdBefore = new Date(now.getTime() - (deps.heldMaxMs ?? TRIAL_CHARGE_HELD_MAX_MS));
  const ids = await deps.findStaleHeld({ createdBefore, take: deps.batch ?? TRIAL_CHARGE_REAP_BATCH });

  const result: TrialChargeReapTickResult = { scanned: ids.length, refunded: 0, failed: 0 };
  for (const id of ids) {
    try {
      if (await deps.refund(id, TRIAL_CHARGE_REAP_REASON)) result.refunded += 1;
    } catch (err) {
      result.failed += 1;
      deps.logger?.error({ err, trialChargeId: id }, "failed to refund a stale trial charge");
    }
  }
  return result;
}
