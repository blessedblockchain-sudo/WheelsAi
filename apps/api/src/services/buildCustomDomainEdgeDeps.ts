/**
 * Composition root for the custom-domain edge: what the host router and the
 * certificate question read from the database.
 *
 *   loadRoutes          -> every row holding a verified claim, with the slug
 *                          of its agent or deployment (looked up inside the
 *                          row's own organization) and whether it serves:
 *                          the derived is_active flag AND the plan still
 *                          including custom domains, read fresh on every load
 *                          so a lapsed plan stops routing within one refresh
 *   findVerifiedDomain  -> the row holding the claim on one name
 *   isEntitled          -> effectivePlan over org_subscriptions
 *   targetExists        -> the agent or deployment, scoped to the row's org
 *   grantIssuance       -> one unit of the certificate issuance budget, or
 *                          a refusal naming whose budget is spent. Counting
 *                          and recording happen in one transaction behind a
 *                          Postgres advisory lock, so many edges asking at
 *                          once cannot each see room for one more
 *   increment           -> request counters, as a relative update
 *
 * No query here selects the certificate key columns.
 */

import {
  applicableCustomHeaders,
  decideIssuanceBudget,
  ISSUANCE_NAME_WINDOW_MS,
  ISSUANCE_WINDOW_MS,
  type EdgeRoute,
  type IssuanceBudgetDecision,
  type IssuanceBudgetLimits,
} from "./customDomainRules.js";
import type { DomainRequestCount } from "./customDomainRouteTable.js";
import { effectivePlan, limitsFor } from "./plans.js";

const ROUTE_SELECT = {
  id: true,
  orgId: true,
  domain: true,
  targetType: true,
  targetId: true,
  isActive: true,
  headers: true,
} as const;

const ASK_SELECT = {
  id: true,
  orgId: true,
  domain: true,
  targetType: true,
  targetId: true,
  verificationStatus: true,
  routingStatus: true,
  sslStatus: true,
  enabled: true,
} as const;

/** One lock for the whole budget: the platform's count is shared by everyone. */
export const ISSUANCE_LOCK_KEY = "custom-domain-issuance";
/** Grants older than this say nothing about any window and are removed. */
const GRANT_RETENTION_MS = 24 * 60 * 60_000;

/** The columns the certificate question reads. */
export interface AskDomainRow {
  id: string;
  orgId: string;
  domain: string;
  targetType: string;
  targetId: string;
  verificationStatus: string;
  routingStatus: string;
  sslStatus: string;
  enabled: boolean;
}

interface GrantWhere {
  grantedAt: { gte: Date };
  orgId?: string;
  domain?: string;
}

/** What the grant statement uses inside its transaction. */
export interface IssuanceGrantTx {
  $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  customDomainIssuanceGrant: {
    count: (args: { where: GrantWhere }) => Promise<number>;
    create: (args: { data: { orgId: string; domain: string; grantedAt: Date } }) => Promise<unknown>;
    deleteMany: (args: { where: { grantedAt: { lt: Date } } }) => Promise<unknown>;
  };
}

interface RouteRow {
  id: string;
  orgId: string;
  domain: string;
  targetType: string;
  targetId: string;
  isActive: boolean;
  headers: unknown;
}

interface SlugRow {
  id: string;
  orgId: string;
  slug: string;
}

/** The slice of the Prisma client the edge uses. */
export interface CustomDomainEdgePrisma {
  $transaction: <T>(run: (tx: IssuanceGrantTx) => Promise<T>) => Promise<T>;
  customDomain: {
    findMany: (args: {
      where: { verifiedDomain: { not: null } };
      select: typeof ROUTE_SELECT;
    }) => Promise<RouteRow[]>;
    findUnique: (args: {
      where: { verifiedDomain: string };
      select: typeof ASK_SELECT;
    }) => Promise<AskDomainRow | null>;
    updateMany: (args: {
      where: { id: string };
      data: { totalRequests: { increment: number }; lastRequestAt: Date };
    }) => Promise<{ count: number }>;
  };
  orgSubscription: {
    findMany: (args: {
      where: { orgId: { in: string[] } };
      select: { orgId: true; plan: true; status: true };
    }) => Promise<Array<{ orgId: string; plan: string; status: string }>>;
  };
  agent: {
    findMany: (args: {
      where: { id: { in: string[] } };
      select: { id: true; orgId: true; slug: true };
    }) => Promise<SlugRow[]>;
    count: (args: { where: { id: string; orgId: string } }) => Promise<number>;
  };
  deployment: {
    findMany: (args: {
      where: { id: { in: string[] } };
      select: { id: true; orgId: true; slug: true };
    }) => Promise<SlugRow[]>;
    count: (args: { where: { id: string; orgId: string } }) => Promise<number>;
  };
}

export interface CustomDomainEdgeDeps {
  loadRoutes: () => Promise<EdgeRoute[]>;
  findVerifiedDomain: (domain: string) => Promise<AskDomainRow | null>;
  isEntitled: (orgId: string) => Promise<boolean>;
  targetExists: (row: Pick<AskDomainRow, "orgId" | "targetType" | "targetId">) => Promise<boolean>;
  grantIssuance: (input: { orgId: string; domain: string; now: Date }) => Promise<IssuanceBudgetDecision>;
  increment: (entry: DomainRequestCount) => Promise<void>;
}

export function buildCustomDomainEdgeDeps(input: {
  prisma: CustomDomainEdgePrisma;
  limits: IssuanceBudgetLimits;
}): CustomDomainEdgeDeps {
  const { prisma, limits } = input;

  // Grants of this process go one at a time. The advisory lock already orders
  // them across processes; without this, a burst of questions would hold one
  // database connection each while waiting for it.
  let lastGrant: Promise<unknown> = Promise.resolve();
  function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
    const result = lastGrant.then(run, run);
    lastGrant = result.catch(() => undefined);
    return result;
  }

  async function entitlements(orgIds: string[]): Promise<Map<string, boolean>> {
    const subscriptions =
      orgIds.length === 0
        ? []
        : await prisma.orgSubscription.findMany({
            where: { orgId: { in: orgIds } },
            select: { orgId: true, plan: true, status: true },
          });
    const byOrg = new Map(subscriptions.map((sub) => [sub.orgId, sub]));
    // No subscription row is a known answer: the Starter plan.
    return new Map(
      orgIds.map((orgId) => [orgId, limitsFor(effectivePlan(byOrg.get(orgId))).customDomains]),
    );
  }

  /** id -> slug, keeping only targets that belong to the organization that points at them. */
  function slugsByOwner(rows: SlugRow[]): Map<string, string> {
    return new Map(rows.map((row) => [`${row.orgId}:${row.id}`, row.slug]));
  }

  return {
    loadRoutes: async () => {
      const rows = await prisma.customDomain.findMany({
        where: { verifiedDomain: { not: null } },
        select: ROUTE_SELECT,
      });
      const ids = (type: string) => [...new Set(rows.filter((r) => r.targetType === type).map((r) => r.targetId))];
      const agentIds = ids("agent");
      const deploymentIds = ids("deployment");
      const select = { id: true, orgId: true, slug: true } as const;
      const [entitled, agents, deployments] = await Promise.all([
        entitlements([...new Set(rows.map((r) => r.orgId))]),
        agentIds.length === 0 ? [] : prisma.agent.findMany({ where: { id: { in: agentIds } }, select }),
        deploymentIds.length === 0
          ? []
          : prisma.deployment.findMany({ where: { id: { in: deploymentIds } }, select }),
      ]);
      const slugs: Record<string, Map<string, string>> = {
        agent: slugsByOwner(agents),
        deployment: slugsByOwner(deployments),
      };

      return rows.map((row) => {
        const targetSlug = slugs[row.targetType]?.get(`${row.orgId}:${row.targetId}`) ?? null;
        return {
          domainId: row.id,
          orgId: row.orgId,
          domain: row.domain,
          targetType: row.targetType,
          targetSlug,
          serving: row.isActive && entitled.get(row.orgId) === true && targetSlug !== null,
          headers: applicableCustomHeaders(row.headers),
        };
      });
    },

    findVerifiedDomain: (domain) =>
      prisma.customDomain.findUnique({ where: { verifiedDomain: domain }, select: ASK_SELECT }),

    isEntitled: async (orgId) => (await entitlements([orgId])).get(orgId) === true,

    targetExists: async (row) => {
      const where = { id: row.targetId, orgId: row.orgId };
      if (row.targetType === "agent") return (await prisma.agent.count({ where })) > 0;
      if (row.targetType === "deployment") return (await prisma.deployment.count({ where })) > 0;
      return false;
    },

    grantIssuance: ({ orgId, domain, now }) =>
      oneAtATime(() =>
        prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${ISSUANCE_LOCK_KEY}))::text`;
          const window = { gte: new Date(now.getTime() - ISSUANCE_WINDOW_MS) };
          const grants = tx.customDomainIssuanceGrant;
          const name = await grants.count({
            where: { domain, grantedAt: { gte: new Date(now.getTime() - ISSUANCE_NAME_WINDOW_MS) } },
          });
          const organization = await grants.count({ where: { orgId, grantedAt: window } });
          const platform = await grants.count({ where: { grantedAt: window } });

          const decision = decideIssuanceBudget({ name, organization, platform }, limits);
          if (decision.granted) {
            await grants.create({ data: { orgId, domain, grantedAt: now } });
            await grants.deleteMany({ where: { grantedAt: { lt: new Date(now.getTime() - GRANT_RETENTION_MS) } } });
          }
          return decision;
        }),
      ),

    increment: async ({ domainId, count, lastRequestAt }) => {
      await prisma.customDomain.updateMany({
        where: { id: domainId },
        data: { totalRequests: { increment: count }, lastRequestAt },
      });
    },
  };
}
