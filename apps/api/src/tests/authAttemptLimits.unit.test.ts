import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

process.env.NODE_ENV ??= "development";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET ??= "12345678901234567890123456789012";

const { createAttemptLimiter } = await import("../lib/attemptLimiter.js");

function memoryStore() {
  const data = new Map<string, number>();
  const ttl = new Map<string, number>();
  return {
    data,
    ttl,
    incr: async (k: string) => {
      const n = (data.get(k) ?? 0) + 1;
      data.set(k, n);
      return n;
    },
    expire: async (k: string, s: number) => ttl.set(k, s),
    get: async (k: string) => (data.has(k) ? String(data.get(k)) : null),
    del: async (k: string) => data.delete(k),
  };
}

const policy = { prefix: "t:", maxFailures: 3, windowSeconds: 60 };

test("locks after maxFailures, per subject, case-insensitive", async () => {
  const store = memoryStore();
  const limiter = createAttemptLimiter(store, policy);
  for (let i = 0; i < 3; i++) await limiter.recordFailure("Victim@Example.com");
  assert.equal(await limiter.isLocked("victim@example.com"), true);
  assert.equal(await limiter.isLocked("other@example.com"), false);
});

test("the window starts at the first failure only", async () => {
  const store = memoryStore();
  const limiter = createAttemptLimiter(store, policy);
  await limiter.recordFailure("a");
  await limiter.recordFailure("a");
  assert.equal(store.ttl.get("t:a"), 60);
  assert.equal(store.ttl.size, 1);
});

test("success clears the counter", async () => {
  const store = memoryStore();
  const limiter = createAttemptLimiter(store, policy);
  await limiter.recordFailure("a");
  await limiter.recordFailure("a");
  await limiter.clear("a");
  await limiter.recordFailure("a");
  assert.equal(await limiter.isLocked("a"), false);
});

test("store errors fail open and are reported", async () => {
  const errors: unknown[] = [];
  const broken = {
    incr: async () => { throw new Error("down"); },
    expire: async () => { throw new Error("down"); },
    get: async () => { throw new Error("down"); },
    del: async () => { throw new Error("down"); },
  };
  const limiter = createAttemptLimiter(broken, policy, (e) => errors.push(e));
  assert.equal(await limiter.isLocked("a"), false);
  assert.equal(await limiter.recordFailure("a"), 0);
  await limiter.clear("a");
  assert.equal(errors.length, 3);
});

// With trustProxy: true, request.ip was the LEFTMOST X-Forwarded-For entry,
// which the client controls. One trusted hop takes the entry Fly appended.
test("one trusted proxy hop ignores client-written X-Forwarded-For entries", async () => {
  const { env } = await import("../config/env.js");
  assert.equal(env.TRUST_PROXY_HOPS, 1);
  const app = Fastify({ trustProxy: env.TRUST_PROXY_HOPS });
  app.get("/ip", async (req) => ({ ip: req.ip }));
  const res = await app.inject({
    method: "GET",
    url: "/ip",
    headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.7" },
    remoteAddress: "10.0.0.1",
  });
  assert.equal(res.json().ip, "203.0.113.7");
});

test("login answers 429 once the account is locked, without checking the password", async () => {
  const auth = await import("../services/auth.js");
  const saved = { isLocked: auth.loginAttempts.isLocked };
  let lookedUp = false;
  (auth.loginAttempts as any).isLocked = async () => true;
  const { prisma } = await import("@wheelsai/db");
  const savedUser = (prisma as any).user;
  (prisma as any).user = {
    findUnique: async () => { lookedUp = true; return null; },
    findFirst: async () => { lookedUp = true; return null; },
  };
  try {
    const sensible = await import("@fastify/sensible");
    const { authRoutes } = await import("../routes/auth.js");
    const app = Fastify();
    await app.register(sensible.default);
    await app.register(authRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/login",
      payload: { email: "victim@example.com", password: "guess-123456" },
    });
    assert.equal(res.statusCode, 429);
    assert.equal(res.json().error, "too_many_attempts");
    assert.equal(lookedUp, false);
  } finally {
    (auth.loginAttempts as any).isLocked = saved.isLocked;
    (prisma as any).user = savedUser;
  }
});
