/**
 * A listing that sells use of its agent is paused while the agent cannot
 * answer because the model it is set to, one its organization runs itself
 * (`wheelsai/<model id>`, services/hostedModel.ts), is not running.
 *
 * Two things live here, and they are kept apart on purpose:
 *
 *   listingPausedNow        whether a listing is paused AT THIS MOMENT. Every
 *                           place that decides something (a start, the
 *                           buyer's page, the seller's list) asks this. It is
 *                           never read from the marker.
 *   reconcileListingPauses  keeps the marker, AgentListing.pausedSince, in
 *                           line with the moment. The marker is only the
 *                           subscribers' clock: while it is set no month of
 *                           use of the listing is renewed
 *                           (marketplaceSubscriptions.ts), and when it is
 *                           cleared every month paid for is made longer by
 *                           the time it was set.
 *
 * Money: a month is made longer in the transaction that clears the marker,
 * and the marker is cleared by compare-and-set on the value that was read.
 * Of two workers that read the same marker one clears it and lengthens the
 * months; the other's clear matches no row and it does nothing more. If the
 * lengthening fails the clear rolls back with it, so the marker is still
 * there for the next reconcile.
 */

import { Prisma, prisma } from "@wheelsai/db";

import { createLogger } from "../utils/logger.js";
import { resolveAgentModelId } from "./agentModelResolution.js";
import { HOSTED_MODEL_PREFIX, resolveHostedModel } from "./hostedModel.js";

export const LISTING_PAUSED_START_MESSAGE =
  "This agent is paused right now, so nothing was started and nothing was charged. Try again later.";
export const AGENT_PAUSED_MESSAGE = "This agent is paused right now. Nothing was charged.";

/** A listing as the reconcile reads it. */
export interface ListingPauseRow {
  id: string;
  status: string;
  sells: string;
  pausedSince: Date | null;
  /** null on a listing that sells a workflow: it has no model of its own to be paused on. */
  agent: { orgId: string; modelConfig: unknown } | null;
}

/** What runs inside the transaction that ends a pause. */
export interface ListingPauseTx {
  agentListing: {
    updateMany(args: {
      where: { id: string; pausedSince: Date | null };
      data: { pausedSince: Date | null };
    }): Promise<{ count: number }>;
  };
  $executeRaw(query: Prisma.Sql): Promise<number>;
}

/** The part of the database the reconcile uses. The Prisma client is one. */
export interface ListingPauseDb {
  agentListing: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: { id: "asc" };
      take: number;
      select: Record<string, unknown>;
    }): Promise<ListingPauseRow[]>;
    updateMany(args: {
      where: { id: string; pausedSince: Date | null };
      data: { pausedSince: Date | null };
    }): Promise<{ count: number }>;
  };
  $transaction<T>(fn: (tx: ListingPauseTx) => Promise<T>): Promise<T>;
}

export interface ListingPauseDeps {
  db?: ListingPauseDb;
  /** Answers `ok` when the organization's own deployment of the model can serve now. */
  resolveHostedModel?: (args: { orgId: string; modelId: string }) => Promise<{ ok: boolean }>;
  now?: () => Date;
  logger?: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
}

const defaultLogger = createLogger("listing-pause");

/** Candidates are read this many at a time, in id order. */
const BATCH_SIZE = 200;

/** Whether a listing that sells use of this agent is paused at this moment. Reads only. */
export async function listingPausedNow(
  args: { listing: { status: string; sells: string }; agent: { orgId: string; modelConfig: unknown } },
  deps: ListingPauseDeps = {},
): Promise<boolean> {
  if (args.listing.status !== "published" || args.listing.sells !== "use") return false;
  // No free models offered: an agent with no model of its own is not on a
  // model its organization runs, whatever it would fall back to.
  const modelId = resolveAgentModelId({ modelConfig: args.agent.modelConfig, availableFreeModelIds: [] });
  if (!modelId || !modelId.startsWith(HOSTED_MODEL_PREFIX)) return false;
  const resolve = deps.resolveHostedModel ?? resolveHostedModel;
  return !(await resolve({ orgId: args.agent.orgId, modelId })).ok;
}

/** Which listings to look at. */
export type ListingPauseScope = { orgId: string } | { listingId: string } | { all: true };

export interface ListingPauseReconcileResult {
  examined: number;
  /** Listings whose marker was set by this call. */
  paused: number;
  /** Listings whose marker was cleared by this call. */
  resumed: number;
  /** Subscriptions whose paid month was made longer by this call. */
  extendedSubscriptions: number;
  errors: number;
}

/**
 * The listings a reconcile looks at: those whose marker is set (it may have
 * to be cleared, whatever the listing is now), and those that could be
 * paused. The model is matched on what is stored, which is wider than the
 * rule (an agent whose `model` is hosted but whose `externalModel` is not);
 * listingPausedNow then applies the rule itself.
 *
 * The stored model is matched on containing the prefix, not on starting
 * with it: the agent's model is the stored text trimmed
 * (agentModelResolution.ts), and a model is stored as it was sent. An agent
 * set to " wheelsai/x" answers from its organization's deployment like any
 * other, so its listing must get a marker too, or its subscribers would be
 * renewed while it cannot answer.
 */
function candidatesWhere(scope: ListingPauseScope, afterId: string | null): Prisma.AgentListingWhereInput {
  const within =
    "orgId" in scope ? { agent: { orgId: scope.orgId } } : "listingId" in scope ? { id: scope.listingId } : {};
  return {
    AND: [
      within,
      ...(afterId === null ? [] : [{ id: { gt: afterId } }]),
      {
        OR: [
          { pausedSince: { not: null } },
          {
            status: "published",
            sells: "use",
            agent: {
              OR: [
                { modelConfig: { path: ["externalModel"], string_contains: HOSTED_MODEL_PREFIX } },
                { modelConfig: { path: ["model"], string_contains: HOSTED_MODEL_PREFIX } },
              ],
            },
          },
        ],
      },
    ],
  };
}

/**
 * Makes every month paid for use of the listing longer by the time the
 * listing was paused during that month: now - max(pausedSince, the month's
 * start), when that is positive. A month that began during the pause is
 * lengthened from its own start only; a marker in the future lengthens
 * nothing.
 *
 * One statement, so no month is read and then written: a renewal that moves
 * a row while this runs is seen by it. Raw SQL because Prisma cannot add a
 * value computed from another column. The two moments go in as whole
 * milliseconds since 1970, never as text and never as timestamps, so no
 * session time zone can shift them: the columns hold UTC without a zone, and
 * their EPOCH is read the same way.
 *
 * Only a licence for use (agent_installs.kind): a copy runs in the buyer's
 * own organization and was never paused.
 */
function extendUseSubscriptionsSql(args: { listingId: string; pausedSince: Date; now: Date }): Prisma.Sql {
  const nowMs = BigInt(Math.trunc(args.now.getTime()));
  const sinceMs = BigInt(Math.trunc(args.pausedSince.getTime()));
  return Prisma.sql`
    UPDATE "agent_subscriptions" AS s
    SET "current_period_end" = s."current_period_end" + (
          ${nowMs}::bigint
          - GREATEST(${sinceMs}::bigint, ROUND(EXTRACT(EPOCH FROM s."current_period_start") * 1000)::bigint)
        )::double precision * INTERVAL '1 millisecond',
        "updated_at" = CURRENT_TIMESTAMP
    FROM "agent_installs" AS i
    WHERE s."listing_id" = ${args.listingId}::uuid
      AND i."listing_id" = s."listing_id"
      AND i."buyer_id" = s."subscriber_id"
      AND i."kind" = 'use'
      AND s."status" IN ('active', 'past_due')
      AND ${nowMs}::bigint
          > GREATEST(${sinceMs}::bigint, ROUND(EXTRACT(EPOCH FROM s."current_period_start") * 1000)::bigint)
  `;
}

/** Brings each listing's marker in line with the moment. One listing's failure never stops the others. */
export async function reconcileListingPauses(
  scope: ListingPauseScope,
  deps: ListingPauseDeps = {},
): Promise<ListingPauseReconcileResult> {
  const db = deps.db ?? (prisma as unknown as ListingPauseDb);
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? defaultLogger;
  const result: ListingPauseReconcileResult = {
    examined: 0,
    paused: 0,
    resumed: 0,
    extendedSubscriptions: 0,
    errors: 0,
  };

  // In id order, a batch at a time: the platform's listings are never all
  // in memory, and a listing is looked at once however its marker changes.
  let afterId: string | null = null;
  for (;;) {
    const batch = await db.agentListing.findMany({
      where: candidatesWhere(scope, afterId),
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
      select: {
        id: true,
        status: true,
        sells: true,
        pausedSince: true,
        agent: { select: { orgId: true, modelConfig: true } },
      },
    });
    for (const listing of batch) {
      result.examined++;
      try {
        // A listing with no agent sells a workflow, and a workflow's listing
        // has no pause: nothing sets its marker and nothing reads it. One
        // found set is cleared, by the same compare-and-set, and no month is
        // made longer for a pause that never was.
        if (listing.agent === null) {
          const stray = listing.pausedSince;
          if (stray !== null) {
            const cleared = await db.agentListing.updateMany({
              where: { id: listing.id, pausedSince: stray },
              data: { pausedSince: null },
            });
            if (cleared.count === 1) {
              result.resumed++;
              logger.info({ listingId: listing.id, pausedSince: stray }, "A pause marker on a listing with no agent was cleared");
            }
          }
          continue;
        }
        // Asked of the model at this moment. If it cannot be answered this
        // throws and the listing is left exactly as it is: an unknown is
        // neither a pause nor a resume.
        const pausedNow = await listingPausedNow({ listing, agent: listing.agent }, deps);
        const since = listing.pausedSince;
        if (pausedNow && since === null) {
          const set = await db.agentListing.updateMany({
            where: { id: listing.id, pausedSince: null },
            data: { pausedSince: now() },
          });
          if (set.count === 1) {
            result.paused++;
            logger.info({ listingId: listing.id }, "Listing paused: its agent's model is not running");
          }
        } else if (!pausedNow && since !== null) {
          const extended = await db.$transaction(async (tx) => {
            // The claim. Only the worker whose clear matches the marker it
            // read lengthens the months; any other does nothing more.
            const cleared = await tx.agentListing.updateMany({
              where: { id: listing.id, pausedSince: since },
              data: { pausedSince: null },
            });
            if (cleared.count !== 1) return null;
            return tx.$executeRaw(
              extendUseSubscriptionsSql({ listingId: listing.id, pausedSince: since, now: now() }),
            );
          });
          if (extended !== null) {
            result.resumed++;
            result.extendedSubscriptions += extended;
            logger.info(
              { listingId: listing.id, pausedSince: since, extendedSubscriptions: extended },
              "Listing no longer paused: the months paid for were made longer",
            );
          }
        }
      } catch (error) {
        result.errors++;
        logger.warn({ listingId: listing.id, error }, "Could not reconcile a listing's pause; it is left as it is");
      }
    }
    if (batch.length < BATCH_SIZE) break;
    afterId = batch[batch.length - 1]!.id;
  }
  return result;
}
