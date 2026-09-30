"use client";

import { useState, useEffect } from "react";
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Zap,
  Clock,
  AlertTriangle,
  Activity,
  Server,
  Cpu,
} from "lucide-react";
import {
  analyticsApi,
  type AnalyticsDashboard,
  type SpendingAlert,
  getErrorMessage,
} from "@/lib/api";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, SkeletonCard, SkeletonTable } from "@/components/ui/skeleton";
import { toast } from "sonner";

export default function AnalyticsDashboardPage() {
  const [dashboard, setDashboard] = useState<AnalyticsDashboard | null>(null);
  const [alerts, setAlerts] = useState<SpendingAlert[]>([]);
  const [periodDays, setPeriodDays] = useState(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDashboard();
  }, [periodDays]);

  async function loadDashboard() {
    setLoading(true);
    try {
      const [dashboardRes, alertsRes] = await Promise.all([
        analyticsApi.getDashboard(periodDays),
        analyticsApi.getAlerts(100),
      ]);
      setDashboard(dashboardRes.data);
      setAlerts(alertsRes.data);
    } catch (error) {
      console.error("Failed to load analytics:", error);
      toast.error(getErrorMessage(error, "Failed to load analytics data"));
    } finally {
      setLoading(false);
    }
  }

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  };

  const formatNumber = (num: number) => {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
    if (num >= 1000) return (num / 1000).toFixed(1) + "K";
    return num.toLocaleString();
  };

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-8 w-36" />
            <Skeleton className="h-4 w-56" />
          </div>
          <Skeleton className="h-10 w-36" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
        <div className="rounded-lg border border-border bg-card p-6 space-y-4">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-48 w-full" />
        </div>
        <SkeletonTable rows={5} cols={8} />
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="p-6">
        <EmptyState
          icon={BarChart3}
          title="No analytics data"
          description="Start using deployments to see usage metrics and cost insights here."
          actionLabel="Deploy a Model"
          actionHref="/dashboard/models"
        />
      </div>
    );
  }

  const { overview, timeseries, deployments, costBreakdown, projection } = dashboard;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Analytics</h1>
          <p className="text-muted-foreground">
            Usage metrics and cost insights
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={periodDays}
            onChange={(e) => setPeriodDays(parseInt(e.target.value))}
            className="bg-card border rounded-lg px-3 py-2 text-sm"
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((alert, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 p-4 rounded-lg border ${
                alert.type === "critical"
                  ? "bg-red-500/10 border-red-500/30 text-red-500"
                  : "bg-yellow-500/10 border-yellow-500/30 text-yellow-500"
              }`}
            >
              <AlertTriangle className="h-5 w-5 flex-shrink-0" />
              <span className="font-medium">{alert.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-card border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <Zap className="h-4 w-4" />
            <span className="text-sm">Total Requests</span>
          </div>
          <div className="text-3xl font-bold">
            {formatNumber(overview.totalRequests)}
          </div>
          <div className="text-sm text-muted-foreground mt-1">
            {overview.errorRate.toFixed(2)}% error rate
          </div>
        </div>

        <div className="bg-card border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <Activity className="h-4 w-4" />
            <span className="text-sm">Total Tokens</span>
          </div>
          <div className="text-3xl font-bold">
            {formatNumber(overview.totalTokensIn + overview.totalTokensOut)}
          </div>
          <div className="text-sm text-muted-foreground mt-1">
            {formatNumber(overview.totalTokensIn)} in / {formatNumber(overview.totalTokensOut)} out
          </div>
        </div>

        <div className="bg-card border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <DollarSign className="h-4 w-4" />
            <span className="text-sm">Total Cost</span>
          </div>
          <div className="text-3xl font-bold">
            {formatCurrency(overview.totalCostCents)}
          </div>
          <div className="text-sm text-muted-foreground mt-1">
            Last {periodDays} days
          </div>
        </div>

        <div className="bg-card border rounded-lg p-4">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <Clock className="h-4 w-4" />
            <span className="text-sm">Avg Latency</span>
          </div>
          <div className="text-3xl font-bold">
            {overview.avgLatencyMs.toFixed(0)}ms
          </div>
          <div className="text-sm text-muted-foreground mt-1">
            Per request average
          </div>
        </div>
      </div>

      {/* Cost Projection */}
      <div className="bg-card border rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">Monthly Cost Projection</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div>
            <div className="text-sm text-muted-foreground mb-1">Current Spend</div>
            <div className="text-2xl font-bold">
              {formatCurrency(projection.currentSpend)}
            </div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground mb-1">Projected Total</div>
            <div className="text-2xl font-bold text-blue-500">
              {formatCurrency(projection.projectedSpend)}
            </div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground mb-1">Daily Average</div>
            <div className="text-2xl font-bold">
              {formatCurrency(projection.dailyAverage)}
            </div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground mb-1">Days Remaining</div>
            <div className="text-2xl font-bold">{projection.daysRemaining}</div>
          </div>
        </div>
      </div>

      {/* Usage Chart */}
      <div className="bg-card border rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">Usage Over Time</h2>
        {timeseries.length > 0 ? (
          <div className="h-64">
            {(() => {
              const firstPoint = timeseries[0];
              const lastPoint = timeseries[timeseries.length - 1];
              return (
                <>
            <div className="flex items-end gap-1 h-48">
              {timeseries.slice(-30).map((point, i) => {
                const maxRequests = Math.max(...timeseries.map((p) => p.requests));
                const height = maxRequests > 0 ? (point.requests / maxRequests) * 100 : 0;
                return (
                  <div
                    key={i}
                    className="flex-1 bg-primary/20 hover:bg-primary/40 rounded-t transition-colors group relative"
                    style={{ height: `${height}%`, minHeight: "4px" }}
                  >
                    <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-popover border rounded px-2 py-1 text-xs opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">
                      <div className="font-medium">{point.requests} requests</div>
                      <div className="text-muted-foreground">
                        {new Date(point.timestamp).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-xs text-muted-foreground mt-2">
              <span>
                {firstPoint ? new Date(firstPoint.timestamp).toLocaleDateString() : ""}
              </span>
              <span>
                {lastPoint ? new Date(lastPoint.timestamp).toLocaleDateString() : ""}
              </span>
            </div>
                </>
              );
            })()}
          </div>
        ) : (
          <div className="h-48 flex items-center justify-center text-muted-foreground">
            No usage data available
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cost by Model */}
        <div className="bg-card border rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">Cost by Model</h2>
          {costBreakdown.byModel.length > 0 ? (
            <div className="space-y-3">
              {costBreakdown.byModel.slice(0, 5).map((item) => {
                const maxCost = Math.max(...costBreakdown.byModel.map((m) => m.costCents));
                const percentage = maxCost > 0 ? (item.costCents / maxCost) * 100 : 0;
                return (
                  <div key={item.modelId}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="font-medium">{item.modelId}</span>
                      <span>{formatCurrency(item.costCents)}</span>
                    </div>
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {formatNumber(item.requests)} requests
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No model data available
            </div>
          )}
        </div>

        {/* Cost by GPU Tier */}
        <div className="bg-card border rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">Cost by GPU Tier</h2>
          {costBreakdown.byGpu.length > 0 ? (
            <div className="space-y-3">
              {costBreakdown.byGpu.map((item) => {
                const maxCost = Math.max(...costBreakdown.byGpu.map((g) => g.costCents));
                const percentage = maxCost > 0 ? (item.costCents / maxCost) * 100 : 0;
                return (
                  <div key={item.gpuTier}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="font-medium flex items-center gap-2">
                        <Cpu className="h-4 w-4" />
                        {item.gpuTier}
                      </span>
                      <span>{formatCurrency(item.costCents)}</span>
                    </div>
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500 rounded-full"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {formatNumber(item.requests)} requests
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No GPU data available
            </div>
          )}
        </div>
      </div>

      {/* Deployment Metrics */}
      <div className="bg-card border rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-4">Deployment Performance</h2>
        {deployments.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-sm text-muted-foreground border-b">
                  <th className="pb-3 font-medium">Deployment</th>
                  <th className="pb-3 font-medium">Model</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 font-medium text-right">Requests</th>
                  <th className="pb-3 font-medium text-right">Tokens</th>
                  <th className="pb-3 font-medium text-right">Cost</th>
                  <th className="pb-3 font-medium text-right">Latency</th>
                  <th className="pb-3 font-medium text-right">Errors</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {deployments.map((d) => (
                  <tr key={d.deploymentId} className="hover:bg-accent/50">
                    <td className="py-3 font-medium">{d.deploymentName}</td>
                    <td className="py-3 text-muted-foreground">{d.modelId}</td>
                    <td className="py-3">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs ${
                          d.status === "running"
                            ? "bg-green-500/20 text-green-500"
                            : d.status === "stopped"
                            ? "bg-gray-500/20 text-muted-foreground"
                            : "bg-yellow-500/20 text-yellow-500"
                        }`}
                      >
                        {d.status}
                      </span>
                    </td>
                    <td className="py-3 text-right">{formatNumber(d.requests)}</td>
                    <td className="py-3 text-right">
                      {formatNumber(d.tokensIn + d.tokensOut)}
                    </td>
                    <td className="py-3 text-right">{formatCurrency(d.costCents)}</td>
                    <td className="py-3 text-right">{d.avgLatencyMs.toFixed(0)}ms</td>
                    <td className="py-3 text-right">
                      <span
                        className={
                          d.errorRate > 5
                            ? "text-red-500"
                            : d.errorRate > 1
                            ? "text-yellow-500"
                            : ""
                        }
                      >
                        {d.errorRate.toFixed(2)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            No deployment data available
          </div>
        )}
      </div>
    </div>
  );
}
