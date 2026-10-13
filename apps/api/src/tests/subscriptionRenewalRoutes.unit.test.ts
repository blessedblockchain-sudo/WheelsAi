import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

// POST /api/marketplace/subscriptions/:listingId/cancel and /resume, through
// the route and the app's own guards, against an in-memory row. Resuming turns
// charges back on, so it needs the right a start needs: an owner or admin, or
// an API key granted marketplace:install by name. Cancelling only stops a
// charge and stays open to every member and every key.

const DAY = 24 * 60 * 60 * 1000;
const LISTING_ID = "11111111-1111-4111-8111-111111111111";
const BUYER = "org_buyer";

type Row = Record<string, any>;

const ROLES: Record<string, string | null> = {
  u_owner: "owner",
  u_admin: "admin",
  u_member: "member",
  u_viewer: "viewer",
  u_removed: null,
};

function makeWorld(sub: Row = {}) {
  const row: Row = {
    id: "sub_1",
    listingId: LISTING_ID,
    subscriberId: BUYER,
    status: "active",
    currentPeriodStart: new Date(Date.now() - 10 * DAY),
    currentPeriodEnd: new Date(Date.now() + 20 * DAY),
    cancelAtPeriodEnd: false,
    cancelledAt: null,
    priceCents: 900n,
    endReason: null,
    planId: null,
    includedUses: null,
    ...sub,
  };
  const state = { row, writes: 0 };
  const models: Row = {
    agentSubscription: {
      updateMany: async ({ where, data }: Row) => {
        const hit =
          row.listingId === where.listingId &&
          row.subscriberId === where.subscriberId &&
          where.status.in.includes(row.status);
        if (!hit) return { count: 0 };
        state.writes += 1;
        Object.assign(row, data);
        return { count: 1 };
      },
      findUnique: async () => ({ ...row }),
    },
    // The spend guard reads the member's role as it is now.
    orgMember: {
      findUnique: async ({ where }: Row) => {
        const role = ROLES[where.orgId_userId.userId as string] ?? null;
        return role ? { role } : null;
      },
    },
    // A plan with no cap on API calls, so a key's call needs no counter.
    orgSubscription: { findUnique: async () => ({ plan: "enterprise", status: "active" }) },
  };
  return { state, models };
}

type World = ReturnType<typeof makeWorld>;

async function post(world: World, action: "cancel" | "resume", principal: Row | null) {
  const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Row };
  const originals: Row = {};
  for (const [name, fake] of Object.entries(world.models)) {
    originals[name] = prisma[name];
    prisma[name] = fake;
  }
  const Fastify = (await import("fastify")).default;
  const sensible = await import("@fastify/sensible");
  const { marketplaceRoutes } = await import("../routes/marketplace.js");
  const app = Fastify();
  try {
    await app.register(sensible.default);
    app.decorateRequest("auth", null);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { auth: unknown }).auth = principal === null ? null : { ...principal };
    });
    await app.register(marketplaceRoutes);
    const res = await app.inject({ method: "POST", url: `/subscriptions/${LISTING_ID}/${action}` });
    return { status: res.statusCode, body: res.json() as Row };
  } finally {
    await app.close();
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

const session = (userId: string): Row => ({ userId, orgId: BUYER, type: "jwt", role: "owner" });
const key = (scopes: string[]): Row => ({ userId: null, orgId: BUYER, type: "api_key", apiKeyId: "key_1", scopes });

/** Everyone who may not spend, and what each is told. */
const MAY_NOT_SPEND: Array<[string, Row, string]> = [
  ["a member", session("u_member"), "insufficient_role"],
  ["a viewer", session("u_viewer"), "insufficient_role"],
  // The token still says owner; the membership as it is now decides.
  ["someone removed from the organization", session("u_removed"), "not_a_member"],
  ["a key with no scopes", key([]), "missing_scope"],
  ["a key with every ordinary scope", key(["*"]), "missing_scope"],
  ["a key that may use agents", key(["agents:use", "agents:invoke"]), "missing_scope"],
];

const MAY_SPEND: Array<[string, Row]> = [
  ["an owner", session("u_owner")],
  ["an admin", session("u_admin")],
  ["a key granted marketplace:install", key(["marketplace:install"])],
];

for (const [name, principal, error] of MAY_NOT_SPEND) {
  test(`resume is refused for ${name}, and the subscription is unchanged`, async () => {
    const world = makeWorld({ cancelAtPeriodEnd: true });
    const before = structuredClone(world.state.row);
    const res = await post(world, "resume", principal);
    assert.deepEqual([res.status, res.body.error], [403, error]);
    assert.equal("subscription" in res.body, false);
    assert.equal(world.state.writes, 0);
    assert.deepEqual(world.state.row, before);
  });
}

for (const [name, principal] of MAY_SPEND) {
  test(`${name} resumes a renewal`, async () => {
    const world = makeWorld({ cancelAtPeriodEnd: true });
    const res = await post(world, "resume", principal);
    assert.equal(res.status, 200);
    assert.equal(res.body.subscription.cancelAtPeriodEnd, false);
    assert.equal(world.state.row.cancelAtPeriodEnd, false);
    assert.equal(world.state.writes, 1);
  });
}

for (const [name, principal] of [...MAY_NOT_SPEND, ...MAY_SPEND] as Array<[string, Row, string?]>) {
  // Someone removed keeps a token until it expires; cancelling was never role-gated.
  test(`cancel still works for ${name}`, async () => {
    const world = makeWorld();
    const res = await post(world, "cancel", principal);
    assert.equal(res.status, 200);
    assert.equal(res.body.subscription.cancelAtPeriodEnd, true);
    assert.equal(world.state.row.cancelAtPeriodEnd, true);
    // Nothing but the renewal choice moved.
    assert.deepEqual(
      [world.state.row.status, world.state.row.priceCents, world.state.writes],
      ["active", 900n, 1],
    );
  });
}

test("resume in the days of grace is held to the same right, and a plan's row is treated the same", async () => {
  const plan = { status: "past_due", cancelAtPeriodEnd: true, planId: "plan_1", includedUses: 500 };
  const refused = makeWorld(plan);
  const no = await post(refused, "resume", session("u_member"));
  assert.deepEqual([no.status, no.body.error], [403, "insufficient_role"]);
  assert.equal(refused.state.row.cancelAtPeriodEnd, true);

  const allowed = makeWorld(plan);
  const yes = await post(allowed, "resume", session("u_owner"));
  assert.equal(yes.status, 200);
  assert.deepEqual([allowed.state.row.cancelAtPeriodEnd, allowed.state.row.status], [false, "past_due"]);
});

test("nobody signed in is a 401 on both, and a subscription that is not open is a 404 for someone who may spend", async () => {
  for (const action of ["cancel", "resume"] as const) {
    const world = makeWorld({ cancelAtPeriodEnd: action === "resume" });
    const res = await post(world, action, null);
    assert.equal(res.status, 401);
    assert.equal(world.state.writes, 0);
  }
  const ended = makeWorld({ status: "expired", cancelAtPeriodEnd: true });
  const res = await post(ended, "resume", session("u_owner"));
  assert.deepEqual([res.status, res.body.error], [404, "subscription_not_found"]);
  assert.equal(ended.state.row.cancelAtPeriodEnd, true);
});
