/**
 * Run with: cd apps/web && npx tsx --test src/lib/model-choice.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { chosenModel, offeredModelIds } from "./model-choice";

const models = {
  freeModels: [
    { id: "free/groq/llama-3.3-70b", available: false },
    { id: "free/groq/gpt-oss-120b", available: true },
    { id: "free/gemini/gemini-2.5-flash", available: true },
  ],
  externalModels: [{ id: "openai/gpt-4o" }],
};

test("only free models that can answer now are offered, then the others, in the order drawn", () => {
  assert.deepEqual(offeredModelIds(models), ["free/groq/gpt-oss-120b", "free/gemini/gemini-2.5-flash", "openai/gpt-4o"]);
  assert.deepEqual(offeredModelIds(null), []);
  assert.deepEqual(offeredModelIds({}), []);
});

test("a model that is offered is kept", () => {
  const offered = offeredModelIds(models);
  assert.equal(chosenModel("free/gemini/gemini-2.5-flash", offered), "free/gemini/gemini-2.5-flash");
  assert.equal(chosenModel("openai/gpt-4o", offered), "openai/gpt-4o");
});

test("a model that is not offered gives way to the first offered one", () => {
  const offered = offeredModelIds(models);
  // The chat's built-in default, on a server without that provider's key.
  assert.equal(chosenModel("free/groq/llama-3.3-70b", offered), "free/groq/gpt-oss-120b");
  assert.equal(chosenModel("", offered), "free/groq/gpt-oss-120b");
  assert.equal(chosenModel("no/such-model", offered), "free/groq/gpt-oss-120b");
});

test("the chosen model is always one of the offered ones once the list has loaded", () => {
  const offered = offeredModelIds(models);
  for (const value of ["", "free/groq/llama-3.3-70b", "free/groq/gpt-oss-120b", "openai/gpt-4o", "x", " free/groq/gpt-oss-120b"]) {
    assert.ok(offered.includes(chosenModel(value, offered)), value);
  }
});

test("with a default entry, an empty or unoffered model is the default entry", () => {
  const offered = offeredModelIds(models);
  assert.equal(chosenModel("", offered, { allowDefault: true }), "");
  assert.equal(chosenModel("free/groq/llama-3.3-70b", offered, { allowDefault: true }), "");
  assert.equal(chosenModel("openai/gpt-4o", offered, { allowDefault: true }), "openai/gpt-4o");
});

test("nothing offered leaves nothing chosen", () => {
  assert.equal(chosenModel("free/groq/llama-3.3-70b", []), "");
});
