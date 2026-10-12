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
  ["http GPU_FACING_API_URL", { GPU_FACING_API_URL: "http://gpu.example.app" }],
  ["localhost GPU_FACING_API_URL", { GPU_FACING_API_URL: "https://localhost:4000" }],
] as const) {
  test(`staging refuses ${name}`, () => {
    const envIn: Record<string, string | undefined> = { ...STAGING, ...override };
    if (envIn.ENCRYPTION_KEY === "") delete envIn.ENCRYPTION_KEY;
    assert.throws(() => validateEnv(envIn as Record<string, string>), EnvValidationError);
  });
}

test("the retired SOL test settings are ignored, and said to be", async () => {
  const { retiredSettingsIn } = await import("../config/env.js");
  const old = { ALLOW_DEVNET_WALLET_TOPUPS: "true", WALLET_TOPUP_SOL_PRICE_USD: "150" };
  // An old value can change nothing, so it never stops the start.
  for (const base of [STAGING, { ...STAGING, NODE_ENV: "production" }]) {
    const data = validateEnv({ ...base, ...old }) as Record<string, unknown>;
    assert.equal("ALLOW_DEVNET_WALLET_TOPUPS" in data, false);
    assert.equal("WALLET_TOPUP_SOL_PRICE_USD" in data, false);
    assert.equal(data.SOL_PRICE_SOURCE, "off", "an old price never switches SOL on");
  }
  const lines = retiredSettingsIn(old);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^ALLOW_DEVNET_WALLET_TOPUPS is no longer a setting and is ignored: .*SOL_PRICE_SOURCE/);
  assert.match(lines[1]!, /^WALLET_TOPUP_SOL_PRICE_USD is no longer a setting and is ignored: .*SOL_PRICE_STATIC_USD/);
  for (const line of lines) assert.doesNotMatch(line, /150|true/, "a retired setting's value is never repeated");
  assert.deepEqual(retiredSettingsIn({}), []);
  assert.deepEqual(retiredSettingsIn({ ALLOW_DEVNET_WALLET_TOPUPS: "" }), []);
});

test("outside development the wallet rail needs the worker that finishes top-ups", () => {
  const rail = { WALLET_TOPUPS_ENABLED: "true", WALLET_MASTER_KEY: "c".repeat(48) };
  assert.doesNotThrow(() => validateEnv({ ...STAGING, ...rail }));
  assert.throws(
    () => validateEnv({ ...STAGING, ...rail, TOPUP_RECONCILE_INTERVAL_MS: "0" }),
    /WALLET_TOPUPS_ENABLED requires TOPUP_RECONCILE_INTERVAL_MS above 0/,
  );
  // With the rail off, the worker may be off.
  assert.doesNotThrow(() => validateEnv({ ...STAGING, TOPUP_RECONCILE_INTERVAL_MS: "0" }));
  // Development may run the rail by hand, without the worker.
  assert.doesNotThrow(() =>
    validateEnv({ ...STAGING, NODE_ENV: "development", ...rail, TOPUP_RECONCILE_INTERVAL_MS: "0" }),
  );
});

test("COOKIE_DOMAIN accepts a parent domain and rejects junk", () => {
  assert.equal(validateEnv({ ...STAGING, COOKIE_DOMAIN: ".example.app" }).COOKIE_DOMAIN, ".example.app");
  assert.throws(() => validateEnv({ ...STAGING, COOKIE_DOMAIN: "https://example.app/" }));
});

test("GPU_FACING_API_URL: https on a public host passes when deployed; anything goes in development", () => {
  assert.doesNotThrow(() => validateEnv({ ...STAGING, GPU_FACING_API_URL: "https://gpu.example.app" }));
  assert.throws(
    () => validateEnv({ ...STAGING, GPU_FACING_API_URL: "http://gpu.example.app" }),
    /GPU_FACING_API_URL must be an https URL on a public host outside development/,
  );
  const development = { ...STAGING, NODE_ENV: "development" };
  assert.doesNotThrow(() => validateEnv({ ...development, GPU_FACING_API_URL: "http://localhost:4180" }));
  assert.throws(() => validateEnv({ ...development, GPU_FACING_API_URL: "not an address" }));
});
