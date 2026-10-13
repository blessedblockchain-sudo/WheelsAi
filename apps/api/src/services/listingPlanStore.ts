/**
 * The plans of a listing, as its creator writes and reads them.
 *
 * A creator sends the whole set of plans for a listing, and the ids of the
 * plans they ended, and it replaces what the listing has, in one transaction:
 *
 *   a plan sent with its id   is changed in place and keeps its id and place
 *   a plan named as ended     is retired, never deleted: the people on it
 *                             hold its id and finish the 30 days they paid for
 *   a plan with no id         is created at a free place from 1 to 4
 *
 * The listing's one free trial is in the same set, as an entry of kind
 * "trial": changed in place by its id, ended by naming it, created at place
 * 0. The four places of the paid plans are not its, and it takes none.
 * Ending it stops new starts at once; the trials that are running finish
 * their days, on their own rows.
 *
 * Ending a plan is said, never implied. A plan on offer that is neither sent
 * nor named is one the sender did not know of (a teammate added it, or the
 * page is an old one), so the whole save is refused and nothing is written.
 *
 * Nothing here touches a subscription. People already on a plan keep the
 * terms they agreed to, which their own row carries (agent_subscriptions).
 *
 * Two saves at once: every change of a row is a compare-and-set on the row
 * still being on offer, and a new row is held to one active plan per place
 * by the database (the partial unique index on listing and position). The
 * save that loses writes nothing and is told to reload.
 *
 * The rules of a plan are services/listingPlans.ts. This file is the reads
 * and writes, and imports no other service.
 */
import { prisma } from "@wheelsai/db";

import { validationFailureFromFields, type ValidationFailureBody } from "../lib/validationFailure.js";
import {
  checkPlanSet,
  MAX_PAID_PLANS,
  TRIAL_PLAN_POSITION,
  type PlanInput,
  type PlanSetCheck,
} from "./listingPlans.js";

/** A plan as its creator sees it. Cents are whole cents. No buyer is named. */
export interface OwnerPlan {
  id: string;
  /** "paid", or "trial" for the listing's free trial, which comes first. */
  kind: string;
  /** "Free trial" for the trial. */
  name: string;
  /** 0 for the trial. */
  priceCents: number;
  includedUses: number;
  /** Null = the plan stops until it renews. Always null for the trial. */
  extraUsePriceCents: number | null;
  status: string;
  /** How many open subscriptions are on this plan. For the trial: the trials that are running now. */
  subscribers: number;
}

export const PLAN_STORE_MESSAGES = {
  listingNotFound: "This listing was not found.",
  changedElsewhere: "These plans were changed by another save at the same moment. Reload the page and try again.",
  /** A plan is on offer that the sender neither sent nor ended: they did not know of it. */
  changedSincePageLoaded: "These plans were changed somewhere else since this page was loaded. Reload the page and try again.",
  keptAndEnded: "This plan is in the list of plans to keep and in the list of plans to end. Choose one.",
} as const;

export type SetPlansResult =
  | { ok: true; plans: OwnerPlan[] }
  | {
      ok: false;
      status: 400 | 404 | 409;
      /** validation_failed, listing_not_found, plans_not_available or plans_changed. */
      code: string;
      message: string;
      /** The whole answer of a 400 validation_failed, with its fields. */
      body?: ValidationFailureBody;
    };

type Refused = Exclude<SetPlansResult, { ok: true }>;

/** Thrown inside the transaction so that it rolls back whole; never leaves this file. */
class PlansRefused extends Error {
  constructor(readonly refusal: Refused) {
    super(refusal.message);
    this.name = "PlansRefused";
  }
}

const CHANGED_ELSEWHERE: Refused = {
  ok: false,
  status: 409,
  code: "plans_changed",
  message: PLAN_STORE_MESSAGES.changedElsewhere,
};

const CHANGED_SINCE_PAGE_LOADED: Refused = {
  ok: false,
  status: 409,
  code: "plans_changed",
  message: PLAN_STORE_MESSAGES.changedSincePageLoaded,
};

/**
 * A plan that is both sent and named as ended, told on its place in `ended`.
 * Null when no plan is in both lists.
 */
function keptAndEnded(plans: readonly PlanInput[], ended: readonly string[]): Refused | null {
  const sent = new Set(plans.flatMap((plan) => (plan.id === undefined ? [] : [plan.id])));
  const fields: Record<string, string> = {};
  ended.forEach((id, index) => {
    if (sent.has(id)) fields[`ended[${index}]`] = PLAN_STORE_MESSAGES.keptAndEnded;
  });
  if (Object.keys(fields).length === 0) return null;
  return {
    ok: false,
    status: 400,
    code: "validation_failed",
    message: PLAN_STORE_MESSAGES.keptAndEnded,
    body: validationFailureFromFields(fields),
  };
}

/** The statuses of a subscription that nothing has closed. */
const OPEN_STATUSES = ["active", "past_due"];

const OWNER_PLAN_COLUMNS = {
  id: true,
  listingId: true,
  kind: true,
  name: true,
  priceCents: true,
  includedUses: true,
  extraUsePriceCents: true,
  status: true,
  position: true,
} as const;

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

type PlanReader = Pick<typeof prisma, "listingPlan" | "agentSubscription">;

/**
 * The plans on offer for each of these listings, in the order a buyer sees
 * them, each with the number of open subscriptions on it. The free trial, if
 * the listing offers one, comes first with its kind. A listing with no plan
 * is not in the map.
 */
export async function readOwnerPlans(db: PlanReader, listingIds: string[]): Promise<Map<string, OwnerPlan[]>> {
  const byListing = new Map<string, OwnerPlan[]>();
  if (listingIds.length === 0) return byListing;
  const rows = await db.listingPlan.findMany({
    where: { listingId: { in: listingIds }, status: "active" },
    orderBy: { position: "asc" },
    select: OWNER_PLAN_COLUMNS,
  });
  if (rows.length === 0) return byListing;

  // Counted by the database: a plan can have many people on it, and none of
  // their rows is read.
  const held = await db.agentSubscription.groupBy({
    by: ["planId"],
    where: { planId: { in: rows.map((row) => row.id) }, status: { in: OPEN_STATUSES } },
    _count: { _all: true },
  });
  const subscribers = new Map(held.map((group) => [group.planId, group._count._all]));

  for (const row of rows) {
    const plans = byListing.get(row.listingId) ?? [];
    // Field by field: the row's place and dates stay here.
    plans.push({
      id: row.id,
      kind: row.kind,
      name: row.name,
      priceCents: Number(row.priceCents),
      includedUses: row.includedUses,
      extraUsePriceCents: row.extraUsePriceCents === null ? null : Number(row.extraUsePriceCents),
      status: row.status,
      subscribers: subscribers.get(row.id) ?? 0,
    });
    byListing.set(row.listingId, plans);
  }
  return byListing;
}

/**
 * Replace the plans of a listing of this organization with the set sent.
 * Nothing is written unless the whole set passes the rules, and the writes
 * commit together or not at all. Answers the plans as they are afterwards.
 *
 * `ended` are the ids of the plans the sender ends. One that is not on offer
 * on this listing (ended already, or never this listing's) changes nothing
 * and is no error.
 */
export async function replaceListingPlans(args: {
  listingId: string;
  orgId: string;
  plans: PlanInput[];
  ended?: readonly string[];
  now?: Date;
}): Promise<SetPlansResult> {
  const { listingId, orgId } = args;
  const now = args.now ?? new Date();
  const ended = args.ended ?? [];
  const both = keptAndEnded(args.plans, ended);
  if (both) return both;
  const named = new Set(ended);
  try {
    await prisma.$transaction(async (tx) => {
      // Somebody else's listing is not there to be told apart from none.
      const listing = await tx.agentListing.findFirst({
        where: { id: listingId, publisherId: orgId },
        select: { id: true, sells: true, pricingModel: true, agent: { select: { agentKind: true } } },
      });
      if (!listing) {
        throw new PlansRefused({
          ok: false,
          status: 404,
          code: "listing_not_found",
          message: PLAN_STORE_MESSAGES.listingNotFound,
        });
      }

      const paidOnOffer = await tx.listingPlan.findMany({
        where: { listingId, status: "active", kind: "paid" },
        select: { id: true, position: true },
      });
      // The free trial, read by itself: the places of the paid plans are
      // worked out from the paid rows alone.
      const trialOnOffer = await tx.listingPlan.findMany({
        where: { listingId, status: "active", kind: "trial" },
        select: { id: true, position: true },
      });
      const onOffer = [...paidOnOffer, ...trialOnOffer];
      const kinds = new Map<string, string>([
        ...paidOnOffer.map((plan): [string, string] => [plan.id, "paid"]),
        ...trialOnOffer.map((plan): [string, string] => [plan.id, "trial"]),
      ]);
      // Every plan on offer must be either sent or named as ended. Checked
      // here, on the rows this transaction read, and before the rules of a
      // plan: a sender who did not know of a plan is told to reload, not what
      // is wrong with a set that was made from an old page.
      const sent = new Set(args.plans.flatMap((plan) => (plan.id === undefined ? [] : [plan.id])));
      if (onOffer.some((plan) => !sent.has(plan.id) && !named.has(plan.id))) {
        throw new PlansRefused(CHANGED_SINCE_PAGE_LOADED);
      }

      // An empty set is allowed on any listing: one that left pay per use can
      // have no new plan, but its creator must be able to take the old ones
      // off, or they would come back on offer unasked if the listing is ever
      // sold per use again.
      const check: PlanSetCheck =
        args.plans.length === 0
          ? { ok: true, plans: [] }
          : checkPlanSet(
              { sells: listing.sells, pricingModel: listing.pricingModel, agentKind: listing.agent?.agentKind },
              args.plans,
              new Set(onOffer.map((plan) => plan.id)),
              kinds,
            );
      if (!check.ok) {
        throw new PlansRefused(
          check.status === 400
            ? { ok: false, status: 400, code: check.code, message: check.message, body: check.body }
            : { ok: false, status: 409, code: check.code, message: check.message },
        );
      }

      // Named as ended: retired. First, so that the places they held are
      // free. Only a plan that is on offer on this listing: an id that is
      // ended already, or is another listing's, is not reached for.
      const leaving = onOffer.filter((plan) => named.has(plan.id)).map((plan) => plan.id);
      if (leaving.length > 0) {
        const retired = await tx.listingPlan.updateMany({
          where: { id: { in: leaving }, listingId, status: "active" },
          data: { status: "retired", retiredAt: now },
        });
        if (retired.count !== leaving.length) throw new PlansRefused(CHANGED_ELSEWHERE);
      }

      // Sent with its id: changed in place. It keeps its id and its place, so
      // no two rows ever reach for one place while this runs. The row must
      // still be of the kind it was sent as: a free trial is never written
      // over a paid plan's row, or the other way round.
      const places = new Set<number>();
      for (const plan of check.plans) {
        if (plan.id === null) continue;
        const changed = await tx.listingPlan.updateMany({
          where: { id: plan.id, listingId, status: "active", kind: plan.kind },
          data: {
            name: plan.name,
            priceCents: plan.priceCents,
            includedUses: plan.includedUses,
            extraUsePriceCents: plan.extraUsePriceCents,
          },
        });
        if (changed.count !== 1) throw new PlansRefused(CHANGED_ELSEWHERE);
        places.add(onOffer.find((row) => row.id === plan.id)!.position);
      }

      // New: at the first free place. Another save creating one at the same
      // moment loses the place to the database's index, and with it the whole
      // of its transaction.
      for (const plan of check.plans) {
        if (plan.id !== null) continue;
        // The free trial has one place of its own. If a trial is still on
        // offer there (another save added it a moment ago), the index
        // refuses this one.
        let position = plan.kind === "trial" ? TRIAL_PLAN_POSITION : 1;
        if (plan.kind !== "trial") {
          while (places.has(position)) position += 1;
          if (position > MAX_PAID_PLANS) throw new PlansRefused(CHANGED_ELSEWHERE);
        }
        places.add(position);
        await tx.listingPlan.create({
          data: {
            listingId,
            kind: plan.kind,
            name: plan.name,
            priceCents: plan.priceCents,
            includedUses: plan.includedUses,
            extraUsePriceCents: plan.extraUsePriceCents,
            position,
            status: "active",
          },
        });
      }
    });
  } catch (err) {
    if (err instanceof PlansRefused) return err.refusal;
    if (isUniqueViolation(err)) return CHANGED_ELSEWHERE;
    throw err;
  }
  return { ok: true, plans: (await readOwnerPlans(prisma, [listingId])).get(listingId) ?? [] };
}
