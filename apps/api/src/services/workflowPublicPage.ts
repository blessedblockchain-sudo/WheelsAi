/**
 * What anyone may read about a workflow on sale, by the slug of its listing:
 *
 *   GET /api/w/:slug       workflowPublicReadOf: what its page draws before
 *                          anyone pays (the listing's own words, the price
 *                          per run, the plans on offer, the input form)
 *   GET /api/w/:slug/api   workflowApiPageOf: what its API page draws for
 *                          people who call it from code, shaped as an agent's
 *                          (services/agentApiPage.ts) with `kind: "workflow"`
 *
 * Both are built field by field from three things: the listing, its plans
 * on offer and the workflow's input form. The buyer's name for the workflow
 * is the listing's slug, and the page is headed by the listing's title and
 * one line. Never the workflow's own name or slug, its id, a step, an agent
 * or a model inside it, tokens, the creator's organization, or how many
 * people use it. The only ids are the listing's (the gate starts, starts a
 * plan and moves by it) and each plan's (a plan is started by its id).
 *
 * Only a listing that sells a workflow, is published, sells use and has a
 * price per run has these reads. Anything else is not found, the same as a
 * slug that no listing holds.
 *
 * Pure: the reads are dependencies (routes/paidWorkflowBindings.ts binds the
 * real ones), and nothing here reads the environment or the database. The
 * model id on /v1 is handed in by the route, which owns its prefix
 * (routes/paidWorkflowCompletions.ts): a route module loads the auth
 * middleware, and with it the environment and the database.
 */

import { AGENT_API_REFUSALS, baseUrlOf, type AgentApiEndpoint, type AgentApiRefusal } from "./agentApiPage.js";
import { paidUseOpenAiError } from "./openaiCompat.js";
import { PAID_USE_LIMITS, PAID_USE_MESSAGES, plansOnOffer, type PaidUseDeps, type PaidUseErrorCode } from "./paidUse.js";
import type { PlanOffer } from "./planOffers.js";
import { BALANCE_CENTS_HEADER, CHARGED_CENTS_HEADER, PLAN_USAGE_HEADER_NAMES } from "./usageHeaders.js";
import { MAX_WORKFLOW_INPUT_BYTES, MAX_WORKFLOW_PROMPT_CHARS } from "./workflowChat.js";
import {
  listingProductKind,
  PAID_WORKFLOW_MAX_ACTIVE_RUNS,
  PAID_WORKFLOW_MAX_RUN_MS,
  WORKFLOW_LISTING_SLUG,
  WORKFLOW_START_MESSAGES,
} from "./workflowListing.js";

/** The longest a paid run may take, in minutes, as the pages say it. */
export const PAID_WORKFLOW_MAX_RUN_MINUTES = PAID_WORKFLOW_MAX_RUN_MS / 60_000;

// ============================================
// The reads behind both answers
// ============================================

/** A listing as these reads take it. The publisher is read to find the workflow, and never sent. */
export interface WorkflowPublicListing {
  id: string;
  slug: string;
  title: string;
  shortDescription: string;
  publisherId: string;
  status: string;
  sells: string;
  pricingModel: string;
  pricePerRequestCents: bigint | null;
  agentId: string | null;
  orchestrationId: string | null;
}

/** The columns of that read, and no others. */
export const WORKFLOW_PUBLIC_LISTING_COLUMNS = {
  id: true,
  slug: true,
  title: true,
  shortDescription: true,
  publisherId: true,
  status: true,
  sells: true,
  pricingModel: true,
  pricePerRequestCents: true,
  agentId: true,
  orchestrationId: true,
} as const;

export interface WorkflowPublicPageDeps {
  /** The listing that holds this slug, in any state and whatever it sells; null when none does. */
  loadListingBySlug(slug: string): Promise<WorkflowPublicListing | null>;
  /** The listing's paid plans on offer, in the order they are shown. */
  loadPlans?: PaidUseDeps["loadPlans"];
  /**
   * The workflow by its id AND the organization it must be in (the listing's
   * publisher), for its input form; null when it is not there.
   */
  loadWorkflowForm(ref: { workflowId: string; orgId: string }): Promise<{ inputSchema: unknown } | null>;
  /** The address this API is reached at from outside, for the API page. */
  publicApiUrl?: string | null;
  logger?: PaidUseDeps["logger"];
}

/** What both answers are built from. */
export interface WorkflowPublicSource {
  listing: { id: string; slug: string; title: string; shortDescription: string; pricePerRequestCents: bigint };
  plans: PlanOffer[];
  inputSchema: unknown;
}

/**
 * The listing by its slug, its plans and its workflow's form, or null when
 * the slug names no workflow that is on sale for use at a price per run.
 * A read that throws is not caught: the route answers it as an error, never
 * as a page with something missing.
 */
export async function readWorkflowPublicSource(
  rawSlug: string,
  deps: WorkflowPublicPageDeps,
): Promise<WorkflowPublicSource | null> {
  // As a paid run reads it: in lower case, and a slug no listing can have is
  // not looked up.
  const slug = typeof rawSlug === "string" ? rawSlug.toLowerCase() : "";
  if (!WORKFLOW_LISTING_SLUG.test(slug)) return null;

  const listing = await deps.loadListingBySlug(slug);
  // An agent's listing has a slug too: it is not a workflow, and is not found here.
  if (!listing || listing.orchestrationId === null || listingProductKind(listing) !== "workflow") return null;
  // A draft, a listing that was stopped, and a row that does not sell use per
  // run (which only a corrupt row can be) have no page.
  if (listing.status !== "published" || listing.sells !== "use" || listing.pricingModel !== "per_request") return null;
  if (listing.pricePerRequestCents === null) return null;

  // Never by the workflow's id alone: a workflow that is no longer in the
  // publisher's organization has no form to show.
  const workflow = await deps.loadWorkflowForm({ workflowId: listing.orchestrationId, orgId: listing.publisherId });
  if (!workflow) return null;

  return {
    listing: {
      id: listing.id,
      slug: listing.slug,
      title: listing.title,
      shortDescription: listing.shortDescription,
      pricePerRequestCents: listing.pricePerRequestCents,
    },
    // A read of the plans that fails tells none; the page still loads.
    plans: (await plansOnOffer({ loadPlans: deps.loadPlans, logger: deps.logger }, listing)) ?? [],
    inputSchema: workflow.inputSchema,
  };
}

// ============================================
// The input form
// ============================================

/** The one field of a workflow whose form has none: its prompt, as a run reads it. */
export const PROMPT_ONLY_FORM = {
  type: "object",
  properties: { prompt: { type: "string", minLength: 1, maxLength: MAX_WORKFLOW_PROMPT_CHARS } },
  required: ["prompt"],
} as const;

/**
 * What a schema may say on the page: the keywords a run checks
 * (services/workflowSchemaCheck.ts) and the words that label a field. An
 * `$id` or a `$schema` is the creator's and is left out.
 */
const FORM_KEYS = new Set([
  "type",
  "enum",
  "const",
  "required",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "title",
  "description",
  "default",
  "examples",
]);
const MAX_FORM_DEPTH = 32;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One schema, key by key. What is not a schema becomes one that says nothing. */
function formPartOf(schema: unknown, depth: number): Record<string, unknown> {
  if (!isPlainObject(schema) || depth > MAX_FORM_DEPTH) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (FORM_KEYS.has(key)) {
      // Copied as data: a value here is a list, a number or a text.
      out[key] = JSON.parse(JSON.stringify(value ?? null)) as unknown;
    } else if (key === "properties" && isPlainObject(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, formPartOf(child, depth + 1)]),
      );
    } else if (key === "items") {
      out.items = formPartOf(value, depth + 1);
    } else if (key === "additionalProperties") {
      out.additionalProperties = typeof value === "boolean" ? value : formPartOf(value, depth + 1);
    }
  }
  return out;
}

/**
 * The form a buyer fills in. A workflow whose form has no fields takes its
 * prompt: the page draws one text box, the key `prompt`.
 */
export function publicFormOf(inputSchema: unknown): Record<string, unknown> {
  const hasFields =
    isPlainObject(inputSchema) &&
    isPlainObject(inputSchema.properties) &&
    Object.keys(inputSchema.properties).length > 0;
  if (!hasFields) return JSON.parse(JSON.stringify(PROMPT_ONLY_FORM)) as Record<string, unknown>;
  return formPartOf(inputSchema, 0);
}

// ============================================
// GET /api/w/:slug
// ============================================

export interface WorkflowPublicRead {
  kind: "workflow";
  /** The listing: the gate starts, starts a plan and moves by it. */
  listingId: string;
  /** The listing's slug: the workflow's address, /w/<slug>, and its model on /v1, w/<slug>. */
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
  /** The owner of a workflow always keeps a copy of what is sent and what it answers. */
  keepsCopy: true;
  /** The longest a run may take. */
  maxRunMinutes: number;
  input: {
    /** The form, as a JSON Schema whose properties are the fields in order. */
    schema: Record<string, unknown>;
    /** The longest input a run takes: the whole input as JSON, in bytes. */
    maxInputBytes: number;
    /** The longest `prompt` a run takes, in characters. */
    maxPromptChars: number;
  };
}

/** The plans, field by field. */
const plansOf = (plans: PlanOffer[]): PlanOffer[] =>
  plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    priceCents: plan.priceCents,
    includedUses: plan.includedUses,
    extraUsePriceCents: plan.extraUsePriceCents,
  }));

export function workflowPublicReadOf(source: WorkflowPublicSource): WorkflowPublicRead {
  const { listing } = source;
  return {
    kind: "workflow",
    listingId: listing.id,
    slug: listing.slug,
    title: listing.title,
    description: listing.shortDescription,
    pricingModel: "per_request",
    unit: "run",
    priceCents: Number(listing.pricePerRequestCents),
    plans: plansOf(source.plans),
    trial: null,
    keepsCopy: true,
    maxRunMinutes: PAID_WORKFLOW_MAX_RUN_MINUTES,
    input: {
      schema: publicFormOf(source.inputSchema),
      maxInputBytes: MAX_WORKFLOW_INPUT_BYTES,
      maxPromptChars: MAX_WORKFLOW_PROMPT_CHARS,
    },
  };
}

// ============================================
// GET /api/w/:slug/api
// ============================================

/**
 * A refusal a caller can meet: what POST /api/w/:slug/run answers (its
 * `error` and its status), what model `w/<slug>` on /v1 answers for the same
 * refusal (its `error.code` and its status; `error.reason` carries the code
 * above when the two differ), and what it means in plain words.
 */
export interface WorkflowApiRefusal extends AgentApiRefusal {
  openai: { code: string; status: number };
}

export interface WorkflowApiPage {
  kind: "workflow";
  /** The listing's title: what the page is headed by. */
  name: string;
  listingId: string;
  listingSlug: string;
  /** As an agent's: no slash at its end; null when this server was given no public address. */
  baseUrl: string | null;
  /** The model id on OpenAI's chat completions. */
  model: string;
  /** The run address first, then OpenAI's chat completions, then the free read of where the caller stands. */
  endpoints: AgentApiEndpoint[];
  pricingModel: "per_request";
  unit: "run";
  priceCents: number;
  plans: PlanOffer[];
  trial: null;
  /**
   * A buyer's own limits, as an agent's page tells them, and how many paid
   * runs of this workflow may go at once, across everyone who uses it.
   */
  limits: { perMinute: number; perDayWithoutPlan: number; maxActiveRuns: number };
  /** The longest a run may take, and the longest input it takes. */
  maxRunMinutes: number;
  input: { maxInputBytes: number; maxPromptChars: number };
  usageHeaders: { always: string[]; onPlan: string[] };
  refusals: WorkflowApiRefusal[];
}

/** The refusals an agent's API page tells in the same words: none of them names what is used. */
function sharedRefusal(code: PaidUseErrorCode): AgentApiRefusal {
  const found = AGENT_API_REFUSALS.find((refusal) => refusal.code === code);
  if (!found) throw new Error(`the agent's API page tells no refusal ${code}`);
  return found;
}

const RUN_BACK = "What was charged was refunded, or the use was given back to your plan.";
/** The same, said of a refusal that only sometimes comes after something was taken. */
const RUN_BACK_IF_TAKEN = "If a charge or a use of your plan was taken, it was given back.";

/**
 * What a caller of a workflow on sale can meet, in the order a run meets
 * them. Each status is what POST /api/w/:slug/run answers
 * (services/paidWorkflow.ts); what /v1 answers is read from the code that
 * answers it, below.
 */
const RUN_REFUSALS: AgentApiRefusal[] = [
  {
    code: "rate_limited",
    status: 429,
    message:
      "More requests were sent than this workflow allows for now. Nothing was charged. The retry-after header says how many seconds to wait.",
  },
  { code: "own_workflow", status: 409, message: WORKFLOW_START_MESSAGES.own },
  {
    code: "workflow_unavailable",
    status: 503,
    // Also what a run stopped by a restart of the service answers, after its
    // charge was refunded: so the page never says only "Nothing was charged".
    message: `This workflow cannot be run right now. Try again later. ${RUN_BACK_IF_TAKEN}`,
  },
  {
    code: "use_not_started",
    status: 403,
    message:
      "You have not started using this workflow. Start on its page, or ask an owner or admin of your organization to start.",
  },
  {
    code: "pricing_changed",
    status: 409,
    message: "The owner changed how this workflow is sold. Nothing is charged until you accept the new terms.",
  },
  sharedRefusal("plan_ended"),
  sharedRefusal("plan_used_up"),
  {
    code: "insufficient_credits",
    status: 402,
    message: "You do not have enough credits for this run. Nothing was charged. Add credits to continue.",
  },
  {
    code: "api_key_spend_caps_missing",
    status: 403,
    message: "This API key has no spend caps, so it cannot pay for a run. Nothing was charged.",
  },
  sharedRefusal("api_key_use_price_cap_exceeded"),
  sharedRefusal("api_key_daily_cap_exceeded"),
  {
    code: "input_invalid",
    status: 400,
    // Only the run address sends the form's list of what is wrong: /v1 answers
    // this refusal with its sentence alone.
    message:
      "The input does not fit this workflow's form. Nothing was charged. On the run address the answer lists what to change.",
  },
  {
    code: "input_too_large",
    status: 413,
    message: "The input is longer than a run takes. Nothing was charged.",
  },
  {
    code: "workflow_busy",
    status: 429,
    message: `This workflow is running as many times as it can right now: ${PAID_WORKFLOW_MAX_ACTIVE_RUNS} runs at once, shared by everyone who uses it. Try again in a minute. ${RUN_BACK_IF_TAKEN} Then the OpenAI address also asks your client not to send it again by itself.`,
  },
  { code: "run_failed", status: 502, message: `The workflow could not finish this run. ${RUN_BACK}` },
  {
    code: "run_timed_out",
    status: 504,
    message: `The workflow took too long and was stopped. A run can take up to ${PAID_WORKFLOW_MAX_RUN_MINUTES} minutes. ${RUN_BACK}`,
  },
  { code: "answer_withheld", status: 502, message: `${PAID_USE_MESSAGES.withheld(null)} ${RUN_BACK}` },
];

/** The same refusal on /v1, as the code that answers it there answers it. */
function openaiOf(refusal: AgentApiRefusal): WorkflowApiRefusal["openai"] {
  const answer = paidUseOpenAiError({ code: refusal.code, message: refusal.message });
  return { code: answer.body.error.code, status: answer.status };
}

/** Every refusal the API page of a workflow tells, for a test that holds them to the code. */
export const WORKFLOW_API_REFUSALS: readonly WorkflowApiRefusal[] = RUN_REFUSALS.map((refusal) => ({
  ...refusal,
  openai: openaiOf(refusal),
}));

/**
 * `model` is the workflow's model id on /v1, `w/<listing slug>`: the route
 * names it with paidWorkflowOpenAiModel, so this file loads no route.
 */
export function workflowApiPageOf(
  source: WorkflowPublicSource,
  options: { model: string; publicApiUrl?: string | null },
): WorkflowApiPage {
  const { listing } = source;
  const at = `/api/w/${encodeURIComponent(listing.slug)}`;
  return {
    kind: "workflow",
    name: listing.title,
    listingId: listing.id,
    listingSlug: listing.slug,
    baseUrl: baseUrlOf(options.publicApiUrl),
    model: options.model,
    endpoints: [
      { use: "run", method: "POST", path: `${at}/run` },
      { use: "openai", method: "POST", path: "/v1/chat/completions" },
      { use: "access", method: "GET", path: `${at}/access` },
    ],
    pricingModel: "per_request",
    unit: "run",
    priceCents: Number(listing.pricePerRequestCents),
    plans: plansOf(source.plans),
    trial: null,
    limits: {
      perMinute: PAID_USE_LIMITS.perBuyerPerMinute,
      perDayWithoutPlan: PAID_USE_LIMITS.perBuyerPerDay,
      maxActiveRuns: PAID_WORKFLOW_MAX_ACTIVE_RUNS,
    },
    maxRunMinutes: PAID_WORKFLOW_MAX_RUN_MINUTES,
    input: { maxInputBytes: MAX_WORKFLOW_INPUT_BYTES, maxPromptChars: MAX_WORKFLOW_PROMPT_CHARS },
    usageHeaders: { always: [CHARGED_CENTS_HEADER, BALANCE_CENTS_HEADER], onPlan: [...PLAN_USAGE_HEADER_NAMES] },
    refusals: WORKFLOW_API_REFUSALS.map((refusal) => ({ ...refusal, openai: { ...refusal.openai } })),
  };
}
