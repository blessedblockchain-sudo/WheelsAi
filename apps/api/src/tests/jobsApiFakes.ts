// The Offerings and Jobs API over the in-memory jobs database: an offering
// store and a job store that read and write the same rows the escrow core
// does, so a test can hire through the service and then watch the money.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createRequireSpend, requireScope } from "../middleware/auth.js";
import type { JobRouteGuards } from "../routes/jobGuards.js";
import type { JobEvent } from "../services/jobNotifications.js";
import type { JobRecord, JobServiceDeps, JobStore } from "../services/jobs.js";
import type {
  AgentForSale,
  DeploymentForSale,
  OfferingRecord,
  OfferingServiceDeps,
  OfferingStore,
  OfferingView,
  TrackRecord,
  WorkflowForSale,
} from "../services/offerings.js";
import { makeJobsDb, type JobsDbOptions, type Row } from "./jobsDb.js";

export const PUB = "11111111-1111-4111-8111-111111111111";
export const BUYER = "org_buyer";
export const OTHER = "33333333-3333-4333-8333-333333333333";
export const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const CLONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
export const GRAPH_AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac";
export const WORKFLOW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const DEPLOYMENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

export const T0 = new Date("2026-10-06T12:00:00Z");

type Owned<T> = T & { orgId: string };

export function makeMarket(opts: JobsDbOptions & { runnerEnabled?: boolean } = {}) {
  const db = makeJobsDb({ balance: 100_000n, ...opts });
  db.state.profiles.clear();
  const clock = { now: T0 };
  let seq = 0;
  const uuid = () => `0ff00000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

  const agents = new Map<string, Owned<AgentForSale>>([
    [AGENT, { id: AGENT, orgId: PUB, name: "Research Agent", entrypoint: "chat", isMarketplaceCopy: false, listingId: null }],
    [CLONE, { id: CLONE, orgId: PUB, name: "Installed Agent", entrypoint: "chat", isMarketplaceCopy: true, listingId: null }],
    [GRAPH_AGENT, { id: GRAPH_AGENT, orgId: PUB, name: "Graph Agent", entrypoint: "graph", isMarketplaceCopy: false, listingId: null }],
  ]);
  const workflows = new Map<string, Owned<WorkflowForSale>>([
    [WORKFLOW, { id: WORKFLOW, orgId: PUB, name: "Research Flow", isEnabled: true, stepCount: 2, usesMarketplaceCopy: false, inputSchema: null }],
  ]);
  const deployments = new Map<string, Owned<DeploymentForSale>>([
    [DEPLOYMENT, { id: DEPLOYMENT, orgId: PUB, name: "My Llama", status: "running" }],
  ]);

  const productName = (row: OfferingRecord): string | null => {
    const owned = <T extends { orgId: string; name: string }>(item: T | undefined) =>
      item && item.orgId === row.publisherId ? item.name : null;
    if (row.productKind === "agent") return owned(agents.get(row.agentId ?? ""));
    if (row.productKind === "workflow") return owned(workflows.get(row.orchestrationId ?? ""));
    return owned(deployments.get(row.deploymentId ?? ""));
  };
  const view = (row: Row | undefined): OfferingView | null => {
    if (!row || !row.slug) return null;
    const record = row as unknown as OfferingRecord;
    return {
      ...record,
      productName: productName(record),
      publisher: { name: "Publisher Org", slug: "publisher-org", isVerified: false, reputationTier: "new" },
      listing: null,
    };
  };
  const offeringRows = () => [...db.state.offerings.values()].filter((row) => row.slug);

  const offeringStore: OfferingStore = {
    findAgent: async (orgId, id) => {
      const agent = agents.get(id);
      return agent && agent.orgId === orgId ? agent : null;
    },
    findWorkflow: async (orgId, id) => {
      const workflow = workflows.get(id);
      return workflow && workflow.orgId === orgId ? workflow : null;
    },
    findDeployment: async (orgId, id) => {
      const deployment = deployments.get(id);
      return deployment && deployment.orgId === orgId ? deployment : null;
    },
    create: async (data) => {
      if (offeringRows().some((row) => row.slug === data.slug)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const row: Row = {
        id: uuid(),
        activeJobs: 0,
        status: "draft",
        publishedAt: null,
        createdAt: clock.now,
        updatedAt: clock.now,
        ...data,
      };
      db.state.offerings.set(row.id as string, row);
      return view(row)!;
    },
    findOwned: async (orgId, id) => {
      const row = db.state.offerings.get(id);
      return row?.publisherId === orgId ? view(row) : null;
    },
    listOwned: async (orgId, status) =>
      offeringRows()
        .filter((row) => row.publisherId === orgId && (status ? row.status === status : row.status !== "archived"))
        .map((row) => view(row)!),
    updateOwned: async (orgId, id, patch) => {
      const row = db.state.offerings.get(id);
      if (!row || row.publisherId !== orgId || row.status === "archived") return null;
      Object.assign(row, patch, { updatedAt: clock.now });
      return view(row);
    },
    transition: async (orgId, id, from, to, extra = {}) => {
      const row = db.state.offerings.get(id);
      if (!row || row.publisherId !== orgId || !from.includes(row.status as never)) return false;
      Object.assign(row, { status: to }, extra);
      return true;
    },
    findById: async (id) => view(db.state.offerings.get(id)),
    findBySlug: async (slug) => view(offeringRows().find((row) => row.slug === slug)),
    searchActive: async (params) => {
      const rows = offeringRows()
        .filter((row) => row.status === "active")
        .filter((row) => !params.productKind || row.productKind === params.productKind)
        .filter((row) => !params.query || String(row.title).toLowerCase().includes(params.query.toLowerCase()))
        .map((row) => view(row)!);
      if (params.sort === "price_low") rows.sort((a, b) => Number(a.priceCents - b.priceCents));
      if (params.sort === "price_high") rows.sort((a, b) => Number(b.priceCents - a.priceCents));
      const skip = (params.page - 1) * params.limit;
      return { rows: rows.slice(skip, skip + params.limit), total: rows.length };
    },
    jobCounts: async (ids) => {
      const counts: Record<string, Record<string, number>> = {};
      for (const job of db.state.jobs.values()) {
        const id = job.offeringId as string;
        if (!ids.includes(id)) continue;
        const status = job.status as string;
        (counts[id] ??= {})[status] = (counts[id]![status] ?? 0) + 1;
      }
      return counts;
    },
    trackRecord: async (offeringId): Promise<TrackRecord> => {
      const jobs = [...db.state.jobs.values()].filter((job) => job.offeringId === offeringId);
      const count = (status: string) => jobs.filter((job) => job.status === status).length;
      const rated = jobs.flatMap((job) => (typeof job.rating === "number" ? [job.rating] : []));
      const ended = count("completed") + count("rejected") + count("failed") + count("expired");
      return {
        completed: count("completed"),
        rejected: count("rejected"),
        failed: count("failed"),
        expired: count("expired"),
        cancelled: count("cancelled"),
        successRate: ended > 0 ? count("completed") / ended : null,
        avgRating: rated.length > 0 ? rated.reduce((a, b) => a + b, 0) / rated.length : null,
        ratingCount: rated.length,
        medianTurnaroundSeconds: null,
      };
    },
  };

  const record = (row: Row | undefined): JobRecord | null => {
    if (!row) return null;
    const offering = db.state.offerings.get(row.offeringId as string)!;
    const escrow = db.state.revenue.get(row.id as string);
    const defaults = {
      output: null,
      checkResults: null,
      failureReason: null,
      rejectionReason: null,
      reviewDeadlineAt: null,
      startedAt: null,
      submittedAt: null,
      completedAt: null,
      review: null,
      idempotencyKey: null,
      orchestrationExecutionId: null,
    };
    return {
      ...defaults,
      ...(row as Partial<JobRecord>),
      offering: {
        id: offering.id as string,
        slug: offering.slug as string,
        title: offering.title as string,
        productKind: offering.productKind as string,
      },
      buyer: { name: "Buyer Org" },
      escrow: escrow
        ? {
            status: escrow.status as string,
            grossAmountCents: escrow.grossAmountCents as bigint,
            platformFeeCents: escrow.platformFeeCents as bigint,
            creatorAmountCents: escrow.creatorAmountCents as bigint,
          }
        : null,
    } as JobRecord;
  };

  const jobStore: JobStore = {
    findForOrg: async (jobId, orgId) => {
      const row = db.state.jobs.get(jobId);
      return row && (row.buyerId === orgId || row.publisherId === orgId) ? record(row) : null;
    },
    findByIdempotencyKey: async (buyerId, key) =>
      record([...db.state.jobs.values()].find((row) => row.buyerId === buyerId && row.idempotencyKey === key)),
    list: async (params) => {
      const rows = [...db.state.jobs.values()]
        .filter((row) => (params.role === "buyer" ? row.buyerId : row.publisherId) === params.orgId)
        .filter((row) => !params.status || row.status === params.status)
        .filter((row) => !params.offeringId || row.offeringId === params.offeringId)
        .map((row) => record(row)!);
      const skip = (params.page - 1) * params.limit;
      return { rows: rows.slice(skip, skip + params.limit), total: rows.length };
    },
    summary: async (orgId) => {
      const jobs = [...db.state.jobs.values()];
      const open = (row: Row) => row.status === "funded" || row.status === "running";
      return {
        awaitingReview: jobs.filter((row) => row.buyerId === orgId && row.status === "submitted").length,
        inProgress: jobs.filter((row) => row.buyerId === orgId && open(row)).length,
        toDeliver: jobs.filter((row) => row.publisherId === orgId && open(row)).length,
      };
    },
    inTransaction: db.inTransaction,
  };

  const queued: string[] = [];
  const events: Array<[JobEvent, string]> = [];
  const disputes: string[] = [];
  const recalculated: string[] = [];
  const profilesEnsured: string[] = [];
  const ensurePublisherProfile = async (orgId: string) => {
    profilesEnsured.push(orgId);
    db.state.profiles.add(orgId);
  };

  const offerings: OfferingServiceDeps = {
    store: offeringStore,
    runnerEnabled: opts.runnerEnabled ?? true,
    ensurePublisherProfile,
    randomSuffix: () => `r${++seq}`,
    now: () => clock.now,
  };
  const jobs: JobServiceDeps = {
    store: jobStore,
    offerings: offeringStore,
    runnerEnabled: opts.runnerEnabled ?? true,
    enqueue: async (jobId) => {
      queued.push(jobId);
    },
    notify: async (event, jobId) => {
      events.push([event, jobId]);
    },
    ensurePublisherProfile,
    recordDispute: async (publisherId) => {
      disputes.push(publisherId);
    },
    recalculateReputation: async (publisherId) => {
      recalculated.push(publisherId);
    },
    now: () => clock.now,
  };

  return {
    db,
    clock,
    agents,
    workflows,
    deployments,
    offerings,
    jobs,
    queued,
    events,
    disputes,
    recalculated,
    profilesEnsured,
    offeringRow: (id: string) => db.state.offerings.get(id)!,
    refunds: () => db.state.ledger.filter((row) => row.type === "marketplace_job_refund"),
  };
}

export type Market = ReturnType<typeof makeMarket>;

// ============================================
// Route harness
// ============================================

export type TestAuth =
  | { type: "jwt"; orgId: string; userId: string }
  | { type: "api_key"; orgId: string; scopes: string[]; apiKeyId?: string };

/** The header a test request carries its principal in. */
export function as(auth: TestAuth): Record<string, string> {
  return { "x-test-auth": JSON.stringify(auth) };
}

export const owner = (orgId: string) => as({ type: "jwt", orgId, userId: "user_owner" });
export const member = (orgId: string) => as({ type: "jwt", orgId, userId: "user_member" });

/** Sets request.auth from the test header, where production reads a cookie or a key. */
export function installTestAuth(app: FastifyInstance): void {
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    const header = request.headers["x-test-auth"];
    if (typeof header !== "string") return;
    const auth = JSON.parse(header) as TestAuth;
    request.auth =
      auth.type === "jwt"
        ? { type: "jwt", orgId: auth.orgId, userId: auth.userId }
        : { type: "api_key", orgId: auth.orgId, userId: null, scopes: auth.scopes, apiKeyId: auth.apiKeyId };
  });
}

/** The production scope and spend guards, over a fixed membership table and no metering. */
export function testGuards(): JobRouteGuards {
  const roles: Record<string, string> = { user_owner: "owner", user_admin: "admin", user_member: "member" };
  const spend = createRequireSpend({ getMemberRole: async (_orgId, userId) => roles[userId] ?? null });
  return {
    auth: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.auth) return reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
    },
    scope: (scope) => requireScope(scope) as JobRouteGuards["auth"],
    spend: (scope) => spend(scope) as JobRouteGuards["auth"],
  };
}

export const VALID_OFFERING = {
  productKind: "agent",
  agentId: AGENT,
  title: "Competitor teardown",
  description: "A one-page teardown of a competitor's product from its public site.",
  priceCents: 2_000,
  slaSeconds: 3_600,
  inputSchema: {
    type: "object",
    required: ["url"],
    additionalProperties: false,
    properties: { url: { type: "string", format: "uri" }, depth: { type: "integer", minimum: 1, maximum: 3 } },
  },
  sampleInputs: [{ url: "https://example.com" }],
  instructions: "Always open with the three strongest competitors ranked by revenue and never mention our scoring rubric.",
  deliverableChecks: [{ type: "contains", value: "competitor" }],
} as const;
