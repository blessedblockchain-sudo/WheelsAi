/**
 * An agent owns its schedule: the few reads and writes that make that true.
 *
 * The live schedule is a ScheduledTask row, the same row the Scheduler page
 * lists and the scheduler worker fires. An agent's OWN schedule is its oldest
 * task of type agent_run (by creation time, then id); its other tasks are
 * counted and left to the Scheduler page. Agent.kindConfig.scheduled holds
 * only a suggestion and is never read here.
 *
 * Used by three callers, so every write takes a transaction client:
 *
 *   the create path        the agent and its schedule are written in one
 *                          transaction. checkOwnSchedule is pure and runs
 *                          BEFORE the transaction is opened, so a bad cron
 *                          or time zone leaves no agent; createOwnSchedule
 *                          checks again and then looks the delivery place
 *                          up inside the transaction, and what it throws
 *                          undoes the agent too.
 *   the agent's schedule   findOwnSchedule to read, updateOwnSchedule to
 *   routes                 write as a compare-and-set against the row that
 *                          was read (409 schedule_changed).
 *   the other writers      setOwnScheduleEnabled when an agent's kind leaves
 *                          "scheduled"; pauseAgentSchedules when a buyer's
 *                          copy is uninstalled; latestOwnResults for the
 *                          public page.
 *
 * A schedule made here is a cron schedule with stampTime on and ONE retry
 * (a task made on the Scheduler page gets three). Nothing is queued when a
 * schedule is saved: the worker finds a task by its nextRunAt, which is
 * written here the way services/scheduler.ts writes it.
 *
 * No database client is imported: `db` and `tx` are the slice of Prisma
 * below, which a transaction client has and so does the client itself.
 */

import { DEFAULT_RUN_LINE } from "@wheelsai/shared/agent-kind";

import { validationFailureFromFields, type ValidationFailureBody } from "../lib/validationFailure.js";
import {
  checkDeliveryChannel,
  getTaskType,
  RESULT_EMAIL_UNAVAILABLE_REASON,
  type AgentRunPayload,
} from "./scheduledTaskTypes.js";
import { nextRun, validateSchedule, type ScheduleRefusalReason } from "./scheduleCalc.js";

// ============================================
// Rules and words
// ============================================

/** The task type of an agent's own schedule. */
export const OWN_SCHEDULE_TASK_TYPE = "agent_run";
/** A schedule made on the agent page gets one retry, not the Scheduler's three. */
export const OWN_SCHEDULE_MAX_RETRIES = 1;
/** As the Scheduler page's own limits (routes/scheduler.ts). */
export const OWN_SCHEDULE_RETRY_LIMIT = 5;
export const OWN_SCHEDULE_TIMEOUT_SECONDS = { min: 5, max: 3600, default: 300 } as const;
/** The longest name a scheduled task may have. */
export const SCHEDULE_NAME_MAX = 80;

export const OWN_SCHEDULE_MESSAGES = {
  invalidCron: "These times could not be read. Check them and try again.",
  invalidTimezone: "Choose a time zone from the list, for example Europe/Berlin.",
  noNextRun: "This schedule has no future run. Set new times to turn it on.",
  prompt: "Write what it is told at each run, in up to 20,000 characters.",
  placeNotFound: "That place was not found. Choose another place for the results.",
  emailOff: "Email delivery is temporarily unavailable. Results are still saved here.",
  placeUnsupported: "That place cannot receive results. Choose Slack, Discord or email.",
  timeout: "A run can be stopped after 5 to 3,600 seconds.",
  retries: "Tries after a failed run can be 0 to 5.",
  changed: "This schedule was changed somewhere else. Reload it and try again.",
  notFound: "This agent has no schedule yet.",
} as const;

export type OwnScheduleErrorCode =
  | "invalid_schedule"
  | "validation_failed"
  | "schedule_changed"
  | "schedule_not_found";

/**
 * An expected refusal, with the status and code the API contract names.
 * `body` is the whole 400 answer of a validation_failed; `extra` carries
 * `reason` and `field` of an invalid_schedule.
 */
export class OwnScheduleError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: OwnScheduleErrorCode,
    message: string,
    readonly extra: { reason?: ScheduleRefusalReason | "no_next_run"; field?: string } = {},
    readonly body?: ValidationFailureBody,
  ) {
    super(message);
    this.name = "OwnScheduleError";
  }
}

const fieldRefusal = (field: string, message: string) =>
  new OwnScheduleError(400, "validation_failed", message, { field }, validationFailureFromFields({ [field]: message }));

const scheduleRefusal = (reason: ScheduleRefusalReason | "no_next_run", field: string) =>
  new OwnScheduleError(
    400,
    "invalid_schedule",
    reason === "invalid_timezone"
      ? OWN_SCHEDULE_MESSAGES.invalidTimezone
      : reason === "no_next_run"
        ? OWN_SCHEDULE_MESSAGES.noNextRun
        : OWN_SCHEDULE_MESSAGES.invalidCron,
    { reason, field },
  );

const scheduleChanged = () => new OwnScheduleError(409, "schedule_changed", OWN_SCHEDULE_MESSAGES.changed);

// ============================================
// Rows
// ============================================

export const OWN_SCHEDULE_COLUMNS = {
  id: true,
  name: true,
  isEnabled: true,
  status: true,
  scheduleType: true,
  cronExpression: true,
  intervalSeconds: true,
  scheduledAt: true,
  timezone: true,
  payload: true,
  timeout: true,
  maxRetries: true,
  nextRunAt: true,
  lastRunAt: true,
  lastRunStatus: true,
} as const;

/** A scheduled_tasks row, as selected by OWN_SCHEDULE_COLUMNS. */
export interface OwnScheduleRow {
  id: string;
  name: string;
  isEnabled: boolean;
  status: string;
  scheduleType: string;
  cronExpression: string | null;
  intervalSeconds: number | null;
  scheduledAt: Date | null;
  timezone: string;
  payload: unknown;
  timeout: number;
  maxRetries: number;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
}

/** What a page needs of an agent's own schedule. */
export interface OwnSchedule {
  /** The ScheduledTask id. For the owner only: never in a public answer. */
  id: string;
  name: string;
  enabled: boolean;
  /** active, paused, completed, failed or disabled, as the Scheduler shows it. */
  status: string;
  /** "cron" for every schedule made here; an older task may be "interval" or "once". */
  scheduleType: string;
  cronExpression: string | null;
  intervalSeconds: number | null;
  scheduledAt: Date | null;
  timezone: string;
  /** The stored payload: { prompt, stampTime?, deliver?: { alertChannelId? } }. */
  payload: unknown;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  maxRetries: number;
  /** Milliseconds, as stored (ScheduledTask.timeout). */
  timeoutMs: number;
}

function toOwnSchedule(row: OwnScheduleRow): OwnSchedule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.isEnabled,
    status: row.status,
    scheduleType: row.scheduleType,
    cronExpression: row.cronExpression,
    intervalSeconds: row.intervalSeconds,
    scheduledAt: row.scheduledAt,
    timezone: row.timezone,
    payload: row.payload,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastRunStatus: row.lastRunStatus,
    maxRetries: row.maxRetries,
    timeoutMs: row.timeout,
  };
}

/** The row an own schedule is first written as. */
export interface NewOwnScheduleRow {
  orgId: string;
  agentId: string;
  name: string;
  scheduleType: "cron";
  cronExpression: string;
  timezone: string;
  taskType: typeof OWN_SCHEDULE_TASK_TYPE;
  payload: AgentRunPayload;
  timeout: number;
  maxRetries: number;
  isEnabled: boolean;
  status: "active" | "paused";
  nextRunAt: Date;
}

/** What a write may change. */
export interface OwnScheduleWrite {
  isEnabled?: boolean;
  status?: "active" | "paused";
  scheduleType?: "cron";
  cronExpression?: string;
  intervalSeconds?: null;
  scheduledAt?: Date | null;
  timezone?: string;
  payload?: AgentRunPayload;
  timeout?: number;
  maxRetries?: number;
  nextRunAt?: Date;
}

/** A stored JSON object, as a payload is read back. */
type StoredJson = string | number | boolean | null | StoredJson[] | StoredJsonObject;
export type StoredJsonObject = { [key: string]: StoredJson };

/**
 * The slice of Prisma these reads and writes touch. A transaction client has
 * it, and so does the client itself.
 */
export interface OwnScheduleDb {
  scheduledTask: {
    findMany(args: {
      where: {
        orgId: string;
        agentId?: string;
        taskType?: string;
        name?: { startsWith: string };
      };
      orderBy?: Array<{ createdAt: "asc" } | { id: "asc" }>;
      take?: number;
      select: typeof OWN_SCHEDULE_COLUMNS;
    }): Promise<OwnScheduleRow[]>;
    count(args: { where: { orgId: string; agentId: string } }): Promise<number>;
    create(args: { data: NewOwnScheduleRow; select: typeof OWN_SCHEDULE_COLUMNS }): Promise<OwnScheduleRow>;
    updateMany(args: {
      where: {
        id?: string;
        orgId: string;
        agentId: string;
        isEnabled?: boolean;
        scheduleType?: string;
        cronExpression?: string | null;
        intervalSeconds?: number | null;
        timezone?: string;
        timeout?: number;
        maxRetries?: number;
        payload?: { equals: StoredJsonObject };
      };
      data: OwnScheduleWrite;
    }): Promise<{ count: number }>;
  };
  alertChannel: {
    findFirst(args: {
      where: { id: string; orgId: string };
      select: { type: true };
    }): Promise<{ type: string } | null>;
  };
  taskExecution: {
    findMany(args: {
      where: {
        taskId: string;
        status: "success";
        completedAt: { not: null };
        task: { orgId: string; agentId: string };
      };
      orderBy: Array<{ completedAt: "desc" } | { createdAt: "desc" }>;
      take: number;
      select: { completedAt: true; output: true };
    }): Promise<Array<{ completedAt: Date | null; output: unknown }>>;
  };
}

// ============================================
// Reading
// ============================================

async function ownRow(
  db: Pick<OwnScheduleDb, "scheduledTask">,
  args: { orgId: string; agentId: string },
): Promise<OwnScheduleRow | null> {
  const rows = await db.scheduledTask.findMany({
    where: { orgId: args.orgId, agentId: args.agentId, taskType: OWN_SCHEDULE_TASK_TYPE },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 1,
    select: OWN_SCHEDULE_COLUMNS,
  });
  return rows[0] ?? null;
}

/**
 * The agent's own schedule (null when it has none) and how many OTHER
 * scheduled tasks use the agent, of any type.
 */
export async function findOwnSchedule(
  db: Pick<OwnScheduleDb, "scheduledTask">,
  args: { orgId: string; agentId: string },
): Promise<{ schedule: OwnSchedule | null; otherTasks: number }> {
  const [row, total] = await Promise.all([
    ownRow(db, args),
    db.scheduledTask.count({ where: { orgId: args.orgId, agentId: args.agentId } }),
  ]);
  return {
    schedule: row ? toOwnSchedule(row) : null,
    otherTasks: Math.max(0, total - (row ? 1 : 0)),
  };
}

// ============================================
// The name
// ============================================

/**
 * "<agent name> (schedule)", at most 80 characters: a long agent name is
 * cut, the label is not. When that name is taken in the organization the
 * label counts up, "(schedule 2)", "(schedule 3)", as an agent's slug does.
 */
export function ownScheduleName(agentName: string, takenNames: Iterable<string>): string {
  const taken = new Set(takenNames);
  const base = agentName.trim() || "Agent";
  for (let counter = 1; ; counter++) {
    const label = counter === 1 ? " (schedule)" : ` (schedule ${counter})`;
    const name = `${base.slice(0, SCHEDULE_NAME_MAX - label.length).trimEnd()}${label}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Whether a failed write lost a race for a task name (the unique index on
 * scheduled_tasks org_id + name). Inside a transaction that error has ended
 * the transaction: the caller runs it again and the name is then seen as
 * taken. Duck-typed, so this file imports no database client.
 */
export function isScheduleNameConflict(err: unknown): boolean {
  const known = err as { code?: unknown; meta?: { target?: unknown } } | null;
  if (known?.code !== "P2002") return false;
  const target = known.meta?.target;
  if (target === undefined || target === null) return true;
  const text = Array.isArray(target) ? target.join(",") : String(target);
  return text.includes("name");
}

// ============================================
// Checking
// ============================================

export interface OwnScheduleInput {
  cronExpression: string;
  /** IANA name; UTC when absent. */
  timezone?: string | null;
  /** What it is told at each run; the default run line when absent or blank. */
  prompt?: string | null;
  /** Default true here. */
  stampTime?: boolean;
  /** Where results go; null or absent means they are only saved. */
  deliver?: { alertChannelId?: string | null } | null;
  timeoutSeconds?: number;
  maxRetries?: number;
}

export type OwnScheduleCheck =
  | {
      ok: true;
      cronExpression: string;
      timezone: string;
      nextRunAt: Date;
      /** What is stored as the task's payload. */
      payload: AgentRunPayload;
      /** Milliseconds. */
      timeout: number;
      maxRetries: number;
    }
  | { ok: false; error: OwnScheduleError };

function checkPayload(input: {
  prompt?: string | null;
  stampTime?: boolean;
  deliver?: { alertChannelId?: string | null } | null;
}): { ok: true; payload: AgentRunPayload } | { ok: false; error: OwnScheduleError } {
  const channelId = input.deliver?.alertChannelId;
  const candidate = {
    prompt: typeof input.prompt === "string" && input.prompt.trim() !== "" ? input.prompt : DEFAULT_RUN_LINE,
    ...(input.stampTime === undefined ? {} : { stampTime: input.stampTime }),
    ...(channelId ? { deliver: { alertChannelId: channelId } } : {}),
  };
  const parsed = getTaskType(OWN_SCHEDULE_TASK_TYPE)!.payload.safeParse(candidate);
  if (parsed.success) return { ok: true, payload: parsed.data as AgentRunPayload };
  const first = parsed.error.issues[0]?.path[0];
  return {
    ok: false,
    error:
      first === "deliver"
        ? fieldRefusal("deliver.alertChannelId", OWN_SCHEDULE_MESSAGES.placeNotFound)
        : fieldRefusal("prompt", OWN_SCHEDULE_MESSAGES.prompt),
  };
}

function checkLimits(input: { timeoutSeconds?: number; maxRetries?: number }): OwnScheduleError | null {
  const { timeoutSeconds, maxRetries } = input;
  if (
    timeoutSeconds !== undefined &&
    !(
      Number.isInteger(timeoutSeconds) &&
      timeoutSeconds >= OWN_SCHEDULE_TIMEOUT_SECONDS.min &&
      timeoutSeconds <= OWN_SCHEDULE_TIMEOUT_SECONDS.max
    )
  ) {
    return fieldRefusal("timeoutSeconds", OWN_SCHEDULE_MESSAGES.timeout);
  }
  if (
    maxRetries !== undefined &&
    !(Number.isInteger(maxRetries) && maxRetries >= 0 && maxRetries <= OWN_SCHEDULE_RETRY_LIMIT)
  ) {
    return fieldRefusal("maxRetries", OWN_SCHEDULE_MESSAGES.retries);
  }
  return null;
}

/**
 * Everything about a new schedule that can be checked without a database:
 * the times (validateSchedule: all five cron fields, an IANA time zone), the
 * payload against the agent_run type, the limits. Pure. The create route runs
 * it before it opens its transaction; whether the delivery place belongs to
 * the organization is checked inside the write.
 */
export function checkOwnSchedule(input: OwnScheduleInput, now: Date): OwnScheduleCheck {
  const schedule = validateSchedule(
    { scheduleType: "cron", cronExpression: input.cronExpression, timezone: input.timezone },
    now,
  );
  if (!schedule.ok) return { ok: false, error: scheduleRefusal(schedule.reason, schedule.field) };

  const payload = checkPayload({ ...input, stampTime: input.stampTime ?? true });
  if (!payload.ok) return payload;
  const limit = checkLimits(input);
  if (limit) return { ok: false, error: limit };

  return {
    ok: true,
    cronExpression: input.cronExpression.trim(),
    timezone: schedule.timezone,
    nextRunAt: schedule.nextRunAt,
    payload: payload.payload,
    timeout: (input.timeoutSeconds ?? OWN_SCHEDULE_TIMEOUT_SECONDS.default) * 1000,
    maxRetries: input.maxRetries ?? OWN_SCHEDULE_MAX_RETRIES,
  };
}

/**
 * The place results go must be one of this organization's alert channels and
 * of a kind that can carry a result here: the same rule a report's channel is
 * held to (checkDeliveryChannel). Throws the refusal.
 */
export async function assertDeliveryPlace(
  db: Pick<OwnScheduleDb, "alertChannel">,
  args: { orgId: string; channelId: string | undefined; emailConfigured: boolean },
): Promise<void> {
  const refusal = await checkDeliveryChannel(args.channelId, "result", {
    capabilities: {
      emailConfigured: args.emailConfigured,
      // Not read by the channel rule.
      workflowRunnerEnabled: false,
      deploymentRestartAvailable: false,
    },
    owns: {
      alertChannel: (id) =>
        db.alertChannel.findFirst({ where: { id, orgId: args.orgId }, select: { type: true } }),
    },
  });
  if (!refusal) return;
  const message =
    refusal.error === "invalid_task"
      ? OWN_SCHEDULE_MESSAGES.placeNotFound
      : refusal.message === RESULT_EMAIL_UNAVAILABLE_REASON
        ? OWN_SCHEDULE_MESSAGES.emailOff
        : OWN_SCHEDULE_MESSAGES.placeUnsupported;
  throw fieldRefusal("deliver.alertChannelId", message);
}

// ============================================
// Writing
// ============================================

export interface CreateOwnScheduleArgs extends OwnScheduleInput {
  orgId: string;
  agentId: string;
  agentName: string;
  /** Default true. A buyer's copy is created with false: suggested times, switched off. */
  enabled?: boolean;
  /** Whether this server can send email (isEmailConfigured()). */
  emailConfigured: boolean;
  /**
   * Who asked. scheduled_tasks has no column for it, so it is NOT stored;
   * taken so callers need not change when one is added.
   */
  createdBy?: string | null;
  now?: Date;
}

/**
 * Creates the agent's schedule: a cron task of type agent_run, stampTime on
 * and one retry unless said otherwise, its next run computed.
 *
 * Safe inside the transaction that creates the agent: it throws an
 * OwnScheduleError before any write when the times, the payload or the place
 * are not acceptable, and whatever it throws undoes the caller's transaction.
 * A lost race for the name is isScheduleNameConflict; the caller runs its
 * transaction again.
 */
export async function createOwnSchedule(tx: OwnScheduleDb, args: CreateOwnScheduleArgs): Promise<OwnSchedule> {
  const checked = checkOwnSchedule(args, args.now ?? new Date());
  if (!checked.ok) throw checked.error;
  await assertDeliveryPlace(tx, {
    orgId: args.orgId,
    channelId: checked.payload.deliver?.alertChannelId,
    emailConfigured: args.emailConfigured,
  });

  // Every name this one could clash with starts with the same cut of the
  // agent's name.
  const stem = (args.agentName.trim() || "Agent").slice(0, SCHEDULE_NAME_MAX - " (schedule 999)".length).trimEnd();
  const sameStem = await tx.scheduledTask.findMany({
    where: { orgId: args.orgId, name: { startsWith: stem } },
    select: OWN_SCHEDULE_COLUMNS,
  });
  const enabled = args.enabled ?? true;

  const row = await tx.scheduledTask.create({
    data: {
      orgId: args.orgId,
      agentId: args.agentId,
      name: ownScheduleName(args.agentName, sameStem.map((task) => task.name)),
      scheduleType: "cron",
      cronExpression: checked.cronExpression,
      timezone: checked.timezone,
      taskType: OWN_SCHEDULE_TASK_TYPE,
      payload: checked.payload,
      timeout: checked.timeout,
      maxRetries: checked.maxRetries,
      isEnabled: enabled,
      status: enabled ? "active" : "paused",
      nextRunAt: checked.nextRunAt,
    },
    select: OWN_SCHEDULE_COLUMNS,
  });
  return toOwnSchedule(row);
}

/** What PUT /api/agents/:id/schedule may change. An absent field keeps its value. */
export interface OwnScheduleChanges {
  enabled?: boolean;
  cronExpression?: string;
  timezone?: string;
  prompt?: string;
  stampTime?: boolean;
  /** null clears the place: results are then only saved. */
  deliver?: { alertChannelId?: string | null } | null;
  timeoutSeconds?: number;
  maxRetries?: number;
}

export interface UpdateOwnScheduleArgs {
  orgId: string;
  agentId: string;
  /** The schedule as the caller read it (findOwnSchedule). */
  expected: OwnSchedule;
  changes: OwnScheduleChanges;
  /** Whether this server can send email (isEmailConfigured()). */
  emailConfigured: boolean;
  now?: Date;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/**
 * Changes the agent's schedule as a compare-and-set against the row the
 * caller read: the write lands only while the fields a person can edit
 * (on or off, the times, the payload, the limits) are still what was read.
 * Otherwise nothing is written and a 409 schedule_changed is thrown. The
 * worker's own bookkeeping (next and last run) is not part of the
 * comparison, so a run finishing meanwhile is not a conflict.
 *
 * The next run is computed again when the times change, and when a schedule
 * that was off is turned on (so it runs at its next time, not at once for a
 * time that passed while it was off). New times make an older interval or
 * one-off task a cron task.
 *
 * Returns the schedule as it is after the write.
 */
export async function updateOwnSchedule(tx: OwnScheduleDb, args: UpdateOwnScheduleArgs): Promise<OwnSchedule> {
  const { expected, changes } = args;
  const now = args.now ?? new Date();
  const data: OwnScheduleWrite = {};

  const limit = checkLimits(changes);
  if (limit) throw limit;
  if (changes.timeoutSeconds !== undefined) data.timeout = changes.timeoutSeconds * 1000;
  if (changes.maxRetries !== undefined) data.maxRetries = changes.maxRetries;

  if (changes.prompt !== undefined || changes.stampTime !== undefined || changes.deliver !== undefined) {
    const stored = record(expected.payload);
    const storedPlace = record(stored.deliver).alertChannelId;
    const deliver =
      changes.deliver !== undefined
        ? changes.deliver
        : typeof storedPlace === "string"
          ? { alertChannelId: storedPlace }
          : null;
    const payload = checkPayload({
      prompt: changes.prompt ?? (typeof stored.prompt === "string" ? stored.prompt : null),
      stampTime: changes.stampTime ?? (typeof stored.stampTime === "boolean" ? stored.stampTime : undefined),
      deliver,
    });
    if (!payload.ok) throw payload.error;
    // A place that was already saved is not looked up again: only a newly
    // chosen one has to be this organization's.
    if (changes.deliver !== undefined) {
      await assertDeliveryPlace(tx, {
        orgId: args.orgId,
        channelId: payload.payload.deliver?.alertChannelId,
        emailConfigured: args.emailConfigured,
      });
    }
    data.payload = payload.payload;
  }

  const enabled = changes.enabled ?? expected.enabled;
  const scheduleType = changes.cronExpression !== undefined ? "cron" : expected.scheduleType;
  const cronExpression = changes.cronExpression?.trim() ?? expected.cronExpression;
  const timezone = changes.timezone ?? expected.timezone;
  const timesChanged =
    scheduleType !== expected.scheduleType ||
    cronExpression !== expected.cronExpression ||
    timezone !== expected.timezone;

  if (timesChanged) {
    const schedule = validateSchedule(
      {
        scheduleType,
        cronExpression,
        intervalSeconds: expected.intervalSeconds,
        scheduledAt: expected.scheduledAt,
        timezone,
      },
      now,
    );
    if (!schedule.ok) throw scheduleRefusal(schedule.reason, schedule.field);
    data.timezone = schedule.timezone;
    data.nextRunAt = schedule.nextRunAt;
    if (changes.cronExpression !== undefined) {
      data.scheduleType = "cron";
      data.cronExpression = cronExpression ?? undefined;
      data.intervalSeconds = null;
      data.scheduledAt = null;
    }
    // New, valid times restart a task that had finished its one-off run or
    // was stopped for an unreadable schedule, as on the Scheduler page.
    data.status = enabled ? "active" : "paused";
  } else if (enabled && !expected.enabled) {
    const nextRunAt = nextRun(expected, now);
    if (!nextRunAt) throw scheduleRefusal("no_next_run", "enabled");
    data.nextRunAt = nextRunAt;
    data.status = "active";
  } else if (!enabled && expected.enabled) {
    data.status = "paused";
  }
  if (changes.enabled !== undefined) data.isEnabled = changes.enabled;

  const written = await tx.scheduledTask.updateMany({
    where: {
      id: expected.id,
      orgId: args.orgId,
      agentId: args.agentId,
      isEnabled: expected.enabled,
      scheduleType: expected.scheduleType,
      cronExpression: expected.cronExpression,
      intervalSeconds: expected.intervalSeconds,
      timezone: expected.timezone,
      timeout: expected.timeoutMs,
      maxRetries: expected.maxRetries,
      // A payload is always an object; a row read with anything else is not compared on it.
      ...(typeof expected.payload === "object" && expected.payload !== null && !Array.isArray(expected.payload)
        ? { payload: { equals: expected.payload as StoredJsonObject } }
        : {}),
    },
    data,
  });
  if (written.count === 0) throw scheduleChanged();

  const current = await ownRow(tx, args);
  // The oldest agent_run task is still this one unless it was deleted since.
  if (!current || current.id !== expected.id) throw scheduleChanged();
  return toOwnSchedule(current);
}

/**
 * Turns the agent's own schedule on or off, as a compare-and-set on its
 * enabled column. `{ changed: false }` is not an error: there was no
 * schedule, it was already so, another request got there first, or (turning
 * on) it has no future run. Used when an agent's kind leaves "scheduled".
 */
export async function setOwnScheduleEnabled(
  tx: Pick<OwnScheduleDb, "scheduledTask">,
  args: { orgId: string; agentId: string; enabled: boolean; now?: Date },
): Promise<{ changed: boolean; taskId: string | null }> {
  const row = await ownRow(tx, args);
  if (!row) return { changed: false, taskId: null };
  if (row.isEnabled === args.enabled) return { changed: false, taskId: row.id };

  const data: OwnScheduleWrite = { isEnabled: args.enabled, status: args.enabled ? "active" : "paused" };
  if (args.enabled) {
    const nextRunAt = nextRun(row, args.now ?? new Date());
    if (!nextRunAt) return { changed: false, taskId: row.id };
    data.nextRunAt = nextRunAt;
  }
  const written = await tx.scheduledTask.updateMany({
    where: { id: row.id, orgId: args.orgId, agentId: args.agentId, isEnabled: !args.enabled },
    data,
  });
  return { changed: written.count > 0, taskId: row.id };
}

/**
 * Switches off EVERY scheduled task of the agent, of any type, in this
 * organization, and says how many were on. Used when a buyer's copy is
 * uninstalled. The tasks and their history stay.
 */
export async function pauseAgentSchedules(
  tx: Pick<OwnScheduleDb, "scheduledTask">,
  args: { orgId: string; agentId: string },
): Promise<number> {
  const written = await tx.scheduledTask.updateMany({
    where: { orgId: args.orgId, agentId: args.agentId, isEnabled: true },
    data: { isEnabled: false, status: "paused" },
  });
  return written.count;
}

// ============================================
// Results
// ============================================

/**
 * The answer of a finished agent run, as stored on its execution:
 * TaskExecution.output.content (services/executeScheduledTask.ts,
 * runAgentTask). Null when the output holds no text.
 */
export function answerTextOf(output: unknown): string | null {
  const content = record(output).content;
  return typeof content === "string" && content.trim() !== "" ? content : null;
}

function cut(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const end = maxChars > 0 && /[\uD800-\uDBFF]/.test(text[maxChars - 1]!) ? maxChars - 1 : maxChars;
  return text.slice(0, Math.max(0, end));
}

/**
 * The latest successful results of the agent's own schedule, newest first:
 * when each finished and its answer text, cut at maxChars. Nothing else
 * leaves here: no input, no prompt, no failed run and no reason for one, no
 * delivery place, no task or execution id. It is what a public page may show.
 */
export async function latestOwnResults(
  db: Pick<OwnScheduleDb, "scheduledTask" | "taskExecution">,
  args: { orgId: string; agentId: string; limit: number; maxChars: number },
): Promise<Array<{ finishedAt: Date; text: string }>> {
  if (args.limit <= 0) return [];
  const row = await ownRow(db, args);
  if (!row) return [];
  const executions = await db.taskExecution.findMany({
    where: {
      taskId: row.id,
      status: "success",
      completedAt: { not: null },
      task: { orgId: args.orgId, agentId: args.agentId },
    },
    orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
    // A few more than asked: a success with no text is passed over.
    take: args.limit + 5,
    select: { completedAt: true, output: true },
  });
  const results: Array<{ finishedAt: Date; text: string }> = [];
  for (const execution of executions) {
    const text = answerTextOf(execution.output);
    if (!execution.completedAt || text === null) continue;
    results.push({ finishedAt: execution.completedAt, text: cut(text, args.maxChars) });
    if (results.length === args.limit) break;
  }
  return results;
}
