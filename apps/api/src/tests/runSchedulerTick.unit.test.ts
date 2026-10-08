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
// Each firing runs under its own AbortController (timeout, cancel), is
// retried with one execution row per attempt, and a deferred result
// (a queued workflow run) is left for its own worker to finish.

import type {
  DueTaskRow,
  ExecutionOutcome,
  SchedulerTickDeps,
  TaskAttemptContext,
  TaskSuccess,
} from "../services/runSchedulerTick.js";

const NOW = new Date("2026-08-02T12:00:00Z");

function task(overrides: Partial<DueTaskRow> = {}): DueTaskRow {
  return {
    id: "task_1",
    orgId: "org_1",
    agentId: "agent_1",
    orchestrationId: null,
    name: "daily digest",
    taskType: "agent_run",
    payload: { prompt: "summarize" },
    timeout: 5_000,
    maxRetries: 0,
    scheduleType: "interval",
    cronExpression: null,
    intervalSeconds: 3600,
    scheduledAt: null,
    timezone: "UTC",
    nextRunAt: new Date("2026-08-02T11:59:00Z"),
    ...overrides,
  };
}

type ExecuteResult = { output: unknown; deferred?: true } | Error;

function makeDeps(opts: {
  due: DueTaskRow[];
  claimResults?: Record<string, boolean>;
  /** One result per task, or a list consumed one per attempt. */
  executeResults?: Record<string, ExecuteResult | ExecuteResult[]>;
  executeDelayMs?: number;
  /** Runs instead of the canned results; sees the attempt's context. */
  execute?: (t: DueTaskRow, ctx: TaskAttemptContext) => Promise<{ output: unknown; deferred?: true }>;
  finishResult?: boolean;
  cancelled?: () => boolean;
  /** Runs inside the success hook, after the call was recorded. */
  onSuccess?: (t: DueTaskRow, success: TaskSuccess) => Promise<void> | void;
}) {
  const finishes: Array<{ executionId: string; taskId: string; outcome: ExecutionOutcome }> = [];
  const executions: Array<{
    id: string;
    taskId: string;
    attempt: number;
    triggeredBy: string;
    now: Date;
  }> = [];
  const contexts: TaskAttemptContext[] = [];
  const sleeps: number[] = [];
  const failures: Array<{ taskId: string; executionId: string; error: string; attempts: number }> = [];
  const successes: Array<{ taskId: string } & TaskSuccess> = [];
  /** Every call that reaches a dep, in order. */
  const order: string[] = [];
  const attemptsSeen: Record<string, number> = {};
  let executionSeq = 0;
  const deps: SchedulerTickDeps = {
    loadDueTasks: async () => opts.due,
    claimTask: async (t) => opts.claimResults?.[t.id] ?? true,
    createExecution: async (t, attempt) => {
      const id = `exec_${++executionSeq}`;
      executions.push({
        id,
        taskId: t.id,
        attempt: attempt.attempt,
        triggeredBy: attempt.triggeredBy,
        now: attempt.now,
      });
      return { id };
    },
    executeTask: async (t, ctx) => {
      contexts.push(ctx);
      if (opts.execute) return opts.execute(t, ctx);
      if (opts.executeDelayMs) {
        await new Promise((r) => setTimeout(r, opts.executeDelayMs));
      }
      const configured = opts.executeResults?.[t.id];
      const index = attemptsSeen[t.id] ?? 0;
      attemptsSeen[t.id] = index + 1;
      const result = Array.isArray(configured)
        ? configured[Math.min(index, configured.length - 1)]
        : configured;
      if (result instanceof Error) throw result;
      return result ?? { output: { ok: true } };
    },
    finishExecution: async (executionId, t, outcome) => {
      finishes.push({ executionId, taskId: t.id, outcome });
      order.push(`finish:${outcome.status}`);
      return opts.finishResult ?? true;
    },
    ...(opts.cancelled ? { isExecutionCancelled: async () => opts.cancelled!() } : {}),
    notifyFailure: async (t, failure) => {
      failures.push({ taskId: t.id, ...failure });
    },
    notifySuccess: async (t, success) => {
      successes.push({ taskId: t.id, ...success });
      order.push("notifySuccess");
      await opts.onSuccess?.(t, success);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    cancelPollMs: 5,
  };
  return { finishes, executions, contexts, sleeps, failures, successes, order, deps };
}

const EMPTY = { due: 0, executed: 0, failed: 0, skipped: 0, deferred: 0, cancelled: 0, retries: 0, reaped: 0 };

test("a due task is claimed, executed, and finished as success", async () => {
  setupEnv();
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { deps, finishes } = makeDeps({ due: [task()] });
  const result = await runSchedulerTick({ now: NOW }, deps);

  assert.deepEqual(result, { ...EMPTY, due: 1, executed: 1 });
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

  assert.deepEqual(result, { ...EMPTY, due: 1, skipped: 1 });
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

  assert.deepEqual(result, { ...EMPTY, due: 2, executed: 1, failed: 1 });
  assert.deepEqual(
    finishes.map((f) => [f.taskId, f.outcome.status]),
    [
      ["task_bad", "failed"],
      ["task_good", "success"],
    ],
  );
});

// ============================================
// Abortable timeout and cancellation
// ============================================

test("a timeout aborts the task through its signal, and the timer does not outlive the task", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  let aborted = false;
  const { deps, finishes, sleeps } = makeDeps({
    due: [task({ timeout: 20, maxRetries: 3 })],
    execute: (_t, ctx) =>
      new Promise((_, reject) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          reject(ctx.signal.reason);
        });
      }),
  });
  const result = await runSchedulerTick({ now: NOW }, deps);

  assert.equal(aborted, true, "the executor's signal fired");
  assert.equal(result.failed, 1);
  assert.match(finishes[0]!.outcome.error!, /timed out after 20ms/);
  // The firing used its whole budget once; it is not run again.
  assert.equal(finishes.length, 1);
  assert.deepEqual(sleeps, []);
});

test("a fast task leaves no signal aborted behind it", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { deps, contexts } = makeDeps({ due: [task({ timeout: 30 })] });
  await runSchedulerTick({ now: NOW }, deps);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(contexts[0]!.signal.aborted, false, "the timeout timer was cleared");
});

test("a cancelled execution aborts the in-flight task and is not finished again", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  let cancelled = false;
  let aborted = false;
  const { deps, finishes, failures } = makeDeps({
    due: [task({ maxRetries: 2 })],
    cancelled: () => cancelled,
    execute: (_t, ctx) =>
      new Promise((_, reject) => {
        setTimeout(() => (cancelled = true), 15);
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          reject(ctx.signal.reason);
        });
      }),
  });
  const result = await runSchedulerTick({ now: NOW }, deps);

  assert.equal(aborted, true);
  assert.deepEqual(result, { ...EMPTY, due: 1, cancelled: 1 });
  assert.equal(finishes.length, 0, "the canceller already closed the row");
  assert.equal(failures.length, 0, "a cancel is not a failure");
});

test("a failure whose finish loses the compare-and-set counts as cancelled, not failed", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { deps, failures } = makeDeps({
    due: [task()],
    executeResults: { task_1: new Error("boom") },
    finishResult: false,
  });
  const result = await runSchedulerTick({ now: NOW }, deps);
  assert.deepEqual(result, { ...EMPTY, due: 1, cancelled: 1 });
  assert.equal(failures.length, 0);
});

// ============================================
// Retries
// ============================================

test("retries write one execution per attempt, numbered 1..n, with a backoff between them", async () => {
  const { runSchedulerTick, retryBackoffMs } = await import("../services/runSchedulerTick.js");
  const { deps, finishes, executions, contexts, sleeps, failures } = makeDeps({
    due: [task({ maxRetries: 2 })],
    executeResults: {
      task_1: [new Error("provider 500"), new Error("provider 502"), { output: { ok: 3 } }],
    },
  });
  const result = await runSchedulerTick({ now: NOW }, deps);

  assert.deepEqual(result, { ...EMPTY, due: 1, executed: 1, retries: 2 });
  assert.deepEqual(executions.map((e) => e.attempt), [1, 2, 3]);
  assert.deepEqual(contexts.map((c) => c.attempt), [1, 2, 3]);
  assert.deepEqual(
    contexts.map((c) => c.executionId),
    ["exec_1", "exec_2", "exec_3"],
    "each attempt runs against its own execution row",
  );
  assert.deepEqual(sleeps, [retryBackoffMs(1), retryBackoffMs(2)]);
  assert.deepEqual(finishes.map((f) => f.outcome.status), ["failed", "failed", "success"]);
  // A retried attempt is closed without ending the firing.
  assert.ok(finishes[0]!.outcome.retryAt instanceof Date);
  assert.ok(finishes[1]!.outcome.retryAt instanceof Date);
  assert.equal(finishes[2]!.outcome.retryAt, undefined);
  assert.equal(failures.length, 0);
});

test("when every attempt fails the last one ends the firing and is reported once", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { deps, finishes, failures } = makeDeps({
    due: [task({ maxRetries: 1 })],
    executeResults: { task_1: new Error("provider 500") },
  });
  const result = await runSchedulerTick({ now: NOW }, deps);

  assert.deepEqual(result, { ...EMPTY, due: 1, failed: 1, retries: 1 });
  assert.equal(finishes.length, 2);
  assert.equal(finishes[1]!.outcome.retryAt, undefined, "the final attempt is final");
  assert.deepEqual(failures, [
    { taskId: "task_1", executionId: "exec_2", error: "provider 500", attempts: 2, triggeredBy: "schedule" },
  ]);
});

test("a permanent failure is not retried, and keeps the output the task produced", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { TaskError } = await import("../services/scheduledTasks/taskError.js");
  const { deps, finishes, sleeps } = makeDeps({
    due: [task({ maxRetries: 5 })],
    executeResults: {
      task_1: new TaskError("health check down", { permanent: true, output: { status: "down" } }),
    },
  });
  const result = await runSchedulerTick({ now: NOW }, deps);

  assert.deepEqual(result, { ...EMPTY, due: 1, failed: 1 });
  assert.equal(finishes.length, 1);
  assert.deepEqual(finishes[0]!.outcome.output, { status: "down" });
  assert.deepEqual(sleeps, []);
});

test("the backoff grows and is capped at a minute", async () => {
  const { retryBackoffMs } = await import("../services/runSchedulerTick.js");
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(retryBackoffMs), [5000, 10000, 20000, 40000, 60000, 60000]);
});

// ============================================
// Deferred results
// ============================================

test("a deferred result leaves the execution running: no finish, no retry", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { deps, finishes, executions } = makeDeps({
    due: [task({ taskType: "workflow_run", orchestrationId: "orch_1" })],
    executeResults: { task_1: { output: { orchestrationExecutionId: "run_1" }, deferred: true } },
  });
  const result = await runSchedulerTick({ now: NOW }, deps);

  assert.deepEqual(result, { ...EMPTY, due: 1, deferred: 1 });
  assert.equal(executions.length, 1);
  assert.equal(finishes.length, 0, "the workflow worker finishes this row");
});

// ============================================
// Bounded concurrency
// ============================================

test("due tasks run concurrently, never more than the configured number at once", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  let running = 0;
  let peak = 0;
  const { deps, finishes } = makeDeps({
    due: Array.from({ length: 7 }, (_, i) => task({ id: `task_${i}` })),
    execute: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running -= 1;
      return { output: { ok: true } };
    },
  });
  const result = await runSchedulerTick({ now: NOW, concurrency: 3 }, deps);

  assert.equal(result.executed, 7);
  assert.equal(finishes.length, 7);
  assert.equal(peak, 3, "the pool was used fully and never exceeded");
});

test("per-task isolation holds under concurrency, including a claim that throws", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { deps, finishes } = makeDeps({
    due: [task({ id: "task_a" }), task({ id: "task_claim" }), task({ id: "task_bad" }), task({ id: "task_d" })],
    executeResults: { task_bad: new Error("boom") },
  });
  const original = deps.claimTask;
  deps.claimTask = async (t, now) => {
    if (t.id === "task_claim") throw new Error("database gone");
    return original(t, now);
  };
  const result = await runSchedulerTick({ now: NOW, concurrency: 4 }, deps);

  assert.deepEqual(result, { ...EMPTY, due: 4, executed: 2, failed: 2 });
  assert.deepEqual(
    finishes.filter((f) => f.outcome.status === "success").map((f) => f.taskId).sort(),
    ["task_a", "task_d"],
  );
});

test("a firing whose execution row cannot be created is counted failed and never executed", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { deps, contexts } = makeDeps({ due: [task()] });
  deps.createExecution = async () => {
    throw new Error("insert failed");
  };
  const result = await runSchedulerTick({ now: NOW }, deps);
  assert.deepEqual(result, { ...EMPTY, due: 1, failed: 1 });
  assert.equal(contexts.length, 0);
});

test("a manual firing is recorded as manual and honours its own retry limit", async () => {
  const { runTaskFiring } = await import("../services/runSchedulerTick.js");
  const { deps, executions, finishes } = makeDeps({
    due: [],
    executeResults: { task_1: new Error("provider 500") },
  });
  const firing = await runTaskFiring(
    task({ maxRetries: 4 }),
    { triggeredBy: "manual", maxRetries: 0 },
    deps,
  );
  assert.deepEqual(firing, { status: "failed", executionId: "exec_1", attempts: 1, error: "provider 500" });
  assert.deepEqual(executions.map((e) => e.triggeredBy), ["manual"]);
  assert.equal(finishes.length, 1);
});

test("lost executions are reaped before due tasks run, and a failing reap does not stop the tick", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const order: string[] = [];
  const { deps } = makeDeps({ due: [task()] });
  const load = deps.loadDueTasks;
  deps.loadDueTasks = async (args) => (order.push("load"), load(args));
  deps.reapLostExecutions = async (now) => {
    order.push("reap");
    assert.equal(now, NOW);
    return 2;
  };
  assert.deepEqual(await runSchedulerTick({ now: NOW }, deps), { ...EMPTY, due: 1, executed: 1, reaped: 2 });
  assert.deepEqual(order, ["reap", "load"]);

  deps.reapLostExecutions = async () => {
    throw new Error("database blip");
  };
  assert.deepEqual(await runSchedulerTick({ now: NOW }, deps), { ...EMPTY, due: 1, executed: 1 });
});

// The lost-run reaper measures an execution's age from its startedAt.
// Stamped with the tick's time, a task that waited 200 s for a pool slot
// behind slower tasks looked 200 s old the moment it started, and another
// replica's tick failed it as "run lost" while it was healthy and billed.
test("each execution is stamped with the moment its attempt starts, not the tick's time", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  let wall = NOW.getTime();
  const { deps, executions, contexts } = makeDeps({
    due: [task({ id: "slow" }), task({ id: "queued", maxRetries: 1 })],
    execute: async (t) => {
      // The slow task holds the only pool slot for 200 s.
      if (t.id === "slow") wall += 200_000;
      else if (wall < NOW.getTime() + 230_000) {
        wall += 30_000;
        throw new Error("provider 500");
      }
      return { output: {} };
    },
  });
  deps.clock = () => new Date(wall);

  const result = await runSchedulerTick({ now: NOW, concurrency: 1 }, deps);

  assert.deepEqual(result, { ...EMPTY, due: 2, executed: 2, retries: 1 });
  assert.deepEqual(
    executions.map((e) => [e.taskId, e.attempt, e.now.getTime() - NOW.getTime()]),
    [
      ["slow", 1, 0],
      ["queued", 1, 200_000],
      ["queued", 2, 230_000],
    ],
  );
  assert.deepEqual(
    contexts.map((c) => c.now.getTime() - NOW.getTime()),
    [0, 200_000, 230_000],
    "the executor sees the same start time the row carries",
  );
});

test("without an injected clock the start time is the wall clock", async () => {
  const { runTaskFiring } = await import("../services/runSchedulerTick.js");
  const { deps, executions } = makeDeps({ due: [] });
  const before = Date.now();
  await runTaskFiring(task(), { triggeredBy: "schedule" }, deps);
  assert.ok(executions[0]!.now.getTime() >= before);
  assert.ok(executions[0]!.now.getTime() <= Date.now());
});

// ============================================
// notifySuccess: told once, decides nothing
// ============================================

test("a won finish as success tells notifySuccess once, after the row is closed", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const at = new Date("2026-08-02T12:00:07Z");
  const { deps, successes, failures, order } = makeDeps({
    due: [task()],
    executeResults: { task_1: { output: { content: "the digest" } } },
  });
  deps.clock = () => at;
  const result = await runSchedulerTick({ now: NOW }, deps);

  assert.deepEqual(result, { ...EMPTY, due: 1, executed: 1 });
  assert.equal(successes.length, 1);
  const { durationMs, ...told } = successes[0]!;
  assert.deepEqual(told, {
    taskId: "task_1",
    executionId: "exec_1",
    attempts: 1,
    triggeredBy: "schedule",
    output: { content: "the digest" },
    finishedAt: at,
  });
  assert.ok(durationMs >= 0);
  assert.deepEqual(order, ["finish:success", "notifySuccess"], "never before the compare-and-set");
  assert.equal(failures.length, 0);
});

test("a success after retries is told once, with the attempt that succeeded", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { deps, successes, failures, order } = makeDeps({
    due: [task({ maxRetries: 2 })],
    executeResults: { task_1: [new Error("provider 500"), { output: { content: "second try" } }] },
  });
  await runSchedulerTick({ now: NOW }, deps);

  assert.equal(successes.length, 1);
  assert.equal(successes[0]!.executionId, "exec_2");
  assert.equal(successes[0]!.attempts, 2);
  assert.deepEqual(order, ["finish:failed", "finish:success", "notifySuccess"]);
  assert.equal(failures.length, 0);
});

test("a success whose finish loses the compare-and-set tells nobody", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { deps, successes, finishes } = makeDeps({ due: [task()], finishResult: false });
  await runSchedulerTick({ now: NOW }, deps);

  assert.equal(finishes.length, 1, "the finish was tried");
  assert.equal(successes.length, 0, "another finisher closed the row; nothing is announced or sent");
});

test("a success that could not be saved tells nobody", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const { deps, successes } = makeDeps({ due: [task()] });
  deps.finishExecution = async () => {
    throw new Error("db down");
  };
  const result = await runSchedulerTick({ now: NOW }, deps);
  assert.deepEqual(result, { ...EMPTY, due: 1, failed: 1 });
  assert.equal(successes.length, 0);
});

test("notifySuccess is never told about a failure, a timeout, a cancel or a deferred run", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");

  const failed = makeDeps({ due: [task({ maxRetries: 1 })], executeResults: { task_1: new Error("boom") } });
  await runSchedulerTick({ now: NOW }, failed.deps);
  assert.equal(failed.successes.length, 0);
  assert.equal(failed.failures.length, 1);

  const timedOut = makeDeps({ due: [task({ timeout: 20 })], executeDelayMs: 200 });
  await runSchedulerTick({ now: NOW }, timedOut.deps);
  assert.equal(timedOut.successes.length, 0);

  let cancelled = false;
  const stopped = makeDeps({
    due: [task()],
    cancelled: () => cancelled,
    execute: async (_t, ctx) => {
      cancelled = true;
      await new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason)));
      return { output: {} };
    },
  });
  assert.deepEqual(await runSchedulerTick({ now: NOW }, stopped.deps), { ...EMPTY, due: 1, cancelled: 1 });
  assert.equal(stopped.successes.length, 0);

  const deferred = makeDeps({
    due: [task({ taskType: "workflow_run" })],
    executeResults: { task_1: { output: { executionId: "run_1" }, deferred: true } },
  });
  assert.deepEqual(await runSchedulerTick({ now: NOW }, deferred.deps), { ...EMPTY, due: 1, deferred: 1 });
  assert.equal(deferred.successes.length, 0);
});

test("a hook that throws leaves the run a success: one finish, no new attempt, the same schedule", async () => {
  const { runSchedulerTick } = await import("../services/runSchedulerTick.js");
  const run = async (onSuccess?: () => Promise<void>) => {
    const made = makeDeps({ due: [task({ maxRetries: 3 })], ...(onSuccess ? { onSuccess } : {}) });
    const claims: Array<{ taskId: string; now: Date }> = [];
    made.deps.claimTask = async (t, now) => {
      claims.push({ taskId: t.id, now });
      return true;
    };
    const result = await runSchedulerTick({ now: NOW }, made.deps);
    return { ...made, claims, result };
  };

  const quiet = await run();
  const throwing = await run(async () => {
    throw new Error("slack is down");
  });

  assert.deepEqual(throwing.result, { ...EMPTY, due: 1, executed: 1 });
  assert.deepEqual(throwing.result, quiet.result, "counted exactly as a run whose hook did nothing");
  // The only writes to the row and the task are the claim (next run time)
  // and the one finish (status, counters): the same with and without.
  assert.deepEqual(throwing.claims, quiet.claims);
  assert.deepEqual(
    throwing.finishes.map((f) => [f.executionId, f.outcome.status, f.outcome.output, f.outcome.retryAt]),
    quiet.finishes.map((f) => [f.executionId, f.outcome.status, f.outcome.output, f.outcome.retryAt]),
  );
  assert.deepEqual(throwing.finishes.map((f) => f.outcome.status), ["success"]);
  assert.equal(throwing.executions.length, 1, "no second execution row");
  assert.equal(throwing.contexts.length, 1, "the task ran once");
  assert.deepEqual(throwing.sleeps, [], "no backoff was started");
  assert.equal(throwing.failures.length, 0, "and it is not reported as a failure");
  assert.equal(throwing.successes.length, 1);
});

test("a hook that throws before its first await is dropped the same way", async () => {
  const { runTaskFiring } = await import("../services/runSchedulerTick.js");
  const { deps, finishes, failures } = makeDeps({ due: [] });
  deps.notifySuccess = (() => {
    throw new Error("not even a promise");
  }) as never;
  const firing = await runTaskFiring(task({ maxRetries: 2 }), { triggeredBy: "manual" }, deps);
  assert.deepEqual(firing, { status: "success", executionId: "exec_1", attempts: 1 });
  assert.deepEqual(finishes.map((f) => f.outcome.status), ["success"]);
  assert.equal(failures.length, 0);
});

test("a hook that never answers is waited for up to its bound, then the firing ends as success", async () => {
  const { runTaskFiring, DEFAULT_NOTIFY_SUCCESS_TIMEOUT_MS } = await import("../services/runSchedulerTick.js");
  assert.equal(DEFAULT_NOTIFY_SUCCESS_TIMEOUT_MS, 30_000);
  const { deps, finishes, executions, successes } = makeDeps({
    due: [],
    onSuccess: () => new Promise<void>(() => {}),
  });
  deps.notifySuccessTimeoutMs = 20;
  const started = Date.now();
  const firing = await runTaskFiring(task({ maxRetries: 2 }), { triggeredBy: "schedule" }, deps);

  assert.deepEqual(firing, { status: "success", executionId: "exec_1", attempts: 1 });
  assert.ok(Date.now() - started < 5_000, "the firing did not wait for the hook");
  assert.equal(successes.length, 1);
  assert.deepEqual(finishes.map((f) => f.outcome.status), ["success"]);
  assert.equal(executions.length, 1);
});

test("a manual firing that succeeds tells notifySuccess once, as manual", async () => {
  const { runTaskFiring } = await import("../services/runSchedulerTick.js");
  const { deps, successes } = makeDeps({ due: [] });
  await runTaskFiring(task(), { triggeredBy: "manual", maxRetries: 0 }, deps);
  assert.equal(successes.length, 1);
  assert.equal(successes[0]!.triggeredBy, "manual");
});

test("a firing with no success hook finishes as it always did", async () => {
  const { runTaskFiring } = await import("../services/runSchedulerTick.js");
  const { deps } = makeDeps({ due: [] });
  delete deps.notifySuccess;
  assert.deepEqual(await runTaskFiring(task(), { triggeredBy: "schedule" }, deps), {
    status: "success",
    executionId: "exec_1",
    attempts: 1,
  });
});

test("\"Run now\" goes through the same firing, with the same hook", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const service = read("../services/scheduler.ts");
  // triggerTask runs the firing the worker runs, on deps built in one place...
  // (firingDeps is the default of buildFiringDeps; the execution row is the
  // one made under the task's lock, tests/schedulerTriggerRace.unit.test.ts.)
  assert.match(service, /buildFiringDeps: \(\) => TaskFiringDeps = firingDeps,/);
  assert.match(
    service,
    /await runTaskFiring\(\s*row,\s*\{ triggeredBy: "manual", maxRetries: 0 \},[\s\S]{0,120}\{ \.\.\.buildFiringDeps\(\), createExecution: async \(\) => \(\{ id: executionId \}\) \},\s*\)/,
  );
  // ...and those deps, like the worker's, can deliver.
  const firingDeps = service.slice(service.indexOf("function firingDeps()"), service.indexOf("export async function triggerTask"));
  assert.match(firingDeps, /buildSchedulerTickDeps\(\{/);
  assert.match(firingDeps, /resultDelivery: buildResultDeliveryDeps,/);
  assert.match(firingDeps, /triggerWebhook\(eventOrgId, type, data\)/);
  const queue = read("../queues/scheduler.queue.ts");
  assert.match(queue, /resultDelivery: buildResultDeliveryDeps,/);
  assert.match(queue, /triggerWebhook\(orgId, type, data\)/);
});
