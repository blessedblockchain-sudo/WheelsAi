/**
 * The scheduled-task form's working copy and its conversion to and from
 * the API's task shape. The fields of each task type come from
 * GET /api/scheduler/task-types; nothing here knows a task type by name.
 *
 * Pure: no React, no fetch.
 */

import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduleType,
  TaskTypeEntry,
  TaskTypeField,
} from "@/lib/api";

export type HeaderRow = { name: string; value: string };
export type SourceRow = { url: string; title: string };
export type FieldValue = string | boolean | HeaderRow[] | SourceRow[];

export type IntervalUnit = "minutes" | "hours" | "days";
const UNIT_SECONDS: Record<IntervalUnit, number> = { minutes: 60, hours: 3600, days: 86_400 };

export interface TaskForm {
  name: string;
  description: string;
  taskType: string;
  agentId: string;
  orchestrationId: string;
  scheduleType: ScheduleType;
  cronExpression: string;
  intervalValue: string;
  intervalUnit: IntervalUnit;
  /** A local date-time ("2026-11-02T09:00"), read in `timezone`. */
  scheduledAt: string;
  timezone: string;
  /** Payload values by field key (a dotted payload path). */
  values: Record<string, FieldValue>;
  timeoutSeconds: string;
  maxRetries: string;
}

export const FALLBACK_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Africa/Lagos",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/** Every IANA zone the browser knows, UTC first. */
export function timezoneOptions(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
      "timeZone"
    );
    if (supported && supported.length > 0) return ["UTC", ...supported.filter((z) => z !== "UTC")];
  } catch {
    // Older browsers: the short list below.
  }
  return FALLBACK_TIMEZONES;
}

export function browserTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // The API takes Area/Location names or UTC.
    return zone && (zone === "UTC" || zone.includes("/")) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

/** An instant as the wall-clock time of `timezone`, in datetime-local form. */
export function toLocalInput(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
  } catch {
    return "";
  }
}

function readPath(root: unknown, key: string): unknown {
  let current = root;
  for (const part of key.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function writePath(root: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (typeof next !== "object" || next === null) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function blankValue(field: TaskTypeField): FieldValue {
  if (field.kind === "boolean") return false;
  if (field.kind === "headers") return [];
  if (field.kind === "sources") return [{ url: "", title: "" }];
  if (field.kind === "select") {
    return field.required ? (field.options?.find((o) => o.available)?.value ?? "") : "";
  }
  return "";
}

function valueFromPayload(field: TaskTypeField, raw: unknown): FieldValue {
  if (raw === undefined || raw === null) return blankValue(field);
  switch (field.kind) {
    case "boolean":
      return raw === true;
    case "headers":
      return typeof raw === "object"
        ? Object.entries(raw as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value) }))
        : [];
    case "sources":
      return Array.isArray(raw)
        ? raw.map((s: { url?: unknown; title?: unknown }) => ({
            url: typeof s?.url === "string" ? s.url : "",
            title: typeof s?.title === "string" ? s.title : "",
          }))
        : [];
    case "json":
      return typeof raw === "string" ? JSON.stringify(raw) : JSON.stringify(raw, null, 2);
    default:
      return String(raw);
  }
}

export function valuesFor(type: TaskTypeEntry | undefined, payload: unknown): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const field of type?.fields ?? []) {
    values[field.key] = valueFromPayload(field, readPath(payload, field.key));
  }
  return values;
}

export function isFieldVisible(field: TaskTypeField, values: Record<string, FieldValue>): boolean {
  if (!field.showWhen) return true;
  const controlling = values[field.showWhen.key];
  return typeof controlling === "string" && field.showWhen.in.includes(controlling);
}

function splitInterval(seconds: number | null | undefined): { value: string; unit: IntervalUnit } {
  if (!seconds) return { value: "15", unit: "minutes" };
  if (seconds % 86_400 === 0) return { value: String(seconds / 86_400), unit: "days" };
  if (seconds % 3600 === 0) return { value: String(seconds / 3600), unit: "hours" };
  return { value: String(Math.max(1, Math.round(seconds / 60))), unit: "minutes" };
}

export function newTaskForm(
  type: TaskTypeEntry | undefined,
  preset: { orchestrationId?: string; name?: string } = {}
): TaskForm {
  return {
    name: preset.name ?? "",
    description: "",
    taskType: type?.type ?? "",
    agentId: "",
    orchestrationId: preset.orchestrationId ?? "",
    scheduleType: "cron",
    cronExpression: "0 9 * * *",
    intervalValue: "15",
    intervalUnit: "minutes",
    scheduledAt: "",
    timezone: browserTimezone(),
    values: valuesFor(type, {}),
    timeoutSeconds: "300",
    maxRetries: type?.retryable ? "3" : "0",
  };
}

export function formFromTask(task: ScheduledTask, type: TaskTypeEntry | undefined): TaskForm {
  const interval = splitInterval(task.intervalSeconds);
  const scheduleType = (["cron", "interval", "once"] as const).includes(task.scheduleType as ScheduleType)
    ? (task.scheduleType as ScheduleType)
    : "cron";
  return {
    name: task.name,
    description: task.description ?? "",
    taskType: task.taskType,
    agentId: task.agentId ?? "",
    orchestrationId: task.orchestrationId ?? "",
    scheduleType,
    cronExpression: task.cronExpression ?? "",
    intervalValue: interval.value,
    intervalUnit: interval.unit,
    scheduledAt: task.scheduledAt ? toLocalInput(task.scheduledAt, task.timezone) : "",
    timezone: task.timezone || "UTC",
    values: valuesFor(type, task.payload),
    timeoutSeconds: String(Math.round(task.timeout / 1000)),
    maxRetries: String(task.maxRetries),
  };
}

/** Problems by form field; payload fields are keyed "payload.<key>" like the API's. */
export type FormErrors = Record<string, string>;

export function intervalSeconds(form: TaskForm): number | null {
  if (!/^\d+$/.test(form.intervalValue.trim())) return null;
  return Number(form.intervalValue.trim()) * UNIT_SECONDS[form.intervalUnit];
}

/**
 * Builds the payload from the visible fields and reports what the form
 * can already tell is wrong. A field hidden by another field's value is
 * left out, so a URL typed before the target changed is not sent.
 */
export function buildPayload(
  type: TaskTypeEntry,
  values: Record<string, FieldValue>
): { payload: Record<string, unknown>; errors: FormErrors } {
  const payload: Record<string, unknown> = {};
  const errors: FormErrors = {};

  for (const field of type.fields) {
    if (!isFieldVisible(field, values)) continue;
    const errorKey = `payload.${field.key}`;
    const value = values[field.key] ?? blankValue(field);
    const missing = () => {
      if (field.required) errors[errorKey] = `${field.label} is required`;
    };

    switch (field.kind) {
      case "boolean":
        if (value === true) writePath(payload, field.key, true);
        break;
      case "number": {
        const text = String(value).trim();
        if (text === "") {
          missing();
          break;
        }
        const n = Number(text);
        if (!Number.isFinite(n)) errors[errorKey] = `${field.label} must be a number`;
        else if (field.min !== undefined && n < field.min) errors[errorKey] = `${field.label} must be at least ${field.min}`;
        else if (field.max !== undefined && n > field.max) errors[errorKey] = `${field.label} must be at most ${field.max}`;
        else writePath(payload, field.key, n);
        break;
      }
      case "json": {
        const text = String(value).trim();
        if (text === "") {
          missing();
          break;
        }
        try {
          writePath(payload, field.key, JSON.parse(text));
        } catch {
          errors[errorKey] = `${field.label} is not valid JSON`;
        }
        break;
      }
      case "headers": {
        const rows = (value as HeaderRow[]).filter((r) => r.name.trim() !== "");
        if (rows.length === 0) {
          missing();
          break;
        }
        writePath(payload, field.key, Object.fromEntries(rows.map((r) => [r.name.trim(), r.value])));
        break;
      }
      case "sources": {
        const rows = (value as SourceRow[]).filter((r) => r.url.trim() !== "");
        if (rows.length === 0) {
          missing();
          break;
        }
        if (field.max !== undefined && rows.length > field.max) {
          errors[errorKey] = `At most ${field.max} sources`;
          break;
        }
        const bad = rows.find((r) => !/^https?:\/\//i.test(r.url.trim()));
        if (bad) {
          errors[errorKey] = `"${bad.url}" is not an http or https URL`;
          break;
        }
        writePath(
          payload,
          field.key,
          rows.map((r) => ({ url: r.url.trim(), ...(r.title.trim() !== "" ? { title: r.title.trim() } : {}) }))
        );
        break;
      }
      case "select": {
        const text = String(value);
        if (text === "") {
          missing();
          break;
        }
        const option = field.options?.find((o) => o.value === text);
        if (option && !option.available) {
          errors[errorKey] = option.reason ?? `${option.label} is not available`;
          break;
        }
        writePath(payload, field.key, text);
        break;
      }
      default: {
        const text = String(value);
        if (text.trim() === "") {
          missing();
          break;
        }
        if (field.kind === "url" && !/^https?:\/\//i.test(text.trim())) {
          errors[errorKey] = `${field.label} must be an http or https URL`;
          break;
        }
        if (field.max !== undefined && text.length > field.max) {
          errors[errorKey] = `${field.label} is at most ${field.max} characters`;
          break;
        }
        writePath(payload, field.key, field.kind === "textarea" ? text : text.trim());
      }
    }
  }
  return { payload, errors };
}

export function buildTaskInput(
  form: TaskForm,
  type: TaskTypeEntry
): { input: ScheduledTaskInput; errors: FormErrors } {
  const { payload, errors } = buildPayload(type, form.values);

  const name = form.name.trim();
  if (name === "") errors.name = "Give the task a name";
  else if (name.length > 80) errors.name = "The name is at most 80 characters";

  if (!type.available) errors.taskType = type.reason ?? "This task type is not available on this server";
  if (type.agent === "required" && !form.agentId) errors.agentId = "Choose an agent";
  if (type.orchestration && !form.orchestrationId) errors.orchestrationId = "Choose a workflow";

  const input: ScheduledTaskInput = {
    name,
    taskType: form.taskType,
    agentId: type.agent === "none" ? null : form.agentId || null,
    orchestrationId: type.orchestration ? form.orchestrationId || null : null,
    scheduleType: form.scheduleType,
    timezone: form.timezone,
    payload,
  };
  if (form.description.trim() !== "") input.description = form.description.trim();

  if (form.scheduleType === "cron") {
    const cron = form.cronExpression.trim();
    if (cron.split(/\s+/).filter(Boolean).length !== 5) {
      errors.cronExpression = "A cron expression has five fields: minute hour day-of-month month weekday";
    }
    input.cronExpression = cron;
  } else if (form.scheduleType === "interval") {
    const seconds = intervalSeconds(form);
    if (seconds === null || seconds < 60) errors.intervalSeconds = "The shortest interval is one minute";
    else input.intervalSeconds = seconds;
  } else {
    if (form.scheduledAt === "") errors.scheduledAt = "Choose a date and time";
    else input.scheduledAt = form.scheduledAt;
  }

  const timeout = Number(form.timeoutSeconds);
  if (!/^\d+$/.test(form.timeoutSeconds.trim()) || timeout < 5 || timeout > 3600) {
    errors.timeout = "The time limit must be 5 to 3600 seconds";
  } else {
    input.timeout = timeout * 1000;
  }

  if (type.retryable) {
    const retries = Number(form.maxRetries);
    if (!/^\d+$/.test(form.maxRetries.trim()) || retries > 5) errors.maxRetries = "Retries must be 0 to 5";
    else input.maxRetries = retries;
  } else {
    input.maxRetries = 0;
  }

  return { input, errors };
}

const SCHEDULE_KEYS = ["scheduleType", "cronExpression", "intervalSeconds", "scheduledAt", "timezone"] as const;

/**
 * What a PATCH should carry: only what changed. Schedule fields travel
 * together, and only when one of them changed, because sending them makes
 * the server re-check the schedule, and a one-off task whose time has
 * passed must still be renameable.
 */
export function changedFields(
  before: ScheduledTaskInput,
  after: ScheduledTaskInput
): Partial<ScheduledTaskInput> {
  const patch: Record<string, unknown> = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  for (const key of ["name", "taskType", "agentId", "orchestrationId", "payload", "timeout", "maxRetries"] as const) {
    if (!same(before[key], after[key])) patch[key] = after[key];
  }
  if (!same(before.description ?? "", after.description ?? "")) patch.description = after.description ?? "";
  if (SCHEDULE_KEYS.some((key) => !same(before[key], after[key]))) {
    for (const key of SCHEDULE_KEYS) {
      if (after[key] !== undefined) patch[key] = after[key];
    }
  }
  return patch as Partial<ScheduledTaskInput>;
}

export const CRON_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every day at 09:00", value: "0 9 * * *" },
  { label: "Weekdays at 09:00", value: "0 9 * * 1-5" },
  { label: "Mondays at 09:00", value: "0 9 * * 1" },
  { label: "First of the month", value: "0 9 1 * *" },
];
