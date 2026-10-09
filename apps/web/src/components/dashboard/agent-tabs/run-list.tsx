"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { History, Send } from "lucide-react";
import { toast } from "sonner";

import { TONE_CLASS } from "@/components/dashboard/workflows/format";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { ResultView } from "@/components/ui/result-view";
import { Skeleton } from "@/components/ui/skeleton";
import { agentsApi, getErrorMessage, type RunView } from "@/lib/api";
import { appendRuns, mergeLatestRuns, resultPreview, runInRefusal, withRun } from "@/lib/agent-page";
import {
  latestDelivery,
  deliveryLine,
  runDelivery,
  runFailureLine,
  runStatusLabel,
  runStatusTone,
  runWhenLine,
  startedByLabel,
  type RunPlace,
} from "@/lib/agent-runs";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;
/** How often the list is read again while a run is still going. */
const RUNNING_REFRESH_MS = 4000;

export interface RunListProps {
  agentId: string;
  /** Where the schedule sends results now; null when they stay on the page. */
  place: RunPlace | null;
  /** The zone run times are written in: the schedule's own. Left out, the viewer's. */
  timeZone?: string;
  /** A run started with Run now: it goes to the top of the list. */
  started?: RunView | null;
}

function RunResult({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = resultPreview(text);
  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <ResultView text={open || !preview.cut ? text : preview.text} copy={open || !preview.cut} />
      {preview.cut && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="mt-2 rounded text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

/**
 * A self-running agent's runs, newest first: what each one's state is, who
 * started it and when, what it produced, why it did not finish, and how
 * sending its result went.
 */
export function RunList({ agentId, place, timeZone, started }: RunListProps) {
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sending, setSending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const page = await agentsApi.listRuns(agentId, { limit: PAGE_SIZE });
      setRuns(page.runs);
      setHasMore(page.hasMore);
    } catch (err) {
      setError(err);
    }
  }, [agentId]);

  useEffect(() => {
    setRuns(null);
    void load();
  }, [load]);

  // A run started by hand shows at once, before the list is read again.
  useEffect(() => {
    if (started) setRuns((current) => (current ? withRun(current, started) : current));
  }, [started]);

  // While a run is going, the newest page is read again so it turns into its result by itself.
  const anyRunning = runs?.some((run) => run.status === "running") ?? false;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setTimeout(async () => {
      try {
        const page = await agentsApi.listRuns(agentId, { limit: PAGE_SIZE });
        if (alive.current) setRuns((current) => (current ? mergeLatestRuns(current, page.runs) : page.runs));
      } catch {
        // The next change of the list tries again; the runs already shown stay.
      }
    }, RUNNING_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [anyRunning, runs, agentId]);

  async function showMore() {
    if (!runs || runs.length === 0 || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await agentsApi.listRuns(agentId, { limit: PAGE_SIZE, before: runs[runs.length - 1]!.id });
      setRuns((current) => appendRuns(current ?? [], page.runs));
      setHasMore(page.hasMore);
    } catch (err) {
      toast.error(getErrorMessage(err, "More runs could not be loaded. Try again."));
    } finally {
      setLoadingMore(false);
    }
  }

  async function sendAgain(run: RunView) {
    if (sending) return;
    setSending(run.id);
    try {
      const { run: sent } = await agentsApi.resendRun(agentId, run.id);
      setRuns((current) => (current ? withRun(current, sent) : current));
      const record = latestDelivery(sent);
      toast.success(record ? deliveryLine(record) : "Sent.");
    } catch (err) {
      // A place that did not take it: the answer carries the run with its new record.
      const carried = runInRefusal<RunView>(err);
      if (carried) setRuns((current) => (current ? withRun(current, carried) : current));
      toast.error(getErrorMessage(err, "The result could not be sent. Try again."));
    } finally {
      setSending(null);
    }
  }

  if (error && !runs) {
    return <ErrorState title="Couldn't load this agent's runs" error={error} onRetry={load} />;
  }

  if (!runs) {
    return (
      <div className="space-y-3" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-3 rounded-lg border bg-card p-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-4 w-56 max-w-full" />
            </div>
            <Skeleton className="h-16 w-full" />
          </div>
        ))}
        <span className="sr-only">Loading runs</span>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="No runs yet."
        description="Each run shows here with what it produced."
      />
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-3">
        {runs.map((run) => {
          const failure = runFailureLine(run);
          const delivery = runDelivery(run, place);
          return (
            <li key={run.id} className="min-w-0 space-y-3 rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
                    TONE_CLASS[runStatusTone(run.status)],
                  )}
                >
                  {runStatusLabel(run.status)}
                </span>
                <span className="text-sm text-foreground">{startedByLabel(run.startedBy)}</span>
                <span className="min-w-0 text-sm text-muted-foreground">{runWhenLine(run, { timeZone })}</span>
              </div>

              {run.text !== null && run.text !== "" && <RunResult text={run.text} />}

              {failure && <p className="text-sm text-danger">{failure}</p>}

              {(delivery.line || delivery.sendAgain) && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {delivery.line ? (
                    <p className={cn("min-w-0 text-sm", delivery.sent ? "text-muted-foreground" : "text-foreground")}>
                      {delivery.line}
                    </p>
                  ) : (
                    <span />
                  )}
                  {delivery.sendAgain && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => sendAgain(run)}
                      isLoading={sending === run.id}
                      disabled={sending !== null && sending !== run.id}
                    >
                      <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                      Send again
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {hasMore && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" onClick={showMore} isLoading={loadingMore}>
            Show more
          </Button>
        </div>
      )}
    </div>
  );
}
