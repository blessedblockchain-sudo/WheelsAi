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

// Drives apps/api/src/services/executeScheduledTask.ts — the per-task
// executor shared by the scheduler worker and "trigger now" (Wave 1).
// Two real types (agent_run, webhook); everything else refuses honestly.

import type {
  ScheduledTaskForExecution,
  ExecuteScheduledTaskDeps,
} from "../services/executeScheduledTask.js";

function baseTask(
  overrides: Partial<ScheduledTaskForExecution> = {},
): ScheduledTaskForExecution {
  return {
    id: "task_1",
    orgId: "org_1",
    agentId: "agent_1",
    name: "digest",
    taskType: "agent_run",
    payload: { prompt: "summarize the day" },
    timeout: 10_000,
    ...overrides,
  };
}

function makeDeps(opts: {
  agent?: { id: string } | null;
  chatContent?: string;
  fetchStatus?: number;
  fetchError?: Error;
}) {
  const chatCalls: Array<{ prompt: string }> = [];
  const fetchCalls: Array<{ url: string; body: unknown }> = [];
  const deps: ExecuteScheduledTaskDeps = {
    loadAgent: async () =>
      opts.agent === null
        ? null
        : ({
            id: "agent_1",
            name: "Agent",
            systemPrompt: null,
            tools: [],
            modelConfig: { model: "llama-3.1-8b" },
            env: {},
          } as never),
    runAgentChat: async ({ prompt }) => {
      chatCalls.push({ prompt });
      return { content: opts.chatContent ?? "done", usage: { totalTokens: 10 } };
    },
    fetchFn: (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (opts.fetchError) throw opts.fetchError;
      fetchCalls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return {
        ok: (opts.fetchStatus ?? 200) < 400,
        status: opts.fetchStatus ?? 200,
      } as Response;
    }) as typeof fetch,
  };
  return { deps, chatCalls, fetchCalls };
}

test("agent_run invokes the agent with the payload prompt and returns its content", async () => {
  setupEnv();
  const { executeScheduledTask } = await import(
    "../services/executeScheduledTask.js"
  );
  const { deps, chatCalls } = makeDeps({ chatContent: "the digest" });
  const result = await executeScheduledTask(baseTask(), deps);

  assert.deepEqual(chatCalls, [{ prompt: "summarize the day" }]);
  assert.deepEqual(result.output, {
    content: "the digest",
    usage: { totalTokens: 10 },
  });
});

test("agent_run falls back to a task-name prompt when the payload has none", async () => {
  const { executeScheduledTask } = await import(
    "../services/executeScheduledTask.js"
  );
  const { deps, chatCalls } = makeDeps({});
  await executeScheduledTask(baseTask({ payload: {} }), deps);
  assert.match(chatCalls[0]!.prompt, /Run scheduled task: digest/);
});

test("agent_run fails clearly when the agent is gone", async () => {
  const { executeScheduledTask } = await import(
    "../services/executeScheduledTask.js"
  );
  const { deps } = makeDeps({ agent: null });
  await assert.rejects(
    executeScheduledTask(baseTask(), deps),
    /agent agent_1 not found/,
  );
});

test("webhook POSTs the payload to the configured URL", async () => {
  const { executeScheduledTask } = await import(
    "../services/executeScheduledTask.js"
  );
  const { deps, fetchCalls } = makeDeps({});
  const result = await executeScheduledTask(
    baseTask({
      taskType: "webhook",
      payload: { url: "https://example.com/hook", body: { a: 1 } },
    }),
    deps,
  );
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]!.url, "https://example.com/hook");
  assert.deepEqual((fetchCalls[0]!.body as { body: unknown }).body, { a: 1 });
  assert.deepEqual(result.output, { status: 200 });
});

test("webhook non-2xx is a failure, and a missing/invalid url refuses up front", async () => {
  const { executeScheduledTask } = await import(
    "../services/executeScheduledTask.js"
  );
  const { deps } = makeDeps({ fetchStatus: 503 });
  await assert.rejects(
    executeScheduledTask(
      baseTask({ taskType: "webhook", payload: { url: "https://example.com/h" } }),
      deps,
    ),
    /webhook responded 503/,
  );
  await assert.rejects(
    executeScheduledTask(
      baseTask({ taskType: "webhook", payload: { url: "ftp://nope" } }),
      deps,
    ),
    /requires a payload.url/,
  );
});

test("unsupported task types refuse honestly instead of fabricating success", async () => {
  const { executeScheduledTask } = await import(
    "../services/executeScheduledTask.js"
  );
  const { deps } = makeDeps({});
  for (const taskType of ["data_sync", "health_check", "report", "cleanup", "custom"]) {
    await assert.rejects(
      executeScheduledTask(baseTask({ taskType }), deps),
      /not supported yet/,
    );
  }
});

// ============================================
// Webhook SSRF: validated on every hop, and no address oracle
// ============================================

test("a webhook whose host resolves to an internal address is refused without naming the address", async () => {
  const { executeScheduledTask } = await import("../services/executeScheduledTask.js");
  const { deps, fetchCalls } = makeDeps({});
  await assert.rejects(
    executeScheduledTask(
      baseTask({ taskType: "webhook", payload: { url: "https://hooks.corp.example/x" } }),
      { ...deps, guardDeps: { resolveHost: async () => ["10.0.3.7"] } },
    ),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.equal(
        message,
        "webhook URL refused: blocked outbound request: the host does not resolve to a public internet address",
      );
      assert.ok(!message.includes("10.0.3.7"), "the execution row is user-visible");
      return true;
    },
  );
  assert.equal(fetchCalls.length, 0);
});

test("a bracketed IPv4-mapped loopback webhook URL is refused", async () => {
  const { executeScheduledTask } = await import("../services/executeScheduledTask.js");
  const { deps, fetchCalls } = makeDeps({});
  for (const url of ["http://[::ffff:127.0.0.1]:6379/", "http://[::ffff:a9fe:a9fe]/latest/meta-data/"]) {
    await assert.rejects(
      executeScheduledTask(baseTask({ taskType: "webhook", payload: { url } }), deps),
      /webhook URL refused/,
      url,
    );
  }
  assert.equal(fetchCalls.length, 0);
});

test("a webhook that answers with a redirect is NOT followed (a 302 to the metadata endpoint)", async () => {
  const { executeScheduledTask } = await import("../services/executeScheduledTask.js");
  const calls: string[] = [];
  const { deps } = makeDeps({});
  const redirecting: typeof deps = {
    ...deps,
    guardDeps: { resolveHost: async () => ["93.184.216.34"] },
    fetchFn: (async (url: string) => {
      calls.push(String(url));
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    }) as unknown as typeof fetch,
  };
  await assert.rejects(
    executeScheduledTask(
      baseTask({ taskType: "webhook", payload: { url: "https://example.com/hook" } }),
      redirecting,
    ),
    /webhook URL redirected; redirects are not followed/,
  );
  assert.deepEqual(calls, ["https://example.com/hook"], "the redirect target was never requested");
});
