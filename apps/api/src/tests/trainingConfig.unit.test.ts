import assert from "node:assert/strict";
import test from "node:test";

import {
  TRAINING_IMAGE_PATTERN,
  TRAINING_MIN_RUNTIME_SECONDS,
  TRAINING_TRANSFER_URL_MAX_TTL_SECONDS,
  TrainingConfigError,
  loadTrainingConfig,
  trainingNosanaTimeoutSeconds,
  trainingRunLimitBounds,
  trainingTransferUrlTtlSeconds,
} from "../config/training.js";

const DIGEST = "a".repeat(64);
const IMAGE = `registry.gitlab.com/bprime/wheelsai/trainer@sha256:${DIGEST}`;

test("defaults: no image, the poller on, and the documented limits", () => {
  const config = loadTrainingConfig({});
  assert.deepEqual(config.image, { configured: false, reason: "TRAINING_IMAGE not set" });
  assert.equal(config.hfToken, undefined);
  assert.equal(config.pollIntervalMs, 15_000);
  assert.equal(config.queueTimeoutSeconds, 1_800);
  assert.equal(config.setupAllowanceSeconds, 900);
  assert.equal(config.maxActiveJobsPerOrg, 2);
  assert.equal(config.freeFailuresPerDay, 3);
  assert.equal(config.adapterMaxBytes, 2 * 1024 ** 3);
  // The storage half is untouched by the job settings.
  assert.equal(config.storage.driver, null);
  assert.equal(config.datasetMaxBytes, 200 * 1024 ** 2);
});

test("image: a reference pinned by digest is accepted", () => {
  assert.deepEqual(loadTrainingConfig({ TRAINING_IMAGE: IMAGE }).image, {
    configured: true,
    reference: IMAGE,
    registry: null,
  });
  for (const reference of [
    `docker.io/wheelsai/trainer@sha256:${DIGEST}`,
    `registry.gitlab.com/bprime/wheelsai/trainer:1.0.0@sha256:${DIGEST}`,
    `localhost:5000/trainer@sha256:${DIGEST}`,
    `  ${IMAGE}  `,
  ]) {
    assert.equal(loadTrainingConfig({ TRAINING_IMAGE: reference }).image.configured, true, reference);
  }
});

test("image: a tag alone, or anything that is not a reference, is not configured - and says why", () => {
  for (const reference of [
    "ghcr.io/wheelsai/training-qlora:latest",
    "registry.gitlab.com/bprime/wheelsai/trainer",
    `trainer@sha256:${DIGEST}`,
    `registry.example.com/trainer@sha256:${"a".repeat(63)}`,
    `registry.example.com/trainer@sha256:${DIGEST.toUpperCase()}`,
    `registry.example.com/trainer@sha256:${DIGEST} --privileged`,
    `registry.example.com/${"a".repeat(600)}@sha256:${DIGEST}`,
  ]) {
    const image = loadTrainingConfig({ TRAINING_IMAGE: reference }).image;
    assert.equal(image.configured, false, reference);
    if (!image.configured) assert.match(image.reason, /pinned by digest/);
    // The over-long one fits the pattern; its length is what refuses it.
    if (reference.length <= 512) assert.equal(TRAINING_IMAGE_PATTERN.test(reference), false);
  }
  // A bad image never takes the storage configuration down with it.
  assert.doesNotThrow(() => loadTrainingConfig({ TRAINING_IMAGE: "nonsense" }));
  assert.equal(loadTrainingConfig({ TRAINING_IMAGE: "" }).image.configured, false, "empty means unset");
});

test("image: registry credentials are all three or none", () => {
  const all = {
    TRAINING_IMAGE: IMAGE,
    TRAINING_IMAGE_REGISTRY_SERVER: "registry.gitlab.com",
    TRAINING_IMAGE_REGISTRY_USERNAME: "gitlab+deploy-token-1",
    TRAINING_IMAGE_REGISTRY_PASSWORD: "example-password",
  };
  assert.deepEqual(loadTrainingConfig(all).image, {
    configured: true,
    reference: IMAGE,
    registry: {
      server: "registry.gitlab.com",
      username: "gitlab+deploy-token-1",
      password: "example-password",
    },
  });

  const { TRAINING_IMAGE_REGISTRY_PASSWORD: _password, ...partial } = all;
  const image = loadTrainingConfig(partial).image;
  assert.equal(image.configured, false, "a partial set is a refusal, not a guess");
  if (!image.configured) {
    assert.match(image.reason, /TRAINING_IMAGE_REGISTRY_PASSWORD not set/);
    assert.equal(image.reason.includes("gitlab+deploy-token-1"), false, "no value in the reason");
  }

  const badServer = loadTrainingConfig({ ...all, TRAINING_IMAGE_REGISTRY_SERVER: "registry.gitlab.com/path" }).image;
  assert.equal(badServer.configured, false);
});

test("HF_TOKEN is carried so gated models can be offered", () => {
  assert.equal(loadTrainingConfig({ HF_TOKEN: "hf_exampleTokenForTests0123" }).hfToken, "hf_exampleTokenForTests0123");
  assert.equal(loadTrainingConfig({ HF_TOKEN: "  " }).hfToken, undefined);
});

test("poller: 0 turns it off; anything else is a sane interval", () => {
  assert.equal(loadTrainingConfig({ TRAINING_POLL_INTERVAL_MS: "0" }).pollIntervalMs, 0);
  assert.equal(loadTrainingConfig({ TRAINING_POLL_INTERVAL_MS: "5000" }).pollIntervalMs, 5_000);
  for (const value of ["500", "-1", "999", "600001", "fast", "1500.5"]) {
    assert.throws(() => loadTrainingConfig({ TRAINING_POLL_INTERVAL_MS: value }), TrainingConfigError, value);
  }
});

test("limits: each has bounds and a bad value is a configuration error", () => {
  const ok = loadTrainingConfig({
    TRAINING_QUEUE_TIMEOUT_SECONDS: "600",
    TRAINING_SETUP_ALLOWANCE_SECONDS: "0",
    TRAINING_MAX_ACTIVE_JOBS_PER_ORG: "5",
    TRAINING_FREE_FAILURES_PER_DAY: "10",
    TRAINING_ADAPTER_MAX_BYTES: String(1024 ** 3),
  });
  assert.equal(ok.queueTimeoutSeconds, 600);
  assert.equal(ok.setupAllowanceSeconds, 0);
  assert.equal(ok.maxActiveJobsPerOrg, 5);
  assert.equal(ok.freeFailuresPerDay, 10);
  assert.equal(ok.adapterMaxBytes, 1024 ** 3);

  for (const [name, value] of [
    ["TRAINING_QUEUE_TIMEOUT_SECONDS", "59"],
    ["TRAINING_QUEUE_TIMEOUT_SECONDS", "86401"],
    ["TRAINING_SETUP_ALLOWANCE_SECONDS", "-1"],
    ["TRAINING_SETUP_ALLOWANCE_SECONDS", "7201"],
    ["TRAINING_MAX_ACTIVE_JOBS_PER_ORG", "0"],
    ["TRAINING_MAX_ACTIVE_JOBS_PER_ORG", "2.5"],
    ["TRAINING_FREE_FAILURES_PER_DAY", "0"],
    ["TRAINING_FREE_FAILURES_PER_DAY", "1001"],
    ["TRAINING_ADAPTER_MAX_BYTES", "1000"],
    ["TRAINING_ADAPTER_MAX_BYTES", String(6 * 1024 ** 3)],
  ] as const) {
    assert.throws(() => loadTrainingConfig({ [name]: value }), TrainingConfigError, `${name}=${value}`);
  }
});

test("run limit: at most the batch job timeout minus the set-up allowance", () => {
  const config = loadTrainingConfig({});
  assert.deepEqual(trainingRunLimitBounds(config, 21_600), {
    minSeconds: TRAINING_MIN_RUNTIME_SECONDS,
    maxSeconds: 20_700,
  });
  assert.equal(TRAINING_MIN_RUNTIME_SECONDS, 300);
  // A batch timeout too short to leave any run limit: max falls below min.
  const tight = trainingRunLimitBounds(config, 1_000);
  assert.ok(tight.maxSeconds < tight.minSeconds);
  assert.equal(trainingRunLimitBounds({ setupAllowanceSeconds: 0 }, 21_600).maxSeconds, 21_600);
});

test("Nosana timeout: the user's run limit plus the allowance, never past the batch timeout", () => {
  const config = loadTrainingConfig({});
  assert.equal(trainingNosanaTimeoutSeconds(config, 3_600), 4_500);
  const { maxSeconds } = trainingRunLimitBounds(config, 21_600);
  assert.equal(trainingNosanaTimeoutSeconds(config, maxSeconds), 21_600);
});

test("transfer URLs live for the queue, the run, the allowance and a margin; seven days at most", () => {
  const config = loadTrainingConfig({});
  // 1800 queue + 3600 run + 900 allowance + 3600 margin.
  assert.equal(trainingTransferUrlTtlSeconds(config, 3_600), 9_900);
  assert.ok(
    trainingTransferUrlTtlSeconds(config, 3_600) >
      config.queueTimeoutSeconds + trainingNosanaTimeoutSeconds(config, 3_600),
    "outlives the longest a job can take",
  );
  assert.equal(TRAINING_TRANSFER_URL_MAX_TTL_SECONDS, 604_800);
  assert.equal(trainingTransferUrlTtlSeconds(config, 7 * 86_400), 604_800, "capped");
});
