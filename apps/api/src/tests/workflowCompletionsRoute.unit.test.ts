import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";

import Fastify, { type FastifyInstance } from "fastify";

import type { WorkflowChatDeps, WorkflowRunSnapshot } from "../services/workflowChat.js";

// The HTTP side of a workflow answered as a chat completion: OpenAI's
// response, stream and error shapes, and what the socket does to the run.

const ORG = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const WORKFLOW = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "nightly-report",
  name: "Nightly report",
  isEnabled: true,
  timeout: 60_000,
  inputSchema: {},
  createdAt: new Date("2026-10-03T00:00:00Z"),
};

function finishedRun(over: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    id: RUN_ID,
    status: "completed",
    output: {},
    context: { draft: { output: "the report" } },
    error: null,
    durationMs: 1200,
    stepOrder: ["draft"],
    failedStepName: null,
    steps: [
      {
        stepName: "draft",
        stepType: "agent",
        status: "success",
        iteration: null,
        durationMs: 1100,
        error: null,
        usage: { inputTokens: 20, outputTokens: 30 },
      },
    ],
    ...over,
  };
}

interface Built {
  app: FastifyInstance;
  calls: string[];
  /** Resolves the in-flight wait; the run is "running" until then. */
  release: () => void;
}

async function buildApp(
  opts: { run?: WorkflowRunSnapshot; hold?: boolean; deps?: Partial<WorkflowChatDeps>; heartbeatMs?: number } = {},
): Promise<Built> {
  const { createWorkflowCompletionRoutes } = await import("../routes/workflowCompletions.js");
  const { openAiErrorHandler } = await import("../middleware/openaiAuth.js");
  const calls: string[] = [];
  let released = !opts.hold;
  let wake: (() => void) | null = null;
  const release = () => {
    released = true;
    wake?.();
  };

  const deps: WorkflowChatDeps = {
    findWorkflow: async (orgId, slug) => (orgId === ORG && slug === WORKFLOW.slug ? WORKFLOW : null),
    startRun: async () => {
      calls.push("start");
      return { id: RUN_ID };
    },
    runStatus: async () => (released ? (opts.run?.status ?? "completed") : "running"),
    loadRun: async () => opts.run ?? finishedRun(),
    cancelRun: async () => {
      calls.push("cancel");
    },
    // Wakes on release or on the client leaving, like the real sleep.
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        if (released || signal.aborted) return resolve();
        wake = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    now: () => 1_760_000_000_000,
    ...opts.deps,
  };

  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as { auth: unknown }).auth = { userId: "user-1", orgId: ORG, type: "jwt" };
  });
  await app.register(
    async (v1) => {
      v1.setErrorHandler(openAiErrorHandler);
      await v1.register(
        createWorkflowCompletionRoutes({
          workflowDeps: () => deps,
          workflowAuth: async () => {},
          now: () => 1_760_000_000_000,
          workflowHeartbeatMs: opts.heartbeatMs ?? 0,
        }),
      );
    },
    { prefix: "/v1" },
  );
  await app.ready();
  return { app, calls, release };
}

const URL = "/v1/workflows/nightly-report/chat/completions";
const MESSAGES = [{ role: "user", content: "write the report" }];
const post = (app: FastifyInstance, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: URL, payload: { messages: MESSAGES, ...payload } });

/** The `data:` payloads of an SSE body, parsed; "[DONE]" stays a string. */
function events(body: string): unknown[] {
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("data:"))
    .map((frame) => {
      const data = frame.slice(5).trim();
      return data === "[DONE]" ? data : JSON.parse(data);
    });
}

test("a completed run is a chat.completion: the output as the assistant message, usage summed, the run in wheelsai", async () => {
  const { app, calls } = await buildApp();
  try {
    const res = await post(app, {});
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.match(body.id, /^chatcmpl-/);
    assert.equal(body.object, "chat.completion");
    assert.equal(body.created, 1_760_000_000);
    assert.equal(body.model, "workflow/nightly-report");
    assert.deepEqual(body.choices, [
      {
        index: 0,
        message: { role: "assistant", content: "the report", refusal: null },
        logprobs: null,
        finish_reason: "stop",
      },
    ]);
    assert.deepEqual(body.usage, { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 });
    assert.deepEqual(body.wheelsai.workflow, {
      slug: "nightly-report",
      executionId: RUN_ID,
      status: "completed",
      durationMs: 1200,
      steps: [{ name: "draft", type: "agent", status: "success", durationMs: 1100, error: null }],
    });
    assert.match(String(res.headers["x-request-id"]), /^req_/);
    assert.deepEqual(calls, ["start"]);
  } finally {
    await app.close();
  }
});

test("usage is left out, not zero-filled, when a step's model call reported none", async () => {
  const run = finishedRun();
  run.steps.push({ ...run.steps[0]!, stepName: "graph", usage: { unreported: true } });
  const { app } = await buildApp({ run });
  try {
    const body = (await post(app, {})).json();
    assert.equal("usage" in body, false);
    assert.equal(body.choices[0].message.content, "the report");
  } finally {
    await app.close();
  }
});

test("a failed run is 502 workflow_failed with the execution id, the failed step, and no SDK retry", async () => {
  const { app } = await buildApp({
    run: finishedRun({ status: "failed", error: "provider down", failedStepName: "draft", context: {} }),
  });
  try {
    const res = await post(app, {});
    assert.equal(res.statusCode, 502);
    const { error } = res.json();
    assert.equal(error.code, "workflow_failed");
    assert.equal(error.type, "server_error");
    assert.equal(error.message, 'Workflow step "draft" failed: provider down');
    assert.equal(error.executionId, RUN_ID);
    assert.equal(error.failedStep, "draft");
    assert.equal(error.workflow.status, "failed");
    // A repeat would be a whole new run, billed again.
    assert.equal(res.headers["x-should-retry"], "false");
  } finally {
    await app.close();
  }
});

test("a run stopped by its time limit is 504 workflow_timeout; an externally cancelled one is 409", async () => {
  const timedOut = await buildApp({
    run: finishedRun({ status: "failed", error: "workflow timed out after 60000ms", context: {} }),
  });
  try {
    const res = await post(timedOut.app, {});
    assert.equal(res.statusCode, 504);
    assert.equal(res.json().error.code, "workflow_timeout");
    assert.equal(res.headers["x-should-retry"], "false");
  } finally {
    await timedOut.app.close();
  }

  const cancelled = await buildApp({ run: finishedRun({ status: "cancelled", context: {} }) });
  try {
    const res = await post(cancelled.app, {});
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "workflow_cancelled");
    assert.equal(res.headers["x-should-retry"], "false");
  } finally {
    await cancelled.app.close();
  }
});

test("refusals before a run exists are plain OpenAI errors, streamed or not", async () => {
  const { app, calls } = await buildApp();
  try {
    for (const stream of [false, true]) {
      const tools = await post(app, {
        stream,
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      });
      assert.equal(tools.statusCode, 400);
      assert.equal(tools.json().error.code, "unsupported_parameter");
      assert.equal(tools.json().error.param, "tools");

      const missing = await app.inject({
        method: "POST",
        url: "/v1/workflows/nope/chat/completions",
        payload: { messages: MESSAGES, stream },
      });
      assert.equal(missing.statusCode, 404);
      assert.equal(missing.json().error.code, "workflow_not_found");

      const invalid = await app.inject({ method: "POST", url: URL, payload: { stream } });
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.json().error.code, "validation_failed");
    }
    assert.deepEqual(calls, []);
  } finally {
    await app.close();
  }
});

test("stream: true delivers the same answer as chunks: role and run id first, content, a stop chunk, [DONE]", async () => {
  const long = "x".repeat(4_500);
  const { app } = await buildApp({ run: finishedRun({ context: { draft: { output: long } } }) });
  try {
    const res = await post(app, { stream: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "text/event-stream");
    assert.equal(res.headers["x-accel-buffering"], "no");
    assert.match(String(res.headers["x-request-id"]), /^req_/);

    const frames = events(res.body) as any[];
    assert.equal(frames.at(-1), "[DONE]");
    const chunks = frames.slice(0, -1);
    for (const chunk of chunks) {
      assert.equal(chunk.object, "chat.completion.chunk");
      assert.equal(chunk.model, "workflow/nightly-report");
      assert.equal(chunk.id, chunks[0].id);
    }
    // Sent as soon as the run is queued: the caller can look the run up.
    assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant", content: "" });
    assert.deepEqual(chunks[0].wheelsai.workflow, {
      slug: "nightly-report",
      executionId: RUN_ID,
      status: "running",
    });
    const content = chunks
      .slice(1)
      .map((c) => c.choices[0]?.delta?.content ?? "")
      .join("");
    assert.equal(content, long);
    assert.ok(chunks.filter((c) => c.choices[0]?.delta?.content).length >= 3, "split into several chunks");

    const last = chunks.at(-1);
    assert.equal(last.choices[0].finish_reason, "stop");
    assert.equal(last.wheelsai.workflow.status, "completed");
    // Usage only when asked for.
    assert.equal(chunks.some((c) => "usage" in c), false);
  } finally {
    await app.close();
  }
});

test("stream_options.include_usage adds one usage chunk with no choices, before [DONE]", async () => {
  const { app } = await buildApp();
  try {
    const res = await post(app, { stream: true, stream_options: { include_usage: true } });
    const frames = events(res.body) as any[];
    const usage = frames.at(-2);
    assert.deepEqual(usage.choices, []);
    assert.deepEqual(usage.usage, { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 });
    assert.equal(frames.at(-1), "[DONE]");
  } finally {
    await app.close();
  }
});

test("a run that fails after the stream opened ends with one error event and no [DONE]", async () => {
  const { app } = await buildApp({
    run: finishedRun({ status: "failed", error: "provider down", failedStepName: "draft", context: {} }),
  });
  try {
    const res = await post(app, { stream: true });
    assert.equal(res.statusCode, 200);
    const frames = events(res.body) as any[];
    assert.equal(frames.includes("[DONE]"), false);
    assert.equal(frames.length, 2);
    assert.equal(frames[1].error.code, "workflow_failed");
    assert.equal(frames[1].error.executionId, RUN_ID);
    assert.equal(frames[1].error.failedStep, "draft");
  } finally {
    await app.close();
  }
});

test("an unexpected failure while streaming is one scrubbed error event; the stream still ends", async () => {
  const { app } = await buildApp({
    deps: {
      loadRun: async () => {
        throw new Error("Invalid `prisma.orchestrationExecution.findFirst()` invocation in /home/app/x.ts");
      },
    },
  });
  try {
    const res = await post(app, { stream: true });
    const frames = events(res.body) as any[];
    assert.equal(frames.at(-1).error.code, "internal_error");
    assert.doesNotMatch(res.body, /prisma|\/home\//);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------

function open(app: FastifyInstance, body: Record<string, unknown>) {
  const { port } = app.server.address() as AddressInfo;
  const payload = JSON.stringify({ messages: MESSAGES, ...body });
  let received = "";
  const req = http.request({
    host: "127.0.0.1",
    port,
    path: URL,
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
  });
  const done = new Promise<{ status: number | undefined; body: string }>((resolve) => {
    req.on("response", (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => (received += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: received }));
      res.on("error", () => resolve({ status: res.statusCode, body: received }));
    });
    req.on("error", () => resolve({ status: undefined, body: received }));
  });
  req.end(payload);
  return { req, done, received: () => received };
}

const until = async (condition: () => boolean, label: string) => {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
};

test("a client that hangs up while the run works gets the run cancelled, streamed or not", async () => {
  for (const stream of [false, true]) {
    const { app, calls } = await buildApp({ hold: true });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const { req } = open(app, { stream });
      await until(() => calls.includes("start"), "the run to start");
      assert.equal(calls.includes("cancel"), false);
      req.destroy();
      await until(() => calls.includes("cancel"), `the cancel (stream=${stream})`);
      assert.deepEqual(calls, ["start", "cancel"]);
    } finally {
      await app.close();
    }
  }
});

test("a stream is open and kept alive while the run works, then delivers the answer", async () => {
  const { app, calls, release } = await buildApp({ hold: true, heartbeatMs: 10 });
  await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    const { done, received } = open(app, { stream: true });
    // Bytes arrive before the run has finished: the opening chunk, then
    // keep-alive comments.
    await until(() => received().includes('"status":"running"'), "the opening chunk");
    await until(() => received().includes(": keep-alive"), "a keep-alive comment");
    assert.equal(received().includes("[DONE]"), false);

    release();
    const { status, body } = await done;
    assert.equal(status, 200);
    const frames = events(body) as any[];
    assert.equal(frames.at(-1), "[DONE]");
    assert.equal(
      frames
        .slice(0, -1)
        .map((c) => c.choices[0]?.delta?.content ?? "")
        .join(""),
      "the report",
    );
    assert.deepEqual(calls, ["start"]);
  } finally {
    await app.close();
  }
});
