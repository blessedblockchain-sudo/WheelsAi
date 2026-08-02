import { FastifyPluginAsync } from "fastify";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { grantCredits } from "../services/creditGrant.js";
import {
  CREDIT_PACKAGES,
  MAX_PURCHASE_DOLLARS,
  MIN_PURCHASE_DOLLARS,
  bonusForAmount,
  validatePurchaseAmount,
} from "../services/creditPackages.js";

interface CheckoutBody {
  amount: number;
}

export const billingRoutes: FastifyPluginAsync = async (fastify) => {
  // Apply auth middleware to all billing routes
  fastify.addHook("preHandler", requireAuth);

  // Get credit balance
  fastify.get("/balance", async (request) => {
    const orgId = request.auth!.orgId;

    const balance = await prisma.creditBalance.findUnique({
      where: { orgId },
    });

    return {
      balance: {
        available: balance ? Number(balance.balanceCents) / 100 : 0,
        pending: 0,
        total: balance ? Number(balance.balanceCents) / 100 : 0,
      },
    };
  });

  // Get transaction history
  fastify.get("/transactions", async (request) => {
    const orgId = request.auth!.orgId;

    const transactions = await prisma.creditTransaction.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return {
      transactions: transactions.map((tx) => ({
        id: tx.id,
        amount: Number(tx.amountCents) / 100,
        type: tx.type.toLowerCase() as "purchase" | "bonus" | "usage" | "refund",
        description: tx.description || `${tx.type} transaction`,
        createdAt: tx.createdAt.toISOString(),
      })),
    };
  });

  // Get usage summary
  fastify.get("/usage", async (request) => {
    const orgId = request.auth!.orgId;

    // Get current month's usage records
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const usageRecords = await prisma.usageRecord.findMany({
      where: {
        orgId,
        periodStart: { gte: startOfMonth },
      },
    });

    const totals = usageRecords.reduce(
      (acc, record) => {
        acc.inputTokens += Number(record.inputTokens);
        acc.outputTokens += Number(record.outputTokens);
        acc.requests += record.requestCount;
        acc.totalLatencyMs += Number(record.totalLatencyMs);
        acc.costCents += Number(record.costCents);
        acc.computeSeconds += Number(record.computeSeconds);
        acc.actualCostCents += Number(record.actualCostCents);
        return acc;
      },
      {
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
        totalLatencyMs: 0,
        costCents: 0,
        computeSeconds: 0,
        actualCostCents: 0,
      }
    );

    // Prefer the real metered compute cost when we have it; fall back to the
    // legacy estimate while the metering backfill is still rolling out.
    const computeCostCents = totals.actualCostCents > 0 ? totals.actualCostCents : totals.costCents * 0.7;
    const gpuHours =
      totals.computeSeconds > 0
        ? totals.computeSeconds / 3600
        : totals.totalLatencyMs / (1000 * 60 * 60);
    const totalCostCents =
      totals.actualCostCents > 0
        ? totals.actualCostCents + totals.costCents * 0.1 + totals.costCents * 0.2
        : totals.costCents;
    const avgCostPerHour = gpuHours > 0 ? computeCostCents / 100 / gpuHours : 0;

    return {
      usage: {
        currentMonth: totalCostCents / 100,
        gpuHours,
        avgCostPerHour,
        computeCost: computeCostCents / 100,
        requests: totals.requests,
        requestsCost: (totals.costCents * 0.1) / 100,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        tokensCost: (totals.costCents * 0.2) / 100,
        // Surface the raw metered values so the UI can label "measured" vs
        // "estimated" on the runway/economics card.
        metered: {
          computeSeconds: totals.computeSeconds,
          actualComputeCost: totals.actualCostCents / 100,
        },
      },
    };
  });

  // Credit packages + bonus tiers, served so the buyer is shown exactly
  // the ladder the grant math uses (B2/T1 — these were duplicated).
  fastify.get("/packages", async () => ({
    packages: CREDIT_PACKAGES,
    minPurchase: MIN_PURCHASE_DOLLARS,
    maxPurchase: MAX_PURCHASE_DOLLARS,
  }));

  // Create checkout session.
  // Real Stripe checkout is not implemented yet. The mock path below grants
  // credits with no payment — credits buy real GPU compute, so it is gated
  // behind ALLOW_MOCK_CHECKOUT, which env.ts refuses to boot with in
  // production. When Stripe lands, credits must only be granted from a
  // signature-verified webhook with an idempotency key.
  fastify.post<{ Body: CheckoutBody }>("/checkout", { preHandler: requireRole("owner", "admin") }, async (request, reply) => {
    const { amount } = request.body;
    const orgId = request.auth!.orgId;

    if (!env.ALLOW_MOCK_CHECKOUT) {
      return reply.status(501).send({
        error: "checkout_not_implemented",
        message: "Credit purchases are not yet available.",
      });
    }

    const amountError = validatePurchaseAmount(amount);
    if (amountError) {
      return reply.status(400).send({
        error: "Bad Request",
        message: amountError,
      });
    }

    const bonusAmount = bonusForAmount(amount);

    // Balance mutation and ledger rows commit atomically — a crash between
    // them must never desync the running balance from the ledger. The
    // grant itself goes through the one shared service every rail uses
    // (B2/T1), so the dev path and the real rails cannot drift.
    await prisma.$transaction(async (tx) => {
      await grantCredits(tx as never, {
        orgId,
        amountCents: BigInt(Math.round(amount * 100)),
        bonusCents: BigInt(bonusAmount * 100),
        referenceId: `development_mock:${Date.now()}`,
        description: `Credit purchase: $${amount}`,
        labelPrefix: "[dev-mock] ",
      });
    });

    return {
      checkoutUrl: `/dashboard/billing?success=true&amount=${amount}`,
      message: "Credits added successfully (development mode)",
    };
  });
};
