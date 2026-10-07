/**
 * /api/jobs: a job as its buyer and its publisher see it, and what the
 * buyer can do with the deliverable (Offerings and Jobs). Hiring is
 * POST /api/offerings/:id/hire.
 *
 *   GET   /              the caller's jobs (role=buyer|publisher)  jobs:read
 *   GET   /summary       what is waiting on the caller             jobs:read
 *   GET   /:id           role-aware; 404 for everyone else         jobs:read
 *   POST  /:id/accept    release the escrow                 spend: jobs:review
 *   POST  /:id/reject    refuse inside the review window    spend: jobs:review
 *   POST  /:id/cancel    before it starts                   spend: jobs:hire
 *   POST  /:id/rate      once, after completion                    jobs:review
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import {
  acceptBodySchema,
  acceptJob,
  cancelBodySchema,
  cancelJob,
  getJob,
  jobListSchema,
  listJobs,
  rateBodySchema,
  rateJobAsBuyer,
  rejectBodySchema,
  rejectJobAsBuyer,
  type JobServiceDeps,
} from "../services/jobs.js";
import type { JobRouteGuards } from "./jobGuards.js";
import { sendServiceError } from "./offerings.js";

export interface JobRouteDeps {
  jobs: JobServiceDeps;
  guards: JobRouteGuards;
}

const idParams = z.object({ id: z.string().uuid() });

export function createJobRoutes(deps: JobRouteDeps): FastifyPluginAsync {
  return async (app) => {
    const { guards } = deps;
    const reader = [guards.auth, guards.scope("jobs:read")];

    app.get("/", { preHandler: reader }, async (request, reply) => {
      try {
        const query = jobListSchema.parse(request.query);
        return await listJobs(deps.jobs, { ...query, orgId: request.auth!.orgId });
      } catch (err) {
        return sendServiceError(reply, err);
      }
    });

    // The app's notice that something is waiting: deliverables to review,
    // jobs in progress, jobs to deliver.
    app.get("/summary", { preHandler: reader }, async (request) => deps.jobs.store.summary(request.auth!.orgId));

    app.get("/:id", { preHandler: reader }, async (request, reply) => {
      try {
        const { id } = idParams.parse(request.params);
        return { job: await getJob(deps.jobs, id, request.auth!.orgId) };
      } catch (err) {
        return sendServiceError(reply, err);
      }
    });

    app.post("/:id/accept", { preHandler: [guards.auth, guards.spend("jobs:review")] }, async (request, reply) => {
      try {
        const { id } = idParams.parse(request.params);
        const body = acceptBodySchema.parse(request.body ?? {});
        return await acceptJob(deps.jobs, { jobId: id, orgId: request.auth!.orgId, ...body });
      } catch (err) {
        return sendServiceError(reply, err);
      }
    });

    app.post("/:id/reject", { preHandler: [guards.auth, guards.spend("jobs:review")] }, async (request, reply) => {
      try {
        const { id } = idParams.parse(request.params);
        const { reason } = rejectBodySchema.parse(request.body);
        return await rejectJobAsBuyer(deps.jobs, { jobId: id, orgId: request.auth!.orgId, reason });
      } catch (err) {
        return sendServiceError(reply, err);
      }
    });

    app.post("/:id/cancel", { preHandler: [guards.auth, guards.spend("jobs:hire")] }, async (request, reply) => {
      try {
        const { id } = idParams.parse(request.params);
        const { reason } = cancelBodySchema.parse(request.body ?? {});
        return await cancelJob(deps.jobs, { jobId: id, orgId: request.auth!.orgId, reason });
      } catch (err) {
        return sendServiceError(reply, err);
      }
    });

    // Moves no money, so any member may rate; a key still needs jobs:review.
    app.post("/:id/rate", { preHandler: [guards.auth, guards.scope("jobs:review")] }, async (request, reply) => {
      try {
        const { id } = idParams.parse(request.params);
        const body = rateBodySchema.parse(request.body);
        return await rateJobAsBuyer(deps.jobs, { jobId: id, orgId: request.auth!.orgId, ...body });
      } catch (err) {
        return sendServiceError(reply, err);
      }
    });
  };
}
