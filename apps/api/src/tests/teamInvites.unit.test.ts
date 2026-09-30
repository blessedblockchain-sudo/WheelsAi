import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "development";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET ??= "12345678901234567890123456789012";

const { prisma } = await import("@wheelsai/db");
const p = prisma as any;

function stub(models: Record<string, unknown>) {
  const saved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(models)) {
    saved[k] = p[k];
    p[k] = v;
  }
  return () => Object.assign(p, saved);
}

const { createTeamInvite, acceptTeamInvite } = await import("../services/enterprise.js");

test("an invite can never grant ownership", async () => {
  await assert.rejects(createTeamInvite("o1", "u0", "x@example.com", "owner"), /admin or member/);
});

function inviteWorld(userEmail: string) {
  const state = {
    invite: {
      id: "i1",
      orgId: "team-org",
      email: "invitee@example.com",
      role: "admin",
      token: "tok",
      status: "pending",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    members: [] as any[],
    verified: false,
  };
  const tx = {
    teamInvite: {
      updateMany: async ({ where, data }: any) => {
        if (state.invite.id !== where.id || state.invite.status !== where.status) return { count: 0 };
        Object.assign(state.invite, data);
        return { count: 1 };
      },
    },
    orgMember: {
      findFirst: async ({ where }: any) =>
        state.members.find((m) => m.orgId === where.orgId && m.userId === where.userId) ?? null,
      create: async ({ data }: any) => void state.members.push(data),
    },
    user: { update: async () => void (state.verified = true) },
  };
  const restore = stub({
    teamInvite: { findUnique: async () => ({ ...state.invite }), updateMany: tx.teamInvite.updateMany },
    user: { findUnique: async () => ({ email: userEmail, emailVerified: false }) },
    $transaction: async (fn: any) => fn(tx),
  });
  return { state, restore };
}

test("accepting requires the invited email address", async () => {
  const { state, restore } = inviteWorld("someone-else@example.com");
  try {
    await assert.rejects(acceptTeamInvite("tok", "u9"), /sent to invitee@example\.com/);
    assert.equal(state.members.length, 0);
    assert.equal(state.invite.status, "pending");
  } finally {
    restore();
  }
});

test("the invited address joins with the invited role, once", async () => {
  const { state, restore } = inviteWorld("Invitee@Example.com");
  try {
    const res = await acceptTeamInvite("tok", "u1");
    assert.deepEqual(res, { orgId: "team-org", role: "admin" });
    assert.deepEqual(state.members, [{ orgId: "team-org", userId: "u1", role: "admin" }]);
    assert.equal(state.verified, true);
    await assert.rejects(acceptTeamInvite("tok", "u1"), /no longer valid/);
    assert.equal(state.members.length, 1);
  } finally {
    restore();
  }
});

async function authApp(principal: unknown) {
  const Fastify = (await import("fastify")).default;
  const sensible = await import("@fastify/sensible");
  const jwt = await import("@fastify/jwt");
  const cookie = await import("@fastify/cookie");
  const { authRoutes } = await import("../routes/auth.js");
  const app = Fastify();
  await app.register(sensible.default);
  await app.register(cookie.default, { secret: process.env.JWT_SECRET });
  await app.register(jwt.default, { secret: process.env.JWT_SECRET! });
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = principal;
  });
  await app.register(authRoutes);
  return app;
}

const member = {
  id: "u1",
  email: "a@example.com",
  walletAddress: null,
  memberships: [
    { role: "owner", org: { id: "11111111-1111-4111-8111-111111111111", name: "Mine" } },
    { role: "member", org: { id: "22222222-2222-4222-8222-222222222222", name: "Team" } },
  ],
};

test("switch-org re-issues the session with that membership's role", async () => {
  const restore = stub({ user: { findUnique: async () => member, findFirst: async () => member } });
  const app = await authApp({ userId: "u1", orgId: member.memberships[0]!.org.id, type: "jwt", role: "owner" });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/switch-org",
      payload: { orgId: "22222222-2222-4222-8222-222222222222" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().role, "member");
    const claims = app.jwt.decode(res.json().token) as any;
    assert.equal(claims.orgId, "22222222-2222-4222-8222-222222222222");
    assert.equal(claims.role, "member");
    assert.match(String(res.headers["set-cookie"]), /wheelsai_token=/);
  } finally {
    await app.close();
    restore();
  }
});

test("switch-org refuses an organization the user does not belong to", async () => {
  const restore = stub({ user: { findUnique: async () => member, findFirst: async () => member } });
  const app = await authApp({ userId: "u1", orgId: member.memberships[0]!.org.id, type: "jwt", role: "owner" });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/switch-org",
      payload: { orgId: "33333333-3333-4333-8333-333333333333" },
    });
    assert.equal(res.statusCode, 403);
  } finally {
    await app.close();
    restore();
  }
});
