"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { OpenClawStatus } from "@/components/dashboard/openclaw-status";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
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
import { getErrorMessage } from "@/lib/api";
import { useConfirm } from "@/components/ui/confirm-dialog";

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

function StatCardSkeleton() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-4" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-12" />
      </CardContent>
    </Card>
  );
}

function DeploymentCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-5 w-8 rounded-full" />
        </div>
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-1/3" />
        </div>
        <Skeleton className="h-3 w-28" />
        <div className="flex items-center gap-2 border-t border-border pt-2">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 w-10" />
          <Skeleton className="h-9 w-10" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function OpenClawDeploymentsPage() {
  const confirmAction = useConfirm();
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

  // Must keep a stable identity: usePolling re-subscribes and fetches again
  // whenever onError changes, so an inline arrow refetched on every render
  // (and repeated the error toast in a loop) instead of every 30s.
  const handleLoadError = useCallback((err: Error) => {
    toast.error(getErrorMessage(err, "Failed to load deployments"));
  }, []);

  const {
    data,
    isLoading: loading,
    error: loadError,
    refresh: refreshDeployments,
  } = usePolling<DeploymentListData>({
    fetcher,
    interval: 30_000,
    onError: handleLoadError,
  });

  // "Try again" on the load error shows the skeleton until the retry settles.
  const [retrying, setRetrying] = useState(false);
  const retryLoad = async () => {
    setRetrying(true);
    await refreshDeployments();
    setRetrying(false);
  };

  const showSkeleton = loading || retrying;
  // Only a failed first load replaces the page; a failed background poll
  // keeps the last good list on screen (the toast still reports it).
  const showLoadError = !data && loadError !== null;

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
      toast.error(getErrorMessage(error, `Failed to ${action} deployment`));
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
        {/* Stats Bar (hidden after a failed load: zeros would be misleading) */}
        {showSkeleton ? (
          <div className="grid gap-4 md:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <StatCardSkeleton key={i} />
            ))}
          </div>
        ) : !showLoadError ? (
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
                <Square className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-muted-foreground">
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
        ) : null}

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
        {showSkeleton ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3" aria-busy="true">
            <span className="sr-only">Loading deployments</span>
            {Array.from({ length: 6 }).map((_, i) => (
              <DeploymentCardSkeleton key={i} />
            ))}
          </div>
        ) : showLoadError ? (
          <ErrorState
            title="Couldn't load deployments"
            error={loadError}
            onRetry={() => void retryLoad()}
          />
        ) : deployments.length === 0 ? (
          <EmptyState
            icon={Server}
            title="No deployments yet"
            description="Get started by creating your first OpenClaw deployment. Deploy AI agents with multi-channel support across Discord, Telegram, Slack, and more."
            actionLabel="Create Deployment"
            actionHref="/dashboard/openclaw/new"
          />
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
                      className="text-red-600 hover:text-red-500 hover:bg-red-500/10"
                      onClick={async (e) => {
                        e.stopPropagation();
                        const ok = await confirmAction({
                          title: `Delete "${deployment.agentName}"?`,
                          description: "The deployment is stopped and removed. This cannot be undone.",
                          confirmLabel: "Delete",
                          destructive: true,
                        });
                        if (ok) handleAction(deployment.id, "delete");
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
