"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Box, Bot, Cpu, Zap, DollarSign, ArrowRight } from "lucide-react";
import { Header } from "@/components/dashboard/header";
import { GetStarted } from "@/components/dashboard/get-started";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { NEW_AGENT_BUTTON } from "@/lib/nav";
import {
  agentsApi,
  deploymentsApi,
  billingApi,
  capabilitiesApi,
  type Agent,
  type BillingRails,
  type Deployment,
} from "@/lib/api";
import { canAddCredits, cutOffByLeaving } from "@/lib/home";

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
  // loads); Your agents then says so instead of showing nothing.
  const [agentsError, setAgentsError] = useState<unknown>(null);
  // What can happen right now, read once. null means the answer could not be
  // read, and Home then promises nothing about email or about paying.
  const [emailDelivery, setEmailDelivery] = useState<boolean | null>(null);
  const [rails, setRails] = useState<BillingRails | null>(null);
  // True once the person is leaving Home: a request the browser drops then is
  // not a failure, and is neither shown nor written to the console.
  const leaving = useRef(false);

  async function loadData() {
    try {
      const [agentsData, deploymentsData, balanceData, usageData, capabilities, packages] = await Promise.all([
        agentsApi.list().catch((error: unknown) => {
          setAgentsError(error);
          return { agents: [], total: 0 };
        }),
        deploymentsApi.list(),
        billingApi.getBalance().catch(() => ({ balance: { available: 0 } })),
        billingApi.getUsage().catch(() => ({ usage: { requests: 0 } })),
        capabilitiesApi.get().catch(() => null),
        billingApi.getPackages().catch(() => null),
      ]);
      // An answer that arrived is drawn even if a leave was started: the
      // person may still be here (a leave that was cancelled).
      setAgents(agentsData.agents);
      setAgentTotal(agentsData.total);
      setDeployments(deploymentsData.deployments);
      setCreditBalance(balanceData.balance.available);
      setTotalRequests(usageData.usage.requests);
      setEmailDelivery(capabilities ? capabilities.emailDelivery?.available === true : null);
      setRails(packages?.rails ?? null);
      setIsLoading(false);
    } catch (error) {
      // Cut off by leaving the page: nothing to show, and nothing to log.
      if (cutOffByLeaving(error, leaving.current)) return;
      setLoadError(error);
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
    leaving.current = false;
    const leave = () => {
      leaving.current = true;
    };
    // Back on the page (a cancelled leave, or a return from the back cache).
    const stay = () => {
      leaving.current = false;
    };
    window.addEventListener("beforeunload", leave);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", stay);
    loadData();
    return () => {
      leaving.current = true;
      window.removeEventListener("beforeunload", leave);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", stay);
    };
    // Loads once, when Home opens.
  }, []);

  const runningDeployments = deployments.filter((d) => d.status === "running");

  return (
    <div className="flex flex-col">
      <Header
        title="Home"
        description="Build, deploy and monetize your agents, workflows and models"
        action={NEW_AGENT_BUTTON}
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
            {/* Creating an agent leads; then the person's agents, the two
                other things to build, and the checklist of what is next. */}
            <GetStarted
              agents={isLoading || agentsError !== null ? null : agents}
              agentsLoading={isLoading}
              agentsError={agentsError}
              onRetry={retryLoad}
              creditCents={Math.round(creditBalance * 100)}
              emailDelivery={emailDelivery}
              rails={rails}
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
                    {canAddCredits(rails) ? "Add credits" : "View billing"}
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
                            <ArrowRight className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
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
            <Link href={NEW_AGENT_BUTTON.href}>
              <Card className="cursor-pointer transition-shadow hover:shadow-md">
                <CardContent className="flex items-center gap-4 py-6">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/15">
                    <Bot className="h-6 w-6 text-primary-600 dark:text-primary-400" />
                  </div>
                  <div>
                    <h3 className="font-medium text-foreground">{NEW_AGENT_BUTTON.label}</h3>
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
