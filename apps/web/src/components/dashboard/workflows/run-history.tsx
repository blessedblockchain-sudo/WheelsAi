"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Ban, Clock, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import {
  getErrorMessage,
  orchestrationApi,
  type OrchestrationExecution,
  type OrchestrationExecutionDetail,
  type OrchestrationStep,
  type OrchestrationStepResult,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration, formatRelative, prettyJson } from "./format";
import { StatusBadge } from "./status-badge";
import { StepResultCard } from "./step-result-card";
import { usePoll } from "./use-poll";
import { stepLevels } from "./workflow-model";

const ACTIVE = new Set(["queued", "running"]);
export const isActiveRun = (status: string) => ACTIVE.has(status);

const TRIGGER_LABEL: Record<string, string> = {
  manual: "Started by hand",
  api: "Started through the API",
  schedule: "Started by a schedule",
  job: "Started by a marketplace job",
};

function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

/** The stages a run goes through: steps that may run together share one. */
function stagesOf(steps: OrchestrationStep[], mode: string): string[][] {
  const ordered = [...steps].sort((a, b) => a.stepOrder - b.stepOrder);
  const levels = stepLevels(ordered.map((s) => ({ key: s.name, dependsOn: s.dependsOn ?? [] })));
  const byLevel = [...ordered].sort(
    (a, b) => (levels.get(a.name)! - levels.get(b.name)!) || a.stepOrder - b.stepOrder
  );
  if (mode !== "parallel") return byLevel.map((s) => [s.name]);
  const stages: string[][] = [];
  for (const step of byLevel) (stages[levels.get(step.name)!] ??= []).push(step.name);
  return stages.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Run list
// ---------------------------------------------------------------------------

export function RunList({
  workflowId,
  onOpen,
  refreshKey = 0,
}: {
  workflowId: string;
  onOpen: (executionId: string) => void;
  /** Bump to reload, for example after a run was started elsewhere on the page. */
  refreshKey?: number;
}) {
  const { data, error, loading, refresh } = usePoll({
    key: `${workflowId}:${refreshKey}`,
    load: () => orchestrationApi.getExecutions(workflowId, { limit: 50 }),
    shouldContinue: (value) => value.executions.some((e) => isActiveRun(e.status)),
    intervalMs: 3000,
  });

  if (loading && !data) {
    return (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
        <span className="sr-only">Loading runs</span>
      </div>
    );
  }
  if (!data) return <ErrorState title="Couldn't load runs" error={error} onRetry={refresh} />;
  if (data.executions.length === 0) {
    return (
      <EmptyState
        icon={Clock}
        title="No runs yet"
        description="Start a run with the Run button, call the API, or put this workflow on a schedule."
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {data.total} run{data.total === 1 ? "" : "s"}
          {data.total > data.executions.length ? `, showing the latest ${data.executions.length}` : ""}
        </p>
        <button
          type="button"
          onClick={refresh}
          aria-label="Refresh runs"
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {data.executions.map((run) => (
          <li key={run.id}>
            <RunRow run={run} onOpen={() => onOpen(run.id)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunRow({ run, onOpen }: { run: OrchestrationExecution; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <StatusBadge status={run.status} />
      <span className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}</span>
      <span className="text-sm text-foreground">{TRIGGER_LABEL[run.triggeredBy] ?? run.triggeredBy}</span>
      {run.error && <span className="min-w-0 flex-1 truncate text-sm text-danger">{run.error}</span>}
      <span className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
        <span className="font-mono">{formatDuration(run.durationMs)}</span>
        <span>{formatRelative(run.startedAt ?? run.createdAt)}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// One run, live
// ---------------------------------------------------------------------------

export function RunView({
  workflowId,
  executionId,
  steps,
  executionMode,
  resourceNames,
  onBack,
}: {
  workflowId: string;
  executionId: string;
  /** The workflow's current steps, to lay results out by stage. */
  steps: OrchestrationStep[];
  executionMode: string;
  resourceNames: Record<string, string>;
  onBack: () => void;
}) {
  const confirmAction = useConfirm();
  const [cancelling, setCancelling] = useState(false);
  const { data: run, error, loading, refresh } = usePoll<OrchestrationExecutionDetail>({
    key: `${workflowId}/${executionId}`,
    load: () => orchestrationApi.getExecution(workflowId, executionId),
    shouldContinue: (value) => isActiveRun(value.status),
  });

  async function cancel() {
    const confirmed = await confirmAction({
      title: "Cancel this run?",
      description:
        "Steps that have not started will not run. A call already in flight is aborted, but the model provider may still bill what it had generated.",
      confirmLabel: "Cancel run",
      cancelLabel: "Keep running",
      destructive: true,
    });
    if (!confirmed) return;
    setCancelling(true);
    try {
      const { execution } = await orchestrationApi.cancelExecution(workflowId, executionId);
      toast.success(
        execution.status === "cancelled" ? "Run cancelled" : "Cancel requested; the run stops within a few seconds"
      );
      refresh();
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not cancel the run"));
      refresh();
    } finally {
      setCancelling(false);
    }
  }

  const back = (
    <button
      type="button"
      onClick={onBack}
      className="inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      All runs
    </button>
  );

  if (loading && !run) {
    return (
      <div className="space-y-4" aria-busy="true">
        {back}
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <span className="sr-only">Loading run</span>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="space-y-4">
        {back}
        <ErrorState title="Couldn't load this run" error={error} onRetry={refresh} />
      </div>
    );
  }

  const active = isActiveRun(run.status);
  const cancelRequested = run.status === "running" && Boolean(run.cancelRequestedAt);
  const resultsByStep = new Map<string, OrchestrationStepResult[]>();
  for (const result of run.stepResults) {
    const list = resultsByStep.get(result.stepName) ?? [];
    list.push(result);
    resultsByStep.set(result.stepName, list);
  }
  // Loop items finish in any order; show them in the order of the list.
  for (const list of resultsByStep.values()) {
    list.sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0));
  }
  const stages = stagesOf(steps, executionMode);
  const known = new Set(stages.flat());
  // Results of steps the workflow no longer has (it was edited after this run).
  const orphaned = run.stepResults.filter((r) => !known.has(r.stepName));

  return (
    <div className="space-y-4">
      {back}

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={run.status} />
          <span className="font-mono text-xs text-muted-foreground">{run.id}</span>
          <span className="text-sm text-muted-foreground">{TRIGGER_LABEL[run.triggeredBy] ?? run.triggeredBy}</span>
          <span className="ml-auto flex items-center gap-2">
            {active && (
              <Button variant="outline" size="sm" onClick={cancel} disabled={cancelling || cancelRequested}>
                <Ban className="mr-1.5 h-4 w-4" aria-hidden="true" />
                {cancelRequested ? "Stopping" : "Cancel run"}
              </Button>
            )}
          </span>
        </div>

        <div
          className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={run.progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Run progress"
        >
          <div
            className={`h-full rounded-full ${run.status === "failed" ? "bg-danger" : "bg-primary"} ${active ? "animate-pulse" : ""}`}
            style={{ width: `${Math.max(run.progress, active ? 4 : 0)}%` }}
          />
        </div>

        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <div>
            <dt className="inline">Queued </dt>
            <dd className="inline text-foreground">{new Date(run.createdAt).toLocaleString()}</dd>
          </div>
          {run.startedAt && (
            <div>
              <dt className="inline">Started </dt>
              <dd className="inline text-foreground">{new Date(run.startedAt).toLocaleString()}</dd>
            </div>
          )}
          {run.durationMs != null && (
            <div>
              <dt className="inline">Took </dt>
              <dd className="inline font-mono text-foreground">{formatDuration(run.durationMs)}</dd>
            </div>
          )}
          {run.scheduledTaskId && (
            <div>
              <Link href="/dashboard/scheduler" className="text-primary hover:underline">
                View the schedule
              </Link>
            </div>
          )}
        </dl>

        {run.status === "queued" && (
          <p className="mt-3 text-sm text-muted-foreground">Queued. The run starts shortly.</p>
        )}
        {cancelRequested && (
          <p className="mt-3 text-sm text-muted-foreground">
            Cancel requested. The run stops before its next step and aborts the call in flight.
          </p>
        )}
        {run.error && (
          <p role="alert" className="mt-3 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
            {run.error}
          </p>
        )}
        {/* A poll that failed after the first load: say so, keep what we have. */}
        {error !== null && (
          <p className="mt-3 text-xs text-muted-foreground">
            Could not refresh just now ({getErrorMessage(error, "request failed")}); showing the last state received.
          </p>
        )}
      </div>

      <div className="space-y-3">
        {stages.map((names, index) => (
          <div key={names.join("|")} className="space-y-2">
            {executionMode === "parallel" && (
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Stage {index + 1}
                {names.length > 1 ? ` · ${names.length} steps run together` : ""}
              </p>
            )}
            {names.map((name) => {
              const results = resultsByStep.get(name) ?? [];
              if (results.length === 0) {
                return (
                  <div
                    key={name}
                    className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{name}</span>
                    <span className="text-xs text-muted-foreground">
                      {active ? "Not finished yet" : "Did not run"}
                    </span>
                  </div>
                );
              }
              return results.map((result) => (
                <StepResultCard
                  key={result.id}
                  result={result}
                  resourceName={resourceNames[result.agentId ?? result.resourceId ?? ""]}
                  defaultOpen={result.status === "failed"}
                />
              ));
            })}
          </div>
        ))}
        {orphaned.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Steps the workflow no longer has
            </p>
            {orphaned.map((result) => (
              <StepResultCard
                key={result.id}
                result={result}
                resourceName={resourceNames[result.agentId ?? result.resourceId ?? ""]}
              />
            ))}
          </div>
        )}
      </div>

      {(run.input !== undefined && run.input !== null) || (run.output !== undefined && run.output !== null) ? (
        <details className="rounded-lg border border-border bg-card p-4">
          <summary className="cursor-pointer text-sm font-medium text-foreground">Run input and final output</summary>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Input</p>
              <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 p-3 font-mono text-xs text-foreground">
                {prettyJson(run.input ?? {})}
              </pre>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Output</p>
              <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 p-3 font-mono text-xs text-foreground">
                {run.output === undefined || run.output === null ? "None" : prettyJson(run.output)}
              </pre>
              {isEmptyObject(run.output) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  No step publishes into the run&apos;s output. Each step&apos;s own output is listed above; to give
                  the run a final output, add an output mapping to a step (under Advanced mappings).
                </p>
              )}
            </div>
          </div>
        </details>
      ) : null}
    </div>
  );
}
