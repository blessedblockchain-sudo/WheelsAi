/**
 * An agent's kind and its settings, as the API accepts, stores and serves
 * them. The shapes, the limits and the form's own rules are in
 * @wheelsai/shared/agent-kind, which the web app's form builder uses too;
 * this adds what needs the server:
 *
 *   resolveKindConfig  what a caller sent for `agentKind` and `kindConfig`,
 *                      as the values to store, or the problems in plain
 *                      words by field. It proves the form's JSON Schema
 *                      compiles with the same checker that will validate
 *                      inputs against it (services/jsonSchema.ts), checks a
 *                      suggested schedule with the scheduler's own rule
 *                      (services/scheduleCalc.ts), and holds the whole value
 *                      to 16 KB.
 *   cloneKindConfig    a deep copy of stored settings holding only what
 *                      this module knows: what a version snapshot, a
 *                      rollback and a buyer's copy carry.
 *   publicTaskForm     a task agent's form as anyone may see it.
 *
 * kindConfig has one key per kind ({ task?, scheduled? }), so changing the
 * kind and changing back loses nothing. On an update a key that is sent
 * replaces that key and the others stay; null removes a key.
 *
 * Pure: nothing here reads the database or the environment.
 */

import {
  DEFAULT_AGENT_KIND,
  DEFAULT_TASK_FIELDS,
  MAX_KIND_CONFIG_BYTES,
  MAX_RUN_LINE_LENGTH,
  hasUnsafeText,
  isAgentKind,
  kindConfigBytes,
  normalizeTaskFields,
  taskFieldsOf,
  taskInputSchema,
  type AgentKind,
  type KindConfig,
  type ScheduledKindConfig,
  type SuggestedSchedule,
  type TaskField,
  type TaskInputSchema,
} from "@wheelsai/shared/agent-kind";

import { JsonSchemaError, compileUserSchema } from "./jsonSchema.js";
import { validateSchedule } from "./scheduleCalc.js";

export const KIND_CONFIG_KEYS = ["task", "scheduled"] as const;

/** What a person is told, by problem. Field problems of a form are in the shared module. */
export const KIND_MESSAGES = {
  invalidKind: "Choose how people use this agent: conversation, task or scheduled.",
  notAnObject: "Send the settings as an object with a task or a scheduled part.",
  // Fixed sentences: what the caller named is not repeated back, so the
  // answer stays one short line whatever was sent.
  unknownKey: "The settings of an agent are task and scheduled. Remove anything else.",
  unknownScheduledKey: "The schedule settings are schedule and prompt. Remove anything else.",
  tooLarge: "These settings are too large to save. Shorten the questions, the help text or the options.",
  taskNotAnObject: "Send the form as an object with a list of fields.",
  formNotUsable: "This form could not be saved. Simplify its questions and try again.",
  scheduledNotAnObject: "Send the schedule settings as an object with a schedule or a prompt.",
  scheduleNotAnObject: "Send the suggested schedule as an object with a cronExpression.",
  cronRequired: "Choose when it should run.",
  cronInvalid:
    "These custom times are not valid. Use five parts: minute, hour, day of the month, month and weekday.",
  timezoneInvalid: 'Choose a time zone such as "Europe/Berlin" or "UTC".',
  promptNotText: "Write what it is told at each run as text.",
  promptTooLong: `Keep what it is told at each run to ${MAX_RUN_LINE_LENGTH} characters or fewer.`,
  promptNotPlainText: "What it is told at each run has hidden characters that cannot be saved. Remove them and try again.",
} as const;

export interface KindConfigInput {
  /** As sent. Left out (undefined) keeps the current kind. */
  agentKind?: unknown;
  /** As sent. Left out keeps the current settings; null clears them; a key replaces that key. */
  kindConfig?: unknown;
}

export interface KindConfigContext {
  /** The agent as stored, on an update. Left out on a create. */
  current?: { agentKind?: string | null; kindConfig?: unknown } | null;
  /** For the schedule check. Defaults to the present. */
  now?: Date;
}

export type KindConfigResolution =
  | {
      ok: true;
      agentKind: AgentKind;
      /** The settings to store: normalized, or null when there are none. */
      kindConfig: KindConfig | null;
      /** True when the kind or the settings differ from `current`. Always true on a create. */
      changed: boolean;
    }
  | {
      ok: false;
      /** The first problem, for a caller that shows one line. */
      message: string;
      /**
       * Every problem by where it is: "agentKind", "kindConfig",
       * "kindConfig.task.fields", "kindConfig.task.fields[2].label",
       * "kindConfig.scheduled.schedule.cronExpression", …
       */
      fields: Record<string, string>;
    };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaCompiles(schema: TaskInputSchema): boolean {
  try {
    compileUserSchema(schema, { root: "object" });
    return true;
  } catch (err) {
    if (err instanceof JsonSchemaError) return false;
    throw err;
  }
}

/** A stored `scheduled` value with only the parts this module knows; null when it has none. */
function readScheduled(value: unknown): ScheduledKindConfig | null {
  if (!isObject(value)) return null;
  const scheduled: ScheduledKindConfig = {};
  if (isObject(value.schedule) && typeof value.schedule.cronExpression === "string" && value.schedule.cronExpression) {
    const schedule: SuggestedSchedule = { cronExpression: value.schedule.cronExpression };
    if (typeof value.schedule.timezone === "string" && value.schedule.timezone) {
      schedule.timezone = value.schedule.timezone;
    }
    scheduled.schedule = schedule;
  }
  if (typeof value.prompt === "string" && value.prompt.trim()) scheduled.prompt = value.prompt.trim();
  return scheduled.schedule || scheduled.prompt ? scheduled : null;
}

/**
 * A deep copy of stored settings: safe to put on a version, to restore from
 * one, and to give a buyer's copy. It shares nothing with the value it was
 * given, and carries only `task` and `scheduled` with the properties this
 * module knows, so nothing else that found its way into the column travels.
 * A form that cannot be read is dropped rather than copied. Null when there
 * is nothing to copy.
 */
export function cloneKindConfig(value: unknown): KindConfig | null {
  if (!isObject(value)) return null;
  const copy: KindConfig = {};
  if (isObject(value.task)) {
    const { fields, issues } = normalizeTaskFields(value.task.fields);
    if (issues.length === 0) copy.task = { fields };
  }
  const scheduled = readScheduled(value.scheduled);
  if (scheduled) copy.scheduled = scheduled;
  return copy.task || copy.scheduled ? copy : null;
}

function resolveScheduled(
  value: JsonObject,
  now: Date,
  problem: (field: string, message: string) => void,
): ScheduledKindConfig | null {
  const at = "kindConfig.scheduled";
  const scheduled: ScheduledKindConfig = {};

  if (Object.keys(value).some((key) => key !== "schedule" && key !== "prompt")) {
    problem(at, KIND_MESSAGES.unknownScheduledKey);
  }

  if (value.schedule !== undefined && value.schedule !== null) {
    if (!isObject(value.schedule)) {
      problem(`${at}.schedule`, KIND_MESSAGES.scheduleNotAnObject);
    } else {
      const cronExpression = typeof value.schedule.cronExpression === "string" ? value.schedule.cronExpression.trim() : "";
      const sentZone = value.schedule.timezone;
      const timezone = typeof sentZone === "string" ? sentZone.trim() : "";
      if (sentZone !== undefined && sentZone !== null && typeof sentZone !== "string") {
        problem(`${at}.schedule.timezone`, KIND_MESSAGES.timezoneInvalid);
      } else if (!cronExpression) {
        problem(`${at}.schedule.cronExpression`, KIND_MESSAGES.cronRequired);
      } else {
        const verdict = validateSchedule(
          { scheduleType: "cron", cronExpression, timezone: timezone || null },
          now,
        );
        if (!verdict.ok) {
          // The scheduler's own message names cron-parser's reason; a person
          // is told what to do instead.
          if (verdict.reason === "invalid_timezone") problem(`${at}.schedule.timezone`, KIND_MESSAGES.timezoneInvalid);
          else problem(`${at}.schedule.cronExpression`, KIND_MESSAGES.cronInvalid);
        } else {
          // Five fields with single spaces, as the scheduler reads it.
          scheduled.schedule = {
            cronExpression: cronExpression.split(/\s+/).join(" "),
            ...(timezone && { timezone }),
          };
        }
      }
    }
  }

  if (value.prompt !== undefined && value.prompt !== null) {
    if (typeof value.prompt !== "string") problem(`${at}.prompt`, KIND_MESSAGES.promptNotText);
    else if (value.prompt.trim().length > MAX_RUN_LINE_LENGTH) problem(`${at}.prompt`, KIND_MESSAGES.promptTooLong);
    else if (hasUnsafeText(value.prompt, { multiline: true })) problem(`${at}.prompt`, KIND_MESSAGES.promptNotPlainText);
    else if (value.prompt.trim()) scheduled.prompt = value.prompt.trim();
  }

  return scheduled.schedule || scheduled.prompt ? scheduled : null;
}

/**
 * The kind and settings to store, from what a caller sent.
 *
 * On a create (`context.current` left out) the kind is conversation unless
 * one is sent. On an update, what is not sent stays: the kind, and each key
 * of the settings that the caller did not name.
 *
 * A task agent always ends up with a form: when it has none, it gets the
 * default one (one required long text, "Your request"). The settings of the
 * other kinds are kept beside it untouched, whatever the kind is now.
 */
export function resolveKindConfig(input: KindConfigInput, context: KindConfigContext = {}): KindConfigResolution {
  const fields: Record<string, string> = {};
  const problem = (field: string, message: string) => {
    if (!(field in fields)) fields[field] = message;
  };
  const refuse = (): KindConfigResolution => ({
    ok: false,
    message: Object.values(fields)[0] ?? KIND_MESSAGES.notAnObject,
    fields,
  });
  const now = context.now ?? new Date();
  const current = context.current ?? null;

  // The kind.
  const storedKind = current && isAgentKind(current.agentKind) ? current.agentKind : DEFAULT_AGENT_KIND;
  let agentKind: AgentKind = storedKind;
  if (input.agentKind !== undefined) {
    if (isAgentKind(input.agentKind)) agentKind = input.agentKind;
    else problem("agentKind", KIND_MESSAGES.invalidKind);
  }

  // The settings: what is stored, with each key that was sent put in its place.
  const stored = current ? cloneKindConfig(current.kindConfig) : null;
  const next: KindConfig = input.kindConfig === null ? {} : { ...(stored ?? {}) };
  const sent = input.kindConfig;

  if (sent !== undefined && sent !== null) {
    if (!isObject(sent)) {
      problem("kindConfig", KIND_MESSAGES.notAnObject);
      return refuse();
    }
    // Before any work is done on it. The value to store is measured again
    // below, once what was kept and what was sent are together.
    if (kindConfigBytes(sent) > MAX_KIND_CONFIG_BYTES) {
      problem("kindConfig", KIND_MESSAGES.tooLarge);
      return refuse();
    }
    if (Object.keys(sent).some((key) => !(KIND_CONFIG_KEYS as readonly string[]).includes(key))) {
      problem("kindConfig", KIND_MESSAGES.unknownKey);
    }

    if (sent.task === null) delete next.task;
    else if (sent.task !== undefined) {
      if (!isObject(sent.task)) {
        problem("kindConfig.task", KIND_MESSAGES.taskNotAnObject);
      } else {
        const { fields: taskFields, issues } = normalizeTaskFields(sent.task.fields);
        for (const issue of issues) {
          problem(
            issue.index < 0
              ? "kindConfig.task.fields"
              : issue.field === "fields"
                ? `kindConfig.task.fields[${issue.index}]`
                : `kindConfig.task.fields[${issue.index}].${issue.field}`,
            issue.message,
          );
        }
        if (issues.length === 0) {
          if (schemaCompiles(taskInputSchema(taskFields))) next.task = { fields: taskFields };
          else problem("kindConfig.task.fields", KIND_MESSAGES.formNotUsable);
        }
      }
    }

    if (sent.scheduled === null) delete next.scheduled;
    else if (sent.scheduled !== undefined) {
      if (!isObject(sent.scheduled)) {
        problem("kindConfig.scheduled", KIND_MESSAGES.scheduledNotAnObject);
      } else {
        const scheduled = resolveScheduled(sent.scheduled, now, problem);
        if (scheduled) next.scheduled = scheduled;
        else delete next.scheduled;
      }
    }
  }

  if (Object.keys(fields).length > 0) return refuse();

  if (agentKind === "task" && !next.task) {
    next.task = { fields: DEFAULT_TASK_FIELDS.map((field) => ({ ...field })) };
  }

  // One order for the keys, so equal settings are equal text.
  const kindConfig: KindConfig | null =
    next.task || next.scheduled
      ? { ...(next.task && { task: next.task }), ...(next.scheduled && { scheduled: next.scheduled }) }
      : null;

  if (kindConfig && kindConfigBytes(kindConfig) > MAX_KIND_CONFIG_BYTES) {
    problem("kindConfig", KIND_MESSAGES.tooLarge);
    return refuse();
  }

  const changed =
    !current || agentKind !== current.agentKind || JSON.stringify(kindConfig) !== JSON.stringify(stored);
  return { ok: true, agentKind, kindConfig, changed };
}

export interface PublicTaskForm {
  /** The JSON Schema an input is checked against, its properties in field order. */
  schema: TaskInputSchema;
  /** The field keys in order, for a reader whose JSON parser does not keep property order. */
  order: string[];
}

/**
 * A task agent's form as anyone may see it: the schema an input is checked
 * against and the order of its questions. Made from the stored form (the
 * default form when the agent has none), and from nothing else: no other
 * kind's settings, no schedule, nothing about the agent.
 */
export function publicTaskForm(kindConfig: unknown): PublicTaskForm {
  const fields: TaskField[] = taskFieldsOf(kindConfig);
  return { schema: taskInputSchema(fields), order: fields.map((field) => field.key) };
}
