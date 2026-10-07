/**
 * Offerings: a fixed task a publisher sells (Offerings and Jobs).
 *
 * An offering names one product of the publisher's organization (an agent,
 * a workflow or a model deployment), what the buyer must send (a JSON
 * Schema), what it costs, how long delivery may take, the publisher's
 * private instructions for the task, and the checks a deliverable must pass
 * before the buyer sees it.
 *
 * What is refused here, so it can never be hired:
 *   - a product that is not in the caller's organization (404, the same
 *     answer as one that does not exist);
 *   - a marketplace copy of someone else's agent, or a workflow that uses
 *     one: that would resell another publisher's work;
 *   - a disabled or empty workflow, a model deployment that is gone;
 *   - an input schema, sample or check that does not compile. A check that
 *     cannot compile would fail every job the offering ever ran.
 *
 * allowedTools does two things. It narrows the agent's tools for a job
 * (empty = all of them), and it is the only way an outbound tool
 * (http_request) runs in one: the `hired` tool mode refuses a tool that
 * sends data to an address the model chooses unless the publisher named it
 * here, because a buyer's input could have it post these instructions to
 * the buyer's own server (services/skills/registry.ts).
 *
 * Two shapes leave this module. PublicOffering is what anyone may read and
 * is built field by field: it has no way to carry the instructions, the
 * product's ids, its system prompt, tools or env. (Its `termsVersion` is a
 * digest that changes when the instructions do; it carries none of them.) PublisherOffering is the
 * owner's view.
 *
 * An active offering can be edited in place, so what a buyer read can be
 * out of date by the time they confirm. offeringTerms is what a hire is
 * held to (services/jobs.ts): the price, the delivery time and one version
 * of everything else they agreed to.
 *
 * Status is moved by compare-and-set: draft|paused -> active, active ->
 * paused, anything -> archived. Activating re-checks that the product can
 * still be sold and makes sure the publisher has a payout profile, because
 * a settle with nowhere to accrue leaves the escrow held.
 *
 * Pure over the injected store.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import { MAX_CHECKS, validateChecks, type Check, type CheckResult } from "./assertions.js";
import {
  JOB_MAX_PRICE_CENTS,
  JOB_MAX_SLA_SECONDS,
  JOB_MIN_PRICE_CENTS,
  JOB_MIN_SLA_SECONDS,
  JOB_REVIEW_WINDOW_MS,
} from "./jobEscrow.js";
import type { JobForRun } from "./jobRunner.js";
import { compileUserSchema, JsonSchemaError, type SchemaIssue } from "./jsonSchema.js";

export type ProductKind = "agent" | "workflow" | "model";
export type OfferingStatus = "draft" | "active" | "paused" | "archived";
export const OFFERING_STATUSES: readonly OfferingStatus[] = ["draft", "active", "paused", "archived"];

export const MAX_SAMPLE_INPUTS = 5;
export const MAX_INSTRUCTIONS_CHARS = 20_000;
export const MAX_ALLOWED_TOOLS = 50;

// ============================================
// Errors
// ============================================

export type OfferingErrorCode =
  | "invalid_request"
  | "product_not_found"
  | "product_not_sellable"
  | "invalid_input_schema"
  | "invalid_sample_input"
  | "invalid_deliverable_check"
  | "offering_not_found"
  | "offering_state_conflict"
  | "jobs_not_configured"
  | "input_invalid"
  | "validation_too_expensive"
  | "free_tier_limited"
  | "test_run_failed";

const STATUS_OF: Record<OfferingErrorCode, number> = {
  invalid_request: 400,
  product_not_found: 404,
  product_not_sellable: 409,
  invalid_input_schema: 422,
  invalid_sample_input: 422,
  invalid_deliverable_check: 422,
  offering_not_found: 404,
  offering_state_conflict: 409,
  jobs_not_configured: 501,
  input_invalid: 422,
  validation_too_expensive: 422,
  free_tier_limited: 429,
  test_run_failed: 502,
};

export class OfferingError extends Error {
  readonly status: number;
  constructor(
    readonly code: OfferingErrorCode,
    message: string,
    readonly details?: SchemaIssue[],
  ) {
    super(message);
    this.name = "OfferingError";
    this.status = STATUS_OF[code];
  }
}

export const JOBS_NOT_CONFIGURED_MESSAGE =
  "Paid jobs are switched off on this server (JOB_RUNNER_CONCURRENCY is 0), so nothing would run them.";

// ============================================
// Request shapes
// ============================================

const jsonObject = z.record(z.unknown());

const contentFields = {
  title: z.string().trim().min(3).max(100),
  description: z.string().trim().min(10).max(5000),
  priceCents: z.number().int().min(Number(JOB_MIN_PRICE_CENTS)).max(Number(JOB_MAX_PRICE_CENTS)),
  slaSeconds: z.number().int().min(JOB_MIN_SLA_SECONDS).max(JOB_MAX_SLA_SECONDS),
  inputSchema: jsonObject.nullable().optional(),
  sampleInputs: z.array(jsonObject).max(MAX_SAMPLE_INPUTS).optional(),
  instructions: z.string().max(MAX_INSTRUCTIONS_CHARS).nullable().optional(),
  deliverableChecks: z.array(z.unknown()).max(MAX_CHECKS).optional(),
  outputFormat: z.enum(["text", "json"]).optional(),
  allowedTools: z.array(z.string().min(1).max(100)).max(MAX_ALLOWED_TOOLS).optional(),
  maxAttempts: z.number().int().min(1).max(3).optional(),
  maxConcurrentJobs: z.number().int().min(1).max(50).optional(),
};

export const createOfferingSchema = z
  .object({
    productKind: z.enum(["agent", "workflow", "model"]),
    agentId: z.string().uuid().optional(),
    orchestrationId: z.string().uuid().optional(),
    deploymentId: z.string().uuid().optional(),
    ...contentFields,
  })
  .strict();

/** Everything but the product: an offering is not moved to another product. */
export const updateOfferingSchema = z
  .object(contentFields)
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to change" });

export const validateOfferingSchema = z
  .object({
    inputSchema: jsonObject.nullable().optional(),
    sampleInputs: z.array(jsonObject).max(MAX_SAMPLE_INPUTS).optional(),
    deliverableChecks: z.array(z.unknown()).max(MAX_CHECKS).optional(),
  })
  .strict();

export type CreateOfferingBody = z.infer<typeof createOfferingSchema>;
export type UpdateOfferingBody = z.infer<typeof updateOfferingSchema>;

// ============================================
// Stored shapes
// ============================================

export interface OfferingRecord {
  id: string;
  publisherId: string;
  productKind: string;
  agentId: string | null;
  orchestrationId: string | null;
  deploymentId: string | null;
  listingId: string | null;
  slug: string;
  title: string;
  description: string;
  priceCents: bigint;
  slaSeconds: number;
  inputSchema: unknown;
  sampleInputs: unknown;
  instructions: string | null;
  deliverableChecks: unknown;
  outputFormat: string;
  allowedTools: string[];
  maxAttempts: number;
  maxConcurrentJobs: number;
  activeJobs: number;
  status: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An offering with the names a reader is shown beside it. */
export interface OfferingView extends OfferingRecord {
  /** The product's display name; null when the product was deleted. */
  productName: string | null;
  publisher: { name: string; slug: string | null; isVerified: boolean; reputationTier: string | null };
  listing: { slug: string; title: string } | null;
}

export interface TrackRecord {
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

export interface AgentForSale {
  id: string;
  name: string;
  /** "graph" = it answers through its graph, whose tools are fixed. */
  entrypoint: string;
  /** Installed from the marketplace: someone else's agent. */
  isMarketplaceCopy: boolean;
  /** Its published listing, when it has one: reviews and contributor shares hang off it. */
  listingId: string | null;
}

export interface WorkflowForSale {
  id: string;
  name: string;
  isEnabled: boolean;
  stepCount: number;
  usesMarketplaceCopy: boolean;
  inputSchema: unknown;
}

export interface DeploymentForSale {
  id: string;
  name: string;
  status: string;
}

export type NewOffering = Omit<
  OfferingRecord,
  "id" | "activeJobs" | "status" | "publishedAt" | "createdAt" | "updatedAt"
>;

export type OfferingPatch = Partial<
  Pick<
    OfferingRecord,
    | "title"
    | "description"
    | "priceCents"
    | "slaSeconds"
    | "inputSchema"
    | "sampleInputs"
    | "instructions"
    | "deliverableChecks"
    | "outputFormat"
    | "allowedTools"
    | "maxAttempts"
    | "maxConcurrentJobs"
    | "listingId"
  >
>;

export interface PublicSearch {
  productKind?: ProductKind;
  query?: string;
  agentId?: string;
  listingId?: string;
  /** A publisher's slug. */
  publisher?: string;
  sort: "newest" | "price_low" | "price_high" | "rating";
  page: number;
  limit: number;
}

export interface OfferingStore {
  /** Each product lookup is scoped to `orgId`; another organization's is null. */
  findAgent(orgId: string, agentId: string): Promise<AgentForSale | null>;
  findWorkflow(orgId: string, orchestrationId: string): Promise<WorkflowForSale | null>;
  findDeployment(orgId: string, deploymentId: string): Promise<DeploymentForSale | null>;
  /** Throws an error whose `code` is "P2002" when the slug is taken. */
  create(data: NewOffering): Promise<OfferingView>;
  findOwned(orgId: string, id: string): Promise<OfferingView | null>;
  listOwned(orgId: string, status?: OfferingStatus): Promise<OfferingView[]>;
  /** Null when the offering is not the organization's, or is archived. */
  updateOwned(orgId: string, id: string, patch: OfferingPatch): Promise<OfferingView | null>;
  /** Compare-and-set on status. False = it was not in one of `from`. */
  transition(
    orgId: string,
    id: string,
    from: OfferingStatus[],
    to: OfferingStatus,
    extra?: { publishedAt?: Date; listingId?: string | null },
  ): Promise<boolean>;
  /** Any status, any organization: the hire path and the public page filter. */
  findById(id: string): Promise<OfferingView | null>;
  findBySlug(slug: string): Promise<OfferingView | null>;
  searchActive(params: PublicSearch): Promise<{ rows: OfferingView[]; total: number }>;
  jobCounts(offeringIds: string[]): Promise<Record<string, Record<string, number>>>;
  trackRecord(offeringId: string): Promise<TrackRecord>;
}

// ============================================
// Validation
// ============================================

export interface OfferingContent {
  inputSchema?: unknown;
  sampleInputs?: unknown[];
  deliverableChecks?: unknown[];
}

/**
 * Compiles the input schema, checks every sample against it and compiles
 * every deliverable check. Throws the first OfferingError found.
 */
export function validateOfferingContent(content: OfferingContent): { checks: Check[] } {
  let compiled: ReturnType<typeof compileUserSchema> | null = null;
  if (content.inputSchema !== undefined && content.inputSchema !== null) {
    try {
      compiled = compileUserSchema(content.inputSchema, { root: "object" });
    } catch (err) {
      if (!(err instanceof JsonSchemaError)) throw err;
      throw new OfferingError("invalid_input_schema", `The input schema is not valid: ${err.message}`, err.issues);
    }
  }
  (content.sampleInputs ?? []).forEach((sample, index) => {
    const result = compiled?.validate(sample);
    if (result && !result.valid && result.code) {
      // Stopped at the work budget, not decided: saying "does not match"
      // would send the publisher to fix a sample that may be fine.
      throw new OfferingError(
        result.code,
        `Sample input ${index + 1} could not be checked against the input schema: ${result.errors[0]?.message ?? "it takes too much work"}`,
        result.errors.map((issue) => ({ path: `/${index}${issue.path}`, message: issue.message })),
      );
    }
    if (result && !result.valid) {
      throw new OfferingError(
        "invalid_sample_input",
        `Sample input ${index + 1} does not match the input schema`,
        result.errors.map((issue) => ({ path: `/${index}${issue.path}`, message: issue.message })),
      );
    }
  });
  const checks = validateChecks(content.deliverableChecks ?? []);
  if (!checks.ok) {
    throw new OfferingError("invalid_deliverable_check", "A deliverable check is not valid", checks.issues);
  }
  return { checks: checks.checks };
}

export interface ProductRef {
  productKind: string;
  agentId: string | null;
  orchestrationId: string | null;
  deploymentId: string | null;
}

export type Sellable =
  | { ok: true; productName: string; listingId: string | null; workflowInputSchema: unknown }
  | { ok: false; code: "product_not_found" | "product_not_sellable"; message: string };

/**
 * Whether the organization may sell this product, as it is now. Run when an
 * offering is created, when it is activated and at every hire: a product
 * can be deleted, disabled or rebuilt from marketplace copies afterwards.
 */
export async function checkSellable(
  store: Pick<OfferingStore, "findAgent" | "findWorkflow" | "findDeployment">,
  orgId: string,
  product: ProductRef,
  options: { allowedTools?: string[] } = {},
): Promise<Sellable> {
  const missing = (what: string): Sellable => ({
    ok: false,
    code: "product_not_found",
    message: `That ${what} was not found in your organization`,
  });
  const refused = (message: string): Sellable => ({ ok: false, code: "product_not_sellable", message });

  if (product.productKind === "agent") {
    const agent = product.agentId ? await store.findAgent(orgId, product.agentId) : null;
    if (!agent) return missing("agent");
    if (agent.isMarketplaceCopy) {
      return refused("This agent was installed from the marketplace. Only an agent you built can be sold as an offering.");
    }
    if (agent.entrypoint === "graph" && (options.allowedTools?.length ?? 0) > 0) {
      return refused(
        "This agent answers through its graph, whose tools are fixed by its design, so an offering cannot limit them. Remove the allowed tools.",
      );
    }
    return { ok: true, productName: agent.name, listingId: agent.listingId, workflowInputSchema: null };
  }
  if (product.productKind === "workflow") {
    const workflow = product.orchestrationId ? await store.findWorkflow(orgId, product.orchestrationId) : null;
    if (!workflow) return missing("workflow");
    if (!workflow.isEnabled) return refused("This workflow is disabled. Enable it before selling it.");
    if (workflow.stepCount === 0) return refused("This workflow has no steps yet.");
    if (workflow.usesMarketplaceCopy) {
      return refused(
        "This workflow uses an agent installed from the marketplace. A workflow can be sold only when every agent in it is one you built.",
      );
    }
    return { ok: true, productName: workflow.name, listingId: null, workflowInputSchema: workflow.inputSchema };
  }
  if (product.productKind === "model") {
    const deployment = product.deploymentId ? await store.findDeployment(orgId, product.deploymentId) : null;
    if (!deployment) return missing("model deployment");
    // Not required to be running to write the offering; it must be to sell.
    return { ok: true, productName: deployment.name, listingId: null, workflowInputSchema: null };
  }
  return refused("Unknown product kind");
}

// ============================================
// Response shapes
// ============================================

function publicChecks(raw: unknown): Array<Record<string, unknown>> {
  const checks = validateChecks(Array.isArray(raw) ? raw : []);
  if (!checks.ok) return [];
  return checks.checks.map((check) => ({ ...check }));
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ============================================
// Terms
// ============================================

/** What a buyer is shown before hiring, and what a hire is checked against. */
export interface OfferingTerms {
  priceCents: number;
  slaSeconds: number;
  termsVersion: string;
}

/** Keys sorted at every level: stored JSON does not keep the order it was written in. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = canonical((value as Record<string, unknown>)[key]);
  return sorted;
}

/**
 * One value that changes whenever anything a buyer is agreeing to changes:
 * what is promised (title, description), the price and delivery time, what
 * they must send, the checks and format of the deliverable, and the
 * publisher's private instructions - which a buyer never sees, and which
 * decide how the work is done all the same.
 *
 * A digest, so it shows that the instructions changed and nothing of what
 * they say. It is not keyed: someone holding an exact copy of an offering's
 * instructions could confirm it against this (docs/HARDENING-BACKLOG.md).
 */
export function offeringTermsVersion(
  o: Pick<
    OfferingRecord,
    | "title"
    | "description"
    | "priceCents"
    | "slaSeconds"
    | "inputSchema"
    | "deliverableChecks"
    | "outputFormat"
    | "instructions"
  >,
): string {
  const terms = canonical({
    title: o.title,
    description: o.description,
    priceCents: o.priceCents.toString(),
    slaSeconds: o.slaSeconds,
    inputSchema: o.inputSchema ?? null,
    deliverableChecks: asArray(o.deliverableChecks),
    outputFormat: o.outputFormat,
    instructions: o.instructions ?? "",
  });
  return createHash("sha256").update(JSON.stringify(terms)).digest("hex").slice(0, 32);
}

export function offeringTerms(o: OfferingRecord): OfferingTerms {
  return { priceCents: Number(o.priceCents), slaSeconds: o.slaSeconds, termsVersion: offeringTermsVersion(o) };
}

/**
 * What anyone may read. Written out field by field on purpose: adding a
 * column to the offering does not add it to this.
 */
export function toPublicOffering(o: OfferingView) {
  return {
    id: o.id,
    slug: o.slug,
    title: o.title,
    description: o.description,
    productKind: o.productKind,
    priceCents: Number(o.priceCents),
    slaSeconds: o.slaSeconds,
    // Sent back with a hire as `expected`, so the buyer pays for what they read.
    termsVersion: offeringTermsVersion(o),
    reviewWindowHours: JOB_REVIEW_WINDOW_MS / 3_600_000,
    inputSchema: o.inputSchema ?? null,
    sampleInputs: asArray(o.sampleInputs),
    deliverableChecks: publicChecks(o.deliverableChecks),
    outputFormat: o.outputFormat,
    product: { name: o.productName ?? "Unavailable" },
    publisher: o.publisher,
    listing: o.listing,
    createdAt: o.createdAt,
  };
}

export type PublicOffering = ReturnType<typeof toPublicOffering>;

export function toPublisherOffering(o: OfferingView, jobCounts: Record<string, number> = {}) {
  return {
    ...toPublicOffering(o),
    status: o.status,
    instructions: o.instructions,
    agentId: o.agentId,
    orchestrationId: o.orchestrationId,
    deploymentId: o.deploymentId,
    listingId: o.listingId,
    allowedTools: o.allowedTools,
    maxAttempts: o.maxAttempts,
    maxConcurrentJobs: o.maxConcurrentJobs,
    activeJobs: o.activeJobs,
    productAvailable: o.productName !== null,
    publishedAt: o.publishedAt,
    updatedAt: o.updatedAt,
    stats: { jobs: jobCounts },
  };
}

export type PublisherOffering = ReturnType<typeof toPublisherOffering>;

// ============================================
// Service
// ============================================

export interface OfferingServiceDeps {
  store: OfferingStore;
  /** False when no worker runs jobs (JOB_RUNNER_CONCURRENCY=0). */
  runnerEnabled: boolean;
  /** Creates the organization's payout profile when it has none. */
  ensurePublisherProfile(orgId: string): Promise<void>;
  /** Six or so random characters for a slug that was taken. */
  randomSuffix(): string;
  now?: () => Date;
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "offering"
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

function sellableOrThrow(sellable: Sellable): Extract<Sellable, { ok: true }> {
  if (!sellable.ok) throw new OfferingError(sellable.code, sellable.message);
  return sellable;
}

export async function createOffering(
  deps: OfferingServiceDeps,
  orgId: string,
  body: CreateOfferingBody,
): Promise<PublisherOffering> {
  const product: ProductRef = {
    productKind: body.productKind,
    agentId: body.productKind === "agent" ? (body.agentId ?? null) : null,
    orchestrationId: body.productKind === "workflow" ? (body.orchestrationId ?? null) : null,
    deploymentId: body.productKind === "model" ? (body.deploymentId ?? null) : null,
  };
  if (!product.agentId && !product.orchestrationId && !product.deploymentId) {
    const field = { agent: "agentId", workflow: "orchestrationId", model: "deploymentId" }[body.productKind];
    throw new OfferingError("invalid_request", `${field} is required for a ${body.productKind} offering`);
  }
  const sellable = sellableOrThrow(
    await checkSellable(deps.store, orgId, product, { allowedTools: body.allowedTools }),
  );
  const { checks } = validateOfferingContent(body);
  // Held from the first offering on, not only at activation: a profile that
  // is missing when a job settles leaves the escrow held.
  await deps.ensurePublisherProfile(orgId);

  const data: Omit<NewOffering, "slug"> = {
    publisherId: orgId,
    ...product,
    listingId: sellable.listingId,
    title: body.title,
    description: body.description,
    priceCents: BigInt(body.priceCents),
    slaSeconds: body.slaSeconds,
    inputSchema: body.inputSchema ?? null,
    sampleInputs: body.sampleInputs ?? [],
    instructions: body.instructions?.trim() ? body.instructions : null,
    deliverableChecks: checks,
    outputFormat: body.outputFormat ?? "text",
    allowedTools: [...new Set(body.allowedTools ?? [])],
    maxAttempts: body.maxAttempts ?? 1,
    maxConcurrentJobs: body.maxConcurrentJobs ?? 5,
  };
  const base = slugify(body.title);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const created = await deps.store.create({
        ...data,
        slug: attempt === 0 ? base : `${base}-${deps.randomSuffix()}`,
      });
      return toPublisherOffering(created);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new OfferingError("offering_state_conflict", "Could not find a free address for this offering. Try another title.");
}

async function ownedOrThrow(deps: OfferingServiceDeps, orgId: string, id: string): Promise<OfferingView> {
  const offering = await deps.store.findOwned(orgId, id);
  if (!offering) throw new OfferingError("offering_not_found", "Offering not found");
  return offering;
}

export async function updateOffering(
  deps: OfferingServiceDeps,
  orgId: string,
  id: string,
  body: UpdateOfferingBody,
): Promise<PublisherOffering> {
  const current = await ownedOrThrow(deps, orgId, id);
  if (current.status === "archived") {
    throw new OfferingError("offering_state_conflict", "An archived offering cannot be changed");
  }
  // The stored values stand in for whatever the patch leaves out, so the
  // samples are always checked against the schema they will be saved beside.
  const { checks } = validateOfferingContent({
    inputSchema: body.inputSchema !== undefined ? body.inputSchema : current.inputSchema,
    sampleInputs: body.sampleInputs ?? asArray(current.sampleInputs),
    deliverableChecks: body.deliverableChecks ?? asArray(current.deliverableChecks),
  });
  if (body.allowedTools !== undefined) {
    sellableOrThrow(await checkSellable(deps.store, orgId, current, { allowedTools: body.allowedTools }));
  }
  const patch: OfferingPatch = {
    ...(body.title !== undefined && { title: body.title }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.priceCents !== undefined && { priceCents: BigInt(body.priceCents) }),
    ...(body.slaSeconds !== undefined && { slaSeconds: body.slaSeconds }),
    ...(body.inputSchema !== undefined && { inputSchema: body.inputSchema }),
    ...(body.sampleInputs !== undefined && { sampleInputs: body.sampleInputs }),
    ...(body.instructions !== undefined && { instructions: body.instructions?.trim() ? body.instructions : null }),
    ...(body.deliverableChecks !== undefined && { deliverableChecks: checks }),
    ...(body.outputFormat !== undefined && { outputFormat: body.outputFormat }),
    ...(body.allowedTools !== undefined && { allowedTools: [...new Set(body.allowedTools)] }),
    ...(body.maxAttempts !== undefined && { maxAttempts: body.maxAttempts }),
    ...(body.maxConcurrentJobs !== undefined && { maxConcurrentJobs: body.maxConcurrentJobs }),
  };
  const updated = await deps.store.updateOwned(orgId, id, patch);
  if (!updated) throw new OfferingError("offering_not_found", "Offering not found");
  const counts = await deps.store.jobCounts([id]);
  return toPublisherOffering(updated, counts[id]);
}

export type OfferingAction = "activate" | "pause" | "archive";

export async function setOfferingStatus(
  deps: OfferingServiceDeps,
  orgId: string,
  id: string,
  action: OfferingAction,
): Promise<PublisherOffering> {
  const offering = await ownedOrThrow(deps, orgId, id);
  let moved: boolean;
  if (action === "activate") {
    if (!deps.runnerEnabled) throw new OfferingError("jobs_not_configured", JOBS_NOT_CONFIGURED_MESSAGE);
    const sellable = sellableOrThrow(
      await checkSellable(deps.store, orgId, offering, { allowedTools: offering.allowedTools }),
    );
    if (offering.productKind === "model") {
      const deployment = await deps.store.findDeployment(orgId, offering.deploymentId ?? "");
      if (deployment?.status !== "running") {
        throw new OfferingError(
          "product_not_sellable",
          "This model deployment is not running. Start it before selling it.",
        );
      }
    }
    validateOfferingContent({
      inputSchema: offering.inputSchema,
      sampleInputs: asArray(offering.sampleInputs),
      deliverableChecks: asArray(offering.deliverableChecks),
    });
    await deps.ensurePublisherProfile(orgId);
    moved = await deps.store.transition(orgId, id, ["draft", "paused"], "active", {
      ...(offering.publishedAt === null && { publishedAt: (deps.now ?? (() => new Date()))() }),
      // The agent may have been listed, or unlisted, since the offering was written.
      listingId: sellable.listingId,
    });
  } else if (action === "pause") {
    moved = await deps.store.transition(orgId, id, ["active"], "paused");
  } else {
    moved = await deps.store.transition(orgId, id, ["draft", "active", "paused"], "archived");
  }
  if (!moved) {
    const need = { activate: "a draft or paused", pause: "an active", archive: "a draft, active or paused" }[action];
    throw new OfferingError(
      "offering_state_conflict",
      `Only ${need} offering can be ${action}d; this one is ${offering.status}.`,
    );
  }
  return getOwnedOffering(deps, orgId, id);
}

export async function getOwnedOffering(
  deps: Pick<OfferingServiceDeps, "store">,
  orgId: string,
  id: string,
): Promise<PublisherOffering> {
  const offering = await deps.store.findOwned(orgId, id);
  if (!offering) throw new OfferingError("offering_not_found", "Offering not found");
  const counts = await deps.store.jobCounts([id]);
  return toPublisherOffering(offering, counts[id]);
}

export async function listOwnedOfferings(
  deps: Pick<OfferingServiceDeps, "store">,
  orgId: string,
  status?: OfferingStatus,
): Promise<PublisherOffering[]> {
  const offerings = await deps.store.listOwned(orgId, status);
  const counts = await deps.store.jobCounts(offerings.map((o) => o.id));
  return offerings.map((o) => toPublisherOffering(o, counts[o.id]));
}

export const publicSearchSchema = z.object({
  productKind: z.enum(["agent", "workflow", "model"]).optional(),
  query: z.string().trim().max(200).optional(),
  agentId: z.string().uuid().optional(),
  listingId: z.string().uuid().optional(),
  publisher: z.string().trim().max(120).optional(),
  sort: z.enum(["newest", "price_low", "price_high", "rating"]).default("newest"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function searchPublicOfferings(deps: Pick<OfferingServiceDeps, "store">, params: PublicSearch) {
  const { rows, total } = await deps.store.searchActive(params);
  return {
    offerings: rows.map(toPublicOffering),
    pagination: {
      page: params.page,
      limit: params.limit,
      total,
      totalPages: Math.ceil(total / params.limit),
    },
  };
}

/** Only an active offering has a public page; anything else is "not found". */
export async function getPublicOffering(deps: Pick<OfferingServiceDeps, "store">, slug: string) {
  const offering = await deps.store.findBySlug(slug);
  if (!offering || offering.status !== "active") {
    throw new OfferingError("offering_not_found", "Offering not found");
  }
  return { ...toPublicOffering(offering), trackRecord: await deps.store.trackRecord(offering.id) };
}

/** The buyer's input against the offering's schema. Throws input_invalid or validation_too_expensive. */
export function validateJobInput(offering: Pick<OfferingRecord, "inputSchema">, input: unknown): void {
  if (offering.inputSchema === null || offering.inputSchema === undefined) return;
  let result;
  try {
    result = compileUserSchema(offering.inputSchema, { root: "object" }).validate(input);
  } catch (err) {
    if (!(err instanceof JsonSchemaError)) throw err;
    // The schema compiled when it was saved; if it no longer does, nothing
    // can be validated against it and nothing is hired.
    throw new OfferingError("input_invalid", "This offering's input schema can no longer be read", err.issues);
  }
  if (!result.valid && result.code) {
    throw new OfferingError(
      result.code,
      `The input could not be checked against this offering's input schema: ${result.errors[0]?.message ?? "it takes too much work"}`,
      result.errors,
    );
  }
  if (!result.valid) {
    throw new OfferingError("input_invalid", "The input does not match this offering's input schema", result.errors);
  }
}

// ============================================
// Test run
// ============================================

export const testRunBodySchema = z.object({ input: z.record(z.unknown()).default({}) }).strict();

export interface OfferingTestRunDeps {
  store: OfferingStore;
  /** One graded run of the product (jobRunner.tryOffering on the runner's deps). */
  tryProduct(job: JobForRun, signal: AbortSignal): Promise<{
    passed: boolean;
    output: Record<string, unknown> | null;
    checkResults: CheckResult[];
  }>;
  /** A test run happens inside a request; it gets this long. */
  maxRunMs: number;
  /** The message the chat core throws when the free-model limit is reached. */
  freeTierLimitMessage: string;
  now?: () => Date;
}

/**
 * The publisher runs their own offering once, exactly as a paid job would
 * run it (the `hired` tool mode, the private instructions, the checks),
 * with no job, no escrow and no buyer. Whatever the product uses is the
 * publisher's own usage, as in the playground.
 */
export async function testRunOffering(
  deps: OfferingTestRunDeps,
  orgId: string,
  id: string,
  input: unknown,
): Promise<{ passed: boolean; output: Record<string, unknown> | null; checkResults: CheckResult[]; durationMs: number }> {
  const offering = await deps.store.findOwned(orgId, id);
  if (!offering) throw new OfferingError("offering_not_found", "Offering not found");
  sellableOrThrow(await checkSellable(deps.store, orgId, offering, { allowedTools: offering.allowedTools }));
  validateJobInput(offering, input);

  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const job: JobForRun = {
    id: `test-run-${offering.id}`,
    buyerId: orgId,
    publisherId: orgId,
    status: "running",
    input,
    deadlineAt: null,
    leaseExpiresAt: null,
    attempts: 0,
    testRun: true,
    terms: {
      title: offering.title,
      deliverableChecks: offering.deliverableChecks,
      outputFormat: offering.outputFormat,
    },
    offering,
  };
  try {
    const result = await deps.tryProduct(job, AbortSignal.timeout(deps.maxRunMs));
    return { ...result, durationMs: Math.max(0, now().getTime() - startedAt.getTime()) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === deps.freeTierLimitMessage) {
      throw new OfferingError("free_tier_limited", "The free-model limit for your organization was reached. Try again later.");
    }
    // The publisher's own product and their own error: shown as it is.
    throw new OfferingError("test_run_failed", `The test run failed: ${message}`);
  }
}
