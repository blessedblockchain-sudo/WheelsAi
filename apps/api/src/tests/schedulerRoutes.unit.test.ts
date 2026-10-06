import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import sensible from "@fastify/sensible";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives routes/scheduler.ts with an injected service. The old module
// accepted any taskType, scheduleType or body key, and answered every
// error (not-found, duplicate name, database outage) as a 400 carrying
// the raw message. The route checks a task's shape; the service checks
// what depends on the task's type and the organization, and the route
// passes those refusals through with their field and reason.

const TASK = "11111111-1111-4111-8111-111111111111";
const MISSING_TASK = "22222222-2222-4222-8222-222222222222";
const EXEC = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";
const WORKFLOW = "55555555-5555-4555-8555-555555555555";

/** Same shape as the service's SchedulerError; the route matches on shape. */
class SchedulerError extends Error {
  override name = "SchedulerError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const validTask = {
  name: "Morning digest",
  taskType: "agent_run",
  agentId: AGENT,
  scheduleType: "cron",
  cronExpression: "0 8 * * 1-5",
  timezone: "UTC",
  payload: { prompt: "Summarise yesterday." },
};

async function makeApp(
  opts: { authed?: boolean; service?: Record<string, (...args: any[]) => unknown> } = {},
) {
  setupEnv();
  const { createSchedulerRoutes } = await import("../routes/scheduler.js");
  const { globalErrorHandler } = await import("../lib/errorHandler.js");
  const { acceptEmptyJsonBody } = await import("../routes/emptyJsonBody.js");

  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const scoped = (id: string) => {
    if (id !== TASK) throw new SchedulerError(404, "not_found", "Task not found");
  };
  const defaults: Record<string, (...args: any[]) => unknown> = {
    getSchedulerStats: async () => ({ totalTasks: 0 }),
    createScheduledTask: async (_orgId: string, input: object) => ({ id: TASK, ...input }),
    getScheduledTasks: async () => ({ tasks: [], total: 0 }),
    getScheduledTask: async (id: string) => (scoped(id), { id }),
    updateScheduledTask: async (id: string, _orgId: string, patch: object) => (scoped(id), { id, ...patch }),
    deleteScheduledTask: async (id: string) => (scoped(id), { success: true }),
    toggleScheduledTask: async (id: string, _orgId: string, isEnabled: boolean) => (scoped(id), { id, isEnabled }),
    triggerTask: async (id: string) => (
      scoped(id), { execution: { id: EXEC, status: "success", output: { ok: true } }, deferred: false }
    ),
    getTaskTypes: () => ({ schedulerEnabled: true, intervalMs: 30000, taskTypes: [] }),
    getTaskExecutions: async (id: string) => (scoped(id), { executions: [], total: 0 }),
    cancelExecution: async (_execId: string, id: string) => (scoped(id), { id: EXEC, status: "cancelled" }),
  };
  const service = Object.fromEntries(
    Object.entries({ ...defaults, ...(opts.service ?? {}) }).map(([fn, impl]) => [
      fn,
      (...args: unknown[]) => {
        calls.push({ fn, args });
        return impl(...args);
      },
    ]),
  );

  const app = Fastify();
  await app.register(sensible);
  app.setErrorHandler(globalErrorHandler);
  // As index.ts does at the root, before any route plugin.
  acceptEmptyJsonBody(app);
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.authed !== false) request.auth = { userId: "u1", orgId: "org_1", type: "jwt" };
  });
  await app.register(createSchedulerRoutes({ service: service as never }), {
    prefix: "/api/scheduler",
  });
  return { app, calls };
}

test("scheduler routes require authentication", async () => {
  const { app, calls } = await makeApp({ authed: false });
  for (const [method, url] of [
    ["GET", "/api/scheduler"],
    ["POST", "/api/scheduler"],
    ["PATCH", `/api/scheduler/${TASK}`],
    ["POST", `/api/scheduler/${TASK}/trigger`],
  ] as const) {
    const res = await app.inject({ method, url, payload: method === "GET" ? undefined : {} });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
  assert.equal(calls.length, 0);
  await app.close();
});

test("create accepts a valid task and scopes it to the caller's organization", async () => {
  const { app, calls } = await makeApp();
  const res = await app.inject({ method: "POST", url: "/api/scheduler", payload: validTask });
  assert.equal(res.statusCode, 201);
  assert.equal(calls[0]!.args[0], "org_1");
  assert.deepEqual(calls[0]!.args[1], validTask);
  await app.close();
});

test("create rejects unknown keys, unknown types and out-of-range values with field errors", async () => {
  const { app, calls } = await makeApp();
  for (const [body, field] of [
    [{ ...validTask, orgId: "org_2" }, null],
    [{ ...validTask, totalRuns: 100 }, null],
    [{ ...validTask, taskType: "mine_bitcoin" }, "taskType"],
    [{ ...validTask, scheduleType: "whenever" }, "scheduleType"],
    [{ ...validTask, scheduleType: "interval", intervalSeconds: 0 }, "intervalSeconds"],
    [{ ...validTask, timeout: 10 }, "timeout"],
    [{ ...validTask, maxRetries: 50 }, "maxRetries"],
    [{ ...validTask, agentId: "not-a-uuid" }, "agentId"],
    [{ ...validTask, orchestrationId: "not-a-uuid" }, "orchestrationId"],
    [{ ...validTask, payload: "a string" }, "payload"],
    // The schedule type's own field is required.
    [{ ...validTask, cronExpression: undefined }, "cronExpression"],
    [{ ...validTask, scheduleType: "interval" }, "intervalSeconds"],
    [{ ...validTask, scheduleType: "once" }, "scheduledAt"],
  ] as const) {
    const res = await app.inject({ method: "POST", url: "/api/scheduler", payload: body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    const json = res.json();
    assert.equal(json.error, "validation_failed");
    if (field) assert.ok(json.details.fieldErrors[field], `no field error for ${field}`);
  }
  assert.equal(calls.length, 0);
  await app.close();
});

test("an agent from another organization answers invalid_task naming the field", async () => {
  const { app } = await makeApp({
    service: {
      createScheduledTask: async () => {
        throw new SchedulerError(400, "invalid_task", "agent not found in this organization", {
          field: "agentId",
        });
      },
    },
  });
  const res = await app.inject({ method: "POST", url: "/api/scheduler", payload: validTask });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), {
    error: "invalid_task",
    message: "agent not found in this organization",
    field: "agentId",
  });
  await app.close();
});

test("a duplicate name (P2002) maps to 409 name_taken without the Prisma message", async () => {
  const p2002 = Object.assign(new Error("Unique constraint failed on the fields: (`org_id`,`name`)"), {
    code: "P2002",
  });
  const { app } = await makeApp({
    service: {
      createScheduledTask: async () => {
        throw p2002;
      },
      updateScheduledTask: async () => {
        throw p2002;
      },
    },
  });
  for (const [method, url, payload] of [
    ["POST", "/api/scheduler", validTask],
    ["PATCH", `/api/scheduler/${TASK}`, { name: "Taken" }],
  ] as const) {
    const res = await app.inject({ method, url, payload });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "name_taken");
    assert.doesNotMatch(res.body, /Unique constraint/);
  }
  await app.close();
});

test("a missing task is a 404 on every route, PATCH included", async () => {
  const { app } = await makeApp();
  for (const [method, url, payload] of [
    ["GET", `/api/scheduler/${MISSING_TASK}`, undefined],
    ["PATCH", `/api/scheduler/${MISSING_TASK}`, { name: "x" }],
    ["DELETE", `/api/scheduler/${MISSING_TASK}`, undefined],
    ["POST", `/api/scheduler/${MISSING_TASK}/toggle`, { isEnabled: false }],
    ["POST", `/api/scheduler/${MISSING_TASK}/trigger`, undefined],
    ["GET", `/api/scheduler/${MISSING_TASK}/executions`, undefined],
    ["POST", `/api/scheduler/${MISSING_TASK}/executions/${EXEC}/cancel`, undefined],
    ["GET", "/api/scheduler/not-a-uuid", undefined],
  ] as const) {
    const res = await app.inject({ method, url, payload });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
    assert.equal(res.json().error, "not_found");
  }
  await app.close();
});

test("PATCH rejects unknown keys and an empty body", async () => {
  const { app, calls } = await makeApp();
  for (const body of [{ orgId: "org_2" }, { agentId: "nope" }, { successfulRuns: 9 }, { nextRunAt: "2030-01-01" }, {}]) {
    const res = await app.inject({ method: "PATCH", url: `/api/scheduler/${TASK}`, payload: body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().error, "validation_failed");
  }
  assert.equal(calls.length, 0);

  const ok = await app.inject({
    method: "PATCH",
    url: `/api/scheduler/${TASK}`,
    payload: { cronExpression: "0 9 * * *", isEnabled: false, agentId: null, orchestrationId: WORKFLOW },
  });
  assert.equal(ok.statusCode, 200);
  await app.close();
});

test("cancelling an execution that already finished is a 409 not_cancellable", async () => {
  const { app } = await makeApp({
    service: {
      cancelExecution: async () => {
        throw new SchedulerError(409, "not_cancellable", "This execution already success", {
          status: "success",
        });
      },
    },
  });
  const res = await app.inject({
    method: "POST",
    url: `/api/scheduler/${TASK}/executions/${EXEC}/cancel`,
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual([res.json().error, res.json().status], ["not_cancellable", "success"]);
  await app.close();
});

test("an unexpected error is a scrubbed 500, not a 400 with the raw message", async () => {
  const { app } = await makeApp({
    service: {
      getScheduledTasks: async () => {
        throw new Error("Can't reach database server at db.internal:5432");
      },
    },
  });
  const res = await app.inject({ method: "GET", url: "/api/scheduler" });
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(res.body, /db\.internal/);
  await app.close();
});

// ============================================
// Task types, per-type validation, trigger
// ============================================

test("every registered task type is accepted by the route, workflow_run with its workflow", async () => {
  const { TASK_TYPE_IDS } = await import("../services/scheduledTaskTypes.js");
  const { app, calls } = await makeApp();
  for (const taskType of TASK_TYPE_IDS) {
    const res = await app.inject({
      method: "POST",
      url: "/api/scheduler",
      payload: { ...validTask, name: taskType, taskType, orchestrationId: WORKFLOW },
    });
    assert.equal(res.statusCode, 201, taskType);
  }
  assert.equal(calls.length, TASK_TYPE_IDS.length);
  assert.equal((calls[0]!.args[1] as { orchestrationId: string }).orchestrationId, WORKFLOW);
  await app.close();
});

test("GET /task-types returns the catalogue and whether schedules fire here", async () => {
  const { taskTypeCatalogue } = await import("../services/scheduledTaskTypes.js");
  const caps = { workflowRunnerEnabled: false, emailConfigured: false, deploymentRestartAvailable: false };
  const { app } = await makeApp({
    service: {
      getTaskTypes: () => ({ schedulerEnabled: false, intervalMs: 0, taskTypes: taskTypeCatalogue(caps) }),
    },
  });
  const res = await app.inject({ method: "GET", url: "/api/scheduler/task-types" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.schedulerEnabled, false);
  assert.equal(body.intervalMs, 0);
  const types = body.taskTypes.map((t: { type: string }) => t.type);
  for (const type of ["agent_run", "webhook", "data_sync", "health_check", "report", "cleanup", "custom", "workflow_run"]) {
    assert.ok(types.includes(type), `${type} is listed`);
  }
  const workflow = body.taskTypes.find((t: { type: string }) => t.type === "workflow_run");
  assert.equal(workflow.available, false);
  assert.match(workflow.reason, /WORKFLOW_RUN_CONCURRENCY is 0/);
  await app.close();
});

test("/task-types is not mistaken for a task id, and needs authentication", async () => {
  const { app, calls } = await makeApp({ authed: false });
  const res = await app.inject({ method: "GET", url: "/api/scheduler/task-types" });
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
  await app.close();
});

test("a per-type payload error comes back as validation_failed keyed by payload field", async () => {
  const refusal = new SchedulerError(400, "validation_failed", "The task payload is not valid for this task type", {
    details: { formErrors: [], fieldErrors: { "payload.url": ["must be an http or https URL"] } },
  });
  const { app } = await makeApp({
    service: {
      createScheduledTask: async () => {
        throw refusal;
      },
      updateScheduledTask: async () => {
        throw refusal;
      },
    },
  });
  for (const [method, url, payload] of [
    ["POST", "/api/scheduler", { ...validTask, taskType: "webhook", payload: { url: "ftp://x" } }],
    ["PATCH", `/api/scheduler/${TASK}`, { payload: { url: "ftp://x" } }],
  ] as const) {
    const res = await app.inject({ method, url, payload });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), {
      error: "validation_failed",
      message: "The task payload is not valid for this task type",
      details: { formErrors: [], fieldErrors: { "payload.url": ["must be an http or https URL"] } },
    });
  }
  await app.close();
});

test("a schedule the service refuses answers invalid_schedule with its reason", async () => {
  const { app } = await makeApp({
    service: {
      createScheduledTask: async (_orgId: string, input: { intervalSeconds?: number }) => {
        if (input.intervalSeconds !== undefined && input.intervalSeconds < 60) {
          throw new SchedulerError(400, "invalid_schedule", "the shortest interval is 60 seconds", {
            reason: "interval_too_short",
            field: "intervalSeconds",
          });
        }
        throw new SchedulerError(400, "invalid_schedule", "scheduledAt is in the past", {
          reason: "scheduled_at_in_past",
          field: "scheduledAt",
        });
      },
    },
  });
  const short = await app.inject({
    method: "POST",
    url: "/api/scheduler",
    payload: { ...validTask, scheduleType: "interval", intervalSeconds: 5 },
  });
  assert.equal(short.statusCode, 400);
  assert.deepEqual(
    [short.json().error, short.json().reason, short.json().field],
    ["invalid_schedule", "interval_too_short", "intervalSeconds"],
  );

  // A naive local time is the service's to read, in the task's time zone.
  const past = await app.inject({
    method: "POST",
    url: "/api/scheduler",
    payload: { ...validTask, scheduleType: "once", scheduledAt: "2020-01-01T09:00", timezone: "Europe/Berlin" },
  });
  assert.equal(past.statusCode, 400);
  assert.equal(past.json().reason, "scheduled_at_in_past");
  await app.close();
});

test("a workflow from another organization answers invalid_task naming orchestrationId", async () => {
  const { app } = await makeApp({
    service: {
      createScheduledTask: async () => {
        throw new SchedulerError(400, "invalid_task", "workflow not found in this organization", {
          field: "orchestrationId",
        });
      },
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/scheduler",
    payload: { ...validTask, taskType: "workflow_run", agentId: null, orchestrationId: WORKFLOW },
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual([res.json().error, res.json().field], ["invalid_task", "orchestrationId"]);
  await app.close();
});

test("the list filters by workflow and task type, and refuses an unknown type", async () => {
  const { app, calls } = await makeApp();
  const res = await app.inject({
    method: "GET",
    url: `/api/scheduler?orchestrationId=${WORKFLOW}&taskType=workflow_run&isEnabled=true&limit=5`,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0]!.args, [
    "org_1",
    { agentId: undefined, orchestrationId: WORKFLOW, taskType: "workflow_run", status: undefined, isEnabled: true, limit: 5, offset: undefined },
  ]);
  const bad = await app.inject({ method: "GET", url: "/api/scheduler?taskType=telepathy" });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "validation_failed");
  await app.close();
});

test("trigger answers 201 with the finished execution for a synchronous type", async () => {
  const { app } = await makeApp();
  const res = await app.inject({ method: "POST", url: `/api/scheduler/${TASK}/trigger` });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json(), { id: EXEC, status: "success", output: { ok: true } });
  await app.close();
});

test("trigger answers 202 with the still-running execution for a workflow_run", async () => {
  const { app } = await makeApp({
    service: {
      triggerTask: async () => ({
        execution: { id: EXEC, status: "running", orchestrationExecutionId: WORKFLOW },
        deferred: true,
      }),
    },
  });
  const res = await app.inject({ method: "POST", url: `/api/scheduler/${TASK}/trigger` });
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.json(), { id: EXEC, status: "running", orchestrationExecutionId: WORKFLOW });
  await app.close();
});

test("triggering a task that is already running is a 409 naming the running execution", async () => {
  const { app } = await makeApp({
    service: {
      triggerTask: async () => {
        throw new SchedulerError(409, "already_running", "This task is already running", { executionId: EXEC });
      },
    },
  });
  const res = await app.inject({ method: "POST", url: `/api/scheduler/${TASK}/trigger` });
  assert.equal(res.statusCode, 409);
  assert.deepEqual([res.json().error, res.json().executionId], ["already_running", EXEC]);
  await app.close();
});

test("cancelling a running execution answers 200 with the cancelled row", async () => {
  const { app, calls } = await makeApp();
  const res = await app.inject({ method: "POST", url: `/api/scheduler/${TASK}/executions/${EXEC}/cancel` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "cancelled");
  assert.deepEqual(calls[0]!.args, [EXEC, TASK, "org_1"]);
  await app.close();
});

// The dashboard's fetch helper sent Content-Type: application/json on
// every request, and "Run now" and "Cancel" have no body. Fastify refuses
// that pair while parsing, before authentication and before the handler,
// so both buttons only ever showed an error.
test("a bodiless POST with a JSON content type reaches trigger and cancel", async () => {
  const { app, calls } = await makeApp();
  const headers = { "content-type": "application/json" };
  const trigger = await app.inject({ method: "POST", url: `/api/scheduler/${TASK}/trigger`, headers });
  assert.equal(trigger.statusCode, 201, trigger.body);
  const cancel = await app.inject({
    method: "POST",
    url: `/api/scheduler/${TASK}/executions/${EXEC}/cancel`,
    headers,
  });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.deepEqual(calls.map((c) => c.fn), ["triggerTask", "cancelExecution"]);
  await app.close();
});

test("an empty JSON body is still refused where a body is required, and JSON is still parsed safely", async () => {
  const { app, calls } = await makeApp();
  const headers = { "content-type": "application/json" };
  const empty = await app.inject({ method: "POST", url: "/api/scheduler", headers });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error, "validation_failed");

  const poisoned = await app.inject({
    method: "POST",
    url: "/api/scheduler",
    headers,
    payload: '{"__proto__":{"isAdmin":true},"name":"x"}',
  });
  assert.equal(poisoned.statusCode, 400);
  const malformed = await app.inject({ method: "POST", url: "/api/scheduler", headers, payload: "{not json" });
  assert.equal(malformed.statusCode, 400);
  assert.equal(calls.length, 0);

  const ok = await app.inject({ method: "POST", url: "/api/scheduler", headers, payload: JSON.stringify(validTask) });
  assert.equal(ok.statusCode, 201);
  await app.close();
});

test("without authentication a bodiless JSON POST answers 401, not a parser 400", async () => {
  const { app } = await makeApp({ authed: false });
  const res = await app.inject({
    method: "POST",
    url: `/api/scheduler/${TASK}/trigger`,
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});
