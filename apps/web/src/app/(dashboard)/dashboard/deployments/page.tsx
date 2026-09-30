"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Cpu, MoreVertical, Play, Square, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deploymentsApi, type Deployment, getErrorMessage } from "@/lib/api";

const statusColors: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  running: "success",
  provisioning: "warning",
  pending: "secondary",
  degraded: "warning",
  stopped: "secondary",
  failed: "destructive",
};

const statusIcons: Record<string, React.ReactNode> = {
  running: <span className="h-2 w-2 rounded-full bg-green-500" />,
  provisioning: <RefreshCw className="h-3 w-3 animate-spin text-yellow-500" />,
  pending: <span className="h-2 w-2 rounded-full bg-gray-400" />,
  degraded: <span className="h-2 w-2 rounded-full bg-yellow-500" />,
  stopped: <span className="h-2 w-2 rounded-full bg-gray-400" />,
  failed: <span className="h-2 w-2 rounded-full bg-red-500" />,
};

export default function DeploymentsPage() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  async function loadDeployments() {
    try {
      const { deployments } = await deploymentsApi.list();
      setDeployments(deployments);
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to load deployments"));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadDeployments();
    // Poll for updates every 10 seconds, but only when tab is visible
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        loadDeployments();
      }
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  async function handleRestart(id: string) {
    setActionLoading(id);
    try {
      await deploymentsApi.restart(id);
      toast.success("Deployment restarting...");
      loadDeployments();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to restart deployment"));
    } finally {
      setActionLoading(null);
    }
  }

  async function handleStop(id: string) {
    setActionLoading(id);
    try {
      await deploymentsApi.delete(id);
      toast.success("Deployment stopped");
      loadDeployments();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to stop deployment"));
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="flex flex-col">
      <Header
        title="Deployments"
        description="Manage your model deployments"
        action={{ label: "New Deployment", href: "/dashboard/deployments/new" }}
      />

      <div className="p-8">
        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : deployments.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <Cpu className="h-16 w-16 text-gray-300" />
              <h3 className="mt-4 text-xl font-medium text-foreground">
                No deployments yet
              </h3>
              <p className="mt-2 text-muted-foreground">
                Deploy your first model to get an OpenAI-compatible endpoint
              </p>
              <Link href="/dashboard/deployments/new" className="mt-6">
                <Button size="lg">
                  <Cpu className="mr-2 h-5 w-5" />
                  Deploy Your First Model
                </Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {deployments.map((deployment) => (
              <Card key={deployment.id} className="overflow-hidden">
                <CardContent className="p-0">
                  <div className="flex items-center justify-between p-6">
                    <div className="flex items-center gap-4">
                      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/15">
                        <Cpu className="h-6 w-6 text-primary-600" />
                      </div>
                      <div>
                        <div className="flex items-center gap-3">
                          <Link
                            href={`/dashboard/deployments/${deployment.id}`}
                            className="text-lg font-semibold text-foreground hover:text-primary-600"
                          >
                            {deployment.name}
                          </Link>
                          <Badge variant={statusColors[deployment.status]}>
                            <span className="mr-1.5 flex items-center">
                              {statusIcons[deployment.status]}
                            </span>
                            {deployment.status}
                          </Badge>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {deployment.model} &middot; {deployment.engine} &middot;{" "}
                          {deployment.gpuTier} &middot; {deployment.replicas} replica
                          {deployment.replicas > 1 ? "s" : ""}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      {deployment.status === "running" && deployment.endpoint && (
                        <div className="text-right">
                          <p className="text-xs text-muted-foreground">Endpoint</p>
                          <code className="text-sm text-foreground">
                            {deployment.endpoint}
                          </code>
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        {deployment.status === "stopped" ||
                        deployment.status === "failed" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRestart(deployment.id)}
                            disabled={actionLoading === deployment.id}
                          >
                            <Play className="mr-1 h-4 w-4" />
                            Start
                          </Button>
                        ) : deployment.status === "running" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleStop(deployment.id)}
                            disabled={actionLoading === deployment.id}
                          >
                            <Square className="mr-1 h-4 w-4" />
                            Stop
                          </Button>
                        ) : null}

                        <Link href={`/dashboard/deployments/${deployment.id}`}>
                          <Button variant="ghost" size="sm">
                            View Details
                          </Button>
                        </Link>
                      </div>
                    </div>
                  </div>

                  {/* Health indicator bar */}
                  <div className="h-1 bg-muted">
                    <div
                      className={`h-full transition-all ${
                        deployment.status === "running"
                          ? "bg-green-500"
                          : deployment.status === "provisioning"
                          ? "animate-pulse bg-yellow-500"
                          : deployment.status === "failed"
                          ? "bg-red-500"
                          : "bg-gray-300"
                      }`}
                      style={{
                        width:
                          deployment.status === "running"
                            ? `${(deployment.healthyNodes / deployment.totalNodes) * 100}%`
                            : deployment.status === "provisioning"
                            ? "50%"
                            : "0%",
                      }}
                    />
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
