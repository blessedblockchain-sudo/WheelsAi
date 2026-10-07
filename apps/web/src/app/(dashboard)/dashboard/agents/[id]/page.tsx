"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  Bot,
  Play,
  Square,
  RefreshCw,
  Copy,
  MessageCircle,
  Workflow,
  BarChart3,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { agentsApi, ApiError, type AgentDetail, getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  OverviewTab,
  ApiTab,
  DeploymentsTab,
  VersionsTab,
  CodeTab,
  LogsTab,
  SettingsTab,
  type DeployConfig,
} from "@/components/dashboard/agent-tabs";

const frameworkColors: Record<string, string> = {
  mastra: "bg-purple-500/10 text-purple-500",
  langchain: "bg-green-500/10 text-green-500",
  autogen: "bg-blue-500/10 text-blue-500",
  custom: "bg-muted text-foreground",
};

const statusColors: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  running: "success",
  building: "warning",
  deploying: "warning",
  pending: "secondary",
  stopped: "secondary",
  failed: "destructive",
};

type Tab = "overview" | "api" | "deployments" | "versions" | "code" | "logs" | "settings";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "api", label: "API" },
  { id: "deployments", label: "Deployments" },
  { id: "versions", label: "Versions" },
  { id: "code", label: "Code" },
  { id: "logs", label: "Logs" },
  { id: "settings", label: "Settings" },
];

/**
 * The API answers 404 for an agent outside this workspace and 400 for an id
 * that is not a UUID. Both mean there is no such agent, so the page says so
 * rather than offering a retry that cannot succeed.
 */
function isMissingAgent(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 400);
}

/** Placeholder in the shape of the loaded page: status bar, tab bar, Overview cards. */
function AgentDetailSkeleton() {
  return (
    <div className="p-8" aria-busy="true">
      <Card className="mb-6">
        <CardContent className="py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <Skeleton className="h-12 w-12 rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-5 w-44" />
                <Skeleton className="h-4 w-64" />
              </div>
            </div>
            <div className="flex gap-2">
              {["w-32", "w-36", "w-28", "w-32", "w-24", "w-12"].map((width, i) => (
                <Skeleton key={i} className={cn("h-10", width)} />
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mb-6 flex gap-2 border-b">
        {Array.from({ length: TABS.length }).map((_, i) => (
          <div key={i} className="border-b-2 border-transparent px-4 py-2">
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-32" />
            </CardHeader>
            <CardContent className="space-y-4">
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-5 w-40" />
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
        <Card className="md:col-span-2">
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      </div>
      <span className="sr-only">Loading agent</span>
    </div>
  );
}

export default function AgentDetailPage() {
  const params = useParams();
  const agentId = params.id as string;

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [isDeploying, setIsDeploying] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [deployConfig, setDeployConfig] = useState<DeployConfig>({
    gpuTier: "rtx-4070", // default: Standard tier (~$0.35/hr, Recommended)
    replicas: 1,
    enableWallet: false,
    dailyLimitCents: 1000,
  });

  // Also the background refresh after deploy/stop and in the tabs: a failed
  // refresh keeps the agent on screen (toast only); loadError replaces the
  // page only while no agent has loaded yet.
  const loadAgent = useCallback(async () => {
    try {
      const { agent } = await agentsApi.get(agentId);
      setAgent(agent);
      setLoadError(null);
    } catch (error) {
      setLoadError(error);
      toast.error(getErrorMessage(error, "Failed to load agent"));
    } finally {
      setIsLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    loadAgent();
  }, [loadAgent]);

  /** "Try again" on the error state: back to the skeleton while it reloads. */
  function retryLoad() {
    setLoadError(null);
    setIsLoading(true);
    void loadAgent();
  }

  async function handleDeploy() {
    setIsDeploying(true);
    try {
      await agentsApi.deploy(agentId, {
        gpuTier: deployConfig.gpuTier,
        replicas: deployConfig.replicas,
        enableWallet: deployConfig.enableWallet,
        walletConfig: deployConfig.enableWallet
          ? { dailyLimitCents: deployConfig.dailyLimitCents }
          : undefined,
      });
      toast.success("Deployment started");
      loadAgent();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to deploy agent"));
    } finally {
      setIsDeploying(false);
    }
  }

  async function handleStop(deploymentId: string) {
    setIsStopping(true);
    try {
      await agentsApi.stopDeployment(agentId, deploymentId);
      toast.success("Deployment stopped");
      loadAgent();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to stop deployment"));
    } finally {
      setIsStopping(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  }

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <Header title="Loading..." />
        <AgentDetailSkeleton />
      </div>
    );
  }

  if (!agent) {
    if (loadError !== null && !isMissingAgent(loadError)) {
      return (
        <div className="flex flex-col">
          <Header title="Agent" />
          <div className="p-8">
            <ErrorState
              title="Couldn't load agent"
              error={loadError}
              onRetry={retryLoad}
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

  const latestDeployment = agent.deployments?.[0];
  const isRunning = latestDeployment?.status === "running";

  return (
    <div className="flex flex-col">
      <Header
        title={agent.name}
        description={agent.description || `${agent.framework} agent`}
      />

      <div className="p-8">
        {/* Status bar */}
        <Card className="mb-6">
          <CardContent className="py-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/15">
                  <Bot className="h-6 w-6 text-primary-600" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className={cn("rounded px-2 py-0.5 text-xs font-medium", frameworkColors[agent.framework])}>
                      {agent.framework}
                    </span>
                    <span className="text-sm text-muted-foreground">v{agent.version}</span>
                    {latestDeployment && (
                      <Badge variant={statusColors[latestDeployment.status]}>
                        {latestDeployment.status}
                      </Badge>
                    )}
                  </div>
                  {/* The agent's /v1 endpoint is served by the platform API
                      whether or not a deployment is running. */}
                  {agent.apiEndpoint ? (
                    <div className="mt-1 flex items-center gap-2">
                      <code className="text-sm text-muted-foreground">{agent.apiEndpoint}</code>
                      <button
                        onClick={() => copyToClipboard(agent.apiEndpoint!)}
                        aria-label="Copy API endpoint"
                      >
                        <Copy className="h-4 w-4 text-muted-foreground hover:text-foreground" />
                      </button>
                    </div>
                  ) : (
                    <p className="mt-1 text-sm text-muted-foreground">
                      Endpoint address unavailable right now
                    </p>
                  )}
                </div>
              </div>

              <div className="flex gap-2">
                <Link href={`/dashboard/agents/${agentId}/playground`}>
                  <Button variant="outline">
                    <MessageCircle className="mr-2 h-4 w-4" />
                    Playground
                  </Button>
                </Link>
                <Link href={`/dashboard/agents/${agentId}/builder`}>
                  <Button variant="outline">
                    <Workflow className="mr-2 h-4 w-4" />
                    Visual Builder
                  </Button>
                </Link>
                <Link href={`/dashboard/agents/${agentId}/analytics`}>
                  <Button variant="outline">
                    <BarChart3 className="mr-2 h-4 w-4" />
                    Analytics
                  </Button>
                </Link>
                <Link href={`/dashboard/agents/${agentId}/contributors`}>
                  <Button variant="outline">
                    <Users className="mr-2 h-4 w-4" />
                    Contributors
                  </Button>
                </Link>
                {isRunning ? (
                  <Button
                    variant="destructive"
                    onClick={() => handleStop(latestDeployment.id)}
                    isLoading={isStopping}
                  >
                    <Square className="mr-2 h-4 w-4" />
                    Stop
                  </Button>
                ) : (
                  <Button onClick={handleDeploy} isLoading={isDeploying}>
                    <Play className="mr-2 h-4 w-4" />
                    Deploy
                  </Button>
                )}
                <Button variant="outline" onClick={loadAgent}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Tabs */}
        <div className="mb-6 flex gap-2 border-b">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                activeTab === tab.id
                  ? "border-primary-500 text-primary-600"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === "overview" && (
          <OverviewTab
            agent={agent}
            agentId={agentId}
            loadAgent={loadAgent}
            deployConfig={deployConfig}
            setDeployConfig={setDeployConfig}
          />
        )}
        {activeTab === "api" && (
          <ApiTab agent={agent} agentId={agentId} loadAgent={loadAgent} />
        )}
        {activeTab === "deployments" && (
          <DeploymentsTab agent={agent} agentId={agentId} loadAgent={loadAgent} />
        )}
        {activeTab === "versions" && (
          <VersionsTab agent={agent} agentId={agentId} loadAgent={loadAgent} />
        )}
        {activeTab === "code" && (
          <CodeTab agent={agent} agentId={agentId} loadAgent={loadAgent} />
        )}
        {activeTab === "logs" && (
          <LogsTab agent={agent} agentId={agentId} loadAgent={loadAgent} />
        )}
        {activeTab === "settings" && (
          <SettingsTab agent={agent} agentId={agentId} loadAgent={loadAgent} />
        )}
      </div>
    </div>
  );
}
