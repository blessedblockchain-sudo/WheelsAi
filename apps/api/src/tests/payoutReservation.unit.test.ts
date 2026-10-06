import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "development";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET ??= "12345678901234567890123456789012";

// Launch review #25 (P0): requestPayout checked for an open payout OUTSIDE
// the transaction and decremented pendingPayoutCents unconditionally, so two
// concurrent requests could both reserve the full balance (negative balance,
// two payable rows). The reservation is now a conditional decrement.

const ORG = "7f5c1d9e-2a3b-4c5d-8e9f-0a1b2c3d4e5f";

function installFakeDb(prisma: any, startBalance: bigint) {
  const state = { balance: startBalance, payouts: [] as any[] };
  prisma.publisherProfile = {
    // Snapshot read: both racing requests see the same starting balance.
    findUnique: async () => ({ orgId: ORG, pendingPayoutCents: startBalance }),
  };
  prisma.creatorPayout = {
    // Neither racer sees the other's uncommitted row.
    findFirst: async () => null,
  };
  // Serialise transactions the way row locks do: the second writer runs
  // against the first writer's committed state.
  let chain: Promise<unknown> = Promise.resolve();
  prisma.$transaction = (fn: (tx: any) => Promise<unknown>) => {
    const run = chain.then(() => {
      const draft = { balance: state.balance, payouts: [...state.payouts] };
      const tx = {
        publisherProfile: {
          updateMany: async ({ where, data }: any) => {
            if (where.orgId !== ORG || draft.balance < where.pendingPayoutCents.gte) {
              return { count: 0 };
            }
            draft.balance -= data.pendingPayoutCents.decrement;
            return { count: 1 };
          },
          update: async () => {
            throw new Error("unconditional update must not be used for the reservation");
          },
        },
        creatorPayout: {
          create: async ({ data }: any) => {
            const row = { id: `p${draft.payouts.length + 1}`, requestedAt: new Date(), ...data };
            draft.payouts.push(row);
            return row;
          },
        },
      };
      return fn(tx).then((result) => {
        state.balance = draft.balance; // commit
        state.payouts = draft.payouts;
        return result;
      });
    });
    chain = run.catch(() => undefined);
    return run;
  };
  return state;
}

test("two concurrent payout requests: exactly one reserves, balance never negative", async () => {
  const { prisma } = await import("@wheelsai/db");
  const saved = {
    publisherProfile: (prisma as any).publisherProfile,
    creatorPayout: (prisma as any).creatorPayout,
    $transaction: (prisma as any).$transaction,
  };
  const state = installFakeDb(prisma, 2500n);
  try {
    const { requestPayout, PayoutReservationConflictError } = await import(
      "../services/marketplace.js"
    );
    const results = await Promise.allSettled([
      requestPayout(ORG, "credits"),
      requestPayout(ORG, "credits"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1);
    assert.equal(failed.length, 1);
    assert.ok(failed[0]!.reason instanceof PayoutReservationConflictError);
    assert.equal(state.balance, 0n);
    assert.equal(state.payouts.length, 1);
    assert.equal(state.payouts[0].amountCents, 2500n);
  } finally {
    Object.assign(prisma as any, saved);
  }
});

test("a reservation that loses the race writes no payout row", async () => {
  const { prisma } = await import("@wheelsai/db");
  const saved = {
    publisherProfile: (prisma as any).publisherProfile,
    creatorPayout: (prisma as any).creatorPayout,
    $transaction: (prisma as any).$transaction,
  };
  // Snapshot says 2500 but the committed balance already dropped to 900.
  const state = installFakeDb(prisma, 2500n);
  state.balance = 900n;
  try {
    const { requestPayout, PayoutReservationConflictError } = await import(
      "../services/marketplace.js"
    );
    await assert.rejects(requestPayout(ORG, "credits"), PayoutReservationConflictError);
    assert.equal(state.balance, 900n);
    assert.equal(state.payouts.length, 0);
  } finally {
    Object.assign(prisma as any, saved);
  }
});

// Payouts carry a caller-supplied address, and API keys bypass requireRole,
// so an org API key could redirect a creator's earnings. The route now
// requires a human (JWT) session.
async function marketplaceAppAs(principal: Record<string, unknown>) {
  const Fastify = (await import("fastify")).default;
  const sensible = await import("@fastify/sensible");
  const { marketplaceRoutes } = await import("../routes/marketplace.js");
  const app = Fastify();
  await app.register(sensible.default);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { auth: unknown }).auth = principal;
  });
  await app.register(marketplaceRoutes);
  return app;
}

test("an API key cannot request a payout, even with org authority", async () => {
  const { prisma } = await import("@wheelsai/db");
  const savedProfile = (prisma as any).publisherProfile;
  let touched = false;
  (prisma as any).publisherProfile = {
    findUnique: async () => {
      touched = true;
      return null;
    },
  };
  try {
    const app = await marketplaceAppAs({ userId: null, orgId: ORG, type: "api_key", scopes: ["*"] });
    const res = await app.inject({
      method: "POST",
      url: "/payouts",
      payload: { payoutMethod: "crypto_sol", payoutAddress: "AttackerWa11et1111111111111111111111111111" },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(touched, false, "the payout service must not run for an API key");
  } finally {
    (prisma as any).publisherProfile = savedProfile;
  }
});

// requireRole decides on the OrgMember row as it is now, so each case states
// what the database holds, which may differ from the token's role claim.
async function payoutAs(tokenRole: string, currentRole: string | null) {
  const { prisma } = await import("@wheelsai/db");
  const p = prisma as any;
  const savedMember = p.orgMember.findUnique;
  const savedProfile = p.publisherProfile;
  let touched = false;
  p.orgMember.findUnique = async () => (currentRole ? { role: currentRole } : null);
  p.publisherProfile = {
    findUnique: async () => {
      touched = true;
      return null;
    },
  };
  const app = await marketplaceAppAs({ userId: "u1", orgId: ORG, type: "jwt", role: tokenRole });
  try {
    const res = await app.inject({ method: "POST", url: "/payouts", payload: { payoutMethod: "credits" } });
    return { res, touched };
  } finally {
    p.orgMember.findUnique = savedMember;
    p.publisherProfile = savedProfile;
    await app.close();
  }
}

test("a JWT member (not owner/admin) is still refused", async () => {
  const { res, touched } = await payoutAs("member", "member");
  assert.equal(res.statusCode, 403);
  assert.equal(touched, false);
});

test("an admin demoted to member cannot request a payout on the old admin token", async () => {
  const { res, touched } = await payoutAs("admin", "member");
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "insufficient_role");
  assert.equal(touched, false, "the payout service must not run for a demoted admin");
});

test("an admin removed from the org cannot request a payout on the old admin token", async () => {
  const { res, touched } = await payoutAs("admin", null);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "not_a_member");
  assert.equal(touched, false, "the payout service must not run for a removed member");
});
