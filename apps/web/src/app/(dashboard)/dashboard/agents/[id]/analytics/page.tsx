"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  BarChart3,
  TrendingUp,
  DollarSign,
  Activity,
  Users,
  Zap,
  Clock,
  Download,
  Bot,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  agentsApi,
  analyticsApi,
  type AgentDetail,
  type AnalyticsDashboard,
  ApiError,
  downloadAnalyticsExport,
  getErrorMessage,
} from "@/lib/api";

function MetricCard({
  label,
  value,
  icon: Icon,
  iconBg,
  iconColor,
  valueColor,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
  valueColor?: string;
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className={`text-2xl font-bold ${valueColor ?? "text-foreground"}`}>
              {value}
            </p>
          </div>
          <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${iconBg}`}>
            <Icon className={`h-5 w-5 ${iconColor}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Same footprint as <MetricCard> while the numbers load. */
function MetricCardSkeleton() {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-16" />
          </div>
          <Skeleton className="h-10 w-10 rounded-lg" />
        </div>
      </CardContent>
    </Card>
  );
}

function MetricGridSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <MetricCardSkeleton key={i} />
      ))}
    </div>
  );
}

// One bar per day, varied so the placeholder reads as the bar chart it stands in for.
const BAR_SKELETON_HEIGHTS = ["h-16", "h-28", "h-20", "h-32", "h-24", "h-36", "h-24"];

/** The 7-day requests chart: bars on the h-40 baseline plus the day-label row. */
function RequestsChartSkeleton() {
  return (
    <>
      <div className="flex h-40 items-end gap-2">
        {BAR_SKELETON_HEIGHTS.map((height, i) => (
          <Skeleton key={i} className={`flex-1 rounded-b-none ${height}`} />
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        {BAR_SKELETON_HEIGHTS.map((_, i) => (
          <div key={i} className="flex flex-1 justify-center">
            <Skeleton className="h-4 w-8" />
          </div>
        ))}
      </div>
    </>
  );
}

/** The four Performance Metrics tiles (label + value). */
function PerformanceTilesSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border p-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-1 h-7 w-16" />
        </div>
      ))}
    </div>
  );
}

/** The Cost Breakdown table: header row and its three line items. */
function CostTableSkeleton() {
  return (
    <div>
      <div className="flex justify-between border-b border-border pb-3">
        <Skeleton className="h-5 w-12" />
        <Skeleton className="h-5 w-16" />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center justify-between py-3">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A titled card (title + description lines) around one of the section skeletons. */
function SectionCardSkeleton({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-64" />
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * The API answers 404 for an agent outside this workspace and 400 for an id
 * that is not a UUID. Both mean there is no such agent, so the page says so
 * rather than offering a retry that cannot succeed.
 */
function isMissingAgent(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 400);
}

export default function AgentAnalyticsPage() {
  const params = useParams();
  const agentId = params.id as string;

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  const [analytics, setAnalytics] = useState<AnalyticsDashboard | null>(null);
  const [isLoadingAnalytics, setIsLoadingAnalytics] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<unknown>(null);
  const [exporting, setExporting] = useState<string | null>(null);

  async function handleExport(dataset: "daily" | "deployments", format: "csv" | "json", label: string) {
    setExporting(label);
    try {
      await downloadAnalyticsExport({ days: 30, format, dataset });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        toast.error(getErrorMessage(err, "Analytics export is included in the Pro plan"), {
          action: { label: "See plans", onClick: () => (window.location.href = "/dashboard/billing") },
        });
      } else {
        toast.error(getErrorMessage(err, "Export failed"));
      }
    } finally {
      setExporting(null);
    }
  }

  const loadAgent = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const { agent } = await agentsApi.get(agentId);
      setAgent(agent);
    } catch (err) {
      setLoadError(err);
      toast.error(getErrorMessage(err, "Failed to load agent"));
    } finally {
      setIsLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    loadAgent();
  }, [loadAgent]);

  const loadAnalytics = useCallback(() => {
    setIsLoadingAnalytics(true);
    setAnalyticsError(null);
    return analyticsApi
      .getDashboard(7)
      .then((res) => setAnalytics(res.data))
      .catch((err: unknown) => setAnalyticsError(err))
      .finally(() => setIsLoadingAnalytics(false));
  }, []);

  useEffect(() => {
    if (!agentId) return;
    loadAnalytics();
  }, [agentId, loadAnalytics]);

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <Header title="Loading..." />
        <div className="p-8 space-y-8" aria-busy="true">
          <Skeleton className="h-9 w-32" />
          <section>
            <Skeleton className="mb-4 h-5 w-20" />
            <MetricGridSkeleton />
          </section>
          <div className="grid gap-6 lg:grid-cols-2">
            <SectionCardSkeleton>
              <RequestsChartSkeleton />
            </SectionCardSkeleton>
            <SectionCardSkeleton>
              <PerformanceTilesSkeleton />
            </SectionCardSkeleton>
          </div>
          <SectionCardSkeleton>
            <CostTableSkeleton />
          </SectionCardSkeleton>
          <Skeleton className="h-20 w-full rounded-lg" />
          <span className="sr-only">Loading analytics</span>
        </div>
      </div>
    );
  }

  if (!agent) {
    if (loadError !== null && !isMissingAgent(loadError)) {
      return (
        <div className="flex flex-col">
          <Header title="Workspace Analytics" />
          <div className="p-8">
            <ErrorState
              title="Couldn't load agent"
              error={loadError}
              onRetry={() => void loadAgent()}
              actionLabel="Back to Agents"
              actionHref="/dashboard/agents"
            />
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col">
        <Header title="Agent Not Found" />
        <div className="p-8">
          <EmptyState
            icon={Bot}
            title="Agent not found"
            description="There's no agent with this ID in your workspace."
            actionLabel="Back to Agents"
            actionHref="/dashboard/agents"
          />
        </div>
      </div>
    );
  }

  const overview = analytics?.overview;
  const timeseries = analytics?.timeseries ?? [];
  const maxRequests = timeseries.length > 0 ? Math.max(...timeseries.map((p) => p.requests), 1) : 1;

  // Compute per-day labels from the timeseries timestamps
  const barLabels = timeseries.map((p) => {
    const d = new Date(p.timestamp);
    return d.toLocaleDateString("en-US", { weekday: "short" });
  });

  const totalRevenueDollars = overview ? (overview.totalCostCents / 100).toFixed(2) : "0.00";
  const errorRatePct = overview ? `${overview.errorRate.toFixed(1)}%` : "0%";
  const avgLatencyDisplay = overview ? `${Math.round(overview.avgLatencyMs)}ms` : "—";

  // Derive a rough per-day cost/revenue split from projection data
  const projection = analytics?.projection;
  const dailyCostDollars = projection ? (projection.dailyAverage / 100).toFixed(2) : null;

  return (
    <div className="flex flex-col">
      {/* Honest scope (INT-B3): getDashboard aggregates the WHOLE
          workspace — per-agent filtering is a backend build (Wave 1
          analytics snapshots). Until then the title must not claim
          agent-level numbers. */}
      <Header
        title="Workspace Analytics"
        description={`Usage and cost across your whole workspace — viewed from ${agent.name}. Per-agent breakdowns are coming.`}
      />

      <div className="p-8 space-y-8">
        {/* Back link */}
        <div className="flex items-center gap-2">
          <Link href={`/dashboard/agents/${agentId}`}>
            <Button variant="outline" size="sm">
              Back to Agent
            </Button>
          </Link>
          {isLoadingAnalytics && (
            <Badge variant="secondary">Loading analytics…</Badge>
          )}
        </div>

        {/* Overview, charts and cost all come from the one dashboard call, so
            when it fails a single error replaces them (not zeros and "no data"). */}
        {analyticsError !== null ? (
          <ErrorState
            title="Couldn't load analytics"
            error={analyticsError}
            onRetry={() => void loadAnalytics()}
          />
        ) : (
          <>
            {/* Overview Cards */}
            <section>
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Overview
              </h2>
              {isLoadingAnalytics ? (
                <MetricGridSkeleton />
              ) : !analytics ? (
                <EmptyState
                  icon={BarChart3}
                  title="No analytics data yet"
                  description="Deploy an agent to start tracking performance."
                  actionLabel="Go to agent"
                  actionHref={`/dashboard/agents/${agentId}`}
                />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <MetricCard
                    label="Total Requests"
                    value={(overview?.totalRequests ?? 0).toLocaleString()}
                    icon={BarChart3}
                    iconBg="bg-blue-500/10"
                    iconColor="text-blue-600 dark:text-blue-400"
                  />
                  <MetricCard
                    label="Tokens Used"
                    value={((overview?.totalTokensIn ?? 0) + (overview?.totalTokensOut ?? 0)).toLocaleString()}
                    icon={Users}
                    iconBg="bg-purple-500/10"
                    iconColor="text-purple-600 dark:text-purple-400"
                  />
                  <MetricCard
                    label="Total Cost"
                    value={`$${totalRevenueDollars}`}
                    icon={DollarSign}
                    iconBg="bg-green-500/10"
                    iconColor="text-green-600 dark:text-green-400"
                    valueColor="text-green-600 dark:text-green-400"
                  />
                  <MetricCard
                    label="Error Rate"
                    value={errorRatePct}
                    icon={Activity}
                    iconBg="bg-red-500/10"
                    iconColor="text-red-600 dark:text-red-400"
                  />
                </div>
              )}
            </section>

            {/* Charts Section */}
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Requests Over Time — CSS bar chart */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="h-5 w-5 text-primary-500" />
                    Requests (Last 7 Days)
                  </CardTitle>
                  <CardDescription>Daily request volume over the past week</CardDescription>
                </CardHeader>
                <CardContent>
                  {isLoadingAnalytics ? (
                    <RequestsChartSkeleton />
                  ) : timeseries.length === 0 ? (
                    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                      No request data for this period
                    </div>
                  ) : (
                    <>
                      <div className="flex h-40 items-end gap-2">
                        {timeseries.map((point, index) => {
                          const heightPct = Math.round((point.requests / maxRequests) * 100);
                          return (
                            <div key={index} className="flex flex-1 flex-col items-center gap-1">
                              <span className="text-xs text-muted-foreground">
                                {point.requests}
                              </span>
                              <div
                                className="w-full rounded-t bg-primary-500 transition-all"
                                style={{ height: `${heightPct}%` }}
                                title={`${barLabels[index]}: ${point.requests} requests`}
                              />
                            </div>
                          );
                        })}
                      </div>
                      <div className="mt-2 flex gap-2">
                        {barLabels.map((label, i) => (
                          <div
                            key={i}
                            className="flex-1 text-center text-xs text-muted-foreground"
                          >
                            {label}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Performance Metrics */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Zap className="h-5 w-5 text-yellow-500" />
                    Performance Metrics
                  </CardTitle>
                  <CardDescription>Latency and availability statistics</CardDescription>
                </CardHeader>
                <CardContent>
                  {isLoadingAnalytics ? (
                    <PerformanceTilesSkeleton />
                  ) : (
                    <div className="grid grid-cols-2 gap-4">
                      {[
                        { label: "Avg Latency", value: avgLatencyDisplay, icon: Clock },
                        {
                          label: "Total Tokens In",
                          value: (overview?.totalTokensIn ?? 0).toLocaleString(),
                          icon: TrendingUp,
                        },
                        {
                          label: "Total Tokens Out",
                          value: (overview?.totalTokensOut ?? 0).toLocaleString(),
                          icon: TrendingUp,
                        },
                        {
                          label: "Error Rate",
                          value: errorRatePct,
                          icon: Activity,
                        },
                      ].map(({ label, value, icon: Icon }) => (
                        <div
                          key={label}
                          className="rounded-lg border border-border bg-muted p-4"
                        >
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <Icon className="h-4 w-4" />
                            <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
                          </div>
                          <p className="mt-1 text-xl font-bold text-foreground">
                            {value}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Hardcoded "Token Performance" card removed (W0-2): it showed
                invented numbers ($0.042 / 89 holders) captioned "live from the
                bonding curve". Real token stats return with the trade-feed
                build (match-up roadmap, Wave 2). */}

            {/* Cost Breakdown */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <DollarSign className="h-5 w-5 text-muted-foreground" />
                  Cost Breakdown
                </CardTitle>
                <CardDescription>Compute cost and projection</CardDescription>
              </CardHeader>
              <CardContent>
                {isLoadingAnalytics ? (
                  <CostTableSkeleton />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-left">
                          <th className="pb-3 font-medium text-muted-foreground">Item</th>
                          <th className="pb-3 text-right font-medium text-muted-foreground">
                            Amount
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        <tr>
                          <td className="py-3 text-foreground">Total Cost (7 days)</td>
                          <td className="py-3 text-right font-medium text-red-600 dark:text-red-400">
                            ${totalRevenueDollars}
                          </td>
                        </tr>
                        {dailyCostDollars !== null && (
                          <tr>
                            <td className="py-3 text-foreground">Daily Average</td>
                            <td className="py-3 text-right font-medium text-foreground">
                              ${dailyCostDollars}
                            </td>
                          </tr>
                        )}
                        {projection && (
                          <tr>
                            <td className="py-3 font-semibold text-foreground">
                              Projected (30 days)
                            </td>
                            <td className="py-3 text-right text-lg font-bold text-blue-600 dark:text-blue-400">
                              ${(projection.projectedSpend / 100).toFixed(2)}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {/* Export Data */}
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium text-foreground">Export Data</p>
            <p className="text-sm text-muted-foreground">
              Daily usage and per-deployment metrics for the last 30 days, as CSV or JSON
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["daily", "csv", "Daily CSV"],
                ["deployments", "csv", "Deployments CSV"],
                ["daily", "json", "JSON"],
              ] as const
            ).map(([dataset, format, label]) => (
              <Button
                key={label}
                variant="outline"
                size="sm"
                isLoading={exporting === label}
                disabled={exporting !== null}
                onClick={() => handleExport(dataset, format, label)}
              >
                <Download className="mr-2 h-4 w-4" />
                {label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
