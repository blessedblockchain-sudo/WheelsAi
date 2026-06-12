import assert from "node:assert/strict";
import test from "node:test";

// A5 (REMEDIATION_PLAN): with X402_ENABLED and submission off, a client
// "pays" with a self-signed transaction that never lands on-chain. These
// pin the boot-fatal production couplings.

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}
setupEnv();

const PROD_BASE: Record<string, string> = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://u:p@db:5432/app",
  JWT_SECRET: "a".repeat(32),
  ENCRYPTION_KEY: "b".repeat(32),
  CORS_ORIGIN: "https://app.wheelsai.io",
};

test("production: X402_ENABLED without X402_SUBMIT_TRANSACTIONS is boot-fatal", async () => {
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  assert.throws(
    () => validateEnv({ ...PROD_BASE, X402_ENABLED: "true" }),
    EnvValidationError
  );
});

test("production: X402_ENABLED without the settlement worker is boot-fatal", async () => {
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  assert.throws(
    () =>
      validateEnv({
        ...PROD_BASE,
        X402_ENABLED: "true",
        X402_SUBMIT_TRANSACTIONS: "true",
      }),
    EnvValidationError
  );
});

test("production: fully-wired x402 passes", async () => {
  const { validateEnv } = await import("../config/env.js");
  assert.doesNotThrow(() =>
    validateEnv({
      ...PROD_BASE,
      X402_ENABLED: "true",
      X402_SUBMIT_TRANSACTIONS: "true",
      X402_SETTLEMENT_WORKER_ENABLED: "true",
    })
  );
});

test("development: verification-only mode remains allowed for local work", async () => {
  const { validateEnv } = await import("../config/env.js");
  const data = validateEnv({
    NODE_ENV: "development",
    DATABASE_URL: PROD_BASE.DATABASE_URL,
    JWT_SECRET: PROD_BASE.JWT_SECRET,
    X402_ENABLED: "true",
  });
  assert.equal(data.X402_ENABLED, true);
  assert.equal(data.X402_SUBMIT_TRANSACTIONS, false);
});
