"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Save } from "lucide-react";

import { SchedulePicker } from "@/components/dashboard/schedule-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ScheduleAnswer } from "@/lib/api";
import {
  SCHEDULE_LIMITS,
  SCHEDULE_MESSAGES,
  otherTasksLine,
  suggestedScheduleSentence,
  type ScheduleForm,
  type ScheduleFormErrors,
} from "@/lib/agent-page";
import { formatRunTime } from "@/lib/agent-runs";

export interface ScheduleCardProps {
  /** What the server holds: the schedule or none, the suggestion, and the two notes. */
  answer: ScheduleAnswer;
  /** The form as typed. */
  form: ScheduleForm;
  onChange: (form: ScheduleForm) => void;
  errors: ScheduleFormErrors;
  /** Whether the form differs from what the server holds. */
  dirty: boolean;
  saving: boolean;
  /** Saves the whole form. */
  onSave: () => void;
  /** Puts the form back to what the server holds. */
  onDiscard: () => void;
  /** Turns the schedule on or off at once. */
  onToggle: (enabled: boolean) => void;
}

/**
 * When the agent runs. With a schedule: its switch, its times, the server's
 * next run and, under Advanced, what it is told and its limits. With none:
 * the times to start from and one button that makes the schedule.
 */
export function ScheduleCard({ answer, form, onChange, errors, dirty, saving, onSave, onDiscard, onToggle }: ScheduleCardProps) {
  const id = useId();
  const schedule = answer.schedule;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const hasAdvancedProblem = Boolean(errors.prompt || errors.timeoutSeconds || errors.maxRetries);
  const showAdvanced = advancedOpen || hasAdvancedProblem;

  const set = (changes: Partial<ScheduleForm>) => onChange({ ...form, ...changes });
  const setUp = schedule ? null : suggestedScheduleSentence(answer.suggested);
  const others = otherTasksLine(answer.otherTasks);
  // The server's own next run, and only while it is true: the schedule is
  // on, timed runs are being picked up, and the times shown are the saved ones.
  const nextRun =
    schedule?.enabled && answer.schedulerRunning && !dirty
      ? formatRunTime(schedule.nextRunAt, { timeZone: schedule.timezone })
      : "";

  return (
    <Card className="min-w-0">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="text-base">Schedule</CardTitle>
          {!schedule && !setUp && (
            <CardDescription>Choose when this agent runs. It starts running once you save.</CardDescription>
          )}
        </div>
        {schedule && (
          <div className="flex items-center gap-2">
            <Switch
              id={`${id}-enabled`}
              checked={schedule.enabled}
              onCheckedChange={onToggle}
              disabled={saving}
              aria-labelledby={`${id}-enabled-label`}
            />
            <span id={`${id}-enabled-label`} className="text-sm font-medium text-foreground">
              {schedule.enabled ? SCHEDULE_MESSAGES.on : SCHEDULE_MESSAGES.off}
            </span>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {!answer.schedulerRunning && (
          <p role="status" className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-sm text-foreground">
            {SCHEDULE_MESSAGES.schedulerPaused}
          </p>
        )}

        {setUp && <p className="text-sm text-foreground">{setUp}</p>}

        {schedule && schedule.cronExpression === null && (
          <p className="text-sm text-muted-foreground">
            This schedule was set up on the Scheduler page and runs on a timer. Saving here changes it to the times below.
          </p>
        )}

        <div className="space-y-2">
          <SchedulePicker
            value={{ cronExpression: form.cronExpression, timezone: form.timezone }}
            onChange={(value) => set({ cronExpression: value.cronExpression, timezone: value.timezone })}
            error={{ cronExpression: errors.cronExpression, timezone: errors.timezone }}
            disabled={saving}
            showNextRun={false}
          />
          {nextRun && (
            <p className="text-sm text-muted-foreground">
              Next scheduled run: <span className="font-medium text-foreground">{nextRun}</span> ({schedule?.timezone}).
            </p>
          )}
        </div>

        {schedule && (
          <div>
            <button
              type="button"
              onClick={() => setAdvancedOpen((open) => !open)}
              aria-expanded={showAdvanced}
              aria-controls={`${id}-advanced`}
              className="flex items-center gap-1 rounded text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showAdvanced ? (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              )}
              Advanced
            </button>

            {showAdvanced && (
              <div id={`${id}-advanced`} className="mt-3 space-y-4 rounded-lg border p-4">
                <div className="space-y-1.5">
                  <Label htmlFor={`${id}-prompt`}>What it is told at each run</Label>
                  <Textarea
                    id={`${id}-prompt`}
                    value={form.prompt}
                    onChange={(e) => set({ prompt: e.target.value })}
                    rows={3}
                    maxLength={2000}
                    disabled={saving}
                    error={errors.prompt}
                    aria-describedby={`${id}-prompt-hint`}
                  />
                  <p id={`${id}-prompt-hint`} className="text-xs text-muted-foreground">
                    {SCHEDULE_MESSAGES.promptEmpty}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor={`${id}-stamp`} className="min-w-0">
                    Tell it the date and time at each run
                  </Label>
                  <Switch
                    id={`${id}-stamp`}
                    checked={form.stampTime}
                    onCheckedChange={(stampTime) => set({ stampTime })}
                    disabled={saving}
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`${id}-timeout`}>Stop a run after (seconds)</Label>
                    <Input
                      id={`${id}-timeout`}
                      type="number"
                      inputMode="numeric"
                      min={SCHEDULE_LIMITS.timeoutSeconds.min}
                      max={SCHEDULE_LIMITS.timeoutSeconds.max}
                      step={1}
                      value={form.timeoutSeconds}
                      onChange={(e) => set({ timeoutSeconds: e.target.value })}
                      disabled={saving}
                      error={errors.timeoutSeconds}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${id}-retries`}>Tries after a failed run. Each try is billed like a run.</Label>
                    <Input
                      id={`${id}-retries`}
                      type="number"
                      inputMode="numeric"
                      min={SCHEDULE_LIMITS.maxRetries.min}
                      max={SCHEDULE_LIMITS.maxRetries.max}
                      step={1}
                      value={form.maxRetries}
                      onChange={(e) => set({ maxRetries: e.target.value })}
                      disabled={saving}
                      error={errors.maxRetries}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {errors.form && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {errors.form}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {schedule ? (
            <>
              <Button type="button" onClick={onSave} disabled={!dirty} isLoading={saving}>
                <Save className="mr-2 h-4 w-4" aria-hidden="true" />
                Save schedule
              </Button>
              <Button type="button" variant="outline" onClick={onDiscard} disabled={!dirty || saving}>
                Discard changes
              </Button>
            </>
          ) : (
            <Button type="button" onClick={onSave} isLoading={saving}>
              {setUp ? "Turn the schedule on" : "Save schedule"}
            </Button>
          )}
        </div>

        {others && (
          <p className="text-sm text-muted-foreground">
            {others}{" "}
            <Link
              href="/dashboard/scheduler"
              className="rounded text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open the Scheduler
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
