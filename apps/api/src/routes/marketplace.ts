import crypto from "node:crypto";

import { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { canSpend as callerCanSpend, requireAuth, requireScope, requireSpend } from "../middleware/auth.js";
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
  InstallRefusedError,
  ListingError,
  listingProductProblem,
  startUsing,
  UseStartError,
  PricingChangedError,
  stoppedUsingMessage,
  uninstallAgent,
  getMyInstalls,
  checkInstallStatus,
  getPublisherRevenue,
  getMySubscriptions,
  setSubscriptionCancelAtPeriodEnd,
  SubscriptionNotFoundError,
  PRICING_MODELS,
} from "../services/marketplace.js";
import { InsufficientCreditsError, SubscriptionClaimLostError } from "../services/marketplaceSubscriptions.js";
import { movePlan, PLAN_MOVE_MESSAGES, PlanMoveError } from "../services/planMove.js";
import { AlreadyOnPlanError, PLAN_START_MESSAGES, PlanTermsChangedError, startPlan } from "../services/planStart.js";
import { TokenRequiredError } from "../services/tokenAccess.js";
import { TrialAlreadyUsedError, TrialNeedsCreditsError } from "../services/trialStart.js";

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
  // What the listing sells: an agent or a workflow of the organization.
  // Exactly one of the two, which the service checks and says in a sentence.
  agentId: z.string().uuid().optional(),
  orchestrationId: z.string().uuid().optional(),
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
  // What the listing sells: use of the creator's own agent, or copies of
  // it. Omitted on a new listing means use; an update that does not name it
  // leaves it as it is. The floors that depend on it (a price per use of 5
  // cents or more) are checked in the service, with the agent in hand.
  sells: z.enum(["use", "copies"]).optional(),
  // The outbound tools the creator allows for people who pay to use it.
  allowedTools: z.array(z.string().min(1).max(100)).max(50).optional(),
  // Publish in the same request.
  publish: z.literal(true).optional(),
});

/**
 * A listing refusal as its answer: the code, one plain sentence, and for a
 * 400 `validation_failed` the fields.
 */
function listingRefusal(error: ListingError) {
  return error.body ?? { error: error.code, message: error.message };
}

/**
 * What a failed listing write tells the person. A sentence the service
 * wrote is passed on; anything that came from the database is not.
 */
function listingFailureMessage(error: unknown): string {
  const known = error as { code?: unknown; clientVersion?: unknown; message?: unknown } | null;
  if (known?.clientVersion !== undefined || (typeof known?.code === "string" && /^P\d{4}$/.test(known.code))) {
    return "The listing could not be saved. Please try again.";
  }
  return typeof known?.message === "string" ? known.message : "The listing could not be saved. Please try again.";
}

/** The pricing a person was shown, as they send it back. */
const shownPricingSchema = z.object({
  pricingModel: z.enum(["free", "per_request", "monthly", "tokenized"]),
  pricePerRequestCents: z.number().int().nonnegative().nullable().optional(),
  monthlyPriceCents: z.number().int().nonnegative().nullable().optional(),
});

/**
 * The plan a person was shown, as they send it back: its id and every one
 * of its terms, in whole cents. The price for an extra use is always said,
 * null when the plan stops: left out, it would be guessed.
 */
const shownPlanSchema = z.object({
  id: z.string().uuid(),
  priceCents: z.number().int().nonnegative().max(10_000_000),
  includedUses: z.number().int().positive().max(1_000_000),
  extraUsePriceCents: z.number().int().nonnegative().max(100_000).nullable(),
});

// A change never names what the listing sells: a listing keeps its agent or
// its workflow for as long as it exists.
const updateListingSchema = createListingSchema.omit({ agentId: true, orchestrationId: true }).partial();

const createReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().max(200).optional(),
  content: z.string().max(5000).optional(),
});

// ============================================
// Routes
// ============================================

/** The scope a key needs, by name, to start using a listing, move to another plan or resume a renewal. */
const SPEND_ON_LISTINGS_SCOPE = "marketplace:install";

/** What the guard on those three decides for this caller, as a yes or a no. */
const mayStartMoveOrResume = (auth: Parameters<typeof callerCanSpend>[0]) =>
  callerCanSpend(auth, SPEND_ON_LISTINGS_SCOPE);

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

      // An agent or a workflow, one of them: said before anything else is.
      const oneProduct = listingProductProblem(body);
      if (oneProduct) return reply.status(oneProduct.status).send(listingRefusal(oneProduct));

      // Validate pricing. A workflow's listing has rules of its own, and the
      // service says each of them on its field.
      if (body.orchestrationId === undefined) {
        if (body.pricingModel === "per_request" && !body.pricePerRequestCents) {
          return reply.badRequest("Price per request is required for per_request pricing model");
        }
        if (body.pricingModel === "monthly" && !body.monthlyPriceCents) {
          return reply.badRequest("Monthly price is required for monthly pricing model");
        }
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
        if (error instanceof ListingError) {
          return reply.status(error.status).send(listingRefusal(error));
        }
        logger.error({ error, orgId }, "Failed to create listing");
        return reply.badRequest(listingFailureMessage(error));
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
        if (error instanceof ListingError) {
          return reply.status(error.status).send(listingRefusal(error));
        }
        logger.error({ error, orgId, listingId: id }, "Failed to update listing");
        return reply.badRequest(listingFailureMessage(error));
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
        if (error instanceof ListingError) {
          return reply.status(error.status).send(listingRefusal(error));
        }
        logger.error({ error, orgId, listingId: id }, "Failed to publish listing");
        return reply.badRequest(listingFailureMessage(error));
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
    // Installing can charge (a monthly listing bills at install), so an API
    // key needs the spend scope by name; "*" and an unscoped key do not
    // carry it (config/apiKeyScopes.ts).
    { preHandler: [requireAuth, requireScope("marketplace:install")] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      // acceptNewPricing is sent only by a buyer who was shown the listing's
      // new pricing after the publisher changed it; without it that case
      // answers 409. expectedPricing is the pricing the buyer was looking at
      // when they confirmed: if the listing has moved since, this answers
      // 409 with the pricing as it stands and nothing is charged.
      const { acceptNewPricing, expectedPricing } = z
        .object({
          acceptNewPricing: z.boolean().optional(),
          expectedPricing: shownPricingSchema.optional(),
        })
        .parse(request.body ?? {});

      try {
        const result = await installAgent(id, orgId, {
          acceptNewPricing,
          ...(expectedPricing && {
            expectedPricing: {
              pricingModel: expectedPricing.pricingModel,
              pricePerRequestCents: expectedPricing.pricePerRequestCents ?? null,
              monthlyPriceCents: expectedPricing.monthlyPriceCents ?? null,
            },
          }),
        });
        return reply.status(201).send({
          message: "Agent installed successfully",
          install: result.install,
          clonedAgent: result.clonedAgent,
          subscription: result.subscription,
        });
      } catch (error: any) {
        // The listing sells use of the creator's agent, or this buyer
        // already uses it: there is no copy to install. The handle is where
        // the person uses it.
        if (error instanceof InstallRefusedError) {
          return reply.status(error.status).send({
            error: error.code,
            message: error.message,
            handle: error.handle,
          });
        }
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
        if (error instanceof PricingChangedError) {
          return reply.status(409).send({
            error: error.code,
            message: error.message,
            pricing: error.pricing,
          });
        }
        // Another request (or the renewal worker) holds the subscription.
        // Nothing was charged.
        if (error instanceof SubscriptionClaimLostError) {
          return reply.status(409).send({ error: error.code, message: error.message });
        }
        logger.error({ error, orgId, listingId: id }, "Failed to install agent");
        return reply.badRequest(error.message);
      }
    }
  );

  /**
   * POST /listings/:id/use - Start using a creator's agent, or accept its
   * current price.
   *
   * No copy is made: the buyer uses the agent on its page or through the
   * API. A price per use charges nothing here; a monthly price charges the
   * first 30 days. Stopping is POST /listings/:id/uninstall.
   *
   * While the listing is paused (the model its agent runs on is not
   * running) nothing is started and nothing is charged: 409 listing_paused,
   * or 503 service_unavailable when that could not be checked.
   *
   * With `plan` in the body ({ id, priceCents, includedUses,
   * extraUsePriceCents }, the plan the person was shown) it starts that plan
   * instead and charges its 30 days now: 409 pricing_changed with the plans
   * as they are when any term differs, 409 already_on_plan while a plan or
   * a month still runs. Starting a plan agrees to no price per use.
   *
   * A `plan` that is the listing's free trial ({ id, priceCents: 0,
   * includedUses, extraUsePriceCents: null }, the trial as shown) starts the
   * trial instead: 7 days, its uses, nothing charged, once per organization
   * and listing. 409 trial_already_used, 409 trial_needs_credits (credits
   * were never added to the account), 409 already_on_plan, and 409
   * pricing_changed with `trial` beside the plans when its terms differ.
   * Over a trial that is running, a paid plan is started by the same request
   * as any other start.
   *
   * With `plan` and `switchNow: true` it moves a buyer who is on a plan up
   * to that bigger plan now: its full price is charged, a fresh 30 days
   * starts and the uses that were left are carried into it once. 409
   * not_on_plan, same_plan, not_a_bigger_plan; 409 pricing_changed as at a
   * start; 409 subscription_claim_lost when the row changed first; 409
   * trial_cannot_move for a buyer on a free trial. Nothing is charged on any
   * of them.
   */
  app.post(
    "/listings/:id/use",
    // Agreeing to a price spends the organization's money: a signed-in
    // member must be an owner or admin (their role as it is now), and an
    // API key must have been granted the spend scope by name; "*" and an
    // unscoped key do not carry it (config/apiKeyScopes.ts).
    { preHandler: [requireAuth, requireSpend(SPEND_ON_LISTINGS_SCOPE)] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const sent =
        request.body !== null && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
      // A move to another plan is asked for with `switchNow: true` and the
      // plan, sent whole. A body that names switchNow in any other way is
      // refused whole, so that it is never read as an ordinary start or as
      // an agreement to a price per use.
      const move = "switchNow" in sent;
      if (move && (sent.switchNow !== true || !shownPlanSchema.safeParse(sent.plan).success)) {
        return reply.status(400).send({ error: "invalid_plan_move", message: PLAN_MOVE_MESSAGES.body });
      }
      if (sent.plan !== undefined) {
        // The plan's terms as shown are the consent. The listing's price per
        // use is not agreed to by this, whatever else the body carries.
        const shown = shownPlanSchema.safeParse(sent.plan);
        if (!shown.success) {
          return reply
            .status(400)
            .send({ error: "expected_terms_required", message: PLAN_START_MESSAGES.termsRequired });
        }
        try {
          // A plan start, or a move, that changes nothing is a refusal, so
          // this is always 201.
          const { created: _created, ...state } = await (move ? movePlan : startPlan)(id, orgId, {
            id: shown.data.id,
            priceCents: BigInt(shown.data.priceCents),
            includedUses: shown.data.includedUses,
            extraUsePriceCents:
              shown.data.extraUsePriceCents === null ? null : BigInt(shown.data.extraUsePriceCents),
          });
          return reply.status(201).send(state);
        } catch (error: any) {
          if (error instanceof UseStartError) {
            return reply.status(error.status).send({
              error: error.code,
              message: error.message,
              ...(error.until && { until: error.until.toISOString() }),
            });
          }
          if (error instanceof InsufficientCreditsError) {
            return reply.status(402).send({
              error: error.code,
              message: PLAN_START_MESSAGES.notEnoughCredits(error.requiredCents),
              requiredCents: Number(error.requiredCents),
            });
          }
          // The plan is not what the person was shown. Nothing was charged;
          // the plans as they are now come with the answer.
          if (error instanceof PlanTermsChangedError) {
            return reply.status(409).send({
              error: error.code,
              message: error.message,
              pricing: error.pricing,
              plans: error.plans,
              // Only when a free trial was asked for: the trial on offer now.
              ...(error.trial !== undefined && { trial: error.trial }),
            });
          }
          // A plan or a month still runs, the buyer's row does not allow the
          // move, another request for this buyer got there first, or a free
          // trial cannot be started: one was used before, or credits were
          // never added. Nothing was charged by this one.
          if (
            error instanceof AlreadyOnPlanError ||
            error instanceof PlanMoveError ||
            error instanceof SubscriptionClaimLostError ||
            error instanceof TrialAlreadyUsedError ||
            error instanceof TrialNeedsCreditsError
          ) {
            return reply.status(409).send({ error: error.code, message: error.message });
          }
          throw error;
        }
      }
      // expected is the pricing the person was shown, and is their consent:
      // without it nothing is agreed to. acceptNewPricing is sent only by a
      // buyer who was shown that the price went up, or the pricing model
      // changed, after they started.
      const body = z
        .object({
          expected: shownPricingSchema.optional(),
          acceptNewPricing: z.boolean().optional(),
        })
        .safeParse(request.body ?? {});
      if (!body.success || !body.data.expected) {
        return reply.status(400).send({
          error: "expected_terms_required",
          message: "Send the price you were shown, so nothing is agreed to that you did not see.",
        });
      }
      const { expected, acceptNewPricing } = body.data;

      try {
        const { created, ...state } = await startUsing(id, orgId, {
          acceptNewPricing,
          expected: {
            pricingModel: expected.pricingModel,
            pricePerRequestCents: expected.pricePerRequestCents ?? null,
            monthlyPriceCents: expected.monthlyPriceCents ?? null,
          },
        });
        // 201 when this request started or accepted something; 200 with the
        // state as it stands when there was nothing to do.
        return reply.status(created ? 201 : 200).send(state);
      } catch (error: any) {
        if (error instanceof UseStartError) {
          // `until` comes with copy_subscription_active: the day the
          // month paid for the buyer's copy ends.
          return reply.status(error.status).send({
            error: error.code,
            message: error.message,
            ...(error.until && { until: error.until.toISOString() }),
          });
        }
        if (error instanceof InsufficientCreditsError) {
          return reply.status(402).send({
            error: error.code,
            message: error.message,
            requiredCents: Number(error.requiredCents),
          });
        }
        // The price or the pricing model is not what the person was shown,
        // or not what their licence agreed to. Nothing was charged.
        if (error instanceof PricingChangedError) {
          return reply.status(409).send({
            error: error.code,
            message: error.message,
            pricing: error.pricing,
          });
        }
        // Another request for this buyer got there first. Nothing was
        // charged by this one.
        if (error instanceof SubscriptionClaimLostError) {
          return reply.status(409).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    }
  );

  /**
   * POST /listings/:id/uninstall - Uninstall an agent, or stop using a
   * workflow: the same path, each in its own words.
   */
  app.post(
    "/listings/:id/uninstall",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      try {
        const { productKind } = await uninstallAgent(id, orgId);
        return { message: stoppedUsingMessage(productKind) };
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
      // `canSpend`: whether this caller may start, move up or resume, which
      // is what the guard on those routes decides. The page offers them only
      // then. Asked beside the installs, and a "no" when it cannot be asked.
      const [installs, canSpend] = await Promise.all([
        getMyInstalls(orgId),
        mayStartMoveOrResume(request.auth),
      ]);
      return { installs, canSpend };
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
   *
   * Resuming turns the charges back on, so it needs the right a start needs:
   * an owner or admin, or an API key granted marketplace:install by name.
   * Cancelling only ever stops a charge, and stays open to every member.
   */
  for (const action of ["cancel", "resume"] as const) {
    app.post(
      `/subscriptions/:listingId/${action}`,
      { preHandler: action === "resume" ? [requireAuth, requireSpend(SPEND_ON_LISTINGS_SCOPE)] : [requireAuth] },
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
  // Revenue Routes
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

  // Requesting, cancelling and listing payouts: routes/payouts.ts, mounted
  // under this same prefix (index.ts).
};
