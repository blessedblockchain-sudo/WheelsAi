import assert from "node:assert/strict";
import test from "node:test";

import {
  runWorkflowReaperTick,
  type ReapCandidate,
  type WorkflowReaperTickDeps,
} from "../services/runWorkflowReaperTick.js";

// Drives services/runWorkflowReaperTick.ts. Nothing used to end a run
// whose job was lost or whose worker died: the row stayed 'running'
// forever. The reaper fails those, and only those.

const NOW = new Date("2026-10-07T12:00:00Z");
const GRACE = { queuedGraceMs: 120_000, runningGraceMs: 120_000 };

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function candidate(over: Partial<ReapCandidate>): ReapCandidate {
  return {
    id: "exec-1",
    status: "queued",
    orchestrationId: "orch-1",
    orgId: "org-1",
    workflowName: "Flow",
    timeout: 600_000,
    createdAt: ago(10 * 60_000),
    startedAt: null,
    taskExecutionId: null,
    ...over,
  };
}

interface World {
  /** Current status per run; failRun is a compare-and-set against it. */
  status: Record<string, string>;
  failed: Array<{ executionId: string; from: string; error: string; durationMs: number | null }>;
  stats: Array<{ orchestrationId: string; success: boolean }>;
  linked: Array<{ taskExecutionId: string; status: string; error?: string }>;
  events: Array<{ type: string; data: Record<string, unknown> }>;
}

function makeDeps(
  candidates: ReapCandidate[],
  over: Partial<WorkflowReaperTickDeps> = {},
): { deps: WorkflowReaperTickDeps; world: World } {
  const world: World = {
    status: Object.fromEntries(candidates.map((c) => [c.id, c.status])),
    failed: [],
    stats: [],
    linked: [],
    events: [],
  };
  const deps: WorkflowReaperTickDeps = {
    loadCandidates: async () => candidates,
    failRun: async ({ executionId, from, error, durationMs }) => {
      if (world.status[executionId] !== from) return false;
      world.status[executionId] = "failed";
      world.failed.push({ executionId, from, error, durationMs });
      return true;
    },
    recordRunStats: async (orchestrationId, stats) => {
      world.stats.push({ orchestrationId, success: stats.success });
    },
    finishLinkedTaskExecution: async (taskExecutionId, outcome) => {
      world.linked.push({ taskExecutionId, status: outcome.status, error: outcome.error });
    },
    emitEvent: async (_orgId, type, data) => {
      world.events.push({ type, data });
    },
    ...over,
  };
  return { deps, world };
}

test("the tick asks for rows older than each grace period", async () => {
  let asked: { queuedBefore: Date; runningStartedBefore: Date } | null = null;
  const { deps } = makeDeps([], {
    loadCandidates: async (args) => {
      asked = args;
      return [];
    },
  });
  await runWorkflowReaperTick({ now: NOW, queuedGraceMs: 120_000, runningGraceMs: 30_000 }, deps);
  assert.deepEqual(asked, { queuedBefore: ago(120_000), runningStartedBefore: ago(30_000) });
});

test("a queued run past grace with no job behind it is failed: never started", async () => {
  const { deps, world } = makeDeps([candidate({ id: "lost" })], {
    isJobPending: async () => false,
  });
  const result = await runWorkflowReaperTick({ now: NOW, ...GRACE }, deps);

  assert.deepEqual(result, { examined: 1, reaped: 1, lostRace: 0, errors: 0 });
  assert.equal(world.failed[0]!.from, "queued");
  assert.match(world.failed[0]!.error, /^never started/);
  assert.deepEqual(world.stats, [{ orchestrationId: "orch-1", success: false }]);
  assert.equal(world.events[0]!.type, "workflow.failed");
  assert.equal(world.events[0]!.data.executionId, "lost");
});

test("a queued run whose job is still waiting is left alone, however long the queue", async () => {
  const { deps, world } = makeDeps([candidate({ createdAt: ago(60 * 60_000) })], {
    isJobPending: async () => true,
  });
  const result = await runWorkflowReaperTick({ now: NOW, ...GRACE }, deps);
  assert.equal(result.reaped, 0);
  assert.equal(world.failed.length, 0);
});

test("when the queue cannot be asked, the run is left alone", async () => {
  const { deps, world } = makeDeps([candidate({})], {
    isJobPending: async () => {
      throw new Error("redis down");
    },
  });
  const result = await runWorkflowReaperTick({ now: NOW, ...GRACE }, deps);
  assert.deepEqual(result, { examined: 1, reaped: 0, lostRace: 0, errors: 1 });
  assert.equal(world.failed.length, 0);
});

test("a running run past its timeout plus grace is failed: run lost", async () => {
  const { deps, world } = makeDeps([
    candidate({
      id: "dead",
      status: "running",
      timeout: 600_000,
      startedAt: ago(600_000 + 120_000 + 1_000),
    }),
  ]);
  const result = await runWorkflowReaperTick({ now: NOW, ...GRACE }, deps);
  assert.equal(result.reaped, 1);
  assert.equal(world.failed[0]!.from, "running");
  assert.match(world.failed[0]!.error, /^run lost/);
  assert.equal(world.failed[0]!.durationMs, 721_000);
});

test("fresh rows are untouched", async () => {
  const { deps, world } = makeDeps(
    [
      // Queued a moment ago.
      candidate({ id: "new", createdAt: ago(5_000) }),
      // Running, slow, but inside timeout + grace: the worker's own
      // timeout will end it first.
      candidate({ id: "slow", status: "running", timeout: 600_000, startedAt: ago(700_000) }),
      // Running with no start time recorded: nothing to measure.
      candidate({ id: "odd", status: "running", startedAt: null }),
    ],
    { isJobPending: async () => false },
  );
  const result = await runWorkflowReaperTick({ now: NOW, ...GRACE }, deps);
  assert.deepEqual(result, { examined: 3, reaped: 0, lostRace: 0, errors: 0 });
  assert.equal(world.failed.length, 0);
  assert.equal(world.events.length, 0);
});

test("the reaper loses cleanly to a worker that finished first", async () => {
  const run = candidate({
    id: "raced",
    status: "running",
    timeout: 10_000,
    startedAt: ago(10 * 60_000),
    taskExecutionId: "texec-1",
  });
  const { deps, world } = makeDeps([run]);
  // The worker's finish landed between the reaper's read and its write.
  world.status.raced = "completed";

  const result = await runWorkflowReaperTick({ now: NOW, ...GRACE }, deps);
  assert.deepEqual(result, { examined: 1, reaped: 0, lostRace: 1, errors: 0 });
  assert.equal(world.status.raced, "completed", "the worker's ending stands");
  // The loser writes nothing more: no stats, no linked finish, no event.
  assert.equal(world.stats.length, 0);
  assert.equal(world.linked.length, 0);
  assert.equal(world.events.length, 0);
});

test("a reaped run's linked scheduled-task execution is finished as failed", async () => {
  const { deps, world } = makeDeps(
    [candidate({ id: "lost", taskExecutionId: "texec-7" })],
    { isJobPending: async () => false },
  );
  await runWorkflowReaperTick({ now: NOW, ...GRACE }, deps);
  assert.equal(world.linked.length, 1);
  assert.equal(world.linked[0]!.taskExecutionId, "texec-7");
  assert.equal(world.linked[0]!.status, "failed");
  assert.match(world.linked[0]!.error!, /never started/);
});

test("one run's error does not stop the others being reaped", async () => {
  const { deps, world } = makeDeps(
    [candidate({ id: "boom" }), candidate({ id: "fine" })],
    {
      isJobPending: async () => false,
      failRun: async ({ executionId }) => {
        if (executionId === "boom") throw new Error("db blip");
        world.failed.push({ executionId, from: "queued", error: "x", durationMs: null });
        return true;
      },
    },
  );
  const result = await runWorkflowReaperTick({ now: NOW, ...GRACE }, deps);
  assert.deepEqual(result, { examined: 2, reaped: 1, lostRace: 0, errors: 1 });
  assert.deepEqual(world.failed.map((f) => f.executionId), ["fine"]);
});
