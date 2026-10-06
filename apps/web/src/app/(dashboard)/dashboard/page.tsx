"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Box, Bot, Cpu, Zap, DollarSign, ArrowRight, Github } from "lucide-react";
import { Header } from "@/components/dashboard/header";
import { GetStarted } from "@/components/dashboard/get-started";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  agentsApi,
  deploymentsApi,
  billingApi,
  type Agent,
  type Deployment,
} from "@/lib/api";

const frameworkColors: Record<string, string> = {
  mastra: "bg-purple-500/10 text-purple-500",
  langchain: "bg-green-500/10 text-green-500",
  autogen: "bg-blue-500/10 text-blue-500",
  elizaos: "bg-cyan-500/10 text-cyan-500",
  crewai: "bg-orange-500/10 text-orange-500",
  custom: "bg-muted text-foreground",
};

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

/** Placeholder shaped like one Recent Agents row. */
function AgentRowSkeleton() {
  return (
    <Card>
      <CardContent className="flex items-center justify-between py-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-lg" />
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-16" />
        </div>
        <Skeleton className="h-5 w-5" />
      </CardContent>
    </Card>
  );
}

/** Placeholder shaped like one Recent Deployments row. */
function DeploymentRowSkeleton() {
  return (
    <Card>
      <CardContent className="flex items-center justify-between py-4">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-10 rounded-lg" />
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-4 w-48" />
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Skeleton className="hidden h-6 w-48 md:block" />
          <Skeleton className="h-5 w-5" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentTotal, setAgentTotal] = useState(0);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [creditBalance, setCreditBalance] = useState(0);
  const [totalRequests, setTotalRequests] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  // The agents call is allowed to fail on its own (the rest of the page still
  // loads); Recent Agents then says so instead of claiming there are none.
  const [agentsError, setAgentsError] = useState<unknown>(null);

  async function loadData() {
    try {
      const [agentsData, deploymentsData, balanceData, usageData] = await Promise.all([
        agentsApi.list().catch((error: unknown) => {
          setAgentsError(error);
          return { agents: [], total: 0 };
        }),
        deploymentsApi.list(),
        billingApi.getBalance().catch(() => ({ balance: { available: 0 } })),
        billingApi.getUsage().catch(() => ({ usage: { requests: 0 } })),
      ]);
      setAgents(agentsData.agents);
      setAgentTotal(agentsData.total);
      setDeployments(deploymentsData.deployments);
      setCreditBalance(balanceData.balance.available);
      setTotalRequests(usageData.usage.requests);
    } catch (error) {
      console.error("Failed to load dashboard data:", error);
      setLoadError(error);
    } finally {
      setIsLoading(false);
    }
  }

  function retryLoad() {
    setLoadError(null);
    setAgentsError(null);
    setIsLoading(true);
    loadData();
  }

  useEffect(() => {
    loadData();
  }, []);

  const runningDeployments = deployments.filter((d) => d.status === "running");

  return (
    <div className="flex flex-col">
      <Header
        title="Dashboard"
        description="Build, deploy and monetize your agents, workflows and models"
        action={{ label: "Create Agent", href: "/dashboard/agents/new" }}
      />

      <div className="p-8">
        {loadError !== null ? (
          <ErrorState
            title="Couldn't load your dashboard"
            error={loadError}
            onRetry={retryLoad}
          />
        ) : (
          <>
            {/* Entry points for the three product types, then the first-run
                checklist. BUILD leads the page because BUILD leads. */}
            <GetStarted
              agentCount={agentTotal}
              deploymentCount={deployments.length}
              creditCents={Math.round(creditBalance * 100)}
            />

            {/* Stats */}
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Active Deployments
                  </CardTitle>
                  <Box className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <>
                      <Skeleton className="h-8 w-12" />
                      <Skeleton className="mt-1 h-3 w-28" />
                    </>
                  ) : (
                    <>
                      <div className="text-2xl font-bold">{runningDeployments.length}</div>
                      <p className="text-xs text-muted-foreground">
                        {deployments.length} total deployments
                      </p>
                    </>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Requests (24h)
                  </CardTitle>
                  <Zap className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <Skeleton className="h-8 w-16" />
                  ) : (
                    <div className="text-2xl font-bold">{formatNumber(totalRequests)}</div>
                  )}
                  <p className="text-xs text-muted-foreground">Across all deployments</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Credit Balance
                  </CardTitle>
                  <DollarSign className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <Skeleton className="h-8 w-24" />
                  ) : (
                    <div className="text-2xl font-bold">{formatCurrency(creditBalance)}</div>
                  )}
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
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Total Agents
                  </CardTitle>
                  <Bot className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  {/* Real agent count — this stat used to show the MODEL
                      catalog length (21 for everyone, forever). Unknown
                      ("—") when the agents call failed, never a false 0. */}
                  {isLoading ? (
                    <Skeleton className="h-8 w-12" />
                  ) : (
                    <div className="text-2xl font-bold">
                      {agentsError !== null ? "—" : agentTotal}
                    </div>
                  )}
                  <Link
                    href="/dashboard/agents"
                    className="text-xs text-primary-600 hover:underline"
                  >
                    Manage agents
                  </Link>
                </CardContent>
              </Card>
            </div>

            {/* Recent Agents — first list on the page (BUILD leads) */}
            <div className="mt-8">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-foreground">
                  Recent Agents
                </h2>
                <Link
                  href="/dashboard/agents"
                  className="text-sm text-primary-600 hover:underline"
                >
                  View all
                </Link>
              </div>

              {isLoading ? (
                <div className="mt-4 space-y-3" aria-busy="true">
                  {[1, 2].map((i) => (
                    <AgentRowSkeleton key={i} />
                  ))}
                  <span className="sr-only">Loading agents</span>
                </div>
              ) : agentsError !== null ? (
                <div className="mt-4">
                  <ErrorState
                    title="Couldn't load agents"
                    error={agentsError}
                    onRetry={retryLoad}
                  />
                </div>
              ) : agents.length === 0 ? (
                <div className="mt-4">
                  <EmptyState
                    icon={Bot}
                    title="No agents yet"
                    description="Import one from GitHub or start from a template."
                    actionLabel="Create Agent"
                    actionHref="/dashboard/agents/new"
                  />
                </div>
              ) : (
                <div className="mt-4 space-y-3">
                  {agents.slice(0, 5).map((agent) => (
                    <Link key={agent.id} href={`/dashboard/agents/${agent.id}`}>
                      <Card className="transition-shadow hover:shadow-md">
                        <CardContent className="flex items-center justify-between py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15">
                              <Bot className="h-5 w-5 text-primary-600 dark:text-primary-400" />
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-foreground">
                                {agent.name}
                              </span>
                              <span
                                className={`rounded px-2 py-0.5 text-xs font-medium ${
                                  frameworkColors[agent.framework] ?? frameworkColors.custom
                                }`}
                              >
                                {agent.framework}
                              </span>
                            </div>
                          </div>
                          <ArrowRight className="h-5 w-5 text-gray-400" />
                        </CardContent>
                      </Card>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            {/* Recent Deployments */}
            <div className="mt-8">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-foreground">
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
                <div className="mt-4 space-y-4" aria-busy="true">
                  {[1, 2, 3].map((i) => (
                    <DeploymentRowSkeleton key={i} />
                  ))}
                  <span className="sr-only">Loading deployments</span>
                </div>
              ) : deployments.length === 0 ? (
                <div className="mt-4">
                  <EmptyState
                    icon={Box}
                    title="No deployments yet"
                    description="Deploy your first model to get started."
                    actionLabel="Deploy a Model"
                    actionHref="/dashboard/deployments/new"
                  />
                </div>
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
                            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
                              <Cpu className="h-5 w-5 text-primary-600 dark:text-primary-400" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-foreground">
                                  {deployment.name}
                                </span>
                                <Badge variant={statusColors[deployment.status]}>
                                  {deployment.status}
                                </Badge>
                              </div>
                              <p className="text-sm text-muted-foreground">
                                {deployment.model} on {deployment.gpuTier}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-4">
                            {deployment.endpoint && (
                              <code className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
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
          </>
        )}

        {/* Quick Actions */}
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-foreground">Quick Actions</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Link href="/dashboard/agents/new">
              <Card className="cursor-pointer transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-4 py-6">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/15">
                    <Bot className="h-6 w-6 text-primary-600 dark:text-primary-400" />
                  </div>
                  <div>
                    <h3 className="font-medium text-foreground">Create Agent</h3>
                    <p className="text-sm text-muted-foreground">
                      Import from GitHub or start fresh
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>

            <Link href="/dashboard/deployments/new">
              <Card className="cursor-pointer transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-4 py-6">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-500/10">
                    <Cpu className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div>
                    <h3 className="font-medium text-foreground">Deploy Model</h3>
                    <p className="text-sm text-muted-foreground">
                      GPU inference on Nosana
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>

            <Link href="/dashboard/keys">
              <Card className="cursor-pointer transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-4 py-6">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-green-500/10">
                    <Zap className="h-6 w-6 text-green-600 dark:text-green-400" />
                  </div>
                  <div>
                    <h3 className="font-medium text-foreground">Create API Key</h3>
                    <p className="text-sm text-muted-foreground">
                      Get credentials for your apps
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>

            <Link href="/dashboard/playground">
              <Card className="cursor-pointer transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-4 py-6">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-purple-500/10">
                    <Box className="h-6 w-6 text-purple-600 dark:text-purple-400" />
                  </div>
                  <div>
                    <h3 className="font-medium text-foreground">Open Playground</h3>
                    <p className="text-sm text-muted-foreground">
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
