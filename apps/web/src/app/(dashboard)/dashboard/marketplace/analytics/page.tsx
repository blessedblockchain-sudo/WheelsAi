"use client";

import {
  DollarSign,
  Store,
  Download,
  Star,
  TrendingUp,
  BarChart3,
  PieChart,
} from "lucide-react";

import { Header } from "@/components/dashboard/header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

// ---------------------------------------------------------------------------
// Mock data — real values will come from the marketplace analytics API
// ---------------------------------------------------------------------------

const REVENUE_BY_AGENT: Array<{ name: string; revenue: number }> = [
  { name: "Support Bot", revenue: 650 },
  { name: "Code Reviewer", revenue: 412 },
  { name: "Research Assistant", revenue: 185 },
];

const MAX_AGENT_REVENUE = Math.max(...REVENUE_BY_AGENT.map((a) => a.revenue));

// 30-day install growth (arbitrary mock values)
const INSTALL_GROWTH_30D: number[] = [
  4, 6, 3, 8, 5, 11, 7, 9, 6, 14, 10, 8, 12, 15, 9, 11, 16, 13, 18, 14, 12,
  17, 20, 15, 19, 22, 18, 21, 25, 23,
];

const MAX_INSTALL = Math.max(...INSTALL_GROWTH_30D);

const TOP_CATEGORIES: Array<{ name: string; pct: number; color: string }> = [
  { name: "Customer Support", pct: 45, color: "bg-blue-500" },
  { name: "Development", pct: 30, color: "bg-purple-500" },
  { name: "Research", pct: 25, color: "bg-green-500" },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

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
            <p
              className={`text-2xl font-bold ${
                valueColor ?? "text-gray-900 dark:text-gray-100"
              }`}
            >
              {value}
            </p>
          </div>
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-lg ${iconBg}`}
          >
            <Icon className={`h-5 w-5 ${iconColor}`} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MarketplaceAnalyticsPage() {
  return (
    <div className="flex flex-col">
      <Header
        title="Marketplace Intelligence"
        description="Publisher analytics — revenue, installs, and category insights"
      />

      <div className="space-y-8 p-8">
        {/* Overview Cards */}
        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Overview
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Total Revenue"
              value="$1,247.50"
              icon={DollarSign}
              iconBg="bg-green-100 dark:bg-green-900/30"
              iconColor="text-green-600 dark:text-green-400"
              valueColor="text-green-600 dark:text-green-400"
            />
            <MetricCard
              label="Published Agents"
              value="3"
              icon={Store}
              iconBg="bg-purple-100 dark:bg-purple-900/30"
              iconColor="text-purple-600 dark:text-purple-400"
            />
            <MetricCard
              label="Total Installs"
              value="342"
              icon={Download}
              iconBg="bg-blue-100 dark:bg-blue-900/30"
              iconColor="text-blue-600 dark:text-blue-400"
            />
            <MetricCard
              label="Avg Rating"
              value="4.7 / 5"
              icon={Star}
              iconBg="bg-yellow-100 dark:bg-yellow-900/30"
              iconColor="text-yellow-600 dark:text-yellow-400"
              valueColor="text-yellow-600 dark:text-yellow-400"
            />
          </div>
        </section>

        {/* Revenue by Agent + Top Categories */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Horizontal bar chart: Revenue by Agent */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-primary-500" />
                Revenue by Agent
              </CardTitle>
              <CardDescription>
                Earnings breakdown across your published agents
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {REVENUE_BY_AGENT.map(({ name, revenue }) => {
                  const widthPct = Math.round((revenue / MAX_AGENT_REVENUE) * 100);
                  return (
                    <div key={name}>
                      <div className="mb-1 flex items-center justify-between text-sm">
                        <span className="font-medium text-gray-700 dark:text-gray-300">
                          {name}
                        </span>
                        <span className="font-semibold text-green-600 dark:text-green-400">
                          ${revenue.toLocaleString()}
                        </span>
                      </div>
                      <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
                        <div
                          className="h-full rounded-full bg-primary-500 transition-all"
                          style={{ width: `${widthPct}%` }}
                          title={`$${revenue}`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Top Categories */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <PieChart className="h-5 w-5 text-blue-500" />
                Top Categories
              </CardTitle>
              <CardDescription>
                Distribution of installs by agent category
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {TOP_CATEGORIES.map(({ name, pct, color }) => (
                  <div key={name}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-3 w-3 rounded-full ${color}`}
                          aria-hidden="true"
                        />
                        <span className="font-medium text-gray-700 dark:text-gray-300">
                          {name}
                        </span>
                      </div>
                      <span className="font-semibold text-gray-900 dark:text-gray-100">
                        {pct}%
                      </span>
                    </div>
                    <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
                      <div
                        className={`h-full rounded-full ${color} transition-all`}
                        style={{ width: `${pct}%` }}
                        title={`${name}: ${pct}%`}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
                Based on total installs across all published agents
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Install Growth — 30-day vertical bar chart */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-green-500" />
              Install Growth (Last 30 Days)
            </CardTitle>
            <CardDescription>
              Daily new installs across all your marketplace listings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex h-40 items-end gap-px sm:gap-1">
              {INSTALL_GROWTH_30D.map((value, index) => {
                const heightPct = Math.round((value / MAX_INSTALL) * 100);
                const dayNum = index + 1;
                return (
                  <div
                    key={index}
                    className="group relative flex flex-1 flex-col items-center"
                  >
                    {/* Tooltip */}
                    <span className="pointer-events-none absolute bottom-full mb-1 hidden whitespace-nowrap rounded bg-gray-900 px-1.5 py-0.5 text-xs text-white group-hover:block dark:bg-gray-100 dark:text-gray-900">
                      Day {dayNum}: {value}
                    </span>
                    <div
                      className="w-full rounded-t bg-blue-500 transition-all hover:bg-blue-400"
                      style={{ height: `${heightPct}%` }}
                    />
                  </div>
                );
              })}
            </div>
            {/* Sparse day labels to avoid clutter */}
            <div className="mt-2 flex">
              {INSTALL_GROWTH_30D.map((_, index) => {
                const dayNum = index + 1;
                const showLabel = dayNum === 1 || dayNum % 5 === 0;
                return (
                  <div key={index} className="flex-1 text-center">
                    {showLabel && (
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {dayNum}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-1 text-center text-xs text-gray-400 dark:text-gray-500">
              Day of month
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
