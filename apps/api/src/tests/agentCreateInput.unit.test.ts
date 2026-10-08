/**
 * services/agentCreateInput.ts: what a caller sent to create an agent, as the
 * agent to store. Only a name is needed; refusals are plain sentences by
 * field.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_TASK_FIELDS } from "@wheelsai/shared/agent-kind";

import {
  AGENT_CREATE_MESSAGES,
  readTemplateId,
  resolveAgentCreate,
  withoutUnavailableFreeModel,
  type AgentCreateContext,
  type AgentCreateData,
  type AgentCreateDefaults,
} from "../services/agentCreateInput.js";

const GROQ = "free/groq/llama-3.3-70b";
const GEMINI = "free/gemini/gemini-2.5-flash";
const NOW = new Date("2026-10-08T12:00:00Z");

const context = (over: Partial<AgentCreateContext> = {}): AgentCreateContext => ({
  availableFreeModelIds: [GROQ],
  now: NOW,
  ...over,
});

function data(body: unknown, ctx: AgentCreateContext = context()): AgentCreateData {
  const result = resolveAgentCreate(body, ctx);
  assert.ok(result.ok, `expected a create, got ${JSON.stringify(result)}`);
  return result.data;
}

function failure(body: unknown, ctx: AgentCreateContext = context()) {
  const result = resolveAgentCreate(body, ctx);
  assert.ok(!result.ok, "expected a refusal");
  return result.failure;
}

test("a name is all a create needs; everything else has a default", () => {
  assert.deepEqual(data({ name: "Support Bot" }), {
    name: "Support Bot",
    slugFrom: "Support Bot",
    description: undefined,
    framework: "custom",
    systemPrompt: undefined,
    tools: [],
    modelConfig: { temperature: 0.7, maxTokens: 4096 },
    sourceType: "inline",
    sourceUrl: undefined,
    sourceCode: undefined,
    env: {},
    tags: [],
    isPublic: false,
    knowledgeBaseId: null,
    agentKind: "conversation",
    kindConfig: null,
  });
});

test("an inline agent needs no code: the old rule is gone", () => {
  const created = data({ name: "No code", framework: "custom", sourceType: "inline", modelConfig: {} });
  assert.equal(created.sourceType, "inline");
  assert.equal(created.sourceCode, undefined);
});

test("an old-style request resolves to what the route stored before", () => {
  const body = {
    name: "Legacy Agent",
    description: "Answers questions",
    framework: "mastra",
    systemPrompt: "Be brief.",
    tools: [{ name: "search", type: "api", description: "Search the web", config: { url: "https://example.com" } }],
    modelConfig: { externalModel: "openai/gpt-4", temperature: 0.2 },
    sourceType: "inline",
    sourceCode: "export default {}",
    env: { OPENAI_API_KEY: "sk-test" },
    tags: ["support"],
    isPublic: true,
  };
  assert.deepEqual(data(body), {
    name: "Legacy Agent",
    slugFrom: "Legacy Agent",
    description: "Answers questions",
    framework: "mastra",
    systemPrompt: "Be brief.",
    tools: body.tools,
    modelConfig: { externalModel: "openai/gpt-4", temperature: 0.2, maxTokens: 4096 },
    sourceType: "inline",
    sourceUrl: undefined,
    sourceCode: "export default {}",
    env: { OPENAI_API_KEY: "sk-test" },
    tags: ["support"],
    isPublic: true,
    knowledgeBaseId: null,
    agentKind: "conversation",
    kindConfig: null,
  });
});

test("a missing, short or non-text name is refused with the plan's sentence", () => {
  for (const body of [{}, { name: "ab" }, { name: "  a  " }, { name: 42 }, { name: null }]) {
    const refused = failure(body);
    assert.equal(refused.error, "validation_failed");
    assert.equal(refused.message, "Give your agent a name of at least 3 characters.");
    assert.equal(refused.fields.name, "Give your agent a name of at least 3 characters.");
    assert.ok(refused.details.fieldErrors.name?.length, "details still names the field, as before");
  }
  assert.equal(failure({ name: "x".repeat(101) }).fields.name, AGENT_CREATE_MESSAGES.nameTooLong);
});

test("a body that is not an object is refused in plain words", () => {
  for (const body of [undefined, null, "name", ["name"]]) {
    const refused = failure(body);
    assert.equal(refused.error, "validation_failed");
    assert.equal(typeof refused.message, "string");
    assert.doesNotMatch(refused.message, /Expected|Required|received/);
  }
});

test("the name is stored without the spaces around it", () => {
  assert.equal(data({ name: "  Support Bot  " }).name, "Support Bot");
});

test("every problem is reported at once, each as a sentence with no zod wording", () => {
  const refused = failure({
    name: "ok name",
    framework: "rails",
    modelConfig: { temperature: 9 },
    tools: [{ name: "t", type: "nope" }],
    agentKind: "chat",
  });
  assert.deepEqual(Object.keys(refused.fields).sort(), [
    "agentKind",
    "framework",
    "modelConfig.temperature",
    "tools[0].type",
  ]);
  assert.match(refused.fields.framework!, /must be one of: mastra, langchain, autogen, elizaos, crewai, custom\./);
  assert.equal(refused.fields["modelConfig.temperature"], '"modelConfig.temperature" must be 2 or less.');
  assert.equal(refused.fields.agentKind, "Choose how people use this agent: conversation, task or scheduled.");
  for (const sentence of Object.values(refused.fields)) {
    assert.doesNotMatch(sentence, /Invalid enum|Expected|Required|character\(s\)/);
  }
  assert.equal(refused.message, Object.values(refused.fields)[0]);
  assert.deepEqual(refused.details.fieldErrors.agentKind, [refused.fields.agentKind]);
});

test("an agent imported from GitHub or IPFS still needs the address of its code", () => {
  for (const sourceType of ["github", "ipfs"]) {
    const refused = failure({ name: "Imported", sourceType });
    assert.deepEqual(refused.fields, { sourceUrl: AGENT_CREATE_MESSAGES.sourceUrl });
    assert.deepEqual(refused.details.fieldErrors.sourceUrl, [AGENT_CREATE_MESSAGES.sourceUrl]);
  }
  const created = data({ name: "Imported", sourceType: "github", sourceUrl: "https://github.com/acme/agent" });
  assert.equal(created.sourceUrl, "https://github.com/acme/agent");
});

test("the kind and its settings go through resolveKindConfig", () => {
  const task = data({ name: "Reviewer", agentKind: "task" });
  assert.equal(task.agentKind, "task");
  assert.deepEqual(task.kindConfig, { task: { fields: [...DEFAULT_TASK_FIELDS] } });

  const scheduled = data({
    name: "Briefing",
    agentKind: "scheduled",
    kindConfig: { scheduled: { schedule: { cronExpression: "0  9 * * *", timezone: "Europe/Berlin" } } },
  });
  assert.deepEqual(scheduled.kindConfig, {
    scheduled: { schedule: { cronExpression: "0 9 * * *", timezone: "Europe/Berlin" } },
  });

  const refused = failure({
    name: "Reviewer",
    agentKind: "task",
    kindConfig: { task: { fields: [{ label: "" }] } },
  });
  assert.equal(refused.fields["kindConfig.task.fields[0].label"], "Give this question a label.");
  assert.equal(refused.message, "Give this question a label.");
  assert.deepEqual(refused.details.fieldErrors.kindConfig, ["Give this question a label."]);
});

test("a free model the platform cannot serve now is left unset; one it can serve is kept", () => {
  const dropped = data({ name: "Uses Gemini", modelConfig: { externalModel: GEMINI, temperature: 0.4 } });
  assert.deepEqual(dropped.modelConfig, { temperature: 0.4, maxTokens: 4096 });

  const kept = data({ name: "Uses Groq", modelConfig: { externalModel: GROQ } });
  assert.equal(kept.modelConfig.externalModel, GROQ);

  const none = data({ name: "No keys", modelConfig: { externalModel: GROQ } }, context({ availableFreeModelIds: [] }));
  assert.equal("externalModel" in none.modelConfig, false);
});

test("a model the caller runs themselves is never dropped", () => {
  const own = data(
    { name: "Own model", modelConfig: { externalModel: "openai/gpt-4", modelId: "m-1" } },
    context({ availableFreeModelIds: [] }),
  );
  assert.equal(own.modelConfig.externalModel, "openai/gpt-4");
  assert.equal(own.modelConfig.modelId, "m-1");
});

test("withoutUnavailableFreeModel checks both places a chat reads a model from", () => {
  assert.deepEqual(
    withoutUnavailableFreeModel({ externalModel: GEMINI, model: GEMINI, temperature: 1, gpuTier: "4090" }, [GROQ]),
    { temperature: 1, gpuTier: "4090" },
  );
  assert.deepEqual(withoutUnavailableFreeModel({ model: GROQ }, [GROQ]), { model: GROQ });
  const input = { externalModel: GEMINI };
  withoutUnavailableFreeModel(input, []);
  assert.deepEqual(input, { externalModel: GEMINI }, "the input is not changed");
});

test("a slug the caller asks for is what the slug is made from; an unusable one falls back to the name", () => {
  assert.equal(data({ name: "Support Bot", slug: "helpdesk" }).slugFrom, "helpdesk");
  assert.equal(data({ name: "Support Bot", slug: "---" }).slugFrom, "Support Bot");
  assert.equal(data({ name: "Support Bot", slug: "" }).slugFrom, "Support Bot");
});

const template: AgentCreateDefaults = {
  description: "Reviews code",
  framework: "mastra",
  systemPrompt: "You review code.",
  tools: [{ name: "lint", type: "function" }],
  modelConfig: { externalModel: GROQ, temperature: 0.3, maxTokens: 2048 },
  sourceType: "inline",
  sourceCode: "export const agent = {}",
  sourceUrl: null,
  env: { REVIEW_DEPTH: "full" },
  tags: ["code"],
  agentKind: "task",
  kindConfig: {
    task: { fields: [{ key: "code", label: "Code to review", type: "long_text", required: true }] },
    scheduled: { prompt: "Review what changed today." },
  },
};

test("an agent made from a template starts from the template's values", () => {
  const created = data({ name: "My Reviewer" }, context({ template }));
  assert.deepEqual(created, {
    name: "My Reviewer",
    slugFrom: "My Reviewer",
    description: "Reviews code",
    framework: "mastra",
    systemPrompt: "You review code.",
    tools: [{ name: "lint", type: "function" }],
    modelConfig: { externalModel: GROQ, temperature: 0.3, maxTokens: 2048 },
    sourceType: "inline",
    sourceUrl: undefined,
    sourceCode: "export const agent = {}",
    env: { REVIEW_DEPTH: "full" },
    tags: ["code"],
    isPublic: false,
    knowledgeBaseId: null,
    agentKind: "task",
    kindConfig: template.kindConfig,
  });
});

test("the template's kind settings are copied, not shared", () => {
  const created = data({ name: "My Reviewer" }, context({ template }));
  const stored = (template.kindConfig as { task: { fields: unknown[] } }).task.fields;
  assert.notEqual(created.kindConfig, template.kindConfig);
  assert.notEqual(created.kindConfig!.task!.fields, stored);
  assert.notEqual(created.kindConfig!.task!.fields[0], stored[0]);
  assert.deepEqual(created.kindConfig!.task!.fields, stored);
  assert.notEqual(created.tools, template.tools);
});

test("what the caller sends replaces the template's value, field by field", () => {
  const created = data(
    {
      name: "My Reviewer",
      description: "Mine",
      systemPrompt: "Be strict.",
      modelConfig: { temperature: 0.9 },
      env: { EXTRA: "1" },
      agentKind: "scheduled",
      kindConfig: { scheduled: { prompt: "Review the main branch." } },
    },
    context({ template }),
  );
  assert.equal(created.description, "Mine");
  assert.equal(created.systemPrompt, "Be strict.");
  // Only the temperature was sent: the template's model and token limit stay.
  assert.deepEqual(created.modelConfig, { externalModel: GROQ, temperature: 0.9, maxTokens: 2048 });
  assert.deepEqual(created.env, { REVIEW_DEPTH: "full", EXTRA: "1" });
  assert.equal(created.agentKind, "scheduled");
  // A key that is sent replaces that key; the template's form stays beside it.
  assert.deepEqual(created.kindConfig, {
    task: (template.kindConfig as { task: unknown }).task,
    scheduled: { prompt: "Review the main branch." },
  });
});

test("a template's free model is dropped too when the platform cannot serve it", () => {
  const created = data({ name: "My Reviewer" }, context({ template, availableFreeModelIds: [GEMINI] }));
  assert.deepEqual(created.modelConfig, { temperature: 0.3, maxTokens: 2048 });
});

test("a template of an unrecognised kind makes a conversation agent", () => {
  const created = data({ name: "Odd" }, context({ template: { ...template, agentKind: "chat", kindConfig: null } }));
  assert.equal(created.agentKind, "conversation");
  assert.equal(created.kindConfig, null);
});

test("templateId: null is no template, and a null for an optional field is not called required", () => {
  const created = data({ name: "abc", templateId: null });
  assert.equal(created.agentKind, "conversation");

  const refused = failure({ name: "abc", description: null });
  assert.deepEqual(refused.fields, { description: '"description" must be text.' });
  assert.equal(refused.message, '"description" must be text.');
});

test("readTemplateId: none, a valid id, and one that is not an id", () => {
  assert.deepEqual(readTemplateId({ name: "x" }), { ok: true, templateId: null });
  assert.deepEqual(readTemplateId(null), { ok: true, templateId: null });
  assert.deepEqual(readTemplateId({ templateId: null }), { ok: true, templateId: null });
  const id = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(readTemplateId({ templateId: id }), { ok: true, templateId: id });
  const refused = readTemplateId({ templateId: "customer-support-bot" });
  assert.ok(!refused.ok);
  assert.deepEqual(refused.failure.fields, { templateId: AGENT_CREATE_MESSAGES.template });
});
