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
  "GPU_FACING_API_URL",
  "NOSANA_API_URL",
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
  assert.match(byCode.training_callbacks_not_configured as string, /Neither GPU_FACING_API_URL nor PUBLIC_API_URL is set/);
  // Gated models need HF_TOKEN; the operator reads which ones are held back.
  assert.match(byCode.hf_token_required as string, /HF_TOKEN is not set/);
  // Deploying a fine-tuned model has its own line: a GPU node fetches the adapter from here.
  assert.equal(
    byCode.adapter_download_not_configured,
    "Fine-tuned models cannot be deployed: Neither GPU_FACING_API_URL nor PUBLIC_API_URL is set, so a GPU node has nowhere to fetch a fine-tuned model's adapter from.",
  );
  // And with no object store there is nothing to fetch it from at all.
  assert.equal(
    byCode.adapter_storage_not_configured,
    "Fine-tuned models cannot be deployed: Object storage is not configured, so a deployment has nowhere to fetch a fine-tuned model's adapter from. Set STORAGE_DRIVER, or AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and DATASETS_BUCKET.",
  );
  for (const line of lines) {
    assert.match(line.message, /^(Fine-tuning cannot start|Fine-tuned models cannot be deployed): /);
  }
});

test("start-up: an address a GPU node cannot reach is logged as the reason no fine-tuned model can be deployed", async () => {
  // The serving side reads the environment when asked (the training side
  // reads config/env.ts, parsed at import, and is covered in trainingJobs).
  process.env.PUBLIC_API_URL = "http://localhost:4000";
  try {
    const lines: Array<{ context: Record<string, unknown>; message: string }> = [];
    await logTrainingReadiness({ warn: (context, message) => lines.push({ context, message }) });
    const byCode = Object.fromEntries(lines.map((line) => [line.context.code, line.message]));
    assert.equal(
      byCode.adapter_download_not_reachable,
      "Fine-tuned models cannot be deployed: A GPU node cannot reach http://localhost:4000, where a deployment fetches its adapter: it is this machine or a private network. Set GPU_FACING_API_URL (or PUBLIC_API_URL) to a public address.",
    );
    assert.equal(byCode.adapter_download_not_configured, undefined);

    // The narrow door: its address is what a GPU node uses, whatever PUBLIC_API_URL says.
    process.env.GPU_FACING_API_URL = "https://door.example.com/";
    const withDoor: string[] = [];
    await logTrainingReadiness({ warn: (context) => withDoor.push(String(context.code)) });
    // (The object store is still unset in this file: that line stays.)
    assert.ok(!withDoor.some((code) => code.startsWith("adapter_download_")));
  } finally {
    delete process.env.PUBLIC_API_URL;
    delete process.env.GPU_FACING_API_URL;
  }
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
  // The training read failed; why a fine-tuned model cannot be deployed is its own read, and is still said.
  assert.deepEqual(lines, [
    "Fine-tuning readiness could not be read at start-up",
    "Fine-tuned models cannot be deployed: Object storage is not configured, so a deployment has nowhere to fetch a fine-tuned model's adapter from. Set STORAGE_DRIVER, or AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and DATASETS_BUCKET.",
    "Fine-tuned models cannot be deployed: Neither GPU_FACING_API_URL nor PUBLIC_API_URL is set, so a GPU node has nowhere to fetch a fine-tuned model's adapter from.",
  ]);
});

test("start-up: one read that fails does not hide what the other has to say", async () => {
  const collect = () => {
    const lines: Array<{ context: Record<string, unknown>; message: string }> = [];
    return { lines, log: { warn: (context: Record<string, unknown>, message: string) => void lines.push({ context, message }) } };
  };
  const deployBlocker = { code: "adapter_download_not_reachable" as const, message: "the deploy reason." };
  const trainingBlocker = { code: "training_image_not_configured", message: "the training reason." };

  // The training read throws: the deploy line is still logged, and nothing is thrown at boot.
  const first = collect();
  await logTrainingReadiness(first.log, {
    training: async () => {
      throw new Error("the training configuration cannot be read");
    },
    deploy: async () => [deployBlocker],
  });
  assert.deepEqual(
    first.lines.map((line) => line.message).filter((message) => !message.includes("HF_TOKEN")),
    ["Fine-tuning readiness could not be read at start-up", "Fine-tuned models cannot be deployed: the deploy reason."],
  );

  // The deploy read throws: the training line is still logged.
  const second = collect();
  await logTrainingReadiness(second.log, {
    training: async () => [trainingBlocker],
    deploy: async () => {
      throw new Error("the deploy configuration cannot be read");
    },
  });
  assert.deepEqual(
    second.lines.map((line) => line.message).filter((message) => !message.includes("HF_TOKEN")),
    [
      "Fine-tuning cannot start: the training reason.",
      "Fine-tuned model deploy readiness could not be read at start-up",
    ],
  );
});
