"use client";

import { useEffect, useState } from "react";
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
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { agentsApi, type AgentDetail } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  OverviewTab,
  DeploymentsTab,
  VersionsTab,
  CodeTab,
  LogsTab,
  SettingsTab,
  type DeployConfig,
} from "@/components/dashboard/agent-tabs";

const frameworkColors: Record<string, string> = {
  mastra: "bg-purple-100 text-purple-700",
  langchain: "bg-green-100 text-green-700",
  autogen: "bg-blue-100 text-blue-700",
  custom: "bg-gray-100 text-gray-700",
};

const statusColors: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  running: "success",
  building: "warning",
  deploying: "warning",
  pending: "secondary",
  stopped: "secondary",
  failed: "destructive",
};

type Tab = "overview" | "deployments" | "versions" | "code" | "logs" | "settings";

export default function AgentDetailPage() {
  const params = useParams();
  const agentId = params.id as string;

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [isDeploying, setIsDeploying] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [deployConfig, setDeployConfig] = useState<DeployConfig>({
    gpuTier: "rtx-4070", // default: Standard tier (~$0.35/hr, Recommended)
    replicas: 1,
    enableWallet: false,
    dailyLimitCents: 1000,
  });

  async function loadAgent() {
    try {
      const { agent } = await agentsApi.get(agentId);
      setAgent(agent);
    } catch (error) {
      toast.error("Failed to load agent");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadAgent();
  }, [agentId]);

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
      toast.error("Failed to deploy agent");
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
      toast.error("Failed to stop deployment");
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
        <div className="p-8">
          <div className="h-96 animate-pulse rounded-lg bg-gray-200" />
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
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary-100">
                  <Bot className="h-6 w-6 text-primary-600" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className={cn("rounded px-2 py-0.5 text-xs font-medium", frameworkColors[agent.framework])}>
                      {agent.framework}
                    </span>
                    <span className="text-sm text-gray-500">v{agent.version}</span>
                    {latestDeployment && (
                      <Badge variant={statusColors[latestDeployment.status]}>
                        {latestDeployment.status}
                      </Badge>
                    )}
                  </div>
                  {latestDeployment?.endpoint && (
                    <div className="mt-1 flex items-center gap-2">
                      <code className="text-sm text-gray-600">{latestDeployment.endpoint}</code>
                      <button onClick={() => copyToClipboard(latestDeployment.endpoint!)}>
                        <Copy className="h-4 w-4 text-gray-400 hover:text-gray-600" />
                      </button>
                    </div>
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
          {(["overview", "deployments", "versions", "code", "logs", "settings"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "border-b-2 px-4 py-2 text-sm font-medium transition-colors",
                activeTab === tab
                  ? "border-primary-500 text-primary-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              )}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
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
