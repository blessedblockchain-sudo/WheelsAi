/**
 * Composition root for the subscription renewal tick
 * (runSubscriptionRenewalTick).
 *
 * Wires:
 *   loadDue        -> AgentSubscription rows whose period has ended and that
 *                     are still active or past_due, never-tried first, then
 *                     least recently tried, with the listing's current
 *                     monthly price and pricing model
 *   recordAttempt  -> stamps lastRenewalAttemptAt in its own statement, so
 *                     it survives the renewal transaction's rollback
 *   inTransaction  -> prisma.$transaction; renewSubscription and
 *                     markPastDueOrExpire each run in their own
 */

import type { PrismaClient } from "@prisma/client";

import type { SubscriptionTx } from "./marketplaceSubscriptions.js";
import type { SubscriptionRenewalDeps } from "./runSubscriptionRenewalTick.js";

export function buildSubscriptionRenewalTickDeps(prisma: PrismaClient): SubscriptionRenewalDeps {
  return {
    loadDue: async ({ now, limit, excludeIds }) => {
      const rows = await prisma.agentSubscription.findMany({
        where: {
          currentPeriodEnd: { lte: now },
          status: { in: ["active", "past_due"] },
          ...(excludeIds.length > 0 && { id: { notIn: excludeIds } }),
        },
        orderBy: [
          { lastRenewalAttemptAt: { sort: "asc", nulls: "first" } },
          { currentPeriodEnd: "asc" },
          { id: "asc" },
        ],
        take: limit,
        include: {
          listing: {
            select: {
              id: true,
              title: true,
              publisherId: true,
              monthlyPriceCents: true,
              pricingModel: true,
              status: true,
            },
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
          priceCents: r.priceCents,
          endReason: r.endReason,
        },
        listing: {
          id: r.listing.id,
          title: r.listing.title,
          publisherId: r.listing.publisherId,
          monthlyPriceCents: r.listing.monthlyPriceCents ?? 0n,
          pricingModel: r.listing.pricingModel,
          status: r.listing.status,
        },
      }));
    },
    inTransaction: (fn) => prisma.$transaction((tx) => fn(tx as unknown as SubscriptionTx)),
    recordAttempt: async (subscriptionId, at) => {
      // Only while still due, so a row renewed by another worker in the
      // meantime is not pushed back for its next period.
      await prisma.agentSubscription.updateMany({
        where: { id: subscriptionId, currentPeriodEnd: { lte: at }, status: { in: ["active", "past_due"] } },
        data: { lastRenewalAttemptAt: at },
      });
    },
  };
}
