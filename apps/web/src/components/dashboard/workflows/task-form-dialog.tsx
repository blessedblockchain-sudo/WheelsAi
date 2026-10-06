"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  deploymentsApi,
  getApiErrorBody,
  getErrorMessage,
  knowledgeApi,
  monitoringApi,
  schedulerApi,
  type Agent,
  type ScheduledTask,
  type ScheduleType,
  type TaskTypeCatalogue,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  buildTaskInput,
  changedFields,
  CRON_PRESETS,
  formFromTask,
  intervalSeconds,
  newTaskForm,
  timezoneOptions,
  valuesFor,
  type FormErrors,
  type IntervalUnit,
  type TaskForm,
} from "./task-form-model";
import { formatInterval } from "./format";
import { TaskTypeFields, type TaskFieldOptions } from "./task-type-fields";

const SCHEDULE_TYPES: Array<{ value: ScheduleType; label: string }> = [
  { value: "cron", label: "Cron" },
  { value: "interval", label: "Interval" },
  { value: "once", label: "Once" },
];

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1 text-xs text-danger">
      {message}
    </p>
  );
}

/** Maps a refused save onto the form: which field, and what the server said. */
function errorsFromResponse(error: unknown): FormErrors | null {
  const failure = getApiErrorBody(error);
  if (!failure) return null;
  const { body, status } = failure;
  const message = typeof body.message === "string" ? body.message : "";
  if (status === 409 && body.error === "name_taken") {
    return { name: "Another scheduled task already has this name" };
  }
  if (status !== 400) return null;
  if (body.error === "invalid_schedule" || body.error === "invalid_task") {
    const field = typeof body.field === "string" ? body.field : "form";
    return { [field]: message || "Not valid" };
  }
  if (body.error === "validation_failed") {
    const details = body.details as { formErrors?: string[]; fieldErrors?: Record<string, string[]> } | undefined;
    const errors: FormErrors = {};
    for (const [field, messages] of Object.entries(details?.fieldErrors ?? {})) {
      // The payload root ("payload", "payload.") carries cross-field rules.
      errors[field === "payload" || field === "payload." ? "form" : field] = messages.join(", ");
    }
    if (details?.formErrors?.length) errors.form = details.formErrors.join(", ");
    if (Object.keys(errors).length === 0 && message) errors.form = message;
    return errors;
  }
  return null;
}

/**
 * Create or edit a scheduled task. The task types, their fields and
 * whether each can run on this server all come from the catalogue, so
 * this form offers exactly what the scheduler will execute.
 */
export function TaskFormDialog({
  catalogue,
  agents,
  workflows,
  task,
  preset,
  onClose,
  onSaved,
}: {
  catalogue: TaskTypeCatalogue;
  agents: Agent[];
  workflows: Array<{ id: string; name: string }>;
  /** The task being edited; omitted to create one. */
  task?: ScheduledTask;
  /** Starting values for a new task (scheduling a workflow from its page). */
  preset?: { taskType?: string; orchestrationId?: string; name?: string };
  onClose: () => void;
  onSaved: (task: ScheduledTask) => void;
}) {
  // An alias (inference) is offered only on a task that already has it.
  const offered = useMemo(
    () => catalogue.taskTypes.filter((t) => !t.aliasOf || t.type === task?.taskType),
    [catalogue, task]
  );
  const typeOf = (id: string) => catalogue.taskTypes.find((t) => t.type === id);

  const [form, setForm] = useState<TaskForm>(() => {
    if (task) return formFromTask(task, typeOf(task.taskType));
    const initial = typeOf(preset?.taskType ?? "") ?? offered.find((t) => t.available) ?? offered[0];
    return newTaskForm(initial, preset);
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState<TaskFieldOptions>({
    knowledgeBases: [],
    deployments: [],
    monitors: [],
    alertChannels: [],
  });
  const timezones = useMemo(() => {
    const zones = timezoneOptions();
    return zones.includes(form.timezone) ? zones : [form.timezone, ...zones];
  }, [form.timezone]);

  // The pickers' lists. Each is independent: one that fails shows its own
  // message instead of emptying the whole form.
  useEffect(() => {
    let cancelled = false;
    const load = async <T,>(key: keyof TaskFieldOptions, fetcher: () => Promise<T[]>) => {
      try {
        const items = await fetcher();
        if (!cancelled) setOptions((o) => ({ ...o, [key]: items }));
      } catch {
        if (!cancelled) setOptions((o) => ({ ...o, [key]: null }));
      }
    };
    load("knowledgeBases", async () => (await knowledgeApi.list({ limit: 100 })).knowledgeBases);
    load("deployments", async () => (await deploymentsApi.list()).deployments);
    load("monitors", async () => (await monitoringApi.getUptimeMonitors()).data);
    load("alertChannels", async () => (await monitoringApi.getChannels()).data);
    return () => {
      cancelled = true;
    };
  }, []);

  const type = typeOf(form.taskType);
  const update = (patch: Partial<TaskForm>) => setForm((f) => ({ ...f, ...patch }));

  function changeType(next: string) {
    const nextType = typeOf(next);
    setErrors({});
    setForm((f) => ({
      ...f,
      taskType: next,
      values: valuesFor(nextType, {}),
      maxRetries: nextType?.retryable ? "3" : "0",
    }));
  }

  async function save() {
    if (!type) {
      setErrors({ taskType: "Choose a task type" });
      return;
    }
    const { input, errors: found } = buildTaskInput(form, type);

    let patch: ReturnType<typeof changedFields> | null = null;
    if (task) {
      const before = buildTaskInput(formFromTask(task, typeOf(task.taskType)), typeOf(task.taskType) ?? type).input;
      patch = changedFields(before, input);
      // A task saved before its type had rules can still be renamed: what
      // the edit does not send is not held against it.
      if (!("payload" in patch) && !("taskType" in patch)) {
        for (const key of Object.keys(found)) if (key.startsWith("payload.")) delete found[key];
      }
      if (!("scheduleType" in patch)) {
        delete found.cronExpression;
        delete found.intervalSeconds;
        delete found.scheduledAt;
      }
    }

    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    if (patch && Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    setErrors({});
    setSaving(true);
    try {
      const saved = task ? await schedulerApi.update(task.id, patch!) : await schedulerApi.create(input);
      toast.success(task ? "Task saved" : "Task created");
      onSaved(saved);
    } catch (error) {
      const mapped = errorsFromResponse(error);
      if (mapped) setErrors(mapped);
      else toast.error(getErrorMessage(error, task ? "Could not save the task" : "Could not create the task"));
    } finally {
      setSaving(false);
    }
  }

  const seconds = intervalSeconds(form);
  // Errors for fields this form does not render (a server-side rule on a
  // field we have no input for) still have to be seen.
  const shownKeys = new Set([
    "name",
    "taskType",
    "agentId",
    "orchestrationId",
    "cronExpression",
    "intervalSeconds",
    "scheduledAt",
    "timezone",
    "timeout",
    "maxRetries",
    ...(type?.fields ?? []).map((f) => `payload.${f.key}`),
  ]);
  const otherErrors = Object.entries(errors).filter(([key]) => !shownKeys.has(key));

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent
        className="flex max-h-[90vh] max-w-2xl flex-col"
        aria-labelledby="task-form-title"
        aria-describedby="task-form-description"
      >
        <DialogHeader>
          <DialogTitle id="task-form-title">{task ? "Edit scheduled task" : "New scheduled task"}</DialogTitle>
          <DialogDescription id="task-form-description">
            {catalogue.schedulerEnabled
              ? `The scheduler checks for due tasks every ${Math.round(catalogue.intervalMs / 1000)} seconds.`
              : "Scheduling is switched off on this server: tasks can be saved and triggered by hand, but none fires on its schedule."}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex-1 space-y-4 overflow-y-auto pr-1">
          <div>
            <label htmlFor="task-name" className="mb-1 block text-sm font-medium text-foreground">
              Name
            </label>
            <Input
              id="task-name"
              value={form.name}
              onChange={(event) => update({ name: event.target.value })}
              maxLength={80}
              placeholder="Nightly knowledge sync"
              aria-invalid={Boolean(errors.name)}
            />
            <FieldError message={errors.name} />
          </div>

          <div>
            <label htmlFor="task-type" className="mb-1 block text-sm font-medium text-foreground">
              What it does
            </label>
            <Select
              id="task-type"
              value={form.taskType}
              onChange={(event) => changeType(event.target.value)}
              aria-invalid={Boolean(errors.taskType)}
            >
              {offered.map((option) => (
                <option key={option.type} value={option.type}>
                  {option.label}
                  {option.available ? "" : " (not available)"}
                </option>
              ))}
            </Select>
            {type && <p className="mt-1 text-xs text-muted-foreground">{type.description}</p>}
            {type && !type.available && (
              <p role="status" className="mt-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-foreground">
                Not available on this server: {type.reason ?? "no reason given"}
              </p>
            )}
            <FieldError message={errors.taskType} />
          </div>

          {type?.orchestration && (
            <div>
              <label htmlFor="task-workflow" className="mb-1 block text-sm font-medium text-foreground">
                Workflow
              </label>
              <Select
                id="task-workflow"
                value={form.orchestrationId}
                onChange={(event) => update({ orchestrationId: event.target.value })}
                aria-invalid={Boolean(errors.orchestrationId)}
              >
                <option value="">Choose a workflow</option>
                {workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </Select>
              {workflows.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">You have no workflows yet.</p>
              )}
              <FieldError message={errors.orchestrationId} />
            </div>
          )}

          {type && type.agent !== "none" && (
            <div>
              <label htmlFor="task-agent" className="mb-1 block text-sm font-medium text-foreground">
                Agent
                {type.agent === "optional" && (
                  <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
                )}
              </label>
              <Select
                id="task-agent"
                value={form.agentId}
                onChange={(event) => update({ agentId: event.target.value })}
                aria-invalid={Boolean(errors.agentId)}
              >
                <option value="">{type.agent === "required" ? "Choose an agent" : "No agent"}</option>
                {form.agentId !== "" && !agents.some((a) => a.id === form.agentId) && (
                  <option value={form.agentId}>Deleted agent ({form.agentId.slice(0, 8)})</option>
                )}
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </Select>
              <FieldError message={errors.agentId} />
            </div>
          )}

          {type && (
            <TaskTypeFields
              fields={type.fields}
              values={form.values}
              errors={errors}
              options={options}
              onChange={(key, value) => setForm((f) => ({ ...f, values: { ...f.values, [key]: value } }))}
            />
          )}

          <fieldset className="space-y-3 border-t border-border pt-4">
            <legend className="sr-only">Schedule</legend>
            <p className="text-sm font-medium text-foreground">When it runs</p>
            <div role="radiogroup" aria-label="Schedule type" className="grid grid-cols-3 gap-2">
              {SCHEDULE_TYPES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={form.scheduleType === option.value}
                  onClick={() => update({ scheduleType: option.value })}
                  className={cn(
                    "rounded-md border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    form.scheduleType === option.value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {form.scheduleType === "cron" && (
              <div>
                <label htmlFor="task-cron" className="mb-1 block text-sm font-medium text-foreground">
                  Cron expression
                </label>
                <Input
                  id="task-cron"
                  value={form.cronExpression}
                  onChange={(event) => update({ cronExpression: event.target.value })}
                  placeholder="0 9 * * 1-5"
                  className="font-mono"
                  aria-invalid={Boolean(errors.cronExpression)}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Five fields: minute, hour, day of month, month, weekday. Read in the time zone below.
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {CRON_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => update({ cronExpression: preset.value })}
                      className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground hover:border-primary/50 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <FieldError message={errors.cronExpression} />
              </div>
            )}

            {form.scheduleType === "interval" && (
              <div>
                <label htmlFor="task-interval" className="mb-1 block text-sm font-medium text-foreground">
                  Every
                </label>
                <div className="flex gap-2">
                  <Input
                    id="task-interval"
                    value={form.intervalValue}
                    onChange={(event) => update({ intervalValue: event.target.value })}
                    inputMode="numeric"
                    aria-invalid={Boolean(errors.intervalSeconds)}
                  />
                  <Select
                    aria-label="Interval unit"
                    value={form.intervalUnit}
                    onChange={(event) => update({ intervalUnit: event.target.value as IntervalUnit })}
                  >
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                  </Select>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {seconds !== null && seconds >= 60
                    ? `${formatInterval(seconds)}, counted from each run. `
                    : ""}
                  The shortest interval is one minute.
                </p>
                <FieldError message={errors.intervalSeconds} />
              </div>
            )}

            {form.scheduleType === "once" && (
              <div>
                <label htmlFor="task-at" className="mb-1 block text-sm font-medium text-foreground">
                  Date and time
                </label>
                <Input
                  id="task-at"
                  type="datetime-local"
                  value={form.scheduledAt}
                  onChange={(event) => update({ scheduledAt: event.target.value })}
                  aria-invalid={Boolean(errors.scheduledAt)}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  The wall-clock time in the time zone below, not your browser&apos;s. It must be in the future.
                </p>
                <FieldError message={errors.scheduledAt} />
              </div>
            )}

            <div>
              <label htmlFor="task-timezone" className="mb-1 block text-sm font-medium text-foreground">
                Time zone
              </label>
              <Select
                id="task-timezone"
                value={form.timezone}
                onChange={(event) => update({ timezone: event.target.value })}
                aria-invalid={Boolean(errors.timezone)}
              >
                {timezones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </Select>
              <FieldError message={errors.timezone} />
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-3 border-t border-border pt-4">
            <div>
              <label htmlFor="task-timeout" className="mb-1 block text-sm font-medium text-foreground">
                Time limit (seconds)
              </label>
              <Input
                id="task-timeout"
                value={form.timeoutSeconds}
                onChange={(event) => update({ timeoutSeconds: event.target.value })}
                inputMode="numeric"
                aria-invalid={Boolean(errors.timeout)}
              />
              <FieldError message={errors.timeout} />
            </div>
            <div>
              <label htmlFor="task-retries" className="mb-1 block text-sm font-medium text-foreground">
                Retries
              </label>
              {type?.retryable ? (
                <>
                  <Input
                    id="task-retries"
                    value={form.maxRetries}
                    onChange={(event) => update({ maxRetries: event.target.value })}
                    inputMode="numeric"
                    aria-invalid={Boolean(errors.maxRetries)}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">0 to 5. Each retry is billed like a run.</p>
                </>
              ) : (
                <p id="task-retries" className="pt-2 text-xs text-muted-foreground">
                  This task type is not retried.
                </p>
              )}
              <FieldError message={errors.maxRetries} />
            </div>
          </div>

          <div>
            <label htmlFor="task-description" className="mb-1 block text-sm font-medium text-foreground">
              Notes <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id="task-description"
              value={form.description}
              onChange={(event) => update({ description: event.target.value })}
              rows={2}
              maxLength={500}
            />
          </div>

          {otherErrors.length > 0 && (
            <div role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
              {otherErrors.map(([key, message]) => (
                <p key={key}>{key === "form" ? message : `${key}: ${message}`}</p>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} isLoading={saving}>
            {task ? "Save changes" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
