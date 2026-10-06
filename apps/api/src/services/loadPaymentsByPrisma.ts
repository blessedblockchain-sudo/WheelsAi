/**
 * Prisma-backed loadPayments (companion to routes/payments.ts).
 *
 * Resolves the ComputePayment history page for an agent's full-history
 * dashboard view. Three SQL trips:
 *
 *   prisma.agent.findFirst       — slug + orgId scoped, walks
 *                                  listing → agentToken → treasury so
 *                                  payments are queried by treasuryId.
 *   prisma.computePayment.findMany — page slice (skip/take), filters,
 *                                    ordered scheduledFor desc.
 *   prisma.computePayment.count    — totalCount under the same filters.
 *
 * Return contract (the route distinguishes these states):
 *   null                                → 404 (no such agent in this org)
 *   { payments: [], totalCount: 0 }     → 200 (the agent has no treasury
 *                                              yet, or has one with no
 *                                              payments)
 *
 * An agent without a treasury is the normal case (most agents are not
 * tokenized), and the dashboard asks for every agent's payments: answering
 * 404 "agent_not_found" for an agent that exists showed an error on its
 * page. The payment queries are still skipped when there is no treasury.
 */

import type {
  ComputePaymentStatus,
  LoadPaymentsResult,
  PaymentRow,
} from "../routes/payments.js";

interface AgentRow {
  id: string;
  orgId: string;
  slug: string;
  listing: {
    agentToken: { treasury: { id: string } | null } | null;
  } | null;
}

interface PaymentDbRow {
  id: string;
  amountLamports: bigint;
  computeSeconds: bigint;
  status: ComputePaymentStatus;
  txSignature: string | null;
  paidAt: Date | null;
  scheduledFor: Date;
  errorMessage: string | null;
  createdAt: Date;
}

interface PaymentWhereClause {
  treasuryId: string;
  status?: ComputePaymentStatus;
  scheduledFor?: { gte?: Date; lte?: Date };
}

interface PrismaStub {
  agent: {
    findFirst: (args: {
      where: { slug: string; orgId: string };
      include: unknown;
    }) => Promise<AgentRow | null>;
  };
  computePayment: {
    findMany: (args: {
      where: PaymentWhereClause;
      orderBy: { scheduledFor: "desc" };
      skip: number;
      take: number;
    }) => Promise<PaymentDbRow[]>;
    count: (args: { where: PaymentWhereClause }) => Promise<number>;
  };
}

export interface LoadPaymentsInput {
  slug: string;
  orgId: string;
  limit: number;
  offset: number;
  status: ComputePaymentStatus | null;
  from: Date | null;
  to: Date | null;
}

export interface LoadPaymentsByPrismaDeps {
  prisma: PrismaStub;
}

function buildWhere(
  treasuryId: string,
  status: ComputePaymentStatus | null,
  from: Date | null,
  to: Date | null,
): PaymentWhereClause {
  const where: PaymentWhereClause = { treasuryId };
  if (status) where.status = status;
  if (from || to) {
    const window: { gte?: Date; lte?: Date } = {};
    if (from) window.gte = from;
    if (to) window.lte = to;
    where.scheduledFor = window;
  }
  return where;
}

export async function loadPaymentsByPrisma(
  input: LoadPaymentsInput,
  deps: LoadPaymentsByPrismaDeps,
): Promise<LoadPaymentsResult | null> {
  const agent = await deps.prisma.agent.findFirst({
    where: { slug: input.slug, orgId: input.orgId },
    include: {
      listing: {
        select: {
          agentToken: {
            select: { treasury: { select: { id: true } } },
          },
        },
      },
    },
  });
  if (!agent) return null;

  const treasuryId = agent.listing?.agentToken?.treasury?.id;
  if (!treasuryId) return { payments: [], totalCount: 0 };

  const where = buildWhere(treasuryId, input.status, input.from, input.to);

  const [rows, totalCount] = await Promise.all([
    deps.prisma.computePayment.findMany({
      where,
      orderBy: { scheduledFor: "desc" },
      skip: input.offset,
      take: input.limit,
    }),
    deps.prisma.computePayment.count({ where }),
  ]);

  const payments: PaymentRow[] = rows.map((r) => ({
    id: r.id,
    amountLamports: r.amountLamports,
    computeSeconds: r.computeSeconds,
    status: r.status,
    txSignature: r.txSignature,
    paidAt: r.paidAt,
    scheduledFor: r.scheduledFor,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt,
  }));

  return { payments, totalCount };
}
