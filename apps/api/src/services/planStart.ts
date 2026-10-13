/**
 * Starting a plan on a creator's agent.
 *
 * A plan is prepaid uses on top of a listing that sells use per request. A
 * buyer starts one with the exact terms they were shown (the plan, its
 * price, its uses, its price for an extra use). If any of them differs from
 * the plan as it is now, nothing is charged and the current plans are
 * answered. Otherwise the full 30 days are charged from credits at once, on
 * the path a monthly subscription takes, and the buyer's subscription row
 * keeps its own copy of the terms.
 *
 * It is the start of services/marketplace.ts (startUsing) with one step
 * replaced. Who may start, on what, and when nothing is started (the
 * creator's own agent, a listing that sells copies, a copy whose month is
 * paid for, a paused listing) are the same refusals in the same order. The
 * step that differs is the agreement: startUsing records the listing's
 * price per use on the licence (agreeToTerms, writeLicence), and a plan
 * start must not, because starting a plan is not an agreement to pay per
 * use. So the licence here is written by startPlanSubscription
 * (services/marketplaceSubscriptions.ts) and by nothing else: when the plan
 * ends the buyer is charged per use only if they agreed to that themselves.
 *
 * Throws UseStartError (404 listing_not_found, 409 own_agent, sells_copies,
 * not_offered, copy_subscription_active, listing_paused, 503
 * service_unavailable), PlanTermsChangedError (409 pricing_changed, with the
 * plans as they are), AlreadyOnPlanError (409 already_on_plan),
 * InsufficientCreditsError, and SubscriptionClaimLostError when another
 * start for this buyer got there first. Nothing was charged on any of them.
 */
import { prisma, type Prisma } from "@wheelsai/db";

import { createLogger } from "../utils/logger.js";
import { listingPausedNow, reconcileListingPauses } from "./listingPause.js";
import { samePlanTerms, type PlanTerms } from "./listingPlans.js";
import {
  afterLicenceStarted,
  claimLicence,
  countLicence,
  LicenceClaimLostError,
  readUseState,
  USE_LISTING_INCLUDE,
  USE_START_MESSAGES,
  UseStartError,
  type ListingPauseHooks,
  type ListingPricingTerms,
  type UseState,
} from "./marketplace.js";
import {
  startPlanSubscription,
  SubscriptionClaimLostError,
  type PlanStartTx,
} from "./marketplaceSubscriptions.js";
import { offersPlans, planOfferOf, readPlanOffers, type PlanOffer, type PlanOfferDb } from "./planOffers.js";
import {
  COPY_MONTH_BLOCKS_USE,
  copyMonthBlockingUse,
  copyMonthBlockingUseMessage,
  useAccess,
} from "./useAccess.js";

const logger = createLogger("plan-start");

const dollars = (cents: bigint) => `$${(Number(cents) / 100).toFixed(2)}`;

export const PLAN_START_MESSAGES = {
  termsRequired:
    "Send the plan you were shown, with its price, its uses and its price for an extra use, so nothing is agreed to that you did not see.",
  termsChanged: (listingTitle: string) =>
    `The plans of "${listingTitle}" are not what you were shown. Nothing was charged. Look at them again and choose.`,
  alreadyOnPlan: "You already have a plan or a subscription for this agent that is still running. Nothing was charged.",
  notEnoughCredits: (priceCents: bigint) =>
    `You do not have enough credits for this plan (${dollars(priceCents)} for 30 days). Nothing was charged. Add credits to continue.`,
} as const;

/**
 * The plan is not what the buyer was shown: its creator changed or ended it
 * in between, the listing is no longer sold per use, or the plan is not one
 * of this listing's. Nothing was written or charged. Carries what the
 * listing offers now, to be shown and agreed to again.
 */
export class PlanTermsChangedError extends Error {
  readonly code = "pricing_changed";
  constructor(
    listingTitle: string,
    /** The listing's own pricing, as PricingChangedError carries it. */
    readonly pricing: ListingPricingTerms,
    /** The plans on offer now. Empty when the listing offers none. */
    readonly plans: PlanOffer[],
  ) {
    super(PLAN_START_MESSAGES.termsChanged(listingTitle));
    this.name = "PlanTermsChangedError";
  }
}

/** The buyer's subscription to this agent still runs: a plan, or a month. Nothing was charged. */
export class AlreadyOnPlanError extends Error {
  readonly code = "already_on_plan";
  constructor() {
    super(PLAN_START_MESSAGES.alreadyOnPlan);
    this.name = "AlreadyOnPlanError";
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

/** A listing as a start reads it: with the agent it sells use of. */
export type PlanListing = Prisma.AgentListingGetPayload<{ include: typeof USE_LISTING_INCLUDE }>;

interface PricedListing {
  title: string;
  status: string;
  sells: string;
  pricingModel: string;
  pricePerRequestCents: bigint | null;
  monthlyPriceCents: bigint | null;
}

/** What a start that found other terms answers with: the listing's pricing and its plans, as they are. */
export async function termsChanged(db: PlanOfferDb, listingId: string, listing: PricedListing): Promise<PlanTermsChangedError> {
  const plans = offersPlans(listing) ? (await readPlanOffers(db, listingId)).map(planOfferOf) : [];
  return new PlanTermsChangedError(
    listing.title,
    {
      pricingModel: listing.pricingModel,
      pricePerRequestCents: listing.pricePerRequestCents !== null ? Number(listing.pricePerRequestCents) : null,
      monthlyPriceCents: listing.monthlyPriceCents !== null ? Number(listing.monthlyPriceCents) : null,
    },
    plans,
  );
}

/**
 * The refusals of an agent that cannot answer a paid use right now. A start
 * and a move to another plan both charge 30 days, and neither charges them
 * for something that cannot run. Throws UseStartError; returns when the
 * agent can answer and no stale pause marker is left on the listing.
 */
export async function refuseIfItCannotAnswer(listing: PlanListing, hooks: ListingPauseHooks): Promise<void> {
  const listingId = listing.id;
  // An agent that answers through its graph cannot answer a paid use. No
  // 30 days are charged for something that cannot run.
  if (listing.agent?.entrypoint === "graph") {
    throw new UseStartError(409, "not_offered", USE_START_MESSAGES.tokenAccess);
  }
  // Paused: the agent cannot answer, so nothing is started on it. Asked of
  // the model at this moment, never read from the marker. Fail closed: when
  // the question cannot be answered nobody is charged.
  let paused: boolean;
  try {
    paused = listing.agent
      ? await (hooks.listingPausedNow ?? listingPausedNow)({ listing, agent: listing.agent })
      : false;
  } catch (err) {
    logger.warn({ err, listingId }, "Could not ask whether a listing is paused; nothing was charged");
    throw new UseStartError(503, "service_unavailable", USE_START_MESSAGES.cannotStart);
  }
  if (paused) {
    throw new UseStartError(409, "listing_paused", USE_START_MESSAGES.paused);
  }
  // A pause that is over but whose marker is still set is cleared BEFORE
  // this start, so that 30 days that begin now are not made longer by a
  // pause that ended before them. If that cannot be done nothing is started.
  if (listing.pausedSince) {
    let errors: number;
    try {
      ({ errors } = await (hooks.reconcileListingPauses ?? reconcileListingPauses)({ listingId }));
    } catch (err) {
      logger.warn({ err, listingId }, "Could not clear a listing's pause before charging a plan; nothing was charged");
      throw new UseStartError(503, "service_unavailable", USE_START_MESSAGES.cannotStart);
    }
    if (errors > 0) {
      throw new UseStartError(503, "service_unavailable", USE_START_MESSAGES.cannotStart);
    }
  }
}

/**
 * The plan `shown`, as this listing offers it inside the transaction that
 * will charge for it. Read again where it is charged: the listing and the
 * plan as they are here are what the buyer is held to. Throws UseStartError
 * when the listing is no longer there to start on, and PlanTermsChangedError
 * when the plan is not what was shown.
 */
export async function planAsOffered(tx: Prisma.TransactionClient, listingId: string, shown: PlanTerms) {
  const fresh = await tx.agentListing.findUnique({
    where: { id: listingId },
    select: {
      title: true,
      status: true,
      sells: true,
      pricingModel: true,
      pricePerRequestCents: true,
      monthlyPriceCents: true,
    },
  });
  const plan = await tx.listingPlan.findUnique({ where: { id: shown.id } });
  if (!fresh || fresh.status !== "published") {
    throw new UseStartError(404, "listing_not_found", USE_START_MESSAGES.listingNotFound);
  }
  if (fresh.sells !== "use") {
    throw new UseStartError(409, "sells_copies", USE_START_MESSAGES.sellsCopies);
  }
  if (
    fresh.pricingModel !== "per_request" ||
    plan === null ||
    plan.listingId !== listingId ||
    plan.kind !== "paid" ||
    !samePlanTerms(shown, plan)
  ) {
    throw await termsChanged(tx, listingId, fresh);
  }
  return plan;
}

/**
 * Start the plan `shown` on a listing, for the buyer's organization. `shown`
 * is the terms the person was looking at when they confirmed, and is their
 * consent. `created` is always true: a start that changes nothing is a
 * refusal here, never a quiet success.
 */
export async function startPlan(
  listingId: string,
  buyerId: string,
  shown: PlanTerms,
  hooks: ListingPauseHooks = {},
): Promise<UseState & { created: true }> {
  const listing = await prisma.agentListing.findUnique({
    where: { id: listingId },
    include: USE_LISTING_INCLUDE,
  });

  // A listing that is not on sale is not there to start on, whoever asks.
  if (!listing || listing.status !== "published") {
    throw new UseStartError(404, "listing_not_found", USE_START_MESSAGES.listingNotFound);
  }
  // Self-dealing is refused by organization, here and at every use.
  if (listing.publisherId === buyerId) {
    throw new UseStartError(409, "own_agent", USE_START_MESSAGES.ownAgent);
  }
  if (listing.sells !== "use") {
    throw new UseStartError(409, "sells_copies", USE_START_MESSAGES.sellsCopies);
  }

  // The plan as it is now, against what the person was shown. Any
  // difference, a cheaper price included, and nothing is agreed to for them.
  // A plan of another listing, one that was ended and one that does not
  // exist are the same case: not a plan this listing offers.
  const planNow = await prisma.listingPlan.findUnique({ where: { id: shown.id } });
  const offered =
    listing.pricingModel === "per_request" &&
    planNow !== null &&
    planNow.listingId === listingId &&
    planNow.kind === "paid" &&
    samePlanTerms(shown, planNow);
  if (!offered) throw await termsChanged(prisma, listingId, listing);

  const existingInstall = await prisma.agentInstall.findUnique({
    where: { listingId_buyerId: { listingId, buyerId } },
  });
  const subRow = existingInstall
    ? await prisma.agentSubscription.findUnique({
        where: { listingId_subscriberId: { listingId, subscriberId: buyerId } },
        select: {
          id: true,
          status: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          endReason: true,
          includedUses: true,
          plan: { select: { status: true } },
        },
      })
    : null;
  const existingSub = subRow && { ...subRow, planRetired: subRow.plan?.status === "retired" };

  const now = new Date();
  // A copy of this agent with a month paid for: one licence row for a
  // listing and a buyer, so starting use over it is refused, as it is for
  // a start without a plan.
  const copyPaidUntil = copyMonthBlockingUse(existingInstall, existingSub, now);
  if (copyPaidUntil) {
    throw new UseStartError(
      409,
      COPY_MONTH_BLOCKS_USE,
      copyMonthBlockingUseMessage(copyPaidUntil, now),
      copyPaidUntil,
    );
  }
  // A plan or a month that still runs. Told here in a sentence; the claim
  // in the transaction is what holds it against two starts at once.
  const access = useAccess(
    {
      licence: existingInstall
        ? {
            kind: existingInstall.kind,
            status: existingInstall.status,
            accepted: {
              pricingModel: existingInstall.acceptedPricingModel,
              pricePerRequestCents: existingInstall.acceptedPricePerRequestCents,
            },
          }
        : null,
      listing,
      sub: existingSub,
    },
    now,
  );
  if (access === "subscribed") throw new AlreadyOnPlanError();

  await refuseIfItCannotAnswer(listing, hooks);

  // The licence, the subscription with its copy of the terms, the charge
  // for the 30 days and the counters commit together or not at all.
  const subscriptionId = await prisma
    .$transaction(async (tx) => {
      const plan = await planAsOffered(tx, listingId, shown);

      await claimLicence(tx, existingInstall);
      // The terms written and charged are the row's, which are the ones shown.
      const started = await startPlanSubscription(tx as unknown as PlanStartTx, {
        listing: { id: listing.id, title: listing.title, publisherId: listing.publisherId },
        plan: {
          planId: plan.id,
          priceCents: plan.priceCents,
          includedUses: plan.includedUses,
          extraUsePriceCents: plan.extraUsePriceCents,
        },
        buyerId,
        // As it was read before the start: a licence that was for a copy
        // has its agreement cleared there, and one for use keeps its own.
        licence: existingInstall ? { id: existingInstall.id, kind: existingInstall.kind } : null,
        now,
      });
      await countLicence(tx, { listingId, previousStatus: existingInstall?.status });
      return started.subscription.id;
    })
    .catch((err) => {
      // The buyer's subscription row still grants access, or another writer
      // took it first. This transaction rolled back whole.
      if (err instanceof SubscriptionClaimLostError) throw new AlreadyOnPlanError();
      // Another start for this buyer holds the licence row, or the unique
      // (listingId, buyerId) on a first start.
      if (isUniqueViolation(err) || err instanceof LicenceClaimLostError) {
        throw new SubscriptionClaimLostError(USE_START_MESSAGES.claimLost);
      }
      throw err;
    });

  await afterLicenceStarted(listingId, listing.publisherId, "a start of a plan");

  logger.info({ listingId, buyerId, subscription: subscriptionId, plan: shown.id }, "Started a plan on an agent from the marketplace");

  return { ...(await readUseState(listing, buyerId)), created: true };
}
