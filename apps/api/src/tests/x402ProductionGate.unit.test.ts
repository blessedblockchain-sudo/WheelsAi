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
      // Production takes money only on mainnet (envMoneyRails.unit.test.ts).
      SOLANA_NETWORK: "mainnet-beta",
      SOLANA_RPC_URL: "https://rpc.example.test",
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

// Payments pass, batch 8: a payment is priced in the asset it is asked for,
// so an asset with no live price cannot be asked for.
test("x402 cannot ask for NOS, and asks for SOL only with a SOL price", async () => {
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  const dev = {
    NODE_ENV: "development",
    DATABASE_URL: PROD_BASE.DATABASE_URL,
    JWT_SECRET: PROD_BASE.JWT_SECRET,
    X402_ENABLED: "true",
    TREASURY_WALLET_ADDRESS: REAL_TREASURY,
  };
  assert.throws(
    () => validateEnv({ ...dev, X402_DEFAULT_ASSET: "NOS" }),
    (err: unknown) => err instanceof EnvValidationError && /cannot ask for NOS/.test(err.message),
  );
  assert.throws(
    () => validateEnv({ ...dev, X402_DEFAULT_ASSET: "SOL" }),
    (err: unknown) => err instanceof EnvValidationError && /X402_DEFAULT_ASSET=SOL requires a SOL price/.test(err.message),
  );
  assert.doesNotThrow(() => validateEnv({ ...dev, X402_DEFAULT_ASSET: "SOL", SOL_PRICE_SOURCE: "static", SOL_PRICE_STATIC_USD: "110" }));
  assert.doesNotThrow(() => validateEnv({ ...dev, X402_DEFAULT_ASSET: "USDC" }));
  // With x402 off the setting is not judged: NOS stays a legal value.
  assert.doesNotThrow(() => validateEnv({ ...dev, X402_ENABLED: "false", X402_DEFAULT_ASSET: "NOS" }));
});

test("the quote holds for two minutes and a paid request waits thirty seconds, unless set", async () => {
  const { validateEnv } = await import("../config/env.js");
  const base = { NODE_ENV: "development", DATABASE_URL: PROD_BASE.DATABASE_URL, JWT_SECRET: PROD_BASE.JWT_SECRET };
  const data = validateEnv(base);
  assert.equal(data.X402_QUOTE_TTL_SECONDS, 120);
  assert.equal(data.X402_CONFIRM_WAIT_MS, 30_000);
  assert.throws(() => validateEnv({ ...base, X402_QUOTE_TTL_SECONDS: "5" }));
  assert.throws(() => validateEnv({ ...base, X402_CONFIRM_WAIT_MS: "10" }));
});

test("the count of settlement attempts is retired: a payment is ended by the chain alone", async () => {
  const { retiredSettingsIn, validateEnv } = await import("../config/env.js");
  const lines = retiredSettingsIn({ X402_SETTLEMENT_MAX_RETRIES: "5" });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /X402_SETTLEMENT_MAX_RETRIES is no longer a setting and is ignored/);
  const data = validateEnv({
    NODE_ENV: "development",
    DATABASE_URL: PROD_BASE.DATABASE_URL,
    JWT_SECRET: PROD_BASE.JWT_SECRET,
    X402_SETTLEMENT_MAX_RETRIES: "5",
  }) as Record<string, unknown>;
  assert.equal("X402_SETTLEMENT_MAX_RETRIES" in data, false);
});
