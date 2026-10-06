/**
 * The OpenAI-compatible API of an agent.
 *
 *   POST /v1/agents/:agentSlug/chat/completions
 *   GET  /v1/agents/:agentSlug/models
 *
 * An OpenAI client pointed at `<api>/v1/agents/<slug>` talks to the agent as
 * if it were a model: plain and streamed completions, the caller's own
 * functions (handed back as `tool_calls`, their results accepted on the next
 * request) next to the agent's server-side skills, and the knowledge base it
 * is bound to.
 *
 * Like the playground route this is an adapter. Who may chat, on which model,
 * with what grounding and at whose expense is decided by the shared
 * agent-chat service (services/agentChat.ts); this file translates between
 * that service and OpenAI's request, response, stream and error shapes
 * (services/openaiCompat.ts).
 *
 * The agent is resolved by (caller's organization, slug). Another
 * organization's slug is a 404, so existence is never revealed.
 */

import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

import { prisma } from "../lib/prisma.js";
import type { RateLimitResult } from "../middleware/free-tier-limit.js";
import {
  AGENTS_INVOKE_SCOPE,
  createOpenAiAuth,
  openAiErrorHandler,
  replyOpenAiError,
  sendOpenAiError,
} from "../middleware/openaiAuth.js";
import {
  prepareAgentChat,
  SHUTTING_DOWN,
  type AgentChatDeps,
  type AgentChatFailure,
  type AgentChatNotAnswered,
  type AgentChatRefusal,
  type AgentChatSession,
  type AgentGraphRunInfo,
} from "../services/agentChat.js";
import { buildAgentChatDeps } from "../services/buildAgentChatDeps.js";
import { abortOnClientClose } from "../services/chatStreamSettlement.js";
import { licenceRevokedMessage } from "../services/marketplaceMetering.js";
import {
  createOpenAiStreamAdapter,
  newCompletionId,
  openAiError,
  parseChatCompletionRequest,
  toChatCompletion,
  type CompletionMeta,
  type OpenAiErrorResponse,
  type ParsedChatRequest,
} from "../services/openaiCompat.js";
import { agentOpenAiModel } from "../services/publicEndpoints.js";
import { publicFallbackReason } from "../services/skills/knowledgeSearchSkill.js";
import { streamToReply } from "../services/sseReply.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("agent-completions");

/**
 * Conversations with tool results in them are larger than Fastify's 1 MiB
 * default allows; the message cap in openaiCompat bounds what is accepted.
 */
export const V1_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

/** Keeps an idle proxy from cutting a stream while tool rounds run. */
const STREAM_HEARTBEAT_MS = 15_000;

const MAX_SLUG_LENGTH = 128;

export interface AgentCompletionDeps {
  /** Built on first use, so registering the routes opens no connection. */
  chatDeps?: () => AgentChatDeps;
  /** The /v1 guard; defaults to createOpenAiAuth with the agents:invoke scope. */
  auth?: preHandlerHookHandler;
  /** The agent behind GET .../models, scoped to the caller's organization. */
  findAgent?: (orgId: string, slug: string) => Promise<{ slug: string; createdAt: Date } | null>;
  now?: () => number;
  heartbeatMs?: number;
}

export type AgentCompletionHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
  target: { agentSlug: string; chat: ParsedChatRequest },
) => Promise<unknown>;

// ============================================
// Refusals and failures in OpenAI's shape
// ============================================

function rateLimitedError(limit: RateLimitResult, nowSeconds: number): OpenAiErrorResponse {
  const minuteExhausted = limit.remaining.rpm <= 0;
  const resetAt = minuteExhausted ? limit.resetAt.rpm : limit.resetAt.rpd;
  const error = openAiError("rate_limit_exceeded", {
    message: minuteExhausted
      ? "Free-model rate limit reached for this organization (requests per minute). Retry after the time in the retry-after header, or give the agent a model with its own API key."
      : "Free-model rate limit reached for this organization (requests per day). Give the agent a model with its own API key to continue today.",
    retryAfterSeconds: Math.max(1, resetAt - nowSeconds),
  });
  // The daily allowance does not come back within any retry an SDK would do.
  if (!minuteExhausted) error.headers["x-should-retry"] = "false";
  return error;
}

export function refusalToOpenAiError(refusal: AgentChatRefusal, nowSeconds: number): OpenAiErrorResponse {
  switch (refusal.kind) {
    case "agent_not_found":
      return openAiError("agent_not_found");
    case "invalid_request":
      return openAiError(refusal.code, { param: refusal.param, message: refusal.message });
    case "not_configured":
    case "model_invalid":
      return openAiError(refusal.code, { message: refusal.message });
    case "rate_limited":
      return rateLimitedError(refusal.limit, nowSeconds);
    case "licence_revoked":
      return openAiError("licence_revoked", {
        message: licenceRevokedMessage(refusal.listingTitle, refusal.revocation, refusal.token),
        extra: {
          reason: refusal.revocation,
          listingTitle: refusal.listingTitle,
          ...(refusal.token && {
            tokenSymbol: refusal.token.symbol,
            mintAddress: refusal.token.mintAddress,
          }),
        },
      });
    case "payment_required":
      return openAiError("marketplace_payment_required", {
        message: `"${refusal.listingTitle}" is billed per request by its publisher. This request costs ${(
          Number(refusal.requiredCents) / 100
        ).toFixed(4)} USD and your balance is ${(Number(refusal.balanceCents) / 100).toFixed(2)} USD.`,
        extra: {
          requiredCents: Number(refusal.requiredCents),
          balanceCents: Number(refusal.balanceCents),
          listingTitle: refusal.listingTitle,
        },
      });
    case "hosted_model_unavailable":
      return openAiError("hosted_model_not_running", { message: refusal.message });
    case "shutting_down":
      return openAiError("service_unavailable", { message: SHUTTING_DOWN, retryAfterSeconds: 5 });
    case "client_gone":
      return openAiError("client_closed_request");
  }
}

/** The charge, if there was one, is already refunded by the service. */
export function failureToOpenAiError(failure: AgentChatFailure): OpenAiErrorResponse {
  if (failure.code === "client_gone") return openAiError("client_closed_request");
  return openAiError(failure.code, {
    message: failure.message,
    ...(failure.retryAfterSeconds !== null && { retryAfterSeconds: failure.retryAfterSeconds }),
    ...(failure.detail && { extra: failure.detail }),
  });
}

/** A chat that was admitted and then did not answer, refused or failed. */
function notAnsweredToOpenAiError(result: AgentChatNotAnswered, nowSeconds: number): OpenAiErrorResponse {
  return result.refusal
    ? refusalToOpenAiError(result.refusal, nowSeconds)
    : failureToOpenAiError(result.failure);
}

/**
 * The limiter's verdict for a free model, on every answer, refused or not:
 * OpenAI's header names for SDKs, and the dashboard's own RPM/RPD pair.
 */
function setRateLimitHeaders(reply: FastifyReply, limit: RateLimitResult, nowSeconds: number): void {
  reply.header("x-ratelimit-remaining-requests", limit.remaining.rpm);
  reply.header("x-ratelimit-reset-requests", `${Math.max(0, limit.resetAt.rpm - nowSeconds)}s`);
  reply.header("X-RateLimit-Remaining-RPM", limit.remaining.rpm);
  reply.header("X-RateLimit-Remaining-RPD", limit.remaining.rpd);
  reply.header("X-RateLimit-Reset-RPM", limit.resetAt.rpm);
  reply.header("X-RateLimit-Reset-RPD", limit.resetAt.rpd);
}

function requestId(headers: FastifyRequest["headers"]): string {
  const given = headers["x-request-id"];
  const value = (Array.isArray(given) ? given[0] : given)?.trim();
  return value && value.length <= 128 ? value : `req_${randomUUID().replace(/-/g, "")}`;
}

/** The `wheelsai` object: what an OpenAI response has no field for. */
function extensionOf(session: AgentChatSession, graph?: AgentGraphRunInfo): Record<string, unknown> {
  const { retrieval } = session;
  return {
    agent: { slug: session.agent.slug, version: session.agent.version },
    // The model that actually answered; `model` on the response is the agent.
    // For a graph agent, the model its llm nodes default to (a node may name
    // its own), or null.
    model: session.modelId,
    // "platform": the platform's chat runtime on the agent's prompt, model
    // and tools. "graph": the agent's saved graph. Neither is a container on
    // a GPU.
    runtime: session.runtime,
    // The run behind a graph agent's answer, inspectable in the builder.
    ...(graph && { graph }),
    billing: session.billing,
    retrieval: retrieval
      ? {
          mode: retrieval.mode,
          // Never the embedding provider's own error body.
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

// ============================================
// Handler
// ============================================

export function createAgentCompletionHandler(deps: AgentCompletionDeps = {}): AgentCompletionHandler {
  const now = deps.now ?? Date.now;
  let chatDeps: AgentChatDeps | null = null;
  const getChatDeps = () => (chatDeps ??= (deps.chatDeps ?? buildAgentChatDeps)());

  return async (request, reply, { agentSlug, chat }) => {
    // Wired before the first await: a client that leaves during the lookups
    // below stops the run and is refunded, as is one already gone.
    const abort = abortOnClientClose(reply.raw);
    reply.header("X-Request-Id", requestId(request.headers));

    if (agentSlug.length === 0 || agentSlug.length > MAX_SLUG_LENGTH) {
      return replyOpenAiError(reply, "agent_not_found");
    }

    const prepared = await prepareAgentChat(
      {
        orgId: request.auth!.orgId,
        agent: { slug: agentSlug },
        caller: "owner",
        source: "api",
        messages: chat.messages,
        // `model` in the body does not pick the agent's model: the agent IS
        // the model here, configured by its owner.
        modelOverride: null,
        requestParams: chat.params,
        clientTools: chat.tools,
        toolChoice: chat.toolChoice,
        signal: abort.signal,
      },
      getChatDeps(),
    );

    const nowSeconds = Math.floor(now() / 1000);
    const limit = prepared.ok
      ? prepared.session.rateLimit
      : prepared.refusal.kind === "rate_limited"
        ? prepared.refusal.limit
        : null;
    if (limit) setRateLimitHeaders(reply, limit, nowSeconds);
    if (!prepared.ok) return sendOpenAiError(reply, refusalToOpenAiError(prepared.refusal, nowSeconds));

    const { session } = prepared;
    const meta: CompletionMeta = {
      id: newCompletionId(),
      created: nowSeconds,
      model: agentOpenAiModel(session.agent.slug),
    };

    if (chat.stream) {
      // Tool rounds, a graph run and the provider's acceptance happen inside
      // stream(), so a failure here is still a plain HTTP error with nothing
      // flushed.
      const started = await session.stream();
      if (!started.ok) return sendOpenAiError(reply, notAnsweredToOpenAiError(started, nowSeconds));
      const extension = extensionOf(session, started.graph);

      const sent = await streamToReply(reply, started.chat, {
        meter: session.meter,
        abort,
        heartbeatMs: deps.heartbeatMs ?? STREAM_HEARTBEAT_MS,
        transform: (upstream) =>
          createOpenAiStreamAdapter(upstream, {
            ...meta,
            includeUsage: chat.includeUsage,
            opening: extension,
          }),
      });
      if (!sent.started) return replyOpenAiError(reply, "client_closed_request");
      if (!sent.outcome.ok) {
        logger.warn(
          { agentId: session.agent.id, modelId: session.modelId, error: sent.outcome.error },
          "Streamed /v1 chat produced no answer",
        );
      }
      return;
    }

    const completed = await session.complete();
    if (!completed.ok) return sendOpenAiError(reply, notAnsweredToOpenAiError(completed, nowSeconds));
    const { result } = completed;
    const extension = extensionOf(session, completed.graph);

    return toChatCompletion({
      ...meta,
      content: result.content,
      finishReason: result.finishReason,
      toolCalls: result.clientToolCalls,
      usage: result.reportedUsage,
      extension: { ...extension, tool_calls: result.toolCalls ?? [] },
    });
  };
}

// ============================================
// Routes (registered under /v1)
// ============================================

export function createAgentCompletionRoutes(deps: AgentCompletionDeps = {}): FastifyPluginAsync {
  const auth = deps.auth ?? createOpenAiAuth({ scope: AGENTS_INVOKE_SCOPE });
  const complete = createAgentCompletionHandler(deps);
  const findAgent =
    deps.findAgent ??
    ((orgId: string, slug: string) =>
      prisma.agent.findUnique({
        where: { orgId_slug: { orgId, slug } },
        select: { slug: true, createdAt: true },
      }));

  return async (app) => {
    app.setErrorHandler(openAiErrorHandler);

    app.post(
      "/agents/:agentSlug/chat/completions",
      {
        preHandler: [auth],
        bodyLimit: V1_BODY_LIMIT_BYTES,
        schema: {
          tags: ["OpenAI-compatible"],
          description:
            "OpenAI chat completions served by an agent: streaming, caller-defined functions and the agent's own tools.",
          security: [{ bearerAuth: [] }],
        },
      },
      async (request, reply) => {
        const { agentSlug } = request.params as { agentSlug: string };
        const parsed = parseChatCompletionRequest(request.body);
        if (!parsed.ok) return sendOpenAiError(reply, parsed.error);
        return complete(request, reply, { agentSlug, chat: parsed.request });
      },
    );

    // So `client.models.list()` works with the per-agent base URL.
    app.get(
      "/agents/:agentSlug/models",
      {
        preHandler: [auth],
        schema: {
          tags: ["OpenAI-compatible"],
          description: "The one model an agent's base URL serves: the agent itself.",
          security: [{ bearerAuth: [] }],
        },
      },
      async (request, reply) => {
        const { agentSlug } = request.params as { agentSlug: string };
        const agent =
          agentSlug.length === 0 || agentSlug.length > MAX_SLUG_LENGTH
            ? null
            : await findAgent(request.auth!.orgId, agentSlug);
        if (!agent) return replyOpenAiError(reply, "agent_not_found");
        return { object: "list", data: [agentModelEntry(agent)] };
      },
    );
  };
}

export function agentModelEntry(agent: { slug: string; createdAt: Date }): Record<string, unknown> {
  return {
    id: agentOpenAiModel(agent.slug),
    object: "model",
    created: Math.floor(agent.createdAt.getTime() / 1000),
    owned_by: "wheelsai",
    wheelsai: { kind: "agent" },
  };
}
