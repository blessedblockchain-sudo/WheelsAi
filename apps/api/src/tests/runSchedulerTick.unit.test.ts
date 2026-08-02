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

// Drives apps/api/src/services/runSchedulerTick.ts — the engine behind
// the scheduler worker (Wave 1). Before it, nothing consumed nextRunAt;
// schedules were definitions that never fired. Claim-BEFORE-execute:
// a crash mid-run loses at most one firing, never double-fires.

import type {
  DueTaskRow,
  ExecutionOutcome,
} from "../services/runSchedulerTick.js";

const NOW = new Date("2026-08-02T12:00:00Z");

function task(overrides: Partial<DueTaskRow> = {}): DueTaskRow {
  return {
    id: "task_1",
    orgId: "org_1",
    agentId: "agent_1",
    name: "daily digest",
    taskType: "agent_run",
    payload: { prompt: "summarize" },
    timeout: 5_000,
    scheduleType: "interval",
    cronExpression: null,
    intervalSeconds: 3600,
    scheduledAt: null,
    timezone: "UTC",
    nextRunAt: new Date("2026-08-02T11:59:00Z"),
    ...overrides,
  };
}

function makeDeps(opts: {
  due: DueTaskRow[];
  claimResults?: Record<string, boolean>;
  executeResults?: Record<string, { output: unknown } | Error>;
  executeDelayMs?: number;
}) {
  const finishes: Array<{ executionId: string; taskId: string; outcome: ExecutionOutcome }> = [];
  let executionSeq = 0;
  return {
    finishes,
    deps: {
      loadDueTasks: async () => opts.due,
      claimTask: async (t: DueTaskRow) => opts.claimResults?.[t.id] ?? true,
      createExecution: async () => ({ id: `exec_${++executionSeq}` }),
      executeTask: async (t: DueTaskRow) => {
        if (opts.executeDelayMs) {
          await new Promise((r) => setTimeout(r, opts.executeDelayMs));
        }
        const result = opts.executeResults?.[t.id];
        if (result instanceof Error) throw result;
        return result ?? { output: { ok: true } };
      },
      finishExecution: async (
        executionId: string,
        t: DueTaskRow,
        outcome: ExecutionOutcome,
      ) => {
        finishes.push({ executionId, taskId: t.id, outcome });
      },
    },
  };
}

test("a due task is claimed, executed, and finished as success", async () => {
  setupEnv();
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { deps, finishes } = makeDeps({ due: [task()] });
  const result = await runSchedulerTick({ now: NOW }, deps);

  assert.deepEqual(result, { due: 1, executed: 1, failed: 0, skipped: 0 });
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0]!.outcome.status, "success");
  assert.deepEqual(finishes[0]!.outcome.output, { ok: true });
});

test("a claim miss (another replica won) skips without executing", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { deps, finishes } = makeDeps({
    due: [task()],
    claimResults: { task_1: false },
  });
  const result = await runSchedulerTick({ now: NOW }, deps);

  assert.deepEqual(result, { due: 1, executed: 0, failed: 0, skipped: 1 });
  assert.equal(finishes.length, 0);
});

test("an executor throw records a failed execution with the real error message", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { deps, finishes } = makeDeps({
    due: [task()],
    executeResults: { task_1: new Error("model provider 500") },
  });
  const result = await runSchedulerTick({ now: NOW }, deps);

  assert.equal(result.failed, 1);
  assert.equal(finishes[0]!.outcome.status, "failed");
  assert.match(finishes[0]!.outcome.error!, /model provider 500/);
});

test("a task exceeding its own timeout fails with a timeout error", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { deps, finishes } = makeDeps({
    due: [task({ timeout: 20 })],
    executeDelayMs: 200,
  });
  const result = await runSchedulerTick({ now: NOW }, deps);

  assert.equal(result.failed, 1);
  assert.match(finishes[0]!.outcome.error!, /timed out after 20ms/);
});

test("per-task isolation: one failing task does not stop the rest", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { deps, finishes } = makeDeps({
    due: [
      task({ id: "task_bad" }),
      task({ id: "task_good" }),
    ],
    executeResults: { task_bad: new Error("boom") },
  });
  const result = await runSchedulerTick({ now: NOW }, deps);

  assert.deepEqual(result, { due: 2, executed: 1, failed: 1, skipped: 0 });
  assert.deepEqual(
    finishes.map((f) => [f.taskId, f.outcome.status]),
    [
      ["task_bad", "failed"],
      ["task_good", "success"],
    ],
  );
});
