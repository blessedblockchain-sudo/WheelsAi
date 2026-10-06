import { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.js";
import { triggerWebhook } from "../services/webhooks.js";
import { assertUrlAllowed } from "../lib/ssrfGuard.js";
import {
  createAlertChannel,
  getAlertChannels,
  updateAlertChannel,
  deleteAlertChannel,
  testAlertChannel,
  createAlertRule,
  getAlertRules,
  getAlertRule,
  updateAlertRule,
  deleteAlertRule,
  toggleAlertRule,
  getAlerts,
  acknowledgeAlert,
  resolveAlert,
  getAlertStats,
  createUptimeMonitor,
  getUptimeMonitors,
  getUptimeMonitor,
  updateUptimeMonitor,
  deleteUptimeMonitor,
  getUptimeSummary,
  type ChannelType,
  type CreateAlertRuleInput,
  type CreateUptimeMonitorInput,
} from "../services/monitoring.js";

/**
 * Why a monitor URL is refused, in words safe to show the user (never the
 * address a host resolved to), or null when it may be probed. The prober
 * re-checks every probe, so this is the early, friendly version of the
 * same rule.
 */
async function monitorUrlRefusal(targetUrl: string): Promise<string | null> {
  const verdict = await assertUrlAllowed(targetUrl);
  if (verdict.ok) return null;
  return verdict.kind === "address"
    ? "targetUrl must point at a public internet address"
    : `targetUrl is not allowed: ${verdict.reason}`;
}

export async function monitoringRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook("preHandler", authenticate);

  // ============================================
  // Alert Channels
  // ============================================

  // Get all alert channels
  app.get("/channels", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };

    const channels = await getAlertChannels(orgId);

    return reply.send({
      success: true,
      data: channels,
    });
  });

  // Create alert channel
  app.post("/channels", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { name, type, config } = request.body as {
      name: string;
      type: ChannelType;
      config: any;
    };

    if (!name || !type || !config) {
      return reply.status(400).send({
        success: false,
        error: "name, type, and config are required",
      });
    }

    try {
      const channel = await createAlertChannel(orgId, name, type, config);

      return reply.send({
        success: true,
        data: channel,
        message: "Alert channel created",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Update alert channel
  app.patch("/channels/:channelId", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { channelId } = request.params as { channelId: string };
    const updates = request.body as {
      name?: string;
      config?: any;
      isEnabled?: boolean;
    };

    try {
      const channel = await updateAlertChannel(channelId, orgId, updates);

      return reply.send({
        success: true,
        data: channel,
        message: "Alert channel updated",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Delete alert channel
  app.delete("/channels/:channelId", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { channelId } = request.params as { channelId: string };

    try {
      await deleteAlertChannel(channelId, orgId);

      return reply.send({
        success: true,
        message: "Alert channel deleted",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Test alert channel
  app.post("/channels/:channelId/test", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { channelId } = request.params as { channelId: string };

    try {
      await testAlertChannel(channelId, orgId);

      return reply.send({
        success: true,
        message: "Test notification sent",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // ============================================
  // Alert Rules
  // ============================================

  // Get all alert rules
  app.get("/rules", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };

    const rules = await getAlertRules(orgId);

    return reply.send({
      success: true,
      data: rules,
    });
  });

  // Get single alert rule
  app.get("/rules/:ruleId", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { ruleId } = request.params as { ruleId: string };

    const rule = await getAlertRule(ruleId, orgId);

    if (!rule) {
      return reply.status(404).send({
        success: false,
        error: "Rule not found",
      });
    }

    return reply.send({
      success: true,
      data: rule,
    });
  });

  // Create alert rule
  app.post("/rules", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const input = request.body as CreateAlertRuleInput;

    if (!input.name || !input.ruleType || !input.metric || !input.operator) {
      return reply.status(400).send({
        success: false,
        error: "name, ruleType, metric, and operator are required",
      });
    }

    try {
      const rule = await createAlertRule(orgId, input);

      return reply.send({
        success: true,
        data: rule,
        message: "Alert rule created",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Update alert rule
  app.patch("/rules/:ruleId", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { ruleId } = request.params as { ruleId: string };
    const updates = request.body as Partial<CreateAlertRuleInput>;

    try {
      const rule = await updateAlertRule(ruleId, orgId, updates);

      return reply.send({
        success: true,
        data: rule,
        message: "Alert rule updated",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Delete alert rule
  app.delete("/rules/:ruleId", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { ruleId } = request.params as { ruleId: string };

    try {
      await deleteAlertRule(ruleId, orgId);

      return reply.send({
        success: true,
        message: "Alert rule deleted",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Toggle alert rule
  app.post("/rules/:ruleId/toggle", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { ruleId } = request.params as { ruleId: string };
    const { isEnabled } = request.body as { isEnabled: boolean };

    try {
      const rule = await toggleAlertRule(ruleId, orgId, isEnabled);

      return reply.send({
        success: true,
        data: rule,
        message: `Alert rule ${isEnabled ? "enabled" : "disabled"}`,
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // ============================================
  // Alerts
  // ============================================

  // Get all alerts
  app.get("/alerts", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { status, severity, ruleId, limit, offset } = request.query as {
      status?: string;
      severity?: string;
      ruleId?: string;
      limit?: string;
      offset?: string;
    };

    const result = await getAlerts(orgId, {
      status,
      severity,
      ruleId,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
    });

    return reply.send({
      success: true,
      data: result.alerts,
      pagination: {
        total: result.total,
        limit: limit ? parseInt(limit) : 50,
        offset: offset ? parseInt(offset) : 0,
      },
    });
  });

  // Acknowledge alert
  app.post("/alerts/:alertId/acknowledge", async (request, reply) => {
    const { orgId, userId } = request.user as { orgId: string; userId: string };
    const { alertId } = request.params as { alertId: string };

    try {
      const alert = await acknowledgeAlert(alertId, orgId, userId);

      return reply.send({
        success: true,
        data: alert,
        message: "Alert acknowledged",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Resolve alert
  app.post("/alerts/:alertId/resolve", async (request, reply) => {
    const { orgId, userId } = request.user as { orgId: string; userId: string };
    const { alertId } = request.params as { alertId: string };

    try {
      const alert = await resolveAlert(alertId, orgId, userId);

      triggerWebhook(
        orgId,
        "alert.resolved",
        { alertId: alert.id, title: alert.title, severity: alert.severity },
        alert.resourceType,
        alert.resourceId ?? undefined,
      ).catch(() => {});

      return reply.send({
        success: true,
        data: alert,
        message: "Alert resolved",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Get alert statistics
  app.get("/alerts/stats", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { days } = request.query as { days?: string };

    const stats = await getAlertStats(orgId, days ? parseInt(days) : 7);

    return reply.send({
      success: true,
      data: stats,
    });
  });

  // ============================================
  // Uptime Monitoring
  // ============================================

  // Get uptime summary
  app.get("/uptime/summary", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };

    const summary = await getUptimeSummary(orgId);

    return reply.send({
      success: true,
      data: summary,
    });
  });

  // Get all uptime monitors
  app.get("/uptime", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };

    const monitors = await getUptimeMonitors(orgId);

    return reply.send({
      success: true,
      data: monitors,
    });
  });

  // Get single uptime monitor
  app.get("/uptime/:monitorId", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { monitorId } = request.params as { monitorId: string };

    const monitor = await getUptimeMonitor(monitorId, orgId);

    if (!monitor) {
      return reply.status(404).send({
        success: false,
        error: "Monitor not found",
      });
    }

    return reply.send({
      success: true,
      data: monitor,
    });
  });

  // Create uptime monitor
  app.post("/uptime", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const input = request.body as CreateUptimeMonitorInput;

    if (!input.name || !input.targetType) {
      return reply.status(400).send({
        success: false,
        error: "name and targetType are required",
      });
    }

    if (input.targetType === "custom_url" && !input.targetUrl) {
      return reply.status(400).send({
        success: false,
        error: "targetUrl is required for custom_url monitors",
      });
    }
    if (input.targetType === "custom_url") {
      const refusal = await monitorUrlRefusal(input.targetUrl!);
      if (refusal) return reply.status(400).send({ success: false, error: refusal });
    }

    try {
      const monitor = await createUptimeMonitor(orgId, input);

      return reply.send({
        success: true,
        data: monitor,
        message: "Uptime monitor created",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Update uptime monitor
  app.patch("/uptime/:monitorId", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { monitorId } = request.params as { monitorId: string };
    const updates = request.body as Partial<CreateUptimeMonitorInput> & {
      isEnabled?: boolean;
    };

    if (typeof updates.targetUrl === "string") {
      const refusal = await monitorUrlRefusal(updates.targetUrl);
      if (refusal) return reply.status(400).send({ success: false, error: refusal });
    }

    try {
      const monitor = await updateUptimeMonitor(monitorId, orgId, updates);

      return reply.send({
        success: true,
        data: monitor,
        message: "Uptime monitor updated",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });

  // Delete uptime monitor
  app.delete("/uptime/:monitorId", async (request, reply) => {
    const { orgId } = request.user as { orgId: string };
    const { monitorId } = request.params as { monitorId: string };

    try {
      await deleteUptimeMonitor(monitorId, orgId);

      return reply.send({
        success: true,
        message: "Uptime monitor deleted",
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        error: error.message,
      });
    }
  });
}
