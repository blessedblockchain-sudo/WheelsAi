/**
 * Creating Stripe Checkout and Billing Portal sessions. Nothing here grants
 * credits or changes a plan: that happens only in the signature-verified
 * webhook (stripeWebhook.ts).
 */
import type Stripe from "stripe";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { bonusForAmount, validatePurchaseAmount } from "../creditPackages.js";
import { effectivePlan, PRO_TRIAL_DAYS } from "../plans.js";

export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

export async function createCreditCheckout(
  stripe: Stripe,
  args: { orgId: string; amountDollars: number; email?: string; successUrl: string; cancelUrl: string },
): Promise<{ url: string; purchaseId: string }> {
  const invalid = validatePurchaseAmount(args.amountDollars);
  if (invalid) throw new CheckoutError(invalid, 400, "invalid_amount");
  const amountCents = BigInt(Math.round(args.amountDollars * 100));
  const bonusCents = BigInt(bonusForAmount(args.amountDollars) * 100);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Number(amountCents),
          product_data: {
            name: `WheelsAI credits: $${args.amountDollars}`,
            ...(bonusCents > 0n
              ? { description: `Includes a $${Number(bonusCents) / 100} bonus` }
              : {}),
          },
        },
      },
    ],
    client_reference_id: args.orgId,
    ...(args.email ? { customer_email: args.email } : {}),
    // Enough for the webhook to rebuild the purchase if our insert below
    // never lands. The bonus is quoted now and honoured later.
    metadata: {
      kind: "credits",
      orgId: args.orgId,
      amountCents: amountCents.toString(),
      bonusCents: bonusCents.toString(),
    },
    payment_intent_data: { metadata: { kind: "credits", orgId: args.orgId } },
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  });
  if (!session.url) throw new CheckoutError("Stripe did not return a checkout URL", 502, "stripe_error");

  const purchase = await prisma.stripePurchase.create({
    data: { orgId: args.orgId, stripeSessionId: session.id, amountCents, bonusCents },
  });
  return { url: session.url, purchaseId: purchase.id };
}

async function ensureCustomer(stripe: Stripe, orgId: string, email?: string): Promise<string> {
  const existing = await prisma.orgSubscription.findUnique({ where: { orgId } });
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;
  const customer = await stripe.customers.create({
    ...(email ? { email } : {}),
    metadata: { orgId },
  });
  await prisma.orgSubscription.upsert({
    where: { orgId },
    create: { orgId, stripeCustomerId: customer.id },
    update: { stripeCustomerId: customer.id },
  });
  return customer.id;
}

export async function createProCheckout(
  stripe: Stripe,
  args: { orgId: string; email?: string; successUrl: string; cancelUrl: string },
): Promise<{ url: string; trialDays: number }> {
  if (!env.STRIPE_PRO_PRICE_ID) {
    throw new CheckoutError("The Pro plan is not available for purchase yet.", 501, "pro_not_configured");
  }
  const sub = await prisma.orgSubscription.findUnique({ where: { orgId: args.orgId } });
  const current = effectivePlan(sub);
  if (current !== "starter") {
    throw new CheckoutError(
      `This organization is already on the ${current} plan. Manage it from the billing portal.`,
      409,
      "already_subscribed",
    );
  }
  const customer = await ensureCustomer(stripe, args.orgId, args.email);
  const trialDays = sub?.trialUsedAt ? 0 : PRO_TRIAL_DAYS;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: args.orgId,
    line_items: [{ price: env.STRIPE_PRO_PRICE_ID, quantity: 1 }],
    subscription_data: {
      metadata: { orgId: args.orgId },
      ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
    },
    metadata: { kind: "subscription", orgId: args.orgId },
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  });
  if (!session.url) throw new CheckoutError("Stripe did not return a checkout URL", 502, "stripe_error");
  return { url: session.url, trialDays };
}

export async function createBillingPortal(
  stripe: Stripe,
  args: { orgId: string; returnUrl: string },
): Promise<{ url: string }> {
  const sub = await prisma.orgSubscription.findUnique({ where: { orgId: args.orgId } });
  if (!sub?.stripeCustomerId) {
    throw new CheckoutError("There is no subscription to manage yet.", 404, "no_customer");
  }
  const portal = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: args.returnUrl,
  });
  return { url: portal.url };
}
