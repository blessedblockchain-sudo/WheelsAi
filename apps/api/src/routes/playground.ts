/**
 * Playground API Routes
 *
 * Chat interface for testing agents with free or paid models,
 * without requiring GPU deployment.
 */

import { FastifyPluginAsync } from "fastify";
import { openAgentEnv } from "../services/agentSecrets.js";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { checkFreeTierLimit } from "../middleware/free-tier-limit.js";
import { resolveModelForPlayground, runChat, type ChatMessage } from "../services/mastra-runtime.js";
import { isFreeModel, getAvailableFreeModels, getAllFreeModels } from "../config/free-models.js";
import { retrieveContextForAgent } from "../services/agentRetrieval.js";
import { beginMarketplaceMetering } from "../services/marketplaceMeteringProduction.js";
import { buildAgentRetrievalDeps } from "../services/buildAgentRetrievalDeps.js";
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
    { preHandler: [requireAuth], schema: { tags: ["Playground"], description: "Chat with agent using free or paid models" } },
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
        const agentEnv = openAgentEnv(agent.env);
        resolved = resolveModelForPlayground(modelId, agentEnv);
      } catch (err) {
        return reply.badRequest(
          err instanceof Error ? err.message : "Failed to resolve model"
        );
      }

      // RAG grounding (W2): only for agents bound to a knowledge base.
      // Unbound agents take the identical path they always did.
      let retrieval: Awaited<ReturnType<typeof retrieveContextForAgent>> = null;
      const lastUserMessage = [...body.messages]
        .reverse()
        .find((m) => m.role === "user");
      if (agent.knowledgeBaseId && lastUserMessage) {
        try {
          retrieval = await retrieveContextForAgent(
            { agentId, orgId, query: lastUserMessage.content },
            buildAgentRetrievalDeps(),
          );
        } catch (err) {
          // Retrieval is an enhancement — never fail the chat over it.
          logger.warn({ err, agentId }, "retrieval failed; answering ungrounded");
        }
      }

      // Marketplace metering (W2): if this agent is a per-request
      // install, the buyer pays their publisher for THIS request. Charged
      // before a single token is generated, refunded if generation fails,
      // and answered as 402 before any response bytes are written — the
      // streaming branch cannot take that back once it has flushed a
      // header.
      const metering = await beginMarketplaceMetering({ agentId, orgId });
      if (metering && !metering.ok && metering.reason === "licence_revoked") {
        return reply.status(403).send({
          error: "LicenceRevoked",
          message: `This agent came from the marketplace listing "${metering.listingTitle}" and stopped working when you uninstalled it. Reinstall it to use it again.`,
        });
      }
      if (metering && !metering.ok) {
        return reply.status(402).send({
          error: "PaymentRequired",
          message: `"${metering.listingTitle}" is billed per request by its publisher. This request costs ${(
            Number(metering.requiredCents) / 100
          ).toFixed(4)} USD and your balance is ${(
            Number(metering.balanceCents) / 100
          ).toFixed(2)} USD.`,
          requiredCents: Number(metering.requiredCents),
          balanceCents: Number(metering.balanceCents),
        });
      }
      const meter = metering?.ok ? metering.handle : null;

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

      // Grounding rides as its own system turn ahead of the conversation,
      // so the user's own message is never rewritten.
      const chatMessages = (
        retrieval
          ? [
              { role: "system", content: retrieval.contextBlock },
              ...body.messages,
            ]
          : body.messages
      ) as ChatMessage[];

      // Streaming response
      if (body.stream) {
        try {
          const stream = await runChat(
            resolved,
            agentConfig,
            chatMessages,
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

          await meter?.settle();
          return;
        } catch (err) {
          logger.error({ err, agentId, modelId }, "Streaming chat error");
          await meter?.refund(
            err instanceof Error ? err.message : "streaming failed",
          );
          return reply.internalServerError("Failed to stream chat response");
        }
      }

      // Non-streaming response
      try {
        const result = await runChat(
          resolved,
          agentConfig,
          chatMessages,
          false
        );

        await meter?.settle();

        // Fire-and-forget usage tracking
        trackUsage(orgId, modelId, result.usage.inputTokens, result.usage.outputTokens).catch(
          (err) => logger.error({ err }, "Failed to track usage")
        );

        return {
          content: result.content,
          model: modelId,
          usage: result.usage,
          // What this answer cost the buyer and who it went to. A charge
          // the user only discovers on their statement is a charge we hid.
          billing: meter
            ? {
                listingTitle: meter.charge.install.listingTitle,
                chargedCents: Number(meter.charge.grossCents),
                creatorCents: Number(meter.charge.creatorCents),
              }
            : null,
          // What grounded this answer, and by which retrieval mode — so
          // the UI can cite sources and never imply "semantic" when the
          // passages were word-overlap matched.
          retrieval: retrieval
            ? {
                mode: retrieval.mode,
                fallbackReason: retrieval.fallbackReason,
                sources: retrieval.sources.map((s) => ({
                  chunkId: s.chunkId,
                  documentId: s.documentId,
                  documentTitle: s.documentTitle,
                  score: s.score,
                })),
              }
            : null,
        };
      } catch (err) {
        logger.error({ err, agentId, modelId }, "Chat error");
        await meter?.refund(err instanceof Error ? err.message : "chat failed");
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
    { preHandler: [requireAuth], schema: { tags: ["Playground"], description: "List available models for playground" } },
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
