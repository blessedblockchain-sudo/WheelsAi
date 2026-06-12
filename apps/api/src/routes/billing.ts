import { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";

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

  // Create checkout session.
  // Real Stripe checkout is not implemented yet. The mock path below grants
  // credits with no payment — credits buy real GPU compute, so it is gated
  // behind ALLOW_MOCK_CHECKOUT, which env.ts refuses to boot with in
  // production. When Stripe lands, credits must only be granted from a
  // signature-verified webhook with an idempotency key.
  fastify.post<{ Body: CheckoutBody }>("/checkout", async (request, reply) => {
    const { amount } = request.body;
    const orgId = request.auth!.orgId;

    if (!env.ALLOW_MOCK_CHECKOUT) {
      return reply.status(501).send({
        error: "checkout_not_implemented",
        message: "Credit purchases are not yet available.",
      });
    }

    if (!amount || Number.isNaN(amount) || amount < 5) {
      return reply.status(400).send({
        error: "Bad Request",
        message: "Minimum purchase amount is $5",
      });
    }

    const amountCents = Math.round(amount * 100);
    const amountCentsBigInt = BigInt(amountCents);

    let bonusAmount = 0;
    if (amount >= 500) bonusAmount = 100;
    else if (amount >= 100) bonusAmount = 15;
    else if (amount >= 50) bonusAmount = 5;

    // Balance mutation and ledger rows commit atomically — a crash between
    // them must never desync the running balance from the ledger.
    await prisma.$transaction(async (tx) => {
      const balanceAfterPurchase = await tx.creditBalance.upsert({
        where: { orgId },
        update: {
          balanceCents: { increment: amountCentsBigInt },
        },
        create: {
          orgId,
          balanceCents: amountCentsBigInt,
        },
      });

      await tx.creditTransaction.create({
        data: {
          orgId,
          amountCents: amountCentsBigInt,
          type: "purchase",
          description: `Credit purchase: $${amount}`,
          referenceId: "development_mock",
          balanceAfter: balanceAfterPurchase.balanceCents,
        },
      });

      if (bonusAmount > 0) {
        const bonusCentsBigInt = BigInt(bonusAmount * 100);
        const balanceAfterBonus = await tx.creditBalance.update({
          where: { orgId },
          data: { balanceCents: { increment: bonusCentsBigInt } },
        });

        await tx.creditTransaction.create({
          data: {
            orgId,
            amountCents: bonusCentsBigInt,
            type: "bonus",
            description: `Bonus credits: $${bonusAmount}`,
            referenceId: "development_bonus",
            balanceAfter: balanceAfterBonus.balanceCents,
          },
        });
      }
    });

    return {
      checkoutUrl: `/dashboard/billing?success=true&amount=${amount}`,
      message: "Credits added successfully (development mode)",
    };
  });
};
