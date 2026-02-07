import { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";

interface CheckoutBody {
  amount: number;
}

export const billingRoutes: FastifyPluginAsync = async (fastify) => {
  // Apply auth middleware to all billing routes
  fastify.addHook("preHandler", requireAuth);

  // Get credit balance
  fastify.get("/balance", async (request) => {
    const { organizationId } = request.user!;

    const balance = await prisma.creditBalance.findUnique({
      where: { organizationId },
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
    const { organizationId } = request.user!;

    const transactions = await prisma.creditTransaction.findMany({
      where: { organizationId },
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
    const { organizationId } = request.user!;

    // Get current month's usage records
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const usageRecords = await prisma.usageRecord.findMany({
      where: {
        organizationId,
        createdAt: { gte: startOfMonth },
      },
    });

    const totals = usageRecords.reduce(
      (acc, record) => {
        acc.inputTokens += Number(record.inputTokens);
        acc.outputTokens += Number(record.outputTokens);
        acc.requests += 1;
        acc.computeMs += Number(record.computeMs);
        acc.costCents += Number(record.costCents);
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, requests: 0, computeMs: 0, costCents: 0 }
    );

    const gpuHours = totals.computeMs / (1000 * 60 * 60);
    const avgCostPerHour = gpuHours > 0 ? (totals.costCents / 100) / gpuHours : 0;

    return {
      usage: {
        currentMonth: totals.costCents / 100,
        gpuHours,
        avgCostPerHour,
        computeCost: (totals.costCents * 0.7) / 100, // 70% compute
        requests: totals.requests,
        requestsCost: (totals.costCents * 0.1) / 100, // 10% requests
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        tokensCost: (totals.costCents * 0.2) / 100, // 20% tokens
      },
    };
  });

  // Create checkout session (Stripe integration placeholder)
  fastify.post<{ Body: CheckoutBody }>("/checkout", async (request, reply) => {
    const { amount } = request.body;
    const { organizationId, userId } = request.user!;

    if (!amount || amount < 5) {
      return reply.status(400).send({
        error: "Bad Request",
        message: "Minimum purchase amount is $5",
      });
    }

    // TODO: Integrate with Stripe
    // For now, simulate adding credits directly (for development)
    const amountCents = Math.round(amount * 100);

    // Add credits
    await prisma.creditBalance.upsert({
      where: { organizationId },
      update: {
        balanceCents: { increment: amountCents },
      },
      create: {
        organizationId,
        balanceCents: amountCents,
      },
    });

    // Record transaction
    await prisma.creditTransaction.create({
      data: {
        organizationId,
        amountCents,
        type: "PURCHASE",
        description: `Credit purchase: $${amount}`,
        metadata: { method: "development_mock" },
      },
    });

    // Add bonus if applicable
    let bonusAmount = 0;
    if (amount >= 500) bonusAmount = 100;
    else if (amount >= 100) bonusAmount = 15;
    else if (amount >= 50) bonusAmount = 5;

    if (bonusAmount > 0) {
      const bonusCents = bonusAmount * 100;
      await prisma.creditBalance.update({
        where: { organizationId },
        data: { balanceCents: { increment: bonusCents } },
      });

      await prisma.creditTransaction.create({
        data: {
          organizationId,
          amountCents: bonusCents,
          type: "BONUS",
          description: `Bonus credits: $${bonusAmount}`,
        },
      });
    }

    return {
      checkoutUrl: `/dashboard/billing?success=true&amount=${amount}`,
      message: "Credits added successfully (development mode)",
    };
  });
};
