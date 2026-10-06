"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { CalendarClock, Pause, Pencil, Play, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";

import {
  agentsApi,
  getErrorMessage,
  orchestrationApi,
  schedulerApi,
  type Agent,
  type OrchestrationDetail,
  type ScheduledTask,
  type TaskTypeCatalogue,
  type WorkflowScheduleSummary,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatRelative, formatSchedule } from "@/components/dashboard/workflows/format";
import { RunDialog } from "@/components/dashboard/workflows/run-dialog";
import { RunList, RunView } from "@/components/dashboard/workflows/run-history";
import { StatusBadge } from "@/components/dashboard/workflows/status-badge";
import { TaskFormDialog } from "@/components/dashboard/workflows/task-form-dialog";
import { WorkflowApiTab } from "@/components/dashboard/workflows/workflow-api-tab";
import {
  resourceNameMap,
  useWorkflowResources,
} from "@/components/dashboard/workflows/use-workflow-resources";
import { WorkflowEditor } from "@/components/dashboard/workflows/workflow-editor";

const LIST = "/dashboard/orchestrations";
type TabId = "editor" | "runs" | "schedules" | "api";
const TABS: TabId[] = ["editor", "runs", "schedules", "api"];

export default function WorkflowPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <WorkflowContent />
    </Suspense>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6 p-6" aria-busy="true">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-10 w-80" />
      <Skeleton className="h-[34rem] w-full" />
      <span className="sr-only">Loading workflow</span>
    </div>
  );
}

function WorkflowContent() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const confirmAction = useConfirm();
  const { resources, error: resourcesError, reload: reloadResources } = useWorkflowResources();

  const [workflow, setWorkflow] = useState<OrchestrationDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  // Remounts the editor from the stored workflow (after a stale save).
  const [editorVersion, setEditorVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [showRun, setShowRun] = useState(false);
  const [runsVersion, setRunsVersion] = useState(0);

  const runId = searchParams.get("run");
  const requestedTab = searchParams.get("tab") as TabId | null;
  const tab: TabId = runId ? "runs" : requestedTab && TABS.includes(requestedTab) ? requestedTab : "editor";

  const load = useCallback(async () => {
    try {
      setWorkflow(await orchestrationApi.get(id));
      setLoadError(null);
      return true;
    } catch (error) {
      setLoadError(error);
      return false;
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  function go(next: { tab?: TabId; run?: string | null }) {
    const params = new URLSearchParams();
    const nextTab = next.tab ?? tab;
    if (nextTab !== "editor") params.set("tab", nextTab);
    if (next.run) params.set("run", next.run);
    const query = params.toString();
    router.replace(`${LIST}/${id}${query ? `?${query}` : ""}`, { scroll: false });
  }

  async function leave() {
    if (
      dirty &&
      !(await confirmAction({
        title: "Leave with unsaved changes?",
        description: "Your changes to this workflow have not been saved.",
        confirmLabel: "Leave",
        cancelLabel: "Keep editing",
        destructive: true,
      }))
    ) {
      return;
    }
    router.push(LIST);
  }

  async function toggleEnabled() {
    if (!workflow) return;
    try {
      const updated = await orchestrationApi.update(workflow.id, { isEnabled: !workflow.isEnabled });
      // `updatedAt` moved with the flag, and it is the editor's lock token:
      // it has to follow, or the next save of the open draft would look stale.
      setWorkflow((w) => (w ? { ...w, isEnabled: updated.isEnabled, updatedAt: updated.updatedAt } : w));
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not change the workflow"));
    }
  }

  async function remove() {
    if (!workflow) return;
    const confirmed = await confirmAction({
      title: `Delete "${workflow.name}"?`,
      description: `Its steps and run history are deleted${
        workflow.schedules.length > 0 ? `, along with the ${workflow.schedules.length} schedule(s) that run it` : ""
      }. Runs in progress are cancelled. This cannot be undone.`,
      confirmLabel: "Delete workflow",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await orchestrationApi.delete(workflow.id);
      toast.success("Workflow deleted");
      router.push(LIST);
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not delete the workflow"));
    }
  }

  if (loadError !== null && !workflow) {
    return (
      <div className="p-6">
        <ErrorState
          title="Couldn't load this workflow"
          error={loadError}
          onRetry={load}
          actionLabel="All workflows"
          actionHref={LIST}
        />
      </div>
    );
  }
  if (!workflow) return <PageSkeleton />;

  return (
    <div className="space-y-4 p-6">
      <PageHeader
        title={workflow.name}
        description={
          <>
            {workflow.description && <span className="block">{workflow.description}</span>}
            <span className="block">
              Model id <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{workflow.openaiModel}</code>
            </span>
          </>
        }
        breadcrumbs={[
          {
            label: (
              <button type="button" onClick={leave} className="hover:text-foreground">
                Workflows
              </button>
            ),
          },
          { label: workflow.name },
        ]}
        actions={
          <>
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch
                checked={workflow.isEnabled}
                onCheckedChange={toggleEnabled}
                aria-label={`Workflow is ${workflow.isEnabled ? "enabled" : "disabled"}`}
              />
              {workflow.isEnabled ? "Enabled" : "Disabled"}
            </span>
            <Button
              onClick={() => setShowRun(true)}
              disabled={!workflow.isEnabled || dirty}
              title={
                !workflow.isEnabled
                  ? "Enable the workflow to run it"
                  : dirty
                    ? "Save your changes first; a run uses the saved workflow"
                    : undefined
              }
            >
              <Play className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Run
            </Button>
            <Button variant="ghost" size="icon" onClick={remove} aria-label="Delete workflow">
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        }
      />

      <Tabs value={tab} onValueChange={(value) => go({ tab: value as TabId, run: null })}>
        <TabsList aria-label="Workflow sections">
          <TabsTrigger value="editor">
            Editor
            {dirty && <span className="text-xs font-normal text-muted-foreground">(unsaved)</span>}
          </TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="schedules">
            Schedules
            {workflow.schedules.length > 0 && (
              <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                {workflow.schedules.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="api">API</TabsTrigger>
        </TabsList>

        {/* Kept mounted so unsaved edits survive a look at the runs. */}
        <TabsContent value="editor" forceMount>
          {resourcesError !== null ? (
            <ErrorState
              title="Couldn't load your agents, deployments and knowledge bases"
              error={resourcesError}
              onRetry={reloadResources}
            />
          ) : resources === null ? (
            <Skeleton className="h-[34rem] w-full" />
          ) : (
            <WorkflowEditor
              key={editorVersion}
              workflow={workflow}
              resources={resources}
              onDirtyChange={setDirty}
              onSaved={(saved) => setWorkflow((w) => (w ? { ...w, ...saved } : w))}
              onReload={async () => {
                if (await load()) setEditorVersion((v) => v + 1);
              }}
            />
          )}
        </TabsContent>

        <TabsContent value="runs">
          {runId ? (
            <RunView
              workflowId={workflow.id}
              executionId={runId}
              steps={workflow.steps}
              executionMode={workflow.executionMode}
              resourceNames={resourceNameMap(resources)}
              onBack={() => {
                setRunsVersion((v) => v + 1);
                go({ tab: "runs", run: null });
              }}
            />
          ) : (
            <RunList workflowId={workflow.id} refreshKey={runsVersion} onOpen={(run) => go({ tab: "runs", run })} />
          )}
        </TabsContent>

        <TabsContent value="schedules">
          <SchedulesTab
            workflow={workflow}
            onChanged={load}
            onOpenRun={(run) => go({ tab: "runs", run })}
          />
        </TabsContent>

        <TabsContent value="api">
          <WorkflowApiTab workflow={workflow} />
        </TabsContent>
      </Tabs>

      {showRun && (
        <RunDialog
          workflow={workflow}
          onClose={() => setShowRun(false)}
          onStarted={(executionId) => {
            setShowRun(false);
            go({ tab: "runs", run: executionId });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

function SchedulesTab({
  workflow,
  onChanged,
  onOpenRun,
}: {
  workflow: OrchestrationDetail;
  onChanged: () => void;
  onOpenRun: (executionId: string) => void;
}) {
  const confirmAction = useConfirm();
  const [catalogue, setCatalogue] = useState<TaskTypeCatalogue | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [catalogueError, setCatalogueError] = useState<unknown>(null);
  const [form, setForm] = useState<{ task?: ScheduledTask } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadCatalogue = useCallback(async () => {
    try {
      const [types, agentsRes] = await Promise.all([schedulerApi.taskTypes(), agentsApi.list()]);
      setCatalogue(types);
      setAgents(agentsRes.agents);
      setCatalogueError(null);
    } catch (error) {
      setCatalogueError(error);
    }
  }, []);

  useEffect(() => {
    loadCatalogue();
  }, [loadCatalogue]);

  const workflowRun = catalogue?.taskTypes.find((t) => t.type === "workflow_run");

  async function act(schedule: WorkflowScheduleSummary, action: () => Promise<void>) {
    setBusy(schedule.id);
    try {
      await action();
    } catch (error) {
      toast.error(getErrorMessage(error, "That did not work"));
    } finally {
      setBusy(null);
    }
  }

  const trigger = (schedule: WorkflowScheduleSummary) =>
    act(schedule, async () => {
      const execution = await schedulerApi.trigger(schedule.id);
      if (execution.orchestrationExecutionId) onOpenRun(execution.orchestrationExecutionId);
      else if (execution.status === "failed") toast.error(execution.error ?? "The run could not be started");
      onChanged();
    });

  const toggle = (schedule: WorkflowScheduleSummary) =>
    act(schedule, async () => {
      await schedulerApi.toggle(schedule.id, !schedule.isEnabled);
      onChanged();
    });

  const edit = (schedule: WorkflowScheduleSummary) =>
    act(schedule, async () => {
      setForm({ task: await schedulerApi.get(schedule.id) });
    });

  const remove = (schedule: WorkflowScheduleSummary) =>
    act(schedule, async () => {
      if (!(await confirmAction({ title: `Delete the schedule "${schedule.name}"?`, destructive: true }))) return;
      await schedulerApi.delete(schedule.id);
      onChanged();
    });

  if (catalogueError !== null) {
    return <ErrorState title="Couldn't load scheduling" error={catalogueError} onRetry={loadCatalogue} />;
  }
  if (!catalogue) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="space-y-4">
      {!catalogue.schedulerEnabled && (
        <p role="status" className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground">
          Scheduling is switched off on this server. Schedules can be saved and triggered by hand, but none fires on
          its own, so the next-run times below will not be acted on.
        </p>
      )}
      {workflowRun && !workflowRun.available && (
        <p role="status" className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground">
          Workflows cannot be scheduled on this server: {workflowRun.reason}
        </p>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Each schedule starts a run of this workflow with its own prompt and input.
        </p>
        <Button variant="outline" onClick={() => setForm({})} disabled={workflowRun ? !workflowRun.available : false}>
          <CalendarClock className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Add a schedule
        </Button>
      </div>

      {workflow.schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Not scheduled"
          description="Add a schedule to run this workflow on a cron expression, at a fixed interval, or once at a set time."
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {workflow.schedules.map((schedule) => (
            <li key={schedule.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{schedule.name}</p>
                <p className="text-xs text-muted-foreground">
                  <span className="font-mono">{formatSchedule(schedule)}</span>
                  {schedule.scheduleType !== "interval" && ` (${schedule.timezone})`}
                </p>
              </div>
              <StatusBadge status={schedule.isEnabled ? schedule.status : "paused"} />
              <span className="text-xs text-muted-foreground">
                Next: {schedule.isEnabled ? formatRelative(schedule.nextRunAt, "none") : "paused"}
              </span>
              <span className="text-xs text-muted-foreground">
                Last: {formatRelative(schedule.lastRunAt)}
                {schedule.lastRunStatus ? ` (${schedule.lastRunStatus})` : ""}
              </span>
              <span className="flex items-center gap-1">
                <RowButton label={`Run "${schedule.name}" now`} disabled={busy === schedule.id} onClick={() => trigger(schedule)}>
                  <Zap className="h-4 w-4" />
                </RowButton>
                <RowButton
                  label={schedule.isEnabled ? `Pause "${schedule.name}"` : `Resume "${schedule.name}"`}
                  disabled={busy === schedule.id}
                  onClick={() => toggle(schedule)}
                >
                  {schedule.isEnabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </RowButton>
                <RowButton label={`Edit "${schedule.name}"`} disabled={busy === schedule.id} onClick={() => edit(schedule)}>
                  <Pencil className="h-4 w-4" />
                </RowButton>
                <RowButton label={`Delete "${schedule.name}"`} disabled={busy === schedule.id} onClick={() => remove(schedule)}>
                  <Trash2 className="h-4 w-4" />
                </RowButton>
              </span>
            </li>
          ))}
        </ul>
      )}

      {form && (
        <TaskFormDialog
          catalogue={catalogue}
          agents={agents}
          workflows={[{ id: workflow.id, name: workflow.name }]}
          task={form.task}
          preset={{
            taskType: "workflow_run",
            orchestrationId: workflow.id,
            name: `Run ${workflow.name}`.slice(0, 80),
          }}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function RowButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      {children}
    </button>
  );
}
