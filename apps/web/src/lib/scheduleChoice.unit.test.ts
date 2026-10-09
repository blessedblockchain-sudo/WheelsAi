/**
 * When a self-running agent runs: the five shapes both ways, and "custom"
 * for everything else. The functions live in packages/shared; the test is
 * here so the web's unit run covers them. Run with:
 *   cd apps/web && npx tsx --test src/lib/scheduleChoice.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  choiceToCron,
  cronToChoice,
  describeNextRun,
  describeSchedule,
  describeWallClock,
  looksLikeCron,
  nextRunOnWallClock,
  parseTime,
  wallClockIn,
  type ScheduleChoice,
  type WallClock,
} from "@wheelsai/shared/schedule-choice";

const SHAPES: Array<{ choice: ScheduleChoice; cron: string; sentence: string }> = [
  { choice: { kind: "hourly" }, cron: "0 * * * *", sentence: "Runs every hour." },
  { choice: { kind: "daily", time: "09:00" }, cron: "0 9 * * *", sentence: "Runs every day at 09:00." },
  { choice: { kind: "weekdays", time: "17:30" }, cron: "30 17 * * 1-5", sentence: "Runs on weekdays at 17:30." },
  {
    choice: { kind: "weekly", day: 1, time: "08:05" },
    cron: "5 8 * * 1",
    sentence: "Runs every week on Monday at 08:05.",
  },
  {
    choice: { kind: "monthly", dayOfMonth: 28, time: "00:00" },
    cron: "0 0 28 * *",
    sentence: "Runs every month on day 28 at 00:00.",
  },
];

test("each of the five shapes becomes its cron line, and the line reads back as the same choice", () => {
  for (const { choice, cron } of SHAPES) {
    assert.equal(choiceToCron(choice), cron);
    assert.deepEqual(cronToChoice(cron), choice);
    assert.equal(choiceToCron(cronToChoice(cron)), cron);
  }
});

test("each shape has its sentence, from a choice or from a cron line", () => {
  for (const { choice, cron, sentence } of SHAPES) {
    assert.equal(describeSchedule(choice), sentence);
    assert.equal(describeSchedule(cron), sentence);
  }
});

test("a line is read whatever its spacing, and Sunday may be 0 or 7", () => {
  assert.deepEqual(cronToChoice("  0   9 * * *  "), { kind: "daily", time: "09:00" });
  assert.deepEqual(cronToChoice("0 9 * * 0"), { kind: "weekly", day: 0, time: "09:00" });
  assert.deepEqual(cronToChoice("0 9 * * 7"), { kind: "weekly", day: 0, time: "09:00" });
  assert.equal(describeSchedule("0 9 * * 7"), "Runs every week on Sunday at 09:00.");
});

test("any other cron line is custom, kept as written", () => {
  const others = [
    "*/15 * * * *", // every 15 minutes
    "30 * * * *", // every hour, but not on the hour
    "0 9,17 * * *", // twice a day
    "0 9 * * 1,3", // two weekdays
    "0 9 * * 1-4", // a range that is not Monday to Friday
    "0 9 29 * *", // a day some months do not have
    "0 9 31 * *",
    "0 9 1 1 *", // once a year
    "0 9 1 * 1", // a day of the month and a weekday
    "0 9 * * MON", // a named day
    "0 0 9 * * *", // six fields
    "0 9 * *", // four fields
    "60 9 * * *", // a minute that does not exist
    "0 24 * * *",
    "every day",
    "",
  ];
  for (const cron of others) {
    assert.deepEqual(cronToChoice(cron), { kind: "custom", cronExpression: cron.trim() }, cron);
  }
  assert.equal(choiceToCron({ kind: "custom", cronExpression: " */15 * * * * " }), "*/15 * * * *");
  assert.equal(describeSchedule("*/15 * * * *"), "Runs at custom times (*/15 * * * *).");
  assert.equal(describeSchedule(""), "No times are set yet.");
});

test("a choice that cannot be read still makes a line the scheduler accepts", () => {
  assert.equal(choiceToCron({ kind: "daily", time: "nine" }), "0 9 * * *");
  assert.equal(choiceToCron({ kind: "daily", time: "25:00" }), "0 9 * * *");
  assert.equal(choiceToCron({ kind: "weekly", day: 9, time: "09:00" }), "0 9 * * 6");
  assert.equal(choiceToCron({ kind: "monthly", dayOfMonth: 31, time: "09:00" }), "0 9 28 * *");
  assert.equal(choiceToCron({ kind: "monthly", dayOfMonth: 0, time: "9:05" }), "5 9 1 * *");
});

test("parseTime reads a 24-hour time and nothing else", () => {
  assert.deepEqual(parseTime("09:05"), { hour: 9, minute: 5 });
  assert.deepEqual(parseTime("9:05"), { hour: 9, minute: 5 });
  assert.deepEqual(parseTime("23:59"), { hour: 23, minute: 59 });
  assert.equal(parseTime("24:00"), null);
  assert.equal(parseTime("9:5"), null);
  assert.equal(parseTime(""), null);
});

test("looksLikeCron counts the five fields", () => {
  assert.equal(looksLikeCron("0 9 * * *"), true);
  assert.equal(looksLikeCron("  */5 * * * 1-5 "), true);
  assert.equal(looksLikeCron("0 9 * *"), false);
  assert.equal(looksLikeCron(""), false);
});

// Friday 9 October 2026, 10:30.
const NOW: WallClock = { year: 2026, month: 10, day: 9, weekday: 5, hour: 10, minute: 30 };

function next(choice: ScheduleChoice, now: WallClock = NOW): string | null {
  const when = nextRunOnWallClock(choice, now);
  return when ? describeWallClock(when, now) : null;
}

test("the next run is the first one after now", () => {
  assert.equal(next({ kind: "hourly" }), "today at 11:00");
  assert.equal(next({ kind: "hourly" }, { ...NOW, hour: 23, minute: 59 }), "tomorrow at 00:00");
  assert.equal(next({ kind: "daily", time: "09:00" }), "tomorrow at 09:00");
  assert.equal(next({ kind: "daily", time: "18:00" }), "today at 18:00");
  // Exactly now has already started: the next one is tomorrow.
  assert.equal(next({ kind: "daily", time: "10:30" }), "tomorrow at 10:30");
  // After Friday morning's run, weekdays next run on Monday.
  assert.equal(next({ kind: "weekdays", time: "09:00" }), "Monday at 09:00");
  assert.equal(next({ kind: "weekdays", time: "17:00" }), "today at 17:00");
  assert.equal(next({ kind: "weekly", day: 0, time: "09:00" }), "Sunday at 09:00");
  // The same weekday, earlier in the day: a week away, so it is a date.
  assert.equal(next({ kind: "weekly", day: 5, time: "09:00" }), "16 October at 09:00");
  assert.equal(next({ kind: "monthly", dayOfMonth: 12, time: "09:00" }), "Monday at 09:00");
  assert.equal(next({ kind: "monthly", dayOfMonth: 1, time: "09:00" }), "1 November at 09:00");
  assert.equal(next({ kind: "monthly", dayOfMonth: 9, time: "09:00" }), "9 November at 09:00");
  assert.equal(next({ kind: "custom", cronExpression: "*/15 * * * *" }), null);
});

test("the next run crosses a year", () => {
  const newYearsEve: WallClock = { year: 2026, month: 12, day: 31, weekday: 4, hour: 12, minute: 0 };
  assert.equal(next({ kind: "daily", time: "09:00" }, newYearsEve), "tomorrow at 09:00");
  assert.equal(next({ kind: "monthly", dayOfMonth: 15, time: "09:00" }, newYearsEve), "15 January at 09:00");
});

test("the wall clock is read in the schedule's time zone", () => {
  // 2026-10-09 22:30 UTC is 00:30 on Saturday the 10th in Berlin (UTC+2) and 15:30 on Friday in Los Angeles (UTC-7).
  const instant = new Date("2026-10-09T22:30:00Z");
  assert.deepEqual(wallClockIn("UTC", instant), { year: 2026, month: 10, day: 9, weekday: 5, hour: 22, minute: 30 });
  assert.deepEqual(wallClockIn("Europe/Berlin", instant), {
    year: 2026,
    month: 10,
    day: 10,
    weekday: 6,
    hour: 0,
    minute: 30,
  });
  assert.equal(wallClockIn("America/Los_Angeles", instant)?.hour, 15);
  assert.equal(wallClockIn("Not/AZone", instant), null);

  assert.equal(describeNextRun("0 9 * * *", "Europe/Berlin", instant), "today at 09:00");
  assert.equal(describeNextRun("0 9 * * *", "UTC", instant), "tomorrow at 09:00");
  assert.equal(describeNextRun({ kind: "daily", time: "09:00" }, "Not/AZone", instant), null);
  assert.equal(describeNextRun("*/15 * * * *", "UTC", instant), null);
});
