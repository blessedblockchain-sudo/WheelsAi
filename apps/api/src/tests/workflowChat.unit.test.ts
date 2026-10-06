import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedMessage } from "../services/openaiCompat.js";
import {
  MAX_WORKFLOW_INPUT_BYTES,
  MAX_WORKFLOW_PROMPT_CHARS,
  startWorkflowChat,
  workflowAnswerText,
  workflowOutcome,
  workflowRunInput,
  workflowUsage,
  type WorkflowChatDeps,
  type WorkflowChatInput,
  type WorkflowForChat,
  type WorkflowRunSnapshot,
} from "../services/workflowChat.js";
import { WorkflowError } from "../services/workflowErrors.js";

// A workflow answered as a chat completion: what the request means to the
// run, what the finished run means to the answer, and - the part with money
// in it - that a run is never left going once nobody is waiting for it.

const ORG = "org-1";
const WORKFLOW: WorkflowForChat = {
  id: "wf-1",
  slug: "nightly-report",
  name: "Nightly report",
  isEnabled: true,
  timeout: 60_000,
  inputSchema: {},
  createdAt: new Date("2026-10-03T00:00:00Z"),
};
const user = (content: string): NormalizedMessage => ({ role: "user", content });

function run(over: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    id: "run-1",
    status: "completed",
    output: {},
    context: { draft: { output: "a draft" }, polish: { output: "the polished answer" } },
    error: null,
    durationMs: 900,
    stepOrder: ["draft", "polish"],
    failedStepName: null,
    steps: [
      { stepName: "draft", stepType: "agent", status: "success", iteration: null, durationMs: 400, error: null, usage: { inputTokens: 10, outputTokens: 20 } },
      { stepName: "polish", stepType: "agent", status: "success", iteration: null, durationMs: 500, error: null, usage: { inputTokens: 25, outputTokens: 5 } },
    ],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Request → run input
// ---------------------------------------------------------------------------

test("the last user message becomes the run prompt and the conversation becomes input.messages", () => {
  const messages: NormalizedMessage[] = [
    { role: "system", content: "be brief" },
    user("first question"),
    { role: "assistant", content: "first answer" },
    user("second question"),
  ];
  const input = workflowRunInput(messages, {});
  assert.ok(input.ok);
  assert.equal(input.prompt, "second question");
  assert.deepEqual(input.input, {
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ],
  });
});

test("a JSON-object message is the run input when the workflow declares an input schema", () => {
  const schema = { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] };
  const structured = workflowRunInput([user('  {"topic": "pricing", "depth": 2} ')], schema);
  assert.ok(structured.ok);
  assert.equal(structured.prompt, undefined);
  assert.deepEqual(structured.input, { topic: "pricing", depth: 2 });

  // Without a schema the same text is just a prompt.
  const plain = workflowRunInput([user('{"topic": "pricing"}')], {});
  assert.ok(plain.ok);
  assert.equal(plain.prompt, '{"topic": "pricing"}');

  // With a schema, text that is not a JSON object is still a prompt (the
  // schema check at start then says what is missing).
  for (const text of ["tell me about pricing", "[1,2]", '{"broken": ']) {
    const fallback = workflowRunInput([user(text)], schema);
    assert.ok(fallback.ok);
    assert.equal(fallback.prompt, text);
  }
});

test("a request with no user text is refused, naming messages", () => {
  const cases: NormalizedMessage[][] = [
    [{ role: "system", content: "x" }],
    [user("   ")],
    [user("hi"), { role: "assistant", content: "yo" }, user("")],
  ];
  for (const messages of cases) {
    const refused = workflowRunInput(messages, {});
    assert.ok(!refused.ok);
    assert.equal(refused.code, "validation_failed");
    assert.equal(refused.detail.param, "messages");
  }
});

test("the run-input limits of the execute route apply: prompt length and total bytes", () => {
  const longPrompt = workflowRunInput([user("x".repeat(MAX_WORKFLOW_PROMPT_CHARS + 1))], {});
  assert.ok(!longPrompt.ok);
  assert.equal(longPrompt.code, "messages_too_large");

  const atLimit = workflowRunInput([user("x".repeat(MAX_WORKFLOW_PROMPT_CHARS))], {});
  assert.ok(atLimit.ok);

  const history = Array.from({ length: 8 }, () => user("y".repeat(10_000)));
  const tooBig = workflowRunInput(history, {});
  assert.ok(!tooBig.ok);
  assert.equal(tooBig.code, "messages_too_large");
  assert.match(tooBig.detail.message ?? "", new RegExp(String(MAX_WORKFLOW_INPUT_BYTES)));
});

// ---------------------------------------------------------------------------
// Finished run → answer
// ---------------------------------------------------------------------------

test("answer text: a single mapped string, else the mapped output as JSON, else the last successful step in plan order", () => {
  assert.equal(workflowAnswerText(run({ output: { answer: "mapped" } })), "mapped");
  assert.equal(
    workflowAnswerText(run({ output: { summary: "s", score: 4 } })),
    '{"summary":"s","score":4}',
  );
  assert.equal(workflowAnswerText(run({ output: { score: 4 } })), '{"score":4}');
  assert.equal(workflowAnswerText(run()), "the polished answer");

  // Plan order, not the order steps happened to finish or be stored in.
  assert.equal(
    workflowAnswerText(run({ context: { polish: { output: "last in plan" }, draft: { output: "first in plan" } } })),
    "last in plan",
  );
  // The last step was skipped or failed: the last one that DID succeed.
  assert.equal(workflowAnswerText(run({ context: { draft: { output: "a draft" } } })), "a draft");
  // A structured step output is given as JSON.
  assert.equal(
    workflowAnswerText(run({ context: { polish: { output: { verdict: "ok" } } } })),
    '{"verdict":"ok"}',
  );
  assert.equal(workflowAnswerText(run({ context: {} })), null);
  assert.equal(workflowAnswerText(run({ context: { polish: { output: "" } } })), null);
});

test("usage sums the steps and is omitted when any model call was unreported or nothing was reported", () => {
  assert.deepEqual(workflowUsage(run().steps), { inputTokens: 35, outputTokens: 25 });
  // A retrieval, skipped or failed row stores no usage and changes nothing.
  assert.deepEqual(
    workflowUsage([...run().steps, { usage: null }, { usage: undefined }]),
    { inputTokens: 35, outputTokens: 25 },
  );
  assert.equal(workflowUsage([...run().steps, { usage: { unreported: true } }]), null);
  assert.equal(workflowUsage([{ usage: { inputTokens: "3", outputTokens: 1 } }]), null);
  assert.equal(workflowUsage([{ usage: null }]), null);
  assert.equal(workflowUsage([]), null);
});

test("a completed run is an answer with usage and the run in wheelsai.workflow", () => {
  const outcome = workflowOutcome(WORKFLOW, run());
  assert.ok(outcome.ok);
  assert.equal(outcome.content, "the polished answer");
  assert.deepEqual(outcome.usage, { inputTokens: 35, outputTokens: 25 });
  assert.deepEqual(outcome.extension, {
    workflow: {
      slug: "nightly-report",
      executionId: "run-1",
      status: "completed",
      durationMs: 900,
      steps: [
        { name: "draft", type: "agent", status: "success", durationMs: 400, error: null },
        { name: "polish", type: "agent", status: "success", durationMs: 500, error: null },
      ],
    },
  });
});

test("a failed run is workflow_failed with the execution id and the failed step", () => {
  const outcome = workflowOutcome(
    WORKFLOW,
    run({ status: "failed", error: "provider down", failedStepName: "polish" }),
  );
  assert.ok(!outcome.ok);
  assert.equal(outcome.code, "workflow_failed");
  assert.equal(outcome.detail.message, 'Workflow step "polish" failed: provider down');
  assert.equal(outcome.detail.extra?.executionId, "run-1");
  assert.equal(outcome.detail.extra?.failedStep, "polish");

  const long = workflowOutcome(WORKFLOW, run({ status: "failed", error: "e".repeat(5_000) }));
  assert.ok(!long.ok);
  assert.ok((long.detail.message ?? "").length < 600);
});

test("a run stopped by its time limit is workflow_timeout; a cancelled one is workflow_cancelled", () => {
  const timedOut = workflowOutcome(WORKFLOW, run({ status: "failed", error: "workflow timed out after 60000ms" }));
  assert.ok(!timedOut.ok);
  assert.equal(timedOut.code, "workflow_timeout");
  assert.equal(timedOut.detail.extra?.executionId, "run-1");

  const cancelled = workflowOutcome(WORKFLOW, run({ status: "cancelled", error: "cancelled" }));
  assert.ok(!cancelled.ok);
  assert.equal(cancelled.code, "workflow_cancelled");
});

test("a run that completed with nothing to say is a failure, not an empty answer", () => {
  const outcome = workflowOutcome(WORKFLOW, run({ context: {}, steps: [] }));
  assert.ok(!outcome.ok);
  assert.equal(outcome.code, "workflow_failed");
  assert.match(outcome.detail.message ?? "", /without producing an output/);
});

// ---------------------------------------------------------------------------
// The request: start, wait, cancel
// ---------------------------------------------------------------------------

interface World {
  deps: WorkflowChatDeps;
  calls: string[];
  started: Array<Record<string, unknown>>;
  /** Statuses returned by successive runStatus reads; the last repeats. */
  statuses: Array<string | null | Error>;
  clock: { now: number };
  finished: WorkflowRunSnapshot | null;
}

function world(over: Partial<WorkflowChatDeps> = {}, workflow: WorkflowForChat | null = WORKFLOW): World {
  const w: World = {
    calls: [],
    started: [],
    statuses: ["completed"],
    clock: { now: 1_000_000 },
    finished: run(),
    deps: null as never,
  };
  w.deps = {
    findWorkflow: async (orgId, slug) => {
      w.calls.push(`find:${orgId}:${slug}`);
      return workflow && orgId === ORG && slug === workflow.slug ? workflow : null;
    },
    startRun: async (args) => {
      w.calls.push("start");
      w.started.push(args);
      return { id: "run-1" };
    },
    runStatus: async (executionId, orchestrationId, orgId) => {
      assert.deepEqual([executionId, orchestrationId, orgId], ["run-1", "wf-1", ORG]);
      w.calls.push("status");
      const next = w.statuses.length > 1 ? w.statuses.shift()! : w.statuses[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
    loadRun: async (executionId, orchestrationId, orgId) => {
      assert.deepEqual([executionId, orchestrationId, orgId], ["run-1", "wf-1", ORG]);
      w.calls.push("load");
      return w.finished;
    },
    cancelRun: async (executionId, orchestrationId, orgId) => {
      assert.deepEqual([executionId, orchestrationId, orgId], ["run-1", "wf-1", ORG]);
      w.calls.push("cancel");
    },
    sleep: async (ms) => {
      w.calls.push("sleep");
      w.clock.now += ms;
    },
    now: () => w.clock.now,
    pollMs: 500,
    graceMs: 30_000,
    ...over,
  };
  return w;
}

function request(over: Partial<WorkflowChatInput> = {}): WorkflowChatInput {
  return {
    orgId: ORG,
    slug: "nightly-report",
    messages: [user("write the report")],
    hasTools: false,
    triggeredById: "key-1",
    signal: new AbortController().signal,
    ...over,
  };
}

test("a request starts one run for the caller's organization and answers when it completes", async () => {
  const w = world();
  w.statuses = ["queued", "running", "running", "completed"];
  const session = await startWorkflowChat(request(), w.deps);
  assert.ok(session.ok);
  assert.equal(session.executionId, "run-1");
  assert.deepEqual(w.started, [
    {
      orchestrationId: "wf-1",
      orgId: ORG,
      prompt: "write the report",
      input: { messages: [{ role: "user", content: "write the report" }] },
      triggeredById: "key-1",
    },
  ]);

  const outcome = await session.finish();
  assert.ok(outcome.ok);
  assert.equal(outcome.content, "the polished answer");
  assert.deepEqual(w.calls, [
    "find:org-1:nightly-report",
    "start",
    "status", "sleep", "status", "sleep", "status", "sleep", "status",
    "load",
  ]);
  assert.equal(w.calls.includes("cancel"), false);
});

test("a workflow that does not exist, or belongs to another organization, is workflow_not_found and starts nothing", async () => {
  const w = world();
  for (const over of [{ slug: "missing" }, { orgId: "org-other" }]) {
    const refused = await startWorkflowChat(request(over), w.deps);
    assert.ok(!refused.ok);
    assert.equal(refused.code, "workflow_not_found");
  }
  assert.equal(w.calls.includes("start"), false);
});

test("tools are refused with param tools, and a disabled workflow is workflow_disabled; neither starts a run", async () => {
  const withTools = world();
  const tools = await startWorkflowChat(request({ hasTools: true }), withTools.deps);
  assert.ok(!tools.ok);
  assert.equal(tools.code, "unsupported_parameter");
  assert.equal(tools.detail.param, "tools");
  assert.equal(withTools.calls.includes("start"), false);

  const disabled = world({}, { ...WORKFLOW, isEnabled: false });
  const refused = await startWorkflowChat(request(), disabled.deps);
  assert.ok(!refused.ok);
  assert.equal(refused.code, "workflow_disabled");
  assert.equal(disabled.calls.includes("start"), false);
});

test("a caller that already left starts no run", async () => {
  const w = world();
  const gone = new AbortController();
  gone.abort();
  const refused = await startWorkflowChat(request({ signal: gone.signal }), w.deps);
  assert.ok(!refused.ok);
  assert.equal(refused.code, "client_closed_request");
  assert.equal(w.calls.includes("start"), false);
});

test("each refusal of the start is named: schema, run cap, runner off, queue down", async () => {
  const cases: Array<[WorkflowError, string, number | undefined]> = [
    [new WorkflowError("input_schema_mismatch", "The input does not match this workflow's input schema", { details: ["topic is required"] }), "validation_failed", undefined],
    [new WorkflowError("workflow_run_limit", "5 runs already", { limit: 5 }), "workflow_run_limit", 10],
    [new WorkflowError("workflow_runner_disabled", "switched off"), "workflow_runner_disabled", undefined],
    [new WorkflowError("workflow_queue_unavailable", "queue down"), "service_unavailable", 5],
    [new WorkflowError("workflow_disabled", "disabled meanwhile"), "workflow_disabled", undefined],
    [new WorkflowError("not_found", "deleted meanwhile"), "workflow_not_found", undefined],
  ];
  for (const [error, code, retryAfter] of cases) {
    const w = world({
      startRun: async () => {
        throw error;
      },
    });
    const refused = await startWorkflowChat(request(), w.deps);
    assert.ok(!refused.ok, code);
    assert.equal(refused.code, code);
    assert.equal(refused.detail.retryAfterSeconds, retryAfter, code);
  }

  const schema = world({
    startRun: async () => {
      throw new WorkflowError("input_schema_mismatch", "The input does not match", { details: ["topic is required"] });
    },
  });
  const refused = await startWorkflowChat(request(), schema.deps);
  assert.ok(!refused.ok);
  assert.equal(refused.detail.param, "messages");
  assert.match(refused.detail.message ?? "", /topic is required/);
});

test("an unexpected start error is not dressed up as a refusal", async () => {
  const w = world({
    startRun: async () => {
      throw new Error("database is gone");
    },
  });
  await assert.rejects(startWorkflowChat(request(), w.deps), /database is gone/);
});

test("a client that disconnects while the run works gets the run cancelled", async () => {
  const w = world();
  const client = new AbortController();
  w.statuses = ["running"];
  w.deps.sleep = async (ms) => {
    w.calls.push("sleep");
    w.clock.now += ms;
    if (w.calls.filter((c) => c === "sleep").length === 2) client.abort();
  };
  const session = await startWorkflowChat(request({ signal: client.signal }), w.deps);
  assert.ok(session.ok);
  const outcome = await session.finish();
  assert.ok(!outcome.ok);
  assert.equal(outcome.code, "client_closed_request");
  assert.equal(outcome.detail.extra?.executionId, "run-1");
  // Cancelled exactly once, and nothing read or written after it.
  assert.deepEqual(w.calls.slice(2), ["status", "sleep", "status", "sleep", "cancel"]);
});

test("a run that outlives the workflow's time limit plus the grace is cancelled and answered 504", async () => {
  const w = world();
  w.statuses = ["queued"];
  w.finished = run({ status: "cancelled", error: "cancelled before it started" });
  const session = await startWorkflowChat(request(), w.deps);
  assert.ok(session.ok);
  const outcome = await session.finish();
  assert.ok(!outcome.ok);
  assert.equal(outcome.code, "workflow_timeout");
  assert.equal(outcome.detail.extra?.executionId, "run-1");
  assert.match(outcome.detail.message ?? "", /did not finish within 90 s .* was cancelled/);

  assert.equal(w.calls.filter((c) => c === "cancel").length, 1);
  // It waited the full limit: timeout 60 s + grace 30 s at 500 ms a poll.
  assert.equal(w.calls.filter((c) => c === "sleep").length, 180);
  assert.equal(w.calls.at(-2), "cancel");
});

test("a run that finished between the last read and the cancel is delivered, not dropped", async () => {
  const w = world();
  w.statuses = ["running"];
  // The cancel found it finished; the run it billed for has an answer.
  w.finished = run({ status: "completed" });
  const session = await startWorkflowChat(request(), w.deps);
  assert.ok(session.ok);
  const outcome = await session.finish();
  assert.ok(outcome.ok);
  assert.equal(outcome.content, "the polished answer");
  assert.equal(w.calls.filter((c) => c === "cancel").length, 1);
});

test("a failed status read is retried on the next poll rather than ending the request", async () => {
  const w = world();
  w.statuses = [new Error("connection reset"), "running", "completed"];
  const session = await startWorkflowChat(request(), w.deps);
  assert.ok(session.ok);
  const outcome = await session.finish();
  assert.ok(outcome.ok);
  assert.equal(w.calls.includes("cancel"), false);
});

test("a run deleted with its workflow while the request waited is workflow_not_found", async () => {
  const w = world();
  w.statuses = ["running", null];
  const session = await startWorkflowChat(request(), w.deps);
  assert.ok(session.ok);
  const outcome = await session.finish();
  assert.ok(!outcome.ok);
  assert.equal(outcome.code, "workflow_not_found");
});

test("the wait is bounded by the workflow's own time limit, not a fixed number", async () => {
  const quick = world({}, { ...WORKFLOW, timeout: 5_000 });
  quick.statuses = ["running"];
  quick.finished = run({ status: "cancelled" });
  const session = await startWorkflowChat(request(), quick.deps);
  assert.ok(session.ok);
  await session.finish();
  // 5 s + 30 s grace at 500 ms a poll.
  assert.equal(quick.calls.filter((c) => c === "sleep").length, 70);
});
