"use client";

import { formatLatencyMs } from "@wheelsai/shared/latency";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Activity, AlertTriangle, CheckCircle2, RotateCw, XCircle } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { API_BASE_URL } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Live view of GET /api/status. Rule: every figure shown here is one the API
 * returned; absent data is rendered as "no data", never as a number. The
 * only thing this component decides on its own is whether the API answered
 * at all, which it reports as such.
 */

const POLL_MS = 30_000;

type ComponentStatus = "operational" | "outage";
type WorkerStatus = "operational" | "delayed" | "failing" | "no_data";
type MonitorStatus = "operational" | "degraded" | "outage" | "no_data";
type OverallStatus = "operational" | "degraded" | "major_outage";

interface StatusPayload {
  status: OverallStatus;
  generatedAt: string;
  components: Array<{ id: string; name: string; status: ComponentStatus; latencyMs: number | null }>;
  workers: {
    available: boolean;
    items: Array<{
      id: string;
      name: string;
      description: string;
      intervalSeconds: number;
      status: WorkerStatus;
      lastCompletedAt: string | null;
      lastFailedAt: string | null;
    }>;
  };
  monitors: {
    configured: boolean;
    available: boolean;
    historyDays: number;
    items: Array<{
      name: string;
      status: MonitorStatus;
      lastCheckAt: string | null;
      uptimePercent: { "24h": number | null; "7d": number | null; "30d": number | null };
      avgLatencyMs: number | null;
      days: Array<{ date: string; checks: number; uptimePercent: number | null }>;
    }>;
  };
  /** Absent from an API that predates the measurement. */
  latency?: LatencyPayload;
}

/** GET /api/status `latency`: the same figure GET /api/public/stats states. */
interface LatencyPayload {
  status: "measured" | "insufficient_data" | "unavailable";
  definition: string;
  windowHours: number;
  sampleCount: number | null;
  minSampleCount: number;
  minOrgCount: number;
  /** Absent from an API that predates the per-organization cap. */
  maxSamplesPerOrg?: number;
  p50Ms: number | null;
  p95Ms: number | null;
  firstTokenP50Ms: number | null;
  firstTokenSampleCount: number | null;
  computedAt: string | null;
  histogram: Array<{ upToMs: number | null; count: number }> | null;
  errorSharePercent: number | null;
}

type Tone = "ok" | "warn" | "bad" | "none";

const toneClasses: Record<Tone, string> = {
  ok: "bg-success/10 text-success",
  warn: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
  bad: "bg-danger/10 text-danger",
  none: "bg-muted text-muted-foreground",
};

function StatusPill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold", toneClasses[tone])}>
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          tone === "ok" && "bg-success",
          tone === "warn" && "bg-yellow-500",
          tone === "bad" && "bg-danger",
          tone === "none" && "bg-muted-foreground",
        )}
        aria-hidden="true"
      />
      {children}
    </span>
  );
}

const componentLabel: Record<ComponentStatus, [Tone, string]> = {
  operational: ["ok", "Operational"],
  outage: ["bad", "Outage"],
};
const workerLabel: Record<WorkerStatus, [Tone, string]> = {
  operational: ["ok", "Running"],
  delayed: ["warn", "Delayed"],
  failing: ["bad", "Last run failed"],
  no_data: ["none", "No runs recorded"],
};
const monitorLabel: Record<MonitorStatus, [Tone, string]> = {
  operational: ["ok", "Up"],
  degraded: ["warn", "Degraded"],
  outage: ["bad", "Down"],
  no_data: ["none", "No checks yet"],
};

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function relative(iso: string | null, nowMs: number): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "unknown";
  const s = Math.round((nowMs - t) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `every ${seconds}s`;
  if (seconds < 3600) return `every ${Math.round(seconds / 60)} min`;
  return `every ${Math.round(seconds / 3600)} h`;
}

function percent(value: number | null): string {
  return value === null ? "No data" : `${value}%`;
}

function dayTone(value: number | null): string {
  if (value === null) return "bg-muted";
  if (value >= 100) return "bg-success";
  if (value >= 95) return "bg-yellow-500";
  return "bg-danger";
}

const wholeNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

// The one way a measured latency is written (packages/shared/src/latency.ts).
const formatMs = formatLatencyMs;

/** "up to 250 ms", "250 ms to 500 ms", "over 30,000 ms". */
function bucketLabel(upToMs: number | null, previousUpToMs: number | null): string {
  if (upToMs === null) return previousUpToMs === null ? "any" : `over ${formatMs(previousUpToMs)}`;
  return previousUpToMs === null ? `up to ${formatMs(upToMs)}` : `${formatMs(previousUpToMs)} to ${formatMs(upToMs)}`;
}

/**
 * Request latency. A number is rendered only from a "measured" answer; the
 * other two states say why there is none.
 */
function LatencySection({ latency, nowMs }: { latency: LatencyPayload | undefined; nowMs: number }) {
  const window = latency ? `${latency.windowHours} hours` : null;
  return (
    <section id="latency" aria-labelledby="latency-heading" className="scroll-mt-24">
      <h2 id="latency-heading" className="text-xl font-semibold text-foreground">
        Request latency
      </h2>
      {latency?.definition && <p className="mt-1 text-sm text-muted-foreground">{latency.definition}</p>}

      {!latency || latency.status === "unavailable" ? (
        <p className="mt-4 rounded-lg border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          The latency measurements could not be read right now, so no figure is shown.
        </p>
      ) : latency.status === "insufficient_data" ? (
        <div className="mt-4">
          <EmptyState
            icon={Activity}
            title="Measuring"
            description={`A figure is published once at least ${wholeNumber.format(latency.minSampleCount)} answered requests from at least ${wholeNumber.format(latency.minOrgCount)} organizations fall inside the last ${window}. So far: ${wholeNumber.format(latency.sampleCount ?? 0)} answered ${latency.sampleCount === 1 ? "request" : "requests"}. Until then no latency is shown.`}
          />
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-border bg-card p-4">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {(
              [
                ["Median (p50)", formatMs(latency.p50Ms)],
                ["95th percentile (p95)", formatMs(latency.p95Ms)],
                [
                  "Median time to first token",
                  latency.firstTokenP50Ms === null ? "Not enough streamed answers" : formatMs(latency.firstTokenP50Ms),
                ],
                [
                  "Requests that failed",
                  latency.errorSharePercent === null ? "No data" : `${latency.errorSharePercent}%`,
                ],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className="font-mono tabular-nums text-foreground">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            Over {wholeNumber.format(latency.sampleCount ?? 0)} answered requests in the last {window}
            {latency.computedAt && (
              <>
                , computed{" "}
                <time dateTime={latency.computedAt} title={formatDateTime(latency.computedAt)}>
                  {relative(latency.computedAt, nowMs)}
                </time>
              </>
            )}
            . The percentiles count answered requests only; failed and timed-out requests are the share shown
            separately. Published only above {wholeNumber.format(latency.minSampleCount)} requests from{" "}
            {wholeNumber.format(latency.minOrgCount)} organizations.
            {typeof latency.maxSamplesPerOrg === "number" && (
              <>
                {" "}
                Each organization counts for its {wholeNumber.format(latency.maxSamplesPerOrg)} most recent requests at
                most, so no single customer sets the figure.
              </>
            )}
          </p>
          {latency.histogram && latency.histogram.length > 0 && (
            <div className="mt-4">
              <p className="text-xs text-muted-foreground" id="latency-histogram">
                Answered requests by response time
              </p>
              <ol className="mt-2 space-y-1" aria-labelledby="latency-histogram">
                {latency.histogram.map((bucket, index) => {
                  const previous = index > 0 ? (latency.histogram?.[index - 1]?.upToMs ?? null) : null;
                  const most = Math.max(1, ...(latency.histogram ?? []).map((b) => b.count));
                  return (
                    <li key={String(bucket.upToMs)} className="grid grid-cols-[9rem_1fr_3.5rem] items-center gap-2 text-xs sm:grid-cols-[12rem_1fr_4rem]">
                      <span className="text-muted-foreground">{bucketLabel(bucket.upToMs, previous)}</span>
                      <span className="h-2 overflow-hidden rounded-sm bg-muted" aria-hidden="true">
                        <span className="block h-full rounded-sm bg-primary" style={{ width: `${(bucket.count / most) * 100}%` }} />
                      </span>
                      <span className="text-right font-mono tabular-nums text-foreground">{wholeNumber.format(bucket.count)}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function StatusBoard() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRefreshing(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/status`, {
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`The status endpoint answered HTTP ${res.status}.`);
      const body = (await res.json()) as StatusPayload;
      if (!body || !Array.isArray(body.components)) throw new Error("The status endpoint returned an unexpected body.");
      setData(body);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error && err.message ? err.message : "Request failed.");
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
        setNowMs(Date.now());
      }
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    const tick = setInterval(() => setNowMs(Date.now()), 10_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      abortRef.current?.abort();
    };
  }, [load]);

  if (loading && !data && !error) {
    return (
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading platform status</span>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const reachable = error === null;
  const overall: { tone: Tone; title: string; Icon: typeof CheckCircle2 } = !reachable
    ? { tone: "bad", title: "We cannot reach the WheelsAI API right now", Icon: XCircle }
    : data?.status === "operational"
      ? { tone: "ok", title: "All systems operational", Icon: CheckCircle2 }
      : data?.status === "degraded"
        ? { tone: "warn", title: "Some systems are degraded", Icon: AlertTriangle }
        : { tone: "bad", title: "Major outage", Icon: XCircle };

  return (
    <div className="space-y-10">
      {/* Overall */}
      <section aria-labelledby="overall-heading">
        <div
          className={cn(
            "flex flex-col gap-4 rounded-lg border p-5 sm:flex-row sm:items-center sm:justify-between",
            overall.tone === "ok" && "border-success/30 bg-success/5",
            overall.tone === "warn" && "border-yellow-500/30 bg-yellow-500/5",
            overall.tone === "bad" && "border-danger/30 bg-danger/5",
          )}
        >
          <div className="flex items-start gap-3">
            <overall.Icon
              className={cn(
                "mt-0.5 h-6 w-6 shrink-0",
                overall.tone === "ok" && "text-success",
                overall.tone === "warn" && "text-yellow-600 dark:text-yellow-400",
                overall.tone === "bad" && "text-danger",
              )}
              aria-hidden="true"
            />
            <div>
              <h2 id="overall-heading" className="text-lg font-semibold text-foreground" aria-live="polite">
                {overall.title}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {data ? (
                  <>
                    Last updated{" "}
                    <time dateTime={data.generatedAt} className="font-medium text-foreground">
                      {formatDateTime(data.generatedAt)}
                    </time>
                    {!reachable && " (the most recent answer we received)"}. Refreshes every 30 seconds.
                  </>
                ) : (
                  <>No status has been received yet. Retrying every 30 seconds.</>
                )}
              </p>
              {error && <p className="mt-1 break-words font-mono text-xs text-muted-foreground">{error}</p>}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={refreshing}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            <RotateCw className={cn("h-4 w-4", refreshing && "animate-spin")} aria-hidden="true" />
            {refreshing ? "Refreshing" : "Refresh now"}
          </button>
        </div>
      </section>

      {/* Components */}
      <section aria-labelledby="components-heading">
        <h2 id="components-heading" className="text-xl font-semibold text-foreground">
          Core services
        </h2>
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-card">
          <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="font-medium text-foreground">API</p>
              <p className="text-sm text-muted-foreground">Answered this page&apos;s status request from your browser.</p>
            </div>
            <StatusPill tone={reachable ? "ok" : "bad"}>{reachable ? "Reachable" : "Unreachable"}</StatusPill>
          </li>
          {data?.components.map((c) => {
            const [tone, label] = componentLabel[c.status] ?? (["none", c.status] as [Tone, string]);
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <p className="font-medium text-foreground">{c.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {c.latencyMs !== null ? (
                      <>
                        Probe answered in <span className="font-mono tabular-nums">{formatMs(c.latencyMs)}</span>
                      </>
                    ) : (
                      "Probe did not answer"
                    )}
                  </p>
                </div>
                <StatusPill tone={reachable ? tone : "none"}>{reachable ? label : `${label} (stale)`}</StatusPill>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Workers */}
      {data && (
        <section aria-labelledby="workers-heading">
          <h2 id="workers-heading" className="text-xl font-semibold text-foreground">
            Background workers
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Scheduled jobs that keep deployments, payments and monitoring moving. Times come from each worker&apos;s own run history.
          </p>
          {!data.workers.available ? (
            <p className="mt-4 rounded-lg border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
              Worker run history could not be read right now, so no worker status is shown.
            </p>
          ) : data.workers.items.length === 0 ? (
            <p className="mt-4 rounded-lg border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
              No background workers are scheduled on this deployment.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-card">
              {data.workers.items.map((w) => {
                const [tone, label] = workerLabel[w.status] ?? (["none", w.status] as [Tone, string]);
                return (
                  <li key={w.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">{w.name}</p>
                      <p className="text-sm text-muted-foreground">{w.description}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Scheduled {formatInterval(w.intervalSeconds)} · Last completed{" "}
                        {w.lastCompletedAt ? (
                          <time dateTime={w.lastCompletedAt} title={formatDateTime(w.lastCompletedAt)}>
                            {relative(w.lastCompletedAt, nowMs)}
                          </time>
                        ) : (
                          "never"
                        )}
                        {w.lastFailedAt && (
                          <>
                            {" "}· Last failed{" "}
                            <time dateTime={w.lastFailedAt} title={formatDateTime(w.lastFailedAt)}>
                              {relative(w.lastFailedAt, nowMs)}
                            </time>
                          </>
                        )}
                      </p>
                    </div>
                    <StatusPill tone={tone}>{label}</StatusPill>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* Monitors */}
      {data && (
        <section aria-labelledby="monitors-heading">
          <h2 id="monitors-heading" className="text-xl font-semibold text-foreground">
            Uptime monitors
          </h2>
          {!data.monitors.configured || (data.monitors.available && data.monitors.items.length === 0) ? (
            <div className="mt-4">
              <EmptyState
                icon={Activity}
                title="No public monitors yet"
                description="When the WheelsAI team publishes uptime monitors for the platform's own endpoints, their check history will appear here. Until real checks exist, no uptime figure is shown."
              />
            </div>
          ) : !data.monitors.available ? (
            <p className="mt-4 rounded-lg border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
              Monitor data could not be read right now.
            </p>
          ) : (
            <ul className="mt-4 space-y-4">
              {data.monitors.items.map((m, index) => {
                const [tone, label] = monitorLabel[m.status] ?? (["none", m.status] as [Tone, string]);
                return (
                  <li key={m.name} className="rounded-lg border border-border bg-card p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-medium text-foreground">{m.name}</h3>
                        <p className="text-xs text-muted-foreground">
                          Last checked{" "}
                          {m.lastCheckAt ? (
                            <time dateTime={m.lastCheckAt} title={formatDateTime(m.lastCheckAt)}>
                              {relative(m.lastCheckAt, nowMs)}
                            </time>
                          ) : (
                            "never"
                          )}
                        </p>
                      </div>
                      <StatusPill tone={tone}>{label}</StatusPill>
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                      {(
                        [
                          ["Uptime, 24 h", percent(m.uptimePercent["24h"])],
                          ["Uptime, 7 days", percent(m.uptimePercent["7d"])],
                          ["Uptime, 30 days", percent(m.uptimePercent["30d"])],
                          ["Avg. latency", m.avgLatencyMs === null ? "No data" : formatMs(m.avgLatencyMs)],
                        ] as const
                      ).map(([k, v]) => (
                        <div key={k}>
                          <dt className="text-xs text-muted-foreground">{k}</dt>
                          <dd className="font-mono tabular-nums text-foreground">{v}</dd>
                        </div>
                      ))}
                    </dl>
                    <div className="mt-4">
                      <p className="text-xs text-muted-foreground" id={`monitor-days-${index}`}>
                        Daily share of successful checks, last {data.monitors.historyDays} days (UTC). Grey means no checks that day.
                      </p>
                      <ol className="mt-2 flex h-8 items-stretch gap-[2px]" aria-labelledby={`monitor-days-${index}`}>
                        {m.days.map((d) => {
                          const text =
                            d.uptimePercent === null
                              ? `${d.date}: no checks`
                              : `${d.date}: ${d.uptimePercent}% of ${d.checks} checks succeeded`;
                          return (
                            <li key={d.date} className={cn("min-w-[3px] flex-1 rounded-sm", dayTone(d.uptimePercent))} title={text}>
                              <span className="sr-only">{text}</span>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* Request latency */}
      {data && <LatencySection latency={data.latency} nowMs={nowMs} />}

      <p className="text-sm text-muted-foreground">
        Something not working that this page does not show?{" "}
        <Link href="/contact?topic=support" className="font-medium text-primary underline-offset-4 hover:underline">
          Contact support
        </Link>
        . Developers can read the same data from{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">GET /api/status</code>.
      </p>
    </div>
  );
}
