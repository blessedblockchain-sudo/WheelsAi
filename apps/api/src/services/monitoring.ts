import { prisma } from "@wheelsai/db";
import { safeFetch } from "../lib/ssrfGuard.js";

// ============================================
// Alert Channels
// ============================================

export type ChannelType = "slack" | "discord" | "email" | "webhook" | "pagerduty";

export interface SlackConfig {
  webhookUrl: string;
  channel?: string;
  username?: string;
}

export interface DiscordConfig {
  webhookUrl: string;
}

export interface EmailConfig {
  emails: string[];
}

export interface WebhookConfig {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  secret?: string;
}

export interface PagerDutyConfig {
  integrationKey: string;
}

export type ChannelConfig =
  | SlackConfig
  | DiscordConfig
  | EmailConfig
  | WebhookConfig
  | PagerDutyConfig;

/**
 * Create an alert channel
 */
export async function createAlertChannel(
  orgId: string,
  name: string,
  type: ChannelType,
  config: ChannelConfig
) {
  return prisma.alertChannel.create({
    data: {
      orgId,
      name,
      type,
      config: config as any,
    },
  });
}

/**
 * Get all alert channels for an organization
 */
export async function getAlertChannels(orgId: string) {
  return prisma.alertChannel.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Update an alert channel
 */
export async function updateAlertChannel(
  channelId: string,
  orgId: string,
  updates: {
    name?: string;
    config?: ChannelConfig;
    isEnabled?: boolean;
  }
) {
  return prisma.alertChannel.update({
    where: { id: channelId, orgId },
    data: {
      name: updates.name,
      config: updates.config as any,
      isEnabled: updates.isEnabled,
    },
  });
}

/**
 * Delete an alert channel
 */
export async function deleteAlertChannel(channelId: string, orgId: string) {
  return prisma.alertChannel.delete({
    where: { id: channelId, orgId },
  });
}

/**
 * Test an alert channel by sending a test notification
 */
export async function testAlertChannel(channelId: string, orgId: string) {
  const channel = await prisma.alertChannel.findFirst({
    where: { id: channelId, orgId },
  });

  if (!channel) {
    throw new Error("Channel not found");
  }

  try {
    await sendNotification(channel.type as ChannelType, channel.config as any, {
      title: "Test Alert",
      message: "This is a test alert from WheelsAI monitoring.",
      severity: "info",
      timestamp: new Date().toISOString(),
    });

    await prisma.alertChannel.update({
      where: { id: channelId },
      data: { lastTestedAt: new Date(), lastError: null },
    });

    return { success: true };
  } catch (error: any) {
    await prisma.alertChannel.update({
      where: { id: channelId },
      data: { lastError: error.message },
    });

    throw error;
  }
}

// ============================================
// Alert Rules
// ============================================

export type RuleType = "threshold" | "anomaly" | "uptime" | "budget";
export type ResourceType = "deployment" | "agent" | "organization";
export type Metric =
  | "error_rate"
  | "latency_p95"
  | "latency_avg"
  | "request_count"
  | "cost"
  | "uptime";
export type Operator = "gt" | "gte" | "lt" | "lte" | "eq";
export type Severity = "info" | "warning" | "critical";

export interface CreateAlertRuleInput {
  name: string;
  description?: string;
  ruleType: RuleType;
  resourceType: ResourceType;
  resourceId?: string;
  metric: Metric;
  operator: Operator;
  threshold: number;
  windowMinutes?: number;
  severity?: Severity;
  cooldownMinutes?: number;
  channelIds: string[];
}

/**
 * Create an alert rule
 */
export async function createAlertRule(orgId: string, input: CreateAlertRuleInput) {
  const rule = await prisma.alertRule.create({
    data: {
      orgId,
      name: input.name,
      description: input.description,
      ruleType: input.ruleType,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metric: input.metric,
      operator: input.operator,
      threshold: input.threshold,
      windowMinutes: input.windowMinutes || 5,
      severity: input.severity || "warning",
      cooldownMinutes: input.cooldownMinutes || 60,
    },
  });

  // Link channels
  if (input.channelIds.length > 0) {
    await prisma.alertRuleChannel.createMany({
      data: input.channelIds.map((channelId) => ({
        ruleId: rule.id,
        channelId,
      })),
    });
  }

  return rule;
}

/**
 * Get all alert rules for an organization
 */
export async function getAlertRules(orgId: string) {
  return prisma.alertRule.findMany({
    where: { orgId },
    include: {
      channels: {
        include: {
          channel: true,
        },
      },
      _count: {
        select: { alerts: { where: { status: "active" } } },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Get a single alert rule
 */
export async function getAlertRule(ruleId: string, orgId: string) {
  return prisma.alertRule.findFirst({
    where: { id: ruleId, orgId },
    include: {
      channels: {
        include: {
          channel: true,
        },
      },
      alerts: {
        where: { status: "active" },
        orderBy: { triggeredAt: "desc" },
        take: 10,
      },
    },
  });
}

/**
 * Update an alert rule
 */
export async function updateAlertRule(
  ruleId: string,
  orgId: string,
  updates: Partial<CreateAlertRuleInput>
) {
  const rule = await prisma.alertRule.update({
    where: { id: ruleId, orgId },
    data: {
      name: updates.name,
      description: updates.description,
      ruleType: updates.ruleType,
      resourceType: updates.resourceType,
      resourceId: updates.resourceId,
      metric: updates.metric,
      operator: updates.operator,
      threshold: updates.threshold,
      windowMinutes: updates.windowMinutes,
      severity: updates.severity,
      cooldownMinutes: updates.cooldownMinutes,
    },
  });

  // Update channels if provided
  if (updates.channelIds) {
    await prisma.alertRuleChannel.deleteMany({
      where: { ruleId },
    });

    if (updates.channelIds.length > 0) {
      await prisma.alertRuleChannel.createMany({
        data: updates.channelIds.map((channelId) => ({
          ruleId,
          channelId,
        })),
      });
    }
  }

  return rule;
}

/**
 * Delete an alert rule
 */
export async function deleteAlertRule(ruleId: string, orgId: string) {
  return prisma.alertRule.delete({
    where: { id: ruleId, orgId },
  });
}

/**
 * Toggle alert rule enabled state
 */
export async function toggleAlertRule(ruleId: string, orgId: string, isEnabled: boolean) {
  return prisma.alertRule.update({
    where: { id: ruleId, orgId },
    data: { isEnabled },
  });
}

// ============================================
// Alerts
// ============================================

/**
 * Get all alerts for an organization
 */
export async function getAlerts(
  orgId: string,
  options: {
    status?: string;
    severity?: string;
    ruleId?: string;
    limit?: number;
    offset?: number;
  } = {}
) {
  const { status, severity, ruleId, limit = 50, offset = 0 } = options;

  const where: any = { orgId };
  if (status) where.status = status;
  if (severity) where.severity = severity;
  if (ruleId) where.ruleId = ruleId;

  const [alerts, total] = await Promise.all([
    prisma.alert.findMany({
      where,
      include: {
        rule: {
          select: { name: true, resourceType: true },
        },
      },
      orderBy: { triggeredAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.alert.count({ where }),
  ]);

  return { alerts, total };
}

/**
 * Acknowledge an alert
 */
export async function acknowledgeAlert(alertId: string, orgId: string, userId: string) {
  return prisma.alert.update({
    where: { id: alertId, orgId },
    data: {
      status: "acknowledged",
      acknowledgedAt: new Date(),
      acknowledgedBy: userId,
    },
  });
}

/**
 * Resolve an alert
 */
export async function resolveAlert(alertId: string, orgId: string, userId: string) {
  return prisma.alert.update({
    where: { id: alertId, orgId },
    data: {
      status: "resolved",
      resolvedAt: new Date(),
      resolvedBy: userId,
    },
  });
}

/**
 * Get alert statistics
 */
export async function getAlertStats(orgId: string, days: number = 7) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [byStatus, bySeverity, byRule, recent] = await Promise.all([
    prisma.alert.groupBy({
      by: ["status"],
      where: { orgId },
      _count: { status: true },
    }),
    prisma.alert.groupBy({
      by: ["severity"],
      where: { orgId, triggeredAt: { gte: since } },
      _count: { severity: true },
    }),
    prisma.alert.groupBy({
      by: ["ruleId"],
      where: { orgId, triggeredAt: { gte: since } },
      _count: { ruleId: true },
      orderBy: { _count: { ruleId: "desc" } },
      take: 5,
    }),
    prisma.alert.count({
      where: { orgId, triggeredAt: { gte: since } },
    }),
  ]);

  return {
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count.status })),
    bySeverity: bySeverity.map((s) => ({ severity: s.severity, count: s._count.severity })),
    topRules: byRule.map((r) => ({ ruleId: r.ruleId, count: r._count.ruleId })),
    totalRecent: recent,
  };
}

/**
 * Trigger an alert (called by the monitoring job)
 */
export async function triggerAlert(
  rule: any,
  metricValue: number,
  resourceId?: string
) {
  // Check cooldown
  if (rule.lastTriggeredAt) {
    const cooldownEnd = new Date(rule.lastTriggeredAt);
    cooldownEnd.setMinutes(cooldownEnd.getMinutes() + rule.cooldownMinutes);

    if (new Date() < cooldownEnd) {
      return null; // Still in cooldown
    }
  }

  // Create the alert
  const alert = await prisma.alert.create({
    data: {
      orgId: rule.orgId,
      ruleId: rule.id,
      status: "active",
      severity: rule.severity,
      title: `${rule.name} triggered`,
      message: `${rule.metric} ${rule.operator} ${rule.threshold} (actual: ${metricValue.toFixed(2)})`,
      resourceType: rule.resourceType,
      resourceId: resourceId || rule.resourceId,
      metricValue,
      threshold: rule.threshold,
    },
  });

  // Update rule last triggered
  await prisma.alertRule.update({
    where: { id: rule.id },
    data: { lastTriggeredAt: new Date() },
  });

  // Send notifications
  const channels = await prisma.alertRuleChannel.findMany({
    where: { ruleId: rule.id },
    include: { channel: true },
  });

  const notificationResults: Record<string, any> = {};

  for (const { channel } of channels) {
    if (!channel.isEnabled) continue;

    try {
      await sendNotification(channel.type as ChannelType, channel.config as any, {
        title: alert.title,
        message: alert.message,
        severity: alert.severity,
        resourceType: rule.resourceType,
        resourceId: resourceId || rule.resourceId,
        metricValue,
        threshold: rule.threshold,
        timestamp: alert.triggeredAt.toISOString(),
        alertId: alert.id,
      });

      notificationResults[channel.id] = { sentAt: new Date(), success: true };
    } catch (error: any) {
      notificationResults[channel.id] = {
        sentAt: new Date(),
        success: false,
        error: error.message,
      };
    }
  }

  // Update alert with notification results
  await prisma.alert.update({
    where: { id: alert.id },
    data: { notificationsSent: notificationResults },
  });

  return alert;
}

// ============================================
// Notification Sending
// ============================================

interface NotificationPayload {
  title: string;
  message: string;
  severity: string;
  timestamp: string;
  resourceType?: string;
  resourceId?: string;
  metricValue?: number;
  threshold?: number;
  alertId?: string;
}

async function sendNotification(
  type: ChannelType,
  config: ChannelConfig,
  payload: NotificationPayload
) {
  switch (type) {
    case "slack":
      return sendSlackNotification(config as SlackConfig, payload);
    case "discord":
      return sendDiscordNotification(config as DiscordConfig, payload);
    case "email":
      return sendEmailNotification(config as EmailConfig, payload);
    case "webhook":
      return sendWebhookNotification(config as WebhookConfig, payload);
    case "pagerduty":
      return sendPagerDutyNotification(config as PagerDutyConfig, payload);
    default:
      throw new Error(`Unknown channel type: ${type}`);
  }
}

async function sendSlackNotification(config: SlackConfig, payload: NotificationPayload) {
  const color =
    payload.severity === "critical"
      ? "#dc2626"
      : payload.severity === "warning"
        ? "#f59e0b"
        : "#3b82f6";

  const body = {
    username: config.username || "WheelsAI Alerts",
    channel: config.channel,
    attachments: [
      {
        color,
        title: payload.title,
        text: payload.message,
        fields: [
          { title: "Severity", value: payload.severity, short: true },
          { title: "Time", value: payload.timestamp, short: true },
        ],
        footer: "WheelsAI Monitoring",
      },
    ],
  };

  const response = await safeFetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Slack notification failed: ${response.status}`);
  }
}

async function sendDiscordNotification(config: DiscordConfig, payload: NotificationPayload) {
  const color =
    payload.severity === "critical"
      ? 0xdc2626
      : payload.severity === "warning"
        ? 0xf59e0b
        : 0x3b82f6;

  const body = {
    embeds: [
      {
        title: payload.title,
        description: payload.message,
        color,
        fields: [
          { name: "Severity", value: payload.severity, inline: true },
          { name: "Time", value: payload.timestamp, inline: true },
        ],
        footer: { text: "WheelsAI Monitoring" },
      },
    ],
  };

  const response = await safeFetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Discord notification failed: ${response.status}`);
  }
}

async function sendEmailNotification(config: EmailConfig, payload: NotificationPayload) {
  // In production, integrate with email service (SendGrid, SES, etc.)
  console.log(`[Email] Would send to ${config.emails.join(", ")}:`, payload);
  // For now, just log - implement actual email sending in production
}

async function sendWebhookNotification(config: WebhookConfig, payload: NotificationPayload) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...config.headers,
  };

  if (config.secret) {
    // Add HMAC signature for webhook verification
    const crypto = await import("crypto");
    const signature = crypto
      .createHmac("sha256", config.secret)
      .update(JSON.stringify(payload))
      .digest("hex");
    headers["X-Webhook-Signature"] = signature;
  }

  const response = await safeFetch(config.url, {
    method: config.method || "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Webhook notification failed: ${response.status}`);
  }
}

async function sendPagerDutyNotification(config: PagerDutyConfig, payload: NotificationPayload) {
  const body = {
    routing_key: config.integrationKey,
    event_action: "trigger",
    payload: {
      summary: `${payload.title}: ${payload.message}`,
      severity: payload.severity === "critical" ? "critical" : "warning",
      source: "WheelsAI",
      timestamp: payload.timestamp,
      custom_details: {
        resourceType: payload.resourceType,
        resourceId: payload.resourceId,
        metricValue: payload.metricValue,
        threshold: payload.threshold,
      },
    },
  };

  const response = await fetch("https://events.pagerduty.com/v2/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`PagerDuty notification failed: ${response.status}`);
  }
}

// ============================================
// Uptime Monitoring
// ============================================

export interface CreateUptimeMonitorInput {
  name: string;
  targetType: "deployment" | "agent" | "custom_url";
  targetId?: string;
  targetUrl?: string;
  checkIntervalSeconds?: number;
  timeoutSeconds?: number;
  httpMethod?: string;
  expectedStatus?: number;
  expectedBody?: string;
  headers?: Record<string, string>;
}

/**
 * Create an uptime monitor
 */
export async function createUptimeMonitor(orgId: string, input: CreateUptimeMonitorInput) {
  return prisma.uptimeMonitor.create({
    data: {
      orgId,
      name: input.name,
      targetType: input.targetType,
      targetId: input.targetId,
      targetUrl: input.targetUrl,
      checkIntervalSeconds: input.checkIntervalSeconds || 60,
      timeoutSeconds: input.timeoutSeconds || 30,
      httpMethod: input.httpMethod || "GET",
      expectedStatus: input.expectedStatus || 200,
      expectedBody: input.expectedBody,
      headers: input.headers as any,
    },
  });
}

/**
 * Get all uptime monitors for an organization
 */
export async function getUptimeMonitors(orgId: string) {
  return prisma.uptimeMonitor.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Get a single uptime monitor with recent events
 */
export async function getUptimeMonitor(monitorId: string, orgId: string) {
  const monitor = await prisma.uptimeMonitor.findFirst({
    where: { id: monitorId, orgId },
  });

  if (!monitor) return null;

  const events = await prisma.uptimeEvent.findMany({
    where: { monitorId },
    orderBy: { checkedAt: "desc" },
    take: 100,
  });

  return { ...monitor, events };
}

/**
 * Update an uptime monitor
 */
export async function updateUptimeMonitor(
  monitorId: string,
  orgId: string,
  updates: Partial<CreateUptimeMonitorInput> & { isEnabled?: boolean }
) {
  return prisma.uptimeMonitor.update({
    where: { id: monitorId, orgId },
    data: {
      name: updates.name,
      targetType: updates.targetType,
      targetId: updates.targetId,
      targetUrl: updates.targetUrl,
      checkIntervalSeconds: updates.checkIntervalSeconds,
      timeoutSeconds: updates.timeoutSeconds,
      httpMethod: updates.httpMethod,
      expectedStatus: updates.expectedStatus,
      expectedBody: updates.expectedBody,
      headers: updates.headers as any,
      isEnabled: updates.isEnabled,
    },
  });
}

/**
 * Delete an uptime monitor
 */
export async function deleteUptimeMonitor(monitorId: string, orgId: string) {
  return prisma.uptimeMonitor.delete({
    where: { id: monitorId, orgId },
  });
}

/**
 * Record an uptime check result
 */
export async function recordUptimeEvent(
  monitorId: string,
  result: {
    status: "up" | "down" | "degraded" | "timeout" | "error";
    statusCode?: number;
    latencyMs?: number;
    errorMessage?: string;
    responseBody?: string;
    responseHeaders?: Record<string, string>;
    checkRegion?: string;
  }
) {
  // Create event
  await prisma.uptimeEvent.create({
    data: {
      monitorId,
      status: result.status,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      errorMessage: result.errorMessage,
      responseBody: result.responseBody,
      responseHeaders: result.responseHeaders as any,
      checkRegion: result.checkRegion,
    },
  });

  // Update monitor status
  const updateData: any = {
    currentStatus: result.status === "up" ? "up" : result.status,
    lastCheckAt: new Date(),
  };

  if (result.status === "up") {
    updateData.lastUpAt = new Date();
  } else {
    updateData.lastDownAt = new Date();
  }

  await prisma.uptimeMonitor.update({
    where: { id: monitorId },
    data: updateData,
  });

  // Calculate uptime percentages
  await updateUptimeStats(monitorId);
}

/**
 * Update uptime statistics for a monitor
 */
async function updateUptimeStats(monitorId: string) {
  const now = new Date();
  const day1 = new Date(now);
  day1.setHours(day1.getHours() - 24);
  const day7 = new Date(now);
  day7.setDate(day7.getDate() - 7);
  const day30 = new Date(now);
  day30.setDate(day30.getDate() - 30);

  const [events24h, events7d, events30d] = await Promise.all([
    prisma.uptimeEvent.findMany({
      where: { monitorId, checkedAt: { gte: day1 } },
      select: { status: true, latencyMs: true },
    }),
    prisma.uptimeEvent.findMany({
      where: { monitorId, checkedAt: { gte: day7 } },
      select: { status: true },
    }),
    prisma.uptimeEvent.findMany({
      where: { monitorId, checkedAt: { gte: day30 } },
      select: { status: true },
    }),
  ]);

  const calcUptime = (events: { status: string }[]) => {
    if (events.length === 0) return null;
    const upCount = events.filter((e) => e.status === "up").length;
    return (upCount / events.length) * 100;
  };

  const calcAvgLatency = (events: { latencyMs: number | null }[]) => {
    const latencies = events.filter((e) => e.latencyMs != null).map((e) => e.latencyMs!);
    if (latencies.length === 0) return null;
    return latencies.reduce((a, b) => a + b, 0) / latencies.length;
  };

  await prisma.uptimeMonitor.update({
    where: { id: monitorId },
    data: {
      uptimePercent24h: calcUptime(events24h),
      uptimePercent7d: calcUptime(events7d),
      uptimePercent30d: calcUptime(events30d),
      avgLatencyMs: calcAvgLatency(events24h),
    },
  });
}

/**
 * Get uptime summary across all monitors
 */
export async function getUptimeSummary(orgId: string) {
  const monitors = await prisma.uptimeMonitor.findMany({
    where: { orgId, isEnabled: true },
    select: {
      id: true,
      name: true,
      targetType: true,
      currentStatus: true,
      uptimePercent24h: true,
      avgLatencyMs: true,
      lastCheckAt: true,
    },
  });

  const totalUp = monitors.filter((m) => m.currentStatus === "up").length;
  const totalDown = monitors.filter((m) => m.currentStatus === "down").length;
  const avgUptime =
    monitors.length > 0
      ? monitors.reduce((acc, m) => acc + (m.uptimePercent24h || 0), 0) / monitors.length
      : null;

  return {
    totalMonitors: monitors.length,
    totalUp,
    totalDown,
    avgUptime24h: avgUptime,
    monitors,
  };
}
