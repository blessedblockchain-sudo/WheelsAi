/**
 * Credit gate for GPU deployment creation (REMEDIATION_PLAN A4).
 *
 * Nosana jobs are signed by the PLATFORM wallet, so an ungated deploy
 * endpoint lets any authenticated org spend platform funds. Before a job
 * is submitted we (1) enforce a per-org active-deployment quota and
 * (2) atomically reserve the estimated cost of one billing hour from the
 * org's credit balance. The reservation is a conditional decrement —
 * `WHERE balanceCents >= cost` — so concurrent deploys against a balance
 * that covers one of them cannot both pass (no read-check-write race).
 *
 * Later metered billing (inference route / treasury settlement) charges
 * actual usage; the reservation is the admission ticket, recorded in the
 * ledger as a `deployment_reservation` row so it is auditable.
 *
 * A ticket that is never torn up is just a fee. Until
 * `releaseDeploymentReservation` existed, nothing ever gave the hold
 * back: a deployment that FAILED kept the org's money having delivered
 * no capacity, and a deployment that ran kept it on top of the metered
 * usage it was also charged for. The release closes both, and runs when
 * the deployment reaches a terminal state — the admission the ticket
 * bought is over either way, and actual consumption is billed separately.
 */

import { getPricePerSecond } from "./computeMetering.js";

/** One billing hour is the minimum admission reservation. */
export const DEPLOYMENT_RESERVATION_SECONDS = 3600;

export interface CreditReservationPrisma {
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

export interface ReserveDeploymentCreditsArgs {
  tx: CreditReservationPrisma;
  orgId: string;
  gpuTier: string;
  replicas: number;
  referenceId: string;
  /** Injectable for tests; defaults to the production tier price table. */
  pricePerSecondUsd?: (tier: string) => number;
}

export type ReserveDeploymentCreditsResult =
  | { ok: true; reservedCents: bigint }
  | { ok: false; reason: "insufficient_credits"; requiredCents: bigint };

export function estimateDeploymentReservationCents(
  gpuTier: string,
  replicas: number,
  pricePerSecondUsd: (tier: string) => number = getPricePerSecond
): bigint {
  const perReplicaUsd =
    pricePerSecondUsd(gpuTier) * DEPLOYMENT_RESERVATION_SECONDS;
  const totalCents = Math.ceil(perReplicaUsd * Math.max(1, replicas) * 100);
  return BigInt(totalCents);
}

/**
 * Run INSIDE a prisma.$transaction so the decrement and the ledger row
 * commit atomically. Returns insufficient_credits when the org has no
 * balance row or the balance does not cover the reservation.
 */
export async function reserveDeploymentCredits(
  args: ReserveDeploymentCreditsArgs
): Promise<ReserveDeploymentCreditsResult> {
  const requiredCents = estimateDeploymentReservationCents(
    args.gpuTier,
    args.replicas,
    args.pricePerSecondUsd
  );

  if (requiredCents <= 0n) {
    return { ok: true, reservedCents: 0n };
  }

  const claimed = await args.tx.creditBalance.updateMany({
    where: { orgId: args.orgId, balanceCents: { gte: requiredCents } },
    data: { balanceCents: { decrement: requiredCents } },
  });

  if (claimed.count === 0) {
    return { ok: false, reason: "insufficient_credits", requiredCents };
  }

  const after = await args.tx.creditBalance.findUnique({
    where: { orgId: args.orgId },
  });

  await args.tx.creditTransaction.create({
    data: {
      orgId: args.orgId,
      amountCents: -requiredCents,
      type: "deployment_reservation",
      description: `GPU deployment reservation (${args.gpuTier} x${args.replicas}, 1h)`,
      referenceId: args.referenceId,
      balanceAfter: after?.balanceCents ?? 0n,
    },
  });

  return { ok: true, reservedCents: requiredCents };
}


// ============================================
// Release
// ============================================

/**
 * Structural surface for the release. `updateMany` on the deployment is
 * the idempotency barrier — see below. `findUnique` re-reads the amount
 * actually held once the barrier is won.
 */
export interface ReleaseReservationPrisma extends CreditReservationPrisma {
  creditBalance: CreditReservationPrisma["creditBalance"] & {
    update(args: {
      where: { orgId: string };
      data: { balanceCents: { increment: bigint } };
    }): Promise<{ balanceCents: bigint }>;
  };
  deployment: {
    updateMany(args: {
      where: {
        id: string;
        reservationReleasedAt: null;
        status?: { in: string[] };
        runGeneration?: number;
      };
      data: { reservationReleasedAt: Date };
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { id: string };
      select: { reservationCents: true };
    }): Promise<{ reservationCents: bigint | null } | null>;
  };
  agentDeployment: {
    updateMany(args: {
      where: { id: string; reservationReleasedAt: null; status?: { in: string[] } };
      data: { reservationReleasedAt: Date };
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { id: string };
      select: { reservationCents: true };
    }): Promise<{ reservationCents: bigint | null } | null>;
  };
}

export interface ReleaseDeploymentReservationArgs {
  tx: ReleaseReservationPrisma;
  kind: "model" | "agent";
  deploymentId: string;
  orgId: string;
  /**
   * The amount the CALLER believes is held (read earlier, possibly long
   * before this transaction). It is only used to skip rows that hold nothing:
   * the amount actually credited is re-read from the row under the barrier
   * below, because a replica change can grow or shrink the hold between the
   * caller's read and the release.
   */
  reservationCents: bigint;
  reason: string;
  now?: () => Date;
  /**
   * Only release while the row is in one of these statuses. The terminal
   * paths pass ["stopped", "failed"]: without it a release that arrives late
   * (after the user restarted the deployment) would claim the NEW run's live
   * hold, because a restart resets reservationReleasedAt to null for it.
   * Restart itself (which releases while the row is `pending`) passes none.
   */
  onlyIfStatusIn?: string[];
  /**
   * Model deployments only: release only while the row is still on this run
   * (Deployment.runGeneration). The status guard alone cannot tell an earlier
   * run's failure from a restarted run that has itself just gone terminal; this
   * can, so a late release never touches a later run's hold.
   */
  onlyIfRunGeneration?: number;
}

export type ReleaseDeploymentReservationResult =
  | { released: true; amountCents: bigint }
  | { released: false; reason: "already_released" | "nothing_reserved" };

/**
 * Gives a deployment's credit hold back, exactly once.
 *
 * Run INSIDE a prisma.$transaction. The CAS is
 * `updateMany({ where: { id, reservationReleasedAt: null } })`: whoever
 * flips it from null wins, and only the winner credits the balance. Two
 * concurrent status ticks observing the same failure therefore refund
 * once, not twice — the same shape as the payout executor's
 * processing→completed claim.
 *
 * The credited amount is read AFTER winning the CAS: winning takes the row
 * lock, and every writer of `reservationCents` (a replica change) holds that
 * same lock for its whole transaction, so the value read here is the final
 * one. Crediting the caller's earlier read instead refunded 200 on a 100 hold
 * after a concurrent scale-down, and lost the extra hold after a scale-up.
 */
export async function releaseDeploymentReservation(
  args: ReleaseDeploymentReservationArgs,
): Promise<ReleaseDeploymentReservationResult> {
  if (args.reservationCents <= 0n) {
    return { released: false, reason: "nothing_reserved" };
  }
  const now = (args.now ?? (() => new Date()))();

  const table =
    args.kind === "agent" ? args.tx.agentDeployment : args.tx.deployment;
  const statusGuard = args.onlyIfStatusIn ? { status: { in: args.onlyIfStatusIn } } : {};
  const data = { reservationReleasedAt: now };
  const claimed =
    args.kind === "agent"
      ? await args.tx.agentDeployment.updateMany({
          where: { id: args.deploymentId, reservationReleasedAt: null, ...statusGuard },
          data,
        })
      : await args.tx.deployment.updateMany({
          where: {
            id: args.deploymentId,
            reservationReleasedAt: null,
            ...statusGuard,
            ...(args.onlyIfRunGeneration !== undefined
              ? { runGeneration: args.onlyIfRunGeneration }
              : {}),
          },
          data,
        });
  if (claimed.count === 0) {
    return { released: false, reason: "already_released" };
  }

  const held = await table.findUnique({
    where: { id: args.deploymentId },
    select: { reservationCents: true },
  });
  const amountCents = held?.reservationCents ?? 0n;
  if (amountCents <= 0n) {
    // The barrier is flipped, but nothing is (any longer) held.
    return { released: false, reason: "nothing_reserved" };
  }

  const after = await args.tx.creditBalance.update({
    where: { orgId: args.orgId },
    data: { balanceCents: { increment: amountCents } },
  });

  await args.tx.creditTransaction.create({
    data: {
      orgId: args.orgId,
      amountCents,
      type: "deployment_reservation_release",
      description: `GPU deployment reservation released (${args.reason})`,
      // The deployment id — so a hold and its release are correlatable in
      // the ledger, which the original `deploy:<model>:<timestamp>`
      // reference made impossible.
      referenceId: args.deploymentId,
      balanceAfter: after.balanceCents,
    },
  });

  return { released: true, amountCents };
}


// ============================================
// Replica changes (PATCH /deployments/:id)
// ============================================

/**
 * Structural surface for growing/shrinking a live reservation when the replica
 * count changes. Every call runs INSIDE the same prisma.$transaction that first
 * claimed the `replicas` change with an updateMany CAS - that update takes the
 * row lock, so two concurrent PATCHes cannot both adjust the hold.
 */
export interface ReservationAdjustPrisma extends CreditReservationPrisma {
  creditBalance: CreditReservationPrisma["creditBalance"] & {
    update(args: {
      where: { orgId: string };
      data: { balanceCents: { increment: bigint } };
    }): Promise<{ balanceCents: bigint }>;
  };
  deployment: {
    findUnique(args: {
      where: { id: string };
      select: { reservationCents: true; reservationReleasedAt: true };
    }): Promise<{
      reservationCents: bigint | null;
      reservationReleasedAt: Date | null;
    } | null>;
    update(args: {
      where: { id: string };
      data: { reservationCents: bigint };
    }): Promise<unknown>;
    updateMany(args: {
      where: {
        id: string;
        reservationReleasedAt: null;
        reservationCents: bigint;
      };
      data: { reservationCents: bigint };
    }): Promise<{ count: number }>;
  };
}

export interface HoldAdditionalReplicasArgs {
  tx: ReservationAdjustPrisma;
  deploymentId: string;
  orgId: string;
  gpuTier: string;
  addedReplicas: number;
  pricePerSecondUsd?: (tier: string) => number;
}

/**
 * Scale-up: reserve one billing hour for the ADDED replicas (conditional
 * decrement + ledger row, via reserveDeploymentCredits) and add it to the
 * deployment's stored reservation so the terminal release refunds exactly what
 * was held in total.
 */
export async function holdAdditionalReplicas(
  args: HoldAdditionalReplicasArgs,
): Promise<ReserveDeploymentCreditsResult> {
  const reservation = await reserveDeploymentCredits({
    tx: args.tx,
    orgId: args.orgId,
    gpuTier: args.gpuTier,
    replicas: args.addedReplicas,
    referenceId: args.deploymentId,
    pricePerSecondUsd: args.pricePerSecondUsd,
  });
  if (!reservation.ok || reservation.reservedCents === 0n) return reservation;

  const row = await args.tx.deployment.findUnique({
    where: { id: args.deploymentId },
    select: { reservationCents: true, reservationReleasedAt: true },
  });
  await args.tx.deployment.update({
    where: { id: args.deploymentId },
    data: { reservationCents: (row?.reservationCents ?? 0n) + reservation.reservedCents },
  });
  return reservation;
}

export interface ReturnReplicaReservationArgs {
  tx: ReservationAdjustPrisma;
  deploymentId: string;
  orgId: string;
  /** Amount to hand back; capped at what the deployment still holds. */
  cents: bigint;
  reason: string;
}

/**
 * Scale-down (or rollback of a failed scale-up): credit back part of the live
 * reservation, reduce the stored amount (by CAS), and write the ledger row. A
 * no-op when the reservation was already released (the terminal release took
 * everything) or was released/changed while this ran.
 */
export async function returnReplicaReservation(
  args: ReturnReplicaReservationArgs,
): Promise<{ returnedCents: bigint }> {
  const row = await args.tx.deployment.findUnique({
    where: { id: args.deploymentId },
    select: { reservationCents: true, reservationReleasedAt: true },
  });
  if (!row || row.reservationReleasedAt || !row.reservationCents) {
    return { returnedCents: 0n };
  }
  const cents = args.cents < row.reservationCents ? args.cents : row.reservationCents;
  if (cents <= 0n) return { returnedCents: 0n };

  // Compare-and-set on the amount just read AND on the hold still being live.
  // Not every caller holds the row lock when it gets here (a caller whose own
  // claim matched nothing does not), so the terminal release can commit between
  // the read above and this write; without the CAS both would credit the same
  // cents.
  const reduced = await args.tx.deployment.updateMany({
    where: {
      id: args.deploymentId,
      reservationReleasedAt: null,
      reservationCents: row.reservationCents,
    },
    data: { reservationCents: row.reservationCents - cents },
  });
  if (reduced.count === 0) return { returnedCents: 0n };
  const after = await args.tx.creditBalance.update({
    where: { orgId: args.orgId },
    data: { balanceCents: { increment: cents } },
  });
  await args.tx.creditTransaction.create({
    data: {
      orgId: args.orgId,
      amountCents: cents,
      type: "deployment_reservation_release",
      description: `GPU deployment reservation reduced (${args.reason})`,
      referenceId: args.deploymentId,
      balanceAfter: after.balanceCents,
    },
  });
  return { returnedCents: cents };
}

/**
 * How much of the hold to hand back when a replica change is resolved to the
 * count Nosana ACTUALLY runs (the status worker's reconciliation of a claim the
 * request never finished, or of a count that drifted with no claim at all).
 *
 * While a claim is pending the hold covers the larger of the two counts: a
 * scale-up took its extra hold at the claim (`claimHoldCents`), a scale-down
 * returns nothing until it commits. Whatever exceeds `actual` goes back - the
 * claim's own cents first, exactly as taken, then the one-hour estimate per
 * replica that a scale-down returns. Zero when `actual` needs the whole hold.
 */
export function replicaHoldReturnCents(args: {
  gpuTier: string;
  /** The confirmed count on the row. */
  from: number;
  /** The pending claim's target, or null when there is no claim. */
  to: number | null;
  /** What Nosana runs. */
  actual: number;
  claimHoldCents: bigint | null;
  pricePerSecondUsd?: (tier: string) => number;
}): bigint {
  const estimate = (replicas: number) =>
    estimateDeploymentReservationCents(args.gpuTier, replicas, args.pricePerSecondUsd);
  const added = args.to !== null && args.to > args.from ? args.to - args.from : 0;
  const heldFor = args.from + added;
  if (args.actual >= heldFor) return 0n;

  const surplus = heldFor - args.actual;
  const fromClaim = Math.min(surplus, added);
  let cents = 0n;
  if (fromClaim > 0) {
    const claimCents = args.claimHoldCents ?? estimate(added);
    cents += (claimCents * BigInt(fromClaim)) / BigInt(added);
  }
  if (surplus > fromClaim) cents += estimate(surplus - fromClaim);
  return cents;
}
