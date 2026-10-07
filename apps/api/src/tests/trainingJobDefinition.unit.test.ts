import assert from "node:assert/strict";
import test from "node:test";

import {
  TRAINER_ENV_NAMES,
  TRAINING_HYPERPARAM_BOUNDS,
  TRAINING_HYPERPARAM_DEFAULTS,
  buildTrainingJobDefinition,
  resolveTrainingHyperparams,
  trainingDeploymentName,
  validateTrainingHyperparams,
  type TrainingJobDefinitionInput,
} from "../services/trainingJobDefinition.js";

const DIGEST = "a".repeat(64);
const IMAGE = `registry.gitlab.com/bprime/wheelsai/trainer@sha256:${DIGEST}`;
const JOB_ID = "5b0b0e5e-2c1c-4a43-9d4e-3a1e0d7f1a11";

// No value here is a real credential.
function input(overrides: Partial<TrainingJobDefinitionInput> = {}): TrainingJobDefinitionInput {
  return {
    image: IMAGE,
    requiredVramGb: 12,
    jobId: JOB_ID,
    baseModelHfId: "microsoft/Phi-3-mini-4k-instruct",
    method: "qlora",
    datasetUrl: "https://bucket.example.com/datasets/org/ds/data.jsonl?X-Amz-Signature=abc123&X-Amz-Expires=9000",
    datasetFormat: "alpaca",
    datasetFileType: "jsonl",
    datasetSha256: "b".repeat(64),
    adapterUploadUrl: "https://bucket.example.com/adapters/org/job/adapter.tar.gz?X-Amz-Signature=def456",
    metricsUploadUrl: "https://bucket.example.com/adapters/org/job/metrics.json?X-Amz-Signature=0a1b2c",
    callbackUrl: `https://api.example.com/api/training/jobs/${JOB_ID}/events`,
    callbackSecret: "c".repeat(64),
    hyperparams: { epochs: 2, loraR: 8 },
    maxRuntimeSeconds: 3600,
    ...overrides,
  };
}

function built(overrides: Partial<TrainingJobDefinitionInput> = {}) {
  const result = buildTrainingJobDefinition(input(overrides));
  assert.ok(result.ok, result.ok ? "" : `${result.field}: ${result.message}`);
  return result;
}

function refusedField(overrides: Partial<TrainingJobDefinitionInput>): string {
  const result = buildTrainingJobDefinition(input(overrides));
  assert.equal(result.ok, false, JSON.stringify(Object.keys(overrides)));
  if (result.ok) return "";
  return result.field;
}

// ============================================
// The definition
// ============================================

test("definition: one container op, the image, a GPU, no command", () => {
  const { definition } = built();
  assert.equal(definition.version, "0.1");
  assert.equal(definition.type, "container", "the only job type Nosana has");
  assert.deepEqual(definition.meta, { trigger: "wheelsai-training" });
  assert.equal(definition.ops.length, 1);
  const op = definition.ops[0];
  assert.equal(op.type, "container/run");
  assert.equal(op.id, "train");
  assert.deepEqual(Object.keys(op.args).sort(), ["env", "gpu", "image"]);
  assert.equal(op.args.image, IMAGE);
  assert.equal(op.args.gpu, true);
  const args = op.args as Record<string, unknown>;
  // required_vram is not a ContainerRun key: Nosana's strict validator refuses it.
  for (const absent of ["cmd", "entrypoint", "expose", "volumes", "work", "authentication", "required_vram"]) {
    assert.equal(Object.hasOwn(args, absent), false, `${absent} is not set`);
  }
});

test("definition: the environment is the container contract and nothing else", () => {
  const { definition } = built();
  const env = definition.ops[0].args.env;
  assert.deepEqual(env, {
    JOB_ID,
    BASE_MODEL: "microsoft/Phi-3-mini-4k-instruct",
    METHOD: "qlora",
    DATASET_URL: input().datasetUrl,
    DATASET_FORMAT: "alpaca",
    DATASET_FILE_TYPE: "jsonl",
    DATASET_SHA256: "b".repeat(64),
    ADAPTER_UPLOAD_URL: input().adapterUploadUrl,
    METRICS_UPLOAD_URL: input().metricsUploadUrl,
    CALLBACK_URL: input().callbackUrl,
    CALLBACK_SECRET: "c".repeat(64),
    HYPERPARAMS: '{"epochs":2,"loraR":8}',
    MAX_RUNTIME_SECONDS: "3600",
  });
  for (const [name, value] of Object.entries(built().definition.ops[0].args.env)) {
    assert.ok((TRAINER_ENV_NAMES as readonly string[]).includes(name), `${name} is one of the fourteen`);
    assert.equal(typeof value, "string");
  }
  assert.equal(TRAINER_ENV_NAMES.length, 14);
  assert.equal(Object.hasOwn(env, "HF_TOKEN"), false, "no token, no variable");
});

test("definition: HF_TOKEN only when there is a token", () => {
  const withToken = built({ hfToken: "hf_exampleTokenForTests0123" });
  assert.equal(withToken.definition.ops[0].args.env.HF_TOKEN, "hf_exampleTokenForTests0123");
  assert.deepEqual(Object.keys(withToken.definition.ops[0].args.env).sort(), [...TRAINER_ENV_NAMES].sort());
  assert.equal(Object.hasOwn(built({ hfToken: null }).definition.ops[0].args.env, "HF_TOKEN"), false);
});

test("definition: registry credentials only when configured", () => {
  const { definition } = built({
    registry: { server: "registry.gitlab.com", username: "gitlab+deploy-token-1", password: "example_p4ss-word!" },
  });
  assert.deepEqual(definition.ops[0].args.authentication, {
    docker: { username: "gitlab+deploy-token-1", password: "example_p4ss-word!", server: "registry.gitlab.com" },
  });
  assert.equal(Object.hasOwn(built({ registry: null }).definition.ops[0].args, "authentication"), false);
});

test("definition: HYPERPARAMS carries only what was sent, and every key the trainer accepts passes", () => {
  assert.equal(built({ hyperparams: {} }).definition.ops[0].args.env.HYPERPARAMS, "{}");
  assert.equal(built({ hyperparams: undefined }).definition.ops[0].args.env.HYPERPARAMS, "{}");

  const all = {
    epochs: 10,
    batchSize: 16,
    gradientAccumulationSteps: 32,
    learningRate: 1e-3,
    warmupRatio: 0.2,
    loraR: 64,
    loraAlpha: 128,
    loraDropout: 0.3,
    targetModules: ["q_proj", "v_proj"],
    maxSeqLength: 4096,
    maxSteps: 20_000,
    evalSplit: 0.2,
    seed: 2_147_483_647,
  };
  const result = built({ hyperparams: all });
  assert.deepEqual(JSON.parse(result.definition.ops[0].args.env.HYPERPARAMS!), all);
  assert.deepEqual(result.hyperparams, all, "returned as sent, for the job row");
  assert.deepEqual(Object.keys(all).sort(), Object.keys(TRAINING_HYPERPARAM_DEFAULTS).sort());
});

test("definition: an unknown or out-of-range hyperparameter refuses the whole definition", () => {
  const unknown = buildTrainingJobDefinition(input({ hyperparams: { epochs: 3, quantizationBits: 4 } }));
  assert.deepEqual(
    unknown.ok ? null : [unknown.code, unknown.field],
    ["unknown_hyperparameter", "quantizationBits"],
  );
  const range = buildTrainingJobDefinition(input({ hyperparams: { epochs: 11 } }));
  assert.deepEqual(range.ok ? null : [range.code, range.field], ["invalid_hyperparameter", "epochs"]);
});

test("definition: Nosana's own validator accepts it, with and without registry credentials", async () => {
  // Offline: the validator is a pure function of the SDK's types.
  const { validateJobDefinition } = await import("@nosana/sdk");
  const plain = validateJobDefinition(built().definition as never);
  assert.equal(plain.success, true, JSON.stringify(plain).slice(0, 300));
  const withRegistry = validateJobDefinition(
    built({
      hfToken: "hf_exampleTokenForTests0123",
      registry: { server: "registry.gitlab.com", username: "deploy", password: "example-password" },
    }).definition as never,
  );
  assert.equal(withRegistry.success, true, JSON.stringify(withRegistry).slice(0, 300));

  // What the removed generator produced: refused by the same validator.
  const old = validateJobDefinition({ ...built().definition, type: "batch" } as never);
  assert.equal(old.success, false);
});

test("definition: the same input gives the same definition", () => {
  assert.deepEqual(built(), built());
  assert.deepEqual(JSON.parse(JSON.stringify(built().definition)), built().definition, "plain JSON");
});

test("definition: http URLs are accepted for the development storage driver", () => {
  const { definition } = built({
    datasetUrl: "http://localhost:4310/api/storage/t/eyJrIjoiZGF0YXNldHMvYS9iIn0.c2ln",
    callbackUrl: "http://127.0.0.1:4310/api/training/jobs/x/events",
  });
  assert.match(definition.ops[0].args.env.DATASET_URL!, /^http:\/\/localhost:4310\//);
});

// ============================================
// Refusals (decision D13)
// ============================================

test("refused: an image that is not pinned by digest, or not an image reference", () => {
  for (const image of [
    "ghcr.io/wheelsai/training-qlora:latest",
    "registry.gitlab.com/bprime/wheelsai/trainer",
    `trainer@sha256:${DIGEST}`,
    `registry.example.com/Trainer@sha256:${DIGEST}`,
    `registry.example.com/trainer@sha256:${"a".repeat(63)}`,
    `registry.example.com/trainer@sha256:${DIGEST}; rm -rf /`,
    `registry.example.com/tr ainer@sha256:${DIGEST}`,
    `$(curl evil)/trainer@sha256:${DIGEST}`,
    "",
  ]) {
    assert.equal(refusedField({ image }), "image", image);
  }
  assert.ok(built({ image: `localhost:5000/wheelsai/trainer:1.0.0@sha256:${DIGEST}` }).ok);
});

test("refused: a job id that is not a UUID", () => {
  for (const jobId of ["", "job-1", `${JOB_ID}\n`, `${JOB_ID};id`, JOB_ID.toUpperCase(), "../../etc/passwd"]) {
    assert.equal(refusedField({ jobId }), "jobId", JSON.stringify(jobId));
  }
});

test("refused: a base model that is not <owner>/<name>", () => {
  for (const baseModelHfId of [
    "phi-3-mini",
    "/workspace/models/local",
    "microsoft/Phi-3-mini-4k-instruct/extra",
    "microsoft/../secrets",
    "microsoft/Phi 3",
    "microsoft/Phi-3$(id)",
    "microsoft/Phi-3`id`",
    "microsoft/Phi-3;ls",
    "microsoft/Phi-3\nEVIL=1",
    "https://huggingface.co/microsoft/Phi-3",
    "microsoft/Phi-3@main",
    "",
  ]) {
    assert.equal(refusedField({ baseModelHfId }), "baseModelHfId", JSON.stringify(baseModelHfId));
  }
  for (const ok of ["meta-llama/Meta-Llama-3.1-8B-Instruct", "Qwen/Qwen2-7B-Instruct", "01-ai/Yi-6B-Chat"]) {
    assert.ok(built({ baseModelHfId: ok }).ok, ok);
  }
});

test("refused: full fine-tuning and any other method", () => {
  for (const method of ["full", "8bit", "LoRA", "", "lora "]) {
    assert.equal(refusedField({ method }), "method", method);
  }
  assert.ok(built({ method: "lora" }).ok);
});

test("refused: a URL that is not a plain http(s) URL", () => {
  const bad = [
    "",
    "s3://bucket/key",
    "store://datasets/org/ds/data.jsonl",
    "file:///etc/passwd",
    "ftp://example.com/data.jsonl",
    "javascript:alert(1)",
    "//example.com/data.jsonl",
    "/api/storage/t/token",
    "https://user:pass@example.com/data.jsonl",
    "https://example.com/data.jsonl?sig=a b",
    "https://example.com/data.jsonl\nX-Injected: 1",
    "https://example.com/data.jsonl?sig=`id`",
    "https://example.com/data.jsonl?sig=$(id)\"",
    "https://example.com/data.jsonl?sig='x'",
    "https://example.com/data\\.jsonl",
    "https://exämple.com/data.jsonl",
    `https://example.com/${"a".repeat(5000)}`,
  ];
  for (const url of bad) {
    assert.equal(refusedField({ datasetUrl: url }), "datasetUrl", JSON.stringify(url.slice(0, 60)));
  }
  assert.equal(refusedField({ adapterUploadUrl: "s3://bucket/adapter" }), "adapterUploadUrl");
  assert.equal(refusedField({ metricsUploadUrl: "not a url" }), "metricsUploadUrl");
  assert.equal(refusedField({ callbackUrl: "https://user:pw@api.example.com/cb" }), "callbackUrl");
});

test("refused: a dataset that is not pinned, or a format or file type the trainer does not read", () => {
  for (const datasetSha256 of ["", "B".repeat(64), "b".repeat(63), `${"b".repeat(64)} `, "sha256:abc"]) {
    assert.equal(refusedField({ datasetSha256 }), "datasetSha256", datasetSha256);
  }
  assert.equal(refusedField({ datasetSha256: null as unknown as string }), "datasetSha256", "validation never hashed it");
  for (const datasetFormat of ["jsonl", "ALPACA", "", "chatml"]) {
    assert.equal(refusedField({ datasetFormat }), "datasetFormat", datasetFormat);
  }
  for (const datasetFileType of ["json", "tsv", "", "JSONL"]) {
    assert.equal(refusedField({ datasetFileType }), "datasetFileType", datasetFileType);
  }
  for (const datasetFormat of ["alpaca", "sharegpt", "completion", "text", "auto"]) {
    assert.ok(built({ datasetFormat }).ok);
  }
  for (const datasetFileType of ["jsonl", "csv", "parquet"]) {
    assert.ok(built({ datasetFileType }).ok);
  }
});

test("refused: secrets and credentials with characters a token never has", () => {
  for (const callbackSecret of ["", "short", "has space in the secret", "quote\"inside-secret", "back`tick-secret", "line\nbreak-secret"]) {
    assert.equal(refusedField({ callbackSecret }), "callbackSecret", JSON.stringify(callbackSecret));
  }
  for (const hfToken of ["", "hf_bad token", "hf_$(whoami)", "hf_x\ny"]) {
    assert.equal(refusedField({ hfToken }), "hfToken", JSON.stringify(hfToken));
  }
  const registry = { server: "registry.gitlab.com", username: "deploy", password: "example-password" };
  assert.equal(refusedField({ registry: { ...registry, server: "registry.gitlab.com/path" } }), "registry.server");
  assert.equal(refusedField({ registry: { ...registry, server: "http://registry.example.com" } }), "registry.server");
  assert.equal(refusedField({ registry: { ...registry, username: "de ploy" } }), "registry.username");
  assert.equal(refusedField({ registry: { ...registry, username: "" } }), "registry.username");
  assert.equal(refusedField({ registry: { ...registry, password: "pass word" } }), "registry.password");
  assert.equal(refusedField({ registry: { ...registry, password: "pa$$word" } }), "registry.password");
  assert.equal(refusedField({ registry: { ...registry, password: "" } }), "registry.password");
});

test("refused: a run limit or VRAM figure that is not a sensible whole number", () => {
  for (const maxRuntimeSeconds of [0, 59, 60.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 8 * 86_400]) {
    assert.equal(refusedField({ maxRuntimeSeconds }), "maxRuntimeSeconds", String(maxRuntimeSeconds));
  }
  assert.ok(built({ maxRuntimeSeconds: 60 }).ok);
  for (const requiredVramGb of [0, -8, 12.5, Number.NaN, 4096]) {
    assert.equal(refusedField({ requiredVramGb }), "requiredVramGb", String(requiredVramGb));
  }
});

test("a refusal names the field and never quotes its value", () => {
  const secret = "hf_SECRET value";
  const result = buildTrainingJobDefinition(input({ hfToken: secret }));
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);

  const url = buildTrainingJobDefinition(input({ datasetUrl: "https://example.com/x?sig=LEAK ME" }));
  assert.equal(JSON.stringify(url).includes("LEAK"), false);

  const key = buildTrainingJobDefinition(input({ hyperparams: { "<script>alert(1)</script>": 1 } }));
  assert.equal(JSON.stringify(key).includes("script"), false);
});

// ============================================
// Hyperparameters, against the trainer's README table
// ============================================

test("hyperparameters: nothing sent means nothing sent", () => {
  assert.deepEqual(validateTrainingHyperparams(undefined), { ok: true, hyperparams: {} });
  assert.deepEqual(validateTrainingHyperparams(null), { ok: true, hyperparams: {} });
  assert.deepEqual(validateTrainingHyperparams({}), { ok: true, hyperparams: {} });
  for (const notAnObject of ["{}", 5, [], [{ epochs: 1 }]]) {
    assert.equal(validateTrainingHyperparams(notAnObject).ok, false);
  }
});

test("hyperparameters: the bounds of every numeric key, inclusive", () => {
  for (const [key, bounds] of Object.entries(TRAINING_HYPERPARAM_BOUNDS)) {
    assert.ok(validateTrainingHyperparams({ [key]: bounds.min }).ok, `${key} min`);
    assert.ok(validateTrainingHyperparams({ [key]: bounds.max }).ok, `${key} max`);
    const step = bounds.integer ? 1 : bounds.max / 1000;
    for (const value of [bounds.min - step, bounds.max + step, Number.NaN, Number.POSITIVE_INFINITY, String(bounds.min)]) {
      const result = validateTrainingHyperparams({ [key]: value });
      assert.deepEqual(
        result.ok ? null : [result.code, result.field],
        ["invalid_hyperparameter", key],
        `${key} = ${String(value)}`,
      );
    }
    if (bounds.integer) {
      assert.equal(validateTrainingHyperparams({ [key]: bounds.min + 0.5 }).ok, false, `${key} whole numbers only`);
    }
  }
  // The table in infra/training/README.md, spelled out.
  assert.deepEqual(TRAINING_HYPERPARAM_BOUNDS, {
    epochs: { min: 1, max: 10, integer: true },
    batchSize: { min: 1, max: 16, integer: true },
    gradientAccumulationSteps: { min: 1, max: 32, integer: true },
    learningRate: { min: 1e-6, max: 1e-3, integer: false },
    warmupRatio: { min: 0, max: 0.2, integer: false },
    loraAlpha: { min: 1, max: 128, integer: true },
    loraDropout: { min: 0, max: 0.3, integer: false },
    maxSeqLength: { min: 128, max: 4096, integer: true },
    maxSteps: { min: 1, max: 20_000, integer: true },
    evalSplit: { min: 0, max: 0.2, integer: false },
    seed: { min: 0, max: 2_147_483_647, integer: true },
  });
});

test("hyperparameters: loraR is one of five ranks", () => {
  for (const loraR of [4, 8, 16, 32, 64]) assert.ok(validateTrainingHyperparams({ loraR }).ok);
  for (const loraR of [0, 2, 12, 128, 16.0001, "16", null]) {
    assert.equal(validateTrainingHyperparams({ loraR }).ok, false, String(loraR));
  }
});

test("hyperparameters: targetModules is all-linear or 1-12 distinct plain names", () => {
  assert.ok(validateTrainingHyperparams({ targetModules: "all-linear" }).ok);
  assert.ok(validateTrainingHyperparams({ targetModules: ["q_proj"] }).ok);
  assert.ok(
    validateTrainingHyperparams({ targetModules: Array.from({ length: 12 }, (_, i) => `m_${"abcdefghijkl"[i]}`) }).ok,
  );
  for (const targetModules of [
    [],
    "q_proj",
    ["q_proj", "q_proj"],
    ["Q_proj"],
    ["q-proj"],
    ["q_proj1"],
    ["q_proj; rm -rf /"],
    [""],
    [7],
    Array.from({ length: 13 }, (_, i) => `m_${"abcdefghijklm"[i]}`),
    { 0: "q_proj" },
  ]) {
    assert.equal(validateTrainingHyperparams({ targetModules }).ok, false, JSON.stringify(targetModules));
  }
});

test("hyperparameters: only maxSteps and evalSplit may be null", () => {
  assert.deepEqual(validateTrainingHyperparams({ maxSteps: null, evalSplit: null }), {
    ok: true,
    hyperparams: { maxSteps: null, evalSplit: null },
  });
  for (const key of Object.keys(TRAINING_HYPERPARAM_DEFAULTS)) {
    if (key === "maxSteps" || key === "evalSplit") continue;
    assert.equal(validateTrainingHyperparams({ [key]: null }).ok, false, key);
  }
});

test("hyperparameters: keys the old routes sent are unknown, not dropped", () => {
  for (const key of ["warmupSteps", "quantizationBits", "gpuCount", "maxRuntimeMinutes", "lora_r", "__proto__x"]) {
    const result = validateTrainingHyperparams({ [key]: 1 });
    assert.equal(result.ok, false, key);
    if (!result.ok) assert.equal(result.code, "unknown_hyperparameter");
  }
});

test("hyperparameters: resolved values are what was sent over the trainer's defaults", () => {
  assert.deepEqual(resolveTrainingHyperparams({}), {
    epochs: 3,
    batchSize: 4,
    gradientAccumulationSteps: 4,
    learningRate: 2e-4,
    warmupRatio: 0.03,
    loraR: 16,
    loraAlpha: 32,
    loraDropout: 0.05,
    targetModules: "all-linear",
    maxSeqLength: 1024,
    maxSteps: null,
    evalSplit: null,
    seed: 42,
  });
  const resolved = resolveTrainingHyperparams({ epochs: 1, maxSteps: 50, targetModules: ["q_proj"] });
  assert.equal(resolved.epochs, 1);
  assert.equal(resolved.maxSteps, 50);
  assert.deepEqual(resolved.targetModules, ["q_proj"]);
  assert.equal(resolved.batchSize, 4);
});

// ============================================
// The deployment name
// ============================================

test("deployment name: wheelsai-train-<job id>-<submit nonce>, or nothing", () => {
  assert.equal(trainingDeploymentName(JOB_ID, "a1b2c3d4e5f6"), `wheelsai-train-${JOB_ID}-a1b2c3d4e5f6`);
  assert.equal(trainingDeploymentName(JOB_ID, "a1b2c3d4e5f6"), trainingDeploymentName(JOB_ID, "a1b2c3d4e5f6"));
  for (const nonce of ["", "short", "UPPERCASE1", "with-dash-1", "a".repeat(33), "abc def gh", "abcdefgh;x"]) {
    assert.equal(trainingDeploymentName(JOB_ID, nonce), null, nonce);
  }
  assert.equal(trainingDeploymentName("not-a-uuid", "a1b2c3d4e5f6"), null);
});
