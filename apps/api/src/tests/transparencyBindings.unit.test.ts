import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/routes/transparencyBindings.ts — the production
// wiring that finally registers the three "dark" transparency route
// factories (remediation E1). These assertions are deliberately DB-free:
//   - hasRoute proves each binding registered its route at the mounted path
//   - the authed feeds short-circuit to 401 on `request.auth` BEFORE any
//     Prisma call, so we exercise the binding's mount without a database
// The loaders' data shaping is already covered by the route-level and
// load*ByPrisma unit tests; this file only proves the production mount.

async function buildApp(): Promise<FastifyInstance> {
  setupEnv();
  const {
    createPublicAgentRoutesProduction,
    createAgentListRoutesProduction,
    createAgentDetailRoutesProduction,
  } = await import("../routes/transparencyBindings.js");

  const app = Fastify();
  // Mirror production's global auth hook: request.auth defaults to null, so
  // an unauthenticated request hits the route's own 401 guard.
  app.decorateRequest("auth", null);

  await app.register(createPublicAgentRoutesProduction(), { prefix: "/api" });
  await app.register(createAgentListRoutesProduction(), { prefix: "/api/feed" });
  await app.register(createAgentDetailRoutesProduction(), { prefix: "/api/feed" });
  await app.ready();
  return app;
}

test("transparency bindings register all three routes at their mounted paths", async () => {
  const app = await buildApp();
  assert.ok(
    app.hasRoute({ method: "GET", url: "/api/a/:slug" }),
    "publicAgent should mount at /api/a/:slug",
  );
  assert.ok(
    app.hasRoute({ method: "GET", url: "/api/feed/agents" }),
    "agentList should mount at /api/feed/agents",
  );
  assert.ok(
    app.hasRoute({ method: "GET", url: "/api/feed/agents/:slug" }),
    "agentDetail should mount at /api/feed/agents/:slug",
  );
  await app.close();
});

test("agentList binding does NOT collide with the legacy /api/agents routes", async () => {
  // The whole reason the authed feeds mount under /api/feed: their /agents
  // path would otherwise duplicate the id-keyed agentRoutes and Fastify
  // would throw at registration. Assert the feed path is distinct.
  const app = await buildApp();
  assert.ok(app.hasRoute({ method: "GET", url: "/api/feed/agents" }));
  assert.equal(
    app.hasRoute({ method: "GET", url: "/api/agents" }),
    false,
    "the feed binding must not have registered the legacy /api/agents path",
  );
  await app.close();
});

test("agentList binding: unauthenticated GET /api/feed/agents returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/feed/agents" });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "unauthenticated");
  await app.close();
});

test("agentDetail binding: unauthenticated GET /api/feed/agents/:slug returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/api/feed/agents/elizabot",
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "unauthenticated");
  await app.close();
});

test("publicAgent binding mounts the feed with no auth guard (public)", async () => {
  // publicAgent is intentionally unauthenticated — there is no 401 path.
  // Invoking it would hit real Prisma, so we assert registration only;
  // its 404-don't-reveal / redaction behavior lives in publicAgentRoute and
  // loadPublicAgent unit tests.
  const app = await buildApp();
  assert.ok(app.hasRoute({ method: "GET", url: "/api/a/:slug" }));
  await app.close();
});
