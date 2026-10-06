"use client";

import { useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
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
  ExternalLink,
  Copy,
  CheckCircle2,
  Server,
  Cpu,
  HardDrive,
  Globe,
  Settings,
  Plug,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getErrorMessage } from "@/lib/api";
import { useConfirm } from "@/components/ui/confirm-dialog";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

interface Channel {
  id: string;
  platform: string;
  enabled: boolean;
  config: Record<string, any>;
  createdAt: string;
}

interface OpenClawDeployment {
  id: string;
  agentName: string;
  slug: string;
  description?: string;
  systemPrompt?: string;
  status: string;
  healthStatus?: string | null;
  publicUrl?: string | null;
  gpuTier?: string;
  createdAt: string;
  updatedAt: string;
  modelConfig?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
  channels: Channel[];
}

function LiveIndicator() {
  return (
    <span className="flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
      </span>
      <span className="text-xs font-medium text-green-600 dark:text-green-400">Live</span>
    </span>
  );
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return `${Math.floor(diffMin / 60)}h ago`;
}

/** Mirrors the loaded page: status, configuration, channels, metadata. */
function DeploymentDetailSkeleton() {
  return (
    <div className="p-8 space-y-6" aria-busy="true">
      {/* Status and actions */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-40 max-w-full" />
              <Skeleton className="h-4 w-1/2" />
            </div>
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Skeleton className="h-10 w-20" />
            <Skeleton className="h-10 w-24" />
            <Skeleton className="ml-auto h-10 w-36" />
          </div>
        </CardContent>
      </Card>

      {/* Agent configuration */}
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-44 max-w-full" />
          <Skeleton className="h-4 w-1/3" />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-24 w-full" />
          </div>
        </CardContent>
      </Card>

      {/* Channels */}
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-1/3" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-4 rounded-lg border border-border p-4"
            >
              <div className="flex flex-1 items-center gap-3">
                <Skeleton className="h-2 w-2 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-32 max-w-full" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-9 w-20" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Metadata */}
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-24" />
        </CardHeader>
        <CardContent className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex justify-between gap-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Last child, so space-y-6 does not push the first card down. */}
      <span className="sr-only">Loading deployment details</span>
    </div>
  );
}

export default function OpenClawDeploymentDetailPage() {
  const confirmAction = useConfirm();
  const params = useParams();
  const router = useRouter();
  const deploymentId = params.id as string;

  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetcher = useCallback(async (): Promise<OpenClawDeployment> => {
    const response = await fetch(`${API_URL}/api/openclaw/deployments/${deploymentId}`, {
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error("Failed to fetch deployment");
    }
    const data = await response.json();
    setLastUpdated(new Date());
    return data.deployment as OpenClawDeployment;
  }, [deploymentId]);

  // Must keep a stable identity: usePolling re-subscribes and fetches again
  // whenever onError changes, so an inline arrow refetched on every render
  // (and repeated the error toast in a loop) instead of every 10s.
  const handleLoadError = useCallback((err: Error) => {
    toast.error(getErrorMessage(err, "Failed to load deployment details"));
  }, []);

  const {
    data: deployment,
    isLoading: loading,
    error: loadError,
    refresh: refreshDeployment,
  } = usePolling<OpenClawDeployment>({
    fetcher,
    interval: 10_000,
    onError: handleLoadError,
  });

  // "Try again" on the load error shows the skeleton until the retry settles.
  const [retrying, setRetrying] = useState(false);
  const retryLoad = async () => {
    setRetrying(true);
    await refreshDeployment();
    setRetrying(false);
  };

  const handleAction = async (action: "start" | "stop" | "restart" | "delete") => {
    if (!deployment) return;

    try {
      setActionLoading(action);

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

      if (action === "delete") {
        router.push("/dashboard/openclaw");
      } else {
        await refreshDeployment();
      }
    } catch (error) {
      console.error(`Error ${action}ing deployment:`, error);
      toast.error(getErrorMessage(error, `Failed to ${action} deployment`));
    } finally {
      setActionLoading(null);
    }
  };

  const handleToggleChannel = async (channelId: string, enabled: boolean) => {
    try {
      const response = await fetch(`${API_URL}/api/openclaw/channels/${channelId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled }),
      });

      if (!response.ok) {
        throw new Error("Failed to update channel");
      }

      toast.success(`Channel ${enabled ? "enabled" : "disabled"}`);
      await refreshDeployment();
    } catch (error) {
      console.error("Error toggling channel:", error);
      toast.error(getErrorMessage(error, "Failed to update channel"));
    }
  };

  const copyPublicUrl = () => {
    if (deployment?.publicUrl) {
      navigator.clipboard.writeText(deployment.publicUrl);
      setCopiedUrl(true);
      toast.success("URL copied to clipboard");
      setTimeout(() => setCopiedUrl(false), 2000);
    }
  };

  if (loading || retrying) {
    return (
      <div className="flex flex-col">
        <Header title="Loading..." />
        <DeploymentDetailSkeleton />
      </div>
    );
  }

  if (!deployment) {
    // A failed load is retryable; it is not proof the deployment is gone.
    return (
      <div className="flex flex-col">
        <Header title={loadError ? "Deployment" : "Not Found"} />
        <div className="p-8">
          {loadError ? (
            <ErrorState
              title="Couldn't load deployment"
              error={loadError}
              onRetry={() => void retryLoad()}
              actionLabel="Back to Deployments"
              actionHref="/dashboard/openclaw"
            />
          ) : (
            <EmptyState
              icon={Server}
              title="Deployment not found"
              description="The deployment you're looking for doesn't exist or has been deleted."
              actionLabel="Back to Deployments"
              actionHref="/dashboard/openclaw"
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <Header
        title={deployment.agentName}
        description={`/${deployment.slug}`}
      />

      <div className="p-8 space-y-6">
        {/* Status and Actions */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <CardTitle>Deployment Status</CardTitle>
                <CardDescription>Monitor and control your deployment</CardDescription>
              </div>
              <div className="flex items-center gap-3">
                {deployment.status === "RUNNING" && <LiveIndicator />}
                <OpenClawStatus
                  status={deployment.status}
                  healthStatus={deployment.healthStatus}
                />
              </div>
            </div>
            {lastUpdated && (
              <p className="text-xs text-muted-foreground mt-1">
                Updated {formatRelativeTime(lastUpdated)} &middot; polling every 10s
              </p>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              {deployment.status === "STOPPED" || deployment.status === "FAILED" ? (
                <Button
                  onClick={() => handleAction("start")}
                  disabled={actionLoading === "start"}
                >
                  <Play className="mr-2 h-4 w-4" />
                  Start Deployment
                </Button>
              ) : deployment.status === "RUNNING" ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => handleAction("stop")}
                    disabled={actionLoading === "stop"}
                  >
                    <Square className="mr-2 h-4 w-4" />
                    Stop
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleAction("restart")}
                    disabled={actionLoading === "restart"}
                  >
                    <RotateCw className="mr-2 h-4 w-4" />
                    Restart
                  </Button>
                </>
              ) : null}

              <Button
                variant="destructive"
                onClick={async () => {
                  const ok = await confirmAction({
                    title: `Delete "${deployment.agentName}"?`,
                    description: "The deployment is stopped and removed. This cannot be undone.",
                    confirmLabel: "Delete",
                    destructive: true,
                  });
                  if (ok) handleAction("delete");
                }}
                disabled={actionLoading === "delete"}
                className="ml-auto"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete Deployment
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Agent Configuration */}
        <Card>
          <CardHeader>
            <CardTitle>Agent Configuration</CardTitle>
            <CardDescription>AI model and agent settings</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {deployment.description && (
              <div>
                <label className="text-sm font-medium text-muted-foreground">Description</label>
                <p className="mt-1 text-sm">{deployment.description}</p>
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Cpu className="h-4 w-4" />
                  Model
                </label>
                <p className="mt-1 text-sm font-mono">
                  {deployment.modelConfig?.model || "Not configured"}
                </p>
              </div>

              {deployment.gpuTier && (
                <div>
                  <label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Server className="h-4 w-4" />
                    GPU Tier
                  </label>
                  <p className="mt-1 text-sm font-mono">{deployment.gpuTier}</p>
                </div>
              )}

              {deployment.modelConfig?.temperature !== undefined && (
                <div>
                  <label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Settings className="h-4 w-4" />
                    Temperature
                  </label>
                  <p className="mt-1 text-sm">{deployment.modelConfig.temperature}</p>
                </div>
              )}

              {deployment.modelConfig?.maxTokens !== undefined && (
                <div>
                  <label className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <HardDrive className="h-4 w-4" />
                    Max Tokens
                  </label>
                  <p className="mt-1 text-sm">{deployment.modelConfig.maxTokens}</p>
                </div>
              )}
            </div>

            {deployment.systemPrompt && (
              <div>
                <label className="text-sm font-medium text-muted-foreground">System Prompt</label>
                <div className="mt-1 p-4 bg-muted rounded-lg">
                  <pre className="text-sm whitespace-pre-wrap font-mono">
                    {deployment.systemPrompt}
                  </pre>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Public URL */}
        {deployment.publicUrl && (
          <Card>
            <CardHeader>
              <CardTitle>Public URL</CardTitle>
              <CardDescription>Access your deployed agent</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <div className="flex-1 p-3 bg-muted rounded-lg font-mono text-sm flex items-center gap-2">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  {deployment.publicUrl}
                </div>
                <Button variant="outline" size="icon" onClick={copyPublicUrl}>
                  {copiedUrl ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => window.open(deployment.publicUrl!, "_blank")}
                >
                  <ExternalLink className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Channels */}
        <Card>
          <CardHeader>
            <CardTitle>Channels ({deployment.channels.length})</CardTitle>
            <CardDescription>Manage platform integrations</CardDescription>
          </CardHeader>
          <CardContent>
            {deployment.channels.length === 0 ? (
              <EmptyState
                icon={Plug}
                title="No channels configured"
                description="This deployment has no platform integrations."
              />
            ) : (
              <div className="space-y-3">
                {deployment.channels.map((channel) => (
                  <div
                    key={channel.id}
                    className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          "w-2 h-2 rounded-full",
                          channel.enabled ? "bg-green-500" : "bg-gray-400 dark:bg-gray-600"
                        )}
                      />
                      <div>
                        <div className="font-medium capitalize">{channel.platform}</div>
                        <div className="text-xs text-muted-foreground">
                          Created {new Date(channel.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={channel.enabled ? "default" : "secondary"}>
                        {channel.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleToggleChannel(channel.id, !channel.enabled)}
                      >
                        {channel.enabled ? "Disable" : "Enable"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Metadata */}
        <Card>
          <CardHeader>
            <CardTitle>Metadata</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Created:</span>
              <span>{new Date(deployment.createdAt).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Last Updated:</span>
              <span>{new Date(deployment.updatedAt).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Deployment ID:</span>
              <span className="font-mono text-xs">{deployment.id}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
