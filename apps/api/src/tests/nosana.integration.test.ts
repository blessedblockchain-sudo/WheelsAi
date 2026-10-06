import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// ============================================
// Test 1: generateVllmJobDefinition — structure
// ============================================

test("generateVllmJobDefinition returns correct job definition structure", async () => {
  setupEnv();

  const { generateVllmJobDefinition } = await import("../services/nosana.js");

  const config = {
    modelId: "model_1",
    hfModelId: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    engine: "vllm" as const,
    maxTokens: 4096,
    gpuMemoryUtilization: 0.9,
    hfToken: "hf_real_token",
  };

  const job = generateVllmJobDefinition(config);

  // Top-level structure
  assert.equal(job.version, "0.1");
  assert.equal(job.type, "container");
  assert.equal(job.meta.trigger, "wheelsai");

  // Operations
  assert.equal(job.ops.length, 1);
  const op = job.ops[0]!;
  assert.equal(op.type, "container/run");
  assert.equal(op.id, "vllm-inference");
  assert.equal(op.args.image, "vllm/vllm-openai:v0.6.0");
  assert.equal(op.args.gpu, true);
  assert.deepStrictEqual(op.args.expose, [8000]);

  // Command args should contain model and port
  assert.ok(Array.isArray(op.args.cmd), "cmd should be an array");
  const cmd = op.args.cmd!;
  assert.ok(cmd.includes("--model"), "cmd should include --model flag");
  assert.ok(
    cmd.includes("meta-llama/Meta-Llama-3.1-8B-Instruct"),
    "cmd should include the HF model ID"
  );
  assert.ok(cmd.includes("--port"), "cmd should include --port flag");
  assert.ok(cmd.includes("8000"), "cmd should expose port 8000");
  assert.ok(cmd.includes("--max-model-len"), "cmd should include --max-model-len");
  assert.ok(cmd.includes("4096"), "cmd should include max tokens value");
  assert.ok(cmd.includes("--gpu-memory-utilization"), "cmd should include GPU mem util");
  assert.ok(cmd.includes("0.9"), "cmd should include GPU mem util value");

  // The token is the REAL one handed to the generator (the job is created
  // confidential), never the literal "${HF_TOKEN}" placeholder nothing ever
  // substituted.
  assert.ok(op.args.env, "env should be defined when a token is configured");
  assert.equal(op.args.env!.HF_TOKEN, "hf_real_token");
});

test("generateVllmJobDefinition omits HF_TOKEN entirely when none is configured", async () => {
  setupEnv();
  const { generateVllmJobDefinition } = await import("../services/nosana.js");
  const job = generateVllmJobDefinition({
    modelId: "model_1",
    hfModelId: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    engine: "vllm" as const,
    maxTokens: 4096,
    gpuMemoryUtilization: 0.9,
  });
  const args = job.ops[0]!.args;
  assert.equal(args.env, undefined, "no env block");
  assert.ok(!JSON.stringify(job).includes("${HF_TOKEN}"), "the literal placeholder is gone");
});

// ============================================
// Test 2: generateVllmJobDefinition — with quantization
// ============================================

test("generateVllmJobDefinition includes quantization when provided", async () => {
  setupEnv();

  const { generateVllmJobDefinition } = await import("../services/nosana.js");

  const config = {
    modelId: "model_2",
    hfModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
    engine: "vllm" as const,
    maxTokens: 2048,
    gpuMemoryUtilization: 0.95,
    quantization: "awq",
  };

  const job = generateVllmJobDefinition(config);
  const cmd = job.ops[0]!.args.cmd!;

  assert.ok(cmd.includes("--quantization"), "cmd should include --quantization flag");
  assert.ok(cmd.includes("awq"), "cmd should include quantization value");
});

// ============================================
// Test 3: generateVllmJobDefinition — without quantization
// ============================================

test("generateVllmJobDefinition omits quantization when not provided", async () => {
  setupEnv();

  const { generateVllmJobDefinition } = await import("../services/nosana.js");

  const config = {
    modelId: "model_3",
    hfModelId: "Qwen/Qwen2.5-7B-Instruct",
    engine: "vllm" as const,
    maxTokens: 8192,
    gpuMemoryUtilization: 0.85,
  };

  const job = generateVllmJobDefinition(config);
  const cmd = job.ops[0]!.args.cmd!;

  assert.ok(!cmd.includes("--quantization"), "cmd should NOT include --quantization when not set");
});

// ============================================
// Test 4: generateOllamaJobDefinition — structure and model mapping
// ============================================

test("generateOllamaJobDefinition returns correct structure with mapped model", async () => {
  setupEnv();

  const { generateOllamaJobDefinition } = await import("../services/nosana.js");

  const config = {
    modelId: "model_4",
    hfModelId: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    engine: "ollama" as const,
    maxTokens: 4096,
    gpuMemoryUtilization: 0.9,
  };

  const job = generateOllamaJobDefinition(config);

  assert.equal(job.version, "0.1");
  assert.equal(job.type, "container");
  assert.equal(job.meta.trigger, "wheelsai");
  assert.equal(job.ops.length, 1);

  const op = job.ops[0]!;
  assert.equal(op.type, "container/run");
  assert.equal(op.id, "ollama-inference");
  assert.equal(op.args.image, "ollama/ollama:latest");
  assert.equal(op.args.gpu, true);
  assert.deepStrictEqual(op.args.expose, [11434]);

  // Should use the mapped Ollama model name, not the HF ID
  const cmdStr = op.args.cmd!.join(" ");
  assert.ok(
    cmdStr.includes("llama3.1:8b"),
    `Expected mapped model name "llama3.1:8b" in cmd, got: ${cmdStr}`
  );

  // Env variables
  assert.equal(op.args.env!.OLLAMA_HOST, "0.0.0.0:11434");
  assert.equal(op.args.env!.OLLAMA_NUM_CTX, "4096");
  assert.equal(op.args.env!.OLLAMA_KEEP_ALIVE, "24h");
});

// ============================================
// Test 5: generateOllamaJobDefinition — various model mappings
// ============================================

test("generateOllamaJobDefinition maps various HF models correctly", async () => {
  setupEnv();

  const { generateOllamaJobDefinition } = await import("../services/nosana.js");

  const testCases: Array<{ hfId: string; expectedOllama: string }> = [
    { hfId: "mistralai/Mistral-7B-Instruct-v0.2", expectedOllama: "mistral:7b" },
    { hfId: "Qwen/Qwen2.5-72B-Instruct", expectedOllama: "qwen2.5:72b" },
    { hfId: "google/gemma-2-9b-it", expectedOllama: "gemma2:9b" },
    { hfId: "microsoft/Phi-3-mini-4k-instruct", expectedOllama: "phi3:mini" },
    { hfId: "codellama/CodeLlama-7b-Instruct-hf", expectedOllama: "codellama:7b" },
    { hfId: "meta-llama/Llama-3.2-3B-Instruct", expectedOllama: "llama3.2:3b" },
  ];

  for (const { hfId, expectedOllama } of testCases) {
    const job = generateOllamaJobDefinition({
      modelId: "model_test",
      hfModelId: hfId,
      engine: "ollama",
      maxTokens: 4096,
      gpuMemoryUtilization: 0.9,
    });

    const cmdStr = job.ops[0]!.args.cmd!.join(" ");
    assert.ok(
      cmdStr.includes(expectedOllama),
      `HF model "${hfId}" should map to "${expectedOllama}", cmd was: ${cmdStr}`
    );
  }
});

// ============================================
// Test 6: generateOllamaJobDefinition — unknown model falls back
// ============================================

test("generateOllamaJobDefinition falls back to last path segment for unknown models", async () => {
  setupEnv();

  const { generateOllamaJobDefinition } = await import("../services/nosana.js");

  const job = generateOllamaJobDefinition({
    modelId: "model_unknown",
    hfModelId: "some-org/custom-model-v1",
    engine: "ollama",
    maxTokens: 2048,
    gpuMemoryUtilization: 0.8,
  });

  const cmdStr = job.ops[0]!.args.cmd!.join(" ");
  assert.ok(
    cmdStr.includes("custom-model-v1"),
    `Unknown model should fall back to last path segment, cmd was: ${cmdStr}`
  );
});

// ============================================
// Test 7: isOllamaSupported — supported models
// ============================================

test("isOllamaSupported returns true for known supported models", async () => {
  setupEnv();

  const { isOllamaSupported } = await import("../services/nosana.js");

  const supportedModels = [
    "meta-llama/Meta-Llama-3.1-8B-Instruct",
    "meta-llama/Meta-Llama-3.1-70B-Instruct",
    "mistralai/Mistral-7B-Instruct-v0.2",
    "Qwen/Qwen2.5-7B-Instruct",
    "google/gemma-2-9b-it",
    "microsoft/Phi-3-mini-4k-instruct",
    "Qwen/Qwen2.5-Coder-7B-Instruct",
    "deepseek-ai/deepseek-coder-6.7b-instruct",
  ];

  for (const model of supportedModels) {
    assert.ok(
      isOllamaSupported(model),
      `Expected "${model}" to be supported by Ollama`
    );
  }
});

// ============================================
// Test 8: isOllamaSupported — unsupported models
// ============================================

test("isOllamaSupported returns false for unsupported models", async () => {
  setupEnv();

  const { isOllamaSupported } = await import("../services/nosana.js");

  const unsupportedModels = [
    "some-org/unknown-model",
    "openai/gpt-4",
    "anthropic/claude-3",
    "meta-llama/Meta-Llama-3.1-405B-Instruct", // 405B is in mapping but not in isOllamaSupported list
    "",
  ];

  for (const model of unsupportedModels) {
    assert.ok(
      !isOllamaSupported(model),
      `Expected "${model}" to NOT be supported by Ollama`
    );
  }
});

// ============================================
// Test 9: generateJobDefinition — dispatches by engine
// ============================================

test("generateJobDefinition dispatches to vllm or ollama based on engine", async () => {
  setupEnv();

  const { generateJobDefinition } = await import("../services/nosana.js");

  const baseConfig = {
    modelId: "model_dispatch",
    hfModelId: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    maxTokens: 4096,
    gpuMemoryUtilization: 0.9,
  };

  const vllmJob = generateJobDefinition({ ...baseConfig, engine: "vllm" });
  assert.equal(vllmJob.ops[0]!.id, "vllm-inference");
  assert.ok(vllmJob.ops[0]!.args.image.includes("vllm"));

  const ollamaJob = generateJobDefinition({ ...baseConfig, engine: "ollama" });
  assert.equal(ollamaJob.ops[0]!.id, "ollama-inference");
  assert.ok(ollamaJob.ops[0]!.args.image.includes("ollama"));
});

// ============================================
// Test 10: generateJobDefinition — unsupported engine throws
// ============================================

test("generateJobDefinition throws for unsupported engine", async () => {
  setupEnv();

  const { generateJobDefinition } = await import("../services/nosana.js");

  assert.throws(
    () =>
      generateJobDefinition({
        modelId: "model_bad",
        hfModelId: "some/model",
        engine: "tensorrt" as any,
        maxTokens: 4096,
        gpuMemoryUtilization: 0.9,
      }),
    /unsupported engine/i
  );
});

// ============================================
// Test 11: NosanaClient.getChainMarkets never falls back to static data
// ============================================

test("NosanaClient.getChainMarkets THROWS when the chain read fails (no silent static fallback)", async () => {
  setupEnv();

  const { NosanaClient } = await import("../services/nosana.js");
  const client = new NosanaClient();

  (client as any).sdk = {
    jobs: {
      allMarkets: async () => {
        throw new Error("RPC unavailable");
      },
    },
  };
  (client as any).isInitialized = true;

  await assert.rejects(() => client.getChainMarkets(), /RPC unavailable/);
});

// ============================================
// Test 12: NosanaClient.getChainMarkets returns NOS base units, not USD
// ============================================

test("NosanaClient.getChainMarkets maps jobPrice to NOS base units per second (bigint)", async () => {
  setupEnv();

  const { NosanaClient } = await import("../services/nosana.js");

  const client = new NosanaClient();

  (client as any).sdk = {
    jobs: {
      allMarkets: async () => [
        {
          address: { toBase58: () => "LiveMarketAddress111111111111111111111" },
          // anchor returns u64 as a BN: only toString() is relied on.
          jobPrice: { toString: () => "202" },
          queue: [1, 2, 3],
        },
      ],
    },
  };
  (client as any).isInitialized = true;

  const markets = await client.getChainMarkets();

  assert.equal(markets.length, 1);
  assert.equal(markets[0]!.address, "LiveMarketAddress111111111111111111111");
  assert.equal(markets[0]!.jobPriceNosBaseUnitsPerSecond, 202n);
  assert.equal(markets[0]!.queueLength, 3);
  assert.ok(!("pricePerSecond" in markets[0]!), "no USD field is ever derived from a chain NOS price");
});

// ============================================
// Test 13: NosanaClient requires SDK initialization
// ============================================

test("NosanaClient.getChainMarkets throws when SDK not initialized", async () => {
  setupEnv();

  const { NosanaClient } = await import("../services/nosana.js");

  const client = new NosanaClient();
  // Do NOT initialize or set sdk — it should be null

  await assert.rejects(
    () => client.getChainMarkets(),
    /not initialised/i
  );
});

// ============================================
// Test 14: NosanaClient.submitJob throws without wallet
// ============================================

test("NosanaClient.submitJob throws when wallet is not configured", async () => {
  setupEnv();

  // Ensure no wallet key is set
  const originalKey = process.env.NOSANA_WALLET_PRIVATE_KEY;
  delete process.env.NOSANA_WALLET_PRIVATE_KEY;

  const { NosanaClient, generateVllmJobDefinition } = await import(
    "../services/nosana.js"
  );

  const client = new NosanaClient();
  // Set SDK but no wallet
  (client as any).sdk = {};
  (client as any).isInitialized = true;
  (client as any).wallet = null;

  const jobDef = generateVllmJobDefinition({
    modelId: "model_1",
    hfModelId: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    engine: "vllm",
    maxTokens: 4096,
    gpuMemoryUtilization: 0.9,
  });

  await assert.rejects(
    () => client.submitJob(jobDef, "4090"),
    /wallet not configured/i
  );

  // Restore
  if (originalKey) {
    process.env.NOSANA_WALLET_PRIVATE_KEY = originalKey;
  }
});

// ============================================
// Test 15: NosanaClient.getJobStatus returns stub for mock IDs
// ============================================

test("NosanaClient.getJobStatus returns running stub for mock job IDs", async () => {
  setupEnv();

  const { NosanaClient } = await import("../services/nosana.js");

  const client = new NosanaClient();
  (client as any).sdk = {};
  (client as any).isInitialized = true;

  const status = await client.getJobStatus("mock_job_abc123");

  assert.ok(status, "Should return a status object");
  assert.equal(status!.id, "mock_job_abc123");
  assert.equal(status!.status, "running");
  assert.equal(status!.market, "");
});

// ============================================
// Test 16: NosanaClient.getMarket returns static market by tier
// ============================================

test("NosanaClient.getMarket returns correct market for known tiers", async () => {
  setupEnv();

  const { NosanaClient } = await import("../services/nosana.js");

  const client = new NosanaClient();

  const market4090 = await client.getMarket("4090");
  assert.ok(market4090);
  assert.equal(market4090!.gpuModel, "RTX 4090");
  assert.equal(market4090!.vram, 24);

  const marketA100 = await client.getMarket("a100");
  assert.ok(marketA100);
  assert.equal(marketA100!.gpuModel, "A100");
  assert.equal(marketA100!.vram, 40);

  const unknown = await client.getMarket("nonexistent_tier");
  assert.equal(unknown, null);
});
