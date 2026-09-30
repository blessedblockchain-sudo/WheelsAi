import { prisma } from "@wheelsai/db";
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
  pricingModel: "free" | "per_request" | "monthly";
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
] as const;

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
      orderBy,
      skip,
      take: limit,
      include: {
        agent: {
          select: {
            id: true,
            framework: true,
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

export async function getListingById(id: string) {
  const listing = await prisma.agentListing.findUnique({
    where: { id },
    include: {
      agent: {
        select: {
          id: true,
          framework: true,
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

  // Check if user has installed the agent (verified review)
  const install = await prisma.agentInstall.findUnique({
    where: {
      listingId_buyerId: { listingId, buyerId: reviewerId },
    },
  });

  const review = await prisma.agentReview.create({
    data: {
      listingId,
      reviewerId,
      rating: data.rating,
      title: data.title,
      content: data.content,
      isVerified: !!install,
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

  const listing = await prisma.agentListing.create({
    data: {
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
      pricePerRequestCents: params.pricePerRequestCents
        ? BigInt(params.pricePerRequestCents)
        : null,
      monthlyPriceCents: params.monthlyPriceCents
        ? BigInt(params.monthlyPriceCents)
        : null,
      publisherId: orgId,
      publisherName: orgName,
      status: "draft",
    },
    include: {
      agent: {
        select: {
          id: true,
          framework: true,
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
      ...(params.pricingModel && { pricingModel: params.pricingModel }),
      ...(params.pricePerRequestCents !== undefined && {
        pricePerRequestCents: params.pricePerRequestCents
          ? BigInt(params.pricePerRequestCents)
          : null,
      }),
      ...(params.monthlyPriceCents !== undefined && {
        monthlyPriceCents: params.monthlyPriceCents
          ? BigInt(params.monthlyPriceCents)
          : null,
      }),
    },
    include: {
      agent: {
        select: {
          id: true,
          framework: true,
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
    agent: listing.agent
      ? {
          id: listing.agent.id,
          framework: listing.agent.framework,
          tags: listing.agent.tags,
          // Present only on selects that ask for them (getListingBySlug);
          // undefined elsewhere.
          slug: listing.agent.slug,
          isPublic: listing.agent.isPublic,
        }
      : undefined,
  };
}

async function ensurePublisherProfile(orgId: string, orgName: string) {
  const existing = await prisma.publisherProfile.findUnique({
    where: { orgId },
  });

  if (existing) {
    return existing;
  }

  // Generate slug
  const baseSlug = orgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  let slug = baseSlug;
  let counter = 1;
  while (await prisma.publisherProfile.findUnique({ where: { slug } })) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  return prisma.publisherProfile.create({
    data: {
      orgId,
      displayName: orgName,
      slug,
    },
  });
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

export async function installAgent(listingId: string, buyerId: string) {
  // Get the listing
  const listing = await prisma.agentListing.findUnique({
    where: { id: listingId },
    include: {
      agent: true,
    },
  });

  if (!listing) {
    throw new Error("Listing not found");
  }

  if (listing.status !== "published") {
    throw new Error("This agent is not available for installation");
  }

  // Check if already installed
  const existingInstall = await prisma.agentInstall.findUnique({
    where: {
      listingId_buyerId: { listingId, buyerId },
    },
  });

  if (existingInstall && existingInstall.status === "active") {
    throw new Error("You have already installed this agent");
  }

  // Clone the agent to buyer's account
  const clonedAgent = await prisma.agent.create({
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
      env: listing.agent.env as any,
      version: listing.agent.version,
      isPublic: false,
      tags: listing.agent.tags,
    },
  });

  // Create or reactivate install record
  let install;
  if (existingInstall) {
    install = await prisma.agentInstall.update({
      where: { id: existingInstall.id },
      data: {
        status: "active",
        clonedAgentId: clonedAgent.id,
        uninstalledAt: null,
      },
    });
  } else {
    install = await prisma.agentInstall.create({
      data: {
        listingId,
        buyerId,
        clonedAgentId: clonedAgent.id,
        status: "active",
      },
    });
  }

  // Update listing stats
  await prisma.agentListing.update({
    where: { id: listingId },
    data: {
      totalInstalls: { increment: 1 },
      activeInstalls: { increment: 1 },
    },
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

  logger.info({ listingId, buyerId, agentId: clonedAgent.id }, "Agent installed from marketplace");

  return {
    install,
    clonedAgent: {
      id: clonedAgent.id,
      name: clonedAgent.name,
      slug: clonedAgent.slug,
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

  if (install.status !== "active") {
    throw new Error("This agent is not currently installed");
  }

  // Update install record
  await prisma.agentInstall.update({
    where: { id: install.id },
    data: {
      status: "uninstalled",
      uninstalledAt: new Date(),
    },
  });

  // Update listing stats
  const listing = await prisma.agentListing.update({
    where: { id: listingId },
    data: {
      activeInstalls: { decrement: 1 },
    },
  });

  // Update publisher stats
  await updatePublisherStats(listing.publisherId);

  logger.info({ listingId, buyerId }, "Agent uninstalled");

  return { success: true };
}

export async function getMyInstalls(buyerId: string) {
  const installs = await prisma.agentInstall.findMany({
    where: { buyerId, status: "active" },
    include: {
      listing: {
        include: {
          agent: {
            select: {
              id: true,
              framework: true,
              tags: true,
            },
          },
        },
      },
    },
    orderBy: { installedAt: "desc" },
  });

  return installs.map((install) => ({
    id: install.id,
    listingId: install.listingId,
    clonedAgentId: install.clonedAgentId,
    status: install.status,
    totalRequests: Number(install.totalRequests),
    totalSpentCents: Number(install.totalSpentCents),
    installedAt: install.installedAt,
    listing: formatListingForPublic(install.listing),
  }));
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
    where: { publisherId, status: "settled" },
    _sum: {
      creatorAmountCents: true,
      requestCount: true,
    },
  });

  // Get listing details for the revenue
  const listingIds = revenueByListing.map((r) => r.listingId);
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
      listing: listingMap.get(r.listingId),
      totalRevenueCents: Number(r._sum.creatorAmountCents) || 0,
      totalRequests: r._sum.requestCount || 0,
    })),
    recentTransactions: recentTransactions.map((t) => ({
      id: t.id,
      type: t.type,
      grossAmountCents: Number(t.grossAmountCents),
      platformFeeCents: Number(t.platformFeeCents),
      creatorAmountCents: Number(t.creatorAmountCents),
      requestCount: t.requestCount,
      status: t.status,
      createdAt: t.createdAt,
    })),
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
