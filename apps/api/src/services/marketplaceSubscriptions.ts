/**
 * Monthly marketplace subscriptions (the "Monthly" pricing model).
 *
 * Before this, a monthly listing installed and ran for free while the
 * listing page said "$X/month": the AgentSubscription table had no reader
 * or writer anywhere.
 *
 *   start   installing a monthly listing charges the first 30-day period
 *           from the buyer's credits (conditional debit, ledger row),
 *           records settled revenue split 90/10 and accrues the creator's
 *           share, and opens the period. The charge is taken only after
 *           the subscription row is claimed: created, or moved off the
 *           exact state that was read, so a concurrent subscribe or the
 *           renewal worker cannot both charge.
 *   renew   a due period is claimed with a compare-and-swap on
 *           currentPeriodEnd (so concurrent ticks cannot double-charge),
 *           then charged. If the buyer cannot pay, the whole renewal rolls
 *           back and the subscription goes past_due; it keeps retrying
 *           until a 3-day grace ends, then access is suspended.
 *   cancel  cancelAtPeriodEnd: access continues until the paid period
 *           ends, then the subscription is cancelled and access removed.
 *   pricing change
 *           a listing that leaves monthly pricing never moves a subscriber
 *           onto the new pricing: the paid period runs out, the
 *           subscription ends with endReason 'pricing_changed', and the
 *           install is suspended until the buyer accepts the new pricing.
 *   use no longer sold
 *           a subscription to USE of the creator's agent, whose listing is
 *           no longer published or now sells copies, ends at the close of
 *           the paid month with endReason 'use_ended' and is not charged
 *           again: there would be nothing to charge for.
 *   paused  a subscription to USE on a listing whose pause marker is set
 *           (services/listingPause.ts: the model the agent runs on is not
 *           running) is not renewed, closed or marked past due. It waits,
 *           and when the pause ends its month is made longer by the time
 *           the listing was paused.
 *
 *   plan    a subscription with a count of uses (a creator-set plan on a
 *           listing that sells use per request). The row carries a copy of
 *           the terms the buyer agreed to: `includedUses` set is the
 *           marker, and a row without it takes every path above untouched.
 *           startPlanSubscription writes the copy and charges the first 30
 *           days; a renewal charges the agreed price and sets the count
 *           back to zero in the statement that moves the period. A plan
 *           row is not closed because its listing is not monthly: it lives
 *           on a listing sold per request, and is closed when that listing
 *           stops selling use per request. A plan its creator ended is not
 *           charged again: the row ends with its paid period, with
 *           endReason 'plan_ended'. A plan row found more than the days of
 *           grace past its end expires, uncharged for time already gone.
 *
 * Access for a monthly install = subscription active or past_due within
 * grace (see subscriptionGrantsAccess), enforced by resolveInstallBilling.
 *
 * Pure over an injected transaction surface.
 */
import { splitRevenue } from "./marketplaceMetering.js";
import { splitCreatorRevenue, type ContributorSplitTx } from "./contributorSplits.js";
import { moveEarnings, type EarningsLedgerTx } from "./earningsLedger.js";
import {
  PAST_DUE_GRACE_DAYS,
  SUBSCRIPTION_PERIOD_DAYS,
  subscriptionGrantsAccess,
} from "./subscriptionAccess.js";

export { PAST_DUE_GRACE_DAYS, SUBSCRIPTION_PERIOD_DAYS, subscriptionGrantsAccess };
const DAY_MS = 24 * 60 * 60 * 1000;

export class InsufficientCreditsError extends Error {
  readonly code = "insufficient_credits";
  constructor(readonly requiredCents: bigint) {
    super(`Insufficient credits: this subscription costs $${(Number(requiredCents) / 100).toFixed(2)} per month.`);
    this.name = "InsufficientCreditsError";
  }
}

/** Subscribing was refused because someone else already holds the period. No charge was made. */
export class SubscriptionClaimLostError extends Error {
  readonly code = "subscription_claim_lost";
  constructor(message = "This subscription was just updated by another request. Refresh to see it.") {
    super(message);
    this.name = "SubscriptionClaimLostError";
  }
}

export type SubscriptionEndReason = "pricing_changed" | "listing_archived" | "use_ended" | "plan_ended";

export interface SubscriptionRow {
  id: string;
  listingId: string;
  subscriberId: string;
  status: string; // 'active' | 'past_due' | 'cancelled' | 'expired'
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /** The agreed monthly price; null only on rows from before it was stored. */
  priceCents?: bigint | null;
  endReason?: string | null;
  /**
   * The kind of the subscriber's licence (AgentInstall.kind): "use" when
   * the month pays for use of the creator's agent, "copy" for a copy.
   * Absent reads as a copy.
   */
  licenceKind?: string;
  /**
   * The marker of a plan (AgentSubscription.includedUses). Null or absent =
   * a month with no count, which is started and renewed exactly as before
   * plans existed. Set = the row is on a plan and carries the terms the
   * buyer agreed to.
   */
  includedUses?: number | null;
  /** The plan the row was started on. */
  planId?: string | null;
  /**
   * True when the creator has ended that plan (ListingPlan.status is
   * 'retired'). The row is not charged again: it ends with its paid period.
   */
  planRetired?: boolean;
}

/** Whether a row is on a plan: it carries a count of included uses. */
const onPlan = (sub: Pick<SubscriptionRow, "includedUses">): boolean =>
  sub.includedUses !== null && sub.includedUses !== undefined;

/** What a row that is not on a plan holds in the plan's columns. */
const NO_PLAN = {
  planId: null,
  includedUses: null,
  usedInPeriod: 0,
  carriedUses: 0,
  extraUsePriceCents: null,
  warnedLevel: 0,
} as const;

export interface ListingForBilling {
  id: string;
  title: string;
  publisherId: string;
  monthlyPriceCents: bigint;
  /** The listing's current model; renewal stops if it is no longer monthly. */
  pricingModel?: string;
  /** Renewal stops if the listing is no longer published. */
  status?: string;
  /** What the listing sells now: "use" or "copies". A use subscription stops renewing once it is not "use". */
  sells?: string;
  /**
   * The listing's pause marker (AgentListing.pausedSince). While it is set
   * the subscribers' clock is stopped: no subscription for use is renewed.
   */
  pausedSince?: Date | null;
}

/** With what moveEarnings needs: each period credits the publisher through the ledger. */
export interface SubscriptionTx extends EarningsLedgerTx {
  creditBalance: {
    updateMany(args: {
      where: { orgId: string; balanceCents: { gte: bigint } };
      data: { balanceCents: { decrement: bigint } };
    }): Promise<{ count: number }>;
    findUnique(args: { where: { orgId: string } }): Promise<{ balanceCents: bigint } | null>;
  };
  creditTransaction: {
    create(args: {
      data: {
        orgId: string;
        amountCents: bigint;
        type: string;
        description: string;
        referenceId: string;
        balanceAfter: bigint;
      };
    }): Promise<unknown>;
  };
  marketplaceRevenue: {
    create(args: {
      data: {
        listingId: string;
        installId?: string | null;
        subscriptionId: string;
        buyerId: string;
        publisherId: string;
        type: string;
        grossAmountCents: bigint;
        platformFeeCents: bigint;
        creatorAmountCents: bigint;
        status: string;
        settledAt: Date;
      };
    }): Promise<{ id: string }>;
  };
  agentSubscription: {
    findUnique(args: {
      where: { listingId_subscriberId: { listingId: string; subscriberId: string } };
      /** Only a plan start asks for it: whether the plan the row is on was ended by its creator. */
      include?: { plan: { select: { status: true } } };
    }): Promise<(SubscriptionRow & { plan?: { status: string } | null }) | null>;
    create(args: { data: Record<string, unknown> }): Promise<SubscriptionRow>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  agentInstall: {
    updateMany(args: {
      where: { listingId: string; buyerId: string; status?: string | { in: string[] } };
      data: { status: string };
    }): Promise<{ count: number }>;
  };
}

async function chargePeriod(
  tx: SubscriptionTx,
  args: {
    subscriptionId: string;
    listing: Pick<ListingForBilling, "id" | "title" | "publisherId">;
    buyerId: string;
    type: "subscription" | "subscription_renewal";
    installId?: string | null;
    priceCents: bigint;
    now: Date;
  },
): Promise<{ revenueId: string; grossCents: bigint }> {
  const price = args.priceCents;
  const debited = await tx.creditBalance.updateMany({
    where: { orgId: args.buyerId, balanceCents: { gte: price } },
    data: { balanceCents: { decrement: price } },
  });
  if (debited.count !== 1) throw new InsufficientCreditsError(price);

  const split = splitRevenue(price, 1);
  const revenue = await tx.marketplaceRevenue.create({
    data: {
      listingId: args.listing.id,
      installId: args.installId ?? null,
      subscriptionId: args.subscriptionId,
      buyerId: args.buyerId,
      publisherId: args.listing.publisherId,
      type: args.type,
      grossAmountCents: split.grossCents,
      platformFeeCents: split.platformFeeCents,
      creatorAmountCents: split.creatorCents,
      status: "settled",
      settledAt: args.now,
    },
  });
  // Accepted contributors are paid their shares; the publisher keeps the rest.
  const { publisherCents } = await splitCreatorRevenue(tx as unknown as Partial<ContributorSplitTx>, {
    revenueId: revenue.id,
    listingId: args.listing.id,
    publisherId: args.listing.publisherId,
    creatorCents: split.creatorCents,
  });
  const credited = await moveEarnings(tx, {
    orgId: args.listing.publisherId,
    amountCents: publisherCents,
    type: "subscription",
    referenceId: revenue.id,
    description: `${args.type === "subscription" ? "Subscription" : "Renewal"}: ${args.listing.title}`,
  });
  // Thrown, so the period's charge rolls back, as an update of a missing
  // profile did.
  if (!credited.moved) {
    throw new Error(`No publisher profile to credit a subscription to (organization ${args.listing.publisherId})`);
  }
  const after = await tx.creditBalance.findUnique({ where: { orgId: args.buyerId } });
  await tx.creditTransaction.create({
    data: {
      orgId: args.buyerId,
      amountCents: -price,
      type: "marketplace_subscription",
      description: `${args.type === "subscription" ? "Subscription" : "Renewal"}: ${args.listing.title}`,
      referenceId: revenue.id,
      balanceAfter: after?.balanceCents ?? 0n,
    },
  });
  return { revenueId: revenue.id, grossCents: split.grossCents };
}

/**
 * The exclusive claim a start needs before it charges: the buyer's
 * subscription row for the listing is created, or moved off the exact state
 * that was read. Throws SubscriptionClaimLostError when the row is already
 * paid up or another writer took it first; nothing has been charged then.
 *
 * `planStart` reads "paid up" the way a use on a plan does
 * (services/useAccess.ts): a row on a plan its creator ended has no days of
 * grace after its period. The buyer is told to choose again the moment that
 * period ends, and the renewal worker may not have closed the row yet, so
 * the start they then make must not be refused as "already paid up".
 */
async function claimForStart(
  tx: SubscriptionTx,
  key: { listingId: string; subscriberId: string },
  dataFor: (current: SubscriptionRow | null) => Record<string, unknown>,
  now: Date,
  planStart = false,
): Promise<SubscriptionRow> {
  // Charging needs an exclusive claim on the subscription row. An upsert
  // is not one: of two concurrent subscribes (or a subscribe racing the
  // renewal worker) both would succeed and both would charge.
  let current: SubscriptionRow | null;
  let paidUp: boolean;
  if (planStart) {
    const found = await tx.agentSubscription.findUnique({
      where: { listingId_subscriberId: key },
      include: { plan: { select: { status: true } } },
    });
    const { plan: itsPlan, ...row } = found ?? { plan: null };
    current = found ? (row as SubscriptionRow) : null;
    const planEnded = current !== null && onPlan(current) && itsPlan?.status === "retired";
    paidUp = subscriptionGrantsAccess(
      current && { ...current, cancelAtPeriodEnd: current.cancelAtPeriodEnd || planEnded },
      now,
    );
  } else {
    current = await tx.agentSubscription.findUnique({ where: { listingId_subscriberId: key } });
    paidUp = subscriptionGrantsAccess(current, now);
  }
  if (paidUp) {
    throw new SubscriptionClaimLostError("You already have a paid-up subscription to this agent.");
  }
  const data = dataFor(current);
  if (!current) {
    // The unique (listingId, subscriberId) makes a concurrent creator fail
    // here, which rolls its whole transaction back.
    return tx.agentSubscription.create({ data: { ...key, ...data } });
  }
  // Compare-and-swap on the state that was read. A row that grants no
  // access always leaves that state when it is claimed (the status or
  // the period end changes), so a second claim on the same read misses.
  const claimed = await tx.agentSubscription.updateMany({
    where: { id: current.id, status: current.status, currentPeriodEnd: current.currentPeriodEnd },
    data,
  });
  if (claimed.count !== 1) throw new SubscriptionClaimLostError();
  return { ...current, ...data } as SubscriptionRow;
}

/**
 * Run inside the install transaction. Throws InsufficientCreditsError, or
 * SubscriptionClaimLostError when the subscription is already paid up or
 * another writer took it first.
 */
export async function startMonthlySubscription(
  tx: SubscriptionTx,
  args: { listing: ListingForBilling; buyerId: string; installId?: string | null; now?: Date },
): Promise<{ subscription: SubscriptionRow; revenueId: string }> {
  if (args.listing.monthlyPriceCents <= 0n) {
    throw new Error("This listing has no monthly price set");
  }
  const now = args.now ?? new Date();
  const end = new Date(now.getTime() + SUBSCRIPTION_PERIOD_DAYS * DAY_MS);
  const period = {
    status: "active",
    currentPeriodStart: now,
    currentPeriodEnd: end,
    cancelAtPeriodEnd: false,
    cancelledAt: null,
    // The price the buyer agrees to now; renewals charge this.
    priceCents: args.listing.monthlyPriceCents,
    endReason: null,
    lastRenewalAttemptAt: null,
  };

  const subscription = await claimForStart(
    tx,
    { listingId: args.listing.id, subscriberId: args.buyerId },
    // A row that was on a plan and is started again as a plain month drops
    // the plan's terms and its count, or the month would be counted against
    // them. Every other row is written exactly what it always was.
    (current) => (current && onPlan(current) ? { ...period, ...NO_PLAN } : period),
    now,
  );

  const { revenueId } = await chargePeriod(tx, {
    subscriptionId: subscription.id,
    listing: args.listing,
    buyerId: args.buyerId,
    type: "subscription",
    installId: args.installId,
    priceCents: args.listing.monthlyPriceCents,
    now,
  });
  return { subscription, revenueId };
}

/** The terms of a plan as the buyer agreed to them. The subscription row keeps this copy. */
export interface PlanTerms {
  /** ListingPlan.id. */
  planId: string;
  /** The price of each 30 days. */
  priceCents: bigint;
  includedUses: number;
  /** What each use past the count costs. Null = the plan stops until it renews. */
  extraUsePriceCents: bigint | null;
}

/**
 * What a plan start needs besides a subscription's own tables: the buyer's
 * licence row. The shapes are the whole of what it may write there: that
 * the licence is for use, and nothing about pricing.
 */
export interface PlanStartTx extends SubscriptionTx {
  agentInstall: SubscriptionTx["agentInstall"] & {
    create(args: {
      data: { listingId: string; buyerId: string; clonedAgentId: null; kind: "use"; status: "active" };
    }): Promise<{ id: string }>;
    update(args: {
      where: { id: string };
      data:
        | { kind: "use" }
        // A licence that was for a copy: what it agreed to was for the copy.
        | { kind: "use"; acceptedPricingModel: null; acceptedPricePerRequestCents: null; pricingAcceptedAt: null };
    }): Promise<{ id: string; status: string }>;
  };
}

/**
 * Start a plan: write the buyer's licence, claim their subscription row
 * with a copy of the terms they agreed to and a count of zero, and charge
 * the full 30 days at once, on the path a monthly subscription takes (the
 * same split, the same ledger rows). Run inside the start's transaction,
 * after the licence row was claimed (claimLicence, services/marketplace.ts).
 * Throws InsufficientCreditsError, or SubscriptionClaimLostError when the
 * buyer already holds a paid-up subscription or another writer took the
 * row first. Either way the transaction rolls back whole.
 *
 * `plan` is what the buyer was shown and agreed to. The caller has already
 * compared it with the plan as it is now (services/listingPlans.ts) and
 * refused a difference: from here on these terms are the buyer's, whatever
 * the creator does to the plan.
 *
 * The licence is written here, and not by the caller, for one reason:
 * starting a plan is not an agreement to the listing's price per use
 * (services/useAccess.ts). So this never writes acceptedPricingModel or
 * acceptedPricePerRequestCents: a new licence has neither, and a licence
 * for use that already agreed to a price per use keeps that agreement as it
 * is. A plan start must not go through agreeToTerms and writeLicence, which
 * write both.
 *
 * A licence that was for a COPY is different: whatever it agreed to, it
 * agreed to for the copy, and holding a copy is not an agreement to pay for
 * use. Turned into a licence for use it would carry that agreement along,
 * and when the plan ended the buyer would be charged per use at a price
 * they never accepted for use. So its agreement is cleared here (the only
 * values the type allows are null), and after the plan the buyer chooses.
 *
 * The licence must be active once it is written. A licence the caller did
 * not claim (still removed, or stopped) would be charged a full 30 days and
 * read as no access, so that start throws before the row is claimed or
 * anything is charged.
 */
export async function startPlanSubscription(
  tx: PlanStartTx,
  args: {
    listing: Pick<ListingForBilling, "id" | "title" | "publisherId">;
    plan: PlanTerms;
    buyerId: string;
    /** The buyer's licence row for the listing, already claimed, with its kind as read; null when they have none yet. */
    licence: { id: string; kind: string } | null;
    now?: Date;
  },
): Promise<{ subscription: SubscriptionRow; revenueId: string; licenceId: string }> {
  const { plan } = args;
  // The route and the plan's own rules check these first. Held again where
  // the row is written: a count that is not a whole number above zero, or a
  // price of nothing, is never stored as somebody's terms.
  if (plan.priceCents <= 0n) throw new Error("This plan has no price set");
  if (!Number.isInteger(plan.includedUses) || plan.includedUses < 1) {
    throw new Error("This plan has no included uses");
  }
  if (plan.extraUsePriceCents !== null && plan.extraUsePriceCents <= 0n) {
    throw new Error("This plan's price for an extra use is not above zero");
  }
  const now = args.now ?? new Date();
  const end = new Date(now.getTime() + SUBSCRIPTION_PERIOD_DAYS * DAY_MS);

  let licence: { id: string };
  if (args.licence) {
    const written = await tx.agentInstall.update({
      where: { id: args.licence.id },
      data:
        args.licence.kind === "use"
          ? { kind: "use" }
          : { kind: "use", acceptedPricingModel: null, acceptedPricePerRequestCents: null, pricingAcceptedAt: null },
    });
    if (written.status !== "active") {
      throw new Error("A plan was started on a licence that is not active: nothing was charged");
    }
    licence = written;
  } else {
    licence = await tx.agentInstall.create({
      data: { listingId: args.listing.id, buyerId: args.buyerId, clonedAgentId: null, kind: "use", status: "active" },
    });
  }

  const subscription = await claimForStart(
    tx,
    { listingId: args.listing.id, subscriberId: args.buyerId },
    () => ({
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      // The price the buyer agrees to now; renewals charge this.
      priceCents: plan.priceCents,
      endReason: null,
      lastRenewalAttemptAt: null,
      // The copy of the terms, and a count that starts at zero.
      planId: plan.planId,
      includedUses: plan.includedUses,
      extraUsePriceCents: plan.extraUsePriceCents,
      usedInPeriod: 0,
      carriedUses: 0,
      warnedLevel: 0,
    }),
    now,
    true,
  );

  const { revenueId } = await chargePeriod(tx, {
    subscriptionId: subscription.id,
    listing: args.listing,
    buyerId: args.buyerId,
    type: "subscription",
    installId: licence.id,
    priceCents: plan.priceCents,
    now,
  });
  return { subscription, revenueId, licenceId: licence.id };
}

export type RenewalOutcome =
  | { kind: "renewed"; revenueId: string; newPeriodEnd: Date }
  | { kind: "cancelled" }
  /** A plan found too long past its end: closed, the licence suspended, nothing charged. */
  | { kind: "expired" }
  | { kind: "not_due" }
  | { kind: "lost_race" }
  /** The listing is paused: nothing was claimed, charged or closed. */
  | { kind: "paused" };

/**
 * Renew (or close) one due subscription. Run inside a transaction; when it
 * throws InsufficientCreditsError the caller rolls back and calls
 * markPastDueOrExpire in a fresh transaction.
 */
export async function renewSubscription(
  tx: SubscriptionTx,
  args: { sub: SubscriptionRow; listing: ListingForBilling; now?: Date },
): Promise<RenewalOutcome> {
  const now = args.now ?? new Date();
  const { sub } = args;

  // The listing is paused (services/listingPause.ts) and this month pays for
  // use of the creator's agent, which cannot answer. The subscribers' clock
  // is stopped, so nothing about the subscription moves: it is not charged,
  // not closed (even if use is no longer sold, or the buyer cancelled) and
  // not marked past due. It comes first for that reason, and it writes
  // nothing. When the pause ends the month is made longer and the row is
  // judged then. A copy runs in the buyer's own organization and is never
  // paused.
  if (sub.licenceKind === "use" && args.listing.pausedSince != null) return { kind: "paused" };

  if (sub.currentPeriodEnd > now) return { kind: "not_due" };

  // A month of USE of the creator's agent, and the listing no longer sells
  // use: it is not published, or it sells copies now. The month that was
  // paid for has ended (access ran to here: services/useAccess.ts checks a
  // paid month before the listing), and there is nothing left to charge
  // for, so it ends and is not renewed. The licence row is left as it is:
  // access is decided from the rows at each use, and the reason recorded
  // here means that selling use again cannot start charging this buyer
  // without their consent. A copy subscription never takes this branch.
  const sellsUse = args.listing.sells === undefined || args.listing.sells === "use";
  const published = args.listing.status === undefined || args.listing.status === "published";
  // A plan is uses of the creator's agent and nothing else. A plan row whose
  // licence is not for use has nothing it could be charged for, and ends
  // the same way.
  const plan = onPlan(sub);
  if ((sub.licenceKind === "use" && !(sellsUse && published)) || (plan && sub.licenceKind !== "use")) {
    const closed = await tx.agentSubscription.updateMany({
      where: { id: sub.id, currentPeriodEnd: sub.currentPeriodEnd, status: { in: ["active", "past_due"] } },
      data: { status: "cancelled", cancelledAt: now, endReason: "use_ended" },
    });
    return closed.count === 1 ? { kind: "cancelled" } : { kind: "lost_race" };
  }

  // The publisher archived the listing: the paid period ran its course and
  // nothing more is charged. An archived listing charges nobody, so the
  // install keeps running; the reason is recorded so that publishing the
  // listing again cannot start charging this buyer without their consent.
  if (args.listing.status !== undefined && args.listing.status !== "published") {
    const closed = await tx.agentSubscription.updateMany({
      where: { id: sub.id, currentPeriodEnd: sub.currentPeriodEnd, status: { in: ["active", "past_due"] } },
      data: { status: "cancelled", cancelledAt: now, endReason: "listing_archived" },
    });
    return closed.count === 1 ? { kind: "cancelled" } : { kind: "lost_race" };
  }

  // The listing left monthly pricing, or this row has no agreed price to
  // renew at (it predates priceCents and was never charged). The buyer
  // agreed to neither the new model nor the listing's current price, so
  // the subscription ends and the install is suspended until they accept.
  //
  // A plan is the other way round. It lives on a listing sold per request,
  // so "the listing is not monthly" is its normal state and never closes
  // it: what ends a plan here is the listing no longer being sold per
  // request.
  const soldAs = plan ? "per_request" : "monthly";
  const offMonthly = args.listing.pricingModel !== undefined && args.listing.pricingModel !== soldAs;
  if (offMonthly || sub.priceCents == null) {
    const closed = await tx.agentSubscription.updateMany({
      where: { id: sub.id, currentPeriodEnd: sub.currentPeriodEnd, status: { in: ["active", "past_due"] } },
      data: { status: "cancelled", cancelledAt: now, endReason: "pricing_changed" },
    });
    if (closed.count !== 1) return { kind: "lost_race" };
    await tx.agentInstall.updateMany({
      where: { listingId: sub.listingId, buyerId: sub.subscriberId, status: "active" },
      data: { status: "suspended" },
    });
    return { kind: "cancelled" };
  }

  // The buyer cancelled: close at period end. The CAS includes the flag,
  // so a resume that lands mid-tick is not closed.
  if (sub.cancelAtPeriodEnd) {
    const closed = await tx.agentSubscription.updateMany({
      where: {
        id: sub.id,
        currentPeriodEnd: sub.currentPeriodEnd,
        status: { in: ["active", "past_due"] },
        cancelAtPeriodEnd: true,
      },
      data: { status: "cancelled", cancelledAt: now },
    });
    if (closed.count !== 1) return { kind: "lost_race" };
    await tx.agentInstall.updateMany({
      where: { listingId: sub.listingId, buyerId: sub.subscriberId, status: "active" },
      data: { status: "suspended" },
    });
    return { kind: "cancelled" };
  }

  if (plan) {
    // The creator ended this plan. The buyer finishes the 30 days they paid
    // for and is not charged again. The licence is left as it is: a buyer
    // who agreed to a price per use themselves goes on at that price, and
    // everybody else is asked to choose (services/useAccess.ts).
    if (sub.planRetired === true) {
      const closed = await tx.agentSubscription.updateMany({
        where: { id: sub.id, currentPeriodEnd: sub.currentPeriodEnd, status: { in: ["active", "past_due"] } },
        data: { status: "cancelled", cancelledAt: now, endReason: "plan_ended" },
      });
      return closed.count === 1 ? { kind: "cancelled" } : { kind: "lost_race" };
    }
    // Found past its days of grace, by a worker that was away or a buyer
    // who could not pay until now. Renewing would charge for a period that
    // began days ago, so the row expires as an unpaid one does, uncharged.
    if (now.getTime() >= sub.currentPeriodEnd.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS) {
      const expired = await tx.agentSubscription.updateMany({
        where: { id: sub.id, currentPeriodEnd: sub.currentPeriodEnd, status: { in: ["active", "past_due"] } },
        data: { status: "expired" },
      });
      if (expired.count !== 1) return { kind: "lost_race" };
      await tx.agentInstall.updateMany({
        where: { listingId: sub.listingId, buyerId: sub.subscriberId, status: "active" },
        data: { status: "suspended" },
      });
      return { kind: "expired" };
    }
  }

  // Claim the period by advancing it; a concurrent tick's CAS then misses.
  const newEnd = new Date(sub.currentPeriodEnd.getTime() + SUBSCRIPTION_PERIOD_DAYS * DAY_MS);
  // The CAS also requires the subscription not to be set to cancel, so a
  // cancel that lands mid-tick is not charged. And, for a month of use, that
  // the listing's pause marker is still not set: the marker this row was
  // loaded with was read a moment ago, and a deployment stopped since then
  // must not be charged for. A claim that misses for that reason charges
  // nothing and reads as a lost race; the next tick loads the marker and
  // the row waits as paused.
  //
  // For a plan the claim also requires the plan to be one its creator has
  // not ended since the row was loaded, and it sets the count, the carried
  // uses and the warning back to zero in this one statement: the count of a
  // period is tied to currentPeriodStart (services/planUse.ts), so the two
  // must move together. Unused uses do not carry over. If the charge below
  // fails, the transaction rolls this back with it: the buyer keeps what
  // was left of the old count through the days of grace.
  const claimed = await tx.agentSubscription.updateMany({
    where: {
      id: sub.id,
      currentPeriodEnd: sub.currentPeriodEnd,
      status: { in: ["active", "past_due"] },
      cancelAtPeriodEnd: false,
      ...(sub.licenceKind === "use" ? { listing: { pausedSince: null } } : {}),
      ...(plan && sub.planId != null ? { plan: { status: "active" } } : {}),
    },
    data: {
      currentPeriodStart: sub.currentPeriodEnd,
      currentPeriodEnd: newEnd,
      status: "active",
      lastRenewalAttemptAt: null,
      ...(plan ? { usedInPeriod: 0, carriedUses: 0, warnedLevel: 0 } : {}),
    },
  });
  if (claimed.count !== 1) return { kind: "lost_race" };

  // Renew at the price the buyer agreed to, never the listing's current one.
  const { revenueId } = await chargePeriod(tx, {
    subscriptionId: sub.id,
    listing: args.listing,
    buyerId: sub.subscriberId,
    type: "subscription_renewal",
    priceCents: sub.priceCents,
    now,
  });
  // A lapsed install comes back once the renewal is paid.
  await tx.agentInstall.updateMany({
    where: { listingId: sub.listingId, buyerId: sub.subscriberId, status: "suspended" },
    data: { status: "active" },
  });
  return { kind: "renewed", revenueId, newPeriodEnd: newEnd };
}

/** After an unpaid renewal: past_due during grace, then expired + suspended. */
export async function markPastDueOrExpire(
  tx: Pick<SubscriptionTx, "agentSubscription" | "agentInstall">,
  args: { sub: SubscriptionRow; now?: Date },
): Promise<"past_due" | "expired" | "unchanged"> {
  const now = args.now ?? new Date();
  const graceEnds = new Date(args.sub.currentPeriodEnd.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS);
  if (now < graceEnds) {
    const r = await tx.agentSubscription.updateMany({
      where: { id: args.sub.id, currentPeriodEnd: args.sub.currentPeriodEnd, status: "active" },
      data: { status: "past_due" },
    });
    return r.count === 1 ? "past_due" : "unchanged";
  }
  const r = await tx.agentSubscription.updateMany({
    where: { id: args.sub.id, currentPeriodEnd: args.sub.currentPeriodEnd, status: { in: ["active", "past_due"] } },
    data: { status: "expired" },
  });
  if (r.count === 1) {
    await tx.agentInstall.updateMany({
      where: { listingId: args.sub.listingId, buyerId: args.sub.subscriberId, status: "active" },
      data: { status: "suspended" },
    });
    return "expired";
  }
  return "unchanged";
}
