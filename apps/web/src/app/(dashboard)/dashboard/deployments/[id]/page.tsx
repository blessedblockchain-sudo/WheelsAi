"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Cpu,
  Copy,
  ExternalLink,
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
import { API_BASE_URL, deploymentsApi, type DeploymentDetail } from "@/lib/api";

const statusColors: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  running: "success",
  provisioning: "warning",
  pending: "secondary",
  degraded: "warning",
  stopped: "secondary",
  failed: "destructive",
};

export default function DeploymentDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [deployment, setDeployment] = useState<DeploymentDetail | null>(null);
  const [metrics, setMetrics] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const deploymentId = params.id as string;

  async function loadDeployment() {
    try {
      const [{ deployment }, metricsData] = await Promise.all([
        deploymentsApi.get(deploymentId),
        deploymentsApi.metrics(deploymentId).catch(() => null),
      ]);
      setDeployment(deployment);
      setMetrics(metricsData);
    } catch (error) {
      toast.error("Failed to load deployment");
      router.push("/dashboard/deployments");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadDeployment();
    const interval = setInterval(loadDeployment, 10000);
    return () => clearInterval(interval);
  }, [deploymentId]);

  async function handleRestart() {
    setActionLoading(true);
    try {
      await deploymentsApi.restart(deploymentId);
      toast.success("Deployment restarting...");
      loadDeployment();
    } catch (error) {
      toast.error("Failed to restart deployment");
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
      toast.error("Failed to stop deployment");
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
        <div className="p-8">
          <div className="h-64 animate-pulse rounded-lg bg-gray-200" />
        </div>
      </div>
    );
  }

  if (!deployment) {
    return null;
  }

  // The real API origin this app talks to — not an aspirational hostname.
  const endpoint = deployment.endpoint || `${API_BASE_URL}/v1/${deployment.slug}`;
  const healthyNodeCount = deployment.nodes.filter(
    (n) => n.healthStatus === "healthy"
  ).length;

  return (
    <div className="flex flex-col">
      <Header
        title={deployment.name}
        description={`${deployment.model} on ${deployment.gpuTier}`}
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
                <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-primary-100">
                  <Cpu className="h-7 w-7 text-primary-600" />
                </div>
                <div>
                  <div className="flex items-center gap-3">
                    <h2 className="text-xl font-semibold">{deployment.name}</h2>
                    <Badge variant={statusColors[deployment.status]}>
                      {deployment.status}
                    </Badge>
                  </div>
                  <p className="text-gray-500">
                    {deployment.replicas} replica{deployment.replicas > 1 ? "s" : ""} &middot;{" "}
                    {deployment.engine} engine
                  </p>
                </div>
              </div>

              {deployment.status === "running" && (
                <div className="text-right">
                  <p className="text-sm text-gray-500">Healthy Nodes</p>
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
          <Card className="mb-6 border-amber-300 bg-amber-50">
            <CardContent className="py-4 text-sm text-amber-800">
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
                <code className="flex-1 rounded-lg bg-gray-100 px-4 py-3 text-sm">
                  {endpoint}/chat/completions
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copyToClipboard(`${endpoint}/chat/completions`)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <div className="mt-4">
                <p className="text-sm font-medium text-gray-700">Usage Example</p>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-gray-900 p-4 text-sm text-gray-100">
{`curl ${endpoint}/chat/completions \\
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
                  <p className="text-sm text-gray-500">Requests (24h)</p>
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
                  <p className="text-sm text-gray-500">Avg Latency</p>
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
                  <p className="text-sm text-gray-500">Tokens (24h)</p>
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
                  <p className="text-sm text-gray-500">Error Rate</p>
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
                <p className="text-sm text-gray-500">Model</p>
                <p className="font-medium">{deployment.model}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">GPU Tier</p>
                <p className="font-medium">{deployment.gpuTier}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Engine</p>
                <p className="font-medium">{deployment.engine}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Max Tokens</p>
                <p className="font-medium">{deployment.config.maxTokens.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">GPU Memory Utilization</p>
                <p className="font-medium">{(deployment.config.gpuMemoryUtilization * 100).toFixed(0)}%</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Created</p>
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
                        <p className="font-medium">Node {i + 1}</p>
                        <p className="text-sm text-gray-500">{node.healthStatus}</p>
                      </div>
                    </div>
                    {node.latencyMs && (
                      <span className="text-sm text-gray-500">{node.latencyMs}ms latency</span>
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
