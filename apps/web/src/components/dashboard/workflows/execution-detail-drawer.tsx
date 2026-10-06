"use client";

import { useState } from "react";
import Link from "next/link";
import { Ban, ExternalLink } from "lucide-react";
import { toast } from "sonner";

import { getErrorMessage, schedulerApi, type ScheduledTask, type TaskExecution } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDuration, prettyJson } from "./format";
import { StatusBadge } from "./status-badge";

/**
 * One execution of a scheduled task: what it returned, why it failed,
 * and, for a workflow run, the way to the run itself.
 */
export function ExecutionDetailDrawer({
  task,
  execution,
  onClose,
  onChanged,
}: {
  task: Pick<ScheduledTask, "id" | "name" | "taskType" | "orchestrationId">;
  execution: TaskExecution;
  onClose: () => void;
  /** Called after a cancel, so the list behind can reload. */
  onChanged: () => void;
}) {
  const confirmAction = useConfirm();
  const [cancelling, setCancelling] = useState(false);
  const hasOutput = execution.output !== undefined && execution.output !== null;

  async function cancel() {
    const confirmed = await confirmAction({
      title: "Cancel this execution?",
      description:
        "The call in flight is aborted within a few seconds. Work already done, and model output already generated, is not undone.",
      confirmLabel: "Cancel execution",
      cancelLabel: "Keep running",
      destructive: true,
    });
    if (!confirmed) return;
    setCancelling(true);
    try {
      await schedulerApi.cancelExecution(task.id, execution.id);
      toast.success("Cancel requested");
      onChanged();
      onClose();
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not cancel the execution"));
      onChanged();
    } finally {
      setCancelling(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[90vh] max-w-2xl flex-col"
        aria-labelledby="execution-title"
        aria-describedby="execution-description"
      >
        <DialogHeader>
          <DialogTitle id="execution-title">{task.name}</DialogTitle>
          <DialogDescription id="execution-description">
            Execution <span className="font-mono">{execution.id}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex-1 space-y-4 overflow-y-auto pr-1">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Status</dt>
              <dd className="mt-1">
                <StatusBadge status={execution.status} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Started</dt>
              <dd className="mt-1 text-foreground">
                {execution.startedAt ? new Date(execution.startedAt).toLocaleString() : "Not started"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Took</dt>
              <dd className="mt-1 font-mono text-foreground">{formatDuration(execution.durationMs)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Attempt</dt>
              <dd className="mt-1 text-foreground">
                {execution.attempt}
                <span className="ml-1.5 text-muted-foreground">
                  ({execution.triggeredBy === "manual" ? "triggered by hand" : execution.triggeredBy})
                </span>
              </dd>
            </div>
          </dl>

          {execution.orchestrationExecutionId && task.orchestrationId && (
            <Link
              href={`/dashboard/orchestrations/${task.orchestrationId}?run=${execution.orchestrationExecutionId}`}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Open the workflow run
            </Link>
          )}

          {execution.error && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">Error</p>
              <p role="alert" className="mt-1 whitespace-pre-wrap break-words rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                {execution.error}
              </p>
            </div>
          )}

          <div>
            <p className="text-xs font-medium text-muted-foreground">Output</p>
            {hasOutput ? (
              <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 p-3 font-mono text-xs text-foreground">
                {prettyJson(execution.output)}
              </pre>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                {execution.status === "running"
                  ? execution.orchestrationExecutionId
                    ? "The workflow run is still going; its outcome is written here when it ends."
                    : "Still running."
                  : "This execution recorded no output."}
              </p>
            )}
          </div>
        </div>

        {execution.status === "running" && (
          <div className="mt-4 flex justify-end border-t border-border pt-4">
            <Button variant="outline" onClick={cancel} isLoading={cancelling}>
              {!cancelling && <Ban className="mr-1.5 h-4 w-4" aria-hidden="true" />}
              Cancel execution
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
