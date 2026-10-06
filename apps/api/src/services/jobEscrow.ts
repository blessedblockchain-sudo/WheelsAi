/**
 * Job escrow (Offerings and Jobs, claims ledger W4 / Virtuals-inspired).
 *
 * A buyer hires an Offering. The price is taken from the buyer's credits
 * into escrow, a MarketplaceRevenue row of type "job" held `pending`, and
 * released exactly once:
 *
 *   hire       -> funded      FUND    buyer debited, escrow pending
 *   start      funded -> running
 *   submit     running -> submitted   (output passed its deliverable checks)
 *   complete   submitted -> completed SETTLE  creator (and contributors) paid
 *   reject     submitted -> rejected  REFUND  within the review window only
 *   fail       funded|running -> failed    REFUND
 *   expire     funded|running -> expired   REFUND  (SLA passed)
 *   cancel     funded -> cancelled         REFUND  (buyer, before it starts)
 *
 * Every transition is a compare-and-swap on the job's status, and the
 * escrow row has its own pending -> settled|refunded CAS, so a settle and
 * a refund can never both happen, and neither can happen twice. Each
 * balance change writes one ledger row. Run each call inside a
 * prisma.$transaction; pure over the injected surface.
 */
import { splitCreatorRevenue, type ContributorSplitTx } from "./contributorSplits.js";
import { splitRevenue } from "./marketplaceMetering.js";

export const JOB_REVIEW_WINDOW_MS = 72 * 60 * 60 * 1000;

export type JobStatus =
  | "created"
  | "funded"
  | "running"
  | "submitted"
  | "completed"
  | "rejected"
  | "failed"
  | "expired"
  | "cancelled";

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  "completed",
  "rejected",
  "failed",
  "expired",
  "cancelled",
];

export class JobFundingError extends Error {
  readonly code = "insufficient_credits";
  constructor(readonly requiredCents: bigint, readonly balanceCents: bigint) {
    super(
      `Insufficient credits: this job costs $${(Number(requiredCents) / 100).toFixed(2)} and your balance is $${(
        Number(balanceCents) / 100
      ).toFixed(2)}.`,
    );
    this.name = "JobFundingError";
  }
}

export class JobTransitionError extends Error {
  readonly code = "job_state_conflict";
  constructor(message: string) {
    super(message);
    this.name = "JobTransitionError";
  }
}

export interface OfferingForHire {
  id: string;
  title: string;
  publisherId: string;
  listingId: string | null;
  priceCents: bigint;
  slaSeconds: number;
}

export interface EscrowTx {
  creditBalance: {
    updateMany(args: {
      where: { orgId: string; balanceCents: { gte: bigint } };
      data: { balanceCents: { decrement: bigint } };
    }): Promise<{ count: number }>;
    findUnique(args: { where: { orgId: string } }): Promise<{ balanceCents: bigint } | null>;
    update(args: {
      where: { orgId: string };
      data: { balanceCents: { increment: bigint } };
    }): Promise<{ balanceCents: bigint }>;
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
  job: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string; deadlineAt: Date | null }>;
    updateMany(args: {
      where: { id: string; status: JobStatus | { in: JobStatus[] }; buyerId?: string; reviewDeadlineAt?: { gt: Date } | { lte: Date } };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  marketplaceRevenue: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
    updateMany(args: {
      where: { jobId: string; status: "pending" };
      data: { status: "settled" | "refunded"; settledAt?: Date };
    }): Promise<{ count: number }>;
    findUnique(args: { where: { jobId: string } }): Promise<{
      id: string;
      listingId: string | null;
      buyerId: string;
      publisherId: string;
      grossAmountCents: bigint;
      creatorAmountCents: bigint;
    } | null>;
  };
  publisherProfile: {
    update(args: {
      where: { orgId: string };
      data: { totalRevenueCents: { increment: bigint }; pendingPayoutCents: { increment: bigint } };
    }): Promise<unknown>;
  };
}

// ============================================
// Fund
// ============================================

/** Create a funded job and hold its price in escrow. Throws JobFundingError. */
export async function hireJob(
  tx: EscrowTx,
  args: { offering: OfferingForHire; buyerId: string; input: unknown; now?: Date },
): Promise<{ jobId: string; revenueId: string; deadlineAt: Date }> {
  const now = args.now ?? new Date();
  const { offering } = args;
  if (offering.publisherId === args.buyerId) {
    throw new JobTransitionError("You can't hire your own offering");
  }
  const split = splitRevenue(offering.priceCents, 1);

  const debited = await tx.creditBalance.updateMany({
    where: { orgId: args.buyerId, balanceCents: { gte: split.grossCents } },
    data: { balanceCents: { decrement: split.grossCents } },
  });
  if (debited.count !== 1) {
    const current = await tx.creditBalance.findUnique({ where: { orgId: args.buyerId } });
    throw new JobFundingError(split.grossCents, current?.balanceCents ?? 0n);
  }

  const deadlineAt = new Date(now.getTime() + offering.slaSeconds * 1000);
  const job = await tx.job.create({
    data: {
      offeringId: offering.id,
      buyerId: args.buyerId,
      publisherId: offering.publisherId,
      status: "funded",
      input: args.input as object,
      priceCents: split.grossCents,
      deadlineAt,
      fundedAt: now,
    },
  });
  const revenue = await tx.marketplaceRevenue.create({
    data: {
      listingId: offering.listingId,
      jobId: job.id,
      buyerId: args.buyerId,
      publisherId: offering.publisherId,
      type: "job",
      grossAmountCents: split.grossCents,
      platformFeeCents: split.platformFeeCents,
      creatorAmountCents: split.creatorCents,
      status: "pending",
    },
  });
  const after = await tx.creditBalance.findUnique({ where: { orgId: args.buyerId } });
  await tx.creditTransaction.create({
    data: {
      orgId: args.buyerId,
      amountCents: -split.grossCents,
      type: "marketplace_job",
      description: `Job escrow: ${offering.title}`,
      referenceId: revenue.id,
      balanceAfter: after?.balanceCents ?? 0n,
    },
  });
  return { jobId: job.id, revenueId: revenue.id, deadlineAt };
}

// ============================================
// Progress
// ============================================

export async function startJob(tx: EscrowTx, args: { jobId: string; now?: Date }): Promise<boolean> {
  const r = await tx.job.updateMany({
    where: { id: args.jobId, status: "funded" },
    data: { status: "running", startedAt: args.now ?? new Date() },
  });
  return r.count === 1;
}

export async function submitJob(
  tx: EscrowTx,
  args: { jobId: string; output: unknown; checkResults: unknown; now?: Date; reviewWindowMs?: number },
): Promise<boolean> {
  const now = args.now ?? new Date();
  const r = await tx.job.updateMany({
    where: { id: args.jobId, status: "running" },
    data: {
      status: "submitted",
      output: args.output as object,
      checkResults: args.checkResults as object,
      submittedAt: now,
      reviewDeadlineAt: new Date(now.getTime() + (args.reviewWindowMs ?? JOB_REVIEW_WINDOW_MS)),
    },
  });
  return r.count === 1;
}

// ============================================
// Settle / refund
// ============================================

async function settleEscrow(tx: EscrowTx, jobId: string, now: Date): Promise<bigint> {
  const claimed = await tx.marketplaceRevenue.updateMany({
    where: { jobId, status: "pending" },
    data: { status: "settled", settledAt: now },
  });
  if (claimed.count !== 1) throw new JobTransitionError("This job's escrow was already released");
  const revenue = await tx.marketplaceRevenue.findUnique({ where: { jobId } });
  if (!revenue) throw new JobTransitionError("Escrow row missing");

  const { publisherCents } = revenue.listingId
    ? await splitCreatorRevenue(tx as unknown as Partial<ContributorSplitTx>, {
        revenueId: revenue.id,
        listingId: revenue.listingId,
        publisherId: revenue.publisherId,
        creatorCents: revenue.creatorAmountCents,
      })
    : { publisherCents: revenue.creatorAmountCents };

  await tx.publisherProfile.update({
    where: { orgId: revenue.publisherId },
    data: { totalRevenueCents: { increment: publisherCents }, pendingPayoutCents: { increment: publisherCents } },
  });
  return revenue.creatorAmountCents;
}

async function refundEscrow(tx: EscrowTx, jobId: string, reason: string): Promise<bigint> {
  const claimed = await tx.marketplaceRevenue.updateMany({
    where: { jobId, status: "pending" },
    data: { status: "refunded" },
  });
  if (claimed.count !== 1) throw new JobTransitionError("This job's escrow was already released");
  const revenue = await tx.marketplaceRevenue.findUnique({ where: { jobId } });
  if (!revenue) throw new JobTransitionError("Escrow row missing");

  const after = await tx.creditBalance.update({
    where: { orgId: revenue.buyerId },
    data: { balanceCents: { increment: revenue.grossAmountCents } },
  });
  await tx.creditTransaction.create({
    data: {
      orgId: revenue.buyerId,
      amountCents: revenue.grossAmountCents,
      type: "marketplace_job_refund",
      description: `Job refunded (${reason})`,
      referenceId: revenue.id,
      balanceAfter: after.balanceCents,
    },
  });
  return revenue.grossAmountCents;
}

/** Buyer accepts, or the review window lapsed (`auto`). SETTLE. */
export async function completeJob(
  tx: EscrowTx,
  args: { jobId: string; buyerId?: string; rating?: number; now?: Date; auto?: boolean },
): Promise<{ creatorCents: bigint }> {
  const now = args.now ?? new Date();
  const r = await tx.job.updateMany({
    where: {
      id: args.jobId,
      status: "submitted",
      ...(args.auto ? { reviewDeadlineAt: { lte: now } } : { buyerId: args.buyerId }),
    },
    data: {
      status: "completed",
      completedAt: now,
      ...(args.rating !== undefined && { rating: Math.max(1, Math.min(5, Math.trunc(args.rating))) }),
    },
  });
  if (r.count !== 1) throw new JobTransitionError("Only a submitted job can be completed");
  return { creatorCents: await settleEscrow(tx, args.jobId, now) };
}

/** Buyer rejects the deliverable inside the review window. REFUND. */
export async function rejectJob(
  tx: EscrowTx,
  args: { jobId: string; buyerId: string; reason: string; now?: Date },
): Promise<{ refundedCents: bigint }> {
  const now = args.now ?? new Date();
  const reason = args.reason.trim();
  if (reason.length < 3) throw new JobTransitionError("Say why you are rejecting the deliverable");
  const r = await tx.job.updateMany({
    where: { id: args.jobId, status: "submitted", buyerId: args.buyerId, reviewDeadlineAt: { gt: now } },
    data: { status: "rejected", rejectionReason: reason.slice(0, 2000), completedAt: now },
  });
  if (r.count !== 1) {
    throw new JobTransitionError("Only a submitted job can be rejected, and only before its review window ends");
  }
  return { refundedCents: await refundEscrow(tx, args.jobId, "rejected by buyer") };
}

/** The run failed, the SLA passed, or the buyer cancelled before it started. REFUND. */
export async function endJobWithRefund(
  tx: EscrowTx,
  args: {
    jobId: string;
    to: "failed" | "expired" | "cancelled";
    reason: string;
    buyerId?: string;
    now?: Date;
  },
): Promise<{ refundedCents: bigint }> {
  const now = args.now ?? new Date();
  const from: JobStatus[] = args.to === "cancelled" ? ["funded"] : ["funded", "running"];
  const r = await tx.job.updateMany({
    where: { id: args.jobId, status: { in: from }, ...(args.buyerId && { buyerId: args.buyerId }) },
    data: { status: args.to, failureReason: args.reason.slice(0, 2000), completedAt: now },
  });
  if (r.count !== 1) {
    throw new JobTransitionError(
      args.to === "cancelled" ? "Only a job that has not started can be cancelled" : "This job has already ended",
    );
  }
  return { refundedCents: await refundEscrow(tx, args.jobId, args.to) };
}
