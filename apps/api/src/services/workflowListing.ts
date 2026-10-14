/**
 * A listing that sells a WORKFLOW: its numbers, its sentences, and the two
 * questions asked of the workflow behind it.
 *
 *   workflowSellableProblem   whether the workflow may be on sale at all. It
 *                             is asked when the listing is created, changed
 *                             or published, before a buyer's start charges
 *                             anything, and before every paid run takes
 *                             anything.
 *   workflowCanRunNow         the wider question: it is sellable AND what its
 *                             steps run on is serving at this moment. Asked
 *                             before a start charges anything and before a
 *                             plan is renewed.
 *
 * Both are asked of one read of the workflow, always made by its id AND an
 * organization (services/buildWorkflowListingDeps.ts): the caller's for its
 * creator, the listing's publisher for a buyer. A workflow that is not in
 * that organization is not found, and so not sellable.
 *
 * Pure: no IO, and nothing here reads the environment or the database.
 */

// ============================================
// What a listing sells
// ============================================

/** What a listing sells. The word an offering already uses for it. */
export type ListingProductKind = "agent" | "workflow";

/**
 * Which of the two a listing row sells. A row that names a workflow, or has
 * no agent, is a workflow's listing: it is never read as an agent's, so
 * nothing invents an agent, a unit or a page for it.
 */
export function listingProductKind(listing: {
  agentId?: string | null;
  orchestrationId?: string | null;
}): ListingProductKind {
  return listing.agentId === null || (listing.orchestrationId ?? null) !== null ? "workflow" : "agent";
}

// ============================================
// The numbers
// ============================================

/** The longest a paid run may take: a workflow on sale has a time limit of at most this. */
export const PAID_WORKFLOW_MAX_RUN_MS = 600_000;

/**
 * How long after the longest run an answer may still be delivered and
 * charged for. Past it the answer is not delivered and the charge is given
 * back, so the sweeper never refunds a charge under an answer that was sent.
 */
export const PAID_WORKFLOW_DELIVER_GRACE_MS = 120_000;

/** How many paid runs of one workflow may be queued or running at once. */
export const PAID_WORKFLOW_MAX_ACTIVE_RUNS = 3;

/**
 * The slug of a workflow's listing, which is the buyer's name for the
 * workflow: /w/<slug> and model "w/<slug>". Never the workflow's own slug.
 */
export const WORKFLOW_LISTING_SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;

/** What a run's row says started it when a buyer paid for it. */
export const PAID_WORKFLOW_TRIGGER = "paid";

const MAX_RUN_MINUTES = PAID_WORKFLOW_MAX_RUN_MS / 60_000;

// ============================================
// The sentences
// ============================================

/** What the creator of a workflow's listing is told. */
export const WORKFLOW_LISTING_MESSAGES = {
  notFound: "Workflow not found.",
  // The first three are the sentences services/offerings.ts says of a
  // workflow sold as an offering, word for word (a test holds them together).
  disabled: "This workflow is disabled. Enable it before selling it.",
  noSteps: "This workflow has no steps yet.",
  marketplaceCopy:
    "This workflow uses an agent installed from the marketplace. A workflow can be sold only when every agent in it is one you built.",
  tooLong: `A workflow on sale must finish within ${MAX_RUN_MINUTES} minutes. Set its time limit to ${MAX_RUN_MINUTES} minutes or less.`,
  agentGone: "This workflow has a step whose agent no longer exists. Choose another agent for that step.",

  oneProduct: "Send agentId or orchestrationId, one of them.",
  listingExists: "This workflow already has a listing.",
  emptySlug: "Give the listing a title with letters or numbers.",
  sellsCopies: "A workflow is sold by use. Copies of a workflow are not sold.",
  notPerRun: "A workflow is sold per run. Add plans for buyers who want a number of uses for 30 days.",
  allowedTools: "A workflow listing has no tools to allow.",
  trialPlan: "A free trial can be offered on an agent only.",

  onSale: "This workflow is on sale. Stop selling it first.",
  onSaleChange: (problem: string) => `This workflow is on sale, so this change cannot be saved. ${problem}`,
  onPlan: "People are still on a plan for this workflow. It can be changed once their 30 days end.",
  hasBuyers:
    "People have paid for this workflow, so it cannot be deleted. Stop selling it instead: it leaves the marketplace, and buyers on a plan keep it until the 30 days they paid for end.",
} as const;

/** What a buyer is told when a workflow's listing cannot be started. */
export const WORKFLOW_START_MESSAGES = {
  notOffered: "This workflow cannot be started right now. Nothing was charged. Try again later.",
} as const;

// ============================================
// May it be on sale
// ============================================

/**
 * A workflow as the two questions read it. Never read by its id alone: the
 * read names the organization too.
 */
export interface WorkflowForListing {
  id: string;
  orgId: string;
  isEnabled: boolean;
  stepCount: number;
  /** A step or a fallback uses an agent that is a buyer's copy from the marketplace. */
  usesMarketplaceCopy: boolean;
  /**
   * Every agent a step or a fallback names is still an agent of the
   * workflow's organization. A step holds its agent by id with no foreign
   * key, and deleting an agent asks nothing of the workflows that use it.
   */
  everyAgentExists: boolean;
  /** The workflow's own time limit, in milliseconds. */
  timeoutMs: number;
  /** The workflow's input form, as it is stored. */
  inputSchema: unknown;
}

/**
 * The first reason this workflow cannot be on sale, as a sentence for its
 * creator, or null when it can.
 *
 * `orgId` is the organization it was asked for: the creator's own, or the
 * publisher of the listing. A workflow that was not found there, or that
 * turns out to be another organization's, is not found.
 */
export function workflowSellableProblem(workflow: WorkflowForListing | null | undefined, orgId: string): string | null {
  if (!workflow || workflow.orgId !== orgId) return WORKFLOW_LISTING_MESSAGES.notFound;
  if (!workflow.isEnabled) return WORKFLOW_LISTING_MESSAGES.disabled;
  if (workflow.stepCount === 0) return WORKFLOW_LISTING_MESSAGES.noSteps;
  if (workflow.usesMarketplaceCopy) return WORKFLOW_LISTING_MESSAGES.marketplaceCopy;
  // A time limit that cannot be read as a number is not one a paid run can be held to.
  if (!(workflow.timeoutMs <= PAID_WORKFLOW_MAX_RUN_MS)) return WORKFLOW_LISTING_MESSAGES.tooLong;
  if (!workflow.everyAgentExists) return WORKFLOW_LISTING_MESSAGES.agentGone;
  return null;
}

/** Whether that problem is that there is no such workflow in the organization (a 404, not a refusal of the workflow). */
export function workflowNotFound(workflow: WorkflowForListing | null | undefined, orgId: string): boolean {
  return !workflow || workflow.orgId !== orgId;
}

// ============================================
// Can it run now
// ============================================

/** What one read found of a workflow and of what its steps run on. */
export interface WorkflowRunReadiness {
  workflow: WorkflowForListing | null;
  /** Every model step's deployment is in the workflow's organization and running. */
  modelStepsServe: boolean;
  /** Every step agent set to a model its organization runs has a deployment that can serve. */
  agentModelsServe: boolean;
}

/**
 * Whether the workflow can run at this moment: it is sellable, and what its
 * steps run on is serving. This is what stands in for the pause of an
 * agent's listing: a workflow's listing has no pause marker.
 */
export function workflowCanRunNow(found: WorkflowRunReadiness, orgId: string): boolean {
  return workflowSellableProblem(found.workflow, orgId) === null && found.modelStepsServe && found.agentModelsServe;
}
