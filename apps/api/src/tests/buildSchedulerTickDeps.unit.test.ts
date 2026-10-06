import assert from "node:assert/strict";
import test from "node:test";

// Binding tests for services/buildSchedulerTickDeps.ts: the exact where
// clauses the scheduler's compare-and-sets run with. The pure tick is
// tested against fakes; this is where a claim that forgot its guard, or
// a finish that could overwrite a cancelled row, would show.

import {
  LOST_EXECUTION_ERROR,
  LOST_EXECUTION_GRACE_MS,
  buildSchedulerTickDeps,
  effectiveMaxRetries,
  type SchedulerPrismaStub,
} from "../services/buildSchedulerTickDeps.js";
import { finishScheduledExecution } from "../services/finishScheduledExecution.js";
import type { DueTaskRow } from "../services/runSchedulerTick.js";

const NOW = new Date("2026-10-06T12:00:00Z");
const DUE = new Date("2026-10-06T11:59:00Z");

type Call = { model: string; op: string; args: any };

function fakePrisma(opts: {
  due?: any[];
  claimCount?: number;
  /** Status of the execution row; drives the finish compare-and-set. */
  executionStatus?: string | null;
  scheduleType?: string;
  /** How the execution being finished was started. */
  triggeredBy?: string;
  running?: Array<{ id: string; startedAt: Date | null; task: { timeout: number; taskType: string } }>;
}) {
  const calls: Call[] = [];
  const log = (model: string, op: string, args: unknown) => calls.push({ model, op, args });
  const prisma: SchedulerPrismaStub = {
    scheduledTask: {
      findMany: async (args) => {
        log("scheduledTask", "findMany", args);
        return opts.due ?? [];
      },
      updateMany: async (args) => {
        log("scheduledTask", "updateMany", args);
        return { count: opts.claimCount ?? 1 };
      },
      update: async (args) => {
        log("scheduledTask", "update", args);
        return {};
      },
    },
    taskExecution: {
      create: async (args) => {
        log("taskExecution", "create", args);
        return { id: "exec_1" };
      },
      findFirst: async (args) => {
        log("taskExecution", "findFirst", args);
        return opts.executionStatus === null ? null : { status: opts.executionStatus ?? "running" };
      },
      findMany: async (args) => {
        log("taskExecution", "findMany", args);
        return opts.running ?? [];
      },
      findUnique: async (args) => {
        log("taskExecution", "findUnique", args);
        return {
          taskId: "task_1",
          triggeredBy: opts.triggeredBy ?? "schedule",
          task: { scheduleType: opts.scheduleType ?? "interval" },
        };
      },
      updateMany: async (args) => {
        log("taskExecution", "updateMany", args);
        // The compare-and-set: only a row still 'running' matches.
        return { count: (opts.executionStatus ?? "running") === "running" ? 1 : 0 };
      },
    },
  };
  return { prisma, calls };
}

function row(overrides: Partial<DueTaskRow> = {}): DueTaskRow {
  return {
    id: "task_1",
    orgId: "org_1",
    agentId: null,
    orchestrationId: null,
    name: "digest",
    taskType: "webhook",
    payload: { url: "https://example.com/hook" },
    timeout: 5_000,
    maxRetries: 2,
    scheduleType: "interval",
    cronExpression: null,
    intervalSeconds: 3600,
    scheduledAt: null,
    timezone: "UTC",
    nextRunAt: DUE,
    ...overrides,
  };
}

const executorDeps = {
  loadAgent: async () => null,
  runAgentChat: async () => ({ content: "" }),
  fetchFn: fetch,
};

function build(prisma: SchedulerPrismaStub, extra: Partial<Parameters<typeof buildSchedulerTickDeps>[0]> = {}) {
  return buildSchedulerTickDeps({ prisma, executorDeps, ...extra });
}

test("due tasks are the enabled, active ones whose time has come; an agent-less task loads", async () => {
  const { prisma, calls } = fakePrisma({
    due: [
      { ...row(), agentId: null, maxRetries: 3, nextRunAt: DUE },
      { ...row({ id: "task_2", taskType: "workflow_run", orchestrationId: "orch_1" }), maxRetries: 3, nextRunAt: DUE },
      { ...row({ id: "task_3" }), nextRunAt: null },
    ],
  });
  const due = await build(prisma, { batchLimit: 7 }).loadDueTasks({ now: NOW });

  assert.deepEqual(calls[0]!.args, {
    where: { isEnabled: true, status: "active", nextRunAt: { not: null, lte: NOW } },
    orderBy: { nextRunAt: "asc" },
    take: 7,
  });
  assert.deepEqual(due.map((t) => t.id), ["task_1", "task_2"]);
  assert.equal(due[0]!.agentId, null);
  assert.equal(due[0]!.maxRetries, 3);
  assert.equal(due[1]!.orchestrationId, "orch_1");
  assert.equal(due[1]!.maxRetries, 0, "a workflow_run is never retried, whatever the row says");
});

test("retries apply only to types that are retried", () => {
  assert.equal(effectiveMaxRetries("webhook", 3), 3);
  assert.equal(effectiveMaxRetries("workflow_run", 3), 0);
  assert.equal(effectiveMaxRetries("health_check", 3), 0);
  assert.equal(effectiveMaxRetries("unknown_type", 3), 0);
});

test("the claim is a compare-and-set on exactly {id, nextRunAt} and advances the schedule", async () => {
  const { prisma, calls } = fakePrisma({});
  const claimed = await build(prisma).claimTask(row(), NOW);

  assert.equal(claimed, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args.where, { id: "task_1", nextRunAt: DUE });
  assert.deepEqual(calls[0]!.args.data, { nextRunAt: new Date("2026-10-06T13:00:00Z") });
});

test("a claim another replica already made counts zero and is not ours", async () => {
  const { prisma } = fakePrisma({ claimCount: 0 });
  assert.equal(await build(prisma).claimTask(row(), NOW), false);
});

test("a cron claim advances by the full expression in the task's time zone", async () => {
  const { prisma, calls } = fakePrisma({});
  await build(prisma).claimTask(
    row({ scheduleType: "cron", cronExpression: "0 16 * * 5", intervalSeconds: null }),
    NOW,
  );
  // Tuesday → the coming Friday, not tomorrow.
  assert.deepEqual(calls[0]!.args.data, { nextRunAt: new Date("2026-10-09T16:00:00Z") });
});

test("a one-off claim clears nextRunAt under the same guard", async () => {
  const { prisma, calls } = fakePrisma({});
  await build(prisma).claimTask(row({ scheduleType: "once", scheduledAt: DUE, intervalSeconds: null }), NOW);
  assert.deepEqual(calls[0]!.args, { where: { id: "task_1", nextRunAt: DUE }, data: { nextRunAt: null } });
});

test("a recurring schedule that cannot be read is stopped with a reason and not fired", async () => {
  const { prisma, calls } = fakePrisma({});
  const claimed = await build(prisma).claimTask(
    row({ scheduleType: "cron", cronExpression: "every now and then", intervalSeconds: null }),
    NOW,
  );
  assert.equal(claimed, false, "nothing runs at a time nobody chose");
  assert.deepEqual(calls[0]!.args.where, { id: "task_1", nextRunAt: DUE });
  assert.equal(calls[0]!.args.data.nextRunAt, null);
  assert.equal(calls[0]!.args.data.status, "failed");
  assert.match(calls[0]!.args.data.lastError, /schedule is not valid/);
});

test("an execution row is created running, with its attempt number and trigger", async () => {
  const { prisma, calls } = fakePrisma({});
  const created = await build(prisma).createExecution(row(), { now: NOW, attempt: 2, triggeredBy: "manual" });
  assert.deepEqual(created, { id: "exec_1" });
  assert.deepEqual(calls[0]!.args, {
    data: {
      taskId: "task_1",
      status: "running",
      input: { url: "https://example.com/hook" },
      triggeredBy: "manual",
      attempt: 2,
      startedAt: NOW,
    },
    select: { id: true },
  });
});

test("the finish is a compare-and-set on {id, status: 'running'} and then counts the run once", async () => {
  const { prisma, calls } = fakePrisma({});
  const won = await build(prisma).finishExecution("exec_1", row(), {
    status: "success",
    durationMs: 120,
    output: { status: 200 },
  });

  assert.equal(won, true);
  const finish = calls.find((c) => c.model === "taskExecution" && c.op === "updateMany")!;
  assert.deepEqual(finish.args.where, { id: "exec_1", status: "running" });
  assert.equal(finish.args.data.status, "success");
  assert.deepEqual(finish.args.data.output, { status: 200 });

  const stats = calls.find((c) => c.model === "scheduledTask" && c.op === "update")!;
  assert.deepEqual(stats.args.where, { id: "task_1" });
  assert.deepEqual(stats.args.data.totalRuns, { increment: 1 });
  assert.deepEqual(stats.args.data.successfulRuns, { increment: 1 });
  assert.equal(stats.args.data.lastRunStatus, "success");
});

test("the finish never matches a cancelled row: nothing is overwritten and no run is counted", async () => {
  const { prisma, calls } = fakePrisma({ executionStatus: "cancelled" });
  const won = await build(prisma).finishExecution("exec_1", row(), { status: "success", durationMs: 5, output: {} });

  assert.equal(won, false);
  assert.deepEqual(
    calls.find((c) => c.op === "updateMany")!.args.where,
    { id: "exec_1", status: "running" },
  );
  assert.equal(calls.filter((c) => c.model === "scheduledTask").length, 0);
});

test("a failed attempt that will be retried closes its row and leaves the task's counters alone", async () => {
  const { prisma, calls } = fakePrisma({});
  const retryAt = new Date("2026-10-06T12:00:05Z");
  await build(prisma).finishExecution("exec_1", row(), {
    status: "failed",
    durationMs: 30,
    error: "provider 500",
    output: { partial: true },
    retryAt,
  });

  const finish = calls.find((c) => c.model === "taskExecution" && c.op === "updateMany")!;
  assert.equal(finish.args.data.status, "failed");
  assert.equal(finish.args.data.error, "provider 500");
  assert.equal(finish.args.data.nextRetryAt, retryAt);
  assert.deepEqual(finish.args.data.output, { partial: true }, "what the task produced is kept with the error");
  assert.equal(calls.filter((c) => c.model === "scheduledTask").length, 0, "the firing is not over");
});

test("the final failure counts one failed run and records the error", async () => {
  const { prisma, calls } = fakePrisma({ scheduleType: "once" });
  await build(prisma).finishExecution("exec_1", row(), { status: "failed", durationMs: 30, error: "provider 500" });
  const stats = calls.find((c) => c.model === "scheduledTask" && c.op === "update")!;
  assert.deepEqual(stats.args.data.failedRuns, { increment: 1 });
  assert.equal(stats.args.data.lastError, "provider 500");
  assert.equal(stats.args.data.status, "completed", "a one-off task is done after its only firing");
  assert.deepEqual(
    calls.find((c) => c.op === "findUnique")!.args.select,
    { taskId: true, triggeredBy: true, task: { select: { scheduleType: true } } },
    "the trigger is read from the execution row, so every finisher agrees",
  );
});

// "Run now" on a one-off task that is still waiting for its time used to
// mark the task completed. The due query loads only 'active' tasks, so
// tomorrow's scheduled firing silently never happened.
test("a manual run of a one-off task leaves the task's status alone, however it ends", async () => {
  for (const outcome of [
    { status: "success", durationMs: 5, output: {} },
    { status: "failed", durationMs: 5, error: "provider 500" },
    { status: "cancelled", durationMs: 5, error: "cancelled" },
  ] as const) {
    const { prisma, calls } = fakePrisma({ scheduleType: "once", triggeredBy: "manual" });
    // The shared finisher directly: a cancel goes through it too.
    assert.equal(await finishScheduledExecution(prisma, "exec_1", outcome), true);
    const stats = calls.find((c) => c.model === "scheduledTask" && c.op === "update")!;
    assert.equal("status" in stats.args.data, false, outcome.status);
    assert.equal("nextRunAt" in stats.args.data, false, outcome.status);
    assert.equal(stats.args.data.lastRunStatus, outcome.status, "the run itself is still recorded");
  }
});

test("the scheduled firing of a one-off task completes it, also when cancelled or reaped", async () => {
  for (const triggeredBy of ["schedule", "scheduler"]) {
    for (const status of ["success", "cancelled"] as const) {
      const { prisma, calls } = fakePrisma({ scheduleType: "once", triggeredBy });
      await finishScheduledExecution(prisma, "exec_1", { status, durationMs: 5 });
      const stats = calls.find((c) => c.model === "scheduledTask" && c.op === "update")!;
      assert.equal(stats.args.data.status, "completed", `${triggeredBy} ${status}`);
    }
  }
  // A recurring task never changes status by finishing.
  const { prisma, calls } = fakePrisma({ scheduleType: "cron", triggeredBy: "schedule" });
  await build(prisma).finishExecution("exec_1", row(), { status: "success", durationMs: 5, output: {} });
  assert.equal("status" in calls.find((c) => c.model === "scheduledTask" && c.op === "update")!.args.data, false);
});

test("a cancelled or vanished execution row reads as cancelled; a running one does not", async () => {
  for (const [status, expected] of [["running", false], ["cancelled", true], [null, true], ["failed", false]] as const) {
    const { prisma, calls } = fakePrisma({ executionStatus: status });
    assert.equal(await build(prisma).isExecutionCancelled!("exec_1"), expected, String(status));
    assert.deepEqual(calls[0]!.args, { where: { id: "exec_1" }, select: { status: true } });
  }
});

test("a final failure emits scheduled_task.failed to the task's own organization", async () => {
  const events: Array<{ orgId: string; type: string; data: Record<string, unknown> }> = [];
  const { prisma } = fakePrisma({});
  const deps = build(prisma, {
    emitEvent: async (orgId, type, data) => {
      events.push({ orgId, type, data });
    },
  });
  await deps.notifyFailure!(row(), {
    executionId: "exec_3",
    error: "x".repeat(5000),
    attempts: 3,
    triggeredBy: "schedule",
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]!.orgId, "org_1");
  assert.equal(events[0]!.type, "scheduled_task.failed");
  assert.deepEqual(
    { ...events[0]!.data, error: undefined },
    { taskId: "task_1", taskName: "digest", taskType: "webhook", executionId: "exec_3", attempts: 3, triggeredBy: "schedule", error: undefined },
  );
  assert.equal((events[0]!.data.error as string).length, 2000, "a long error is cut for the payload");
});

test("executeTask passes the attempt's context through to the executor", async () => {
  const { prisma } = fakePrisma({});
  const seen: Array<{ url: string; body: any }> = [];
  const deps = buildSchedulerTickDeps({
    prisma,
    executorDeps: {
      ...executorDeps,
      guardDeps: { resolveHost: async () => ["93.184.216.34"] },
      fetchFn: (async (url: string, init?: RequestInit) => {
        seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    },
  });
  const result = await deps.executeTask(row(), {
    executionId: "exec_9",
    attempt: 3,
    signal: new AbortController().signal,
    triggeredBy: "schedule",
    now: NOW,
  });
  assert.deepEqual(result.output, { status: 200 });
  assert.equal(seen[0]!.body.executionId, "exec_9");
  assert.equal(seen[0]!.body.attempt, 3);
});

test("the webhook event list carries the workflow and scheduler events", async () => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  const { WEBHOOK_EVENTS } = await import("../services/webhooks.js");
  for (const event of ["workflow.completed", "workflow.failed", "scheduled_task.failed", "report.generated"]) {
    assert.ok((WEBHOOK_EVENTS as string[]).includes(event), event);
  }
  assert.equal(new Set(WEBHOOK_EVENTS).size, WEBHOOK_EVENTS.length, "no event is listed twice");
});

test("the reaper fails only executions running past their task's timeout plus grace", async () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const { prisma, calls } = fakePrisma({
    running: [
      // 10 s timeout, running for 10 minutes: lost.
      { id: "lost", startedAt: ago(600_000), task: { timeout: 10_000, taskType: "agent_run" } },
      // One hour timeout, running for 10 minutes: healthy.
      { id: "slow", startedAt: ago(600_000), task: { timeout: 3_600_000, taskType: "agent_run" } },
      // Just inside the grace period.
      { id: "edge", startedAt: ago(10_000 + LOST_EXECUTION_GRACE_MS), task: { timeout: 10_000, taskType: "webhook" } },
      // A workflow run is finished by its own worker; the task timeout does not apply to it.
      { id: "workflow", startedAt: ago(600_000), task: { timeout: 10_000, taskType: "workflow_run" } },
      // ...until even the longest workflow would be over.
      { id: "dead_workflow", startedAt: ago(3_600_000 + LOST_EXECUTION_GRACE_MS + 1), task: { timeout: 10_000, taskType: "workflow_run" } },
    ],
  });
  const reaped = await build(prisma).reapLostExecutions!(NOW);

  assert.equal(reaped, 2);
  const scan = calls[0]!.args;
  assert.equal(scan.where.status, "running");
  assert.deepEqual(scan.where.startedAt, { lt: new Date(NOW.getTime() - 5_000 - LOST_EXECUTION_GRACE_MS) });
  const closed = calls.filter((c) => c.model === "taskExecution" && c.op === "updateMany");
  assert.deepEqual(closed.map((c) => c.args.where), [
    { id: "lost", status: "running" },
    { id: "dead_workflow", status: "running" },
  ]);
  assert.equal(closed[0]!.args.data.status, "failed");
  assert.equal(closed[0]!.args.data.error, LOST_EXECUTION_ERROR);
});

test("the reaper loses cleanly to a worker that finished first", async () => {
  const { prisma, calls } = fakePrisma({
    executionStatus: "success",
    running: [{ id: "raced", startedAt: new Date(NOW.getTime() - 900_000), task: { timeout: 10_000, taskType: "webhook" } }],
  });
  assert.equal(await build(prisma).reapLostExecutions!(NOW), 0);
  assert.equal(calls.filter((c) => c.model === "scheduledTask").length, 0, "no run is counted twice");
});

// The two halves together: replica A's tick started at T0, its fifth
// task only got a pool slot at T0+200 s, and replica B's tick at
// T0+430 s reaps. The row is 230 s into a 300 s timeout and must stand.
test("an execution that started late in its tick is not reaped by another replica's tick", async () => {
  const { runTaskFiring } = await import("../services/runSchedulerTick.js");
  const tickStart = NOW.getTime();
  const { prisma, calls } = fakePrisma({});
  const deps = build(prisma, { clock: () => new Date(tickStart + 200_000) });
  deps.executeTask = async () => ({ output: {} });
  await runTaskFiring(row({ timeout: 300_000 }), { triggeredBy: "schedule" }, deps);

  const startedAt: Date = calls.find((c) => c.model === "taskExecution" && c.op === "create")!.args.data.startedAt;
  assert.equal(startedAt.getTime(), tickStart + 200_000);

  const other = fakePrisma({
    running: [{ id: "exec_1", startedAt, task: { timeout: 300_000, taskType: "agent_run" } }],
  });
  const reaped = await build(other.prisma).reapLostExecutions!(new Date(tickStart + 430_000));
  assert.equal(reaped, 0);
  assert.equal(other.calls.filter((c) => c.op === "updateMany").length, 0);

  // Stamped with the tick's time, the same row would have been called lost.
  const stale = fakePrisma({
    running: [{ id: "exec_1", startedAt: new Date(tickStart), task: { timeout: 300_000, taskType: "agent_run" } }],
  });
  assert.equal(await build(stale.prisma).reapLostExecutions!(new Date(tickStart + 430_000)), 1);
});
