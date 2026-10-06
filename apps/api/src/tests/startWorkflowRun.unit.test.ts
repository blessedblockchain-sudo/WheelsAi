import assert from "node:assert/strict";
import test from "node:test";

import {
  startWorkflowRun,
  type NewRunRow,
  type StartWorkflowRunArgs,
  type StartWorkflowRunDeps,
} from "../services/startWorkflowRun.js";
import { WorkflowError } from "../services/workflowErrors.js";

// Drives services/startWorkflowRun.ts. Starting a run used to execute the
// whole workflow inside the HTTP request. Now it records a 'queued' row
// and enqueues one job; these tests pin the order and the refusals.

interface World {
  events: string[];
  rows: Array<NewRunRow & { id: string; status: string; error?: string }>;
  enqueued: string[];
}

function makeDeps(
  over: Partial<StartWorkflowRunDeps> & {
    workflow?: { id: string; isEnabled: boolean; inputSchema: unknown } | null;
    activeRuns?: number;
  } = {},
): { deps: StartWorkflowRunDeps; world: World } {
  const world: World = { events: [], rows: [], enqueued: [] };
  const { workflow, activeRuns, ...depOverrides } = over;
  const deps: StartWorkflowRunDeps = {
    runnerEnabled: true,
    maxActiveRunsPerOrg: 5,
    loadWorkflow: async (id, orgId) => {
      world.events.push(`load:${id}:${orgId}`);
      return workflow === undefined ? { id, isEnabled: true, inputSchema: {} } : workflow;
    },
    createQueuedRun: async (row, maxActive) => {
      if ((activeRuns ?? 0) >= maxActive) return null;
      const created = { ...row, id: `exec-${world.rows.length + 1}`, status: "queued" };
      world.rows.push(created);
      world.events.push(`create:${created.id}`);
      return {
        id: created.id,
        status: "queued",
        triggeredBy: row.triggeredBy,
        triggeredById: row.triggeredById,
        createdAt: new Date(0),
      };
    },
    enqueue: async (executionId) => {
      world.enqueued.push(executionId);
      world.events.push(`enqueue:${executionId}`);
    },
    failQueuedRun: async (executionId, error) => {
      const row = world.rows.find((r) => r.id === executionId && r.status === "queued");
      if (row) Object.assign(row, { status: "failed", error });
      world.events.push(`fail:${executionId}`);
    },
    ...depOverrides,
  };
  return { deps, world };
}

const args: StartWorkflowRunArgs = {
  orchestrationId: "orch-1",
  orgId: "org-1",
  triggeredBy: "manual",
  triggeredById: "user-1",
};

async function codeOf(promise: Promise<unknown>): Promise<WorkflowError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof WorkflowError, `expected a WorkflowError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected the start to be refused");
}

test("creates a queued run, then enqueues a job for exactly that run", async () => {
  const { deps, world } = makeDeps();
  const run = await startWorkflowRun({ ...args, prompt: "go", input: { topic: "tides" } }, deps);

  assert.equal(run.status, "queued");
  assert.deepEqual(world.events, ["load:orch-1:org-1", "create:exec-1", "enqueue:exec-1"]);
  // The job id is the execution id: one run, one job.
  assert.deepEqual(world.enqueued, [run.id]);
  assert.deepEqual(world.rows[0]!.input, { topic: "tides", prompt: "go" });
});

test("the trigger and its ids come from the caller's arguments and are stored as given", async () => {
  const { deps, world } = makeDeps();
  await startWorkflowRun(
    {
      ...args,
      // A client-supplied `triggeredBy` inside the INPUT is just data.
      input: { triggeredBy: "schedule", triggeredById: "someone-else" },
      triggeredBy: "api",
      triggeredById: "key-9",
      scheduledTaskId: "task-1",
      taskExecutionId: "texec-1",
      jobId: "job-1",
    },
    deps,
  );
  const row = world.rows[0]!;
  assert.equal(row.triggeredBy, "api");
  assert.equal(row.triggeredById, "key-9");
  assert.equal(row.scheduledTaskId, "task-1");
  assert.equal(row.taskExecutionId, "texec-1");
  assert.equal(row.jobId, "job-1");
  assert.equal(row.orgId, "org-1");
});

test("a workflow in another organization is not found", async () => {
  const { deps, world } = makeDeps({ workflow: null });
  const err = await codeOf(startWorkflowRun(args, deps));
  assert.equal(err.code, "not_found");
  assert.equal(err.status, 404);
  assert.equal(world.rows.length, 0);
});

test("a disabled workflow is refused with workflow_disabled", async () => {
  const { deps, world } = makeDeps({
    workflow: { id: "orch-1", isEnabled: false, inputSchema: {} },
  });
  const err = await codeOf(startWorkflowRun(args, deps));
  assert.equal(err.code, "workflow_disabled");
  assert.equal(err.status, 409);
  assert.equal(world.rows.length, 0);
  assert.equal(world.enqueued.length, 0);
});

test("with the runner switched off, nothing is queued and the answer is 501", async () => {
  const { deps, world } = makeDeps({ runnerEnabled: false });
  const err = await codeOf(startWorkflowRun(args, deps));
  assert.equal(err.code, "workflow_runner_disabled");
  assert.equal(err.status, 501);
  assert.match(err.message, /WORKFLOW_RUN_CONCURRENCY/);
  assert.equal(world.rows.length, 0);
});

test("the per-organization cap refuses the next run with workflow_run_limit", async () => {
  const { deps, world } = makeDeps({ activeRuns: 5, maxActiveRunsPerOrg: 5 });
  const err = await codeOf(startWorkflowRun(args, deps));
  assert.equal(err.code, "workflow_run_limit");
  assert.equal(err.status, 429);
  assert.deepEqual(err.extra, { limit: 5 });
  assert.equal(world.enqueued.length, 0);

  const under = makeDeps({ activeRuns: 4, maxActiveRunsPerOrg: 5 });
  await startWorkflowRun(args, under.deps);
  assert.equal(under.world.rows.length, 1);
});

test("an input that does not match the inputSchema creates no row", async () => {
  const { deps, world } = makeDeps({
    workflow: {
      id: "orch-1",
      isEnabled: true,
      inputSchema: {
        type: "object",
        required: ["topic"],
        properties: { topic: { type: "string" } },
      },
    },
  });
  const err = await codeOf(startWorkflowRun({ ...args, input: { topic: 7 } }, deps));
  assert.equal(err.code, "input_schema_mismatch");
  assert.equal(err.status, 400);
  assert.deepEqual(err.extra, { details: ["topic must be string, got integer"] });
  assert.equal(world.rows.length, 0);
  assert.equal(world.enqueued.length, 0);

  await startWorkflowRun({ ...args, input: { topic: "tides" } }, deps);
  assert.equal(world.rows.length, 1);
});

test("an enqueue failure marks the row failed and reports the queue as unavailable", async () => {
  const { deps, world } = makeDeps({
    enqueue: async () => {
      throw new Error("ECONNREFUSED redis");
    },
  });
  const err = await codeOf(startWorkflowRun(args, deps));
  assert.equal(err.code, "workflow_queue_unavailable");
  assert.equal(err.status, 503);
  // Never left 'queued' with no job behind it.
  assert.equal(world.rows[0]!.status, "failed");
  assert.match(world.rows[0]!.error!, /could not be queued: ECONNREFUSED redis/);
  // The client is not shown the Redis error.
  assert.doesNotMatch(err.message, /ECONNREFUSED/);
});

test("the queue being down is still reported when the row cannot be failed either", async () => {
  const { deps } = makeDeps({
    enqueue: async () => {
      throw new Error("redis down");
    },
    failQueuedRun: async () => {
      throw new Error("db down");
    },
  });
  const err = await codeOf(startWorkflowRun(args, deps));
  assert.equal(err.code, "workflow_queue_unavailable");
});
