/**
 * Jobs: hiring an offering and what the two sides can do with the result
 * (Offerings and Jobs).
 *
 *   hire     the terms the buyer saw are compared with the offering as it
 *            is now (409 offering_terms_changed when they differ), the
 *            buyer's input is checked against the offering's schema, then
 *            ONE transaction reserves the API key's allowance (when a
 *            key is hiring), takes a capacity slot, debits the buyer and
 *            creates the funded job with its escrow (jobEscrow.hireJob).
 *            The job is put on the runner's queue only after that commits;
 *            if the queue is down the sweeper finds the funded job.
 *   accept   the buyer releases the escrow to the publisher.
 *   reject   the buyer refuses the deliverable inside the review window and
 *            is refunded; it counts as a dispute on the publisher.
 *   cancel   the buyer takes a job back before it starts, refunded.
 *   rate     the buyer rates a completed job, once.
 *
 * Idempotency: a hire may carry an Idempotency-Key. The key is unique per
 * buyer, so a retried hire either finds the first job before the
 * transaction or loses the insert inside it - which rolls its debit back -
 * and is then answered with the first job. The unique violation is handled
 * OUTSIDE the transaction; inside, it would have aborted it anyway.
 *
 * Expected terms: an active offering can be edited in place, so a hire
 * carries `expected` - the price, the delivery time and the terms version
 * the buyer was shown (PublicOffering.termsVersion). The comparison and the
 * debit use the SAME read of the offering: what is charged, and what the
 * job records as its terms, is exactly what was compared, whatever the
 * publisher saves in between. A person (a dashboard session) must send all
 * three; without them the hire is refused with 400 expected_terms_required.
 * An API key may leave `expected` out and is then hired at the offering's
 * terms as they are when the request arrives: a script has not "seen" a
 * price, and the key's per-job cap (required for jobs:hire, reserved inside
 * the transaction) already bounds what one hire can cost. Whatever part of
 * `expected` a key does send is held to.
 *
 * Who may see a job: its buyer and its publisher, each a different view of
 * it. Anyone else is told it does not exist. Neither view carries the
 * offering's private instructions; the buyer's view has no output until the
 * job was submitted, and never the publisher's diagnostics.
 *
 * Pure over the injected store.
 */

import { z } from "zod";

import { ApiKeySpendCapError, reserveApiKeySpend, type ApiKeySpendTx } from "./apiKeySpend.js";
import {
  completeJob,
  endJobWithRefund,
  hireJob,
  JobFundingError,
  JobSettlementError,
  JobTermsError,
  JobTransitionError,
  JobUnavailableError,
  rateJob,
  rejectJob,
  type EscrowTx,
} from "./jobEscrow.js";
import type { JobEvent } from "./jobNotifications.js";
import { workflowJobInput } from "./jobPrompt.js";
import {
  checkSellable,
  JOBS_NOT_CONFIGURED_MESSAGE,
  OfferingError,
  offeringTerms,
  validateJobInput,
  type OfferingStore,
  type OfferingTerms,
  type OfferingView,
} from "./offerings.js";
import { checkAgainstSchema } from "./workflowSchemaCheck.js";

export const MAX_JOB_INPUT_BYTES = 64 * 1024;
export const MAX_IDEMPOTENCY_KEY_CHARS = 100;

// ============================================
// Errors
// ============================================

export type JobErrorCode =
  | "invalid_request"
  | "insufficient_credits"
  | "api_key_job_price_cap_exceeded"
  | "api_key_daily_cap_exceeded"
  | "api_key_spend_caps_missing"
  | "not_the_buyer"
  | "offering_not_found"
  | "job_not_found"
  | "own_offering"
  | "offering_unavailable"
  | "offering_at_capacity"
  | "idempotency_key_reused"
  | "expected_terms_required"
  | "offering_terms_changed"
  | "job_state_conflict"
  | "review_window_closed"
  | "job_already_started"
  | "input_invalid"
  | "validation_too_expensive"
  | "settlement_unavailable"
  | "jobs_not_configured";

const STATUS_OF: Record<JobErrorCode, number> = {
  invalid_request: 400,
  expected_terms_required: 400,
  insufficient_credits: 402,
  api_key_job_price_cap_exceeded: 403,
  api_key_daily_cap_exceeded: 403,
  api_key_spend_caps_missing: 403,
  not_the_buyer: 403,
  offering_not_found: 404,
  job_not_found: 404,
  own_offering: 409,
  offering_unavailable: 409,
  offering_at_capacity: 409,
  idempotency_key_reused: 409,
  offering_terms_changed: 409,
  job_state_conflict: 409,
  review_window_closed: 409,
  job_already_started: 409,
  input_invalid: 422,
  validation_too_expensive: 422,
  settlement_unavailable: 503,
  jobs_not_configured: 501,
};

export class JobError extends Error {
  readonly status: number;
  constructor(
    readonly code: JobErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "JobError";
    this.status = STATUS_OF[code];
  }
}

// ============================================
// Stored shape
// ============================================

export interface JobRecord {
  id: string;
  offeringId: string;
  buyerId: string;
  publisherId: string;
  status: string;
  input: unknown;
  output: unknown;
  checkResults: unknown;
  priceCents: bigint;
  failureReason: string | null;
  rejectionReason: string | null;
  deadlineAt: Date | null;
  reviewDeadlineAt: Date | null;
  fundedAt: Date | null;
  startedAt: Date | null;
  submittedAt: Date | null;
  completedAt: Date | null;
  rating: number | null;
  review: string | null;
  idempotencyKey: string | null;
  attempts: number;
  orchestrationExecutionId: string | null;
  modelCostCents: bigint;
  createdAt: Date;
  offering: { id: string; slug: string; title: string; productKind: string };
  buyer: { name: string };
  escrow: {
    status: string;
    grossAmountCents: bigint;
    platformFeeCents: bigint;
    creatorAmountCents: bigint;
  } | null;
}

export type JobRole = "buyer" | "publisher";

export interface JobListParams {
  orgId: string;
  role: JobRole;
  status?: string;
  offeringId?: string;
  page: number;
  limit: number;
}

export interface JobStore {
  /** The job, when `orgId` is its buyer or its publisher; null for anyone else. */
  findForOrg(jobId: string, orgId: string): Promise<JobRecord | null>;
  findByIdempotencyKey(buyerId: string, key: string): Promise<JobRecord | null>;
  list(params: JobListParams): Promise<{ rows: JobRecord[]; total: number }>;
  /** What is waiting on this organization, for the app's badges. */
  summary(orgId: string): Promise<{ awaitingReview: number; inProgress: number; toDeliver: number }>;
  inTransaction<T>(fn: (tx: EscrowTx & ApiKeySpendTx) => Promise<T>): Promise<T>;
}

export interface JobServiceDeps {
  store: JobStore;
  offerings: OfferingStore;
  /** False when no worker runs jobs (JOB_RUNNER_CONCURRENCY=0). */
  runnerEnabled: boolean;
  /** After the hire committed. May throw; the sweeper re-queues. */
  enqueue(jobId: string): Promise<void>;
  /** Must not throw. */
  notify(event: JobEvent, jobId: string): Promise<void>;
  ensurePublisherProfile(orgId: string): Promise<void>;
  /** A rejection counts against the publisher. Must not throw. */
  recordDispute(publisherId: string): Promise<void>;
  /** Fire-and-forget after anything that moves a publisher's standing. Must not throw. */
  recalculateReputation(publisherId: string): Promise<void>;
  onEnqueueError?(jobId: string, err: unknown): void;
  now?: () => Date;
}

/** Who is acting. An API key has no user behind it. */
export interface JobCaller {
  orgId: string;
  userId: string | null;
  apiKeyId: string | null;
}

// ============================================
// Response shapes
// ============================================

const ESCROW_STATE: Record<string, "held" | "released" | "refunded"> = {
  pending: "held",
  settled: "released",
  refunded: "refunded",
};

const OUTPUT_VISIBLE_TO_BUYER = new Set(["submitted", "completed", "rejected"]);

interface StoredResult {
  type?: unknown;
  label?: unknown;
  passed?: unknown;
  details?: unknown;
}

function results(raw: unknown): StoredResult[] {
  return Array.isArray(raw) ? (raw as StoredResult[]) : [];
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/** The buyer's view. No diagnostics, and no output before the job was submitted. */
export function toBuyerJob(job: JobRecord) {
  return {
    id: job.id,
    role: "buyer" as const,
    status: job.status,
    offering: job.offering,
    priceCents: Number(job.priceCents),
    escrow: job.escrow
      ? { status: ESCROW_STATE[job.escrow.status] ?? "held", amountCents: Number(job.escrow.grossAmountCents) }
      : null,
    input: job.input,
    output: OUTPUT_VISIBLE_TO_BUYER.has(job.status) ? (job.output ?? null) : null,
    // Which checks ran and whether they passed; the publisher's notes on a
    // failed run ("run" rows, and every `details`) stay with the publisher.
    checks: results(job.checkResults)
      .filter((r) => r.type !== "run")
      .map((r) => ({ label: String(r.label ?? ""), type: String(r.type ?? ""), passed: r.passed === true })),
    deadlineAt: iso(job.deadlineAt),
    reviewDeadlineAt: iso(job.reviewDeadlineAt),
    fundedAt: iso(job.fundedAt),
    startedAt: iso(job.startedAt),
    submittedAt: iso(job.submittedAt),
    completedAt: iso(job.completedAt),
    failureReason: job.failureReason,
    rejectionReason: job.rejectionReason,
    rating: job.rating,
    review: job.review,
    createdAt: job.createdAt.toISOString(),
  };
}

export type BuyerJob = ReturnType<typeof toBuyerJob>;

/** The publisher's view: what their product produced and how it was graded. */
export function toPublisherJob(job: JobRecord) {
  const { checks: _checks, ...shared } = toBuyerJob(job);
  return {
    ...shared,
    role: "publisher" as const,
    buyer: { orgId: job.buyerId, name: job.buyer.name },
    output: job.output ?? null,
    checkResults: results(job.checkResults).map((r) => ({
      label: String(r.label ?? ""),
      type: String(r.type ?? ""),
      passed: r.passed === true,
      details: String(r.details ?? ""),
    })),
    attempts: job.attempts,
    orchestrationExecutionId: job.orchestrationExecutionId,
    platformFeeCents: job.escrow ? Number(job.escrow.platformFeeCents) : null,
    creatorAmountCents: job.escrow ? Number(job.escrow.creatorAmountCents) : null,
    modelCostCents: Number(job.modelCostCents),
  };
}

export type PublisherJob = ReturnType<typeof toPublisherJob>;

export function toJobView(job: JobRecord, orgId: string): BuyerJob | PublisherJob {
  return job.buyerId === orgId ? toBuyerJob(job) : toPublisherJob(job);
}

// ============================================
// Hire
// ============================================

/** The terms the buyer was shown: see the header. */
export const expectedTermsSchema = z
  .object({
    priceCents: z.number().int().min(0),
    slaSeconds: z.number().int().min(0).optional(),
    termsVersion: z.string().min(1).max(100).optional(),
  })
  .strict();

export type ExpectedTerms = z.infer<typeof expectedTermsSchema>;

export const hireBodySchema = z
  .object({ input: z.record(z.unknown()).default({}), expected: expectedTermsSchema.optional() })
  .strict();

/**
 * Holds a hire to the terms its buyer saw. Throws before anything is
 * charged; both errors carry the offering's current terms, so the caller
 * can show them and ask again.
 */
function assertExpectedTerms(current: OfferingTerms, expected: ExpectedTerms | null, caller: JobCaller): void {
  const byPerson = caller.apiKeyId === null;
  if (byPerson && (!expected || expected.slaSeconds === undefined || expected.termsVersion === undefined)) {
    throw new JobError(
      "expected_terms_required",
      "A hire must say which terms were agreed to: send expected.priceCents, expected.slaSeconds and expected.termsVersion from the offering as it was shown",
      { current },
    );
  }
  if (!expected) return;
  const changed = (["priceCents", "slaSeconds", "termsVersion"] as const).filter(
    (field) => expected[field] !== undefined && expected[field] !== current[field],
  );
  if (changed.length > 0) {
    throw new JobError(
      "offering_terms_changed",
      "This offering changed after you opened it. Nothing was charged; review it as it is now and hire again.",
      { current, changed },
    );
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

function replay(job: JobRecord, offeringId: string): { job: BuyerJob; replayed: true } {
  if (job.offeringId !== offeringId) {
    throw new JobError(
      "idempotency_key_reused",
      "This Idempotency-Key was already used to hire a different offering",
    );
  }
  return { job: toBuyerJob(job), replayed: true };
}

export async function hireOffering(
  deps: JobServiceDeps,
  args: {
    offeringId: string;
    caller: JobCaller;
    input: unknown;
    /** What the buyer was shown. Required of a person; see the header. */
    expected?: ExpectedTerms | null;
    idempotencyKey?: string | null;
  },
): Promise<{ job: BuyerJob; replayed: boolean }> {
  const { caller } = args;
  const key = args.idempotencyKey?.trim() || null;
  if (key && key.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    throw new JobError("invalid_request", `Idempotency-Key is at most ${MAX_IDEMPOTENCY_KEY_CHARS} characters`);
  }
  if (!deps.runnerEnabled) throw new JobError("jobs_not_configured", JOBS_NOT_CONFIGURED_MESSAGE);

  const offering: OfferingView | null = await deps.offerings.findById(args.offeringId);
  if (!offering || offering.status !== "active") {
    throw new JobError("offering_not_found", "Offering not found");
  }
  if (key) {
    const first = await deps.store.findByIdempotencyKey(caller.orgId, key);
    if (first) return replay(first, offering.id);
  }
  if (offering.publisherId === caller.orgId) {
    throw new JobError("own_offering", "You can't hire your own offering. Use its test run instead.");
  }
  // Against `offering`, the read the debit below takes its price from.
  assertExpectedTerms(offeringTerms(offering), args.expected ?? null, caller);

  const input = args.input ?? {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new JobError("invalid_request", "input must be an object");
  }
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_JOB_INPUT_BYTES) {
    throw new JobError("invalid_request", `input is larger than ${MAX_JOB_INPUT_BYTES / 1024} KB`);
  }

  // The product as it is now: deleted, disabled or rebuilt from marketplace
  // copies since the offering was activated means it cannot be hired, and
  // the offering stops being offered.
  const sellable = await checkSellable(deps.offerings, offering.publisherId, offering, {
    allowedTools: offering.allowedTools,
  });
  if (!sellable.ok) {
    await deps.offerings.transition(offering.publisherId, offering.id, ["active"], "paused").catch(() => false);
    throw new JobError("offering_unavailable", "This offering is not available for hire right now");
  }

  try {
    validateJobInput(offering, input);
  } catch (err) {
    if (err instanceof OfferingError) {
      throw new JobError(
        err.code === "validation_too_expensive" ? "validation_too_expensive" : "input_invalid",
        err.message,
        { errors: err.details ?? [] },
      );
    }
    throw err;
  }
  if (offering.productKind === "workflow") {
    // The workflow checks its own input schema when the run starts; a
    // mismatch found only there would cost the buyer a failed job. Checked
    // here with the same function, on the same input the run will get.
    const run = workflowJobInput(offering, input);
    const problems = checkAgainstSchema(sellable.workflowInputSchema, {
      ...run.input,
      ...(run.prompt !== undefined && { prompt: run.prompt }),
    });
    if (problems.length > 0) {
      throw new JobError("input_invalid", "The input does not match what this offering's workflow accepts", {
        errors: problems.map((message) => ({ path: "", message })),
      });
    }
  }

  const now = (deps.now ?? (() => new Date()))();
  let hired: { jobId: string };
  try {
    hired = await deps.store.inTransaction(async (tx) => {
      if (caller.apiKeyId) {
        await reserveApiKeySpend(tx, {
          apiKeyId: caller.apiKeyId,
          orgId: caller.orgId,
          priceCents: offering.priceCents,
          now,
        });
      }
      return hireJob(tx, {
        offering: {
          id: offering.id,
          title: offering.title,
          publisherId: offering.publisherId,
          listingId: offering.listingId,
          priceCents: offering.priceCents,
          slaSeconds: offering.slaSeconds,
          maxConcurrentJobs: offering.maxConcurrentJobs,
          deliverableChecks: offering.deliverableChecks,
          outputFormat: offering.outputFormat,
        },
        buyerId: caller.orgId,
        input,
        now,
        idempotencyKey: key,
        hiredByUserId: caller.userId,
        hiredByApiKeyId: caller.apiKeyId,
      });
    });
  } catch (err) {
    // Everything below rolled the whole transaction back: nothing was charged.
    if (key && isUniqueViolation(err)) {
      const first = await deps.store.findByIdempotencyKey(caller.orgId, key);
      if (first) return replay(first, offering.id);
    }
    if (err instanceof JobFundingError) {
      throw new JobError("insufficient_credits", err.message, {
        requiredCents: Number(err.requiredCents),
        balanceCents: Number(err.balanceCents),
      });
    }
    if (err instanceof ApiKeySpendCapError) throw new JobError(err.code, err.message, err.extra);
    if (err instanceof JobUnavailableError) throw new JobError(err.code, err.message);
    if (err instanceof JobTermsError) {
      throw new JobError("offering_unavailable", "This offering is not available for hire right now");
    }
    if (err instanceof JobTransitionError) throw new JobError("own_offering", err.message);
    throw err;
  }

  // Only now, with the job committed. A queue that is down is not the
  // buyer's problem: the sweeper re-queues a funded job nobody started.
  await deps.enqueue(hired.jobId).catch((err: unknown) => deps.onEnqueueError?.(hired.jobId, err));
  await deps.notify("job.funded", hired.jobId);

  const job = await deps.store.findForOrg(hired.jobId, caller.orgId);
  if (!job) throw new Error(`job ${hired.jobId} was hired and could not be read back`);
  return { job: toBuyerJob(job), replayed: false };
}

// ============================================
// Read
// ============================================

export const jobListSchema = z.object({
  role: z.enum(["buyer", "publisher"]).default("buyer"),
  status: z
    .enum(["funded", "running", "submitted", "completed", "rejected", "failed", "expired", "cancelled"])
    .optional(),
  offeringId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function listJobs(deps: Pick<JobServiceDeps, "store">, params: JobListParams) {
  const { rows, total } = await deps.store.list(params);
  return {
    jobs: rows.map((job) => (params.role === "buyer" ? toBuyerJob(job) : toPublisherJob(job))),
    pagination: {
      page: params.page,
      limit: params.limit,
      total,
      totalPages: Math.ceil(total / params.limit),
    },
  };
}

async function findOrThrow(deps: Pick<JobServiceDeps, "store">, jobId: string, orgId: string): Promise<JobRecord> {
  const job = await deps.store.findForOrg(jobId, orgId);
  // The same answer for a job that does not exist and one that is not
  // yours, so ids cannot be probed.
  if (!job) throw new JobError("job_not_found", "Job not found");
  return job;
}

export async function getJob(deps: Pick<JobServiceDeps, "store">, jobId: string, orgId: string) {
  return toJobView(await findOrThrow(deps, jobId, orgId), orgId);
}

// ============================================
// Buyer actions
// ============================================

async function buyersJob(deps: Pick<JobServiceDeps, "store">, jobId: string, orgId: string): Promise<JobRecord> {
  const job = await findOrThrow(deps, jobId, orgId);
  if (job.buyerId !== orgId) {
    throw new JobError("not_the_buyer", "Only the buyer of a job can do this");
  }
  return job;
}

async function reread(deps: Pick<JobServiceDeps, "store">, jobId: string, orgId: string): Promise<BuyerJob> {
  return toBuyerJob(await findOrThrow(deps, jobId, orgId));
}

export const acceptBodySchema = z
  .object({ rating: z.number().int().min(1).max(5).optional(), review: z.string().trim().max(2000).optional() })
  .strict();

export async function acceptJob(
  deps: JobServiceDeps,
  args: { jobId: string; orgId: string; rating?: number; review?: string },
): Promise<{ job: BuyerJob }> {
  const job = await buyersJob(deps, args.jobId, args.orgId);
  const now = (deps.now ?? (() => new Date()))();
  const settle = () =>
    deps.store.inTransaction((tx) =>
      completeJob(tx, { jobId: job.id, buyerId: args.orgId, rating: args.rating, review: args.review, now }),
    );
  try {
    try {
      await settle();
    } catch (err) {
      if (!(err instanceof JobSettlementError)) throw err;
      // Rolled back, escrow still held. The profile is created at offering
      // time; if it is gone anyway, make it and settle again.
      await deps.ensurePublisherProfile(job.publisherId);
      await settle();
    }
  } catch (err) {
    if (err instanceof JobTransitionError) throw new JobError("job_state_conflict", err.message);
    if (err instanceof JobSettlementError) {
      throw new JobError(
        "settlement_unavailable",
        "The payment could not be released right now; the escrow is still held. Try again shortly.",
      );
    }
    throw err;
  }
  void deps.recalculateReputation(job.publisherId);
  await deps.notify("job.completed", job.id);
  return { job: await reread(deps, job.id, args.orgId) };
}

export const rejectBodySchema = z.object({ reason: z.string().trim().min(3).max(2000) }).strict();

export async function rejectJobAsBuyer(
  deps: JobServiceDeps,
  args: { jobId: string; orgId: string; reason: string },
): Promise<{ job: BuyerJob; refundedCents: number }> {
  const job = await buyersJob(deps, args.jobId, args.orgId);
  const now = (deps.now ?? (() => new Date()))();
  let refundedCents: bigint;
  try {
    ({ refundedCents } = await deps.store.inTransaction((tx) =>
      rejectJob(tx, { jobId: job.id, buyerId: args.orgId, reason: args.reason, now }),
    ));
  } catch (err) {
    if (!(err instanceof JobTransitionError)) throw err;
    const lapsed =
      job.status === "submitted" && job.reviewDeadlineAt !== null && job.reviewDeadlineAt.getTime() <= now.getTime();
    throw lapsed
      ? new JobError("review_window_closed", "The review window for this job has closed")
      : new JobError("job_state_conflict", err.message);
  }
  await deps.recordDispute(job.publisherId);
  void deps.recalculateReputation(job.publisherId);
  await deps.notify("job.rejected", job.id);
  return { job: await reread(deps, job.id, args.orgId), refundedCents: Number(refundedCents) };
}

export const cancelBodySchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();

export async function cancelJob(
  deps: JobServiceDeps,
  args: { jobId: string; orgId: string; reason?: string },
): Promise<{ job: BuyerJob; refundedCents: number }> {
  const job = await buyersJob(deps, args.jobId, args.orgId);
  const now = (deps.now ?? (() => new Date()))();
  let refundedCents: bigint;
  try {
    ({ refundedCents } = await deps.store.inTransaction((tx) =>
      endJobWithRefund(tx, {
        jobId: job.id,
        to: "cancelled",
        buyerId: args.orgId,
        reason: args.reason || "Cancelled by the buyer before it started",
        now,
      }),
    ));
  } catch (err) {
    if (!(err instanceof JobTransitionError)) throw err;
    throw job.status === "funded" || job.status === "running"
      ? new JobError("job_already_started", "This job has already started and can no longer be cancelled")
      : new JobError("job_state_conflict", err.message);
  }
  await deps.notify("job.cancelled", job.id);
  return { job: await reread(deps, job.id, args.orgId), refundedCents: Number(refundedCents) };
}

export const rateBodySchema = z
  .object({ rating: z.number().int().min(1).max(5), review: z.string().trim().max(2000).optional() })
  .strict();

export async function rateJobAsBuyer(
  deps: JobServiceDeps,
  args: { jobId: string; orgId: string; rating: number; review?: string },
): Promise<{ job: BuyerJob }> {
  const job = await buyersJob(deps, args.jobId, args.orgId);
  try {
    await deps.store.inTransaction((tx) =>
      rateJob(tx, {
        jobId: job.id,
        buyerId: args.orgId,
        rating: args.rating,
        review: args.review,
        now: (deps.now ?? (() => new Date()))(),
      }),
    );
  } catch (err) {
    if (err instanceof JobTransitionError) throw new JobError("job_state_conflict", err.message);
    throw err;
  }
  void deps.recalculateReputation(job.publisherId);
  return { job: await reread(deps, job.id, args.orgId) };
}
