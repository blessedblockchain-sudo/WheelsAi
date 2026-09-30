import assert from "node:assert/strict";
import test from "node:test";
import {
  holdInferenceCredits,
  releaseInferenceHold,
  settleInferenceHold,
  type InferenceHoldPrisma,
} from "../services/inferenceCreditHold.js";

// Launch review #10 / monetize P1-2: /v1 admitted any org with >= 10 cents,
// ran an unbounded request, then decremented unconditionally with a stale
// balanceAfter. These pin the hold -> settle/release contract.

function fakeDb(start: bigint) {
  const state = { balance: start, ledger: [] as any[] };
  const db: InferenceHoldPrisma = {
    creditBalance: {
      updateMany: async ({ where, data }) => {
        if (state.balance < where.balanceCents.gte) return { count: 0 };
        state.balance -= data.balanceCents.decrement;
        return { count: 1 };
      },
      update: async ({ data }) => {
        state.balance += data.balanceCents.increment;
        return { balanceCents: state.balance };
      },
      findUnique: async () => ({ balanceCents: state.balance }),
    },
    creditTransaction: {
      create: async ({ data }) => {
        state.ledger.push(data);
        return data;
      },
    },
  };
  return { db, state };
}

const base = { orgId: "o", requestId: "r", description: "Inference: d" };

test("insufficient balance: no debit, no ledger row", async () => {
  const { db, state } = fakeDb(5n);
  const res = await holdInferenceCredits(db, { ...base, holdCents: 9n });
  assert.deepEqual(res, { ok: false, reason: "insufficient_credits", requiredCents: 9n });
  assert.equal(state.balance, 5n);
  assert.equal(state.ledger.length, 0);
});

test("concurrent holds cannot jointly overdraw", async () => {
  const { db, state } = fakeDb(10n);
  const results = await Promise.all([
    holdInferenceCredits(db, { ...base, holdCents: 6n }),
    holdInferenceCredits(db, { ...base, holdCents: 6n }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(state.balance, 4n);
});

test("settle under the hold releases the difference; ledger nets to the actual cost", async () => {
  const { db, state } = fakeDb(100n);
  await holdInferenceCredits(db, { ...base, holdCents: 30n });
  const res = await settleInferenceHold(db, { ...base, heldCents: 30n, actualCents: 7n });
  assert.deepEqual(res, { chargedCents: 7n, shortfallCents: 0n });
  assert.equal(state.balance, 93n);
  const net = state.ledger.reduce((a, r) => a + r.amountCents, 0n);
  assert.equal(net, -7n);
  assert.deepEqual(state.ledger.map((r) => r.balanceAfter), [70n, 93n]);
});

test("settle above the hold charges the extra only when covered", async () => {
  const { db, state } = fakeDb(40n);
  await holdInferenceCredits(db, { ...base, holdCents: 30n });
  const res = await settleInferenceHold(db, { ...base, heldCents: 30n, actualCents: 35n });
  assert.deepEqual(res, { chargedCents: 35n, shortfallCents: 0n });
  assert.equal(state.balance, 5n);
});

test("settle above the hold never drives the balance negative", async () => {
  const { db, state } = fakeDb(30n);
  await holdInferenceCredits(db, { ...base, holdCents: 30n });
  const res = await settleInferenceHold(db, { ...base, heldCents: 30n, actualCents: 45n });
  assert.deepEqual(res, { chargedCents: 30n, shortfallCents: 15n });
  assert.equal(state.balance, 0n);
});

test("a request that never reached a node is fully released", async () => {
  const { db, state } = fakeDb(50n);
  await holdInferenceCredits(db, { ...base, holdCents: 20n });
  await releaseInferenceHold(db, { orgId: "o", heldCents: 20n, requestId: "r", reason: "no healthy node" });
  assert.equal(state.balance, 50n);
  assert.equal(state.ledger.length, 2);
  assert.equal(state.ledger[1].type, "usage_release");
});

test("a zero-cost hold still holds at least one cent", async () => {
  const { db, state } = fakeDb(10n);
  const res = await holdInferenceCredits(db, { ...base, holdCents: 0n });
  assert.deepEqual(res, { ok: true, heldCents: 1n });
  assert.equal(state.balance, 9n);
});

// Route wiring: the hold is taken before any GPU work and given back when
// the request never reaches a node.
async function v1App(p: any) {
  process.env.NODE_ENV ??= "development";
  process.env.LOG_LEVEL ??= "error";
  process.env.DATABASE_URL ??= "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET ??= "12345678901234567890123456789012";
  const { prisma } = await import("@wheelsai/db");
  const saved: Record<string, unknown> = {};
  for (const k of Object.keys(p)) {
    saved[k] = (prisma as any)[k];
    (prisma as any)[k] = p[k];
  }
  const Fastify = (await import("fastify")).default;
  const sensible = await import("@fastify/sensible");
  const { createInferenceRoutes } = await import("../routes/inference.js");
  const { globalErrorHandler } = await import("../lib/errorHandler.js");
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(sensible.default);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = { userId: "u", orgId: "org-1", type: "jwt", role: "owner" };
  });
  await app.register(createInferenceRoutes());
  return {
    app,
    restore: async () => {
      await app.close();
      const { disconnectTokenGateCache } = await import("../middleware/tokenGate.js");
      disconnectTokenGateCache();
      Object.assign(prisma as any, saved);
    },
  };
}

function routeDb(start: bigint, nodes: unknown[], pricingTier = "small") {
  const { db, state } = fakeDb(start);
  return {
    state,
    p: {
      deployment: {
        findFirst: async () => ({
          id: "dep-1",
          name: "d",
          slug: "d",
          gpuTier: "3060",
          model: { pricingTier },
          nodes,
        }),
      },
      agentDeployment: { findFirst: async () => null },
      creditBalance: { ...db.creditBalance },
      creditTransaction: db.creditTransaction,
      deploymentNode: { update: async () => ({}) },
      $transaction: async (fn: any) => fn(db),
    },
  };
}

test("/v1 refuses with 402 when the worst-case hold is not covered", async () => {
  // Passes the old 10-cent admission check, but a ~500k-character prompt
  // on the large tier costs well over 10 cents.
  const { p, state } = routeDb(12n, [], "large");
  const { app, restore } = await v1App(p);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/v1/d/chat/completions",
      payload: { messages: [{ role: "user", content: "x".repeat(500_000) }], max_tokens: 8192 },
    });
    assert.equal(res.statusCode, 402);
    assert.equal(state.balance, 12n);
    assert.equal(state.ledger.length, 0);
  } finally {
    await restore();
  }
});

test("/v1 rejects an unbounded max_tokens", async () => {
  const { p } = routeDb(10_000n, []);
  const { app, restore } = await v1App(p);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/v1/d/chat/completions",
      payload: { messages: [{ role: "user", content: "hi" }], max_tokens: 1_000_000 },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await restore();
  }
});

test("/v1 with no healthy node releases the whole hold", async () => {
  const { p, state } = routeDb(1_000n, []);
  const { app, restore } = await v1App(p);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/v1/d/chat/completions",
      payload: { messages: [{ role: "user", content: "hello" }] },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(state.balance, 1_000n);
    assert.deepEqual(state.ledger.map((r: any) => r.type), ["usage", "usage_release"]);
  } finally {
    await restore();
  }
});
