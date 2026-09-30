import crypto from "node:crypto";

import { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireAuth, requireJwtAuth, requireRole } from "../middleware/auth.js";
import { createLogger } from "../utils/logger.js";
import { prisma } from "@wheelsai/db";
import {
  searchListings,
  getListingBySlug,
  getListingById,
  getFeaturedListings,
  getCategoryStats,
  getListingReviews,
  createReview,
  getPublisherProfile,
  createListing,
  updateListing,
  publishListing,
  archiveListing,
  getMyListings,
  installAgent,
  uninstallAgent,
  getMyInstalls,
  checkInstallStatus,
  getPublisherRevenue,
  requestPayout,
  PayoutReservationConflictError,
  getPayoutHistory,
  getMySubscriptions,
  setSubscriptionCancelAtPeriodEnd,
  SubscriptionNotFoundError,
  PRICING_MODELS,
} from "../services/marketplace.js";
import { InsufficientCreditsError } from "../services/marketplaceSubscriptions.js";
import { TokenRequiredError } from "../services/tokenAccess.js";

const logger = createLogger("marketplace-routes");

// ============================================
// Schemas
// ============================================

const searchQuerySchema = z.object({
  query: z.string().optional(),
  category: z.string().optional(),
  pricingModel: z.string().optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  sortBy: z.enum(["popular", "rating", "newest", "price_low", "price_high"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const createListingSchema = z.object({
  agentId: z.string().uuid(),
  title: z.string().min(3).max(100),
  shortDescription: z.string().min(10).max(280),
  longDescription: z.string().max(10000).optional(),
  category: z.enum([
    "customer-support",
    "coding",
    "research",
    "automation",
    "creative",
    "other",
  ]),
  iconUrl: z.string().url().optional(),
  screenshots: z.array(z.string().url()).max(10).optional(),
  readme: z.string().max(50000).optional(),
  pricingModel: z.enum(["free", "per_request", "monthly", "tokenized"]),
  pricePerRequestCents: z.number().int().min(1).max(100000).optional(),
  monthlyPriceCents: z.number().int().min(100).max(10000000).optional(),
});

const updateListingSchema = createListingSchema.omit({ agentId: true }).partial();

const createReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().max(200).optional(),
  content: z.string().max(5000).optional(),
});

// ============================================
// Routes
// ============================================

export const marketplaceRoutes: FastifyPluginAsync = async (app) => {
  // ==========================================
  // Public Routes (No Auth Required)
  // ==========================================

  /**
   * GET /listings - Search and filter marketplace listings
   */
  app.get("/listings", async (request) => {
    const query = searchQuerySchema.parse(request.query);
    return searchListings(query);
  });

  /**
   * GET /listings/:slug - Get listing by slug
   */
  app.get("/listings/:slug", async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);

    // Try by slug first, then by ID
    let listing = await getListingBySlug(slug);
    if (!listing) {
      // Check if it's a UUID
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug);
      if (isUuid) {
        listing = await getListingById(slug);
      }
    }

    if (!listing) {
      return reply.notFound("Listing not found");
    }

    return { listing };
  });

  /**
   * GET /listings/:id/reviews - Get reviews for a listing
   */
  app.get("/listings/:id/reviews", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { page, limit } = z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(10),
    }).parse(request.query);

    return getListingReviews(id, page, limit);
  });

  /**
   * GET /categories - Get all categories with listing counts
   */
  app.get("/categories", async () => {
    const stats = await getCategoryStats();
    return { categories: stats };
  });

  /**
   * GET /featured - Get featured listings
   */
  app.get("/featured", async (request) => {
    const { limit } = z.object({
      limit: z.coerce.number().int().min(1).max(20).default(6),
    }).parse(request.query);

    const listings = await getFeaturedListings(limit);
    return { listings };
  });

  /**
   * GET /publishers/:slug - Get publisher profile
   */
  app.get("/publishers/:slug", async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);

    const profile = await getPublisherProfile(slug);
    if (!profile) {
      return reply.notFound("Publisher not found");
    }

    return { publisher: profile };
  });

  /**
   * GET /pricing-models - Get available pricing models
   */
  app.get("/pricing-models", async () => {
    return { pricingModels: PRICING_MODELS };
  });

  // ==========================================
  // Protected Routes (Auth Required)
  // ==========================================

  /**
   * POST /listings - Create a new listing
   */
  app.post(
    "/listings",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const body = createListingSchema.parse(request.body);

      // Validate pricing
      if (body.pricingModel === "per_request" && !body.pricePerRequestCents) {
        return reply.badRequest("Price per request is required for per_request pricing model");
      }
      if (body.pricingModel === "monthly" && !body.monthlyPriceCents) {
        return reply.badRequest("Monthly price is required for monthly pricing model");
      }

      // Fetch org name
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true },
      });

      try {
        const listing = await createListing(orgId, org?.name || "Unknown", body);
        return reply.status(201).send({ listing });
      } catch (error: any) {
        logger.error({ error, orgId }, "Failed to create listing");
        return reply.badRequest(error.message);
      }
    }
  );

  /**
   * PATCH /listings/:id - Update a listing
   */
  app.patch(
    "/listings/:id",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = updateListingSchema.parse(request.body);

      try {
        const listing = await updateListing(id, orgId, body);
        return { listing };
      } catch (error: any) {
        logger.error({ error, orgId, listingId: id }, "Failed to update listing");
        return reply.badRequest(error.message);
      }
    }
  );

  /**
   * POST /listings/:id/publish - Publish a listing
   */
  app.post(
    "/listings/:id/publish",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      try {
        const listing = await publishListing(id, orgId);
        return { listing, message: "Listing published successfully" };
      } catch (error: any) {
        logger.error({ error, orgId, listingId: id }, "Failed to publish listing");
        return reply.badRequest(error.message);
      }
    }
  );

  /**
   * POST /listings/:id/archive - Archive a listing
   */
  app.post(
    "/listings/:id/archive",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      try {
        const listing = await archiveListing(id, orgId);
        return { listing, message: "Listing archived successfully" };
      } catch (error: any) {
        logger.error({ error, orgId, listingId: id }, "Failed to archive listing");
        return reply.badRequest(error.message);
      }
    }
  );

  /**
   * PATCH /listings/:id/featured — platform curation (Wave 1).
   *
   * Nothing ever wrote AgentListing.isFeatured, so every "Featured"
   * section was permanently empty. Curation is an OPERATOR action, not
   * a publisher one (self-featuring defeats the point), so this is
   * gated by PLATFORM_ADMIN_KEY via the x-admin-key header rather than
   * org auth. Read from process.env at request time so key rotation
   * doesn't need a reboot. Unset ⇒ honest 503.
   */
  app.patch("/listings/:id/featured", async (request, reply) => {
    const adminKey = process.env.PLATFORM_ADMIN_KEY;
    if (!adminKey) {
      return reply.status(503).send({
        error: "curation_not_configured",
        message: "PLATFORM_ADMIN_KEY is not set on this deployment.",
      });
    }
    const presented = request.headers["x-admin-key"];
    const presentedHash = crypto
      .createHash("sha256")
      .update(typeof presented === "string" ? presented : "")
      .digest();
    const expectedHash = crypto.createHash("sha256").update(adminKey).digest();
    if (!crypto.timingSafeEqual(presentedHash, expectedHash)) {
      return reply.status(401).send({ error: "invalid_admin_key" });
    }

    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { isFeatured } = z
      .object({ isFeatured: z.boolean() })
      .parse(request.body);

    const { count } = await prisma.agentListing.updateMany({
      where: { id },
      data: { isFeatured },
    });
    if (count === 0) {
      return reply.notFound("Listing not found");
    }

    logger.info({ listingId: id, isFeatured }, "Listing curation updated");
    return { listing: { id, isFeatured } };
  });

  /**
   * GET /my-listings - Get current user's listings
   */
  app.get(
    "/my-listings",
    { preHandler: [requireAuth] },
    async (request) => {
      const { orgId } = request.auth!;
      const listings = await getMyListings(orgId);
      return { listings };
    }
  );

  /**
   * POST /listings/:id/reviews - Create a review
   */
  app.post(
    "/listings/:id/reviews",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = createReviewSchema.parse(request.body);

      try {
        const review = await createReview(id, orgId, body);
        return reply.status(201).send({ review });
      } catch (error: any) {
        logger.error({ error, orgId, listingId: id }, "Failed to create review");
        return reply.badRequest(error.message);
      }
    }
  );

  // ==========================================
  // Install / Deploy Routes
  // ==========================================

  /**
   * POST /listings/:id/install - Install an agent from marketplace
   */
  app.post(
    "/listings/:id/install",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      try {
        const result = await installAgent(id, orgId);
        return reply.status(201).send({
          message: "Agent installed successfully",
          install: result.install,
          clonedAgent: result.clonedAgent,
          subscription: result.subscription,
        });
      } catch (error: any) {
        if (error instanceof InsufficientCreditsError) {
          return reply.status(402).send({
            error: error.code,
            message: error.message,
            requiredCents: Number(error.requiredCents),
          });
        }
        if (error instanceof TokenRequiredError) {
          return reply.status(403).send({
            error: error.code,
            message: error.message,
            tokenSymbol: error.token.symbol,
            mintAddress: error.token.mintAddress,
            requiredBalance: error.minTokens,
          });
        }
        logger.error({ error, orgId, listingId: id }, "Failed to install agent");
        return reply.badRequest(error.message);
      }
    }
  );

  /**
   * POST /listings/:id/uninstall - Uninstall an agent
   */
  app.post(
    "/listings/:id/uninstall",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      try {
        await uninstallAgent(id, orgId);
        return { message: "Agent uninstalled successfully" };
      } catch (error: any) {
        logger.error({ error, orgId, listingId: id }, "Failed to uninstall agent");
        return reply.badRequest(error.message);
      }
    }
  );

  /**
   * GET /listings/:id/install-status - Check if user has installed this agent
   */
  app.get(
    "/listings/:id/install-status",
    { preHandler: [requireAuth] },
    async (request) => {
      const { orgId } = request.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      const status = await checkInstallStatus(id, orgId);
      return status;
    }
  );

  /**
   * GET /my-installs - Get user's installed agents
   */
  app.get(
    "/my-installs",
    { preHandler: [requireAuth] },
    async (request) => {
      const { orgId } = request.auth!;
      const installs = await getMyInstalls(orgId);
      return { installs };
    }
  );

  // ==========================================
  // Monthly Subscription Routes
  // ==========================================

  /**
   * GET /subscriptions - The org's monthly subscriptions
   */
  app.get(
    "/subscriptions",
    { preHandler: [requireAuth] },
    async (request) => {
      const { orgId } = request.auth!;
      return { subscriptions: await getMySubscriptions(orgId) };
    }
  );

  /**
   * POST /subscriptions/:listingId/cancel - Stop renewing at period end
   * POST /subscriptions/:listingId/resume - Keep renewing
   */
  for (const action of ["cancel", "resume"] as const) {
    app.post(
      `/subscriptions/:listingId/${action}`,
      { preHandler: [requireAuth] },
      async (request, reply) => {
        const { orgId } = request.auth!;
        const { listingId } = z.object({ listingId: z.string().uuid() }).parse(request.params);
        try {
          const subscription = await setSubscriptionCancelAtPeriodEnd(orgId, listingId, action === "cancel");
          return { subscription };
        } catch (error) {
          if (error instanceof SubscriptionNotFoundError) {
            return reply.status(404).send({ error: error.code, message: error.message });
          }
          throw error;
        }
      }
    );
  }

  // ==========================================
  // Revenue & Payout Routes
  // ==========================================

  /**
   * GET /revenue - Get publisher revenue dashboard
   */
  app.get(
    "/revenue",
    { preHandler: [requireAuth] },
    async (request) => {
      const { orgId } = request.auth!;
      const revenue = await getPublisherRevenue(orgId);
      return revenue;
    }
  );

  /**
   * POST /payouts - Request a payout
   */
  // Human sessions only: the caller supplies the payout address, so an
  // API key (which bypasses role checks) must never be able to redirect a
  // creator's earnings.
  app.post(
    "/payouts",
    { preHandler: [requireAuth, requireJwtAuth, requireRole("owner", "admin")] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const body = z
        .object({
          payoutMethod: z.enum(["credits", "crypto_usdc", "crypto_sol"]),
          payoutAddress: z.string().optional(),
        })
        .parse(request.body);

      try {
        const result = await requestPayout(orgId, body.payoutMethod, body.payoutAddress);
        return reply.status(201).send(result);
      } catch (error: any) {
        if (error instanceof PayoutReservationConflictError) {
          return reply.status(409).send({ error: error.code, message: error.message });
        }
        logger.error({ error, orgId }, "Failed to request payout");
        return reply.badRequest(error.message);
      }
    }
  );

  /**
   * GET /payouts - Get payout history
   */
  app.get(
    "/payouts",
    { preHandler: [requireAuth] },
    async (request) => {
      const { orgId } = request.auth!;
      const payouts = await getPayoutHistory(orgId);
      return { payouts };
    }
  );
};
