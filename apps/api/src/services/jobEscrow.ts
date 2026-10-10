/**
 * Job escrow (Offerings and Jobs, claims ledger W4 / Virtuals-inspired).
 *
 * A buyer hires an Offering. The price is taken from the buyer's credits
 * into escrow, a MarketplaceRevenue row of type "job" held `pending`, and
 * released exactly once:
 *
 *   hire       -> funded      FUND    buyer debited, escrow pending
 *   start      funded -> running      (before the deadline only)
 *   submit     running -> submitted   (output passed its deliverable checks;
 *                                      before the deadline only)
 *   complete   submitted -> completed SETTLE  creator (and contributors) paid
 *   reject     submitted -> rejected  REFUND  within the review window only
 *   fail       funded|running -> failed    REFUND
 *   expire     funded|running -> expired   REFUND  (only once the SLA passed)
 *   cancel     funded -> cancelled         REFUND  (the buyer, before it starts)
 *
 * `created` is never written here: funding from credits is one transaction,
 * so a job exists only once it is paid for. The status is kept for funding
 * that takes two steps (an on-chain payment).
 *
 * Every transition is a compare-and-swap on the job's status, and the
 * escrow row has its own pending -> settled|refunded CAS, so a settle and
 * a refund can never both happen, and neither can happen twice. Each
 * balance change writes one ledger row. The deadline is part of the
 * compare-and-swap, not a check made beforehand: a deliverable that
 * arrives after the SLA cannot be submitted, and a job cannot be expired
 * before it.
 *
 * A job that ran on the platform's own model keys carries what that cost
 * (Job.modelCostCents, written with the transition that ends the run). The
 * settle moves it from the creator amount to the platform, on the escrow
 * row, before anyone is paid; a job that is refunded earned nothing, so
 * there is nothing to take it from and the buyer is refunded in full.
 *
 * An offering runs a bounded number of jobs at once (Offering.activeJobs,
 * a compare-and-set counter): hiring takes a slot and refuses when none is
 * free; the slot is given back when the job leaves funded|running.
 *
 * Run each call inside a prisma.$transaction; pure over the injected
 * surface.
 */
import { splitCreatorRevenue, type ContributorSplitTx } from "./contributorSplits.js";
import { moveEarnings, type EarningsLedgerTx } from "./earningsLedger.js";
import { splitRevenue } from "./marketplaceMetering.js";

export const JOB_REVIEW_WINDOW_MS = 72 * 60 * 60 * 1000;

/** A job costs between 50 cents and 1,000 dollars. */
export const JOB_MIN_PRICE_CENTS = 50n;
export const JOB_MAX_PRICE_CENTS = 100_000n;
/** A publisher promises delivery in between 5 minutes and 7 days. */
export const JOB_MIN_SLA_SECONDS = 300;
export const JOB_MAX_SLA_SECONDS = 7 * 24 * 60 * 60;
/** A completed job can be rated for this long after it completed. */
export const JOB_RATING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** How long a claimed job is the claiming worker's before it can be reclaimed. */
export const JOB_DEFAULT_LEASE_MS = 20 * 60 * 1000;
export const JOB_REVIEW_MAX_CHARS = 2000;

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

/** The offering is paused, archived or gone, or every slot is taken. */
export class JobUnavailableError extends Error {
  constructor(
    readonly code: "offering_unavailable" | "offering_at_capacity",
    message: string,
  ) {
    super(message);
    this.name = "JobUnavailableError";
  }
}

/** The offering's own terms are outside what a job may be. Nothing was charged. */
export class JobTermsError extends Error {
  readonly code = "invalid_job_terms";
  constructor(message: string) {
    super(message);
    this.name = "JobTermsError";
  }
}

/**
 * The publisher has no payout profile to accrue into. The settle rolls
 * back and the escrow stays held: money is never released into nothing.
 */
export class JobSettlementError extends Error {
  readonly code = "publisher_profile_missing";
  constructor(readonly publisherId: string) {
    super("The publisher has no payout profile; the escrow stays held until one exists");
    this.name = "JobSettlementError";
  }
}

export interface OfferingForHire {
  id: string;
  title: string;
  publisherId: string;
  listingId: string | null;
  priceCents: bigint;
  slaSeconds: number;
  /** Jobs funded or running at once. Omitted = the capacity is not checked. */
  maxConcurrentJobs?: number;
  /** Copied into the job's terms, so later edits do not change this job. */
  deliverableChecks?: unknown;
  outputFormat?: string;
}

/** What the buyer agreed to at hire; stored on the job. */
export interface JobTerms {
  title: string;
  priceCents: string;
  slaSeconds: number;
  reviewWindowMs: number;
  deliverableChecks: unknown;
  outputFormat: string;
}

type DateBound = { gt: Date } | { lte: Date };

/** With what moveEarnings needs: a settled job credits the publisher through the ledger. */
export interface EscrowTx extends EarningsLedgerTx {
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
      where: {
        id: string;
        status: JobStatus | { in: JobStatus[] };
        buyerId?: string;
        deadlineAt?: DateBound;
        reviewDeadlineAt?: DateBound;
        leaseExpiresAt?: DateBound;
        completedAt?: DateBound;
        rating?: null;
      };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { id: string };
      select: { offeringId: true; modelCostCents: true };
    }): Promise<{ offeringId: string; modelCostCents: bigint } | null>;
  };
  offering: {
    updateMany(args: {
      where: { id: string; status?: "active"; activeJobs: { lt: number } | { gt: number } };
      data: { activeJobs: { increment: number } | { decrement: number } };
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { id: string };
      select: { status: true; agentId: true };
    }): Promise<{ status: string; agentId: string | null } | null>;
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
    update(args: {
      where: { jobId: string };
      data: {
        platformFeeCents: { increment: bigint };
        creatorAmountCents: { decrement: bigint };
        modelCostCents: bigint;
      };
    }): Promise<unknown>;
  };
}

// ============================================
// Fund
// ============================================

const JOB_FOR_ESCROW = { offeringId: true, modelCostCents: true } as const;

/**
 * What a run used on the platform's own model keys, and what it cost.
 * Written by the same statement that ends the run, so it is counted once.
 */
export interface JobModelUsage {
  inputTokens: number;
  outputTokens: number;
  costCents: bigint;
}

function usageData(usage: JobModelUsage | undefined): Record<string, unknown> {
  if (!usage || (usage.inputTokens <= 0 && usage.outputTokens <= 0 && usage.costCents <= 0n)) return {};
  return {
    platformInputTokens: { increment: BigInt(Math.max(0, Math.trunc(usage.inputTokens))) },
    platformOutputTokens: { increment: BigInt(Math.max(0, Math.trunc(usage.outputTokens))) },
    modelCostCents: { increment: usage.costCents > 0n ? usage.costCents : 0n },
  };
}

/** Gives the offering's slot back when its job leaves funded|running. */
async function releaseSlot(tx: EscrowTx, jobId: string): Promise<void> {
  const job = await tx.job.findUnique({ where: { id: jobId }, select: JOB_FOR_ESCROW });
  if (!job) return;
  // Guarded, so a counter that is already zero stays zero.
  await tx.offering.updateMany({
    where: { id: job.offeringId, activeJobs: { gt: 0 } },
    data: { activeJobs: { decrement: 1 } },
  });
}

/**
 * Create a funded job and hold its price in escrow. Throws JobTermsError,
 * JobUnavailableError or JobFundingError; nothing is charged on any of them.
 *
 * `idempotencyKey` is stored under the unique (buyerId, idempotencyKey):
 * a second hire with the same key fails the insert and its transaction
 * rolls back whole, debit included. The caller finds the first job and
 * returns it (outside the transaction).
 */
export async function hireJob(
  tx: EscrowTx,
  args: {
    offering: OfferingForHire;
    buyerId: string;
    input: unknown;
    now?: Date;
    idempotencyKey?: string | null;
    hiredByUserId?: string | null;
    hiredByApiKeyId?: string | null;
  },
): Promise<{ jobId: string; revenueId: string; deadlineAt: Date; terms: JobTerms }> {
  const now = args.now ?? new Date();
  const { offering } = args;
  if (offering.publisherId === args.buyerId) {
    throw new JobTransitionError("You can't hire your own offering");
  }
  // The route validates these when the offering is written. Held here too:
  // this is the last code before money moves.
  if (offering.priceCents < JOB_MIN_PRICE_CENTS || offering.priceCents > JOB_MAX_PRICE_CENTS) {
    throw new JobTermsError("A job costs between $0.50 and $1,000.00");
  }
  if (
    !Number.isInteger(offering.slaSeconds) ||
    offering.slaSeconds < JOB_MIN_SLA_SECONDS ||
    offering.slaSeconds > JOB_MAX_SLA_SECONDS
  ) {
    throw new JobTermsError("A job's delivery time is between 5 minutes and 7 days");
  }
  const split = splitRevenue(offering.priceCents, 1);

  if (offering.maxConcurrentJobs !== undefined) {
    // Also the compare-and-swap on the offering still being sold: a pause
    // or archive that lands first leaves no slot to take.
    const slot = await tx.offering.updateMany({
      where: { id: offering.id, status: "active", activeJobs: { lt: offering.maxConcurrentJobs } },
      data: { activeJobs: { increment: 1 } },
    });
    if (slot.count !== 1) {
      const current = await tx.offering.findUnique({
        where: { id: offering.id },
        select: { status: true, agentId: true },
      });
      throw current?.status === "active"
        ? new JobUnavailableError(
            "offering_at_capacity",
            "This offering is running as many jobs as its publisher allows at once. Try again shortly.",
          )
        : new JobUnavailableError("offering_unavailable", "This offering is not available for hire");
    }
  }

  const debited = await tx.creditBalance.updateMany({
    where: { orgId: args.buyerId, balanceCents: { gte: split.grossCents } },
    data: { balanceCents: { decrement: split.grossCents } },
  });
  if (debited.count !== 1) {
    const current = await tx.creditBalance.findUnique({ where: { orgId: args.buyerId } });
    throw new JobFundingError(split.grossCents, current?.balanceCents ?? 0n);
  }

  const terms: JobTerms = {
    title: offering.title,
    priceCents: split.grossCents.toString(),
    slaSeconds: offering.slaSeconds,
    reviewWindowMs: JOB_REVIEW_WINDOW_MS,
    deliverableChecks: offering.deliverableChecks ?? [],
    outputFormat: offering.outputFormat ?? "text",
  };
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
      terms,
      ...(args.idempotencyKey && { idempotencyKey: args.idempotencyKey }),
      ...(args.hiredByUserId && { hiredByUserId: args.hiredByUserId }),
      ...(args.hiredByApiKeyId && { hiredByApiKeyId: args.hiredByApiKeyId }),
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
  return { jobId: job.id, revenueId: revenue.id, deadlineAt, terms };
}

// ============================================
// Progress
// ============================================

/**
 * Claims a funded job for one worker. False = someone else has it, it is
 * no longer funded, or its deadline has passed (it is the sweeper's to
 * expire, never a worker's to start).
 */
export async function startJob(
  tx: EscrowTx,
  args: { jobId: string; now?: Date; leaseMs?: number },
): Promise<boolean> {
  const now = args.now ?? new Date();
  const r = await tx.job.updateMany({
    where: { id: args.jobId, status: "funded", deadlineAt: { gt: now } },
    data: {
      status: "running",
      startedAt: now,
      leaseExpiresAt: new Date(now.getTime() + (args.leaseMs ?? JOB_DEFAULT_LEASE_MS)),
      attempts: { increment: 1 },
    },
  });
  return r.count === 1;
}

/**
 * Takes over a running job whose worker stopped renewing its lease (it
 * crashed), while there is still time before the deadline. Without this
 * the buyer waits out the whole SLA for a refund.
 */
export async function reclaimJob(
  tx: EscrowTx,
  args: { jobId: string; now?: Date; leaseMs?: number },
): Promise<boolean> {
  const now = args.now ?? new Date();
  const r = await tx.job.updateMany({
    where: { id: args.jobId, status: "running", leaseExpiresAt: { lte: now }, deadlineAt: { gt: now } },
    data: {
      leaseExpiresAt: new Date(now.getTime() + (args.leaseMs ?? JOB_DEFAULT_LEASE_MS)),
      attempts: { increment: 1 },
    },
  });
  return r.count === 1;
}

/**
 * A worker that is shutting down gives its job up: the lease ends now, so
 * the sweeper hands the job to another worker instead of the buyer waiting
 * out the lease.
 */
export async function releaseJobLease(
  tx: Pick<EscrowTx, "job">,
  args: { jobId: string; now?: Date; modelUsage?: JobModelUsage },
): Promise<boolean> {
  const now = args.now ?? new Date();
  const r = await tx.job.updateMany({
    where: { id: args.jobId, status: "running" },
    data: { leaseExpiresAt: now, ...usageData(args.modelUsage) },
  });
  return r.count === 1;
}

/** False = the job is no longer running, or the deliverable is late: discard it. */
export async function submitJob(
  tx: EscrowTx,
  args: {
    jobId: string;
    output: unknown;
    checkResults: unknown;
    now?: Date;
    reviewWindowMs?: number;
    modelUsage?: JobModelUsage;
  },
): Promise<boolean> {
  const now = args.now ?? new Date();
  const r = await tx.job.updateMany({
    where: { id: args.jobId, status: "running", deadlineAt: { gt: now } },
    data: {
      status: "submitted",
      output: args.output as object,
      checkResults: args.checkResults as object,
      submittedAt: now,
      reviewDeadlineAt: new Date(now.getTime() + (args.reviewWindowMs ?? JOB_REVIEW_WINDOW_MS)),
      leaseExpiresAt: null,
      ...usageData(args.modelUsage),
    },
  });
  if (r.count !== 1) return false;
  await releaseSlot(tx, args.jobId);
  return true;
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

  // Model usage on the platform's keys comes out of the creator amount
  // first, on the escrow row itself, so the row still adds up (gross =
  // platform fee + creator amount) and contributors share what is left.
  const job = await tx.job.findUnique({ where: { id: jobId }, select: JOB_FOR_ESCROW });
  const owed = job?.modelCostCents ?? 0n;
  const modelCostCents = owed > revenue.creatorAmountCents ? revenue.creatorAmountCents : owed;
  if (modelCostCents > 0n) {
    await tx.marketplaceRevenue.update({
      where: { jobId },
      data: {
        platformFeeCents: { increment: modelCostCents },
        creatorAmountCents: { decrement: modelCostCents },
        modelCostCents,
      },
    });
  }
  const creatorCents = revenue.creatorAmountCents - modelCostCents;

  // An agent offering pays the agent's contributors whether or not the
  // agent is also listed; a workflow or model offering has none.
  const agentId = revenue.listingId || !job
    ? null
    : ((await tx.offering.findUnique({ where: { id: job.offeringId }, select: { status: true, agentId: true } }))
        ?.agentId ?? null);
  const { publisherCents } =
    revenue.listingId || agentId
      ? await splitCreatorRevenue(tx as unknown as Partial<ContributorSplitTx>, {
          revenueId: revenue.id,
          ...(revenue.listingId ? { listingId: revenue.listingId } : { agentId: agentId! }),
          publisherId: revenue.publisherId,
          creatorCents,
        })
      : { publisherCents: creatorCents };

  const accrued = await moveEarnings(tx, {
    orgId: revenue.publisherId,
    amountCents: publisherCents,
    type: "job",
    referenceId: revenue.id,
    description: "Job settled",
  });
  // Thrown, so the whole transaction (the job's completion and the escrow
  // claim above) rolls back and the escrow is still held.
  if (!accrued.moved) throw new JobSettlementError(revenue.publisherId);
  return creatorCents;
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

function ratingData(rating: number, review: string | undefined): { rating: number; review?: string } {
  const text = review?.trim();
  return {
    rating: Math.max(1, Math.min(5, Math.trunc(rating))),
    ...(text && { review: text.slice(0, JOB_REVIEW_MAX_CHARS) }),
  };
}

/** Buyer accepts, or the review window lapsed (`auto`). SETTLE. */
export async function completeJob(
  tx: EscrowTx,
  args: { jobId: string; buyerId?: string; rating?: number; review?: string; now?: Date; auto?: boolean },
): Promise<{ creatorCents: bigint }> {
  const now = args.now ?? new Date();
  // Without this, an accept with no buyer would match any submitted job.
  if (!args.auto && !args.buyerId) throw new JobTransitionError("Only the buyer can accept a deliverable");
  const rated = !args.auto && args.rating !== undefined;
  const r = await tx.job.updateMany({
    where: {
      id: args.jobId,
      status: "submitted",
      ...(args.auto ? { reviewDeadlineAt: { lte: now } } : { buyerId: args.buyerId }),
    },
    data: {
      status: "completed",
      completedAt: now,
      ...(rated && { ...ratingData(args.rating!, args.review), ratedAt: now }),
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

/**
 * The run failed, the SLA passed, or the buyer cancelled before it started.
 * REFUND.
 *
 *   failed     the runner's verdict, any time before submission
 *   expired    only once deadlineAt has passed
 *   cancelled  only the buyer, and only while the job is still funded
 */
export async function endJobWithRefund(
  tx: EscrowTx,
  args: {
    jobId: string;
    to: "failed" | "expired" | "cancelled";
    reason: string;
    buyerId?: string;
    now?: Date;
    /** What the last run produced and how it was graded, for the publisher. */
    output?: unknown;
    checkResults?: unknown;
    modelUsage?: JobModelUsage;
  },
): Promise<{ refundedCents: bigint }> {
  const now = args.now ?? new Date();
  if (args.to === "cancelled" && !args.buyerId) {
    throw new JobTransitionError("Only the buyer can cancel a job");
  }
  const from: JobStatus[] = args.to === "cancelled" ? ["funded"] : ["funded", "running"];
  const r = await tx.job.updateMany({
    where: {
      id: args.jobId,
      status: { in: from },
      ...(args.buyerId && { buyerId: args.buyerId }),
      ...(args.to === "expired" && { deadlineAt: { lte: now } }),
    },
    data: {
      status: args.to,
      failureReason: args.reason.slice(0, 2000),
      completedAt: now,
      leaseExpiresAt: null,
      ...(args.output !== undefined && { output: args.output as object }),
      ...(args.checkResults !== undefined && { checkResults: args.checkResults as object }),
      ...usageData(args.modelUsage),
    },
  });
  if (r.count !== 1) {
    throw new JobTransitionError(
      args.to === "cancelled"
        ? "Only a job that has not started can be cancelled"
        : args.to === "expired"
          ? "This job has already ended, or its deadline has not passed"
          : "This job has already ended",
    );
  }
  await releaseSlot(tx, args.jobId);
  return { refundedCents: await refundEscrow(tx, args.jobId, args.to) };
}

// ============================================
// Rating
// ============================================

/**
 * The buyer rates a completed job they did not rate when accepting (an
 * auto-completed one included). Once: the compare-and-swap is on the
 * rating still being empty. Moves no money.
 */
export async function rateJob(
  tx: Pick<EscrowTx, "job">,
  args: { jobId: string; buyerId: string; rating: number; review?: string; now?: Date },
): Promise<void> {
  const now = args.now ?? new Date();
  if (!Number.isFinite(args.rating)) throw new JobTransitionError("A rating is a number from 1 to 5");
  const r = await tx.job.updateMany({
    where: {
      id: args.jobId,
      status: "completed",
      buyerId: args.buyerId,
      rating: null,
      completedAt: { gt: new Date(now.getTime() - JOB_RATING_WINDOW_MS) },
    },
    data: { ...ratingData(args.rating, args.review), ratedAt: now },
  });
  if (r.count !== 1) {
    throw new JobTransitionError(
      "Only the buyer can rate a job, once, within 30 days of its completion",
    );
  }
}
