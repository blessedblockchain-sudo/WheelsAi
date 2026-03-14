import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// A valid-looking Solana wallet address (base58, 32-44 chars)
const VALID_WALLET = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const SHORT_WALLET = "abc"; // too short for the schema

// ============================================
// Test 1: POST /wallet/nonce — happy path
// ============================================

test("wallet/nonce returns a nonce string for a valid wallet address", async () => {
  setupEnv();

  const [{ authRoutes }, { env }] = await Promise.all([
    import("../routes/auth.js"),
    import("../config/env.js"),
  ]);

  // Stub the auth service's generateNonce so we don't need Redis
  const authService = await import("../services/auth.js");
  const originalGenerateNonce = authService.generateNonce;
  (authService as any).generateNonce = async (walletAddress: string) =>
    `WheelsAI authentication request.\n\nWallet: ${walletAddress}\nNonce: test_nonce_12345\nTimestamp: 1700000000000`;

  const app = Fastify();

  // Register JWT plugin (required by auth routes)
  await app.register(await import("@fastify/jwt"), {
    secret: env.JWT_SECRET,
    sign: { expiresIn: "24h" },
  });
  await app.register(await import("@fastify/cookie"), {
    secret: env.JWT_SECRET,
    hook: "onRequest",
  });
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    request.auth = null;
  });

  await app.register(authRoutes, { prefix: "/api/auth" });

  const response = await app.inject({
    method: "POST",
    url: "/api/auth/wallet/nonce",
    payload: { walletAddress: VALID_WALLET },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.ok(typeof body.nonce === "string", "nonce should be a string");
  assert.ok(body.nonce.length > 0, "nonce should not be empty");
  assert.equal(body.walletAddress, VALID_WALLET);

  await app.close();
  (authService as any).generateNonce = originalGenerateNonce;
});

// ============================================
// Test 2: POST /wallet/nonce — missing wallet address
// ============================================

test("wallet/nonce returns 400 when walletAddress is missing", async () => {
  setupEnv();

  const [{ authRoutes }, { env }] = await Promise.all([
    import("../routes/auth.js"),
    import("../config/env.js"),
  ]);

  const app = Fastify();
  await app.register(await import("@fastify/jwt"), {
    secret: env.JWT_SECRET,
    sign: { expiresIn: "24h" },
  });
  await app.register(await import("@fastify/cookie"), {
    secret: env.JWT_SECRET,
    hook: "onRequest",
  });
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    request.auth = null;
  });

  await app.register(authRoutes, { prefix: "/api/auth" });

  const response = await app.inject({
    method: "POST",
    url: "/api/auth/wallet/nonce",
    payload: {},
  });

  // Zod validation should reject missing walletAddress
  assert.ok(
    response.statusCode >= 400 && response.statusCode < 500,
    `Expected 4xx status, got ${response.statusCode}`
  );

  await app.close();
});

// ============================================
// Test 3: POST /wallet/nonce — wallet address too short
// ============================================

test("wallet/nonce returns 4xx when walletAddress is too short", async () => {
  setupEnv();

  const [{ authRoutes }, { env }] = await Promise.all([
    import("../routes/auth.js"),
    import("../config/env.js"),
  ]);

  const app = Fastify();
  await app.register(await import("@fastify/jwt"), {
    secret: env.JWT_SECRET,
    sign: { expiresIn: "24h" },
  });
  await app.register(await import("@fastify/cookie"), {
    secret: env.JWT_SECRET,
    hook: "onRequest",
  });
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    request.auth = null;
  });

  await app.register(authRoutes, { prefix: "/api/auth" });

  const response = await app.inject({
    method: "POST",
    url: "/api/auth/wallet/nonce",
    payload: { walletAddress: SHORT_WALLET },
  });

  assert.ok(
    response.statusCode >= 400 && response.statusCode < 500,
    `Expected 4xx for short wallet, got ${response.statusCode}`
  );

  await app.close();
});

// ============================================
// Test 4: POST /wallet/verify — invalid nonce returns 401
// ============================================

test("wallet/verify returns 401 when nonce does not match stored value", async () => {
  setupEnv();

  const [{ authRoutes }, { env }] = await Promise.all([
    import("../routes/auth.js"),
    import("../config/env.js"),
  ]);

  // Stub getNonce to return a different nonce than what we send
  const authService = await import("../services/auth.js");
  const originalGetNonce = authService.getNonce;
  (authService as any).getNonce = async () => "stored_nonce_does_not_match";

  const app = Fastify();
  await app.register(await import("@fastify/jwt"), {
    secret: env.JWT_SECRET,
    sign: { expiresIn: "24h" },
  });
  await app.register(await import("@fastify/cookie"), {
    secret: env.JWT_SECRET,
    hook: "onRequest",
  });
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    request.auth = null;
  });

  await app.register(authRoutes, { prefix: "/api/auth" });

  const response = await app.inject({
    method: "POST",
    url: "/api/auth/wallet/verify",
    payload: {
      walletAddress: VALID_WALLET,
      signature: "fakesignaturebase58encoded",
      nonce: "wrong_nonce_value",
    },
  });

  assert.equal(response.statusCode, 401);
  const body = response.json();
  assert.equal(body.error, "Unauthorized");
  assert.ok(body.message.toLowerCase().includes("nonce"), "Error message should mention nonce");

  await app.close();
  (authService as any).getNonce = originalGetNonce;
});

// ============================================
// Test 5: POST /wallet/verify — expired nonce (null from Redis)
// ============================================

test("wallet/verify returns 401 when nonce has expired (Redis returns null)", async () => {
  setupEnv();

  const [{ authRoutes }, { env }] = await Promise.all([
    import("../routes/auth.js"),
    import("../config/env.js"),
  ]);

  const authService = await import("../services/auth.js");
  const originalGetNonce = authService.getNonce;
  // Simulate expired nonce — Redis returns null
  (authService as any).getNonce = async () => null;

  const app = Fastify();
  await app.register(await import("@fastify/jwt"), {
    secret: env.JWT_SECRET,
    sign: { expiresIn: "24h" },
  });
  await app.register(await import("@fastify/cookie"), {
    secret: env.JWT_SECRET,
    hook: "onRequest",
  });
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    request.auth = null;
  });

  await app.register(authRoutes, { prefix: "/api/auth" });

  const response = await app.inject({
    method: "POST",
    url: "/api/auth/wallet/verify",
    payload: {
      walletAddress: VALID_WALLET,
      signature: "fakesignaturebase58encoded",
      nonce: "some_nonce_that_expired",
    },
  });

  assert.equal(response.statusCode, 401);
  const body = response.json();
  assert.equal(body.error, "Unauthorized");

  await app.close();
  (authService as any).getNonce = originalGetNonce;
});

// ============================================
// Test 6: POST /wallet/verify — invalid signature returns 401
// ============================================

test("wallet/verify returns 401 when signature is invalid", async () => {
  setupEnv();

  const [{ authRoutes }, { env }] = await Promise.all([
    import("../routes/auth.js"),
    import("../config/env.js"),
  ]);

  const authService = await import("../services/auth.js");
  const originalGetNonce = authService.getNonce;
  const originalVerify = authService.verifySolanaSignature;

  const testNonce = "matching_nonce_value";
  // getNonce returns the same nonce we send, so the nonce check passes
  (authService as any).getNonce = async () => testNonce;
  // But the signature check fails
  (authService as any).verifySolanaSignature = () => false;

  const app = Fastify();
  await app.register(await import("@fastify/jwt"), {
    secret: env.JWT_SECRET,
    sign: { expiresIn: "24h" },
  });
  await app.register(await import("@fastify/cookie"), {
    secret: env.JWT_SECRET,
    hook: "onRequest",
  });
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    request.auth = null;
  });

  await app.register(authRoutes, { prefix: "/api/auth" });

  const response = await app.inject({
    method: "POST",
    url: "/api/auth/wallet/verify",
    payload: {
      walletAddress: VALID_WALLET,
      signature: "invalidsignature",
      nonce: testNonce,
    },
  });

  assert.equal(response.statusCode, 401);
  const body = response.json();
  assert.equal(body.error, "Unauthorized");
  assert.ok(
    body.message.toLowerCase().includes("signature"),
    "Error message should mention signature"
  );

  await app.close();
  (authService as any).getNonce = originalGetNonce;
  (authService as any).verifySolanaSignature = originalVerify;
});

// ============================================
// Test 7: POST /wallet/verify — missing fields returns 4xx
// ============================================

test("wallet/verify returns 4xx when required fields are missing", async () => {
  setupEnv();

  const [{ authRoutes }, { env }] = await Promise.all([
    import("../routes/auth.js"),
    import("../config/env.js"),
  ]);

  const app = Fastify();
  await app.register(await import("@fastify/jwt"), {
    secret: env.JWT_SECRET,
    sign: { expiresIn: "24h" },
  });
  await app.register(await import("@fastify/cookie"), {
    secret: env.JWT_SECRET,
    hook: "onRequest",
  });
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    request.auth = null;
  });

  await app.register(authRoutes, { prefix: "/api/auth" });

  // Missing signature and nonce
  const noSig = await app.inject({
    method: "POST",
    url: "/api/auth/wallet/verify",
    payload: { walletAddress: VALID_WALLET },
  });
  assert.ok(
    noSig.statusCode >= 400 && noSig.statusCode < 500,
    `Expected 4xx for missing signature/nonce, got ${noSig.statusCode}`
  );

  // Missing walletAddress
  const noWallet = await app.inject({
    method: "POST",
    url: "/api/auth/wallet/verify",
    payload: { signature: "abc", nonce: "xyz" },
  });
  assert.ok(
    noWallet.statusCode >= 400 && noWallet.statusCode < 500,
    `Expected 4xx for missing walletAddress, got ${noWallet.statusCode}`
  );

  // Empty body
  const empty = await app.inject({
    method: "POST",
    url: "/api/auth/wallet/verify",
    payload: {},
  });
  assert.ok(
    empty.statusCode >= 400 && empty.statusCode < 500,
    `Expected 4xx for empty body, got ${empty.statusCode}`
  );

  await app.close();
});
