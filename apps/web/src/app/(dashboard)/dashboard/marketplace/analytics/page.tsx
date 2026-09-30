"use client";

import { useEffect, useState } from "react";
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
import {
  analyticsApi,
  marketplaceApi,
  type AnalyticsDashboard,
  type MarketplaceListing,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RevenueByListing {
  listingId: string;
  listing: { id: string; title: string; slug: string } | undefined;
  totalRevenueCents: number;
  totalRequests: number;
}

interface RevenueData {
  totalRevenueCents: number;
  pendingPayoutCents: number;
  totalListings: number;
  totalInstalls: number;
  revenueByListing: RevenueByListing[];
}

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
            <p className="text-sm text-muted-foreground">{label}</p>
            <p
              className={`text-2xl font-bold ${
                valueColor ?? "text-foreground"
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

function SkeletonCard() {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <div className="h-3 w-24 animate-pulse rounded bg-muted" />
            <div className="h-7 w-16 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-10 w-10 animate-pulse rounded-lg bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Category breakdown derived from listings
// ---------------------------------------------------------------------------

const CATEGORY_COLORS: Record<string, string> = {
  "Customer Support": "bg-blue-500",
  Development: "bg-purple-500",
  Research: "bg-green-500",
  Productivity: "bg-yellow-500",
  Finance: "bg-orange-500",
  Marketing: "bg-pink-500",
  Other: "bg-gray-500",
};

function deriveCategoryBreakdown(
  listings: MarketplaceListing[]
): Array<{ name: string; pct: number; color: string }> {
  if (listings.length === 0) return [];
  const totalInstalls = listings.reduce((sum, l) => sum + l.totalInstalls, 0);
  if (totalInstalls === 0) return [];

  const counts: Record<string, number> = {};
  for (const listing of listings) {
    counts[listing.category] = (counts[listing.category] ?? 0) + listing.totalInstalls;
  }

  return Object.entries(counts)
    .map(([name, installs]) => ({
      name,
      pct: Math.round((installs / totalInstalls) * 100),
      color: CATEGORY_COLORS[name] ?? "bg-gray-500",
    }))
    .sort((a, b) => b.pct - a.pct);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MarketplaceAnalyticsPage() {
  const [revenue, setRevenue] = useState<RevenueData | null>(null);
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [dashboard, setDashboard] = useState<AnalyticsDashboard | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let done = 0;
    const finish = () => {
      done += 1;
      if (done === 3) setIsLoading(false);
    };

    marketplaceApi
      .getRevenue()
      .then((data) => setRevenue(data as RevenueData))
      .catch(() => {})
      .finally(finish);

    marketplaceApi
      .getMyListings()
      .then(({ listings }) => setListings(listings))
      .catch(() => {})
      .finally(finish);

    analyticsApi
      .getDashboard(30)
      .then((res) => setDashboard(res.data))
      .catch(() => {})
      .finally(finish);
  }, []);

  const hasAnyData = revenue !== null || listings.length > 0 || dashboard !== null;

  // Overview derived values
  const totalRevenueDollars =
    revenue ? `$${(revenue.totalRevenueCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "$0.00";

  const publishedListings = listings.filter((l) => l.status === "published");
  const totalInstalls = listings.reduce((sum, l) => sum + l.totalInstalls, 0);

  const ratingsWithReviews = listings.filter((l) => l.reviewCount > 0);
  const avgRating =
    ratingsWithReviews.length > 0
      ? ratingsWithReviews.reduce((sum, l) => sum + l.avgRating, 0) / ratingsWithReviews.length
      : null;

  // Revenue by agent for bar chart
  const revenueByAgent = (revenue?.revenueByListing ?? [])
    .filter((r) => r.totalRevenueCents > 0)
    .sort((a, b) => b.totalRevenueCents - a.totalRevenueCents)
    .slice(0, 5);
  const maxAgentRevenue = revenueByAgent.length > 0
    ? Math.max(...revenueByAgent.map((r) => r.totalRevenueCents), 1)
    : 1;

  // Category breakdown
  const categoryBreakdown = deriveCategoryBreakdown(listings);

  // Install growth timeseries (use analytics timeseries as a proxy for daily activity)
  const timeseries = dashboard?.timeseries ?? [];
  const maxActivity = timeseries.length > 0
    ? Math.max(...timeseries.map((p) => p.requests), 1)
    : 1;

  return (
    <div className="flex flex-col">
      <Header
        title="Marketplace Intelligence"
        description="Publisher analytics — revenue, installs, and category insights"
      />

      <div className="space-y-8 p-8">
        {/* Empty state */}
        {!isLoading && !hasAnyData && (
          <Card>
            <CardContent className="py-16 text-center">
              <BarChart3 className="mx-auto h-12 w-12 text-gray-300" />
              <h3 className="mt-4 text-lg font-medium text-foreground">
                No analytics data yet
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Deploy an agent to start tracking performance.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Overview Cards */}
        {(isLoading || hasAnyData) && (
          <section>
            <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Overview
            </h2>
            {isLoading ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <SkeletonCard key={i} />
                ))}
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard
                  label="Total Revenue"
                  value={totalRevenueDollars}
                  icon={DollarSign}
                  iconBg="bg-green-500/10"
                  iconColor="text-green-600 dark:text-green-400"
                  valueColor="text-green-600 dark:text-green-400"
                />
                <MetricCard
                  label="Published Agents"
                  value={publishedListings.length.toString()}
                  icon={Store}
                  iconBg="bg-purple-500/10"
                  iconColor="text-purple-600 dark:text-purple-400"
                />
                <MetricCard
                  label="Total Installs"
                  value={totalInstalls.toLocaleString()}
                  icon={Download}
                  iconBg="bg-blue-500/10"
                  iconColor="text-blue-600 dark:text-blue-400"
                />
                <MetricCard
                  label="Avg Rating"
                  value={avgRating !== null ? `${avgRating.toFixed(1)} / 5` : "—"}
                  icon={Star}
                  iconBg="bg-yellow-500/10"
                  iconColor="text-yellow-600 dark:text-yellow-400"
                  valueColor="text-yellow-600 dark:text-yellow-400"
                />
              </div>
            )}
          </section>
        )}

        {/* Revenue by Agent + Top Categories */}
        {(isLoading || hasAnyData) && (
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
                {isLoading ? (
                  <div className="space-y-4">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="space-y-1">
                        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
                        <div className="h-3 w-full animate-pulse rounded-full bg-muted" />
                      </div>
                    ))}
                  </div>
                ) : revenueByAgent.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    No revenue data yet
                  </p>
                ) : (
                  <div className="space-y-4">
                    {revenueByAgent.map((item) => {
                      const widthPct = Math.round(
                        (item.totalRevenueCents / maxAgentRevenue) * 100
                      );
                      const agentName = item.listing?.title ?? item.listingId;
                      const revenueDisplay = `$${(item.totalRevenueCents / 100).toLocaleString()}`;
                      return (
                        <div key={item.listingId}>
                          <div className="mb-1 flex items-center justify-between text-sm">
                            <span className="font-medium text-foreground">
                              {agentName}
                            </span>
                            <span className="font-semibold text-green-600 dark:text-green-400">
                              {revenueDisplay}
                            </span>
                          </div>
                          <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary-500 transition-all"
                              style={{ width: `${widthPct}%` }}
                              title={revenueDisplay}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
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
                {isLoading ? (
                  <div className="space-y-4">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="space-y-1">
                        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
                        <div className="h-3 w-full animate-pulse rounded-full bg-muted" />
                      </div>
                    ))}
                  </div>
                ) : categoryBreakdown.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    No category data yet
                  </p>
                ) : (
                  <>
                    <div className="space-y-4">
                      {categoryBreakdown.map(({ name, pct, color }) => (
                        <div key={name}>
                          <div className="mb-1 flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                              <span
                                className={`h-3 w-3 rounded-full ${color}`}
                                aria-hidden="true"
                              />
                              <span className="font-medium text-foreground">
                                {name}
                              </span>
                            </div>
                            <span className="font-semibold text-foreground">
                              {pct}%
                            </span>
                          </div>
                          <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className={`h-full rounded-full ${color} transition-all`}
                              style={{ width: `${pct}%` }}
                              title={`${name}: ${pct}%`}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="mt-4 text-xs text-muted-foreground">
                      Based on total installs across all published agents
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Activity / Install Growth — 30-day vertical bar chart from analytics timeseries */}
        {(isLoading || hasAnyData) && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-green-500" />
                Request Activity (Last 30 Days)
              </CardTitle>
              <CardDescription>
                Daily request volume across all your marketplace listings
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="h-40 animate-pulse rounded bg-muted" />
              ) : timeseries.length === 0 ? (
                <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                  No activity data for this period
                </div>
              ) : (
                <>
                  <div className="flex h-40 items-end gap-px sm:gap-1">
                    {timeseries.map((point, index) => {
                      const heightPct = Math.round((point.requests / maxActivity) * 100);
                      const dayNum = index + 1;
                      return (
                        <div
                          key={index}
                          className="group relative flex flex-1 flex-col items-center"
                        >
                          <span className="pointer-events-none absolute bottom-full mb-1 hidden whitespace-nowrap rounded bg-gray-900 px-1.5 py-0.5 text-xs text-white group-hover:block dark:bg-gray-100 dark:text-gray-900">
                            Day {dayNum}: {point.requests}
                          </span>
                          <div
                            className="w-full rounded-t bg-blue-500 transition-all hover:bg-blue-400"
                            style={{ height: `${heightPct}%` }}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-2 flex">
                    {timeseries.map((_, index) => {
                      const dayNum = index + 1;
                      const showLabel = dayNum === 1 || dayNum % 5 === 0;
                      return (
                        <div key={index} className="flex-1 text-center">
                          {showLabel && (
                            <span className="text-xs text-muted-foreground">
                              {dayNum}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-center text-xs text-muted-foreground">
                    Day of period
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
