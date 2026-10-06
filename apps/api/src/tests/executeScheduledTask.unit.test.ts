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
// executor shared by the scheduler worker and "trigger now". It
// dispatches through the task-type registry: agent_run, webhook,
// data_sync, health_check, report, cleanup, custom and workflow_run each
// run for real (see scheduledTaskExecutors.unit.test.ts for the last
// six); a type that is not registered, or whose services are not wired
// into the process, refuses honestly.

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

test("only a truly unknown task type refuses now, and it is not retried", async () => {
  const { executeScheduledTask } = await import(
    "../services/executeScheduledTask.js"
  );
  const { isPermanentFailure } = await import("../services/scheduledTasks/taskError.js");
  const { deps, chatCalls, fetchCalls } = makeDeps({});
  await assert.rejects(
    executeScheduledTask(baseTask({ taskType: "telepathy" }), deps),
    (err: unknown) => {
      assert.match((err as Error).message, /task type "telepathy" is not supported/);
      assert.equal(isPermanentFailure(err), true);
      return true;
    },
  );
  assert.equal(chatCalls.length + fetchCalls.length, 0);
});

test("a registered type whose services are not wired refuses by name instead of fabricating success", async () => {
  const { executeScheduledTask } = await import(
    "../services/executeScheduledTask.js"
  );
  const { deps } = makeDeps({});
  const payloads: Record<string, unknown> = {
    data_sync: { knowledgeBaseId: "11111111-1111-4111-8111-111111111111", sources: [{ url: "https://example.com" }] },
    health_check: { target: "url", url: "https://example.com" },
    report: {},
    cleanup: { archiveConversationsOlderThanDays: 30 },
    custom: { input: "go" },
    workflow_run: {},
  };
  for (const [taskType, payload] of Object.entries(payloads)) {
    await assert.rejects(
      executeScheduledTask(baseTask({ taskType, payload }), deps),
      new RegExp(`task type "${taskType}" cannot run here: its services are not connected`),
      taskType,
    );
  }
});

test("a stored payload that is not valid for its type fails naming the field, without running", async () => {
  const { executeScheduledTask } = await import(
    "../services/executeScheduledTask.js"
  );
  const { deps } = makeDeps({});
  await assert.rejects(
    executeScheduledTask(
      baseTask({ taskType: "health_check", payload: { target: "url" } }),
      { ...deps, taskTypes: { healthCheck: {} as never } },
    ),
    /payload is not valid for a health_check task \(payload\.url: a url health check needs url\)/,
  );
});

test("agent_run hands the run's abort signal to the model call", async () => {
  const { executeScheduledTask } = await import(
    "../services/executeScheduledTask.js"
  );
  const { deps } = makeDeps({});
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  await executeScheduledTask(
    baseTask(),
    {
      ...deps,
      runAgentChat: async ({ signal }) => {
        seen = signal;
        return { content: "ok" };
      },
    },
    { signal: controller.signal },
  );
  assert.equal(seen, controller.signal);
});

test("a webhook body carries executionId and attempt so a receiver can drop a retry", async () => {
  const { executeScheduledTask } = await import(
    "../services/executeScheduledTask.js"
  );
  const { deps, fetchCalls } = makeDeps({});
  await executeScheduledTask(
    baseTask({ taskType: "webhook", payload: { url: "https://example.com/hook", body: { a: 1 } } }),
    deps,
    { executionId: "exec_7", attempt: 2, now: new Date("2026-10-06T12:00:00Z") },
  );
  assert.deepEqual(fetchCalls[0]!.body, {
    taskId: "task_1",
    taskName: "digest",
    executionId: "exec_7",
    attempt: 2,
    firedAt: "2026-10-06T12:00:00.000Z",
    body: { a: 1 },
  });
});

test("webhook headers are sent, and a header that steers routing is refused before any request", async () => {
  const { executeScheduledTask } = await import(
    "../services/executeScheduledTask.js"
  );
  const seen: Array<Record<string, string>> = [];
  const { deps } = makeDeps({});
  const capturing = {
    ...deps,
    fetchFn: (async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch,
  };
  await executeScheduledTask(
    baseTask({
      taskType: "webhook",
      payload: { url: "https://example.com/hook", headers: { "X-Api-Key": "k", "Content-Type": "text/plain" } },
    }),
    capturing,
  );
  assert.equal(seen[0]!["X-Api-Key"], "k");
  assert.equal(seen[0]!["Content-Type"], "application/json", "the body is JSON whatever was asked");

  await assert.rejects(
    executeScheduledTask(
      baseTask({ taskType: "webhook", payload: { url: "https://example.com/hook", headers: { Host: "internal" } } }),
      capturing,
    ),
    /webhook headers refused/,
  );
  assert.equal(seen.length, 1);
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
