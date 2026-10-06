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
//   - requireRole gates JWT (human) sessions by the member's CURRENT org
//     role, read through a membership lookup, never by the token's claim
//     (MK-2: a demoted or removed admin kept passing until the token expired)
//   - an org-scoped API key acts with org authority and bypasses requireRole
//   - requireJwtAuth refuses API keys outright (per-user identity actions)
// Route wiring (which routes carry which guard) is asserted by each route's
// own tests; this file pins the guards themselves.

function setupEnv() {
  // auth.ts transitively loads config/env.js, which validates on import — set
  // the required vars before the dynamic import below (mirrors the sibling
  // route tests). No DB/Redis is touched; requireRole is built over a fake
  // membership lookup.
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

// The membership table as the database holds it right now, keyed
// "orgId:userId". The token's role claim is deliberately allowed to disagree.
type Memberships = Record<string, string>;

async function roleGuard(memberships: Memberships, lookups: string[] = []) {
  const { createRequireRole } = await loadAuth();
  return createRequireRole({
    getMemberRole: async (orgId, userId) => {
      lookups.push(`${orgId}:${userId}`);
      return memberships[`${orgId}:${userId}`] ?? null;
    },
  })("owner", "admin");
}

const ROLE_MATRIX: Array<{
  name: string;
  principal: Principal;
  memberships: Memberships;
  status: number;
  error?: string;
}> = [
  {
    name: "no auth → 401 unauthenticated",
    principal: null,
    memberships: {},
    status: 401,
    error: "unauthenticated",
  },
  {
    name: "api_key → pass-through (org authority)",
    principal: API_KEY,
    memberships: {},
    status: 200,
  },
  {
    name: "jwt owner → pass-through",
    principal: { userId: "u", orgId: "org_1", role: "owner", type: "jwt" },
    memberships: { "org_1:u": "owner" },
    status: 200,
  },
  {
    name: "jwt admin → pass-through",
    principal: { userId: "u", orgId: "org_1", role: "admin", type: "jwt" },
    memberships: { "org_1:u": "admin" },
    status: 200,
  },
  {
    name: "jwt member → 403 insufficient_role",
    principal: { userId: "u", orgId: "org_1", role: "member", type: "jwt" },
    memberships: { "org_1:u": "member" },
    status: 403,
    error: "insufficient_role",
  },
  {
    name: "admin token, since demoted to member → 403 insufficient_role",
    principal: { userId: "u", orgId: "org_1", role: "admin", type: "jwt" },
    memberships: { "org_1:u": "member" },
    status: 403,
    error: "insufficient_role",
  },
  {
    name: "admin token, since removed from the org → 403 not_a_member (fails closed)",
    principal: { userId: "u", orgId: "org_1", role: "admin", type: "jwt" },
    memberships: {},
    status: 403,
    error: "not_a_member",
  },
  {
    name: "admin token for org_1 does not borrow the user's role in another org",
    principal: { userId: "u", orgId: "org_1", role: "admin", type: "jwt" },
    memberships: { "org_2:u": "owner" },
    status: 403,
    error: "not_a_member",
  },
  {
    name: "member token, since promoted to admin → pass-through",
    principal: { userId: "u", orgId: "org_1", role: "member", type: "jwt" },
    memberships: { "org_1:u": "admin" },
    status: 200,
  },
  {
    name: "token with no role claim, current admin → pass-through",
    principal: { userId: "u", orgId: "org_1", type: "jwt" },
    memberships: { "org_1:u": "admin" },
    status: 200,
  },
  {
    name: "jwt with no user id → 403 not_a_member (fails closed)",
    principal: { userId: null, orgId: "org_1", role: "owner", type: "jwt" },
    memberships: {},
    status: 403,
    error: "not_a_member",
  },
];

for (const c of ROLE_MATRIX) {
  test(`requireRole("owner","admin"): ${c.name}`, async () => {
    const app = await appWithGuard(await roleGuard(c.memberships), c.principal);
    const res = await app.inject({ method: "GET", url: "/guarded" });
    assert.equal(res.statusCode, c.status);
    if (c.error) assert.equal(res.json().error, c.error);
    await app.close();
  });
}

test("requireRole hands the handler the current role, not the token's claim", async () => {
  const guard = await roleGuard({ "org_1:u": "owner" });
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { auth: Principal }).auth = {
      userId: "u",
      orgId: "org_1",
      role: "admin",
      type: "jwt",
    };
  });
  app.get("/guarded", { preHandler: guard }, async (request) => ({
    role: (request as unknown as { auth: { role: string } }).auth.role,
  }));
  const res = await app.inject({ method: "GET", url: "/guarded" });
  assert.equal(res.json().role, "owner");
  await app.close();
});

test("requireRole does not look up a membership for an API key", async () => {
  const lookups: string[] = [];
  const app = await appWithGuard(await roleGuard({}, lookups), API_KEY);
  const res = await app.inject({ method: "GET", url: "/guarded" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(lookups, []);
  await app.close();
});

test("requireRole refuses with 503 when the membership cannot be read", async () => {
  const { createRequireRole } = await loadAuth();
  const guard = createRequireRole({
    getMemberRole: async () => {
      throw new Error("database is down");
    },
  })("owner", "admin");
  const app = await appWithGuard(guard, {
    userId: "u",
    orgId: "org_1",
    role: "owner",
    type: "jwt",
  });
  const res = await app.inject({ method: "GET", url: "/guarded" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "role_check_unavailable");
  await app.close();
});

test("the exported requireRole reads the OrgMember row for the token's org and user", async () => {
  const { requireRole } = await loadAuth();
  const { prisma } = await import("@wheelsai/db");
  const p = prisma as unknown as { orgMember: Record<string, unknown> };
  const original = p.orgMember.findUnique;
  const wheres: unknown[] = [];
  let row: { role: string } | null = { role: "member" };
  p.orgMember.findUnique = async ({ where }: { where: unknown }) => {
    wheres.push(where);
    return row;
  };
  const app = await appWithGuard(requireRole("owner", "admin"), {
    userId: "u",
    orgId: "org_1",
    role: "admin",
    type: "jwt",
  });
  try {
    const demoted = await app.inject({ method: "GET", url: "/guarded" });
    assert.equal(demoted.statusCode, 403);
    assert.equal(demoted.json().error, "insufficient_role");

    row = null;
    const removed = await app.inject({ method: "GET", url: "/guarded" });
    assert.equal(removed.statusCode, 403);
    assert.equal(removed.json().error, "not_a_member");

    row = { role: "admin" };
    const current = await app.inject({ method: "GET", url: "/guarded" });
    assert.equal(current.statusCode, 200);

    assert.deepEqual(wheres[0], { orgId_userId: { orgId: "org_1", userId: "u" } });
  } finally {
    p.orgMember.findUnique = original;
    await app.close();
  }
});

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
