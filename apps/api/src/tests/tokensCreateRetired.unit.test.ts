import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

// A2 (REMEDIATION_PLAN): the custodial mint path is retired. Its service
// is @deprecated and produced broken on-chain metadata; the supported
// path is the browser partial-sign flow. This pins the 410 so the
// endpoint can never silently mint again.

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}
setupEnv();

test("POST /api/tokens/create returns 410 custodial_create_retired", async () => {
  const { tokenRoutes } = await import("../routes/tokens.js");

  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request) => {
    (request as unknown as { auth: unknown }).auth = {
      userId: "user_1",
      orgId: "org_1",
      walletAddress: "SoMeWaLLet1111111111111111111111111111111111",
      type: "jwt",
    };
  });
  await app.register(tokenRoutes, { prefix: "/api/tokens" });

  const res = await app.inject({
    method: "POST",
    url: "/api/tokens/create",
    payload: {
      agentListingId: "listing_1",
      name: "Eliza",
      symbol: "ELZ",
    },
  });

  assert.equal(res.statusCode, 410);
  const body = res.json();
  assert.equal(body.error, "custodial_create_retired");
  assert.match(body.message, /launch\/prepare/);
  await app.close();
});
