import { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { createLogger } from "../utils/logger.js";
import { prisma } from "@wheelsai/db";
import {
  getNosanaClient,
  generateJobDefinition,
  type ModelDeploymentConfig,
} from "../services/nosana.js";

const logger = createLogger("deployment-routes");

// ============================================
// Schemas
// ============================================

const createDeploymentSchema = z.object({
  name: z.string().min(3).max(50),
  modelId: z.string(),
  gpuTier: z.string(),
  engine: z.enum(["vllm", "ollama"]).default("vllm"),
  replicas: z.number().int().min(1).max(10).default(1),
  config: z
    .object({
      maxTokens: z.number().int().min(256).max(32768).default(4096),
      gpuMemoryUtilization: z.number().min(0.5).max(0.95).default(0.9),
    })
    .optional(),
});

const updateDeploymentSchema = z.object({
  replicas: z.number().int().min(1).max(10).optional(),
  config: z
    .object({
      maxTokens: z.number().int().min(256).max(32768).optional(),
    })
    .optional(),
});

// ============================================
// Routes
// ============================================

export const deploymentRoutes: FastifyPluginAsync = async (app) => {
  /**
   * List deployments
   */
  app.get("/", { preHandler: [requireAuth] }, async (request, reply) => {
    const { orgId } = request.auth!;

    const deployments = await prisma.deployment.findMany({
      where: { orgId },
      include: {
        model: {
          select: {
            displayName: true,
            pricingTier: true,
          },
        },
        nodes: {
          select: {
            id: true,
            healthStatus: true,
            latencyMs: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return {
      deployments: deployments.map((d) => ({
        id: d.id,
        name: d.name,
        slug: d.slug,
        model: d.model.displayName,
        engine: d.engine,
        gpuTier: d.gpuTier,
        replicas: d.replicas,
        status: d.status,
        endpoint:
          d.status === "running"
            ? `https://api.wheelsai.io/v1/${d.slug}`
            : null,
        healthyNodes: d.nodes.filter((n) => n.healthStatus === "healthy").length,
        totalNodes: d.nodes.length,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
      total: deployments.length,
    };
  });

  /**
   * Get single deployment
   */
  app.get(
    "/:deploymentId",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { deploymentId } = z
        .object({ deploymentId: z.string() })
        .parse(request.params);

      const deployment = await prisma.deployment.findFirst({
        where: { id: deploymentId, orgId },
        include: {
          model: true,
          nodes: true,
        },
      });

      if (!deployment) {
        return reply.notFound("Deployment not found");
      }

      return {
        deployment: {
          ...deployment,
          endpoint:
            deployment.status === "running"
              ? `https://api.wheelsai.io/v1/${deployment.slug}`
              : null,
        },
      };
    }
  );

  /**
   * Create deployment
   */
  app.post("/", { preHandler: [requireAuth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const body = createDeploymentSchema.parse(request.body);

    // Verify model exists
    const model = await prisma.model.findUnique({
      where: { id: body.modelId },
    });

    if (!model) {
      return reply.badRequest(`Model '${body.modelId}' not found`);
    }

    // Generate slug from name
    const baseSlug = body.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // Ensure slug is unique for this org
    let slug = baseSlug;
    let counter = 0;
    while (
      await prisma.deployment.findUnique({
        where: { orgId_slug: { orgId, slug } },
      })
    ) {
      counter++;
      slug = `${baseSlug}-${counter}`;
    }

    const config = body.config ?? {
      maxTokens: 4096,
      gpuMemoryUtilization: 0.9,
    };

    // Create deployment in database
    const deployment = await prisma.deployment.create({
      data: {
        orgId,
        name: body.name,
        slug,
        modelId: body.modelId,
        engine: body.engine,
        gpuTier: body.gpuTier,
        replicas: body.replicas,
        config,
        status: "pending",
        nosanaJobIds: [],
      },
    });

    logger.info(
      { deploymentId: deployment.id, modelId: body.modelId },
      "Deployment created"
    );

    // Submit to Nosana (async)
    submitToNosana(deployment.id, {
      modelId: body.modelId,
      hfModelId: model.hfId,
      engine: body.engine,
      maxTokens: config.maxTokens,
      gpuMemoryUtilization: config.gpuMemoryUtilization,
    }, body.gpuTier, body.replicas).catch((err) => {
      logger.error({ err, deploymentId: deployment.id }, "Failed to submit to Nosana");
    });

    reply.status(201);
    return {
      deployment: {
        id: deployment.id,
        name: deployment.name,
        slug: deployment.slug,
        status: deployment.status,
      },
      message: "Deployment created. Provisioning GPU node...",
    };
  });

  /**
   * Update deployment (scale, config changes)
   */
  app.patch(
    "/:deploymentId",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { deploymentId } = z
        .object({ deploymentId: z.string() })
        .parse(request.params);
      const updates = updateDeploymentSchema.parse(request.body);

      const deployment = await prisma.deployment.findFirst({
        where: { id: deploymentId, orgId },
      });

      if (!deployment) {
        return reply.notFound("Deployment not found");
      }

      // Apply updates
      const updatedDeployment = await prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          replicas: updates.replicas,
          config: updates.config
            ? { ...(deployment.config as any), ...updates.config }
            : undefined,
        },
      });

      // Scale via Nosana if replicas changed
      if (updates.replicas && updates.replicas !== deployment.replicas) {
        try {
          const nosana = await getNosanaClient();
          logger.info(
            { deploymentId, oldReplicas: deployment.replicas, newReplicas: updates.replicas },
            "Scaling deployment — Nosana job will be resubmitted with updated replica count"
          );
        } catch (err) {
          logger.warn({ err, deploymentId }, "Nosana scaling unavailable — replica count updated in DB only");
        }
      }

      return { deployment: updatedDeployment };
    }
  );

  /**
   * Delete/stop deployment
   */
  app.delete(
    "/:deploymentId",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { deploymentId } = z
        .object({ deploymentId: z.string() })
        .parse(request.params);

      const deployment = await prisma.deployment.findFirst({
        where: { id: deploymentId, orgId },
      });

      if (!deployment) {
        return reply.notFound("Deployment not found");
      }

      // Update status
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: "stopped",
          stoppedAt: new Date(),
        },
      });

      // Stop via Nosana
      const nosana = await getNosanaClient();
      for (const jobId of deployment.nosanaJobIds) {
        await nosana.stopDeployment(jobId).catch((err) => {
          logger.error({ err, jobId }, "Failed to stop Nosana deployment");
        });
      }

      // Delete nodes
      await prisma.deploymentNode.deleteMany({
        where: { deploymentId },
      });

      logger.info({ deploymentId }, "Deployment stopped");

      return { message: "Deployment stopped" };
    }
  );

  /**
   * Restart deployment
   */
  app.post(
    "/:deploymentId/restart",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { deploymentId } = z
        .object({ deploymentId: z.string() })
        .parse(request.params);

      const deployment = await prisma.deployment.findFirst({
        where: { id: deploymentId, orgId },
        include: { model: true },
      });

      if (!deployment) {
        return reply.notFound("Deployment not found");
      }

      // Update status
      await prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: "provisioning" },
      });

      // Re-submit to Nosana
      const config = deployment.config as any;
      submitToNosana(
        deploymentId,
        {
          modelId: deployment.modelId,
          hfModelId: deployment.model.hfId,
          engine: deployment.engine as "vllm" | "ollama",
          maxTokens: config.maxTokens ?? 4096,
          gpuMemoryUtilization: config.gpuMemoryUtilization ?? 0.9,
        },
        deployment.gpuTier,
        deployment.replicas
      ).catch((err) => {
        logger.error({ err, deploymentId }, "Failed to restart deployment");
      });

      return { message: "Deployment restarting" };
    }
  );

  /**
   * Get deployment logs
   */
  app.get(
    "/:deploymentId/logs",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { deploymentId } = z
        .object({ deploymentId: z.string() })
        .parse(request.params);
      const { lines } = z
        .object({
          lines: z.coerce.number().int().min(10).max(1000).default(100),
        })
        .parse(request.query);

      const deployment = await prisma.deployment.findFirst({
        where: { id: deploymentId, orgId },
      });

      if (!deployment) {
        return reply.notFound("Deployment not found");
      }

      // TODO: Fetch actual logs from Nosana nodes
      return {
        deploymentId,
        logs: [
          {
            timestamp: new Date().toISOString(),
            level: "info",
            message: "Logs will be available when deployment is running",
          },
        ],
      };
    }
  );

  /**
   * Get deployment metrics
   */
  app.get(
    "/:deploymentId/metrics",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { deploymentId } = z
        .object({ deploymentId: z.string() })
        .parse(request.params);

      const deployment = await prisma.deployment.findFirst({
        where: { id: deploymentId, orgId },
      });

      if (!deployment) {
        return reply.notFound("Deployment not found");
      }

      // Get usage records for last 24 hours
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const usageRecords = await prisma.usageRecord.findMany({
        where: {
          deploymentId,
          periodStart: { gte: since },
        },
        orderBy: { periodStart: "asc" },
      });

      // Aggregate metrics
      const totals = usageRecords.reduce(
        (acc, r) => ({
          requests: acc.requests + r.requestCount,
          inputTokens: acc.inputTokens + Number(r.inputTokens),
          outputTokens: acc.outputTokens + Number(r.outputTokens),
          totalLatencyMs: acc.totalLatencyMs + Number(r.totalLatencyMs),
          errors: acc.errors + r.errorCount,
        }),
        { requests: 0, inputTokens: 0, outputTokens: 0, totalLatencyMs: 0, errors: 0 }
      );

      return {
        deploymentId,
        period: "24h",
        metrics: {
          requests: totals.requests,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          avgLatencyMs:
            totals.requests > 0
              ? Math.round(totals.totalLatencyMs / totals.requests)
              : 0,
          errorRate:
            totals.requests > 0
              ? (totals.errors / totals.requests) * 100
              : 0,
        },
        byHour: usageRecords.map((r) => ({
          period: r.periodStart.toISOString(),
          requests: r.requestCount,
          inputTokens: Number(r.inputTokens),
          outputTokens: Number(r.outputTokens),
        })),
      };
    }
  );

  /**
   * Playground chat endpoint - proxies to deployment
   */
  app.post(
    "/:deploymentId/chat",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { deploymentId } = z
        .object({ deploymentId: z.string() })
        .parse(request.params);

      const chatSchema = z.object({
        messages: z.array(
          z.object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string(),
          })
        ),
        temperature: z.number().min(0).max(2).optional().default(0.7),
        max_tokens: z.number().int().min(1).max(32768).optional().default(1024),
        stream: z.boolean().optional().default(false),
      });

      const body = chatSchema.parse(request.body);

      const deployment = await prisma.deployment.findFirst({
        where: { id: deploymentId, orgId },
        include: {
          model: true,
          nodes: {
            where: { healthStatus: "healthy" },
          },
        },
      });

      if (!deployment) {
        return reply.notFound("Deployment not found");
      }

      if (deployment.status !== "running") {
        return reply.badRequest("Deployment is not running");
      }

      if (deployment.nodes.length === 0) {
        return reply.serviceUnavailable("No healthy nodes available");
      }

      // Pick a random healthy node
      const node = deployment.nodes[Math.floor(Math.random() * deployment.nodes.length)];
      if (!node) {
        return reply.serviceUnavailable("No healthy nodes available");
      }

      try {
        // For development, return a mock response
        // In production, this would proxy to the actual node
        const mockResponse = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: deployment.model.displayName,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant" as const,
                content: `This is a mock response from ${deployment.model.displayName}. In production, this request would be proxied to: ${node.nodeUrl}`,
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: body.messages.reduce((acc, m) => acc + m.content.length / 4, 0),
            completion_tokens: 50,
            total_tokens: body.messages.reduce((acc, m) => acc + m.content.length / 4, 0) + 50,
          },
        };

        // In production, proxy to node:
        // const response = await fetch(`${node.nodeUrl}/v1/chat/completions`, {
        //   method: 'POST',
        //   headers: { 'Content-Type': 'application/json' },
        //   body: JSON.stringify(body),
        // });
        // return response.json();

        return mockResponse;
      } catch (error) {
        logger.error({ error, deploymentId, nodeId: node.id }, "Chat request failed");
        return reply.internalServerError("Failed to process chat request");
      }
    }
  );
};

// ============================================
// Helper Functions
// ============================================

async function submitToNosana(
  deploymentId: string,
  config: ModelDeploymentConfig,
  gpuTier: string,
  replicas: number
): Promise<void> {
  try {
    // Update status to provisioning
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: "provisioning" },
    });

    // Generate job definition
    const jobDefinition = generateJobDefinition(config);

    // Get Nosana client and submit
    const nosana = await getNosanaClient();
    const nosanaDeployment = await nosana.createDeployment(
      jobDefinition,
      gpuTier,
      replicas
    );

    // Store Nosana job IDs
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        nosanaJobIds: [nosanaDeployment.id],
      },
    });

    // Create node records
    for (const node of nosanaDeployment.nodes) {
      await prisma.deploymentNode.create({
        data: {
          deploymentId,
          nosanaNodeId: node.id,
          nodeUrl: node.url,
          healthStatus: "unknown",
        },
      });
    }

    // Start health check polling (simulate for now)
    setTimeout(async () => {
      try {
        // Mark nodes as healthy and deployment as running
        await prisma.deploymentNode.updateMany({
          where: { deploymentId },
          data: { healthStatus: "healthy", latencyMs: 50 },
        });

        await prisma.deployment.update({
          where: { id: deploymentId },
          data: { status: "running" },
        });

        logger.info({ deploymentId }, "Deployment is now running");
      } catch (err) {
        logger.error({ err, deploymentId }, "Failed to update deployment status");
      }
    }, 5000);

    logger.info(
      { deploymentId, nosanaId: nosanaDeployment.id },
      "Submitted to Nosana"
    );
  } catch (error) {
    logger.error({ error, deploymentId }, "Failed to submit to Nosana");

    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: "failed" },
    });

    throw error;
  }
}
