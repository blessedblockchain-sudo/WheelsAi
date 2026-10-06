import assert from "node:assert/strict";
import test from "node:test";

import type { AgentForExecution } from "../services/executeScheduledTask.js";
import {
  createRunAgentChat,
  FREE_TIER_LIMIT_MESSAGE,
  type SharedAgentChatSeams,
} from "../services/sharedAgentChat.js";

// Drives services/sharedAgentChat.ts, the one agent call that scheduled
// tasks, workflow steps and the test runner share. Free models run on the
// platform's provider key; only the playground used to rate-limit them,
// so a looping workflow on a schedule was an unmetered way to spend it.

const FREE = "free/groq/llama-3.3-70b";
const OWN_KEY = "openai/gpt-4o";

function agent(model: string): AgentForExecution {
  return {
    id: "agent-1",
    orgId: "org-1",
    name: "Helper",
    systemPrompt: "Be brief.",
    tools: [],
    modelConfig: { externalModel: model },
    env: {},
  };
}

interface World {
  events: string[];
  usage: Array<{ orgId: string; modelId: string; inputTokens: number; outputTokens: number }>;
  chatOptions: Array<{ mode: string; signal?: AbortSignal }>;
}

function makeSeams(
  over: Partial<SharedAgentChatSeams<string>> & { allowed?: boolean } = {},
): { seams: SharedAgentChatSeams<string>; world: World } {
  const world: World = { events: [], usage: [], chatOptions: [] };
  const { allowed, ...seamOverrides } = over;
  const seams: SharedAgentChatSeams<string> = {
    isFreeModel: (modelId) => modelId.startsWith("free/"),
    checkFreeTierLimit: async (orgId) => {
      world.events.push(`limit:${orgId}`);
      return { allowed: allowed ?? true };
    },
    recordFreeTierUsage: async (usage) => {
      world.events.push("usage");
      world.usage.push(usage);
    },
    openAgentEnv: () => ({}),
    resolveModel: (modelId) => `resolved:${modelId}`,
    resolveToolMode: async ({ base }) => base,
    withMetering: async (_args, run) => {
      world.events.push("meter:charge");
      try {
        const result = await run();
        world.events.push("meter:settle");
        return result;
      } catch (err) {
        world.events.push("meter:refund");
        throw err;
      }
    },
    runChat: async (_resolved, _config, _prompt, options) => {
      world.events.push("model");
      world.chatOptions.push({ mode: options.mode, signal: options.signal });
      return { content: "answer", usage: { inputTokens: 12, outputTokens: 34 } };
    },
    ...seamOverrides,
  };
  return { seams, world };
}

for (const mode of ["scheduled", "job", "test"] as const) {
  test(`a free model in ${mode} mode consults the limiter before the model runs`, async () => {
    const { seams, world } = makeSeams();
    const result = await createRunAgentChat(seams)({ agent: agent(FREE), prompt: "hi", mode });
    assert.equal(result.content, "answer");
    assert.deepEqual(world.events, ["limit:org-1", "meter:charge", "model", "meter:settle", "usage"]);
    assert.equal(world.chatOptions[0]!.mode, mode);
  });
}

test("over the limit, the call is refused clearly and no model call is made", async () => {
  const { seams, world } = makeSeams({ allowed: false });
  await assert.rejects(
    createRunAgentChat(seams)({ agent: agent(FREE), prompt: "hi", mode: "job" }),
    (err: unknown) => err instanceof Error && err.message === FREE_TIER_LIMIT_MESSAGE,
  );
  assert.equal(
    FREE_TIER_LIMIT_MESSAGE,
    "free-model limit reached for this org; retry later or use your own provider key",
  );
  // Refused before anything is charged or called.
  assert.deepEqual(world.events, ["limit:org-1"]);
  assert.equal(world.usage.length, 0);
});

test("free-tier usage is recorded with the call's real token counts", async () => {
  const { seams, world } = makeSeams();
  await createRunAgentChat(seams)({ agent: agent(FREE), prompt: "hi" });
  assert.deepEqual(world.usage, [
    { orgId: "org-1", modelId: FREE, inputTokens: 12, outputTokens: 34 },
  ]);
});

test("an agent on its own provider key skips the limiter and the usage row", async () => {
  const { seams, world } = makeSeams({ allowed: false });
  const result = await createRunAgentChat(seams)({ agent: agent(OWN_KEY), prompt: "hi", mode: "job" });
  assert.equal(result.content, "answer");
  assert.deepEqual(world.events, ["meter:charge", "model", "meter:settle"]);
});

test("a failed usage write never fails a finished run", async () => {
  const { seams } = makeSeams({
    recordFreeTierUsage: async () => {
      throw new Error("db blip");
    },
  });
  const result = await createRunAgentChat(seams)({ agent: agent(FREE), prompt: "hi" });
  assert.equal(result.content, "answer");
});

test("the caller's abort signal reaches the model call, and an abort refunds the meter", async () => {
  const controller = new AbortController();
  const { seams, world } = makeSeams({
    runChat: async (_resolved, _config, _prompt, options) => {
      world.events.push("model");
      world.chatOptions.push({ mode: options.mode, signal: options.signal });
      controller.abort("cancel");
      throw new Error("aborted");
    },
  });
  await assert.rejects(
    createRunAgentChat(seams)({
      agent: agent(OWN_KEY),
      prompt: "hi",
      mode: "job",
      signal: controller.signal,
    }),
    /aborted/,
  );
  assert.equal(world.chatOptions[0]!.signal, controller.signal);
  assert.deepEqual(world.events, ["meter:charge", "model", "meter:refund"]);
});

test("an agent with no model configured fails before the limiter is touched", async () => {
  const { seams, world } = makeSeams();
  await assert.rejects(
    createRunAgentChat(seams)({
      agent: { ...agent(FREE), modelConfig: {} },
      prompt: "hi",
    }),
    /has no model configured/,
  );
  assert.deepEqual(world.events, []);
});
