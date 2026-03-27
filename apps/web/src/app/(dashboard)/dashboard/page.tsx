"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Box, Bot, Cpu, Zap, DollarSign, ArrowRight } from "lucide-react";
import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deploymentsApi, billingApi, modelsApi, type Deployment } from "@/lib/api";

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
}

const statusColors: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  running: "success",
  provisioning: "warning",
  pending: "secondary",
  degraded: "warning",
  stopped: "secondary",
  failed: "destructive",
};

export default function DashboardPage() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [creditBalance, setCreditBalance] = useState(0);
  const [totalRequests, setTotalRequests] = useState(0);
  const [modelCount, setModelCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const [deploymentsData, balanceData, usageData, modelsData] = await Promise.all([
          deploymentsApi.list(),
          billingApi.getBalance().catch(() => ({ balance: { available: 0 } })),
          billingApi.getUsage().catch(() => ({ usage: { requests: 0 } })),
          modelsApi.list().catch(() => ({ models: [] })),
        ]);
        setDeployments(deploymentsData.deployments);
        setCreditBalance(balanceData.balance.available);
        setTotalRequests(usageData.usage.requests);
        setModelCount(modelsData.models.length);
      } catch (error) {
        console.error("Failed to load dashboard data:", error);
      } finally {
        setIsLoading(false);
      }
    }
    loadData();
  }, []);

  const runningDeployments = deployments.filter((d) => d.status === "running");

  return (
    <div className="flex flex-col">
      <Header
        title="Dashboard"
        description="Overview of your AI deployments and usage"
        action={{ label: "New Deployment", href: "/dashboard/deployments/new" }}
      />

      <div className="p-8">
        {/* Stats */}
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Active Deployments
              </CardTitle>
              <Box className="h-4 w-4 text-gray-400 dark:text-gray-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{runningDeployments.length}</div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {deployments.length} total deployments
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Requests (24h)
              </CardTitle>
              <Zap className="h-4 w-4 text-gray-400 dark:text-gray-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatNumber(totalRequests)}</div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Across all deployments</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Credit Balance
              </CardTitle>
              <DollarSign className="h-4 w-4 text-gray-400 dark:text-gray-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(creditBalance)}</div>
              <Link
                href="/dashboard/billing"
                className="text-xs text-primary-600 hover:underline"
              >
                Add credits
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-gray-500 dark:text-gray-400">
                Total Agents
              </CardTitle>
              <Bot className="h-4 w-4 text-gray-400 dark:text-gray-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{modelCount || 0}</div>
              <Link
                href="/dashboard/agents"
                className="text-xs text-primary-600 hover:underline"
              >
                Manage agents
              </Link>
            </CardContent>
          </Card>
        </div>

        {/* Recent Deployments */}
        <div className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Recent Deployments
            </h2>
            <Link
              href="/dashboard/deployments"
              className="text-sm text-primary-600 hover:underline"
            >
              View all
            </Link>
          </div>

          {isLoading ? (
            <div className="mt-4 space-y-4">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-20 animate-pulse rounded-lg bg-gray-200 dark:bg-gray-800"
                />
              ))}
            </div>
          ) : deployments.length === 0 ? (
            <Card className="mt-4">
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Box className="h-12 w-12 text-gray-300 dark:text-gray-600" />
                <h3 className="mt-4 text-lg font-medium text-gray-900 dark:text-gray-100">
                  No deployments yet
                </h3>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  Deploy your first model to get started
                </p>
                <Link href="/dashboard/deployments/new" className="mt-4">
                  <Button>
                    <Cpu className="mr-2 h-4 w-4" />
                    Deploy a Model
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            <div className="mt-4 space-y-4">
              {deployments.slice(0, 5).map((deployment) => (
                <Link
                  key={deployment.id}
                  href={`/dashboard/deployments/${deployment.id}`}
                >
                  <Card className="transition-shadow hover:shadow-md">
                    <CardContent className="flex items-center justify-between py-4">
                      <div className="flex items-center gap-4">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-100 dark:bg-primary-900/30">
                          <Cpu className="h-5 w-5 text-primary-600 dark:text-primary-400" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-gray-900 dark:text-gray-100">
                              {deployment.name}
                            </span>
                            <Badge variant={statusColors[deployment.status]}>
                              {deployment.status}
                            </Badge>
                          </div>
                          <p className="text-sm text-gray-500 dark:text-gray-400">
                            {deployment.model} on {deployment.gpuTier}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        {deployment.endpoint && (
                          <code className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                            {deployment.endpoint}
                          </code>
                        )}
                        <ArrowRight className="h-5 w-5 text-gray-400" />
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Quick Actions</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <Link href="/dashboard/deployments/new">
              <Card className="cursor-pointer transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-4 py-6">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary-100 dark:bg-primary-900/30">
                    <Cpu className="h-6 w-6 text-primary-600 dark:text-primary-400" />
                  </div>
                  <div>
                    <h3 className="font-medium text-gray-900 dark:text-gray-100">Deploy Model</h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Launch a new inference endpoint
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>

            <Link href="/dashboard/keys">
              <Card className="cursor-pointer transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-4 py-6">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-green-100 dark:bg-green-900/30">
                    <Zap className="h-6 w-6 text-green-600 dark:text-green-400" />
                  </div>
                  <div>
                    <h3 className="font-medium text-gray-900 dark:text-gray-100">Create API Key</h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Get credentials for your apps
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>

            <Link href="/dashboard/playground">
              <Card className="cursor-pointer transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-4 py-6">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-purple-100 dark:bg-purple-900/30">
                    <Box className="h-6 w-6 text-purple-600 dark:text-purple-400" />
                  </div>
                  <div>
                    <h3 className="font-medium text-gray-900 dark:text-gray-100">Open Playground</h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Test your models interactively
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
