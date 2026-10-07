import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

// The start-up log of what keeps fine-tuning from starting: one warning per
// missing setting, in operator language, and never a thrown error at boot.

for (const name of [
  "TRAINING_IMAGE",
  "STORAGE_DRIVER",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "DATASETS_BUCKET",
  "NOSANA_API_KEY",
  "NOSANA_WALLET_PRIVATE_KEY",
  "ALLOW_NOSANA_MOCK",
  "PUBLIC_API_URL",
  "HF_TOKEN",
]) {
  delete process.env[name];
}

const { logTrainingReadiness } = await import("../services/buildTrainingDeps.js");

test("start-up: each missing fine-tuning setting is logged once, as an operator sentence with its code", async () => {
  const lines: Array<{ context: Record<string, unknown>; message: string }> = [];
  await logTrainingReadiness({ warn: (context, message) => lines.push({ context, message }) });

  const codes = lines.map((line) => line.context.code);
  assert.equal(new Set(codes).size, codes.length, "one line per blocker");
  for (const code of [
    "dataset_storage_not_configured",
    "training_image_not_configured",
    "nosana_not_configured",
    "training_callbacks_not_configured",
  ]) {
    assert.ok(codes.includes(code), `${code} is logged`);
  }
  const byCode = Object.fromEntries(lines.map((line) => [line.context.code, line.message]));
  assert.match(byCode.dataset_storage_not_configured as string, /DATASETS_BUCKET/);
  assert.match(byCode.training_image_not_configured as string, /TRAINING_IMAGE not set/);
  assert.match(byCode.nosana_not_configured as string, /NOSANA_API_KEY/);
  assert.match(byCode.training_callbacks_not_configured as string, /PUBLIC_API_URL/);
  // Gated models need HF_TOKEN; the operator reads which ones are held back.
  assert.match(byCode.hf_token_required as string, /HF_TOKEN is not set/);
  for (const line of lines) assert.match(line.message, /^Fine-tuning cannot start: /);
});

test("start-up: a configuration that cannot be read is logged, never thrown", async () => {
  const lines: string[] = [];
  const log = {
    warn: (_context: Record<string, unknown>, message: string) => {
      if (message.startsWith("Fine-tuning cannot start")) throw new Error("logger broke");
      lines.push(message);
    },
  };
  await logTrainingReadiness(log);
  assert.deepEqual(lines, ["Fine-tuning readiness could not be read at start-up"]);
});
