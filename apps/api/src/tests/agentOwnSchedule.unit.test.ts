/**
 * services/agentOwnSchedule.ts: the reads and writes that make "an agent
 * owns its schedule".
 *
 * The database is an in-memory stand-in that applies the same `where` the
 * service sends and holds the unique index the real one has (one task name
 * per organization), so "only that agent's tasks in that organization" and
 * the compare-and-set are tested as the queries, not as a mock's return
 * value. Every write is recorded, so "refused before any write" is counted.
 */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";

import { DEFAULT_RUN_LINE } from "@wheelsai/shared/agent-kind";

import {
  OWN_SCHEDULE_MESSAGES,
  OwnScheduleError,
  answerTextOf,
  checkOwnSchedule,
  createOwnSchedule,
  findOwnSchedule,
  isScheduleNameConflict,
  latestOwnResults,
  ownScheduleName,
  pauseAgentSchedules,
  setOwnScheduleEnabled,
  updateOwnSchedule,
  type OwnScheduleDb,
  type OwnScheduleRow,
} from "../services/agentOwnSchedule.js";

const ORG = "org-owner";
const OTHER_ORG = "org-other";
const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "66666666-6666-4666-8666-666666666666";
const FOREIGN_CHANNEL = "99999999-9999-4999-8999-999999999999";
// A Tuesday, 12:00 UTC.
const NOW = new Date("2026-10-06T12:00:00Z");

interface StoredTask extends OwnScheduleRow {
  orgId: string;
  agentId: string | null;
  taskType: string;
  createdAt: Date;
}
interface StoredExecution {
  id: string;
  taskId: string;
  status: string;
  completedAt: Date | null;
  createdAt: Date;
  input: unknown;
  output: unknown;
  error: string | null;
  delivery: unknown;
}

const unique = () =>
  Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target: ["org_id", "name"] } });

let serial = 0;
function task(over: Partial<StoredTask> = {}): StoredTask {
  serial += 1;
  return {
    id: `task-${String(serial).padStart(3, "0")}`,
    orgId: ORG,
    agentId: AGENT,
    name: `Task ${serial}`,
    taskType: "agent_run",
    isEnabled: true,
    status: "active",
    scheduleType: "cron",
    cronExpression: "0 9 * * *",
    intervalSeconds: null,
    scheduledAt: null,
    timezone: "UTC",
    payload: { prompt: "Brief me." },
    timeout: 300_000,
    maxRetries: 3,
    nextRunAt: new Date("2026-10-07T09:00:00Z"),
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    ...over,
  };
}

function fakeDb(seed: { tasks?: StoredTask[]; executions?: StoredExecution[]; channels?: Array<{ id: string; orgId: string; type: string }> } = {}) {
  const state = {
    tasks: seed.tasks ?? [],
    executions: seed.executions ?? [],
    channels: seed.channels ?? [
      { id: CHANNEL, orgId: ORG, type: "slack" },
      { id: FOREIGN_CHANNEL, orgId: OTHER_ORG, type: "slack" },
    ],
  };
  const writes: Array<{ op: string; args: unknown }> = [];
  const hooks: { beforeUpdate?: () => void } = {};

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, wanted]) => {
      if (wanted === undefined) return true;
      const actual = row[key];
      if (typeof wanted === "object" && wanted !== null && !(wanted instanceof Date)) {
        const filter = wanted as Record<string, unknown>;
        if ("startsWith" in filter) return typeof actual === "string" && actual.startsWith(filter.startsWith as string);
        if ("equals" in filter) return isDeepStrictEqual(actual, filter.equals);
        if ("not" in filter) return actual !== filter.not;
        throw new Error(`the stand-in does not know the filter on ${key}`);
      }
      return actual === wanted;
    });

  const db: OwnScheduleDb = {
    scheduledTask: {
      findMany: async (args) => {
        let rows = state.tasks.filter((t) => matches(t as unknown as Record<string, unknown>, args.where));
        if (args.orderBy) {
          rows = [...rows].sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          );
        }
        return rows.slice(0, args.take ?? rows.length).map((t) => ({ ...t }));
      },
      count: async (args) => state.tasks.filter((t) => matches(t as unknown as Record<string, unknown>, args.where)).length,
      create: async (args) => {
        writes.push({ op: "create", args });
        if (state.tasks.some((t) => t.orgId === args.data.orgId && t.name === args.data.name)) throw unique();
        const row = task({
          ...args.data,
          intervalSeconds: null,
          scheduledAt: null,
          lastRunAt: null,
          lastRunStatus: null,
          createdAt: new Date(NOW),
        });
        state.tasks.push(row);
        return { ...row };
      },
      updateMany: async (args) => {
        hooks.beforeUpdate?.();
        hooks.beforeUpdate = undefined;
        writes.push({ op: "updateMany", args });
        const hit = state.tasks.filter((t) => matches(t as unknown as Record<string, unknown>, args.where));
        for (const row of hit) Object.assign(row, args.data);
        return { count: hit.length };
      },
    },
    alertChannel: {
      findFirst: async (args) => {
        const found = state.channels.find((c) => c.id === args.where.id && c.orgId === args.where.orgId);
        return found ? { type: found.type } : null;
      },
    },
    taskExecution: {
      findMany: async (args) => {
        // The select is honoured: a column that was not asked for cannot leak.
        assert.deepEqual(args.select, { completedAt: true, output: true });
        const { task: taskWhere, ...where } = args.where;
        return state.executions
          .filter((e) => matches(e as unknown as Record<string, unknown>, where))
          .filter((e) => state.tasks.some((t) => t.id === e.taskId && t.orgId === taskWhere.orgId && t.agentId === taskWhere.agentId))
          .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))
          .slice(0, args.take)
          .map((e) => ({ completedAt: e.completedAt, output: e.output }));
      },
    },
  };
  return { db, state, writes, hooks };
}

async function refused(run: Promise<unknown>): Promise<OwnScheduleError> {
  try {
    await run;
  } catch (err) {
    assert.ok(err instanceof OwnScheduleError, String(err));
    return err;
  }
  assert.fail("expected a refusal");
}

const create = (over: Record<string, unknown> = {}) => ({
  orgId: ORG,
  agentId: AGENT,
  agentName: "Daily Briefing",
  cronExpression: "0 9 * * *",
  timezone: "Europe/Berlin",
  emailConfigured: true,
  now: NOW,
  ...over,
});

// ============================================
// Finding it
// ============================================

test("the oldest agent_run task is the agent's own schedule, and the others are counted", async () => {
  const { db } = fakeDb({
    tasks: [
      task({ id: "later", createdAt: new Date("2026-10-03T00:00:00Z") }),
      task({ id: "report", taskType: "report", createdAt: new Date("2026-09-01T00:00:00Z") }),
      task({ id: "own", createdAt: new Date("2026-10-02T00:00:00Z"), payload: { prompt: "Brief me.", stampTime: true }, maxRetries: 1, timeout: 120_000 }),
      task({ id: "alias", taskType: "inference", createdAt: new Date("2026-08-01T00:00:00Z") }),
      task({ id: "another-agent", agentId: OTHER_AGENT, createdAt: new Date("2026-01-01T00:00:00Z") }),
      task({ id: "another-org", orgId: OTHER_ORG, createdAt: new Date("2026-01-01T00:00:00Z") }),
    ],
  });
  const found = await findOwnSchedule(db, { orgId: ORG, agentId: AGENT });
  assert.equal(found.otherTasks, 3, "the later agent_run, the report and the inference task; never another agent's or organization's");
  assert.deepEqual(found.schedule, {
    id: "own",
    name: found.schedule!.name,
    enabled: true,
    status: "active",
    scheduleType: "cron",
    cronExpression: "0 9 * * *",
    intervalSeconds: null,
    scheduledAt: null,
    timezone: "UTC",
    payload: { prompt: "Brief me.", stampTime: true },
    nextRunAt: new Date("2026-10-07T09:00:00Z"),
    lastRunAt: null,
    lastRunStatus: null,
    maxRetries: 1,
    timeoutMs: 120_000,
  });
});

test("two tasks created at the same instant: the lower id is the own schedule", async () => {
  const at = new Date("2026-10-02T00:00:00Z");
  const { db } = fakeDb({ tasks: [task({ id: "b", createdAt: at }), task({ id: "a", createdAt: at })] });
  assert.equal((await findOwnSchedule(db, { orgId: ORG, agentId: AGENT })).schedule!.id, "a");
});

test("an agent with no agent_run task has no own schedule; its other tasks are still counted", async () => {
  const { db } = fakeDb({ tasks: [task({ taskType: "report" }), task({ taskType: "custom" })] });
  assert.deepEqual(await findOwnSchedule(db, { orgId: ORG, agentId: AGENT }), { schedule: null, otherTasks: 2 });
  assert.deepEqual(await findOwnSchedule(db, { orgId: OTHER_ORG, agentId: AGENT }), { schedule: null, otherTasks: 0 });
});

// ============================================
// Naming it
// ============================================

test("the name is '<agent name> (schedule)', cut to 80 characters with the label kept", () => {
  assert.equal(ownScheduleName("Daily Briefing", []), "Daily Briefing (schedule)");
  assert.equal(ownScheduleName("  Daily Briefing  ", []), "Daily Briefing (schedule)");

  const long = ownScheduleName("A".repeat(100), []);
  assert.equal(long.length, 80);
  assert.equal(long, `${"A".repeat(69)} (schedule)`);

  const exact = ownScheduleName("B".repeat(69), []);
  assert.equal(exact.length, 80);
  // A cut that lands on a space leaves no double space.
  assert.equal(ownScheduleName(`${"C".repeat(68)} DDDD`, []), `${"C".repeat(68)} (schedule)`);
});

test("a taken name gets a short counting suffix, still inside 80 characters", () => {
  assert.equal(ownScheduleName("Daily Briefing", ["Daily Briefing (schedule)"]), "Daily Briefing (schedule 2)");
  assert.equal(
    ownScheduleName("Daily Briefing", ["Daily Briefing (schedule)", "Daily Briefing (schedule 2)"]),
    "Daily Briefing (schedule 3)",
  );
  // Names are compared exactly, as the unique index compares them.
  assert.equal(ownScheduleName("Daily Briefing", ["daily briefing (schedule)"]), "Daily Briefing (schedule)");

  const first = `${"A".repeat(69)} (schedule)`;
  const second = ownScheduleName("A".repeat(100), [first]);
  assert.equal(second, `${"A".repeat(67)} (schedule 2)`);
  assert.equal(second.length, 80);
});

test("create picks a free name among the organization's tasks, and another organization's names do not count", async () => {
  const { db, state } = fakeDb({
    tasks: [
      task({ name: "Daily Briefing (schedule)", agentId: OTHER_AGENT }),
      task({ name: "Daily Briefing (schedule 2)", agentId: null, taskType: "webhook" }),
    ],
  });
  assert.equal((await createOwnSchedule(db, create())).name, "Daily Briefing (schedule 3)");

  const elsewhere = fakeDb({ tasks: [task({ name: "Daily Briefing (schedule)", orgId: OTHER_ORG })] });
  assert.equal((await createOwnSchedule(elsewhere.db, create())).name, "Daily Briefing (schedule)");
  assert.equal(state.tasks.length, 3);
});

test("a lost race for the name is recognisable, so the caller can run its transaction again", async () => {
  assert.equal(isScheduleNameConflict(unique()), true);
  assert.equal(isScheduleNameConflict(Object.assign(new Error("x"), { code: "P2002" })), true);
  assert.equal(isScheduleNameConflict(Object.assign(new Error("x"), { code: "P2002", meta: { target: ["org_id", "slug"] } })), false);
  assert.equal(isScheduleNameConflict(Object.assign(new Error("x"), { code: "P2002", meta: { target: ["public_handle"] } })), false);
  assert.equal(isScheduleNameConflict(new Error("boom")), false);
  assert.equal(isScheduleNameConflict(null), false);
});

// ============================================
// Creating it
// ============================================

test("create writes a cron agent_run task: stampTime on, one retry, the next run in the task's time zone", async () => {
  const { db, state } = fakeDb();
  const made = await createOwnSchedule(db, create({ prompt: "Brief me on the news.", deliver: { alertChannelId: CHANNEL } }));
  const stored = state.tasks[0]!;
  assert.deepEqual(
    {
      orgId: stored.orgId,
      agentId: stored.agentId,
      name: stored.name,
      taskType: stored.taskType,
      scheduleType: stored.scheduleType,
      cronExpression: stored.cronExpression,
      timezone: stored.timezone,
      payload: stored.payload,
      maxRetries: stored.maxRetries,
      timeout: stored.timeout,
      isEnabled: stored.isEnabled,
      status: stored.status,
      nextRunAt: stored.nextRunAt?.toISOString(),
    },
    {
      orgId: ORG,
      agentId: AGENT,
      name: "Daily Briefing (schedule)",
      taskType: "agent_run",
      scheduleType: "cron",
      cronExpression: "0 9 * * *",
      timezone: "Europe/Berlin",
      payload: { prompt: "Brief me on the news.", stampTime: true, deliver: { alertChannelId: CHANNEL } },
      maxRetries: 1,
      timeout: 300_000,
      isEnabled: true,
      status: "active",
      // 09:00 in Berlin (UTC+2 in October) on the next day.
      nextRunAt: "2026-10-07T07:00:00.000Z",
    },
  );
  assert.deepEqual([made.id, made.enabled, made.maxRetries, made.timeoutMs], [stored.id, true, 1, 300_000]);
});

test("create without a prompt uses the default run line; a buyer's copy starts switched off", async () => {
  const { db, state } = fakeDb();
  const made = await createOwnSchedule(db, create({ prompt: "   ", enabled: false, timezone: undefined, createdBy: "user-1" }));
  assert.deepEqual(state.tasks[0]!.payload, { prompt: DEFAULT_RUN_LINE, stampTime: true });
  assert.deepEqual([made.enabled, made.status, made.timezone], [false, "paused", "UTC"]);
  assert.ok(made.nextRunAt, "the next run is known while it is off, so the page can say when it would run");
  assert.equal("createdBy" in state.tasks[0]!, false, "there is no column for it");
});

test("create refuses a bad cron or time zone before any write", async () => {
  const cases: Array<[Record<string, unknown>, string, string, string]> = [
    [{ cronExpression: "nope" }, "invalid_cron", "cronExpression", OWN_SCHEDULE_MESSAGES.invalidCron],
    [{ cronExpression: "* * * * * *" }, "invalid_cron", "cronExpression", OWN_SCHEDULE_MESSAGES.invalidCron],
    [{ cronExpression: "" }, "missing_field", "cronExpression", OWN_SCHEDULE_MESSAGES.invalidCron],
    [{ timezone: "Mars/Olympus" }, "invalid_timezone", "timezone", OWN_SCHEDULE_MESSAGES.invalidTimezone],
    [{ timezone: "+02:00" }, "invalid_timezone", "timezone", OWN_SCHEDULE_MESSAGES.invalidTimezone],
  ];
  for (const [over, reason, field, message] of cases) {
    const { db, writes, state } = fakeDb();
    const err = await refused(createOwnSchedule(db, create(over)));
    assert.deepEqual([err.status, err.code, err.extra.reason, err.extra.field, err.message], [400, "invalid_schedule", reason, field, message]);
    assert.equal(writes.length, 0, JSON.stringify(over));
    assert.equal(state.tasks.length, 0);

    // The same answer from the pure check the create route runs before its transaction.
    const checked = checkOwnSchedule({ cronExpression: "0 9 * * *", timezone: "UTC", ...over } as never, NOW);
    assert.equal(checked.ok, false);
    assert.equal((checked as { error: OwnScheduleError }).error.extra.reason, reason);
  }
});

test("the pure check accepts a good schedule and says what would be stored", () => {
  const checked = checkOwnSchedule({ cronExpression: " 0 16 * * 5 ", timezone: "UTC", prompt: "Go.", stampTime: false }, NOW);
  assert.deepEqual(checked, {
    ok: true,
    cronExpression: "0 16 * * 5",
    timezone: "UTC",
    nextRunAt: new Date("2026-10-09T16:00:00.000Z"),
    payload: { prompt: "Go.", stampTime: false },
    timeout: 300_000,
    maxRetries: 1,
  });
  const limits = checkOwnSchedule({ cronExpression: "0 9 * * *", timeoutSeconds: 60, maxRetries: 0 }, NOW);
  assert.deepEqual([limits.ok && limits.timeout, limits.ok && limits.maxRetries], [60_000, 0]);
});

test("create refuses a place that is not this organization's, an unusable one, and limits out of range, before any write", async () => {
  const cases: Array<[Record<string, unknown>, Parameters<typeof fakeDb>[0], string, string]> = [
    [{ deliver: { alertChannelId: FOREIGN_CHANNEL } }, {}, "deliver.alertChannelId", OWN_SCHEDULE_MESSAGES.placeNotFound],
    [{ deliver: { alertChannelId: "not-an-id" } }, {}, "deliver.alertChannelId", OWN_SCHEDULE_MESSAGES.placeNotFound],
    [
      { deliver: { alertChannelId: CHANNEL }, emailConfigured: false },
      { channels: [{ id: CHANNEL, orgId: ORG, type: "email" }] },
      "deliver.alertChannelId",
      OWN_SCHEDULE_MESSAGES.emailOff,
    ],
    [
      { deliver: { alertChannelId: CHANNEL } },
      { channels: [{ id: CHANNEL, orgId: ORG, type: "pagerduty" }] },
      "deliver.alertChannelId",
      OWN_SCHEDULE_MESSAGES.placeUnsupported,
    ],
    [{ prompt: "x".repeat(20_001) }, {}, "prompt", OWN_SCHEDULE_MESSAGES.prompt],
    [{ timeoutSeconds: 4 }, {}, "timeoutSeconds", OWN_SCHEDULE_MESSAGES.timeout],
    [{ timeoutSeconds: 3601 }, {}, "timeoutSeconds", OWN_SCHEDULE_MESSAGES.timeout],
    [{ maxRetries: 6 }, {}, "maxRetries", OWN_SCHEDULE_MESSAGES.retries],
    [{ maxRetries: 1.5 }, {}, "maxRetries", OWN_SCHEDULE_MESSAGES.retries],
  ];
  for (const [over, seed, field, message] of cases) {
    const { db, writes } = fakeDb(seed);
    const err = await refused(createOwnSchedule(db, create(over)));
    assert.deepEqual([err.status, err.code, err.message], [400, "validation_failed", message], JSON.stringify(over));
    assert.deepEqual(err.body?.fields, { [field]: message });
    assert.equal(writes.length, 0, JSON.stringify(over));
  }
  // An email place is fine while email works; no place asks nothing.
  const email = fakeDb({ channels: [{ id: CHANNEL, orgId: ORG, type: "email" }] });
  await createOwnSchedule(email.db, create({ deliver: { alertChannelId: CHANNEL } }));
  const none = fakeDb({ channels: [] });
  assert.deepEqual((await createOwnSchedule(none.db, create({ deliver: null }))).payload, { prompt: DEFAULT_RUN_LINE, stampTime: true });
});

// ============================================
// Changing it
// ============================================

async function seeded(over: Partial<StoredTask> = {}) {
  const world = fakeDb({ tasks: [task({ id: "own", name: "Daily Briefing (schedule)", maxRetries: 1, ...over })] });
  const { schedule } = await findOwnSchedule(world.db, { orgId: ORG, agentId: AGENT });
  return { ...world, expected: schedule! };
}
const update = (expected: NonNullable<Awaited<ReturnType<typeof findOwnSchedule>>["schedule"]>, changes: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  orgId: ORG,
  agentId: AGENT,
  expected,
  changes,
  emailConfigured: true,
  now: NOW,
  ...over,
});

test("update writes every field the schedule route takes, and computes the next run again when the times change", async () => {
  const { db, state, expected } = await seeded();
  const after = await updateOwnSchedule(
    db,
    update(expected, {
      cronExpression: "30 8 * * 1-5",
      timezone: "Europe/Berlin",
      prompt: "Weekday briefing.",
      stampTime: true,
      deliver: { alertChannelId: CHANNEL },
      timeoutSeconds: 120,
      maxRetries: 0,
    }),
  );
  const stored = state.tasks[0]!;
  assert.deepEqual(
    [stored.cronExpression, stored.timezone, stored.timeout, stored.maxRetries, stored.isEnabled, stored.status],
    ["30 8 * * 1-5", "Europe/Berlin", 120_000, 0, true, "active"],
  );
  assert.deepEqual(stored.payload, { prompt: "Weekday briefing.", stampTime: true, deliver: { alertChannelId: CHANNEL } });
  assert.equal(stored.nextRunAt?.toISOString(), "2026-10-07T06:30:00.000Z");
  assert.deepEqual([after.id, after.cronExpression, after.timeoutMs, after.maxRetries], ["own", "30 8 * * 1-5", 120_000, 0]);
});

test("update keeps what it was not given, and null clears the place", async () => {
  const { db, state, expected } = await seeded({
    payload: { prompt: "Brief me.", stampTime: true, deliver: { alertChannelId: CHANNEL } },
  });
  const before = state.tasks[0]!.nextRunAt;
  await updateOwnSchedule(db, update(expected, { prompt: "New line." }));
  assert.deepEqual(state.tasks[0]!.payload, { prompt: "New line.", stampTime: true, deliver: { alertChannelId: CHANNEL } });
  assert.equal(state.tasks[0]!.nextRunAt, before, "the times did not change, so the next run is left alone");
  assert.equal(state.tasks[0]!.status, "active");

  const again = (await findOwnSchedule(db, { orgId: ORG, agentId: AGENT })).schedule!;
  await updateOwnSchedule(db, update(again, { deliver: null, stampTime: false }));
  assert.deepEqual(state.tasks[0]!.payload, { prompt: "New line.", stampTime: false });
});

test("update is a compare-and-set: a schedule changed since it was read is a 409 and nothing is written", async () => {
  const edits: Array<Partial<StoredTask>> = [
    { isEnabled: false },
    { cronExpression: "0 10 * * *" },
    { timezone: "Europe/Berlin" },
    { payload: { prompt: "Someone else's line." } },
    { timeout: 60_000 },
    { maxRetries: 2 },
  ];
  for (const edit of edits) {
    const { db, state, hooks, expected } = await seeded();
    hooks.beforeUpdate = () => Object.assign(state.tasks[0]!, edit);
    const err = await refused(updateOwnSchedule(db, update(expected, { prompt: "Mine." })));
    assert.deepEqual([err.status, err.code, err.message], [409, "schedule_changed", OWN_SCHEDULE_MESSAGES.changed]);
    assert.notDeepEqual(state.tasks[0]!.payload, { prompt: "Mine." }, JSON.stringify(edit));
  }
});

test("update: the worker's own bookkeeping is not a conflict, and another agent's or organization's row is never written", async () => {
  const { db, state, hooks, expected } = await seeded();
  hooks.beforeUpdate = () =>
    Object.assign(state.tasks[0]!, { nextRunAt: new Date("2026-10-08T09:00:00Z"), lastRunAt: NOW, lastRunStatus: "success" });
  await updateOwnSchedule(db, update(expected, { prompt: "Mine." }));
  assert.deepEqual(state.tasks[0]!.payload, { prompt: "Mine." });

  for (const scope of [{ orgId: OTHER_ORG }, { agentId: OTHER_AGENT }]) {
    const world = await seeded();
    const err = await refused(updateOwnSchedule(world.db, update(world.expected, { prompt: "Not mine." }, scope)));
    assert.equal(err.code, "schedule_changed");
    assert.deepEqual(world.state.tasks[0]!.payload, { prompt: "Brief me." });
  }
});

test("update refuses bad times, a bad place and bad limits before any write", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ cronExpression: "every day" }, "invalid_schedule"],
    [{ timezone: "Nowhere/Land" }, "invalid_schedule"],
    [{ deliver: { alertChannelId: FOREIGN_CHANNEL } }, "validation_failed"],
    [{ prompt: "x".repeat(20_001) }, "validation_failed"],
    [{ timeoutSeconds: 0 }, "validation_failed"],
    [{ maxRetries: -1 }, "validation_failed"],
  ];
  for (const [changes, code] of cases) {
    const { db, writes, expected } = await seeded();
    const err = await refused(updateOwnSchedule(db, update(expected, changes)));
    assert.deepEqual([err.status, err.code], [400, code], JSON.stringify(changes));
    assert.equal(writes.length, 0, JSON.stringify(changes));
  }
});

test("update: off pauses; on again runs at the next time, not at once for a time that passed while it was off", async () => {
  const { db, state, expected } = await seeded();
  const off = await updateOwnSchedule(db, update(expected, { enabled: false }));
  assert.deepEqual([state.tasks[0]!.isEnabled, state.tasks[0]!.status, off.enabled], [false, "paused", false]);

  // A week passes with the schedule off: its stored next run is long gone.
  const later = new Date("2026-10-13T12:00:00Z");
  const on = await updateOwnSchedule(db, update(off, { enabled: true }, { now: later }));
  assert.deepEqual([on.enabled, on.status, on.nextRunAt?.toISOString()], [true, "active", "2026-10-14T09:00:00.000Z"]);
});

test("update: an older one-off task whose time has passed cannot be turned on without new times, and new times make it a cron task", async () => {
  const past = { scheduleType: "once", cronExpression: null, scheduledAt: new Date("2026-01-01T00:00:00Z"), isEnabled: false, status: "completed", nextRunAt: null };
  const first = await seeded(past);
  const err = await refused(updateOwnSchedule(first.db, update(first.expected, { enabled: true })));
  assert.deepEqual([err.code, err.extra.reason, err.message], ["invalid_schedule", "no_next_run", OWN_SCHEDULE_MESSAGES.noNextRun]);
  assert.equal(first.writes.length, 0);

  const second = await seeded(past);
  const after = await updateOwnSchedule(second.db, update(second.expected, { enabled: true, cronExpression: "0 9 * * *" }));
  assert.deepEqual(
    [after.scheduleType, after.cronExpression, after.scheduledAt, after.status, after.enabled, after.nextRunAt?.toISOString()],
    ["cron", "0 9 * * *", null, "active", true, "2026-10-07T09:00:00.000Z"],
  );
});

// ============================================
// Switching off
// ============================================

test("setOwnScheduleEnabled is a compare-and-set on the own schedule; not changing is not an error", async () => {
  const { db, state, hooks } = fakeDb({
    tasks: [
      task({ id: "own", createdAt: new Date("2026-10-01T00:00:00Z") }),
      task({ id: "second", createdAt: new Date("2026-10-02T00:00:00Z") }),
      task({ id: "report", taskType: "report", createdAt: new Date("2026-09-01T00:00:00Z") }),
    ],
  });
  assert.deepEqual(await setOwnScheduleEnabled(db, { orgId: ORG, agentId: AGENT, enabled: false }), { changed: true, taskId: "own" });
  const by = (id: string) => state.tasks.find((t) => t.id === id)!;
  assert.deepEqual([by("own").isEnabled, by("own").status], [false, "paused"]);
  assert.deepEqual([by("second").isEnabled, by("report").isEnabled], [true, true], "only the own schedule");

  assert.deepEqual(await setOwnScheduleEnabled(db, { orgId: ORG, agentId: AGENT, enabled: false }), { changed: false, taskId: "own" });
  assert.deepEqual(await setOwnScheduleEnabled(db, { orgId: ORG, agentId: OTHER_AGENT, enabled: false }), { changed: false, taskId: null });
  assert.deepEqual(await setOwnScheduleEnabled(db, { orgId: OTHER_ORG, agentId: AGENT, enabled: false }), { changed: false, taskId: null });

  // Turning it on computes the next run from now.
  const on = await setOwnScheduleEnabled(db, { orgId: ORG, agentId: AGENT, enabled: true, now: new Date("2026-10-20T12:00:00Z") });
  assert.deepEqual([on.changed, by("own").status, by("own").nextRunAt?.toISOString()], [true, "active", "2026-10-21T09:00:00.000Z"]);

  // Another request switched it off between the read and the write.
  hooks.beforeUpdate = () => Object.assign(by("own"), { isEnabled: false, status: "paused" });
  assert.deepEqual(await setOwnScheduleEnabled(db, { orgId: ORG, agentId: AGENT, enabled: false }), { changed: false, taskId: "own" });
});

test("pauseAgentSchedules switches off every task of that agent in that organization, and no other", async () => {
  const { db, state } = fakeDb({
    tasks: [
      task({ id: "own" }),
      task({ id: "report", taskType: "report" }),
      task({ id: "already-off", isEnabled: false, status: "paused" }),
      task({ id: "another-agent", agentId: OTHER_AGENT }),
      task({ id: "another-org", orgId: OTHER_ORG }),
      task({ id: "no-agent", agentId: null, taskType: "webhook" }),
    ],
  });
  assert.equal(await pauseAgentSchedules(db, { orgId: ORG, agentId: AGENT }), 2);
  assert.deepEqual(
    Object.fromEntries(state.tasks.map((t) => [t.id, [t.isEnabled, t.status]])),
    {
      own: [false, "paused"],
      report: [false, "paused"],
      "already-off": [false, "paused"],
      "another-agent": [true, "active"],
      "another-org": [true, "active"],
      "no-agent": [true, "active"],
    },
  );
  assert.equal(await pauseAgentSchedules(db, { orgId: ORG, agentId: AGENT }), 0);
  assert.equal(state.tasks.length, 6, "the tasks stay");
});

// ============================================
// Results
// ============================================

function execution(over: Partial<StoredExecution>): StoredExecution {
  serial += 1;
  return {
    id: `execution-${serial}`,
    taskId: "own",
    status: "success",
    completedAt: new Date("2026-10-05T09:00:10Z"),
    createdAt: new Date("2026-10-05T09:00:00Z"),
    input: { prompt: "SECRET PROMPT", deliver: { alertChannelId: CHANNEL } },
    output: { content: "An answer.", usage: { totalTokens: 12 } },
    error: null,
    delivery: [{ channelId: CHANNEL, name: "Team Slack", type: "slack", status: "sent", at: "2026-10-05T09:00:11Z" }],
    ...over,
  };
}

test("latestOwnResults returns only successful runs of the own schedule, newest first, and only the answer text", async () => {
  const { db } = fakeDb({
    tasks: [
      task({ id: "own", createdAt: new Date("2026-10-01T00:00:00Z") }),
      task({ id: "second", createdAt: new Date("2026-10-02T00:00:00Z") }),
      task({ id: "another-org", orgId: OTHER_ORG, createdAt: new Date("2026-09-01T00:00:00Z") }),
    ],
    executions: [
      execution({ completedAt: new Date("2026-10-03T09:00:10Z"), output: { content: "Friday's answer." } }),
      execution({ completedAt: new Date("2026-10-05T09:00:10Z"), output: { content: "Sunday's answer." } }),
      execution({ completedAt: new Date("2026-10-04T09:00:10Z"), output: { content: "Saturday's answer." } }),
      execution({ completedAt: new Date("2026-10-02T09:00:10Z"), output: { content: "Thursday's answer." } }),
      execution({ status: "failed", completedAt: new Date("2026-10-06T09:00:10Z"), output: { content: "HALF AN ANSWER" }, error: "FAILURE REASON" }),
      execution({ status: "running", completedAt: null, output: null }),
      execution({ status: "cancelled", completedAt: new Date("2026-10-06T10:00:00Z"), error: "cancelled" }),
      execution({ taskId: "second", completedAt: new Date("2026-10-06T11:00:00Z"), output: { content: "ANOTHER TASK" } }),
      execution({ taskId: "another-org", completedAt: new Date("2026-10-06T11:30:00Z"), output: { content: "ANOTHER ORG" } }),
    ],
  });
  const results = await latestOwnResults(db, { orgId: ORG, agentId: AGENT, limit: 3, maxChars: 8000 });
  assert.deepEqual(results, [
    { finishedAt: new Date("2026-10-05T09:00:10Z"), text: "Sunday's answer." },
    { finishedAt: new Date("2026-10-04T09:00:10Z"), text: "Saturday's answer." },
    { finishedAt: new Date("2026-10-03T09:00:10Z"), text: "Friday's answer." },
  ]);
  for (const result of results) assert.deepEqual(Object.keys(result), ["finishedAt", "text"]);
  assert.doesNotMatch(
    JSON.stringify(results),
    /SECRET PROMPT|FAILURE REASON|HALF AN ANSWER|ANOTHER|Team Slack|own|execution-|usage|66666666/,
    "no input, prompt, failure, delivery place or id",
  );

  assert.deepEqual(await latestOwnResults(db, { orgId: OTHER_ORG, agentId: OTHER_AGENT, limit: 3, maxChars: 8000 }), []);
  assert.deepEqual(await latestOwnResults(db, { orgId: ORG, agentId: AGENT, limit: 0, maxChars: 8000 }), []);
});

test("latestOwnResults cuts each text at maxChars and passes over a success that holds no text", async () => {
  const { db } = fakeDb({
    tasks: [task({ id: "own" })],
    executions: [
      execution({ completedAt: new Date("2026-10-05T09:00:10Z"), output: { content: "x".repeat(9000) } }),
      execution({ completedAt: new Date("2026-10-04T09:00:10Z"), output: { status: 200 } }),
      execution({ completedAt: new Date("2026-10-03T09:00:10Z"), output: { content: "   " } }),
      execution({ completedAt: new Date("2026-10-02T09:00:10Z"), output: { content: "ab\u{1F600}cd" } }),
    ],
  });
  const results = await latestOwnResults(db, { orgId: ORG, agentId: AGENT, limit: 3, maxChars: 8000 });
  assert.deepEqual(results.map((r) => r.text.length), [8000, 6]);

  // A cut never leaves half of a character.
  const short = await latestOwnResults(db, { orgId: ORG, agentId: AGENT, limit: 3, maxChars: 3 });
  assert.deepEqual(short.map((r) => r.text), ["xxx", "ab"]);
});

test("answerTextOf reads the answer where the executor stores it, and nothing else", () => {
  assert.equal(answerTextOf({ content: "An answer.", usage: null }), "An answer.");
  assert.equal(answerTextOf({ content: "" }), null);
  assert.equal(answerTextOf({ content: 42 }), null);
  assert.equal(answerTextOf({ text: "not here" }), null);
  assert.equal(answerTextOf(null), null);
  assert.equal(answerTextOf("An answer."), null);
});
