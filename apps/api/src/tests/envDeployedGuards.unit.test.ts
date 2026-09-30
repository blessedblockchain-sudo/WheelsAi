import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV ??= "development";
process.env.LOG_LEVEL ??= "error";
process.env.DATABASE_URL ??= "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET ??= "12345678901234567890123456789012";

// Staging runs with real keys as a production rehearsal. Before, every
// production guard was skipped for NODE_ENV=staging and CORS reflected any
// origin with credentials.
const STAGING: Record<string, string> = {
  NODE_ENV: "staging",
  DATABASE_URL: "postgresql://u:p@db:5432/app",
  JWT_SECRET: "a".repeat(32),
  ENCRYPTION_KEY: "b".repeat(32),
  CORS_ORIGIN: "https://staging.example.app",
};

const { validateEnv, EnvValidationError } = await import("../config/env.js");

test("staging baseline passes", () => {
  assert.doesNotThrow(() => validateEnv({ ...STAGING }));
});

for (const [name, override] of [
  ["mock checkout", { ALLOW_MOCK_CHECKOUT: "true" }],
  ["Nosana mock", { ALLOW_NOSANA_MOCK: "true" }],
  ["missing ENCRYPTION_KEY", { ENCRYPTION_KEY: "" }],
  ["ENCRYPTION_KEY equal to JWT_SECRET", { ENCRYPTION_KEY: "a".repeat(32) }],
  ["default localhost CORS", { CORS_ORIGIN: "http://localhost:3000" }],
  ["http PUBLIC_API_URL", { PUBLIC_API_URL: "http://api.example.app" }],
] as const) {
  test(`staging refuses ${name}`, () => {
    const envIn: Record<string, string | undefined> = { ...STAGING, ...override };
    if (envIn.ENCRYPTION_KEY === "") delete envIn.ENCRYPTION_KEY;
    assert.throws(() => validateEnv(envIn as Record<string, string>), EnvValidationError);
  });
}

test("staging may run the devnet SOL top-up rail; production may not", () => {
  assert.doesNotThrow(() => validateEnv({ ...STAGING, ALLOW_DEVNET_WALLET_TOPUPS: "true" }));
  assert.throws(
    () =>
      validateEnv({
        ...STAGING,
        NODE_ENV: "production",
        ALLOW_DEVNET_WALLET_TOPUPS: "true",
      }),
    EnvValidationError,
  );
});

test("COOKIE_DOMAIN accepts a parent domain and rejects junk", () => {
  assert.equal(validateEnv({ ...STAGING, COOKIE_DOMAIN: ".example.app" }).COOKIE_DOMAIN, ".example.app");
  assert.throws(() => validateEnv({ ...STAGING, COOKIE_DOMAIN: "https://example.app/" }));
});
