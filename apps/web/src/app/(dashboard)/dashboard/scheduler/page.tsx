"use client";

import { useState, useEffect } from "react";
import {
  Calendar,
  Clock,
  Plus,
  Play,
  Pause,
  Trash2,
  Zap,
  CheckCircle,
  XCircle,
  BarChart3,
  Timer,
  RefreshCw,
  X,
  AlertTriangle,
} from "lucide-react";
import {
  schedulerApi,
  agentsApi,
  type ScheduledTask,
  type TaskExecution,
  type SchedulerStats,
  type Agent,
  getErrorMessage,
} from "@/lib/api";
import { Skeleton, SkeletonCard, SkeletonTable } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";

type Tab = "tasks" | "executions";

const statusBadgeClasses: Record<string, string> = {
  active: "bg-green-500/15 text-green-400 border border-green-500/30",
  paused: "bg-yellow-500/15 text-yellow-400 border border-yellow-500/30",
  completed: "bg-blue-500/15 text-blue-400 border border-blue-500/30",
  failed: "bg-red-500/15 text-red-400 border border-red-500/30",
  disabled: "bg-gray-500/15 text-gray-400 border border-gray-500/30",
  running: "bg-cyan-500/15 text-cyan-400 border border-cyan-500/30",
  pending: "bg-yellow-500/15 text-yellow-400 border border-yellow-500/30",
  success: "bg-green-500/15 text-green-400 border border-green-500/30",
  error: "bg-red-500/15 text-red-400 border border-red-500/30",
};

function getStatusBadge(status: string): string {
  return statusBadgeClasses[status] ?? statusBadgeClasses.disabled ?? "";
}

function formatSchedule(task: ScheduledTask): string {
  if (task.scheduleType === "interval" && task.intervalSeconds) {
    const seconds = task.intervalSeconds;
    if (seconds < 60) return `Every ${seconds}s`;
    if (seconds < 3600) return `Every ${Math.floor(seconds / 60)} min`;
    if (seconds < 86400) return `Every ${Math.floor(seconds / 3600)}h`;
    return `Every ${Math.floor(seconds / 86400)}d`;
  }
  if (task.scheduleType === "cron" && task.cronExpression) {
    return task.cronExpression;
  }
  if (task.scheduleType === "once" && task.scheduledAt) {
    return new Date(task.scheduledAt).toLocaleString();
  }
  return "N/A";
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(Math.abs(diffMs) / 60000);
  const diffHours = Math.floor(Math.abs(diffMs) / 3600000);
  const diffDays = Math.floor(Math.abs(diffMs) / 86400000);
  const isFuture = diffMs < 0;

  if (diffMins < 1) return isFuture ? "In a moment" : "Just now";
  if (diffMins < 60) return isFuture ? `In ${diffMins}m` : `${diffMins}m ago`;
  if (diffHours < 24) return isFuture ? `In ${diffHours}h` : `${diffHours}h ago`;
  if (diffDays < 7) return isFuture ? `In ${diffDays}d` : `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function formatDuration(ms?: number): string {
  if (!ms) return "N/A";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function getTaskSuccessRate(task: ScheduledTask): string {
  if (task.totalRuns === 0) return "N/A";
  return `${((task.successfulRuns / task.totalRuns) * 100).toFixed(0)}%`;
}

export default function SchedulerPage() {
  const confirmAction = useConfirm();
  const [activeTab, setActiveTab] = useState<Tab>("tasks");
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<SchedulerStats | null>(null);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [executions, setExecutions] = useState<TaskExecution[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (activeTab === "executions" && tasks.length > 0) {
      loadExecutions(selectedTaskId || tasks[0]?.id);
    }
  }, [activeTab, selectedTaskId]);

  async function loadData() {
    try {
      setLoading(true);
      const [statsRes, tasksRes, agentsRes] = await Promise.all([
        schedulerApi.getStats(),
        schedulerApi.list({ limit: 50 }),
        agentsApi.list(),
      ]);
      setStats(statsRes);
      setTasks(tasksRes.tasks);
      setAgents(agentsRes.agents);
    } catch (error) {
      console.error("Failed to load scheduler data:", error);
    } finally {
      setLoading(false);
    }
  }

  async function loadExecutions(taskId?: string) {
    if (!taskId) return;
    try {
      const res = await schedulerApi.getExecutions(taskId, { limit: 50 });
      setExecutions(res.executions);
    } catch (error) {
      console.error("Failed to load executions:", error);
    }
  }

  async function handleTrigger(taskId: string) {
    try {
      await schedulerApi.trigger(taskId);
      loadData();
    } catch (error) {
      console.error("Failed to trigger task:", error);
      toast.error(getErrorMessage(error, "Failed to trigger task"));
    }
  }

  async function handleToggle(taskId: string, isEnabled: boolean) {
    try {
      await schedulerApi.toggle(taskId, isEnabled);
      loadData();
    } catch (error) {
      console.error("Failed to toggle task:", error);
      toast.error(getErrorMessage(error, "Failed to toggle task"));
    }
  }

  async function handleDelete(taskId: string) {
    if (!(await confirmAction({ title: "Delete this scheduled task?", destructive: true }))) return;
    try {
      await schedulerApi.delete(taskId);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
      loadData();
    } catch (error) {
      console.error("Failed to delete task:", error);
    }
  }

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
          <Skeleton className="h-10 w-28" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
        <SkeletonTable rows={5} cols={7} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Scheduled Tasks</h1>
          <p className="text-muted-foreground mt-1">
            Manage cron jobs and scheduled task executions for your agents
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground font-semibold rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Task
        </button>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <StatsCard
            icon={Calendar}
            label="Total Tasks"
            value={stats.totalTasks}
          />
          <StatsCard
            icon={Play}
            label="Active"
            value={stats.activeTasks}
            accent="green"
          />
          <StatsCard
            icon={Pause}
            label="Paused"
            value={stats.pausedTasks}
            accent="yellow"
          />
          <StatsCard
            icon={Zap}
            label="Runs Today"
            value={stats.totalRunsToday}
            accent="cyan"
          />
          <StatsCard
            icon={BarChart3}
            label="Success Rate"
            value={`${stats.successRateToday.toFixed(0)}%`}
            accent="green"
          />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {(["tasks", "executions"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors capitalize ${
              activeTab === tab
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tasks Tab */}
      {activeTab === "tasks" && (
        <div className="bg-card border rounded-lg overflow-hidden">
          {tasks.length === 0 ? (
            <div className="p-12 text-center">
              <Calendar className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-30" />
              <h3 className="text-lg font-medium mb-2">No scheduled tasks</h3>
              <p className="text-muted-foreground text-sm mb-4">
                Create a scheduled task to automate your agent workflows
              </p>
              <button
                onClick={() => setShowCreateModal(true)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground font-semibold rounded-lg hover:bg-primary/90 transition-colors"
              >
                <Plus className="h-4 w-4" />
                New Task
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Name
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Schedule
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Status
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Last Run
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Next Run
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Success Rate
                    </th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {tasks.map((task) => {
                    const agent = agents.find((a) => a.id === task.agentId);
                    return (
                      <tr
                        key={task.id}
                        className="hover:bg-muted/50 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <div>
                            <div className="font-medium text-foreground">
                              {task.name}
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5">
                              {agent?.name || "Unknown Agent"} &middot;{" "}
                              <span className="text-muted-foreground/70">
                                {task.taskType}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Timer className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-sm font-mono text-foreground">
                              {formatSchedule(task)}
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 capitalize">
                            {task.scheduleType}
                            {task.timezone && task.timezone !== "UTC"
                              ? ` (${task.timezone})`
                              : ""}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${getStatusBadge(
                              task.status
                            )}`}
                          >
                            {task.status}
                          </span>
                          {task.lastRunStatus && task.lastRunStatus !== task.status && (
                            <div className="mt-1">
                              <span
                                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium capitalize ${getStatusBadge(
                                  task.lastRunStatus
                                )}`}
                              >
                                Last: {task.lastRunStatus}
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-sm text-foreground">
                            {formatDate(task.lastRunAt)}
                          </div>
                          {task.lastRunDurationMs != null && (
                            <div className="text-xs text-muted-foreground mt-0.5">
                              {formatDuration(task.lastRunDurationMs)}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-sm text-foreground">
                            {formatDate(task.nextRunAt)}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-sm font-medium text-foreground">
                            {getTaskSuccessRate(task)}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {task.successfulRuns}/{task.totalRuns} runs
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => handleTrigger(task.id)}
                              className="p-1.5 rounded-md text-muted-foreground hover:text-cyan-400 hover:bg-cyan-500/10 transition-colors"
                              title="Trigger now"
                            >
                              <Zap className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() =>
                                handleToggle(task.id, !task.isEnabled)
                              }
                              className={`p-1.5 rounded-md transition-colors ${
                                task.isEnabled
                                  ? "text-green-400 hover:bg-green-500/10"
                                  : "text-muted-foreground hover:bg-yellow-500/10 hover:text-yellow-400"
                              }`}
                              title={
                                task.isEnabled ? "Pause task" : "Resume task"
                              }
                            >
                              {task.isEnabled ? (
                                <Pause className="h-4 w-4" />
                              ) : (
                                <Play className="h-4 w-4" />
                              )}
                            </button>
                            <button
                              onClick={() => handleDelete(task.id)}
                              className="p-1.5 rounded-md text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
                              title="Delete task"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Executions Tab */}
      {activeTab === "executions" && (
        <div className="space-y-4">
          {/* Task selector */}
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-muted-foreground">
              Task:
            </label>
            <select
              value={selectedTaskId || tasks[0]?.id || ""}
              onChange={(e) => {
                setSelectedTaskId(e.target.value);
                loadExecutions(e.target.value);
              }}
              className="px-3 py-1.5 bg-background border border-border rounded-lg text-sm text-foreground focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-colors"
            >
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.name}
                </option>
              ))}
            </select>
            <button
              onClick={() =>
                loadExecutions(selectedTaskId || tasks[0]?.id)
              }
              className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>

          <div className="bg-card border rounded-lg overflow-hidden">
            {executions.length === 0 ? (
              <div className="p-12 text-center">
                <Clock className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-30" />
                <h3 className="text-lg font-medium mb-2">No executions yet</h3>
                <p className="text-muted-foreground text-sm">
                  Executions will appear here once the task runs
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Status
                      </th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Started
                      </th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Duration
                      </th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Attempt
                      </th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Triggered By
                      </th>
                      <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Error
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {executions.map((exec) => (
                      <tr
                        key={exec.id}
                        className="hover:bg-muted/50 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium capitalize ${getStatusBadge(
                              exec.status
                            )}`}
                          >
                            {exec.status === "success" && (
                              <CheckCircle className="h-3 w-3" />
                            )}
                            {(exec.status === "failed" ||
                              exec.status === "error") && (
                              <XCircle className="h-3 w-3" />
                            )}
                            {exec.status === "running" && (
                              <RefreshCw className="h-3 w-3 animate-spin" />
                            )}
                            {exec.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-foreground">
                          {exec.startedAt
                            ? new Date(exec.startedAt).toLocaleString()
                            : "Pending"}
                        </td>
                        <td className="px-4 py-3 text-sm text-foreground font-mono">
                          {formatDuration(exec.durationMs)}
                        </td>
                        <td className="px-4 py-3 text-sm text-foreground">
                          {exec.attempt}
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground capitalize">
                            {exec.triggeredBy}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {exec.error ? (
                            <span
                              className="text-xs text-red-400 max-w-xs truncate block"
                              title={exec.error}
                            >
                              {exec.error}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              --
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create Task Modal */}
      {showCreateModal && (
        <CreateTaskModal
          agents={agents}
          onClose={() => setShowCreateModal(false)}
          onSave={loadData}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stats Card                                                          */
/* ------------------------------------------------------------------ */

function StatsCard({
  icon: Icon,
  label,
  value,
  accent = "default",
}: {
  icon: React.ElementType;
  label: string;
  value: number | string;
  accent?: "default" | "green" | "yellow" | "cyan" | "red";
}) {
  const accentStyles = {
    default: "text-muted-foreground bg-muted",
    green: "text-green-400 bg-green-500/10",
    yellow: "text-yellow-400 bg-yellow-500/10",
    cyan: "text-cyan-400 bg-cyan-500/10",
    red: "text-red-400 bg-red-500/10",
  };

  return (
    <div className="bg-card border rounded-lg p-4">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg ${accentStyles[accent]}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-lg font-bold text-foreground">{value}</p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Create Task Modal                                                    */
/* ------------------------------------------------------------------ */

function CreateTaskModal({
  agents,
  onClose,
  onSave,
}: {
  agents: Agent[];
  onClose: () => void;
  onSave: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "",
    agentId: "",
    scheduleType: "cron" as "cron" | "interval" | "once",
    cronExpression: "",
    intervalSeconds: 300,
    scheduledAt: "",
    taskType: "agent_run",
    timezone: "UTC",
  });

  function updateForm(updates: Partial<typeof form>) {
    setForm((prev) => ({ ...prev, ...updates }));
  }

  async function handleCreate() {
    if (!form.name || !form.agentId) return;
    setSaving(true);
    try {
      const payload: Partial<ScheduledTask> = {
        name: form.name,
        agentId: form.agentId,
        scheduleType: form.scheduleType,
        taskType: form.taskType,
        timezone: form.timezone,
      };

      if (form.scheduleType === "cron") {
        payload.cronExpression = form.cronExpression;
      } else if (form.scheduleType === "interval") {
        payload.intervalSeconds = form.intervalSeconds;
      } else if (form.scheduleType === "once") {
        payload.scheduledAt = form.scheduledAt;
      }

      await schedulerApi.create(payload);
      onSave();
      onClose();
    } catch (error) {
      console.error("Failed to create task:", error);
      toast.error(getErrorMessage(error, "Failed to create task"));
    } finally {
      setSaving(false);
    }
  }

  const isValid =
    form.name &&
    form.agentId &&
    ((form.scheduleType === "cron" && form.cronExpression) ||
      (form.scheduleType === "interval" && form.intervalSeconds > 0) ||
      (form.scheduleType === "once" && form.scheduledAt));

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-xl p-6 w-full max-w-lg shadow-lg shadow-black/30">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-foreground">
            Create Scheduled Task
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Task Name */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Name
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => updateForm({ name: e.target.value })}
              placeholder="Daily data sync"
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-colors"
            />
          </div>

          {/* Agent */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Agent
            </label>
            <select
              value={form.agentId}
              onChange={(e) => updateForm({ agentId: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-colors"
            >
              <option value="">Select an agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>

          {/* Schedule Type */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Schedule Type
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(["cron", "interval", "once"] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => updateForm({ scheduleType: type })}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors capitalize ${
                    form.scheduleType === type
                      ? "bg-primary/15 text-primary border border-primary/30"
                      : "bg-muted text-muted-foreground border border-transparent hover:border-border"
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          {/* Schedule Value */}
          {form.scheduleType === "cron" && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Cron Expression
              </label>
              <input
                type="text"
                value={form.cronExpression}
                onChange={(e) =>
                  updateForm({ cronExpression: e.target.value })
                }
                placeholder="*/5 * * * *"
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground font-mono placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-colors"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Standard cron syntax: minute hour day month weekday
              </p>
            </div>
          )}

          {form.scheduleType === "interval" && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Interval (seconds)
              </label>
              <input
                type="number"
                min={1}
                value={form.intervalSeconds}
                onChange={(e) =>
                  updateForm({
                    intervalSeconds: parseInt(e.target.value) || 0,
                  })
                }
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground font-mono focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-colors"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {form.intervalSeconds > 0
                  ? `Runs every ${formatSchedule({
                      scheduleType: "interval",
                      intervalSeconds: form.intervalSeconds,
                    } as ScheduledTask)}`
                  : "Enter interval in seconds"}
              </p>
            </div>
          )}

          {form.scheduleType === "once" && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Scheduled At
              </label>
              <input
                type="datetime-local"
                value={form.scheduledAt}
                onChange={(e) =>
                  updateForm({ scheduledAt: e.target.value })
                }
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-colors"
              />
            </div>
          )}

          {/* Task Type */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Task Type
            </label>
            {/* Only the types the execution engine actually runs — the
                other four advertised here were backed by nothing and are
                offered again when their executors exist. */}
            <select
              value={form.taskType}
              onChange={(e) => updateForm({ taskType: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-colors"
            >
              <option value="agent_run">Agent Run — prompt your agent on a schedule</option>
              <option value="webhook">Webhook — POST to a URL on a schedule</option>
            </select>
          </div>

          {/* Timezone */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Timezone
            </label>
            <select
              value={form.timezone}
              onChange={(e) => updateForm({ timezone: e.target.value })}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-colors"
            >
              <option value="UTC">UTC</option>
              <option value="America/New_York">America/New_York (EST)</option>
              <option value="America/Chicago">America/Chicago (CST)</option>
              <option value="America/Denver">America/Denver (MST)</option>
              <option value="America/Los_Angeles">
                America/Los_Angeles (PST)
              </option>
              <option value="Europe/London">Europe/London (GMT)</option>
              <option value="Europe/Berlin">Europe/Berlin (CET)</option>
              <option value="Asia/Tokyo">Asia/Tokyo (JST)</option>
              <option value="Asia/Shanghai">Asia/Shanghai (CST)</option>
              <option value="Australia/Sydney">Australia/Sydney (AEST)</option>
            </select>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 mt-6 pt-4 border-t border-border">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-border rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={saving || !isValid}
            className="flex-1 px-4 py-2 bg-primary text-primary-foreground font-semibold rounded-lg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? "Creating..." : "Create Task"}
          </button>
        </div>
      </div>
    </div>
  );
}
