import assert from "node:assert/strict";
import test from "node:test";

import { enqueueJobRun, JOB_RUNNER_JOB_NAME, jobRunEntryId } from "../queues/job-runner.queue.js";

// The producer half of queues/job-runner.queue.ts with an injected queue
// (no Redis).

function fakeQueue(existing?: { state: string }) {
  const added: Array<{ name: string; data: unknown; opts: Record<string, unknown> }> = [];
  const removed: string[] = [];
  const queue = {
    add: async (name: string, data: unknown, opts: Record<string, unknown>) => {
      added.push({ name, data, opts });
      return {} as never;
    },
    getJob: async (id: string) =>
      existing
        ? {
            getState: async () => existing.state,
            remove: async () => {
              removed.push(id);
            },
          }
        : null,
  };
  return { queue: queue as never, added, removed };
}

test("a job is enqueued once per job id, with a single attempt", async () => {
  const { queue, added } = fakeQueue();
  await enqueueJobRun("9f1c2b6e-0000-4000-8000-000000000001", { queue });

  assert.equal(added.length, 1);
  assert.equal(added[0]!.name, JOB_RUNNER_JOB_NAME);
  assert.deepEqual(added[0]!.data, { jobId: "9f1c2b6e-0000-4000-8000-000000000001" });
  // Dedup by job, and never re-run a product that may already have run.
  assert.equal(added[0]!.opts.jobId, "job-run-9f1c2b6e-0000-4000-8000-000000000001");
  assert.equal(added[0]!.opts.attempts, 1);
  assert.ok(added[0]!.opts.removeOnComplete);
  assert.ok(added[0]!.opts.removeOnFail);
});

test("the entry id has no colon, which BullMQ refuses in a custom id", () => {
  assert.ok(!jobRunEntryId("abc").includes(":"));
});

test("an empty job id is refused", async () => {
  await assert.rejects(enqueueJobRun("", { queue: fakeQueue().queue }), /jobId is required/);
});

test("a queue failure propagates, so the caller knows the job was not queued", async () => {
  const queue = {
    add: async () => {
      throw new Error("ECONNREFUSED");
    },
  } as never;
  await assert.rejects(enqueueJobRun("job-1", { queue }), /ECONNREFUSED/);
});

test("the sweeper's add replaces a finished entry, and leaves a waiting or active one alone", async () => {
  for (const state of ["completed", "failed"]) {
    const { queue, added, removed } = fakeQueue({ state });
    await enqueueJobRun("job-1", { queue, replaceFinished: true });
    assert.deepEqual(removed, ["job-run-job-1"], state);
    assert.equal(added.length, 1);
  }
  for (const state of ["waiting", "active", "delayed"]) {
    const { queue, added, removed } = fakeQueue({ state });
    await enqueueJobRun("job-1", { queue, replaceFinished: true });
    assert.deepEqual(removed, [], state);
    // Added again all the same: BullMQ ignores an add whose id is in use.
    assert.equal(added.length, 1);
  }
  // A plain add (the hire path) never removes anything.
  const { queue, removed } = fakeQueue({ state: "completed" });
  await enqueueJobRun("job-1", { queue });
  assert.deepEqual(removed, []);
});
