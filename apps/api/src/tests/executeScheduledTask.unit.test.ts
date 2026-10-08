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
    // The webhook URL passes the SSRF guard, which resolves the host: answer
    // here so the test needs no DNS and cannot flake on it.
    guardDeps: { resolveHost: async () => ["93.184.216.34"] },
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

// ============================================
// Refusals are final; everything else retries as before
// ============================================

/** A refusal as services/sharedAgentChat.ts marks it. */
function refusal(kind: string, message: string, name = "Error"): Error {
  const err = new Error(message);
  err.name = name;
  Object.defineProperty(err, "chatRefusal", { value: kind, enumerable: false });
  return err;
}

async function failureOf(task: ScheduledTaskForExecution, thrown: unknown, signal?: AbortSignal) {
  const { executeScheduledTask } = await import("../services/executeScheduledTask.js");
  const { isPermanentFailure } = await import("../services/scheduledTasks/taskError.js");
  const { deps } = makeDeps({});
  let calls = 0;
  deps.runAgentChat = async () => {
    calls += 1;
    throw thrown;
  };
  let caught: unknown;
  try {
    await executeScheduledTask(task, deps, signal ? { signal } : {});
  } catch (err) {
    caught = err;
  }
  assert.ok(caught !== undefined, "the run was expected to fail");
  return { caught, calls, permanent: isPermanentFailure(caught) };
}

for (const [label, thrown] of [
  [
    "the free-model limit",
    refusal("rate_limited", "free-model limit reached for this org; retry later or use your own provider key"),
  ],
  [
    "a payment refusal",
    refusal("payment_required", "This agent is billed per request by its publisher.", "MarketplacePaymentRequiredError"),
  ],
  [
    "an ended licence",
    refusal("licence_revoked", "Your licence for Pro has ended.", "MarketplaceLicenceRevokedError"),
  ],
] as const) {
  test(`agent_run: ${label} ends the firing at once, with the message it came with`, async () => {
    const { caught, calls, permanent } = await failureOf(baseTask(), thrown);
    assert.equal(permanent, true, "the tick does not spend a retry on it");
    assert.equal((caught as Error).message, thrown.message);
    assert.equal(calls, 1);
  });
}

test("agent_run: a refusal is final through the tick too: one execution, no backoff, reported once", async () => {
  const { executeScheduledTask } = await import("../services/executeScheduledTask.js");
  const { runTaskFiring } = await import("../services/runSchedulerTick.js");
  const { deps } = makeDeps({});
  let chats = 0;
  deps.runAgentChat = async () => {
    chats += 1;
    throw refusal("rate_limited", "free-model limit reached for this org; retry later or use your own provider key");
  };
  const row = {
    ...baseTask(),
    orchestrationId: null,
    maxRetries: 3,
    scheduleType: "cron",
    cronExpression: "0 9 * * *",
    intervalSeconds: null,
    scheduledAt: null,
    timezone: "UTC",
    nextRunAt: new Date("2026-10-14T09:00:00Z"),
  };
  const sleeps: number[] = [];
  const finishes: Array<{ status: string; retryAt?: Date }> = [];
  let executions = 0;
  const firing = await runTaskFiring(row, { triggeredBy: "schedule" }, {
    createExecution: async () => ({ id: `exec_${++executions}` }),
    executeTask: (t, ctx) => executeScheduledTask(t, deps, ctx),
    finishExecution: async (_id, _t, outcome) => {
      finishes.push({ status: outcome.status, retryAt: outcome.retryAt });
      return true;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(firing.status, "failed");
  assert.equal(firing.attempts, 1);
  assert.equal(chats, 1, "the agent was asked once");
  assert.equal(executions, 1);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(finishes, [{ status: "failed", retryAt: undefined }]);
});

test("agent_run: a graph run's own billing errors are final by their name", async () => {
  const unmarked = Object.assign(new Error("top up to keep using it"), { name: "MarketplacePaymentRequiredError" });
  assert.equal((await failureOf(baseTask(), unmarked)).permanent, true);
  const ended = Object.assign(new Error("licence ended"), { name: "MarketplaceLicenceRevokedError" });
  assert.equal((await failureOf(baseTask(), ended)).permanent, true);
});

test("agent_run: 'the server is restarting' stays retryable", async () => {
  const restart = refusal("shutting_down", "the server is restarting; nothing was charged - retry in a moment");
  const { caught, permanent } = await failureOf(baseTask(), restart);
  assert.equal(permanent, false);
  assert.equal(caught, restart, "thrown on as it was");
});

test("agent_run: a failed model call stays retryable, as does any other refusal", async () => {
  const model = new Error("The model provider rejected the key.");
  const failed = await failureOf(baseTask(), model);
  assert.equal(failed.permanent, false);
  assert.equal(failed.caught, model);

  for (const kind of ["hosted_model_unavailable", "not_configured", "model_invalid", "agent_not_found"]) {
    const other = refusal(kind, "No model is available for this agent right now.");
    assert.equal((await failureOf(baseTask(), other)).permanent, false, kind);
  }
});

test("agent_run: a timeout or cancel is seen as the abort, never turned into a final failure", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("task timeout", "AbortError"));
  const marked = refusal("rate_limited", "free-model limit reached");
  const { caught, permanent } = await failureOf(baseTask(), marked, controller.signal);
  assert.equal(permanent, false);
  assert.equal(caught, marked);
});

test("the inference alias makes refusals final too; no other type's errors change", async () => {
  const limit = refusal("rate_limited", "free-model limit reached");
  assert.equal((await failureOf(baseTask({ taskType: "inference" }), limit)).permanent, true);

  // A webhook that answers 500 is retried as it always was.
  const { executeScheduledTask } = await import("../services/executeScheduledTask.js");
  const { isPermanentFailure } = await import("../services/scheduledTasks/taskError.js");
  const { deps } = makeDeps({ fetchStatus: 500 });
  await assert.rejects(
    executeScheduledTask(
      baseTask({ taskType: "webhook", agentId: null, payload: { url: "https://example.com/hook" } }),
      deps,
    ),
    (err: unknown) => !isPermanentFailure(err) && /webhook responded 500/.test((err as Error).message),
  );
});

// ============================================
// The date line
// ============================================

test("runDateLine says the run's date and time on the wall clock of the given zone", async () => {
  const { runDateLine } = await import("../services/executeScheduledTask.js");
  const at = new Date("2026-10-14T07:00:00Z");
  assert.equal(runDateLine(at, "Europe/Berlin"), "It is Wednesday 14 October 2026, 09:00 (Europe/Berlin).");
  assert.equal(runDateLine(at, "UTC"), "It is Wednesday 14 October 2026, 07:00 (UTC).");
  assert.equal(runDateLine(at, "America/New_York"), "It is Wednesday 14 October 2026, 03:00 (America/New_York).");
  // Half-hour zones, and a zone already in the next day.
  assert.equal(runDateLine(at, "Asia/Kolkata"), "It is Wednesday 14 October 2026, 12:30 (Asia/Kolkata).");
  assert.equal(
    runDateLine(new Date("2026-10-14T20:15:00Z"), "Asia/Tokyo"),
    "It is Thursday 15 October 2026, 05:15 (Asia/Tokyo).",
  );
  // ...and one still in the day before.
  assert.equal(
    runDateLine(new Date("2026-01-01T03:05:00Z"), "America/Los_Angeles"),
    "It is Wednesday 31 December 2025, 19:05 (America/Los_Angeles).",
  );
  // Midnight is 00:00, never 24:00.
  assert.equal(runDateLine(new Date("2026-10-14T00:00:00Z"), "UTC"), "It is Wednesday 14 October 2026, 00:00 (UTC).");
});

test("runDateLine follows daylight saving: the hour that does not exist, and both sides of the change", async () => {
  const { runDateLine } = await import("../services/executeScheduledTask.js");
  // Europe/Berlin springs forward on 29 March 2026 at 01:00 UTC: 01:59 is
  // followed by 03:00.
  assert.equal(
    runDateLine(new Date("2026-03-29T00:59:00Z"), "Europe/Berlin"),
    "It is Sunday 29 March 2026, 01:59 (Europe/Berlin).",
  );
  assert.equal(
    runDateLine(new Date("2026-03-29T01:00:00Z"), "Europe/Berlin"),
    "It is Sunday 29 March 2026, 03:00 (Europe/Berlin).",
  );
  // It falls back on 25 October 2026 at 01:00 UTC: the same instant a day
  // apart reads an hour apart on the wall.
  assert.equal(
    runDateLine(new Date("2026-10-24T07:00:00Z"), "Europe/Berlin"),
    "It is Saturday 24 October 2026, 09:00 (Europe/Berlin).",
  );
  assert.equal(
    runDateLine(new Date("2026-10-25T07:00:00Z"), "Europe/Berlin"),
    "It is Sunday 25 October 2026, 08:00 (Europe/Berlin).",
  );
  // New York, the other way round in the year.
  assert.equal(
    runDateLine(new Date("2026-03-08T07:00:00Z"), "America/New_York"),
    "It is Sunday 8 March 2026, 03:00 (America/New_York).",
  );
});

test("runDateLine reads a missing or unknown zone as UTC and says UTC", async () => {
  const { runDateLine } = await import("../services/executeScheduledTask.js");
  const at = new Date("2026-10-14T07:00:00Z");
  const utc = "It is Wednesday 14 October 2026, 07:00 (UTC).";
  assert.equal(runDateLine(at, "Mars/Olympus_Mons"), utc);
  assert.equal(runDateLine(at, ""), utc);
  assert.equal(runDateLine(at, null), utc);
  assert.equal(runDateLine(at, undefined), utc);
});

test("agent_run puts the date line ahead of the prompt only when stampTime is true, in the task's zone", async () => {
  const { executeScheduledTask } = await import("../services/executeScheduledTask.js");
  const now = new Date("2026-10-14T07:00:00Z");
  const promptFor = async (payload: Record<string, unknown>, timezone?: string) => {
    const { deps, chatCalls } = makeDeps({});
    await executeScheduledTask({ ...baseTask({ payload }), ...(timezone ? { timezone } : {}) }, deps, { now });
    return chatCalls[0]!.prompt;
  };

  assert.equal(
    await promptFor({ prompt: "summarize the day", stampTime: true }, "Europe/Berlin"),
    "It is Wednesday 14 October 2026, 09:00 (Europe/Berlin).\n\nsummarize the day",
  );
  assert.equal(
    await promptFor({ prompt: "summarize the day", stampTime: true }, "Asia/Tokyo"),
    "It is Wednesday 14 October 2026, 16:00 (Asia/Tokyo).\n\nsummarize the day",
  );
  // Absent or false: exactly the prompt it has always been.
  assert.equal(await promptFor({ prompt: "summarize the day" }, "Europe/Berlin"), "summarize the day");
  assert.equal(await promptFor({ prompt: "summarize the day", stampTime: false }, "Europe/Berlin"), "summarize the day");
  // Only the boolean turns it on.
  assert.equal(await promptFor({ prompt: "summarize the day", stampTime: "true" }, "Europe/Berlin"), "summarize the day");
  // The fallback prompt is stamped like any other.
  assert.equal(
    await promptFor({ stampTime: true }, "UTC"),
    "It is Wednesday 14 October 2026, 07:00 (UTC).\n\nRun scheduled task: digest",
  );
});
