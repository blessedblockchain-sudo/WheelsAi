/**
 * Composition root for the subscription renewal tick
 * (runSubscriptionRenewalTick).
 *
 * Wires:
 *   loadDue        -> AgentSubscription rows whose period has ended and that
 *                     are still active or past_due, oldest first, with the
 *                     listing's current monthly price and pricing model
 *   inTransaction  -> prisma.$transaction; renewSubscription and
 *                     markPastDueOrExpire each run in their own
 */

import type { PrismaClient } from "@prisma/client";

import type { SubscriptionTx } from "./marketplaceSubscriptions.js";
import type { SubscriptionRenewalDeps } from "./runSubscriptionRenewalTick.js";

export function buildSubscriptionRenewalTickDeps(prisma: PrismaClient): SubscriptionRenewalDeps {
  return {
    loadDue: async ({ now, limit }) => {
      const rows = await prisma.agentSubscription.findMany({
        where: { currentPeriodEnd: { lte: now }, status: { in: ["active", "past_due"] } },
        orderBy: { currentPeriodEnd: "asc" },
        take: limit,
        include: {
          listing: {
            select: { id: true, title: true, publisherId: true, monthlyPriceCents: true, pricingModel: true },
          },
        },
      });
      return rows.map((r) => ({
        sub: {
          id: r.id,
          listingId: r.listingId,
          subscriberId: r.subscriberId,
          status: r.status,
          currentPeriodStart: r.currentPeriodStart,
          currentPeriodEnd: r.currentPeriodEnd,
          cancelAtPeriodEnd: r.cancelAtPeriodEnd,
        },
        listing: {
          id: r.listing.id,
          title: r.listing.title,
          publisherId: r.listing.publisherId,
          monthlyPriceCents: r.listing.monthlyPriceCents ?? 0n,
          pricingModel: r.listing.pricingModel,
        },
      }));
    },
    inTransaction: (fn) => prisma.$transaction((tx) => fn(tx as unknown as SubscriptionTx)),
  };
}
