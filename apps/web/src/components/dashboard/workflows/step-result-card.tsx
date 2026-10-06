"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import type { OrchestrationStepResult } from "@/lib/api";
import { formatDuration, prettyJson } from "./format";
import { StatusBadge } from "./status-badge";

function Block({ label, children }: { label: string; children: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 p-3 font-mono text-xs text-foreground">
        {children}
      </pre>
    </div>
  );
}

/**
 * One recorded step result: a loop writes one per item or pass, and every
 * attempt's final outcome is what is stored. Collapsed it is a single
 * line; open it shows exactly what the step was sent and what it
 * returned.
 */
export function StepResultCard({
  result,
  resourceName,
  defaultOpen = false,
}: {
  result: OrchestrationStepResult;
  /** The agent, deployment or knowledge base the step used, by name. */
  resourceName?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { prompt, missingRefs, ...otherInput } = result.input ?? {};
  const hasOtherInput = Object.keys(otherInput).length > 0;
  const output = result.output;
  const structured = output?.value !== undefined;

  return (
    <div className="rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {result.stepName}
          {result.iteration !== null && (
            <span className="ml-1.5 font-normal text-muted-foreground">
              {result.input && "item" in result.input ? `item ${result.iteration + 1}` : `pass ${result.iteration}`}
            </span>
          )}
        </span>
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
          {result.stepType}
          {resourceName ? ` · ${resourceName}` : ""}
        </span>
        {result.attempt > 1 && (
          <span className="shrink-0 text-xs text-muted-foreground">attempt {result.attempt}</span>
        )}
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatDuration(result.durationMs)}</span>
        <StatusBadge status={result.status} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
          {result.error && (
            <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
              {result.error}
            </p>
          )}
          {Array.isArray(missingRefs) && missingRefs.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Read as empty because the step did not run or produced nothing:{" "}
              <span className="font-mono">{missingRefs.join(", ")}</span>
            </p>
          )}
          {typeof prompt === "string" && prompt !== "" && (
            <Block label={result.stepType === "retrieval" ? "Search query" : "Prompt sent"}>{prompt}</Block>
          )}
          {hasOtherInput && <Block label="Other input">{prettyJson(otherInput)}</Block>}
          {output && (
            <Block label={structured ? "Output (JSON)" : "Output"}>
              {structured ? prettyJson(output.value) : (output.content ?? "")}
            </Block>
          )}
          {output?.truncated && (
            <p className="text-xs text-muted-foreground">
              The stored output was cut at 100,000 characters. Later steps received the full value.
            </p>
          )}
          {!output && !result.error && result.status !== "skipped" && (
            <p className="text-xs text-muted-foreground">This step produced no output.</p>
          )}
        </div>
      )}
    </div>
  );
}
