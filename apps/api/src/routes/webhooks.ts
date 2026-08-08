import { FastifyInstance } from "fastify";
import { authMiddleware } from "../middleware/auth.js";
import {
  createWebhook,
  getWebhooks,
  getWebhook,
  updateWebhook,
  deleteWebhook,
  regenerateWebhookSecret,
  testWebhook,
  getWebhookDeliveries,
  retryDelivery,
  WEBHOOK_EVENTS,
} from "../services/webhooks.js";
import {
  createIntegration,
  getIntegrations,
  getIntegration,
  updateIntegration,
  deleteIntegration,
  disconnectIntegration,
  getIntegrationEvents,
  getAvailableIntegrations,
  sendSlackMessage,
  sendDiscordMessage,
  triggerZapierWebhook,
  triggerMakeWebhook,
  triggerN8nWebhook,
  INTEGRATION_TYPES,
} from "../services/integrations.js";

// ============================================
// Webhooks & Integrations Routes
// ============================================

export async function webhooksRoutes(app: FastifyInstance) {
  // Apply auth middleware to all routes
  app.addHook("preHandler", authMiddleware);

  // ============================================
  // Webhook Endpoints
  // ============================================

  /**
   * Get available webhook events
   */
  app.get("/webhooks/events", async (request, reply) => {
    return reply.send({
      events: WEBHOOK_EVENTS,
      categories: {
        agent: WEBHOOK_EVENTS.filter((e) => e.startsWith("agent.")),
        deployment: WEBHOOK_EVENTS.filter((e) => e.startsWith("deployment.")),
        training: WEBHOOK_EVENTS.filter((e) => e.startsWith("training.")),
        alert: WEBHOOK_EVENTS.filter((e) => e.startsWith("alert.")),
        billing: WEBHOOK_EVENTS.filter((e) => e.startsWith("billing.")),
      },
    });
  });

  /**
   * Create a webhook
   */
  app.post<{
    Body: {
      name: string;
      description?: string;
      url: string;
      events: string[];
      resourceType?: string;
      resourceId?: string;
      headers?: Record<string, string>;
      retryCount?: number;
      timeoutSeconds?: number;
    };
  }>("/webhooks", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const webhook = await createWebhook(orgId, request.body);

      return reply.status(201).send(webhook);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  /**
   * List webhooks
   */
  app.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      isEnabled?: string;
    };
  }>("/webhooks", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const { limit, offset, isEnabled } = request.query;

      const result = await getWebhooks(orgId, {
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined,
        isEnabled: isEnabled === "true" ? true : isEnabled === "false" ? false : undefined,
      });

      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  /**
   * Get a webhook
   */
  app.get<{
    Params: { webhookId: string };
  }>("/webhooks/:webhookId", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const { webhookId } = request.params;

      const webhook = await getWebhook(orgId, webhookId);

      if (!webhook) {
        return reply.status(404).send({ error: "Webhook not found" });
      }

      return reply.send(webhook);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  /**
   * Update a webhook
   */
  app.patch<{
    Params: { webhookId: string };
    Body: {
      name?: string;
      description?: string;
      url?: string;
      events?: string[];
      resourceType?: string;
      resourceId?: string;
      headers?: Record<string, string>;
      retryCount?: number;
      timeoutSeconds?: number;
      isEnabled?: boolean;
    };
  }>("/webhooks/:webhookId", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const { webhookId } = request.params;

      // Verify ownership
      const existing = await getWebhook(orgId, webhookId);
      if (!existing) {
        return reply.status(404).send({ error: "Webhook not found" });
      }

      const webhook = await updateWebhook(orgId, webhookId, request.body);

      return reply.send(webhook);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  /**
   * Delete a webhook
   */
  app.delete<{
    Params: { webhookId: string };
  }>("/webhooks/:webhookId", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const { webhookId } = request.params;

      // Verify ownership
      const existing = await getWebhook(orgId, webhookId);
      if (!existing) {
        return reply.status(404).send({ error: "Webhook not found" });
      }

      await deleteWebhook(orgId, webhookId);

      return reply.status(204).send();
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  /**
   * Regenerate webhook secret
   */
  app.post<{
    Params: { webhookId: string };
  }>("/webhooks/:webhookId/regenerate-secret", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const { webhookId } = request.params;

      // Verify ownership
      const existing = await getWebhook(orgId, webhookId);
      if (!existing) {
        return reply.status(404).send({ error: "Webhook not found" });
      }

      const result = await regenerateWebhookSecret(orgId, webhookId);

      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  /**
   * Test a webhook
   */
  app.post<{
    Params: { webhookId: string };
  }>("/webhooks/:webhookId/test", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const { webhookId } = request.params;

      const result = await testWebhook(orgId, webhookId);

      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  /**
   * Get webhook deliveries
   */
  app.get<{
    Params: { webhookId: string };
    Querystring: {
      limit?: string;
      offset?: string;
      status?: string;
    };
  }>("/webhooks/:webhookId/deliveries", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const { webhookId } = request.params;
      const { limit, offset, status } = request.query;

      const result = await getWebhookDeliveries(orgId, webhookId, {
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined,
        status,
      });

      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  /**
   * Retry a webhook delivery
   */
  app.post<{
    Params: { webhookId: string; deliveryId: string };
  }>("/webhooks/:webhookId/deliveries/:deliveryId/retry", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const { webhookId, deliveryId } = request.params;

      const result = await retryDelivery(orgId, webhookId, deliveryId);

      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // ============================================
  // Integration Endpoints
  // ============================================

  /**
   * Get available integrations
   */
  app.get("/integrations/available", async (request, reply) => {
    return reply.send({
      integrations: getAvailableIntegrations(),
      types: INTEGRATION_TYPES,
    });
  });

  /**
   * Create an integration
   */
  app.post<{
    Body: {
      type: string;
      name: string;
      config?: Record<string, any>;
      scopes?: string[];
    };
  }>("/integrations", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const integration = await createIntegration(orgId, request.body as any);

      return reply.status(201).send(integration);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  /**
   * List integrations
   */
  app.get<{
    Querystring: {
      type?: string;
      isEnabled?: string;
      limit?: string;
      offset?: string;
    };
  }>("/integrations", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const { type, isEnabled, limit, offset } = request.query;

      const result = await getIntegrations(orgId, {
        type: type as any,
        isEnabled: isEnabled === "true" ? true : isEnabled === "false" ? false : undefined,
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined,
      });

      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  /**
   * Get an integration
   */
  app.get<{
    Params: { integrationId: string };
  }>("/integrations/:integrationId", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const { integrationId } = request.params;

      const integration = await getIntegration(orgId, integrationId);

      if (!integration) {
        return reply.status(404).send({ error: "Integration not found" });
      }

      return reply.send(integration);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  /**
   * Update an integration
   */
  app.patch<{
    Params: { integrationId: string };
    Body: {
      name?: string;
      config?: Record<string, any>;
      scopes?: string[];
      isEnabled?: boolean;
    };
  }>("/integrations/:integrationId", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const { integrationId } = request.params;

      // Verify ownership
      const existing = await getIntegration(orgId, integrationId);
      if (!existing) {
        return reply.status(404).send({ error: "Integration not found" });
      }

      const integration = await updateIntegration(orgId, integrationId, request.body as any);

      return reply.send(integration);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  /**
   * Delete an integration
   */
  app.delete<{
    Params: { integrationId: string };
  }>("/integrations/:integrationId", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const { integrationId } = request.params;

      // Verify ownership
      const existing = await getIntegration(orgId, integrationId);
      if (!existing) {
        return reply.status(404).send({ error: "Integration not found" });
      }

      await deleteIntegration(orgId, integrationId);

      return reply.status(204).send();
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  /**
   * Disconnect an integration
   */
  app.post<{
    Params: { integrationId: string };
  }>("/integrations/:integrationId/disconnect", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const { integrationId } = request.params;

      // Defense in depth: the service is org-scoped now, and the route
      // pre-checks too — the other mutating routes already did, and this
      // one's omission was the live cross-org IDOR.
      const existing = await getIntegration(orgId, integrationId);
      if (!existing) {
        return reply.status(404).send({ error: "Integration not found" });
      }

      const integration = await disconnectIntegration(orgId, integrationId);

      return reply.send(integration);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  /**
   * Get integration events/logs
   */
  app.get<{
    Params: { integrationId: string };
    Querystring: {
      limit?: string;
      offset?: string;
      status?: string;
      action?: string;
    };
  }>("/integrations/:integrationId/events", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const { integrationId } = request.params;
      const { limit, offset, status, action } = request.query;

      const result = await getIntegrationEvents(orgId, integrationId, {
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined,
        status,
        action,
      });

      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  /**
   * Test integration action
   */
  app.post<{
    Params: { integrationId: string };
    Body: {
      action: string;
      payload?: Record<string, any>;
    };
  }>("/integrations/:integrationId/test", async (request, reply) => {
    try {
      const orgId = request.user!.orgId;
      const { integrationId } = request.params;
      const { payload } = request.body;

      const integration = await getIntegration(orgId, integrationId);
      if (!integration) {
        return reply.status(404).send({ error: "Integration not found" });
      }

      let result;
      switch (integration.type) {
        case "slack":
          result = await sendSlackMessage(
            orgId,
            integrationId,
            payload?.channel || "general",
            payload?.message || "Test message from WheelsAI"
          );
          break;
        case "discord":
          result = await sendDiscordMessage(
            orgId,
            integrationId,
            payload?.content || "Test message from WheelsAI"
          );
          break;
        case "zapier":
          result = await triggerZapierWebhook(orgId, integrationId, {
            test: true,
            message: "Test from WheelsAI",
            ...payload,
          });
          break;
        case "make":
          result = await triggerMakeWebhook(orgId, integrationId, {
            test: true,
            message: "Test from WheelsAI",
            ...payload,
          });
          break;
        case "n8n":
          result = await triggerN8nWebhook(orgId, integrationId, {
            test: true,
            message: "Test from WheelsAI",
            ...payload,
          });
          break;
        default:
          return reply.status(400).send({ error: `Test not supported for ${integration.type}` });
      }

      return reply.send({ success: true, result });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });
}
