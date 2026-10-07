import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { createLogger } from "../utils/logger.js";
import {
  createDeployment,
  getDeployment,
  getDeployments,
  updateDeployment,
  deleteDeployment,
  startDeployment,
  stopDeployment,
  restartDeployment,
  addChannel,
  addWebChatKey,
  updateChannel,
  removeChannel,
  SUPPORTED_PLATFORMS,
  WEB_CHAT_PLATFORM,
} from "../services/openclaw.js";
import { isOneShotUnavailable } from "../services/nosanaPreflight.js";
import type { TelegramWebhookResult } from "../services/telegramWebhook.js";

const logger = createLogger("openclaw-routes");

type DeploymentRecord = Awaited<ReturnType<typeof getDeployment>>;
type ChannelRecord = DeploymentRecord["channels"][number];

const createDeploymentSchema = z
  .object({
    name: z.string().min(1).optional(),
    agentName: z.string().min(1).optional(),
    slug: z.string().min(1),
    description: z.string().optional(),
    systemPrompt: z.string().optional(),
    modelConfig: z.record(z.unknown()).default({}),
    gpuTier: z.string().default("basic"),
    openclawVersion: z.string().optional(),
    envVars: z.record(z.string()).optional(),
    env: z.record(z.string()).optional(),
    channels: z
      .array(
        z.object({
          platform: z.string(),
          config: z.record(z.string()).default({}),
        })
      )
      .default([]),
  })
  .refine((data) => Boolean(data.name || data.agentName), {
    message: "name is required",
    path: ["name"],
  });

const updateDeploymentSchema = z.object({
  envVars: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
  openclawVersion: z.string().optional(),
});

const addChannelSchema = z.object({
  platform: z.string(),
  config: z.record(z.string()).default({}),
});

const updateChannelSchema = z.object({
  config: z.record(z.string()).optional(),
  enabled: z.boolean().optional(),
});

const deploymentParamsSchema = z.object({
  id: z.string(),
});

const channelParamsSchema = z.object({
  channelId: z.string(),
});

function getOrgId(request: FastifyRequest): string {
  return request.auth!.orgId;
}

function normalizePlatform(platform: string): string {
  if (platform === "webchat") return "web";
  if (platform === "webhook") return "api";
  return platform;
}

/**
 * What "Web Chat" made: a web chat key, managed with the other keys
 * (/api/channels/web/keys; Integrations, Channels in the dashboard).
 */
function serializeWebChatKey(key: { id: string }) {
  return {
    id: key.id,
    manageUrl: "/dashboard/integrations#channels",
    message:
      "A web chat key was created for this agent. Add the sites that may embed it, then copy its snippet.",
  };
}

function toModelConfig(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function serializeChannel(channel: ChannelRecord & { webhook?: TelegramWebhookResult }) {
  return {
    id: channel.id,
    platform: channel.platform,
    enabled: channel.enabled,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
    // Telegram only: whether Telegram now delivers to this deployment.
    ...(channel.webhook && { webhook: channel.webhook }),
  };
}

function serializeDeployment(deployment: DeploymentRecord) {
  const modelConfig = toModelConfig(deployment.agent.modelConfig);
  const gpuTier = typeof modelConfig.gpuTier === "string" ? modelConfig.gpuTier : undefined;

  return {
    id: deployment.id,
    agentId: deployment.agentId,
    agentName: deployment.agent.name,
    name: deployment.agent.name,
    slug: deployment.agent.slug,
    description: deployment.agent.description || undefined,
    systemPrompt: deployment.agent.systemPrompt || undefined,
    status: deployment.status,
    healthStatus: deployment.healthStatus,
    publicUrl: deployment.publicUrl,
    channelCount: deployment.channels.length,
    channels: deployment.channels.map(serializeChannel),
    modelConfig,
    gpuTier,
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
  };
}

/**
 * OpenClaw starts a one-shot Nosana job, which the platform's API-key access
 * cannot run privately. An honest 501 with the reason; nothing was changed.
 */
export function replyOneShotUnavailable(reply: FastifyReply, error: unknown): boolean {
  if (!isOneShotUnavailable(error)) return false;
  reply.status(501).send({
    error: "openclaw_start_unavailable",
    reason: "nosana_one_shot_unavailable",
    message: "Starting an OpenClaw deployment is not available right now. Nothing was changed.",
  });
  return true;
}

export const openclawRoutes: FastifyPluginAsync = async (app) => {
  const createDeploymentHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const body = createDeploymentSchema.parse(request.body);
      const deployment = await createDeployment({
        orgId: getOrgId(request),
        name: body.name ?? body.agentName!,
        slug: body.slug,
        description: body.description,
        systemPrompt: body.systemPrompt,
        modelConfig: body.modelConfig,
        gpuTier: body.gpuTier,
        openclawVersion: body.openclawVersion,
        envVars: body.envVars ?? body.env ?? {},
        channels: body.channels.map((channel) => ({
          platform: normalizePlatform(channel.platform),
          config: channel.config,
        })),
      });

      return reply.status(201).send({
        deployment: serializeDeployment(deployment),
        ...(deployment.webChatKey && { webChatKey: serializeWebChatKey(deployment.webChatKey) }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error }, "Failed to create deployment");
      return reply.status(400).send({ error: message });
    }
  };

  const listDeploymentsHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const deployments = await getDeployments(getOrgId(request));
      return reply.send({
        deployments: deployments.map(serializeDeployment),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error }, "Failed to list deployments");
      return reply.status(400).send({ error: message });
    }
  };

  const getDeploymentHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const { id } = deploymentParamsSchema.parse(request.params);
      const deployment = await getDeployment(id, getOrgId(request));
      return reply.send({ deployment: serializeDeployment(deployment) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error, params: request.params }, "Failed to get deployment");
      return reply.status(400).send({ error: message });
    }
  };

  const updateDeploymentHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const { id } = deploymentParamsSchema.parse(request.params);
      const body = updateDeploymentSchema.parse(request.body);
      const deployment = await updateDeployment(id, getOrgId(request), {
        envVars: body.envVars ?? body.env,
        openclawVersion: body.openclawVersion,
      });
      return reply.send({ deployment: serializeDeployment(deployment) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error, params: request.params }, "Failed to update deployment");
      return reply.status(400).send({ error: message });
    }
  };

  const startDeploymentHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const { id } = deploymentParamsSchema.parse(request.params);
      const deployment = await startDeployment(id, getOrgId(request));
      return reply.send({ deployment: serializeDeployment(deployment) });
    } catch (error) {
      if (replyOneShotUnavailable(reply, error)) return reply;
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error, params: request.params }, "Failed to start deployment");
      return reply.status(400).send({ error: message });
    }
  };

  const stopDeploymentHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const { id } = deploymentParamsSchema.parse(request.params);
      const deployment = await stopDeployment(id, getOrgId(request));
      return reply.send({ deployment: serializeDeployment(deployment) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error, params: request.params }, "Failed to stop deployment");
      return reply.status(400).send({ error: message });
    }
  };

  const restartDeploymentHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const { id } = deploymentParamsSchema.parse(request.params);
      const deployment = await restartDeployment(id, getOrgId(request));
      return reply.send({ deployment: serializeDeployment(deployment) });
    } catch (error) {
      if (replyOneShotUnavailable(reply, error)) return reply;
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error, params: request.params }, "Failed to restart deployment");
      return reply.status(400).send({ error: message });
    }
  };

  const deleteDeploymentHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const { id } = deploymentParamsSchema.parse(request.params);
      await deleteDeployment(id, getOrgId(request));
      return reply.send({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error, params: request.params }, "Failed to delete deployment");
      return reply.status(400).send({ error: message });
    }
  };

  const deploymentHealthHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const { id } = deploymentParamsSchema.parse(request.params);
      const deployment = await getDeployment(id, getOrgId(request));

      return reply.send({
        status: deployment.status,
        healthStatus: deployment.healthStatus,
        healthLastCheck: deployment.healthLastCheck,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error, params: request.params }, "Failed to get health status");
      return reply.status(400).send({ error: message });
    }
  };

  const deploymentLogsHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const { id } = deploymentParamsSchema.parse(request.params);
      await getDeployment(id, getOrgId(request));

      // Honest 501, not an empty string pretending to be a log stream:
      // log retrieval from the Nosana job is not built yet (match-up
      // roadmap, Wave 3 with the OpenClaw runtime image).
      return reply.status(501).send({
        error: "logs_not_implemented",
        message: "Log streaming is not available yet.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error, params: request.params }, "Failed to get deployment logs");
      return reply.status(400).send({ error: message });
    }
  };

  const addChannelHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const { id } = deploymentParamsSchema.parse(request.params);
      const body = addChannelSchema.parse(request.body);
      if (normalizePlatform(body.platform) === WEB_CHAT_PLATFORM) {
        const key = await addWebChatKey(id, getOrgId(request), body.config);
        return reply.status(201).send({ webChatKey: serializeWebChatKey(key) });
      }
      const channel = await addChannel(id, getOrgId(request), {
        ...body,
        platform: normalizePlatform(body.platform),
      });
      return reply.status(201).send({ channel: serializeChannel(channel) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error, params: request.params }, "Failed to add channel");
      return reply.status(400).send({ error: message });
    }
  };

  const updateChannelHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const { channelId } = channelParamsSchema.parse(request.params);
      const body = updateChannelSchema.parse(request.body);
      const channel = await updateChannel(channelId, getOrgId(request), body);
      return reply.send({ channel: serializeChannel(channel) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error, params: request.params }, "Failed to update channel");
      return reply.status(400).send({ error: message });
    }
  };

  const deleteChannelHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    try {
      const { channelId } = channelParamsSchema.parse(request.params);
      await removeChannel(channelId, getOrgId(request));
      return reply.send({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error, params: request.params }, "Failed to remove channel");
      return reply.status(400).send({ error: message });
    }
  };

  app.post("/deploy", { preHandler: [requireAuth] }, createDeploymentHandler);
  app.post("/deployments", { preHandler: [requireAuth] }, createDeploymentHandler);

  app.get("/", { preHandler: [requireAuth] }, listDeploymentsHandler);
  app.get("/deployments", { preHandler: [requireAuth] }, listDeploymentsHandler);

  app.get("/:id", { preHandler: [requireAuth] }, getDeploymentHandler);
  app.get("/deployments/:id", { preHandler: [requireAuth] }, getDeploymentHandler);

  app.put("/:id", { preHandler: [requireAuth] }, updateDeploymentHandler);
  app.put("/deployments/:id", { preHandler: [requireAuth] }, updateDeploymentHandler);

  app.post("/:id/start", { preHandler: [requireAuth] }, startDeploymentHandler);
  app.post("/deployments/:id/start", { preHandler: [requireAuth] }, startDeploymentHandler);

  app.post("/:id/restart", { preHandler: [requireAuth] }, restartDeploymentHandler);
  app.post("/deployments/:id/restart", { preHandler: [requireAuth] }, restartDeploymentHandler);

  app.post("/:id/stop", { preHandler: [requireAuth] }, stopDeploymentHandler);
  app.post("/deployments/:id/stop", { preHandler: [requireAuth] }, stopDeploymentHandler);

  app.delete("/:id", { preHandler: [requireAuth] }, deleteDeploymentHandler);
  app.delete("/deployments/:id", { preHandler: [requireAuth] }, deleteDeploymentHandler);

  app.get("/:id/health", { preHandler: [requireAuth] }, deploymentHealthHandler);
  app.get("/deployments/:id/health", { preHandler: [requireAuth] }, deploymentHealthHandler);

  app.get("/:id/logs", { preHandler: [requireAuth] }, deploymentLogsHandler);
  app.get("/deployments/:id/logs", { preHandler: [requireAuth] }, deploymentLogsHandler);

  app.post("/:id/channels", { preHandler: [requireAuth] }, addChannelHandler);
  app.post("/deployments/:id/channels", { preHandler: [requireAuth] }, addChannelHandler);

  app.put("/:id/channels/:channelId", { preHandler: [requireAuth] }, updateChannelHandler);
  app.patch("/:id/channels/:channelId", { preHandler: [requireAuth] }, updateChannelHandler);
  app.put(
    "/deployments/:id/channels/:channelId",
    { preHandler: [requireAuth] },
    updateChannelHandler
  );
  app.patch(
    "/deployments/:id/channels/:channelId",
    { preHandler: [requireAuth] },
    updateChannelHandler
  );
  app.patch("/channels/:channelId", { preHandler: [requireAuth] }, updateChannelHandler);

  app.delete("/:id/channels/:channelId", { preHandler: [requireAuth] }, deleteChannelHandler);
  app.delete(
    "/deployments/:id/channels/:channelId",
    { preHandler: [requireAuth] },
    deleteChannelHandler
  );
  app.delete("/channels/:channelId", { preHandler: [requireAuth] }, deleteChannelHandler);

  app.get("/platforms", async (request, reply) => {
    try {
      const platforms = Array.from(
        new Set([...SUPPORTED_PLATFORMS, "webchat", "webhook"])
      );
      return reply.send({ platforms });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error }, "Failed to list platforms");
      return reply.status(400).send({ error: message });
    }
  });
};
