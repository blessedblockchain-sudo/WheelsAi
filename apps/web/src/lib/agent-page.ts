/**
 * The rules of the agent page's tabs that are not layout: what the schedule
 * form sends, where a refusal's sentences go, what a kind change asks, what a
 * delete warns about, what a run cost, and which listing is this agent's.
 * Pure, so the tabs only lay them out.
 *
 * It reads errors by shape (`status` and `data`), as the delivery picker
 * does, so nothing here needs the API client.
 */
import type { AgentKind } from "@wheelsai/shared/agent-kind";
import {
  DEFAULT_SCHEDULE_CHOICE,
  choiceToCron,
  cronToChoice,
  describeSchedule,
} from "@wheelsai/shared/schedule-choice";

import { KIND_CHOICES } from "./agent-list";

// ============================================
// Reading a refusal
// ============================================

/** The HTTP status of a failed call, or null for anything else that was thrown. */
export function statusOf(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function bodyOf(err: unknown): Record<string, unknown> | null {
  const data = (err as { data?: unknown } | null)?.data;
  return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

/** The API's own name for a refusal (`schedule_changed`, `already_running`), or null. */
export function codeOf(err: unknown): string | null {
  const code = bodyOf(err)?.error;
  return typeof code === "string" ? code : null;
}

/** The server's sentence for a refusal, or null when it sent none. */
export function sentenceOf(err: unknown): string | null {
  const message = bodyOf(err)?.message;
  return typeof message === "string" && message.trim() ? message : null;
}

// ============================================
// The schedule form
// ============================================

/** The schedule card and the delivery card, as typed. */
export interface ScheduleForm {
  enabled: boolean;
  cronExpression: string;
  timezone: string;
  /** What the agent is told at each run. */
  prompt: string;
  stampTime: boolean;
  /** Where results go; null is "Only here". */
  channelId: string | null;
  /** Typed, so an unfinished number can sit in its input. "" leaves the server's own value. */
  timeoutSeconds: string;
  maxRetries: string;
}

/** The parts of the schedule a problem can be filed under; `form` is the schedule as a whole. */
export type ScheduleFormField =
  | "cronExpression"
  | "timezone"
  | "prompt"
  | "deliver"
  | "timeoutSeconds"
  | "maxRetries"
  | "form";

export type ScheduleFormErrors = Partial<Record<ScheduleFormField, string>>;

interface ScheduleLike {
  enabled: boolean;
  cronExpression: string | null;
  timezone: string;
  prompt: string;
  stampTime: boolean;
  deliver: { channelId: string } | null;
  timeoutSeconds: number;
  maxRetries: number;
}

interface SuggestedLike {
  schedule?: { cronExpression: string; timezone?: string };
  prompt?: string;
}

export interface ScheduleAnswerLike {
  schedule: ScheduleLike | null;
  suggested: SuggestedLike | null;
}

/** Every day at 09:00: what a new schedule starts on when nothing was suggested. */
export const DEFAULT_CRON = choiceToCron(DEFAULT_SCHEDULE_CHOICE);

export const SCHEDULE_LIMITS = {
  timeoutSeconds: { min: 5, max: 3600 },
  maxRetries: { min: 0, max: 5 },
} as const;

export const SCHEDULE_MESSAGES = {
  timeoutSeconds: "Enter a whole number of seconds from 5 to 3,600.",
  maxRetries: "Enter a whole number of tries from 0 to 5.",
  schedulerPaused: "Scheduled runs are temporarily paused. You can still run it by hand.",
  setUpTail: "Turn the schedule on to start. You choose the times and where results go.",
  promptEmpty: "Left empty, it is told the standard line.",
  runningNow: "Running now. The result shows here when it is done.",
  on: "Schedule is on",
  off: "Schedule is off",
} as const;

/**
 * The form as the page opens it. With a schedule: the schedule. With none:
 * the suggested times when there are any, else every day at 09:00, in the
 * suggested zone or the viewer's own. A new schedule tells the agent the
 * date and time, as schedules made on the agent page do.
 */
export function scheduleFormOf(answer: ScheduleAnswerLike, viewerTimezone: string): ScheduleForm {
  const schedule = answer.schedule;
  if (schedule) {
    return {
      enabled: schedule.enabled,
      cronExpression: schedule.cronExpression ?? DEFAULT_CRON,
      timezone: schedule.timezone || viewerTimezone || "UTC",
      prompt: schedule.prompt ?? "",
      stampTime: schedule.stampTime,
      channelId: schedule.deliver?.channelId ?? null,
      timeoutSeconds: String(schedule.timeoutSeconds),
      maxRetries: String(schedule.maxRetries),
    };
  }
  const suggested = answer.suggested;
  return {
    enabled: true,
    cronExpression: suggested?.schedule?.cronExpression?.trim() || DEFAULT_CRON,
    timezone: suggested?.schedule?.timezone?.trim() || viewerTimezone || "UTC",
    prompt: suggested?.prompt ?? "",
    stampTime: true,
    channelId: null,
    timeoutSeconds: "",
    maxRetries: "",
  };
}

function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** Problems that can be told before the form is sent. Empty when it can go. */
export function checkScheduleForm(form: ScheduleForm): ScheduleFormErrors {
  const errors: ScheduleFormErrors = {};
  for (const field of ["timeoutSeconds", "maxRetries"] as const) {
    if (form[field].trim() === "") continue;
    const value = wholeNumber(form[field]);
    const { min, max } = SCHEDULE_LIMITS[field];
    if (value === null || value < min || value > max) errors[field] = SCHEDULE_MESSAGES[field];
  }
  return errors;
}

/**
 * The body of a PUT of the schedule: all of it, so one save never undoes
 * another card's change. The line is always sent: the API reads an empty one
 * as "the standard line" and answers with that line, where leaving it out
 * would keep the old one and the cleared box would fill again unexplained.
 */
export function scheduleBodyOf(form: ScheduleForm): {
  enabled: boolean;
  cronExpression: string;
  timezone: string;
  prompt: string;
  stampTime: boolean;
  deliver: { channelId: string } | null;
  timeoutSeconds?: number;
  maxRetries?: number;
} {
  const prompt = form.prompt.trim();
  const timeoutSeconds = wholeNumber(form.timeoutSeconds);
  const maxRetries = wholeNumber(form.maxRetries);
  return {
    enabled: form.enabled,
    cronExpression: form.cronExpression.trim(),
    timezone: form.timezone,
    prompt,
    stampTime: form.stampTime,
    deliver: form.channelId ? { channelId: form.channelId } : null,
    ...(timeoutSeconds !== null && { timeoutSeconds }),
    ...(maxRetries !== null && { maxRetries }),
  };
}

const SCHEDULE_PATHS: Record<string, ScheduleFormField> = {
  cronExpression: "cronExpression",
  timezone: "timezone",
  prompt: "prompt",
  deliver: "deliver",
  "deliver.channelId": "deliver",
  timeoutSeconds: "timeoutSeconds",
  maxRetries: "maxRetries",
};

/** The sentences of a 400, each under the input it is about; anything else is the form's. */
export function scheduleFieldErrors(fields: Record<string, string>): ScheduleFormErrors {
  const errors: ScheduleFormErrors = {};
  for (const [path, sentence] of Object.entries(fields)) {
    const field = SCHEDULE_PATHS[path] ?? "form";
    errors[field] ??= sentence;
  }
  return errors;
}

/** Whether two states of the form would send the same schedule. */
export function sameSchedule(a: ScheduleForm, b: ScheduleForm): boolean {
  return (
    JSON.stringify({ ...scheduleBodyOf(a), t: a.timeoutSeconds.trim(), r: a.maxRetries.trim() }) ===
    JSON.stringify({ ...scheduleBodyOf(b), t: b.timeoutSeconds.trim(), r: b.maxRetries.trim() })
  );
}

/**
 * The form after a save that changed one thing (the switch, or the place):
 * what the server now holds, with every edit that was not part of that save
 * left as it was typed.
 */
export function rebaseForm(form: ScheduleForm, before: ScheduleForm, after: ScheduleForm): ScheduleForm {
  const next = { ...after } as Record<keyof ScheduleForm, ScheduleForm[keyof ScheduleForm]>;
  for (const key of Object.keys(after) as Array<keyof ScheduleForm>) {
    if (form[key] !== before[key]) next[key] = form[key];
  }
  return next as ScheduleForm;
}

/**
 * For an agent that came with suggested times and has no schedule yet:
 * "This agent is set up to run every day at 09:00. Turn the schedule on to
 * start. You choose the times and where results go." null when nothing was
 * suggested.
 */
export function suggestedScheduleSentence(suggested: SuggestedLike | null | undefined): string | null {
  const cron = suggested?.schedule?.cronExpression?.trim();
  if (!cron) return null;
  // "Runs every day at 09:00." -> "run every day at 09:00"
  const runs = describeSchedule(cronToChoice(cron)).replace(/\.$/, "");
  const phrase = /^Runs /.test(runs) ? runs.replace(/^Runs /, "run ") : `run on its own times (${cron})`;
  return `This agent is set up to ${phrase}. ${SCHEDULE_MESSAGES.setUpTail}`;
}

/** "1 other scheduled task uses this agent." / "3 other scheduled tasks use this agent."; null for none. */
export function otherTasksLine(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  return count === 1 ? "1 other scheduled task uses this agent." : `${count} other scheduled tasks use this agent.`;
}

// ============================================
// Runs
// ============================================

/** The list with a run put first, or put in the place of the run it already has with that id. */
export function withRun<T extends { id: string }>(runs: readonly T[], run: T): T[] {
  if (runs.some((existing) => existing.id === run.id)) {
    return runs.map((existing) => (existing.id === run.id ? run : existing));
  }
  return [run, ...runs];
}

/** The next page added to the list, without a run the list already shows. */
export function appendRuns<T extends { id: string }>(runs: readonly T[], more: readonly T[]): T[] {
  const seen = new Set(runs.map((run) => run.id));
  return [...runs, ...more.filter((run) => !seen.has(run.id))];
}

/**
 * The list after its newest page was read again: those runs as they are now,
 * then the older ones already shown.
 */
export function mergeLatestRuns<T extends { id: string }>(runs: readonly T[], latest: readonly T[]): T[] {
  const fresh = new Set(latest.map((run) => run.id));
  return [...latest, ...runs.filter((run) => !fresh.has(run.id))];
}

/** The run a 502 `delivery_failed` carries: the same run with its new delivery record. */
export function runInRefusal<T extends { id: string }>(err: unknown): T | null {
  const run = bodyOf(err)?.run;
  if (typeof run !== "object" || run === null) return null;
  return typeof (run as { id?: unknown }).id === "string" ? (run as T) : null;
}

/** Past this many lines, or this many characters, a result starts collapsed. */
export const RESULT_PREVIEW_LINES = 6;
export const RESULT_PREVIEW_CHARS = 600;

/** A long result's first lines, and whether anything was left out. */
export function resultPreview(text: string): { text: string; cut: boolean } {
  const lines = text.split("\n");
  let preview = lines.length > RESULT_PREVIEW_LINES ? lines.slice(0, RESULT_PREVIEW_LINES).join("\n") : text;
  if (preview.length > RESULT_PREVIEW_CHARS) preview = preview.slice(0, RESULT_PREVIEW_CHARS).trimEnd();
  const cut = preview.length < text.length;
  return { text: cut ? `${preview.trimEnd()}…` : text, cut };
}

// ============================================
// Running a task
// ============================================

export const RUN_MESSAGES = {
  invalid: "Some answers need another look.",
  tooLong: "Your answers are too long. Shorten them and try again.",
  failed: "The agent could not finish this run. Try again.",
} as const;

export interface RunRefusal {
  /** One sentence above the Run button. */
  message: string;
  /** The answers that need another look, as the server listed them; empty for any other refusal. */
  details: Array<{ path: string; message: string }>;
}

/** What to say about a run that was refused: 422, 413, or the server's own sentence. */
export function runRefusal(err: unknown): RunRefusal {
  const status = statusOf(err);
  if (status === 422) {
    const raw = bodyOf(err)?.details;
    const details = Array.isArray(raw)
      ? raw.flatMap((item) => {
          if (typeof item !== "object" || item === null) return [];
          const { path, message } = item as { path?: unknown; message?: unknown };
          return typeof message === "string" ? [{ path: typeof path === "string" ? path : "", message }] : [];
        })
      : [];
    return { message: RUN_MESSAGES.invalid, details };
  }
  if (status === 413) return { message: RUN_MESSAGES.tooLong, details: [] };
  return { message: sentenceOf(err) ?? RUN_MESSAGES.failed, details: [] };
}

/** "$0.05", "$12.00". */
export function formatCents(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

/** On a buyer's copy: "This run cost $0.05, paid to Research Summarizer." null when nothing was charged. */
export function runCostLine(billing: { listingTitle: string; chargedCents: number } | null | undefined): string | null {
  if (!billing || !Number.isFinite(billing.chargedCents) || billing.chargedCents <= 0) return null;
  const title = billing.listingTitle?.trim();
  return `This run cost ${formatCents(billing.chargedCents)}${title ? `, paid to ${title}` : ""}.`;
}

/** "Took 1.5 s." / "Took 2.0 min."; null for a missing length. */
export function runTookLine(durationMs: number | null | undefined): string | null {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return `Took ${Math.round(durationMs)} ms.`;
  if (durationMs < 60_000) return `Took ${(durationMs / 1000).toFixed(1)} s.`;
  return `Took ${(durationMs / 60_000).toFixed(1)} min.`;
}

// ============================================
// Settings: how people use it, and delete
// ============================================

export const KIND_CHANGE_MESSAGES = {
  kept: "Its other settings are kept, so you can switch back.",
  scheduleOff: "Its schedule will be turned off.",
  schedulePaused: "This agent's schedule was turned off.",
} as const;

function kindTitle(kind: AgentKind): string {
  return KIND_CHOICES.find((choice) => choice.kind === kind)?.title ?? kind;
}

/**
 * What changing how an agent is used asks first, or null when nothing
 * changes. The schedule line shows only when leaving "It runs on its own".
 */
export function kindChangeConfirm(
  from: AgentKind,
  to: AgentKind,
): { title: string; description: string; confirmLabel: string } | null {
  if (from === to) return null;
  const description =
    from === "scheduled"
      ? `${KIND_CHANGE_MESSAGES.kept} ${KIND_CHANGE_MESSAGES.scheduleOff}`
      : KIND_CHANGE_MESSAGES.kept;
  return { title: `Change to "${kindTitle(to)}"?`, description, confirmLabel: "Change" };
}

/** What the delete dialog says, from what `getSchedule` knows about the agent. */
export function deleteWarning(info: { hasSchedule: boolean; otherTasks: number } | null | undefined): string {
  const lines = ["Its deployments are stopped and it cannot be recovered."];
  if (info?.hasSchedule) lines.push("Its schedule and its saved results are deleted too.");
  const others = info?.otherTasks ?? 0;
  if (others === 1) lines.push("1 scheduled task uses this agent and will be deleted too.");
  else if (others > 1) lines.push(`${others} scheduled tasks use this agent and will be deleted too.`);
  return lines.join(" ");
}

// ============================================
// GPU, Overview, Sell, usage
// ============================================

export const GPU_MESSAGES = {
  beingBuilt:
    "Dedicated GPUs for agents are being built. Nothing was reserved or charged. Your agent keeps answering on WheelsAI.",
} as const;

/** A tier id of GPU_TIER_ORDER as people read it: "RTX 4070", "A100". */
export function gpuTierLabel(tier: string): string {
  const id = tier.trim().replace(/^rtx-?/i, "");
  return /^\d/.test(id) ? `RTX ${id}` : id.toUpperCase();
}

/** An agent has a token when it has a treasury of its own. */
export function agentHasToken(runway: { treasuryAddress?: string | null } | null | undefined): boolean {
  return Boolean(runway?.treasuryAddress?.trim());
}

interface ListingLike {
  /** null on a workflow's listing, which is never an agent's. */
  agentId: string | null;
  status: string;
}

/** This agent's listing among the organization's own; the one that is live first. */
export function listingForAgent<T extends ListingLike>(listings: readonly T[], agentId: string): T | null {
  const own = listings.filter((listing) => listing.agentId === agentId);
  return own.find((listing) => listing.status === "published") ?? own.find((listing) => listing.status !== "archived") ?? own[0] ?? null;
}

/** The query parameter that tells the listing wizard which agent to start with. */
export const LIST_AGENT_PARAM = "agent";

/** Where "List this agent" goes: the listing wizard, with this agent already chosen. */
export function listAgentHref(agentId: string): string {
  return `/dashboard/marketplace/publish?${LIST_AGENT_PARAM}=${encodeURIComponent(agentId)}`;
}

/**
 * The agent the listing wizard starts with, from `?agent=`: that agent when
 * it is one of the agents the person may list (the wizard's own list), else
 * none. Never when an existing listing is being edited: its agent is fixed.
 */
export function agentToListFirst(
  param: string | null | undefined,
  agents: ReadonlyArray<{ id: string }>,
  editing: boolean,
): string | null {
  const id = (param ?? "").trim();
  if (editing || !id) return null;
  return agents.some((agent) => agent.id === id) ? id : null;
}

const LISTING_STATUS: Record<string, { label: string; sentence: string }> = {
  published: { label: "On the marketplace", sentence: "People can find this agent on the marketplace." },
  pending_review: { label: "In review", sentence: "This listing is being reviewed. It appears on the marketplace once it is approved." },
  draft: { label: "Draft", sentence: "This listing is a draft. Nobody else can see it yet." },
  archived: { label: "Taken down", sentence: "This listing was taken down. Nobody new can find it." },
};

/** A listing's state in plain words. */
export function listingStatus(status: string): { label: string; sentence: string } {
  return LISTING_STATUS[status] ?? { label: "Listed", sentence: "This agent has a listing." };
}

/** Where an agent's use came from, for the traffic table. The names are the API's own. */
export const USAGE_SOURCE_LABELS: Readonly<Record<string, string>> = {
  playground: "Chat on its page",
  api: "API (/v1)",
  widget: "Public page and website chat",
  trial: "Try it on the marketplace",
  scheduled: "Scheduled runs",
  job: "Jobs",
  test: "Testing",
  hired: "Hired tasks",
  paid: "Paid use",
};

/** The label of a usage source; a name this page does not know shows as it came. */
export function usageSourceLabel(source: string): string {
  return USAGE_SOURCE_LABELS[source] ?? source;
}
