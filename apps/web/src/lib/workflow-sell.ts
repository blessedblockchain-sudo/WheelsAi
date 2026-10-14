/**
 * Selling a workflow: what its Sell part says and sends, and where a
 * workflow's listing is opened from the creator's own lists.
 *
 * A workflow is sold by use only, per run, at the smallest price per use or
 * more, with plans of a number of runs for 30 days on top. It has no free
 * trial, no copies, no tools to allow and no token. Its buyers use it at
 * /w/<listing slug> and as model w/<listing slug>: the LISTING's slug, never
 * the workflow's own, which stays the owner's workflow/<slug>.
 *
 * Pure: no IO, no React. The workflow's API tab draws what this returns.
 * Every sentence the API also says (why a workflow cannot be sold) is the
 * API's own, word for word, and a test holds them against its source.
 */
import { productKindOf, type MarketplaceProductKind } from "./api";
import { formatCents } from "./jobs";
import {
  LISTING_TITLE_MAX,
  saleStanding,
  sellWordsOf,
  type SaleStanding,
  type SellListing,
  type SellSave,
} from "./sell-choice";

// ============================================
// Words
// ============================================

/** What the creator is told on the Sell part of a workflow, besides the longest run (`paidRunLimitLine`). */
export const WORKFLOW_SELL_LINES = {
  stepsCost: "Steps that ran before a run failed or was cancelled are your cost.",
  // Written once, in the workflow's words of "Who can use it?".
  hiredMode: sellWordsOf("workflow").forPayers,
  runsListed: sellWordsOf("workflow").keepCopy,
} as const;

export const WORKFLOW_SELL_WORDS = {
  title: "Sell",
  description: "Let people outside your organization run this workflow and pay for each run.",
  stopTitle: "Stop selling this workflow?",
  onSaleToast: "Your workflow is on sale",
  savedToast: "Changes saved",
  stoppedToast: "This workflow is no longer on sale",
  pageLabel: "Page",
  modelLabel: "Model id",
  openPage: "Open",
  lineHint: "It shows with the listing's title on the marketplace.",
  /** On a refusal to change or delete a workflow that is on sale: where it is stopped. */
  openSell: "Open Sell",
} as const;

/** How the run list names a run a buyer paid for: the trigger "paid". */
export const PAID_RUN_TRIGGER = "paid";
export const PAID_RUN_LABEL = "Paid run by a buyer";

/** "1 minute", "10 minutes". */
function minutesText(minutes: number): string {
  return minutes === 1 ? "1 minute" : `${minutes.toLocaleString("en-US")} minutes`;
}

/**
 * The longest a paid run may take, in whole minutes, from the capabilities'
 * `paidWorkflowMaxRunMs`. null when the API did not say or said something
 * that is not a whole number of minutes: no number is better than a guess.
 */
export function maxRunMinutesOf(
  capabilities: { paidUse?: { paidWorkflowMaxRunMs?: unknown } | null } | null | undefined,
): number | null {
  const ms = capabilities?.paidUse?.paidWorkflowMaxRunMs;
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms <= 0 || ms % 60_000 !== 0) return null;
  return ms / 60_000;
}

/** "A paid run is stopped after 10 minutes." null when the longest run is not known. */
export function paidRunLimitLine(maxRunMinutes: number | null): string | null {
  return maxRunMinutes === null ? null : `A paid run is stopped after ${minutesText(maxRunMinutes)}.`;
}

/** The four sentences of the Sell part, in the order they are read; the longest run is left out when it is not known. */
export function workflowSellLines(maxRunMinutes: number | null): string[] {
  const limit = paidRunLimitLine(maxRunMinutes);
  return [
    WORKFLOW_SELL_LINES.stepsCost,
    ...(limit ? [limit] : []),
    WORKFLOW_SELL_LINES.hiredMode,
    WORKFLOW_SELL_LINES.runsListed,
  ];
}

/**
 * The line on the workflow's own API cards: `workflow/<slug>` is the owner's
 * address, run as the owner and counted on the owner's plan, and is not what
 * a buyer calls.
 */
export function ownAddressLine(openaiModel: string): string {
  return `${openaiModel} is your own address: a call to it runs as you and counts as an API call on your plan. People who pay use the page and the model id shown under Sell.`;
}

// ============================================
// Can it go on sale
// ============================================

/** The API's sentences for a workflow it will not put on sale (services/workflowListing.ts). */
export const WORKFLOW_NOT_SELLABLE = {
  disabled: "This workflow is disabled. Enable it before selling it.",
  noSteps: "This workflow has no steps yet.",
} as const;

/** "A workflow on sale must finish within 10 minutes. Set its time limit to 10 minutes or less." */
export function tooLongSentence(maxRunMinutes: number): string {
  const limit = minutesText(maxRunMinutes);
  return `A workflow on sale must finish within ${limit}. Set its time limit to ${limit} or less.`;
}

/**
 * Why this workflow cannot go on sale as it is, read off what the page
 * already has: disabled, no steps, or a time limit longer than a paid run
 * may take (only when that is known). null when none of these holds. The API
 * asks more (an agent installed from the marketplace, an agent that no longer
 * exists) and says it when a save is refused.
 */
export function workflowSellProblem(
  workflow: { isEnabled: boolean; steps?: readonly unknown[] | null; timeout: number },
  maxRunMinutes: number | null,
): string | null {
  if (!workflow.isEnabled) return WORKFLOW_NOT_SELLABLE.disabled;
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) return WORKFLOW_NOT_SELLABLE.noSteps;
  if (maxRunMinutes !== null && !(workflow.timeout <= maxRunMinutes * 60_000)) return tooLongSentence(maxRunMinutes);
  return null;
}

/** The codes the API refuses a change or a delete of a workflow with while it is on sale or has buyers. */
const ON_SALE_REFUSALS: ReadonlyArray<string> = ["workflow_on_sale", "workflow_has_buyers"];

/** Whether a refusal is about the workflow being on sale: the screen then offers the way to its Sell part. */
export function refusedForSale(code: string | null | undefined): boolean {
  return typeof code === "string" && ON_SALE_REFUSALS.includes(code);
}

// ============================================
// Its listing
// ============================================

interface OwnListingLike {
  id: string;
  productKind?: MarketplaceProductKind;
  agentId: string | null;
  orchestrationId?: string | null;
}

/** This workflow's listing among the organization's own (`getMyListings`), by `orchestrationId`; null when it has none. */
export function listingForWorkflow<T extends OwnListingLike>(listings: readonly T[], workflowId: string): T | null {
  return listings.find((listing) => productKindOf(listing) === "workflow" && listing.orchestrationId === workflowId) ?? null;
}

/**
 * The body that makes a workflow's first listing from its API tab: the
 * workflow, a title from its name, its line, and the answer to the question,
 * put on sale at once.
 */
export function firstWorkflowListingOf(
  workflow: { id: string; name: string },
  line: string,
  save: SellSave,
): SellSave & { orchestrationId: string; title: string; shortDescription: string; category: "other"; publish: true } {
  return {
    orchestrationId: workflow.id,
    title: workflow.name.trim().slice(0, LISTING_TITLE_MAX),
    shortDescription: line,
    category: "other",
    ...save,
    publish: true,
  };
}

/** Where the creator edits a listing of a workflow: the workflow's API tab. null for any other listing. */
export function workflowEditHref(listing: Omit<OwnListingLike, "id">): string | null {
  if (productKindOf(listing) !== "workflow" || !listing.orchestrationId) return null;
  return `/dashboard/orchestrations/${encodeURIComponent(listing.orchestrationId)}?tab=api`;
}

/** Where Edit goes for one of the organization's own listings: a workflow's API tab, or the listing wizard. */
export function ownListingEditHref(listing: OwnListingLike): string {
  return workflowEditHref(listing) ?? `/dashboard/marketplace/publish?edit=${listing.id}`;
}

// ============================================
// Where the sale stands
// ============================================

const WORKFLOW_STANDING_WORDS: Record<Exclude<SaleStanding, "not_listed" | "on_sale">, { label: string; sentence: string }> = {
  draft: { label: "Draft", sentence: "This workflow has a listing that is a draft. Nobody else can see it yet." },
  in_review: { label: "In review", sentence: "This listing is being reviewed. It goes on sale once it is approved." },
  stopped: { label: "Not on sale", sentence: "You stopped selling this workflow. Nobody new can find it on the marketplace." },
};

/** "$0.05 per run". */
export function workflowPriceText(listing: Pick<SellListing, "pricePerRequestCents">): string {
  return `${formatCents(listing.pricePerRequestCents ?? 0)} per run`;
}

/** The badge and the sentence at the top of the Sell part of a workflow that has a listing. */
export function workflowSaleStatus(listing: SellListing): { standing: SaleStanding; label: string; sentence: string } {
  const standing = saleStanding(listing);
  if (standing !== "on_sale" && standing !== "not_listed") return { standing, ...WORKFLOW_STANDING_WORDS[standing] };
  return {
    standing,
    label: "On sale",
    sentence: `People pay ${workflowPriceText(listing)} to use it on its page or through the API.`,
  };
}

function wholeCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * What stopping does, for the confirm dialog: "Stop selling. People who pay
 * per run lose access now. 2 people on a plan keep it until the 30 days they
 * paid for end and are not charged again." The number is the listing's own;
 * the sentence about plans is left out when nobody is on one.
 */
export function workflowStopSellingSentence(listing: Pick<SellListing, "buyers">): string {
  const subscribed = wholeCount(listing.buyers?.subscribed);
  const lines = ["Stop selling.", "People who pay per run lose access now."];
  if (subscribed === 1) {
    lines.push("1 person on a plan keeps it until the 30 days they paid for end and is not charged again.");
  } else if (subscribed > 1) {
    lines.push(
      `${subscribed.toLocaleString("en-US")} people on a plan keep it until the 30 days they paid for end and are not charged again.`,
    );
  }
  return lines.join(" ");
}

// ============================================
// Where buyers use it
// ============================================

/** The page of a workflow on sale: /w/<listing slug>. */
export function workflowPagePath(listingSlug: string): string {
  return `/w/${listingSlug}`;
}

/**
 * The page's full address on this site when its origin is known, the path
 * alone otherwise. Never a domain this deployment may not own.
 */
export function workflowPageAddress(origin: string | null | undefined, listingSlug: string): string {
  const base = (origin ?? "").trim().replace(/\/+$/, "");
  return `${base}${workflowPagePath(listingSlug)}`;
}

/** The model id a buyer calls on /v1: w/<listing slug>. */
export function workflowModelId(listingSlug: string): string {
  return `w/${listingSlug}`;
}
