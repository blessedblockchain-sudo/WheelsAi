import assert from "node:assert/strict";
import test from "node:test";

// The environment of public chat (config/env.ts): the Turnstile pair rule and
// the limit defaults. validateEnv is pure; process.env only needs to satisfy
// the module-level parse that importing the file triggers.

const BASE = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai",
  JWT_SECRET: "12345678901234567890123456789012",
};

async function load() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? BASE.DATABASE_URL;
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? BASE.JWT_SECRET;
  return import("../config/env.js");
}

test("half a Turnstile configuration is refused, in every environment", async () => {
  const { validateEnv, EnvValidationError } = await load();
  for (const half of [{ TURNSTILE_SITE_KEY: "0x4AAA-site" }, { TURNSTILE_SECRET_KEY: "0x4AAA-secret" }]) {
    assert.throws(
      () => validateEnv({ ...BASE, ...half }),
      (err: unknown) => err instanceof EnvValidationError && /TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY/.test(err.message),
      JSON.stringify(Object.keys(half)),
    );
    // An empty value from a .env file is "unset", so the other half alone is still half.
    assert.throws(() => validateEnv({ ...BASE, TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "", ...half }));
  }
});

test("both Turnstile keys, or neither, is accepted", async () => {
  const { validateEnv } = await load();
  const both = validateEnv({ ...BASE, TURNSTILE_SITE_KEY: "0x4AAA-site", TURNSTILE_SECRET_KEY: "0x4AAA-secret" });
  assert.equal(both.TURNSTILE_SITE_KEY, "0x4AAA-site");
  const neither = validateEnv({ ...BASE });
  assert.equal(neither.TURNSTILE_SITE_KEY, undefined);
  assert.equal(neither.TURNSTILE_SECRET_KEY, undefined);
  const empty = validateEnv({ ...BASE, TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "" });
  assert.equal(empty.TURNSTILE_SITE_KEY, undefined, "empty strings mean unset");
});

test("the public limits have defaults, and the price of a funded message has none", async () => {
  const { validateEnv } = await load();
  const data = validateEnv({ ...BASE });
  for (const name of [
    "WIDGET_PER_IP_PER_MINUTE",
    "WIDGET_PER_IP_PER_DAY",
    "WIDGET_PER_KEY_PER_MINUTE",
    "WIDGET_DEFAULT_DAILY_CAP",
    "TRIAL_MESSAGES_PER_SESSION",
    "TRIAL_PER_IP_PER_HOUR",
    "TRIAL_SIGNED_IN_PER_DAY",
    "TRIAL_GLOBAL_PER_MINUTE",
  ] as const) {
    assert.ok(Number.isInteger(data[name]) && data[name] > 0, name);
  }
  assert.ok(data.TRIAL_BASE_DAILY_MESSAGES >= 0);
  // A made-up price would debit real credits: unset stays unset.
  assert.equal(data.TRIAL_FUNDED_MESSAGE_CENTS, undefined);
  assert.equal(validateEnv({ ...BASE, TRIAL_FUNDED_MESSAGE_CENTS: "" }).TRIAL_FUNDED_MESSAGE_CENTS, undefined);
  assert.equal(validateEnv({ ...BASE, TRIAL_FUNDED_MESSAGE_CENTS: "2" }).TRIAL_FUNDED_MESSAGE_CENTS, 2);
  assert.throws(() => validateEnv({ ...BASE, TRIAL_FUNDED_MESSAGE_CENTS: "0" }));
  assert.throws(() => validateEnv({ ...BASE, WIDGET_PER_IP_PER_MINUTE: "0" }));
});
