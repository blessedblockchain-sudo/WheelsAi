import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "development";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET ??= "12345678901234567890123456789012";

async function appWith(stubs: Record<string, unknown>, principal: unknown, sent: unknown[]) {
  const { prisma } = await import("@wheelsai/db");
  const saved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stubs)) {
    saved[k] = (prisma as any)[k];
    (prisma as any)[k] = v;
  }
  const Fastify = (await import("fastify")).default;
  const sensible = await import("@fastify/sensible");
  const { globalErrorHandler } = await import("../lib/errorHandler.js");
  const { createEmailAuthRoutes } = await import("../routes/emailAuth.js");
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(sensible.default);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = principal;
  });
  await app.register(createEmailAuthRoutes({ sendEmail: async (m) => void sent.push(m) }));
  return {
    app,
    restore: async () => {
      await app.close();
      Object.assign(prisma as any, saved);
    },
  };
}

const tokenDb = {
  emailToken: {
    updateMany: async () => ({ count: 0 }),
    create: async () => ({}),
  },
};

test("forgot-password answers the same for known and unknown emails", async () => {
  const sent: any[] = [];
  const users: Record<string, unknown> = {
    "known@example.com": { id: "u1", email: "known@example.com", passwordHash: "h" },
  };
  const { app, restore } = await appWith(
    { ...tokenDb, user: { findUnique: async ({ where }: any) => users[where.email] ?? null } },
    null,
    sent,
  );
  try {
    const known = await app.inject({ method: "POST", url: "/password/forgot", payload: { email: "known@example.com" } });
    const unknown = await app.inject({ method: "POST", url: "/password/forgot", payload: { email: "nobody@example.com" } });
    assert.equal(known.statusCode, 202);
    assert.equal(unknown.statusCode, 202);
    assert.equal(known.body, unknown.body);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /\/reset-password\?token=/);
    assert.equal(sent[0].to, "known@example.com");
  } finally {
    await restore();
  }
});

test("without an email provider the flows answer 501 instead of pretending", async () => {
  const { env } = await import("../config/env.js");
  const saved = { NODE_ENV: env.NODE_ENV, EMAIL_PROVIDER: env.EMAIL_PROVIDER };
  (env as any).NODE_ENV = "staging";
  (env as any).EMAIL_PROVIDER = undefined;
  const { app, restore } = await appWith({ ...tokenDb, user: { findUnique: async () => null } }, null, []);
  try {
    const res = await app.inject({ method: "POST", url: "/password/forgot", payload: { email: "a@example.com" } });
    assert.equal(res.statusCode, 501);
    assert.equal(res.json().error, "email_not_configured");
  } finally {
    Object.assign(env as any, saved);
    await restore();
  }
});

test("a bad verification token is a 400 with one message", async () => {
  const { app, restore } = await appWith(
    { $transaction: async (fn: any) => fn({ emailToken: { findUnique: async () => null } }) },
    null,
    [],
  );
  try {
    const res = await app.inject({
      method: "POST",
      url: "/email/verify/confirm",
      payload: { token: "x".repeat(43) },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, "invalid_or_expired_token");
  } finally {
    await restore();
  }
});

test("an API key cannot request a verification email", async () => {
  const { app, restore } = await appWith({}, { userId: null, orgId: "o", type: "api_key" }, []);
  try {
    const res = await app.inject({ method: "POST", url: "/email/verify/request" });
    assert.equal(res.statusCode, 401);
  } finally {
    await restore();
  }
});

test("a signed-in unverified user gets a verification link", async () => {
  const sent: any[] = [];
  const { app, restore } = await appWith(
    {
      ...tokenDb,
      user: { findUnique: async () => ({ id: "u1", email: "a@example.com", emailVerified: false }) },
      organization: { findFirst: async () => ({ signupBonusGrantedAt: null }) },
    },
    { userId: "u1", orgId: "o1", type: "jwt", role: "owner" },
    sent,
  );
  try {
    const res = await app.inject({ method: "POST", url: "/email/verify/request" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { sent: true });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /\/verify-email\?token=/);
    assert.match(sent[0].text, /\$5 of free credits/);
  } finally {
    await restore();
  }
});
