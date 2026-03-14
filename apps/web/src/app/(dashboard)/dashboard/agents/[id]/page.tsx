"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Bot,
  Play,
  Square,
  RefreshCw,
  Trash2,
  Settings,
  Code,
  Terminal,
  Wallet,
  Copy,
  ExternalLink,
  AlertTriangle,
  Workflow,
  MessageCircle,
  History,
  GitBranch,
  ArrowLeft,
  Plus,
  Tag,
  Upload,
  Check,
  X,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";

import { Header } from "@/components/dashboard/header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  agentsApi,
  versioningApi,
  type AgentDetail,
  type AgentDeployment,
  type AgentVersionSummary,
  type VersionHistoryEntry,
  type AgentVersionDiff,
  type ChangeType,
} from "@/lib/api";
import { cn } from "@/lib/utils";

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
  const router = useRouter();
  const agentId = params.id as string;

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [isDeploying, setIsDeploying] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Deploy form state
  const [deployConfig, setDeployConfig] = useState({
    gpuTier: "rtx-4090",
    replicas: 1,
    enableWallet: false,
    dailyLimitCents: 1000,
  });

  // Versioning state
  const [versionHistory, setVersionHistory] = useState<VersionHistoryEntry[]>([]);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [showCreateVersion, setShowCreateVersion] = useState(false);
  const [isCreatingVersion, setIsCreatingVersion] = useState(false);
  const [newVersionForm, setNewVersionForm] = useState({
    changeLog: "",
    changeType: "patch" as ChangeType,
    tags: "",
  });
  const [comparingVersions, setComparingVersions] = useState<{
    from: string;
    to: string;
  } | null>(null);
  const [versionDiff, setVersionDiff] = useState<AgentVersionDiff | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState<string | null>(null);

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

  async function loadVersionHistory() {
    setIsLoadingVersions(true);
    try {
      const history = await versioningApi.getHistory(agentId);
      setVersionHistory(history);
    } catch (error) {
      toast.error("Failed to load version history");
    } finally {
      setIsLoadingVersions(false);
    }
  }

  useEffect(() => {
    if (activeTab === "versions") {
      loadVersionHistory();
    }
  }, [activeTab, agentId]);

  async function handleCreateVersion() {
    setIsCreatingVersion(true);
    try {
      const tags = newVersionForm.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      await versioningApi.createVersion(agentId, {
        changeLog: newVersionForm.changeLog || undefined,
        changeType: newVersionForm.changeType,
        tags: tags.length > 0 ? tags : undefined,
      });

      toast.success("Version created successfully");
      setShowCreateVersion(false);
      setNewVersionForm({ changeLog: "", changeType: "patch", tags: "" });
      loadVersionHistory();
      loadAgent();
    } catch (error) {
      toast.error("Failed to create version");
    } finally {
      setIsCreatingVersion(false);
    }
  }

  async function handleCompareVersions(from: string, to: string) {
    setComparingVersions({ from, to });
    setIsLoadingDiff(true);
    try {
      const diff = await versioningApi.compareVersions(agentId, from, to);
      setVersionDiff(diff);
    } catch (error) {
      toast.error("Failed to compare versions");
    } finally {
      setIsLoadingDiff(false);
    }
  }

  async function handleRollback(version: string) {
    if (!confirm(`Are you sure you want to rollback to version ${version}? This will create a new version.`)) {
      return;
    }

    setIsRollingBack(version);
    try {
      await versioningApi.rollbackToVersion(agentId, version);
      toast.success(`Rolled back to version ${version}`);
      loadVersionHistory();
      loadAgent();
    } catch (error) {
      toast.error("Failed to rollback");
    } finally {
      setIsRollingBack(null);
    }
  }

  async function handlePublishVersion(version: string) {
    try {
      await versioningApi.publishVersion(agentId, version);
      toast.success("Version published");
      loadVersionHistory();
    } catch (error) {
      toast.error("Failed to publish version");
    }
  }

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

  async function handleDelete() {
    if (!confirm("Are you sure you want to delete this agent? This action cannot be undone.")) {
      return;
    }

    setIsDeleting(true);
    try {
      await agentsApi.delete(agentId);
      toast.success("Agent deleted");
      router.push("/dashboard/agents");
    } catch (error) {
      toast.error("Failed to delete agent");
    } finally {
      setIsDeleting(false);
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
        )}

        {activeTab === "deployments" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Deployment History</CardTitle>
            </CardHeader>
            <CardContent>
              {agent.deployments?.length > 0 ? (
                <div className="space-y-4">
                  {agent.deployments.map((deployment: AgentDeployment) => (
                    <div
                      key={deployment.id}
                      className="flex items-center justify-between rounded-lg border p-4"
                    >
                      <div className="flex items-center gap-4">
                        <Badge variant={statusColors[deployment.status]}>
                          {deployment.status}
                        </Badge>
                        <div>
                          <p className="font-medium">{deployment.id.slice(0, 8)}...</p>
                          <p className="text-sm text-gray-500">
                            {new Date(deployment.createdAt).toLocaleString()}
                          </p>
                        </div>
                      </div>
                      {deployment.endpoint && (
                        <code className="rounded bg-gray-100 px-2 py-1 text-sm">
                          {deployment.endpoint}
                        </code>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-center text-gray-500">No deployments yet</p>
              )}
            </CardContent>
          </Card>
        )}

        {activeTab === "versions" && (
          <div className="space-y-6">
            {/* Create Version Modal */}
            {showCreateVersion && (
              <Card className="border-primary-200 bg-primary-50/50">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Create New Version</CardTitle>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowCreateVersion(false)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Change Type
                    </label>
                    <Select
                      value={newVersionForm.changeType}
                      onChange={(e) =>
                        setNewVersionForm({
                          ...newVersionForm,
                          changeType: e.target.value as ChangeType,
                        })
                      }
                    >
                      <option value="patch">Patch (bug fixes)</option>
                      <option value="minor">Minor (new features)</option>
                      <option value="major">Major (breaking changes)</option>
                    </Select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Change Log (optional)
                    </label>
                    <Textarea
                      value={newVersionForm.changeLog}
                      onChange={(e) =>
                        setNewVersionForm({
                          ...newVersionForm,
                          changeLog: e.target.value,
                        })
                      }
                      placeholder="Describe what changed in this version..."
                      rows={3}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Tags (comma-separated, optional)
                    </label>
                    <Input
                      value={newVersionForm.tags}
                      onChange={(e) =>
                        setNewVersionForm({
                          ...newVersionForm,
                          tags: e.target.value,
                        })
                      }
                      placeholder="stable, production, beta"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setShowCreateVersion(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={handleCreateVersion}
                      isLoading={isCreatingVersion}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Create Version
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Version Comparison Modal */}
            {comparingVersions && (
              <Card className="border-blue-200 bg-blue-50/50">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">
                      Comparing v{comparingVersions.from} → v{comparingVersions.to}
                    </CardTitle>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setComparingVersions(null);
                        setVersionDiff(null);
                      }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {isLoadingDiff ? (
                    <div className="h-32 animate-pulse rounded bg-gray-200" />
                  ) : versionDiff ? (
                    <div className="space-y-4">
                      <div className="flex gap-4 text-sm">
                        {versionDiff.linesAdded > 0 && (
                          <span className="text-green-600">
                            +{versionDiff.linesAdded} added
                          </span>
                        )}
                        {versionDiff.linesRemoved > 0 && (
                          <span className="text-red-600">
                            -{versionDiff.linesRemoved} removed
                          </span>
                        )}
                      </div>

                      {versionDiff.addedFields.length > 0 && (
                        <div>
                          <p className="font-medium text-green-700 mb-1">
                            Added Fields:
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {versionDiff.addedFields.map((field) => (
                              <Badge key={field} variant="success">
                                {field}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {versionDiff.removedFields.length > 0 && (
                        <div>
                          <p className="font-medium text-red-700 mb-1">
                            Removed Fields:
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {versionDiff.removedFields.map((field) => (
                              <Badge key={field} variant="destructive">
                                {field}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {versionDiff.modifiedFields.length > 0 && (
                        <div>
                          <p className="font-medium text-yellow-700 mb-1">
                            Modified Fields:
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {versionDiff.modifiedFields.map((field) => (
                              <Badge key={field} variant="warning">
                                {field}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {Object.keys(versionDiff.changes).length > 0 && (
                        <div className="mt-4">
                          <p className="font-medium mb-2">Changes Detail:</p>
                          <pre className="rounded bg-gray-900 p-4 text-sm text-gray-100 overflow-auto max-h-64">
                            {JSON.stringify(versionDiff.changes, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-gray-500">No differences found</p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Version History */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">Version History</CardTitle>
                    <CardDescription>
                      Track changes and rollback to previous versions
                    </CardDescription>
                  </div>
                  {!showCreateVersion && (
                    <Button onClick={() => setShowCreateVersion(true)}>
                      <Plus className="mr-2 h-4 w-4" />
                      Create Version
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {isLoadingVersions ? (
                  <div className="space-y-4">
                    {[1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="h-24 animate-pulse rounded bg-gray-200"
                      />
                    ))}
                  </div>
                ) : versionHistory.length > 0 ? (
                  <div className="relative">
                    {/* Timeline line */}
                    <div className="absolute left-4 top-6 bottom-6 w-0.5 bg-gray-200" />

                    <div className="space-y-4">
                      {versionHistory.map((version, index) => {
                        const prevVersion = versionHistory[index + 1];

                        return (
                          <div
                            key={version.id}
                            className={cn(
                              "relative pl-10 rounded-lg border p-4",
                              version.isLatest && "border-primary-200 bg-primary-50/30"
                            )}
                          >
                            {/* Timeline dot */}
                            <div
                              className={cn(
                                "absolute left-2.5 top-6 h-3 w-3 rounded-full border-2 border-white",
                                version.isLatest
                                  ? "bg-primary-500"
                                  : "bg-gray-400"
                              )}
                            />

                            <div className="flex flex-wrap items-start justify-between gap-4">
                              <div className="flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono font-semibold">
                                    v{version.version}
                                  </span>
                                  {version.isLatest && (
                                    <Badge variant="success">Latest</Badge>
                                  )}
                                  {version.isPublished && (
                                    <Badge variant="secondary">Published</Badge>
                                  )}
                                  <Badge
                                    variant={
                                      version.changeType === "major"
                                        ? "destructive"
                                        : version.changeType === "minor"
                                        ? "warning"
                                        : "secondary"
                                    }
                                  >
                                    {version.changeType}
                                  </Badge>
                                </div>

                                {version.changeLog && (
                                  <p className="mt-1 text-sm text-gray-600">
                                    {version.changeLog}
                                  </p>
                                )}

                                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                                  <span>by {version.createdByName}</span>
                                  <span>•</span>
                                  <span>
                                    {new Date(version.createdAt).toLocaleDateString()}
                                  </span>
                                  {version.tags.length > 0 && (
                                    <>
                                      <span>•</span>
                                      <div className="flex gap-1">
                                        {version.tags.map((tag) => (
                                          <span
                                            key={tag}
                                            className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5"
                                          >
                                            <Tag className="mr-1 h-3 w-3" />
                                            {tag}
                                          </span>
                                        ))}
                                      </div>
                                    </>
                                  )}
                                </div>

                                {/* Diff summary */}
                                {version.diff && (
                                  <div className="mt-2 flex gap-3 text-xs">
                                    {version.diff.linesAdded > 0 && (
                                      <span className="text-green-600">
                                        +{version.diff.linesAdded}
                                      </span>
                                    )}
                                    {version.diff.linesRemoved > 0 && (
                                      <span className="text-red-600">
                                        -{version.diff.linesRemoved}
                                      </span>
                                    )}
                                    {version.diff.modifiedFields.length > 0 && (
                                      <span className="text-gray-500">
                                        {version.diff.modifiedFields.length} fields
                                        changed
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>

                              <div className="flex gap-2">
                                {prevVersion && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                      handleCompareVersions(
                                        prevVersion.version,
                                        version.version
                                      )
                                    }
                                  >
                                    <GitBranch className="mr-1 h-3 w-3" />
                                    Compare
                                  </Button>
                                )}
                                {!version.isLatest && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleRollback(version.version)}
                                    isLoading={isRollingBack === version.version}
                                  >
                                    <ArrowLeft className="mr-1 h-3 w-3" />
                                    Rollback
                                  </Button>
                                )}
                                {!version.isPublished && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                      handlePublishVersion(version.version)
                                    }
                                  >
                                    <Upload className="mr-1 h-3 w-3" />
                                    Publish
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <History className="mx-auto h-12 w-12 text-gray-300" />
                    <h3 className="mt-2 text-sm font-medium text-gray-900">
                      No versions yet
                    </h3>
                    <p className="mt-1 text-sm text-gray-500">
                      Create your first version to start tracking changes.
                    </p>
                    <Button
                      className="mt-4"
                      onClick={() => setShowCreateVersion(true)}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Create First Version
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === "code" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Agent Code</CardTitle>
              <CardDescription>
                Source type: {agent.sourceType}
                {agent.sourceUrl && ` - ${agent.sourceUrl}`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {agent.sourceCode ? (
                <pre className="overflow-x-auto rounded-lg bg-gray-900 p-4 text-sm text-gray-100">
                  {agent.sourceCode}
                </pre>
              ) : agent.sourceUrl ? (
                <a
                  href={agent.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-primary-600 hover:underline"
                >
                  <ExternalLink className="h-4 w-4" />
                  View source
                </a>
              ) : (
                <p className="text-gray-500">No source code available</p>
              )}
            </CardContent>
          </Card>
        )}

        {activeTab === "logs" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Logs</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="h-96 overflow-auto rounded-lg bg-gray-900 p-4 text-sm text-gray-100">
                {latestDeployment?.buildLogs || "No logs available"}
              </pre>
            </CardContent>
          </Card>
        )}

        {activeTab === "settings" && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Agent Settings</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-500">Settings editing coming soon...</p>
              </CardContent>
            </Card>

            <Card className="border-red-200">
              <CardHeader>
                <CardTitle className="text-base text-red-600">Danger Zone</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">Delete Agent</p>
                    <p className="text-sm text-gray-500">
                      Permanently delete this agent and all its deployments
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    onClick={handleDelete}
                    isLoading={isDeleting}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete Agent
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
