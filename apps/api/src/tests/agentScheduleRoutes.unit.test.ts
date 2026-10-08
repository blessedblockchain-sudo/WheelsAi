/**
 * routes/agentSchedule.ts over HTTP: guards, shapes and every refusal, on
 * the stand-in world of agentScheduleWorld.ts. The scope guard is the real
 * one.
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import sensible from "@fastify/sensible";
import Fastify, { type FastifyInstance, type preHandlerAsyncHookHandler } from "fastify";

import { globalErrorHandler } from "../lib/errorHandler.js";
import { requireScope } from "../middleware/auth.js";
import { AGENTS_INVOKE_SCOPE } from "../middleware/openaiAuth.js";
import { createAgentScheduleRoutes } from "../routes/agentSchedule.js";
import { OWN_SCHEDULE_MESSAGES } from "../services/agentOwnSchedule.js";
import { RUN_FAILURE_MESSAGES } from "../services/agentSchedule.js";
import { taskTimeoutError } from "../services/runSchedulerTick.js";
import { ChannelDeliveryError } from "../services/scheduledTasks/reportDelivery.js";
import {
  ADDRESS,
  AGENT,
  FOREIGN_AGENT,
  FOREIGN_SLACK,
  ORG,
  OTHER_ORG,
  SECOND_AGENT,
  SLACK,
  SLACK_LINK,
  fakeWorld,
  run,
  task,
  type WorldSeed,
} from "./agentScheduleWorld.js";

async function buildApp(seed: WorldSeed = {}) {
  const world = fakeWorld(seed);
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(sensible);
  app.decorateRequest("auth", null);
  // Stands in for the global auth hook: a test names its caller in headers.
  app.addHook("onRequest", async (request) => {
    const org = request.headers["x-test-org"];
    if (typeof org !== "string") return;
    const scopes = request.headers["x-test-scopes"];
    (request as { auth: unknown }).auth =
      typeof scopes === "string"
        ? { orgId: org, userId: null, type: "api_key", apiKeyId: "key_1", scopes: scopes ? scopes.split(",") : [] }
        : { orgId: org, userId: "user-1", type: "jwt" };
  });
  const auth: preHandlerAsyncHookHandler = async (request, reply) => {
    if (!request.auth) return reply.status(401).send({ error: "Unauthorized", message: "Authentication required" });
  };
  await app.register(
    createAgentScheduleRoutes({
      schedule: world.deps,
      guards: { auth, invoke: requireScope(AGENTS_INVOKE_SCOPE) as preHandlerAsyncHookHandler },
    }),
    { prefix: "/api/agents" },
  );
  await app.ready();
  return { app, world };
}

const session = { "x-test-org": ORG };
const key = (scopes: string) => ({ "x-test-org": ORG, "x-test-scopes": scopes });

const call = (
  app: FastifyInstance,
  method: "GET" | "PUT" | "POST",
  path: string,
  payload?: unknown,
  headers: Record<string, string> = session,
) =>
  app.inject({
    method,
    url: `/api/agents/${path}`,
    headers: payload === undefined ? headers : { "content-type": "application/json", ...headers },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });

const BODY = { enabled: true, cronExpression: "0 9 * * *", timezone: "Europe/Berlin" };

const assertNoLinkOrAddress = (body: string) => {
  for (const secret of [SLACK_LINK, "hooks.slack.com", "secret-token", ADDRESS, "webhookUrl", "emails"]) {
    assert.ok(!body.includes(secret), `the answer carries ${secret}`);
  }
};

test("every route needs a caller; only run now needs agents:invoke of a key", async () => {
  const { app, world } = await buildApp({ tasks: [task()] });
  const routes: Array<["GET" | "PUT" | "POST", string, unknown?]> = [
    ["GET", `${AGENT}/schedule`],
    ["PUT", `${AGENT}/schedule`, BODY],
    ["POST", `${AGENT}/schedule/run`],
    ["GET", `${AGENT}/runs`],
    ["POST", `${AGENT}/runs/aaaaaaaa-0000-4000-8000-000000000001/deliver`],
  ];
  for (const [method, path, payload] of routes) {
    const res = await call(app, method, path, payload, {});
    assert.equal(res.statusCode, 401, `${method} ${path}`);
  }
  assert.equal(world.writes.length, 0);

  const unscoped = await call(app, "POST", `${AGENT}/schedule/run`, undefined, key("agents:read"));
  assert.equal(unscoped.statusCode, 403);
  assert.equal(unscoped.json().error, "missing_scope");
  assert.equal(world.runNowCalls.length, 0);

  assert.equal((await call(app, "POST", `${AGENT}/schedule/run`, undefined, key(AGENTS_INVOKE_SCOPE))).statusCode, 201);
  assert.equal((await call(app, "GET", `${AGENT}/schedule`, undefined, key("agents:read"))).statusCode, 200);
  assert.equal((await call(app, "PUT", `${AGENT}/schedule`, BODY, key("agents:read"))).statusCode, 200);
  assert.equal((await call(app, "GET", `${AGENT}/runs`, undefined, key("agents:read"))).statusCode, 200);
  await app.close();
});

test("GET and PUT answer the same shape, and never a place's link", async () => {
  const { app, world } = await buildApp();
  world.state.agents[0]!.kindConfig = { scheduled: { schedule: { cronExpression: "0 7 * * *" }, prompt: "Go." } };

  const empty = await call(app, "GET", `${AGENT}/schedule`);
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), {
    schedule: null,
    suggested: { schedule: { cronExpression: "0 7 * * *" }, prompt: "Go." },
    otherTasks: 0,
    schedulerRunning: true,
  });

  const put = await call(app, "PUT", `${AGENT}/schedule`, { ...BODY, deliver: { channelId: SLACK } });
  assert.equal(put.statusCode, 200);
  const made = put.json();
  assert.deepEqual(Object.keys(made).sort(), ["otherTasks", "schedule", "schedulerRunning", "suggested"]);
  assert.deepEqual(Object.keys(made.schedule).sort(), [
    "cronExpression",
    "deliver",
    "enabled",
    "id",
    "lastRunAt",
    "lastRunStatus",
    "maxRetries",
    "nextRunAt",
    "prompt",
    "stampTime",
    "timeoutSeconds",
    "timezone",
  ]);
  assert.deepEqual(made.schedule.deliver, { channelId: SLACK, name: "Team Slack", type: "slack" });
  assert.equal(typeof made.schedule.nextRunAt, "string");
  assertNoLinkOrAddress(put.body);

  const get = await call(app, "GET", `${AGENT}/schedule`);
  assert.deepEqual(get.json(), made);

  const off = await call(app, "PUT", `${AGENT}/schedule`, { enabled: false, cronExpression: "0 9 * * *", deliver: null });
  assert.equal(off.statusCode, 200);
  assert.equal(off.json().schedule.enabled, false);
  assert.equal(off.json().schedule.deliver, null);
  assert.equal(world.state.tasks.length, 1);
  await app.close();
});

test("PUT refusals: 400 validation_failed and invalid_schedule, 404, 409 schedule_changed", async () => {
  const { app, world } = await buildApp();

  for (const bad of [
    {},
    { enabled: true },
    { ...BODY, enabled: "yes" },
    { ...BODY, surprise: 1 },
    { ...BODY, deliver: { channelId: SLACK, link: SLACK_LINK } },
    { ...BODY, deliver: { channelId: "not-an-id" } },
  ]) {
    const res = await call(app, "PUT", `${AGENT}/schedule`, bad);
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.equal(res.json().error, "validation_failed");
    assert.equal(typeof res.json().message, "string");
    assert.ok(res.json().fields);
    assertNoLinkOrAddress(res.body);
  }

  const cron = await call(app, "PUT", `${AGENT}/schedule`, { ...BODY, cronExpression: "whenever" });
  assert.equal(cron.statusCode, 400);
  assert.deepEqual(cron.json(), {
    error: "invalid_schedule",
    message: OWN_SCHEDULE_MESSAGES.invalidCron,
    reason: cron.json().reason,
    field: "cronExpression",
  });

  const place = await call(app, "PUT", `${AGENT}/schedule`, { ...BODY, deliver: { channelId: FOREIGN_SLACK } });
  assert.equal(place.statusCode, 400);
  assert.equal(place.json().error, "validation_failed");
  assert.equal(place.json().message, OWN_SCHEDULE_MESSAGES.placeNotFound);
  assert.deepEqual(place.json().fields, { "deliver.channelId": OWN_SCHEDULE_MESSAGES.placeNotFound });
  assert.ok(!place.body.includes("alertChannelId"), "the answer names the field as the request does");

  const limit = await call(app, "PUT", `${AGENT}/schedule`, { ...BODY, maxRetries: 9 });
  assert.equal(limit.statusCode, 400);
  assert.equal(limit.json().message, OWN_SCHEDULE_MESSAGES.retries);
  assert.equal(world.state.tasks.length, 0);

  for (const path of [`${FOREIGN_AGENT}/schedule`, `not-a-uuid/schedule`]) {
    const res = await call(app, "PUT", path, BODY);
    assert.equal(res.statusCode, 404, path);
    assert.deepEqual(res.json(), { error: "not_found", message: "Agent not found" });
    assert.equal((await call(app, "GET", path)).statusCode, 404);
  }
  // The other organization sees its own agent.
  assert.equal((await call(app, "GET", `${FOREIGN_AGENT}/schedule`, undefined, { "x-test-org": OTHER_ORG })).statusCode, 200);

  assert.equal((await call(app, "PUT", `${AGENT}/schedule`, BODY)).statusCode, 200);
  world.deps.transaction = (fn) => fn(world.deps.db);
  world.hooks.beforeUpdate = () => {
    world.state.tasks[0]!.timezone = "Asia/Tokyo";
  };
  const stale = await call(app, "PUT", `${AGENT}/schedule`, { ...BODY, prompt: "Mine." });
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.json(), { error: "schedule_changed", message: OWN_SCHEDULE_MESSAGES.changed });
  await app.close();
});

test("run now: 201 { run }, 409 already_running, 404 without a schedule", async () => {
  const own = task({ payload: { prompt: "Brief me.", deliver: { alertChannelId: SLACK } } });
  const { app, world } = await buildApp({ tasks: [own] });

  const started = await call(app, "POST", `${AGENT}/schedule/run`);
  assert.equal(started.statusCode, 201);
  const { run: view } = started.json();
  assert.deepEqual(Object.keys(view).sort(), [
    "delivery",
    "durationMs",
    "failure",
    "finishedAt",
    "id",
    "startedAt",
    "startedBy",
    "status",
    "text",
  ]);
  assert.equal(view.status, "finished");
  assert.equal(view.startedBy, "person");
  assert.equal(view.text, "Today's briefing.");
  assert.deepEqual(world.runNowCalls, [{ taskId: own.id, orgId: ORG }]);
  // The Scheduler's run delivers; the route does not deliver again.
  assert.equal(world.sends.length, 0);

  // A run that failed is still a run: 201, with a plain sentence.
  world.hooks.runNow = async (taskId) => ({
    execution: run(taskId, { status: "failed", error: taskTimeoutError(300_000), output: null, triggeredBy: "manual" }),
  });
  const failed = await call(app, "POST", `${AGENT}/schedule/run`);
  assert.equal(failed.statusCode, 201);
  assert.equal(failed.json().run.status, "did_not_finish");
  assert.equal(failed.json().run.failure, RUN_FAILURE_MESSAGES.timeLimit);
  assert.ok(!failed.body.includes("300000ms"));

  world.hooks.runNow = async () => {
    throw Object.assign(new Error("This task is already running; wait for it to finish or cancel that execution"), {
      name: "SchedulerError",
      status: 409,
      code: "already_running",
      extra: { executionId: "x" },
    });
  };
  const busy = await call(app, "POST", `${AGENT}/schedule/run`);
  assert.equal(busy.statusCode, 409);
  assert.deepEqual(busy.json(), {
    error: "already_running",
    message: "This agent is already running. Wait for it to finish.",
  });

  const none = await call(app, "POST", `${SECOND_AGENT}/schedule/run`);
  assert.equal(none.statusCode, 404);
  assert.deepEqual(none.json(), { error: "schedule_not_found", message: OWN_SCHEDULE_MESSAGES.notFound });
  assert.equal((await call(app, "POST", `${FOREIGN_AGENT}/schedule/run`)).statusCode, 404);
  await app.close();
});

test("runs: { runs, hasMore }, a limit and a cursor, and never the stored error or input", async () => {
  const own = task();
  const at = (day: number) => new Date(`2026-10-0${day}T09:00:00Z`);
  const { app } = await buildApp({
    tasks: [own],
    runs: [
      run(own.id, { createdAt: at(1) }),
      run(own.id, { createdAt: at(2), status: "failed", error: "ECONNREFUSED 10.1.2.3:5432", output: null }),
      run(own.id, { createdAt: at(3), status: "cancelled", error: "cancelled", output: null }),
    ],
  });

  const first = await call(app, "GET", `${AGENT}/runs?limit=2`);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().hasMore, true);
  assert.deepEqual(
    first.json().runs.map((r: { status: string; failure: string | null }) => [r.status, r.failure]),
    [
      ["stopped", null],
      ["did_not_finish", RUN_FAILURE_MESSAGES.other],
    ],
  );
  const next = await call(app, "GET", `${AGENT}/runs?limit=2&before=${first.json().runs[1].id}`);
  assert.equal(next.json().hasMore, false);
  assert.deepEqual(next.json().runs.map((r: { text: string }) => r.text), ["Today's briefing."]);
  for (const res of [first, next]) {
    assert.ok(!res.body.includes("10.1.2.3") && !res.body.includes("the stored input"));
  }

  assert.deepEqual((await call(app, "GET", `${SECOND_AGENT}/runs`)).json(), { runs: [], hasMore: false });
  for (const query of ["limit=0", "limit=101", "before=nope", "offset=3"]) {
    const res = await call(app, "GET", `${AGENT}/runs?${query}`);
    assert.equal(res.statusCode, 400, query);
    assert.equal(res.json().error, "validation_failed");
  }
  assert.equal((await call(app, "GET", `${FOREIGN_AGENT}/runs`)).statusCode, 404);
  await app.close();
});

test("send again: 200 { run }, 404, 409 run_not_finished, 400 no_place, 502 delivery_failed", async () => {
  const own = task({ payload: { prompt: "Brief me.", deliver: { alertChannelId: SLACK } } });
  const second = task({ agentId: SECOND_AGENT });
  const finished = run(own.id);
  const failed = run(own.id, { status: "failed", error: "x", output: null });
  const placeless = run(second.id);
  const { app, world } = await buildApp({ tasks: [own, second], runs: [finished, failed, placeless] });
  const deliver = (agentId: string, runId: string) => call(app, "POST", `${agentId}/runs/${runId}/deliver`);

  const sent = await deliver(AGENT, finished.id);
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.json().run.id, finished.id);
  assert.equal(sent.json().run.delivery.length, 1);
  assert.equal(sent.json().run.delivery[0].status, "sent");
  assertNoLinkOrAddress(sent.body);
  assert.equal(world.sends.length, 1);
  assert.equal(world.runNowCalls.length, 0);

  for (const [agentId, runId] of [
    [AGENT, placeless.id],
    [SECOND_AGENT, finished.id],
    [AGENT, "aaaaaaaa-0000-4000-8000-ffffffffffff"],
    [AGENT, "not-a-uuid"],
    [FOREIGN_AGENT, finished.id],
  ] as const) {
    const res = await deliver(agentId, runId);
    assert.equal(res.statusCode, 404, `${agentId} ${runId}`);
    assert.equal(res.json().error, "not_found");
  }

  const unfinished = await deliver(AGENT, failed.id);
  assert.equal(unfinished.statusCode, 409);
  assert.equal(unfinished.json().error, "run_not_finished");

  const noPlace = await deliver(SECOND_AGENT, placeless.id);
  assert.equal(noPlace.statusCode, 400);
  assert.equal(noPlace.json().error, "no_place");

  world.hooks.send = async () => {
    throw new ChannelDeliveryError("refused", `Slack responded 410 for ${SLACK_LINK}`);
  };
  const refused = await deliver(AGENT, finished.id);
  assert.equal(refused.statusCode, 502);
  assert.equal(refused.json().error, "delivery_failed");
  assert.equal(
    refused.json().message,
    "Not sent to Team Slack: it did not accept the message. The result is saved here.",
  );
  assert.deepEqual(refused.json().run.delivery.map((d: { status: string }) => d.status), ["sent", "failed"]);
  assertNoLinkOrAddress(refused.body);
  assert.equal(world.state.runs.find((r) => r.id === finished.id)!.status, "success");
  assert.equal(world.runNowCalls.length, 0);
  await app.close();
});
