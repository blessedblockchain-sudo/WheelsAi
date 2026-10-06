import assert from "node:assert/strict";
import test from "node:test";

// Drives services/scheduledTaskTypes.ts: the registry that decides which
// task types exist, what each needs, and what GET /task-types lists. The
// dashboard once offered six types over an executor that ran two; a type
// now exists only by being registered, and one that cannot work on this
// server is listed as unavailable with the reason, never hidden.

import {
  EMAIL_UNAVAILABLE_REASON,
  RESTART_UNAVAILABLE_REASON,
  TASK_TYPE_IDS,
  WORKFLOW_RUNNER_UNAVAILABLE_REASON,
  getTaskType,
  listTaskTypes,
  taskTypeCatalogue,
  validateTask,
  type TaskCandidate,
  type TaskOwnershipLoader,
  type TaskTypeCapabilities,
  type TaskVerdict,
} from "../services/scheduledTaskTypes.js";

const NOW = new Date("2026-10-06T12:00:00Z");
const AGENT = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "99999999-9999-4999-8999-999999999999";
const WORKFLOW = "22222222-2222-4222-8222-222222222222";
const KB = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT = "44444444-4444-4444-8444-444444444444";
const MONITOR = "55555555-5555-4555-8555-555555555555";
const CHANNEL = "66666666-6666-4666-8666-666666666666";

const ALL: TaskTypeCapabilities = {
  workflowRunnerEnabled: true,
  emailConfigured: true,
  deploymentRestartAvailable: true,
};
const NONE: TaskTypeCapabilities = {
  workflowRunnerEnabled: false,
  emailConfigured: false,
  deploymentRestartAvailable: false,
};

/** An organization that owns exactly the ids above. */
function owns(overrides: Partial<TaskOwnershipLoader> = {}): TaskOwnershipLoader {
  const only = (id: string) => async (asked: string) => (asked === id ? { id } : null);
  return {
    agent: async (id) => (id === AGENT ? { knowledgeBaseId: KB } : null),
    orchestration: only(WORKFLOW),
    knowledgeBase: only(KB),
    deployment: only(DEPLOYMENT),
    monitor: only(MONITOR),
    alertChannel: async (id) => (id === CHANNEL ? { type: "slack" } : null),
    ...overrides,
  };
}

const schedule = { scheduleType: "interval", intervalSeconds: 3600 } as const;

function check(
  candidate: Partial<TaskCandidate> & { taskType: string },
  options: { capabilities?: TaskTypeCapabilities; owns?: TaskOwnershipLoader; checkSchedule?: boolean } = {},
): Promise<TaskVerdict> {
  return validateTask(
    { ...schedule, ...candidate },
    {
      now: NOW,
      capabilities: options.capabilities ?? ALL,
      owns: options.owns ?? owns(),
      checkSchedule: options.checkSchedule,
    },
  );
}

function refusal(verdict: TaskVerdict) {
  assert.equal(verdict.ok, false, JSON.stringify(verdict));
  return (verdict as Extract<TaskVerdict, { ok: false }>).refusal;
}
function accepted(verdict: TaskVerdict) {
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  return verdict as Extract<TaskVerdict, { ok: true }>;
}
function fieldErrors(verdict: TaskVerdict): Record<string, string[]> {
  const r = refusal(verdict);
  assert.equal(r.error, "validation_failed");
  return (r as Extract<typeof r, { error: "validation_failed" }>).details.fieldErrors;
}

// ============================================
// The registry and the catalogue
// ============================================

test("every type has a payload schema, an agent rule, a workflow rule and form fields", () => {
  assert.deepEqual(listTaskTypes().map((t) => t.type).sort(), [...TASK_TYPE_IDS].sort());
  for (const def of listTaskTypes()) {
    assert.equal(typeof def.payload.safeParse, "function", def.type);
    assert.ok(["required", "optional", "none"].includes(def.agent), def.type);
    assert.equal(typeof def.orchestration, "boolean", def.type);
    assert.ok(def.label && def.description, def.type);
    assert.ok(Array.isArray(def.fields(ALL)), def.type);
  }
  assert.equal(getTaskType("made_up"), undefined);
});

test("the agent and workflow rules per type", () => {
  const rule = (type: string) => {
    const def = getTaskType(type)!;
    return [def.agent, def.orchestration, def.deferred, def.retryable];
  };
  assert.deepEqual(rule("agent_run"), ["required", false, false, true]);
  assert.deepEqual(rule("inference"), ["required", false, false, true]);
  assert.deepEqual(rule("webhook"), ["none", false, false, true]);
  assert.deepEqual(rule("data_sync"), ["optional", false, false, true]);
  assert.deepEqual(rule("health_check"), ["optional", false, false, false]);
  assert.deepEqual(rule("report"), ["optional", false, false, true]);
  assert.deepEqual(rule("cleanup"), ["optional", false, false, true]);
  assert.deepEqual(rule("custom"), ["required", false, false, true]);
  assert.deepEqual(rule("workflow_run"), ["none", true, true, false]);
  assert.equal(getTaskType("inference")!.aliasOf, "agent_run");
});

test("the catalogue lists every type on a fully configured server, all available", () => {
  const catalogue = taskTypeCatalogue(ALL);
  assert.deepEqual(catalogue.map((t) => t.type).sort(), [...TASK_TYPE_IDS].sort());
  assert.ok(catalogue.every((t) => t.available && t.reason === undefined));
});

test("nothing is hidden on an unconfigured server: unavailable types and options carry a reason", () => {
  const catalogue = taskTypeCatalogue(NONE);
  assert.equal(catalogue.length, TASK_TYPE_IDS.length, "every type is still listed");

  const workflow = catalogue.find((t) => t.type === "workflow_run")!;
  assert.equal(workflow.available, false);
  assert.equal(workflow.reason, WORKFLOW_RUNNER_UNAVAILABLE_REASON);

  const health = catalogue.find((t) => t.type === "health_check")!;
  assert.equal(health.available, true, "the check itself works; only the restart action does not");
  const restart = health.fields
    .find((f) => f.key === "onDown")!
    .options!.find((o) => o.value === "restart_deployment")!;
  assert.deepEqual(
    { available: restart.available, reason: restart.reason },
    { available: false, reason: RESTART_UNAVAILABLE_REASON },
  );

  const report = catalogue.find((t) => t.type === "report")!;
  assert.match(report.fields.find((f) => f.key === "deliver.alertChannelId")!.help!, /email delivery is not configured/);
});

// ============================================
// Saving a task
// ============================================

test("an unknown task type is refused naming the known ones", async () => {
  const errors = fieldErrors(await check({ taskType: "telepathy" }));
  assert.match(errors.taskType![0]!, /unknown task type "telepathy"/);
  assert.match(errors.taskType![0]!, /workflow_run/);
});

test("agent_run requires an agent and a prompt; payload errors are keyed by field", async () => {
  const noAgent = refusal(await check({ taskType: "agent_run", payload: { prompt: "hi" } }));
  assert.deepEqual(
    { error: noAgent.error, field: (noAgent as { field?: string }).field },
    { error: "invalid_task", field: "agentId" },
  );

  const errors = fieldErrors(await check({ taskType: "agent_run", agentId: AGENT, payload: {} }));
  assert.deepEqual(Object.keys(errors), ["payload.prompt"]);

  const unknownKey = fieldErrors(
    await check({ taskType: "agent_run", agentId: AGENT, payload: { prompt: "hi", model: "gpt" } }),
  );
  assert.ok(unknownKey.payload, "an unknown payload key is refused, not silently ignored");

  accepted(await check({ taskType: "agent_run", agentId: AGENT, payload: { prompt: "hi" } }));
});

test("a webhook needs no agent, and its url error is keyed payload.url", async () => {
  accepted(await check({ taskType: "webhook", payload: { url: "https://example.com/hook" } }));
  const errors = fieldErrors(await check({ taskType: "webhook", payload: { url: "ftp://example.com" } }));
  assert.deepEqual(Object.keys(errors), ["payload.url"]);
  assert.deepEqual(Object.keys(fieldErrors(await check({ taskType: "webhook", payload: {} }))), ["payload.url"]);
});

test("workflow_run requires a workflow in the organization and refuses retries", async () => {
  const none = refusal(await check({ taskType: "workflow_run" }));
  assert.equal((none as { field?: string }).field, "orchestrationId");

  const foreign = refusal(await check({ taskType: "workflow_run", orchestrationId: FOREIGN }));
  assert.deepEqual(
    { error: foreign.error, message: foreign.message },
    { error: "invalid_task", message: "workflow not found in this organization" },
  );

  const retried = fieldErrors(
    await check({ taskType: "workflow_run", orchestrationId: WORKFLOW, maxRetries: 2 }),
  );
  assert.match(retried.maxRetries![0]!, /maxRetries must be 0/);

  const ok = accepted(await check({ taskType: "workflow_run", orchestrationId: WORKFLOW }));
  assert.equal(ok.maxRetries, 0, "the default for a type that is not retried");

  // Only a workflow_run runs a workflow.
  const stray = refusal(
    await check({ taskType: "webhook", orchestrationId: WORKFLOW, payload: { url: "https://example.com" } }),
  );
  assert.equal((stray as { field?: string }).field, "orchestrationId");
});

test("a type that is unavailable on this server is refused with its reason when saved", async () => {
  const errors = fieldErrors(
    await check({ taskType: "workflow_run", orchestrationId: WORKFLOW }, { capabilities: NONE }),
  );
  assert.deepEqual(errors.taskType, [WORKFLOW_RUNNER_UNAVAILABLE_REASON]);
});

test("an agent from another organization is refused whatever the type", async () => {
  const r = refusal(await check({ taskType: "agent_run", agentId: FOREIGN, payload: { prompt: "hi" } }));
  assert.deepEqual(r, { error: "invalid_task", field: "agentId", message: "agent not found in this organization" });
  const optional = refusal(
    await check({ taskType: "cleanup", agentId: FOREIGN, payload: { archiveConversationsOlderThanDays: 30 } }),
  );
  assert.equal(optional.error, "invalid_task");
});

test("data_sync takes its knowledge base from the payload or the agent, and checks ownership", async () => {
  const sources = [{ url: "https://example.com/docs" }];
  accepted(await check({ taskType: "data_sync", payload: { knowledgeBaseId: KB, sources } }));
  accepted(await check({ taskType: "data_sync", agentId: AGENT, payload: { sources } }));

  const foreign = refusal(await check({ taskType: "data_sync", payload: { knowledgeBaseId: FOREIGN, sources } }));
  assert.equal((foreign as { field?: string }).field, "payload.knowledgeBaseId");

  const nowhere = fieldErrors(await check({ taskType: "data_sync", payload: { sources } }));
  assert.deepEqual(Object.keys(nowhere), ["payload.knowledgeBaseId"]);

  const agentWithout = fieldErrors(
    await check(
      { taskType: "data_sync", agentId: AGENT, payload: { sources } },
      { owns: owns({ agent: async () => ({ knowledgeBaseId: null }) }) },
    ),
  );
  assert.match(agentWithout["payload.knowledgeBaseId"]![0]!, /agent has no knowledge base/);

  const tooMany = fieldErrors(
    await check({
      taskType: "data_sync",
      payload: { knowledgeBaseId: KB, sources: Array.from({ length: 11 }, () => sources[0]) },
    }),
  );
  assert.deepEqual(Object.keys(tooMany), ["payload.sources"]);
});

test("health_check: each target needs its own field, ids are org-checked, defaults are applied", async () => {
  assert.deepEqual(
    Object.keys(fieldErrors(await check({ taskType: "health_check", payload: { target: "deployment" } }))),
    ["payload.deploymentId"],
  );
  assert.deepEqual(
    Object.keys(fieldErrors(await check({ taskType: "health_check", payload: { target: "url" } }))),
    ["payload.url"],
  );
  assert.deepEqual(
    Object.keys(fieldErrors(await check({ taskType: "health_check", payload: { target: "monitor" } }))),
    ["payload.monitorId"],
  );
  assert.equal(
    (refusal(await check({ taskType: "health_check", payload: { target: "agent" } })) as { field?: string }).field,
    "agentId",
  );
  assert.equal(
    (refusal(
      await check({ taskType: "health_check", payload: { target: "deployment", deploymentId: FOREIGN } }),
    ) as { field?: string }).field,
    "payload.deploymentId",
  );
  assert.equal(
    (refusal(
      await check({ taskType: "health_check", payload: { target: "url", url: "https://example.com", monitorId: FOREIGN } }),
    ) as { field?: string }).field,
    "payload.monitorId",
  );

  const ok = accepted(
    await check({ taskType: "health_check", payload: { target: "url", url: "https://example.com/health" } }),
  );
  assert.deepEqual(ok.payload, {
    target: "url",
    url: "https://example.com/health",
    expectedStatus: 200,
    timeoutSeconds: 10,
    onDown: "none",
  });
  assert.equal(ok.maxRetries, 0);
});

test("the restart action is refused with its reason where the server cannot do it", async () => {
  const payload = { target: "deployment", deploymentId: DEPLOYMENT, onDown: "restart_deployment" };
  accepted(await check({ taskType: "health_check", payload }));
  const errors = fieldErrors(await check({ taskType: "health_check", payload }, { capabilities: NONE }));
  assert.deepEqual(errors["payload.onDown"], [RESTART_UNAVAILABLE_REASON]);

  // And it only means anything for a deployment.
  const wrongTarget = fieldErrors(
    await check({
      taskType: "health_check",
      payload: { target: "url", url: "https://example.com", onDown: "restart_deployment" },
    }),
  );
  assert.deepEqual(Object.keys(wrongTarget), ["payload.onDown"]);
});

test("report: agent scope and summarize need an agent; the channel is org-checked", async () => {
  accepted(await check({ taskType: "report", payload: {} }));
  assert.equal(
    (refusal(await check({ taskType: "report", payload: { scope: "agent" } })) as { field?: string }).field,
    "agentId",
  );
  assert.equal(
    (refusal(await check({ taskType: "report", payload: { summarize: true } })) as { field?: string }).field,
    "agentId",
  );
  assert.equal(
    (refusal(
      await check({ taskType: "report", payload: { deliver: { alertChannelId: FOREIGN } } }),
    ) as { field?: string }).field,
    "payload.deliver.alertChannelId",
  );
  const ok = accepted(
    await check({ taskType: "report", agentId: AGENT, payload: { scope: "agent", deliver: { alertChannelId: CHANNEL } } }),
  );
  assert.equal(ok.payload.periodDays, 7);
  assert.deepEqual(
    Object.keys(fieldErrors(await check({ taskType: "report", payload: { periodDays: 91 } }))),
    ["payload.periodDays"],
  );
});

test("a report to an email channel is refused while email is not configured, and PagerDuty always", async () => {
  const emailChannel = owns({ alertChannel: async () => ({ type: "email" }) });
  const payload = { deliver: { alertChannelId: CHANNEL } };

  accepted(await check({ taskType: "report", payload }, { owns: emailChannel }));
  const errors = fieldErrors(
    await check({ taskType: "report", payload }, { owns: emailChannel, capabilities: NONE }),
  );
  assert.deepEqual(errors["payload.deliver.alertChannelId"], [EMAIL_UNAVAILABLE_REASON]);

  const pager = fieldErrors(
    await check({ taskType: "report", payload }, { owns: owns({ alertChannel: async () => ({ type: "pagerduty" }) }) }),
  );
  assert.match(pager["payload.deliver.alertChannelId"]![0]!, /PagerDuty/);
});

test("cleanup needs at least one operation and enforces the retention floors", async () => {
  const empty = fieldErrors(await check({ taskType: "cleanup", payload: { dryRun: true } }));
  assert.match(empty.payload![0]!, /at least one operation/);

  // Archive after at least a day, delete after at least a week.
  assert.deepEqual(
    Object.keys(fieldErrors(await check({ taskType: "cleanup", payload: { archiveConversationsOlderThanDays: 0 } }))),
    ["payload.archiveConversationsOlderThanDays"],
  );
  assert.deepEqual(
    Object.keys(fieldErrors(await check({ taskType: "cleanup", payload: { deleteArchivedOlderThanDays: 6 } }))),
    ["payload.deleteArchivedOlderThanDays"],
  );
  assert.deepEqual(
    Object.keys(fieldErrors(await check({ taskType: "cleanup", payload: { pruneRunHistoryOlderThanDays: 6 } }))),
    ["payload.pruneRunHistoryOlderThanDays"],
  );
  assert.deepEqual(
    Object.keys(
      fieldErrors(await check({ taskType: "cleanup", payload: { memoryDecay: { factor: 0.2, minImportance: 0.1 } } })),
    ),
    ["payload.memoryDecay.factor"],
  );
  accepted(
    await check({
      taskType: "cleanup",
      payload: { archiveConversationsOlderThanDays: 1, deleteArchivedOlderThanDays: 7, dryRun: true },
    }),
  );
});

test("custom requires an agent and defaults its input", async () => {
  assert.equal((refusal(await check({ taskType: "custom" })) as { field?: string }).field, "agentId");
  assert.deepEqual(accepted(await check({ taskType: "custom", agentId: AGENT })).payload, { input: "" });
});

test("the schedule is checked with the task, and skipped only when asked", async () => {
  const bad = refusal(
    await check({ taskType: "webhook", payload: { url: "https://example.com" }, scheduleType: "cron", cronExpression: "nope" }),
  );
  assert.deepEqual(
    { error: bad.error, reason: (bad as { reason?: string }).reason },
    { error: "invalid_schedule", reason: "invalid_cron" },
  );
  assert.equal(
    (refusal(
      await check({ taskType: "webhook", payload: { url: "https://example.com" }, scheduleType: "interval", intervalSeconds: 30 }),
    ) as { reason?: string }).reason,
    "interval_too_short",
  );

  const ok = accepted(
    await check({ taskType: "webhook", payload: { url: "https://example.com" }, scheduleType: "cron", cronExpression: "0 16 * * 5", timezone: "UTC" }),
  );
  assert.equal(ok.schedule!.nextRunAt.toISOString(), "2026-10-09T16:00:00.000Z");

  // An update that did not touch the schedule leaves a passed one-off time alone.
  const untouched = accepted(
    await check(
      { taskType: "webhook", payload: { url: "https://example.com" }, scheduleType: "once", scheduledAt: new Date("2020-01-01T00:00:00Z") },
      { checkSchedule: false },
    ),
  );
  assert.equal(untouched.schedule, null);
});
