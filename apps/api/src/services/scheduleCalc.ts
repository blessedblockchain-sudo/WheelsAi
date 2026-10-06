/**
 * Schedule arithmetic for scheduled tasks: when a task next fires, and
 * whether a schedule is one the scheduler can honour.
 *
 * The first scheduler read only the minute and hour of a cron expression,
 * ignored the time zone and accepted anything: "0 16 * * 5" fired every
 * day at 16:00 server time, an unparseable expression fell back to
 * midnight, and a one-off time in the past was saved and never fired.
 *
 * Now:
 *   cron      five fields, all honoured, evaluated in the task's IANA
 *             time zone (so 09:00 stays 09:00 across a DST change)
 *   interval  at least MIN_INTERVAL_SECONDS; below that a schedule is a
 *             loop, and every firing can bill a model call
 *   once      an instant in the future. A time written without an offset
 *             ("2026-11-02T09:00") is read in the task's time zone, not
 *             the server's.
 *
 * Pure: `now` is always an argument.
 */

import cronParser from "cron-parser";
import { DateTime, IANAZone } from "luxon";

export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 31_536_000;

export type ScheduleType = "cron" | "interval" | "once";

export type ScheduleRefusalReason =
  | "invalid_cron"
  | "invalid_timezone"
  | "invalid_scheduled_at"
  | "scheduled_at_in_past"
  | "interval_too_short"
  | "interval_too_long"
  | "missing_field"
  | "invalid_schedule_type";

export interface ScheduleInput {
  scheduleType: string;
  cronExpression?: string | null;
  intervalSeconds?: number | null;
  /** An ISO instant, a naive local date-time, or an already-resolved Date. */
  scheduledAt?: string | Date | null;
  timezone?: string | null;
}

export type ScheduleVerdict =
  | {
      ok: true;
      nextRunAt: Date;
      /** The resolved instant of a 'once' schedule; null for the others. */
      scheduledAt: Date | null;
      timezone: string;
    }
  | { ok: false; reason: ScheduleRefusalReason; field: string; message: string };

const AREA_LOCATION = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/;

export function isValidTimezone(timezone: string): boolean {
  // The runtime also accepts bare offsets and abbreviations ("+02:00",
  // "EST"). Those have no DST rules, so a "09:00" schedule would drift by
  // an hour twice a year; only Area/Location names are taken.
  if (timezone === "UTC") return true;
  return AREA_LOCATION.test(timezone) && IANAZone.isValidZone(timezone);
}

const HAS_OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/**
 * Resolves a one-off time to an instant. A value carrying an offset or
 * "Z" is that instant; a naive one is wall-clock time in `timezone`.
 * Returns null when the text is not a date-time.
 */
export function resolveScheduledAt(value: string | Date, timezone: string): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = value.trim();
  const parsed = HAS_OFFSET.test(text)
    ? DateTime.fromISO(text, { setZone: true })
    : DateTime.fromISO(text, { zone: timezone });
  return parsed.isValid ? parsed.toJSDate() : null;
}

function nextCronRun(expression: string, timezone: string, from: Date): Date {
  const fields = expression.trim().split(/\s+/);
  // cron-parser also takes a sixth (seconds) field, which would allow a
  // schedule that fires every second.
  if (fields.length !== 5) {
    throw new Error("a cron expression has five fields: minute hour day-of-month month weekday");
  }
  const interval = cronParser.parseExpression(fields.join(" "), {
    currentDate: from,
    tz: timezone,
  });
  return interval.next().toDate();
}

/**
 * The next firing strictly after `from`, or null when there is none (a
 * one-off time that has passed) or the stored schedule cannot be read.
 * Used when a firing is claimed; validateSchedule is the strict form used
 * when a task is saved.
 */
export function nextRun(
  schedule: {
    scheduleType: string;
    cronExpression?: string | null;
    intervalSeconds?: number | null;
    scheduledAt?: Date | null;
    timezone?: string | null;
  },
  from: Date,
): Date | null {
  const timezone = schedule.timezone || "UTC";
  if (schedule.scheduleType === "once") {
    const at = schedule.scheduledAt;
    return at && at.getTime() > from.getTime() ? at : null;
  }
  if (schedule.scheduleType === "interval") {
    const seconds = schedule.intervalSeconds;
    if (!seconds || seconds < MIN_INTERVAL_SECONDS) return null;
    return new Date(from.getTime() + seconds * 1000);
  }
  if (schedule.scheduleType === "cron" && schedule.cronExpression) {
    if (!isValidTimezone(timezone)) return null;
    try {
      return nextCronRun(schedule.cronExpression, timezone, from);
    } catch {
      return null;
    }
  }
  return null;
}

const refuse = (
  reason: ScheduleRefusalReason,
  field: string,
  message: string,
): ScheduleVerdict => ({ ok: false, reason, field, message });

export function validateSchedule(input: ScheduleInput, now: Date): ScheduleVerdict {
  const timezone = input.timezone || "UTC";
  if (!isValidTimezone(timezone)) {
    return refuse(
      "invalid_timezone",
      "timezone",
      `"${timezone}" is not an IANA time zone (for example "Europe/Berlin" or "UTC")`,
    );
  }

  if (input.scheduleType === "cron") {
    if (!input.cronExpression) {
      return refuse("missing_field", "cronExpression", "a cron schedule needs cronExpression");
    }
    try {
      const nextRunAt = nextCronRun(input.cronExpression, timezone, now);
      return { ok: true, nextRunAt, scheduledAt: null, timezone };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return refuse("invalid_cron", "cronExpression", `invalid cron expression: ${detail}`);
    }
  }

  if (input.scheduleType === "interval") {
    const seconds = input.intervalSeconds;
    if (seconds === undefined || seconds === null) {
      return refuse("missing_field", "intervalSeconds", "an interval schedule needs intervalSeconds");
    }
    if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS) {
      return refuse(
        "interval_too_short",
        "intervalSeconds",
        `the shortest interval is ${MIN_INTERVAL_SECONDS} seconds`,
      );
    }
    if (seconds > MAX_INTERVAL_SECONDS) {
      return refuse("interval_too_long", "intervalSeconds", "the longest interval is one year");
    }
    return {
      ok: true,
      nextRunAt: new Date(now.getTime() + seconds * 1000),
      scheduledAt: null,
      timezone,
    };
  }

  if (input.scheduleType === "once") {
    if (input.scheduledAt === undefined || input.scheduledAt === null || input.scheduledAt === "") {
      return refuse("missing_field", "scheduledAt", "a one-off schedule needs scheduledAt");
    }
    const at = resolveScheduledAt(input.scheduledAt, timezone);
    if (!at) {
      return refuse(
        "invalid_scheduled_at",
        "scheduledAt",
        "scheduledAt must be an ISO date and time, for example 2026-11-02T09:00",
      );
    }
    if (at.getTime() <= now.getTime()) {
      return refuse(
        "scheduled_at_in_past",
        "scheduledAt",
        "scheduledAt is in the past; a one-off task needs a future time",
      );
    }
    return { ok: true, nextRunAt: at, scheduledAt: at, timezone };
  }

  return refuse(
    "invalid_schedule_type",
    "scheduleType",
    `unknown schedule type "${input.scheduleType}"`,
  );
}
