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
import {
  resolveModelForPlayground,
  runChat,
  runChatStream,
  type ChatMessage,
} from "../services/mastra-runtime.js";
import {
  abortOnClientClose,
  CLIENT_GONE,
  forwardAndSettle,
  watchDelivery,
} from "../services/chatStreamSettlement.js";
import { publicFallbackReason } from "../services/skills/knowledgeSearchSkill.js";
import { resolveToolMode } from "../services/skills/runMode.js";
import { isFreeModel, getAvailableFreeModels, getAllFreeModels } from "../config/free-models.js";
import { retrieveContextForAgent } from "../services/agentRetrieval.js";
import { beginMarketplaceMetering } from "../services/marketplaceMeteringProduction.js";
import { licenceRevokedMessage } from "../services/marketplaceMetering.js";
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

      // Client disconnect cancels the provider call and any running tool, so
      // a closed tab stops costing money (and is refunded, not settled).
      // Wired before the first await so a client that leaves during any of
      // the lookups below is seen - as is one that left before we got here.
      const abort = abortOnClientClose(reply.raw);
      const clientGone = () =>
        reply.status(499).send({ error: "ClientClosedRequest", message: CLIENT_GONE });

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
      // Nobody is waiting for this answer any more: stop before charging.
      if (abort.signal.aborted) return clientGone();

      const metering = await beginMarketplaceMetering({ agentId, orgId });
      if (metering && !metering.ok && metering.reason === "licence_revoked") {
        return reply.status(403).send({
          error: "LicenceRevoked",
          reason: metering.revocation,
          message: licenceRevokedMessage(metering.listingTitle, metering.revocation, metering.token),
          ...(metering.token && { tokenSymbol: metering.token.symbol, mintAddress: metering.token.mintAddress }),
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

      const chatOptions = {
        agentId,
        orgId,
        // A marketplace buyer's copy of someone else's agent runs in `trial`
        // mode: money-moving tools are withheld.
        mode: await resolveToolMode({ agentId, orgId, base: "playground" }),
        signal: abort.signal,
      };

      // Streaming response
      if (body.stream) {
        let chat;
        try {
          // Tool rounds (if any) and the provider's acceptance of the request
          // happen BEFORE this resolves, so a failure here is still a plain
          // HTTP error: no header has been flushed and nothing was billed.
          chat = await runChatStream(resolved, agentConfig, chatMessages, chatOptions);
        } catch (err) {
          logger.error({ err, agentId, modelId }, "Streaming chat error");
          await meter?.refund(
            err instanceof Error ? err.message : "streaming failed",
          );
          return reply.status(502).send({
            error: "ModelError",
            message: err instanceof Error ? err.message : "Failed to stream chat response",
          });
        }

        // The whole answer of a tool-using chat exists by now, and the
        // client may have left while it was produced. Its charge goes back.
        if (abort.signal.aborted || reply.raw.destroyed) {
          await chat.stream.cancel().catch(() => {});
          await meter?.refund(CLIENT_GONE);
          return clientGone();
        }

        // Billing follows the stream's outcome: a real answer settles; a
        // provider error event, an empty answer, a cut-off stream or a
        // vanished client refunds. (write() on a closed socket returns false
        // - it never throws - so the byte loop alone cannot tell.)
        const delivered = watchDelivery(reply.raw, abort.signal);

        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const outcome = await forwardAndSettle({
          chat,
          write: (chunk) => {
            reply.raw.write(chunk);
          },
          end: () => {
            reply.raw.end();
          },
          delivered,
          meter,
        });
        if (!outcome.ok) {
          logger.warn({ agentId, modelId, error: outcome.error }, "Streamed chat produced no answer");
        }
        return;
      }

      // Non-streaming response
      try {
        const result = await runChat(
          resolved,
          agentConfig,
          chatMessages,
          false,
          chatOptions
        );

        // Generated, but the client hung up while it was: not delivered.
        if (abort.signal.aborted) {
          await meter?.refund(CLIENT_GONE);
          return clientGone();
        }

        await meter?.settle();

        // Fire-and-forget usage tracking
        trackUsage(orgId, modelId, result.usage.inputTokens, result.usage.outputTokens).catch(
          (err) => logger.error({ err }, "Failed to track usage")
        );

        return {
          content: result.content,
          model: modelId,
          usage: result.usage,
          // Every tool the model called and how each call ended, so the UI
          // can say "web_search: unavailable" instead of leaving it to the
          // model's paraphrase.
          toolCalls: result.toolCalls ?? [],
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
                // Never the embedding provider's own error body: that is
                // the operator's account talking, not the tenant's.
                fallbackReason: publicFallbackReason(retrieval.fallbackReason),
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
