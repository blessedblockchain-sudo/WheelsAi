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

/**
 * Helper: create a minimal Fastify app with a test route guarded by the
 * token-gate middleware. The route itself just returns 200 with { ok: true }.
 */
async function buildApp(
  requireTokenHolding: (min?: number) => any,
  opts: { minBalance?: number; paramName?: "deploymentSlug" | "id" } = {}
): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest("auth", null);

  const paramKey = opts.paramName ?? "deploymentSlug";
  const handler = requireTokenHolding(opts.minBalance ?? 1);

  app.get(
    `/test/:${paramKey}`,
    { preHandler: [handler] },
    async () => ({ ok: true })
  );

  await app.ready();
  return app;
}

// ============================================
// Test 1: Non-tokenized listing passes through
// ============================================

test("token gate passes through when listing is not tokenized", async () => {
  setupEnv();

  const [{ requireTokenHolding }, { prisma }] = await Promise.all([
    import("../middleware/tokenGate.js"),
    import("@wheelsai/db"),
  ]);

  const prismaAny = prisma as any;
  const origDeploymentFindFirst = prismaAny.deployment.findFirst;
  const origAgentDeploymentFindFirst = prismaAny.agentDeployment.findFirst;

  // Model deployment exists but has no tokenized listing
  prismaAny.deployment.findFirst = async () => ({ id: "dep_1" });
  prismaAny.agentDeployment.findFirst = async () => ({
    agent: {
      listing: {
        id: "listing_1",
        pricingModel: "free", // not "tokenized"
        agentToken: null,
      },
    },
  });

  const app = await buildApp(requireTokenHolding);

  const response = await app.inject({
    method: "GET",
    url: "/test/demo-deployment",
  });

  assert.equal(response.statusCode, 200);
  assert.deepStrictEqual(response.json(), { ok: true });

  await app.close();
  prismaAny.deployment.findFirst = origDeploymentFindFirst;
  prismaAny.agentDeployment.findFirst = origAgentDeploymentFindFirst;
});

// ============================================
// Test 2: No listing at all passes through
// ============================================

test("token gate passes through when no listing exists for the deployment", async () => {
  setupEnv();

  const [{ requireTokenHolding }, { prisma }] = await Promise.all([
    import("../middleware/tokenGate.js"),
    import("@wheelsai/db"),
  ]);

  const prismaAny = prisma as any;
  const origDeploymentFindFirst = prismaAny.deployment.findFirst;
  const origAgentDeploymentFindFirst = prismaAny.agentDeployment.findFirst;

  prismaAny.deployment.findFirst = async () => ({ id: "dep_1" });
  // No agent deployment linked
  prismaAny.agentDeployment.findFirst = async () => null;

  const app = await buildApp(requireTokenHolding);

  const response = await app.inject({
    method: "GET",
    url: "/test/some-slug",
  });

  assert.equal(response.statusCode, 200);
  assert.deepStrictEqual(response.json(), { ok: true });

  await app.close();
  prismaAny.deployment.findFirst = origDeploymentFindFirst;
  prismaAny.agentDeployment.findFirst = origAgentDeploymentFindFirst;
});

// ============================================
// Test 3: Tokenized listing — no wallet returns 403
// ============================================

test("token gate returns 403 when wallet address is missing for tokenized agent", async () => {
  setupEnv();

  const [{ requireTokenHolding }, { prisma }] = await Promise.all([
    import("../middleware/tokenGate.js"),
    import("@wheelsai/db"),
  ]);

  const prismaAny = prisma as any;
  const origDeploymentFindFirst = prismaAny.deployment.findFirst;
  const origAgentDeploymentFindFirst = prismaAny.agentDeployment.findFirst;

  prismaAny.deployment.findFirst = async () => ({ id: "dep_1" });
  prismaAny.agentDeployment.findFirst = async () => ({
    agent: {
      listing: {
        id: "listing_1",
        pricingModel: "tokenized",
        agentToken: {
          id: "token_1",
          symbol: "AGENT",
          mintAddress: "MintAddress1111111111111111111111111",
        },
      },
    },
  });

  const app = Fastify();
  app.decorateRequest("auth", null);
  // No auth hook — request.auth remains null (no wallet)
  const handler = requireTokenHolding(1);
  app.get("/test/:deploymentSlug", { preHandler: [handler] }, async () => ({ ok: true }));
  await app.ready();

  const response = await app.inject({
    method: "GET",
    url: "/test/tokenized-deploy",
  });

  assert.equal(response.statusCode, 403);
  const body = response.json();
  assert.equal(body.error, "Forbidden");
  assert.ok(body.message.toLowerCase().includes("wallet"));
  assert.equal(body.tokenSymbol, "AGENT");
  assert.equal(body.mintAddress, "MintAddress1111111111111111111111111");

  await app.close();
  prismaAny.deployment.findFirst = origDeploymentFindFirst;
  prismaAny.agentDeployment.findFirst = origAgentDeploymentFindFirst;
});

// ============================================
// Test 4: Tokenized listing — insufficient balance returns 403
// ============================================

test("token gate returns 403 with proper error shape when token balance is insufficient", async () => {
  setupEnv();

  const [{ requireTokenHolding }, { prisma }] = await Promise.all([
    import("../middleware/tokenGate.js"),
    import("@wheelsai/db"),
  ]);

  const prismaAny = prisma as any;
  const origDeploymentFindFirst = prismaAny.deployment.findFirst;
  const origAgentDeploymentFindFirst = prismaAny.agentDeployment.findFirst;
  const origAgentTokenHolderFindUnique = prismaAny.agentTokenHolder.findUnique;

  prismaAny.deployment.findFirst = async () => ({ id: "dep_1" });
  prismaAny.agentDeployment.findFirst = async () => ({
    agent: {
      listing: {
        id: "listing_1",
        pricingModel: "tokenized",
        agentToken: {
          id: "token_1",
          symbol: "AGENT",
          mintAddress: "MintAddress1111111111111111111111111",
        },
      },
    },
  });
  // Holder record exists but with zero balance. The gate reads the
  // integer balanceRaw column (D9), not the Float balance.
  prismaAny.agentTokenHolder.findUnique = async () => ({
    balanceRaw: 0n,
  });

  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = {
      userId: "user_1",
      orgId: "org_1",
      walletAddress: "WalletABC123456789012345678901234567890",
      type: "jwt",
    };
  });

  const minRequired = 100;
  const handler = requireTokenHolding(minRequired);
  app.get("/test/:deploymentSlug", { preHandler: [handler] }, async () => ({ ok: true }));
  await app.ready();

  const response = await app.inject({
    method: "GET",
    url: "/test/tokenized-deploy",
  });

  assert.equal(response.statusCode, 403);
  const body = response.json();
  assert.equal(body.error, "Forbidden");
  assert.ok(body.message.includes("Insufficient"), "Message should mention insufficient holdings");
  assert.equal(body.tokenSymbol, "AGENT");
  assert.equal(body.mintAddress, "MintAddress1111111111111111111111111");
  assert.equal(body.requiredBalance, minRequired);
  assert.equal(body.currentBalance, 0);

  await app.close();
  prismaAny.deployment.findFirst = origDeploymentFindFirst;
  prismaAny.agentDeployment.findFirst = origAgentDeploymentFindFirst;
  prismaAny.agentTokenHolder.findUnique = origAgentTokenHolderFindUnique;
});

// ============================================
// Test 5: Tokenized listing — sufficient balance passes through
// ============================================

test("token gate passes through when holder has sufficient token balance", async () => {
  setupEnv();

  const [{ requireTokenHolding }, { prisma }] = await Promise.all([
    import("../middleware/tokenGate.js"),
    import("@wheelsai/db"),
  ]);

  const prismaAny = prisma as any;
  const origDeploymentFindFirst = prismaAny.deployment.findFirst;
  const origAgentDeploymentFindFirst = prismaAny.agentDeployment.findFirst;
  const origAgentTokenHolderFindUnique = prismaAny.agentTokenHolder.findUnique;

  prismaAny.deployment.findFirst = async () => ({ id: "dep_1" });
  // Distinct listing/token/slug/wallet from the insufficient-balance test
  // above: the gate caches the resolved listing (by slug) and the holder
  // balance (by token+wallet) in Redis with a short TTL, so reusing them
  // would let that test's cached zero balance leak in and fail this one.
  prismaAny.agentDeployment.findFirst = async () => ({
    agent: {
      listing: {
        id: "listing_5",
        pricingModel: "tokenized",
        agentToken: {
          id: "token_5",
          symbol: "AGENT",
          mintAddress: "MintAddress5555555555555555555555555",
        },
      },
    },
  });
  // 500 whole tokens in raw units (× 1e6) — comfortably over the min of 100.
  prismaAny.agentTokenHolder.findUnique = async () => ({
    balanceRaw: 500_000_000n,
  });

  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = {
      userId: "user_1",
      orgId: "org_1",
      walletAddress: "WalletSUFFICIENT9012345678901234567890",
      type: "jwt",
    };
  });

  const handler = requireTokenHolding(100);
  app.get("/test/:deploymentSlug", { preHandler: [handler] }, async () => ({ ok: true }));
  await app.ready();

  const response = await app.inject({
    method: "GET",
    url: "/test/tokenized-deploy-sufficient",
  });

  assert.equal(response.statusCode, 200);
  assert.deepStrictEqual(response.json(), { ok: true });

  await app.close();
  prismaAny.deployment.findFirst = origDeploymentFindFirst;
  prismaAny.agentDeployment.findFirst = origAgentDeploymentFindFirst;
  prismaAny.agentTokenHolder.findUnique = origAgentTokenHolderFindUnique;
});

// ============================================
// Test 6: Missing deployment — no slug or id passes through
// ============================================

test("token gate passes through when neither deploymentSlug nor id param is present", async () => {
  setupEnv();

  const [{ requireTokenHolding }] = await Promise.all([
    import("../middleware/tokenGate.js"),
  ]);

  const app = Fastify();
  app.decorateRequest("auth", null);

  const handler = requireTokenHolding(1);
  // Route without :deploymentSlug or :id param
  app.get("/test/no-params", { preHandler: [handler] }, async () => ({ ok: true }));
  await app.ready();

  const response = await app.inject({
    method: "GET",
    url: "/test/no-params",
  });

  assert.equal(response.statusCode, 200);
  assert.deepStrictEqual(response.json(), { ok: true });

  await app.close();
});

// ============================================
// Test 7: Tokenized listing with no token created returns 403
// ============================================

test("token gate returns 403 when listing is tokenized but token has not been created", async () => {
  setupEnv();

  const [{ requireTokenHolding }, { prisma }] = await Promise.all([
    import("../middleware/tokenGate.js"),
    import("@wheelsai/db"),
  ]);

  const prismaAny = prisma as any;
  const origDeploymentFindFirst = prismaAny.deployment.findFirst;
  const origAgentDeploymentFindFirst = prismaAny.agentDeployment.findFirst;

  prismaAny.deployment.findFirst = async () => ({ id: "dep_1" });
  prismaAny.agentDeployment.findFirst = async () => ({
    agent: {
      listing: {
        id: "listing_1",
        pricingModel: "tokenized",
        agentToken: null, // Token not created yet
      },
    },
  });

  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = {
      userId: "user_1",
      orgId: "org_1",
      walletAddress: "WalletABC123456789012345678901234567890",
      type: "jwt",
    };
  });

  const handler = requireTokenHolding(1);
  app.get("/test/:deploymentSlug", { preHandler: [handler] }, async () => ({ ok: true }));
  await app.ready();

  const response = await app.inject({
    method: "GET",
    url: "/test/tokenized-no-token",
  });

  assert.equal(response.statusCode, 403);
  const body = response.json();
  assert.equal(body.error, "Forbidden");
  assert.ok(body.message.includes("not been created"), "Should mention token not created");

  await app.close();
  prismaAny.deployment.findFirst = origDeploymentFindFirst;
  prismaAny.agentDeployment.findFirst = origAgentDeploymentFindFirst;
});

// ============================================
// Test 8: Resolves via :id param (agent deployment path)
// ============================================

test("token gate resolves listing via :id param when deploymentSlug is absent", async () => {
  setupEnv();

  const [{ requireTokenHolding }, { prisma }] = await Promise.all([
    import("../middleware/tokenGate.js"),
    import("@wheelsai/db"),
  ]);

  const prismaAny = prisma as any;
  const origDeploymentFindFirst = prismaAny.deployment.findFirst;
  const origAgentDeploymentFindFirst = prismaAny.agentDeployment.findFirst;
  const origAgentTokenHolderFindUnique = prismaAny.agentTokenHolder.findUnique;

  // deployment.findFirst should not be called for the :id path
  prismaAny.deployment.findFirst = async () => null;

  let agentDeploymentCalled = false;
  prismaAny.agentDeployment.findFirst = async ({ where: _where }: any) => {
    agentDeploymentCalled = true;
    return {
      agent: {
        listing: {
          id: "listing_2",
          pricingModel: "tokenized",
          agentToken: {
            id: "token_2",
            symbol: "WAGENT",
            mintAddress: "MintXYZ1111111111111111111111111111111",
          },
        },
      },
    };
  };

  // 50 whole tokens in raw units (× 1e6) — over the min of 10.
  prismaAny.agentTokenHolder.findUnique = async () => ({
    balanceRaw: 50_000_000n,
  });

  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as any).auth = {
      userId: "user_1",
      orgId: "org_1",
      walletAddress: "WalletABC123456789012345678901234567890",
      type: "jwt",
    };
  });

  const handler = requireTokenHolding(10);
  app.get("/test/:id", { preHandler: [handler] }, async () => ({ ok: true }));
  await app.ready();

  const response = await app.inject({
    method: "GET",
    url: "/test/agent_deploy_123",
  });

  assert.equal(response.statusCode, 200);
  assert.ok(agentDeploymentCalled, "Should have queried agentDeployment by id");

  await app.close();
  prismaAny.deployment.findFirst = origDeploymentFindFirst;
  prismaAny.agentDeployment.findFirst = origAgentDeploymentFindFirst;
  prismaAny.agentTokenHolder.findUnique = origAgentTokenHolderFindUnique;
});
