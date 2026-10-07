import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentChatAgent,
  AgentChatDeps,
  AgentChatUsageRecord,
  AgentGraphOutcome,
} from "../services/agentChat.js";
import type { AgentForExecution } from "../services/executeScheduledTask.js";
import {
  MarketplaceLicenceRevokedError,
  MarketplacePaymentRequiredError,
} from "../services/marketplaceMetering.js";
import type { ChatMessage, ChatResult, RunChatOptions } from "../services/mastra-runtime.js";
import { createRunAgentChat, FREE_TIER_LIMIT_MESSAGE } from "../services/sharedAgentChat.js";

// Drives services/sharedAgentChat.ts, the agent call that scheduled tasks,
// workflow steps and the test runner share. It runs through the SAME core as
// the playground and /v1 (services/agentChat.ts), so the fakes here are that
// core's deps: what is pinned is that a run with nobody watching gets the
// core's model resolution, limiter, metering, tool mode, usage row and
// shutdown registration, in the core's order.
//
// Free models run on the platform's provider key; only the playground used to
// rate-limit them, so a looping workflow on a schedule was an unmetered way to
// spend it.

const FREE = "free/groq/llama-3.3-70b";
const OWN_KEY = "openai/gpt-4o";
const HOSTED = "wheelsai/llama-3.1-8b";

function agent(model: string | null): AgentForExecution {
  return {
    id: "agent-1",
    orgId: "org-1",
    name: "Helper",
    systemPrompt: "Be brief.",
    tools: [],
    modelConfig: model ? { externalModel: model } : {},
    env: {},
  };
}

interface World {
  events: string[];
  usage: AgentChatUsageRecord[];
  chats: Array<{ resolved: unknown; messages: ChatMessage[]; options: RunChatOptions; model: string }>;
  graphRuns: Array<{ input: string; mode: string }>;
  slots: { begun: number; done: number };
}

type Over = Partial<AgentChatDeps> & {
  allowed?: boolean;
  /** Columns of the stored agent row the executor's own load does not carry. */
  row?: Partial<AgentChatAgent>;
  metering?: Awaited<ReturnType<AgentChatDeps["beginMetering"]>> | "charge";
  freeModels?: string[];
};

function makeDeps(stored: AgentForExecution, over: Over = {}): { deps: AgentChatDeps; world: World } {
  const world: World = { events: [], usage: [], chats: [], graphRuns: [], slots: { begun: 0, done: 0 } };
  const { allowed, row, metering, freeModels, ...depOverrides } = over;
  const handle = {
    charge: { install: { listingTitle: "Pro" }, grossCents: 5n, creatorCents: 4n } as never,
    settle: async () => {
      world.events.push("meter:settle");
    },
    refund: async () => {
      world.events.push("meter:refund");
    },
  };
  const deps: AgentChatDeps = {
    // Org-scoped, as the production binding is.
    loadAgent: async (where) =>
      "id" in where && where.id === stored.id && where.orgId === stored.orgId
        ? {
            ...stored,
            slug: "helper",
            version: "1.0.0",
            knowledgeBaseId: null,
            entrypoint: "chat",
            ...row,
          }
        : null,
    openAgentEnv: () => ({}),
    availableFreeModelIds: () => freeModels ?? [FREE],
    isFreeModel: (modelId) => modelId.startsWith("free/"),
    resolveModel: (modelId) => {
      if (modelId.startsWith("wheelsai/")) {
        throw Object.assign(new Error("hosted models are not served here"), {
          code: "hosted_model_not_available",
        });
      }
      return { apiKey: "k", baseUrl: "https://provider.example/v1", modelName: modelId };
    },
    checkFreeTierLimit: async (orgId) => {
      world.events.push(`limit:${orgId}`);
      return {
        allowed: allowed ?? true,
        remaining: { rpm: 1, rpd: 1 },
        resetAt: { rpm: 60, rpd: 60 },
      };
    },
    retrieveContext: async () => null,
    beginMetering: async () => {
      if (metering !== undefined && metering !== "charge") return metering;
      world.events.push("meter:charge");
      return { ok: true as const, handle };
    },
    resolveToolMode: async ({ base }) => base,
    skillKeys: () => [],
    runChat: async (resolved, config, messages, options) => {
      world.events.push("model");
      world.chats.push({ resolved, messages, options, model: config.modelConfig.externalModel ?? "" });
      return {
        content: "answer",
        usage: { inputTokens: 12, outputTokens: 34 },
        reportedUsage: { inputTokens: 12, outputTokens: 34 },
        finishReason: "stop",
        toolCalls: [],
        clientToolCalls: [],
        transcript: [],
      } satisfies ChatResult;
    },
    runChatStream: async () => assert.fail("a run with nobody watching never streams"),
    beginRun: () => {
      world.slots.begun += 1;
      return {
        signal: new AbortController().signal,
        done: () => {
          world.slots.done += 1;
        },
      };
    },
    recordUsage: async (record) => {
      world.events.push("usage");
      world.usage.push(record);
    },
    deadlineMs: 120_000,
    ...depOverrides,
  };
  return { deps, world };
}

/** recordUsage is fire-and-forget in the core: let the microtasks run. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

for (const mode of ["scheduled", "job", "test"] as const) {
  test(`a free model in ${mode} mode consults the limiter before the model runs`, async () => {
    const { deps, world } = makeDeps(agent(FREE));
    const result = await createRunAgentChat(deps)({ agent: agent(FREE), prompt: "hi", mode });
    await settled();
    assert.equal(result.content, "answer");
    assert.deepEqual(world.events, ["limit:org-1", "meter:charge", "model", "meter:settle", "usage"]);
    assert.equal(world.chats[0]!.options.mode, mode);
    // Filed under the caller it came from, next to playground and api traffic.
    assert.equal(world.usage[0]!.source, mode);
  });
}

test("the tool mode defaults to scheduled, and an interactive mode is refused", async () => {
  const { deps, world } = makeDeps(agent(OWN_KEY));
  await createRunAgentChat(deps)({ agent: agent(OWN_KEY), prompt: "hi" });
  assert.equal(world.chats[0]!.options.mode, "scheduled");

  await assert.rejects(
    createRunAgentChat(deps)({ agent: agent(OWN_KEY), prompt: "hi", mode: "playground" }),
    /cannot use the "playground" tool mode/,
  );
  assert.equal(world.chats.length, 1, "nothing ran for the refused mode");
});

test("a marketplace buyer's copy runs restricted however the run was triggered", async () => {
  const { deps, world } = makeDeps(agent(OWN_KEY), { resolveToolMode: async () => "trial" });
  await createRunAgentChat(deps)({ agent: agent(OWN_KEY), prompt: "hi", mode: "job" });
  assert.equal(world.chats[0]!.options.mode, "trial");
});

test("a paid job runs in hired mode with the offering's instructions as a system turn, and reports what to meter", async () => {
  const stored = { ...agent(FREE), tools: [{ name: "calculator", description: "" }, { name: "file_read", description: "" }] };
  const { deps, world } = makeDeps(stored);
  const controller = new AbortController();
  const result = await createRunAgentChat(deps)({
    agent: stored,
    prompt: "BRIEF",
    mode: "hired",
    signal: controller.signal,
    systemAddendum: "PRIVATE RUBRIC",
    toolAllowlist: ["calculator"],
  });
  await settled();
  const chat = world.chats[0]!;
  assert.equal(chat.options.mode, "hired");
  assert.deepEqual(chat.messages, [
    { role: "system", content: "PRIVATE RUBRIC" },
    { role: "user", content: "BRIEF" },
  ]);
  // The job's own deadline bounds the run; the interactive one is off.
  assert.equal(chat.options.deadlineMs, undefined);
  assert.equal(world.usage[0]!.source, "hired");
  // The limiter still guards the platform's keys during a paid job.
  assert.equal(world.events[0], "limit:org-1");
  assert.deepEqual(result, {
    content: "answer",
    usage: { inputTokens: 12, outputTokens: 34 },
    model: FREE,
    platformModel: true,
    toolCallCount: 0,
  });

  const own = makeDeps(agent(OWN_KEY));
  const ownResult = await createRunAgentChat(own.deps)({ agent: agent(OWN_KEY), prompt: "x", mode: "hired" });
  assert.equal(ownResult.platformModel, false);
  assert.equal(ownResult.model, OWN_KEY);
});

test("job instructions and a tool allowlist are refused outside hired mode, before anything runs", async () => {
  const { deps, world } = makeDeps(agent(OWN_KEY));
  const run = createRunAgentChat(deps);
  await assert.rejects(
    run({ agent: agent(OWN_KEY), prompt: "hi", mode: "job", systemAddendum: "PRIVATE RUBRIC" }),
    /apply to hired runs only, not "job"/,
  );
  await assert.rejects(
    run({ agent: agent(OWN_KEY), prompt: "hi", toolAllowlist: ["calculator"] }),
    /apply to hired runs only, not "scheduled"/,
  );
  assert.equal(world.chats.length, 0);
  assert.deepEqual(world.events, []);
});

test("over the limit, the call is refused clearly and no model call is made", async () => {
  const { deps, world } = makeDeps(agent(FREE), { allowed: false });
  await assert.rejects(
    createRunAgentChat(deps)({ agent: agent(FREE), prompt: "hi", mode: "job" }),
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

test("usage is recorded with the call's real token counts", async () => {
  const { deps, world } = makeDeps(agent(FREE));
  const result = await createRunAgentChat(deps)({ agent: agent(FREE), prompt: "hi" });
  await settled();
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 34 });
  assert.equal(world.usage.length, 1);
  const { latencyMs: _latency, ...record } = world.usage[0]!;
  assert.deepEqual(record, {
    orgId: "org-1",
    agentId: "agent-1",
    source: "scheduled",
    modelId: FREE,
    freeModel: true,
    streamed: false,
    ok: true,
    clientGone: false,
    usage: { inputTokens: 12, outputTokens: 34 },
    toolCallCount: 0,
  });
});

test("an agent on its own provider key skips the limiter but is still recorded", async () => {
  const { deps, world } = makeDeps(agent(OWN_KEY), { allowed: false });
  const result = await createRunAgentChat(deps)({ agent: agent(OWN_KEY), prompt: "hi", mode: "job" });
  await settled();
  assert.equal(result.content, "answer");
  // The same rollup the playground and /v1 write: every admitted chat.
  assert.deepEqual(world.events, ["meter:charge", "model", "meter:settle", "usage"]);
  assert.equal(world.usage[0]!.freeModel, false);
});

test("a failed usage write never fails a finished run", async () => {
  const { deps } = makeDeps(agent(FREE), {
    recordUsage: async () => {
      throw new Error("db blip");
    },
  });
  const result = await createRunAgentChat(deps)({ agent: agent(FREE), prompt: "hi" });
  await settled();
  assert.equal(result.content, "answer");
});

test("the caller's abort reaches the model call, refunds the meter and surfaces as the abort", async () => {
  const controller = new AbortController();
  const cancel = new Error("cancel");
  const { deps, world } = makeDeps(agent(OWN_KEY), {
    runChat: async (_resolved, _config, _messages, options) => {
      world.events.push("model");
      // The core hands the model the caller's signal joined with shutdown's.
      assert.equal(options.signal?.aborted, false);
      controller.abort(cancel);
      assert.equal(options.signal?.aborted, true, "the caller's abort reached the model call");
      throw new Error("aborted");
    },
  });
  await assert.rejects(
    createRunAgentChat(deps)({
      agent: agent(OWN_KEY),
      prompt: "hi",
      mode: "job",
      signal: controller.signal,
    }),
    // The caller's own reason, so its timeout/cancel handling recognises it.
    (err: unknown) => err === cancel,
  );
  await settled();
  assert.deepEqual(world.events, ["meter:charge", "model", "meter:refund", "usage"]);
  assert.equal(world.usage[0]!.ok, false);
});

test("a failed model call refunds the charge and throws the reason", async () => {
  const { deps, world } = makeDeps(agent(OWN_KEY), {
    runChat: async () => {
      throw Object.assign(new Error("The model provider rejected the key."), {
        name: "ProviderHttpError",
        status: 401,
      });
    },
  });
  await assert.rejects(
    createRunAgentChat(deps)({ agent: agent(OWN_KEY), prompt: "hi" }),
    /The model provider rejected the key\./,
  );
  assert.deepEqual(world.events.slice(0, 2), ["meter:charge", "meter:refund"]);
});

// ============================================
// Model resolution: the playground's, exactly
// ============================================

test("an agent with no model runs on the first available free model, limited like one", async () => {
  const { deps, world } = makeDeps(agent(null));
  await createRunAgentChat(deps)({ agent: agent(null), prompt: "hi" });
  assert.equal(world.chats[0]!.model, FREE);
  assert.equal(world.events[0], "limit:org-1");
});

test("an agent with no model and no free model available is refused before the limiter is touched", async () => {
  const { deps, world } = makeDeps(agent(null), { freeModels: [] });
  await assert.rejects(
    createRunAgentChat(deps)({ agent: agent(null), prompt: "hi" }),
    /No model specified and no free models are available/,
  );
  assert.deepEqual(world.events, []);
});

test("the legacy modelConfig.model key is honoured", async () => {
  const legacy = { ...agent(null), modelConfig: { model: OWN_KEY } };
  const { deps, world } = makeDeps(legacy);
  await createRunAgentChat(deps)({ agent: legacy, prompt: "hi" });
  assert.equal(world.chats[0]!.model, OWN_KEY);
});

test("an organization's own hosted model (wheelsai/<id>) resolves to its deployment", async () => {
  const node = { apiKey: "", baseUrl: "https://node.example/v1", modelName: "meta/llama-3.1-8b" };
  const asked: unknown[] = [];
  const { deps, world } = makeDeps(agent(HOSTED), {
    resolveHostedModel: async (args) => {
      asked.push(args);
      return { ok: true, resolved: node };
    },
  });
  const result = await createRunAgentChat(deps)({ agent: agent(HOSTED), prompt: "hi", mode: "job" });
  assert.equal(result.content, "answer");
  assert.deepEqual(asked, [{ orgId: "org-1", modelId: HOSTED }]);
  assert.equal(world.chats[0]!.resolved, node);
  // Included in the deployment's GPU time: not a free model, no limiter.
  assert.ok(!world.events.includes("limit:org-1"));
});

test("a hosted model with nothing running refuses with the deployment's reason", async () => {
  const { deps, world } = makeDeps(agent(HOSTED), {
    resolveHostedModel: async () => ({ ok: false, message: "no running deployment of it" }),
  });
  await assert.rejects(
    createRunAgentChat(deps)({ agent: agent(HOSTED), prompt: "hi" }),
    /no running deployment of it/,
  );
  assert.deepEqual(world.events, [], "nothing charged, nothing called");
});

test("an agent whose entrypoint is its graph runs the graph, in the caller's mode", async () => {
  for (const mode of ["scheduled", "job", "test"] as const) {
    const { deps, world } = makeDeps(agent(OWN_KEY), {
      row: { entrypoint: "graph" },
      runGraph: async (args): Promise<AgentGraphOutcome> => {
        world.graphRuns.push({ input: args.input, mode: args.mode });
        return {
          kind: "completed",
          output: "from the graph",
          run: { executionId: "exec-1", durationMs: 3, steps: [] },
        };
      },
      answerStream: () => new ReadableStream<Uint8Array>(),
    });
    const result = await createRunAgentChat(deps)({ agent: agent(OWN_KEY), prompt: "summarise", mode });
    assert.equal(result.content, "from the graph");
    assert.deepEqual(world.graphRuns, [{ input: "summarise", mode }]);
    assert.equal(world.chats.length, 0, "the prompt-and-model chat did not run");
    // No provider reports usage for a whole run: unknown, never zero.
    assert.equal(result.usage, undefined);
  }
});

test("a graph run that failed throws; its billing refusals are the typed errors", async () => {
  const graph = (outcome: AgentGraphOutcome) =>
    makeDeps(agent(OWN_KEY), {
      row: { entrypoint: "graph" },
      runGraph: async () => outcome,
      answerStream: () => new ReadableStream<Uint8Array>(),
    }).deps;

  await assert.rejects(
    createRunAgentChat(
      graph({ kind: "failed", failedStep: "Draft", run: { executionId: "e", durationMs: 1, steps: [] } }),
    )({ agent: agent(OWN_KEY), prompt: "hi" }),
    /graph failed at "Draft"/,
  );
  await assert.rejects(
    createRunAgentChat(
      graph({ kind: "payment_required", listingTitle: "Pro", requiredCents: 5n, balanceCents: 1n }),
    )({ agent: agent(OWN_KEY), prompt: "hi" }),
    MarketplacePaymentRequiredError,
  );
});

// ============================================
// Marketplace metering: the core's refusals
// ============================================

test("a buyer who cannot pay is refused before the model runs", async () => {
  const { deps, world } = makeDeps(agent(OWN_KEY), {
    metering: {
      ok: false,
      reason: "insufficient_credits",
      requiredCents: 5n,
      balanceCents: 1n,
      listingTitle: "Pro",
    },
  });
  await assert.rejects(
    createRunAgentChat(deps)({ agent: agent(OWN_KEY), prompt: "hi", mode: "job" }),
    (err: unknown) => err instanceof MarketplacePaymentRequiredError && err.requiredCents === 5n,
  );
  assert.deepEqual(world.events, []);
  assert.deepEqual(world.slots, { begun: 1, done: 1 }, "the shutdown slot is given back");
});

test("a revoked licence is refused before the model runs", async () => {
  const { deps, world } = makeDeps(agent(OWN_KEY), {
    metering: { ok: false, reason: "licence_revoked", listingTitle: "Pro", revocation: "uninstalled" },
  });
  await assert.rejects(
    createRunAgentChat(deps)({ agent: agent(OWN_KEY), prompt: "hi" }),
    MarketplaceLicenceRevokedError,
  );
  assert.deepEqual(world.events, []);
});

test("an agent that is not a per-request install is not charged", async () => {
  const { deps, world } = makeDeps(agent(OWN_KEY), { metering: null });
  await createRunAgentChat(deps)({ agent: agent(OWN_KEY), prompt: "hi" });
  assert.deepEqual(world.events.filter((e) => e.startsWith("meter")), []);
});

// ============================================
// Shutdown and deadlines
// ============================================

test("the run is registered for shutdown before it is charged, and released when it ends", async () => {
  const order: string[] = [];
  const { deps, world } = makeDeps(agent(OWN_KEY), {
    beginRun: () => {
      order.push("register");
      return { signal: new AbortController().signal, done: () => order.push("release") };
    },
  });
  const realBegin = deps.beginMetering;
  deps.beginMetering = async (args) => {
    order.push("charge");
    return realBegin(args);
  };
  await createRunAgentChat(deps)({ agent: agent(OWN_KEY), prompt: "hi" });
  assert.deepEqual(order, ["register", "charge", "release"]);
  assert.ok(world.events.includes("meter:settle"));
});

test("once shutdown has begun the run is refused, uncharged", async () => {
  const { deps, world } = makeDeps(agent(OWN_KEY), { beginRun: () => null });
  await assert.rejects(
    createRunAgentChat(deps)({ agent: agent(OWN_KEY), prompt: "hi" }),
    /the server is restarting; nothing was charged/,
  );
  assert.deepEqual(world.events, []);
});

test("a caller with its own signal bounds the run itself; one without keeps the chat deadline", async () => {
  const bounded = makeDeps(agent(OWN_KEY));
  await createRunAgentChat(bounded.deps)({
    agent: agent(OWN_KEY),
    prompt: "hi",
    signal: new AbortController().signal,
  });
  // A task's timeout can be an hour: the interactive limit must not cut it.
  assert.equal(bounded.world.chats[0]!.options.deadlineMs, undefined);

  const unbounded = makeDeps(agent(OWN_KEY));
  await createRunAgentChat(unbounded.deps)({ agent: agent(OWN_KEY), prompt: "hi", mode: "test" });
  assert.equal(unbounded.world.chats[0]!.options.deadlineMs, 120_000);
});

test("the agent is re-read inside the caller's organization", async () => {
  const { deps, world } = makeDeps(agent(OWN_KEY));
  await assert.rejects(
    createRunAgentChat(deps)({ agent: { ...agent(OWN_KEY), orgId: "org-2" }, prompt: "hi" }),
    /agent agent-1 not found in this organization/,
  );
  assert.deepEqual(world.events, []);
});

test("the deps are built on first use, once", async () => {
  let builds = 0;
  const { deps } = makeDeps(agent(OWN_KEY));
  const run = createRunAgentChat(() => {
    builds += 1;
    return deps;
  });
  assert.equal(builds, 0, "building an executor opens nothing");
  await run({ agent: agent(OWN_KEY), prompt: "a" });
  await run({ agent: agent(OWN_KEY), prompt: "b" });
  assert.equal(builds, 1);
});
