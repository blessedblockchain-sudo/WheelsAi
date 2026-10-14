import { seg, type RequestOptions, type WheelsAIClient } from "../client.js";
import type { TaskInputIssue } from "./agents.js";
import type { PlanOffer } from "./marketplace.js";
import type { UseAccessKind, UseAccessState, UseBilling, UseTerms } from "./use.js";

/**
 * A workflow another organization sells, that you pay to run: `/api/w/{slug}/...`, where `slug` is the slug
 * of its listing (never the workflow's own). It runs in the seller's organization and you never see its
 * steps, its agents or its models. Start with `marketplace.startUsing` (a price per run) or
 * `marketplace.startPlan` (a number of runs for 30 days) on the listing's id, `listingId` of `page`, then
 * call `run` here. A workflow has no free trial and no copies.
 *
 * The same workflow also answers `inference.chat` with `model: "w/<slug>"`: pass `{ timeoutMs: 11 * 60_000 }`
 * to it, because a run can take up to 10 minutes and a call that gives up sooner cancels it.
 * `inference.listModels` lists it under that name, with `wheelsai.kind` `paid_workflow`, while your
 * organization has started it and pays for it, on a plan that is running or at the price per run it agreed
 * to. It stays listed while it cannot run at the moment; a run then answers with its refusal.
 *
 * Limits for one organization and one workflow are an agent's: 10 runs a minute, 200 a day with no plan; on
 * a plan, the plan's count. A workflow also runs at most 3 paid runs at once, shared by everyone who uses
 * it (`workflow_busy`).
 */

/**
 * A run can take up to 10 minutes (`paidUse.paidWorkflowMaxRunMs` of the capabilities), and nothing is sent
 * while it goes, so `run` waits 11 minutes unless `options.timeoutMs` says otherwise. A client that gives up
 * sooner cancels the run, and what was charged is given back.
 */
const PAID_RUN_TIMEOUT_MS = 11 * 60_000;

/** `GET /api/w/{slug}`: what a workflow's page shows before anyone pays. Open to anyone. */
export interface WorkflowPage {
  kind: "workflow";
  /** The listing: start, start a plan or move with it. */
  listingId: string;
  /** The listing's slug: the page is `/w/<slug>` and the model `w/<slug>`. */
  slug: string;
  /** The listing's title and its one line. */
  title: string;
  description: string;
  pricingModel: "per_request";
  /** What `priceCents` buys: one run. */
  unit: "run";
  priceCents: number;
  /** The plans on offer, in the order they are shown. Empty when there are none. */
  plans: PlanOffer[];
  /** A workflow's listing offers no free trial. */
  trial: null;
  /** The owner of a workflow always gets a copy of what is sent and what it answers. */
  keepsCopy: true;
  /** The longest a run may take, in minutes. */
  maxRunMinutes: number;
  input: {
    /**
     * The form, as a JSON Schema whose properties are its fields. A workflow whose form has no fields takes
     * one text field, `prompt`.
     */
    schema: Record<string, unknown>;
    /** The most a run takes, as the input's JSON, in bytes. */
    maxInputBytes: number;
    /** The longest `prompt`, in characters. */
    maxPromptChars: number;
  };
}

/** One address of a workflow's API page. */
export interface WorkflowApiEndpoint {
  /** `run`: the run address. `openai`: chat completions with the model id. `access`: where you stand, a free read. */
  use: "run" | "openai" | "access";
  method: "GET" | "POST";
  path: string;
}

/**
 * A refusal the API page explains: what the run address answers, and what `/v1` answers for it. It is the
 * list the page explains, not every refusal there is (see `WorkflowRunRefusal`).
 */
export interface WorkflowApiRefusal {
  code: string;
  status: number;
  message: string;
  openai: { code: string; status: number };
}

/** `GET /api/w/{slug}/api`: what a workflow's API page draws. Open to anyone. */
export interface WorkflowApiPage {
  kind: "workflow";
  /** The listing's title. */
  name: string;
  listingId: string;
  listingSlug: string;
  /** Where to send requests, with no slash at its end; null when the server was given no public address. */
  baseUrl: string | null;
  /** The model id on `/v1/chat/completions`: `w/<slug>`. */
  model: string;
  endpoints: WorkflowApiEndpoint[];
  pricingModel: "per_request";
  unit: "run";
  priceCents: number;
  plans: PlanOffer[];
  trial: null;
  /** Your limits, and how many paid runs of this workflow may go at once, across everyone who uses it. */
  limits: { perMinute: number; perDayWithoutPlan: number; maxActiveRuns: number };
  maxRunMinutes: number;
  input: { maxInputBytes: number; maxPromptChars: number };
  /** The usage headers of a paid answer: always, and on a plan. */
  usageHeaders: { always: string[]; onPlan: string[] };
  refusals: WorkflowApiRefusal[];
}

/** Where you stand with a workflow: an agent's kinds, and `own_workflow` for one your organization sells. */
export type WorkflowAccessKind = Exclude<UseAccessKind, "own_agent"> | "own_workflow";

/**
 * `GET /api/w/{slug}/access`: the answer of `use.access` for a workflow. A workflow has no free trial and no
 * pause, so those fields are always the same. Whether it can run right now is told by a run or a start.
 */
export interface WorkflowAccessState
  extends Omit<
    UseAccessState,
    "access" | "terms" | "trial" | "trialAvailable" | "trialNeedsCredits" | "trialEnded" | "startBlocked" | "paused"
  > {
  access: WorkflowAccessKind;
  /** What the listing asks now, per run; null when use of it is not on sale. */
  terms: (UseTerms & { unit: "run" }) | null;
  trial: null;
  trialAvailable: false;
  trialNeedsCredits: false;
  trialEnded: false;
  startBlocked: null;
  paused: false;
}

/** What one run answered: its text, and what it cost. Nothing of the run itself. */
export interface WorkflowRunResult {
  output: { format: "text"; text: string };
  /** An agent's billing: `plan` carries the count after this run when you are on one. */
  billing: UseBilling;
}

/**
 * The body of a refused run, which is `error.data` of the thrown `WheelsAIError`, in the shape of
 * `UseRefusal`. Show `message` as it comes. Where a charge was taken before the refusal, `refundedCents`
 * says what was given back.
 *
 * `error` is one of: `invalid_request` (400: the body is not `{ input }` alone), `input_invalid` (400, with
 * `details`), `missing_scope`, `use_not_started`, `api_key_use_price_cap_exceeded`,
 * `api_key_daily_cap_exceeded`, `api_key_spend_caps_missing`, `not_a_member` (403),
 * `insufficient_credits`, `subscription_lapsed`, `plan_ended` (402), `workflow_not_found` (404),
 * `own_workflow`, `pricing_changed`, `not_offered`, `not_for_sale` (409), `input_too_large` (413),
 * `rate_limited`, `plan_used_up`, `too_many_refunds`, `workflow_busy` (429), `client_closed_request`
 * (499), `run_failed`, `answer_withheld` (502), `workflow_unavailable`, `rate_limiter_unavailable` (503)
 * and `run_timed_out` (504).
 */
export interface WorkflowRunRefusal {
  error: string;
  message: string;
  retryAfterSeconds?: number;
  /** `rate_limited`: your own limit. */
  scope?: "org";
  /** `input_invalid`: what to change. */
  details?: TaskInputIssue[];
  access?: WorkflowAccessKind;
  /** `use_not_started`, `pricing_changed` and `plan_ended`: what the listing asks now. */
  terms?: UseTerms & { unit: "run" };
  /** `plan_used_up` and `plan_ended`: the plans on offer now. */
  plans?: PlanOffer[];
  /** `plan_used_up`: when the plan's count starts again (an ISO time). Left out when the plan will not renew. */
  resetsAt?: string;
  /** `insufficient_credits`: the price of a run and your credits. */
  priceCents?: number;
  balanceCents?: number;
  /** What was charged for this run and given back. */
  refundedCents?: number;
}

/** `use.workflow`: the reads and the run of a workflow you pay for. */
export function useWorkflowMethods(client: WheelsAIClient) {
  return {
    /** `GET /api/w/{slug}`: its page, before anyone pays. Open to anyone. 404 `workflow_not_found`. */
    page: (slug: string) => client.get<WorkflowPage>(`/api/w/${seg(slug)}`),

    /** `GET /api/w/{slug}/api`: what its API page draws. Open to anyone. 404 `workflow_not_found`. */
    apiPage: (slug: string) => client.get<WorkflowApiPage>(`/api/w/${seg(slug)}/api`),

    /** `GET /api/w/{slug}/access`: where you stand with it and what it asks. A free read. 404 `workflow_not_found`. */
    access: (slug: string) => client.get<WorkflowAccessState>(`/api/w/${seg(slug)}/access`),

    /**
     * `POST /api/w/{slug}/run`: one run, from the answers to its form, by each field's name (`{ prompt }` for a
     * form with no fields). Only `input` is sent: the route takes nothing else. It is charged when the run
     * starts and refunded, or the use of a plan given back, when no answer is delivered. The answer comes
     * whole once the run has ended. Needs an API key granted `agents:use` with both spend caps, or a session.
     */
    run: (slug: string, body: { input: Record<string, unknown> }, options?: RequestOptions) =>
      client.post<WorkflowRunResult>(
        `/api/w/${seg(slug)}/run`,
        { input: body.input },
        {
          ...options,
          // Named last: options without a timeout (headers only, or `timeoutMs: undefined`) must not fall
          // back to the client's shorter one, which would cut, and so cancel, a run that is still going.
          timeoutMs: options?.timeoutMs ?? PAID_RUN_TIMEOUT_MS,
        },
      ),
  };
}
