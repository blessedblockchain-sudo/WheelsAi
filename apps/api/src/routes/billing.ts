import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth, requireJwtAuth, requireRole } from "../middleware/auth.js";
import { getStripe, isProSubscriptionEnabled, isStripeCheckoutEnabled } from "../services/stripe/stripeClient.js";
import {
  CheckoutError,
  createBillingPortal,
  createCreditCheckout,
  createProCheckout,
} from "../services/stripe/stripeCheckout.js";
import { countOwnAgents, getApiCallsThisMonth, getOrgPlan } from "../services/orgPlan.js";
import { PLANS } from "../services/plans.js";
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

function webOrigin(): string {
  return (env.PUBLIC_WEB_URL ?? env.CORS_ORIGIN).replace(/\/+$/, "");
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
  // `rails` tells the UI which payment paths are actually live on this
  // deployment, so it never renders a button the API would refuse.
  fastify.get("/packages", async () => ({
    packages: CREDIT_PACKAGES,
    minPurchase: MIN_PURCHASE_DOLLARS,
    maxPurchase: MAX_PURCHASE_DOLLARS,
    rails: {
      stripeCheckout: isStripeCheckoutEnabled(),
      proSubscription: isProSubscriptionEnabled(),
      mockCheckout: env.ALLOW_MOCK_CHECKOUT,
      wallet: env.WALLET_TOPUPS_ENABLED,
      // USDC first; SOL after it wherever a SOL price source is set.
      walletAssets: env.WALLET_TOPUPS_ENABLED
        ? ["USDC", ...(env.SOL_PRICE_SOURCE !== "off" ? ["SOL"] : [])]
        : [],
      // The organization's own deposit address (routes/depositAddress.ts).
      deposits: env.DEPOSITS_ENABLED,
      network: env.SOLANA_NETWORK,
    },
  }));

  // Create checkout session.
  // Real Stripe checkout is not implemented yet. The mock path below grants
  // credits with no payment — credits buy real GPU compute, so it is gated
  // behind ALLOW_MOCK_CHECKOUT, which env.ts refuses to boot with in
  // production. When Stripe lands, credits must only be granted from a
  // signature-verified webhook with an idempotency key.
  fastify.post<{ Body: CheckoutBody }>("/checkout", { preHandler: [requireJwtAuth, requireRole("owner", "admin")] }, async (request, reply) => {
    const { amount } = request.body;
    const orgId = request.auth!.orgId;

    // Real card checkout. Credits are granted by the signature-verified
    // webhook, never here.
    const stripe = getStripe();
    if (stripe && isStripeCheckoutEnabled()) {
      try {
        const result = await createCreditCheckout(stripe, {
          orgId,
          amountDollars: Number(amount),
          email: request.auth!.email,
          successUrl: `${webOrigin()}/dashboard/billing?checkout=success`,
          cancelUrl: `${webOrigin()}/dashboard/billing?checkout=cancelled`,
        });
        return { checkoutUrl: result.url };
      } catch (err) {
        if (err instanceof CheckoutError) {
          return reply.status(err.status).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    }

    if (!env.ALLOW_MOCK_CHECKOUT) {
      return reply.status(501).send({
        error: "card_payments_not_configured",
        message:
          "Card payments are temporarily unavailable. Nothing was charged. Pay with another method on the Billing page, or try again later.",
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

  // Current plan, its limits, and this month's usage against them.
  fastify.get("/plan", async (request) => {
    const orgId = request.auth!.orgId;
    const [{ plan, limits }, sub, agents, apiCalls] = await Promise.all([
      getOrgPlan(orgId),
      prisma.orgSubscription.findUnique({ where: { orgId } }),
      countOwnAgents(orgId),
      getApiCallsThisMonth(orgId),
    ]);
    return {
      plan,
      limits,
      status: sub?.status ?? "none",
      trialEndsAt: sub?.trialEndsAt ?? null,
      trialAvailable: !sub?.trialUsedAt,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      hasBillingAccount: !!sub?.stripeCustomerId,
      usage: { agents, apiCallsThisMonth: apiCalls },
      plans: PLANS,
      proSubscriptionAvailable: isProSubscriptionEnabled(),
    };
  });

  // Start Pro (with the 14-day trial the first time).
  fastify.post(
    "/subscription/checkout",
    { preHandler: [requireJwtAuth, requireRole("owner", "admin")] },
    async (request, reply) => {
      z.object({ plan: z.literal("pro") }).parse(request.body ?? {});
      const stripe = getStripe();
      if (!stripe || !isProSubscriptionEnabled()) {
        return reply.status(501).send({
          error: "pro_not_configured",
          message: "Pro checkout is temporarily unavailable. Nothing was charged. Try again later.",
        });
      }
      try {
        const result = await createProCheckout(stripe, {
          orgId: request.auth!.orgId,
          email: request.auth!.email,
          successUrl: `${webOrigin()}/dashboard/billing?subscription=success`,
          cancelUrl: `${webOrigin()}/dashboard/billing?subscription=cancelled`,
        });
        return { checkoutUrl: result.url, trialDays: result.trialDays };
      } catch (err) {
        if (err instanceof CheckoutError) {
          return reply.status(err.status).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // Manage payment method, invoices, cancellation.
  fastify.post(
    "/portal",
    { preHandler: [requireJwtAuth, requireRole("owner", "admin")] },
    async (request, reply) => {
      const stripe = getStripe();
      if (!stripe) {
        return reply.status(501).send({
          error: "card_payments_not_configured",
          message: "Billing management is temporarily unavailable. Try again later.",
        });
      }
      try {
        return await createBillingPortal(stripe, {
          orgId: request.auth!.orgId,
          returnUrl: `${webOrigin()}/dashboard/billing`,
        });
      } catch (err) {
        if (err instanceof CheckoutError) {
          return reply.status(err.status).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );
};
