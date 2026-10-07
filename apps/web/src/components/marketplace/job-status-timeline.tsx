import { Check, Circle, Loader2, X } from "lucide-react";

import type { Job } from "@/lib/api";
import { jobTimeline, type TimelineStep } from "@/lib/jobs";
import { cn } from "@/lib/utils";

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const MARKER: Record<TimelineStep["state"], string> = {
  done: "border-success bg-success/10 text-success",
  current: "border-primary bg-primary/10 text-primary",
  pending: "border-border bg-muted text-muted-foreground",
  failed: "border-danger bg-danger/10 text-danger",
};

function Marker({ state }: { state: TimelineStep["state"] }) {
  const Icon = state === "done" ? Check : state === "current" ? Loader2 : state === "failed" ? X : Circle;
  return (
    <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full border", MARKER[state])}>
      <Icon className={cn("h-3.5 w-3.5", state === "current" && "animate-spin")} aria-hidden />
    </span>
  );
}

/**
 * The steps a job has been through and the ones still ahead: paid into
 * escrow, the product running, the deliverable submitted, and how it ended.
 */
export function JobStatusTimeline({ job }: { job: Job }) {
  const steps = jobTimeline(job);
  return (
    <ol className="space-y-0" aria-label="Job progress">
      {steps.map((step, index) => (
        <li key={step.key} className="flex gap-3" aria-current={step.state === "current" ? "step" : undefined}>
          <div className="flex flex-col items-center">
            <Marker state={step.state} />
            {index < steps.length - 1 && <span className="my-1 w-px flex-1 bg-border" aria-hidden />}
          </div>
          <div className={cn("min-w-0 pb-5", index === steps.length - 1 && "pb-0")}>
            <p
              className={cn(
                "text-sm font-medium",
                step.state === "pending" ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {step.label}
              <span className="sr-only">
                {step.state === "pending" ? " (not yet)" : step.state === "current" ? " (now)" : ""}
              </span>
            </p>
            {step.at && <p className="text-xs text-muted-foreground">{formatWhen(step.at)}</p>}
            {step.until && (
              <p className="text-xs text-muted-foreground">
                {step.until.label} {formatWhen(step.until.at)}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
