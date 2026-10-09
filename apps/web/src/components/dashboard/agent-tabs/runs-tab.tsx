"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Play } from "lucide-react";
import { toast } from "sonner";

import { browserTimezone } from "@/components/dashboard/schedule-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  agentsApi,
  getErrorMessage,
  getValidationError,
  type AgentDetail,
  type RunView,
  type ScheduleAnswer,
} from "@/lib/api";
import {
  SCHEDULE_MESSAGES,
  checkScheduleForm,
  codeOf,
  rebaseForm,
  sameSchedule,
  scheduleBodyOf,
  scheduleFieldErrors,
  scheduleFormOf,
  statusOf,
  type ScheduleForm,
  type ScheduleFormErrors,
} from "@/lib/agent-page";
import { RUN_ALREADY_RUNNING, runNowNote } from "@/lib/agent-runs";
import { DeliveryCard } from "./delivery-card";
import { RunList } from "./run-list";
import { ScheduleCard } from "./schedule-card";

export interface RunsTabProps {
  agent: AgentDetail;
}

const SAVE_FAILED = "The schedule could not be saved. Try again.";

/**
 * A self-running agent's front door, and the Schedule tab of the other
 * kinds: when it runs, where its results go, Run now, and every run with
 * what it produced.
 */
export function RunsTab({ agent }: RunsTabProps) {
  const agentId = agent.id;
  const [answer, setAnswer] = useState<ScheduleAnswer | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  /** What the server holds, as a form; the form itself is what is typed. */
  const [saved, setSaved] = useState<ScheduleForm | null>(null);
  const [form, setForm] = useState<ScheduleForm | null>(null);
  const [errors, setErrors] = useState<ScheduleFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState<RunView | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);

  /** Takes an answer as the new truth and starts the form from it. */
  const adopt = useCallback((next: ScheduleAnswer) => {
    const fresh = scheduleFormOf(next, browserTimezone());
    setAnswer(next);
    setSaved(fresh);
    setForm(fresh);
    setErrors({});
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      adopt(await agentsApi.getSchedule(agentId));
    } catch (err) {
      setLoadError(err);
    }
  }, [agentId, adopt]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Sends one state of the form. `keepEdits` is for a save of one thing (the
   * switch, the place): what else was typed stays typed.
   */
  async function put(next: ScheduleForm, success: string, keepEdits: boolean): Promise<void> {
    const problems = checkScheduleForm(next);
    if (Object.keys(problems).length > 0) {
      setErrors(problems);
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      const result = await agentsApi.putSchedule(agentId, scheduleBodyOf(next));
      const fresh = scheduleFormOf(result, browserTimezone());
      setAnswer(result);
      setForm((current) => (keepEdits && current && saved ? rebaseForm(current, saved, fresh) : fresh));
      setSaved(fresh);
      toast.success(success);
    } catch (err) {
      if (statusOf(err) === 409 && codeOf(err) === "schedule_changed") {
        // Changed somewhere else: say so in the server's words and show what it is now.
        toast.error(getErrorMessage(err, "This schedule was changed somewhere else. It was reloaded."));
        await load();
        return;
      }
      const validation = getValidationError(err);
      if (validation && Object.keys(validation.fields).length > 0) {
        setErrors(scheduleFieldErrors(validation.fields));
      } else if (codeOf(err) === "invalid_schedule") {
        setErrors({ cronExpression: getErrorMessage(err, SAVE_FAILED) });
      } else {
        setErrors({ form: validation?.message ?? getErrorMessage(err, SAVE_FAILED) });
      }
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    if (starting) return;
    setStarting(true);
    setRunNotice(null);
    try {
      const { run } = await agentsApi.runScheduleNow(agentId);
      setStarted(run);
    } catch (err) {
      if (statusOf(err) === 409) setRunNotice(RUN_ALREADY_RUNNING);
      else setRunNotice(getErrorMessage(err, "The run could not be started. Try again."));
    } finally {
      setStarting(false);
    }
  }

  const dirty = useMemo(() => (form && saved ? !sameSchedule(form, saved) : false), [form, saved]);

  if (loadError && !answer) {
    return <ErrorState title="Couldn't load this agent's schedule" error={loadError} onRetry={load} />;
  }

  if (!answer || !form || !saved) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="grid gap-6 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-32" />
              </CardHeader>
              <CardContent className="space-y-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-4 w-64 max-w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Skeleton className="h-24 w-full" />
        <span className="sr-only">Loading the schedule</span>
      </div>
    );
  }

  const schedule = answer.schedule;
  const note = runNowNote(schedule?.deliver);

  return (
    <div className="min-w-0 space-y-6">
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <ScheduleCard
          answer={answer}
          form={form}
          onChange={setForm}
          errors={errors}
          dirty={dirty}
          saving={saving}
          onSave={() => put(form, schedule ? "Schedule saved" : SCHEDULE_MESSAGES.on, false)}
          onDiscard={() => {
            setForm(saved);
            setErrors({});
          }}
          onToggle={(enabled) =>
            put({ ...saved, enabled }, enabled ? SCHEDULE_MESSAGES.on : SCHEDULE_MESSAGES.off, true)
          }
        />
        <DeliveryCard
          channelId={form.channelId}
          hasSchedule={Boolean(schedule)}
          saving={saving}
          error={errors.deliver}
          onChange={(channelId) => {
            if (!schedule) {
              setForm({ ...form, channelId });
              return;
            }
            setForm({ ...form, channelId });
            void put({ ...saved, channelId }, "Saved where results go", true);
          }}
        />
      </div>

      <section aria-labelledby="agent-runs-heading" className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="agent-runs-heading" className="text-base font-semibold text-foreground">
              Runs
            </h2>
            <p className="text-sm text-muted-foreground">
              {schedule ? "Every run of this agent and what it produced." : "Save a schedule to start running this agent."}
            </p>
          </div>
          {schedule && (
            <div className="flex min-w-0 flex-col items-start gap-1 sm:items-end">
              <Button type="button" onClick={runNow} isLoading={starting}>
                <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                Run now
              </Button>
              {starting && (
                <p role="status" className="text-sm text-foreground">
                  {SCHEDULE_MESSAGES.runningNow}
                </p>
              )}
              {note && <p className="text-xs text-muted-foreground">{note}</p>}
              {runNotice && (
                <p role="alert" className="text-sm text-danger">
                  {runNotice}
                </p>
              )}
            </div>
          )}
        </div>

        <RunList
          agentId={agentId}
          place={schedule?.deliver ?? null}
          timeZone={schedule?.timezone}
          started={started}
        />
      </section>
    </div>
  );
}
