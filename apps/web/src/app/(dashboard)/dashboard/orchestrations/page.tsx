"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, GitBranch, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  agentsApi,
  getErrorMessage,
  orchestrationApi,
  schedulerApi,
  type Agent,
  type Orchestration,
  type OrchestrationStats,
  type TaskTypeCatalogue,
} from "@/lib/api";
import { buttonVariants } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Stat } from "@/components/ui/stat";
import { Switch } from "@/components/ui/switch";
import { formatDuration, formatRelative } from "@/components/dashboard/workflows/format";
import { RunDialog } from "@/components/dashboard/workflows/run-dialog";
import { StatusBadge } from "@/components/dashboard/workflows/status-badge";
import { TaskFormDialog } from "@/components/dashboard/workflows/task-form-dialog";
import { EXECUTION_MODES } from "@/components/dashboard/workflows/workflow-model";
import { cn } from "@/lib/utils";
import { codeOf } from "@/lib/agent-page";
import { WORKFLOW_SELL_WORDS, refusedForSale } from "@/lib/workflow-sell";

const NEW_WORKFLOW = "/dashboard/orchestrations/new";

const iconButton =
  "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export default function WorkflowsPage() {
  const router = useRouter();
  const confirmAction = useConfirm();
  const [workflows, setWorkflows] = useState<Orchestration[]>([]);
  const [stats, setStats] = useState<OrchestrationStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [runTarget, setRunTarget] = useState<Orchestration | null>(null);
  // What the schedule form needs, fetched when it is first opened.
  const [scheduleTarget, setScheduleTarget] = useState<{
    workflow: Orchestration;
    catalogue: TaskTypeCatalogue;
    agents: Agent[];
  } | null>(null);
  const [openingSchedule, setOpeningSchedule] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    try {
      if (!quiet) setLoading(true);
      const [statsRes, listRes] = await Promise.all([
        orchestrationApi.getStats(),
        orchestrationApi.list({ limit: 100 }),
      ]);
      setStats(statsRes);
      setWorkflows(listRes.orchestrations);
      setLoadError(null);
    } catch (error) {
      // A background refresh that fails keeps the list on screen.
      if (!quiet) setLoadError(error);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(workflow: Orchestration) {
    try {
      await orchestrationApi.update(workflow.id, { isEnabled: !workflow.isEnabled });
      load(true);
    } catch (error) {
      refused(workflow, error, "Could not change the workflow");
    }
  }

  // The API's own sentence. A workflow on sale, or one people have paid for, is stopped from its Sell part
  // first: the refusal offers the way there.
  function refused(workflow: Orchestration, error: unknown, fallback: string) {
    const message = getErrorMessage(error, fallback);
    if (refusedForSale(codeOf(error))) {
      const sell = `/dashboard/orchestrations/${workflow.id}?tab=api`;
      toast.error(message, { action: { label: WORKFLOW_SELL_WORDS.openSell, onClick: () => router.push(sell) } });
    } else {
      toast.error(message);
    }
  }

  async function remove(workflow: Orchestration) {
    const schedules = workflow.scheduleCount ?? 0;
    const confirmed = await confirmAction({
      title: `Delete "${workflow.name}"?`,
      description: `Its steps and run history are deleted${
        schedules > 0 ? `, along with ${schedules} schedule${schedules === 1 ? "" : "s"} that run it` : ""
      }. Runs in progress are cancelled. This cannot be undone.`,
      confirmLabel: "Delete workflow",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await orchestrationApi.delete(workflow.id);
      toast.success("Workflow deleted");
      load(true);
    } catch (error) {
      refused(workflow, error, "Could not delete the workflow");
    }
  }

  async function openSchedule(workflow: Orchestration) {
    setOpeningSchedule(workflow.id);
    try {
      const [catalogue, agentsRes] = await Promise.all([schedulerApi.taskTypes(), agentsApi.list()]);
      setScheduleTarget({ workflow, catalogue, agents: agentsRes.agents });
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not open the schedule form"));
    } finally {
      setOpeningSchedule(null);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Workflows"
        description="Chain agents, model deployments and knowledge-base searches into multi-step pipelines with branches, loops and parallel steps. Run them on demand, through the API, or on a schedule."
        actions={
          <Link href={NEW_WORKFLOW} className={buttonVariants()}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
            New workflow
          </Link>
        }
      />

      {loading && (
        <div className="space-y-6" aria-busy="true">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
          <span className="sr-only">Loading workflows</span>
        </div>
      )}

      {!loading && loadError !== null && (
        <ErrorState title="Couldn't load workflows" error={loadError} onRetry={() => load()} />
      )}

      {!loading && loadError === null && (
        <>
          {stats && (
            <div className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Workflows" value={stats.totalOrchestrations} />
              <Stat label="Enabled" value={stats.activeOrchestrations} />
              <Stat label="Runs, all time" value={stats.totalExecutions} />
              <Stat label="Queued or running now" value={stats.runningExecutions} />
            </div>
          )}

          {workflows.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              title="No workflows yet"
              description="A workflow runs several steps for one request: research then summarize, classify then branch, or one step per item of a list."
              actionLabel="New workflow"
              actionHref={NEW_WORKFLOW}
            />
          ) : (
            <ul className="space-y-3">
              {workflows.map((workflow) => {
                const stepCount = workflow._count?.steps ?? workflow.steps?.length ?? 0;
                const mode = EXECUTION_MODES.find((m) => m.value === workflow.executionMode);
                const schedules = workflow.scheduleCount ?? 0;
                return (
                  <li key={workflow.id} className="rounded-lg border border-border bg-card p-4">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/dashboard/orchestrations/${workflow.id}`}
                            className="truncate text-base font-semibold text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {workflow.name}
                          </Link>
                          <span
                            className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                            title={mode?.description}
                          >
                            {mode?.label ?? workflow.executionMode}
                          </span>
                          {!workflow.isEnabled && (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                              Disabled
                            </span>
                          )}
                        </div>
                        {workflow.description && (
                          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{workflow.description}</p>
                        )}
                        <dl className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
                          <div>
                            <dt className="sr-only">Steps</dt>
                            <dd>
                              {stepCount} step{stepCount === 1 ? "" : "s"}
                            </dd>
                          </div>
                          <div>
                            <dt className="sr-only">Runs</dt>
                            <dd>
                              {workflow.totalRuns} finished run{workflow.totalRuns === 1 ? "" : "s"}
                              {workflow.totalRuns > 0 &&
                                ` (${workflow.successfulRuns} completed, ${workflow.failedRuns} failed)`}
                            </dd>
                          </div>
                          {workflow.avgDurationMs != null && (
                            <div>
                              <dt className="inline">Average </dt>
                              <dd className="inline font-mono">{formatDuration(workflow.avgDurationMs)}</dd>
                            </div>
                          )}
                          <div>
                            <dt className="sr-only">Schedules</dt>
                            <dd>
                              {schedules === 0 ? "Not scheduled" : `${schedules} schedule${schedules === 1 ? "" : "s"}`}
                            </dd>
                          </div>
                          {workflow.lastExecution && (
                            <div className="flex items-center gap-1.5">
                              <dt>Last run</dt>
                              <dd className="flex items-center gap-1.5">
                                <Link
                                  href={`/dashboard/orchestrations/${workflow.id}?run=${workflow.lastExecution.id}`}
                                  className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  aria-label={`Open the last run, ${workflow.lastExecution.status}`}
                                >
                                  <StatusBadge status={workflow.lastExecution.status} />
                                </Link>
                                {workflow.lastExecution.completedAt && (
                                  <span>{formatRelative(workflow.lastExecution.completedAt)}</span>
                                )}
                              </dd>
                            </div>
                          )}
                        </dl>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setRunTarget(workflow)}
                          disabled={!workflow.isEnabled}
                          title={workflow.isEnabled ? undefined : "Enable the workflow to run it"}
                          className={cn(iconButton, "border-primary/40 text-primary hover:bg-primary/10")}
                        >
                          <Play className="h-4 w-4" aria-hidden="true" />
                          Run
                        </button>
                        <button
                          type="button"
                          onClick={() => openSchedule(workflow)}
                          disabled={openingSchedule === workflow.id}
                          className={iconButton}
                        >
                          <CalendarClock className="h-4 w-4" aria-hidden="true" />
                          Schedule
                        </button>
                        <Link href={`/dashboard/orchestrations/${workflow.id}`} className={iconButton}>
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                          Edit
                        </Link>
                        <span className="flex items-center gap-2 pl-1">
                          <Switch
                            checked={workflow.isEnabled}
                            onCheckedChange={() => toggle(workflow)}
                            aria-label={`${workflow.name} is ${workflow.isEnabled ? "enabled" : "disabled"}`}
                          />
                        </span>
                        <button
                          type="button"
                          onClick={() => remove(workflow)}
                          aria-label={`Delete ${workflow.name}`}
                          className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {runTarget && (
        <RunDialog
          workflow={runTarget}
          onClose={() => setRunTarget(null)}
          onStarted={(executionId) => {
            // The run is queued; its page follows it live.
            router.push(`/dashboard/orchestrations/${runTarget.id}?run=${executionId}`);
          }}
        />
      )}

      {scheduleTarget && (
        <TaskFormDialog
          catalogue={scheduleTarget.catalogue}
          agents={scheduleTarget.agents}
          workflows={workflows.map((w) => ({ id: w.id, name: w.name }))}
          preset={{
            taskType: "workflow_run",
            orchestrationId: scheduleTarget.workflow.id,
            name: `Run ${scheduleTarget.workflow.name}`.slice(0, 80),
          }}
          onClose={() => setScheduleTarget(null)}
          onSaved={() => {
            setScheduleTarget(null);
            load(true);
          }}
        />
      )}
    </div>
  );
}
