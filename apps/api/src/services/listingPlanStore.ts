/**
 * The plans of a listing, as its creator writes and reads them.
 *
 * A creator sends the whole set of plans for a listing and it replaces what
 * the listing has, in one transaction:
 *
 *   a plan sent with its id   is changed in place and keeps its id and place
 *   a plan left out           is retired, never deleted: the people on it
 *                             hold its id and finish the 30 days they paid for
 *   a plan with no id         is created at a free place from 1 to 4
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

import type { ValidationFailureBody } from "../lib/validationFailure.js";
import { checkPlanSet, MAX_PAID_PLANS, type PlanInput, type PlanSetCheck } from "./listingPlans.js";

/** A plan as its creator sees it. Cents are whole cents. No buyer is named. */
export interface OwnerPlan {
  id: string;
  /** "paid". */
  kind: string;
  name: string;
  priceCents: number;
  includedUses: number;
  /** Null = the plan stops until it renews. */
  extraUsePriceCents: number | null;
  status: string;
  /** How many open subscriptions are on this plan. */
  subscribers: number;
}

export const PLAN_STORE_MESSAGES = {
  listingNotFound: "This listing was not found.",
  changedElsewhere: "These plans were changed by another save at the same moment. Reload the page and try again.",
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
 * them, each with the number of open subscriptions on it. A listing with no
 * plan is not in the map.
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
 */
export async function replaceListingPlans(args: {
  listingId: string;
  orgId: string;
  plans: PlanInput[];
  now?: Date;
}): Promise<SetPlansResult> {
  const { listingId, orgId } = args;
  const now = args.now ?? new Date();
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

      const onOffer = await tx.listingPlan.findMany({
        where: { listingId, status: "active", kind: "paid" },
        select: { id: true, position: true },
      });
      // An empty set ends every plan, and that is allowed on any listing: one
      // that left pay per use can have no new plan, but its creator must be
      // able to take the old ones off, or they would come back on offer
      // unasked if the listing is ever sold per use again.
      const check: PlanSetCheck =
        args.plans.length === 0
          ? { ok: true, plans: [] }
          : checkPlanSet(
              { sells: listing.sells, pricingModel: listing.pricingModel, agentKind: listing.agent?.agentKind },
              args.plans,
              new Set(onOffer.map((plan) => plan.id)),
            );
      if (!check.ok) {
        throw new PlansRefused(
          check.status === 400
            ? { ok: false, status: 400, code: check.code, message: check.message, body: check.body }
            : { ok: false, status: 409, code: check.code, message: check.message },
        );
      }

      // Left out: retired. First, so that the places they held are free.
      const kept = new Set(check.plans.flatMap((plan) => (plan.id === null ? [] : [plan.id])));
      const leaving = onOffer.filter((plan) => !kept.has(plan.id)).map((plan) => plan.id);
      if (leaving.length > 0) {
        const retired = await tx.listingPlan.updateMany({
          where: { id: { in: leaving }, listingId, status: "active" },
          data: { status: "retired", retiredAt: now },
        });
        if (retired.count !== leaving.length) throw new PlansRefused(CHANGED_ELSEWHERE);
      }

      // Sent with its id: changed in place. It keeps its id and its place, so
      // no two rows ever reach for one place while this runs.
      const places = new Set<number>();
      for (const plan of check.plans) {
        if (plan.id === null) continue;
        const changed = await tx.listingPlan.updateMany({
          where: { id: plan.id, listingId, status: "active" },
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
        let position = 1;
        while (places.has(position)) position += 1;
        if (position > MAX_PAID_PLANS) throw new PlansRefused(CHANGED_ELSEWHERE);
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
