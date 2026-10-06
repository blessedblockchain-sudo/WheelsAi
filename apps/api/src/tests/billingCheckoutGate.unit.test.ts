import assert from "node:assert/strict";
import test from "node:test";

// A1 (REMEDIATION_PLAN): the mock checkout path mints credits with no
// payment. These tests pin (1) the boot-fatal production assertions in
// config/env.ts and (2) the 501 gate on POST /api/billing/checkout when
// ALLOW_MOCK_CHECKOUT is off (the default).

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}
setupEnv();

// Minimal valid production environment for validateEnv tests.
const PROD_BASE: Record<string, string> = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://u:p@db:5432/app",
  JWT_SECRET: "a".repeat(32),
  ENCRYPTION_KEY: "b".repeat(32),
  CORS_ORIGIN: "https://app.wheelsai.io",
};

test("validateEnv: production baseline passes", async () => {
  const { validateEnv } = await import("../config/env.js");
  assert.doesNotThrow(() => validateEnv({ ...PROD_BASE }));
});

test("validateEnv: ALLOW_MOCK_CHECKOUT is boot-fatal in production", async () => {
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  assert.throws(
    () => validateEnv({ ...PROD_BASE, ALLOW_MOCK_CHECKOUT: "true" }),
    EnvValidationError
  );
});

test("validateEnv: ALLOW_NOSANA_MOCK is boot-fatal in production", async () => {
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  assert.throws(
    () => validateEnv({ ...PROD_BASE, ALLOW_NOSANA_MOCK: "true" }),
    EnvValidationError
  );
});

test("validateEnv: ENCRYPTION_KEY must differ from JWT_SECRET in production", async () => {
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  assert.throws(
    () =>
      validateEnv({
        ...PROD_BASE,
        ENCRYPTION_KEY: PROD_BASE.JWT_SECRET,
      }),
    EnvValidationError
  );
});

test("validateEnv: ALLOW_DEVNET_WALLET_TOPUPS is boot-fatal in production", async () => {
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  assert.throws(
    () => validateEnv({ ...PROD_BASE, ALLOW_DEVNET_WALLET_TOPUPS: "true" }),
    EnvValidationError
  );
});

test("validateEnv: WALLET_TOPUPS_ENABLED demands WALLET_MASTER_KEY in every environment", async () => {
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  // Without the master key there are no deposit addresses to derive —
  // a config contradiction, not a runtime 500.
  assert.throws(
    () =>
      validateEnv({
        NODE_ENV: "development",
        DATABASE_URL: PROD_BASE.DATABASE_URL,
        JWT_SECRET: PROD_BASE.JWT_SECRET,
        WALLET_TOPUPS_ENABLED: "true",
      }),
    EnvValidationError
  );
  assert.doesNotThrow(() =>
    validateEnv({
      NODE_ENV: "development",
      DATABASE_URL: PROD_BASE.DATABASE_URL,
      JWT_SECRET: PROD_BASE.JWT_SECRET,
      WALLET_TOPUPS_ENABLED: "true",
      WALLET_MASTER_KEY: "c".repeat(32),
    })
  );
});

test("validateEnv: mock checkout is allowed outside production", async () => {
  const { validateEnv } = await import("../config/env.js");
  const data = validateEnv({
    NODE_ENV: "development",
    DATABASE_URL: PROD_BASE.DATABASE_URL,
    JWT_SECRET: PROD_BASE.JWT_SECRET,
    ALLOW_MOCK_CHECKOUT: "true",
  });
  assert.equal(data.ALLOW_MOCK_CHECKOUT, true);
});

test("POST /checkout returns 501 card_payments_not_configured when neither Stripe nor the mock path is enabled", async () => {
  // ALLOW_MOCK_CHECKOUT defaults to false; setupEnv does not set it, so the
  // module-level env the route reads has the gate closed.
  const Fastify = (await import("fastify")).default;
  const { billingRoutes } = await import("../routes/billing.js");

  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request) => {
    // Stand in for the global auth hook. /checkout is now role-gated (F4), so
    // the principal needs an owner/admin role or requireRole would 403 before
    // the 501 gate this test asserts.
    (request as unknown as { auth: unknown }).auth = {
      userId: "user_1",
      orgId: "org_1",
      role: "owner",
      type: "jwt",
    };
  });
  await app.register(billingRoutes, { prefix: "/api/billing" });

  // requireRole reads the member's current role from the database, not the
  // token; without a membership row it would refuse before the 501 gate.
  const { prisma } = await import("@wheelsai/db");
  const p = prisma as unknown as { orgMember: Record<string, unknown> };
  const savedFindUnique = p.orgMember.findUnique;
  p.orgMember.findUnique = async () => ({ role: "owner" });

  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/billing/checkout",
      payload: { amount: 100 },
    });

    assert.equal(res.statusCode, 501);
    assert.equal(res.json().error, "card_payments_not_configured");
  } finally {
    p.orgMember.findUnique = savedFindUnique;
    await app.close();
  }
});
