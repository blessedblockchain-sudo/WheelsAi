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
 *
 * Access for a monthly install = subscription active or past_due within
 * grace (see subscriptionGrantsAccess), enforced by resolveInstallBilling.
 *
 * Pure over an injected transaction surface.
 */
import { splitRevenue } from "./marketplaceMetering.js";
import { splitCreatorRevenue, type ContributorSplitTx } from "./contributorSplits.js";
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

export type SubscriptionEndReason = "pricing_changed" | "listing_archived";

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
}

export interface ListingForBilling {
  id: string;
  title: string;
  publisherId: string;
  monthlyPriceCents: bigint;
  /** The listing's current model; renewal stops if it is no longer monthly. */
  pricingModel?: string;
  /** Renewal stops if the listing is no longer published. */
  status?: string;
}

export interface SubscriptionTx {
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
  publisherProfile: {
    update(args: {
      where: { orgId: string };
      data: {
        totalRevenueCents: { increment: bigint };
        pendingPayoutCents: { increment: bigint };
      };
    }): Promise<unknown>;
  };
  agentSubscription: {
    findUnique(args: {
      where: { listingId_subscriberId: { listingId: string; subscriberId: string } };
    }): Promise<SubscriptionRow | null>;
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
    listing: ListingForBilling;
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
  await tx.publisherProfile.update({
    where: { orgId: args.listing.publisherId },
    data: {
      totalRevenueCents: { increment: publisherCents },
      pendingPayoutCents: { increment: publisherCents },
    },
  });
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

  // Charging needs an exclusive claim on the subscription row. An upsert
  // is not one: of two concurrent subscribes (or a subscribe racing the
  // renewal worker) both would succeed and both would charge.
  const key = { listingId: args.listing.id, subscriberId: args.buyerId };
  const current = await tx.agentSubscription.findUnique({ where: { listingId_subscriberId: key } });
  if (subscriptionGrantsAccess(current, now)) {
    throw new SubscriptionClaimLostError("You already have a paid-up subscription to this agent.");
  }
  let subscription: SubscriptionRow;
  if (!current) {
    // The unique (listingId, subscriberId) makes a concurrent creator fail
    // here, which rolls its whole transaction back.
    subscription = await tx.agentSubscription.create({ data: { ...key, ...period } });
  } else {
    // Compare-and-swap on the state that was read. A row that grants no
    // access always leaves that state when it is claimed (the status or
    // the period end changes), so a second claim on the same read misses.
    const claimed = await tx.agentSubscription.updateMany({
      where: { id: current.id, status: current.status, currentPeriodEnd: current.currentPeriodEnd },
      data: period,
    });
    if (claimed.count !== 1) throw new SubscriptionClaimLostError();
    subscription = { ...current, ...period };
  }

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

export type RenewalOutcome =
  | { kind: "renewed"; revenueId: string; newPeriodEnd: Date }
  | { kind: "cancelled" }
  | { kind: "not_due" }
  | { kind: "lost_race" };

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
  if (sub.currentPeriodEnd > now) return { kind: "not_due" };

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
  const offMonthly = args.listing.pricingModel !== undefined && args.listing.pricingModel !== "monthly";
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

  // Claim the period by advancing it; a concurrent tick's CAS then misses.
  const newEnd = new Date(sub.currentPeriodEnd.getTime() + SUBSCRIPTION_PERIOD_DAYS * DAY_MS);
  // The CAS also requires the subscription not to be set to cancel, so a
  // cancel that lands mid-tick is not charged.
  const claimed = await tx.agentSubscription.updateMany({
    where: {
      id: sub.id,
      currentPeriodEnd: sub.currentPeriodEnd,
      status: { in: ["active", "past_due"] },
      cancelAtPeriodEnd: false,
    },
    data: {
      currentPeriodStart: sub.currentPeriodEnd,
      currentPeriodEnd: newEnd,
      status: "active",
      lastRenewalAttemptAt: null,
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
