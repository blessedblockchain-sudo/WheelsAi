/**
 * The sentences of a self-running agent's runs: what a run's state is called,
 * how sending its result went, when it ran and who started it. Pure, so the
 * Runs tab only lays them out.
 *
 * The delivery reasons are the API's own short phrases (written to follow
 * "Not sent to <name>: "); nothing here invents one.
 */
import { formatDuration, type Tone } from "../components/dashboard/workflows/format";
import type { RunDelivery, RunStatus, RunView } from "./api";

/** A place results go to, as far as a sentence needs it: `ScheduleView.deliver` fits. */
export interface RunPlace {
  /** "" when the place was removed after it was chosen. */
  name: string;
}

const STATUS_LABEL: Record<RunStatus, string> = {
  running: "Running",
  finished: "Finished",
  did_not_finish: "Did not finish",
  stopped: "Stopped",
};

const STATUS_TONE: Record<RunStatus, Tone> = {
  running: "info",
  finished: "success",
  did_not_finish: "danger",
  stopped: "warning",
};

/** Running, Finished, Did not finish, Stopped. */
export function runStatusLabel(status: RunStatus): string {
  return STATUS_LABEL[status] ?? "Did not finish";
}

/** The colour family of a run's state, for `TONE_CLASS` in workflows/format. */
export function runStatusTone(status: RunStatus): Tone {
  return STATUS_TONE[status] ?? "neutral";
}

/** Shown when a run did not finish and the API gave no sentence for it. */
export const RUN_FAILURE_FALLBACK = "This run could not be completed.";

/** Run now, refused with 409 `already_running`. */
export const RUN_ALREADY_RUNNING = "This agent is already running. Wait for it to finish.";

/** Why a run did not finish, in the API's sentence; null for a run that is running, finished or stopped. */
export function runFailureLine(run: Pick<RunView, "status" | "failure">): string | null {
  if (run.status !== "did_not_finish") return null;
  return run.failure?.trim() || RUN_FAILURE_FALLBACK;
}

/** A reason as it sits mid-sentence: no full stop of its own. */
function reasonOf(record: Pick<RunDelivery, "reason">): string {
  const reason = (record.reason ?? "").trim().replace(/[.\s]+$/, "");
  return reason || "it could not be reached";
}

/**
 * "Sent to Team Slack." / "Not sent to Team Slack: it did not accept the
 * message. The result is saved here." / "Not sent: email delivery is
 * temporarily unavailable. The result is saved here." when the place has no name.
 */
export function deliveryLine(record: Pick<RunDelivery, "name" | "status" | "reason">): string {
  const name = record.name?.trim() ?? "";
  if (record.status === "sent") return name ? `Sent to ${name}.` : "Sent.";
  const where = name ? `Not sent to ${name}` : "Not sent";
  return `${where}: ${reasonOf(record)}. The result is saved here.`;
}

/** The newest try to send a run's result; null when none was made. */
export function latestDelivery(run: Pick<RunView, "delivery">): RunDelivery | null {
  const records = run.delivery ?? [];
  return records[records.length - 1] ?? null;
}

/**
 * Whether "Send again" is offered for a run: it finished, so there is a saved
 * result, and its schedule has a place to send it to now.
 */
export function canSendAgain(run: Pick<RunView, "status">, place: RunPlace | null | undefined): boolean {
  return run.status === "finished" && Boolean(place);
}

export interface RunDeliverySummary {
  /** The sentence for the newest try; null when nothing was sent or tried. */
  line: string | null;
  /** true: sent. false: not sent. null: nothing was tried. */
  sent: boolean | null;
  /** Whether to offer "Send again". */
  sendAgain: boolean;
}

/** What the Runs tab says about delivery under one run. */
export function runDelivery(run: Pick<RunView, "status" | "delivery">, place: RunPlace | null | undefined): RunDeliverySummary {
  const latest = latestDelivery(run);
  return {
    line: latest ? deliveryLine(latest) : null,
    sent: latest ? latest.status === "sent" : null,
    sendAgain: canSendAgain(run, place),
  };
}

/** Under Run now: "This also sends the result to Team Slack." or null when results stay on the page. */
export function runNowNote(place: RunPlace | null | undefined): string | null {
  const name = place?.name?.trim();
  return name ? `This also sends the result to ${name}.` : null;
}

/** Who started a run. */
export function startedByLabel(startedBy: RunView["startedBy"]): string {
  return startedBy === "person" ? "Started by hand" : "On schedule";
}

export interface RunTimeOptions {
  /** An IANA zone, such as the schedule's own; left out, the viewer's zone. */
  timeZone?: string;
}

function partsOf(iso: string, options: RunTimeOptions): { date: string; time: string } | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  let timeZone = options.timeZone;
  const format = (zone: string | undefined) => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: zone,
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return { date: `${get("day")} ${get("month")}`, time: `${get("hour")}:${get("minute")}` };
  };
  try {
    return format(timeZone);
  } catch {
    // An unknown zone name: fall back to the viewer's own.
    timeZone = undefined;
    return format(timeZone);
  }
}

/** "12 Oct, 09:00"; "" for a missing or unreadable time. */
export function formatRunTime(iso: string | null | undefined, options: RunTimeOptions = {}): string {
  if (!iso) return "";
  const parts = partsOf(iso, options);
  return parts ? `${parts.date}, ${parts.time}` : "";
}

/** "1.5 s", "2.0 min"; null when the run has no length yet. */
export function runDurationLabel(run: Pick<RunView, "startedAt" | "finishedAt" | "durationMs">): string | null {
  let ms = run.durationMs;
  if (ms === null || ms === undefined) {
    if (!run.finishedAt) return null;
    ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  }
  if (!Number.isFinite(ms) || ms < 0) return null;
  return formatDuration(Math.round(ms));
}

const END_WORD: Record<RunStatus, string> = {
  running: "Finished",
  finished: "Finished",
  did_not_finish: "Ended",
  stopped: "Stopped",
};

/**
 * One short line for when a run happened:
 * "Started 12 Oct, 09:00." while it runs, then
 * "Started 12 Oct, 09:00. Finished 09:02, after 1.5 min."
 * The end carries its date only when it is another day.
 */
export function runWhenLine(
  run: Pick<RunView, "status" | "startedAt" | "finishedAt" | "durationMs">,
  options: RunTimeOptions = {},
): string {
  const start = partsOf(run.startedAt, options);
  if (!start) return "";
  const started = `Started ${start.date}, ${start.time}.`;
  if (run.status === "running" || !run.finishedAt) return started;
  const end = partsOf(run.finishedAt, options);
  if (!end) return started;
  const endAt = end.date === start.date ? end.time : `${end.date}, ${end.time}`;
  const took = runDurationLabel(run);
  return `${started} ${END_WORD[run.status] ?? "Ended"} ${endAt}${took ? `, after ${took}` : ""}.`;
}
