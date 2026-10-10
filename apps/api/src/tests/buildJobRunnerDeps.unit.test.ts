import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { buildJobRunnerDeps, JOB_FOR_RUN_SELECT, platformUsageOf } from "../services/buildJobRunnerDeps.js";
import type { JobForRun, ProductRunArgs } from "../services/jobRunner.js";

// Binding tests for the job runner's production deps: whose organization a
// job runs in, which inference path it takes, and what it is told.

const JOB: JobForRun = {
  id: "job_1",
  buyerId: "org_buyer",
  publisherId: "org_pub",
  status: "running",
  input: { url: "https://example.com" },
  deadlineAt: new Date("2026-10-06T13:00:00Z"),
  leaseExpiresAt: null,
  attempts: 1,
  terms: { title: "Teardown", outputFormat: "text", deliverableChecks: [] },
  offering: {
    id: "off_1",
    title: "Teardown",
    productKind: "agent",
    agentId: "agent_1",
    orchestrationId: null,
    deploymentId: "dep_1",
    inputSchema: null,
    instructions: "private",
    allowedTools: [],
    maxAttempts: 1,
  },
};

function args(extra: Partial<ProductRunArgs> = {}): ProductRunArgs {
  return {
    job: JOB,
    brief: "<buyer_input>{}</buyer_input>",
    systemAddendum: "Instructions for this job: private",
    toolAllowlist: [],
    signal: new AbortController().signal,
    ...extra,
  };
}

function build(over: Parameters<typeof buildJobRunnerDeps>[0] = {}) {
  const loads: Array<{ agentId: string; orgId: string }> = [];
  const chats: Array<Record<string, unknown>> = [];
  const modelCalls: Array<Record<string, unknown>> = [];
  const queries: unknown[] = [];
  let transactions = 0;
  const deps = buildJobRunnerDeps({
    prisma: {
      job: {
        findUnique: async (query) => {
          queries.push(query);
          return { ...JOB, terms: "not an object" };
        },
        updateMany: async () => ({ count: 1 }),
      },
      orchestrationExecution: { findUnique: async () => null },
      $transaction: async (fn) => {
        transactions++;
        return fn({ marker: "tx" });
      },
    },
    executor: {
      loadAgent: async (agentId, orgId) => {
        loads.push({ agentId, orgId });
        return orgId === "org_pub"
          ? { id: agentId, orgId, name: "Atlas", systemPrompt: "You are Atlas.", tools: [], modelConfig: {}, env: {} }
          : null;
      },
      runAgentChat: async (chat) => {
        chats.push(chat as unknown as Record<string, unknown>);
        return { content: "the report", usage: { inputTokens: 120, outputTokens: 30 }, model: "free/groq/x", platformModel: true };
      },
    },
    chatWithDeployment: async (request) => {
      modelCalls.push(request as unknown as Record<string, unknown>);
      return { content: "model answer", usage: null, finishReason: "stop", billing: { mode: "gpu_included", chargedCents: 0 }, requestId: "r1" };
    },
    notify: async () => {},
    maxRunMs: 60_000,
    platformModelRates: { inputCentsPerMTok: 15, outputCentsPerMTok: 60 },
    ...over,
  });
  return { deps, loads, chats, modelCalls, queries, transactions: () => transactions };
}

test("the agent is loaded in the publisher's organization and run through the shared chat in hired mode", async () => {
  const { deps, loads, chats } = build();
  const signal = new AbortController().signal;
  const run = await deps.runAgent({ ...args({ signal, toolAllowlist: ["web_search"] }), agentId: "agent_1" });

  // The publisher's organization, never the buyer's.
  assert.deepEqual(loads, [{ agentId: "agent_1", orgId: "org_pub" }]);
  assert.equal(chats.length, 1);
  const chat = chats[0]!;
  assert.equal(chat.mode, "hired");
  assert.equal(chat.prompt, "<buyer_input>{}</buyer_input>");
  assert.equal(chat.systemAddendum, "Instructions for this job: private");
  assert.deepEqual(chat.toolAllowlist, ["web_search"]);
  assert.equal(chat.signal, signal);
  assert.equal((chat.agent as { orgId: string }).orgId, "org_pub");

  assert.equal(run.content, "the report");
  // The agent's system prompt is what the deliverable must not repeat.
  assert.deepEqual(run.confidential, ["You are Atlas."]);
  assert.deepEqual(run.platformUsage, { inputTokens: 120, outputTokens: 30 });
});

test("an empty allowlist is not sent, so the offering allows every tool the mode does", async () => {
  const { deps, chats } = build();
  await deps.runAgent({ ...args(), agentId: "agent_1" });
  assert.equal("toolAllowlist" in chats[0]!, false);
});

test("an agent that is no longer the publisher's fails the run instead of running someone else's", async () => {
  const { deps, chats } = build();
  const foreign = { ...JOB, publisherId: "org_other" };
  await assert.rejects(deps.runAgent({ ...args({ job: foreign }), agentId: "agent_1" }), /no longer exists/);
  assert.equal(chats.length, 0);
});

test("the default agent path is buildProductionExecutorDeps: the one inference path", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(fileURLToPath(new URL("../services/buildJobRunnerDeps.ts", import.meta.url)), "utf8");
  assert.match(source, /overrides\.executor \?\? buildProductionExecutorDeps\(\)/);
  // No second chat implementation here.
  assert.doesNotMatch(source, /runChat\(|prepareAgentChat\(/);
});

test("a model job calls the publisher's own deployment with the instructions as a system turn", async () => {
  const { deps, modelCalls } = build();
  const run = await deps.runModel({ ...args(), deploymentId: "dep_1" });
  assert.equal(modelCalls[0]!.orgId, "org_pub");
  assert.equal(modelCalls[0]!.deploymentId, "dep_1");
  assert.deepEqual(modelCalls[0]!.messages, [
    { role: "system", content: "Instructions for this job: private" },
    { role: "user", content: "<buyer_input>{}</buyer_input>" },
  ]);
  // The publisher's deployment is billed by its own rules, not metered again.
  assert.equal(run.platformUsage, null);
  assert.equal(run.content, "model answer");
});

test("the job is loaded with the fields a run needs and nothing else, and money moves inside $transaction", async () => {
  const { deps, queries, transactions } = build();
  const job = await deps.loadJob("job_1");
  assert.deepEqual(queries, [{ where: { id: "job_1" }, select: JOB_FOR_RUN_SELECT }]);
  // Terms that are not an object read as empty rather than crashing the run.
  assert.deepEqual(job?.terms, {});
  assert.equal("buyer" in JOB_FOR_RUN_SELECT, false);
  // The order of the form's questions is read with the schema, for the brief.
  assert.equal(JOB_FOR_RUN_SELECT.offering.select.inputOrder, true);
  // A job whose offering has no remembered order runs on the schema as stored.
  assert.equal(job?.offering.inputSchema, null);
  assert.equal("inputOrder" in (job?.offering ?? {}), false);

  const got = await deps.inTransaction(async (tx) => (tx as unknown as { marker: string }).marker);
  assert.equal(got, "tx");
  assert.equal(transactions(), 1);
});

test("notify never throws", async () => {
  const { deps } = build({
    notify: async () => {
      throw new Error("webhook endpoint down");
    },
  });
  await assert.doesNotReject(deps.notify("job.submitted", "job_1"));
});

test("usage on the platform's keys is metered; a provider that reports none is estimated, never free", () => {
  assert.equal(platformUsageOf({ content: "x", platformModel: false, usage: { inputTokens: 5, outputTokens: 5 } }, 400), null);
  assert.deepEqual(
    platformUsageOf({ content: "x", platformModel: true, usage: { inputTokens: 5, outputTokens: 7 } }, 400),
    { inputTokens: 5, outputTokens: 7 },
  );
  assert.deepEqual(platformUsageOf({ content: "a".repeat(80), platformModel: true }, 400), {
    inputTokens: 100,
    outputTokens: 20,
  });
});
