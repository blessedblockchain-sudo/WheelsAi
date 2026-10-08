import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDIT_PAID_MIN_TIMEOUT_SECONDS,
  creditPaidTimeoutSeconds,
  loadNosanaDeployConfig,
  NosanaDeployConfigError,
} from "../config/nosanaDeploy.js";
import { trainingNosanaTimeoutSeconds } from "../config/training.js";

// Nosana's 50-minute minimum for a job paid with prepaid credits (first live
// run, 2026-10-08): accepted at create, reported RUNNING, never assigned. So
// a configured timeout below it stops the boot when the API key pays, and a
// per-call one is raised. Wallet access keeps its range. Pure: the source
// object is passed in.

// Shaped like a key, and nothing more: it opens nothing.
const KEY = "nos_unit_test_key_0000000000_wxyz";
const WALLET = "[1,2,3]";

function refusal(setting: string) {
  return (err: unknown) =>
    err instanceof NosanaDeployConfigError &&
    err.message.includes(setting) &&
    err.message.includes("3000") &&
    /50 minutes/.test(err.message);
}

test("the minimum is 3000 seconds, and a shorter credit-paid timeout is raised to it", () => {
  assert.equal(CREDIT_PAID_MIN_TIMEOUT_SECONDS, 3_000);
  assert.equal(creditPaidTimeoutSeconds(600), 3_000);
  assert.equal(creditPaidTimeoutSeconds(2_999), 3_000);
  assert.equal(creditPaidTimeoutSeconds(3_000), 3_000);
  assert.equal(creditPaidTimeoutSeconds(7_200), 7_200);
});

test("with the API key paying, a configured service or batch timeout under the minimum is refused by name", () => {
  for (const timeout of ["600", "2999"]) {
    assert.throws(
      () => loadNosanaDeployConfig({ NOSANA_API_KEY: KEY, NOSANA_JOB_TIMEOUT_SECONDS: timeout }),
      refusal("NOSANA_JOB_TIMEOUT_SECONDS"),
      timeout,
    );
    assert.throws(
      () => loadNosanaDeployConfig({ NOSANA_API_KEY: KEY, NOSANA_BATCH_JOB_TIMEOUT_SECONDS: timeout }),
      refusal("NOSANA_BATCH_JOB_TIMEOUT_SECONDS"),
      timeout,
    );
  }
  // Both credentials, the API key named as the one that pays.
  assert.throws(
    () =>
      loadNosanaDeployConfig({
        NOSANA_API_KEY: KEY,
        NOSANA_WALLET_PRIVATE_KEY: WALLET,
        NOSANA_ACCESS_MODE: "api_key",
        NOSANA_JOB_TIMEOUT_SECONDS: "600",
      }),
    refusal("NOSANA_JOB_TIMEOUT_SECONDS"),
  );
  // The explicit option decides when it is given.
  assert.throws(
    () => loadNosanaDeployConfig({ NOSANA_JOB_TIMEOUT_SECONDS: "600" }, { creditPaid: true }),
    refusal("NOSANA_JOB_TIMEOUT_SECONDS"),
  );
});

test("with the API key paying, the minimum itself and the defaults pass", () => {
  const atMinimum = loadNosanaDeployConfig({
    NOSANA_API_KEY: KEY,
    NOSANA_JOB_TIMEOUT_SECONDS: "3000",
    NOSANA_BATCH_JOB_TIMEOUT_SECONDS: "3000",
  });
  assert.equal(atMinimum.jobTimeoutSeconds, 3_000);
  assert.equal(atMinimum.batchJobTimeoutSeconds, 3_000);
  const defaults = loadNosanaDeployConfig({ NOSANA_API_KEY: KEY });
  assert.equal(defaults.jobTimeoutSeconds, 7_200);
  assert.equal(defaults.batchJobTimeoutSeconds, 21_600);
});

test("wallet access keeps its range: 600 seconds is still accepted", () => {
  for (const source of [
    { NOSANA_JOB_TIMEOUT_SECONDS: "600", NOSANA_BATCH_JOB_TIMEOUT_SECONDS: "600" },
    { NOSANA_WALLET_PRIVATE_KEY: WALLET, NOSANA_JOB_TIMEOUT_SECONDS: "600", NOSANA_BATCH_JOB_TIMEOUT_SECONDS: "600" },
    {
      // The key is loaded for old rows only: the wallet pays.
      NOSANA_API_KEY: KEY,
      NOSANA_WALLET_PRIVATE_KEY: WALLET,
      NOSANA_ACCESS_MODE: "wallet",
      NOSANA_JOB_TIMEOUT_SECONDS: "600",
      NOSANA_BATCH_JOB_TIMEOUT_SECONDS: "600",
    },
  ]) {
    const cfg = loadNosanaDeployConfig(source);
    assert.equal(cfg.jobTimeoutSeconds, 600);
    assert.equal(cfg.batchJobTimeoutSeconds, 600);
  }
});

test("validateEnv stops the boot on a credit-paid timeout under the minimum, naming the setting", async () => {
  await import("./unitEnv.js");
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  const base = {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai",
    JWT_SECRET: "12345678901234567890123456789012",
  };
  assert.throws(
    () => validateEnv({ ...base, NOSANA_API_KEY: KEY, NOSANA_JOB_TIMEOUT_SECONDS: "600" }),
    (err: unknown) =>
      err instanceof EnvValidationError && /NOSANA_JOB_TIMEOUT_SECONDS=600 is below 3000/.test(err.message),
  );
  assert.throws(
    () => validateEnv({ ...base, NOSANA_API_KEY: KEY, NOSANA_BATCH_JOB_TIMEOUT_SECONDS: "1800" }),
    (err: unknown) =>
      err instanceof EnvValidationError && /NOSANA_BATCH_JOB_TIMEOUT_SECONDS=1800 is below 3000/.test(err.message),
  );
  assert.doesNotThrow(() => validateEnv({ ...base, NOSANA_API_KEY: KEY, NOSANA_JOB_TIMEOUT_SECONDS: "3000" }));
  assert.doesNotThrow(() => validateEnv({ ...base, NOSANA_WALLET_PRIVATE_KEY: WALLET, NOSANA_JOB_TIMEOUT_SECONDS: "600" }));
  assert.doesNotThrow(() => validateEnv({ ...base, NOSANA_JOB_TIMEOUT_SECONDS: "600" }));
});

test("a training job's Nosana timeout is the run limit plus the allowance, and at least the credit-paid minimum", () => {
  const wallet = { setupAllowanceSeconds: 900 };
  const credits = { setupAllowanceSeconds: 900, nosanaMinTimeoutSeconds: CREDIT_PAID_MIN_TIMEOUT_SECONDS };
  // 30 minutes of training: 45 minutes with a wallet, 50 with credits.
  assert.equal(trainingNosanaTimeoutSeconds(wallet, 1_800), 2_700);
  assert.equal(trainingNosanaTimeoutSeconds(credits, 1_800), 3_000);
  // A longer run is unchanged in both.
  assert.equal(trainingNosanaTimeoutSeconds(wallet, 7_200), 8_100);
  assert.equal(trainingNosanaTimeoutSeconds(credits, 7_200), 8_100);
  assert.equal(trainingNosanaTimeoutSeconds({ setupAllowanceSeconds: 900, nosanaMinTimeoutSeconds: 0 }, 600), 1_500);
});
