"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Cpu,
  Copy,
  RefreshCw,
  Square,
  Play,
  Trash2,
  Activity,
  Clock,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { absoluteApiUrl, deploymentsApi, type DeploymentDetail, getErrorMessage } from "@/lib/api";

const statusColors: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  running: "success",
  provisioning: "warning",
  pending: "secondary",
  degraded: "warning",
  stopped: "secondary",
  failed: "destructive",
};

/** The API answers 404 when no deployment with this ID exists in the caller's org. */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 404
  );
}

/** Placeholder shaped like the actions row, status card, metrics and configuration below. */
function DeploymentDetailSkeleton() {
  return (
    <div className="p-8" aria-busy="true">
      <span className="sr-only">Loading deployment</span>
      <div className="mb-6 flex items-center justify-between">
        <Skeleton className="h-10 w-48" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-10 w-24" />
          <Skeleton className="h-10 w-28" />
        </div>
      </div>

      <Card className="mb-6">
        <CardContent className="py-6">
          <div className="flex items-center gap-4">
            <Skeleton className="h-14 w-14 rounded-lg" />
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <Skeleton className="h-7 w-48" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
              <Skeleton className="h-5 w-40" />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mb-6 grid gap-4 md:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i}>
            <CardContent className="py-4">
              <div className="flex items-center gap-3">
                <Skeleton className="h-5 w-5" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-7 w-16" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-40" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function DeploymentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [deployment, setDeployment] = useState<DeploymentDetail | null>(null);
  const [metrics, setMetrics] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionLoading, setActionLoading] = useState(false);
  // Set once a fetch succeeds. After that a failed poll, Refresh or reload
  // after Start keeps the last good deployment on screen (with the toast)
  // instead of the error panel, as the deployments list does.
  const hasLoadedRef = useRef(false);

  const deploymentId = params.id as string;

  const loadDeployment = useCallback(async () => {
    try {
      const [{ deployment }, metricsData] = await Promise.all([
        deploymentsApi.get(deploymentId),
        deploymentsApi.metrics(deploymentId).catch(() => null),
      ]);
      setDeployment(deployment);
      setMetrics(metricsData);
      hasLoadedRef.current = true;
      setLoadError(null);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load deployment"));
      if (!hasLoadedRef.current) setLoadError(error);
    } finally {
      setIsLoading(false);
    }
  }, [deploymentId]);

  // Nothing has loaded and the last attempt failed: the error (or not-found)
  // panel below is showing.
  const initialLoadFailed = !deployment && Boolean(loadError);

  useEffect(() => {
    loadDeployment();
  }, [loadDeployment]);

  // Poll for updates every 10 seconds, but only when the tab is visible, and
  // not while the initial load has failed: there "Try again" drives retries,
  // so a deployment that cannot load is not re-fetched (and re-toasted) every
  // 10 seconds.
  useEffect(() => {
    if (initialLoadFailed) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        loadDeployment();
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [loadDeployment, initialLoadFailed]);

  function retryLoad() {
    setLoadError(null);
    setIsLoading(true);
    loadDeployment();
  }

  async function handleRestart() {
    setActionLoading(true);
    try {
      await deploymentsApi.restart(deploymentId);
      toast.success("Deployment restarting...");
      loadDeployment();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to restart deployment"));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleStop() {
    setActionLoading(true);
    try {
      await deploymentsApi.delete(deploymentId);
      toast.success("Deployment stopped");
      router.push("/dashboard/deployments");
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to stop deployment"));
    } finally {
      setActionLoading(false);
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
        <DeploymentDetailSkeleton />
      </div>
    );
  }

  // Only reached when nothing has loaded yet: once a deployment is on screen, a
  // failed poll or Refresh keeps it there and just toasts.
  if (!deployment) {
    // A 404 means no deployment with this ID exists in the caller's org, so a
    // retry cannot help; any other failure is a load error the user can retry.
    const notFound = !loadError || isNotFoundError(loadError);
    return (
      <div className="flex flex-col">
        <Header title={notFound ? "Deployment Not Found" : "Deployment"} />
        <div className="p-8">
          {notFound ? (
            <EmptyState
              icon={Cpu}
              title="Deployment not found"
              description="Check the link, or go back to your deployments."
              actionLabel="Back to Deployments"
              actionHref="/dashboard/deployments"
            />
          ) : (
            <ErrorState
              title="Couldn't load deployment"
              error={loadError}
              onRetry={retryLoad}
              actionLabel="Back to Deployments"
              actionHref="/dashboard/deployments"
            />
          )}
        </div>
      </div>
    );
  }

  // The API returns the full chat-completions URL: absolute when it knows its
  // public address, host-relative otherwise - then it is resolved against the
  // API origin this app talks to, never an aspirational hostname.
  const endpoint = absoluteApiUrl(
    deployment.endpoint || `/v1/${encodeURIComponent(deployment.slug)}/chat/completions`
  );
  const healthyNodeCount = deployment.nodes.filter(
    (n) => n.healthStatus === "healthy"
  ).length;

  return (
    <div className="flex flex-col">
      <Header
        title={deployment.name}
        description={`${deployment.model.displayName} on ${deployment.gpuTier}`}
      />

      <div className="p-8">
        {/* Back button and actions */}
        <div className="mb-6 flex items-center justify-between">
          <Link href="/dashboard/deployments">
            <Button variant="ghost">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Deployments
            </Button>
          </Link>

          <div className="flex items-center gap-2">
            {deployment.status === "running" && (
              <Button
                variant="outline"
                onClick={handleStop}
                disabled={actionLoading}
              >
                <Square className="mr-2 h-4 w-4" />
                Stop
              </Button>
            )}
            {(deployment.status === "stopped" || deployment.status === "failed") && (
              <Button
                variant="outline"
                onClick={handleRestart}
                disabled={actionLoading}
              >
                <Play className="mr-2 h-4 w-4" />
                Start
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => loadDeployment()}
              disabled={actionLoading}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>

        {/* Status Card */}
        <Card className="mb-6">
          <CardContent className="py-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-primary/15">
                  <Cpu className="h-7 w-7 text-primary-600" />
                </div>
                <div>
                  <div className="flex items-center gap-3">
                    <h2 className="text-xl font-semibold">{deployment.name}</h2>
                    <Badge variant={statusColors[deployment.status]}>
                      {deployment.status}
                    </Badge>
                  </div>
                  <p className="text-muted-foreground">
                    {deployment.replicas} replica{deployment.replicas > 1 ? "s" : ""} &middot;{" "}
                    {deployment.engine} engine
                  </p>
                </div>
              </div>

              {deployment.status === "running" && (
                <div className="text-right">
                  <p className="text-sm text-muted-foreground">Healthy Nodes</p>
                  <p className="text-2xl font-bold text-green-600">
                    {deployment.nodes.filter((n) => n.healthStatus === "healthy").length}/
                    {deployment.nodes.length}
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Endpoint — only once a node has actually passed a health
            check; a running job whose nodes are still "unknown" cannot
            serve this URL yet, and showing it would be a lie. */}
        {deployment.status === "running" && healthyNodeCount === 0 && (
          <Card className="mb-6 border-amber-500/30 bg-amber-500/10">
            <CardContent className="py-4 text-sm text-amber-500">
              Deployment is running; awaiting the first successful node
              health check before the API endpoint goes live. This
              usually resolves within a minute.
            </CardContent>
          </Card>
        )}
        {deployment.status === "running" && healthyNodeCount > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="text-base">API Endpoint</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-lg bg-muted px-4 py-3 text-sm">
                  {endpoint}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copyToClipboard(endpoint)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <div className="mt-4">
                <p className="text-sm font-medium text-foreground">Usage Example</p>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-gray-900 p-4 text-sm text-gray-100">
{`curl ${endpoint} \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'`}
                </pre>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Metrics */}
        <div className="mb-6 grid gap-4 md:grid-cols-4">
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center gap-3">
                <Zap className="h-5 w-5 text-gray-400" />
                <div>
                  <p className="text-sm text-muted-foreground">Requests (24h)</p>
                  <p className="text-2xl font-bold">
                    {metrics?.metrics?.requests?.toLocaleString() || 0}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-4">
              <div className="flex items-center gap-3">
                <Activity className="h-5 w-5 text-gray-400" />
                <div>
                  <p className="text-sm text-muted-foreground">Avg Latency</p>
                  <p className="text-2xl font-bold">
                    {metrics?.metrics?.avgLatencyMs || 0}ms
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-4">
              <div className="flex items-center gap-3">
                <Cpu className="h-5 w-5 text-gray-400" />
                <div>
                  <p className="text-sm text-muted-foreground">Tokens (24h)</p>
                  <p className="text-2xl font-bold">
                    {((metrics?.metrics?.inputTokens || 0) + (metrics?.metrics?.outputTokens || 0)).toLocaleString()}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-4">
              <div className="flex items-center gap-3">
                <Clock className="h-5 w-5 text-gray-400" />
                <div>
                  <p className="text-sm text-muted-foreground">Error Rate</p>
                  <p className="text-2xl font-bold">
                    {(metrics?.metrics?.errorRate || 0).toFixed(1)}%
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Configuration */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">Configuration</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <p className="text-sm text-muted-foreground">Model</p>
                <p className="font-medium">{deployment.model.displayName}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">GPU Tier</p>
                <p className="font-medium">{deployment.gpuTier}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Engine</p>
                <p className="font-medium">{deployment.engine}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Max Tokens</p>
                <p className="font-medium">{deployment.config.maxTokens.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">GPU Memory Utilization</p>
                <p className="font-medium">{(deployment.config.gpuMemoryUtilization * 100).toFixed(0)}%</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Created</p>
                <p className="font-medium">
                  {new Date(deployment.createdAt).toLocaleDateString()}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Nodes */}
        {deployment.nodes.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Nodes</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {deployment.nodes.map((node, i) => (
                  <div
                    key={node.id}
                    className="flex items-center justify-between rounded-lg border p-4"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`h-3 w-3 rounded-full ${
                          node.healthStatus === "healthy"
                            ? "bg-green-500"
                            : node.healthStatus === "unhealthy"
                            ? "bg-red-500"
                            : "bg-yellow-500"
                        }`}
                      />
                      <div>
                        <p className="font-medium">Nosana host {i + 1}</p>
                        <p className="text-sm text-muted-foreground">{node.healthStatus}</p>
                      </div>
                    </div>
                    {node.latencyMs !== null && (
                      <span className="text-sm text-muted-foreground">{node.latencyMs}ms latency</span>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
