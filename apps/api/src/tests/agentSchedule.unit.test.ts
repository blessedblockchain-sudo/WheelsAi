/**
 * services/agentSchedule.ts and buildAgentScheduleDeps.ts: an agent's own
 * schedule and its runs, as the agent page reads and changes them.
 *
 * The world (agentScheduleWorld.ts) applies the `where` the service sends,
 * so organization scoping and the compare-and-set are tested as queries.
 */
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { SHUTTING_DOWN } from "../services/agentChat.js";
import { OWN_SCHEDULE_MESSAGES, OwnScheduleError } from "../services/agentOwnSchedule.js";
import {
  AGENT_SCHEDULE_MESSAGES,
  AgentScheduleError,
  RUN_FAILURE_MESSAGES,
  deliveryListOf,
  getAgentSchedule,
  listAgentRuns,
  notSentMessage,
  putAgentSchedule,
  resendRunResult,
  runAgentScheduleNow,
  runFailureMessage,
  runStatusOf,
  startedByOf,
  suggestedOf,
  toRunView,
  type ResendDeps,
  type ScheduleBody,
} from "../services/agentSchedule.js";
import { buildAgentScheduleDeps, RUN_COLUMNS } from "../services/buildAgentScheduleDeps.js";
import { LOST_EXECUTION_ERROR } from "../services/buildSchedulerTickDeps.js";
import { CLIENT_GONE } from "../services/chatStreamSettlement.js";
import { MarketplaceLicenceRevokedError, MarketplacePaymentRequiredError } from "../services/marketplaceMetering.js";
import { isTaskTimeoutError, taskTimeoutError } from "../services/runSchedulerTick.js";
import { ChannelDeliveryError } from "../services/scheduledTasks/reportDelivery.js";
import { DELIVERY_REASONS } from "../services/scheduledTasks/resultDelivery.js";
import { FREE_TIER_LIMIT_MESSAGE } from "../services/sharedAgentChat.js";
import {
  AGENT,
  EMAIL,
  FOREIGN_AGENT,
  FOREIGN_SLACK,
  NOW,
  ORG,
  OTHER_ORG,
  SECOND_AGENT,
  SLACK,
  SLACK_LINK,
  ADDRESS,
  fakeWorld,
  run,
  task,
} from "./agentScheduleWorld.js";

const BODY: ScheduleBody = { enabled: true, cronExpression: "0 9 * * *", timezone: "Europe/Berlin" };

const refusal = async (promise: Promise<unknown>): Promise<AgentScheduleError | OwnScheduleError> => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AgentScheduleError || err instanceof OwnScheduleError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
};

/** Nothing of a place but its id, name and type may leave. */
const assertNoLinkOrAddress = (answer: unknown) => {
  const text = JSON.stringify(answer);
  for (const secret of [SLACK_LINK, "hooks.slack.com", "secret-token", ADDRESS, "webhookUrl", "emails"]) {
    assert.ok(!text.includes(secret), `the answer carries ${secret}`);
  }
};

// ============================================
// Reading
// ============================================

test("the oldest agent_run task is the page's; the others are only counted", async () => {
  const oldestReport = task({ taskType: "report", createdAt: new Date("2026-09-01T00:00:00Z") });
  const own = task({ createdAt: new Date("2026-09-10T00:00:00Z"), payload: { prompt: "Brief me.", stampTime: true } });
  const later = task({ createdAt: new Date("2026-09-20T00:00:00Z"), cronExpression: "0 18 * * *" });
  const world = fakeWorld({
    tasks: [
      later,
      own,
      oldestReport,
      task({ agentId: SECOND_AGENT, createdAt: new Date("2026-08-01T00:00:00Z") }),
      task({ orgId: OTHER_ORG, agentId: FOREIGN_AGENT, createdAt: new Date("2026-08-01T00:00:00Z") }),
    ],
  });

  const answer = await getAgentSchedule(world.deps, ORG, AGENT);
  assert.equal(answer.schedule?.id, own.id);
  assert.equal(answer.otherTasks, 2);
  assert.equal(answer.schedulerRunning, true);
  assert.equal(answer.suggested, null);
  assert.deepEqual(answer.schedule, {
    id: own.id,
    enabled: true,
    cronExpression: "0 9 * * *",
    timezone: "UTC",
    prompt: "Brief me.",
    stampTime: true,
    deliver: null,
    timeoutSeconds: 300,
    maxRetries: 1,
    nextRunAt: own.nextRunAt,
    lastRunAt: null,
    lastRunStatus: null,
  });
});

test("an agent with no schedule answers null, its suggestion and whether timed runs fire", async () => {
  const world = fakeWorld({ schedulerRunning: false });
  world.state.agents[0]!.kindConfig = {
    task: { fields: [] },
    scheduled: { schedule: { cronExpression: "0 7 * * 1-5", timezone: "Europe/Berlin" }, prompt: "Check prices.", extra: "x" },
  };
  assert.deepEqual(await getAgentSchedule(world.deps, ORG, AGENT), {
    schedule: null,
    suggested: { schedule: { cronExpression: "0 7 * * 1-5", timezone: "Europe/Berlin" }, prompt: "Check prices." },
    otherTasks: 0,
    schedulerRunning: false,
  });
  assert.equal(suggestedOf({ task: {} }), null);
  assert.equal(suggestedOf(null), null);
  assert.deepEqual(suggestedOf({ scheduled: {} }), {});
});

test("a scheduler state that cannot be read is answered as not running", async () => {
  const world = fakeWorld();
  world.deps.schedulerRunning = () => {
    throw new Error("no env");
  };
  assert.equal((await getAgentSchedule(world.deps, ORG, AGENT)).schedulerRunning, false);
});

test("another organization's agent is not found, for every call", async () => {
  const world = fakeWorld({ tasks: [task({ orgId: OTHER_ORG, agentId: FOREIGN_AGENT })] });
  for (const call of [
    getAgentSchedule(world.deps, ORG, FOREIGN_AGENT),
    putAgentSchedule(world.deps, ORG, FOREIGN_AGENT, BODY),
    runAgentScheduleNow(world.deps, ORG, FOREIGN_AGENT),
    listAgentRuns(world.deps, ORG, FOREIGN_AGENT),
    resendRunResult(world.deps, ORG, FOREIGN_AGENT, "aaaaaaaa-0000-4000-8000-000000000001"),
  ]) {
    const err = await refusal(call);
    assert.equal(err.status, 404);
    assert.equal(err.code, "not_found");
  }
  assert.equal(world.writes.length, 0);
  assert.equal(world.runNowCalls.length, 0);
});

// ============================================
// Writing
// ============================================

test("PUT creates the schedule, then updates it; the place is answered without its link", async () => {
  const world = fakeWorld();

  const created = await putAgentSchedule(world.deps, ORG, AGENT, { ...BODY, deliver: { channelId: SLACK } });
  assert.equal(world.state.tasks.length, 1);
  const stored = world.state.tasks[0]!;
  assert.equal(stored.name, "Morning Brief (schedule)");
  assert.equal(stored.agentId, AGENT);
  assert.equal(stored.taskType, "agent_run");
  assert.deepEqual((stored.payload as { deliver?: unknown }).deliver, { alertChannelId: SLACK });
  assert.equal(created.schedule?.id, stored.id);
  assert.equal(created.schedule?.enabled, true);
  assert.equal(created.schedule?.timezone, "Europe/Berlin");
  assert.equal(created.schedule?.stampTime, true);
  assert.equal(created.schedule?.maxRetries, 1);
  assert.equal(created.schedule?.timeoutSeconds, 300);
  assert.deepEqual(created.schedule?.deliver, { channelId: SLACK, name: "Team Slack", type: "slack" });
  assert.equal(created.otherTasks, 0);
  assertNoLinkOrAddress(created);

  const updated = await putAgentSchedule(world.deps, ORG, AGENT, {
    enabled: false,
    cronExpression: "30 18 * * 1-5",
    timezone: "Europe/Berlin",
    prompt: "Evening summary.",
    stampTime: false,
    deliver: null,
    timeoutSeconds: 60,
    maxRetries: 0,
  });
  assert.equal(world.state.tasks.length, 1, "an update makes no second task");
  assert.deepEqual(
    { ...updated.schedule, nextRunAt: undefined },
    {
      id: stored.id,
      enabled: false,
      cronExpression: "30 18 * * 1-5",
      timezone: "Europe/Berlin",
      prompt: "Evening summary.",
      stampTime: false,
      deliver: null,
      timeoutSeconds: 60,
      maxRetries: 0,
      nextRunAt: undefined,
      lastRunAt: null,
      lastRunStatus: null,
    },
  );
  assert.equal(world.state.tasks[0]!.status, "paused");
});

test("an agent of any kind may have a schedule, and a schedule can be created switched off", async () => {
  const world = fakeWorld();
  world.state.agents[0]!.kindConfig = { task: { fields: [] } };
  const answer = await putAgentSchedule(world.deps, ORG, AGENT, { enabled: false, cronExpression: "0 9 * * *" });
  assert.equal(answer.schedule?.enabled, false);
  assert.equal(answer.schedule?.timezone, "UTC");
  assert.equal(world.state.tasks[0]!.status, "paused");
});

test("a stale PUT is 409 schedule_changed and writes nothing", async () => {
  const own = task();
  const world = fakeWorld({ tasks: [own] });
  // The other request's write is committed: it is not this transaction's to undo.
  world.deps.transaction = (fn) => fn(world.deps.db);
  // Another request changes the times between this one's read and its write.
  world.hooks.beforeUpdate = () => {
    world.state.tasks[0]!.cronExpression = "0 6 * * *";
  };
  const err = await refusal(putAgentSchedule(world.deps, ORG, AGENT, { ...BODY, prompt: "Mine." }));
  assert.equal(err.status, 409);
  assert.equal(err.code, "schedule_changed");
  assert.equal(err.message, OWN_SCHEDULE_MESSAGES.changed);
  assert.equal(world.writes.length, 0);
  assert.equal(world.state.tasks[0]!.cronExpression, "0 6 * * *");
  assert.deepEqual(world.state.tasks[0]!.payload, { prompt: "Brief me." });
});

test("a schedule another request created meanwhile is 409, and no second task is made", async () => {
  const world = fakeWorld();
  const transaction = world.deps.transaction;
  world.deps.transaction = async (fn) => {
    world.state.tasks.push(task({ name: "Made first" }));
    return transaction(fn);
  };
  const err = await refusal(putAgentSchedule(world.deps, ORG, AGENT, BODY));
  assert.equal(err.code, "schedule_changed");
  assert.equal(world.state.tasks.length, 1);
});

test("a lost race for the task's name runs the create again", async () => {
  const world = fakeWorld();
  const transaction = world.deps.transaction;
  let first = true;
  world.deps.transaction = async (fn) => {
    if (first) {
      first = false;
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target: ["org_id", "name"] } });
    }
    return transaction(fn);
  };
  const answer = await putAgentSchedule(world.deps, ORG, AGENT, BODY);
  assert.ok(answer.schedule);
  assert.equal(world.state.tasks.length, 1);
});

test("PUT refusals: unreadable times, a place of another organization, limits; nothing is written", async () => {
  const world = fakeWorld();

  const times = await refusal(putAgentSchedule(world.deps, ORG, AGENT, { ...BODY, cronExpression: "every day" }));
  assert.equal(times.status, 400);
  assert.equal(times.code, "invalid_schedule");
  assert.equal(times.message, OWN_SCHEDULE_MESSAGES.invalidCron);

  const zone = await refusal(putAgentSchedule(world.deps, ORG, AGENT, { ...BODY, timezone: "Mars/Olympus" }));
  assert.equal(zone.code, "invalid_schedule");
  assert.equal(zone.message, OWN_SCHEDULE_MESSAGES.invalidTimezone);

  const place = (await refusal(
    putAgentSchedule(world.deps, ORG, AGENT, { ...BODY, deliver: { channelId: FOREIGN_SLACK } }),
  )) as OwnScheduleError;
  assert.equal(place.status, 400);
  assert.equal(place.code, "validation_failed");
  assert.equal(place.body?.message, OWN_SCHEDULE_MESSAGES.placeNotFound);
  // Named as the request names it, never by the stored payload's name.
  assert.deepEqual(place.body?.fields, { "deliver.channelId": OWN_SCHEDULE_MESSAGES.placeNotFound });
  assert.equal(place.extra.field, "deliver.channelId");

  const limit = (await refusal(putAgentSchedule(world.deps, ORG, AGENT, { ...BODY, timeoutSeconds: 2 }))) as OwnScheduleError;
  assert.equal(limit.code, "validation_failed");
  assert.equal(limit.body?.message, OWN_SCHEDULE_MESSAGES.timeout);

  assert.equal(world.state.tasks.length, 0);
  assert.equal(world.writes.length, 0);
});

test("every place refusal on PUT names the field deliver.channelId, on a create and on a change", async () => {
  const pagerduty = "88888888-8888-4888-8888-888888888888";
  const channels = (world: ReturnType<typeof fakeWorld>) =>
    world.state.channels.push({ id: pagerduty, orgId: ORG, name: "On call", type: "pagerduty", isEnabled: true, config: {} });
  const cases: Array<[string, string, string]> = [
    ["unknown", FOREIGN_SLACK, OWN_SCHEDULE_MESSAGES.placeNotFound],
    ["unsupported", pagerduty, OWN_SCHEDULE_MESSAGES.placeUnsupported],
    ["email while email is off", EMAIL, OWN_SCHEDULE_MESSAGES.emailOff],
  ];
  for (const existing of [false, true]) {
    for (const [what, channelId, message] of cases) {
      const world = fakeWorld({ tasks: existing ? [task()] : [], emailConfigured: false });
      channels(world);
      const err = (await refusal(
        putAgentSchedule(world.deps, ORG, AGENT, { ...BODY, deliver: { channelId } }),
      )) as OwnScheduleError;
      const label = `${what}, ${existing ? "change" : "create"}`;
      assert.ok(err instanceof OwnScheduleError, label);
      assert.equal(err.status, 400, label);
      assert.equal(err.code, "validation_failed", label);
      assert.deepEqual(err.body?.fields, { "deliver.channelId": message }, label);
      assert.equal(err.body?.message, message, label);
      assert.ok(!JSON.stringify({ body: err.body, extra: err.extra }).includes("alertChannelId"), label);
      assert.equal(world.writes.length, 0, label);
    }
  }
});

test("two first saves at the same moment make one schedule and one 409, even across a rename", async () => {
  // The same name: the second save waits for the first and then sees its schedule.
  const same = fakeWorld();
  const both = await Promise.allSettled([
    putAgentSchedule(same.deps, ORG, AGENT, BODY),
    putAgentSchedule(same.deps, ORG, AGENT, BODY),
  ]);
  assert.equal(same.state.tasks.length, 1);
  assert.deepEqual(both.map((s) => s.status).sort(), ["fulfilled", "rejected"]);
  const lost = (both.find((s) => s.status === "rejected") as PromiseRejectedResult).reason as OwnScheduleError;
  assert.equal(lost.status, 409);
  assert.equal(lost.code, "schedule_changed");

  // The agent is renamed between the two requests' reads, so the two would
  // pick different names and the unique name could not stop the second.
  const world = fakeWorld();
  const first = putAgentSchedule(world.deps, ORG, AGENT, BODY);
  world.state.agents.find((a) => a.id === AGENT)!.name = "Evening Brief";
  const second = putAgentSchedule(world.deps, ORG, AGENT, BODY);
  const settled = await Promise.allSettled([first, second]);

  assert.equal(world.state.tasks.length, 1, "one schedule");
  assert.equal(world.writes.filter((w) => w.op === "create").length, 1, "one insert");
  assert.deepEqual(settled.map((s) => s.status).sort(), ["fulfilled", "rejected"]);
  const refused = (settled.find((s) => s.status === "rejected") as PromiseRejectedResult).reason as OwnScheduleError;
  assert.ok(refused instanceof OwnScheduleError);
  assert.equal(refused.status, 409);
  assert.equal(refused.code, "schedule_changed");
  assert.equal(refused.message, OWN_SCHEDULE_MESSAGES.changed);
  // Named from the agent as it is under the lock.
  assert.equal(world.state.tasks[0]!.name, "Evening Brief (schedule)");

  // An agent deleted between the read and the transaction is not found; nothing is written.
  const gone = fakeWorld();
  const late = putAgentSchedule(gone.deps, ORG, AGENT, BODY);
  gone.state.agents = gone.state.agents.filter((a) => a.id !== AGENT);
  const missing = await refusal(late);
  assert.equal(missing.status, 404);
  assert.equal(missing.code, "not_found");
  assert.equal(gone.state.tasks.length, 0);
});

test("email off refuses a newly chosen email place, not one that was already saved", async () => {
  const own = task({ payload: { prompt: "Brief me.", deliver: { alertChannelId: EMAIL } } });
  const world = fakeWorld({ tasks: [own], emailConfigured: false });

  const kept = await putAgentSchedule(world.deps, ORG, AGENT, { ...BODY, deliver: { channelId: EMAIL } });
  assert.deepEqual(kept.schedule?.deliver, { channelId: EMAIL, name: "Email to me", type: "email" });
  assertNoLinkOrAddress(kept);

  const fresh = fakeWorld({ tasks: [task()], emailConfigured: false });
  const err = (await refusal(
    putAgentSchedule(fresh.deps, ORG, AGENT, { ...BODY, deliver: { channelId: EMAIL } }),
  )) as OwnScheduleError;
  assert.equal(err.body?.message, OWN_SCHEDULE_MESSAGES.emailOff);
});

test("a place that was removed since it was chosen is answered by its id alone", async () => {
  const gone = "55555555-5555-4555-8555-555555555555";
  const world = fakeWorld({ tasks: [task({ payload: { prompt: "p", deliver: { alertChannelId: gone } } })] });
  assert.deepEqual((await getAgentSchedule(world.deps, ORG, AGENT)).schedule?.deliver, {
    channelId: gone,
    name: "",
    type: "unknown",
  });
});

// ============================================
// Status and failure
// ============================================

test("the stored status maps to the four words", () => {
  assert.equal(runStatusOf("pending"), "running");
  assert.equal(runStatusOf("running"), "running");
  assert.equal(runStatusOf("success"), "finished");
  assert.equal(runStatusOf("failed"), "did_not_finish");
  assert.equal(runStatusOf("timeout"), "did_not_finish");
  assert.equal(runStatusOf("cancelled"), "stopped");
  assert.equal(runStatusOf("something new"), "did_not_finish");
  assert.equal(startedByOf("manual"), "person");
  assert.equal(startedByOf("schedule"), "schedule");
  assert.equal(startedByOf("scheduler"), "schedule");
});

test("every stored error ends as one of the plain sentences, never as itself", () => {
  assert.equal(isTaskTimeoutError(taskTimeoutError(1)), true);
  assert.equal(isTaskTimeoutError("the tool timed out after 30000ms"), false);
  assert.equal(isTaskTimeoutError(null), false);
  const cases: Array<[string | null, string]> = [
    // What the tick stores for a run past its limit, from the builder that stores it.
    [taskTimeoutError(300_000), RUN_FAILURE_MESSAGES.timeLimit],
    [taskTimeoutError(5_000), RUN_FAILURE_MESSAGES.timeLimit],
    [LOST_EXECUTION_ERROR, RUN_FAILURE_MESSAGES.interrupted],
    [SHUTTING_DOWN, RUN_FAILURE_MESSAGES.interrupted],
    [CLIENT_GONE, RUN_FAILURE_MESSAGES.interrupted],
    ["The operation was aborted", RUN_FAILURE_MESSAGES.interrupted],
    [FREE_TIER_LIMIT_MESSAGE, RUN_FAILURE_MESSAGES.freeModelLimit],
    [
      "No model is available for this agent right now. Nothing was charged. Try again later.",
      RUN_FAILURE_MESSAGES.noModel,
    ],
    ['The deployment "llama" has no healthy node right now. Retry shortly.', RUN_FAILURE_MESSAGES.noModel],
    ["the model call failed", RUN_FAILURE_MESSAGES.other],
    // Only the scheduler's own time limit is "its time limit": a provider or
    // a tool that timed out inside the run is a run that could not be completed.
    ["Request timed out.", RUN_FAILURE_MESSAGES.other],
    ["The model provider timed out after 60000ms", RUN_FAILURE_MESSAGES.other],
    ["upstream timeout", RUN_FAILURE_MESSAGES.other],
    ["the run hit the provider's time limit", RUN_FAILURE_MESSAGES.other],
    ["workflow timed out after 12345ms", RUN_FAILURE_MESSAGES.other],
    // A buyer's copy that was refused: the plan words no sentence of its own for these.
    [new MarketplaceLicenceRevokedError("Brief Bot", "subscription_lapsed").message, RUN_FAILURE_MESSAGES.other],
    [
      new MarketplacePaymentRequiredError({ requiredCents: 5n, balanceCents: 0n, listingTitle: "Brief Bot" }).message,
      RUN_FAILURE_MESSAGES.other,
    ],
    ['PrismaClientKnownRequestError: relation "agents" does not exist', RUN_FAILURE_MESSAGES.other],
    ["agent 1111 not found in this organization", RUN_FAILURE_MESSAGES.other],
    ["", RUN_FAILURE_MESSAGES.other],
    [null, RUN_FAILURE_MESSAGES.other],
  ];
  const sentences = new Set<string>(Object.values(RUN_FAILURE_MESSAGES));
  for (const [stored, sentence] of cases) {
    const message = runFailureMessage(stored);
    assert.equal(message, sentence, `for ${stored}`);
    assert.ok(sentences.has(message));
    if (stored) assert.notEqual(message, stored);
  }
});

test("a run shows its text only when finished and its failure only when it did not finish", () => {
  const base = run("t");
  const finished = toRunView(base);
  assert.equal(finished.status, "finished");
  assert.equal(finished.text, "Today's briefing.");
  assert.equal(finished.failure, null);
  assert.equal(finished.startedBy, "schedule");
  assert.deepEqual(finished.delivery, []);
  assert.ok(!("input" in finished) && !("output" in finished) && !("error" in finished));

  const failed = toRunView({ ...base, status: "failed", output: { content: "partial" }, error: "ECONNRESET at 10.0.0.3" });
  assert.equal(failed.status, "did_not_finish");
  assert.equal(failed.text, null);
  assert.equal(failed.failure, RUN_FAILURE_MESSAGES.other);
  assert.ok(!JSON.stringify(failed).includes("10.0.0.3"));

  const stopped = toRunView({ ...base, status: "cancelled", error: "cancelled" });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.failure, null);

  const running = toRunView({ ...base, status: "running", startedAt: null, completedAt: null, durationMs: null });
  assert.equal(running.status, "running");
  assert.equal(running.finishedAt, null);
  assert.deepEqual(running.startedAt, base.createdAt);
});

test("a stored delivery list is copied field by field", () => {
  assert.deepEqual(deliveryListOf(null), []);
  assert.deepEqual(deliveryListOf({ not: "a list" }), []);
  assert.deepEqual(
    deliveryListOf([
      { channelId: SLACK, name: "Team Slack", type: "slack", status: "sent", at: "2026-10-05T09:00:06.000Z", webhookUrl: SLACK_LINK },
      { channelId: SLACK, name: "Team Slack", type: "slack", status: "failed", reason: DELIVERY_REASONS.refused, at: "x" },
      { status: "sent" },
      "junk",
    ]),
    [
      { channelId: SLACK, name: "Team Slack", type: "slack", status: "sent", at: "2026-10-05T09:00:06.000Z" },
      { channelId: SLACK, name: "Team Slack", type: "slack", status: "failed", reason: DELIVERY_REASONS.refused, at: "x" },
    ],
  );
});

// ============================================
// Runs
// ============================================

test("runs are the own schedule's only, newest first, a page at a time", async () => {
  const own = task({ createdAt: new Date("2026-09-10T00:00:00Z") });
  const other = task({ createdAt: new Date("2026-09-20T00:00:00Z") });
  const at = (day: number) => new Date(`2026-10-0${day}T09:00:00Z`);
  const world = fakeWorld({
    tasks: [own, other],
    runs: [
      run(own.id, { createdAt: at(1), output: { content: "one" } }),
      run(own.id, { createdAt: at(3), status: "failed", error: taskTimeoutError(300_000), output: null }),
      run(own.id, { createdAt: at(2), output: { content: "two" }, triggeredBy: "manual" }),
      run(other.id, { createdAt: at(4), output: { content: "another task's" } }),
    ],
  });

  const first = await listAgentRuns(world.deps, ORG, AGENT, { limit: 2 });
  assert.equal(first.hasMore, true);
  assert.deepEqual(
    first.runs.map((r) => [r.status, r.text, r.failure, r.startedBy]),
    [
      ["did_not_finish", null, RUN_FAILURE_MESSAGES.timeLimit, "schedule"],
      ["finished", "two", null, "person"],
    ],
  );
  const second = await listAgentRuns(world.deps, ORG, AGENT, { limit: 2, before: first.runs[1]!.id });
  assert.equal(second.hasMore, false);
  assert.deepEqual(second.runs.map((r) => r.text), ["one"]);
  assert.ok(!JSON.stringify([first, second]).includes("the stored input"));

  assert.deepEqual(await listAgentRuns(world.deps, ORG, SECOND_AGENT), { runs: [], hasMore: false });
});

test("run now is the Scheduler's own: called with the schedule's id, and its refusals are worded", async () => {
  const own = task();
  const world = fakeWorld({ tasks: [own, task({ createdAt: new Date("2026-10-02T00:00:00Z") })] });

  const { run: started } = await runAgentScheduleNow(world.deps, ORG, AGENT);
  assert.deepEqual(world.runNowCalls, [{ taskId: own.id, orgId: ORG }]);
  assert.equal(started.startedBy, "person");
  assert.equal(started.status, "finished");
  assert.equal(world.writes.length, 0, "the service writes nothing itself");

  world.hooks.runNow = async () => {
    throw Object.assign(new Error("This task is already running; wait for it to finish or cancel that execution"), {
      name: "SchedulerError",
      status: 409,
      code: "already_running",
    });
  };
  const busy = await refusal(runAgentScheduleNow(world.deps, ORG, AGENT));
  assert.equal(busy.status, 409);
  assert.equal(busy.code, "already_running");
  assert.equal(busy.message, "This agent is already running. Wait for it to finish.");

  world.hooks.runNow = async () => {
    throw new Error("database down");
  };
  await assert.rejects(runAgentScheduleNow(world.deps, ORG, AGENT), /database down/);

  const none = await refusal(runAgentScheduleNow(world.deps, ORG, SECOND_AGENT));
  assert.equal(none.status, 404);
  assert.equal(none.code, "schedule_not_found");
  assert.equal(none.message, OWN_SCHEDULE_MESSAGES.notFound);
});

// ============================================
// Send again
// ============================================

/** The slice "Send again" is given: there is no executor and no chat core in it. */
function resendDeps(world: ReturnType<typeof fakeWorld>): ResendDeps {
  const { db, loadAgent, runs, delivery } = world.deps;
  return { db, loadAgent, runs, delivery };
}

test("send again posts the stored result, runs nothing and appends a record", async () => {
  const own = task({ payload: { prompt: "Brief me.", deliver: { alertChannelId: SLACK } } });
  const earlier = { channelId: SLACK, name: "Team Slack", type: "slack", status: "failed", reason: DELIVERY_REASONS.refused, at: "2026-10-05T09:00:06.000Z" };
  const finished = run(own.id, { delivery: [earlier] });
  const world = fakeWorld({ tasks: [own], runs: [finished] });

  const { run: view } = await resendRunResult(resendDeps(world), ORG, AGENT, finished.id);

  assert.equal(world.runNowCalls.length, 0);
  assert.equal(world.sends.length, 1);
  assert.equal(world.sends[0]!.channelId, SLACK);
  assert.equal(world.sends[0]!.message.text, "Today's briefing.");
  assert.equal(world.sends[0]!.message.kind, "result");
  assert.equal(world.sends[0]!.message.executionId, finished.id);
  assert.deepEqual(view.delivery, [
    earlier,
    { channelId: SLACK, name: "Team Slack", type: "slack", status: "sent", at: NOW.toISOString() },
  ]);
  assert.deepEqual(world.state.runs[0]!.delivery, view.delivery);
  assert.equal(world.state.runs[0]!.status, "success");
  assert.deepEqual(world.writes.map((w) => w.op), ["appendDelivery"]);
  assertNoLinkOrAddress(view);
});

test("a place that does not take it is 502 delivery_failed, with the record stored and the run unchanged", async () => {
  const own = task({ payload: { prompt: "Brief me.", deliver: { alertChannelId: SLACK } } });
  const finished = run(own.id);
  const world = fakeWorld({ tasks: [own], runs: [finished] });
  world.hooks.send = async () => {
    throw new ChannelDeliveryError("refused", `Slack responded 404 for ${SLACK_LINK}`);
  };

  const err = (await refusal(resendRunResult(resendDeps(world), ORG, AGENT, finished.id))) as AgentScheduleError;
  assert.equal(err.status, 502);
  assert.equal(err.code, "delivery_failed");
  assert.equal(err.message, "Not sent to Team Slack: it did not accept the message. The result is saved here.");
  assertNoLinkOrAddress({ message: err.message, extra: err.extra });
  const stored = world.state.runs[0]!;
  assert.equal(stored.status, "success");
  assert.deepEqual(stored.delivery, [
    { channelId: SLACK, name: "Team Slack", type: "slack", status: "failed", reason: DELIVERY_REASONS.refused, at: NOW.toISOString() },
  ]);
  assert.deepEqual((err.extra.run as { delivery: unknown }).delivery, stored.delivery);
  assert.equal(world.runNowCalls.length, 0);

  assert.equal(notSentMessage({ name: "", reason: DELIVERY_REASONS.emailOff }), "Not sent: email delivery is temporarily unavailable. The result is saved here.");
});

test("send again refuses a run that is not this schedule's, is not finished, or has no place", async () => {
  const own = task({ payload: { prompt: "Brief me.", deliver: { alertChannelId: SLACK } } });
  const otherTask = task({ createdAt: new Date("2026-10-02T00:00:00Z"), payload: { prompt: "p", deliver: { alertChannelId: SLACK } } });
  const second = task({ agentId: SECOND_AGENT, payload: { prompt: "p", deliver: { alertChannelId: SLACK } } });
  const foreign = task({ orgId: OTHER_ORG, agentId: FOREIGN_AGENT, payload: { prompt: "p", deliver: { alertChannelId: FOREIGN_SLACK } } });
  const failed = run(own.id, { status: "failed", error: "x", output: null });
  const running = run(own.id, { status: "running", completedAt: null });
  const ofOtherTask = run(otherTask.id);
  const ofSecondAgent = run(second.id);
  const ofForeign = run(foreign.id);
  const world = fakeWorld({
    tasks: [own, otherTask, second, foreign],
    runs: [failed, running, ofOtherTask, ofSecondAgent, ofForeign],
  });
  const deps = resendDeps(world);

  for (const id of [ofOtherTask.id, ofSecondAgent.id, ofForeign.id, "aaaaaaaa-0000-4000-8000-ffffffffffff"]) {
    const err = await refusal(resendRunResult(deps, ORG, AGENT, id));
    assert.equal(err.status, 404, id);
    assert.equal(err.message, AGENT_SCHEDULE_MESSAGES.runNotFound);
  }
  // The other organization's run, asked for through its own agent's id.
  assert.equal((await refusal(resendRunResult(deps, ORG, FOREIGN_AGENT, ofForeign.id))).status, 404);

  for (const id of [failed.id, running.id]) {
    const err = await refusal(resendRunResult(deps, ORG, AGENT, id));
    assert.equal(err.status, 409);
    assert.equal(err.code, "run_not_finished");
  }

  const bare = fakeWorld({ tasks: [task()] });
  const done = run(bare.state.tasks[0]!.id);
  bare.state.runs.push(done);
  const noPlace = await refusal(resendRunResult(resendDeps(bare), ORG, AGENT, done.id));
  assert.equal(noPlace.status, 400);
  assert.equal(noPlace.code, "no_place");

  assert.equal(world.sends.length + bare.sends.length, 0);
  assert.equal(world.writes.length + bare.writes.length, 0);
});

// ============================================
// Production wiring
// ============================================

test("the wiring runs through the Scheduler's own run now and never selects a place's config", async () => {
  const calls: Array<{ op: string; args: unknown }> = [];
  const note = (op: string, result: unknown) => async (args: unknown) => {
    calls.push({ op, args });
    return result;
  };
  const execution = run("t", { triggeredBy: "manual" });
  const prisma = {
    agent: { findFirst: note("agent.findFirst", { id: AGENT, name: "A", kindConfig: null }) },
    alertChannel: { findFirst: note("alertChannel.findFirst", { id: SLACK, name: "Team Slack", type: "slack" }) },
    taskExecution: { findMany: note("taskExecution.findMany", []), findFirst: note("taskExecution.findFirst", null) },
    scheduledTask: {},
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ marker: "tx" }),
    $executeRaw: note("$executeRaw", 1),
  };
  const triggered: unknown[] = [];
  const deps = buildAgentScheduleDeps({
    prisma: prisma as never,
    scheduler: async () => ({
      triggerTask: async (taskId, orgId) => {
        triggered.push([taskId, orgId]);
        return { execution, deferred: false };
      },
      getTaskTypes: () => ({ schedulerEnabled: false }),
    }),
    emailConfigured: () => true,
  });

  assert.equal((await deps.runNow("task-1", ORG)).execution.id, execution.id);
  assert.deepEqual(triggered, [["task-1", ORG]]);
  assert.equal(await deps.schedulerRunning(), false);

  await deps.loadAgent({ orgId: ORG, agentId: AGENT });
  await deps.loadPlace(SLACK, ORG);
  await deps.runs.list({ taskId: "task-1", limit: 3, before: "run-9" });
  await deps.runs.find({ taskId: "task-1", runId: "run-1" });
  assert.equal(await deps.runs.appendDelivery({ taskId: "task-1", runId: "run-1", records: [] }), true);
  assert.deepEqual(await deps.transaction(async (tx) => tx as unknown), { marker: "tx" });

  const by = (op: string) => calls.find((c) => c.op === op)!.args as Record<string, unknown>;
  assert.deepEqual(by("agent.findFirst").where, { id: AGENT, orgId: ORG });
  assert.deepEqual(by("alertChannel.findFirst"), {
    where: { id: SLACK, orgId: ORG },
    select: { id: true, name: true, type: true },
  });
  assert.deepEqual(by("taskExecution.findMany"), {
    where: { taskId: "task-1" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 3,
    cursor: { id: "run-9" },
    skip: 1,
    select: RUN_COLUMNS,
  });
  assert.deepEqual(by("taskExecution.findFirst").where, { id: "run-1", taskId: "task-1" });
  assert.ok(!("input" in RUN_COLUMNS) && !("logs" in RUN_COLUMNS));
  const sql = JSON.stringify(by("$executeRaw"));
  assert.match(sql, /task_executions/);
  assert.match(sql, /status.*=.*'success'/);
});
