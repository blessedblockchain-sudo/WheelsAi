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
