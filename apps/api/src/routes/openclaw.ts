import { FastifyPluginAsync } from "fastify";
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
  updateChannel,
  removeChannel,
  SUPPORTED_PLATFORMS,
} from "../services/openclaw.js";

const logger = createLogger("openclaw-routes");

// Schemas
const createDeploymentSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().optional(),
  systemPrompt: z.string().optional(),
  modelConfig: z.record(z.unknown()),
  gpuTier: z.string(),
  openclawVersion: z.string().optional(),
  envVars: z.record(z.string()),
  channels: z.array(
    z.object({
      platform: z.string(),
      config: z.record(z.string()),
    })
  ),
});

const updateDeploymentSchema = z.object({
  envVars: z.record(z.string()).optional(),
  openclawVersion: z.string().optional(),
});

const addChannelSchema = z.object({
  platform: z.string(),
  config: z.record(z.string()),
});

const updateChannelSchema = z.object({
  config: z.record(z.string()).optional(),
  enabled: z.boolean().optional(),
});

export const openclawRoutes: FastifyPluginAsync = async (app) => {
  // POST /deploy - Create new deployment
  app.post(
    "/deploy",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const body = createDeploymentSchema.parse(request.body);
        const deployment = await createDeployment({
          orgId: request.orgId,
          ...body,
        });
        return reply.status(201).send({ deployment });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ error }, "Failed to create deployment");
        return reply.status(400).send({ error: message });
      }
    }
  );

  // GET / - List deployments
  app.get("/", { preHandler: [requireAuth] }, async (request, reply) => {
    try {
      const deployments = await getDeployments(request.orgId);
      return reply.send({ deployments });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error }, "Failed to list deployments");
      return reply.status(400).send({ error: message });
    }
  });

  // GET /:id - Get deployment by ID
  app.get(
    "/:id",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const deployment = await getDeployment(id, request.orgId);
        return reply.send({ deployment });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ error, id: (request.params as any).id }, "Failed to get deployment");
        return reply.status(400).send({ error: message });
      }
    }
  );

  // PUT /:id - Update deployment
  app.put(
    "/:id",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = updateDeploymentSchema.parse(request.body);
        const deployment = await updateDeployment(id, request.orgId, body);
        return reply.send({ deployment });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ error, id: (request.params as any).id }, "Failed to update deployment");
        return reply.status(400).send({ error: message });
      }
    }
  );

  // POST /:id/restart - Restart deployment
  app.post(
    "/:id/restart",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const deployment = await restartDeployment(id, request.orgId);
        return reply.send({ deployment });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ error, id: (request.params as any).id }, "Failed to restart deployment");
        return reply.status(400).send({ error: message });
      }
    }
  );

  // POST /:id/stop - Stop deployment
  app.post(
    "/:id/stop",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const deployment = await stopDeployment(id, request.orgId);
        return reply.send({ deployment });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ error, id: (request.params as any).id }, "Failed to stop deployment");
        return reply.status(400).send({ error: message });
      }
    }
  );

  // DELETE /:id - Delete deployment
  app.delete(
    "/:id",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        await deleteDeployment(id, request.orgId);
        return reply.send({ success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ error, id: (request.params as any).id }, "Failed to delete deployment");
        return reply.status(400).send({ error: message });
      }
    }
  );

  // GET /:id/health - Get health status
  app.get(
    "/:id/health",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const deployment = await getDeployment(id, request.orgId);

        return reply.send({
          status: deployment.status,
          healthStatus: deployment.healthStatus,
          healthLastCheck: deployment.healthLastCheck,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ error, id: (request.params as any).id }, "Failed to get health status");
        return reply.status(400).send({ error: message });
      }
    }
  );

  // POST /:id/channels - Add channel
  app.post(
    "/:id/channels",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = addChannelSchema.parse(request.body);
        const channel = await addChannel(id, request.orgId, body);
        return reply.status(201).send({ channel });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ error, id: (request.params as any).id }, "Failed to add channel");
        return reply.status(400).send({ error: message });
      }
    }
  );

  // PUT /:id/channels/:channelId - Update channel
  app.put(
    "/:id/channels/:channelId",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const { channelId } = request.params as { id: string; channelId: string };
        const body = updateChannelSchema.parse(request.body);
        const channel = await updateChannel(channelId, request.orgId, body);
        return reply.send({ channel });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ error, channelId: (request.params as any).channelId }, "Failed to update channel");
        return reply.status(400).send({ error: message });
      }
    }
  );

  // DELETE /:id/channels/:channelId - Remove channel
  app.delete(
    "/:id/channels/:channelId",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      try {
        const { channelId } = request.params as { id: string; channelId: string };
        await removeChannel(channelId, request.orgId);
        return reply.send({ success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        logger.error({ error, channelId: (request.params as any).channelId }, "Failed to remove channel");
        return reply.status(400).send({ error: message });
      }
    }
  );

  // GET /platforms - List supported platforms (no auth required)
  app.get("/platforms", async (request, reply) => {
    try {
      return reply.send({ platforms: SUPPORTED_PLATFORMS });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ error }, "Failed to list platforms");
      return reply.status(400).send({ error: message });
    }
  });
};
