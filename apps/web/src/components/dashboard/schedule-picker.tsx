"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  DEFAULT_SCHEDULE_TIME,
  MAX_MONTH_DAY,
  WEEKDAY_NAMES,
  choiceToCron,
  cronToChoice,
  describeNextRun,
  describeSchedule,
  type ScheduleChoice,
  type ScheduleShape,
} from "@wheelsai/shared/schedule-choice";

/** When an agent runs: a five-field cron line and the time zone its times are in. */
export interface ScheduleValue {
  cronExpression: string;
  /** An IANA time zone such as Europe/Berlin. */
  timezone: string;
}

export interface SchedulePickerProps {
  value: ScheduleValue;
  onChange: (value: ScheduleValue) => void;
  /** A sentence under the times and one under the time zone, from a check or from the server. */
  error?: { cronExpression?: string; timezone?: string };
  /** The question above the picker. */
  label?: string;
  disabled?: boolean;
  /**
   * Whether the sentence under the times also says when the next run is,
   * worked out from the clock ("Next run: tomorrow at 09:00."). On by
   * default, for a schedule being made. A page that knows more (the schedule
   * is off, timed runs are paused, or the server has said the next run
   * itself) turns it off.
   */
  showNextRun?: boolean;
}

/** The time zone of this browser, or UTC when it cannot be read. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timeZones(current: string): string[] {
  let zones: string[] = [];
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    zones = supported ? supported("timeZone") : [];
  } catch {
    zones = [];
  }
  const all = new Set<string>(["UTC", ...zones]);
  if (current) all.add(current);
  return [...all].sort((a, b) => (a === "UTC" ? -1 : b === "UTC" ? 1 : a.localeCompare(b)));
}

const SHAPE_OPTIONS: Array<{ shape: ScheduleShape; label: string }> = [
  { shape: "hourly", label: "Every hour" },
  { shape: "daily", label: "Every day at" },
  { shape: "weekdays", label: "Weekdays at" },
  { shape: "weekly", label: "Every week on" },
  { shape: "monthly", label: "Every month on day" },
];

/** The choice a shape starts with, keeping the time, weekday or day already chosen. */
function choiceOfShape(shape: ScheduleShape, from: ScheduleChoice): ScheduleChoice {
  const time = "time" in from ? from.time : DEFAULT_SCHEDULE_TIME;
  switch (shape) {
    case "hourly":
      return { kind: "hourly" };
    case "daily":
      return { kind: "daily", time };
    case "weekdays":
      return { kind: "weekdays", time };
    case "weekly":
      return { kind: "weekly", day: from.kind === "weekly" ? from.day : 1, time };
    case "monthly":
      return { kind: "monthly", dayOfMonth: from.kind === "monthly" ? from.dayOfMonth : 1, time };
  }
}

/**
 * "When should it run?": one of five plain choices, the sentence it makes,
 * the time zone its times are in, and under "Custom times (cron)" the cron
 * line itself.
 * Holds no schedule of its own: `value` in, `onChange` out.
 */
export function SchedulePicker({
  value,
  onChange,
  error,
  label = "When should it run?",
  disabled,
  showNextRun = true,
}: SchedulePickerProps) {
  const id = useId();
  const choice = useMemo(() => cronToChoice(value.cronExpression), [value.cronExpression]);
  const isCustom = choice.kind === "custom";
  const [cronOpen, setCronOpen] = useState(isCustom);
  const [zoneOpen, setZoneOpen] = useState(false);
  // The next run depends on the clock, so it is worked out after mount.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), [value.cronExpression, value.timezone]);

  const zones = useMemo(() => (zoneOpen ? timeZones(value.timezone) : []), [zoneOpen, value.timezone]);
  const nextRun = showNextRun && now ? describeNextRun(choice, value.timezone, now) : null;
  const sentence = `${describeSchedule(choice)}${nextRun ? ` Next run: ${nextRun}.` : ""}`;

  const setChoice = (next: ScheduleChoice) => onChange({ ...value, cronExpression: choiceToCron(next) });
  const showCron = cronOpen || isCustom;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-shape`}>{label}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-56">
            <Select
              id={`${id}-shape`}
              value={choice.kind}
              disabled={disabled}
              aria-describedby={`${id}-sentence`}
              onChange={(e) => {
                if (e.target.value === "custom") return;
                setChoice(choiceOfShape(e.target.value as ScheduleShape, choice));
              }}
            >
              {SHAPE_OPTIONS.map((option) => (
                <option key={option.shape} value={option.shape}>
                  {option.label}
                </option>
              ))}
              {isCustom && <option value="custom">Custom times</option>}
            </Select>
          </div>

          {choice.kind === "weekly" && (
            <div className="w-40">
              <Select
                aria-label="Day of the week"
                value={String(choice.day)}
                disabled={disabled}
                onChange={(e) => setChoice({ ...choice, day: Number(e.target.value) })}
              >
                {/* Monday first, as a week is read. */}
                {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                  <option key={day} value={day}>
                    {WEEKDAY_NAMES[day]}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {choice.kind === "monthly" && (
            <div className="w-24">
              <Select
                aria-label="Day of the month"
                value={String(choice.dayOfMonth)}
                disabled={disabled}
                onChange={(e) => setChoice({ ...choice, dayOfMonth: Number(e.target.value) })}
              >
                {Array.from({ length: MAX_MONTH_DAY }, (_, index) => index + 1).map((day) => (
                  <option key={day} value={day}>
                    {day}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {(choice.kind === "weekly" || choice.kind === "monthly") && (
            <span className="text-sm text-muted-foreground">at</span>
          )}

          {"time" in choice && (
            <div className="w-32">
              <Input
                type="time"
                aria-label="Time"
                value={choice.time}
                disabled={disabled}
                onChange={(e) => {
                  // An emptied time input keeps the time it had.
                  if (e.target.value) setChoice({ ...choice, time: e.target.value });
                }}
              />
            </div>
          )}
        </div>
        <p id={`${id}-sentence`} className="text-sm text-muted-foreground" aria-live="polite">
          {sentence}
        </p>
        {error?.cronExpression && (
          <p role="alert" className="text-sm text-danger">
            {error.cronExpression}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-sm text-muted-foreground">
          Times are in <span className="font-medium text-foreground">{value.timezone || "UTC"}</span>.{" "}
          <button
            type="button"
            disabled={disabled}
            aria-expanded={zoneOpen}
            aria-controls={`${id}-zone`}
            onClick={() => setZoneOpen((open) => !open)}
            className="rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            Change.
          </button>
        </p>
        {zoneOpen && (
          <div id={`${id}-zone`} className="max-w-sm space-y-1.5">
            <Label htmlFor={`${id}-zone-select`}>Time zone</Label>
            <Select
              id={`${id}-zone-select`}
              value={value.timezone}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, timezone: e.target.value })}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </div>
        )}
        {error?.timezone && (
          <p role="alert" className="text-sm text-danger">
            {error.timezone}
          </p>
        )}
      </div>

      <div>
        <button
          type="button"
          aria-expanded={showCron}
          aria-controls={`${id}-custom`}
          onClick={() => setCronOpen(!showCron)}
          // A custom schedule keeps its cron line in view.
          disabled={isCustom}
          className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:text-muted-foreground"
        >
          {showCron ? (
            <ChevronDown className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden />
          )}
          Custom times (cron)
        </button>
        {showCron && (
          <div id={`${id}-custom`} className="mt-3 max-w-sm space-y-1.5">
            <Label htmlFor={`${id}-cron`}>Custom times (cron)</Label>
            <Input
              id={`${id}-cron`}
              value={value.cronExpression}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              placeholder="0 9 * * 1-5"
              className="font-mono"
              aria-describedby={`${id}-cron-hint`}
              onChange={(e) => onChange({ ...value, cronExpression: e.target.value })}
            />
            <p id={`${id}-cron-hint`} className="text-xs text-muted-foreground">
              Five parts: minute, hour, day of the month, month, day of the week.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
