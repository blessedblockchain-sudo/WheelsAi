/**
 * `model: "a/<handle>"` on /v1/chat/completions: an agent the caller PAYS to
 * use, named by the handle on its page, so an agent has one name everywhere.
 *
 * It is the page's paid chat (services/paidUse.ts, runPaidChat) in OpenAI's
 * wire format, on the same deps (productionPaidUseDeps), so a buyer's limits
 * and counters are shared between the page and the API. What this file adds
 * is the translation, both ways:
 *
 *   in    the OpenAI body, less everything a buyer may not send: tools,
 *         tool_choice and a system or tool message are `unsupported_parameter`
 *         before anything is counted or charged. Sampling settings are
 *         accepted and NOT applied: the agent's owner sets the model and its
 *         settings.
 *   out   a chat.completion (or its chunks) whose `model` echoes
 *         `a/<handle>`, plus `wheelsai: { agent: { handle }, billing }` and
 *         nothing else. Never the agent's own model id, a document title, the
 *         creator's organization or token usage (which would measure the
 *         instructions).
 *
 * Money is the paid service's: charged once before the run, settled when the
 * answer is delivered, refunded in every other ending. A streamed answer is
 * the checked answer released whole, and settles on delivery (streamToReply),
 * exactly as on the page.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import { replyOpenAiError, sendOpenAiError } from "../middleware/openaiAuth.js";
import { abortOnClientClose } from "../services/chatStreamSettlement.js";
import type { ChatStream } from "../services/mastra-runtime.js";
import {
  extensionChunk,
  newCompletionId,
  paidUseOpenAiError,
  SSE_DONE,
  sseFrame,
  toChatCompletion,
  toChunk,
  type CompletionMeta,
  type ParsedChatRequest,
} from "../services/openaiCompat.js";
import { runPaidChat, type PaidUseBilling, type PaidUseDeps } from "../services/paidUse.js";
import { streamToReply } from "../services/sseReply.js";

export const PAID_MODEL_PREFIX = "a/";

/** The scope a key needs to pay for a use: a spend scope, held only by name. */
export const AGENTS_USE_SCOPE = "agents:use";

const STREAM_HEARTBEAT_MS = 15_000;

/** `a/<handle>`: what a paid agent is called as an OpenAI `model`. */
export function paidOpenAiModel(handle: string): string {
  return `${PAID_MODEL_PREFIX}${handle}`;
}

/** A paid agent the organization uses, as an OpenAI model object. */
export function paidModelEntry(agent: { handle: string; createdAt: Date }): Record<string, unknown> {
  return {
    id: paidOpenAiModel(agent.handle),
    object: "model",
    created: Math.floor(agent.createdAt.getTime() / 1000),
    owned_by: "wheelsai",
    wheelsai: { kind: "paid_agent" },
  };
}

export interface PaidCompletionDeps {
  /** Built on first use. Default: the one set of paid-use deps of this process. */
  paidUse?: () => PaidUseDeps;
  now?: () => number;
  heartbeatMs?: number;
}

export type PaidCompletionHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
  target: { handle: string; chat: ParsedChatRequest },
) => Promise<FastifyReply | void>;

/** What a buyer may not send, by the name of the parameter. null = nothing. */
export function paidRequestRefusal(chat: ParsedChatRequest): { param: string; message: string } | null {
  if (chat.tools.length > 0) {
    return { param: "tools", message: "An agent you pay to use does not accept caller-defined tools. Remove tools." };
  }
  if (chat.toolChoice !== null) {
    return { param: "tool_choice", message: "An agent you pay to use does not accept tool_choice. Remove it." };
  }
  for (const [index, message] of chat.messages.entries()) {
    const steering =
      message.role === "system" ||
      message.role === "tool" ||
      (message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0);
    if (steering) {
      return {
        param: `messages[${index}].role`,
        message:
          "An agent you pay to use accepts only user and assistant text messages. Its owner sets its instructions; remove the system and tool messages.",
      };
    }
  }
  return null;
}

/** The `wheelsai` object of a paid answer: the handle and the billing, and nothing else. */
function extensionOf(handle: string, billing: PaidUseBilling): Record<string, unknown> {
  return {
    agent: { handle },
    billing: { chargedCents: billing.chargedCents, balanceCents: billing.balanceCents, access: billing.access },
  };
}

/**
 * The page's public stream (lib/publicSse.ts) as OpenAI chunks. The answer
 * is already whole, so it is read to its end and written out again: the
 * `wheelsai` chunk first, the text, a finish chunk, [DONE]. Only content
 * deltas are carried over; a tool-call event and the page's own billing
 * event are not forwarded.
 */
function toOpenAiChunks(chat: ChatStream, meta: CompletionMeta, extension: Record<string, unknown>): ChatStream {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let body = "";
  const stream = chat.stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes) {
        body += decoder.decode(bytes, { stream: true });
      },
      flush(controller) {
        body += decoder.decode();
        const send = (payload: unknown) => controller.enqueue(encoder.encode(sseFrame(payload)));
        send(extensionChunk(meta, extension));
        let first = true;
        for (const line of body.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]" || data.length === 0) continue;
          let json: { choices?: Array<{ delta?: { content?: unknown } }> } | null = null;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          const content = json?.choices?.[0]?.delta?.content;
          if (typeof content !== "string" || content.length === 0) continue;
          send(toChunk(meta, first ? { role: "assistant", content } : { content }));
          first = false;
        }
        send(toChunk(meta, first ? { role: "assistant" } : {}, "stop"));
        controller.enqueue(encoder.encode(SSE_DONE));
      },
    }),
  );
  return { stream, outcome: chat.outcome };
}

export function createPaidCompletionHandler(deps: PaidCompletionDeps = {}): PaidCompletionHandler {
  const now = deps.now ?? Date.now;
  let paidUse: PaidUseDeps | null = null;
  const core = async (): Promise<PaidUseDeps> => {
    if (paidUse) return paidUse;
    if (deps.paidUse) return (paidUse = deps.paidUse());
    // Imported on first use: registering /v1 opens nothing of paid use.
    const { productionPaidUseDeps } = await import("../services/buildPaidUseDeps.js");
    return (paidUse = productionPaidUseDeps());
  };

  return async (request, reply, { handle, chat }) => {
    // Wired before the first await: a caller who leaves stops the run, and
    // whatever was charged goes back.
    const abort = abortOnClientClose(reply.raw);

    // Before anything is counted, looked up or charged.
    const unsupported = paidRequestRefusal(chat);
    if (unsupported) return replyOpenAiError(reply, "unsupported_parameter", unsupported);

    const auth = request.auth!;
    const result = await runPaidChat(
      {
        caller: {
          orgId: auth.orgId,
          userId: auth.userId,
          type: auth.type,
          apiKeyId: auth.apiKeyId ?? null,
          scopes: auth.scopes ?? [],
        },
        handle,
        // The page's body and nothing else: `temperature`, `max_tokens` and
        // the rest were accepted by the parser and stop here.
        body: {
          messages: chat.messages.map((message) => ({ role: message.role, content: message.content ?? "" })),
          stream: chat.stream,
        },
        signal: abort.signal,
      },
      await core(),
    );

    reply.header("cache-control", "no-store");
    if (result.kind === "refused") return sendOpenAiError(reply, paidUseOpenAiError(result.refusal));

    const shownHandle = handle.toLowerCase();
    const meta: CompletionMeta = {
      id: newCompletionId(),
      created: Math.floor(now() / 1000),
      model: paidOpenAiModel(shownHandle),
    };

    if (result.kind === "stream") {
      const extension = extensionOf(shownHandle, result.billing);
      const sent = await streamToReply(reply, result.chat, {
        meter: result.meter,
        abort,
        heartbeatMs: deps.heartbeatMs ?? STREAM_HEARTBEAT_MS,
        transform: (upstream) => toOpenAiChunks(upstream, meta, extension),
      });
      if (!sent.started) {
        // Gone before the first byte; streamToReply refunded.
        await result.finished({ ok: false, error: "client disconnected", toolCalls: [], code: "client_gone" });
        return replyOpenAiError(reply, "client_closed_request");
      }
      await result.finished(sent.outcome);
      return;
    }

    return reply.status(200).send(
      toChatCompletion({
        ...meta,
        content: result.message.content,
        finishReason: "stop",
        extension: extensionOf(shownHandle, result.billing),
      }),
    );
  };
}
