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
 *
 * The usage headers are the page's (services/usageHeaders.ts), written from
 * the billing object the `wheelsai` extension carries, before the body.
 *
 * The x402 door (createPaidX402CompletionHandler): a call with NO credential
 * at all, which the unified guard lets through only for `a/<handle>` while
 * the door is open, is answered by the door (services/paidUseX402.ts). The
 * listing is judged first and only then the body, by the same parse and the
 * same refusals as a buyer's call; a 402 carries PAYMENT-REQUIRED and
 * OpenAI's error shape, and a paid answer is the same chat.completion with
 * PAYMENT-RESPONSE. A handle the door does not serve gets the 401 of a
 * missing key, byte for byte.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import { replyMissingApiKey, replyOpenAiError, sendOpenAiError } from "../middleware/openaiAuth.js";
import { abortOnClientClose } from "../services/chatStreamSettlement.js";
import type { ChatStream } from "../services/mastra-runtime.js";
import {
  extensionChunk,
  newCompletionId,
  openAiError,
  paidUseOpenAiError,
  parseChatCompletionRequest,
  SSE_DONE,
  sseFrame,
  toChatCompletion,
  toChunk,
  type CompletionMeta,
  type OpenAiErrorResponse,
  type ParsedChatRequest,
} from "../services/openaiCompat.js";
import { runPaidChat, type PaidUseBilling, type PaidUseDeps } from "../services/paidUse.js";
import { runX402Use, type X402BodyCheck } from "../services/paidUseX402.js";
import { streamToReply } from "../services/sseReply.js";
import { clearUsageHeaders, refusalUsageHeadersOf, setUsageHeaders, usageHeadersOf } from "../services/usageHeaders.js";
import { setX402Headers, x402DoorCallOf, type PaidUseX402Door } from "./paidUse.js";

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
  /**
   * The x402 door. Default: the process's own (services/buildPaidUseX402Deps.ts),
   * imported on first use; null answers every call it would take with the
   * 401 of a missing key.
   */
  x402?: () => PaidUseX402Door | null;
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
  const { plan } = billing;
  return {
    agent: { handle },
    billing: {
      chargedCents: billing.chargedCents,
      balanceCents: billing.balanceCents,
      access: billing.access,
      // On a plan: the count after this use, as the page's answer carries it.
      ...(plan && {
        plan: {
          id: plan.id,
          use: plan.use,
          // True on the listing's free trial.
          trial: plan.trial,
          includedUses: plan.includedUses,
          carriedUses: plan.carriedUses,
          usedUses: plan.usedUses,
          remainingUses: plan.remainingUses,
          extraUsePriceCents: plan.extraUsePriceCents,
          ...(plan.resetsAt !== undefined && { resetsAt: plan.resetsAt }),
          warning: plan.warning,
        },
      }),
    },
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
    if (result.kind === "refused") {
      // Only a plan that is used up has any: the plan's count, with nothing remaining.
      setUsageHeaders(reply, refusalUsageHeadersOf(result.refusal));
      return sendOpenAiError(reply, paidUseOpenAiError(result.refusal));
    }
    setUsageHeaders(reply, usageHeadersOf(result.billing));

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
        // No answer went out, so nothing says what one cost.
        clearUsageHeaders(reply);
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

export type PaidX402CompletionHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
  target: { handle: string },
) => Promise<FastifyReply | void>;

/**
 * `a/<handle>` on /v1 for a caller with no credential: one use paid from a
 * wallet at the agent's x402 door. The door judges the listing before the
 * body is read; the body is then the parse and the refusals of a buyer's
 * call, with `stream` as the parse reads it (not streaming unless asked).
 */
export function createPaidX402CompletionHandler(deps: PaidCompletionDeps = {}): PaidX402CompletionHandler {
  const now = deps.now ?? Date.now;
  const door = async (): Promise<PaidUseX402Door | null> => {
    if (deps.x402) return deps.x402();
    // Imported on first use: registering /v1 opens nothing of the door.
    const { productionX402Door } = await import("../services/buildPaidUseX402Deps.js");
    return productionX402Door();
  };

  return async (request, reply, { handle }) => {
    let binding: PaidUseX402Door | null;
    try {
      binding = await door();
    } catch (err) {
      request.log.error({ err }, "x402 door could not be built; answered as a call with no key");
      return replyMissingApiKey(reply);
    }
    const call = x402DoorCallOf(request, reply, () => binding);
    if (!call) return replyMissingApiKey(reply);

    // The route's own check, run by the door once it serves the listing.
    const checkBody = (): X402BodyCheck<OpenAiErrorResponse> => {
      const parsed = parseChatCompletionRequest(request.body);
      if (!parsed.ok) return { ok: false, refused: parsed.error };
      const unsupported = paidRequestRefusal(parsed.request);
      if (unsupported) return { ok: false, refused: openAiError("unsupported_parameter", unsupported) };
      return {
        ok: true,
        // The page's body and nothing else, as for a buyer. `stream` is the
        // parse's boolean: OpenAI's default is a whole answer.
        body: {
          messages: parsed.request.messages.map((message) => ({ role: message.role, content: message.content ?? "" })),
          stream: parsed.request.stream,
        },
      };
    };

    const result = await runX402Use<OpenAiErrorResponse>(
      {
        kind: "chat",
        handle,
        body: request.body,
        checkBody,
        headers: request.headers,
        bucket: call.bucket,
        arrivedAt: call.arrivedAt,
        resourceUrl: call.resourceUrl,
        signal: call.gone.signal,
        onServed: call.onServed,
      },
      call.deps,
    );
    if (result.kind === "not_served") return replyMissingApiKey(reply);
    if (result.kind === "body_refused") return sendOpenAiError(reply, result.refused);

    reply.header("cache-control", "no-store");
    if (result.kind === "refusal") {
      setX402Headers(reply, result.headers);
      // After the claim, an OpenAI SDK must not send the same payment again
      // by itself: it would only be told it was presented twice.
      return sendOpenAiError(
        reply,
        paidUseOpenAiError({ ...result.refusal, ...(call.claimed() && { noAutomaticRetry: true }) }),
      );
    }

    // Paid and confirmed: what was paid rides in the headers, set before the body.
    setX402Headers(reply, result.headers);
    setUsageHeaders(reply, usageHeadersOf(result.billing));
    const shownHandle = handle.toLowerCase();
    const meta: CompletionMeta = {
      id: newCompletionId(),
      created: Math.floor(now() / 1000),
      model: paidOpenAiModel(shownHandle),
    };
    const extension = extensionOf(shownHandle, result.billing);

    if (result.stream) {
      const sent = await streamToReply(reply, result.stream, {
        meter: null,
        abort: call.gone,
        heartbeatMs: deps.heartbeatMs ?? STREAM_HEARTBEAT_MS,
        transform: (upstream) => toOpenAiChunks(upstream, meta, extension),
      });
      if (!sent.started) {
        // The payment went through and its sale is written; the caller left
        // between the two. Nothing reads this answer.
        request.log.error({ handle: shownHandle }, "x402 door: a paid answer was not delivered; the caller left after the sale");
        return reply.status(499).send();
      }
      return;
    }

    if (call.gone.signal.aborted) {
      // As above: paid and written, and the caller is gone before the answer.
      request.log.error({ handle: shownHandle }, "x402 door: a paid answer was not delivered; the caller left after the sale");
    }
    return reply.status(200).send(
      toChatCompletion({
        ...meta,
        content: result.text,
        finishReason: "stop",
        extension,
      }),
    );
  };
}
