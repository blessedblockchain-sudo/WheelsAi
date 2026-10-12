import "./unitEnv.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

// @ts-expect-error The door is a plain .mjs program outside this workspace and ships no types.
import { ADAPTER_TARGET, EVENTS_TARGET, MAX_EVENT_BYTES } from "../../../../infra/gpu-door/door.mjs";
import { buildTrainingDeps } from "../services/buildTrainingDeps.js";
import { adapterDownloadUrl } from "../services/fineTunedModels.js";
import { trainingCallbackUrl } from "../services/trainingJobs.js";
import { TRAINING_CALLBACK_MAX_BYTES } from "../services/trainingWebhookAuth.js";

// The door (infra/gpu-door) stands between a public tunnel and this API on a
// development machine. It passes two request shapes and answers 404 to
// everything else, and neither caller tries again after a 404: a training
// run would go silent and a deployment would never get its adapter. So the
// shapes the door passes are held here to the addresses this API builds.

const target = (address: string) => {
  const url = new URL(address);
  return `${url.pathname}${url.search}`;
};

test("the door passes the address a training run reports to, as this API builds it", () => {
  const deps = buildTrainingDeps({} as never);
  for (let i = 0; i < 50; i += 1) {
    const address = trainingCallbackUrl("https://door.example.com", deps.newId(), deps.newNonce());
    assert.match(target(address), EVENTS_TARGET as RegExp, address);
  }
});

test("the door passes the adapter address, as this API builds it", () => {
  for (const runGeneration of [0, 1, 7, 42, 999_999_999]) {
    const address = adapterDownloadUrl(
      "https://door.example.com/",
      { fineTunedModelId: randomUUID(), deploymentId: randomUUID(), runGeneration },
      "a-signing-secret-for-this-test",
    );
    assert.match(target(address), ADAPTER_TARGET as RegExp, address);
  }
});

test("the door's limit for a progress report is the route's own", () => {
  assert.equal(MAX_EVENT_BYTES, TRAINING_CALLBACK_MAX_BYTES);
});
