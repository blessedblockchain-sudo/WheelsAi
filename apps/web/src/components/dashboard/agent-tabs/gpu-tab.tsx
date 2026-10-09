"use client";

import { useCallback, useEffect, useState } from "react";
import { Cpu, Play, Square } from "lucide-react";
import { toast } from "sonner";
import { GPU_TIER_ORDER } from "@wheelsai/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { agentsApi, capabilitiesApi, getErrorMessage, type AgentDeployment } from "@/lib/api";
import { GPU_MESSAGES, gpuTierLabel } from "@/lib/agent-page";
import type { AgentTabProps } from "./types";

export interface DeployConfig {
  gpuTier: string;
  replicas: number;
  enableWallet: boolean;
  dailyLimitCents: number;
}

const statusColors: Record<string, "success" | "warning" | "destructive" | "secondary"> = {
  running: "success",
  building: "warning",
  deploying: "warning",
  pending: "secondary",
  stopped: "secondary",
  failed: "destructive",
};

/** The tier a deploy starts on: the second of the order, as the page chose before. */
const DEFAULT_TIER = GPU_TIER_ORDER[1] ?? GPU_TIER_ORDER[0];

/**
 * A GPU of the agent's own. While that is not offered, the tab says so and
 * offers nothing that would be refused. A deployment that is running keeps
 * its status and its Stop button, and the history of deployments stays.
 */
export function GpuTab({ agent, agentId, loadAgent }: AgentTabProps) {
  const latest = agent.deployments?.[0];
  const running = latest?.status === "running" ? latest : null;

  /** null while it is being read. */
  const [available, setAvailable] = useState<boolean | null>(null);
  const [capabilityError, setCapabilityError] = useState<unknown>(null);
  const [isStopping, setIsStopping] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [config, setConfig] = useState<DeployConfig>({
    gpuTier: DEFAULT_TIER,
    replicas: 1,
    enableWallet: false,
    dailyLimitCents: 1000,
  });

  const loadCapability = useCallback(async () => {
    setCapabilityError(null);
    try {
      setAvailable((await capabilitiesApi.get()).agentGpu.available);
    } catch (err) {
      setCapabilityError(err);
    }
  }, []);

  useEffect(() => {
    void loadCapability();
  }, [loadCapability]);

  async function handleStop(deploymentId: string) {
    setIsStopping(true);
    try {
      await agentsApi.stopDeployment(agentId, deploymentId);
      toast.success("Deployment stopped");
      await loadAgent();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to stop deployment"));
    } finally {
      setIsStopping(false);
    }
  }

  async function handleDeploy() {
    setIsDeploying(true);
    try {
      await agentsApi.deploy(agentId, {
        gpuTier: config.gpuTier,
        replicas: config.replicas,
        enableWallet: config.enableWallet,
        walletConfig: config.enableWallet ? { dailyLimitCents: config.dailyLimitCents } : undefined,
      });
      toast.success("Deployment started");
      await loadAgent();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to deploy agent"));
    } finally {
      setIsDeploying(false);
    }
  }

  return (
    <div className="min-w-0 space-y-6">
      {running ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Dedicated GPU</CardTitle>
            <CardDescription>This agent has a deployment running on a GPU of its own.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <Badge variant={statusColors[running.status]}>{running.status}</Badge>
                <span className="text-sm text-foreground">{gpuTierLabel(running.gpuTier)}</span>
                {running.endpoint && (
                  <code className="min-w-0 break-all rounded bg-muted px-2 py-1 text-sm">{running.endpoint}</code>
                )}
              </div>
              <Button variant="destructive" onClick={() => handleStop(running.id)} isLoading={isStopping}>
                <Square className="mr-2 h-4 w-4" aria-hidden="true" />
                Stop
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : capabilityError ? (
        <ErrorState title="Couldn't check GPUs for this agent" error={capabilityError} onRetry={loadCapability} />
      ) : available === null ? (
        <Card aria-busy="true">
          <CardHeader>
            <Skeleton className="h-5 w-36" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-10 w-full" />
            <span className="sr-only">Loading</span>
          </CardContent>
        </Card>
      ) : available ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Dedicated GPU</CardTitle>
            <CardDescription>Give this agent a GPU of its own. It keeps answering on WheelsAI until the GPU is ready.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="gpu-tier">GPU</Label>
                <Select
                  id="gpu-tier"
                  value={config.gpuTier}
                  onChange={(e) => setConfig({ ...config, gpuTier: e.target.value })}
                >
                  {GPU_TIER_ORDER.map((tier) => (
                    <option key={tier} value={tier}>
                      {gpuTierLabel(tier)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gpu-replicas">Replicas</Label>
                <Select
                  id="gpu-replicas"
                  value={config.replicas.toString()}
                  onChange={(e) => setConfig({ ...config, replicas: parseInt(e.target.value, 10) })}
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <Switch
                  id="gpu-wallet"
                  checked={config.enableWallet}
                  onCheckedChange={(enableWallet) => setConfig({ ...config, enableWallet })}
                />
                <Label htmlFor="gpu-wallet">Enable Agent Wallet</Label>
              </div>
              {config.enableWallet && (
                <div className="max-w-xs space-y-1.5">
                  <Label htmlFor="gpu-daily-limit">Daily limit (USD)</Label>
                  <Input
                    id="gpu-daily-limit"
                    type="number"
                    min={0}
                    step={1}
                    value={config.dailyLimitCents / 100}
                    onChange={(e) => {
                      const dollars = parseFloat(e.target.value);
                      setConfig({ ...config, dailyLimitCents: Number.isFinite(dollars) ? Math.round(dollars * 100) : 0 });
                    }}
                  />
                </div>
              )}
            </div>
            <Button onClick={handleDeploy} isLoading={isDeploying}>
              <Play className="mr-2 h-4 w-4" aria-hidden="true" />
              Deploy
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex items-start gap-4 py-6">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted" aria-hidden="true">
              <Cpu className="h-5 w-5 text-muted-foreground" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">Dedicated GPU</h2>
              <p className="mt-1 text-sm text-foreground">{GPU_MESSAGES.beingBuilt}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {agent.deployments?.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Deployment History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {agent.deployments.map((deployment: AgentDeployment) => (
                <div
                  key={deployment.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
                >
                  <div className="flex min-w-0 items-center gap-4">
                    <Badge variant={statusColors[deployment.status]}>{deployment.status}</Badge>
                    <div className="min-w-0">
                      <p className="font-medium">{deployment.id.slice(0, 8)}...</p>
                      <p className="text-sm text-muted-foreground">{new Date(deployment.createdAt).toLocaleString()}</p>
                    </div>
                  </div>
                  {deployment.endpoint && (
                    <code className="min-w-0 break-all rounded bg-muted px-2 py-1 text-sm">{deployment.endpoint}</code>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
