import assert from "node:assert/strict";
import test from "node:test";

// Drives services/scheduleCalc.ts. The scheduler it replaces read only
// the minute and hour of a cron expression, ignored the time zone, fell
// back to midnight on anything it could not parse, and accepted one-off
// times that had already passed.

import {
  MIN_INTERVAL_SECONDS,
  isValidTimezone,
  nextRun,
  resolveScheduledAt,
  validateSchedule,
} from "../services/scheduleCalc.js";

// A Tuesday.
const NOW = new Date("2026-10-06T12:00:00Z");

function ok(verdict: ReturnType<typeof validateSchedule>) {
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  return verdict as Extract<typeof verdict, { ok: true }>;
}
function refused(verdict: ReturnType<typeof validateSchedule>) {
  assert.equal(verdict.ok, false, JSON.stringify(verdict));
  return verdict as Extract<typeof verdict, { ok: false }>;
}

test("the weekday field is honoured: '0 16 * * 5' is the next Friday, not today", () => {
  const verdict = ok(
    validateSchedule({ scheduleType: "cron", cronExpression: "0 16 * * 5", timezone: "UTC" }, NOW),
  );
  assert.equal(verdict.nextRunAt.toISOString(), "2026-10-09T16:00:00.000Z");
  assert.equal(verdict.nextRunAt.getUTCDay(), 5);
});

test("day-of-month and month fields are honoured", () => {
  assert.equal(
    ok(validateSchedule({ scheduleType: "cron", cronExpression: "30 6 15 * *" }, NOW))
      .nextRunAt.toISOString(),
    "2026-10-15T06:30:00.000Z",
  );
  assert.equal(
    ok(validateSchedule({ scheduleType: "cron", cronExpression: "0 0 1 3 *" }, NOW))
      .nextRunAt.toISOString(),
    "2027-03-01T00:00:00.000Z",
  );
});

test("09:00 in America/New_York is the right instant on both sides of a DST change", () => {
  const daily = { scheduleType: "cron", cronExpression: "0 9 * * *", timezone: "America/New_York" };
  // Clocks go back on 2026-11-01. The day before is EDT (UTC-4)...
  assert.equal(
    ok(validateSchedule(daily, new Date("2026-10-30T20:00:00Z"))).nextRunAt.toISOString(),
    "2026-10-31T13:00:00.000Z",
  );
  // ...the day of and after are EST (UTC-5).
  assert.equal(
    ok(validateSchedule(daily, new Date("2026-10-31T20:00:00Z"))).nextRunAt.toISOString(),
    "2026-11-01T14:00:00.000Z",
  );
  // And forward again on 2027-03-14.
  assert.equal(
    ok(validateSchedule(daily, new Date("2027-03-13T20:00:00Z"))).nextRunAt.toISOString(),
    "2027-03-14T13:00:00.000Z",
  );
});

test("an invalid cron expression is refused, not guessed at", () => {
  for (const cronExpression of [
    "banana",
    "61 * * * *",
    "0 25 * * *",
    "0 0 31 2 *", // a date that never comes
    "* * * *", // four fields
    "* * * * * *", // six fields would allow per-second firing
  ]) {
    const verdict = refused(validateSchedule({ scheduleType: "cron", cronExpression }, NOW));
    assert.equal(verdict.reason, "invalid_cron", cronExpression);
    assert.equal(verdict.field, "cronExpression");
  }
});

test("a time zone must be an IANA zone", () => {
  assert.equal(isValidTimezone("UTC"), true);
  assert.equal(isValidTimezone("Europe/Berlin"), true);
  for (const timezone of ["EST5", "EST", "Mars/Olympus", "+02:00", "europe"]) {
    assert.equal(isValidTimezone(timezone), false, timezone);
    const verdict = refused(
      validateSchedule({ scheduleType: "cron", cronExpression: "0 9 * * *", timezone }, NOW),
    );
    assert.equal(verdict.reason, "invalid_timezone");
  }
});

test("an interval under a minute is refused; a minute is allowed", () => {
  const short = refused(
    validateSchedule({ scheduleType: "interval", intervalSeconds: MIN_INTERVAL_SECONDS - 1 }, NOW),
  );
  assert.equal(short.reason, "interval_too_short");
  assert.equal(short.field, "intervalSeconds");

  const minute = ok(validateSchedule({ scheduleType: "interval", intervalSeconds: 60 }, NOW));
  assert.equal(minute.nextRunAt.toISOString(), "2026-10-06T12:01:00.000Z");
});

test("a one-off time in the past is refused instead of saved and never fired", () => {
  const verdict = refused(
    validateSchedule({ scheduleType: "once", scheduledAt: "2026-10-06T11:59:00Z" }, NOW),
  );
  assert.equal(verdict.reason, "scheduled_at_in_past");
  assert.equal(
    refused(validateSchedule({ scheduleType: "once", scheduledAt: "tomorrow-ish" }, NOW)).reason,
    "invalid_scheduled_at",
  );
});

test("a naive one-off time is read in the task's time zone, not the server's", () => {
  const berlin = ok(
    validateSchedule(
      { scheduleType: "once", scheduledAt: "2026-11-02T09:00", timezone: "Europe/Berlin" },
      NOW,
    ),
  );
  assert.equal(berlin.scheduledAt!.toISOString(), "2026-11-02T08:00:00.000Z");
  assert.equal(berlin.nextRunAt.toISOString(), "2026-11-02T08:00:00.000Z");

  const tokyo = ok(
    validateSchedule(
      { scheduleType: "once", scheduledAt: "2026-11-02T09:00", timezone: "Asia/Tokyo" },
      NOW,
    ),
  );
  assert.equal(tokyo.scheduledAt!.toISOString(), "2026-11-02T00:00:00.000Z");
});

test("a one-off time that carries its own offset is that instant, whatever the time zone", () => {
  assert.equal(
    resolveScheduledAt("2026-11-02T09:00:00+05:00", "Europe/Berlin")!.toISOString(),
    "2026-11-02T04:00:00.000Z",
  );
  assert.equal(
    resolveScheduledAt("2026-11-02T09:00:00Z", "Asia/Tokyo")!.toISOString(),
    "2026-11-02T09:00:00.000Z",
  );
  assert.equal(resolveScheduledAt("not a date", "UTC"), null);
});

test("a schedule missing its own field is refused naming it", () => {
  assert.equal(refused(validateSchedule({ scheduleType: "cron" }, NOW)).field, "cronExpression");
  assert.equal(refused(validateSchedule({ scheduleType: "interval" }, NOW)).field, "intervalSeconds");
  assert.equal(refused(validateSchedule({ scheduleType: "once" }, NOW)).field, "scheduledAt");
  assert.equal(
    refused(validateSchedule({ scheduleType: "hourly" }, NOW)).reason,
    "invalid_schedule_type",
  );
});

test("nextRun advances a stored schedule and returns null where there is no next run", () => {
  assert.equal(
    nextRun({ scheduleType: "cron", cronExpression: "0 16 * * 5", timezone: "UTC" }, NOW)!.toISOString(),
    "2026-10-09T16:00:00.000Z",
  );
  assert.equal(
    nextRun({ scheduleType: "interval", intervalSeconds: 3600 }, NOW)!.toISOString(),
    "2026-10-06T13:00:00.000Z",
  );
  // A one-off time that has passed, and stored schedules that cannot be read.
  assert.equal(nextRun({ scheduleType: "once", scheduledAt: new Date("2026-10-01T00:00:00Z") }, NOW), null);
  assert.equal(nextRun({ scheduleType: "cron", cronExpression: "nonsense" }, NOW), null);
  assert.equal(nextRun({ scheduleType: "cron", cronExpression: "0 9 * * *", timezone: "Nowhere" }, NOW), null);
  assert.equal(nextRun({ scheduleType: "interval", intervalSeconds: 5 }, NOW), null);
});
