import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A single metric: label, a monospace tabular value, optional delta and hint.
 *
 *   <Stat label="Revenue (30d)" value={formatCurrency(cents)} delta={12.4} />
 *   <Stat label="Cost / 1k req" value="$0.42" delta={-3} invertDelta />
 *
 * Delta colouring uses the success/danger tokens — the only place green/red
 * appear. By default up = good; pass `invertDelta` for metrics where down is
 * good (cost, latency, error rate). Zero renders neutral.
 */
export interface StatProps extends React.HTMLAttributes<HTMLDListElement> {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Signed change; rendered with an explicit +/- sign. */
  delta?: number | null;
  /** Appended to the delta magnitude. Default "%". */
  deltaSuffix?: string;
  /** Custom magnitude formatter (receives the absolute value). */
  formatDelta?: (magnitude: number) => string;
  /** Treat a negative delta as good (cost, latency, error rate). */
  invertDelta?: boolean;
  /** Secondary text under the value (e.g. "vs. previous 30 days"). */
  hint?: React.ReactNode;
  size?: "sm" | "md" | "lg";
}

const valueSize = {
  sm: "text-lg",
  md: "text-2xl",
  lg: "text-3xl",
} as const;

function defaultFormat(magnitude: number) {
  return magnitude.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const Stat = React.forwardRef<HTMLDListElement, StatProps>(
  (
    {
      label,
      value,
      delta,
      deltaSuffix = "%",
      formatDelta = defaultFormat,
      invertDelta = false,
      hint,
      size = "md",
      className,
      ...props
    },
    ref
  ) => {
    const hasDelta = typeof delta === "number" && Number.isFinite(delta);
    let deltaNode: React.ReactNode = null;

    if (hasDelta) {
      const d = delta as number;
      const sign = d > 0 ? "+" : d < 0 ? "-" : "";
      const good = invertDelta ? d < 0 : d > 0;
      const tone =
        d === 0 ? "text-muted-foreground" : good ? "text-success" : "text-danger";
      deltaNode = (
        <span className={cn("font-mono text-sm tabular-nums", tone)}>
          {sign}
          {formatDelta(Math.abs(d))}
          {deltaSuffix}
        </span>
      );
    }

    return (
      <dl ref={ref} className={cn("min-w-0", className)} {...props}>
        <dt className="truncate text-sm text-muted-foreground">{label}</dt>
        <dd className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <span
            className={cn(
              "font-mono font-semibold tabular-nums tracking-tight text-foreground",
              valueSize[size]
            )}
          >
            {value}
          </span>
          {deltaNode}
        </dd>
        {hint && <dd className="mt-1 text-xs text-muted-foreground">{hint}</dd>}
      </dl>
    );
  }
);
Stat.displayName = "Stat";

export { Stat };
