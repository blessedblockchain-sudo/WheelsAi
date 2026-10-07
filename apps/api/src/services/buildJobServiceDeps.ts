/**
 * Composition root for jobs (services/jobs.ts): the store over Prisma, the
 * runner's queue, notifications and reputation.
 *
 * A job is read only through findForOrg, whose `where` names the caller as
 * the buyer or the publisher. Money moves only inside prisma.$transaction,
 * through the escrow core.
 */

import type { Prisma } from "@prisma/client";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { enqueueJobRun } from "../queues/job-runner.queue.js";
import { createLogger } from "../utils/logger.js";
import type { ApiKeySpendTx } from "./apiKeySpend.js";
import { buildJobNotifier } from "./buildJobNotifier.js";
import { buildOfferingStore, ensureOrgPublisherProfile } from "./buildOfferingServiceDeps.js";
import type { EscrowTx } from "./jobEscrow.js";
import type { JobListParams, JobRecord, JobServiceDeps, JobStore } from "./jobs.js";
import { recordDispute, updatePublisherReputation } from "./reputation.js";

const logger = createLogger("jobs");

export { ensureOrgPublisherProfile };

const RECORD_INCLUDE = {
  offering: { select: { id: true, slug: true, title: true, productKind: true } },
  buyer: { select: { name: true } },
  escrow: {
    select: { status: true, grossAmountCents: true, platformFeeCents: true, creatorAmountCents: true },
  },
} satisfies Prisma.JobInclude;

/** Never throws: a recalculation is bookkeeping, not part of the transition. */
export async function recalculateReputationQuietly(publisherId: string): Promise<void> {
  await updatePublisherReputation(publisherId).catch((err: unknown) =>
    logger.error({ err, publisherId }, "Failed to recalculate reputation after a job"),
  );
}

export function buildJobStore(): JobStore {
  return {
    findForOrg: (jobId, orgId): Promise<JobRecord | null> =>
      prisma.job.findFirst({
        where: { id: jobId, OR: [{ buyerId: orgId }, { publisherId: orgId }] },
        include: RECORD_INCLUDE,
      }),

    findByIdempotencyKey: (buyerId, key): Promise<JobRecord | null> =>
      prisma.job.findUnique({
        where: { buyerId_idempotencyKey: { buyerId, idempotencyKey: key } },
        include: RECORD_INCLUDE,
      }),

    list: async (params: JobListParams) => {
      const where: Prisma.JobWhereInput = {
        ...(params.role === "buyer" ? { buyerId: params.orgId } : { publisherId: params.orgId }),
        ...(params.status && { status: params.status }),
        ...(params.offeringId && { offeringId: params.offeringId }),
      };
      const [rows, total] = await Promise.all([
        prisma.job.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          skip: (params.page - 1) * params.limit,
          take: params.limit,
          include: RECORD_INCLUDE,
        }),
        prisma.job.count({ where }),
      ]);
      return { rows, total };
    },

    summary: async (orgId) => {
      const [awaitingReview, inProgress, toDeliver] = await Promise.all([
        prisma.job.count({ where: { buyerId: orgId, status: "submitted" } }),
        prisma.job.count({ where: { buyerId: orgId, status: { in: ["funded", "running"] } } }),
        prisma.job.count({ where: { publisherId: orgId, status: { in: ["funded", "running"] } } }),
      ]);
      return { awaitingReview, inProgress, toDeliver };
    },

    inTransaction: (fn) => prisma.$transaction((tx) => fn(tx as unknown as EscrowTx & ApiKeySpendTx)),
  };
}

export function buildJobServiceDeps(overrides: Partial<JobServiceDeps> = {}): JobServiceDeps {
  const notify = buildJobNotifier();
  return {
    store: buildJobStore(),
    offerings: buildOfferingStore(),
    runnerEnabled: env.JOB_RUNNER_CONCURRENCY > 0,
    enqueue: (jobId) => enqueueJobRun(jobId),
    notify,
    ensurePublisherProfile: ensureOrgPublisherProfile,
    recordDispute: async (publisherId) => {
      // Resolved: the buyer already has their money back.
      await recordDispute(publisherId, true).catch((err: unknown) =>
        logger.error({ err, publisherId }, "Failed to record a dispute after a rejection"),
      );
    },
    recalculateReputation: recalculateReputationQuietly,
    onEnqueueError: (jobId, err) =>
      logger.error({ err, jobId }, "Hired job could not be queued; the sweeper will queue it"),
    ...overrides,
  };
}
