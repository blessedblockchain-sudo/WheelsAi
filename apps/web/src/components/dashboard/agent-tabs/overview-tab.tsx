"use client";

import { useState } from "react";
import { Settings, ChevronRight, ChevronDown } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RunwayCard } from "@/components/dashboard/runway-card";
import { PaymentsTable } from "@/components/dashboard/payments-table";
import type { AgentTabProps } from "./types";

export interface DeployConfig {
  gpuTier: string;
  replicas: number;
  enableWallet: boolean;
  dailyLimitCents: number;
}

export interface OverviewTabProps extends AgentTabProps {
  deployConfig: DeployConfig;
  setDeployConfig: (config: DeployConfig) => void;
}

/** Maps simplified tier names to actual GPU IDs sent to the deploy API. */
const SIMPLIFIED_TIER_TO_GPU: Record<string, string> = {
  basic: "rtx-3060",
  standard: "rtx-4070",
  premium: "rtx-4090",
  enterprise: "a100",
};

/** Reverse map: GPU ID -> simplified tier, for initialising the selector. */
const GPU_TO_SIMPLIFIED_TIER: Record<string, string> = Object.fromEntries(
  Object.entries(SIMPLIFIED_TIER_TO_GPU).map(([tier, gpu]) => [gpu, tier])
);

export function OverviewTab({ agent, deployConfig, setDeployConfig }: OverviewTabProps) {
  const latestDeployment = agent.deployments?.[0];
  const isRunning = latestDeployment?.status === "running";

  const [showAdvanced, setShowAdvanced] = useState(false);

  /**
   * The simplified tier shown in the primary selector.
   * Falls back to "standard" if the current gpuTier isn't in the map
   * (e.g. after the user picked an advanced GPU directly).
   */
  const simplifiedTier = GPU_TO_SIMPLIFIED_TIER[deployConfig.gpuTier] ?? "standard";

  function handleSimplifiedTierChange(tier: string) {
    const gpuTier = SIMPLIFIED_TIER_TO_GPU[tier] ?? "rtx-4070";
    setDeployConfig({ ...deployConfig, gpuTier });
  }

  function handleAdvancedGpuChange(gpuTier: string) {
    setDeployConfig({ ...deployConfig, gpuTier });
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-sm text-gray-500">Model</p>
            <p className="font-medium">{(agent.modelConfig as any)?.externalModel || "Not configured"}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Temperature</p>
            <p className="font-medium">{(agent.modelConfig as any)?.temperature || 0.7}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Max Tokens</p>
            <p className="font-medium">{(agent.modelConfig as any)?.maxTokens || 4096}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500">Source</p>
            <p className="font-medium capitalize">{agent.sourceType}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tools ({(agent.tools as any[])?.length || 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {(agent.tools as any[])?.length > 0 ? (
            <div className="space-y-2">
              {(agent.tools as any[]).map((tool: any, index: number) => (
                <div key={index} className="flex items-center gap-2 rounded border p-2">
                  <Settings className="h-4 w-4 text-gray-400" />
                  <span className="font-medium">{tool.name}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-500">No tools configured</p>
          )}
        </CardContent>
      </Card>

      {agent.systemPrompt && (
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">System Prompt</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap rounded bg-gray-50 p-4 text-sm">
              {agent.systemPrompt}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Treasury — runway + auto-pay history.
          Only renders meaningfully once the agent is tokenized; the
          underlying API returns 404 otherwise and the components show
          their own loading/error states. */}
      <RunwayCard slug={agent.slug} />
      <PaymentsTable
        slug={agent.slug}
        cluster="devnet"
        className="md:col-span-2"
      />

      {/* Deploy configuration */}
      {!isRunning && (
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Deploy Configuration</CardTitle>
            <CardDescription>Configure deployment settings</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Simplified tier selector */}
            <div>
              <label className="block text-sm font-medium text-gray-700">Performance Tier</label>
              <Select
                value={GPU_TO_SIMPLIFIED_TIER[deployConfig.gpuTier] ? simplifiedTier : "standard"}
                onChange={(e) => handleSimplifiedTierChange(e.target.value)}
                className="mt-1"
              >
                <option value="basic">Basic (~$0.15/hr)</option>
                <option value="standard">Standard (~$0.35/hr) ★ Recommended</option>
                <option value="premium">Premium (~$0.50/hr)</option>
                <option value="enterprise">Enterprise (~$1.50/hr)</option>
              </Select>
            </div>

            {/* Advanced options toggle */}
            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-1 text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors"
              >
                {showAdvanced ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                Advanced Options
              </button>

              {showAdvanced && (
                <div className="mt-3 grid gap-4 md:grid-cols-3 rounded-lg border border-gray-200 p-4">
                  {/* Raw GPU tier selector */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700">GPU Type</label>
                    <Select
                      value={deployConfig.gpuTier}
                      onChange={(e) => handleAdvancedGpuChange(e.target.value)}
                      className="mt-1"
                    >
                      <option value="rtx-3060">RTX 3060 ($0.20/hr)</option>
                      <option value="rtx-4070">RTX 4070 ($0.35/hr)</option>
                      <option value="rtx-4090">RTX 4090 ($0.50/hr)</option>
                      <option value="a100">A100 ($1.50/hr)</option>
                    </Select>
                  </div>

                  {/* Replicas */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Replicas</label>
                    <Select
                      value={deployConfig.replicas.toString()}
                      onChange={(e) => setDeployConfig({ ...deployConfig, replicas: parseInt(e.target.value) })}
                      className="mt-1"
                    >
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </Select>
                  </div>

                  {/* Wallet config */}
                  <div>
                    <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
                      <input
                        type="checkbox"
                        checked={deployConfig.enableWallet}
                        onChange={(e) => setDeployConfig({ ...deployConfig, enableWallet: e.target.checked })}
                      />
                      Enable Agent Wallet
                    </label>
                    {deployConfig.enableWallet && (
                      <Input
                        type="number"
                        value={deployConfig.dailyLimitCents / 100}
                        onChange={(e) =>
                          setDeployConfig({
                            ...deployConfig,
                            dailyLimitCents: parseFloat(e.target.value) * 100,
                          })
                        }
                        placeholder="Daily limit (USD)"
                        className="mt-2"
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
