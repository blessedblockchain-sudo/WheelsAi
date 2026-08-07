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

// A structurally valid devnet pubkey for tests that enable x402.
const REAL_TREASURY = "2BFEMhwhA1hakQ4J7P4tNeMQZW4k3J6tziumWncVobkH";

test("production: fully-wired x402 passes", async () => {
  const { validateEnv } = await import("../config/env.js");
  assert.doesNotThrow(() =>
    validateEnv({
      ...PROD_BASE,
      X402_ENABLED: "true",
      X402_SUBMIT_TRANSACTIONS: "true",
      X402_SETTLEMENT_WORKER_ENABLED: "true",
      TREASURY_WALLET_ADDRESS: REAL_TREASURY,
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
    TREASURY_WALLET_ADDRESS: REAL_TREASURY,
  });
  assert.equal(data.X402_ENABLED, true);
  assert.equal(data.X402_SUBMIT_TRANSACTIONS, false);
});

// T7: the default TREASURY_WALLET_ADDRESS is the all-ones System Program
// address — an address nobody controls. An enabled x402 rail advertising
// it as payTo burns every client payment, so the combination is refused
// in EVERY environment, not just production.

test("X402_ENABLED with the all-ones default treasury is boot-fatal in every environment", async () => {
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  for (const nodeEnv of ["development", "production"]) {
    assert.throws(
      () =>
        validateEnv({
          ...PROD_BASE,
          NODE_ENV: nodeEnv,
          X402_ENABLED: "true",
          X402_SUBMIT_TRANSACTIONS: "true",
          X402_SETTLEMENT_WORKER_ENABLED: "true",
          // TREASURY_WALLET_ADDRESS deliberately unset → all-ones default
        }),
      EnvValidationError,
      nodeEnv
    );
  }
});

test("X402_ENABLED with a malformed treasury address is boot-fatal", async () => {
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  assert.throws(
    () =>
      validateEnv({
        NODE_ENV: "development",
        DATABASE_URL: PROD_BASE.DATABASE_URL,
        JWT_SECRET: PROD_BASE.JWT_SECRET,
        X402_ENABLED: "true",
        TREASURY_WALLET_ADDRESS: "not-a-solana-address-0OIl",
      }),
    EnvValidationError
  );
});

test("x402 disabled: the default treasury placeholder stays legal", async () => {
  const { validateEnv } = await import("../config/env.js");
  assert.doesNotThrow(() =>
    validateEnv({
      NODE_ENV: "development",
      DATABASE_URL: PROD_BASE.DATABASE_URL,
      JWT_SECRET: PROD_BASE.JWT_SECRET,
    })
  );
});
