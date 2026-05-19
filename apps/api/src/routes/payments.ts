/**
 * GET /agents/:slug/payments — paginated ComputePayment history.
 *
 * The agent-detail route already shows last N payments inline; this is
 * the dedicated full-history surface (status filters, date scrubbing).
 *
 * Loader returns null when the agent has no treasury (not tokenized) —
 * the route renders 404, distinct from "0 payments yet" (200 + empty
 * array) on a tokenized agent.
 */

import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export type ComputePaymentStatus =
  | "PENDING"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED";

const STATUS_VALUES = ["PENDING", "SUBMITTED", "CONFIRMED", "FAILED"] as const;

// ============================================
// Shapes
// ============================================

export interface PaymentRow {
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

export interface LoadPaymentsResult {
  payments: PaymentRow[];
  totalCount: number;
}

export interface PaymentsRouteDeps {
  loadPayments: (args: {
    slug: string;
    orgId: string;
    limit: number;
    offset: number;
    status: ComputePaymentStatus | null;
    from: Date | null;
    to: Date | null;
  }) => Promise<LoadPaymentsResult | null>;
}

// ============================================
// Schema
// ============================================

const querySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    status: z.enum(STATUS_VALUES).optional(),
    from: z
      .string()
      .optional()
      .transform((v) => (v ? new Date(v) : null))
      .refine((v) => v === null || !Number.isNaN(v.getTime()), {
        message: "from must be a valid ISO date",
      }),
    to: z
      .string()
      .optional()
      .transform((v) => (v ? new Date(v) : null))
      .refine((v) => v === null || !Number.isNaN(v.getTime()), {
        message: "to must be a valid ISO date",
      }),
  })
  .refine(
    (q) =>
      q.from === null ||
      q.to === null ||
      q.from.getTime() <= q.to.getTime(),
    { message: "from must be <= to" },
  );

// ============================================
// Serialization
// ============================================

function serialize(p: PaymentRow) {
  return {
    id: p.id,
    amountLamports: p.amountLamports.toString(),
    computeSeconds: p.computeSeconds.toString(),
    status: p.status,
    txSignature: p.txSignature,
    paidAt: p.paidAt ? p.paidAt.toISOString() : null,
    scheduledFor: p.scheduledFor.toISOString(),
    errorMessage: p.errorMessage,
    createdAt: p.createdAt.toISOString(),
  };
}

// ============================================
// Plugin
// ============================================

export function createPaymentsRoutes(
  deps: PaymentsRouteDeps,
): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Params: { slug: string }; Querystring: Record<string, string> }>(
      "/agents/:slug/payments",
      async (request, reply) => {
        if (!request.auth) {
          return reply.status(401).send({ error: "unauthenticated" });
        }
        const { orgId } = request.auth;
        const { slug } = request.params;

        const parsed = querySchema.safeParse(request.query);
        if (!parsed.success) {
          return reply
            .status(400)
            .send({ error: "invalid_query", details: parsed.error.flatten() });
        }
        const limit = parsed.data.limit ?? DEFAULT_LIMIT;
        const offset = parsed.data.offset ?? 0;
        const status = (parsed.data.status ?? null) as ComputePaymentStatus | null;
        const { from, to } = parsed.data;

        const result = await deps.loadPayments({
          slug,
          orgId,
          limit,
          offset,
          status,
          from,
          to,
        });
        if (!result) {
          return reply.status(404).send({ error: "agent_not_found" });
        }

        return reply.status(200).send({
          payments: result.payments.map(serialize),
          totalCount: result.totalCount,
          limit,
          offset,
          status,
          from: from ? from.toISOString() : null,
          to: to ? to.toISOString() : null,
        });
      },
    );
  };
}
