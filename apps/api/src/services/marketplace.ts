import { prisma, Prisma } from "@wheelsai/db";
import { DEFAULT_AGENT_KIND, isAgentKind } from "@wheelsai/shared/agent-kind";
import { pauseAgentSchedules, type OwnScheduleDb } from "./agentOwnSchedule.js";
import { getOrgPlan } from "./orgPlan.js";
import { cloneAgentBehaviour, cloneAgentKind } from "./marketplaceClone.js";
import { startMonthlySubscription, type SubscriptionTx } from "./marketplaceSubscriptions.js";
import {
  installAccess,
  PAST_DUE_GRACE_DAYS,
  subscriptionGrantsAccess,
  subscriptionIsOpen,
} from "./subscriptionAccess.js";
import { orgHoldsToken, TokenRequiredError } from "./tokenAccess.js";
import { createLogger } from "../utils/logger.js";
import { updatePublisherReputation } from "./reputation.js";

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
}

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
          select: {
            id: true,
            framework: true,
            agentKind: true,
            tags: true,
          },
        },
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
          systemPrompt: true,
          tools: true,
        },
      },
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
      agent: { select: { entrypoint: true, agentKind: true, modelConfig: true, tools: true } },
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
        select: {
          id: true,
          framework: true,
          agentKind: true,
          tags: true,
        },
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
        select: {
          id: true,
          framework: true,
          agentKind: true,
          tags: true,
        },
      },
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
                select: {
                  id: true,
                  framework: true,
                  agentKind: true,
                  tags: true,
                },
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

  // Check if listing already exists for this agent
  const existing = await prisma.agentListing.findUnique({
    where: { agentId: params.agentId },
  });

  if (existing) {
    throw new Error("A listing already exists for this agent");
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

  const listing = await prisma.agentListing.create({
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
      pricingModel: params.pricingModel,
      ...normalizeListingPricing(params.pricingModel, params),
      publisherId: orgId,
      publisherName: orgName,
      status: "draft",
    },
    include: {
      agent: {
        select: {
          id: true,
          framework: true,
          agentKind: true,
          tags: true,
        },
      },
    },
  });

  // Ensure publisher profile exists
  await ensurePublisherProfile(orgId, orgName);

  return formatListingForPublic(listing);
}

export async function updateListing(
  listingId: string,
  orgId: string,
  params: Partial<ListingCreateParams>
) {
  const listing = await prisma.agentListing.findFirst({
    where: { id: listingId, publisherId: orgId },
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
    : {};

  const updated = await prisma.agentListing.update({
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
      ...pricing,
    },
    include: {
      agent: {
        select: {
          id: true,
          framework: true,
          agentKind: true,
          tags: true,
        },
      },
    },
  });

  return formatListingForPublic(updated);
}

export async function publishListing(listingId: string, orgId: string) {
  const listing = await prisma.agentListing.findFirst({
    where: { id: listingId, publisherId: orgId },
  });

  if (!listing) {
    throw new Error("Listing not found");
  }

  if (listing.status === "published") {
    throw new Error("Listing is already published");
  }

  // Validate listing has required fields
  if (!listing.title || !listing.shortDescription || !listing.category) {
    throw new Error("Listing is missing required fields");
  }

  const updated = await prisma.agentListing.update({
    where: { id: listingId },
    data: {
      status: "published",
      publishedAt: new Date(),
    },
  });

  // Update publisher stats
  await updatePublisherStats(orgId);

  logger.info({ listingId, orgId }, "Listing published");

  return updated;
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

export async function getMyListings(orgId: string) {
  const listings = await prisma.agentListing.findMany({
    where: { publisherId: orgId },
    orderBy: { createdAt: "desc" },
    include: {
      agent: {
        select: {
          id: true,
          framework: true,
          agentKind: true,
          tags: true,
        },
      },
    },
  });

  return listings.map(formatListingForPublic);
}

// ============================================
// Helpers
// ============================================

function formatListingForPublic(listing: any) {
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

  // Check if already installed
  const existingInstall = await prisma.agentInstall.findUnique({
    where: {
      listingId_buyerId: { listingId, buyerId },
    },
  });
  const existingSub = existingInstall
    ? await prisma.agentSubscription.findUnique({
        where: { listingId_subscriberId: { listingId, subscriberId: buyerId } },
        select: { id: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, endReason: true },
      })
    : null;

  const currentPricing = listingPricingTerms(listing);
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
    if (access === "pricing_changed" && !opts.acceptNewPricing) {
      throw new PricingChangedError(listing.title, currentPricing);
    }
  }
  // The publisher changed the price between the buyer seeing it and
  // confirming: what they confirmed is not what would be recorded.
  if (opts.expectedPricing && !samePricing(opts.expectedPricing, currentPricing)) {
    throw new PricingChangedError(listing.title, currentPricing);
  }
  // What this install agrees to. Billing compares the listing against it at
  // every request (installAccess), so a later increase pauses the install
  // instead of being charged.
  const acceptedPricing = {
    acceptedPricingModel: listing.pricingModel,
    acceptedPricePerRequestCents:
      listing.pricingModel === "per_request" ? (listing.pricePerRequestCents ?? 0n) : null,
    pricingAcceptedAt: new Date(),
  };

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
    // Claim the existing install row first, by compare-and-swap on what we
    // read. For an uninstalled or suspended row this is exclusive: of two
    // concurrent installs one wins and the other stops here. For a row
    // that is already active it changes nothing a second request could
    // miss, so it is not a claim: there the exclusive step is the
    // subscription's (or the pricing acceptance's) below, and nothing is
    // charged before it. Matching clonedAgentId as well stops a request
    // that read the row before another install repointed it: acting on
    // the stale id would create a second copy and orphan the first, which
    // would then run unmetered.
    if (existingInstall) {
      const claimed = await tx.agentInstall.updateMany({
        where: {
          id: existingInstall.id,
          status: existingInstall.status,
          clonedAgentId: existingInstall.clonedAgentId,
        },
        data: { status: "active", uninstalledAt: null },
      });
      if (claimed.count !== 1) {
        throw new Error("This agent is already being installed. Refresh to see it.");
      }
    }

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

    // A brand-new install is protected by the unique (listingId, buyerId):
    // the loser of a race fails here and its whole transaction rolls back.
    const install = existingInstall
      ? await tx.agentInstall.update({
          where: { id: existingInstall.id },
          data: { clonedAgentId: clonedAgent.id, ...acceptedPricing },
        })
      : await tx.agentInstall.create({
          data: { listingId, buyerId, clonedAgentId: clonedAgent.id, status: "active", ...acceptedPricing },
        });

    // Monthly listings charge the first 30-day period now.
    let subscription: { id: string; currentPeriodEnd: Date } | null = null;
    if (listing.pricingModel === "monthly") {
      const started = await startMonthlySubscription(tx as unknown as SubscriptionTx, {
        listing: {
          id: listing.id,
          title: listing.title,
          publisherId: listing.publisherId,
          monthlyPriceCents: listing.monthlyPriceCents ?? 0n,
        },
        buyerId,
        installId: install.id,
      });
      subscription = {
        id: started.subscription.id,
        currentPeriodEnd: started.subscription.currentPeriodEnd,
      };
    } else if (existingSub && (existingSub.endReason || subscriptionIsOpen(existingSub))) {
      // The buyer accepts the listing's current pricing in place of the
      // subscription: one the publisher's side ended, or one that ran out
      // and the renewal worker has not closed yet. Compare-and-swap on
      // what was read, so this is the exclusive step when the install row
      // was already active, and the worker's own close (which matches an
      // open status) then misses instead of suspending the install again.
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
        throw new Error("This agent is already being installed. Refresh to see it.");
      }
    }

    // A lapsed (suspended) or already-active install still counts as
    // active on the listing, so (re)subscribing must not count it twice.
    if (existingInstall?.status !== "suspended" && existingInstall?.status !== "active") {
      await tx.agentListing.update({
        where: { id: listingId },
        data: {
          totalInstalls: { increment: 1 },
          activeInstalls: { increment: 1 },
        },
      });
    }

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
      throw new Error("This agent is already being installed. Refresh to see it.");
    }
    throw err;
  });

  // Update publisher stats
  await updatePublisherStats(listing.publisherId);

  // Installs feed the usage/social legs of the reputation score.
  updatePublisherReputation(listing.publisherId).catch((err) =>
    logger.error(
      { err, listingId, publisherId: listing.publisherId },
      "Failed to recalc publisher reputation after install"
    )
  );

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
            select: {
              id: true,
              framework: true,
              agentKind: true,
              tags: true,
            },
          },
        },
      },
    },
    orderBy: { installedAt: "desc" },
  });

  const subscriptions = await prisma.agentSubscription.findMany({
    where: { subscriberId: buyerId, listingId: { in: installs.map((i) => i.listingId) } },
  });
  const subByListing = new Map(subscriptions.map((sub) => [sub.listingId, sub]));

  return installs.map((install) => {
    const sub = subByListing.get(install.listingId);
    return {
      id: install.id,
      listingId: install.listingId,
      clonedAgentId: install.clonedAgentId,
      status: install.status,
      totalRequests: Number(install.totalRequests),
      totalSpentCents: Number(install.totalSpentCents),
      installedAt: install.installedAt,
      // The same rule install billing applies (token gates aside), so the
      // page offers only what will actually work.
      access: installAccess({
        installStatus: install.status,
        listingStatus: install.listing.status,
        pricingModel: install.listing.pricingModel,
        pricePerRequestCents: install.listing.pricePerRequestCents,
        accepted: {
          pricingModel: install.acceptedPricingModel,
          pricePerRequestCents: install.acceptedPricePerRequestCents,
        },
        sub: sub ?? null,
      }),
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

export async function checkInstallStatus(listingId: string, buyerId: string) {
  const install = await prisma.agentInstall.findUnique({
    where: {
      listingId_buyerId: { listingId, buyerId },
    },
  });

  return {
    isInstalled: install?.status === "active",
    install: install
      ? {
          id: install.id,
          status: install.status,
          clonedAgentId: install.clonedAgentId,
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

  if (!profile) {
    return {
      totalRevenueCents: 0,
      pendingPayoutCents: 0,
      totalListings: 0,
      totalInstalls: 0,
      revenueByListing: [],
      recentTransactions: [],
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
  };
}

/**
 * The balance changed between the snapshot and the reservation (a
 * concurrent payout request won, or revenue was restored/adjusted).
 * Nothing was written; the caller may retry and will see the new balance.
 */
export class PayoutReservationConflictError extends Error {
  readonly code = "payout_reservation_conflict";
  constructor() {
    super("Your payout balance changed while this request was processing. Please try again.");
    this.name = "PayoutReservationConflictError";
  }
}

export async function requestPayout(
  publisherId: string,
  payoutMethod: "credits" | "crypto_usdc" | "crypto_sol",
  payoutAddress?: string
) {
  // Get publisher profile
  const profile = await prisma.publisherProfile.findUnique({
    where: { orgId: publisherId },
  });

  if (!profile) {
    throw new Error("Publisher profile not found");
  }

  const pendingAmount = Number(profile.pendingPayoutCents);

  if (pendingAmount < 1000) {
    // Minimum $10 payout
    throw new Error("Minimum payout amount is $10.00");
  }

  if (payoutMethod !== "credits" && !payoutAddress) {
    throw new Error("Payout address is required for crypto payouts");
  }

  // Check for existing pending payout
  const existingPayout = await prisma.creatorPayout.findFirst({
    where: {
      publisherId,
      status: { in: ["pending", "processing"] },
    },
  });

  if (existingPayout) {
    throw new Error("You already have a pending payout request");
  }

  // Calculate revenue breakdown
  const grossRevenue = Math.round(pendingAmount / CREATOR_REVENUE_SHARE);
  const platformFee = grossRevenue - pendingAmount;

  // Requesting a payout RESERVES the pending balance into the payout row:
  // create the row AND zero pendingPayoutCents in ONE transaction. Before
  // this was two separate writes, so a crash between them either lost the
  // reservation (row exists, balance still pending → double-payable) or
  // stranded it. The reservation is released back to pendingPayoutCents
  // only if the executor later fails the payout (see the payout-executor
  // tick's failAndRestore). Deducting off the CURRENT balance inside the
  // transaction also prevents a payout that races with fresh revenue from
  // zeroing income that accrued after the amount was snapshotted.
  //
  // The decrement is CONDITIONAL on the balance still covering the amount.
  // An unconditional decrement let two concurrent requests both pass the
  // pending-payout check above, both reserve the full balance, drive
  // pendingPayoutCents negative, and get paid twice by the executor. Under
  // Postgres row locking the second request re-reads the committed balance
  // and matches zero rows, so exactly one reservation wins.
  const payout = await prisma.$transaction(async (tx) => {
    const reserved = await tx.publisherProfile.updateMany({
      where: { orgId: publisherId, pendingPayoutCents: { gte: BigInt(pendingAmount) } },
      data: { pendingPayoutCents: { decrement: BigInt(pendingAmount) } },
    });
    if (reserved.count !== 1) {
      throw new PayoutReservationConflictError();
    }
    const created = await tx.creatorPayout.create({
      data: {
        publisherId,
        amountCents: BigInt(pendingAmount),
        payoutMethod,
        payoutAddress,
        status: "pending",
        grossRevenueCents: BigInt(grossRevenue),
        platformFeeCents: BigInt(platformFee),
        periodStart: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
        periodEnd: new Date(),
      },
    });
    return created;
  });

  logger.info({ publisherId, payoutId: payout.id, amount: pendingAmount }, "Payout requested");

  return {
    payout: {
      id: payout.id,
      amountCents: Number(payout.amountCents),
      payoutMethod: payout.payoutMethod,
      status: payout.status,
      requestedAt: payout.requestedAt,
    },
  };
}

export async function getPayoutHistory(publisherId: string) {
  const payouts = await prisma.creatorPayout.findMany({
    where: { publisherId },
    orderBy: { requestedAt: "desc" },
    take: 50,
  });

  return payouts.map((p) => ({
    id: p.id,
    amountCents: Number(p.amountCents),
    payoutMethod: p.payoutMethod,
    payoutAddress: p.payoutAddress,
    status: p.status,
    txSignature: p.txSignature,
    grossRevenueCents: Number(p.grossRevenueCents),
    platformFeeCents: Number(p.platformFeeCents),
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    requestedAt: p.requestedAt,
    processedAt: p.processedAt,
    failureReason: p.failureReason,
  }));
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
