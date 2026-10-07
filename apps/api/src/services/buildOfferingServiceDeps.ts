/**
 * Composition root for offerings (services/offerings.ts): the store over
 * Prisma.
 *
 * Every product lookup carries the caller's organization in its `where`,
 * and every write to an offering carries its publisher. The public reads
 * (findBySlug, searchActive) select no more than the view needs; the
 * private instructions are on the record because the owner's view and the
 * runner need them, and services/offerings.ts decides which shape leaves.
 */

import { randomBytes } from "node:crypto";

import { Prisma } from "@prisma/client";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { ensurePublisherProfile } from "./marketplace.js";
import type {
  NewOffering,
  OfferingPatch,
  OfferingServiceDeps,
  OfferingStore,
  OfferingView,
  PublicSearch,
  TrackRecord,
} from "./offerings.js";

const VIEW_INCLUDE = {
  agent: { select: { name: true } },
  orchestration: { select: { name: true } },
  listing: { select: { slug: true, title: true, status: true } },
  publisher: {
    select: {
      name: true,
      publisherProfile: { select: { displayName: true, slug: true, isVerified: true, reputationTier: true } },
    },
  },
} satisfies Prisma.OfferingInclude;

type OfferingRow = Prisma.OfferingGetPayload<{ include: typeof VIEW_INCLUDE }>;

async function deploymentNames(rows: OfferingRow[]): Promise<Map<string, string>> {
  // Offering.deploymentId has no foreign key, so a deleted deployment is
  // simply absent here and the offering reads as unavailable.
  const ids = rows.flatMap((row) => (row.deploymentId ? [row.deploymentId] : []));
  if (ids.length === 0) return new Map();
  const deployments = await prisma.deployment.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, orgId: true },
  });
  const owner = new Map(rows.map((row) => [row.deploymentId, row.publisherId]));
  return new Map(deployments.filter((d) => owner.get(d.id) === d.orgId).map((d) => [d.id, d.name]));
}

async function toViews(rows: OfferingRow[]): Promise<OfferingView[]> {
  const deployments = await deploymentNames(rows);
  return rows.map(({ agent, orchestration, listing, publisher, ...record }) => ({
    ...record,
    productName:
      record.productKind === "agent"
        ? (agent?.name ?? null)
        : record.productKind === "workflow"
          ? (orchestration?.name ?? null)
          : ((record.deploymentId && deployments.get(record.deploymentId)) ?? null),
    publisher: {
      name: publisher.publisherProfile?.displayName ?? publisher.name,
      slug: publisher.publisherProfile?.slug ?? null,
      isVerified: publisher.publisherProfile?.isVerified ?? false,
      reputationTier: publisher.publisherProfile?.reputationTier ?? null,
    },
    listing: listing && listing.status === "published" ? { slug: listing.slug, title: listing.title } : null,
  }));
}

async function toView(row: OfferingRow | null): Promise<OfferingView | null> {
  return row ? ((await toViews([row]))[0] ?? null) : null;
}

/** Whether any of these agents is a buyer's copy of a marketplace listing. */
async function anyMarketplaceCopy(agentIds: string[]): Promise<boolean> {
  if (agentIds.length === 0) return false;
  // Any install row, whatever its status: an uninstalled copy is still
  // somebody else's agent.
  const install = await prisma.agentInstall.findFirst({
    where: { clonedAgentId: { in: agentIds } },
    select: { id: true },
  });
  return install !== null;
}

function searchWhere(params: PublicSearch): Prisma.OfferingWhereInput {
  return {
    status: "active",
    ...(params.productKind && { productKind: params.productKind }),
    ...(params.agentId && { agentId: params.agentId }),
    ...(params.listingId && { listingId: params.listingId }),
    ...(params.publisher && { publisher: { publisherProfile: { slug: params.publisher } } }),
    ...(params.query && {
      OR: [
        { title: { contains: params.query, mode: "insensitive" } },
        { description: { contains: params.query, mode: "insensitive" } },
      ],
    }),
  };
}

/** How many offerings a rating sort ranks; past this the order is by date. */
const RATING_SORT_WINDOW = 2_000;

export function buildOfferingStore(): OfferingStore {
  return {
    findAgent: async (orgId, agentId) => {
      const agent = await prisma.agent.findFirst({
        where: { id: agentId, orgId },
        select: { id: true, name: true, entrypoint: true, listing: { select: { id: true, status: true } } },
      });
      if (!agent) return null;
      return {
        id: agent.id,
        name: agent.name,
        entrypoint: agent.entrypoint,
        isMarketplaceCopy: await anyMarketplaceCopy([agent.id]),
        listingId: agent.listing?.status === "published" ? agent.listing.id : null,
      };
    },

    findWorkflow: async (orgId, orchestrationId) => {
      const workflow = await prisma.orchestration.findFirst({
        where: { id: orchestrationId, orgId },
        select: {
          id: true,
          name: true,
          isEnabled: true,
          inputSchema: true,
          steps: { select: { agentId: true, fallbackAgentId: true } },
        },
      });
      if (!workflow) return null;
      const agentIds = [
        ...new Set(workflow.steps.flatMap((s) => [s.agentId, s.fallbackAgentId]).filter((id): id is string => !!id)),
      ];
      return {
        id: workflow.id,
        name: workflow.name,
        isEnabled: workflow.isEnabled,
        stepCount: workflow.steps.length,
        usesMarketplaceCopy: await anyMarketplaceCopy(agentIds),
        inputSchema: workflow.inputSchema,
      };
    },

    findDeployment: (orgId, deploymentId) =>
      prisma.deployment.findFirst({
        where: { id: deploymentId, orgId },
        select: { id: true, name: true, status: true },
      }),

    create: async (data: NewOffering) => {
      const row = await prisma.offering.create({
        data: {
          ...data,
          inputSchema: (data.inputSchema ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          sampleInputs: data.sampleInputs as Prisma.InputJsonValue,
          deliverableChecks: data.deliverableChecks as Prisma.InputJsonValue,
        },
        include: VIEW_INCLUDE,
      });
      return (await toViews([row]))[0]!;
    },

    findOwned: async (orgId, id) =>
      toView(await prisma.offering.findFirst({ where: { id, publisherId: orgId }, include: VIEW_INCLUDE })),

    listOwned: async (orgId, status) =>
      toViews(
        await prisma.offering.findMany({
          where: { publisherId: orgId, ...(status ? { status } : { status: { not: "archived" } }) },
          orderBy: { createdAt: "desc" },
          take: 200,
          include: VIEW_INCLUDE,
        }),
      ),

    updateOwned: async (orgId, id, patch: OfferingPatch) => {
      const { inputSchema, sampleInputs, deliverableChecks, ...rest } = patch;
      const { count } = await prisma.offering.updateMany({
        where: { id, publisherId: orgId, status: { not: "archived" } },
        data: {
          ...rest,
          ...(inputSchema !== undefined && {
            inputSchema: (inputSchema ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          }),
          ...(sampleInputs !== undefined && { sampleInputs: sampleInputs as Prisma.InputJsonValue }),
          ...(deliverableChecks !== undefined && {
            deliverableChecks: deliverableChecks as Prisma.InputJsonValue,
          }),
        },
      });
      if (count !== 1) return null;
      return toView(await prisma.offering.findFirst({ where: { id, publisherId: orgId }, include: VIEW_INCLUDE }));
    },

    transition: async (orgId, id, from, to, extra = {}) => {
      const { count } = await prisma.offering.updateMany({
        where: { id, publisherId: orgId, status: { in: from } },
        data: {
          status: to,
          ...(extra.publishedAt && { publishedAt: extra.publishedAt }),
          ...(extra.listingId !== undefined && { listingId: extra.listingId }),
        },
      });
      return count === 1;
    },

    findById: async (id) => toView(await prisma.offering.findUnique({ where: { id }, include: VIEW_INCLUDE })),

    findBySlug: async (slug) => toView(await prisma.offering.findUnique({ where: { slug }, include: VIEW_INCLUDE })),

    searchActive: async (params) => {
      const where = searchWhere(params);
      const skip = (params.page - 1) * params.limit;
      const total = await prisma.offering.count({ where });
      if (params.sort !== "rating") {
        const orderBy: Prisma.OfferingOrderByWithRelationInput =
          params.sort === "price_low"
            ? { priceCents: "asc" }
            : params.sort === "price_high"
              ? { priceCents: "desc" }
              : { createdAt: "desc" };
        const rows = await prisma.offering.findMany({
          where,
          orderBy: [orderBy, { id: "asc" }],
          skip,
          take: params.limit,
          include: VIEW_INCLUDE,
        });
        return { rows: await toViews(rows), total };
      }
      // By the buyers' ratings of its jobs; unrated offerings follow, newest
      // first. Ranked in memory over a bounded window of matches.
      const matched = await prisma.offering.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: RATING_SORT_WINDOW,
        select: { id: true },
      });
      const ratings = await prisma.job.groupBy({
        by: ["offeringId"],
        where: { offeringId: { in: matched.map((m) => m.id) }, rating: { not: null } },
        _avg: { rating: true },
      });
      const rating = new Map(ratings.map((r) => [r.offeringId, r._avg.rating ?? 0]));
      const position = new Map(matched.map((m, index) => [m.id, index]));
      const ids = matched
        .map((m) => m.id)
        .sort((a, b) => (rating.get(b) ?? -1) - (rating.get(a) ?? -1) || position.get(a)! - position.get(b)!)
        .slice(skip, skip + params.limit);
      const rows = await prisma.offering.findMany({ where: { id: { in: ids } }, include: VIEW_INCLUDE });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return { rows: await toViews(ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))), total };
    },

    jobCounts: async (offeringIds) => {
      const counts: Record<string, Record<string, number>> = {};
      if (offeringIds.length === 0) return counts;
      const groups = await prisma.job.groupBy({
        by: ["offeringId", "status"],
        where: { offeringId: { in: offeringIds } },
        _count: { _all: true },
      });
      for (const group of groups) {
        (counts[group.offeringId] ??= {})[group.status] = group._count._all;
      }
      return counts;
    },

    trackRecord: async (offeringId): Promise<TrackRecord> => {
      const [groups, rated, median] = await Promise.all([
        prisma.job.groupBy({ by: ["status"], where: { offeringId }, _count: { _all: true } }),
        prisma.job.aggregate({
          where: { offeringId, rating: { not: null } },
          _avg: { rating: true },
          _count: { _all: true },
        }),
        prisma.$queryRaw<Array<{ seconds: number | null }>>`
          SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
                   ORDER BY EXTRACT(EPOCH FROM ("submitted_at" - "funded_at"))
                 )::float8 AS seconds
          FROM "jobs"
          WHERE "offering_id" = ${offeringId}::uuid
            AND "submitted_at" IS NOT NULL AND "funded_at" IS NOT NULL`,
      ]);
      const count = (status: string) => groups.find((g) => g.status === status)?._count._all ?? 0;
      const completed = count("completed");
      const [rejected, failed, expired] = [count("rejected"), count("failed"), count("expired")];
      const ended = completed + rejected + failed + expired;
      const seconds = median[0]?.seconds ?? null;
      return {
        completed,
        rejected,
        failed,
        expired,
        cancelled: count("cancelled"),
        successRate: ended > 0 ? Math.round((completed / ended) * 1000) / 1000 : null,
        avgRating: rated._avg.rating === null ? null : Math.round(rated._avg.rating * 100) / 100,
        ratingCount: rated._count._all,
        medianTurnaroundSeconds: seconds === null ? null : Math.round(seconds),
      };
    },
  };
}

/** The organization's payout profile, created when it has none. Never inside a transaction. */
export async function ensureOrgPublisherProfile(orgId: string): Promise<void> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
  if (!org) throw new Error(`organization ${orgId} not found`);
  await ensurePublisherProfile(orgId, org.name);
}

export function buildOfferingServiceDeps(overrides: Partial<OfferingServiceDeps> = {}): OfferingServiceDeps {
  return {
    store: buildOfferingStore(),
    runnerEnabled: env.JOB_RUNNER_CONCURRENCY > 0,
    ensurePublisherProfile: ensureOrgPublisherProfile,
    randomSuffix: () => randomBytes(3).toString("hex"),
    ...overrides,
  };
}
