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
import { LISTING_TITLE_MIN } from "./listing-draft";
import {
  LISTING_LINE_MAX,
  LISTING_LINE_MIN,
  LISTING_TITLE_MAX,
  SELL_LINE_TOO_SHORT,
  saleStanding,
  sellLineOf,
  sellUpdateOf,
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

// ============================================
// Its title and its one line
// ============================================

/** The two fields of the Sell part that name and describe the listing, and why a value is refused. */
export const WORKFLOW_LISTING_WORDS = {
  titleLabel: "Title",
  titleHint: "Buyers see it as the name of this workflow. Its page address is made from it.",
  /** Once the listing exists: the slug was made at the first save and a change of title keeps it. */
  titleHintListed: "Buyers see it as the name of this workflow. Changing it does not change its page address.",
  lineLabel: "One line",
  titlePlaceholder: "Weekly report",
  linePlaceholder: "Turns your meeting notes into a weekly report",
  titleTooShort: `Give the listing a title of at least ${LISTING_TITLE_MIN} characters.`,
  titleTooLong: `Keep the title to ${LISTING_TITLE_MAX} characters or fewer.`,
  /** The API's own sentence for a title that makes an empty slug (services/workflowListing.ts). */
  titleNoLetters: "Give the listing a title with letters or numbers.",
  lineTooShort: SELL_LINE_TOO_SHORT,
  lineTooLong: `Keep this line to ${LISTING_LINE_MAX} characters or fewer.`,
} as const;

/** The title and the one line as typed. */
export interface ListingWordsForm {
  title: string;
  line: string;
}

/** A sentence under the title or the line. */
export interface ListingWordsErrors {
  title?: string;
  line?: string;
}

/** The two fields of a listing that exists: its own title and line, as my listings reads them. */
export function savedListingWordsOf(listing: { title: string; shortDescription: string }): ListingWordsForm {
  return { title: listing.title, line: listing.shortDescription };
}

/** A text with every run of white space (line breaks too) made one space, and its ends trimmed. */
function oneLineOf(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The two fields as they open. With a listing, its own title and line.
 * Without one, what the first save would take: the workflow's name cut to
 * the longest title, and its description when it is long enough for a
 * line, else nothing for the creator to fill. Every run of white space is
 * made one space first: the fields are one-line inputs, which drop line
 * breaks from what they show, so the check and the request must not hold
 * text the creator cannot see.
 */
export function listingWordsFormOf(
  workflow: { name: string; description?: string | null },
  listing: { title: string; shortDescription: string } | null | undefined,
): ListingWordsForm {
  if (listing) return savedListingWordsOf(listing);
  return {
    title: oneLineOf(workflow.name).slice(0, LISTING_TITLE_MAX).trim(),
    line: sellLineOf([oneLineOf(workflow.description)]) ?? "",
  };
}

/**
 * Why a title is refused, as the API refuses it: from 3 to 100 characters,
 * and with a letter or a digit, since the buyer's address is made from it
 * (lowercased, every run of anything else made one dash). null when it is
 * fine. Checked on the trimmed title, which is what is sent.
 */
export function listingTitleProblem(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed.length < LISTING_TITLE_MIN) return WORKFLOW_LISTING_WORDS.titleTooShort;
  if (trimmed.length > LISTING_TITLE_MAX) return WORKFLOW_LISTING_WORDS.titleTooLong;
  if (!/[a-z0-9]/.test(trimmed.toLowerCase())) return WORKFLOW_LISTING_WORDS.titleNoLetters;
  return null;
}

/** Why a line is refused, as the API refuses it: from 10 to 280 characters. null when it is fine. */
export function listingLineProblem(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length < LISTING_LINE_MIN) return WORKFLOW_LISTING_WORDS.lineTooShort;
  if (trimmed.length > LISTING_LINE_MAX) return WORKFLOW_LISTING_WORDS.lineTooLong;
  return null;
}

/** Whether two states of the fields would send the same thing. */
export function sameListingWords(a: ListingWordsForm, b: ListingWordsForm): boolean {
  return a.title.trim() === b.title.trim() && a.line.trim() === b.line.trim();
}

/** What the listing routes take of the two fields: the trimmed text of each one that is sent. */
export interface ListingWordsSave {
  title?: string;
  shortDescription?: string;
}

export type ListingWordsCheck = { ok: true; words: ListingWordsSave } | { ok: false; errors: ListingWordsErrors };

/**
 * What the two fields send, or why they cannot be sent, each sentence under
 * its field. A first listing (`saved` null) sends both. A listing that
 * exists sends only what changed from `saved`, so a title the API took
 * once is never held against a change of price.
 */
export function listingWordsSaveOf(form: ListingWordsForm, saved: ListingWordsForm | null): ListingWordsCheck {
  const sendTitle = saved === null || form.title.trim() !== saved.title.trim();
  const sendLine = saved === null || form.line.trim() !== saved.line.trim();
  const errors: ListingWordsErrors = {};
  const titleProblem = sendTitle ? listingTitleProblem(form.title) : null;
  const lineProblem = sendLine ? listingLineProblem(form.line) : null;
  if (titleProblem) errors.title = titleProblem;
  if (lineProblem) errors.line = lineProblem;
  if (titleProblem || lineProblem) return { ok: false, errors };
  return {
    ok: true,
    words: {
      ...(sendTitle && { title: form.title.trim() }),
      ...(sendLine && { shortDescription: form.line.trim() }),
    },
  };
}

/** The listing routes' names for the two fields, and the field of the Sell part each one is about. */
const LISTING_WORDS_FIELD_OF: Record<string, keyof ListingWordsErrors> = {
  title: "title",
  shortDescription: "line",
};

/** The API's sentences of a refused save (400 `validation_failed`) that are about the title or the line. */
export function listingWordsFieldErrors(fields: Record<string, string>): ListingWordsErrors {
  const errors: ListingWordsErrors = {};
  for (const [path, sentence] of Object.entries(fields)) {
    const field = Object.prototype.hasOwnProperty.call(LISTING_WORDS_FIELD_OF, path) ? LISTING_WORDS_FIELD_OF[path] : undefined;
    if (field) errors[field] ??= sentence;
  }
  return errors;
}

/**
 * The body that makes a workflow's first listing from its API tab: the
 * workflow, the title and the line of the two fields as they are sent
 * (trimmed, once `listingWordsSaveOf(words, null)` took them), and the answer
 * to the question, put on sale at once.
 */
export function firstWorkflowListingOf(
  workflowId: string,
  words: ListingWordsForm,
  save: SellSave,
): SellSave & { orchestrationId: string; title: string; shortDescription: string; category: "other"; publish: true } {
  return {
    orchestrationId: workflowId,
    title: words.title.trim(),
    shortDescription: words.line.trim(),
    category: "other",
    ...save,
    publish: true,
  };
}

/**
 * The body of a save on a workflow's listing that exists: the answer to the
 * question (with publish when it is not on sale), and the title and the line
 * when they changed.
 */
export function workflowListingUpdateOf(
  save: SellSave,
  words: ListingWordsSave,
  listing: { status?: string } | null | undefined,
): SellSave & ListingWordsSave & { publish?: true } {
  return { ...sellUpdateOf(save, listing), ...words };
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
