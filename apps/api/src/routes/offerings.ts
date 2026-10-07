/**
 * /api/offerings: what a publisher sells, and the door a buyer hires
 * through (Offerings and Jobs).
 *
 *   POST   /                    create a draft            offerings:write
 *   GET    /mine                the caller's offerings    offerings:write
 *   GET    /mine/:id                                      offerings:write
 *   PATCH  /:id                                           offerings:write
 *   POST   /:id/activate|pause|archive                    offerings:write
 *   POST   /validate            check a schema, samples and checks
 *   POST   /:id/test-run        run it once, no money     offerings:write
 *   GET    /                    active offerings          public
 *   GET    /:slug               one active offering       public
 *   POST   /:id/hire            pay into escrow           spend: jobs:hire
 *                               body.expected = the terms the buyer saw;
 *                               409 offering_terms_changed when they moved
 *
 * The public reads answer PublicOffering, which cannot carry the private
 * instructions. Every publisher route is scoped to the caller's
 * organization inside the service.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { hireBodySchema, hireOffering, JobError, type JobServiceDeps } from "../services/jobs.js";
import {
  createOffering,
  createOfferingSchema,
  getOwnedOffering,
  getPublicOffering,
  listOwnedOfferings,
  OFFERING_STATUSES,
  OfferingError,
  publicSearchSchema,
  searchPublicOfferings,
  setOfferingStatus,
  testRunBodySchema,
  testRunOffering,
  updateOffering,
  updateOfferingSchema,
  validateOfferingContent,
  validateOfferingSchema,
  type OfferingAction,
  type OfferingServiceDeps,
  type OfferingTestRunDeps,
} from "../services/offerings.js";
import type { JobRouteGuards } from "./jobGuards.js";

export interface OfferingRouteDeps {
  offerings: OfferingServiceDeps;
  jobs: JobServiceDeps;
  testRun: Omit<OfferingTestRunDeps, "store">;
  guards: JobRouteGuards;
}

const idParams = z.object({ id: z.string().uuid() });
const slugParams = z.object({ slug: z.string().min(1).max(200) });
const mineQuery = z.object({ status: z.enum(OFFERING_STATUSES as [string, ...string[]]).optional() });

/** Answers a service's typed error in the house shape; rethrows anything else. */
export function sendServiceError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof OfferingError) {
    return reply.status(err.status).send({
      error: err.code,
      message: err.message,
      ...(err.details && { details: err.details }),
    });
  }
  if (err instanceof JobError) {
    return reply.status(err.status).send({ error: err.code, message: err.message, ...err.extra });
  }
  if (err instanceof z.ZodError) {
    return reply.status(400).send({
      error: "invalid_request",
      message: "The request is not valid",
      details: err.issues.map((issue) => ({ path: `/${issue.path.join("/")}`, message: issue.message })),
    });
  }
  throw err;
}

/** The caller, as the job records who spent the money. */
export function jobCaller(request: FastifyRequest) {
  const auth = request.auth!;
  return { orgId: auth.orgId, userId: auth.userId, apiKeyId: auth.apiKeyId ?? null };
}

export function createOfferingRoutes(deps: OfferingRouteDeps): FastifyPluginAsync {
  return async (app) => {
    const { guards } = deps;
    const publisher = [guards.auth, guards.scope("offerings:write")];

    app.post("/", { preHandler: publisher }, async (request, reply) => {
      try {
        const body = createOfferingSchema.parse(request.body);
        const offering = await createOffering(deps.offerings, request.auth!.orgId, body);
        return reply.status(201).send({ offering });
      } catch (err) {
        return sendServiceError(reply, err);
      }
    });

    app.get("/mine", { preHandler: publisher }, async (request, reply) => {
      try {
        const { status } = mineQuery.parse(request.query);
        const offerings = await listOwnedOfferings(
          deps.offerings,
          request.auth!.orgId,
          status as (typeof OFFERING_STATUSES)[number] | undefined,
        );
        return { offerings };
      } catch (err) {
        return sendServiceError(reply, err);
      }
    });

    app.get("/mine/:id", { preHandler: publisher }, async (request, reply) => {
      try {
        const { id } = idParams.parse(request.params);
        return { offering: await getOwnedOffering(deps.offerings, request.auth!.orgId, id) };
      } catch (err) {
        return sendServiceError(reply, err);
      }
    });

    app.patch("/:id", { preHandler: publisher }, async (request, reply) => {
      try {
        const { id } = idParams.parse(request.params);
        const body = updateOfferingSchema.parse(request.body);
        return { offering: await updateOffering(deps.offerings, request.auth!.orgId, id, body) };
      } catch (err) {
        return sendServiceError(reply, err);
      }
    });

    for (const action of ["activate", "pause", "archive"] as const satisfies readonly OfferingAction[]) {
      app.post(`/:id/${action}`, { preHandler: publisher }, async (request, reply) => {
        try {
          const { id } = idParams.parse(request.params);
          return { offering: await setOfferingStatus(deps.offerings, request.auth!.orgId, id, action) };
        } catch (err) {
          return sendServiceError(reply, err);
        }
      });
    }

    // The editor's live validation: the same checks a save runs, saving nothing.
    app.post("/validate", { preHandler: publisher }, async (request, reply) => {
      try {
        validateOfferingContent(validateOfferingSchema.parse(request.body));
        return { ok: true };
      } catch (err) {
        return sendServiceError(reply, err);
      }
    });

    app.post(
      "/:id/test-run",
      {
        preHandler: publisher,
        // Each one is a real run of the product on the publisher's own usage.
        config: {
          rateLimit: {
            max: 10,
            timeWindow: "1 minute",
            keyGenerator: (request: FastifyRequest) => `offering-test-run:${request.auth?.orgId ?? request.ip}`,
          },
        },
      },
      async (request, reply) => {
        try {
          const { id } = idParams.parse(request.params);
          const { input } = testRunBodySchema.parse(request.body ?? {});
          return await testRunOffering(
            { ...deps.testRun, store: deps.offerings.store },
            request.auth!.orgId,
            id,
            input,
          );
        } catch (err) {
          return sendServiceError(reply, err);
        }
      },
    );

    app.get("/", async (request, reply) => {
      try {
        return await searchPublicOfferings(deps.offerings, publicSearchSchema.parse(request.query));
      } catch (err) {
        return sendServiceError(reply, err);
      }
    });

    app.get("/:slug", async (request, reply) => {
      try {
        const { slug } = slugParams.parse(request.params);
        return { offering: await getPublicOffering(deps.offerings, slug) };
      } catch (err) {
        return sendServiceError(reply, err);
      }
    });

    app.post("/:id/hire", { preHandler: [guards.auth, guards.spend("jobs:hire")] }, async (request, reply) => {
      try {
        const { id } = idParams.parse(request.params);
        const { input, expected } = hireBodySchema.parse(request.body ?? {});
        const header = request.headers["idempotency-key"];
        const result = await hireOffering(deps.jobs, {
          offeringId: id,
          caller: jobCaller(request),
          input,
          expected,
          idempotencyKey: Array.isArray(header) ? header[0] : header,
        });
        // 200 for a repeated Idempotency-Key: the same job, no second charge.
        return reply.status(result.replayed ? 200 : 201).send({ job: result.job });
      } catch (err) {
        return sendServiceError(reply, err);
      }
    });
  };
}
