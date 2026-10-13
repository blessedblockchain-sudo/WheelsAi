import { prisma, Prisma } from "@wheelsai/db";
import { DEFAULT_AGENT_KIND, isAgentKind } from "@wheelsai/shared/agent-kind";
import { pauseAgentSchedules, type OwnScheduleDb } from "./agentOwnSchedule.js";
import {
  ensurePageKey,
  ensurePublicPage,
  isHandleConflict,
  PublicLinkError,
  setPageUse,
  type PublicLinkTx,
} from "./agentPublicLink.js";
import { resolveAgentModelId } from "./agentModelResolution.js";
import { HOSTED_MODEL_PREFIX } from "./hostedModel.js";
import { readOwnerPlans, replaceListingPlans, type OwnerPlan } from "./listingPlanStore.js";
import type { PlanInput } from "./listingPlans.js";
import { LISTING_PAUSED_START_MESSAGE, listingPausedNow, reconcileListingPauses } from "./listingPause.js";
import { getOrgPlan } from "./orgPlan.js";
import { cloneAgentBehaviour, cloneAgentKind } from "./marketplaceClone.js";
import { startMonthlySubscription, SubscriptionClaimLostError, type SubscriptionTx } from "./marketplaceSubscriptions.js";
import {
  installAccess,
  type InstallAccess,
  PAST_DUE_GRACE_DAYS,
  subscriptionGrantsAccess,
  subscriptionIsOpen,
} from "./subscriptionAccess.js";
import { orgHoldsToken, TokenRequiredError } from "./tokenAccess.js";
import {
  COPY_MONTH_BLOCKS_USE,
  copyMonthBlockingUse,
  copyMonthBlockingUseMessage,
  useAccess,
  type UseAccess,
} from "./useAccess.js";
import { isPaidUse, MIN_PRICE_PER_USE_CENTS, useUnitOf, type UseUnit } from "./useListing.js";
import { validationFailureFromFields, type ValidationFailureBody } from "../lib/validationFailure.js";
import { createLogger } from "../utils/logger.js";
import { updatePublisherReputation } from "./reputation.js";
import { payoutRequestSettingsFromEnv, readPayoutLimits, type PayoutReadsDb } from "./payoutRequests.js";
import { env } from "../config/env.js";

const logger = createLogger("marketplace-service");

// ============================================
// Types
// ============================================

export interface ListingSearchParams {
  query?: string;
  category?: string;
  pricingModel?: string;
  minRating?: number;
  sortBy?: "popular" | "rating" | "newest" | "price_low" | "price_high";
  page?: number;
  limit?: number;
}

export interface ListingCreateParams {
  agentId: string;
  title: string;
  shortDescription: string;
  longDescription?: string;
  category: string;
  iconUrl?: string;
  screenshots?: string[];
  readme?: string;
  pricingModel: "free" | "per_request" | "monthly" | "tokenized";
  pricePerRequestCents?: number;
  monthlyPriceCents?: number;
  /**
   * What the listing sells: use of the creator's own agent, or copies of it.
   * Omitted on a new listing means use; an existing listing keeps what it
   * sells unless an update names it.
   */
  sells?: ListingSells;
  /**
   * The outbound tools the creator allows for people who pay to use the
   * agent, by name. Only names of tools the agent has.
   */
  allowedTools?: string[];
  /** Publish in the same request. A listing that is already published stays as it is. */
  publish?: boolean;
}

export const LISTING_SELLS = ["use", "copies"] as const;
export type ListingSells = (typeof LISTING_SELLS)[number];

// ============================================
// Constants
// ============================================

export const CATEGORIES = [
  { id: "customer-support", label: "Customer Support", icon: "headphones" },
  { id: "coding", label: "Coding & Development", icon: "code" },
  { id: "research", label: "Research & Analysis", icon: "search" },
  { id: "automation", label: "Workflow Automation", icon: "zap" },
  { id: "creative", label: "Content & Creative", icon: "sparkles" },
  { id: "other", label: "Other", icon: "grid" },
] as const;

export const PRICING_MODELS = [
  { id: "free", label: "Free" },
  { id: "per_request", label: "Pay per Request" },
  { id: "monthly", label: "Monthly Subscription" },
  { id: "tokenized", label: "Token Gated" },
] as const;

/**
 * The prices a pricing model keeps. Per-request and monthly need their
 * price; free and token-gated carry none (a stale price would otherwise
 * be shown or charged after a switch).
 */
export function normalizeListingPricing(
  pricingModel: ListingCreateParams["pricingModel"],
  prices: { pricePerRequestCents?: number | null; monthlyPriceCents?: number | null }
): { pricePerRequestCents: bigint | null; monthlyPriceCents: bigint | null } {
  if (pricingModel === "per_request") {
    if (!prices.pricePerRequestCents) {
      throw new Error("Price per request is required for per_request pricing model");
    }
    return { pricePerRequestCents: BigInt(prices.pricePerRequestCents), monthlyPriceCents: null };
  }
  if (pricingModel === "monthly") {
    if (!prices.monthlyPriceCents) {
      throw new Error("Monthly price is required for monthly pricing model");
    }
    return { pricePerRequestCents: null, monthlyPriceCents: BigInt(prices.monthlyPriceCents) };
  }
  return { pricePerRequestCents: null, monthlyPriceCents: null };
}

// Revenue split: 90% creator, 10% platform
export const CREATOR_REVENUE_SHARE = 0.9;
export const PLATFORM_FEE_SHARE = 0.1;

// ============================================
// Search & Discovery
// ============================================

export async function searchListings(params: ListingSearchParams) {
  const {
    query,
    category,
    pricingModel,
    minRating = 0,
    sortBy = "popular",
    page = 1,
    limit = 20,
  } = params;

  const where: any = {
    status: "published",
    avgRating: { gte: minRating },
  };

  if (category && category !== "all") {
    where.category = category;
  }

  if (pricingModel && pricingModel !== "all") {
    where.pricingModel = pricingModel;
  }

  if (query) {
    where.OR = [
      { title: { contains: query, mode: "insensitive" } },
      { shortDescription: { contains: query, mode: "insensitive" } },
      { publisherName: { contains: query, mode: "insensitive" } },
    ];
  }

  // Determine sort order
  let orderBy: any = {};
  switch (sortBy) {
    case "popular":
      orderBy = { totalInstalls: "desc" };
      break;
    case "rating":
      orderBy = { avgRating: "desc" };
      break;
    case "newest":
      orderBy = { publishedAt: "desc" };
      break;
    case "price_low":
      orderBy = { pricePerRequestCents: "asc" };
      break;
    case "price_high":
      orderBy = { pricePerRequestCents: "desc" };
      break;
    default:
      orderBy = { totalInstalls: "desc" };
  }

  const skip = (page - 1) * limit;

  const [listings, total] = await Promise.all([
    prisma.agentListing.findMany({
      where,
      // Pro/Enterprise publishers rank first within popularity, rating and
      // recency sorts; an explicit price sort stays a pure price order.
      orderBy: sortBy === "price_low" || sortBy === "price_high"
        ? orderBy
        : [{ priorityPlacement: "desc" }, orderBy],
      skip,
      take: limit,
      include: {
        agent: {
          select: LISTING_AGENT_COLUMNS,
        },
        agentToken: LISTING_TOKEN_MARK,
      },
    }),
    prisma.agentListing.count({ where }),
  ]);

  return {
    listings: listings.map(formatListingForPublic),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getListingBySlug(slug: string) {
  const listing = await prisma.agentListing.findUnique({
    where: { slug, status: "published" },
    include: {
      agent: {
        select: {
          id: true,
          // slug + isPublic let the detail page link to the public
          // /a/:slug transparency feed (only when the agent is public).
          slug: true,
          isPublic: true,
          framework: true,
          agentKind: true,
          tags: true,
          publicHandle: true,
        },
      },
      agentToken: LISTING_TOKEN_MARK,
    },
  });

  if (!listing) {
    return null;
  }

  return formatListingForPublic(listing);
}

// ============================================
// Try it
// ============================================

/**
 * A published listing as its Try it panel describes it: which model the
 * installed agent is set up with and which tools it has. Published only -
 * a draft cannot be tried by the public.
 */
export async function getListingTrialPreview(slug: string) {
  const listing = await prisma.agentListing.findFirst({
    where: { slug, status: "published" },
    select: {
      id: true,
      agent: { select: { entrypoint: true, agentKind: true, kindConfig: true, modelConfig: true, tools: true } },
    },
  });
  if (!listing) return null;

  const modelConfig =
    typeof listing.agent.modelConfig === "object" && listing.agent.modelConfig !== null
      ? (listing.agent.modelConfig as Record<string, unknown>)
      : {};
  const tools = Array.isArray(listing.agent.tools) ? (listing.agent.tools as unknown[]) : [];
  return {
    id: listing.id,
    agentEntrypoint: listing.agent.entrypoint,
    agentKind: isAgentKind(listing.agent.agentKind) ? listing.agent.agentKind : DEFAULT_AGENT_KIND,
    // The task form is made from this by the caller (publicTaskForm); the
    // rest of it goes nowhere.
    agentKindConfig: listing.agent.kindConfig,
    // Resolved to a model id by the caller, with the rule agent chat uses.
    agentModelConfig: modelConfig,
    agentTools: tools
      .map((tool) => (tool as { name?: unknown } | null)?.name)
      .filter((name): name is string => typeof name === "string"),
  };
}

/** A listing's Try it settings, for its publisher only. */
export async function getListingTrialSettings(orgId: string, listingId: string) {
  const listing = await prisma.agentListing.findFirst({
    where: { id: listingId, publisherId: orgId },
    select: { status: true, trialFundedDailyCap: true },
  });
  return listing ? { status: listing.status, fundedDailyCap: listing.trialFundedDailyCap } : null;
}

/**
 * Sets how many Try it messages a day the publisher pays for, above the
 * platform's. False when the listing is not this organization's.
 */
export async function setListingTrialFundedCap(orgId: string, listingId: string, cap: number): Promise<boolean> {
  const updated = await prisma.agentListing.updateMany({
    where: { id: listingId, publisherId: orgId },
    data: { trialFundedDailyCap: cap },
  });
  return updated.count > 0;
}

/**
 * What the publisher has paid for on one UTC day: the funded messages
 * counted, and the cents of the charges that were not refunded.
 */
export async function getListingTrialFundedUsage(listingId: string, day: string) {
  const [usage, spent] = await Promise.all([
    prisma.trialDailyUsage.findUnique({
      where: { listingId_day: { listingId, day } },
      select: { fundedCount: true },
    }),
    prisma.trialCharge.aggregate({
      where: { listingId, day, status: { in: ["held", "settled"] } },
      _sum: { amountCents: true },
    }),
  ]);
  return {
    fundedCount: usage?.fundedCount ?? 0,
    fundedSpentCents: Number(spent._sum.amountCents ?? 0n),
  };
}

export async function getListingById(id: string) {
  const listing = await prisma.agentListing.findUnique({
    where: { id },
    include: {
      agent: {
        select: LISTING_AGENT_COLUMNS,
      },
    },
  });

  return listing ? formatListingForPublic(listing) : null;
}

export async function getFeaturedListings(limit = 6) {
  const listings = await prisma.agentListing.findMany({
    where: {
      status: "published",
      isFeatured: true,
    },
    orderBy: { totalInstalls: "desc" },
    take: limit,
    include: {
      agent: {
        select: LISTING_AGENT_COLUMNS,
      },
      agentToken: LISTING_TOKEN_MARK,
    },
  });

  return listings.map(formatListingForPublic);
}

export async function getCategoryStats() {
  const stats = await prisma.agentListing.groupBy({
    by: ["category"],
    where: { status: "published" },
    _count: { id: true },
  });

  return CATEGORIES.map((cat) => ({
    ...cat,
    count: stats.find((s) => s.category === cat.id)?._count.id ?? 0,
  }));
}

// ============================================
// Reviews
// ============================================

export async function getListingReviews(
  listingId: string,
  page = 1,
  limit = 10
) {
  const skip = (page - 1) * limit;

  const [reviews, total] = await Promise.all([
    prisma.agentReview.findMany({
      where: { listingId },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      include: {
        reviewer: {
          select: {
            name: true,
          },
        },
      },
    }),
    prisma.agentReview.count({ where: { listingId } }),
  ]);

  return {
    reviews: reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      title: r.title,
      content: r.content,
      isVerified: r.isVerified,
      helpfulCount: r.helpfulCount,
      reviewerName: r.reviewer.name,
      createdAt: r.createdAt,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * A review is verified when the reviewer used what they are reviewing:
 * they installed the listing, or a job they hired from one of its
 * offerings completed.
 */
export async function isVerifiedReviewer(
  listingId: string,
  reviewerId: string,
  db: {
    agentInstall: { findUnique(args: any): Promise<unknown> };
    job: { findFirst(args: any): Promise<unknown> };
  } = prisma,
): Promise<boolean> {
  const install = await db.agentInstall.findUnique({
    where: {
      listingId_buyerId: { listingId, buyerId: reviewerId },
    },
  });
  if (install) return true;
  const job = await db.job.findFirst({
    where: { buyerId: reviewerId, status: "completed", offering: { listingId } },
    select: { id: true },
  });
  return job !== null && job !== undefined;
}

export async function createReview(
  listingId: string,
  reviewerId: string,
  data: { rating: number; title?: string; content?: string }
) {
  // The review moves the publisher's social score, so we need to know
  // whose reputation to recalc — and a review against a nonexistent
  // listing should fail here, not on the FK.
  const listing = await prisma.agentListing.findUnique({
    where: { id: listingId },
    select: { publisherId: true },
  });

  if (!listing) {
    throw new Error("Listing not found");
  }

  // Check if user has already reviewed
  const existing = await prisma.agentReview.findUnique({
    where: {
      listingId_reviewerId: { listingId, reviewerId },
    },
  });

  if (existing) {
    throw new Error("You have already reviewed this agent");
  }

  const isVerified = await isVerifiedReviewer(listingId, reviewerId);

  const review = await prisma.agentReview.create({
    data: {
      listingId,
      reviewerId,
      rating: data.rating,
      title: data.title,
      content: data.content,
      isVerified,
    },
  });

  // Update listing stats
  await updateListingRatingStats(listingId);

  // Reviews feed the social leg of the reputation score; recalc so the
  // token-eligibility gate can actually move without a manual recalc.
  updatePublisherReputation(listing.publisherId).catch((err) =>
    logger.error(
      { err, listingId, publisherId: listing.publisherId },
      "Failed to recalc publisher reputation after review"
    )
  );

  return review;
}

async function updateListingRatingStats(listingId: string) {
  const stats = await prisma.agentReview.aggregate({
    where: { listingId },
    _avg: { rating: true },
    _count: { id: true },
  });

  await prisma.agentListing.update({
    where: { id: listingId },
    data: {
      avgRating: stats._avg.rating ?? 0,
      reviewCount: stats._count.id,
    },
  });
}

// ============================================
// Publisher Profile
// ============================================

export async function getPublisherProfile(slug: string) {
  const profile = await prisma.publisherProfile.findUnique({
    where: { slug },
    include: {
      org: {
        include: {
          publishedListings: {
            where: { status: "published" },
            orderBy: { totalInstalls: "desc" },
            take: 10,
            include: {
              agent: {
                select: LISTING_AGENT_COLUMNS,
              },
            },
          },
        },
      },
    },
  });

  if (!profile) {
    return null;
  }

  return {
    displayName: profile.displayName,
    slug: profile.slug,
    bio: profile.bio,
    avatarUrl: profile.avatarUrl,
    website: profile.website,
    twitter: profile.twitter,
    github: profile.github,
    isVerified: profile.isVerified,
    totalListings: profile.totalListings,
    totalInstalls: profile.totalInstalls,
    createdAt: profile.createdAt,
    listings: profile.org.publishedListings.map(formatListingForPublic),
  };
}

// ============================================
// Listing Management (Protected)
// ============================================

/** The agent columns every listing answer is drawn from. Never its instructions or its tools. */
/**
 * Whether the listing has a token, and nothing of the token itself. The
 * marketplace shows a "Receipts" mark on a listing that has one.
 */
const LISTING_TOKEN_MARK = { select: { id: true } } as const;

const LISTING_AGENT_COLUMNS = {
  id: true,
  framework: true,
  agentKind: true,
  tags: true,
  publicHandle: true,
} as const;

/** The same, with the name a buyer knows the agent by. */
const LICENCE_AGENT_COLUMNS = { ...LISTING_AGENT_COLUMNS, name: true } as const;

/** What deciding whether an agent can be sold needs of it. */
const SELLABLE_AGENT_COLUMNS = {
  id: true,
  entrypoint: true,
  agentKind: true,
  tools: true,
} as const;

interface SellableAgent {
  id: string;
  entrypoint?: string | null;
  agentKind?: string | null;
  tools?: unknown;
}

/** The smallest monthly price, in cents. */
export const MIN_MONTHLY_PRICE_CENTS = 100n;

export const LISTING_MESSAGES = {
  marketplaceCopy: "This agent came from the marketplace, so it cannot be sold again.",
  graphAgent:
    "This agent answers through its graph, so use of it cannot be sold yet. You can sell it as a task with guaranteed delivery, or sell copies.",
  tokenAccess:
    "Use of an agent cannot be sold to token holders yet. Choose Free, Pay per use or Monthly, or sell copies instead.",
  listingExists: "This agent already has a listing. Edit that listing instead.",
  nameTaken: "Another listing was saved under that name at the same moment. Try again.",
  monthlyFloor: "The price per month must be at least $1.00.",
  perMessageFloor: "The price per message must be at least $0.05.",
  perRunFloor: "The price per run must be at least $0.05.",
  scheduledPerUse: "An agent that runs on its own can be free or sold by the month, not per use.",
  unknownTool: (name: string) => `Your agent has no tool named "${name}".`,
} as const;

/**
 * A listing that cannot be saved or published as asked. The message is a
 * plain sentence for the person; `body` is the whole answer when it is a
 * 400 `validation_failed` with its fields.
 */
export class ListingError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
    readonly body?: ValidationFailureBody,
  ) {
    super(message);
    this.name = "ListingError";
  }
}

function listingInvalid(field: string, message: string): ListingError {
  return new ListingError(400, "validation_failed", message, validationFailureFromFields({ [field]: message }));
}

interface ListingTerms {
  sells: string;
  pricingModel: string;
  pricePerRequestCents: bigint | null;
  monthlyPriceCents: bigint | null;
}

/**
 * Refuses terms an agent cannot be sold on. Pure.
 *
 * Use of an agent is sold free, per use or by the month, and only for an
 * agent that answers from its instructions: a graph run looks up a copy by
 * itself and would run free. A per-use price is 5 cents or more, so the
 * platform's share never rounds to nothing, and is not offered for an agent
 * that runs on its own. A listing that sells copies is held to the monthly
 * floor only, as before.
 */
export function assertSellable(agent: SellableAgent, terms: ListingTerms): void {
  if (
    terms.pricingModel === "monthly" &&
    terms.monthlyPriceCents !== null &&
    terms.monthlyPriceCents < MIN_MONTHLY_PRICE_CENTS
  ) {
    throw listingInvalid("monthlyPriceCents", LISTING_MESSAGES.monthlyFloor);
  }
  if (terms.sells !== "use") return;
  if (agent.entrypoint === "graph") {
    throw new ListingError(409, "graph_agent_not_supported", LISTING_MESSAGES.graphAgent);
  }
  if (terms.pricingModel === "tokenized") {
    throw new ListingError(400, "token_access_not_available", LISTING_MESSAGES.tokenAccess);
  }
  if (terms.pricingModel === "per_request") {
    if (agent.agentKind === "scheduled") throw listingInvalid("pricingModel", LISTING_MESSAGES.scheduledPerUse);
    if ((terms.pricePerRequestCents ?? 0n) < MIN_PRICE_PER_USE_CENTS) {
      throw listingInvalid(
        "pricePerRequestCents",
        agent.agentKind === "task" ? LISTING_MESSAGES.perRunFloor : LISTING_MESSAGES.perMessageFloor,
      );
    }
  }
}

/** The tools named, each once, when the agent has every one of them. */
function allowedToolsOf(agent: SellableAgent, names: string[]): string[] {
  const has = new Set(
    (Array.isArray(agent.tools) ? (agent.tools as unknown[]) : [])
      .map((tool) => (tool as { name?: unknown } | null)?.name)
      .filter((name): name is string => typeof name === "string"),
  );
  const allowed = [...new Set(names)];
  for (const name of allowed) {
    if (!has.has(name)) throw listingInvalid("allowedTools", LISTING_MESSAGES.unknownTool(name));
  }
  return allowed;
}

/**
 * Whether this agent is a buyer's copy from the marketplace. A copy carries
 * its creator's instructions, so it is not sold on, as use or as copies.
 */
async function isMarketplaceCopy(agentId: string): Promise<boolean> {
  const install = await prisma.agentInstall.findFirst({
    where: { clonedAgentId: agentId },
    select: { id: true },
  });
  return install !== null && install !== undefined;
}

/** Two listings reaching for one address at once: the loser looks again. */
const PAGE_ATTEMPTS = 3;

/**
 * Runs a transaction that may give the agent its public address. A write
 * that loses the address to another agent ends the Postgres transaction
 * (isHandleConflict), so the whole of it is run again and then sees the
 * address as taken.
 */
async function inPageTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(fn);
    } catch (err) {
      if (err instanceof PublicLinkError) {
        throw new ListingError(err.status, err.code, err.message, err.body);
      }
      if (!isHandleConflict(err) || attempt >= PAGE_ATTEMPTS) throw err;
    }
  }
}

/**
 * The page of an agent whose use is on sale, set inside the transaction
 * that puts it on sale: the page is public and has an address, and it has
 * its page key. Free use turns the key on, because the page is how people
 * use it; a price turns it off, because free use on the page would be the
 * paid thing for nothing. A self-running agent shows its results to
 * everyone when free and to subscribers only (through the paid routes) when
 * sold by the month.
 *
 * The pause is written whether or not the key reads as on. A write that
 * waited for a key seen as on would match nothing against a key that
 * another request is turning on at this moment, and would not wait for it:
 * both would commit and the priced page would be left on. Written always,
 * it takes the key's row lock, so it lands after that "on" and overrides
 * it, or before it, and then the other request sees the price and stops.
 */
async function applyUsePage(
  tx: Prisma.TransactionClient,
  args: {
    orgId: string;
    agentId: string;
    agentKind: string | null | undefined;
    paid: boolean;
    /**
     * "set" when free use is starting: the listing goes on sale free, or moves
     * to free. "keep" when a free listing that was already on sale is saved
     * again: the owner may have hidden the results since, and a save of the
     * listing must not show them again.
     */
    results: "set" | "keep";
  },
): Promise<void> {
  const page = tx as unknown as PublicLinkTx;
  const { orgId, agentId } = args;
  await ensurePublicPage(page, { orgId, agentId });
  await ensurePageKey(page, { orgId, agentId });
  if (args.paid) {
    await page.widgetKey.updateMany({
      where: { pageOfAgentId: agentId, orgId, revokedAt: null },
      data: { enabled: false },
    });
  } else {
    await setPageUse(page, { orgId, agentId, enabled: true });
  }
  if (args.agentKind === "scheduled" && (args.paid || args.results === "set")) {
    await tx.agent.updateMany({ where: { id: agentId, orgId }, data: { publicResults: !args.paid } });
  }
}

export async function createListing(
  orgId: string,
  orgName: string,
  params: ListingCreateParams
) {
  // Verify agent belongs to org
  const agent = await prisma.agent.findFirst({
    where: { id: params.agentId, orgId },
  });

  if (!agent) {
    throw new Error("Agent not found or does not belong to your organization");
  }

  // A new listing sells use unless copies are asked for by name.
  const sells: ListingSells = params.sells ?? "use";

  if (await isMarketplaceCopy(agent.id)) {
    throw new ListingError(409, "marketplace_copy", LISTING_MESSAGES.marketplaceCopy);
  }

  const prices = normalizeListingPricing(params.pricingModel, params);
  assertSellable(agent, { sells, pricingModel: params.pricingModel, ...prices });
  const useAllowedTools = allowedToolsOf(agent, params.allowedTools ?? []);

  // Check if listing already exists for this agent
  const existing = await prisma.agentListing.findUnique({
    where: { agentId: params.agentId },
  });

  if (existing) {
    throw new ListingError(409, "listing_exists", LISTING_MESSAGES.listingExists);
  }

  // Generate slug
  const baseSlug = params.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  let slug = baseSlug;
  let counter = 1;
  while (await prisma.agentListing.findUnique({ where: { slug } })) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  // Paid plans rank ahead in the marketplace from the first publish.
  const { limits: planLimits } = await getOrgPlan(orgId).catch(() => ({
    limits: { priorityPlacement: false },
  }));

  const listing = await prisma.agentListing
    .create({
      data: {
        priorityPlacement: planLimits.priorityPlacement,
        agentId: params.agentId,
        title: params.title,
        slug,
        shortDescription: params.shortDescription,
        longDescription: params.longDescription,
        category: params.category,
        iconUrl: params.iconUrl,
        screenshots: params.screenshots ?? [],
        readme: params.readme,
        sells,
        useAllowedTools,
        pricingModel: params.pricingModel,
        ...prices,
        publisherId: orgId,
        publisherName: orgName,
        status: "draft",
      },
      include: {
        agent: {
          select: LISTING_AGENT_COLUMNS,
        },
      },
    })
    .catch((err) => {
      // Two requests for one agent, or two titles that give one slug, at the
      // same moment. Said in a sentence, never in the database's words.
      if (!isUniqueViolation(err)) throw err;
      const target = String((err as { meta?: { target?: unknown } }).meta?.target ?? "");
      throw target.includes("slug")
        ? new ListingError(409, "listing_name_taken", LISTING_MESSAGES.nameTaken)
        : new ListingError(409, "listing_exists", LISTING_MESSAGES.listingExists);
    });

  // Ensure publisher profile exists
  await ensurePublisherProfile(orgId, orgName);

  if (!params.publish) return formatListingForOwner(listing);

  await publishOwnListing(listing.id, orgId);
  const published = await prisma.agentListing.findUnique({
    where: { id: listing.id },
    include: { agent: { select: LISTING_AGENT_COLUMNS } },
  });
  return formatListingForOwner(published ?? listing);
}

export async function updateListing(
  listingId: string,
  orgId: string,
  params: Partial<ListingCreateParams>
) {
  const listing = await prisma.agentListing.findFirst({
    where: { id: listingId, publisherId: orgId },
    include: { agent: { select: SELLABLE_AGENT_COLUMNS } },
  });

  if (!listing) {
    throw new Error("Listing not found or you don't have permission to edit");
  }

  // Pricing is validated as a whole: the model that results from this
  // edit must have the price it needs, and drops the ones it doesn't.
  const pricingTouched =
    params.pricingModel !== undefined ||
    params.pricePerRequestCents !== undefined ||
    params.monthlyPriceCents !== undefined;
  const pricing = pricingTouched
    ? {
        pricingModel: params.pricingModel ?? listing.pricingModel,
        ...normalizeListingPricing(
          (params.pricingModel ?? listing.pricingModel) as ListingCreateParams["pricingModel"],
          {
            pricePerRequestCents:
              params.pricePerRequestCents !== undefined
                ? params.pricePerRequestCents
                : listing.pricePerRequestCents !== null
                ? Number(listing.pricePerRequestCents)
                : null,
            monthlyPriceCents:
              params.monthlyPriceCents !== undefined
                ? params.monthlyPriceCents
                : listing.monthlyPriceCents !== null
                ? Number(listing.monthlyPriceCents)
                : null,
          }
        ),
      }
    : null;

  // What the listing sells, and on what terms, once this edit is saved. An
  // edit that does not name what it sells leaves that as it is.
  const next: ListingTerms = {
    sells: params.sells ?? listing.sells,
    pricingModel: pricing?.pricingModel ?? listing.pricingModel,
    pricePerRequestCents: pricing ? pricing.pricePerRequestCents : listing.pricePerRequestCents,
    monthlyPriceCents: pricing ? pricing.monthlyPriceCents : listing.monthlyPriceCents,
  };
  const agent: SellableAgent = listing.agent ?? { id: listing.agentId };
  if (params.sells !== undefined && params.sells !== listing.sells && (await isMarketplaceCopy(listing.agentId))) {
    throw new ListingError(409, "marketplace_copy", LISTING_MESSAGES.marketplaceCopy);
  }
  if (pricingTouched || params.sells !== undefined || params.publish) assertSellable(agent, next);
  const useAllowedTools =
    params.allowedTools !== undefined ? allowedToolsOf(agent, params.allowedTools) : undefined;

  const publishing = params.publish === true && listing.status !== "published";
  if (
    publishing &&
    (!(params.title || listing.title) ||
      !(params.shortDescription || listing.shortDescription) ||
      !(params.category || listing.category))
  ) {
    throw new Error("Listing is missing required fields");
  }

  // The agent's page follows the listing while use of it is on sale. An
  // edit that names the price, what is sold, or publish may move the page,
  // so it is saved in a transaction and the page is set there from the row
  // as it was saved, never from the read above: another edit or a publish
  // may have committed since, and the row as saved is what is on sale. The
  // listing's row lock puts two such requests one after the other, and the
  // later one sets the page for what both left. Every other edit leaves the
  // page alone. Nothing is undone when a listing stops selling use: no
  // licence or subscription is ended here, access is decided from the rows
  // at each use (services/useAccess.ts), and a paid month runs to its end.
  const mayMovePage = pricingTouched || params.sells !== undefined || params.publish === true;
  // Free use was already on sale before this edit. A self-running agent's
  // results are shown when free use starts, not each time the listing is saved.
  const wasFreeUse = listing.status === "published" && listing.sells === "use" && !isPaidUse(listing);

  const write = {
    where: { id: listingId },
    data: {
      ...(params.title && { title: params.title }),
      ...(params.shortDescription && {
        shortDescription: params.shortDescription,
      }),
      ...(params.longDescription !== undefined && {
        longDescription: params.longDescription,
      }),
      ...(params.category && { category: params.category }),
      ...(params.iconUrl !== undefined && { iconUrl: params.iconUrl }),
      ...(params.screenshots && { screenshots: params.screenshots }),
      ...(params.readme !== undefined && { readme: params.readme }),
      ...(pricing ?? {}),
      ...(params.sells !== undefined && { sells: params.sells }),
      ...(useAllowedTools !== undefined && { useAllowedTools }),
      ...(publishing && { status: "published", publishedAt: new Date() }),
    },
    include: {
      agent: {
        select: LISTING_AGENT_COLUMNS,
      },
    },
  };

  const updated = mayMovePage
    ? await inPageTransaction(async (tx) => {
        const saved = await tx.agentListing.update(write);
        if (saved.status !== "published") return saved;
        // The sale rules, on the terms that are on sale once this commits and
        // on the agent as it is now: it may have changed since the read above.
        const agentNow: SellableAgent =
          (await tx.agent.findFirst({ where: { id: listing.agentId, orgId }, select: SELLABLE_AGENT_COLUMNS })) ?? agent;
        assertSellable(agentNow, saved);
        if (saved.sells !== "use") return saved;
        await applyUsePage(tx, {
          orgId,
          agentId: listing.agentId,
          agentKind: agentNow.agentKind,
          paid: isPaidUse(saved),
          results: wasFreeUse ? "keep" : "set",
        });
        // Read again: the page may have just been given its address.
        return (
          (await tx.agentListing.findUnique({
            where: { id: listingId },
            include: { agent: { select: LISTING_AGENT_COLUMNS } },
          })) ?? saved
        );
      })
    : await prisma.agentListing.update(write);

  if (publishing) {
    await updatePublisherStats(orgId);
    logger.info({ listingId, orgId }, "Listing published");
  }

  return formatListingForOwner(updated);
}

/**
 * Puts the organization's listing on sale. Publishing a listing that is
 * already published changes nothing and is not an error. False when there
 * was nothing to do.
 *
 * For a listing that sells use, the agent's page is set in the same
 * transaction (applyUsePage), from the listing as it is read again after
 * the status is written: a price saved on the draft a moment earlier is
 * what is published, or what is refused.
 */
async function publishOwnListing(listingId: string, orgId: string): Promise<boolean> {
  const listing = await prisma.agentListing.findFirst({
    where: { id: listingId, publisherId: orgId },
    include: { agent: { select: SELLABLE_AGENT_COLUMNS } },
  });

  if (!listing) {
    throw new Error("Listing not found");
  }

  if (listing.status === "published") return false;

  // Validate listing has required fields
  if (!listing.title || !listing.shortDescription || !listing.category) {
    throw new Error("Listing is missing required fields");
  }

  // The agent may have changed since the draft was saved.
  const agent: SellableAgent = listing.agent ?? { id: listing.agentId };
  assertSellable(agent, listing);

  const published = await inPageTransaction(async (tx) => {
    // Compare-and-set: of two publishes at once, one moves the listing and
    // the other finds nothing to do.
    const moved = await tx.agentListing.updateMany({
      where: { id: listingId, publisherId: orgId, status: { not: "published" } },
      data: {
        status: "published",
        publishedAt: new Date(),
      },
    });
    if (moved.count !== 1) return false;
    // The row as it goes on sale. The read before the transaction may be
    // behind an edit that committed since; this one is made holding the
    // listing's row lock, so no edit lands between it and the commit.
    const onSale = await tx.agentListing.findUnique({
      where: { id: listingId },
      include: { agent: { select: SELLABLE_AGENT_COLUMNS } },
    });
    if (!onSale) throw new Error("Listing not found");
    const agentNow: SellableAgent = onSale.agent ?? agent;
    assertSellable(agentNow, onSale);
    if (onSale.sells === "use") {
      await applyUsePage(tx, {
        orgId,
        agentId: onSale.agentId,
        agentKind: agentNow.agentKind,
        paid: isPaidUse(onSale),
        results: "set",
      });
    }
    return true;
  });
  if (!published) return false;

  // Update publisher stats
  await updatePublisherStats(orgId);

  logger.info({ listingId, orgId }, "Listing published");
  return true;
}

export async function publishListing(listingId: string, orgId: string) {
  await publishOwnListing(listingId, orgId);
  return prisma.agentListing.findUnique({ where: { id: listingId } });
}

export async function archiveListing(listingId: string, orgId: string) {
  const listing = await prisma.agentListing.findFirst({
    where: { id: listingId, publisherId: orgId },
  });

  if (!listing) {
    throw new Error("Listing not found");
  }

  const updated = await prisma.agentListing.update({
    where: { id: listingId },
    data: { status: "archived" },
  });

  await updatePublisherStats(orgId);

  return updated;
}

/**
 * How a listing's pause is asked about and its marker brought in line
 * (services/listingPause.ts). The real ones when omitted.
 */
export interface ListingPauseHooks {
  listingPausedNow?: typeof listingPausedNow;
  reconcileListingPauses?: typeof reconcileListingPauses;
}

export async function getMyListings(orgId: string, hooks: ListingPauseHooks = {}) {
  const listings = await prisma.agentListing.findMany({
    where: { publisherId: orgId },
    orderBy: { createdAt: "desc" },
    include: {
      agent: {
        // The organization and the model are read to ask about a pause;
        // neither is part of the answer.
        select: { ...LISTING_AGENT_COLUMNS, orgId: true, modelConfig: true },
      },
    },
  });

  // Whether each listing is paused, asked at this moment and never read from
  // the marker; the marker only says since when. Asked only where the agent
  // is set to a model its organization runs: no other listing can be paused.
  // When it cannot be answered the listing is shown as not paused; nothing
  // is decided by this list.
  const pausedNow = hooks.listingPausedNow ?? listingPausedNow;
  const pausedOf = async (listing: (typeof listings)[number]): Promise<{ since: string | null } | null> => {
    const agent = listing.agent;
    const modelId = agent
      ? resolveAgentModelId({ modelConfig: agent.modelConfig, availableFreeModelIds: [] })
      : null;
    if (!agent || !modelId || !modelId.startsWith(HOSTED_MODEL_PREFIX)) return null;
    try {
      if (!(await pausedNow({ listing, agent }))) return null;
      return { since: listing.pausedSince ? listing.pausedSince.toISOString() : null };
    } catch (err) {
      logger.warn({ err, listingId: listing.id }, "Could not ask whether a listing is paused; shown as not paused");
      return null;
    }
  };
  const paused = await Promise.all(listings.map(pausedOf));

  // Who holds what, per listing: copies in use, people using the agent
  // itself, and subscriptions that grant access right now.
  const listingIds = listings.map((listing) => listing.id);
  const [licences, subscriptions] =
    listingIds.length > 0
      ? await Promise.all([
          prisma.agentInstall.findMany({
            where: { listingId: { in: listingIds }, status: "active" },
            select: { listingId: true, kind: true },
          }),
          prisma.agentSubscription.findMany({
            where: { listingId: { in: listingIds }, status: { in: ["active", "past_due"] } },
            select: { listingId: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
          }),
        ])
      : [[], []];
  // The plans on offer on each listing, with how many people are on each.
  const plans = await readOwnerPlans(prisma, listingIds);
  const now = new Date();
  const buyersOf = (listingId: string) => ({
    copies: licences.filter((l) => l.listingId === listingId && l.kind !== "use").length,
    using: licences.filter((l) => l.listingId === listingId && l.kind === "use").length,
    subscribed: subscriptions.filter((s) => s.listingId === listingId && subscriptionGrantsAccess(s, now)).length,
  });

  return listings.map((listing, index) => ({
    ...formatListingForOwner(listing),
    buyers: buyersOf(listing.id),
    // In the order a buyer sees them. No buyer is named.
    plans: plans.get(listing.id) ?? [],
    // null when the listing is not paused at this moment.
    paused: paused[index]!,
  }));
}

/**
 * Replace the plans of a listing with the set its creator sends
 * (services/listingPlanStore.ts): a plan sent with its id is changed in
 * place, one left out is retired, one with no id is new. People already on a
 * plan keep the terms they agreed to. Answers the plans as they are now.
 *
 * Throws ListingError: 400 validation_failed with a sentence for each field,
 * 404 listing_not_found, 409 plans_not_available for a listing that cannot
 * have plans, and 409 plans_changed when another save got there first.
 */
export async function setListingPlans(listingId: string, orgId: string, plans: PlanInput[]): Promise<OwnerPlan[]> {
  const result = await replaceListingPlans({ listingId, orgId, plans });
  if (!result.ok) throw new ListingError(result.status, result.code, result.message, result.body);
  logger.info({ listingId, orgId, plans: result.plans.length }, "The plans of a listing were set");
  return result.plans;
}

// ============================================
// Helpers
// ============================================

/** A listing as its publisher sees it: the public answer plus what only they set. */
function formatListingForOwner(listing: any) {
  return {
    ...formatListingForPublic(listing),
    allowedTools: Array.isArray(listing.useAllowedTools) ? (listing.useAllowedTools as string[]) : [],
  };
}

function formatListingForPublic(listing: any) {
  // What one payment buys, for a listing that sells use at a price. A
  // listing that sells copies, or use for free, has no unit.
  const unit: UseUnit | null =
    listing.sells === "use" && isPaidUse(listing) ? useUnitOf(listing.agent?.agentKind, listing.pricingModel) : null;
  return {
    id: listing.id,
    agentId: listing.agentId,
    title: listing.title,
    slug: listing.slug,
    shortDescription: listing.shortDescription,
    longDescription: listing.longDescription,
    category: listing.category,
    iconUrl: listing.iconUrl,
    screenshots: listing.screenshots,
    readme: listing.readme,
    // "use": people use the creator's agent on its page or through the API
    // and get no copy. "copies": a buyer installs their own copy.
    sells: listing.sells === "use" ? "use" : "copies",
    unit,
    // Said only by the reads that looked: search, featured and the listing page.
    ...(listing.agentToken !== undefined && { hasToken: listing.agentToken !== null }),
    pricingModel: listing.pricingModel,
    pricePerRequestCents: listing.pricePerRequestCents
      ? Number(listing.pricePerRequestCents)
      : null,
    monthlyPriceCents: listing.monthlyPriceCents
      ? Number(listing.monthlyPriceCents)
      : null,
    publisherId: listing.publisherId,
    publisherName: listing.publisherName,
    status: listing.status,
    isFeatured: listing.isFeatured,
    totalInstalls: listing.totalInstalls,
    activeInstalls: listing.activeInstalls,
    avgRating: listing.avgRating,
    reviewCount: listing.reviewCount,
    totalRequests: listing.totalRequests
      ? Number(listing.totalRequests)
      : 0,
    publishedAt: listing.publishedAt,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    // Try it is on for every published listing; there is no switch to read.
    trial: { enabled: listing.status === "published" },
    agent: listing.agent
      ? {
          id: listing.agent.id,
          framework: listing.agent.framework,
          // What kind of agent the listing is: a chat, a task with a form,
          // or one that runs on its own.
          agentKind: isAgentKind(listing.agent.agentKind) ? listing.agent.agentKind : DEFAULT_AGENT_KIND,
          tags: listing.agent.tags,
          // The agent's address, /a/<handle>: where a listing that sells use
          // is used. null until the agent has a page.
          handle: listing.agent.publicHandle ?? null,
          // Present only on selects that ask for them (getListingBySlug);
          // undefined elsewhere.
          slug: listing.agent.slug,
          isPublic: listing.agent.isPublic,
        }
      : undefined,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

/**
 * The org's publisher profile (its payout balance), created if missing.
 * Safe to call concurrently: never call it inside a $transaction.
 */
export async function ensurePublisherProfile(orgId: string, orgName: string) {
  const baseSlug =
    orgName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "publisher";

  // Check-then-insert races with itself: two requests for the same org
  // (the loser re-reads the winner's row), or two orgs whose names give
  // the same slug (the loser moves to the next suffix). The last attempt
  // uses the org id, which cannot collide.
  for (let attempt = 0; attempt < 6; attempt++) {
    const existing = await prisma.publisherProfile.findUnique({ where: { orgId } });
    if (existing) return existing;

    let slug = attempt < 5 ? baseSlug : `org-${orgId}`;
    let counter = 1;
    while (await prisma.publisherProfile.findUnique({ where: { slug } })) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    try {
      return await prisma.publisherProfile.create({
        data: { orgId, displayName: orgName, slug },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("Could not create the publisher profile. Please try again.");
}

async function updatePublisherStats(orgId: string) {
  const stats = await prisma.agentListing.aggregate({
    where: { publisherId: orgId, status: "published" },
    _count: { id: true },
    _sum: { totalInstalls: true },
  });

  await prisma.publisherProfile.update({
    where: { orgId },
    data: {
      totalListings: stats._count.id,
      totalInstalls: stats._sum.totalInstalls ?? 0,
    },
  });
}

// ============================================
// Install / Deploy Flow
// ============================================

/**
 * The listing's pricing is not what the buyer agreed to: the publisher
 * changed it after they subscribed or installed, or between the buyer
 * seeing a price and confirming it. Continuing means accepting the pricing
 * carried here, explicitly.
 */
export class PricingChangedError extends Error {
  readonly code = "pricing_changed";
  constructor(
    readonly listingTitle: string,
    readonly pricing: {
      pricingModel: string;
      pricePerRequestCents: number | null;
      monthlyPriceCents: number | null;
    },
  ) {
    super(
      `The publisher changed the pricing of "${listingTitle}" after you agreed to it. Review and accept the new pricing to keep using it.`,
    );
    this.name = "PricingChangedError";
  }
}

/** A listing's pricing as a buyer is shown it, and as they send it back. */
export interface ListingPricingTerms {
  pricingModel: string;
  pricePerRequestCents: number | null;
  monthlyPriceCents: number | null;
}

function listingPricingTerms(listing: {
  pricingModel: string;
  pricePerRequestCents: bigint | null;
  monthlyPriceCents: bigint | null;
}): ListingPricingTerms {
  return {
    pricingModel: listing.pricingModel,
    pricePerRequestCents: listing.pricePerRequestCents !== null ? Number(listing.pricePerRequestCents) : null,
    monthlyPriceCents: listing.monthlyPriceCents !== null ? Number(listing.monthlyPriceCents) : null,
  };
}

/** The price that applies under each model; the other one is not compared. */
function samePricing(a: ListingPricingTerms, b: ListingPricingTerms): boolean {
  if (a.pricingModel !== b.pricingModel) return false;
  if (a.pricingModel === "per_request") return (a.pricePerRequestCents ?? 0) === (b.pricePerRequestCents ?? 0);
  if (a.pricingModel === "monthly") return (a.monthlyPriceCents ?? 0) === (b.monthlyPriceCents ?? 0);
  return true;
}

// ============================================
// The licence: four steps install and start-using share
// ============================================
//
// A buyer's licence is one AgentInstall row per listing and buyer, whether
// it is for their own copy (kind "copy") or for use of the creator's agent
// (kind "use"). installAgent and startUsing both run these four steps, in
// this order, so the two cannot drift on what a buyer agreed to or on what
// they are charged:
//
//   1. agreeToTerms               nothing is recorded that the buyer did not see
//   2. claimLicence, writeLicence the row is claimed, then written with the terms
//   3. settleLicenceSubscription  a monthly listing charges its first 30 days
//   4. countLicence               the listing's counters, once per licence

/** Another request holds the licence row or its subscription. Nothing was written or charged. */
export class LicenceClaimLostError extends Error {
  readonly code = "install_in_progress";
  constructor(message = "This agent is already being installed. Refresh to see it.") {
    super(message);
    this.name = "LicenceClaimLostError";
  }
}

/** What a licence records of the pricing its buyer agreed to. */
export interface AcceptedTerms {
  acceptedPricingModel: string;
  acceptedPricePerRequestCents: bigint | null;
  pricingAcceptedAt: Date;
}

interface LicenceListing {
  id: string;
  title: string;
  publisherId: string;
  pricingModel: string;
  pricePerRequestCents: bigint | null;
  monthlyPriceCents: bigint | null;
}

interface LicenceRow {
  id: string;
  status: string;
  clonedAgentId: string | null;
}

interface LicenceSubscription {
  id: string;
  status: string;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  endReason: string | null;
  /** The marker of a plan (AgentSubscription.includedUses). Null or absent = a month with no count. */
  includedUses?: number | null;
}

/**
 * What deciding a buyer's access reads of their subscription row besides its
 * dates. The count is the marker of a plan: a row read without it reads as a
 * month with no count, and agreeing to a price per use would then close a
 * plan that is running. The plan's status says whether its creator ended it:
 * such a plan is not renewed, so it gets no days of grace
 * (services/useAccess.ts).
 */
const LICENCE_SUBSCRIPTION_COLUMNS = {
  id: true,
  status: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  endReason: true,
  includedUses: true,
  plan: { select: { status: true } },
} as const;

/** The same of a row read whole. */
const WITH_PLAN_STATUS = { plan: { select: { status: true } } } as const;

/** The row with `planRetired` in place of the plan it was read with. */
function withPlanRetired<Row extends { plan?: { status: string } | null }>(
  sub: Row,
): Omit<Row, "plan"> & { planRetired: boolean } {
  const { plan, ...row } = sub;
  return { ...row, planRetired: plan?.status === "retired" };
}

/**
 * Step 1, the terms check. Answers what the licence will record, or throws
 * PricingChangedError carrying the pricing as it stands.
 *
 * `changed` is the caller's reading of the rows: the listing's pricing is
 * not what this buyer's licence agreed to. Moving onto it takes the buyer's
 * explicit acceptance. `expectedPricing` is what the buyer was looking at
 * when they confirmed: if the listing has moved since, what they confirmed
 * is not what would be recorded, so nothing is.
 */
export function agreeToTerms(
  listing: LicenceListing,
  opts: { changed: boolean; acceptNewPricing?: boolean; expectedPricing?: ListingPricingTerms },
): AcceptedTerms {
  const currentPricing = listingPricingTerms(listing);
  if (opts.changed && !opts.acceptNewPricing) {
    throw new PricingChangedError(listing.title, currentPricing);
  }
  // The publisher changed the price between the buyer seeing it and
  // confirming: what they confirmed is not what would be recorded.
  if (opts.expectedPricing && !samePricing(opts.expectedPricing, currentPricing)) {
    throw new PricingChangedError(listing.title, currentPricing);
  }
  // What this licence agrees to. Billing compares the listing against it at
  // every request (installAccess, useAccess), so a later increase pauses
  // the licence instead of being charged.
  return {
    acceptedPricingModel: listing.pricingModel,
    acceptedPricePerRequestCents:
      listing.pricingModel === "per_request" ? (listing.pricePerRequestCents ?? 0n) : null,
    pricingAcceptedAt: new Date(),
  };
}

/**
 * Step 2, first half: claim the existing licence row, by compare-and-swap
 * on what was read. For an uninstalled or suspended row this is exclusive:
 * of two concurrent requests one wins and the other stops here. For a row
 * that is already active it changes nothing a second request could miss, so
 * it is not a claim: there the exclusive step is the subscription's (or the
 * pricing acceptance's) in step 3, and nothing is charged before it.
 * Matching clonedAgentId as well stops a request that read the row before
 * another install repointed it: acting on the stale id would create a
 * second copy and orphan the first, which would then run unmetered.
 */
export async function claimLicence(tx: Prisma.TransactionClient, existing: LicenceRow | null): Promise<void> {
  if (!existing) return;
  const claimed = await tx.agentInstall.updateMany({
    where: {
      id: existing.id,
      status: existing.status,
      clonedAgentId: existing.clonedAgentId,
    },
    data: { status: "active", uninstalledAt: null },
  });
  if (claimed.count !== 1) {
    throw new LicenceClaimLostError();
  }
}

/**
 * Step 2, second half: write the licence with its kind and the terms the
 * buyer agreed to. A brand-new licence is protected by the unique
 * (listingId, buyerId): the loser of a race fails here and its whole
 * transaction rolls back.
 *
 * A copy names its copy. A use licence never does: on a new row
 * clonedAgentId is null, and on a row that once held a copy the copy is
 * left where it is, still pointed at and still metered by this row.
 */
export async function writeLicence(
  tx: Prisma.TransactionClient,
  args: {
    existing: LicenceRow | null;
    listingId: string;
    buyerId: string;
    terms: AcceptedTerms;
  } & ({ kind: "copy"; clonedAgentId: string } | { kind: "use" }),
) {
  const { existing, listingId, buyerId, terms } = args;
  if (args.kind === "copy") {
    return existing
      ? tx.agentInstall.update({
          where: { id: existing.id },
          data: { clonedAgentId: args.clonedAgentId, kind: "copy", ...terms },
        })
      : tx.agentInstall.create({
          data: { listingId, buyerId, clonedAgentId: args.clonedAgentId, kind: "copy", status: "active", ...terms },
        });
  }
  return existing
    ? tx.agentInstall.update({ where: { id: existing.id }, data: { kind: "use", ...terms } })
    : tx.agentInstall.create({
        data: { listingId, buyerId, clonedAgentId: null, kind: "use", status: "active", ...terms },
      });
}

/**
 * Step 3, the subscription. A monthly listing charges the first 30-day
 * period now, in this transaction (startMonthlySubscription claims the
 * subscription row before it debits, so two requests at once charge one
 * month). Under any other pricing, a subscription that is over or was ended
 * from the publisher's side is closed by the buyer's acceptance.
 */
export async function settleLicenceSubscription(
  tx: Prisma.TransactionClient,
  args: { listing: LicenceListing; buyerId: string; installId: string; existingSub: LicenceSubscription | null },
): Promise<{ id: string; currentPeriodEnd: Date } | null> {
  const { listing, buyerId, existingSub } = args;
  // Monthly listings charge the first 30-day period now.
  if (listing.pricingModel === "monthly") {
    const started = await startMonthlySubscription(tx as unknown as SubscriptionTx, {
      listing: {
        id: listing.id,
        title: listing.title,
        publisherId: listing.publisherId,
        monthlyPriceCents: listing.monthlyPriceCents ?? 0n,
      },
      buyerId,
      installId: args.installId,
    });
    return {
      id: started.subscription.id,
      currentPeriodEnd: started.subscription.currentPeriodEnd,
    };
  }
  // A plan is prepaid uses on top of the price per use, not in place of it.
  // Agreeing to a price per use never closes one: a plan that is running
  // keeps running, and the price agreed here is what comes after it.
  if (existingSub && existingSub.includedUses != null) return null;
  if (existingSub && (existingSub.endReason || subscriptionIsOpen(existingSub))) {
    // The buyer accepts the listing's current pricing in place of the
    // subscription: one the publisher's side ended, or one that ran out
    // and the renewal worker has not closed yet. Compare-and-swap on
    // what was read, so this is the exclusive step when the licence row
    // was already active, and the worker's own close (which matches an
    // open status) then misses instead of suspending the licence again.
    const accepted = await tx.agentSubscription.updateMany({
      where: {
        id: existingSub.id,
        status: existingSub.status,
        currentPeriodEnd: existingSub.currentPeriodEnd,
        endReason: existingSub.endReason,
      },
      data: {
        status: "cancelled",
        endReason: null,
        cancelAtPeriodEnd: false,
        ...(subscriptionIsOpen(existingSub) ? { cancelledAt: new Date() } : {}),
      },
    });
    if (accepted.count !== 1) {
      throw new LicenceClaimLostError();
    }
  }
  return null;
}

/**
 * Step 4, the counters. A lapsed (suspended) or already-active licence
 * still counts as active on the listing, so (re)subscribing or accepting a
 * price must not count it twice.
 */
export async function countLicence(
  tx: Prisma.TransactionClient,
  args: { listingId: string; previousStatus: string | undefined },
): Promise<void> {
  if (args.previousStatus === "suspended" || args.previousStatus === "active") return;
  await tx.agentListing.update({
    where: { id: args.listingId },
    data: {
      totalInstalls: { increment: 1 },
      activeInstalls: { increment: 1 },
    },
  });
}

/** After a licence is written: the publisher's totals, and the reputation legs they feed. */
export async function afterLicenceStarted(listingId: string, publisherId: string, what: string): Promise<void> {
  // Update publisher stats
  await updatePublisherStats(publisherId);

  // Installs feed the usage/social legs of the reputation score.
  updatePublisherReputation(publisherId).catch((err) =>
    logger.error({ err, listingId, publisherId }, `Failed to recalc publisher reputation after ${what}`)
  );
}

export const INSTALL_MESSAGES = {
  sellsUse: "You use this agent on its page. You do not get a copy.",
  alreadyUsing: "You already use this agent on its page. Stop using it before you install a copy.",
} as const;

/**
 * Installing was refused because of what the listing sells: use of the
 * creator's agent, not copies of it. Carries the agent's address so a
 * client can send the person to its page.
 */
export class InstallRefusedError extends Error {
  readonly status = 409;
  constructor(
    readonly code: "sells_use" | "already_using",
    message: string,
    /** /a/<handle>; null when the agent has no page. */
    readonly handle: string | null,
  ) {
    super(message);
    this.name = "InstallRefusedError";
  }
}

export async function installAgent(
  listingId: string,
  buyerId: string,
  opts: {
    acceptNewPricing?: boolean;
    /**
     * The pricing the buyer was looking at when they confirmed. If the
     * listing no longer matches it, nothing is installed, accepted or
     * charged: the buyer is shown the pricing as it stands instead.
     */
    expectedPricing?: ListingPricingTerms;
  } = {},
) {
  // Get the listing
  const listing = await prisma.agentListing.findUnique({
    where: { id: listingId },
    include: {
      // The graph is part of how a graph agent answers, so it is copied too.
      agent: { include: { graph: true } },
    },
  });

  if (!listing) {
    throw new Error("Listing not found");
  }

  if (listing.status !== "published") {
    throw new Error("This agent is not available for installation");
  }

  if (listing.publisherId === buyerId) {
    throw new Error("You published this agent; it is already in your workspace");
  }

  // A listing that sells use gives nobody a copy: the buyer uses the
  // creator's own agent and never receives its instructions.
  if (listing.sells === "use") {
    throw new InstallRefusedError("sells_use", INSTALL_MESSAGES.sellsUse, listing.agent?.publicHandle ?? null);
  }

  // Check if already installed
  const existingInstall = await prisma.agentInstall.findUnique({
    where: {
      listingId_buyerId: { listingId, buyerId },
    },
  });
  // The listing sold use when this buyer started, and their licence for it
  // still runs (a paid month, say). One licence per listing and buyer: it
  // is not turned into a copy underneath them.
  if (
    existingInstall?.kind === "use" &&
    (existingInstall.status === "active" || existingInstall.status === "suspended")
  ) {
    throw new InstallRefusedError("already_using", INSTALL_MESSAGES.alreadyUsing, listing.agent?.publicHandle ?? null);
  }
  const existingSub = existingInstall
    ? await prisma.agentSubscription.findUnique({
        where: { listingId_subscriberId: { listingId, subscriberId: buyerId } },
        // Without the count, on purpose. A copy install never meets a plan
        // that is running: a licence for use that is active or suspended was
        // refused above, and stopping use cancels the plan. What it can meet
        // is a plan row that was closed with a reason, and the buyer's
        // acceptance here must clear that reason as it does for any other
        // row, or the copy could never run.
        select: { id: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, endReason: true },
      })
    : null;

  let changed = false;
  if (existingInstall) {
    const access = installAccess({
      installStatus: existingInstall.status,
      listingStatus: listing.status,
      pricingModel: listing.pricingModel,
      pricePerRequestCents: listing.pricePerRequestCents,
      accepted: {
        pricingModel: existingInstall.acceptedPricingModel,
        pricePerRequestCents: existingInstall.acceptedPricePerRequestCents,
      },
      sub: existingSub,
    });
    // An install that runs is final. What is left: a monthly listing with
    // no paid-up subscription (this call subscribes), a pricing change the
    // buyer has to accept, and a reinstall.
    if (access === "subscribed" || access === "listing_pricing") {
      throw new Error("You have already installed this agent");
    }
    changed = access === "pricing_changed";
  }
  const acceptedPricing = agreeToTerms(listing, {
    changed,
    acceptNewPricing: opts.acceptNewPricing,
    expectedPricing: opts.expectedPricing,
  });

  // Token-gated: once the token exists, installing needs it too, so a
  // buyer learns what access requires before anything is created.
  if (listing.pricingModel === "tokenized") {
    const token = await prisma.agentToken.findUnique({
      where: { agentListingId: listing.id },
      select: { id: true, symbol: true, mintAddress: true },
    });
    if (token && !(await orgHoldsToken(prisma, { orgId: buyerId, tokenId: token.id }))) {
      throw new TokenRequiredError(listing.title, token);
    }
  }

  // Everything below commits together: the clone, the install row, the
  // counters and (for monthly listings) the first period's charge. Before,
  // these were separate writes, and a crash in between left a clone that
  // ran for free.
  const result = await prisma.$transaction(async (tx) => {
    await claimLicence(tx, existingInstall);

    // Reinstalling reuses the buyer's existing copy. Creating a new clone
    // each time left the previous one in the buyer's org with no install
    // row pointing at it: a free, unmetered copy of a paid agent.
    const previousClone = existingInstall?.clonedAgentId
      ? await tx.agent.findFirst({ where: { id: existingInstall.clonedAgentId, orgId: buyerId } })
      : null;

    const behaviour = cloneAgentBehaviour(listing.agent);
    const kind = cloneAgentKind(listing.agent);
    const clonedAgent =
      previousClone ??
      (await tx.agent.create({
        data: {
          orgId: buyerId,
          name: `${listing.agent.name} (Marketplace)`,
          slug: `${listing.agent.slug}-${Date.now()}`,
          description: listing.agent.description,
          framework: listing.agent.framework,
          systemPrompt: listing.agent.systemPrompt,
          tools: listing.agent.tools as any,
          modelConfig: listing.agent.modelConfig as any,
          sourceType: listing.agent.sourceType,
          sourceUrl: listing.agent.sourceUrl,
          sourceCode: listing.agent.sourceCode,
          // Never copy the publisher's secrets (provider keys, bot tokens)
          // into the buyer's org. The clone starts with no variables; buyers
          // set their own keys.
          version: listing.agent.version,
          isPublic: false,
          tags: listing.agent.tags,
          // The copy answers the way the original does: through its graph
          // when that is its entrypoint (see marketplaceClone.ts).
          entrypoint: behaviour.entrypoint,
          // And is used the way the original is: the same kind, with a copy
          // of its form or suggested schedule. The publisher's live schedule
          // and public page are not part of this.
          agentKind: kind.agentKind,
          kindConfig: kind.kindConfig ?? Prisma.DbNull,
          ...(behaviour.graph && {
            graph: {
              create: {
                nodes: behaviour.graph.nodes as any,
                edges: behaviour.graph.edges as any,
                ...(behaviour.graph.viewport !== null && { viewport: behaviour.graph.viewport as any }),
                isValid: behaviour.graph.isValid,
                ...(behaviour.graph.validationErrors !== null && {
                  validationErrors: behaviour.graph.validationErrors as any,
                }),
              },
            },
          }),
        },
      }));

    const install = await writeLicence(tx, {
      existing: existingInstall,
      listingId,
      buyerId,
      kind: "copy",
      clonedAgentId: clonedAgent.id,
      terms: acceptedPricing,
    });

    const subscription = await settleLicenceSubscription(tx, {
      listing,
      buyerId,
      installId: install.id,
      existingSub,
    });

    await countLicence(tx, { listingId, previousStatus: existingInstall?.status });

    return {
      install,
      clonedAgent,
      subscription,
      // Only a copy made now: a reused copy is the buyer's own and is left
      // as they have it.
      needsConfiguration: previousClone ? [] : (behaviour.graph?.needsConfiguration ?? []),
    };
  }).catch((err) => {
    // A concurrent first install (or first subscribe) won the unique
    // constraint and this transaction rolled back whole. Translated out
    // here, never inside the transaction.
    if (isUniqueViolation(err)) {
      throw new LicenceClaimLostError();
    }
    throw err;
  });

  await afterLicenceStarted(listingId, listing.publisherId, "install");

  logger.info(
    { listingId, buyerId, agentId: result.clonedAgent.id, subscription: result.subscription?.id },
    "Agent installed from marketplace"
  );

  return {
    install: result.install,
    subscription: result.subscription,
    clonedAgent: {
      id: result.clonedAgent.id,
      name: result.clonedAgent.name,
      slug: result.clonedAgent.slug,
      // Graph nodes whose request details or code stayed with the publisher
      // (marketplaceClone.ts); the buyer sets their own before it can run.
      needsConfiguration: result.needsConfiguration,
    },
  };
}

// ============================================
// Using the creator's agent
// ============================================

export const USE_START_MESSAGES = {
  expectedTermsRequired: "Send the price you were shown, so nothing is agreed to that you did not see.",
  listingNotFound: "Listing not found",
  sellsCopies: "This listing sells copies of the agent. Install it to get your own copy.",
  ownAgent: "This is your agent. You do not pay to use it.",
  tokenAccess: "Use of this agent is not on sale right now.",
  paused: LISTING_PAUSED_START_MESSAGE,
  cannotStart: "This agent cannot be started right now. Nothing was charged. Try again later.",
  claimLost: "This was just started by another request. Refresh to see it.",
} as const;

/** Starting to use an agent was refused before anything was written or charged. */
export class UseStartError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly code:
      | "expected_terms_required"
      | "listing_not_found"
      | "sells_copies"
      | "own_agent"
      | "not_offered"
      | "listing_paused"
      | "service_unavailable"
      | typeof COPY_MONTH_BLOCKS_USE,
    message: string,
    /** For copy_subscription_active: the day the copy's paid month ends. */
    readonly until?: Date,
  ) {
    super(message);
    this.name = "UseStartError";
  }
}

/** The agent a licence is for, as its buyer may know it. Never its instructions. */
export interface LicenceAgent {
  /** /a/<handle>; null when the agent has no page. */
  handle: string | null;
  name: string;
  agentKind: string;
}

function licenceAgentOf(agent: { publicHandle?: string | null; name?: string | null; agentKind?: string | null } | null | undefined): LicenceAgent {
  return {
    handle: agent?.publicHandle ?? null,
    name: agent?.name ?? "",
    agentKind: isAgentKind(agent?.agentKind) ? agent.agentKind : DEFAULT_AGENT_KIND,
  };
}

/** Where a buyer stands with an agent they use, or could. */
export interface UseState {
  access: UseAccess;
  /** What the buyer agreed to. null when there is no licence (free use needs none). */
  acceptedPricing: { pricingModel: string | null; pricePerRequestCents: number | null; acceptedAt: Date | null } | null;
  subscription: ReturnType<typeof formatSubscription> | null;
  agent: LicenceAgent;
}

// orgId and modelConfig are read to ask whether the listing is paused.
export const USE_LISTING_INCLUDE = {
  agent: {
    select: {
      id: true,
      name: true,
      agentKind: true,
      publicHandle: true,
      entrypoint: true,
      orgId: true,
      modelConfig: true,
    },
  },
} as const;

/** The buyer's state for a listing, from the rows as they are now. */
export async function readUseState(
  listing: {
    id: string;
    status: string;
    sells: string;
    pricingModel: string;
    pricePerRequestCents: bigint | null;
    agent: Parameters<typeof licenceAgentOf>[0];
  },
  buyerId: string,
): Promise<UseState> {
  const licence = await prisma.agentInstall.findUnique({
    where: { listingId_buyerId: { listingId: listing.id, buyerId } },
  });
  const subRow = licence
    ? await prisma.agentSubscription.findUnique({
        where: { listingId_subscriberId: { listingId: listing.id, subscriberId: buyerId } },
        include: WITH_PLAN_STATUS,
      })
    : null;
  const sub = subRow && withPlanRetired(subRow);
  return {
    access: useAccess({
      licence: licence
        ? {
            kind: licence.kind,
            status: licence.status,
            accepted: {
              pricingModel: licence.acceptedPricingModel,
              pricePerRequestCents: licence.acceptedPricePerRequestCents,
            },
          }
        : null,
      listing,
      sub,
    }),
    acceptedPricing: licence
      ? {
          pricingModel: licence.acceptedPricingModel,
          pricePerRequestCents:
            licence.acceptedPricePerRequestCents !== null && licence.acceptedPricePerRequestCents !== undefined
              ? Number(licence.acceptedPricePerRequestCents)
              : null,
          acceptedAt: licence.pricingAcceptedAt ?? null,
        }
      : null,
    subscription: sub ? formatSubscription(sub) : null,
    agent: licenceAgentOf(listing.agent),
  };
}

/**
 * Start using a creator's agent, or accept its current terms.
 *
 * Writes or claims the buyer's licence with kind "use" and the pricing they
 * agreed to. No copy is made: the buyer uses the creator's own agent on its
 * page or through the API, and nothing of the agent is written into their
 * organization. A price per use charges nothing here (each use is charged
 * when it is sent); a monthly price charges the first 30 days now, in the
 * same transaction as the licence, exactly as a monthly copy does.
 *
 * `expected` is the pricing the person was shown and is always required:
 * it is their consent. If the listing no longer matches it nothing is
 * written or charged, and PricingChangedError carries the pricing as it is
 * now. A buyer whose licence agreed to less (a higher price, or another
 * pricing model) also has to send `acceptNewPricing`.
 *
 * `created: false` means nothing was written: the buyer already uses the
 * agent on terms that cover it, or use is free and needs no licence.
 *
 * A listing that is paused (services/listingPause.ts: the model its agent
 * runs on is not running) starts nothing: no first start, no new month and
 * no accepting of a new price. That is asked at this moment, before
 * anything is claimed or charged, and when it cannot be answered nothing is
 * started either.
 *
 * Throws UseStartError (400 expected_terms_required, 404, 409 sells_copies,
 * own_agent, not_offered, copy_subscription_active, listing_paused, 503
 * service_unavailable), PricingChangedError, InsufficientCreditsError and
 * SubscriptionClaimLostError (another request got there first; of two
 * starts at once one month is charged).
 */
export async function startUsing(
  listingId: string,
  buyerId: string,
  opts: { expected?: ListingPricingTerms; acceptNewPricing?: boolean },
  hooks: ListingPauseHooks = {},
): Promise<UseState & { created: boolean }> {
  if (!opts.expected) {
    throw new UseStartError(400, "expected_terms_required", USE_START_MESSAGES.expectedTermsRequired);
  }

  const listing = await prisma.agentListing.findUnique({
    where: { id: listingId },
    include: USE_LISTING_INCLUDE,
  });

  // A listing that is not on sale is not there to start on, whoever asks.
  if (!listing || listing.status !== "published") {
    throw new UseStartError(404, "listing_not_found", USE_START_MESSAGES.listingNotFound);
  }

  // Self-dealing is refused by organization, here and at every use.
  if (listing.publisherId === buyerId) {
    throw new UseStartError(409, "own_agent", USE_START_MESSAGES.ownAgent);
  }

  if (listing.sells !== "use") {
    throw new UseStartError(409, "sells_copies", USE_START_MESSAGES.sellsCopies);
  }
  // Use is sold free, per use or by the month. Anything else cannot be
  // published as use; if a row says so anyway, nothing is started on it.
  if (listing.pricingModel !== "free" && listing.pricingModel !== "per_request" && listing.pricingModel !== "monthly") {
    throw new UseStartError(409, "not_offered", USE_START_MESSAGES.tokenAccess);
  }

  // Free use is the agent's public page: nobody pays, so there is nothing
  // to agree to and no licence to write.
  if (!isPaidUse(listing)) {
    return { ...(await readUseState(listing, buyerId)), created: false };
  }

  const existingInstall = await prisma.agentInstall.findUnique({
    where: {
      listingId_buyerId: { listingId, buyerId },
    },
  });
  const existingSubRow = existingInstall
    ? await prisma.agentSubscription.findUnique({
        where: { listingId_subscriberId: { listingId, subscriberId: buyerId } },
        select: LICENCE_SUBSCRIPTION_COLUMNS,
      })
    : null;
  const existingSub = existingSubRow && withPlanRetired(existingSubRow);

  const now = new Date();
  const access = useAccess(
    {
      licence: existingInstall
        ? {
            kind: existingInstall.kind,
            status: existingInstall.status,
            accepted: {
              pricingModel: existingInstall.acceptedPricingModel,
              pricePerRequestCents: existingInstall.acceptedPricePerRequestCents,
            },
          }
        : null,
      listing,
      sub: existingSub,
    },
    now,
  );
  // Already using it on terms that cover the listing: nothing to agree to
  // and nothing to charge. Answered as it stands.
  if (access === "subscribed" || access === "listing_pricing") {
    return { ...(await readUseState(listing, buyerId)), created: false };
  }
  // An agent that answers through its graph cannot answer a paid use (the
  // listing rules refuse it, but an agent can be moved back to an earlier
  // version). No first month is charged for something that cannot run.
  if (listing.agent?.entrypoint === "graph") {
    throw new UseStartError(409, "not_offered", USE_START_MESSAGES.tokenAccess);
  }
  // A copy of this agent with a month paid for. There is one licence row
  // for a listing and a buyer: starting use over it would cancel the month
  // that was paid for, or on a monthly listing could never go through.
  // Refused here, before anything is written, cancelled or charged.
  const copyPaidUntil = copyMonthBlockingUse(existingInstall, existingSub, now);
  if (copyPaidUntil) {
    throw new UseStartError(
      409,
      COPY_MONTH_BLOCKS_USE,
      copyMonthBlockingUseMessage(copyPaidUntil, now),
      copyPaidUntil,
    );
  }
  // Paused: the agent cannot answer, so nothing is started on it. Asked of
  // the model at this moment, never read from the marker. Fail closed: when
  // the question cannot be answered nobody is charged.
  let paused: boolean;
  try {
    paused = listing.agent
      ? await (hooks.listingPausedNow ?? listingPausedNow)({ listing, agent: listing.agent })
      : false;
  } catch (err) {
    logger.warn({ err, listingId }, "Could not ask whether a listing is paused; nothing was started");
    throw new UseStartError(503, "service_unavailable", USE_START_MESSAGES.cannotStart);
  }
  if (paused) {
    throw new UseStartError(409, "listing_paused", USE_START_MESSAGES.paused);
  }
  // A pause that is over but whose marker is still set: the marker is
  // cleared, and the months already paid for made longer, BEFORE this start,
  // so that a month that begins now is not lengthened by a pause that ended
  // before it. If that cannot be done nothing is started.
  if (listing.pausedSince) {
    let errors: number;
    try {
      ({ errors } = await (hooks.reconcileListingPauses ?? reconcileListingPauses)({ listingId }));
    } catch (err) {
      logger.warn({ err, listingId }, "Could not clear a listing's pause before a start; nothing was started");
      throw new UseStartError(503, "service_unavailable", USE_START_MESSAGES.cannotStart);
    }
    if (errors > 0) {
      throw new UseStartError(503, "service_unavailable", USE_START_MESSAGES.cannotStart);
    }
  }

  const terms = agreeToTerms(listing, {
    changed: access === "pricing_changed",
    acceptNewPricing: opts.acceptNewPricing,
    expectedPricing: opts.expected,
  });

  // The licence, the counters and (for a monthly price) the first month's
  // charge commit together or not at all.
  const subscriptionId = await prisma
    .$transaction(async (tx) => {
      await claimLicence(tx, existingInstall);
      const licence = await writeLicence(tx, { existing: existingInstall, listingId, buyerId, kind: "use", terms });
      const subscription = await settleLicenceSubscription(tx, {
        listing,
        buyerId,
        installId: licence.id,
        existingSub,
      });
      await countLicence(tx, { listingId, previousStatus: existingInstall?.status });
      return subscription?.id ?? null;
    })
    .catch((err) => {
      // Another start for this buyer got there first: it holds the licence
      // row, or the unique (listingId, buyerId) on a first start. This
      // transaction rolled back whole, so nothing was charged twice.
      if (isUniqueViolation(err) || err instanceof LicenceClaimLostError) {
        throw new SubscriptionClaimLostError(USE_START_MESSAGES.claimLost);
      }
      throw err;
    });

  await afterLicenceStarted(listingId, listing.publisherId, "a start of use");

  logger.info({ listingId, buyerId, subscription: subscriptionId }, "Started using an agent from the marketplace");

  return { ...(await readUseState(listing, buyerId)), created: true };
}

export async function uninstallAgent(listingId: string, buyerId: string) {
  const install = await prisma.agentInstall.findUnique({
    where: {
      listingId_buyerId: { listingId, buyerId },
    },
  });

  if (!install) {
    throw new Error("Installation not found");
  }

  // A lapsed monthly install (suspended) can be removed too.
  if (install.status !== "active" && install.status !== "suspended") {
    throw new Error("This agent is not currently installed");
  }

  // One transaction, claimed by compare-and-swap: of two concurrent
  // uninstalls only one ends the subscription and moves the counter.
  // Uninstalling ends a monthly subscription now (the current period is
  // not refunded).
  //
  // Stopping use of a creator's agent is this same path: the licence ends
  // now ("uninstalled" is a status useAccess reads as no licence), a
  // subscription ends now with no refund for the month, and there is no
  // copy to stop. A buyer who wants the rest of a paid month cancels the
  // renewal instead.
  const listing = await prisma.$transaction(async (tx) => {
    const claimed = await tx.agentInstall.updateMany({
      where: { id: install.id, status: { in: ["active", "suspended"] } },
      data: { status: "uninstalled", uninstalledAt: new Date() },
    });
    if (claimed.count !== 1) throw new Error("This agent is not currently installed");
    await tx.agentSubscription.updateMany({
      where: { listingId, subscriberId: buyerId, status: { in: ["active", "past_due"] } },
      data: { status: "cancelled", cancelledAt: new Date(), cancelAtPeriodEnd: false },
    });
    // The copy stops running on its own with the uninstall: every scheduled
    // task of it is switched off here, so nothing keeps firing, and
    // charging, after the buyer has stopped. The tasks and their history
    // stay. The copy is read from the row just claimed, not from the read
    // above, which an install in between may have pointed at a newer copy.
    const uninstalled = await tx.agentInstall.findUnique({
      where: { id: install.id },
      select: { clonedAgentId: true },
    });
    if (uninstalled?.clonedAgentId) {
      await pauseAgentSchedules(tx as unknown as Pick<OwnScheduleDb, "scheduledTask">, {
        orgId: buyerId,
        agentId: uninstalled.clonedAgentId,
      });
    }
    return tx.agentListing.update({
      where: { id: listingId },
      data: { activeInstalls: { decrement: 1 } },
    });
  });

  // Update publisher stats
  await updatePublisherStats(listing.publisherId);

  logger.info({ listingId, buyerId }, "Agent uninstalled");

  return { success: true };
}

export async function getMyInstalls(buyerId: string) {
  const installs = await prisma.agentInstall.findMany({
    // Suspended = a monthly subscription lapsed; the buyer still needs to
    // see it to resubscribe or remove it.
    where: { buyerId, status: { in: ["active", "suspended"] } },
    include: {
      listing: {
        include: {
          agent: {
            select: LICENCE_AGENT_COLUMNS,
          },
        },
      },
    },
    orderBy: { installedAt: "desc" },
  });

  const subscriptions = await prisma.agentSubscription.findMany({
    where: { subscriberId: buyerId, listingId: { in: installs.map((i) => i.listingId) } },
    include: WITH_PLAN_STATUS,
  });
  const subByListing = new Map(subscriptions.map((sub) => [sub.listingId, withPlanRetired(sub)]));

  return installs.map((install) => {
    const sub = subByListing.get(install.listingId);
    const accepted = {
      pricingModel: install.acceptedPricingModel,
      pricePerRequestCents: install.acceptedPricePerRequestCents,
    };
    const kind = install.kind === "use" ? ("use" as const) : ("copy" as const);
    return {
      id: install.id,
      listingId: install.listingId,
      // "use": the buyer uses the creator's agent on its page and has no
      // copy. "copy": their own copy, clonedAgentId.
      kind,
      clonedAgentId: install.clonedAgentId ?? null,
      // The agent the licence is for. For "use" this is where it is used.
      agent: licenceAgentOf(install.listing.agent),
      status: install.status,
      totalRequests: Number(install.totalRequests),
      totalSpentCents: Number(install.totalSpentCents),
      installedAt: install.installedAt,
      // The same rule billing applies (token gates aside), so the page
      // offers only what will actually work: installAccess for a copy,
      // useAccess for use of the creator's agent.
      access: licenceAccess(kind, install.status, accepted, install.listing, sub ?? null),
      // What the buyer agreed to, next to the listing's pricing today, so
      // the page can show both when they differ.
      acceptedPricing: {
        pricingModel: install.acceptedPricingModel,
        pricePerRequestCents:
          install.acceptedPricePerRequestCents !== null ? Number(install.acceptedPricePerRequestCents) : null,
        acceptedAt: install.pricingAcceptedAt,
      },
      listing: formatListingForPublic(install.listing),
      subscription: sub ? formatSubscription(sub) : null,
    };
  });
}

// ============================================
// Monthly subscriptions (buyer side)
// ============================================

const DAY_MS = 24 * 60 * 60 * 1000;

function formatSubscription(sub: {
  id: string;
  listingId: string;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  cancelledAt: Date | null;
  priceCents: bigint | null;
  endReason: string | null;
}) {
  return {
    id: sub.id,
    listingId: sub.listingId,
    status: sub.status,
    // What the buyer agreed to and what a renewal charges. The listing's
    // current price can differ; null only when no price was ever agreed.
    priceCents: sub.priceCents !== null ? Number(sub.priceCents) : null,
    endReason: sub.endReason,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    cancelledAt: sub.cancelledAt,
    hasAccess: subscriptionGrantsAccess(sub),
    graceEndsAt:
      sub.status === "past_due"
        ? new Date(sub.currentPeriodEnd.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS)
        : null,
  };
}

export async function getMySubscriptions(orgId: string) {
  const subs = await prisma.agentSubscription.findMany({
    where: { subscriberId: orgId },
    include: {
      listing: { select: { id: true, title: true, slug: true, iconUrl: true, monthlyPriceCents: true } },
    },
    orderBy: { currentPeriodEnd: "asc" },
  });
  return subs.map((sub) => ({
    ...formatSubscription(sub),
    listing: {
      id: sub.listing.id,
      title: sub.listing.title,
      slug: sub.listing.slug,
      iconUrl: sub.listing.iconUrl,
      monthlyPriceCents: sub.listing.monthlyPriceCents ? Number(sub.listing.monthlyPriceCents) : 0,
    },
  }));
}

export class SubscriptionNotFoundError extends Error {
  readonly code = "subscription_not_found";
  constructor() {
    super("No active subscription for this listing");
    this.name = "SubscriptionNotFoundError";
  }
}

/**
 * Cancel at period end (cancel = true) or undo that (cancel = false).
 * Access continues until the paid period ends; the renewal worker then
 * closes the subscription instead of charging it.
 */
export async function setSubscriptionCancelAtPeriodEnd(
  orgId: string,
  listingId: string,
  cancel: boolean
) {
  const updated = await prisma.agentSubscription.updateMany({
    where: { listingId, subscriberId: orgId, status: { in: ["active", "past_due"] } },
    data: { cancelAtPeriodEnd: cancel },
  });
  if (updated.count !== 1) throw new SubscriptionNotFoundError();

  const sub = await prisma.agentSubscription.findUnique({
    where: { listingId_subscriberId: { listingId, subscriberId: orgId } },
  });
  logger.info({ orgId, listingId, cancelAtPeriodEnd: cancel }, "Subscription renewal setting changed");
  return formatSubscription(sub!);
}

/**
 * Where a licence stands. A copy is decided by installAccess; use of the
 * creator's agent by useAccess, which can also answer "none" and
 * "not_offered".
 */
function licenceAccess(
  kind: "copy" | "use",
  status: string,
  accepted: { pricingModel: string | null; pricePerRequestCents: bigint | null },
  listing: { status: string; sells: string; pricingModel: string; pricePerRequestCents: bigint | null },
  sub: {
    status: string;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd?: boolean;
    endReason?: string | null;
    /** The marker of a plan, and whether its creator ended it (services/useAccess.ts). */
    includedUses?: number | null;
    planRetired?: boolean;
  } | null,
): InstallAccess | UseAccess {
  if (kind === "use") {
    return useAccess({ licence: { kind, status, accepted }, listing, sub });
  }
  return installAccess({
    installStatus: status,
    listingStatus: listing.status,
    pricingModel: listing.pricingModel,
    pricePerRequestCents: listing.pricePerRequestCents,
    accepted,
    sub,
  });
}

export async function checkInstallStatus(listingId: string, buyerId: string) {
  const install = await prisma.agentInstall.findUnique({
    where: {
      listingId_buyerId: { listingId, buyerId },
    },
    include: { listing: { include: { agent: { select: LICENCE_AGENT_COLUMNS } } } },
  });
  const subRow = install
    ? await prisma.agentSubscription.findUnique({
        where: { listingId_subscriberId: { listingId, subscriberId: buyerId } },
        include: WITH_PLAN_STATUS,
      })
    : null;
  const sub = subRow && withPlanRetired(subRow);
  const kind = install?.kind === "use" ? ("use" as const) : ("copy" as const);

  return {
    isInstalled: install?.status === "active",
    install: install
      ? {
          id: install.id,
          status: install.status,
          kind,
          clonedAgentId: install.clonedAgentId ?? null,
          agent: licenceAgentOf(install.listing.agent),
          access: licenceAccess(
            kind,
            install.status,
            {
              pricingModel: install.acceptedPricingModel,
              pricePerRequestCents: install.acceptedPricePerRequestCents,
            },
            install.listing,
            sub,
          ),
          installedAt: install.installedAt,
        }
      : null,
  };
}

// ============================================
// Revenue & Payouts
// ============================================

function escrowState(status: string): "held" | "released" | "refunded" {
  return status === "settled" ? "released" : status === "refunded" ? "refunded" : "held";
}

export async function getPublisherRevenue(publisherId: string) {
  // Get publisher profile
  const profile = await prisma.publisherProfile.findUnique({
    where: { orgId: publisherId },
  });

  // What can be requested as a payout right now, and the limits it is
  // held to (services/payoutRules.ts). A creator with no profile is owed
  // nothing and has taken nothing out today.
  const payoutLimits = await readPayoutLimits(prisma as unknown as PayoutReadsDb, {
    orgId: publisherId,
    balanceCents: profile?.pendingPayoutCents ?? 0n,
    settings: payoutRequestSettingsFromEnv(env),
    now: new Date(),
  });

  if (!profile) {
    return {
      totalRevenueCents: 0,
      pendingPayoutCents: 0,
      totalListings: 0,
      totalInstalls: 0,
      revenueByListing: [],
      recentTransactions: [],
      payoutLimits,
    };
  }

  // Get revenue by listing
  const revenueByListing = await prisma.marketplaceRevenue.groupBy({
    by: ["listingId"],
    where: { publisherId, status: "settled", listingId: { not: null } },
    _sum: {
      creatorAmountCents: true,
      requestCount: true,
    },
  });
  // Jobs for workflow and model offerings have no agent listing.
  const unlistedJobs = await prisma.marketplaceRevenue.aggregate({
    where: { publisherId, status: "settled", type: "job", listingId: null },
    _sum: { creatorAmountCents: true },
    _count: { _all: true },
  });

  // Get listing details for the revenue
  const listingIds = revenueByListing.flatMap((r) => (r.listingId ? [r.listingId] : []));
  const listings = await prisma.agentListing.findMany({
    where: { id: { in: listingIds } },
    select: { id: true, title: true, slug: true },
  });

  const listingMap = new Map(listings.map((l) => [l.id, l]));

  // Get recent transactions
  const recentTransactions = await prisma.marketplaceRevenue.findMany({
    where: { publisherId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  // What each row's licence is for, so a sale of use and a request made on a
  // buyer's copy are not given the same name. A row with no licence (a job,
  // an x402 payment) has none.
  const licenceIds = [...new Set(recentTransactions.flatMap((t) => (t.installId ? [t.installId] : [])))];
  const licences = licenceIds.length
    ? await prisma.agentInstall.findMany({ where: { id: { in: licenceIds } }, select: { id: true, kind: true } })
    : [];
  const licenceKindOf = new Map(licences.map((licence) => [licence.id, licence.kind === "use" ? "use" : "copy"] as const));
  // Job payments still in escrow: paid by buyers, not yet the publisher's.
  const heldInEscrow = await prisma.marketplaceRevenue.aggregate({
    where: { publisherId, type: "job", status: "pending" },
    _sum: { creatorAmountCents: true },
    _count: { _all: true },
  });

  // Get pending payouts
  const pendingPayouts = await prisma.creatorPayout.findMany({
    where: { publisherId, status: { in: ["pending", "processing"] } },
  });

  return {
    totalRevenueCents: Number(profile.totalRevenueCents),
    pendingPayoutCents: Number(profile.pendingPayoutCents),
    totalListings: profile.totalListings,
    totalInstalls: profile.totalInstalls,
    revenueByListing: revenueByListing.map((r) => ({
      listingId: r.listingId,
      listing: r.listingId ? listingMap.get(r.listingId) : undefined,
      totalRevenueCents: Number(r._sum.creatorAmountCents) || 0,
      totalRequests: r._sum.requestCount || 0,
    })),
    unlistedJobRevenue: {
      totalRevenueCents: Number(unlistedJobs._sum.creatorAmountCents ?? 0n),
      jobs: unlistedJobs._count._all,
    },
    recentTransactions: recentTransactions.map((t) => ({
      id: t.id,
      type: t.type,
      grossAmountCents: Number(t.grossAmountCents),
      platformFeeCents: Number(t.platformFeeCents),
      creatorAmountCents: Number(t.creatorAmountCents),
      requestCount: t.requestCount,
      status: t.status,
      // A job's row is its escrow: held until the buyer accepts (or the
      // review window closes), then released, or refunded. Only a released
      // row is an earning.
      jobId: t.jobId,
      escrow: t.type === "job" ? escrowState(t.status) : null,
      modelCostCents: Number(t.modelCostCents),
      // "use": the buyer used the creator's own agent. "copy": a request on
      // the buyer's copy, or its subscription. null: no licence behind it.
      licenceKind: t.installId ? (licenceKindOf.get(t.installId) ?? null) : null,
      createdAt: t.createdAt,
    })),
    heldInEscrow: {
      creatorAmountCents: Number(heldInEscrow._sum.creatorAmountCents ?? 0n),
      jobs: heldInEscrow._count._all,
    },
    pendingPayouts: pendingPayouts.map((p) => ({
      id: p.id,
      amountCents: Number(p.amountCents),
      payoutMethod: p.payoutMethod,
      status: p.status,
      requestedAt: p.requestedAt,
    })),
    payoutLimits,
  };
}

/**
 * Per-request marketplace billing lives in services/marketplaceMetering.ts.
 *
 * What used to be here — `recordMarketplaceUsage` — had zero callers, and
 * that was the only thing keeping it harmless: it wrote a `settled`
 * revenue row and incremented the publisher's pendingPayoutCents WITHOUT
 * ever debiting the buyer. Wiring it up would have made the platform owe
 * creators real payouts against revenue it never collected. The
 * replacement charges the buyer first, settles only on delivery, and
 * refunds when the agent fails.
 */
