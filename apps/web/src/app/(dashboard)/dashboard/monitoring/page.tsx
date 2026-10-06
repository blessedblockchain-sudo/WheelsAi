"use client";

import { useState, useEffect } from "react";
import {
  Bell,
  Activity,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  Plus,
  Settings,
  Trash2,
  Play,
  Pause,
  Eye,
  ChevronRight,
  Slack,
  MessageCircle,
  Mail,
  Webhook,
  X,
} from "lucide-react";
import {
  monitoringApi,
  type AlertChannel,
  type AlertRule,
  type Alert,
  type UptimeMonitor,
  type AlertStats,
  type UptimeSummary,
  getErrorMessage,
} from "@/lib/api";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";

type Tab = "overview" | "alerts" | "rules" | "channels" | "uptime";

const severityColors = {
  info: "bg-blue-500/10 text-blue-500",
  warning: "bg-yellow-500/10 text-yellow-500",
  critical: "bg-red-500/10 text-red-500",
};

const statusColors = {
  active: "bg-red-500/10 text-red-500",
  acknowledged: "bg-yellow-500/10 text-yellow-500",
  resolved: "bg-green-500/10 text-green-500",
};

const channelIcons = {
  slack: Slack,
  discord: MessageCircle,
  email: Mail,
  webhook: Webhook,
  pagerduty: Bell,
};

export default function MonitoringPage() {
  const confirmAction = useConfirm();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  // Data states
  const [alertStats, setAlertStats] = useState<AlertStats | null>(null);
  const [uptimeSummary, setUptimeSummary] = useState<UptimeSummary | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [uptimeMonitors, setUptimeMonitors] = useState<UptimeMonitor[]>([]);

  // Modal states
  const [showChannelModal, setShowChannelModal] = useState(false);
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [showUptimeModal, setShowUptimeModal] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoadError(null);
    try {
      const [statsRes, uptimeRes, alertsRes, rulesRes, channelsRes, monitorsRes] =
        await Promise.all([
          monitoringApi.getAlertStats(),
          monitoringApi.getUptimeSummary(),
          monitoringApi.getAlerts({ status: "active", limit: 10 }),
          monitoringApi.getRules(),
          monitoringApi.getChannels(),
          monitoringApi.getUptimeMonitors(),
        ]);

      setAlertStats(statsRes.data);
      setUptimeSummary(uptimeRes.data);
      setAlerts(alertsRes.data);
      setRules(rulesRes.data);
      setChannels(channelsRes.data);
      setUptimeMonitors(monitorsRes.data);
    } catch (error) {
      console.error("Failed to load monitoring data:", error);
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  }

  // loadData also refreshes in place after actions, so only a retry from the
  // error state brings the skeleton back.
  function retryLoad() {
    setLoading(true);
    void loadData();
  }

  async function handleAcknowledgeAlert(alertId: string) {
    try {
      await monitoringApi.acknowledgeAlert(alertId);
      loadData();
    } catch (error) {
      console.error("Failed to acknowledge alert:", error);
    }
  }

  async function handleResolveAlert(alertId: string) {
    try {
      await monitoringApi.resolveAlert(alertId);
      loadData();
    } catch (error) {
      console.error("Failed to resolve alert:", error);
    }
  }

  async function handleToggleRule(ruleId: string, isEnabled: boolean) {
    try {
      await monitoringApi.toggleRule(ruleId, isEnabled);
      loadData();
    } catch (error) {
      console.error("Failed to toggle rule:", error);
    }
  }

  async function handleDeleteRule(ruleId: string) {
    if (!(await confirmAction({ title: "Delete this alert rule?", destructive: true }))) return;
    try {
      await monitoringApi.deleteRule(ruleId);
      loadData();
    } catch (error) {
      console.error("Failed to delete rule:", error);
    }
  }

  async function handleTestChannel(channelId: string) {
    try {
      await monitoringApi.testChannel(channelId);
      toast.success("Test notification sent!");
    } catch (error) {
      toast.error(`Failed to send test: ${getErrorMessage(error)}`);
    }
  }

  async function handleDeleteChannel(channelId: string) {
    if (!(await confirmAction({ title: "Delete this channel?", destructive: true }))) return;
    try {
      await monitoringApi.deleteChannel(channelId);
      loadData();
    } catch (error) {
      console.error("Failed to delete channel:", error);
    }
  }

  const header = (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold">Monitoring</h1>
        <p className="text-muted-foreground">
          Alerts, uptime monitoring, and notification channels
        </p>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="p-6 space-y-6">
        {header}
        <MonitoringOverviewSkeleton />
      </div>
    );
  }

  if (loadError !== null) {
    return (
      <div className="p-6 space-y-6">
        {header}
        <ErrorState
          title="Couldn't load monitoring data"
          error={loadError}
          onRetry={retryLoad}
        />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      {header}

      {/* Tabs */}
      <div className="flex gap-2 border-b">
        {(["overview", "alerts", "rules", "channels", "uptime"] as Tab[]).map(
          (tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          )
        )}
      </div>

      {/* Overview Tab */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          {/* Stats Cards */}
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-card border rounded-lg p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-red-500/10 rounded-lg">
                  <AlertTriangle className="h-5 w-5 text-red-600" />
                </div>
                <div>
                  <div className="text-2xl font-bold">
                    {alertStats?.byStatus.find((s) => s.status === "active")?.count || 0}
                  </div>
                  <div className="text-sm text-muted-foreground">Active Alerts</div>
                </div>
              </div>
            </div>

            <div className="bg-card border rounded-lg p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-500/10 rounded-lg">
                  <CheckCircle className="h-5 w-5 text-green-600" />
                </div>
                <div>
                  <div className="text-2xl font-bold">
                    {uptimeSummary?.totalUp || 0}/{uptimeSummary?.totalMonitors || 0}
                  </div>
                  <div className="text-sm text-muted-foreground">Services Up</div>
                </div>
              </div>
            </div>

            <div className="bg-card border rounded-lg p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-500/10 rounded-lg">
                  <Activity className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <div className="text-2xl font-bold">
                    {uptimeSummary?.avgUptime24h?.toFixed(1) || "N/A"}%
                  </div>
                  <div className="text-sm text-muted-foreground">Avg Uptime (24h)</div>
                </div>
              </div>
            </div>

            <div className="bg-card border rounded-lg p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-500/10 rounded-lg">
                  <Bell className="h-5 w-5 text-purple-600" />
                </div>
                <div>
                  <div className="text-2xl font-bold">{rules.filter((r) => r.isEnabled).length}</div>
                  <div className="text-sm text-muted-foreground">Active Rules</div>
                </div>
              </div>
            </div>
          </div>

          {/* Recent Alerts */}
          <div className="bg-card border rounded-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Recent Alerts</h2>
              <button
                onClick={() => setActiveTab("alerts")}
                className="text-sm text-primary hover:underline flex items-center gap-1"
              >
                View all <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            {alerts.length === 0 ? (
              <EmptyState
                icon={CheckCircle}
                title="No active alerts"
                description="Alerts appear here when one of your alert rules is triggered."
              />
            ) : (
              <div className="space-y-3">
                {alerts.slice(0, 5).map((alert) => (
                  <div
                    key={alert.id}
                    className="flex items-center justify-between py-3 border-b last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${severityColors[alert.severity]}`}
                      >
                        {alert.severity}
                      </span>
                      <div>
                        <div className="font-medium">{alert.title}</div>
                        <div className="text-sm text-muted-foreground">{alert.message}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {new Date(alert.triggeredAt).toLocaleString()}
                      </span>
                      <button
                        onClick={() => handleAcknowledgeAlert(alert.id)}
                        className="p-1.5 hover:bg-accent rounded"
                        title="Acknowledge"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleResolveAlert(alert.id)}
                        className="p-1.5 hover:bg-accent rounded"
                        title="Resolve"
                      >
                        <CheckCircle className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Uptime Summary */}
          <div className="bg-card border rounded-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Uptime Status</h2>
              <button
                onClick={() => setActiveTab("uptime")}
                className="text-sm text-primary hover:underline flex items-center gap-1"
              >
                View all <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            {!uptimeSummary?.monitors.length ? (
              <EmptyState
                icon={Activity}
                title="No uptime monitors configured"
                description="Monitor your deployments and endpoints."
                actionLabel="Add Monitor"
                onAction={() => setShowUptimeModal(true)}
              />
            ) : (
              <div className="space-y-3">
                {uptimeSummary?.monitors.slice(0, 5).map((monitor) => (
                  <div
                    key={monitor.id}
                    className="flex items-center justify-between py-3 border-b last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      {monitor.currentStatus === "up" ? (
                        <CheckCircle className="h-5 w-5 text-green-500" />
                      ) : monitor.currentStatus === "down" ? (
                        <XCircle className="h-5 w-5 text-red-500" />
                      ) : (
                        <Clock className="h-5 w-5 text-gray-400" />
                      )}
                      <div>
                        <div className="font-medium">{monitor.name}</div>
                        <div className="text-sm text-muted-foreground">
                          {monitor.targetType}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium">
                        {monitor.uptimePercent24h?.toFixed(2) || "N/A"}%
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {monitor.avgLatencyMs?.toFixed(0) || "N/A"}ms
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Alerts Tab */}
      {activeTab === "alerts" && (
        <div className="bg-card border rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4">All Alerts</h2>

          {alerts.length === 0 ? (
            <EmptyState
              icon={CheckCircle}
              title="No alerts"
              description="Alerts appear here when one of your alert rules is triggered."
            />
          ) : (
            <div className="space-y-3">
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  className="flex items-center justify-between p-4 border rounded-lg"
                >
                  <div className="flex items-center gap-4">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${severityColors[alert.severity]}`}
                    >
                      {alert.severity}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[alert.status]}`}
                    >
                      {alert.status}
                    </span>
                    <div>
                      <div className="font-medium">{alert.title}</div>
                      <div className="text-sm text-muted-foreground">{alert.message}</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {new Date(alert.triggeredAt).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  {alert.status === "active" && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleAcknowledgeAlert(alert.id)}
                        className="px-3 py-1.5 text-sm border rounded-lg hover:bg-accent"
                      >
                        Acknowledge
                      </button>
                      <button
                        onClick={() => handleResolveAlert(alert.id)}
                        className="px-3 py-1.5 text-sm bg-green-500 text-white rounded-lg hover:bg-green-600"
                      >
                        Resolve
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Rules Tab */}
      {activeTab === "rules" && (
        <div className="bg-card border rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Alert Rules</h2>
            <button
              onClick={() => setShowRuleModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" />
              Create Rule
            </button>
          </div>

          {rules.length === 0 ? (
            <EmptyState
              icon={Bell}
              title="No alert rules configured"
              description="Create a rule to start monitoring."
              actionLabel="Create Rule"
              onAction={() => setShowRuleModal(true)}
            />
          ) : (
            <div className="space-y-3">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex items-center justify-between p-4 border rounded-lg"
                >
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => handleToggleRule(rule.id, !rule.isEnabled)}
                      className={`p-2 rounded-lg transition-colors ${
                        rule.isEnabled ? "bg-green-500/10 text-green-600" : "bg-muted text-gray-400"
                      }`}
                    >
                      {rule.isEnabled ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                    </button>
                    <div>
                      <div className="font-medium">{rule.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {rule.metric} {rule.operator} {rule.threshold} (window: {rule.windowMinutes}m)
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-medium ${severityColors[rule.severity]}`}
                        >
                          {rule.severity}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {rule.resourceType}
                          {rule._count?.alerts ? ` (${rule._count.alerts} active)` : ""}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleDeleteRule(rule.id)}
                      className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Channels Tab */}
      {activeTab === "channels" && (
        <div className="bg-card border rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Notification Channels</h2>
            <button
              onClick={() => setShowChannelModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" />
              Add Channel
            </button>
          </div>

          {channels.length === 0 ? (
            <EmptyState
              icon={Bell}
              title="No notification channels"
              description="Add Slack, Discord, or email to receive alerts."
              actionLabel="Add Channel"
              onAction={() => setShowChannelModal(true)}
            />
          ) : (
            <div className="space-y-3">
              {channels.map((channel) => {
                const Icon = channelIcons[channel.type] || Bell;
                return (
                  <div
                    key={channel.id}
                    className="flex items-center justify-between p-4 border rounded-lg"
                  >
                    <div className="flex items-center gap-4">
                      <div
                        className={`p-2 rounded-lg ${
                          channel.isEnabled ? "bg-primary/10" : "bg-muted"
                        }`}
                      >
                        <Icon
                          className={`h-5 w-5 ${
                            channel.isEnabled ? "text-primary" : "text-gray-400"
                          }`}
                        />
                      </div>
                      <div>
                        <div className="font-medium">{channel.name}</div>
                        <div className="text-sm text-muted-foreground capitalize">
                          {channel.type}
                        </div>
                        {channel.lastError && (
                          <div className="text-xs text-red-500 mt-1">{channel.lastError}</div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleTestChannel(channel.id)}
                        className="px-3 py-1.5 text-sm border rounded-lg hover:bg-accent"
                      >
                        Test
                      </button>
                      <button
                        onClick={() => handleDeleteChannel(channel.id)}
                        className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Uptime Tab */}
      {activeTab === "uptime" && (
        <div className="bg-card border rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Uptime Monitors</h2>
            <button
              onClick={() => setShowUptimeModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" />
              Add Monitor
            </button>
          </div>

          {uptimeMonitors.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No uptime monitors"
              description="Monitor your deployments and endpoints."
              actionLabel="Add Monitor"
              onAction={() => setShowUptimeModal(true)}
            />
          ) : (
            <div className="space-y-3">
              {uptimeMonitors.map((monitor) => (
                <div
                  key={monitor.id}
                  className="flex items-center justify-between p-4 border rounded-lg"
                >
                  <div className="flex items-center gap-4">
                    {monitor.currentStatus === "up" ? (
                      <CheckCircle className="h-6 w-6 text-green-500" />
                    ) : monitor.currentStatus === "down" ? (
                      <XCircle className="h-6 w-6 text-red-500" />
                    ) : (
                      <Clock className="h-6 w-6 text-gray-400" />
                    )}
                    <div>
                      <div className="font-medium">{monitor.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {monitor.targetUrl || monitor.targetType}
                      </div>
                      <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                        <span>Check every {monitor.checkIntervalSeconds}s</span>
                        {monitor.lastCheckAt && (
                          <span>Last: {new Date(monitor.lastCheckAt).toLocaleString()}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <div className="font-bold">
                          {monitor.uptimePercent24h?.toFixed(2) || "N/A"}%
                        </div>
                        <div className="text-xs text-muted-foreground">24h</div>
                      </div>
                      <div>
                        <div className="font-bold">
                          {monitor.uptimePercent7d?.toFixed(2) || "N/A"}%
                        </div>
                        <div className="text-xs text-muted-foreground">7d</div>
                      </div>
                      <div>
                        <div className="font-bold">
                          {monitor.avgLatencyMs?.toFixed(0) || "N/A"}ms
                        </div>
                        <div className="text-xs text-muted-foreground">Latency</div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Channel Modal (simplified) */}
      {showChannelModal && (
        <ChannelModal onClose={() => setShowChannelModal(false)} onSave={loadData} />
      )}

      {/* Rule Modal (simplified) */}
      {showRuleModal && (
        <RuleModal
          channels={channels}
          onClose={() => setShowRuleModal(false)}
          onSave={loadData}
        />
      )}

      {/* Uptime Modal (simplified) */}
      {showUptimeModal && (
        <UptimeModal onClose={() => setShowUptimeModal(false)} onSave={loadData} />
      )}
    </div>
  );
}

// Loading placeholder shaped like the Overview tab (the default tab)
function MonitoringOverviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      {/* Tabs */}
      <div className="flex gap-2 border-b">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="px-4 py-2 border-b-2 border-transparent">
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-card border rounded-lg p-4">
            <div className="flex items-center gap-3">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-7 w-16" />
                <Skeleton className="h-4 w-24" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Recent Alerts, Uptime Status */}
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="bg-card border rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-16" />
          </div>
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, j) => (
              <div
                key={j}
                className="flex items-center justify-between py-3 border-b last:border-0"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Skeleton className="h-5 w-14 shrink-0" />
                  <div className="min-w-0 space-y-2">
                    <Skeleton className="h-5 w-40 max-w-full" />
                    <Skeleton className="h-4 w-56 max-w-full" />
                  </div>
                </div>
                <Skeleton className="h-4 w-28 shrink-0" />
              </div>
            ))}
          </div>
        </div>
      ))}
      <span className="sr-only">Loading monitoring data</span>
    </div>
  );
}

// Channel Modal Component
function ChannelModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("slack");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await monitoringApi.createChannel({
        name,
        type: type as any,
        config: { webhookUrl },
      });
      onSave();
      onClose();
    } catch (error) {
      console.error("Failed to create channel:", error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card border rounded-lg p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Add Notification Channel</h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Slack Channel"
              className="w-full px-3 py-2 bg-background border rounded-lg"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full px-3 py-2 bg-background border rounded-lg"
            >
              <option value="slack">Slack</option>
              <option value="discord">Discord</option>
              <option value="webhook">Webhook</option>
              <option value="email">Email</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Webhook URL</label>
            <input
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://hooks.slack.com/..."
              className="w-full px-3 py-2 bg-background border rounded-lg"
            />
          </div>

          <div className="flex gap-2 pt-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 border rounded-lg hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !name || !webhookUrl}
              className="flex-1 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Rule Modal Component
function RuleModal({
  channels,
  onClose,
  onSave,
}: {
  channels: AlertChannel[];
  onClose: () => void;
  onSave: () => void;
}) {
  const [name, setName] = useState("");
  const [metric, setMetric] = useState("error_rate");
  const [operator, setOperator] = useState("gt");
  const [threshold, setThreshold] = useState("5");
  const [severity, setSeverity] = useState("warning");
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await monitoringApi.createRule({
        name,
        ruleType: "threshold",
        resourceType: "organization",
        metric,
        operator: operator as any,
        threshold: parseFloat(threshold),
        severity: severity as any,
        channelIds: selectedChannels,
      });
      onSave();
      onClose();
    } catch (error) {
      console.error("Failed to create rule:", error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card border rounded-lg p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Create Alert Rule</h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Rule Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="High Error Rate"
              className="w-full px-3 py-2 bg-background border rounded-lg"
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-sm font-medium mb-1">Metric</label>
              <select
                value={metric}
                onChange={(e) => setMetric(e.target.value)}
                className="w-full px-3 py-2 bg-background border rounded-lg text-sm"
              >
                <option value="error_rate">Error Rate</option>
                <option value="latency_p95">Latency P95</option>
                <option value="latency_avg">Avg Latency</option>
                <option value="request_count">Requests</option>
                <option value="cost">Cost</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Operator</label>
              <select
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
                className="w-full px-3 py-2 bg-background border rounded-lg text-sm"
              >
                <option value="gt">&gt;</option>
                <option value="gte">&gt;=</option>
                <option value="lt">&lt;</option>
                <option value="lte">&lt;=</option>
                <option value="eq">=</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Threshold</label>
              <input
                type="number"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                className="w-full px-3 py-2 bg-background border rounded-lg text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Severity</label>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              className="w-full px-3 py-2 bg-background border rounded-lg"
            >
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Notify Channels</label>
            <div className="space-y-2">
              {channels.map((channel) => (
                <label key={channel.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selectedChannels.includes(channel.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedChannels([...selectedChannels, channel.id]);
                      } else {
                        setSelectedChannels(selectedChannels.filter((id) => id !== channel.id));
                      }
                    }}
                  />
                  {channel.name} ({channel.type})
                </label>
              ))}
              {channels.length === 0 && (
                <p className="text-sm text-muted-foreground">No channels configured</p>
              )}
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 border rounded-lg hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !name}
              className="flex-1 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Create Rule"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Uptime Modal Component
function UptimeModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: () => void;
}) {
  const [name, setName] = useState("");
  const [targetType, setTargetType] = useState("custom_url");
  const [targetUrl, setTargetUrl] = useState("");
  const [interval, setInterval] = useState("60");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await monitoringApi.createUptimeMonitor({
        name,
        targetType: targetType as any,
        targetUrl,
        checkIntervalSeconds: parseInt(interval),
      });
      onSave();
      onClose();
    } catch (error) {
      console.error("Failed to create monitor:", error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card border rounded-lg p-6 w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Add Uptime Monitor</h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production API"
              className="w-full px-3 py-2 bg-background border rounded-lg"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Target Type</label>
            <select
              value={targetType}
              onChange={(e) => setTargetType(e.target.value)}
              className="w-full px-3 py-2 bg-background border rounded-lg"
            >
              <option value="custom_url">Custom URL</option>
              <option value="deployment">Deployment</option>
              <option value="agent">Agent</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">URL</label>
            <input
              type="url"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://api.example.com/health"
              className="w-full px-3 py-2 bg-background border rounded-lg"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Check Interval</label>
            <select
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              className="w-full px-3 py-2 bg-background border rounded-lg"
            >
              <option value="30">30 seconds</option>
              <option value="60">1 minute</option>
              <option value="300">5 minutes</option>
              <option value="600">10 minutes</option>
            </select>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 border rounded-lg hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !name || !targetUrl}
              className="flex-1 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Create Monitor"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
