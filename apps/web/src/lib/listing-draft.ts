/**
 * The listing wizard's rules that are not layout: which agents already have
 * a listing and where choosing one leads, why Next is not ready, what a
 * save sends, and what its buttons say. Pure, so the page only lays them out.
 */
import type { AgentKind } from "@wheelsai/shared/agent-kind";

import { LIST_AGENT_PARAM, listingForAgent } from "./agent-page";
import { DEFAULT_SELL_LIMITS, sellProblem, type SellForm, type SellLimits, type SellSave } from "./sell-choice";
import { plansProblem, type PlanLimits, type PlansForm, type SavedPlan } from "./sell-plans";

export type ListingCategory = "customer-support" | "coding" | "research" | "automation" | "creative" | "other";

/** What the wizard's second step asks for, as typed. */
export interface ListingDetails {
  agentId: string;
  title: string;
  shortDescription: string;
  longDescription: string;
  category: ListingCategory;
}

const CATEGORIES: readonly ListingCategory[] = ["customer-support", "coding", "research", "automation", "creative", "other"];

export const LISTING_TITLE_MIN = 3;
export const LISTING_SHORT_MIN = 10;

export function emptyDetails(agentId = ""): ListingDetails {
  return { agentId, title: "", shortDescription: "", longDescription: "", category: "other" };
}

/** A listing's own details, for editing it. A category the wizard does not know reads as Other. */
export function detailsOfListing(listing: {
  agentId: string;
  title: string;
  shortDescription: string;
  longDescription?: string | null;
  category: string;
}): ListingDetails {
  return {
    agentId: listing.agentId,
    title: listing.title,
    shortDescription: listing.shortDescription,
    longDescription: listing.longDescription ?? "",
    category: CATEGORIES.includes(listing.category as ListingCategory) ? (listing.category as ListingCategory) : "other",
  };
}

// ============================================
// The agent picker
// ============================================

const WIZARD_PATH = "/dashboard/marketplace/publish";

/** Beside an agent that already has a listing. */
export const LISTED_AGENT_BADGE = "Has a listing";
export const LISTED_AGENT_NOTE = "Choosing it opens its listing for editing.";

export function editListingHref(listingId: string): string {
  return `${WIZARD_PATH}?edit=${encodeURIComponent(listingId)}`;
}

export function newListingHref(agentId: string): string {
  return `${WIZARD_PATH}?${LIST_AGENT_PARAM}=${encodeURIComponent(agentId)}`;
}

interface ListingRow {
  id: string;
  agentId: string;
  status: string;
}

/** Each agent with the listing it already has, or null. An agent has at most one. */
export function agentRows<A extends { id: string }, L extends ListingRow>(
  agents: readonly A[],
  listings: readonly L[],
): Array<{ agent: A; listing: L | null }> {
  return agents.map((agent) => ({ agent, listing: listingForAgent(listings, agent.id) }));
}

export type AgentPick =
  /** The agent has no listing and none is being edited: it becomes the wizard's agent. */
  | { kind: "select" }
  /** Go to another address of the wizard: the agent's listing for editing, or a new listing for it. */
  | { kind: "go"; href: string };

/**
 * What choosing an agent does. An agent that has a listing opens that
 * listing for editing, because an agent has one listing. Choosing an agent
 * without one while another listing is being edited leaves that edit and
 * starts a new listing.
 */
export function pickAgent(agentId: string, listings: readonly ListingRow[], editingListingId: string | null): AgentPick {
  const listing = listingForAgent(listings, agentId);
  if (listing) return listing.id === editingListingId ? { kind: "select" } : { kind: "go", href: editListingHref(listing.id) };
  return editingListingId ? { kind: "go", href: newListingHref(agentId) } : { kind: "select" };
}

// ============================================
// Why Next is not ready
// ============================================

export const WIZARD_STEPS = ["agent", "details", "pricing", "preview"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface WizardState {
  details: ListingDetails;
  sell: SellForm;
  /** The chosen agent with its tools; null until it has been read. */
  agent: { agentKind?: AgentKind | null; tools?: unknown } | null;
  limits?: SellLimits;
  /** The plans typed under "Pay per use", with the plans the listing has now; left out, no plan is checked. */
  plans?: { form: PlansForm; saved: readonly SavedPlan[] | null; limits?: PlanLimits };
}

/** Why the wizard cannot go on from a step, in one sentence; null when it can. */
export function stepProblem(step: WizardStep, state: WizardState): string | null {
  const { details } = state;
  if (step === "agent") return details.agentId ? null : "Choose an agent to go on.";
  if (step === "details") {
    if (details.title.trim().length < LISTING_TITLE_MIN) return "Give the listing a title of at least 3 characters.";
    if (details.shortDescription.trim().length < LISTING_SHORT_MIN) return "Write a short description of at least 10 characters.";
    return null;
  }
  if (step === "pricing") {
    if (!state.agent) return "This agent is still loading.";
    const problem = sellProblem(state.sell, state.agent, state.limits ?? DEFAULT_SELL_LIMITS);
    if (problem !== null || !state.plans) return problem;
    return plansProblem({ sell: state.sell, ...state.plans });
  }
  return null;
}

// ============================================
// What a save sends
// ============================================

interface DetailsBody {
  title: string;
  shortDescription: string;
  longDescription: string;
  category: ListingCategory;
}

function detailsBody(details: ListingDetails): DetailsBody {
  return {
    title: details.title.trim(),
    shortDescription: details.shortDescription.trim(),
    longDescription: details.longDescription,
    category: details.category,
  };
}

/** The body of a new listing. What it sells is always named: use, unless copies were chosen under More options. */
export function createListingBody(
  details: ListingDetails,
  save: SellSave,
  publish: boolean,
): DetailsBody & SellSave & { agentId: string; publish?: true } {
  return { agentId: details.agentId, ...detailsBody(details), ...save, ...(publish && { publish: true as const }) };
}

/** The body of a save of an existing listing. Its agent is fixed, so it is not sent. */
export function updateListingBody(details: ListingDetails, save: SellSave, publish: boolean): DetailsBody & SellSave & { publish?: true } {
  return { ...detailsBody(details), ...save, ...(publish && { publish: true as const }) };
}

// ============================================
// The buttons of the last step
// ============================================

export interface SubmitButton {
  id: "draft" | "save" | "publish";
  label: string;
  /** Whether the save also puts the listing on sale. */
  publish: boolean;
  primary: boolean;
  /** What the toast says when it worked. */
  done: string;
}

/**
 * A new listing is saved as a draft or published. An edit reads "Save
 * changes": alone for a listing that is on sale, and beside "Save and
 * publish" for one that is not.
 */
export function submitButtons(editing: { status: string } | null): SubmitButton[] {
  if (!editing) {
    return [
      { id: "draft", label: "Save as draft", publish: false, primary: false, done: "Listing saved as a draft" },
      { id: "publish", label: "Publish now", publish: true, primary: true, done: "Your agent is on the marketplace" },
    ];
  }
  const save: SubmitButton = { id: "save", label: "Save changes", publish: false, primary: true, done: "Changes saved" };
  if (editing.status === "published") return [save];
  return [
    { ...save, primary: false },
    { id: "publish", label: "Save and publish", publish: true, primary: true, done: "Changes saved and the listing is published" },
  ];
}

/** The preview's line that says what a buyer gets. */
export function previewSellsLine(sell: Pick<SellForm, "sells">): string {
  return sell.sells === "copies"
    ? "Buyers get their own copy, including its instructions."
    : "People use your agent on its page or through the API. They do not get a copy.";
}
