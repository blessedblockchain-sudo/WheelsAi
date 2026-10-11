/**
 * The Billing page's reads (services/billingLedger.ts), bound to the
 * database and the clock.
 *
 * EVERY QUERY HERE IS SCOPED TO ONE ORGANIZATION: by `orgId` where the table
 * has one, by `agent.orgId` for an agent's deployment, by `buyerId` for a
 * job's escrow and by `publisherId` for a Try it charge. An organization
 * never reads another's rows, holds or totals.
 *
 * Nothing here writes.
 */

import { prisma } from "../lib/prisma.js";
import type {
  BillingLedgerDeps,
  BillingLedgerStore,
  HeldRow,
  LedgerRow,
} from "./billingLedger.js";

// ============================================
// The slice of the database these reads use
// ============================================

type DateRangeFilter = { gte: Date; lt: Date };

type ReservedRow = {
  id: string;
  reservationCents: bigint | null;
  createdAt: Date;
};

const LEDGER_SELECT = {
  id: true,
  amountCents: true,
  type: true,
  description: true,
  balanceAfter: true,
  createdAt: true,
} as const;

type LedgerOrder = Array<{ createdAt: "asc" | "desc" } | { id: "asc" | "desc" }>;

export interface BillingLedgerDb {
  creditBalance: {
    findUnique(args: {
      where: { orgId: string };
      select: { balanceCents: true };
    }): Promise<{ balanceCents: bigint } | null>;
  };
  creditTransaction: {
    groupBy(args: {
      by: ["type"];
      where: { orgId: string; createdAt: DateRangeFilter };
      _sum: { amountCents: true; gpuSeconds: true };
    }): Promise<
      Array<{ type: string; _sum: { amountCents: bigint | null; gpuSeconds: bigint | null } }>
    >;
    findMany(args: {
      where: {
        orgId: string;
        type?: { in: string[] };
        createdAt?: DateRangeFilter;
        OR?: Array<{ createdAt: { lt: Date } } | { createdAt: Date; id: { lt: string } }>;
      };
      orderBy: LedgerOrder;
      take: number;
      select: typeof LEDGER_SELECT;
    }): Promise<LedgerRow[]>;
  };
  deployment: {
    findMany(args: {
      where: { orgId: string; reservationCents: { gt: bigint }; reservationReleasedAt: null };
      select: { id: true; name: true; reservationCents: true; createdAt: true };
    }): Promise<Array<ReservedRow & { name: string }>>;
  };
  agentDeployment: {
    findMany(args: {
      where: {
        agent: { orgId: string };
        reservationCents: { gt: bigint };
        reservationReleasedAt: null;
      };
      select: {
        id: true;
        reservationCents: true;
        createdAt: true;
        agent: { select: { name: true } };
      };
    }): Promise<Array<ReservedRow & { agent: { name: string } | null }>>;
  };
  trainingJob: {
    findMany(args: {
      where: { orgId: string; reservationCents: { gt: bigint }; settledAt: null };
      select: { id: true; name: true; reservationCents: true; createdAt: true };
    }): Promise<Array<ReservedRow & { name: string }>>;
  };
  marketplaceRevenue: {
    findMany(args: {
      where: { buyerId: string; type: "job"; status: "pending" };
      select: {
        id: true;
        jobId: true;
        grossAmountCents: true;
        createdAt: true;
        job: { select: { terms: true; offering: { select: { title: true } } } };
      };
    }): Promise<
      Array<{
        id: string;
        jobId: string | null;
        grossAmountCents: bigint;
        createdAt: Date;
        job: { terms: unknown; offering: { title: string } | null } | null;
      }>
    >;
    aggregate(args: {
      where: { buyerId: string; type: "job"; status: "settled"; settledAt: DateRangeFilter };
      _sum: { grossAmountCents: true };
    }): Promise<{ _sum: { grossAmountCents: bigint | null } }>;
  };
  trialCharge: {
    aggregate(args: {
      where: { publisherId: string; status: "held" };
      _sum: { amountCents: true };
      _min: { createdAt: true };
    }): Promise<{ _sum: { amountCents: bigint | null }; _min: { createdAt: Date | null } }>;
  };
  usageRecord: {
    aggregate(args: {
      where: { orgId: string; periodStart: DateRangeFilter };
      _sum: { requestCount: true; inputTokens: true; outputTokens: true };
    }): Promise<{
      _sum: {
        requestCount: number | null;
        inputTokens: bigint | null;
        outputTokens: bigint | null;
      };
    }>;
  };
}

// ============================================
// The reads
// ============================================

/** What the buyer agreed to call the job at hire, when the terms hold a title. */
function titleInTerms(terms: unknown): string | null {
  if (!terms || typeof terms !== "object" || Array.isArray(terms)) return null;
  const title = (terms as Record<string, unknown>).title;
  return typeof title === "string" && title.trim() ? title : null;
}

export function buildBillingLedgerStore(db: BillingLedgerDb): BillingLedgerStore {
  const held = (row: ReservedRow, name: string | null): HeldRow => ({
    id: row.id,
    name,
    amountCents: row.reservationCents ?? 0n,
    since: row.createdAt,
  });

  return {
    async balanceCents(orgId) {
      const row = await db.creditBalance.findUnique({
        where: { orgId },
        select: { balanceCents: true },
      });
      return row?.balanceCents ?? 0n;
    },

    async deploymentHolds(orgId) {
      const rows = await db.deployment.findMany({
        where: { orgId, reservationCents: { gt: 0n }, reservationReleasedAt: null },
        select: { id: true, name: true, reservationCents: true, createdAt: true },
      });
      return rows.map((row) => held(row, row.name));
    },

    async agentDeploymentHolds(orgId) {
      const rows = await db.agentDeployment.findMany({
        where: {
          agent: { orgId },
          reservationCents: { gt: 0n },
          reservationReleasedAt: null,
        },
        select: {
          id: true,
          reservationCents: true,
          createdAt: true,
          agent: { select: { name: true } },
        },
      });
      return rows.map((row) => held(row, row.agent?.name ?? null));
    },

    async fineTuningHolds(orgId) {
      const rows = await db.trainingJob.findMany({
        where: { orgId, reservationCents: { gt: 0n }, settledAt: null },
        select: { id: true, name: true, reservationCents: true, createdAt: true },
      });
      return rows.map((row) => held(row, row.name));
    },

    async jobHolds(orgId) {
      // Type "job" only: a "per_request" row that is pending is a request in
      // progress, not a hold.
      const rows = await db.marketplaceRevenue.findMany({
        where: { buyerId: orgId, type: "job", status: "pending" },
        select: {
          id: true,
          jobId: true,
          grossAmountCents: true,
          createdAt: true,
          job: { select: { terms: true, offering: { select: { title: true } } } },
        },
      });
      return rows.map((row) => ({
        id: row.jobId ?? row.id,
        name: titleInTerms(row.job?.terms) ?? row.job?.offering?.title ?? null,
        amountCents: row.grossAmountCents,
        since: row.createdAt,
      }));
    },

    async tryItHold(orgId) {
      const sum = await db.trialCharge.aggregate({
        where: { publisherId: orgId, status: "held" },
        _sum: { amountCents: true },
        _min: { createdAt: true },
      });
      return { amountCents: sum._sum.amountCents ?? 0n, since: sum._min.createdAt ?? null };
    },

    async ledgerTotalsByType({ orgId, from, to }) {
      const groups = await db.creditTransaction.groupBy({
        by: ["type"],
        where: { orgId, createdAt: { gte: from, lt: to } },
        _sum: { amountCents: true, gpuSeconds: true },
      });
      return groups.map((group) => ({
        type: group.type,
        amountCents: group._sum.amountCents ?? 0n,
        gpuSeconds: group._sum.gpuSeconds ?? 0n,
      }));
    },

    async settledJobCents({ orgId, from, to }) {
      const sum = await db.marketplaceRevenue.aggregate({
        where: {
          buyerId: orgId,
          type: "job",
          status: "settled",
          settledAt: { gte: from, lt: to },
        },
        _sum: { grossAmountCents: true },
      });
      return sum._sum.grossAmountCents ?? 0n;
    },

    async usageCounts({ orgId, from, to }) {
      const sum = await db.usageRecord.aggregate({
        where: { orgId, periodStart: { gte: from, lt: to } },
        _sum: { requestCount: true, inputTokens: true, outputTokens: true },
      });
      return {
        requests: sum._sum.requestCount ?? 0,
        inputTokens: sum._sum.inputTokens ?? 0n,
        outputTokens: sum._sum.outputTokens ?? 0n,
      };
    },

    async listLedger({ orgId, types, before, take }) {
      return db.creditTransaction.findMany({
        where: {
          orgId,
          ...(types ? { type: { in: types } } : {}),
          // createdAt alone can tie, so the id finishes the order: the next
          // page starts strictly after the last row of the one before.
          ...(before
            ? {
                OR: [
                  { createdAt: { lt: before.createdAt } },
                  { createdAt: before.createdAt, id: { lt: before.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        select: LEDGER_SELECT,
      });
    },

    async ledgerInRange({ orgId, from, to, take }) {
      return db.creditTransaction.findMany({
        where: { orgId, createdAt: { gte: from, lt: to } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: LEDGER_SELECT,
      });
    },
  };
}

export function buildBillingLedgerDeps(): BillingLedgerDeps {
  return {
    store: buildBillingLedgerStore(prisma as unknown as BillingLedgerDb),
    now: () => new Date(),
  };
}
