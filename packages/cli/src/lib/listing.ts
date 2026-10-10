import type { Agent, AgentListing, WheelsAI } from "@wheelsai/sdk";

import { CliError } from "../errors.js";
import { listingUrl } from "./urls.js";
import { parseCategory, LISTING_CATEGORIES, type ListingCategory, type Pricing } from "./pricing.js";

export interface PublishOptions {
  /** Pricing from flags; null means "not specified". */
  pricing: Pricing | null;
  title?: string;
  description?: string;
  category?: string;
  /**
   * Sell copies of the agent (buyers get their own copy, including its instructions) instead of use of it.
   * Left out, a new listing sells use and an existing one keeps what it sells.
   */
  copies?: boolean;
}

export interface PublishResult {
  listing: AgentListing;
  url: string;
  /** A new listing was created (otherwise the agent's existing one was reused). */
  created: boolean;
  /** An existing listing was edited because flags asked for it. */
  updated: boolean;
  /** The listing was already public; nothing was published just now. */
  alreadyPublished: boolean;
}

const SHORT_DESCRIPTION_MAX = 280;
const SHORT_DESCRIPTION_MIN = 10;
const TITLE_MIN = 3;
const TITLE_MAX = 100;

/**
 * Check `--title` and `--description` against the API's limits without calling it.
 * `publishAgent` leaves validation to the API; this is for callers that must know
 * before they start something expensive (a GPU deployment).
 */
export function checkListingText(options: Pick<PublishOptions, "title" | "description">): void {
  if (options.title !== undefined && (options.title.length < TITLE_MIN || options.title.length > TITLE_MAX)) {
    throw new CliError(`--title must be ${TITLE_MIN} to ${TITLE_MAX} characters, got ${options.title.length}.`);
  }
  if (
    options.description !== undefined &&
    (options.description.length < SHORT_DESCRIPTION_MIN || options.description.length > SHORT_DESCRIPTION_MAX)
  ) {
    throw new CliError(
      `--description must be ${SHORT_DESCRIPTION_MIN} to ${SHORT_DESCRIPTION_MAX} characters, got ${options.description.length}.`,
    );
  }
}

/**
 * Everything about a listing that can be checked before the agent is deployed: the flags,
 * and, when the agent has no listing yet, the title its name would give. Reads the caller's
 * listings (no writes), so a marketplace the caller cannot use also fails here.
 */
export async function preflightListing(wheels: WheelsAI, agent: Agent, options: PublishOptions): Promise<void> {
  parseCategory(options.category);
  checkListingText(options);
  const { listings } = await wheels.marketplace.myListings();
  if (listings.some((listing) => listing.agentId === agent.id)) return;
  const title = options.title ?? defaultListingFields(agent).title;
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    throw new CliError(
      `The listing would take the agent's name as its title, but "${title}" is not ${TITLE_MIN} to ${TITLE_MAX} characters.`,
      { hint: "Pass --title <title>." },
    );
  }
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The `wheelsai publish` command that repeats these listing options, for a retry hint. */
export function publishCommandLine(agentSlug: string, options: PublishOptions): string {
  const parts = ["wheelsai publish --agent", agentSlug];
  const pricing = options.pricing;
  if (options.copies) parts.push("--copies");
  if (pricing?.pricingModel === "per_request") parts.push("--price-per-request", String(pricing.pricePerRequestCents));
  else if (pricing?.pricingModel === "monthly") parts.push("--monthly", String(pricing.monthlyPriceCents));
  else if (pricing) parts.push(pricing.pricingModel === "free" ? "--free" : "--tokenized");
  if (options.title !== undefined) parts.push("--title", shellQuote(options.title));
  if (options.description !== undefined) parts.push("--description", shellQuote(options.description));
  if (options.category !== undefined) parts.push("--category", options.category);
  return parts.join(" ");
}

/** What a listing's fallback line says the agent is, by how people use it. */
function describeKind(agent: Pick<Agent, "framework"> & Partial<Pick<Agent, "agentKind">>): string {
  if (agent.agentKind === "task") return `a ${agent.framework} agent that does a task you give it, built on WheelsAI.`;
  if (agent.agentKind === "scheduled") return `a ${agent.framework} agent that runs on its own, built on WheelsAI.`;
  return `a ${agent.framework} agent built on WheelsAI.`;
}

/** Listing text for an agent, from the agent's own fields. */
export function defaultListingFields(
  agent: Pick<Agent, "name" | "description" | "framework" | "tags"> & Partial<Pick<Agent, "agentKind">>,
): { title: string; shortDescription: string; category: ListingCategory } {
  const description = agent.description?.trim() ?? "";
  const shortDescription =
    description.length >= SHORT_DESCRIPTION_MIN
      ? description.slice(0, SHORT_DESCRIPTION_MAX)
      : `${agent.name}: ${describeKind(agent)}`;
  const tag = agent.tags.find((candidate) => (LISTING_CATEGORIES as readonly string[]).includes(candidate));
  return {
    title: agent.name,
    shortDescription,
    category: (tag as ListingCategory | undefined) ?? "other",
  };
}

/**
 * Create and publish the agent's marketplace listing; safe to run again.
 * An agent has at most one listing, so an existing one is reused: edited only
 * if flags say so, then published if it is not already.
 */
export async function publishAgent(
  wheels: WheelsAI,
  agent: Agent,
  webUrl: string,
  options: PublishOptions,
  onStep: (message: string) => void = () => {},
): Promise<PublishResult> {
  const category = parseCategory(options.category);
  const { listings } = await wheels.marketplace.myListings();
  const existing = listings.find((listing) => listing.agentId === agent.id);

  let listing: AgentListing;
  let created = false;
  let updated = false;

  if (!existing) {
    const defaults = defaultListingFields(agent);
    onStep("Creating marketplace listing");
    ({ listing } = await wheels.marketplace.createListing({
      agentId: agent.id,
      title: options.title ?? defaults.title,
      shortDescription: options.description ?? defaults.shortDescription,
      category: category ?? defaults.category,
      // Use of the agent unless the caller asked for copies: the API's own default, so it is left out.
      ...(options.copies && { sells: "copies" as const }),
      // Free unless the caller chose a price: publishing never charges by accident.
      ...(options.pricing ?? { pricingModel: "free" as const }),
    }));
    created = true;
  } else {
    listing = existing;
    const edits = {
      ...(options.title !== undefined && { title: options.title }),
      ...(options.description !== undefined && { shortDescription: options.description }),
      ...(category !== undefined && { category }),
      ...(options.copies && { sells: "copies" as const }),
      ...(options.pricing ?? {}),
    };
    if (Object.keys(edits).length > 0) {
      onStep("Updating marketplace listing");
      ({ listing } = await wheels.marketplace.updateListing(existing.id, edits));
      updated = true;
    }
  }

  const alreadyPublished = listing.status === "published";
  if (!alreadyPublished) {
    onStep("Publishing to marketplace");
    const published = await wheels.marketplace.publishListing(listing.id);
    listing = { ...listing, ...published.listing };
  }

  if (!listing.slug) {
    throw new CliError("The API published the listing but returned no slug, so there is no URL to show.", {
      hint: "Find it with `wheelsai publish` again or in the dashboard.",
    });
  }

  return { listing, url: listingUrl(webUrl, listing.slug), created, updated, alreadyPublished };
}

/** One line saying what `publishAgent` did. */
export function describePublishOutcome(result: Pick<PublishResult, "created" | "updated" | "alreadyPublished">): string {
  if (result.created) return "Listed on the marketplace";
  if (result.alreadyPublished) return result.updated ? "Updated the listing (already on the marketplace)" : "Already listed on the marketplace";
  return result.updated ? "Updated and published the existing listing" : "Published the existing listing";
}
