/**
 * Money of a training job: reserve the maximum, charge the seconds run,
 * settle exactly once.
 *
 * A model deployment that runs out of credits can be stopped and loses
 * nothing, so it holds one hour and is charged tick by tick
 * (deploymentCreditGate.ts, gpuBilling.ts). A training run that is stopped
 * for lack of credits loses all its work, so a job holds its whole ceiling
 * when it is created and can never run out mid-run.
 *
 *   Hold    retail price per second x the run limit the user chose
 *           (maxRuntimeSeconds). Taken in the transaction that creates the
 *           job: a conditional decrement (balance >= hold) and one ledger row,
 *           type 'training_reservation', referenceId = the job id.
 *
 *   Charge  retail price per second x billable seconds, never more than the
 *           hold. Billable time starts when the Nosana job starts (fallback:
 *           the first event from the container) and ends when it ends - or,
 *           for a cancelled run, when the cancel was requested if that came
 *           first. Queue time is free. The Nosana timeout is the run limit
 *           plus a set-up allowance the platform carries: time past the run
 *           limit is cut off by the cap.
 *
 *   Settle  in the transaction of the terminal compare-and-set, exactly once:
 *           one row 'training_reservation_release' returning the WHOLE hold,
 *           and, when the charge is above zero, one row 'training_usage' for
 *           the charge. Each row carries the balance after it. The key is
 *           TrainingJob.settledAt: the compare-and-set requires it NULL and
 *           sets it, so a second writer changes nothing.
 *
 * Whether a run is charged at all is not decided here: the caller passes
 * what classifyTrainingOutcome said (services/trainingStateMachine.ts).
 *
 * All arithmetic is integer micro-dollars, as the GPU billing tick charges.
 * Pure but for the injected transaction.
 */

import { computeGpuCharge, MICRO_USD_PER_CENT, pricePerSecondMicroUsd } from "./gpuBilling.js";
import {
  canTransition,
  isTerminalTrainingState,
  type TerminalTrainingState,
  type TrainingState,
} from "./trainingStateMachine.js";

export const TRAINING_RESERVATION_LEDGER_TYPE = "training_reservation";
export const TRAINING_RELEASE_LEDGER_TYPE = "training_reservation_release";
export const TRAINING_USAGE_LEDGER_TYPE = "training_usage";

/**
 * The ledger types that are compute spend: per-second GPU time of a
 * deployment and of a training run. Anything that sums an organization's
 * GPU usage sums both.
 */
export const COMPUTE_USAGE_LEDGER_TYPES = ["gpu_usage", TRAINING_USAGE_LEDGER_TYPE] as const;

// ============================================
// Arithmetic
// ============================================

/** The retail rate as stored on the job: whole micro-dollars per second. */
export function trainingPriceMicroUsdPerSecond(pricePerSecondUsd: number): bigint {
  return pricePerSecondMicroUsd(pricePerSecondUsd);
}

/**
 * The hold for a run limit, in cents, rounded up. Integer micro-dollars: in
 * floating point 0.0001 x 3600 x 100 is 36.00000000000001, which would round
 * up to 37 cents.
 */
export function trainingHoldCents(
  priceMicroUsdPerSecond: bigint,
  maxRuntimeSeconds: number,
): bigint {
  if (!Number.isSafeInteger(maxRuntimeSeconds) || maxRuntimeSeconds < 0) {
    throw new RangeError(`maxRuntimeSeconds must be a whole number of seconds, got ${maxRuntimeSeconds}`);
  }
  if (priceMicroUsdPerSecond < 0n) {
    throw new RangeError("priceMicroUsdPerSecond cannot be negative");
  }
  const microUsd = priceMicroUsdPerSecond * BigInt(maxRuntimeSeconds);
  return (microUsd + MICRO_USD_PER_CENT - 1n) / MICRO_USD_PER_CENT;
}

export interface TrainingBillableWindow {
  /** When the Nosana job started (fallback: the first container event). Null = never ran. */
  startedAt: Date | null;
  /** When the Nosana job ended, or the reconcile's clock when that is not known. */
  endedAt: Date;
  /** When the user asked for the cancel. A cancelled run is never billed past it. */
  cancelRequestedAt?: Date | null;
}

/**
 * Billable milliseconds: start to min(end, cancel request). A run that never
 * started, or was cancelled before it did, is 0. The time we then took to
 * stop a cancelled run is ours.
 */
export function trainingBillableMs(window: TrainingBillableWindow): number {
  if (!window.startedAt) return 0;
  const start = window.startedAt.getTime();
  let end = window.endedAt.getTime();
  if (window.cancelRequestedAt) end = Math.min(end, window.cancelRequestedAt.getTime());
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor(end - start));
}

/**
 * The charge for the time run: price x time, rounded up to a cent, never more
 * than the hold. The cap is what keeps the set-up allowance (and any time a
 * node ran past the run limit) off the user's bill.
 */
export function trainingChargeCents(args: {
  priceMicroUsdPerSecond: bigint;
  billableMs: number;
  holdCents: bigint;
}): bigint {
  if (args.billableMs <= 0 || args.holdCents <= 0n) return 0n;
  const { cents } = computeGpuCharge({
    rateMicroUsdPerSecondPerReplica: args.priceMicroUsdPerSecond,
    replicas: 1,
    fromMs: 0,
    toMs: args.billableMs,
    rounding: "ceil",
  });
  return cents < args.holdCents ? cents : args.holdCents;
}

/** Cost so far of a job that is still running, for display. Capped by the hold. */
export function trainingCostSoFarCents(args: {
  priceMicroUsdPerSecond: bigint | null;
  holdCents: bigint | null;
  startedAt: Date | null;
  now: Date;
}): bigint {
  if (args.priceMicroUsdPerSecond === null || args.holdCents === null) return 0n;
  return trainingChargeCents({
    priceMicroUsdPerSecond: args.priceMicroUsdPerSecond,
    billableMs: trainingBillableMs({ startedAt: args.startedAt, endedAt: args.now }),
    holdCents: args.holdCents,
  });
}

// ============================================
// Reserve (inside the transaction that creates the job)
// ============================================

/** The same surface reserveDeploymentCredits needs. */
export interface TrainingReservePrisma {
  creditBalance: {
    updateMany(args: {
      where: { orgId: string; balanceCents: { gte: bigint } };
      data: { balanceCents: { decrement: bigint } };
    }): Promise<{ count: number }>;
    findUnique(args: { where: { orgId: string } }): Promise<{ balanceCents: bigint } | null>;
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
        /** The GPU-seconds the row charges for (training_usage rows). */
        gpuSeconds?: bigint;
      };
    }): Promise<unknown>;
  };
}

export interface ReserveTrainingCreditsArgs {
  tx: TrainingReservePrisma;
  orgId: string;
  /** The job id: the referenceId of every ledger row of this job. */
  jobId: string;
  /** trainingHoldCents(...), also written to TrainingJob.reservationCents by the caller. */
  holdCents: bigint;
  gpuTier: string;
  maxRuntimeSeconds: number;
}

export type ReserveTrainingCreditsResult =
  | { ok: true; reservedCents: bigint }
  | { ok: false; code: "insufficient_credits"; requiredCents: bigint; message: string };

/**
 * Takes the hold. Run INSIDE the prisma.$transaction that creates the job
 * row, so the row, the decrement and the ledger row commit together; on
 * `insufficient_credits` the caller rolls the transaction back and answers
 * 402. The decrement is conditional (`WHERE balance >= hold`), so two jobs
 * created against a balance that covers one cannot both pass.
 */
export async function reserveTrainingCredits(
  args: ReserveTrainingCreditsArgs,
): Promise<ReserveTrainingCreditsResult> {
  const holdCents = args.holdCents;
  if (holdCents <= 0n) {
    // A free tier: nothing to hold, and no ledger row for nothing.
    return { ok: true, reservedCents: 0n };
  }

  const claimed = await args.tx.creditBalance.updateMany({
    where: { orgId: args.orgId, balanceCents: { gte: holdCents } },
    data: { balanceCents: { decrement: holdCents } },
  });
  if (claimed.count === 0) {
    return {
      ok: false,
      code: "insufficient_credits",
      requiredCents: holdCents,
      message: "Not enough credits to hold the cost of the full run limit",
    };
  }

  const after = await args.tx.creditBalance.findUnique({ where: { orgId: args.orgId } });

  await args.tx.creditTransaction.create({
    data: {
      orgId: args.orgId,
      amountCents: -holdCents,
      type: TRAINING_RESERVATION_LEDGER_TYPE,
      description: `Fine-tuning hold (${args.gpuTier}, run limit ${args.maxRuntimeSeconds}s)`,
      referenceId: args.jobId,
      balanceAfter: after?.balanceCents ?? 0n,
    },
  });

  return { ok: true, reservedCents: holdCents };
}

// ============================================
// Settle (inside the transaction of the terminal compare-and-set)
// ============================================

/** Columns a terminal transition may set beside the ones the settlement owns. */
export interface TrainingTerminalFields {
  failureCode?: string | null;
  lastError?: string | null;
  gpuStoppedAt?: Date;
  outputModelId?: string;
  outputPath?: string;
  progress?: number;
}

export interface TrainingSettlePrisma {
  trainingJob: {
    updateMany(args: {
      where: { id: string; orgId: string; status: { in: string[] }; settledAt: null };
      data: TrainingTerminalFields & { status: string; settledAt: Date; completedAt: Date };
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { id: string };
      select: {
        reservationCents: true;
        priceMicroUsdPerSecond: true;
        maxRuntimeSeconds: true;
        gpuTier: true;
      };
    }): Promise<{
      reservationCents: bigint | null;
      priceMicroUsdPerSecond: bigint | null;
      maxRuntimeSeconds: number | null;
      gpuTier: string;
    } | null>;
    update(args: {
      where: { id: string };
      data: { billedSeconds: number; actualCostCents: bigint };
    }): Promise<unknown>;
  };
  creditBalance: {
    update(args: {
      where: { orgId: string };
      data: { balanceCents: { increment: bigint } };
    }): Promise<{ balanceCents: bigint }>;
    findUnique(args: { where: { orgId: string } }): Promise<{ balanceCents: bigint } | null>;
  };
  creditTransaction: TrainingReservePrisma["creditTransaction"];
}

export interface SettleTrainingJobArgs {
  tx: TrainingSettlePrisma;
  jobId: string;
  orgId: string;
  /** The states the caller read the job in. Each must lead to toStatus. */
  fromStatuses: TrainingState[];
  toStatus: TerminalTrainingState;
  /**
   * "none" returns the whole hold. "seconds_run" charges the billable time,
   * capped by the hold (classifyTrainingOutcome decides which).
   */
  charge: { kind: "none" } | { kind: "seconds_run"; billableMs: number };
  fields?: TrainingTerminalFields;
  now: Date;
}

export type SettleTrainingJobResult =
  | {
      settled: true;
      holdCents: bigint;
      chargeCents: bigint;
      /** hold - charge: what the organization got back net. */
      refundCents: bigint;
      billedSeconds: number;
    }
  | { settled: false; reason: "lost" | "invalid_transition" };

/**
 * Makes the terminal transition and settles the job's money, exactly once.
 *
 * Run INSIDE a prisma.$transaction. The compare-and-set is
 * `updateMany({ where: { id, status in fromStatuses, settledAt: null } })`:
 * whoever flips it wins, and only the winner moves money. A callback's
 * reconcile and the poller's can observe the same end at the same time; the
 * loser gets `{ settled: false, reason: "lost" }` and must change nothing
 * else (the same shape as releaseDeploymentReservation).
 *
 * The hold and the price are read AFTER winning: winning takes the row lock,
 * and both were written when the job was created, so they are final. The
 * charge is worked out from the price stored on the row, never from today's
 * price table.
 *
 * The balance moves once, by hold - charge (never negative, so there is no
 * debit that could fail), and the ledger states both halves: the release of
 * the whole hold, then the usage. Each row's balanceAfter is the balance
 * after that row.
 *
 * A row with no hold (one created before fine-tuning was billed) settles
 * with no money and no ledger rows.
 *
 * Anything thrown by the transaction client propagates and rolls the whole
 * terminal transition back: the job stays where it was and the next
 * reconcile tries again.
 */
export async function settleTrainingJob(
  args: SettleTrainingJobArgs,
): Promise<SettleTrainingJobResult> {
  if (
    !isTerminalTrainingState(args.toStatus) ||
    args.fromStatuses.length === 0 ||
    !args.fromStatuses.every((from) => canTransition(from, args.toStatus))
  ) {
    return { settled: false, reason: "invalid_transition" };
  }

  const claimed = await args.tx.trainingJob.updateMany({
    where: {
      id: args.jobId,
      orgId: args.orgId,
      status: { in: [...args.fromStatuses] },
      settledAt: null,
    },
    data: {
      ...args.fields,
      status: args.toStatus,
      settledAt: args.now,
      completedAt: args.now,
    },
  });
  if (claimed.count === 0) {
    return { settled: false, reason: "lost" };
  }

  const row = await args.tx.trainingJob.findUnique({
    where: { id: args.jobId },
    select: {
      reservationCents: true,
      priceMicroUsdPerSecond: true,
      maxRuntimeSeconds: true,
      gpuTier: true,
    },
  });
  const holdCents = row?.reservationCents ?? 0n;
  const price = row?.priceMicroUsdPerSecond ?? null;

  const billableMs = args.charge.kind === "seconds_run" ? Math.max(0, args.charge.billableMs) : 0;
  const chargeCents =
    price === null || holdCents <= 0n
      ? 0n
      : trainingChargeCents({ priceMicroUsdPerSecond: price, billableMs, holdCents });
  // Seconds the charge stands for: the time run, cut at the run limit as the
  // charge is cut at the hold. 0 when nothing is charged.
  const ranSeconds = Math.ceil(billableMs / 1000);
  const billedSeconds =
    chargeCents === 0n
      ? 0
      : row?.maxRuntimeSeconds != null
        ? Math.min(ranSeconds, row.maxRuntimeSeconds)
        : ranSeconds;

  await args.tx.trainingJob.update({
    where: { id: args.jobId },
    data: { billedSeconds, actualCostCents: chargeCents },
  });

  if (holdCents <= 0n) {
    return { settled: true, holdCents: 0n, chargeCents: 0n, refundCents: 0n, billedSeconds: 0 };
  }

  const refundCents = holdCents - chargeCents;
  let balanceCents: bigint;
  if (refundCents > 0n) {
    const after = await args.tx.creditBalance.update({
      where: { orgId: args.orgId },
      data: { balanceCents: { increment: refundCents } },
    });
    balanceCents = after.balanceCents;
  } else {
    // The run used the whole hold: the balance does not move.
    const current = await args.tx.creditBalance.findUnique({ where: { orgId: args.orgId } });
    if (!current) throw new Error(`settleTrainingJob: organization ${args.orgId} has no credit balance`);
    balanceCents = current.balanceCents;
  }

  const tier = row?.gpuTier ?? "gpu";
  await args.tx.creditTransaction.create({
    data: {
      orgId: args.orgId,
      amountCents: holdCents,
      type: TRAINING_RELEASE_LEDGER_TYPE,
      description: `Fine-tuning hold released (${args.toStatus})`,
      referenceId: args.jobId,
      // The balance once the hold is back and before the usage below.
      balanceAfter: balanceCents + chargeCents,
    },
  });
  if (chargeCents > 0n) {
    await args.tx.creditTransaction.create({
      data: {
        orgId: args.orgId,
        amountCents: -chargeCents,
        type: TRAINING_USAGE_LEDGER_TYPE,
        description: `Fine-tuning usage (${tier}, ${billedSeconds}s)`,
        referenceId: args.jobId,
        balanceAfter: balanceCents,
        // What the month's GPU hours are summed from.
        gpuSeconds: BigInt(billedSeconds),
      },
    });
  }

  return { settled: true, holdCents, chargeCents, refundCents, billedSeconds };
}
