/**
 * An agent's own schedule and its runs, as the agent page reads and changes
 * them. The reads and writes of the schedule itself are
 * services/agentOwnSchedule.ts; this file shapes them for a page and adds
 * the runs:
 *
 *   getAgentSchedule      the schedule, the suggested times, how many other
 *                         tasks use the agent, whether timed runs fire here
 *   putAgentSchedule      creates the schedule, or changes it by
 *                         compare-and-set against the row this request read
 *   runAgentScheduleNow   one run now, through the Scheduler's own "run now"
 *                         (deps.runNow), so it is billed, bounded, recorded
 *                         and delivered exactly like a timed run
 *   listAgentRuns         the schedule's executions, newest first
 *   resendRunResult       "Send again": posts the STORED result of a
 *                         finished run to the schedule's current place
 *
 * Everything is scoped to the caller's organization: the agent is read with
 * its organization, the schedule is found through it, and a run is only ever
 * read by the schedule's id. Another organization's agent, schedule or run is
 * "not found".
 *
 * resendRunResult takes ResendDeps, a slice that has no way to start a run:
 * it reads a stored row and calls the delivery senders. It cannot reach the
 * executor, a model or a charge, and the type says so.
 *
 * A place results go to is answered by id, name and type only. Its link or
 * address never leaves here.
 *
 * No database client is imported: production wiring is
 * buildAgentScheduleDeps.ts.
 */

import { z } from "zod";

import { validationFailureFromFields } from "../lib/validationFailure.js";
import {
  checkOwnSchedule,
  createOwnSchedule,
  findOwnSchedule,
  isScheduleNameConflict,
  OWN_SCHEDULE_MESSAGES,
  OwnScheduleError,
  answerTextOf,
  updateOwnSchedule,
  type OwnSchedule,
  type OwnScheduleChanges,
  type OwnScheduleDb,
} from "./agentOwnSchedule.js";
import { isTaskTimeoutError } from "./runSchedulerTick.js";
import {
  deliverResult,
  resultChannelIdOf,
  type DeliveryRecord,
  type DeliveryStatus,
  type ResultDeliveryDeps,
} from "./scheduledTasks/resultDelivery.js";

// ============================================
// Words
// ============================================

export const AGENT_SCHEDULE_MESSAGES = {
  agentNotFound: "Agent not found",
  runNotFound: "Run not found",
  alreadyRunning: "This agent is already running. Wait for it to finish.",
  runNotFinished: "Only a finished run has a result to send.",
  noPlace: "Choose where results go first, then send again.",
} as const;

/** "Why a run did not finish", as the agent page words it. */
export const RUN_FAILURE_MESSAGES = {
  timeLimit: "This run took longer than its time limit and was stopped.",
  interrupted: "This run was interrupted before it finished.",
  freeModelLimit:
    "Your free-model limit was reached, so this run did not start. It will try again at the next scheduled time.",
  noModel: "No model is available for this agent right now. Nothing was charged.",
  other: "This run could not be completed.",
} as const;

export type AgentScheduleErrorCode =
  | "not_found"
  | "schedule_not_found"
  | "already_running"
  | "run_not_finished"
  | "no_place"
  | "delivery_failed";

/** An expected refusal, with the status and code the API contract names. */
export class AgentScheduleError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    readonly code: AgentScheduleErrorCode,
    message: string,
    /** Sent beside error and message. */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AgentScheduleError";
  }
}

const agentNotFound = () => new AgentScheduleError(404, "not_found", AGENT_SCHEDULE_MESSAGES.agentNotFound);
const runNotFound = () => new AgentScheduleError(404, "not_found", AGENT_SCHEDULE_MESSAGES.runNotFound);
const scheduleNotFound = () => new AgentScheduleError(404, "schedule_not_found", OWN_SCHEDULE_MESSAGES.notFound);

// ============================================
// Shapes
// ============================================

/** A place results can go to. Never its link or its address. */
export interface PlaceView {
  channelId: string;
  /** "" when the place was removed since it was chosen. */
  name: string;
  /** slack, discord, webhook or email; "unknown" when the place was removed. */
  type: string;
}

/** The agent's own schedule, as a page shows it. */
export interface ScheduleView {
  id: string;
  enabled: boolean;
  /** Null only for an older task that runs on an interval or once. */
  cronExpression: string | null;
  timezone: string;
  prompt: string;
  stampTime: boolean;
  deliver: PlaceView | null;
  timeoutSeconds: number;
  maxRetries: number;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
}

/** The times and the line a template or a creator suggested. */
export interface SuggestedSchedule {
  schedule?: { cronExpression: string; timezone?: string };
  prompt?: string;
}

export interface AgentScheduleAnswer {
  schedule: ScheduleView | null;
  suggested: SuggestedSchedule | null;
  /** The agent's other scheduled tasks; they are on the Scheduler page. */
  otherTasks: number;
  /** False while no worker here fires schedules: runs can still be started by hand. */
  schedulerRunning: boolean;
}

export type RunStatus = "running" | "finished" | "did_not_finish" | "stopped";

export interface RunView {
  id: string;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  startedBy: "schedule" | "person";
  /** The answer of a finished run; null otherwise. */
  text: string | null;
  /** One plain sentence when the run did not finish; null otherwise. */
  failure: string | null;
  delivery: DeliveryRecord[];
}

/** A task_executions row, as far as a run is read. */
export interface RunRow {
  id: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  triggeredBy: string;
  output: unknown;
  error: string | null;
  delivery: unknown;
  createdAt: Date;
}

// ============================================
// Dependencies
// ============================================

export interface AgentScheduleDeps {
  /** Reads outside a transaction. */
  db: OwnScheduleDb;
  /** Runs `fn` in one database transaction; what it throws undoes it. */
  transaction<T>(fn: (tx: OwnScheduleDb) => Promise<T>): Promise<T>;
  /**
   * Locks the agent's row until `tx` ends (SELECT ... FOR UPDATE) and answers
   * its name as it is under that lock; null when it is gone. MUST scope by
   * orgId. Two first saves of a schedule take turns on it.
   */
  lockAgent(tx: OwnScheduleDb, where: { orgId: string; agentId: string }): Promise<{ name: string } | null>;
  /** MUST scope by orgId: another organization's agent is "not found". */
  loadAgent(where: { orgId: string; agentId: string }): Promise<{ id: string; name: string; kindConfig: unknown } | null>;
  /** MUST scope by orgId. Only what a page may show of a place. */
  loadPlace(channelId: string, orgId: string): Promise<{ id: string; name: string; type: string } | null>;
  runs: {
    /** Newest first (createdAt, then id), `limit` rows, after the run `before` when given. */
    list(args: { taskId: string; limit: number; before?: string }): Promise<RunRow[]>;
    find(args: { taskId: string; runId: string }): Promise<RunRow | null>;
    /**
     * Adds records to the end of a finished run's delivery list, in one
     * statement. False when the run is not there or is not finished.
     */
    appendDelivery(args: { taskId: string; runId: string; records: DeliveryRecord[] }): Promise<boolean>;
  };
  /**
   * The Scheduler's "run now" (services/scheduler.ts, triggerTask): the same
   * firing the worker uses. Throws its own refusal for a run in flight.
   */
  runNow(taskId: string, orgId: string): Promise<{ execution: RunRow }>;
  /** Whether a worker in this deployment fires schedules at all. */
  schedulerRunning(): boolean | Promise<boolean>;
  /** Whether this server can send email. */
  emailConfigured(): boolean;
  /** Built on first use, so reading a schedule opens no sender. */
  delivery(): ResultDeliveryDeps;
  now?: () => Date;
}

/** What "Send again" may touch. There is no way to start a run in here. */
export type ResendDeps = Pick<AgentScheduleDeps, "db" | "loadAgent" | "runs" | "delivery">;

// ============================================
// Pure
// ============================================

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The four words a run is shown with, from the stored status. */
export function runStatusOf(stored: string): RunStatus {
  switch (stored) {
    case "pending":
    case "running":
      return "running";
    case "success":
      return "finished";
    case "cancelled":
      return "stopped";
    // failed, timeout, and anything this code does not know.
    default:
      return "did_not_finish";
  }
}

/**
 * The stored error of a run that did not finish, as one plain sentence. The
 * stored text is what the executor recorded (the time-limit line, a lost run, a
 * refusal of the chat core, a provider's message) and is never shown.
 */
export function runFailureMessage(stored: string | null | undefined): string {
  // Only the scheduler's own time limit (taskTimeoutError): a provider or a
  // tool that timed out inside the run falls to "could not be completed".
  if (isTaskTimeoutError(stored)) return RUN_FAILURE_MESSAGES.timeLimit;
  const error = (stored ?? "").toLowerCase();
  if (/free-model limit|free model limit|free-tier limit/.test(error)) return RUN_FAILURE_MESSAGES.freeModelLimit;
  if (
    /run lost|worker stopped|server is restarting|shutting down|was aborted|\babort|client disconnected|interrupted/.test(
      error,
    )
  ) {
    return RUN_FAILURE_MESSAGES.interrupted;
  }
  if (
    /no model is available|no (healthy|usable) node|provider (is )?not configured|model_provider_not_configured|hosted_model_not_available|no model configured/.test(
      error,
    )
  ) {
    return RUN_FAILURE_MESSAGES.noModel;
  }
  return RUN_FAILURE_MESSAGES.other;
}

/** Who started a run, from what its execution records. */
export function startedByOf(triggeredBy: string): "schedule" | "person" {
  return triggeredBy === "manual" ? "person" : "schedule";
}

const DELIVERY_STATUSES: readonly string[] = ["sent", "failed", "skipped"] satisfies DeliveryStatus[];

/**
 * The stored delivery list. Each record is copied field by field, so nothing
 * but a place's id, name and type, how it went and when can leave with it.
 */
export function deliveryListOf(stored: unknown): DeliveryRecord[] {
  if (!Array.isArray(stored)) return [];
  const list: DeliveryRecord[] = [];
  for (const entry of stored) {
    const item = record(entry);
    if (typeof item.channelId !== "string" || !DELIVERY_STATUSES.includes(item.status as string)) continue;
    list.push({
      channelId: item.channelId,
      name: typeof item.name === "string" ? item.name : "",
      type: typeof item.type === "string" ? item.type : "unknown",
      status: item.status as DeliveryStatus,
      ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
      at: typeof item.at === "string" ? item.at : "",
    });
  }
  return list;
}

export function toRunView(row: RunRow): RunView {
  const status = runStatusOf(row.status);
  return {
    id: row.id,
    status,
    startedAt: row.startedAt ?? row.createdAt,
    finishedAt: status === "running" ? null : row.completedAt,
    durationMs: status === "running" ? null : row.durationMs,
    startedBy: startedByOf(row.triggeredBy),
    text: status === "finished" ? answerTextOf(row.output) : null,
    failure: status === "did_not_finish" ? runFailureMessage(row.error) : null,
    delivery: deliveryListOf(row.delivery),
  };
}

/** What kindConfig.scheduled carries, or null. Known fields only. */
export function suggestedOf(kindConfig: unknown): SuggestedSchedule | null {
  const scheduled = record(kindConfig).scheduled;
  if (typeof scheduled !== "object" || scheduled === null || Array.isArray(scheduled)) return null;
  const { schedule, prompt } = scheduled as Record<string, unknown>;
  const times = record(schedule);
  const suggested: SuggestedSchedule = {};
  if (typeof times.cronExpression === "string") {
    suggested.schedule = {
      cronExpression: times.cronExpression,
      ...(typeof times.timezone === "string" ? { timezone: times.timezone } : {}),
    };
  }
  if (typeof prompt === "string") suggested.prompt = prompt;
  return suggested;
}

/** "Not sent to Team Slack: it did not accept the message. The result is saved here." */
export function notSentMessage(sent: Pick<DeliveryRecord, "name" | "reason">): string {
  const where = sent.name ? `Not sent to ${sent.name}` : "Not sent";
  return `${where}: ${sent.reason ?? "it could not be reached"}. The result is saved here.`;
}

// ============================================
// The schedule
// ============================================

/** PUT /api/agents/:agentId/schedule. Limits and times are the service's to word. */
export const scheduleBodySchema = z
  .object({
    enabled: z.boolean(),
    cronExpression: z.string().trim().min(1, OWN_SCHEDULE_MESSAGES.invalidCron).max(100, OWN_SCHEDULE_MESSAGES.invalidCron),
    timezone: z.string().min(1, OWN_SCHEDULE_MESSAGES.invalidTimezone).max(64, OWN_SCHEDULE_MESSAGES.invalidTimezone).optional(),
    prompt: z.string().optional(),
    stampTime: z.boolean().optional(),
    deliver: z
      .object({ channelId: z.string().uuid(OWN_SCHEDULE_MESSAGES.placeNotFound) })
      .strict()
      .nullable()
      .optional(),
    timeoutSeconds: z.number().optional(),
    maxRetries: z.number().optional(),
  })
  .strict();

export type ScheduleBody = z.infer<typeof scheduleBodySchema>;

async function placeOf(
  deps: Pick<AgentScheduleDeps, "loadPlace">,
  orgId: string,
  schedule: OwnSchedule,
): Promise<PlaceView | null> {
  const channelId = record(record(schedule.payload).deliver).alertChannelId;
  if (typeof channelId !== "string" || channelId === "") return null;
  const place = await deps.loadPlace(channelId, orgId);
  // Removed since it was chosen: the page says so and offers another place.
  return place ? { channelId, name: place.name, type: place.type } : { channelId, name: "", type: "unknown" };
}

async function scheduleView(
  deps: Pick<AgentScheduleDeps, "loadPlace">,
  orgId: string,
  schedule: OwnSchedule,
): Promise<ScheduleView> {
  const payload = record(schedule.payload);
  return {
    id: schedule.id,
    enabled: schedule.enabled,
    cronExpression: schedule.cronExpression,
    timezone: schedule.timezone,
    prompt: typeof payload.prompt === "string" ? payload.prompt : "",
    stampTime: payload.stampTime === true,
    deliver: await placeOf(deps, orgId, schedule),
    timeoutSeconds: Math.round(schedule.timeoutMs / 1000),
    maxRetries: schedule.maxRetries,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    lastRunStatus: schedule.lastRunStatus,
  };
}

/** Fails closed: a state that cannot be read is "not running". */
async function schedulerRunning(deps: Pick<AgentScheduleDeps, "schedulerRunning">): Promise<boolean> {
  try {
    return (await deps.schedulerRunning()) === true;
  } catch {
    return false;
  }
}

export async function getAgentSchedule(
  deps: Pick<AgentScheduleDeps, "db" | "loadAgent" | "loadPlace" | "schedulerRunning">,
  orgId: string,
  agentId: string,
): Promise<AgentScheduleAnswer> {
  const agent = await deps.loadAgent({ orgId, agentId });
  if (!agent) throw agentNotFound();
  const found = await findOwnSchedule(deps.db, { orgId, agentId });
  return {
    schedule: found.schedule ? await scheduleView(deps, orgId, found.schedule) : null,
    suggested: suggestedOf(agent.kindConfig),
    otherTasks: found.otherTasks,
    schedulerRunning: await schedulerRunning(deps),
  };
}

/** The place field as the request names it, and as the stored payload does. */
const SENT_PLACE_FIELD = "deliver.channelId";
const STORED_PLACE_FIELD = "deliver.alertChannelId";

/**
 * A refusal of the place, named the way this request names the field. The
 * schedule's own writes (agentOwnSchedule.ts) name it as the payload stores
 * it, which is right for their other callers and not for a PUT.
 */
function asSent(err: unknown): unknown {
  if (!(err instanceof OwnScheduleError) || err.extra.field !== STORED_PLACE_FIELD) return err;
  return new OwnScheduleError(
    err.status,
    err.code,
    err.message,
    { ...err.extra, field: SENT_PLACE_FIELD },
    validationFailureFromFields({ [SENT_PLACE_FIELD]: err.message }),
  );
}

/** How often a create is run again after losing a race for the task's name. */
const NAME_RACE_ATTEMPTS = 3;

/**
 * Creates the agent's schedule when it has none; otherwise changes it by
 * compare-and-set against the row read here (409 schedule_changed, nothing
 * written). An agent of any kind may have a schedule.
 */
export async function putAgentSchedule(
  deps: Pick<
    AgentScheduleDeps,
    "db" | "transaction" | "lockAgent" | "loadAgent" | "loadPlace" | "schedulerRunning" | "emailConfigured" | "now"
  >,
  orgId: string,
  agentId: string,
  body: ScheduleBody,
): Promise<AgentScheduleAnswer> {
  const agent = await deps.loadAgent({ orgId, agentId });
  if (!agent) throw agentNotFound();
  const scope = { orgId, agentId };
  const now = deps.now?.() ?? new Date();
  const emailConfigured = deps.emailConfigured() === true;
  const deliver =
    body.deliver === undefined ? undefined : body.deliver === null ? null : { alertChannelId: body.deliver.channelId };

  const read = await findOwnSchedule(deps.db, scope);

  try {
    await writeSchedule();
  } catch (err) {
    throw asSent(err);
  }
  return getAgentSchedule(deps, orgId, agentId);

  async function writeSchedule(): Promise<void> {
    if (!read.schedule) {
      const input = {
        cronExpression: body.cronExpression,
        timezone: body.timezone,
        prompt: body.prompt,
        stampTime: body.stampTime,
        deliver,
        timeoutSeconds: body.timeoutSeconds,
        maxRetries: body.maxRetries,
      };
      // Before a transaction is opened: unreadable times write nothing.
      const checked = checkOwnSchedule(input, now);
      if (!checked.ok) throw checked.error;

      for (let attempt = 1; ; attempt++) {
        try {
          await deps.transaction(async (tx) => {
            // First, the agent's row lock: two first saves at the same moment
            // take turns here, so the second sees the first one's schedule
            // whatever name it was given.
            const locked = await deps.lockAgent(tx, scope);
            if (!locked) throw agentNotFound();
            // Another request made one since the read above: this one lost.
            const again = await findOwnSchedule(tx, scope);
            if (again.schedule) throw new OwnScheduleError(409, "schedule_changed", OWN_SCHEDULE_MESSAGES.changed);
            return createOwnSchedule(tx, {
              ...input,
              ...scope,
              // As it is under the lock, not as it was read before it.
              agentName: locked.name,
              enabled: body.enabled,
              emailConfigured,
              now,
            });
          });
          break;
        } catch (err) {
          // The clash ended that transaction; the name is seen as taken on the next.
          if (isScheduleNameConflict(err) && attempt < NAME_RACE_ATTEMPTS) continue;
          throw err;
        }
      }
    } else {
      const expected = read.schedule;
      const changes: OwnScheduleChanges = {
        enabled: body.enabled,
        cronExpression: body.cronExpression,
        ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
        ...(body.prompt === undefined ? {} : { prompt: body.prompt }),
        ...(body.stampTime === undefined ? {} : { stampTime: body.stampTime }),
        ...(body.timeoutSeconds === undefined ? {} : { timeoutSeconds: body.timeoutSeconds }),
        ...(body.maxRetries === undefined ? {} : { maxRetries: body.maxRetries }),
      };
      // The place as it is saved is not a change, so it is not looked up again
      // (and is not refused because email was turned off since).
      const storedPlace = record(record(expected.payload).deliver).alertChannelId;
      const samePlace = deliver === null ? typeof storedPlace !== "string" : deliver?.alertChannelId === storedPlace;
      if (deliver !== undefined && !samePlace) changes.deliver = deliver;

      await deps.transaction((tx) => updateOwnSchedule(tx, { ...scope, expected, changes, emailConfigured, now }));
    }
  }
}

// ============================================
// Runs
// ============================================

export const RUNS_PAGE = { default: 20, max: 100 } as const;

/**
 * Starts the own schedule's run now. The run is the Scheduler's (deps.runNow):
 * this function adds nothing to it and writes nothing itself.
 */
export async function runAgentScheduleNow(
  deps: Pick<AgentScheduleDeps, "db" | "loadAgent" | "runNow">,
  orgId: string,
  agentId: string,
): Promise<{ run: RunView }> {
  const agent = await deps.loadAgent({ orgId, agentId });
  if (!agent) throw agentNotFound();
  const { schedule } = await findOwnSchedule(deps.db, { orgId, agentId });
  if (!schedule) throw scheduleNotFound();

  try {
    const { execution } = await deps.runNow(schedule.id, orgId);
    return { run: toRunView(execution) };
  } catch (err) {
    // Matched by shape: the Scheduler's refusal need not share a class.
    const refusal = err as { name?: unknown; code?: unknown } | null;
    if (refusal?.name === "SchedulerError") {
      if (refusal.code === "already_running") {
        throw new AgentScheduleError(409, "already_running", AGENT_SCHEDULE_MESSAGES.alreadyRunning);
      }
      // Deleted between the read above and the run.
      if (refusal.code === "not_found") throw scheduleNotFound();
    }
    throw err;
  }
}

/** The own schedule's executions, newest first. An agent with no schedule has none. */
export async function listAgentRuns(
  deps: Pick<AgentScheduleDeps, "db" | "loadAgent" | "runs">,
  orgId: string,
  agentId: string,
  page: { limit?: number; before?: string } = {},
): Promise<{ runs: RunView[]; hasMore: boolean }> {
  const agent = await deps.loadAgent({ orgId, agentId });
  if (!agent) throw agentNotFound();
  const { schedule } = await findOwnSchedule(deps.db, { orgId, agentId });
  if (!schedule) return { runs: [], hasMore: false };

  const limit = Math.min(Math.max(1, page.limit ?? RUNS_PAGE.default), RUNS_PAGE.max);
  // One more than asked says whether there is another page.
  const rows = await deps.runs.list({ taskId: schedule.id, limit: limit + 1, before: page.before });
  return { runs: rows.slice(0, limit).map(toRunView), hasMore: rows.length > limit };
}

/**
 * "Send again": posts the stored result of a finished run to the place the
 * schedule names now, and adds how that went to the run's delivery list.
 * Runs nothing. When the place did not take it the record is stored all the
 * same and a 502 delivery_failed carries the plain reason and the run.
 */
export async function resendRunResult(
  deps: ResendDeps,
  orgId: string,
  agentId: string,
  runId: string,
): Promise<{ run: RunView }> {
  const agent = await deps.loadAgent({ orgId, agentId });
  if (!agent) throw agentNotFound();
  const { schedule } = await findOwnSchedule(deps.db, { orgId, agentId });
  // A run is only ever looked for under this agent's own schedule.
  if (!schedule) throw runNotFound();
  const scope = { taskId: schedule.id, runId };
  const run = await deps.runs.find(scope);
  if (!run) throw runNotFound();
  if (run.status !== "success") {
    throw new AgentScheduleError(409, "run_not_finished", AGENT_SCHEDULE_MESSAGES.runNotFinished);
  }
  const task = { name: schedule.name, taskType: "agent_run", payload: schedule.payload };
  if (!resultChannelIdOf(task)) throw new AgentScheduleError(400, "no_place", AGENT_SCHEDULE_MESSAGES.noPlace);

  const records = await deliverResult(deps.delivery(), {
    orgId,
    task,
    execution: { id: run.id, finishedAt: run.completedAt },
    text: answerTextOf(run.output) ?? "",
  });
  if (!(await deps.runs.appendDelivery({ ...scope, records }))) throw runNotFound();

  const view = toRunView((await deps.runs.find(scope)) ?? { ...run, delivery: [...deliveryListOf(run.delivery), ...records] });
  const sent = records[records.length - 1];
  if (!sent || sent.status !== "sent") {
    throw new AgentScheduleError(502, "delivery_failed", notSentMessage(sent ?? { name: "" }), { run: view });
  }
  return { run: view };
}
