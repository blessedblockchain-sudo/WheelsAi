/**
 * Playground API Routes
 *
 * Chat interface for testing agents with free or paid models,
 * without requiring GPU deployment.
 *
 * The chat route is an adapter: who may chat, on which model, with what
 * grounding and at whose expense is decided by the shared agent-chat service
 * (services/agentChat.ts), which the /v1 agent API uses too. This file only
 * translates between that service and the playground's own request and
 * response shapes, which the dashboard depends on.
 */

import { FastifyPluginAsync, type preHandlerHookHandler } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import {
  prepareAgentChat,
  SHUTTING_DOWN,
  type AgentChatDeps,
  type AgentChatFailure,
  type AgentChatNotAnswered,
  type AgentChatRefusal,
} from "../services/agentChat.js";
import { buildAgentChatDeps } from "../services/buildAgentChatDeps.js";
import { abortOnClientClose, CLIENT_GONE } from "../services/chatStreamSettlement.js";
import { publicFallbackReason } from "../services/skills/knowledgeSearchSkill.js";
import { getAllFreeModels } from "../config/free-models.js";
import { licenceRevokedMessage } from "../services/marketplaceMetering.js";
import { streamToReply } from "../services/sseReply.js";
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
  // A model id is a short printable name. Refused here rather than passed on:
  // it reaches provider URLs, logs and the latency record as given.
  // eslint-disable-next-line no-control-regex
  model: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/, "Invalid model id").optional(),
  stream: z.boolean().optional().default(false),
});

export interface PlaygroundRouteDeps {
  /** Built on first use, so registering the routes opens no connection. */
  chatDeps?: () => AgentChatDeps;
  requireAuth?: preHandlerHookHandler;
}

export function createPlaygroundRoutes(deps: PlaygroundRouteDeps = {}): FastifyPluginAsync {
  const auth = deps.requireAuth ?? requireAuth;
  let chatDeps: AgentChatDeps | null = null;
  const getChatDeps = () => (chatDeps ??= (deps.chatDeps ?? buildAgentChatDeps)());

  return async (app) => {
  /**
   * POST /api/agents/:agentId/playground/chat
   * Chat with an agent using free or paid models
   */
  app.post(
    "/agents/:agentId/playground/chat",
    { preHandler: [auth], schema: { tags: ["Playground"], description: "Chat with agent using free or paid models" } },
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

      const refused = (refusal: AgentChatRefusal) => {
        switch (refusal.kind) {
          case "agent_not_found":
            return reply.notFound("Agent not found");
          case "invalid_request":
          case "model_invalid":
            return reply.badRequest(refusal.message);
          case "not_configured":
            // Nothing the user can fix from here: the platform has no
            // provider for this model. Said as what it is, not as a bad
            // request.
            return reply.status(501).send({ error: refusal.code, message: refusal.message });
          case "rate_limited":
            return reply.status(429).send({
              error: "RateLimitExceeded",
              message: "Free tier rate limit exceeded. Try again later or use a paid model.",
              remaining: refusal.limit.remaining,
              resetAt: refusal.limit.resetAt,
            });
          case "licence_revoked":
            return reply.status(403).send({
              error: "LicenceRevoked",
              reason: refusal.revocation,
              message: licenceRevokedMessage(refusal.listingTitle, refusal.revocation, refusal.token),
              ...(refusal.token && { tokenSymbol: refusal.token.symbol, mintAddress: refusal.token.mintAddress }),
            });
          case "payment_required":
            return reply.status(402).send({
              error: "PaymentRequired",
              message: `"${refusal.listingTitle}" is billed per request by its publisher. This request costs ${(
                Number(refusal.requiredCents) / 100
              ).toFixed(4)} USD and your balance is ${(
                Number(refusal.balanceCents) / 100
              ).toFixed(2)} USD.`,
              requiredCents: Number(refusal.requiredCents),
              balanceCents: Number(refusal.balanceCents),
            });
          case "hosted_model_unavailable":
            return reply.status(503).send({ error: "hosted_model_not_running", message: refusal.message });
          case "shutting_down":
            return reply
              .status(503)
              .header("retry-after", "5")
              .send({ error: "ServiceUnavailable", message: SHUTTING_DOWN });
          case "client_gone":
            return clientGone();
        }
      };

      // The charge, if there was one, is already refunded by the service.
      const failed = (failure: AgentChatFailure) =>
        failure.code === "client_gone"
          ? clientGone()
          : failure.code === "service_unavailable"
            ? reply
                .status(503)
                .header("retry-after", "5")
                .send({ error: "ServiceUnavailable", message: failure.message })
            : reply.status(502).send({ error: "ModelError", message: failure.message, ...failure.detail });

      // A graph agent learns "licence revoked", "cannot pay" and "has no
      // graph" when its run is attempted; those are refusals like any other.
      const notAnswered = (result: AgentChatNotAnswered) =>
        result.refusal ? refused(result.refusal) : failed(result.failure);

      const prepared = await prepareAgentChat(
        {
          orgId,
          agent: { id: agentId },
          caller: "owner",
          source: "playground",
          messages: body.messages,
          modelOverride: body.model,
          signal: abort.signal,
        },
        getChatDeps(),
      );

      // The limiter's verdict rides on every answer for a free model,
      // refused or not.
      const limit = prepared.ok
        ? prepared.session.rateLimit
        : prepared.refusal.kind === "rate_limited"
          ? prepared.refusal.limit
          : null;
      if (limit) {
        reply.header("X-RateLimit-Remaining-RPM", limit.remaining.rpm);
        reply.header("X-RateLimit-Remaining-RPD", limit.remaining.rpd);
        reply.header("X-RateLimit-Reset-RPM", limit.resetAt.rpm);
        reply.header("X-RateLimit-Reset-RPD", limit.resetAt.rpd);
      }
      if (!prepared.ok) return refused(prepared.refusal);

      const { session } = prepared;
      const { modelId, retrieval, billing } = session;

      // Streaming response
      if (body.stream) {
        const started = await session.stream();
        if (!started.ok) return notAnswered(started);

        // Headers set so far (CORS, rate limits) go out with the stream, and
        // billing settles only on an answer that was produced AND delivered.
        const sent = await streamToReply(reply, started.chat, { meter: session.meter, abort });
        if (!sent.started) return clientGone();
        if (!sent.outcome.ok) {
          logger.warn({ agentId, modelId, error: sent.outcome.error }, "Streamed chat produced no answer");
        }
        return;
      }

      // Non-streaming response
      const completed = await session.complete();
      if (!completed.ok) return notAnswered(completed);
      const { result } = completed;

      return {
        content: result.content,
        // For a graph agent: the model its llm nodes default to, or "graph"
        // when the agent configures none.
        model: modelId ?? "graph",
        usage: result.usage,
        // The run behind a graph agent's answer; absent for a chat agent.
        ...(completed.graph && { graph: completed.graph }),
        // Every tool the model called and how each call ended, so the UI
        // can say "web_search: unavailable" instead of leaving it to the
        // model's paraphrase.
        toolCalls: result.toolCalls ?? [],
        // What this answer cost the buyer and who it went to. A charge
        // the user only discovers on their statement is a charge we hid.
        billing,
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
    }
  );

  /**
   * GET /api/agents/:agentId/playground/models
   * List available models grouped by tier
   */
  app.get(
    "/agents/:agentId/playground/models",
    { preHandler: [auth], schema: { tags: ["Playground"], description: "List available models for playground" } },
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
}

export const playgroundRoutes: FastifyPluginAsync = createPlaygroundRoutes();
