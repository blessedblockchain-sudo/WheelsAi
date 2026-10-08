/**
 * "Run now" started twice at the same moment runs once.
 *
 * triggerTask (services/scheduler.ts) reads "is one running" and then
 * starts a run. Done as two separate steps, two requests that arrive
 * together both read "none" and both run: two model calls, two charges on a
 * buyer's copy, two deliveries. So the task's row is locked, and the read
 * and the creation of the execution row happen under that lock in one
 * transaction; the firing is handed the row that was made.
 *
 * The stand-in below models exactly that much of Postgres: a row lock taken
 * by SELECT ... FOR UPDATE is held until its transaction ends, and a second
 * transaction asking for it waits. Without the lock nothing waits, and the
 * stand-in lets both requests through, as the database would.
 *
 * Hermetic: the global prisma's delegates are replaced for each test, and
 * the firing's executor is a counter.
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prisma } from "@wheelsai/db";

import { runAgentScheduleNow, AgentScheduleError } from "../services/agentSchedule.js";
import { buildAgentScheduleDeps } from "../services/buildAgentScheduleDeps.js";
import type { TaskFiringDeps } from "../services/runSchedulerTick.js";
import { SchedulerError, triggerTask } from "../services/scheduler.js";

const ORG = "0f1e2d3c-4b5a-4968-8776-655443322110";
const OTHER_ORG = "0f1e2d3c-4b5a-4968-8776-000000000000";
const AGENT = "11111111-2222-4333-8444-555555555555";
const TASK = "aaaaaaaa-2222-4333-8444-555555555555";

type Row = Record<string, any>;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function world() {
  const state = {
    tasks: [
      {
        id: TASK,
        orgId: ORG,
        agentId: AGENT,
        orchestrationId: null,
        name: "Morning Brief (schedule)",
        taskType: "agent_run",
        payload: { prompt: "Brief me." },
        timeout: 300_000,
        maxRetries: 1,
        scheduleType: "cron",
        cronExpression: "0 9 * * *",
        intervalSeconds: null,
        scheduledAt: null,
        timezone: "UTC",
        nextRunAt: new Date("2026-10-07T09:00:00Z"),
        isEnabled: true,
        status: "active",
        lastRunAt: null,
        lastRunStatus: null,
        createdAt: new Date("2026-10-01T00:00:00Z"),
      },
    ] as Row[],
    executions: [] as Row[],
    executorCalls: 0,
    lockStatements: [] as string[],
  };
  let serial = 0;

  const scheduledTask = {
    findFirst: async ({ where }: { where: Row }) => {
      await tick();
      return state.tasks.find((t) => t.id === where.id && t.orgId === where.orgId) ?? null;
    },
    findMany: async ({ where }: { where: Row }) =>
      state.tasks.filter(
        (t) => t.orgId === where.orgId && t.agentId === where.agentId && (!where.taskType || t.taskType === where.taskType),
      ),
    count: async ({ where }: { where: Row }) =>
      state.tasks.filter((t) => t.orgId === where.orgId && t.agentId === where.agentId).length,
  };
  const taskExecution = {
    findFirst: async ({ where }: { where: Row }) => {
      await tick();
      return (
        state.executions.find(
          (e) =>
            (where.id === undefined || e.id === where.id) &&
            (where.taskId === undefined || e.taskId === where.taskId) &&
            (where.status === undefined || e.status === where.status),
        ) ?? null
      );
    },
    create: async ({ data }: { data: Row }) => {
      await tick();
      serial += 1;
      const row = {
        id: `bbbbbbbb-0000-4000-8000-${String(serial).padStart(12, "0")}`,
        completedAt: null,
        durationMs: null,
        output: null,
        error: null,
        delivery: null,
        createdAt: new Date(),
        ...data,
      };
      state.executions.push(row);
      return row;
    },
  };

  // One row lock per task: held from the FOR UPDATE to the end of its transaction.
  const held = new Map<string, Promise<void>>();
  const $transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    const releases: Array<() => void> = [];
    const tx = {
      scheduledTask,
      taskExecution,
      $queryRaw: async (query: { strings?: readonly string[]; sql?: string; values?: unknown[] }) => {
        const text = query.sql ?? (query.strings ?? []).join("?");
        state.lockStatements.push(text);
        const values = query.values ?? [];
        const row = state.tasks.find((t) => values.includes(t.id) && values.includes(t.orgId));
        if (!row) return [];
        if (/FOR UPDATE/.test(text)) {
          while (held.has(row.id)) await held.get(row.id);
          let release!: () => void;
          held.set(
            row.id,
            new Promise<void>((resolve) => {
              release = resolve;
            }),
          );
          releases.push(() => {
            held.delete(row.id);
            release();
          });
        }
        return [{ id: row.id }];
      },
    };
    try {
      return await fn(tx);
    } finally {
      for (const release of releases) release();
    }
  };

  /** The firing as the worker has it, with a counter where the model call is. */
  const firing = (): TaskFiringDeps => ({
    createExecution: async (task, { now, attempt, triggeredBy }) =>
      taskExecution.create({
        data: { taskId: task.id, status: "running", input: task.payload, triggeredBy, attempt, startedAt: now },
      }),
    executeTask: async () => {
      state.executorCalls += 1;
      await tick();
      await tick();
      return { output: { content: "Today's briefing." } };
    },
    finishExecution: async (executionId, _task, outcome) => {
      const row = state.executions.find((e) => e.id === executionId && e.status === "running");
      if (!row) return false;
      Object.assign(row, { status: outcome.status, completedAt: new Date(), durationMs: outcome.durationMs });
      if (outcome.output !== undefined) row.output = outcome.output;
      return true;
    },
  });

  const fake = {
    scheduledTask,
    taskExecution,
    $transaction,
    agent: {
      findFirst: async ({ where }: { where: Row }) =>
        where.id === AGENT && where.orgId === ORG ? { id: AGENT, name: "Morning Brief", kindConfig: null } : null,
    },
  };
  return { state, fake, firing };
}

async function withPrisma<T>(fake: Row, fn: () => Promise<T>): Promise<T> {
  const names = ["scheduledTask", "taskExecution", "$transaction"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, (prisma as any)[name]]));
  for (const name of names) (prisma as any)[name] = fake[name];
  try {
    return await fn();
  } finally {
    for (const name of names) (prisma as any)[name] = saved[name];
  }
}

test("two run now at the same moment: one execution row, one executor call, one already_running", async () => {
  const { state, fake, firing } = world();
  const settled = await withPrisma(fake, () =>
    Promise.allSettled([triggerTask(TASK, ORG, firing), triggerTask(TASK, ORG, firing)]),
  );

  assert.equal(state.executions.length, 1, "one execution row");
  assert.equal(state.executorCalls, 1, "the executor ran once");
  const won = settled.filter((s) => s.status === "fulfilled") as Array<PromiseFulfilledResult<Row>>;
  const lost = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.equal(won[0]!.value.execution.id, state.executions[0]!.id);
  assert.equal(won[0]!.value.execution.status, "success");
  assert.equal(won[0]!.value.execution.triggeredBy, "manual");
  assert.equal(won[0]!.value.deferred, false);
  assert.ok(lost[0]!.reason instanceof SchedulerError);
  assert.equal(lost[0]!.reason.status, 409);
  assert.equal(lost[0]!.reason.code, "already_running");
  assert.equal(lost[0]!.reason.extra.executionId, state.executions[0]!.id);
});

test("a run now on its own still runs, and again once the first has finished", async () => {
  const { state, fake, firing } = world();
  await withPrisma(fake, async () => {
    const first = await triggerTask(TASK, ORG, firing);
    assert.equal(first.execution.status, "success");
    // The row was made as the firing makes it: running, manual, attempt 1, the payload as input.
    assert.equal(first.execution.attempt, 1);
    assert.deepEqual(first.execution.input, { prompt: "Brief me." });
    assert.ok(first.execution.startedAt instanceof Date);
    const second = await triggerTask(TASK, ORG, firing);
    assert.notEqual(second.execution.id, first.execution.id);
  });
  assert.equal(state.executions.length, 2);
  assert.equal(state.executorCalls, 2);
});

test("another organization's task is not found, and nothing is locked for long or created", async () => {
  const { state, fake, firing } = world();
  await withPrisma(fake, async () => {
    await assert.rejects(triggerTask(TASK, OTHER_ORG, firing), (err: unknown) => {
      assert.ok(err instanceof SchedulerError);
      assert.equal(err.status, 404);
      assert.equal(err.code, "not_found");
      return true;
    });
    // The refusal released whatever it held: the owner's run goes through.
    assert.equal((await triggerTask(TASK, ORG, firing)).execution.status, "success");
  });
  assert.equal(state.executions.length, 1);
  assert.equal(state.executorCalls, 1);
});

test("two Run now on an agent's own schedule at once: the agent runs once and one answers 409 already_running", async () => {
  const { state, fake, firing } = world();
  const deps = buildAgentScheduleDeps({
    prisma: fake as never,
    scheduler: async () => ({
      triggerTask: (taskId, orgId) => triggerTask(taskId, orgId, firing),
      getTaskTypes: () => ({ schedulerEnabled: true }),
    }),
    emailConfigured: () => true,
  });
  const settled = await withPrisma(fake, () =>
    Promise.allSettled([runAgentScheduleNow(deps, ORG, AGENT), runAgentScheduleNow(deps, ORG, AGENT)]),
  );

  assert.equal(state.executorCalls, 1, "the agent ran once");
  assert.equal(state.executions.length, 1);
  const won = settled.filter((s) => s.status === "fulfilled") as Array<PromiseFulfilledResult<Row>>;
  const lost = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
  assert.equal(won.length, 1);
  assert.equal(won[0]!.value.run.status, "finished");
  assert.equal(won[0]!.value.run.startedBy, "person");
  assert.equal(won[0]!.value.run.text, "Today's briefing.");
  assert.equal(lost.length, 1);
  assert.ok(lost[0]!.reason instanceof AgentScheduleError);
  assert.equal(lost[0]!.reason.status, 409);
  assert.equal(lost[0]!.reason.code, "already_running");
  assert.equal(lost[0]!.reason.message, "This agent is already running. Wait for it to finish.");
});

test("the lock, the read and the row are one transaction, ahead of the firing", () => {
  const service = readFileSync(new URL("../services/scheduler.ts", import.meta.url), "utf8");
  const body = service.slice(service.indexOf("export async function triggerTask"), service.indexOf("export async function getTaskExecutions"));
  const opened = body.indexOf("prisma.$transaction(");
  const lock = body.indexOf("FOR UPDATE");
  const read = body.indexOf('tx.taskExecution.findFirst(');
  const made = body.indexOf("tx.taskExecution.create(");
  const fired = body.indexOf("await runTaskFiring(");
  assert.ok(opened > 0, "a transaction is opened");
  assert.ok(lock > opened, "the task's row is locked inside it");
  assert.match(body, /FROM "scheduled_tasks"[\s\S]*"org_id" = \$\{orgId\}::uuid[\s\S]*FOR UPDATE/);
  assert.ok(read > lock, "is one running is read under the lock");
  assert.ok(made > read, "the execution row is created under the lock");
  assert.ok(fired > made, "the firing starts after the transaction");
  // Nothing outside the transaction reads "is one running".
  assert.doesNotMatch(body, /[^x]\.taskExecution\.findFirst\(\{\s*where: \{ taskId: id, status: "running" \}/);
});
