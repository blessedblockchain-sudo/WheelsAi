/**
 * POST /api/billing/stripe/webhook
 *
 * Unauthenticated by design (Stripe calls it); every request must carry a
 * valid Stripe-Signature over the exact raw body, or it is refused. The
 * raw-body parser is scoped to this plugin only.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { getStripe } from "../services/stripe/stripeClient.js";
import { processStripeEvent, type StripeWebhookTx } from "../services/stripe/stripeWebhook.js";

export const stripeWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 1_048_576 }, (_req, body, done) =>
    done(null, body),
  );

  app.post("/webhook", async (request, reply) => {
    const stripe = getStripe();
    if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
      return reply.status(501).send({ error: "card_payments_not_configured" });
    }
    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string") {
      return reply.status(400).send({ error: "missing_signature" });
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(request.body as Buffer, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch {
      return reply.status(400).send({ error: "invalid_signature" });
    }

    const outcome = await prisma.$transaction((tx) =>
      processStripeEvent(tx as unknown as StripeWebhookTx, event as never, {
        proPriceId: env.STRIPE_PRO_PRICE_ID,
      }),
    );
    request.log.info({ eventId: event.id, type: event.type, outcome: outcome.kind }, "Stripe webhook processed");
    if (outcome.kind === "refund_clawed_back" && outcome.shortfallCents > 0n) {
      request.log.warn(
        { orgId: outcome.orgId, shortfallCents: Number(outcome.shortfallCents) },
        "Refund exceeded the remaining credit balance; shortfall not recovered",
      );
    }
    return reply.send({ received: true });
  });
};
