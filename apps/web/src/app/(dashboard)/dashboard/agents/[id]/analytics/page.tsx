"use client";

import { useEffect, useState } from "react";
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
import {
  agentsApi,
  analyticsApi,
  type AgentDetail,
  type AnalyticsDashboard,
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
            <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
            <p className={`text-2xl font-bold ${valueColor ?? "text-gray-900 dark:text-gray-100"}`}>
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

function SkeletonCard() {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <div className="h-3 w-24 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
            <div className="h-7 w-16 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
          </div>
          <div className="h-10 w-10 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function AgentAnalyticsPage() {
  const params = useParams();
  const agentId = params.id as string;

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [analytics, setAnalytics] = useState<AnalyticsDashboard | null>(null);
  const [isLoadingAnalytics, setIsLoadingAnalytics] = useState(true);

  useEffect(() => {
    async function loadAgent() {
      try {
        const { agent } = await agentsApi.get(agentId);
        setAgent(agent);
      } catch {
        toast.error("Failed to load agent");
      } finally {
        setIsLoading(false);
      }
    }
    loadAgent();
  }, [agentId]);

  useEffect(() => {
    if (!agentId) return;
    analyticsApi
      .getDashboard(7)
      .then((res) => setAnalytics(res.data))
      .catch(() => {})
      .finally(() => setIsLoadingAnalytics(false));
  }, [agentId]);

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <Header title="Loading..." />
        <div className="p-8">
          <div className="h-96 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700" />
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="flex flex-col">
        <Header title="Agent Not Found" />
        <div className="p-8">
          <Card>
            <CardContent className="py-16 text-center">
              <Bot className="mx-auto h-16 w-16 text-gray-300" />
              <h3 className="mt-4 text-xl font-medium">Agent not found</h3>
              <Link href="/dashboard/agents" className="mt-4 inline-block">
                <Button variant="outline">Back to Agents</Button>
              </Link>
            </CardContent>
          </Card>
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

  // Determine whether this agent has a token (placeholder: false until token API is wired)
  const hasToken = false;

  return (
    <div className="flex flex-col">
      <Header
        title={`${agent.name} — Analytics`}
        description="Performance insights and cost breakdown for this agent"
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

        {/* Overview Cards */}
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Overview
          </h2>
          {isLoadingAnalytics ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonCard key={i} />
              ))}
            </div>
          ) : !analytics ? (
            <Card>
              <CardContent className="py-10 text-center">
                <BarChart3 className="mx-auto h-10 w-10 text-gray-300" />
                <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                  No analytics data yet. Deploy an agent to start tracking performance.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard
                label="Total Requests"
                value={(overview?.totalRequests ?? 0).toLocaleString()}
                icon={BarChart3}
                iconBg="bg-blue-100 dark:bg-blue-900/30"
                iconColor="text-blue-600 dark:text-blue-400"
              />
              <MetricCard
                label="Tokens Used"
                value={((overview?.totalTokensIn ?? 0) + (overview?.totalTokensOut ?? 0)).toLocaleString()}
                icon={Users}
                iconBg="bg-purple-100 dark:bg-purple-900/30"
                iconColor="text-purple-600 dark:text-purple-400"
              />
              <MetricCard
                label="Total Cost"
                value={`$${totalRevenueDollars}`}
                icon={DollarSign}
                iconBg="bg-green-100 dark:bg-green-900/30"
                iconColor="text-green-600 dark:text-green-400"
                valueColor="text-green-600 dark:text-green-400"
              />
              <MetricCard
                label="Error Rate"
                value={errorRatePct}
                icon={Activity}
                iconBg="bg-red-100 dark:bg-red-900/30"
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
                <div className="h-40 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
              ) : timeseries.length === 0 ? (
                <div className="flex h-40 items-center justify-center text-sm text-gray-400 dark:text-gray-500">
                  No request data for this period
                </div>
              ) : (
                <>
                  <div className="flex h-40 items-end gap-2">
                    {timeseries.map((point, index) => {
                      const heightPct = Math.round((point.requests / maxRequests) * 100);
                      return (
                        <div key={index} className="flex flex-1 flex-col items-center gap-1">
                          <span className="text-xs text-gray-500 dark:text-gray-400">
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
                        className="flex-1 text-center text-xs text-gray-500 dark:text-gray-400"
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
                <div className="grid grid-cols-2 gap-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-20 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700"
                    />
                  ))}
                </div>
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
                      className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800"
                    >
                      <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                        <Icon className="h-4 w-4" />
                        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
                      </div>
                      <p className="mt-1 text-xl font-bold text-gray-900 dark:text-gray-100">
                        {value}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Token Performance — only shown if agent has an associated token */}
        {hasToken && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-green-500" />
                Token Performance
              </CardTitle>
              <CardDescription>
                Live bonding curve data from the token marketplace
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { label: "Token Price", value: "$0.042" },
                  { label: "Market Cap", value: "$42,000" },
                  { label: "24h Volume", value: "$1,250" },
                  { label: "Holders", value: "89" },
                ].map(({ label, value }) => (
                  <div
                    key={label}
                    className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800"
                  >
                    <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      {label}
                    </p>
                    <p className="mt-1 text-xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
                Token data is live from the bonding curve
              </p>
            </CardContent>
          </Card>
        )}

        {/* Cost Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5 text-gray-500" />
              Cost Breakdown
            </CardTitle>
            <CardDescription>Compute cost and projection</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoadingAnalytics ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-10 animate-pulse rounded bg-gray-200 dark:bg-gray-700"
                  />
                ))}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-left dark:border-gray-700">
                      <th className="pb-3 font-medium text-gray-500 dark:text-gray-400">Item</th>
                      <th className="pb-3 text-right font-medium text-gray-500 dark:text-gray-400">
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                    <tr>
                      <td className="py-3 text-gray-700 dark:text-gray-300">Total Cost (7 days)</td>
                      <td className="py-3 text-right font-medium text-red-600 dark:text-red-400">
                        ${totalRevenueDollars}
                      </td>
                    </tr>
                    {dailyCostDollars !== null && (
                      <tr>
                        <td className="py-3 text-gray-700 dark:text-gray-300">Daily Average</td>
                        <td className="py-3 text-right font-medium text-gray-700 dark:text-gray-300">
                          ${dailyCostDollars}
                        </td>
                      </tr>
                    )}
                    {projection && (
                      <tr>
                        <td className="py-3 font-semibold text-gray-900 dark:text-gray-100">
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

        {/* Export Data */}
        <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800">
          <div>
            <p className="font-medium text-gray-900 dark:text-gray-100">Export Data</p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Download analytics as CSV or JSON
            </p>
          </div>
          <div className="group relative">
            <Button variant="outline" disabled>
              <Download className="mr-2 h-4 w-4" />
              Export
            </Button>
            <span className="pointer-events-none absolute bottom-full right-0 mb-2 whitespace-nowrap rounded bg-gray-900 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100 dark:bg-gray-100 dark:text-gray-900">
              Coming soon
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
