"use client";

import { Settings } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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

export function OverviewTab({ agent, deployConfig, setDeployConfig }: OverviewTabProps) {
  const latestDeployment = agent.deployments?.[0];
  const isRunning = latestDeployment?.status === "running";

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

      {/* Deploy configuration */}
      {!isRunning && (
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Deploy Configuration</CardTitle>
            <CardDescription>Configure deployment settings</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <label className="block text-sm font-medium text-gray-700">GPU Tier</label>
                <Select
                  value={deployConfig.gpuTier}
                  onChange={(e) => setDeployConfig({ ...deployConfig, gpuTier: e.target.value })}
                  className="mt-1"
                >
                  <option value="rtx-3060">RTX 3060 ($0.20/hr)</option>
                  <option value="rtx-4070">RTX 4070 ($0.35/hr)</option>
                  <option value="rtx-4090">RTX 4090 ($0.50/hr)</option>
                  <option value="a100">A100 ($1.50/hr)</option>
                </Select>
              </div>

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
                    onChange={(e) => setDeployConfig({ ...deployConfig, dailyLimitCents: parseFloat(e.target.value) * 100 })}
                    placeholder="Daily limit (USD)"
                    className="mt-2"
                  />
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
