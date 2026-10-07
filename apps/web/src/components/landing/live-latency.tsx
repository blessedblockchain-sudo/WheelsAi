"use client";

import Link from "next/link";
import { formatLatencyCaption } from "@wheelsai/shared/latency";

import { landingLatencyValue, latencyLineInput, usePublicStats } from "@/lib/publicStats";

/**
 * The landing page's latency, read live from GET /api/public/stats. It has
 * three states and no fallback number:
 *   measured     the p50 the API measured, with what it measures
 *   measuring    not enough traffic yet to publish a figure; no number
 *   unavailable  the figure could not be read; no number
 * The text is the shared formatter's, the same the CLI prints, except that
 * the measuring state leaves out the running request count (lib/publicStats.ts).
 */

/** The value after "Latency:" in the terminal mock. */
export function LiveLatencyValue() {
  const input = latencyLineInput(usePublicStats());
  const status = input === "loading" ? "loading" : (input?.status ?? "unavailable");
  return <span data-latency-status={status}>{landingLatencyValue(input)}</span>;
}

/** Under the terminal: what the value is, or why there is none, and how it is measured. */
export function LiveLatencyCaption() {
  const input = latencyLineInput(usePublicStats());
  return (
    <p className="mt-3 text-xs text-navy-200/50" aria-live="polite">
      <span className="font-medium text-navy-200/70">Latency:</span> {formatLatencyCaption(input)}{" "}
      <Link
        href="/status#latency"
        className="text-navy-400 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-400 rounded-sm"
      >
        How it is measured
      </Link>
    </p>
  );
}
