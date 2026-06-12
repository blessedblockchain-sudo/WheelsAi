import { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.js";
import {
  calculateReputationScore,
  updatePublisherReputation,
  getReputationLeaderboard,
  getPublishersByTier,
  getBadgeInfo,
  getAllBadgesInfo,
} from "../services/reputation.js";
import { prisma } from "@wheelsai/db";

export async function reputationRoutes(app: FastifyInstance) {
  // Get reputation leaderboard (public)
  app.get("/leaderboard", async (request, reply) => {
    const { limit } = request.query as { limit?: string };
    const leaderboard = await getReputationLeaderboard(
      limit ? parseInt(limit) : 10
    );

    return reply.send({
      success: true,
      data: leaderboard,
    });
  });

  // Get publishers by tier (public)
  app.get("/tier/:tier", async (request, reply) => {
    const { tier } = request.params as { tier: string };
    const { limit } = request.query as { limit?: string };

    const validTiers = ["new", "bronze", "silver", "gold", "platinum"];
    if (!validTiers.includes(tier)) {
      return reply.status(400).send({
        success: false,
        error: "Invalid tier. Must be one of: " + validTiers.join(", "),
      });
    }

    const publishers = await getPublishersByTier(
      tier,
      limit ? parseInt(limit) : 20
    );

    return reply.send({
      success: true,
      data: publishers,
    });
  });

  // Get all badge definitions (public)
  app.get("/badges", async (request, reply) => {
    const badges = getAllBadgesInfo();
    return reply.send({
      success: true,
      data: badges,
    });
  });

  // Get specific badge info (public)
  app.get("/badges/:badge", async (request, reply) => {
    const { badge } = request.params as { badge: string };
    const info = getBadgeInfo(badge);

    return reply.send({
      success: true,
      data: {
        id: badge,
        ...info,
      },
    });
  });

  // Get reputation for a specific publisher (public)
  app.get("/publisher/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };

    const profile = await prisma.publisherProfile.findUnique({
      where: { slug },
      select: {
        orgId: true,
        displayName: true,
        slug: true,
        avatarUrl: true,
        bio: true,
        website: true,
        twitter: true,
        github: true,
        isVerified: true,
        reputationScore: true,
        reputationTier: true,
        badges: true,
        totalListings: true,
        totalInstalls: true,
        avgResponseTimeMs: true,
        joinedDaysAgo: true,
        createdAt: true,
      },
    });

    if (!profile) {
      return reply.status(404).send({
        success: false,
        error: "Publisher not found",
      });
    }

    return reply.send({
      success: true,
      data: {
        ...profile,
        avgResponseTimeMs: profile.avgResponseTimeMs
          ? Number(profile.avgResponseTimeMs)
          : null,
      },
    });
  });

  // Get detailed reputation breakdown for a publisher (public)
  app.get("/publisher/:slug/breakdown", async (request, reply) => {
    const { slug } = request.params as { slug: string };

    const profile = await prisma.publisherProfile.findUnique({
      where: { slug },
    });

    if (!profile) {
      return reply.status(404).send({
        success: false,
        error: "Publisher not found",
      });
    }

    try {
      const breakdown = await calculateReputationScore(profile.orgId);
      return reply.send({
        success: true,
        data: breakdown,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        error: error.message,
      });
    }
  });

  // === Protected Routes ===

  // Get my reputation (authenticated)
  app.get(
    "/my-reputation",
    { preHandler: authenticate },
    async (request, reply) => {
      const { orgId } = request.user as { orgId: string };

      const profile = await prisma.publisherProfile.findUnique({
        where: { orgId },
      });

      if (!profile) {
        return reply.status(404).send({
          success: false,
          error: "You don't have a publisher profile yet",
        });
      }

      try {
        const breakdown = await calculateReputationScore(orgId);
        return reply.send({
          success: true,
          data: {
            profile: {
              displayName: profile.displayName,
              slug: profile.slug,
              avatarUrl: profile.avatarUrl,
              isVerified: profile.isVerified,
            },
            reputation: breakdown,
          },
        });
      } catch (error: any) {
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    }
  );

  // Manually trigger reputation recalculation (authenticated, for own profile)
  app.post(
    "/recalculate",
    { preHandler: authenticate },
    async (request, reply) => {
      const { orgId } = request.user as { orgId: string };

      const profile = await prisma.publisherProfile.findUnique({
        where: { orgId },
      });

      if (!profile) {
        return reply.status(404).send({
          success: false,
          error: "You don't have a publisher profile yet",
        });
      }

      try {
        const reputation = await updatePublisherReputation(orgId);
        return reply.send({
          success: true,
          data: reputation,
          message: "Reputation recalculated successfully",
        });
      } catch (error: any) {
        return reply.status(500).send({
          success: false,
          error: error.message,
        });
      }
    }
  );

  // Get tier distribution stats (public)
  app.get("/stats", async (request, reply) => {
    const stats = await prisma.publisherProfile.groupBy({
      by: ["reputationTier"],
      _count: {
        orgId: true,
      },
      where: {
        totalListings: { gt: 0 },
      },
    });

    const totalPublishers = await prisma.publisherProfile.count({
      where: { totalListings: { gt: 0 } },
    });

    const avgScore = await prisma.publisherProfile.aggregate({
      _avg: {
        reputationScore: true,
      },
      where: { totalListings: { gt: 0 } },
    });

    return reply.send({
      success: true,
      data: {
        totalPublishers,
        averageScore: avgScore._avg.reputationScore || 0,
        tierDistribution: stats.reduce(
          (acc, s) => ({
            ...acc,
            [s.reputationTier]: s._count.orgId,
          }),
          {}
        ),
      },
    });
  });
}
