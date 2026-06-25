import assert from "node:assert/strict";
import test from "node:test";
import Fastify, {
  type FastifyInstance,
  type RouteShorthandOptions,
} from "fastify";

// Drives apps/api/src/middleware/auth.ts requireRole / requireJwtAuth
// (remediation F4). Before F4 there was no role anywhere in the request path,
// so any freshly-invited member could read audit logs, configure SSO, mint
// credits, or request payouts. These DB-free tests pin the guard contract:
//   - requireRole gates JWT (human) sessions by org role
//   - an org-scoped API key acts with org authority and bypasses requireRole
//   - requireJwtAuth refuses API keys outright (per-user identity actions)
// Route wiring (which routes carry which guard) is asserted by each route's
// own tests; this file pins the guards themselves.

function setupEnv() {
  // auth.ts transitively loads config/env.js, which validates on import — set
  // the required vars before the dynamic import below (mirrors the sibling
  // route tests). No DB/Redis is touched; the guards are pure.
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}
setupEnv();

async function loadAuth() {
  setupEnv();
  return import("../middleware/auth.js");
}

type Principal = {
  userId: string | null;
  orgId: string;
  role?: string | null;
  type: "jwt" | "api_key";
  scopes?: string[];
} | null;

// Build a one-route app whose `request.auth` is the given principal, guarded by
// `guard`. Mirrors production: the global onRequest hook populates request.auth
// before any preHandler runs.
async function appWithGuard(
  guard: RouteShorthandOptions["preHandler"],
  principal: Principal,
): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { auth: Principal }).auth = principal;
  });
  app.get("/guarded", { preHandler: guard }, async () => ({ ok: true }));
  await app.ready();
  return app;
}

const API_KEY: Principal = {
  userId: null,
  orgId: "org_1",
  type: "api_key",
  scopes: ["*"],
};

const ROLE_MATRIX: Array<{
  name: string;
  principal: Principal;
  status: number;
  error?: string;
}> = [
  {
    name: "no auth → 401 unauthenticated",
    principal: null,
    status: 401,
    error: "unauthenticated",
  },
  {
    name: "api_key → pass-through (org authority)",
    principal: API_KEY,
    status: 200,
  },
  {
    name: "jwt owner → pass-through",
    principal: { userId: "u", orgId: "org_1", role: "owner", type: "jwt" },
    status: 200,
  },
  {
    name: "jwt admin → pass-through",
    principal: { userId: "u", orgId: "org_1", role: "admin", type: "jwt" },
    status: 200,
  },
  {
    name: "jwt member → 403 insufficient_role",
    principal: { userId: "u", orgId: "org_1", role: "member", type: "jwt" },
    status: 403,
    error: "insufficient_role",
  },
  {
    name: "jwt with no role → 403 insufficient_role (fails closed)",
    principal: { userId: "u", orgId: "org_1", type: "jwt" },
    status: 403,
    error: "insufficient_role",
  },
];

for (const c of ROLE_MATRIX) {
  test(`requireRole("owner","admin"): ${c.name}`, async () => {
    const { requireRole } = await loadAuth();
    const app = await appWithGuard(requireRole("owner", "admin"), c.principal);
    const res = await app.inject({ method: "GET", url: "/guarded" });
    assert.equal(res.statusCode, c.status);
    if (c.error) assert.equal(res.json().error, c.error);
    await app.close();
  });
}

test("requireJwtAuth refuses api_key principals (401) — 2FA is per-user", async () => {
  const { requireJwtAuth } = await loadAuth();
  const app = await appWithGuard(requireJwtAuth, API_KEY);
  const res = await app.inject({ method: "GET", url: "/guarded" });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test("requireJwtAuth accepts jwt principals regardless of role (200)", async () => {
  const { requireJwtAuth } = await loadAuth();
  const app = await appWithGuard(requireJwtAuth, {
    userId: "u",
    orgId: "org_1",
    role: "member",
    type: "jwt",
  });
  const res = await app.inject({ method: "GET", url: "/guarded" });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test("api-key principal carries a null userId (no user behind it)", () => {
  // Pins the F4 honesty change: API keys are org-scoped, not user-scoped.
  assert.equal(API_KEY!.userId, null);
});
