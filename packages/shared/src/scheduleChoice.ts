/**
 * When a self-running agent runs, as a choice a person makes and as the cron
 * line that is stored.
 *
 * A person picks one of five shapes: every hour; every day at a time;
 * weekdays at a time; every week on a day at a time; every month on a day
 * (1 to 28, so every month has it) at a time. Each shape is one five-field
 * cron line (choiceToCron), and a stored cron line that has one of these
 * shapes reads back as the same choice (cronToChoice). Any other cron line is
 * "custom": it is kept exactly as written and shown as written.
 *
 * Self-contained on purpose (no imports), like agentKind.ts: the web app and
 * the API both use it, and it must run in a browser.
 */

// ============================================
// The choice
// ============================================

export const SCHEDULE_SHAPES = ["hourly", "daily", "weekdays", "weekly", "monthly"] as const;
export type ScheduleShape = (typeof SCHEDULE_SHAPES)[number];

/** How each shape reads in the list a person chooses from. */
export const SCHEDULE_SHAPE_LABELS: Record<ScheduleShape | "custom", string> = {
  hourly: "Every hour",
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Every week",
  monthly: "Every month",
  custom: "Custom times",
};

/** Days of the week as cron numbers them: 0 is Sunday. */
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** The last day of the month a monthly schedule can name, so that every month has it. */
export const MAX_MONTH_DAY = 28;

/** The time a new schedule starts with. */
export const DEFAULT_SCHEDULE_TIME = "09:00";

export type ScheduleChoice =
  | { kind: "hourly" }
  /** `time` is "HH:MM" on a 24-hour clock. */
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  /** `day` is 0 (Sunday) to 6 (Saturday). */
  | { kind: "weekly"; day: number; time: string }
  /** `dayOfMonth` is 1 to 28. */
  | { kind: "monthly"; dayOfMonth: number; time: string }
  /** Any cron line that is not one of the five shapes, kept as written. */
  | { kind: "custom"; cronExpression: string };

/** What a new self-running agent starts with: every day at 09:00. */
export const DEFAULT_SCHEDULE_CHOICE: ScheduleChoice = { kind: "daily", time: DEFAULT_SCHEDULE_TIME };

// ============================================
// Times
// ============================================

const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "9:5" is not a time; "9:05" and "09:05" are. Answers hour and minute, or null. */
export function parseTime(time: string): { hour: number; minute: number } | null {
  const match = TIME_PATTERN.exec(String(time ?? "").trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** 9 and 5 are "09:05". */
export function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function timeOrDefault(time: string): { hour: number; minute: number } {
  return parseTime(time) ?? parseTime(DEFAULT_SCHEDULE_TIME)!;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

// ============================================
// Choice to cron, and back
// ============================================

/**
 * The five-field cron line of a choice. A time that cannot be read becomes
 * 09:00, a weekday is kept inside 0 to 6 and a day of the month inside 1 to
 * 28, so what comes out is always a line the scheduler accepts. A custom
 * choice is its own line, trimmed.
 */
export function choiceToCron(choice: ScheduleChoice): string {
  switch (choice.kind) {
    case "hourly":
      return "0 * * * *";
    case "daily": {
      const { hour, minute } = timeOrDefault(choice.time);
      return `${minute} ${hour} * * *`;
    }
    case "weekdays": {
      const { hour, minute } = timeOrDefault(choice.time);
      return `${minute} ${hour} * * 1-5`;
    }
    case "weekly": {
      const { hour, minute } = timeOrDefault(choice.time);
      return `${minute} ${hour} * * ${clamp(choice.day, 0, 6)}`;
    }
    case "monthly": {
      const { hour, minute } = timeOrDefault(choice.time);
      return `${minute} ${hour} ${clamp(choice.dayOfMonth, 1, MAX_MONTH_DAY)} * *`;
    }
    case "custom":
      return String(choice.cronExpression ?? "").trim();
  }
}

const WHOLE_NUMBER = /^\d{1,2}$/;

function numberIn(text: string, min: number, max: number): number | null {
  if (!WHOLE_NUMBER.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

/**
 * The choice a cron line stands for. One of the five shapes when the line
 * has exactly that shape (a weekly line may name Sunday as 0 or 7); anything
 * else, including a line that cannot be read, is "custom" with the line as
 * written.
 */
export function cronToChoice(cronExpression: string): ScheduleChoice {
  const line = String(cronExpression ?? "").trim();
  const custom: ScheduleChoice = { kind: "custom", cronExpression: line };
  const parts = line.split(/\s+/);
  if (parts.length !== 5) return custom;
  const [minuteText, hourText, dayText, monthText, weekdayText] = parts as [string, string, string, string, string];
  if (monthText !== "*") return custom;

  const minute = numberIn(minuteText, 0, 59);
  if (minute === null) return custom;

  if (hourText === "*") {
    return minute === 0 && dayText === "*" && weekdayText === "*" ? { kind: "hourly" } : custom;
  }
  const hour = numberIn(hourText, 0, 23);
  if (hour === null) return custom;
  const time = formatTime(hour, minute);

  if (dayText === "*") {
    if (weekdayText === "*") return { kind: "daily", time };
    if (weekdayText === "1-5") return { kind: "weekdays", time };
    const day = numberIn(weekdayText, 0, 7);
    return day === null ? custom : { kind: "weekly", day: day % 7, time };
  }
  if (weekdayText !== "*") return custom;
  const dayOfMonth = numberIn(dayText, 1, MAX_MONTH_DAY);
  return dayOfMonth === null ? custom : { kind: "monthly", dayOfMonth, time };
}

/** True when the text has the five fields a cron line has. It says nothing about whether each field can be read. */
export function looksLikeCron(cronExpression: string): boolean {
  const line = String(cronExpression ?? "").trim();
  return line !== "" && line.split(/\s+/).length === 5;
}

// ============================================
// Words
// ============================================

/**
 * One sentence for a schedule: "Runs every day at 09:00." Takes a choice or
 * a cron line. A custom line is shown as written.
 */
export function describeSchedule(schedule: ScheduleChoice | string): string {
  const choice = typeof schedule === "string" ? cronToChoice(schedule) : schedule;
  switch (choice.kind) {
    case "hourly":
      return "Runs every hour.";
    case "daily":
      return `Runs every day at ${choiceTime(choice.time)}.`;
    case "weekdays":
      return `Runs on weekdays at ${choiceTime(choice.time)}.`;
    case "weekly":
      return `Runs every week on ${WEEKDAY_NAMES[clamp(choice.day, 0, 6)]} at ${choiceTime(choice.time)}.`;
    case "monthly":
      return `Runs every month on day ${clamp(choice.dayOfMonth, 1, MAX_MONTH_DAY)} at ${choiceTime(choice.time)}.`;
    case "custom": {
      const line = String(choice.cronExpression ?? "").trim();
      return line ? `Runs at custom times (${line}).` : "No times are set yet.";
    }
  }
}

function choiceTime(time: string): string {
  const { hour, minute } = timeOrDefault(time);
  return formatTime(hour, minute);
}

// ============================================
// The next run
// ============================================

/** A date and time as a clock on the wall shows it in some time zone. `weekday` is 0 (Sunday) to 6. */
export type WallClock = {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A wall clock as a number that can be compared and moved, by reading it as if it were UTC. */
function wallMs(wall: Pick<WallClock, "year" | "month" | "day" | "hour" | "minute">): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

function wallFromMs(ms: number): WallClock {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

/**
 * What a clock on the wall shows in `timezone` at the instant `now`, or null
 * when the time zone is not one this runtime knows.
 */
export function wallClockIn(timezone: string, now: Date = new Date()): WallClock | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    }).formatToParts(now);
    const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const wall = { year: read("year"), month: read("month"), day: read("day"), hour: read("hour") % 24, minute: read("minute") };
    if (Object.values(wall).some((value) => !Number.isFinite(value))) return null;
    return wallFromMs(wallMs(wall));
  } catch {
    return null;
  }
}

/**
 * The first run after `now`, on the same wall clock. null for a custom
 * schedule: when it next runs is the scheduler's to say.
 */
export function nextRunOnWallClock(choice: ScheduleChoice, now: WallClock): WallClock | null {
  if (choice.kind === "custom") return null;
  const nowMs = wallMs(now);
  if (choice.kind === "hourly") {
    return wallFromMs(wallMs({ ...now, minute: 0 }) + 60 * MINUTE_MS);
  }
  const { hour, minute } = timeOrDefault(choice.time);
  const todayAtTime = wallMs({ ...now, hour, minute });
  // Far enough ahead for every shape: a monthly run is at most 31 days away.
  for (let ahead = 0; ahead <= 32; ahead += 1) {
    const candidateMs = todayAtTime + ahead * DAY_MS;
    if (candidateMs <= nowMs) continue;
    const candidate = wallFromMs(candidateMs);
    const runsThatDay =
      choice.kind === "daily" ||
      (choice.kind === "weekdays" && candidate.weekday >= 1 && candidate.weekday <= 5) ||
      (choice.kind === "weekly" && candidate.weekday === clamp(choice.day, 0, 6)) ||
      (choice.kind === "monthly" && candidate.day === clamp(choice.dayOfMonth, 1, MAX_MONTH_DAY));
    if (runsThatDay) return candidate;
  }
  return null;
}

/** "today at 09:00", "tomorrow at 09:00", "Monday at 09:00", or "1 November at 09:00" when it is a week or more away. */
export function describeWallClock(when: WallClock, now: WallClock): string {
  const time = formatTime(when.hour, when.minute);
  const startOf = (wall: WallClock) => wallMs({ ...wall, hour: 0, minute: 0 });
  const days = Math.round((startOf(when) - startOf(now)) / DAY_MS);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAY_NAMES[when.weekday]} at ${time}`;
  return `${when.day} ${MONTH_NAMES[when.month - 1]} at ${time}`;
}

/**
 * When a schedule next runs, in words: "tomorrow at 09:00". null when it is
 * not known here: a custom schedule, or a time zone this runtime does not
 * know.
 */
export function describeNextRun(
  schedule: ScheduleChoice | string,
  timezone: string,
  now: Date = new Date(),
): string | null {
  const choice = typeof schedule === "string" ? cronToChoice(schedule) : schedule;
  const wallNow = wallClockIn(timezone, now);
  if (!wallNow) return null;
  const next = nextRunOnWallClock(choice, wallNow);
  return next ? describeWallClock(next, wallNow) : null;
}
