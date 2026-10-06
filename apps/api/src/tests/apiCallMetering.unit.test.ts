import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

// What counts against a plan's monthly API calls (middleware/auth.ts).
// requireAuth used to count every API-key request, so status polling and
// listing spent the allowance: a CLI waiting ten minutes at one poll every
// three seconds burned 200 of Starter's 1,000 calls. Reads with a key are now
// free; every /v1 request and every other API-key request still counts.

process.env.NODE_ENV ??= "development";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET ??= "12345678901234567890123456789012";

const { countsAsApiCall, requireAuth } = await import("../middleware/auth.js");
const { prisma } = await import("@wheelsai/db");

const CASES: Array<{
  authType: "jwt" | "api_key";
  method: string;
  url: string;
  counts: boolean;
}> = [
  { authType: "api_key", method: "GET", url: "/api/deployments/d1", counts: false },
  { authType: "api_key", method: "GET", url: "/api/agents?limit=20", counts: false },
  { authType: "api_key", method: "HEAD", url: "/api/agents", counts: false },
  { authType: "api_key", method: "OPTIONS", url: "/api/agents", counts: false },
  { authType: "api_key", method: "get", url: "/api/agents", counts: false },
  { authType: "api_key", method: "POST", url: "/api/agents", counts: true },
  { authType: "api_key", method: "PUT", url: "/api/agents/a1", counts: true },
  { authType: "api_key", method: "PATCH", url: "/api/agents/a1", counts: true },
  { authType: "api_key", method: "DELETE", url: "/api/agents/a1", counts: true },
  { authType: "api_key", method: "POST", url: "/api/agents/a1/playground/chat", counts: true },
  // /v1 counts whatever the method and however it is authenticated.
  { authType: "api_key", method: "POST", url: "/v1/chat/completions", counts: true },
  { authType: "api_key", method: "GET", url: "/v1/models", counts: true },
  { authType: "jwt", method: "POST", url: "/v1/chat/completions", counts: true },
  { authType: "jwt", method: "GET", url: "/v1/models", counts: true },
  // The dashboard session is never metered outside /v1.
  { authType: "jwt", method: "GET", url: "/api/agents", counts: false },
  { authType: "jwt", method: "POST", url: "/api/agents", counts: false },
  // Only the /v1 API itself, not a path that merely starts with the letters.
  { authType: "jwt", method: "POST", url: "/v1beta/thing", counts: false },
];

for (const c of CASES) {
  test(`${c.authType} ${c.method} ${c.url} ${c.counts ? "counts" : "is free"}`, () => {
    assert.equal(countsAsApiCall(c), c.counts);
  });
}

// requireAuth -> meterApiCall -> getOrgPlan. An enterprise plan has no call
// cap, so no Redis is needed; the plan lookup count shows whether the request
// was metered.
async function meteredApp(principal: unknown) {
  const p = prisma as any;
  const original = p.orgSubscription;
  const state = { planLookups: 0 };
  p.orgSubscription = {
    findUnique: async () => {
      state.planLookups += 1;
      return { plan: "enterprise", status: "active" };
    },
  };
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = principal;
  });
  app.route({
    method: ["GET", "HEAD", "POST", "DELETE"],
    url: "/api/deployments/:id",
    preHandler: requireAuth,
    handler: async () => ({ ok: true }),
  });
  app.route({
    method: ["GET", "POST"],
    url: "/v1/models",
    preHandler: requireAuth,
    handler: async () => ({ ok: true }),
  });
  await app.ready();
  return {
    app,
    state,
    restore: async () => {
      p.orgSubscription = original;
      await app.close();
    },
  };
}

const KEY = { userId: null, orgId: "org-1", type: "api_key", scopes: ["*"] };
const SESSION = { userId: "u1", orgId: "org-1", type: "jwt", role: "owner" };

test("polling a deployment 200 times with an API key spends no API calls", async () => {
  const { app, state, restore } = await meteredApp(KEY);
  try {
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: "GET", url: "/api/deployments/d1" });
      assert.equal(res.statusCode, 200);
    }
    assert.equal(state.planLookups, 0);
  } finally {
    await restore();
  }
});

test("an API-key write is metered once per request", async () => {
  const { app, state, restore } = await meteredApp(KEY);
  try {
    await app.inject({ method: "POST", url: "/api/deployments/d1" });
    await app.inject({ method: "DELETE", url: "/api/deployments/d1" });
    await app.inject({ method: "HEAD", url: "/api/deployments/d1" });
    assert.equal(state.planLookups, 2);
  } finally {
    await restore();
  }
});

test("every /v1 request is metered, reads and sessions included", async () => {
  const key = await meteredApp(KEY);
  try {
    await key.app.inject({ method: "GET", url: "/v1/models" });
    await key.app.inject({ method: "POST", url: "/v1/models" });
    assert.equal(key.state.planLookups, 2);
  } finally {
    await key.restore();
  }
  const session = await meteredApp(SESSION);
  try {
    await session.app.inject({ method: "GET", url: "/v1/models" });
    await session.app.inject({ method: "POST", url: "/api/deployments/d1" });
    assert.equal(session.state.planLookups, 1);
  } finally {
    await session.restore();
  }
});

test("an unauthenticated request is refused before any metering", async () => {
  const { app, state, restore } = await meteredApp(null);
  try {
    const res = await app.inject({ method: "POST", url: "/v1/models" });
    assert.equal(res.statusCode, 401);
    assert.equal(state.planLookups, 0);
  } finally {
    await restore();
  }
});
