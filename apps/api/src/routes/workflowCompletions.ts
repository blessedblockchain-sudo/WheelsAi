/**
 * The OpenAI-compatible API of a workflow.
 *
 *   POST /v1/workflows/:workflowSlug/chat/completions
 *   GET  /v1/workflows/:workflowSlug/models
 *
 * and, through routes/openaiV1.ts, POST /v1/chat/completions with
 * `model: "workflow/<slug>"`.
 *
 * The last user message is the run's input; the run's final output comes
 * back as the assistant message, with usage summed over its steps. One
 * request is one run and one plan API call; each step inside the run is
 * billed by its own rules, exactly as when the dashboard or the scheduler
 * starts the same workflow.
 *
 * An adapter, like the agent route: what a request means to a workflow and
 * what happens to a run nobody is waiting for any more is decided by
 * services/workflowChat.ts. This file translates to and from OpenAI's
 * request, response, stream and error shapes.
 *
 * Streaming. A workflow produces its answer at the end, not token by token.
 * With `stream: true` the response starts as soon as the run is queued - so
 * a proxy sees bytes and the caller learns the execution id - is kept alive
 * while the run works, and then delivers the same answer as content chunks.
 * A run that fails after the stream opened ends with one error event and no
 * `[DONE]`.
 */

import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

import {
  createOpenAiAuth,
  openAiErrorHandler,
  replyOpenAiError,
  sendOpenAiError,
  WORKFLOWS_INVOKE_SCOPE,
} from "../middleware/openaiAuth.js";
import { buildWorkflowChatDeps } from "../services/buildWorkflowChatDeps.js";
import { abortOnClientClose } from "../services/chatStreamSettlement.js";
import {
  newCompletionId,
  openAiError,
  parseChatCompletionRequest,
  SSE_DONE,
  sseFrame,
  toChatCompletion,
  toChunk,
  usageChunk,
  type CompletionMeta,
  type ParsedChatRequest,
} from "../services/openaiCompat.js";
import { workflowOpenAiModel } from "../services/publicEndpoints.js";
import { sseHeaders } from "../services/sseReply.js";
import {
  startWorkflowChat,
  type WorkflowChatDeps,
  type WorkflowChatOutcome,
  type WorkflowChatRefusal,
} from "../services/workflowChat.js";
import { createLogger } from "../utils/logger.js";
import { V1_BODY_LIMIT_BYTES } from "./agentCompletions.js";

const logger = createLogger("workflow-completions");

/** Keeps an idle proxy from cutting the stream while the run works. */
const STREAM_HEARTBEAT_MS = 15_000;
const HEARTBEAT = ": keep-alive\n\n";
/** The answer exists in full; it is cut only to keep each SSE frame small. */
const STREAM_CHUNK_CHARS = 2_000;
const MAX_SLUG_LENGTH = 128;

export interface WorkflowCompletionDeps {
  /** Built on first use, so registering the routes opens no connection. */
  workflowDeps?: () => WorkflowChatDeps;
  /** The /v1 guard; defaults to createOpenAiAuth with the workflows:invoke scope. */
  workflowAuth?: preHandlerHookHandler;
  now?: () => number;
  workflowHeartbeatMs?: number;
}

export type WorkflowCompletionHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
  target: { workflowSlug: string; chat: ParsedChatRequest },
) => Promise<unknown>;

function requestId(headers: FastifyRequest["headers"]): string {
  const given = headers["x-request-id"];
  const value = (Array.isArray(given) ? given[0] : given)?.trim();
  return value && value.length <= 128 ? value : `req_${randomUUID().replace(/-/g, "")}`;
}

/** The API key or the user behind the request; recorded on the run. */
function triggeredById(auth: NonNullable<FastifyRequest["auth"]>): string | null {
  return auth.type === "api_key" ? (auth.apiKeyId ?? null) : (auth.userId ?? null);
}

function sendRefusal(reply: FastifyReply, refusal: WorkflowChatRefusal): FastifyReply {
  return sendOpenAiError(reply, openAiError(refusal.code, refusal.detail));
}

/** The answer as SSE frames, ending in `[DONE]`. */
export function workflowAnswerFrames(
  meta: CompletionMeta,
  outcome: Extract<WorkflowChatOutcome, { ok: true }>,
  includeUsage: boolean,
): string {
  let frames = "";
  for (let at = 0; at < outcome.content.length; at += STREAM_CHUNK_CHARS) {
    frames += sseFrame(toChunk(meta, { content: outcome.content.slice(at, at + STREAM_CHUNK_CHARS) }));
  }
  frames += sseFrame({ ...toChunk(meta, {}, "stop"), wheelsai: outcome.extension });
  const usage = includeUsage ? usageChunk(meta, outcome.usage) : null;
  return frames + (usage ? sseFrame(usage) : "") + SSE_DONE;
}

export function createWorkflowCompletionHandler(deps: WorkflowCompletionDeps = {}): WorkflowCompletionHandler {
  const now = deps.now ?? Date.now;
  let chatDeps: WorkflowChatDeps | null = null;
  const getDeps = () => (chatDeps ??= (deps.workflowDeps ?? buildWorkflowChatDeps)());

  return async (request, reply, { workflowSlug, chat }) => {
    // Wired before the first await: a client that leaves at any point from
    // here on gets its run cancelled, not left running with nobody to answer.
    const abort = abortOnClientClose(reply.raw);
    reply.header("X-Request-Id", requestId(request.headers));

    if (workflowSlug.length === 0 || workflowSlug.length > MAX_SLUG_LENGTH) {
      return replyOpenAiError(reply, "workflow_not_found");
    }

    const session = await startWorkflowChat(
      {
        orgId: request.auth!.orgId,
        slug: workflowSlug,
        messages: chat.messages,
        hasTools: chat.tools.length > 0 || chat.toolChoice !== null,
        triggeredById: triggeredById(request.auth!),
        signal: abort.signal,
      },
      getDeps(),
    );
    if (!session.ok) return sendRefusal(reply, session);

    const meta: CompletionMeta = {
      id: newCompletionId(),
      created: Math.floor(now() / 1000),
      model: workflowOpenAiModel(session.workflow.slug),
    };

    if (!chat.stream) {
      const outcome = await session.finish();
      if (!outcome.ok) return sendRefusal(reply, outcome);
      return toChatCompletion({
        ...meta,
        content: outcome.content,
        finishReason: "stop",
        usage: outcome.usage,
        extension: outcome.extension,
      });
    }

    const raw = reply.raw;
    const write = (text: string) => {
      if (!raw.writableEnded && !raw.destroyed) raw.write(text);
    };
    raw.writeHead(200, sseHeaders(reply));
    // The role, and the run's id while it is still going: a caller that
    // loses the connection can look the run up.
    write(
      sseFrame({
        ...toChunk(meta, { role: "assistant", content: "" }),
        wheelsai: {
          workflow: { slug: session.workflow.slug, executionId: session.executionId, status: "running" },
        },
      }),
    );
    const heartbeatMs = deps.workflowHeartbeatMs ?? STREAM_HEARTBEAT_MS;
    const heartbeat = heartbeatMs > 0 ? setInterval(() => write(HEARTBEAT), heartbeatMs) : undefined;
    heartbeat?.unref?.();

    try {
      const outcome = await session.finish();
      write(
        outcome.ok
          ? workflowAnswerFrames(meta, outcome, chat.includeUsage)
          : // After the head is sent a failure can only be an event. No [DONE]:
            // clients stop reading there, and would see an empty answer.
            sseFrame(openAiError(outcome.code, outcome.detail).body),
      );
    } catch (err) {
      logger.error({ err, executionId: session.executionId }, "Streamed workflow completion failed");
      write(sseFrame(openAiError("internal_error", { extra: { executionId: session.executionId } }).body));
    } finally {
      clearInterval(heartbeat);
      raw.end();
    }
  };
}

export function workflowModelEntry(workflow: { slug: string; createdAt: Date }): Record<string, unknown> {
  return {
    id: workflowOpenAiModel(workflow.slug),
    object: "model",
    created: Math.floor(workflow.createdAt.getTime() / 1000),
    owned_by: "wheelsai",
    wheelsai: { kind: "workflow" },
  };
}

// ============================================
// Routes (registered under /v1)
// ============================================

export function createWorkflowCompletionRoutes(deps: WorkflowCompletionDeps = {}): FastifyPluginAsync {
  const auth = deps.workflowAuth ?? createOpenAiAuth({ scope: WORKFLOWS_INVOKE_SCOPE });
  const complete = createWorkflowCompletionHandler(deps);
  let chatDeps: WorkflowChatDeps | null = null;
  const getDeps = () => (chatDeps ??= (deps.workflowDeps ?? buildWorkflowChatDeps)());

  return async (app) => {
    app.setErrorHandler(openAiErrorHandler);

    app.post(
      "/workflows/:workflowSlug/chat/completions",
      {
        preHandler: [auth],
        bodyLimit: V1_BODY_LIMIT_BYTES,
        schema: {
          tags: ["OpenAI-compatible"],
          description:
            "OpenAI chat completions served by a workflow: the last user message is the run's input, the run's output is the answer.",
          security: [{ bearerAuth: [] }],
        },
      },
      async (request, reply) => {
        const { workflowSlug } = request.params as { workflowSlug: string };
        const parsed = parseChatCompletionRequest(request.body);
        if (!parsed.ok) return sendOpenAiError(reply, parsed.error);
        return complete(request, reply, { workflowSlug, chat: parsed.request });
      },
    );

    // So `client.models.list()` works with the per-workflow base URL.
    app.get(
      "/workflows/:workflowSlug/models",
      {
        preHandler: [auth],
        schema: {
          tags: ["OpenAI-compatible"],
          description: "The one model a workflow's base URL serves: the workflow itself.",
          security: [{ bearerAuth: [] }],
        },
      },
      async (request, reply) => {
        const { workflowSlug } = request.params as { workflowSlug: string };
        const workflow =
          workflowSlug.length === 0 || workflowSlug.length > MAX_SLUG_LENGTH
            ? null
            : await getDeps().findWorkflow(request.auth!.orgId, workflowSlug);
        if (!workflow) return replyOpenAiError(reply, "workflow_not_found");
        return { object: "list", data: [workflowModelEntry(workflow)] };
      },
    );
  };
}
