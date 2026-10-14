/**
 * The Usage page's reads (services/buyerUsage.ts), bound to the database
 * and the clock.
 *
 * EVERY QUERY HERE IS SCOPED TO ONE ORGANIZATION: the licences by `buyerId`,
 * the subscription beside each by `subscriberId`, the charges by `buyer_id`.
 * An organization never reads another's licence, plan or spending.
 *
 * Two queries whatever the number of listings: the licences with their
 * listing and subscription, and the settled charges summed by window.
 *
 * Nothing here writes.
 */

import { prisma } from "../lib/prisma.js";
import type { BuyerUsageDeps, BuyerUsageLicence, PaidUseSum, PaidUseWindow } from "./buyerUsage.js";

// ============================================
// The slice of the database these reads use
// ============================================

const LICENCE_SELECT = {
  buyerId: true,
  status: true,
  acceptedPricingModel: true,
  acceptedPricePerRequestCents: true,
  listing: {
    select: {
      id: true,
      title: true,
      slug: true,
      status: true,
      sells: true,
      pricingModel: true,
      pricePerRequestCents: true,
      // To know a licence on the reader's own listing. Never in the answer.
      publisherId: true,
      // To know a listing that sells a workflow. Never in the answer.
      orchestrationId: true,
      agent: { select: { publicHandle: true, agentKind: true } },
    },
  },
} as const;

/** The subscription columns a plan is read from, and the plan's name and status as they are now. */
const SUBSCRIPTION_SELECT = {
  id: true,
  subscriberId: true,
  status: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  endReason: true,
  priceCents: true,
  planId: true,
  includedUses: true,
  usedInPeriod: true,
  carriedUses: true,
  extraUsePriceCents: true,
  plan: { select: { status: true, name: true } },
} as const;

interface SubscriptionRow {
  id: string;
  subscriberId: string;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  endReason: string | null;
  priceCents: bigint | null;
  planId: string | null;
  includedUses: number | null;
  usedInPeriod: number;
  carriedUses: number;
  extraUsePriceCents: bigint | null;
  plan: { status: string; name: string } | null;
}

interface LicenceRow {
  buyerId: string;
  status: string;
  acceptedPricingModel: string | null;
  acceptedPricePerRequestCents: bigint | null;
  listing: {
    id: string;
    title: string;
    slug: string;
    status: string;
    sells: string;
    pricingModel: string;
    pricePerRequestCents: bigint | null;
    publisherId: string;
    orchestrationId?: string | null;
    agent: { publicHandle: string | null; agentKind: string | null } | null;
    subscriptions: SubscriptionRow[];
  };
}

/** A row of the sum: which window, how many uses, how many cents (as text, so no bigint is lost). */
interface WindowSumRow {
  bucket: number;
  uses: number;
  cents: string;
}

export interface BuyerUsageDb {
  creditBalance: {
    findUnique(args: {
      where: { orgId: string };
      select: { balanceCents: true };
    }): Promise<{ balanceCents: bigint } | null>;
  };
  agentInstall: {
    findMany(args: {
      where: { buyerId: string; kind: "use"; status: { in: string[] } };
      orderBy: { installedAt: "desc" };
      take: number;
      select: Omit<typeof LICENCE_SELECT, "listing"> & {
        listing: {
          select: (typeof LICENCE_SELECT)["listing"]["select"] & {
            subscriptions: { where: { subscriberId: string }; select: typeof SUBSCRIPTION_SELECT };
          };
        };
      };
    }): Promise<LicenceRow[]>;
  };
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

// ============================================
// The sum, as SQL
// ============================================

export interface SqlQuery {
  text: string;
  values: unknown[];
}

/**
 * The buyer's settled charges per use, summed by window, in one statement.
 * A window is a WHEN of one CASE, numbered in the order given, so a charge
 * is counted in the first window it falls in and never twice. Only the
 * buyer's own rows are read ($1), and none older than the earliest window,
 * which is what the index on (buyer_id, created_at) serves.
 *
 * Pure, so what it filters on is testable without a database
 * (services/latencyQueries.ts is built the same way).
 */
export function paidUseWindowsQuery(buyerId: string, windows: PaidUseWindow[]): SqlQuery {
  const values: unknown[] = [buyerId];
  const param = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const cases = windows.map((window, bucket) => {
    const listing = `r.listing_id = ${param(window.listingId)}::uuid`;
    const from = `r.created_at >= ${param(window.from)}`;
    const until = window.until === null ? "" : ` AND r.created_at < ${param(window.until)}`;
    return `WHEN ${listing} AND ${from}${until} THEN ${bucket}`;
  });
  const earliest = windows.reduce((least, window) => (window.from < least ? window.from : least), windows[0]!.from);
  const text = `SELECT w.bucket AS bucket, SUM(w.request_count)::int AS uses, SUM(w.gross_amount_cents)::text AS cents
  FROM (
    SELECT r.request_count, r.gross_amount_cents,
           CASE
             ${cases.join("\n             ")}
           END AS bucket
      FROM marketplace_revenue r
     WHERE r.buyer_id = $1::uuid
       AND r.status = 'settled'
       AND r.type = 'per_request'
       AND r.created_at >= ${param(earliest)}
  ) AS w
 WHERE w.bucket IS NOT NULL
 GROUP BY w.bucket`;
  return { text, values };
}

// ============================================
// The reads
// ============================================

/** The statuses of a licence a buyer still sees (getMyInstalls, services/marketplace.ts). */
const SHOWN_LICENCE_STATUSES = ["active", "suspended"];

function licenceOf(row: LicenceRow): BuyerUsageLicence {
  const { listing } = row;
  // One row at most: a buyer has one subscription to a listing.
  const sub = listing.subscriptions[0] ?? null;
  // A listing that names a workflow, or has no agent, sells a workflow. It
  // is never read as an agent's: no handle and no kind of agent for it.
  const sellsWorkflow = (listing.orchestrationId ?? null) !== null || !listing.agent;
  const agent = sellsWorkflow ? null : listing.agent;
  return {
    buyerId: row.buyerId,
    status: row.status,
    accepted: {
      pricingModel: row.acceptedPricingModel,
      pricePerRequestCents: row.acceptedPricePerRequestCents,
    },
    listing: {
      id: listing.id,
      title: listing.title,
      slug: listing.slug,
      status: listing.status,
      sells: listing.sells,
      pricingModel: listing.pricingModel,
      pricePerRequestCents: listing.pricePerRequestCents,
      publisherId: listing.publisherId,
      productKind: sellsWorkflow ? "workflow" : "agent",
      handle: agent?.publicHandle ?? null,
      agentKind: agent?.agentKind ?? null,
    },
    sub: sub && {
      id: sub.id,
      subscriberId: sub.subscriberId,
      status: sub.status,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      endReason: sub.endReason,
      priceCents: sub.priceCents,
      planId: sub.planId,
      includedUses: sub.includedUses,
      usedInPeriod: sub.usedInPeriod,
      carriedUses: sub.carriedUses,
      extraUsePriceCents: sub.extraUsePriceCents,
      // A plan its creator ended is not renewed, and is named as it is now.
      planRetired: sub.plan?.status === "retired",
      planName: sub.plan?.name ?? null,
    },
  };
}

export function buildBuyerUsageReads(db: BuyerUsageDb): Omit<BuyerUsageDeps, "now"> {
  return {
    async readBalance(orgId) {
      const row = await db.creditBalance.findUnique({ where: { orgId }, select: { balanceCents: true } });
      return row?.balanceCents ?? 0n;
    },

    async loadLicences({ orgId, take }) {
      const rows = await db.agentInstall.findMany({
        where: { buyerId: orgId, kind: "use", status: { in: SHOWN_LICENCE_STATUSES } },
        orderBy: { installedAt: "desc" },
        take,
        select: {
          ...LICENCE_SELECT,
          listing: {
            select: {
              ...LICENCE_SELECT.listing.select,
              subscriptions: { where: { subscriberId: orgId }, select: SUBSCRIPTION_SELECT },
            },
          },
        },
      });
      return rows.map(licenceOf);
    },

    async sumPaidUses({ buyerId, windows }) {
      const sums = new Map<string, PaidUseSum>();
      if (windows.length === 0) return sums;
      const query = paidUseWindowsQuery(buyerId, windows);
      const rows = await db.$queryRawUnsafe<WindowSumRow[]>(query.text, ...query.values);
      for (const row of rows) {
        const window = windows[Number(row.bucket)];
        if (!window) continue;
        sums.set(window.key, { uses: Number(row.uses), cents: BigInt(row.cents) });
      }
      return sums;
    },
  };
}

export function buildBuyerUsageDeps(): BuyerUsageDeps {
  return {
    ...buildBuyerUsageReads(prisma as unknown as BuyerUsageDb),
    now: () => new Date(),
  };
}
