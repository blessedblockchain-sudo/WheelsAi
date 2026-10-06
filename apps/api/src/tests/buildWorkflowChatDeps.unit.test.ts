import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";

import { buildWorkflowChatDeps } from "../services/buildWorkflowChatDeps.js";
import { WorkflowError } from "../services/workflowErrors.js";

// The bindings behind workflows through /v1: every read goes through the
// caller's organization, the run is started as an API run through the one
// start entry point, and a cancel that finds the run finished is not an error.

function build(over: { execution?: unknown; cancel?: () => Promise<unknown> } = {}) {
  const queries: Array<{ model: string; args: any }> = [];
  const started: unknown[] = [];
  const cancelled: unknown[][] = [];
  const deps = buildWorkflowChatDeps({
    prisma: {
      orchestration: {
        findUnique: async (args) => {
          queries.push({ model: "orchestration", args });
          return { id: "wf-1", slug: "nightly", name: "Nightly", isEnabled: true, timeout: 1000, inputSchema: {}, createdAt: new Date(0) };
        },
      },
      orchestrationExecution: {
        findFirst: async (args) => {
          queries.push({ model: "execution", args });
          return over.execution ?? null;
        },
      },
    },
    service: {
      startOrchestrationRun: async (args) => {
        started.push(args);
        return { id: "run-1", status: "queued", triggeredBy: "api", triggeredById: null, createdAt: new Date(0) };
      },
      cancelExecution: (async (...args: unknown[]) => {
        cancelled.push(args);
        return over.cancel ? over.cancel() : { execution: {}, outcome: "cancel_requested" };
      }) as never,
    },
  });
  return { deps, queries, started, cancelled };
}

test("the workflow is found by (organization, slug)", async () => {
  const { deps, queries } = build();
  const workflow = await deps.findWorkflow("org-1", "nightly");
  assert.equal(workflow?.id, "wf-1");
  assert.deepEqual(queries[0]!.args.where, { orgId_slug: { orgId: "org-1", slug: "nightly" } });
});

test("the run is started through startOrchestrationRun as an API run", async () => {
  const { deps, started } = build();
  const run = await deps.startRun({
    orchestrationId: "wf-1",
    orgId: "org-1",
    prompt: "go",
    input: { messages: [] },
    triggeredById: "key-1",
  });
  assert.equal(run.id, "run-1");
  assert.deepEqual(started, [
    {
      orchestrationId: "wf-1",
      orgId: "org-1",
      prompt: "go",
      input: { messages: [] },
      triggeredBy: "api",
      triggeredById: "key-1",
    },
  ]);
});

test("status and run reads are scoped to the workflow AND the organization", async () => {
  const { deps, queries } = build();
  assert.equal(await deps.runStatus("run-1", "wf-1", "org-1"), null);
  assert.equal(await deps.loadRun("run-1", "wf-1", "org-1"), null);
  for (const query of queries) {
    assert.deepEqual(query.args.where, {
      id: "run-1",
      orchestrationId: "wf-1",
      orchestration: { orgId: "org-1" },
    });
  }
});

test("a loaded run carries plan order, the failed step's name and each step's stored usage", async () => {
  const { deps } = build({
    execution: {
      id: "run-1",
      status: "failed",
      output: {},
      context: { a: { output: "x" } },
      error: "boom",
      durationMs: 12,
      failedStepId: "step-b",
      orchestration: { steps: [{ id: "step-a", name: "a" }, { id: "step-b", name: "b" }] },
      stepResults: [
        { stepName: "a", stepType: "agent", status: "success", iteration: null, durationMs: 5, error: null, usage: { inputTokens: 1, outputTokens: 2 } },
        { stepName: "b", stepType: "model", status: "failed", iteration: null, durationMs: 7, error: "boom", usage: null },
      ],
    },
  });
  const run = await deps.loadRun("run-1", "wf-1", "org-1");
  assert.deepEqual(run?.stepOrder, ["a", "b"]);
  assert.equal(run?.failedStepName, "b");
  assert.deepEqual(run?.steps.map((s) => s.usage), [{ inputTokens: 1, outputTokens: 2 }, null]);
  assert.equal(await deps.runStatus("run-1", "wf-1", "org-1"), "failed");
});

test("cancel goes through the service's compare-and-set cancel; a finished or deleted run is not an error", async () => {
  const ok = build();
  await ok.deps.cancelRun("run-1", "wf-1", "org-1");
  assert.deepEqual(ok.cancelled, [["run-1", "wf-1", "org-1"]]);

  for (const code of ["execution_finished", "not_found"] as const) {
    const done = build({
      cancel: async () => {
        throw new WorkflowError(code, "nothing to cancel");
      },
    });
    await done.deps.cancelRun("run-1", "wf-1", "org-1");
  }

  const broken = build({
    cancel: async () => {
      throw new Error("database is gone");
    },
  });
  await assert.rejects(broken.deps.cancelRun("run-1", "wf-1", "org-1"), /database is gone/);
});

test("sleep resolves early when the client leaves", async () => {
  const { deps } = build();
  const client = new AbortController();
  const started = Date.now();
  const slept = deps.sleep(60_000, client.signal);
  client.abort();
  await slept;
  assert.ok(Date.now() - started < 1_000);
});
