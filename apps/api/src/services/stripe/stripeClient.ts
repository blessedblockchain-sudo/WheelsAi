import Stripe from "stripe";
import { env } from "../../config/env.js";

let client: Stripe | null = null;

/** The Stripe client, or null when card payments are not configured. */
export function getStripe(): Stripe | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  client ??= new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16", maxNetworkRetries: 2 });
  return client;
}

/** Card checkout needs both the API key and the webhook secret. */
export function isStripeCheckoutEnabled(): boolean {
  return !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET;
}

export function isProSubscriptionEnabled(): boolean {
  return isStripeCheckoutEnabled() && !!env.STRIPE_PRO_PRICE_ID;
}
