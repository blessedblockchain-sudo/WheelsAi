"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Calendar, Clock, Pause, Pencil, Play, Plus, RefreshCw, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";

import {
  agentsApi,
  getErrorMessage,
  orchestrationApi,
  schedulerApi,
  type Agent,
  type ScheduledTask,
  type SchedulerStats,
  type TaskExecution,
  type TaskTypeCatalogue,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";
import { Stat } from "@/components/ui/stat";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExecutionDetailDrawer } from "@/components/dashboard/workflows/execution-detail-drawer";
import { formatDuration, formatRelative, formatSchedule } from "@/components/dashboard/workflows/format";
import { StatusBadge } from "@/components/dashboard/workflows/status-badge";
import { TaskFormDialog } from "@/components/dashboard/workflows/task-form-dialog";
import { usePoll } from "@/components/dashboard/workflows/use-poll";

type TabId = "tasks" | "executions";

interface PageData {
  stats: SchedulerStats;
  tasks: ScheduledTask[];
  agents: Agent[];
  catalogue: TaskTypeCatalogue;
  workflows: Array<{ id: string; name: string }>;
}

const th = "px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground";
const rowAction =
  "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export default function SchedulerPage() {
  const confirmAction = useConfirm();
  const [tab, setTab] = useState<TabId>("tasks");
  const [data, setData] = useState<PageData | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [form, setForm] = useState<{ task?: ScheduledTask } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [detail, setDetail] = useState<{ task: ScheduledTask; execution: TaskExecution } | null>(null);

  const load = useCallback(async () => {
    try {
      const [stats, tasksRes, agentsRes, catalogue, workflowsRes] = await Promise.all([
        schedulerApi.getStats(),
        schedulerApi.list({ limit: 100 }),
        agentsApi.list(),
        schedulerApi.taskTypes(),
        orchestrationApi.list({ limit: 100 }),
      ]);
      setData({
        stats,
        tasks: tasksRes.tasks,
        agents: agentsRes.agents,
        catalogue,
        workflows: workflowsRes.orchestrations.map((w) => ({ id: w.id, name: w.name })),
      });
      setLoadError(null);
    } catch (error) {
      setLoadError(error);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const tasks = data?.tasks ?? [];
  // A selection whose task was deleted falls back to the first task, so
  // the executions tab never keeps asking for a task that is gone.
  const executionsTaskId = tasks.some((t) => t.id === selectedTaskId) ? selectedTaskId : (tasks[0]?.id ?? null);
  const executionsTask = tasks.find((t) => t.id === executionsTaskId);

  const executions = usePoll({
    key: tab === "executions" ? executionsTaskId : null,
    load: () => schedulerApi.getExecutions(executionsTaskId!, { limit: 50 }),
    shouldContinue: (value) => value.executions.some((e) => e.status === "running"),
    intervalMs: 3000,
  });

  async function trigger(task: ScheduledTask) {
    setBusy(task.id);
    try {
      const execution = await schedulerApi.trigger(task.id);
      if (execution.status === "running") {
        toast.success("Workflow run started; this execution follows its outcome");
      } else if (execution.status === "success") {
        toast.success(`"${task.name}" ran successfully`);
      } else {
        toast.error(`"${task.name}" ${execution.status}${execution.error ? `: ${execution.error}` : ""}`);
      }
      setDetail({ task, execution });
      load();
      executions.refresh();
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not trigger the task"));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(task: ScheduledTask) {
    setBusy(task.id);
    try {
      await schedulerApi.toggle(task.id, !task.isEnabled);
      load();
    } catch (error) {
      toast.error(getErrorMessage(error, task.isEnabled ? "Could not pause the task" : "Could not resume the task"));
    } finally {
      setBusy(null);
    }
  }

  async function remove(task: ScheduledTask) {
    const confirmed = await confirmAction({
      title: `Delete "${task.name}"?`,
      description: "The task and its execution history are deleted. This cannot be undone.",
      confirmLabel: "Delete task",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await schedulerApi.delete(task.id);
      toast.success("Task deleted");
      load();
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not delete the task"));
    }
  }

  const typeLabel = (type: string) => data?.catalogue.taskTypes.find((t) => t.type === type)?.label ?? type;

  /** What the task acts on, and whether that still exists. */
  function target(task: ScheduledTask): { text: string; missing: boolean; href?: string } | null {
    if (task.orchestrationId) {
      const workflow = data?.workflows.find((w) => w.id === task.orchestrationId);
      return workflow
        ? { text: workflow.name, missing: false, href: `/dashboard/orchestrations/${workflow.id}` }
        : { text: "workflow no longer exists", missing: true };
    }
    if (task.agentId) {
      const agent = data?.agents.find((a) => a.id === task.agentId);
      return agent
        ? { text: agent.name, missing: false, href: `/dashboard/agents/${agent.id}` }
        : { text: "agent no longer exists", missing: true };
    }
    return null;
  }

  const newTaskButton = (
    <Button onClick={() => setForm({})} disabled={!data}>
      <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
      New task
    </Button>
  );

  const noTasks = (
    <EmptyState
      icon={Calendar}
      title="No scheduled tasks"
      description="Run an agent, a workflow, a knowledge sync, a health check, a report or a cleanup on a schedule."
      actionLabel="New task"
      onAction={() => setForm({})}
    />
  );

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Scheduler"
        description="Run agents, workflows, knowledge syncs, health checks, reports, cleanups and webhooks on a cron expression, at an interval, or once."
        actions={newTaskButton}
      />

      {!data && loadError === null && (
        <div className="space-y-6" aria-busy="true">
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
          <SkeletonTable rows={5} cols={7} />
          <span className="sr-only">Loading scheduled tasks</span>
        </div>
      )}

      {!data && loadError !== null && (
        <ErrorState title="Couldn't load scheduled tasks" error={loadError} onRetry={load} />
      )}

      {data && (
        <>
          {!data.stats.schedulerEnabled && (
            <div role="status" className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground">
              <p className="font-medium">Scheduling is switched off on this server.</p>
              <p className="mt-1 text-muted-foreground">
                No worker is firing schedules, so the next-run times below will not be acted on. Tasks can still be
                saved and triggered by hand. An operator turns the scheduler on by setting SCHEDULER_INTERVAL_MS above
                zero.
              </p>
            </div>
          )}
          {/* A reload that failed after the first load: say so, keep the table. */}
          {loadError !== null && (
            <p role="status" className="text-sm text-muted-foreground">
              Could not refresh just now ({getErrorMessage(loadError, "request failed")}); showing what was loaded
              before.
            </p>
          )}

          <div className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Tasks" value={data.stats.totalTasks} size="sm" />
            <Stat label="Active" value={data.stats.activeTasks} size="sm" />
            <Stat label="Running now" value={data.stats.runningExecutions} size="sm" />
            <Stat label="Runs today" value={data.stats.totalRunsToday} size="sm" />
            <Stat
              label="Succeeded today"
              value={data.stats.totalRunsToday > 0 ? `${data.stats.successRateToday.toFixed(0)}%` : "--"}
              hint={data.stats.failedRunsToday > 0 ? `${data.stats.failedRunsToday} failed` : undefined}
              size="sm"
            />
          </div>

          <Tabs value={tab} onValueChange={(value) => setTab(value as TabId)}>
            <TabsList aria-label="Scheduler sections">
              <TabsTrigger value="tasks">Tasks</TabsTrigger>
              <TabsTrigger value="executions">Executions</TabsTrigger>
            </TabsList>

            <TabsContent value="tasks">
              {tasks.length === 0 ? (
                noTasks
              ) : (
                <div className="overflow-hidden rounded-lg border border-border bg-card">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-border">
                          <th scope="col" className={th}>Task</th>
                          <th scope="col" className={th}>Schedule</th>
                          <th scope="col" className={th}>Status</th>
                          <th scope="col" className={th}>Last run</th>
                          <th scope="col" className={th}>Next run</th>
                          <th scope="col" className={th}>Runs</th>
                          <th scope="col" className={`${th} text-right`}>Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {tasks.map((task) => {
                          const on = target(task);
                          return (
                            <tr key={task.id} className="transition-colors hover:bg-muted/50">
                              <td className="px-4 py-3">
                                <div className="font-medium text-foreground">{task.name}</div>
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                  {typeLabel(task.taskType)}
                                  {on && (
                                    <>
                                      {" · "}
                                      {on.href ? (
                                        <Link href={on.href} className="hover:text-foreground hover:underline">
                                          {on.text}
                                        </Link>
                                      ) : (
                                        <span className={on.missing ? "text-danger" : undefined}>{on.text}</span>
                                      )}
                                    </>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <div className="font-mono text-sm text-foreground">{formatSchedule(task)}</div>
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                  {task.scheduleType}
                                  {task.scheduleType !== "interval" ? ` · ${task.timezone}` : ""}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <StatusBadge status={task.status} />
                                {task.status === "failed" && task.lastError && (
                                  <div className="mt-1 max-w-[16rem] truncate text-xs text-danger" title={task.lastError}>
                                    {task.lastError}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                <div className="text-sm text-foreground">{formatRelative(task.lastRunAt)}</div>
                                {task.lastRunStatus && (
                                  <div className="mt-0.5 text-xs text-muted-foreground">
                                    {task.lastRunStatus}
                                    {task.lastRunDurationMs != null ? ` · ${formatDuration(task.lastRunDurationMs)}` : ""}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3 text-sm text-foreground">
                                {task.isEnabled && task.status === "active"
                                  ? formatRelative(task.nextRunAt, "None")
                                  : "Not scheduled"}
                              </td>
                              <td className="px-4 py-3">
                                <div className="text-sm text-foreground">
                                  {task.totalRuns === 0
                                    ? "None yet"
                                    : `${((task.successfulRuns / task.totalRuns) * 100).toFixed(0)}% succeeded`}
                                </div>
                                {task.totalRuns > 0 && (
                                  <div className="mt-0.5 text-xs text-muted-foreground">
                                    {task.successfulRuns} of {task.totalRuns}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center justify-end gap-1">
                                  <button
                                    type="button"
                                    onClick={() => trigger(task)}
                                    disabled={busy === task.id}
                                    className={rowAction}
                                    aria-label={`Run "${task.name}" now`}
                                    title="Run now"
                                  >
                                    {busy === task.id ? (
                                      <RefreshCw className="h-4 w-4 animate-spin" />
                                    ) : (
                                      <Zap className="h-4 w-4" />
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => toggle(task)}
                                    disabled={busy === task.id}
                                    className={rowAction}
                                    aria-label={task.isEnabled ? `Pause "${task.name}"` : `Resume "${task.name}"`}
                                    title={task.isEnabled ? "Pause" : "Resume"}
                                  >
                                    {task.isEnabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setForm({ task })}
                                    className={rowAction}
                                    aria-label={`Edit "${task.name}"`}
                                    title="Edit"
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedTaskId(task.id);
                                      setTab("executions");
                                    }}
                                    className={rowAction}
                                    aria-label={`Show executions of "${task.name}"`}
                                    title="Executions"
                                  >
                                    <Clock className="h-4 w-4" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => remove(task)}
                                    className={`${rowAction} hover:bg-danger/10 hover:text-danger`}
                                    aria-label={`Delete "${task.name}"`}
                                    title="Delete"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="executions">
              {tasks.length === 0 || !executionsTask ? (
                noTasks
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <label htmlFor="executions-task" className="text-sm font-medium text-muted-foreground">
                      Task
                    </label>
                    <div className="w-full max-w-xs">
                      <Select
                        id="executions-task"
                        value={executionsTask.id}
                        onChange={(event) => setSelectedTaskId(event.target.value)}
                      >
                        {tasks.map((task) => (
                          <option key={task.id} value={task.id}>
                            {task.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <button type="button" onClick={executions.refresh} className={rowAction} aria-label="Refresh executions">
                      <RefreshCw className="h-4 w-4" />
                    </button>
                  </div>

                  {executions.loading && !executions.data ? (
                    <div aria-busy="true">
                      <SkeletonTable rows={5} cols={6} />
                      <span className="sr-only">Loading executions</span>
                    </div>
                  ) : !executions.data ? (
                    <ErrorState title="Couldn't load executions" error={executions.error} onRetry={executions.refresh} />
                  ) : executions.data.executions.length === 0 ? (
                    <EmptyState
                      icon={Clock}
                      title="No executions yet"
                      description="An execution is recorded each time this task fires or is run by hand."
                    />
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-border bg-card">
                      <div className="overflow-x-auto">
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-border">
                              <th scope="col" className={th}>Status</th>
                              <th scope="col" className={th}>Started</th>
                              <th scope="col" className={th}>Took</th>
                              <th scope="col" className={th}>Attempt</th>
                              <th scope="col" className={th}>Started by</th>
                              <th scope="col" className={th}>Result</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {executions.data.executions.map((execution) => (
                              <tr key={execution.id} className="transition-colors hover:bg-muted/50">
                                <td className="px-4 py-3">
                                  <StatusBadge status={execution.status} />
                                </td>
                                <td className="px-4 py-3 text-sm text-foreground">
                                  {execution.startedAt ? new Date(execution.startedAt).toLocaleString() : "Not started"}
                                </td>
                                <td className="px-4 py-3 font-mono text-sm text-foreground">
                                  {formatDuration(execution.durationMs)}
                                </td>
                                <td className="px-4 py-3 text-sm text-foreground">{execution.attempt}</td>
                                <td className="px-4 py-3 text-sm text-muted-foreground">
                                  {execution.triggeredBy === "manual" ? "by hand" : execution.triggeredBy}
                                </td>
                                <td className="px-4 py-3">
                                  <button
                                    type="button"
                                    onClick={() => setDetail({ task: executionsTask, execution })}
                                    className="max-w-xs truncate rounded text-left text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  >
                                    {execution.error ? (
                                      <span className="text-danger">{execution.error}</span>
                                    ) : (
                                      "View output"
                                    )}
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}

      {form && data && (
        <TaskFormDialog
          catalogue={data.catalogue}
          agents={data.agents}
          workflows={data.workflows}
          task={form.task}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            load();
          }}
        />
      )}

      {detail && (
        <ExecutionDetailDrawer
          task={detail.task}
          execution={detail.execution}
          onClose={() => setDetail(null)}
          onChanged={() => {
            load();
            executions.refresh();
          }}
        />
      )}
    </div>
  );
}
