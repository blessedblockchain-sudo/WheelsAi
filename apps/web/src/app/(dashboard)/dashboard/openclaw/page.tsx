"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { OpenClawStatus } from "@/components/dashboard/openclaw-status";
import { usePolling } from "@/lib/use-polling";
import {
  Play,
  Square,
  RotateCw,
  Trash2,
  Plus,
  Server,
  Activity,
  AlertCircle,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

interface OpenClawDeployment {
  id: string;
  agentName: string;
  slug: string;
  description?: string;
  status: string;
  healthStatus?: string | null;
  channelCount: number;
  publicUrl?: string | null;
  createdAt: string;
  modelConfig?: {
    model?: string;
  };
}

interface DeploymentStats {
  total: number;
  running: number;
  stopped: number;
  failed: number;
}

interface DeploymentListData {
  deployments: OpenClawDeployment[];
  stats: DeploymentStats;
}

function formatRelativeTime(date: Date): string {
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}

function useRelativeTime(date: Date | null): string {
  const [label, setLabel] = useState("just now");

  useEffect(() => {
    if (!date) return;

    const update = () => {
      const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
      if (diffSec < 5) setLabel("just now");
      else if (diffSec < 60) setLabel(`${diffSec}s ago`);
      else setLabel(`${Math.floor(diffSec / 60)}m ago`);
    };

    update();
    const id = setInterval(update, 10_000);
    return () => clearInterval(id);
  }, [date]);

  return label;
}

export default function OpenClawDeploymentsPage() {
  const router = useRouter();
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const updatedLabel = useRelativeTime(lastUpdated);

  const fetcher = useCallback(async (): Promise<DeploymentListData> => {
    const response = await fetch(`${API_URL}/api/openclaw/deployments`, {
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error("Failed to fetch deployments");
    }

    const data = await response.json();
    const deployments: OpenClawDeployment[] = data.deployments || [];

    const stats: DeploymentStats = {
      total: deployments.length,
      running: deployments.filter((d) => d.status === "RUNNING").length,
      stopped: deployments.filter((d) => d.status === "STOPPED").length,
      failed: deployments.filter((d) => d.status === "FAILED").length,
    };

    setLastUpdated(new Date());
    return { deployments, stats };
  }, []);

  const { data, isLoading: loading, refresh: refreshDeployments } = usePolling<DeploymentListData>({
    fetcher,
    interval: 30_000,
    onError: () => {
      toast.error("Failed to load deployments");
    },
  });

  const deployments = data?.deployments ?? [];
  const stats = data?.stats ?? { total: 0, running: 0, stopped: 0, failed: 0 };

  const handleAction = async (
    deploymentId: string,
    action: "start" | "stop" | "restart" | "delete"
  ) => {
    try {
      setActionLoading(deploymentId);

      const endpoint =
        action === "delete"
          ? `${API_URL}/api/openclaw/deployments/${deploymentId}`
          : `${API_URL}/api/openclaw/deployments/${deploymentId}/${action}`;

      const response = await fetch(endpoint, {
        method: action === "delete" ? "DELETE" : "POST",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`Failed to ${action} deployment`);
      }

      toast.success(`Deployment ${action === "delete" ? "deleted" : action + "ed"} successfully`);
      await refreshDeployments();
    } catch (error) {
      console.error(`Error ${action}ing deployment:`, error);
      toast.error(`Failed to ${action} deployment`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleViewDetails = (deploymentId: string) => {
    router.push(`/dashboard/openclaw/${deploymentId}`);
  };

  return (
    <div className="flex flex-col">
      <Header
        title="OpenClaw Deployments"
        description="Manage your AI agent deployments with multi-channel support"
        action={{ label: "New Deployment", href: "/dashboard/openclaw/new" }}
      />

      <div className="p-8 space-y-6">
        {/* Stats Bar */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Deployments</CardTitle>
              <Server className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Running</CardTitle>
              <Activity className="h-4 w-4 text-green-600 dark:text-green-400" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                {stats.running}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Stopped</CardTitle>
              <Square className="h-4 w-4 text-gray-600 dark:text-gray-400" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-gray-600 dark:text-gray-400">
                {stats.stopped}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Failed</CardTitle>
              <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600 dark:text-red-400">
                {stats.failed}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Last updated indicator */}
        {lastUpdated && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary/60 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary/80" />
            </span>
            Updated {updatedLabel} &middot; auto-refreshes every 30s
          </div>
        )}

        {/* Deployments Grid */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
              <p className="mt-4 text-sm text-muted-foreground">Loading deployments...</p>
            </div>
          </div>
        ) : deployments.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Server className="h-16 w-16 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No deployments yet</h3>
              <p className="text-sm text-muted-foreground mb-6 text-center max-w-md">
                Get started by creating your first OpenClaw deployment. Deploy AI agents with
                multi-channel support across Discord, Telegram, Slack, and more.
              </p>
              <Button onClick={() => router.push("/dashboard/openclaw/new")}>
                <Plus className="mr-2 h-4 w-4" />
                Create Deployment
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {deployments.map((deployment) => (
              <Card
                key={deployment.id}
                className="hover:shadow-lg transition-shadow cursor-pointer"
                onClick={() => handleViewDetails(deployment.id)}
              >
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="space-y-1 flex-1">
                      <CardTitle className="text-lg">{deployment.agentName}</CardTitle>
                      <CardDescription className="text-xs font-mono">
                        /{deployment.slug}
                      </CardDescription>
                    </div>
                    <OpenClawStatus
                      status={deployment.status}
                      healthStatus={deployment.healthStatus}
                    />
                  </div>
                  {deployment.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2 mt-2">
                      {deployment.description}
                    </p>
                  )}
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Channels:</span>
                    <Badge variant="secondary">{deployment.channelCount}</Badge>
                  </div>

                  {deployment.modelConfig?.model && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Model:</span>
                      <span className="font-mono text-xs">{deployment.modelConfig.model}</span>
                    </div>
                  )}

                  {deployment.publicUrl && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">URL:</span>
                      <a
                        href={deployment.publicUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline flex items-center gap-1 truncate flex-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="truncate">{deployment.publicUrl}</span>
                        <ExternalLink className="h-3 w-3 flex-shrink-0" />
                      </a>
                    </div>
                  )}

                  <div className="text-xs text-muted-foreground">
                    Created {new Date(deployment.createdAt).toLocaleDateString()}
                  </div>

                  {/* Action Buttons */}
                  <div
                    className="flex items-center gap-2 pt-2 border-t"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {deployment.status === "STOPPED" || deployment.status === "FAILED" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAction(deployment.id, "start");
                        }}
                        disabled={actionLoading === deployment.id}
                      >
                        <Play className="mr-1 h-3 w-3" />
                        Start
                      </Button>
                    ) : deployment.status === "RUNNING" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAction(deployment.id, "stop");
                        }}
                        disabled={actionLoading === deployment.id}
                      >
                        <Square className="mr-1 h-3 w-3" />
                        Stop
                      </Button>
                    ) : null}

                    {deployment.status === "RUNNING" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAction(deployment.id, "restart");
                        }}
                        disabled={actionLoading === deployment.id}
                      >
                        <RotateCw className="h-3 w-3" />
                      </Button>
                    )}

                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (
                          confirm(`Are you sure you want to delete "${deployment.agentName}"?`)
                        ) {
                          handleAction(deployment.id, "delete");
                        }
                      }}
                      disabled={actionLoading === deployment.id}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
