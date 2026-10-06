/**
 * Per-second GPU billing for model deployments.
 *
 * Nosana jobs are paid by the PLATFORM wallet for as long as they run, so the
 * org must be charged for GPU time while a deployment is live - not only for
 * the tokens it serves. The GPU billing worker charges
 *
 *     pricePerSecond(tier) x replicas x elapsed seconds
 *
 * from a per-deployment cursor (`Deployment.billedThroughAt`) using the house
 * money pattern (see deploymentCreditGate.ts / inferenceCreditHold.ts):
 *
 *   1. CAS the cursor:     UPDATE ... WHERE id AND status='running'
 *                                        AND replicas = <value read>
 *                                        AND billed_through_at = <value read>
 *      Whoever flips it wins; a concurrent tick updates 0 rows and bills
 *      nothing, so a window can never be billed twice.
 *   2. conditional decrement: UPDATE credit_balances SET balance = balance - X
 *                             WHERE org_id AND balance >= X
 *      The balance can never go negative. If it cannot pay, the whole
 *      transaction rolls back (including the cursor) and the caller stops the
 *      deployment.
 *   3. ledger row (type 'gpu_usage', referenceId = deployment id) whose
 *      balanceAfter is read inside the same transaction.
 *
 * What is billed
 * --------------
 * Only time a deployment is `running` (live endpoint). A `degraded` spell (no
 * live endpoint) is never billed, so the window is SETTLED at each edge of a
 * running spell instead of being left to the next tick:
 *   - running -> degraded / stopped / failed seen by the status worker: settled
 *     ("settle" mode) in the same transaction as the status change;
 *   - a user stop from `running`: final window ("final" mode, rounded up) - from
 *     `degraded` there is nothing to settle, the degrade edge already did;
 *   - a replica change: `replicas` only moves once Nosana has confirmed the new
 *     count, and the transaction that moves it charges everything up to that
 *     moment at the OLD count ("replica_change" mode, rounded up so no sub-cent
 *     remainder is left to be billed at the new count). The cursor CAS includes
 *     `replicas`, so a window is never billed at a replica count it did not run
 *     with.
 *
 * Every one of those edges CLAIMS FIRST and bills second: the status / replica
 * compare-and-set runs before chargeGpuWindow in the same transaction. The
 * claim takes the row lock, so the cursor read after it is current, and a claim
 * that loses bills nothing. A caller that gets `cursor_lost` after winning its
 * claim must roll back (throw) - it is never a success.
 *
 * Precision
 * ---------
 * The ledger is whole cents but GPU time is cheaper than that per second
 * (e.g. 4090: $0.00025/s = 1.5 cents/minute). Rounding every window would bias
 * the charge by up to a cent per tick, so the tick bills WHOLE cents only and
 * advances the cursor by exactly the time those cents pay for (millisecond
 * resolution, matching the TIMESTAMP(3) column); the sub-cent remainder simply
 * stays in the next window. The org is never charged for time the cursor did
 * not advance over. All arithmetic is integer (micro-dollars x ms), never
 * floats. `rounding: "ceil"` is used where a window must be closed completely:
 * the final window when a deployment stops, and the last window at the old
 * count when a replica change commits.
 */

export const MICRO_USD_PER_CENT = 10_000n;

/** Converts a USD/second price into integer micro-dollars per second. */
export function pricePerSecondMicroUsd(pricePerSecondUsd: number): bigint {
  const micro = Math.round(pricePerSecondUsd * 1_000_000);
  if (!Number.isFinite(micro) || micro < 0) {
    throw new RangeError(`invalid pricePerSecond ${pricePerSecondUsd}`);
  }
  return BigInt(micro);
}

export interface GpuChargeInput {
  rateMicroUsdPerSecondPerReplica: bigint;
  replicas: number;
  fromMs: number;
  toMs: number;
  /** "floor": whole cents only, cursor advances by the time they pay for. */
  rounding: "floor" | "ceil";
}

export interface GpuCharge {
  cents: bigint;
  /** Milliseconds the cursor advances by (<= elapsedMs). */
  coveredMs: number;
  elapsedMs: number;
  newCursorMs: number;
}

/** 1 cent = 10,000 uUSD; rate is uUSD per SECOND, time is in ms. */
const MICRO_USD_MS_PER_CENT = MICRO_USD_PER_CENT * 1000n;

/**
 * The cursor is a TIMESTAMP(3), so time is tracked in whole milliseconds: one
 * cent of a100 (800 uUSD/s) is exactly 12.5 s, which a whole-second cursor
 * could not express without drifting.
 */
export function computeGpuCharge(input: GpuChargeInput): GpuCharge {
  if (!Number.isInteger(input.replicas) || input.replicas < 1) {
    throw new RangeError(`replicas must be a positive integer, got ${input.replicas}`);
  }
  const elapsedMs = Math.max(0, Math.floor(input.toMs - input.fromMs));
  const rate = input.rateMicroUsdPerSecondPerReplica * BigInt(input.replicas);

  if (elapsedMs === 0) {
    return { cents: 0n, coveredMs: 0, elapsedMs, newCursorMs: input.fromMs };
  }
  if (rate === 0n) {
    // A free tier: nothing to charge, but the time has been "accounted for".
    return { cents: 0n, coveredMs: elapsedMs, elapsedMs, newCursorMs: input.fromMs + elapsedMs };
  }

  const costMicroMs = rate * BigInt(elapsedMs);

  if (input.rounding === "ceil") {
    const cents = (costMicroMs + MICRO_USD_MS_PER_CENT - 1n) / MICRO_USD_MS_PER_CENT;
    return { cents, coveredMs: elapsedMs, elapsedMs, newCursorMs: input.fromMs + elapsedMs };
  }

  const cents = costMicroMs / MICRO_USD_MS_PER_CENT;
  if (cents === 0n) {
    return { cents: 0n, coveredMs: 0, elapsedMs, newCursorMs: input.fromMs };
  }
  // The time `cents` pay for, rounded UP to a millisecond so the org is never
  // charged for time the cursor did not advance over (<= elapsedMs by
  // construction: cents x 1e7 <= rate x elapsedMs).
  const coveredMs = Number((cents * MICRO_USD_MS_PER_CENT + rate - 1n) / rate);
  return { cents, coveredMs, elapsedMs, newCursorMs: input.fromMs + coveredMs };
}

// ============================================
// Arrears (admission check for /v1)
// ============================================

/**
 * How many billing intervals ago a whole cent must already have been
 * collectable for a deployment to count as in arrears. One interval would trip
 * on a tick that is merely late; three means the worker has had repeated
 * chances to move the cursor and has not.
 */
export const GPU_BILLING_ARREARS_INTERVALS = 3;

/**
 * Whether a running deployment's GPU time is going uncollected, and how much is
 * owed. Requests to a dedicated deployment are "included in its GPU billing",
 * which is only true while that billing is actually being collected: the tick
 * rolls its window back when the org cannot pay, and if it then cannot stop the
 * deployment on Nosana either, the row stays `running` with a cursor that no
 * longer moves. That stuck cursor is what this detects - without consulting
 * the balance, so an org that is paid up is served whatever its balance is.
 *
 * Null when billing is current (or cannot be judged: no cursor yet).
 */
export function gpuBillingArrears(args: {
  gpuTier: string;
  replicas: number;
  billedThroughAt: Date | null | undefined;
  now: Date;
  billingIntervalMs: number;
  pricePerSecondUsd: (tier: string) => number;
}): { owedCents: bigint } | null {
  if (!args.billedThroughAt || args.billingIntervalMs <= 0) return null;
  const window = {
    rateMicroUsdPerSecondPerReplica: pricePerSecondMicroUsd(args.pricePerSecondUsd(args.gpuTier)),
    replicas: args.replicas,
    fromMs: args.billedThroughAt.getTime(),
    rounding: "floor" as const,
  };
  // Sub-cent time legitimately stays on the cursor, so "old cursor" alone is
  // not arrears: a cent must have been due for the whole grace period.
  const dueLongAgo = computeGpuCharge({
    ...window,
    toMs: args.now.getTime() - GPU_BILLING_ARREARS_INTERVALS * args.billingIntervalMs,
  });
  if (dueLongAgo.cents < 1n) return null;
  return { owedCents: computeGpuCharge({ ...window, toMs: args.now.getTime() }).cents };
}

// ============================================
// Transactional surface
// ============================================

export interface GpuBillingTx {
  deployment: {
    updateMany(args: {
      where: {
        id: string;
        status?: string;
        /** The replica count the row holds: a concurrent replica change loses the CAS. */
        replicas?: number;
        billedThroughAt: Date | null;
      };
      data: { billedThroughAt: Date };
    }): Promise<{ count: number }>;
  };
  creditBalance: {
    updateMany(args: {
      where: { orgId: string; balanceCents: { gte: bigint } };
      data: { balanceCents: { decrement: bigint } };
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { orgId: string };
    }): Promise<{ balanceCents: bigint } | null>;
  };
  creditTransaction: {
    create(args: {
      data: {
        orgId: string;
        amountCents: bigint;
        type: string;
        description: string;
        referenceId: string;
        balanceAfter: bigint;
      };
    }): Promise<unknown>;
  };
}

/**
 * Thrown from inside the billing transaction when the org cannot pay, so the
 * transaction (cursor advance included) rolls back. The worker catches it and
 * stops the deployment.
 */
export class InsufficientGpuCreditsError extends Error {
  constructor(
    readonly deploymentId: string,
    readonly requiredCents: bigint,
  ) {
    super(`insufficient credits for GPU usage of deployment ${deploymentId}`);
    this.name = "InsufficientGpuCreditsError";
  }
}

export interface ChargeGpuWindowArgs {
  deploymentId: string;
  orgId: string;
  gpuTier: string;
  /** The replica count the window RAN at (the rate it is billed at). */
  replicas: number;
  /**
   * The replica count the row holds now, when that is no longer `replicas`: a
   * replica change committing in this same transaction has already written the
   * new count (claim first, bill second) and is closing the window at the old
   * one. Defaults to `replicas`.
   */
  rowReplicas?: number;
  /** The cursor value the caller read; the CAS expects exactly this. */
  billedThroughAt: Date;
  now: Date;
  /**
   * - "tick":   floor (whole cents), the row must still be `running`, an
   *             unpayable window THROWS (the transaction rolls back).
   * - "settle": floor, no status requirement, takes what the org can pay and
   *             never throws. Used when the status worker moves a running
   *             deployment to degraded / stopped / failed.
   * - "final":  ceil (the last partial cent is rounded up), no status
   *             requirement, partial payment allowed. Stop-time settlement.
   * - "replica_change": ceil, no status requirement, partial payment allowed.
   *             Closes the window at the old count when a replica change
   *             commits, AFTER Nosana applied it - too late to refuse. (The
   *             claim that precedes the Nosana call settles in "tick" mode, so
   *             an org that cannot pay is refused there, not forgiven.)
   */
  mode: "tick" | "settle" | "final" | "replica_change";
  /**
   * USD/second per replica for a tier - callers pass computeMetering's
   * getPricePerSecond (kept out of this module so the billing math stays free
   * of the Nosana SDK and env validation).
   */
  pricePerSecondUsd: (tier: string) => number;
}

export type ChargeGpuWindowOutcome =
  | {
      kind: "charged";
      cents: bigint;
      coveredMs: number;
      coveredSeconds: number;
      balanceAfter: bigint;
      newCursor: Date;
      /** settle / final modes: part of the window the balance could not cover. */
      shortfallCents: bigint;
    }
  | { kind: "nothing_to_bill" }
  | { kind: "cursor_lost" };

/**
 * Bills one window. RUN INSIDE prisma.$transaction. See the file header for the
 * CAS -> conditional decrement -> ledger sequence.
 */
export async function chargeGpuWindow(
  tx: GpuBillingTx,
  args: ChargeGpuWindowArgs,
): Promise<ChargeGpuWindowOutcome> {
  const price = args.pricePerSecondUsd(args.gpuTier);
  const charge = computeGpuCharge({
    rateMicroUsdPerSecondPerReplica: pricePerSecondMicroUsd(price),
    replicas: args.replicas,
    fromMs: args.billedThroughAt.getTime(),
    toMs: args.now.getTime(),
    rounding: args.mode === "final" || args.mode === "replica_change" ? "ceil" : "floor",
  });
  const partialAllowed = args.mode !== "tick";

  if (charge.coveredMs === 0) return { kind: "nothing_to_bill" };
  const coveredSeconds = Math.round(charge.coveredMs / 1000);

  const newCursor = new Date(charge.newCursorMs);

  // 1. CAS the cursor. A concurrent ticker/stopper that already advanced it
  //    makes this update match 0 rows: we bill nothing.
  const cursor = await tx.deployment.updateMany({
    where: {
      id: args.deploymentId,
      ...(args.mode === "tick" ? { status: "running" } : {}),
      // A committed replica change changes the rate: a window billed at the
      // replica count read earlier must lose the CAS and be re-read.
      replicas: args.rowReplicas ?? args.replicas,
      billedThroughAt: args.billedThroughAt,
    },
    data: { billedThroughAt: newCursor },
  });
  if (cursor.count === 0) return { kind: "cursor_lost" };

  if (charge.cents === 0n) {
    // Free tier: the cursor moved, there is nothing to debit.
    return {
      kind: "charged",
      cents: 0n,
      coveredMs: charge.coveredMs,
      coveredSeconds,
      balanceAfter: (await tx.creditBalance.findUnique({ where: { orgId: args.orgId } }))
        ?.balanceCents ?? 0n,
      newCursor,
      shortfallCents: 0n,
    };
  }

  // 2. Conditional decrement.
  let debit = charge.cents;
  let shortfall = 0n;
  if (partialAllowed) {
    // The deployment is leaving service (or being degraded) anyway: take what
    // the org can pay (a partial charge beats none) and report the shortfall.
    const current =
      (await tx.creditBalance.findUnique({ where: { orgId: args.orgId } }))?.balanceCents ?? 0n;
    if (current < debit) {
      shortfall = debit - current;
      debit = current;
    }
  }

  let balanceAfter: bigint;
  if (debit > 0n) {
    const claimed = await tx.creditBalance.updateMany({
      where: { orgId: args.orgId, balanceCents: { gte: debit } },
      data: { balanceCents: { decrement: debit } },
    });
    if (claimed.count === 0) {
      if (!partialAllowed) {
        throw new InsufficientGpuCreditsError(args.deploymentId, charge.cents);
      }
      // settle / final: the balance moved under us; bill nothing more.
      return {
        kind: "charged",
        cents: 0n,
        coveredMs: charge.coveredMs,
        coveredSeconds,
        balanceAfter:
          (await tx.creditBalance.findUnique({ where: { orgId: args.orgId } }))?.balanceCents ?? 0n,
        newCursor,
        shortfallCents: charge.cents,
      };
    }
    balanceAfter =
      (await tx.creditBalance.findUnique({ where: { orgId: args.orgId } }))?.balanceCents ?? 0n;

    // 3. Ledger row, balanceAfter read inside the same transaction.
    await tx.creditTransaction.create({
      data: {
        orgId: args.orgId,
        amountCents: -debit,
        type: "gpu_usage",
        description: `GPU usage (${args.gpuTier} x${args.replicas}, ${coveredSeconds}s${
          args.mode === "final"
            ? ", final"
            : args.mode === "settle"
              ? ", settled"
              : args.mode === "replica_change"
                ? ", before replica change"
                : ""
        })`,
        referenceId: args.deploymentId,
        balanceAfter,
      },
    });
  } else {
    balanceAfter = 0n;
  }

  return {
    kind: "charged",
    cents: debit,
    coveredMs: charge.coveredMs,
    coveredSeconds,
    balanceAfter,
    newCursor,
    shortfallCents: shortfall,
  };
}
