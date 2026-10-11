/**
 * Composition root for the subscription renewal tick
 * (runSubscriptionRenewalTick).
 *
 * Wires:
 *   reconcilePauses -> reconcileListingPauses over every listing, on this
 *                     client
 *   loadDue        -> AgentSubscription rows whose period has ended and that
 *                     are still active or past_due, never-tried first, then
 *                     least recently tried, with the listing's current
 *                     monthly price, pricing model, what it sells and its
 *                     pause marker, and the kind of the subscriber's
 *                     licence (a copy, or use of the creator's agent)
 *   recordAttempt  -> stamps lastRenewalAttemptAt in its own statement, so
 *                     it survives the renewal transaction's rollback
 *   inTransaction  -> prisma.$transaction; renewSubscription and
 *                     markPastDueOrExpire each run in their own
 */

import type { PrismaClient } from "@prisma/client";

import { createLogger } from "../utils/logger.js";
import { reconcileListingPauses, type ListingPauseDb } from "./listingPause.js";
import type { SubscriptionTx } from "./marketplaceSubscriptions.js";
import type { SubscriptionRenewalDeps } from "./runSubscriptionRenewalTick.js";

const logger = createLogger("subscription-renewal");

export function buildSubscriptionRenewalTickDeps(prisma: PrismaClient): SubscriptionRenewalDeps {
  return {
    reconcilePauses: () => reconcileListingPauses({ all: true }, { db: prisma as unknown as ListingPauseDb }),
    logger,
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
              sells: true,
              pausedSince: true,
            },
          },
        },
      });
      // The kind of each subscriber's licence. One read for the page; a
      // subscription with no licence row reads as a copy, as before. If
      // this read fails the tick fails with it and nothing is charged.
      const licences =
        rows.length > 0
          ? await prisma.agentInstall.findMany({
              where: { OR: rows.map((r) => ({ listingId: r.listingId, buyerId: r.subscriberId })) },
              select: { listingId: true, buyerId: true, kind: true },
            })
          : [];
      const kindOf = new Map(licences.map((l) => [`${l.listingId}:${l.buyerId}`, l.kind]));
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
          licenceKind: kindOf.get(`${r.listingId}:${r.subscriberId}`) ?? "copy",
        },
        listing: {
          id: r.listing.id,
          title: r.listing.title,
          publisherId: r.listing.publisherId,
          monthlyPriceCents: r.listing.monthlyPriceCents ?? 0n,
          pricingModel: r.listing.pricingModel,
          status: r.listing.status,
          sells: r.listing.sells,
          pausedSince: r.listing.pausedSince,
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
