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

// Drives routes/orchestration.ts with an injected service. The old module
// caught every error and answered 400 with the raw message (Prisma text
// included), passed the PATCH body straight to the database, and ran a
// workflow inside the request. These tests pin the contract that replaced it.

const ORCH = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ORCH = "22222222-2222-4222-8222-222222222222";
const EXEC = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";

const definition = {
  name: "Flow",
  executionMode: "sequential",
  steps: [{ name: "a", agentId: AGENT }],
};

type Calls = Array<{ fn: string; args: unknown[] }>;

async function makeApp(
  opts: {
    /** null = unauthenticated. */
    auth?: null;
    service?: Record<string, (...args: any[]) => unknown>;
  } = {},
) {
  setupEnv();
  const { createOrchestrationRoutes } = await import("../routes/orchestration.js");
  const { WorkflowError } = await import("../services/workflowErrors.js");
  const { globalErrorHandler } = await import("../lib/errorHandler.js");
  const { acceptEmptyJsonBody } = await import("../routes/emptyJsonBody.js");

  const calls: Calls = [];
  const notFound = () => new WorkflowError("not_found", "Workflow not found");
  const scoped = (id: string) => {
    if (id !== ORCH) throw notFound();
  };

  const defaults: Record<string, (...args: any[]) => unknown> = {
    getOrchestrationStats: async () => ({
      totalOrchestrations: 1,
      activeOrchestrations: 1,
      totalExecutions: 0,
      runningExecutions: 0,
    }),
    planWorkflow: async () => ({ levels: [["a"]], order: ["a"], concurrency: 1, warnings: [] }),
    createOrchestration: async (_orgId: string, def: { name: string }) => ({ id: ORCH, ...def }),
    getOrchestrations: async () => ({ orchestrations: [], total: 0 }),
    getOrchestration: async (id: string) => {
      scoped(id);
      return { id, name: "Flow" };
    },
    replaceOrchestration: async (id: string, _orgId: string, def: { steps: unknown[] }) => {
      scoped(id);
      return { id, steps: def.steps };
    },
    updateOrchestration: async (id: string, _orgId: string, patch: object) => {
      scoped(id);
      return { id, ...patch };
    },
    deleteOrchestration: async (id: string) => {
      scoped(id);
      return { success: true };
    },
    executeOrchestration: async (
      id: string,
      _orgId: string,
      _body: unknown,
      trigger: { triggeredBy: string; triggeredById: string | null },
    ) => {
      scoped(id);
      return { id: EXEC, status: "queued", ...trigger, createdAt: new Date(0) };
    },
    getExecutions: async (id: string) => {
      scoped(id);
      return { executions: [], total: 0 };
    },
    getExecution: async (_execId: string, id: string) => {
      scoped(id);
      return { id: EXEC, status: "completed", stepResults: [] };
    },
    cancelExecution: async (_execId: string, id: string) => {
      scoped(id);
      return { execution: { id: EXEC, status: "cancelled" }, outcome: "cancelled" };
    },
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
    if (opts.auth === null) return;
    request.auth = { orgId: "org_1", type: "jwt", userId: "user_1" };
  });
  await app.register(createOrchestrationRoutes({ service: service as never }), {
    prefix: "/api/orchestrations",
  });
  return { app, calls, WorkflowError };
}

test("every route requires authentication", async () => {
  const { app, calls } = await makeApp({ auth: null });
  for (const [method, url] of [
    ["GET", "/api/orchestrations"],
    ["GET", "/api/orchestrations/stats"],
    ["POST", "/api/orchestrations"],
    ["POST", "/api/orchestrations/plan"],
    ["PATCH", `/api/orchestrations/${ORCH}`],
    ["PUT", `/api/orchestrations/${ORCH}`],
    ["DELETE", `/api/orchestrations/${ORCH}`],
    ["POST", `/api/orchestrations/${ORCH}/execute`],
    ["POST", `/api/orchestrations/${ORCH}/executions/${EXEC}/cancel`],
  ] as const) {
    const res = await app.inject({ method, url, payload: method === "GET" || method === "DELETE" ? undefined : {} });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
  assert.equal(calls.length, 0);
  await app.close();
});

test("PATCH with orgId, totalRuns or nested steps is a 400 and never reaches the service", async () => {
  const { app, calls } = await makeApp();
  for (const body of [
    { orgId: "org_2" },
    { totalRuns: 9000 },
    { successfulRuns: 9000, avgDurationMs: 1 },
    { isEnabled: true, steps: { deleteMany: {} } },
    { executions: { create: {} } },
    { executionMode: "parallel" },
  ]) {
    const res = await app.inject({ method: "PATCH", url: `/api/orchestrations/${ORCH}`, payload: body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().error, "validation_failed");
  }
  assert.equal(calls.length, 0, "the service was never called with a rejected body");

  const ok = await app.inject({
    method: "PATCH",
    url: `/api/orchestrations/${ORCH}`,
    payload: { isEnabled: false, name: "Renamed" },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(calls[0]!.args, [ORCH, "org_1", { isEnabled: false, name: "Renamed" }]);
  await app.close();
});

test("another organization's id answers 404 on every route", async () => {
  const { app } = await makeApp();
  for (const [method, url, payload] of [
    ["GET", `/api/orchestrations/${OTHER_ORG_ORCH}`, undefined],
    ["PATCH", `/api/orchestrations/${OTHER_ORG_ORCH}`, { isEnabled: false }],
    ["PUT", `/api/orchestrations/${OTHER_ORG_ORCH}`, definition],
    ["DELETE", `/api/orchestrations/${OTHER_ORG_ORCH}`, undefined],
    ["POST", `/api/orchestrations/${OTHER_ORG_ORCH}/execute`, {}],
    ["GET", `/api/orchestrations/${OTHER_ORG_ORCH}/executions`, undefined],
    ["GET", `/api/orchestrations/${OTHER_ORG_ORCH}/executions/${EXEC}`, undefined],
    ["POST", `/api/orchestrations/${OTHER_ORG_ORCH}/executions/${EXEC}/cancel`, undefined],
  ] as const) {
    const res = await app.inject({ method, url, payload });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
    assert.equal(res.json().error, "not_found");
  }
  await app.close();
});

test("a malformed id is a 404, not a database error", async () => {
  const { app, calls } = await makeApp();
  const res = await app.inject({ method: "GET", url: "/api/orchestrations/not-a-uuid" });
  assert.equal(res.statusCode, 404);
  assert.equal(calls.length, 0);
  await app.close();
});

test("a duplicate name (P2002) maps to 409 name_taken without the Prisma message", async () => {
  const p2002 = Object.assign(
    new Error("Unique constraint failed on the fields: (`org_id`,`name`)"),
    { code: "P2002" },
  );
  const { app } = await makeApp({
    service: {
      createOrchestration: async () => {
        throw p2002;
      },
      updateOrchestration: async () => {
        throw p2002;
      },
      replaceOrchestration: async () => {
        throw p2002;
      },
    },
  });
  for (const [method, url, payload] of [
    ["POST", "/api/orchestrations", definition],
    ["PATCH", `/api/orchestrations/${ORCH}`, { name: "Taken" }],
    ["PUT", `/api/orchestrations/${ORCH}`, definition],
  ] as const) {
    const res = await app.inject({ method, url, payload });
    assert.equal(res.statusCode, 409, `${method} ${url}`);
    assert.equal(res.json().error, "name_taken");
    assert.doesNotMatch(res.body, /Unique constraint|org_id/);
  }
  await app.close();
});

test("an unexpected error is a scrubbed 500, not a 400 with the raw message", async () => {
  const { app } = await makeApp({
    service: {
      getOrchestrations: async () => {
        throw new Error("Can't reach database server at db.internal:5432");
      },
    },
  });
  const res = await app.inject({ method: "GET", url: "/api/orchestrations" });
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(res.body, /db\.internal/);
  await app.close();
});

test("create validates the body strictly and answers 201", async () => {
  const { app, calls } = await makeApp();
  const created = await app.inject({ method: "POST", url: "/api/orchestrations", payload: definition });
  assert.equal(created.statusCode, 201);
  assert.equal(calls[0]!.fn, "createOrchestration");
  assert.equal(calls[0]!.args[0], "org_1");

  for (const body of [
    { ...definition, orgId: "org_2" },
    { ...definition, executionMode: "chaotic" },
    { ...definition, steps: [] },
    { ...definition, steps: [{ name: "a.b", agentId: AGENT }] },
  ]) {
    const res = await app.inject({ method: "POST", url: "/api/orchestrations", payload: body });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, "validation_failed");
    assert.ok(res.json().details, "zod details are returned");
  }
  assert.equal(calls.length, 1);
  await app.close();
});

test("PUT replaces the steps and passes expectedUpdatedAt; a stale one is a 409", async () => {
  const fresh = await makeApp();
  const stamp = "2026-10-07T10:00:00.000Z";
  const res = await fresh.app.inject({
    method: "PUT",
    url: `/api/orchestrations/${ORCH}`,
    payload: {
      ...definition,
      steps: [
        { name: "a", agentId: AGENT },
        { name: "b", agentId: AGENT, dependsOn: ["a"] },
      ],
      expectedUpdatedAt: stamp,
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().steps.length, 2);
  const [id, orgId, def, expected] = fresh.calls[0]!.args as [string, string, Record<string, unknown>, string];
  assert.equal(id, ORCH);
  assert.equal(orgId, "org_1");
  assert.equal(expected, stamp);
  assert.equal("expectedUpdatedAt" in def, false, "the token is not part of the definition");
  await fresh.app.close();

  const { WorkflowError } = fresh;
  const staleApp = await makeApp({
    service: {
      replaceOrchestration: async () => {
        throw new WorkflowError("stale_definition", "changed after you loaded it", {
          currentUpdatedAt: "2026-10-07T11:00:00.000Z",
        });
      },
    },
  });
  const conflict = await staleApp.app.inject({
    method: "PUT",
    url: `/api/orchestrations/${ORCH}`,
    payload: { ...definition, expectedUpdatedAt: stamp },
  });
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(
    [conflict.json().error, conflict.json().currentUpdatedAt],
    ["stale_definition", "2026-10-07T11:00:00.000Z"],
  );
  await staleApp.app.close();
});

test("POST /plan returns the levels, or invalid_workflow naming the step and field", async () => {
  const ok = await makeApp();
  const planned = await ok.app.inject({ method: "POST", url: "/api/orchestrations/plan", payload: definition });
  assert.equal(planned.statusCode, 200);
  assert.deepEqual(planned.json(), { levels: [["a"]], order: ["a"], concurrency: 1, warnings: [] });
  await ok.app.close();

  const { WorkflowError } = ok;
  const bad = await makeApp({
    service: {
      planWorkflow: async () => {
        throw new WorkflowError("invalid_workflow", "dependency cycle among steps: a, b", {
          field: "dependsOn",
        });
      },
    },
  });
  const refused = await bad.app.inject({ method: "POST", url: "/api/orchestrations/plan", payload: definition });
  assert.equal(refused.statusCode, 400);
  assert.deepEqual(refused.json(), {
    error: "invalid_workflow",
    message: "dependency cycle among steps: a, b",
    field: "dependsOn",
  });
  await bad.app.close();
});

test("execute answers 202 with a queued run and derives the trigger from authentication", async () => {
  const session = await makeApp();
  const res = await session.app.inject({
    method: "POST",
    url: `/api/orchestrations/${ORCH}/execute`,
    payload: { prompt: "go", input: { topic: "tides" } },
  });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().execution.status, "queued");
  assert.equal(res.json().execution.triggeredBy, "manual");
  assert.equal(res.json().execution.triggeredById, "user_1");
  assert.deepEqual(session.calls[0]!.args[2], { prompt: "go", input: { topic: "tides" } });
  await session.app.close();

  // An API key is a program, not a person. (Checked on the pure helper:
  // an API-key request through requireAuth is metered against the database.)
  const { triggerFromAuth } = await import("../routes/orchestration.js");
  assert.deepEqual(triggerFromAuth({ type: "api_key", userId: null, apiKeyId: "key_1" }), {
    triggeredBy: "api",
    triggeredById: "key_1",
  });
  assert.deepEqual(triggerFromAuth({ type: "jwt", userId: "user_1" }), {
    triggeredBy: "manual",
    triggeredById: "user_1",
  });
});

test("a triggeredBy in the execute body is rejected, never trusted", async () => {
  const { app, calls } = await makeApp();
  const res = await app.inject({
    method: "POST",
    url: `/api/orchestrations/${ORCH}/execute`,
    payload: { input: {}, triggeredBy: "schedule" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "validation_failed");
  assert.equal(calls.length, 0);
  await app.close();
});

test("execute maps each refusal to its documented status and code", async () => {
  const { WorkflowError, app: first } = await makeApp();
  await first.close();
  for (const [code, status, extra] of [
    ["workflow_runner_disabled", 501, {}],
    ["workflow_disabled", 409, {}],
    ["workflow_run_limit", 429, { limit: 5 }],
    ["workflow_queue_unavailable", 503, {}],
    ["input_schema_mismatch", 400, { details: ["topic is required"] }],
  ] as const) {
    const { app } = await makeApp({
      service: {
        executeOrchestration: async () => {
          throw new WorkflowError(code, `refused: ${code}`, extra);
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/orchestrations/${ORCH}/execute`,
      payload: {},
    });
    assert.equal(res.statusCode, status, code);
    assert.equal(res.json().error, code);
    for (const [key, value] of Object.entries(extra)) assert.deepEqual(res.json()[key], value);
    await app.close();
  }
});

test("a workflow on sale: a disable, a change and a delete that are refused answer 409 with their code and sentence", async () => {
  const { WorkflowError, app: first } = await makeApp();
  await first.close();
  const cases = [
    ["PATCH", "updateOrchestration", { isEnabled: false }, "workflow_on_sale", "This workflow is on sale. Stop selling it first."],
    ["PUT", "replaceOrchestration", definition, "workflow_on_sale", "People are still on a plan for this workflow. It can be changed once their 30 days end."],
    ["DELETE", "deleteOrchestration", undefined, "workflow_on_sale", "This workflow is on sale. Stop selling it first."],
    ["DELETE", "deleteOrchestration", undefined, "workflow_has_buyers", "People have paid for this workflow, so it cannot be deleted."],
  ] as const;
  for (const [method, fn, payload, code, message] of cases) {
    const { app } = await makeApp({
      service: {
        [fn]: async () => {
          throw new WorkflowError(code, message);
        },
      },
    });
    const res = await app.inject({ method, url: `/api/orchestrations/${ORCH}`, ...(payload && { payload }) });
    assert.equal(res.statusCode, 409, `${method} ${code}`);
    assert.deepEqual(res.json(), { error: code, message });
    await app.close();
  }
});

test("cancel: 200 for a queued run, 202 for a running one, 409 for a finished one", async () => {
  const queued = await makeApp();
  const cancelled = await queued.app.inject({
    method: "POST",
    url: `/api/orchestrations/${ORCH}/executions/${EXEC}/cancel`,
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().execution.status, "cancelled");
  await queued.app.close();

  const running = await makeApp({
    service: {
      cancelExecution: async () => ({
        execution: { id: EXEC, status: "running", cancelRequestedAt: "2026-10-07T10:00:00.000Z" },
        outcome: "cancel_requested",
      }),
    },
  });
  const requested = await running.app.inject({
    method: "POST",
    url: `/api/orchestrations/${ORCH}/executions/${EXEC}/cancel`,
  });
  assert.equal(requested.statusCode, 202);
  assert.equal(requested.json().execution.status, "running");
  assert.ok(requested.json().execution.cancelRequestedAt);
  await running.app.close();

  const { WorkflowError } = queued;
  const finished = await makeApp({
    service: {
      cancelExecution: async () => {
        throw new WorkflowError("execution_finished", "This run already completed", {
          status: "completed",
        });
      },
    },
  });
  const tooLate = await finished.app.inject({
    method: "POST",
    url: `/api/orchestrations/${ORCH}/executions/${EXEC}/cancel`,
  });
  assert.equal(tooLate.statusCode, 409);
  assert.deepEqual([tooLate.json().error, tooLate.json().status], ["execution_finished", "completed"]);
  await finished.app.close();
});

test("list query parameters are validated", async () => {
  const { app, calls } = await makeApp();
  for (const query of ["limit=0", "limit=101", "offset=-1", "isEnabled=maybe", "limit=abc"]) {
    const res = await app.inject({ method: "GET", url: `/api/orchestrations?${query}` });
    assert.equal(res.statusCode, 400, query);
    assert.equal(res.json().error, "validation_failed");
  }
  assert.equal(calls.length, 0);

  const ok = await app.inject({ method: "GET", url: "/api/orchestrations?isEnabled=false&limit=50&offset=10" });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(calls[0]!.args, ["org_1", { isEnabled: false, limit: 50, offset: 10 }]);
  await app.close();
});

// The dashboard's fetch helper sent Content-Type: application/json with
// no body on Cancel; Fastify answered 400 FST_ERR_CTP_EMPTY_JSON_BODY
// before the handler, so a run could not be cancelled from the UI.
test("a bodiless POST with a JSON content type reaches cancel and execute", async () => {
  const { app, calls } = await makeApp();
  const headers = { "content-type": "application/json" };
  const cancel = await app.inject({
    method: "POST",
    url: `/api/orchestrations/${ORCH}/executions/${EXEC}/cancel`,
    headers,
  });
  assert.equal(cancel.statusCode, 200, cancel.body);
  const execute = await app.inject({ method: "POST", url: `/api/orchestrations/${ORCH}/execute`, headers });
  assert.equal(execute.statusCode, 202, execute.body);
  assert.deepEqual(calls.map((c) => c.fn), ["cancelExecution", "executeOrchestration"]);

  // A body that is present is parsed as before, bad JSON included.
  const malformed = await app.inject({
    method: "POST",
    url: `/api/orchestrations/${ORCH}/execute`,
    headers,
    payload: "{not json",
  });
  assert.equal(malformed.statusCode, 400);
  await app.close();
});
