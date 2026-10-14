import { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { prisma } from "@wheelsai/db";
import { env } from "../config/env.js";
import {
  evaluateX402Alerts,
  getX402AlertThresholds,
  getX402OrgPaymentSummary,
  getX402SettlementWorkerMetrics,
} from "../services/x402Settlement.js";

const listPaymentsQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const metricsHistoryQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(env.X402_METRICS_HISTORY_LIMIT),
  hours: z.coerce.number().int().min(1).max(24 * 30).default(24),
});

interface X402MetricsHistoryRow {
  timestamp: Date;
  total_payments: number;
  pending_payments: number;
  verified_payments: number;
  settled_payments: number;
  failed_payments: number;
  retriable_payments: number;
  failure_rate_percent: number;
  oldest_pending_minutes: number | null;
  alert_count: number;
  alerts: unknown;
  worker_ticks: number;
  worker_processed: number;
  worker_settled: number;
  worker_failed: number;
  worker_retried: number;
  worker_skipped: number;
}

// A payment with a listing was made by a stranger's wallet for one use of
// the organization's agent through the x402 door: it is not the
// organization's own payment, and its payer's wallet and failures are not
// the organization's to see. A creator sees those sales on the earnings page.
// Every read below keeps to the organization's own rows.
const OWN_PAYMENTS = { listingId: null } as const;

export const x402Routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", requireAuth);

  app.get("/metrics", async (request) => {
    const { orgId } = request.auth!;
    const worker = getX402SettlementWorkerMetrics();

    // Reads only. The history rows are the settlement worker's to write,
    // once a run; a page that is opened must never add one.
    const [summary, recentFailures] = await Promise.all([
      getX402OrgPaymentSummary(orgId),
      prisma.x402Payment.findMany({
        where: {
          orgId,
          ...OWN_PAYMENTS,
          status: "failed",
        },
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: {
          id: true,
          requestId: true,
          txSignature: true,
          retryCount: true,
          failureReason: true,
          updatedAt: true,
        },
      }),
    ]);
    const alerts = evaluateX402Alerts(summary);

    return {
      worker,
      thresholds: getX402AlertThresholds(),
      alerts,
      payments: {
        total: summary.total,
        pending: summary.pending,
        verified: summary.verified,
        settled: summary.settled,
        failed: summary.failed,
        retriable: summary.retriable,
        failureRatePercent: Number(summary.failureRatePercent.toFixed(2)),
        oldestPendingMinutes: summary.oldestPendingMinutes,
      },
      recentFailures: recentFailures.map((failure) => ({
        ...failure,
        updatedAt: failure.updatedAt.toISOString(),
      })),
    };
  });

  app.get("/metrics/history", async (request) => {
    const { orgId } = request.auth!;
    const { limit, hours } = metricsHistoryQuerySchema.parse(request.query);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const rows = await prisma.$queryRaw<X402MetricsHistoryRow[]>`
      SELECT
        "timestamp",
        "total_payments",
        "pending_payments",
        "verified_payments",
        "settled_payments",
        "failed_payments",
        "retriable_payments",
        "failure_rate_percent",
        "oldest_pending_minutes",
        "alert_count",
        "alerts",
        "worker_ticks",
        "worker_processed",
        "worker_settled",
        "worker_failed",
        "worker_retried",
        "worker_skipped"
      FROM "x402_settlement_metrics"
      WHERE "org_id" = ${orgId}::uuid
        AND "timestamp" >= ${since}
      ORDER BY "timestamp" DESC
      LIMIT ${limit}
    `;
    rows.reverse();

    return {
      history: rows.map((row) => ({
        timestamp: row.timestamp.toISOString(),
        totalPayments: row.total_payments,
        pendingPayments: row.pending_payments,
        verifiedPayments: row.verified_payments,
        settledPayments: row.settled_payments,
        failedPayments: row.failed_payments,
        retriablePayments: row.retriable_payments,
        failureRatePercent: row.failure_rate_percent,
        oldestPendingMinutes: row.oldest_pending_minutes,
        alertCount: row.alert_count,
        alerts: row.alerts ?? [],
        worker: {
          ticks: row.worker_ticks,
          processed: row.worker_processed,
          settled: row.worker_settled,
          failed: row.worker_failed,
          retried: row.worker_retried,
          skipped: row.worker_skipped,
        },
      })),
      query: {
        hours,
        limit,
      },
    };
  });

  app.get("/payments", async (request) => {
    const { orgId } = request.auth!;
    const query = listPaymentsQuerySchema.parse(request.query);

    const where = {
      orgId,
      ...OWN_PAYMENTS,
      ...(query.status ? { status: query.status } : {}),
    };

    const [payments, total] = await Promise.all([
      prisma.x402Payment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: query.limit,
        skip: query.offset,
      }),
      prisma.x402Payment.count({ where }),
    ]);

    return {
      payments: payments.map((payment) => ({
        id: payment.id,
        requestId: payment.requestId,
        deploymentId: payment.deploymentId,
        network: payment.network,
        asset: payment.asset,
        amountRaw: payment.amountRaw,
        amountUsd: payment.amountUsd,
        payerAddress: payment.payerAddress,
        payeeAddress: payment.payeeAddress,
        txSignature: payment.txSignature,
        status: payment.status,
        verifiedAt: payment.verifiedAt,
        settledAt: payment.settledAt,
        failureReason: payment.failureReason,
        retryCount: payment.retryCount,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
      })),
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
      },
    };
  });

  app.get("/payments/:paymentId", async (request, reply) => {
    const { orgId } = request.auth!;
    const { paymentId } = z.object({ paymentId: z.string().uuid() }).parse(request.params);

    const payment = await prisma.x402Payment.findFirst({
      where: {
        id: paymentId,
        orgId,
        ...OWN_PAYMENTS,
      },
    });

    if (!payment) {
      return reply.status(404).send({
        error: "Not Found",
        message: "X402 payment not found",
      });
    }

    // The signed transaction stays with the row: it is what the settlement
    // worker reads, and no caller needs it back. The door's two columns stay
    // out too: always null on an organization's own row, and this answer
    // keeps the shape it had before the door.
    const {
      signedTxB64: _signedTxB64,
      listingId: _listingId,
      messageHash: _messageHash,
      ...shown
    } = payment;
    return { payment: shown };
  });
};
