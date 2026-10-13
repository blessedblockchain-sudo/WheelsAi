/**
 * A creator's plans on a listing.
 *
 *   PUT /api/marketplace/listings/:id/plans
 *
 * The body is the whole set, `{ plans: [{ id?, kind, name, priceCents,
 * includedUses, extraUsePriceCents }] }`, and it replaces what the listing
 * has: a plan sent with its id is changed in place, one left out is retired,
 * one with no id is new. People already on a plan keep the terms they agreed
 * to. The answer is the plans as they are now, as GET /my-listings shows
 * them.
 *
 * Who: an owner or admin of the organization the listing belongs to (their
 * role as it is now), or one of its API keys, which act for the organization
 * on the other routes that change a listing too.
 *
 * Cents and uses are whole numbers in JSON. Anything else is refused here,
 * before the rules of a plan (services/listingPlans.ts) are asked.
 *
 * Refusals are the listing's own (ListingError): 400 validation_failed with
 * a sentence for each field, 404 listing_not_found, 409 plans_not_available
 * for a listing that cannot have plans, and 409 plans_changed when another
 * save got there first.
 */
import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";

import { validationFailure } from "../lib/validationFailure.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import type { PlanInput } from "../services/listingPlans.js";
import type { OwnerPlan } from "../services/listingPlanStore.js";
import { ListingError, setListingPlans } from "../services/marketplace.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("listing-plan-routes");

/** More than a listing can have, so that one too many is told by the rules in a sentence. */
const MAX_PLANS_IN_BODY = 20;

const planSchema = z.object({
  id: z.string().uuid().optional(),
  kind: z.string().max(20),
  name: z.string().max(200),
  // The bounds here only keep a number whole and exact. The floors, and how
  // many uses a price allows, are the rules' to say.
  priceCents: z.number().int().min(-10_000_000).max(10_000_000),
  includedUses: z.number().int().min(-1_000_000).max(1_000_000),
  // Null says the plan stops until it renews. It must be said: left out, a
  // plan changed in place would lose its price for an extra use unasked.
  extraUsePriceCents: z.number().int().min(-100_000).max(100_000).nullable(),
});

const bodySchema = z.object({ plans: z.array(planSchema).max(MAX_PLANS_IN_BODY) });

export interface ListingPlanRouteDeps {
  guards: {
    /** Who are you. */
    auth: preHandlerAsyncHookHandler;
    /** A signed-in member must be an owner or admin. */
    ownerOrAdmin: preHandlerAsyncHookHandler;
  };
  /** services/marketplace.ts, setListingPlans, when omitted. */
  setPlans?: (listingId: string, orgId: string, plans: PlanInput[]) => Promise<OwnerPlan[]>;
}

export function createListingPlanRoutes(deps: ListingPlanRouteDeps): FastifyPluginAsync {
  const { auth, ownerOrAdmin } = deps.guards;
  const setPlans = deps.setPlans ?? setListingPlans;

  return async (app) => {
    app.put<{ Params: { id: string } }>(
      "/listings/:id/plans",
      {
        preHandler: [auth, ownerOrAdmin],
        schema: { tags: ["Marketplace"], description: "Set the plans of a listing that sells use per request" },
      },
      async (request, reply) => {
        const { orgId } = request.auth!;
        const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
        if (!params.success) return reply.status(400).send(validationFailure(params.error));
        const body = bodySchema.safeParse(request.body);
        if (!body.success) return reply.status(400).send(validationFailure(body.error));

        const plans: PlanInput[] = body.data.plans.map((plan) => ({
          ...(plan.id !== undefined && { id: plan.id }),
          kind: plan.kind,
          name: plan.name,
          priceCents: BigInt(plan.priceCents),
          includedUses: plan.includedUses,
          extraUsePriceCents: plan.extraUsePriceCents === null ? null : BigInt(plan.extraUsePriceCents),
        }));

        try {
          return { plans: await setPlans(params.data.id, orgId, plans) };
        } catch (error) {
          if (error instanceof ListingError) {
            return reply.status(error.status).send(error.body ?? { error: error.code, message: error.message });
          }
          logger.error({ error, orgId, listingId: params.data.id }, "Failed to set the plans of a listing");
          throw error;
        }
      },
    );
  };
}

export const listingPlanRoutes: FastifyPluginAsync = createListingPlanRoutes({
  guards: { auth: requireAuth, ownerOrAdmin: requireRole("owner", "admin") },
});
