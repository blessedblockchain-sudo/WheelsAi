/**
 * Run with: cd apps/web && npx tsx --test src/lib/model-choice.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HOSTED_GROUP_LABEL,
  chosenModel,
  hostedModelLabel,
  hostedModelLine,
  isUnlistedModel,
  offeredModelIds,
  type HostedModelEntry,
} from "./model-choice";

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

const running: HostedModelEntry = {
  id: "wheelsai/llama-3.1-8b",
  displayName: "Llama 3.1 8B",
  available: true,
  state: "running",
  deployment: { slug: "support-llm" },
};
const starting: HostedModelEntry = {
  id: "wheelsai/qwen-2.5-7b",
  displayName: "Qwen 2.5 7B",
  available: false,
  state: "starting",
  deployment: { slug: "qwen-test" },
};
const silent: HostedModelEntry = {
  id: "wheelsai/ft-support-tone",
  displayName: "Support tone",
  available: false,
  state: "not_answering",
  deployment: { slug: "support-tone" },
};
const withHosted = { ...models, hostedModels: [running, starting, silent] };

test("the organization's own models that can answer are offered, after everything a picker may fall back to", () => {
  assert.deepEqual(offeredModelIds(withHosted), [...offeredModelIds(models), "wheelsai/llama-3.1-8b"]);
  assert.deepEqual(offeredModelIds({ ...models, hostedModels: [] }), offeredModelIds(models));
  assert.deepEqual(offeredModelIds({ ...models, hostedModels: null }), offeredModelIds(models));
});

test("a picker never falls back to a model the organization runs: an agent moves onto a GPU only when a person chooses that", () => {
  const offered = offeredModelIds(withHosted);
  for (const value of ["", "free/groq/llama-3.3-70b", "no/such-model", starting.id, "wheelsai/mistral-7b"]) {
    assert.equal(chosenModel(value, offered), "free/groq/gpt-oss-120b", value);
  }
  // With no free model that can answer, the fallback is still not the GPU.
  const noFree = offeredModelIds({ freeModels: [], externalModels: models.externalModels, hostedModels: [running] });
  assert.equal(chosenModel("", noFree), "openai/gpt-4o");
});

test("a hosted model that cannot answer is never the chosen one unless the picker keeps its value", () => {
  const offered = offeredModelIds(withHosted);
  assert.equal(chosenModel(running.id, offered), running.id);
  assert.notEqual(chosenModel(starting.id, offered), starting.id);
  assert.notEqual(chosenModel(silent.id, offered), silent.id);
});

test("a hosted entry names its deployment, or says why it cannot be chosen", () => {
  assert.equal(HOSTED_GROUP_LABEL, "Your models on Nosana");
  assert.equal(hostedModelLabel(running), "Llama 3.1 8B (your deployment support-llm)");
  assert.equal(hostedModelLabel(starting), "Qwen 2.5 7B (starting)");
  assert.equal(hostedModelLabel(silent), "Support tone (not answering right now)");
  // The server's word on whether it can answer decides, not the state beside it.
  assert.equal(hostedModelLabel({ ...running, available: false }), "Llama 3.1 8B (not answering right now)");
});

test("the extra not-available entry is for a held model the picker has no entry for", () => {
  assert.equal(isUnlistedModel("", withHosted), false);
  assert.equal(isUnlistedModel(running.id, withHosted), false);
  assert.equal(isUnlistedModel("openai/gpt-4o", withHosted), false);
  // Listed, though it cannot answer: its own entry says why.
  assert.equal(isUnlistedModel(starting.id, withHosted), false);
  assert.equal(isUnlistedModel(silent.id, withHosted), false);
  // Held, and nothing in the list for it: a free model without its key, a hosted model whose deployment stopped.
  assert.equal(isUnlistedModel("free/groq/llama-3.3-70b", withHosted), true);
  assert.equal(isUnlistedModel("wheelsai/mistral-7b", withHosted), true);
  assert.equal(isUnlistedModel(running.id, models), true);
  assert.equal(isUnlistedModel("openai/gpt-4o", null), true);
});

test("under the picker, a hosted choice says where the agent answers from", () => {
  const line = hostedModelLine(running.id, [running, starting]);
  assert.deepEqual(line, {
    kind: "hosted",
    text: "This agent answers from your deployment support-llm. It can answer only while that deployment is running. Its GPU time is billed by the second on the deployment.",
  });
  // One that is still starting is the same promise, on its own deployment.
  assert.match(hostedModelLine(starting.id, [running, starting])?.text ?? "", /^This agent answers from your deployment qwen-test\. /);
});

test("under the picker, an agent set to a model the organization no longer runs is said to be unable to answer", () => {
  const stopped = {
    kind: "stopped",
    text: "This agent is set to a model your organization is not running now, so it cannot answer. Deploy that model again, or choose another model.",
    linkLabel: "Deploy a model",
    href: "/dashboard/deployments/new",
  };
  // Whether or not the organization runs other models.
  assert.deepEqual(hostedModelLine("wheelsai/mistral-7b", []), stopped);
  assert.deepEqual(hostedModelLine("wheelsai/mistral-7b", [running, starting]), stopped);
  assert.deepEqual(hostedModelLine("wheelsai/ft-old-tone", [running]), stopped);
});

test("under the picker, an organization with no model of its own is shown how to get one", () => {
  for (const value of ["", "free/groq/gpt-oss-120b"]) {
    assert.deepEqual(hostedModelLine(value, []), {
      kind: "deploy",
      text: "To have this agent think on a GPU you run, deploy a model on Nosana, then choose it here.",
      linkLabel: "Deploy a model",
      href: "/dashboard/deployments/new",
    });
  }
});

test("under the picker, nothing is said otherwise", () => {
  // Another model is chosen and the organization has models of its own.
  assert.equal(hostedModelLine("free/groq/gpt-oss-120b", [running]), null);
  assert.equal(hostedModelLine("", [running]), null);
  // The server did not say which models the organization runs.
  assert.equal(hostedModelLine(running.id, undefined), null);
  assert.equal(hostedModelLine("", null), null);
});

test("no sentence a customer reads carries an em dash", () => {
  const words = [
    HOSTED_GROUP_LABEL,
    hostedModelLabel(running),
    hostedModelLabel(starting),
    hostedModelLabel(silent),
    hostedModelLine(running.id, [running])?.text ?? "",
    hostedModelLine("", [])?.text ?? "",
    hostedModelLine("wheelsai/mistral-7b", [])?.text ?? "",
  ];
  for (const sentence of words) assert.ok(sentence.length > 0 && !sentence.includes("\u2014"), sentence);
});
