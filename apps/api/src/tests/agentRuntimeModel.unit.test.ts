import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.JWT_SECRET ??= "test-jwt-secret-that-is-at-least-32-chars";

const { resolveProviderModel, generateMastraConfig, generateElizaOSConfig } = await import(
  "../services/agent-runtime.js"
);

const baseAgent = (externalModel?: string) => ({
  name: "a",
  systemPrompt: "p",
  modelConfig: { externalModel, temperature: 0.5, maxTokens: 100 },
  tools: [],
});

test("free ids resolve through the catalog, not the id's own suffix", () => {
  assert.deepEqual(resolveProviderModel("free/groq/llama-3.3-70b"), {
    provider: "groq",
    modelName: "openai/gpt-oss-120b",
  });
});

test("unknown free ids fall back to the default free model", () => {
  assert.deepEqual(resolveProviderModel("free/groq/retired-model"), {
    provider: "groq",
    modelName: "openai/gpt-oss-120b",
  });
});

test("provider/model ids split on the first slash only", () => {
  assert.deepEqual(resolveProviderModel("together/meta-llama/Llama-3-8b"), {
    provider: "together",
    modelName: "meta-llama/Llama-3-8b",
  });
});

test("no retired Groq model id leaks into generated runtime configs", () => {
  const mastra = JSON.stringify(generateMastraConfig(baseAgent("free/groq/llama-3.3-70b") as any));
  const eliza = JSON.stringify(generateElizaOSConfig(baseAgent(undefined) as any));
  for (const cfg of [mastra, eliza]) {
    assert.ok(!cfg.includes("llama-3.3-70b-versatile"), cfg);
    assert.ok(!cfg.includes('"free"'), "provider must never be the literal 'free'");
  }
});
