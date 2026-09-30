"use client";

import { useState, useEffect } from "react";
import {
  Network,
  Plus,
  Play,
  Pause,
  Trash2,
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Activity,
  Layers,
  ChevronDown,
  ChevronUp,
  X,
  Loader2,
  GitBranch,
  ArrowRightLeft,
  Workflow,
  Timer,
} from "lucide-react";
import {
  orchestrationApi,
  type Orchestration,
  type OrchestrationExecution,
  getErrorMessage,
} from "@/lib/api";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";

// ---------------------------------------------------------------------------
// Execution mode badge config
// ---------------------------------------------------------------------------
const modeBadgeStyles: Record<string, string> = {
  sequential: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  parallel: "bg-green-500/20 text-green-400 border-green-500/30",
  conditional: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  pipeline: "bg-purple-500/20 text-purple-400 border-purple-500/30",
};

const modeIcons: Record<string, React.ElementType> = {
  sequential: ArrowRightLeft,
  parallel: Layers,
  conditional: GitBranch,
  pipeline: Workflow,
};

// ---------------------------------------------------------------------------
// Execution status config
// ---------------------------------------------------------------------------
const statusConfig: Record<
  string,
  { color: string; bgColor: string; barColor: string; pulse?: boolean }
> = {
  pending: {
    color: "text-gray-400",
    bgColor: "bg-gray-500/20",
    barColor: "bg-gray-400",
  },
  running: {
    color: "text-blue-400",
    bgColor: "bg-blue-500/20",
    barColor: "bg-blue-400",
    pulse: true,
  },
  completed: {
    color: "text-green-400",
    bgColor: "bg-green-500/20",
    barColor: "bg-green-400",
  },
  failed: {
    color: "text-red-400",
    bgColor: "bg-red-500/20",
    barColor: "bg-red-400",
  },
  cancelled: {
    color: "text-yellow-400",
    bgColor: "bg-yellow-500/20",
    barColor: "bg-yellow-400",
  },
};

function getStatusConfig(status: string) {
  return (
    statusConfig[status] || {
      color: "text-gray-400",
      bgColor: "bg-gray-500/20",
      barColor: "bg-gray-400",
    }
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatDuration(ms?: number): string {
  if (!ms) return "--";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatRelativeTime(dateStr?: string): string {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  const now = new Date();
  const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------
export default function OrchestrationsPage() {
  const confirmAction = useConfirm();
  const [orchestrations, setOrchestrations] = useState<Orchestration[]>([]);
  const [stats, setStats] = useState<{
    totalOrchestrations: number;
    activeOrchestrations: number;
    totalExecutions: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [executions, setExecutions] = useState<
    Record<string, OrchestrationExecution[]>
  >({});
  const [loadingExecutions, setLoadingExecutions] = useState<string | null>(
    null
  );

  // Execute modal
  const [executeModalId, setExecuteModalId] = useState<string | null>(null);
  const [executeInput, setExecuteInput] = useState("");
  const [executing, setExecuting] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      setLoading(true);
      const [statsRes, listRes] = await Promise.all([
        orchestrationApi.getStats(),
        orchestrationApi.list({ limit: 50 }),
      ]);
      setStats(statsRes);
      setOrchestrations(listRes.orchestrations);
    } catch (error) {
      console.error("Failed to load orchestrations:", error);
    } finally {
      setLoading(false);
    }
  }

  async function loadExecutions(orchId: string) {
    try {
      setLoadingExecutions(orchId);
      const res = await orchestrationApi.getExecutions(orchId, { limit: 10 });
      setExecutions((prev) => ({ ...prev, [orchId]: res.executions }));
    } catch (error) {
      console.error("Failed to load executions:", error);
    } finally {
      setLoadingExecutions(null);
    }
  }

  function handleToggleExpand(orchId: string) {
    if (expandedId === orchId) {
      setExpandedId(null);
    } else {
      setExpandedId(orchId);
      if (!executions[orchId]) {
        loadExecutions(orchId);
      }
    }
  }

  async function handleExecute() {
    if (!executeModalId) return;
    try {
      setExecuting(true);
      let input: Record<string, unknown> | undefined;
      if (executeInput.trim()) {
        input = JSON.parse(executeInput);
      }
      await orchestrationApi.execute(executeModalId, input);
      setExecuteModalId(null);
      setExecuteInput("");
      loadData();
      if (expandedId === executeModalId) {
        loadExecutions(executeModalId);
      }
    } catch (error) {
      console.error("Failed to execute orchestration:", error);
      toast.error(
        error instanceof SyntaxError
          ? "Invalid JSON input."
          : getErrorMessage(error, "Failed to execute orchestration")
      );
    } finally {
      setExecuting(false);
    }
  }

  async function handleToggle(orch: Orchestration) {
    try {
      await orchestrationApi.update(orch.id, { isEnabled: !orch.isEnabled });
      loadData();
    } catch (error) {
      console.error("Failed to toggle orchestration:", error);
    }
  }

  async function handleDelete(orchId: string) {
    if (!(await confirmAction({ title: "Delete this orchestration?", destructive: true }))) return;
    try {
      await orchestrationApi.delete(orchId);
      if (expandedId === orchId) setExpandedId(null);
      loadData();
    } catch (error) {
      console.error("Failed to delete orchestration:", error);
    }
  }

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="h-8 w-64 bg-card animate-pulse rounded" />
        <div className="grid grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="h-24 bg-card border border-border rounded-lg animate-pulse"
            />
          ))}
        </div>
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="h-32 bg-card border border-border rounded-lg animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="p-6 space-y-6 min-h-screen bg-background">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-primary flex items-center gap-3">
            <Network className="h-7 w-7" />
            Multi-Agent Orchestration
          </h1>
          <p className="text-gray-400 mt-1">
            Coordinate multiple agents in sequential, parallel, and conditional
            workflows
          </p>
        </div>
        <button
          onClick={() =>
            toast.info(
              "Create orchestration form would open here. Use the API to create orchestrations."
            )
          }
          className="flex items-center gap-2 px-4 py-2 bg-primary/20 text-primary border border-primary/30 rounded-lg hover:bg-primary/30 transition-colors font-medium"
        >
          <Plus className="h-4 w-4" />
          New Orchestration
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            icon={Network}
            label="Total Orchestrations"
            value={stats.totalOrchestrations}
          />
          <StatCard
            icon={Activity}
            label="Active"
            value={stats.activeOrchestrations}
            accent="green"
          />
          <StatCard
            icon={Play}
            label="Total Executions"
            value={stats.totalExecutions}
            accent="cyan"
          />
        </div>
      )}

      {/* Orchestration Cards */}
      {orchestrations.length === 0 ? (
        <div className="bg-card border border-border rounded-lg p-12 text-center">
          <Network className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-300 mb-2">
            No orchestrations yet
          </h3>
          <p className="text-muted-foreground mb-6">
            Create your first multi-agent orchestration to coordinate workflows
          </p>
          <button
            onClick={() =>
              toast.info(
                "Create orchestration form would open here. Use the API to create orchestrations."
              )
            }
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary/20 text-primary border border-primary/30 rounded-lg hover:bg-primary/30 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New Orchestration
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {orchestrations.map((orch) => (
            <OrchestrationCard
              key={orch.id}
              orchestration={orch}
              isExpanded={expandedId === orch.id}
              executions={executions[orch.id] || []}
              loadingExecutions={loadingExecutions === orch.id}
              onToggleExpand={() => handleToggleExpand(orch.id)}
              onExecute={() => {
                setExecuteModalId(orch.id);
                setExecuteInput("");
              }}
              onToggle={() => handleToggle(orch)}
              onDelete={() => handleDelete(orch.id)}
            />
          ))}
        </div>
      )}

      {/* Execute Modal */}
      {executeModalId && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-card border border-border rounded-lg p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-primary">
                Execute Orchestration
              </h2>
              <button
                onClick={() => setExecuteModalId(null)}
                className="p-1 text-gray-400 hover:text-gray-200 hover:bg-border rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Input JSON (optional)
                </label>
                <textarea
                  value={executeInput}
                  onChange={(e) => setExecuteInput(e.target.value)}
                  placeholder='{"key": "value"}'
                  rows={6}
                  className="w-full px-3 py-2 bg-background border border-input rounded-lg text-foreground font-mono text-sm placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setExecuteModalId(null)}
                  className="flex-1 px-4 py-2 border border-border text-gray-400 rounded-lg hover:bg-border/50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleExecute}
                  disabled={executing}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-primary/20 text-primary border border-primary/30 rounded-lg hover:bg-primary/30 disabled:opacity-50 transition-colors"
                >
                  {executing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Running...
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4" />
                      Execute
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat Card
// ---------------------------------------------------------------------------
function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  accent?: "green" | "cyan" | "purple";
}) {
  const accentStyles = {
    green: "text-primary bg-primary/10 border-primary/20",
    cyan: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
    purple: "text-purple-400 bg-purple-500/10 border-purple-500/20",
  };

  const iconAccent = accent ? accentStyles[accent] : "text-gray-400 bg-gray-500/10 border-gray-500/20";

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center gap-3">
        <div className={`p-2.5 rounded-lg border ${iconAccent}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm text-gray-400">{label}</p>
          <p className="text-2xl font-bold text-gray-100">{value}</p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Orchestration Card
// ---------------------------------------------------------------------------
function OrchestrationCard({
  orchestration,
  isExpanded,
  executions,
  loadingExecutions,
  onToggleExpand,
  onExecute,
  onToggle,
  onDelete,
}: {
  orchestration: Orchestration;
  isExpanded: boolean;
  executions: OrchestrationExecution[];
  loadingExecutions: boolean;
  onToggleExpand: () => void;
  onExecute: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const mode = orchestration.executionMode;
  const ModeIcon = modeIcons[mode] || Workflow;
  const badgeStyle =
    modeBadgeStyles[mode] || "bg-gray-500/20 text-gray-400 border-gray-500/30";
  const stepsCount = orchestration.steps?.length ?? 0;
  const successRate =
    orchestration.totalRuns > 0
      ? ((orchestration.successfulRuns / orchestration.totalRuns) * 100).toFixed(
          0
        )
      : null;

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden hover:border-primary/30 transition-colors">
      {/* Card Header */}
      <div className="p-5">
        <div className="flex items-start justify-between">
          {/* Left: Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-1">
              <button
                onClick={onToggleExpand}
                className="text-lg font-semibold text-gray-100 hover:text-primary transition-colors truncate"
              >
                {orchestration.name}
              </button>

              {/* Mode Badge */}
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${badgeStyle}`}
              >
                <ModeIcon className="h-3 w-3" />
                {mode}
              </span>

              {/* Enabled/Disabled */}
              {!orchestration.isEnabled && (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-500/20 text-muted-foreground border border-gray-500/30">
                  disabled
                </span>
              )}
            </div>

            {orchestration.description && (
              <p className="text-sm text-gray-400 mt-1 line-clamp-2">
                {orchestration.description}
              </p>
            )}

            {/* Metrics Row */}
            <div className="flex items-center gap-5 mt-3 text-sm">
              <span className="flex items-center gap-1.5 text-gray-400">
                <Layers className="h-3.5 w-3.5" />
                {stepsCount} step{stepsCount !== 1 ? "s" : ""}
              </span>

              <span className="flex items-center gap-1.5 text-gray-400">
                <Play className="h-3.5 w-3.5" />
                {orchestration.totalRuns} run
                {orchestration.totalRuns !== 1 ? "s" : ""}
              </span>

              <span className="flex items-center gap-1.5 text-green-400">
                <CheckCircle className="h-3.5 w-3.5" />
                {orchestration.successfulRuns}
              </span>

              <span className="flex items-center gap-1.5 text-red-400">
                <XCircle className="h-3.5 w-3.5" />
                {orchestration.failedRuns}
              </span>

              {successRate !== null && (
                <span className="text-muted-foreground">({successRate}%)</span>
              )}

              <span className="flex items-center gap-1.5 text-gray-400">
                <Timer className="h-3.5 w-3.5" />
                {formatDuration(orchestration.avgDurationMs)}
              </span>

              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                {formatRelativeTime(orchestration.lastRunAt)}
              </span>
            </div>
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-2 ml-4">
            <button
              onClick={onExecute}
              disabled={!orchestration.isEnabled}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary/20 text-primary border border-primary/30 rounded-lg hover:bg-primary/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Execute"
            >
              <Play className="h-3.5 w-3.5" />
              Execute
            </button>

            <button
              onClick={onToggle}
              className={`p-2 rounded-lg transition-colors ${
                orchestration.isEnabled
                  ? "text-green-400 hover:bg-green-500/10"
                  : "text-muted-foreground hover:bg-gray-500/10"
              }`}
              title={orchestration.isEnabled ? "Disable" : "Enable"}
            >
              {orchestration.isEnabled ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </button>

            <button
              onClick={onDelete}
              className="p-2 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
              title="Delete"
            >
              <Trash2 className="h-4 w-4" />
            </button>

            <button
              onClick={onToggleExpand}
              className="p-2 text-muted-foreground hover:text-gray-300 hover:bg-border rounded-lg transition-colors"
              title={isExpanded ? "Collapse" : "Show executions"}
            >
              {isExpanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Expanded: Recent Executions */}
      {isExpanded && (
        <div className="border-t border-border bg-background/50 px-5 py-4">
          <h4 className="text-sm font-medium text-gray-300 mb-3">
            Recent Executions
          </h4>

          {loadingExecutions ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <span className="ml-2 text-sm text-gray-400">
                Loading executions...
              </span>
            </div>
          ) : executions.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground text-sm">
              No executions yet. Click Execute to run this orchestration.
            </div>
          ) : (
            <div className="space-y-2">
              {executions.map((exec) => (
                <ExecutionRow key={exec.id} execution={exec} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Execution Row
// ---------------------------------------------------------------------------
function ExecutionRow({ execution }: { execution: OrchestrationExecution }) {
  const sc = getStatusConfig(execution.status);
  const StatusIcon =
    execution.status === "completed"
      ? CheckCircle
      : execution.status === "failed"
        ? XCircle
        : execution.status === "running"
          ? Loader2
          : execution.status === "cancelled"
            ? AlertTriangle
            : Clock;

  return (
    <div className="flex items-center gap-4 p-3 bg-card/50 border border-border/50 rounded-lg">
      {/* Status Icon */}
      <div className={`p-1.5 rounded ${sc.bgColor}`}>
        <StatusIcon
          className={`h-4 w-4 ${sc.color} ${execution.status === "running" ? "animate-spin" : ""}`}
        />
      </div>

      {/* Progress Bar */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-gray-400 font-mono truncate">
            {execution.id.slice(0, 8)}
          </span>
          <span className={`text-xs font-medium ${sc.color}`}>
            {execution.status}
          </span>
        </div>
        <div className="w-full h-1.5 bg-background rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${sc.barColor} ${
              sc.pulse ? "animate-pulse" : ""
            }`}
            style={{ width: `${Math.max(execution.progress, 2)}%` }}
          />
        </div>
      </div>

      {/* Meta */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
        <span>{execution.progress}%</span>
        <span>{formatDuration(execution.durationMs)}</span>
        <span>{formatRelativeTime(execution.startedAt || execution.createdAt)}</span>
      </div>

      {/* Error indicator */}
      {execution.error && (
        <span
          className="text-red-400 cursor-help"
          title={execution.error}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
        </span>
      )}
    </div>
  );
}
