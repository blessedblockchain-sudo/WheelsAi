import assert from "node:assert/strict";
import test from "node:test";

import {
  enqueueWorkflowRun,
  WORKFLOW_RUN_JOB_NAME,
} from "../queues/workflow-run.queue.js";

// Drives the producer half of queues/workflow-run.queue.ts with an
// injected queue (no Redis).

test("a run is enqueued with its execution id as the job id and a single attempt", async () => {
  const added: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];
  await enqueueWorkflowRun("exec-1", {
    queue: {
      add: async (name: string, data: unknown, opts: Record<string, unknown>) => {
        added.push({ name, data, opts });
        return {} as never;
      },
    } as never,
  });

  assert.equal(added.length, 1);
  assert.equal(added[0]!.name, WORKFLOW_RUN_JOB_NAME);
  assert.deepEqual(added[0]!.data, { executionId: "exec-1" });
  // Dedup by run, and never retry work that may already have been billed.
  assert.equal(added[0]!.opts.jobId, "exec-1");
  assert.equal(added[0]!.opts.attempts, 1);
});

test("an empty execution id is refused", async () => {
  await assert.rejects(enqueueWorkflowRun("", { queue: { add: async () => ({}) } as never }), /executionId is required/);
});

test("a queue failure propagates so the caller can fail the run", async () => {
  await assert.rejects(
    enqueueWorkflowRun("exec-1", {
      queue: {
        add: async () => {
          throw new Error("ECONNREFUSED");
        },
      } as never,
    }),
    /ECONNREFUSED/,
  );
});
