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
  outputPreviewOf,
  type DeliveryRecordPrisma,
  type SchedulerPrismaStub,
} from "../services/buildSchedulerTickDeps.js";
import { finishScheduledExecution } from "../services/finishScheduledExecution.js";
import { runTaskFiring, type DueTaskRow, type TaskSuccess } from "../services/runSchedulerTick.js";
import type { ReportChannel } from "../services/scheduledTasks/report.js";
import type { ResultDeliveryDeps } from "../services/scheduledTasks/resultDelivery.js";

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
  /** The delivery-column write fails (the row vanished, the database is down). */
  deliveryWriteFails?: boolean;
}) {
  const calls: Call[] = [];
  const log = (model: string, op: string, args: unknown) => calls.push({ model, op, args });
  const prisma: SchedulerPrismaStub & DeliveryRecordPrisma = {
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
      update: async (args) => {
        log("taskExecution", "update", args);
        if (opts.deliveryWriteFails) throw new Error("record to update not found");
        return { id: args.where.id };
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

// ============================================
// After a success: the event, then the delivery, then the record
// ============================================

const CHANNEL_ID = "0b0f6c0e-5a52-4a3e-9d0e-2f6f3f1f7a11";
const FINISHED = new Date("2026-10-06T12:00:09Z");

function agentRow(overrides: Partial<DueTaskRow> = {}): DueTaskRow {
  return row({
    agentId: "agent_1",
    taskType: "agent_run",
    payload: { prompt: "summarize", deliver: { alertChannelId: CHANNEL_ID } },
    ...overrides,
  });
}

function success(overrides: Partial<TaskSuccess> = {}): TaskSuccess {
  return {
    executionId: "exec_7",
    attempts: 2,
    triggeredBy: "schedule",
    durationMs: 1234,
    output: { content: "the digest", usage: null },
    finishedAt: FINISHED,
    ...overrides,
  };
}

/** The whole success step on fakes, with one shared log of what happened in what order. */
function successWorld(opts: {
  channel?: Partial<ReportChannel> | null;
  emitFails?: boolean;
  sendFails?: boolean;
  loadFails?: boolean;
  deliveryWriteFails?: boolean;
  noDelivery?: boolean;
  noEmit?: boolean;
} = {}) {
  const steps: string[] = [];
  const events: Array<{ orgId: string; type: string; data: Record<string, unknown> }> = [];
  const loads: Array<{ channelId: string; orgId: string }> = [];
  const sent: Array<{ channel: ReportChannel; message: any }> = [];
  const { prisma, calls } = fakePrisma({ deliveryWriteFails: opts.deliveryWriteFails });
  let built = 0;
  const delivery: ResultDeliveryDeps = {
    loadAlertChannel: async (channelId, orgId) => {
      steps.push("load");
      loads.push({ channelId, orgId });
      if (opts.loadFails) throw new Error("db down");
      if (opts.channel === null) return null;
      return {
        id: channelId,
        name: "Team Slack",
        type: "slack",
        isEnabled: true,
        config: { webhookUrl: "https://hooks.slack.example/T000/B000/secret" },
        ...opts.channel,
      } as ReportChannel;
    },
    emailConfigured: () => true,
    sendToChannel: async (channel, message) => {
      steps.push("send");
      if (opts.sendFails) throw new Error("https://hooks.slack.example/T000/B000/secret answered 500");
      sent.push({ channel, message });
    },
    sendEmail: async (channel, message) => {
      steps.push("email");
      sent.push({ channel, message });
    },
    now: () => FINISHED,
  };
  const deps = build(prisma, {
    ...(opts.noEmit
      ? {}
      : {
          emitEvent: async (orgId, type, data) => {
            steps.push("event");
            if (opts.emitFails) throw new Error("webhook store down");
            events.push({ orgId, type, data });
          },
        }),
    ...(opts.noDelivery
      ? {}
      : {
          resultDelivery: () => {
            built += 1;
            return delivery;
          },
        }),
  });
  const writes = () => {
    const recorded = calls.filter((c) => c.model === "taskExecution" && c.op === "update");
    if (recorded.length > 0 && !steps.includes("record")) steps.push("record");
    return recorded;
  };
  // Every other write the tick's Prisma can make: none may happen in this step.
  const otherWrites = () =>
    calls.filter(
      (c) =>
        !(c.model === "taskExecution" && c.op === "update") &&
        ["update", "updateMany", "create"].includes(c.op),
    );
  return { deps, steps, events, loads, sent, calls, writes, otherWrites, built: () => built };
}

test("a success emits scheduled_task.completed with exactly the documented payload", async () => {
  const world = successWorld();
  await world.deps.notifySuccess!(agentRow(), success());

  assert.equal(world.events.length, 1);
  assert.equal(world.events[0]!.orgId, "org_1");
  assert.equal(world.events[0]!.type, "scheduled_task.completed");
  assert.deepEqual(world.events[0]!.data, {
    taskId: "task_1",
    taskName: "digest",
    taskType: "agent_run",
    agentId: "agent_1",
    executionId: "exec_7",
    attempts: 2,
    triggeredBy: "schedule",
    durationMs: 1234,
    outputPreview: "the digest",
  });
});

test("the event comes first, then the delivery, then the record", async () => {
  const world = successWorld();
  await world.deps.notifySuccess!(agentRow(), success());
  world.writes();
  assert.deepEqual(world.steps, ["event", "load", "send", "record"]);

  // The place is looked up inside the task's own organization, and gets the answer text.
  assert.deepEqual(world.loads, [{ channelId: CHANNEL_ID, orgId: "org_1" }]);
  assert.equal(world.sent.length, 1);
  assert.deepEqual(world.sent[0]!.message, {
    kind: "result",
    title: "Result: digest",
    text: "the digest",
    executionId: "exec_7",
    finishedAt: FINISHED.toISOString(),
  });
});

test("the record write sets the delivery column of that execution and touches nothing else", async () => {
  const world = successWorld();
  await world.deps.notifySuccess!(agentRow(), success());

  const writes = world.writes();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!.args, {
    where: { id: "exec_7" },
    data: {
      delivery: [
        {
          channelId: CHANNEL_ID,
          name: "Team Slack",
          type: "slack",
          status: "sent",
          at: FINISHED.toISOString(),
        },
      ],
    },
    select: { id: true },
  });
  assert.deepEqual(Object.keys(writes[0]!.args.data), ["delivery"]);
  assert.deepEqual(world.otherWrites(), [], "no status, counter or schedule write happens in this step");
});

test("a failing event emit does not stop the delivery or its record", async () => {
  const world = successWorld({ emitFails: true });
  await world.deps.notifySuccess!(agentRow(), success());
  world.writes();
  assert.deepEqual(world.steps, ["event", "load", "send", "record"]);
  assert.equal(world.sent.length, 1);
  assert.equal(world.writes()[0]!.args.data.delivery[0].status, "sent");
});

test("a delivery that fails is recorded as failed, in plain words, and nothing is thrown", async () => {
  const world = successWorld({ sendFails: true });
  await world.deps.notifySuccess!(agentRow(), success());

  assert.equal(world.events.length, 1, "the event still went out");
  const [record] = world.writes()[0]!.args.data.delivery;
  assert.equal(record.status, "failed");
  assert.equal(record.name, "Team Slack");
  assert.doesNotMatch(JSON.stringify(record), /hooks\.slack|secret|500/, "no link and no raw error in the record");
  assert.deepEqual(world.otherWrites(), []);
});

test("a place that was removed, or cannot be looked up, is recorded and never throws", async () => {
  const removed = successWorld({ channel: null });
  await removed.deps.notifySuccess!(agentRow(), success());
  assert.equal(removed.writes()[0]!.args.data.delivery[0].status, "skipped");
  assert.equal(removed.sent.length, 0);

  const down = successWorld({ loadFails: true });
  await down.deps.notifySuccess!(agentRow(), success());
  assert.equal(down.writes()[0]!.args.data.delivery[0].status, "failed");
});

test("a failing record write is dropped: the hook still returns", async () => {
  const world = successWorld({ deliveryWriteFails: true });
  await world.deps.notifySuccess!(agentRow(), success());
  assert.equal(world.sent.length, 1);
  assert.equal(world.writes().length, 1);
  assert.deepEqual(world.otherWrites(), []);
});

test("an empty delivery list writes nothing: a task with no place set", async () => {
  const world = successWorld();
  await world.deps.notifySuccess!(agentRow({ payload: { prompt: "summarize" } }), success());

  assert.equal(world.events.length, 1, "the event is for every finished run");
  assert.deepEqual(world.loads, [], "no place is looked up");
  assert.equal(world.sent.length, 0);
  assert.deepEqual(world.writes(), [], "the delivery column stays null");
  assert.deepEqual(world.otherWrites(), []);
});

test("a report task is never sent by this step, even when it names a place", async () => {
  const world = successWorld();
  await world.deps.notifySuccess!(
    row({ taskType: "report", payload: { period: "daily", deliver: { alertChannelId: CHANNEL_ID } } }),
    success({ output: { content: "the report text", delivered: [{ channel: "Team Slack" }] } }),
  );

  assert.deepEqual(world.loads, [], "its channel is not even looked up");
  assert.equal(world.sent.length, 0, "the report delivered itself; it is not sent twice");
  assert.deepEqual(world.writes(), []);
  // It still tells the organization's webhooks that it finished.
  assert.equal(world.events.length, 1);
  assert.equal(world.events[0]!.data.taskType, "report");
});

test("the event is emitted for every task type; only agent_run and inference deliver", async () => {
  for (const taskType of ["webhook", "data_sync", "health_check", "cleanup", "custom", "report"]) {
    const world = successWorld();
    await world.deps.notifySuccess!(
      row({ taskType, payload: { deliver: { alertChannelId: CHANNEL_ID } } }),
      success({ output: { status: 200 } }),
    );
    assert.equal(world.events.length, 1, taskType);
    assert.equal(world.events[0]!.data.taskType, taskType);
    assert.equal(world.events[0]!.data.agentId, null);
    assert.equal(world.sent.length, 0, taskType);
    assert.deepEqual(world.writes(), [], taskType);
  }
  const alias = successWorld();
  await alias.deps.notifySuccess!(agentRow({ taskType: "inference" }), success());
  assert.equal(alias.sent.length, 1);
  assert.equal(alias.writes().length, 1);
});

test("a run that produced no text still tells webhooks, and records that nothing was sent", async () => {
  const world = successWorld();
  await world.deps.notifySuccess!(agentRow(), success({ output: { content: "   ", usage: null } }));
  assert.equal(world.sent.length, 0);
  assert.equal(world.writes()[0]!.args.data.delivery[0].status, "skipped");
  assert.equal(world.events.length, 1);
});

test("the preview is the first 2,000 characters of the answer, cut as workflow.completed cuts it", () => {
  assert.equal(outputPreviewOf({ content: "short answer" }), "short answer");
  const long = outputPreviewOf({ content: "x".repeat(5000) });
  assert.equal(long, `${"x".repeat(2000)}...`);
  // A type with no answer text carries its stored output as JSON, as a workflow's does.
  assert.equal(outputPreviewOf({ status: 200 }), '{"status":200}');
  assert.equal(outputPreviewOf({ rows: "y".repeat(5000) }).length, 2003);
  assert.equal(outputPreviewOf(null), "");
  assert.equal(outputPreviewOf(undefined), "");
});

test("with no delivery wired the result is only stored; with no emitter the delivery still runs", async () => {
  const stored = successWorld({ noDelivery: true });
  await stored.deps.notifySuccess!(agentRow(), success());
  assert.equal(stored.events.length, 1);
  assert.deepEqual(stored.writes(), []);

  const quiet = successWorld({ noEmit: true });
  await quiet.deps.notifySuccess!(agentRow(), success());
  assert.equal(quiet.sent.length, 1);
  assert.equal(quiet.writes().length, 1);
});

test("the delivery deps are built on first use, once, and never for a failure", async () => {
  const world = successWorld();
  assert.equal(world.built(), 0, "building the tick's deps opens nothing");
  await world.deps.notifyFailure!(agentRow(), {
    executionId: "exec_1",
    error: "boom",
    attempts: 1,
    triggeredBy: "schedule",
  });
  assert.equal(world.built(), 0);
  assert.equal(world.sent.length, 0, "a failed run is never delivered");
  await world.deps.notifySuccess!(agentRow(), success());
  await world.deps.notifySuccess!(agentRow(), success({ executionId: "exec_8" }));
  assert.equal(world.built(), 1);
});

test("through a whole firing: the finish is written first, and a delivery that fails changes nothing it wrote", async () => {
  const run = async (sendFails: boolean) => {
    const world = successWorld({ sendFails });
    const deps = {
      ...world.deps,
      executeTask: async () => ({ output: { content: "the digest", usage: null } }),
      sleep: async () => assert.fail("no backoff: nothing is retried"),
    };
    const firing = await runTaskFiring(agentRow({ maxRetries: 3 }), { triggeredBy: "schedule" }, deps);
    return { world, firing };
  };
  const ok = await run(false);
  const bad = await run(true);

  for (const { world, firing } of [ok, bad]) {
    assert.deepEqual(firing, { status: "success", executionId: "exec_1", attempts: 1 });
    const writes = world.calls.filter((c) => ["create", "update", "updateMany"].includes(c.op));
    assert.deepEqual(
      writes.map((c) => `${c.model}.${c.op}`),
      ["taskExecution.create", "taskExecution.updateMany", "scheduledTask.update", "taskExecution.update"],
      "one execution row, one finish, the task's counters once, then the delivery column",
    );
    assert.equal(writes[1]!.args.data.status, "success");
    assert.deepEqual(writes[1]!.args.where, { id: "exec_1", status: "running" });
  }
  // What the finish and the task were given is identical whether the
  // delivery worked or not: status, counters and last-run fields.
  const finishOf = (w: typeof ok.world) =>
    w.calls
      .filter((c) => c.op === "updateMany" || (c.model === "scheduledTask" && c.op === "update"))
      .map((c) => ({ ...c.args.data, completedAt: null, lastRunAt: null, durationMs: null, lastRunDurationMs: null }));
  assert.deepEqual(finishOf(bad.world), finishOf(ok.world));
  assert.deepEqual(
    bad.world.calls.find((c) => c.model === "scheduledTask" && c.op === "update")!.args.data.successfulRuns,
    { increment: 1 },
  );
  assert.equal("failedRuns" in bad.world.calls.find((c) => c.model === "scheduledTask" && c.op === "update")!.args.data, false);
  assert.equal(bad.world.calls.find((c) => c.model === "taskExecution" && c.op === "update")!.args.data.delivery[0].status, "failed");
});

test("scheduled_task.completed is an event an organization can subscribe to", async () => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  const { WEBHOOK_EVENTS } = await import("../services/webhooks.js");
  assert.ok((WEBHOOK_EVENTS as string[]).includes("scheduled_task.completed"));
  assert.ok((WEBHOOK_EVENTS as string[]).includes("scheduled_task.failed"), "the failure event stays");
});
