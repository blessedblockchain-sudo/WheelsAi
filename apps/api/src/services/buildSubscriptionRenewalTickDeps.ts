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
 *                     licence (a copy, or use of the creator's agent).
 *                     For a row on a plan: the marker, the plan it names
 *                     and whether its creator has ended that plan.
 *                     For a row of a listing that sells a WORKFLOW the
 *                     marker handed on is never the column: a workflow's
 *                     listing has no pause, and what stands in for it is
 *                     whether the workflow can run at this moment, asked
 *                     only for a row that could be charged (see below)
 *   recordAttempt  -> stamps lastRenewalAttemptAt in its own statement, so
 *                     it survives the renewal transaction's rollback
 *   inTransaction  -> prisma.$transaction; renewSubscription and
 *                     markPastDueOrExpire each run in their own
 */

import type { PrismaClient } from "@prisma/client";

import { createLogger } from "../utils/logger.js";
import { readWorkflowCanRunNow, type WorkflowListingDb, type WorkflowListingRef } from "./buildWorkflowListingDeps.js";
import { reconcileListingPauses, type ListingPauseDb } from "./listingPause.js";
import type { SubscriptionTx } from "./marketplaceSubscriptions.js";
import type { SubscriptionRenewalDeps } from "./runSubscriptionRenewalTick.js";
import { PAST_DUE_GRACE_DAYS } from "./subscriptionAccess.js";
import { listingProductKind } from "./workflowListing.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const logger = createLogger("subscription-renewal");

export interface SubscriptionRenewalHooks {
  /**
   * Whether a workflow on sale can run at this moment: it is sellable and
   * what its steps run on is serving. The real read when omitted.
   */
  workflowCanRunNow?: (ref: WorkflowListingRef) => Promise<boolean>;
}

export function buildSubscriptionRenewalTickDeps(
  prisma: PrismaClient,
  hooks: SubscriptionRenewalHooks = {},
): SubscriptionRenewalDeps {
  const workflowCanRunNow =
    hooks.workflowCanRunNow ??
    ((ref: WorkflowListingRef) => readWorkflowCanRunNow(ref, { db: prisma as unknown as WorkflowListingDb }));

  /**
   * What a due row of a workflow's listing is handed as its listing's pause
   * marker. A plan on a workflow is not charged again while the workflow
   * cannot run: its creator may have stopped a step's deployment or deleted
   * a step's agent, and every run of the next 30 days would fail. So the
   * marker is a date when the workflow cannot run, or when that cannot be
   * read, and renewSubscription then leaves the row as it leaves a paused
   * agent's: nothing claimed, nothing charged, nobody credited, not marked
   * past due, tried again at the next tick. It is null when the workflow
   * can run, whatever the column says, and the row is charged then.
   *
   * Asked with the listing's publisher as the workflow's organization.
   */
  async function workflowMarker(
    listing: { id: string; publisherId: string; orchestrationId: string | null },
    now: Date,
  ): Promise<Date | null> {
    // A listing that sells a workflow and names none has nothing that can run.
    if (listing.orchestrationId === null) return now;
    try {
      const canRun = await workflowCanRunNow({ workflowId: listing.orchestrationId, orgId: listing.publisherId });
      return canRun ? null : now;
    } catch (error) {
      logger.warn(
        { error, listingId: listing.id },
        "Could not ask whether a workflow can run; its plans are not renewed at this tick",
      );
      return now;
    }
  }

  /**
   * A due row that renewSubscription closes and never charges, whatever the
   * workflow can do: use of the listing is no longer sold, the buyer
   * cancelled, the creator ended the plan, or the row is past its days of
   * grace (a plan found that late is never renewed: that would charge for
   * 30 days that began days ago). Such a row is not held back by a workflow
   * that cannot run. An agent's pause ends and the row is judged then;
   * nothing ends "cannot run" for a workflow whose creator stopped what its
   * steps run on, and the row would stay active and due for good. Handed no
   * marker it takes one of the closing branches, each a compare-and-set
   * that charges nobody.
   *
   * So a plan that comes due while its workflow cannot run waits for the
   * days of grace and no longer: charged once if the workflow runs again in
   * time, ended uncharged if it does not.
   */
  function closesAnyway(
    row: {
      cancelAtPeriodEnd: boolean;
      currentPeriodEnd: Date;
      listing: { status: string; sells: string };
      plan: { status: string } | null;
    },
    now: Date,
  ): boolean {
    return (
      row.listing.status !== "published" ||
      row.listing.sells !== "use" ||
      row.cancelAtPeriodEnd ||
      row.plan?.status === "retired" ||
      now.getTime() >= row.currentPeriodEnd.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS
    );
  }

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
              // What says the listing sells an agent or a workflow.
              agentId: true,
              orchestrationId: true,
            },
          },
          // Whether the creator ended the plan a row is on: such a row is
          // not charged again.
          plan: { select: { status: true } },
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
      // An agent's row is handed its listing's marker, the column, as it
      // always was. A workflow's row is handed the answer of the moment,
      // asked once for a listing however many of its rows are in the page,
      // and only when a row of the page could be charged.
      const pausedSince = new Map<string, Date | null>();
      for (const r of rows) {
        if (pausedSince.has(r.listing.id)) continue;
        if (listingProductKind(r.listing) !== "workflow") {
          pausedSince.set(r.listing.id, r.listing.pausedSince);
          continue;
        }
        if (closesAnyway(r, now)) continue;
        pausedSince.set(r.listing.id, await workflowMarker(r.listing, now));
      }
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
          // The marker of a plan. Null on every row from before plans.
          includedUses: r.includedUses,
          planId: r.planId,
          planRetired: r.plan?.status === "retired",
        },
        listing: {
          id: r.listing.id,
          title: r.listing.title,
          publisherId: r.listing.publisherId,
          monthlyPriceCents: r.listing.monthlyPriceCents ?? 0n,
          pricingModel: r.listing.pricingModel,
          status: r.listing.status,
          sells: r.listing.sells,
          // A workflow's row that is only closed is handed no marker: see
          // closesAnyway.
          pausedSince:
            listingProductKind(r.listing) === "workflow" && closesAnyway(r, now)
              ? null
              : (pausedSince.get(r.listing.id) ?? null),
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
