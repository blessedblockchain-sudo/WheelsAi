/**
 * Composition root for the sweeper of charges per use left pending
 * (services/runPendingUseSweepTick.ts): the stale-charge query and the
 * refund, on Prisma.
 *
 * The refund is refundMarketplaceRequest, the one a failed use makes. A
 * charge is built again from its revenue row and the licence it was made
 * on, so the buyer gets back exactly what the row says was held and their
 * ledger line reads as any refunded use does.
 *
 * Two things are kept out of the batch here, so that they cannot sit at the
 * head of an oldest-first read and stop every other buyer's refund: a
 * request of a copy that may still be running, and a charge whose refund
 * just failed.
 */

import { prisma } from "../lib/prisma.js";
import { createLogger } from "../utils/logger.js";
import {
  refundMarketplaceRequest,
  type MarketplaceCharge,
  type MeteringRefundPrisma,
} from "./marketplaceMetering.js";
import type { PendingUseSweepTickDeps, StalePendingUse } from "./runPendingUseSweepTick.js";

const logger = createLogger("pending-use-sweeper");

/** The one type of revenue row this sweeper may touch: a charge for one use, or one request of a copy. */
export const PENDING_USE_REVENUE_TYPE = "per_request";

/**
 * How long a request of a buyer's own copy may stay pending before it is
 * given back. A copy's run is not held to the 15 minutes of a paid use: a
 * scheduled task on a copy runs with no deadline but the task's own timeout
 * (up to OWN_SCHEDULE_TIMEOUT_SECONDS.max, an hour), and a hired job whose
 * agent is a copy runs up to JOB_MAX_RUN_MS (an hour at most). Refunded
 * sooner, such a run would still deliver its answer and its later settle
 * would change nothing: a free answer, and nothing for the creator. This
 * must stay above both limits.
 */
export const PENDING_COPY_MAX_MS = 75 * 60_000;

/**
 * How long a charge whose refund failed is left out of the read before it
 * is tried again. Without it, a batch of charges that can never be refunded
 * (a licence that is gone, a buyer with no balance row) would be read first
 * on every tick and no one behind them would get their money back.
 */
export const PENDING_USE_SWEEP_HOLD_MS = 30 * 60_000;
/** The most charges left out at once. Past it the oldest entry is let back in. */
export const PENDING_USE_SWEEP_HOLD_MAX = 1_000;

interface StaleWhere {
  type: typeof PENDING_USE_REVENUE_TYPE;
  status: "pending";
  createdAt: { lt: Date };
  id?: { notIn: string[] };
}

interface RevenueRow {
  id: string;
  listingId: string | null;
  installId: string | null;
  buyerId: string;
  publisherId: string;
  grossAmountCents: bigint;
  platformFeeCents: bigint;
  creatorAmountCents: bigint;
  requestCount: number;
  createdAt: Date;
}

export interface PendingUseSweepPrisma {
  marketplaceRevenue: {
    findMany(args: {
      where: StaleWhere;
      orderBy: { createdAt: "asc" };
      take: number;
      select: {
        id: true;
        listingId: true;
        installId: true;
        buyerId: true;
        publisherId: true;
        grossAmountCents: true;
        platformFeeCents: true;
        creatorAmountCents: true;
        requestCount: true;
        createdAt: true;
      };
    }): Promise<RevenueRow[]>;
    count(args: { where: StaleWhere }): Promise<number>;
  };
  agentInstall: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; kind: true; listing: { select: { title: true } } };
    }): Promise<Array<{ id: string; kind: string; listing: { title: string } }>>;
  };
  $transaction<T>(run: (tx: MeteringRefundPrisma) => Promise<T>): Promise<T>;
}

/** A stale charge with the charge object the refund takes; null when its licence could not be read. */
export interface SweepableCharge extends StalePendingUse {
  charge: MarketplaceCharge | null;
}

function staleWhere(createdBefore: Date, leftOut: string[]): StaleWhere {
  return {
    type: PENDING_USE_REVENUE_TYPE,
    status: "pending",
    createdAt: { lt: createdBefore },
    ...(leftOut.length > 0 && { id: { notIn: leftOut } }),
  };
}

export function bindPendingUseSweepTickDeps(
  db: PendingUseSweepPrisma,
  now: () => Date = () => new Date(),
): PendingUseSweepTickDeps<SweepableCharge> {
  // Revenue id -> the time until which it is left out of the read. Kept in
  // this process only: a restart tries everything again.
  const heldUntil = new Map<string, number>();
  const hold = (revenueId: string, until: number) => {
    heldUntil.delete(revenueId);
    heldUntil.set(revenueId, until);
    while (heldUntil.size > PENDING_USE_SWEEP_HOLD_MAX) {
      const oldest = heldUntil.keys().next();
      if (oldest.done) break;
      heldUntil.delete(oldest.value);
    }
  };
  const leftOut = (): string[] => {
    const at = now().getTime();
    for (const [revenueId, until] of heldUntil) {
      if (until <= at) heldUntil.delete(revenueId);
    }
    return [...heldUntil.keys()];
  };

  return {
    now,
    findStalePending: async ({ createdBefore, take }) => {
      const rows = await db.marketplaceRevenue.findMany({
        where: staleWhere(createdBefore, leftOut()),
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          listingId: true,
          installId: true,
          buyerId: true,
          publisherId: true,
          grossAmountCents: true,
          platformFeeCents: true,
          creatorAmountCents: true,
          requestCount: true,
          createdAt: true,
        },
      });
      // The licences of the whole batch in one read: whether each is a use
      // or a copy, and the title, are what the buyer's ledger line is
      // written from.
      const installIds = [...new Set(rows.flatMap((row) => (row.installId ? [row.installId] : [])))];
      const installs =
        installIds.length === 0
          ? []
          : await db.agentInstall.findMany({
              where: { id: { in: installIds } },
              select: { id: true, kind: true, listing: { select: { title: true } } },
            });
      const installOf = new Map(installs.map((install) => [install.id, install]));

      // A request of a copy may still be running at this age. It is not a
      // failure: it is left out, here and from the next reads, until it is
      // old enough.
      const at = now().getTime();
      const due = rows.filter((row) => {
        const install = row.installId ? installOf.get(row.installId) : undefined;
        if (install?.kind !== "copy") return true;
        const dueAt = row.createdAt.getTime() + PENDING_COPY_MAX_MS;
        if (dueAt < at) return true;
        hold(row.id, dueAt);
        return false;
      });

      return due.map((row) => {
        const install = row.installId ? installOf.get(row.installId) : undefined;
        const requestCount = Math.max(1, Math.trunc(row.requestCount));
        const known = install && row.listingId && (install.kind === "use" || install.kind === "copy");
        return {
          revenueId: row.id,
          buyerId: row.buyerId,
          grossCents: row.grossAmountCents,
          createdAt: row.createdAt,
          charge: known
            ? {
                revenueId: row.id,
                grossCents: row.grossAmountCents,
                platformFeeCents: row.platformFeeCents,
                creatorCents: row.creatorAmountCents,
                requestCount,
                install: {
                  installId: install.id,
                  listingId: row.listingId as string,
                  listingTitle: install.listing.title,
                  publisherId: row.publisherId,
                  buyerId: row.buyerId,
                  pricePerRequestCents: row.grossAmountCents / BigInt(requestCount),
                  kind: install.kind as "use" | "copy",
                },
              }
            : null,
        };
      });
    },
    countStalePending: ({ createdBefore }) =>
      db.marketplaceRevenue.count({ where: staleWhere(createdBefore, leftOut()) }),
    refund: async (stale, reason) => {
      const charge = stale.charge;
      let result: Awaited<ReturnType<typeof refundMarketplaceRequest>>;
      try {
        // Without the licence there is no telling whether this was a use or
        // a copy, so neither how long it may run nor what the buyer's ledger
        // line should say. The row stays pending and is logged, for a person
        // to look at.
        if (!charge) throw new Error("the licence of this charge could not be read");
        result = await db.$transaction((tx) => refundMarketplaceRequest(tx, { charge, reason }));
      } catch (err) {
        hold(stale.revenueId, now().getTime() + PENDING_USE_SWEEP_HOLD_MS);
        throw err;
      }
      if (!result.refunded) return false;
      logger.info(
        { revenueId: charge.revenueId, buyerId: charge.install.buyerId, refundedCents: String(result.amountCents) },
        "a charge for a use that was left pending was given back",
      );
      return true;
    },
    logger,
  };
}

export function buildPendingUseSweepTickDeps(): PendingUseSweepTickDeps<SweepableCharge> {
  return bindPendingUseSweepTickDeps(prisma as unknown as PendingUseSweepPrisma);
}
