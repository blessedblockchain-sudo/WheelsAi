import assert from "node:assert/strict";
import { test } from "node:test";

import type { ScheduledTask, TaskTypeEntry } from "@/lib/api";
import {
  buildPayload,
  buildTaskInput,
  changedFields,
  formFromTask,
  newTaskForm,
  toLocalInput,
  valuesFor,
} from "./task-form-model";

const base = { deferred: false, retryable: true, available: true } as const;

const webhook: TaskTypeEntry = {
  ...base,
  type: "webhook",
  label: "Webhook",
  description: "",
  agent: "none",
  orchestration: false,
  fields: [
    { key: "url", label: "URL", kind: "url", required: true, max: 2048 },
    { key: "body", label: "Body (JSON)", kind: "json", required: false },
    { key: "headers", label: "Headers", kind: "headers", required: false },
  ],
};

const healthCheck: TaskTypeEntry = {
  ...base,
  retryable: false,
  type: "health_check",
  label: "Health check",
  description: "",
  agent: "optional",
  orchestration: false,
  fields: [
    {
      key: "target",
      label: "Target",
      kind: "select",
      required: true,
      options: [
        { value: "agent", label: "Agent", available: true },
        { value: "deployment", label: "Deployment", available: true },
        { value: "url", label: "URL", available: true },
      ],
    },
    { key: "deploymentId", label: "Deployment", kind: "deployment", required: true, showWhen: { key: "target", in: ["deployment"] } },
    { key: "url", label: "URL", kind: "url", required: true, showWhen: { key: "target", in: ["url"] } },
    { key: "timeoutSeconds", label: "Timeout (seconds)", kind: "number", required: false, min: 1, max: 60 },
    {
      key: "onDown",
      label: "When down",
      kind: "select",
      required: false,
      showWhen: { key: "target", in: ["deployment"] },
      options: [
        { value: "none", label: "Only record", available: true },
        { value: "restart_deployment", label: "Restart", available: false, reason: "no restart service" },
      ],
    },
  ],
};

const report: TaskTypeEntry = {
  ...base,
  type: "report",
  label: "Report",
  description: "",
  agent: "optional",
  orchestration: false,
  fields: [
    { key: "periodDays", label: "Period (days)", kind: "number", required: false, min: 1, max: 90 },
    { key: "deliver.webhookEvent", label: "Send an event", kind: "boolean", required: false },
    { key: "deliver.alertChannelId", label: "Alert channel", kind: "alert_channel", required: false },
  ],
};

const workflowRun: TaskTypeEntry = {
  ...base,
  retryable: false,
  deferred: true,
  type: "workflow_run",
  label: "Workflow run",
  description: "",
  agent: "none",
  orchestration: true,
  fields: [{ key: "prompt", label: "Prompt", kind: "textarea", required: false }],
};

function task(extra: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "t1",
    orgId: "org",
    agentId: null,
    orchestrationId: null,
    name: "Ping",
    scheduleType: "interval",
    intervalSeconds: 3600,
    timezone: "UTC",
    taskType: "webhook",
    payload: {},
    timeout: 300_000,
    maxRetries: 3,
    isEnabled: true,
    status: "active",
    totalRuns: 0,
    successfulRuns: 0,
    failedRuns: 0,
    createdAt: "2026-10-06T00:00:00.000Z",
    ...extra,
  };
}

test("a payload is built from the catalogue's fields, nested keys included", () => {
  const values = valuesFor(report, {});
  values.periodDays = "30";
  values["deliver.webhookEvent"] = true;
  assert.deepEqual(buildPayload(report, values), {
    payload: { periodDays: 30, deliver: { webhookEvent: true } },
    errors: {},
  });
});

test("required, range, URL and JSON problems are reported by payload field", () => {
  const values = valuesFor(webhook, {});
  values.body = "{ nope";
  assert.deepEqual(buildPayload(webhook, values).errors, {
    "payload.url": "URL is required",
    "payload.body": "Body (JSON) is not valid JSON",
  });
  values.url = "ftp://example.com";
  assert.match(buildPayload(webhook, values).errors["payload.url"]!, /http or https/);

  const health = valuesFor(healthCheck, {});
  health.target = "url";
  health.url = "https://example.com";
  health.timeoutSeconds = "600";
  assert.deepEqual(buildPayload(healthCheck, health).errors, {
    "payload.timeoutSeconds": "Timeout (seconds) must be at most 60",
  });
});

test("a field hidden by another field's value is not sent", () => {
  const values = valuesFor(healthCheck, {});
  values.target = "deployment";
  values.deploymentId = "dep-1";
  values.url = "https://typed-earlier.example";
  assert.deepEqual(buildPayload(healthCheck, values).payload, { target: "deployment", deploymentId: "dep-1" });

  values.target = "url";
  assert.deepEqual(buildPayload(healthCheck, values).payload, {
    target: "url",
    url: "https://typed-earlier.example",
  });
});

test("an option the server cannot honour is refused with the server's reason", () => {
  const values = valuesFor(healthCheck, {});
  values.target = "deployment";
  values.deploymentId = "dep-1";
  values.onDown = "restart_deployment";
  assert.equal(buildPayload(healthCheck, values).errors["payload.onDown"], "no restart service");
});

test("headers and sources are sent without their empty rows", () => {
  const values = valuesFor(webhook, {});
  values.url = "https://example.com/hook";
  values.headers = [
    { name: "X-Source", value: "wheelsai" },
    { name: "", value: "ignored" },
  ];
  assert.deepEqual(buildPayload(webhook, values).payload, {
    url: "https://example.com/hook",
    headers: { "X-Source": "wheelsai" },
  });
});

test("the task type decides whether an agent or a workflow is required, and whether it retries", () => {
  const form = newTaskForm(workflowRun, { orchestrationId: "", name: "Nightly" });
  form.agentId = "left-over-agent";
  form.maxRetries = "4";
  const built = buildTaskInput(form, workflowRun);
  assert.equal(built.errors.orchestrationId, "Choose a workflow");
  assert.equal(built.input.agentId, null);
  assert.equal(built.input.maxRetries, 0);

  const unavailable = buildTaskInput(form, { ...workflowRun, available: false, reason: "runner is off" });
  assert.equal(unavailable.errors.taskType, "runner is off");
});

test("schedules: five cron fields, a one-minute floor, and a naive local time for once", () => {
  const form = newTaskForm(webhook);
  form.name = "Ping";
  form.values.url = "https://example.com";

  form.cronExpression = "0 9 * *";
  assert.match(buildTaskInput(form, webhook).errors.cronExpression!, /five fields/);

  form.scheduleType = "interval";
  form.intervalValue = "0";
  assert.match(buildTaskInput(form, webhook).errors.intervalSeconds!, /one minute/);
  form.intervalValue = "2";
  form.intervalUnit = "hours";
  assert.equal(buildTaskInput(form, webhook).input.intervalSeconds, 7200);

  form.scheduleType = "once";
  form.scheduledAt = "2026-11-02T09:00";
  form.timezone = "Europe/Berlin";
  const once = buildTaskInput(form, webhook).input;
  // Sent as typed: the server reads it in the task's time zone.
  assert.equal(once.scheduledAt, "2026-11-02T09:00");
  assert.equal(once.timezone, "Europe/Berlin");
});

test("a stored instant is shown as the wall-clock time of the task's zone", () => {
  assert.equal(toLocalInput("2026-11-02T08:00:00.000Z", "Europe/Berlin"), "2026-11-02T09:00");
  assert.equal(toLocalInput("2026-07-01T13:00:00.000Z", "America/New_York"), "2026-07-01T09:00");
  assert.equal(toLocalInput("not a date", "UTC"), "");
});

test("an edit sends only what changed, and schedule fields only when the schedule changed", () => {
  const stored = task({ payload: { url: "https://example.com/hook" } });
  const before = buildTaskInput(formFromTask(stored, webhook), webhook).input;

  const renamed = formFromTask(stored, webhook);
  renamed.name = "Ping the hook";
  assert.deepEqual(changedFields(before, buildTaskInput(renamed, webhook).input), { name: "Ping the hook" });

  const rescheduled = formFromTask(stored, webhook);
  rescheduled.intervalValue = "2";
  assert.deepEqual(changedFields(before, buildTaskInput(rescheduled, webhook).input), {
    scheduleType: "interval",
    intervalSeconds: 7200,
    timezone: "UTC",
  });

  assert.deepEqual(changedFields(before, before), {});
});
