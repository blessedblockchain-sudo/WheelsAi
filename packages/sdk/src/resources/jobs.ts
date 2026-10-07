import { seg, type Query, type WheelsAIClient } from "../client.js";
import type { Pagination } from "./marketplace.js";
import type { OfferingOutputFormat, OfferingProductKind } from "./offerings.js";

/**
 * `funded` (paid into escrow, waiting for a worker), `running`, `submitted` (the deliverable
 * passed its checks and waits for the buyer), `completed` (escrow released to the publisher),
 * and four refunded endings: `rejected` by the buyer, `failed` its checks or its run,
 * `expired` past the promised delivery time, `cancelled` by the buyer before it started.
 */
export type JobStatus =
  | "funded"
  | "running"
  | "submitted"
  | "completed"
  | "rejected"
  | "failed"
  | "expired"
  | "cancelled";

export type JobRole = "buyer" | "publisher";

/** Where the price is: `held` in escrow, `released` to the publisher, or `refunded` to the buyer. */
export type EscrowState = "held" | "released" | "refunded";

export interface JobDeliverable {
  format: OfferingOutputFormat;
  text: string;
  /** The parsed value when `format` is `json`. */
  value?: unknown;
}

interface JobBase {
  id: string;
  status: JobStatus;
  offering: { id: string; slug: string; title: string; productKind: OfferingProductKind };
  priceCents: number;
  escrow: { status: EscrowState; amountCents: number } | null;
  input: Record<string, unknown>;
  /** When delivery is due; past it the job expires and is refunded. */
  deadlineAt: string | null;
  /** When a submitted job completes by itself if the buyer does nothing. */
  reviewDeadlineAt: string | null;
  fundedAt: string | null;
  startedAt: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  rejectionReason: string | null;
  rating: number | null;
  review: string | null;
  createdAt: string;
}

/** A job as its buyer sees it. */
export interface BuyerJob extends JobBase {
  role: "buyer";
  /** null until the job is submitted, and for a job that failed, expired or was cancelled. */
  output: JobDeliverable | null;
  /** Which checks ran and whether each passed. The publisher's diagnostics are not included. */
  checks: Array<{ label: string; type: string; passed: boolean }>;
}

/** A job as the publisher whose product ran it sees it. */
export interface PublisherJob extends JobBase {
  role: "publisher";
  buyer: { orgId: string; name: string };
  output: JobDeliverable | null;
  checkResults: Array<{ label: string; type: string; passed: boolean; details: string }>;
  /** How many times a worker claimed the job. */
  attempts: number;
  /** The workflow run behind a workflow job, in your organization. */
  orchestrationExecutionId: string | null;
  platformFeeCents: number | null;
  /** Your share once the escrow is released, after the platform fee and any model cost. */
  creatorAmountCents: number | null;
  /** What the job used on the platform's model keys, taken from your share at settlement. */
  modelCostCents: number;
}

export type Job = BuyerJob | PublisherJob;

export interface ListJobsParams {
  /** `buyer` (default): jobs you hired. `publisher`: jobs hired from your offerings. */
  role?: JobRole;
  status?: JobStatus;
  offeringId?: string;
  page?: number;
  limit?: number;
}

export function jobsResource(client: WheelsAIClient) {
  return {
    /** An API key needs `jobs:read`. Hiring is `offerings.hire`. */
    list: (params?: ListJobsParams) =>
      client.get<{ jobs: Job[]; pagination: Pagination }>("/api/jobs", params as Query),

    /** What is waiting on your organization: deliverables to review, jobs in progress, jobs to deliver. */
    summary: () => client.get<{ awaitingReview: number; inProgress: number; toDeliver: number }>("/api/jobs/summary"),

    /** The job as your side sees it. 404 `job_not_found` for a job that is neither bought nor sold by you. */
    get: (jobId: string) => client.get<{ job: Job }>(`/api/jobs/${seg(jobId)}`),

    /**
     * Accepts a submitted deliverable and releases the escrow to the publisher; a rating may be
     * given with it. An API key needs `jobs:review` by name.
     */
    accept: (jobId: string, body: { rating?: number; review?: string } = {}) =>
      client.post<{ job: BuyerJob }>(`/api/jobs/${seg(jobId)}/accept`, body),

    /**
     * Rejects a submitted deliverable inside the review window: the full price is refunded and
     * the rejection counts as a dispute on the publisher. 409 `review_window_closed` after it.
     */
    reject: (jobId: string, reason: string) =>
      client.post<{ job: BuyerJob; refundedCents: number }>(`/api/jobs/${seg(jobId)}/reject`, { reason }),

    /** Takes a job back before a worker has started it, refunded. 409 `job_already_started` after that. */
    cancel: (jobId: string, reason?: string) =>
      client.post<{ job: BuyerJob; refundedCents: number }>(
        `/api/jobs/${seg(jobId)}/cancel`,
        reason === undefined ? {} : { reason },
      ),

    /** Rates a completed job, once, within 30 days of completion. */
    rate: (jobId: string, rating: number, review?: string) =>
      client.post<{ job: BuyerJob }>(
        `/api/jobs/${seg(jobId)}/rate`,
        review === undefined ? { rating } : { rating, review },
      ),
  };
}
