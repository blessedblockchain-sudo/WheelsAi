import assert from "node:assert/strict";
import test from "node:test";

import { resolveAgentModelId } from "../services/agentModelResolution.js";

// services/agentModelResolution.ts: the one rule for which model an agent's
// chat runs on.

const FREE = ["free/groq/llama-3.3-70b", "free/gemini/gemini-2.5-flash"];

test("override > externalModel > model > first available free model", () => {
  const modelConfig = { externalModel: "openai/gpt-4", model: "groq/legacy" };
  assert.equal(
    resolveAgentModelId({ override: "free/groq/qwen3-32b", modelConfig, availableFreeModelIds: FREE }),
    "free/groq/qwen3-32b",
  );
  assert.equal(resolveAgentModelId({ modelConfig, availableFreeModelIds: FREE }), "openai/gpt-4");
  assert.equal(
    resolveAgentModelId({ modelConfig: { model: "groq/legacy" }, availableFreeModelIds: FREE }),
    "groq/legacy",
  );
  assert.equal(resolveAgentModelId({ modelConfig: {}, availableFreeModelIds: FREE }), FREE[0]);
});

test("empty and non-string values do not count as a choice", () => {
  assert.equal(
    resolveAgentModelId({
      override: "  ",
      modelConfig: { externalModel: "", model: 42 },
      availableFreeModelIds: FREE,
    }),
    FREE[0],
  );
  // modelConfig is stored JSON: it may be null or not an object at all.
  for (const modelConfig of [null, undefined, "x", 3]) {
    assert.equal(resolveAgentModelId({ modelConfig, availableFreeModelIds: FREE }), FREE[0]);
  }
});

test("returns null when nothing is configured and no free provider key exists", () => {
  assert.equal(resolveAgentModelId({ modelConfig: {}, availableFreeModelIds: [] }), null);
  assert.equal(resolveAgentModelId({ override: null, modelConfig: null, availableFreeModelIds: [] }), null);
});
