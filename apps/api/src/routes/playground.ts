/**
 * Playground API Routes
 *
 * Chat interface for testing agents with free or paid models,
 * without requiring GPU deployment.
 */

import { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { checkFreeTierLimit } from "../middleware/free-tier-limit.js";
import { resolveModelForPlayground, runChat, type ChatMessage } from "../services/mastra-runtime.js";
import { isFreeModel, getAvailableFreeModels, getAllFreeModels } from "../config/free-models.js";
import { prisma } from "@wheelsai/db";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("playground");

const chatBodySchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant", "system"]),
      content: z.string().min(1).max(32000),
    })
  ).min(1).max(50),
  model: z.string().optional(),
  stream: z.boolean().optional().default(false),
});

export const playgroundRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/agents/:agentId/playground/chat
   * Chat with an agent using free or paid models
   */
  app.post(
    "/agents/:agentId/playground/chat",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { agentId } = z.object({ agentId: z.string().uuid() }).parse(request.params);
      const body = chatBodySchema.parse(request.body);
      const orgId = request.auth!.orgId;

      // Load agent and verify ownership
      const agent = await prisma.agent.findFirst({
        where: { id: agentId, orgId },
      });

      if (!agent) {
        return reply.notFound("Agent not found");
      }

      const modelConfig = (agent.modelConfig as any) ?? {};
      const agentTools = (agent.tools as any[]) ?? [];

      // Resolve which model to use
      const modelId =
        body.model ||
        modelConfig.externalModel ||
        getFirstAvailableFreeModel();

      if (!modelId) {
        return reply.badRequest(
          "No model specified and no free models are available. Configure a provider API key on the platform."
        );
      }

      // Rate limit free models
      if (isFreeModel(modelId)) {
        const limit = await checkFreeTierLimit(orgId);
        reply.header("X-RateLimit-Remaining-RPM", limit.remaining.rpm);
        reply.header("X-RateLimit-Remaining-RPD", limit.remaining.rpd);
        reply.header("X-RateLimit-Reset-RPM", limit.resetAt.rpm);
        reply.header("X-RateLimit-Reset-RPD", limit.resetAt.rpd);

        if (!limit.allowed) {
          return reply.status(429).send({
            error: "RateLimitExceeded",
            message: "Free tier rate limit exceeded. Try again later or use a paid model.",
            remaining: limit.remaining,
            resetAt: limit.resetAt,
          });
        }
      }

      // Resolve model connection config
      let resolved;
      try {
        const agentEnv = (agent.env as Record<string, string>) ?? {};
        resolved = resolveModelForPlayground(modelId, agentEnv);
      } catch (err) {
        return reply.badRequest(
          err instanceof Error ? err.message : "Failed to resolve model"
        );
      }

      const agentConfig = {
        name: agent.name,
        systemPrompt: agent.systemPrompt ?? undefined,
        tools: agentTools,
        modelConfig: {
          externalModel: modelId,
          temperature: modelConfig.temperature ?? 0.7,
          maxTokens: modelConfig.maxTokens ?? 4096,
        },
      };

      // Streaming response
      if (body.stream) {
        try {
          const stream = await runChat(
            resolved,
            agentConfig,
            body.messages as ChatMessage[],
            true
          );

          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const reader = stream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              reply.raw.write(value);
            }
          } finally {
            reader.releaseLock();
            reply.raw.end();
          }

          return;
        } catch (err) {
          logger.error({ err, agentId, modelId }, "Streaming chat error");
          return reply.internalServerError("Failed to stream chat response");
        }
      }

      // Non-streaming response
      try {
        const result = await runChat(
          resolved,
          agentConfig,
          body.messages as ChatMessage[],
          false
        );

        // Fire-and-forget usage tracking
        trackUsage(orgId, modelId, result.usage.inputTokens, result.usage.outputTokens).catch(
          (err) => logger.error({ err }, "Failed to track usage")
        );

        return {
          content: result.content,
          model: modelId,
          usage: result.usage,
        };
      } catch (err) {
        logger.error({ err, agentId, modelId }, "Chat error");
        const message = err instanceof Error ? err.message : "Chat failed";
        return reply.status(502).send({
          error: "ModelError",
          message,
        });
      }
    }
  );

  /**
   * GET /api/agents/:agentId/playground/models
   * List available models grouped by tier
   */
  app.get(
    "/agents/:agentId/playground/models",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { agentId } = z.object({ agentId: z.string().uuid() }).parse(request.params);
      const orgId = request.auth!.orgId;

      // Verify agent access
      const agent = await prisma.agent.findFirst({
        where: { id: agentId, orgId },
        select: { id: true },
      });

      if (!agent) {
        return reply.notFound("Agent not found");
      }

      const freeModels = getAllFreeModels();

      const externalModels = [
        { id: "openai/gpt-4", displayName: "GPT-4", provider: "openai", requiresApiKey: true, envKey: "OPENAI_API_KEY" },
        { id: "openai/gpt-4-turbo", displayName: "GPT-4 Turbo", provider: "openai", requiresApiKey: true, envKey: "OPENAI_API_KEY" },
        { id: "openai/gpt-3.5-turbo", displayName: "GPT-3.5 Turbo", provider: "openai", requiresApiKey: true, envKey: "OPENAI_API_KEY" },
        { id: "anthropic/claude-3-opus", displayName: "Claude 3 Opus", provider: "anthropic", requiresApiKey: true, envKey: "ANTHROPIC_API_KEY" },
        { id: "anthropic/claude-3-sonnet", displayName: "Claude 3 Sonnet", provider: "anthropic", requiresApiKey: true, envKey: "ANTHROPIC_API_KEY" },
      ];

      return {
        freeModels,
        externalModels,
      };
    }
  );
};

function getFirstAvailableFreeModel(): string | null {
  const available = getAvailableFreeModels();
  return available[0]?.id ?? null;
}

async function trackUsage(
  orgId: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  const provider = model.split("/")[1] ?? model.split("/")[0] ?? "unknown";
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  try {
    await prisma.freeTierUsage.upsert({
      where: {
        orgId_model_date: { orgId, model, date: today },
      },
      update: {
        inputTokens: { increment: inputTokens },
        outputTokens: { increment: outputTokens },
        requestCount: { increment: 1 },
      },
      create: {
        orgId,
        model,
        provider,
        inputTokens,
        outputTokens,
        requestCount: 1,
        date: today,
      },
    });
  } catch {
    // Usage tracking is best-effort — don't fail the request
  }
}
