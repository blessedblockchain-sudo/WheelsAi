/**
 * Sends a chat stream to a Fastify reply as Server-Sent Events.
 *
 * SSE is written to `reply.raw`, which skips Fastify's own header handling:
 * `writeHead` with just the SSE headers silently dropped everything earlier
 * hooks and the handler had set with `reply.header()` - the CORS headers from
 * @fastify/cors (so a browser on another origin could not read the stream at
 * all), the request id and the rate-limit headers. `streamToReply` merges
 * `reply.getHeaders()` into the head it writes.
 *
 * It also owns the billing decision for a stream, which only the socket can
 * make: the answer settles when it was produced AND delivered, and refunds
 * otherwise (chatStreamSettlement.ts).
 */

import type { FastifyReply } from "fastify";

import {
  CLIENT_GONE,
  forwardAndSettle,
  watchDelivery,
  type SettleableMeter,
} from "./chatStreamSettlement.js";
import type { ChatStream, StreamOutcome } from "./mastra-runtime.js";

export interface StreamToReplyOptions {
  /** The charge to settle or refund; null when nothing was charged. */
  meter: SettleableMeter | null;
  /** The client-disconnect signal (abortOnClientClose(reply.raw)). */
  abort: AbortController;
  /**
   * Rewrites the stream before any byte reaches the socket (the OpenAI
   * adapter for /v1). The transformed stream keeps the same outcome.
   */
  transform?: (chat: ChatStream) => ChatStream;
  /**
   * Send an SSE comment every this many ms while the stream is quiet, so an
   * idle proxy does not cut a slow answer. Off when omitted.
   */
  heartbeatMs?: number;
  /** How long a slow reader may hold the billing decision open. */
  deliveryTimeoutMs?: number;
}

export type StreamToReplyResult =
  /**
   * The client was already gone: nothing was written, the charge is refunded
   * and the stream cancelled. The route answers as it does for any client
   * that left (nobody reads it).
   */
  | { started: false }
  | { started: true; outcome: StreamOutcome };

/** Headers Fastify computed for a body that is not the one being sent. */
const NOT_FORWARDED = new Set(["content-length", "content-type", "transfer-encoding"]);

const HEARTBEAT = new TextEncoder().encode(": keep-alive\n\n");

export function sseHeaders(reply: FastifyReply): Record<string, number | string | string[]> {
  const headers: Record<string, number | string | string[]> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value === undefined || NOT_FORWARDED.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return {
    ...headers,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // nginx-style proxies buffer responses unless told not to, which turns a
    // stream into one late blob.
    "X-Accel-Buffering": "no",
  };
}

export async function streamToReply(
  reply: FastifyReply,
  chat: ChatStream,
  options: StreamToReplyOptions,
): Promise<StreamToReplyResult> {
  const { abort, meter } = options;

  // The whole answer of a tool-using chat exists by now, and the client may
  // have left while it was produced. Its charge goes back.
  if (abort.signal.aborted || reply.raw.destroyed) {
    await chat.stream.cancel().catch(() => {});
    await meter?.refund(CLIENT_GONE);
    return { started: false };
  }

  // Billing follows the stream's outcome: a real answer settles; a provider
  // error event, an empty answer, a cut-off stream or a vanished client
  // refunds. (write() on a closed socket returns false - it never throws - so
  // the byte loop alone cannot tell.) Watched BEFORE the first write.
  const delivered = watchDelivery(reply.raw, abort.signal, options.deliveryTimeoutMs);

  const outgoing = options.transform ? options.transform(chat) : chat;

  reply.raw.writeHead(200, sseHeaders(reply));

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (options.heartbeatMs && options.heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(HEARTBEAT);
    }, options.heartbeatMs);
    heartbeat.unref?.();
  }

  const outcome = await forwardAndSettle({
    chat: outgoing,
    write: (chunk) => {
      reply.raw.write(chunk);
    },
    end: () => {
      clearInterval(heartbeat);
      reply.raw.end();
    },
    delivered,
    meter,
  });
  return { started: true, outcome };
}
