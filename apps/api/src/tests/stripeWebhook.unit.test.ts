import assert from "node:assert/strict";
import test from "node:test";
import { processStripeEvent, type StripeWebhookTx } from "../services/stripe/stripeWebhook.js";

function world() {
  const state = {
    events: new Set<string>(),
    purchases: [] as any[],
    subs: new Map<string, any>(),
    listings: [{ publisherId: "org1", priorityPlacement: false }] as any[],
    balance: new Map<string, bigint>(),
    ledger: [] as any[],
  };
  const tx: StripeWebhookTx = {
    stripeEvent: {
      findUnique: async ({ where }) => (state.events.has(where.id) ? { id: where.id } : null),
      create: async ({ data }) => void state.events.add(data.id),
    },
    stripePurchase: {
      findUnique: async ({ where }: any) =>
        state.purchases.find((p) =>
          "stripeSessionId" in where ? p.stripeSessionId === where.stripeSessionId : p.stripePaymentIntentId === where.stripePaymentIntentId,
        ) ?? null,
      create: async ({ data }) => {
        const row = { id: `p${state.purchases.length + 1}`, status: "created", refundedCents: 0n, ...data };
        state.purchases.push(row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const rows = state.purchases.filter(
          (p) =>
            (where.stripeSessionId === undefined || p.stripeSessionId === where.stripeSessionId) &&
            (where.id === undefined || p.id === where.id) &&
            (where.status === undefined || p.status === where.status) &&
            (where.refundedCents === undefined || p.refundedCents === where.refundedCents),
        );
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
    orgSubscription: {
      findUnique: async ({ where }: any) =>
        "orgId" in where
          ? state.subs.get(where.orgId) ?? null
          : [...state.subs.values()].find((s) => s.stripeCustomerId === where.stripeCustomerId) ?? null,
      upsert: async ({ where, create, update }) => {
        const cur = state.subs.get(where.orgId);
        state.subs.set(where.orgId, cur ? { ...cur, ...update } : { ...create });
      },
    },
    agentListing: {
      updateMany: async ({ where, data }) => {
        const rows = state.listings.filter((l) => l.publisherId === where.publisherId);
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
    creditBalance: {
      upsert: async ({ where, update, create }) => {
        const next = (state.balance.get(where.orgId) ?? 0n) + (state.balance.has(where.orgId) ? update.balanceCents.increment : create.balanceCents);
        state.balance.set(where.orgId, next);
        return { balanceCents: next };
      },
      update: async ({ where, data }) => {
        const next = (state.balance.get(where.orgId) ?? 0n) + data.balanceCents.increment;
        state.balance.set(where.orgId, next);
        return { balanceCents: next };
      },
      findUnique: async ({ where }) =>
        state.balance.has(where.orgId) ? { balanceCents: state.balance.get(where.orgId)! } : null,
      updateMany: async ({ where, data }) => {
        const cur = state.balance.get(where.orgId) ?? 0n;
        if (cur < where.balanceCents.gte) return { count: 0 };
        state.balance.set(where.orgId, cur - data.balanceCents.decrement);
        return { count: 1 };
      },
    },
    creditTransaction: { create: async ({ data }) => void state.ledger.push(data) },
  };
  return { state, tx };
}

let seq = 0;
const ev = (type: string, object: Record<string, any>, created = 1_800_000_000) => ({
  id: `evt_${++seq}`,
  type,
  created,
  data: { object },
});

const creditSession = (extra: Record<string, any> = {}) => ({
  id: "cs_1",
  payment_status: "paid",
  payment_intent: "pi_1",
  metadata: { kind: "credits", orgId: "org1", amountCents: "5000", bonusCents: "500" },
  ...extra,
});

test("a paid credit checkout grants amount + quoted bonus exactly once", async () => {
  const { state, tx } = world();
  await tx.stripePurchase.create({ data: { orgId: "org1", stripeSessionId: "cs_1", amountCents: 5000n, bonusCents: 500n } });
  const first = ev("checkout.session.completed", creditSession());
  const r1 = await processStripeEvent(tx, first);
  assert.equal(r1.kind, "credits_granted");
  assert.equal(state.balance.get("org1"), 5500n);
  // Same event redelivered.
  assert.deepEqual(await processStripeEvent(tx, first), { kind: "duplicate" });
  // A different event for the same session (e.g. async_payment_succeeded).
  const r3 = await processStripeEvent(tx, ev("checkout.session.async_payment_succeeded", creditSession()));
  assert.equal(r3.kind, "credits_already_granted");
  assert.equal(state.balance.get("org1"), 5500n);
  assert.deepEqual(state.ledger.map((l) => [l.type, l.amountCents]), [["purchase", 5000n], ["bonus", 500n]]);
  assert.equal(state.purchases[0].stripePaymentIntentId, "pi_1");
});

test("an unpaid (async) checkout grants nothing until the payment succeeds", async () => {
  const { state, tx } = world();
  await tx.stripePurchase.create({ data: { orgId: "org1", stripeSessionId: "cs_1", amountCents: 5000n, bonusCents: 0n } });
  const r = await processStripeEvent(tx, ev("checkout.session.completed", creditSession({ payment_status: "unpaid" })));
  assert.equal(r.kind, "ignored");
  assert.equal(state.balance.get("org1"), undefined);
  await processStripeEvent(tx, ev("checkout.session.async_payment_succeeded", creditSession()));
  assert.equal(state.balance.get("org1"), 5000n);
});

test("a missing purchase row is rebuilt from the session metadata", async () => {
  const { state, tx } = world();
  const r = await processStripeEvent(tx, ev("checkout.session.completed", creditSession()));
  assert.equal(r.kind, "credits_granted");
  assert.equal(state.purchases.length, 1);
  assert.equal(state.balance.get("org1"), 5500n);
});

test("expired and failed sessions close without granting", async () => {
  const { state, tx } = world();
  await tx.stripePurchase.create({ data: { orgId: "org1", stripeSessionId: "cs_1", amountCents: 5000n, bonusCents: 0n } });
  await processStripeEvent(tx, ev("checkout.session.expired", creditSession()));
  assert.equal(state.purchases[0].status, "expired");
  // A late "completed" for an expired row does not grant.
  const r = await processStripeEvent(tx, ev("checkout.session.completed", creditSession()));
  assert.equal(r.kind, "credits_already_granted");
  assert.equal(state.balance.get("org1"), undefined);
});

const proSub = (status: string, extra: Record<string, any> = {}) => ({
  id: "sub_1",
  customer: "cus_1",
  status,
  metadata: { orgId: "org1" },
  items: { data: [{ price: { id: "price_pro" } }] },
  current_period_end: 1_900_000_000,
  trial_end: status === "trialing" ? 1_801_209_600 : null,
  cancel_at_period_end: false,
  ...extra,
});

test("a Pro trial turns the plan on and ranks the org's listings first", async () => {
  const { state, tx } = world();
  const r = await processStripeEvent(tx, ev("customer.subscription.created", proSub("trialing")), { proPriceId: "price_pro" });
  assert.deepEqual(r, { kind: "subscription_updated", orgId: "org1", plan: "pro", status: "trialing" });
  assert.equal(state.subs.get("org1").stripeCustomerId, "cus_1");
  assert.ok(state.subs.get("org1").trialUsedAt instanceof Date);
  assert.equal(state.listings[0].priorityPlacement, true);
});

test("cancellation removes the paid features; stale events never overwrite newer ones", async () => {
  const { state, tx } = world();
  await processStripeEvent(tx, ev("customer.subscription.updated", proSub("active"), 1_800_000_100), { proPriceId: "price_pro" });
  await processStripeEvent(tx, ev("customer.subscription.deleted", proSub("canceled"), 1_800_000_200), { proPriceId: "price_pro" });
  assert.equal(state.subs.get("org1").status, "canceled");
  assert.equal(state.listings[0].priorityPlacement, false);
  const stale = await processStripeEvent(tx, ev("customer.subscription.updated", proSub("active"), 1_800_000_150), { proPriceId: "price_pro" });
  assert.equal(stale.kind, "subscription_stale");
  assert.equal(state.subs.get("org1").status, "canceled");
});

test("an operator-set Enterprise plan is never downgraded by Stripe events", async () => {
  const { state, tx } = world();
  state.subs.set("org1", { orgId: "org1", plan: "enterprise", status: "manual", lastStripeEventAt: null });
  await processStripeEvent(tx, ev("customer.subscription.deleted", proSub("canceled")), { proPriceId: "price_pro" });
  assert.equal(state.subs.get("org1").plan, "enterprise");
  assert.equal(state.subs.get("org1").status, "manual");
});

test("a full refund claws back purchase + bonus once; a second refund event changes nothing", async () => {
  const { state, tx } = world();
  await processStripeEvent(tx, ev("checkout.session.completed", creditSession()));
  const refund = { payment_intent: "pi_1", amount_refunded: 5000 };
  const r = await processStripeEvent(tx, ev("charge.refunded", refund));
  assert.deepEqual(r, { kind: "refund_clawed_back", orgId: "org1", clawedCents: 5500n, shortfallCents: 0n });
  assert.equal(state.balance.get("org1"), 0n);
  const again = await processStripeEvent(tx, ev("charge.refunded", refund));
  assert.equal(again.kind, "ignored");
});

test("a refund larger than the remaining balance never goes negative and reports the shortfall", async () => {
  const { state, tx } = world();
  await processStripeEvent(tx, ev("checkout.session.completed", creditSession()));
  state.balance.set("org1", 1000n); // most credits already spent
  const r = await processStripeEvent(tx, ev("charge.refunded", { payment_intent: "pi_1", amount_refunded: 5000 }));
  assert.deepEqual(r, { kind: "refund_clawed_back", orgId: "org1", clawedCents: 1000n, shortfallCents: 4500n });
  assert.equal(state.balance.get("org1"), 0n);
});

test("a partial refund claws back its proportional share, then the rest on the final refund", async () => {
  const { state, tx } = world();
  await processStripeEvent(tx, ev("checkout.session.completed", creditSession()));
  await processStripeEvent(tx, ev("charge.refunded", { payment_intent: "pi_1", amount_refunded: 2500 }));
  assert.equal(state.balance.get("org1"), 2750n);
  await processStripeEvent(tx, ev("charge.refunded", { payment_intent: "pi_1", amount_refunded: 5000 }));
  assert.equal(state.balance.get("org1"), 0n);
});
