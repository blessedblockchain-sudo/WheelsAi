import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "development";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET ??= "12345678901234567890123456789012";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";

const Stripe = (await import("stripe")).default;
const { prisma } = await import("@wheelsai/db");
const Fastify = (await import("fastify")).default;
const { stripeWebhookRoutes } = await import("../routes/stripeWebhook.js");

async function app() {
  const a = Fastify();
  await a.register(stripeWebhookRoutes);
  return a;
}

const payload = JSON.stringify({
  id: "evt_route_1",
  type: "checkout.session.expired",
  created: 1_800_000_000,
  data: { object: { id: "cs_x", metadata: { kind: "credits" } } },
});

test("a correctly signed event is processed inside a transaction", async () => {
  const seen: string[] = [];
  const saved = (prisma as any).$transaction;
  (prisma as any).$transaction = async (fn: any) =>
    fn({
      stripeEvent: {
        findUnique: async () => null,
        create: async ({ data }: any) => void seen.push(data.id),
      },
      stripePurchase: { findUnique: async () => null, updateMany: async () => ({ count: 0 }) },
    });
  const a = await app();
  try {
    const header = new Stripe("sk_test_dummy", { apiVersion: "2023-10-16" }).webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_test_secret",
    });
    const res = await a.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "stripe-signature": header },
      payload,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(seen, ["evt_route_1"]);
  } finally {
    (prisma as any).$transaction = saved;
    await a.close();
  }
});

test("a forged or missing signature is refused before touching the database", async () => {
  let touched = false;
  const saved = (prisma as any).$transaction;
  (prisma as any).$transaction = async () => {
    touched = true;
  };
  const a = await app();
  try {
    const forged = new Stripe("sk_test_dummy", { apiVersion: "2023-10-16" }).webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_attacker",
    });
    const bad = await a.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json", "stripe-signature": forged },
      payload,
    });
    const missing = await a.inject({
      method: "POST",
      url: "/webhook",
      headers: { "content-type": "application/json" },
      payload,
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(missing.statusCode, 400);
    assert.equal(touched, false);
  } finally {
    (prisma as any).$transaction = saved;
    await a.close();
  }
});
