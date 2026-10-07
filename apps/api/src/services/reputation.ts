import { prisma } from "@wheelsai/db";

// Reputation score weights
const WEIGHTS = {
  avgRating: 0.30, // 30% - Average review rating
  installCount: 0.20, // 20% - Total installs
  responseTime: 0.15, // 15% - Agent response time
  accountAge: 0.10, // 10% - How long they've been a publisher
  verificationStatus: 0.10, // 10% - Verified publisher
  disputeRatio: 0.10, // 10% - Disputes resolved vs total
  payoutSuccess: 0.05, // 5% - Successful payouts
};

// Tier thresholds
const TIERS = {
  platinum: 90,
  gold: 75,
  silver: 50,
  bronze: 25,
  new: 0,
};

// Badge criteria
const BADGE_CRITERIA = {
  "fast-responder": { avgResponseTimeMs: 500 }, // < 500ms avg response
  "top-rated": { avgRating: 4.5, reviewCount: 10 },
  "verified-developer": { isVerified: true },
  "high-volume": { totalInstalls: 100 },
  "trusted-publisher": { reputationScore: 80, successfulPayouts: 5 },
  "zero-disputes": { disputeCount: 0, totalInstalls: 20 },
};

export interface ReputationBreakdown {
  score: number;
  tier: string;
  breakdown: {
    avgRating: { value: number; score: number; weight: number };
    installCount: { value: number; score: number; weight: number };
    responseTime: { value: number | null; score: number; weight: number };
    accountAge: { value: number; score: number; weight: number };
    verificationStatus: { value: boolean; score: number; weight: number };
    disputeRatio: { value: number; score: number; weight: number };
    payoutSuccess: { value: number; score: number; weight: number };
  };
  badges: string[];
  /** Paid jobs (Offerings and Jobs) behind the score: how they ended, and how many were rated. */
  jobs: { completed: number; rejected: number; failed: number; expired: number; ratingCount: number };
}

/** What the score reads. Production passes Prisma; tests pass a fake. */
export interface ReputationDb {
  publisherProfile: {
    findUnique(args: { where: { orgId: string } }): Promise<{
      createdAt: Date;
      isVerified: boolean;
      avgResponseTimeMs: bigint | null;
      successfulPayouts: number;
      disputeCount: number;
      disputeResolvedCount: number;
    } | null>;
  };
  agentListing: {
    findMany(args: {
      where: { publisherId: string; status: "published" };
      include: { reviews: true };
    }): Promise<Array<{ totalInstalls: number; reviews: Array<{ rating: number }> }>>;
  };
  job: {
    aggregate(args: {
      where: { publisherId: string; rating: { not: null } };
      _avg: { rating: true };
      _count: { _all: true };
    }): Promise<{ _avg: { rating: number | null }; _count: { _all: number } }>;
    groupBy(args: {
      by: ["status"];
      where: { publisherId: string };
      _count: { _all: true };
    }): Promise<Array<{ status: string; _count: { _all: number } }>>;
  };
}

/**
 * One average over everything buyers rated: listing reviews and paid jobs.
 * A publisher who sells only offerings (a workflow or a model has no
 * listing to review) is rated by their jobs alone.
 */
export function blendRatings(
  reviewRatings: number[],
  jobs: { avg: number | null; count: number },
): { avgRating: number; ratingCount: number } {
  const jobCount = jobs.avg === null ? 0 : jobs.count;
  const ratingCount = reviewRatings.length + jobCount;
  if (ratingCount === 0) return { avgRating: 0, ratingCount: 0 };
  const sum = reviewRatings.reduce((total, rating) => total + rating, 0) + (jobs.avg ?? 0) * jobCount;
  return { avgRating: sum / ratingCount, ratingCount };
}

/**
 * Calculate reputation score for a publisher
 */
export async function calculateReputationScore(
  publisherId: string,
  db: ReputationDb = prisma as unknown as ReputationDb
): Promise<ReputationBreakdown> {
  const profile = await db.publisherProfile.findUnique({
    where: { orgId: publisherId },
  });

  if (!profile) {
    throw new Error("Publisher profile not found");
  }

  // Get listings and their stats
  const listings = await db.agentListing.findMany({
    where: { publisherId, status: "published" },
    include: {
      reviews: true,
    },
  });

  const [jobRatings, jobOutcomes] = await Promise.all([
    db.job.aggregate({
      where: { publisherId, rating: { not: null } },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    db.job.groupBy({ by: ["status"], where: { publisherId }, _count: { _all: true } }),
  ]);
  const jobCount = (status: string) =>
    jobOutcomes.find((group) => group.status === status)?._count._all ?? 0;

  // Average rating across listing reviews and rated jobs
  const allReviews = listings.flatMap((l) => l.reviews);
  const { avgRating, ratingCount } = blendRatings(
    allReviews.map((r) => r.rating),
    { avg: jobRatings._avg.rating, count: jobRatings._count._all }
  );

  // Calculate total installs
  const totalInstalls = listings.reduce((sum, l) => sum + l.totalInstalls, 0);

  // Calculate account age in days
  const accountAgeDays = Math.floor(
    (Date.now() - profile.createdAt.getTime()) / (1000 * 60 * 60 * 24)
  );

  // Calculate dispute ratio (resolved / total)
  const disputeRatio =
    profile.disputeCount > 0
      ? profile.disputeResolvedCount / profile.disputeCount
      : 1; // No disputes = perfect

  // Calculate scores for each factor (0-100)
  const scores = {
    avgRating: {
      value: avgRating,
      score: Math.min((avgRating / 5) * 100, 100),
      weight: WEIGHTS.avgRating,
    },
    installCount: {
      value: totalInstalls,
      score: Math.min((totalInstalls / 1000) * 100, 100), // Cap at 1000 installs
      weight: WEIGHTS.installCount,
    },
    responseTime: {
      value: profile.avgResponseTimeMs ? Number(profile.avgResponseTimeMs) : null,
      score: profile.avgResponseTimeMs
        ? Math.max(100 - Number(profile.avgResponseTimeMs) / 10, 0) // Lower is better
        : 50, // Default if no data
      weight: WEIGHTS.responseTime,
    },
    accountAge: {
      value: accountAgeDays,
      score: Math.min((accountAgeDays / 365) * 100, 100), // Cap at 1 year
      weight: WEIGHTS.accountAge,
    },
    verificationStatus: {
      value: profile.isVerified,
      score: profile.isVerified ? 100 : 0,
      weight: WEIGHTS.verificationStatus,
    },
    disputeRatio: {
      value: disputeRatio,
      score: disputeRatio * 100,
      weight: WEIGHTS.disputeRatio,
    },
    payoutSuccess: {
      value: profile.successfulPayouts,
      score: Math.min((profile.successfulPayouts / 10) * 100, 100),
      weight: WEIGHTS.payoutSuccess,
    },
  };

  // Calculate weighted total
  const totalScore = Object.values(scores).reduce(
    (sum, { score, weight }) => sum + score * weight,
    0
  );

  // Determine tier
  let tier = "new";
  for (const [tierName, threshold] of Object.entries(TIERS)) {
    if (totalScore >= threshold) {
      tier = tierName;
      break;
    }
  }

  // Determine badges
  const badges: string[] = [];
  const reviewCount = ratingCount;

  if (
    scores.responseTime.value &&
    scores.responseTime.value < BADGE_CRITERIA["fast-responder"].avgResponseTimeMs
  ) {
    badges.push("fast-responder");
  }

  if (
    avgRating >= BADGE_CRITERIA["top-rated"].avgRating &&
    reviewCount >= BADGE_CRITERIA["top-rated"].reviewCount
  ) {
    badges.push("top-rated");
  }

  if (profile.isVerified) {
    badges.push("verified-developer");
  }

  if (totalInstalls >= BADGE_CRITERIA["high-volume"].totalInstalls) {
    badges.push("high-volume");
  }

  if (
    totalScore >= BADGE_CRITERIA["trusted-publisher"].reputationScore &&
    profile.successfulPayouts >= BADGE_CRITERIA["trusted-publisher"].successfulPayouts
  ) {
    badges.push("trusted-publisher");
  }

  if (
    profile.disputeCount === 0 &&
    totalInstalls >= BADGE_CRITERIA["zero-disputes"].totalInstalls
  ) {
    badges.push("zero-disputes");
  }

  return {
    score: Math.round(totalScore * 100) / 100,
    tier,
    breakdown: scores,
    badges,
    jobs: {
      completed: jobCount("completed"),
      rejected: jobCount("rejected"),
      failed: jobCount("failed"),
      expired: jobCount("expired"),
      ratingCount: jobRatings._count._all,
    },
  };
}

/**
 * Update publisher's stored reputation data
 */
export async function updatePublisherReputation(publisherId: string) {
  const reputation = await calculateReputationScore(publisherId);

  await prisma.publisherProfile.update({
    where: { orgId: publisherId },
    data: {
      reputationScore: reputation.score,
      reputationTier: reputation.tier,
      badges: reputation.badges,
      joinedDaysAgo: Math.floor(
        (Date.now() -
          (
            await prisma.publisherProfile.findUnique({
              where: { orgId: publisherId },
            })
          )!.createdAt.getTime()) /
          (1000 * 60 * 60 * 24)
      ),
      lastReputationCalc: new Date(),
    },
  });

  return reputation;
}

/**
 * Get reputation leaderboard
 */
export async function getReputationLeaderboard(limit: number = 10) {
  const publishers = await prisma.publisherProfile.findMany({
    where: {
      totalListings: { gt: 0 },
    },
    orderBy: {
      reputationScore: "desc",
    },
    take: limit,
    select: {
      orgId: true,
      displayName: true,
      slug: true,
      avatarUrl: true,
      isVerified: true,
      reputationScore: true,
      reputationTier: true,
      badges: true,
      totalListings: true,
      totalInstalls: true,
    },
  });

  return publishers;
}

/**
 * Get publishers by tier
 */
export async function getPublishersByTier(tier: string, limit: number = 20) {
  const publishers = await prisma.publisherProfile.findMany({
    where: {
      reputationTier: tier,
      totalListings: { gt: 0 },
    },
    orderBy: {
      reputationScore: "desc",
    },
    take: limit,
    select: {
      orgId: true,
      displayName: true,
      slug: true,
      avatarUrl: true,
      isVerified: true,
      reputationScore: true,
      reputationTier: true,
      badges: true,
      totalListings: true,
      totalInstalls: true,
    },
  });

  return publishers;
}

/**
 * Record agent response time for reputation tracking
 */
export async function recordAgentResponseTime(
  publisherId: string,
  responseTimeMs: number
) {
  const profile = await prisma.publisherProfile.findUnique({
    where: { orgId: publisherId },
  });

  if (!profile) return;

  // Calculate running average
  const currentAvg = profile.avgResponseTimeMs
    ? Number(profile.avgResponseTimeMs)
    : responseTimeMs;
  const newAvg = (currentAvg + responseTimeMs) / 2;

  await prisma.publisherProfile.update({
    where: { orgId: publisherId },
    data: {
      avgResponseTimeMs: BigInt(Math.round(newAvg)),
    },
  });
}

/**
 * Record a dispute. A buyer rejecting a job's deliverable is one: the buyer
 * was refunded, so it is recorded already resolved (the ratio stays honest
 * about how often a publisher's work is refused through the count).
 */
export async function recordDispute(
  publisherId: string,
  resolved: boolean = false,
  db: {
    publisherProfile: {
      updateMany(args: { where: { orgId: string }; data: Record<string, unknown> }): Promise<unknown>;
    };
  } = prisma
) {
  const updateData: any = {
    disputeCount: { increment: 1 },
  };

  if (resolved) {
    updateData.disputeResolvedCount = { increment: 1 };
  }

  // updateMany: a publisher with no profile row has nothing to count
  // against, and that must not throw into the rejection that reported it.
  await db.publisherProfile.updateMany({
    where: { orgId: publisherId },
    data: updateData,
  });
}

/**
 * Record successful payout
 */
export async function recordSuccessfulPayout(publisherId: string) {
  await prisma.publisherProfile.update({
    where: { orgId: publisherId },
    data: {
      successfulPayouts: { increment: 1 },
    },
  });
}

/**
 * Get badge info
 */
export function getBadgeInfo(badge: string) {
  const badgeInfo: Record<string, { name: string; description: string; icon: string }> = {
    "fast-responder": {
      name: "Fast Responder",
      description: "Average agent response time under 500ms",
      icon: "zap",
    },
    "top-rated": {
      name: "Top Rated",
      description: "4.5+ star average with 10+ reviews",
      icon: "star",
    },
    "verified-developer": {
      name: "Verified Developer",
      description: "Identity verified by WheelsAI",
      icon: "badge-check",
    },
    "high-volume": {
      name: "High Volume",
      description: "100+ total agent installs",
      icon: "trending-up",
    },
    "trusted-publisher": {
      name: "Trusted Publisher",
      description: "80+ reputation score with 5+ successful payouts",
      icon: "shield-check",
    },
    "zero-disputes": {
      name: "Zero Disputes",
      description: "No disputes with 20+ installs",
      icon: "award",
    },
  };

  return badgeInfo[badge] || { name: badge, description: "", icon: "badge" };
}

/**
 * Get all badges info
 */
export function getAllBadgesInfo() {
  return [
    "fast-responder",
    "top-rated",
    "verified-developer",
    "high-volume",
    "trusted-publisher",
    "zero-disputes",
  ].map((badge) => ({
    id: badge,
    ...getBadgeInfo(badge),
  }));
}
