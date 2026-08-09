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
 * the idempotency barrier — see below.
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
      where: { id: string; reservationReleasedAt: null };
      data: { reservationReleasedAt: Date };
    }): Promise<{ count: number }>;
  };
  agentDeployment: {
    updateMany(args: {
      where: { id: string; reservationReleasedAt: null };
      data: { reservationReleasedAt: Date };
    }): Promise<{ count: number }>;
  };
}

export interface ReleaseDeploymentReservationArgs {
  tx: ReleaseReservationPrisma;
  kind: "model" | "agent";
  deploymentId: string;
  orgId: string;
  /** The amount actually held, read from the deployment row. */
  reservationCents: bigint;
  reason: string;
  now?: () => Date;
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
  const claimed = await table.updateMany({
    where: { id: args.deploymentId, reservationReleasedAt: null },
    data: { reservationReleasedAt: now },
  });
  if (claimed.count === 0) {
    return { released: false, reason: "already_released" };
  }

  const after = await args.tx.creditBalance.update({
    where: { orgId: args.orgId },
    data: { balanceCents: { increment: args.reservationCents } },
  });

  await args.tx.creditTransaction.create({
    data: {
      orgId: args.orgId,
      amountCents: args.reservationCents,
      type: "deployment_reservation_release",
      description: `GPU deployment reservation released (${args.reason})`,
      // The deployment id — so a hold and its release are correlatable in
      // the ledger, which the original `deploy:<model>:<timestamp>`
      // reference made impossible.
      referenceId: args.deploymentId,
      balanceAfter: after.balanceCents,
    },
  });

  return { released: true, amountCents: args.reservationCents };
}
