import { seg, type Query, type RequestOptions, type WheelsAIClient } from "../client.js";
import type { Pagination } from "./marketplace.js";
import type { BuyerJob } from "./jobs.js";

export type OfferingProductKind = "agent" | "workflow" | "model";
export type OfferingStatus = "draft" | "active" | "paused" | "archived";
export type OfferingOutputFormat = "text" | "json";

/** A check the deliverable must pass before the buyer sees it. Failing every attempt refunds the job. */
export type DeliverableCheck =
  | { type: "contains" | "not_contains"; value: string; caseSensitive?: boolean; label?: string }
  | { type: "exact"; value: string; label?: string }
  | { type: "regex"; pattern: string; flags?: string; label?: string }
  | { type: "json_schema"; schema: Record<string, unknown>; label?: string }
  | { type: "min_length" | "max_length"; value: number; label?: string };

/**
 * An offering as anyone can read it: a fixed task a publisher's agent, workflow or model runs
 * for a buyer. It never carries the publisher's private instructions or the product's ids.
 */
export interface Offering {
  id: string;
  /** The offering lives at `<web>/marketplace/offerings/<slug>`. */
  slug: string;
  title: string;
  description: string;
  productKind: OfferingProductKind;
  /** The fixed price of one job, held in escrow at hire. 50 to 100,000. */
  priceCents: number;
  /** How long the publisher has to deliver. Past it the job expires and is refunded. */
  slaSeconds: number;
  /**
   * Changes whenever anything a buyer agrees to changes: the title and description, the price,
   * the delivery time, the input schema, the checks, the output format or the publisher's
   * private instructions. `hire` sends it back so you pay for the offering you read.
   */
  termsVersion: string;
  /** How long the buyer has to accept or reject a deliverable; after it the job completes by itself. */
  reviewWindowHours: number;
  /**
   * JSON Schema (draft-07 or 2020-12) for `hire`'s `input`; null accepts any object. Its
   * `properties` come in the order the publisher saved them: the order of the form's questions.
   */
  inputSchema: Record<string, unknown> | null;
  sampleInputs: Array<Record<string, unknown>>;
  deliverableChecks: DeliverableCheck[];
  outputFormat: OfferingOutputFormat;
  product: { name: string };
  publisher: { name: string; slug: string | null; isVerified: boolean; reputationTier: string | null };
  /** The agent's marketplace listing, when it has one. */
  listing: { slug: string; title: string } | null;
  createdAt: string;
}

export interface OfferingTrackRecord {
  completed: number;
  rejected: number;
  failed: number;
  expired: number;
  cancelled: number;
  /** completed / (completed + rejected + failed + expired); null before the first. */
  successRate: number | null;
  avgRating: number | null;
  ratingCount: number;
  medianTurnaroundSeconds: number | null;
}

/** The publisher's own view of an offering. */
export interface OwnedOffering extends Offering {
  status: OfferingStatus;
  /** Private: sent to the product with every job, never shown to a buyer. */
  instructions: string | null;
  agentId: string | null;
  orchestrationId: string | null;
  deploymentId: string | null;
  listingId: string | null;
  allowedTools: string[];
  maxAttempts: number;
  maxConcurrentJobs: number;
  activeJobs: number;
  /** false when the product behind the offering was deleted. */
  productAvailable: boolean;
  publishedAt: string | null;
  updatedAt: string;
  stats: { jobs: Record<string, number> };
  /**
   * For an offering whose form was taken from its agent's own task form (`fromAgentForm`): true
   * while buyers see the form the agent has now, false after the agent's form was edited. Saving
   * with `fromAgentForm: true` again shows buyers the new form and changes `termsVersion`. Null
   * for an offering whose `inputSchema` was written by hand.
   */
  formInSync: boolean | null;
}

export interface OfferingContentInput {
  title: string;
  description: string;
  priceCents: number;
  /** 300 (5 minutes) to 604,800 (7 days). */
  slaSeconds: number;
  /** The form buyers fill in. Its questions keep the order of `properties` as you send it. */
  inputSchema?: Record<string, unknown> | null;
  /**
   * Take the form from the agent's own task form, in the agent's field order, in place of
   * `inputSchema`. Sending both is refused (400), and so is an agent that is not a task agent
   * (409 `not_a_task_agent`). The form is stored with the offering: editing the agent's form
   * later does not change what buyers see until you save with `fromAgentForm: true` again
   * (`formInSync` on your offering says when the two differ).
   */
  fromAgentForm?: boolean;
  /** Up to 5 example inputs; each must match `inputSchema`. */
  sampleInputs?: Array<Record<string, unknown>>;
  instructions?: string | null;
  deliverableChecks?: DeliverableCheck[];
  outputFormat?: OfferingOutputFormat;
  /**
   * Limits the tools an agent may use during a job. Refused for an agent that answers through its graph.
   *
   * `http_request` never runs in a job unless it is named here: a buyer writes the job's input,
   * and an agent that can call any address can be talked into sending your private instructions
   * to the buyer's server, where no deliverable check sees them. Name it only when the task
   * needs it and the instructions hold nothing you would not show a buyer.
   */
  allowedTools?: string[];
  /** How many times a deliverable that fails its checks is produced again: 1 to 3. */
  maxAttempts?: number;
  /** Jobs that may be open at once: 1 to 50. */
  maxConcurrentJobs?: number;
}

export type CreateOfferingInput = OfferingContentInput &
  (
    | { productKind: "agent"; agentId: string }
    | { productKind: "workflow"; orchestrationId: string }
    | { productKind: "model"; deploymentId: string }
  );

/** Everything but the product: an offering is not moved to another product. */
export type UpdateOfferingInput = Partial<OfferingContentInput>;

export interface SearchOfferingsParams {
  productKind?: OfferingProductKind;
  query?: string;
  /** Offerings on one agent, or on one marketplace listing. */
  agentId?: string;
  listingId?: string;
  /** A publisher's slug. */
  publisher?: string;
  sort?: "newest" | "price_low" | "price_high" | "rating";
  page?: number;
  limit?: number;
}

export interface OfferingTestRun {
  passed: boolean;
  output: { format: OfferingOutputFormat; text: string; value?: unknown } | null;
  checkResults: Array<{ label: string; type: string; passed: boolean; details: string }>;
  durationMs: number;
}

/** The terms a hire is held to. An offering read with `get` or `search` has all three. */
export interface ExpectedTerms {
  priceCents: number;
  slaSeconds?: number;
  termsVersion?: string;
}

export interface HireOptions extends RequestOptions {
  /**
   * Sent as `Idempotency-Key` (at most 100 characters). Repeating a hire with the same key
   * returns the first job and charges nothing more, so a hire that timed out can be retried.
   */
  idempotencyKey?: string;
  /**
   * The terms you decided on. Sent automatically when `hire` is given the offering itself;
   * set it when hiring by id (for example `{ priceCents: 500 }` as "at most what I planned").
   */
  expected?: ExpectedTerms;
}

/** What `hire` reads from an offering object: its id and the terms it had when you read it. */
export type OfferingToHire = Pick<Offering, "id" | "priceCents" | "slaSeconds" | "termsVersion">;

export function offeringsResource(client: WheelsAIClient) {
  return {
    /** Public: active offerings. */
    search: (params?: SearchOfferingsParams) =>
      client.get<{ offerings: Offering[]; pagination: Pagination }>("/api/offerings", params as Query),

    /** Public: one active offering with its track record. */
    get: (slug: string) =>
      client.get<{ offering: Offering & { trackRecord: OfferingTrackRecord } }>(`/api/offerings/${seg(slug)}`),

    /** Your organization's offerings in every state. An API key needs `offerings:write`. */
    listMine: (query?: { status?: OfferingStatus }) =>
      client.get<{ offerings: OwnedOffering[] }>("/api/offerings/mine", query as Query),

    getMine: (offeringId: string) =>
      client.get<{ offering: OwnedOffering }>(`/api/offerings/mine/${seg(offeringId)}`),

    /**
     * Creates a draft on one of your own products. A product installed from the marketplace, or
     * a workflow that uses one, is refused (409 `product_not_sellable`). `fromAgentForm: true`
     * takes the buyers' form from a task agent's own form; with `inputSchema` as well it is a
     * 400, and for an agent that is not a task agent 409 `not_a_task_agent`.
     */
    create: (input: CreateOfferingInput) => client.post<{ offering: OwnedOffering }>("/api/offerings", input),

    /**
     * Changes a draft, active or paused offering. `{ fromAgentForm: true }` takes the agent's
     * task form as it is now (the same two refusals as `create`).
     */
    update: (offeringId: string, updates: UpdateOfferingInput) =>
      client.patch<{ offering: OwnedOffering }>(`/api/offerings/${seg(offeringId)}`, updates),

    /** Makes a draft or paused offering hireable. 501 `jobs_not_configured` while paid jobs are temporarily unavailable. */
    activate: (offeringId: string) =>
      client.post<{ offering: OwnedOffering }>(`/api/offerings/${seg(offeringId)}/activate`),

    /** Stops new hires; jobs already hired still run. */
    pause: (offeringId: string) =>
      client.post<{ offering: OwnedOffering }>(`/api/offerings/${seg(offeringId)}/pause`),

    archive: (offeringId: string) =>
      client.post<{ offering: OwnedOffering }>(`/api/offerings/${seg(offeringId)}/archive`),

    /** Checks an input schema, samples and deliverable checks exactly as a save would; saves nothing. */
    validate: (content: Pick<OfferingContentInput, "inputSchema" | "sampleInputs" | "deliverableChecks">) =>
      client.post<{ ok: true }>("/api/offerings/validate", content),

    /**
     * Runs the offering once as a paid job would run it, with no job and no money. The usage is
     * your own. The request waits for the run, so pass `{ timeoutMs }` above the default 30 s.
     */
    testRun: (offeringId: string, input: Record<string, unknown> = {}, options?: RequestOptions) =>
      client.post<OfferingTestRun>(`/api/offerings/${seg(offeringId)}/test-run`, { input }, options),

    /**
     * Hires the offering: the price is taken from your credits into escrow and the job is queued
     * (`201`, status `funded`). Poll `jobs.get` until it is `submitted`, then `jobs.accept` or
     * `jobs.reject`.
     *
     * Pass the offering you read (from `get` or `search`), not just its id: its price, delivery
     * time and `termsVersion` are sent as `expected`, and if the publisher changed any of them
     * since, the hire is refused with 409 `offering_terms_changed` and nothing is charged
     * (`err.data.current` has the terms as they are now, `err.data.changed` what moved). Hiring
     * by id with no `options.expected` is allowed for an API key only, and hires at whatever the
     * terms are when the request arrives, bounded by the key's per-job cap; a session gets 400
     * `expected_terms_required`.
     *
     * An API key must have been granted `jobs:hire` by name and stays inside its spend caps: a
     * key with no scopes or `*` gets 403 `missing_scope`, a job above the key's caps 403
     * `api_key_job_price_cap_exceeded` or `api_key_daily_cap_exceeded`. Not enough credits is
     * 402 `insufficient_credits`; an input that does not match the schema is 422
     * `input_invalid` with `errors: [{ path, message }]`. Nothing is charged by a refused hire.
     */
    hire: (offering: string | OfferingToHire, input: Record<string, unknown> = {}, options?: HireOptions) => {
      const expected: ExpectedTerms | undefined =
        options?.expected ??
        (typeof offering === "string"
          ? undefined
          : { priceCents: offering.priceCents, slaSeconds: offering.slaSeconds, termsVersion: offering.termsVersion });
      return client.post<{ job: BuyerJob }>(
        `/api/offerings/${seg(typeof offering === "string" ? offering : offering.id)}/hire`,
        { input, ...(expected && { expected }) },
        {
          timeoutMs: options?.timeoutMs,
          headers: {
            ...options?.headers,
            ...(options?.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
          },
        },
      );
    },
  };
}
