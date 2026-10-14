/**
 * Moving up to a bigger plan before the period ends.
 *
 * A buyer on a plan can move to a bigger plan of the same listing at any
 * time. The new plan's full price is charged from their credits now, a fresh
 * 30 days starts now, and the uses that were left in the old period are
 * carried into the new one, once: the next renewal drops them. The period
 * that was running is not refunded, so only a plan that costs more is a
 * move. A move to a smaller plan is not one: the buyer cancels the renewal
 * and chooses the smaller plan when theirs ends.
 *
 * It is a start (services/planStart.ts) with the claim replaced. The
 * refusals that are about the listing are the start's, in the start's order
 * and words: not on sale, the caller's own agent, a listing that sells
 * copies, an agent that cannot answer, a paused listing. The plan asked for
 * is held to the terms the buyer was shown in the same way, and read again
 * inside the transaction that charges. What differs is the buyer's row: a
 * start needs one that grants nothing, a move needs one that is open and on
 * a plan, and takes it in one claim (movePlanSubscription,
 * services/marketplaceSubscriptions.ts).
 *
 * A move writes nothing on the licence. Like a start, it is not an
 * agreement to the listing's price per use.
 *
 * A buyer on a free trial does not move: a trial carries nothing, and the
 * plan they want is started over it by the normal start. Asked to move, they
 * are told so (409 trial_cannot_move) and nothing is charged.
 *
 * Throws UseStartError, PlanMoveError (409 not_on_plan, same_plan,
 * not_a_bigger_plan, trial_cannot_move), PlanTermsChangedError (409 pricing_changed, with the
 * plans as they are), InsufficientCreditsError, and SubscriptionClaimLostError
 * when a renewal, a use or another move changed the row first. Nothing was
 * charged and nothing was changed on any of them.
 */
import { prisma } from "@wheelsai/db";

import { createLogger } from "../utils/logger.js";
import { samePlanTerms, type PlanTerms } from "./listingPlans.js";
import {
  readUseState,
  USE_LISTING_INCLUDE,
  USE_START_MESSAGES,
  useStartMessagesOf,
  UseStartError,
  type ListingPauseHooks,
  type UseState,
} from "./marketplace.js";
import {
  judgePlanMove,
  movePlanSubscription,
  PlanMoveRefusedError,
  type PlanMoveRefusal,
  type SubscriptionTx,
} from "./marketplaceSubscriptions.js";
import { planAsOffered, refuseIfItCannotAnswer, termsChanged } from "./planStart.js";

const logger = createLogger("plan-move");

export const PLAN_MOVE_MESSAGES = {
  /** `switchNow` without a plan sent whole, or with a value that is not true. */
  body: "To move to another plan, send the plan you were shown and set switchNow to true. Nothing was changed.",
  notOnPlan: "You are not on a plan. Start one first.",
  samePlan: "You are already on this plan. Nothing was charged.",
  notBigger: "To move to a smaller plan, cancel the renewal and choose it when your plan ends.",
  /** A free trial is not moved from: the plan is started over it, by the normal start. */
  onTrial: "You are on a free trial. Start the plan you want: nothing of the trial is carried over.",
} as const;

const REFUSALS: Record<PlanMoveRefusal, { code: PlanMoveError["code"]; message: string }> = {
  not_on_plan: { code: "not_on_plan", message: PLAN_MOVE_MESSAGES.notOnPlan },
  same_plan: { code: "same_plan", message: PLAN_MOVE_MESSAGES.samePlan },
  not_bigger: { code: "not_a_bigger_plan", message: PLAN_MOVE_MESSAGES.notBigger },
  on_trial: { code: "trial_cannot_move", message: PLAN_MOVE_MESSAGES.onTrial },
};

/** The buyer's own row does not allow this move. Nothing was charged or changed. */
export class PlanMoveError extends Error {
  constructor(
    readonly code: "not_on_plan" | "same_plan" | "not_a_bigger_plan" | "trial_cannot_move",
    message: string,
  ) {
    super(message);
    this.name = "PlanMoveError";
  }
}

const refusedBy = (reason: PlanMoveRefusal) => new PlanMoveError(REFUSALS[reason].code, REFUSALS[reason].message);

/**
 * Move the buyer's organization to the plan `shown` on a listing, now.
 * `shown` is the terms the person was looking at when they confirmed, and is
 * their consent. `created` is always true: a move that changes nothing is a
 * refusal, never a quiet success.
 */
export async function movePlan(
  listingId: string,
  buyerId: string,
  shown: PlanTerms,
  hooks: ListingPauseHooks = {},
): Promise<UseState & { created: true }> {
  const listing = await prisma.agentListing.findUnique({
    where: { id: listingId },
    include: USE_LISTING_INCLUDE,
  });

  // The start's refusals about the listing, in the start's order.
  if (!listing || listing.status !== "published") {
    throw new UseStartError(404, "listing_not_found", USE_START_MESSAGES.listingNotFound);
  }
  // In the words of what the listing sells: an agent, or a workflow.
  const words = useStartMessagesOf(listing);
  if (listing.publisherId === buyerId) {
    throw new UseStartError(409, "own_agent", words.ownAgent);
  }
  if (listing.sells !== "use") {
    throw new UseStartError(409, "sells_copies", words.sellsCopies);
  }

  const target = {
    planId: shown.id,
    priceCents: shown.priceCents,
    includedUses: shown.includedUses,
    extraUsePriceCents: shown.extraUsePriceCents,
  };

  // The buyer's row first: somebody who is not on a plan is told so, whatever
  // plan they sent. A licence that is not for use, or not active, has no
  // plan to move from. Told here in a sentence; the claim in the transaction
  // judges the row again and is what holds it.
  const licence = await prisma.agentInstall.findUnique({
    where: { listingId_buyerId: { listingId, buyerId } },
  });
  if (!licence || licence.kind !== "use" || licence.status !== "active") throw refusedBy("not_on_plan");
  const subRow = await prisma.agentSubscription.findUnique({
    where: { listingId_subscriberId: { listingId, subscriberId: buyerId } },
    include: { plan: { select: { status: true } } },
  });
  const now = new Date();
  // Judged on the price sent. It is the plan's own price unless the terms
  // differ, and those are compared next, before anything else is decided.
  const judged = judgePlanMove(
    subRow && { ...subRow, planRetired: subRow.plan?.status === "retired" },
    target,
    now,
  );
  if (!judged.ok && judged.refusal !== "not_bigger") throw refusedBy(judged.refusal);

  // The plan as it is now, against what the person was shown, as at a start.
  const planNow = await prisma.listingPlan.findUnique({ where: { id: shown.id } });
  const offered =
    listing.pricingModel === "per_request" &&
    planNow !== null &&
    planNow.listingId === listingId &&
    planNow.kind === "paid" &&
    samePlanTerms(shown, planNow);
  if (!offered) throw await termsChanged(prisma, listingId, listing);
  if (!judged.ok) throw refusedBy(judged.refusal);

  await refuseIfItCannotAnswer(listing, hooks);

  // The claim of the row and the charge for the new 30 days commit together
  // or not at all.
  const moved = await prisma
    .$transaction(async (tx) => {
      const plan = await planAsOffered(tx, listingId, shown);
      // The terms written and charged are the row's, which are the ones shown.
      return movePlanSubscription(tx as unknown as SubscriptionTx, {
        listing: { id: listing.id, title: listing.title, publisherId: listing.publisherId },
        plan: {
          planId: plan.id,
          priceCents: plan.priceCents,
          includedUses: plan.includedUses,
          extraUsePriceCents: plan.extraUsePriceCents,
        },
        buyerId,
        licenceId: licence.id,
        now,
      });
    })
    .catch((err) => {
      // The row as the transaction read it does not allow the move.
      if (err instanceof PlanMoveRefusedError) throw refusedBy(err.reason);
      throw err;
    });

  logger.info(
    { listingId, buyerId, subscription: moved.subscription.id, plan: shown.id, carriedUses: moved.carriedUses },
    "Moved a subscription up to a bigger plan",
  );

  return { ...(await readUseState(listing, buyerId)), created: true };
}
