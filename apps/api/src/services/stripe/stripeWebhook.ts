/**
 * Stripe webhook processing: the only place card payments turn into
 * credits or plan changes.
 *
 * - Each Stripe event id is processed at most once (StripeEvent row written
 *   in the same transaction as the effect; a duplicate delivery hits the
 *   primary key and changes nothing).
 * - A credit purchase is granted exactly once: compare-and-swap on the
 *   StripePurchase row (created -> completed) and grantCredits in the same
 *   transaction. The bonus is the one quoted at checkout.
 * - Subscription events set the org's plan; an older event never overwrites
 *   a newer one (lastStripeEventAt).
 * - Refunds claw back the credits they paid for, never driving the balance
 *   below zero (a shortfall is reported, not hidden).
 *
 * Pure over an injected transaction surface so it is testable without
 * Stripe or a database.
 */
import { grantCredits, type CreditGrantTxClient } from "../creditGrant.js";

export interface StripeEventLike {
  id: string;
  type: string;
  created: number; // unix seconds
  data: { object: Record<string, any> };
}

interface PurchaseRow {
  id: string;
  orgId: string;
  amountCents: bigint;
  bonusCents: bigint;
  status: string;
  refundedCents: bigint;
}

interface SubscriptionRow {
  orgId: string;
  plan: string;
  status: string;
  lastStripeEventAt: Date | null;
  trialUsedAt: Date | null;
}

export interface StripeWebhookTx extends CreditGrantTxClient {
  stripeEvent: {
    findUnique(args: { where: { id: string } }): Promise<{ id: string } | null>;
    create(args: { data: { id: string; type: string } }): Promise<unknown>;
  };
  stripePurchase: {
    findUnique(args: {
      where: { stripeSessionId: string } | { stripePaymentIntentId: string };
    }): Promise<PurchaseRow | null>;
    create(args: {
      data: { orgId: string; stripeSessionId: string; amountCents: bigint; bonusCents: bigint };
    }): Promise<PurchaseRow>;
    updateMany(args: {
      where: { stripeSessionId?: string; id?: string; status?: string; refundedCents?: bigint };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  orgSubscription: {
    findUnique(args: {
      where: { orgId: string } | { stripeCustomerId: string };
    }): Promise<SubscriptionRow | null>;
    upsert(args: {
      where: { orgId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
  agentListing: {
    updateMany(args: {
      where: { publisherId: string };
      data: { priorityPlacement: boolean };
    }): Promise<{ count: number }>;
  };
  creditBalance: CreditGrantTxClient["creditBalance"] & {
    findUnique(args: { where: { orgId: string } }): Promise<{ balanceCents: bigint } | null>;
    updateMany(args: {
      where: { orgId: string; balanceCents: { gte: bigint } };
      data: { balanceCents: { decrement: bigint } };
    }): Promise<{ count: number }>;
  };
}

export interface StripeWebhookConfig {
  proPriceId?: string;
}

export type WebhookOutcome =
  | { kind: "duplicate" }
  | { kind: "ignored"; reason: string }
  | { kind: "credits_granted"; purchaseId: string; orgId: string; grantedCents: bigint }
  | { kind: "credits_already_granted"; purchaseId: string }
  | { kind: "purchase_closed"; purchaseId: string | null; status: string }
  | { kind: "subscription_updated"; orgId: string; plan: string; status: string }
  | { kind: "subscription_stale"; orgId: string }
  | { kind: "refund_clawed_back"; orgId: string; clawedCents: bigint; shortfallCents: bigint };

const PAID_PLANS = new Set(["pro", "enterprise"]);
const ENTITLED = new Set(["trialing", "active", "past_due", "manual"]);

async function completeCreditPurchase(
  tx: StripeWebhookTx,
  session: Record<string, any>,
): Promise<WebhookOutcome> {
  const sessionId: string = session.id;
  let row = await tx.stripePurchase.findUnique({ where: { stripeSessionId: sessionId } });
  if (!row) {
    // The session exists at Stripe but our row was never written (crash
    // between session creation and insert): rebuild it from the metadata
    // we attached at checkout.
    const meta = session.metadata ?? {};
    if (!meta.orgId || !meta.amountCents) {
      return { kind: "ignored", reason: "credit session without purchase metadata" };
    }
    row = await tx.stripePurchase.create({
      data: {
        orgId: meta.orgId,
        stripeSessionId: sessionId,
        amountCents: BigInt(meta.amountCents),
        bonusCents: BigInt(meta.bonusCents ?? 0),
      },
    });
  }
  const paymentIntent =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  const claimed = await tx.stripePurchase.updateMany({
    where: { stripeSessionId: sessionId, status: "created" },
    data: {
      status: "completed",
      completedAt: new Date(),
      ...(paymentIntent ? { stripePaymentIntentId: paymentIntent } : {}),
    },
  });
  if (claimed.count !== 1) return { kind: "credits_already_granted", purchaseId: row.id };

  await grantCredits(tx, {
    orgId: row.orgId,
    amountCents: row.amountCents,
    bonusCents: row.bonusCents,
    referenceId: row.id,
    description: `Card purchase: $${(Number(row.amountCents) / 100).toFixed(2)}`,
  });
  return {
    kind: "credits_granted",
    purchaseId: row.id,
    orgId: row.orgId,
    grantedCents: row.amountCents + row.bonusCents,
  };
}

async function closeCreditPurchase(
  tx: StripeWebhookTx,
  session: Record<string, any>,
  status: "failed" | "expired",
): Promise<WebhookOutcome> {
  const row = await tx.stripePurchase.findUnique({ where: { stripeSessionId: session.id } });
  await tx.stripePurchase.updateMany({
    where: { stripeSessionId: session.id, status: "created" },
    data: { status, failureReason: status === "failed" ? "async payment failed" : "checkout expired" },
  });
  return { kind: "purchase_closed", purchaseId: row?.id ?? null, status };
}

async function resolveSubscriptionOrg(
  tx: StripeWebhookTx,
  sub: Record<string, any>,
): Promise<string | null> {
  if (sub.metadata?.orgId) return sub.metadata.orgId as string;
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (!customer) return null;
  const row = await tx.orgSubscription.findUnique({ where: { stripeCustomerId: customer } });
  return row?.orgId ?? null;
}

async function applySubscription(
  tx: StripeWebhookTx,
  event: StripeEventLike,
  cfg: StripeWebhookConfig,
): Promise<WebhookOutcome> {
  const sub = event.data.object;
  const orgId = await resolveSubscriptionOrg(tx, sub);
  if (!orgId) return { kind: "ignored", reason: "subscription for an unknown customer" };

  const existing = await tx.orgSubscription.findUnique({ where: { orgId } });
  const eventAt = new Date(event.created * 1000);
  if (existing?.lastStripeEventAt && existing.lastStripeEventAt > eventAt) {
    return { kind: "subscription_stale", orgId };
  }

  const priceIds: string[] = (sub.items?.data ?? []).map((i: any) => i?.price?.id).filter(Boolean);
  const isPro = !!cfg.proPriceId && priceIds.includes(cfg.proPriceId);
  // Enterprise is operator-set; a Stripe event never downgrades it.
  const plan = existing?.plan === "enterprise" ? "enterprise" : isPro ? "pro" : existing?.plan ?? "starter";
  const status = event.type === "customer.subscription.deleted" ? "canceled" : String(sub.status);
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  const fields = {
    plan,
    status: plan === "enterprise" ? "manual" : status,
    stripeSubscriptionId: sub.id as string,
    ...(customer ? { stripeCustomerId: customer } : {}),
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
    trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    lastStripeEventAt: eventAt,
    ...(sub.trial_end && !existing?.trialUsedAt ? { trialUsedAt: eventAt } : {}),
  };
  await tx.orgSubscription.upsert({
    where: { orgId },
    create: { orgId, ...fields },
    update: fields,
  });

  const entitled = PAID_PLANS.has(plan) && ENTITLED.has(fields.status);
  await tx.agentListing.updateMany({
    where: { publisherId: orgId },
    data: { priorityPlacement: entitled },
  });
  return { kind: "subscription_updated", orgId, plan, status: fields.status };
}

async function clawBackRefund(
  tx: StripeWebhookTx,
  charge: Record<string, any>,
): Promise<WebhookOutcome> {
  const paymentIntent =
    typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!paymentIntent) return { kind: "ignored", reason: "refund without a payment intent" };
  const row = await tx.stripePurchase.findUnique({ where: { stripePaymentIntentId: paymentIntent } });
  if (!row || row.status !== "completed") return { kind: "ignored", reason: "refund for an unknown purchase" };

  // Credits granted for the refunded share of the payment, bonus included
  // proportionally. amount_refunded is cumulative across partial refunds.
  const granted = row.amountCents + row.bonusCents;
  const refundedPaid = BigInt(Math.min(Number(charge.amount_refunded ?? 0), Number(row.amountCents)));
  const owed = row.amountCents > 0n ? (refundedPaid * granted) / row.amountCents : 0n;
  const toClaw = owed - row.refundedCents;
  if (toClaw <= 0n) return { kind: "ignored", reason: "refund already clawed back" };

  const advanced = await tx.stripePurchase.updateMany({
    where: { id: row.id, refundedCents: row.refundedCents },
    data: { refundedCents: owed },
  });
  if (advanced.count !== 1) return { kind: "ignored", reason: "concurrent refund processing" };

  const balance = await tx.creditBalance.findUnique({ where: { orgId: row.orgId } });
  const available = balance?.balanceCents ?? 0n;
  const clawed = toClaw <= available ? toClaw : available;
  if (clawed > 0n) {
    const done = await tx.creditBalance.updateMany({
      where: { orgId: row.orgId, balanceCents: { gte: clawed } },
      data: { balanceCents: { decrement: clawed } },
    });
    if (done.count === 1) {
      const after = await tx.creditBalance.findUnique({ where: { orgId: row.orgId } });
      await tx.creditTransaction.create({
        data: {
          orgId: row.orgId,
          amountCents: -clawed,
          type: "refund",
          description: "Card refund: credits reversed",
          referenceId: row.id,
          balanceAfter: after?.balanceCents ?? 0n,
        },
      });
    }
  }
  return { kind: "refund_clawed_back", orgId: row.orgId, clawedCents: clawed, shortfallCents: toClaw - clawed };
}

/** Run inside prisma.$transaction. */
export async function processStripeEvent(
  tx: StripeWebhookTx,
  event: StripeEventLike,
  cfg: StripeWebhookConfig = {},
): Promise<WebhookOutcome> {
  // Check first: in Postgres a unique violation aborts the transaction, so
  // it cannot be caught and continued. Two truly concurrent deliveries of
  // the same event: the loser's insert fails, its transaction rolls back,
  // the route answers 500 and Stripe retries into the "duplicate" branch.
  if (await tx.stripeEvent.findUnique({ where: { id: event.id } })) return { kind: "duplicate" };
  await tx.stripeEvent.create({ data: { id: event.id, type: event.type } });

  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
      if (obj.metadata?.kind === "credits") {
        return obj.payment_status === "paid"
          ? completeCreditPurchase(tx, obj)
          : { kind: "ignored", reason: "awaiting async payment" };
      }
      return { kind: "ignored", reason: "non-credit session (subscription events carry the plan)" };
    case "checkout.session.async_payment_succeeded":
      return obj.metadata?.kind === "credits"
        ? completeCreditPurchase(tx, obj)
        : { kind: "ignored", reason: "non-credit session" };
    case "checkout.session.async_payment_failed":
      return closeCreditPurchase(tx, obj, "failed");
    case "checkout.session.expired":
      return closeCreditPurchase(tx, obj, "expired");
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return applySubscription(tx, event, cfg);
    case "charge.refunded":
      return clawBackRefund(tx, obj);
    default:
      return { kind: "ignored", reason: `unhandled event ${event.type}` };
  }
}
