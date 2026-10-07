/**
 * How a public chat's result (services/publicChat.ts) becomes an HTTP
 * response. The widget route and the Try it route both answer through this,
 * so a visitor is told the same things in the same shapes on either.
 */

import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";

import { publicRefusalBody, type PublicChatRefusal, type PublicChatResult } from "../services/publicChat.js";
import { streamToReply } from "../services/sseReply.js";

/** Long enough for a tool round to finish; short enough for idle proxies. */
const STREAM_HEARTBEAT_MS = 15_000;

/** Caches must not hand one site's answer to another. */
export function varyByOrigin(reply: FastifyReply): void {
  const current = reply.getHeader("vary");
  const names = (Array.isArray(current) ? current.join(",") : String(current ?? ""))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.some((name) => name.toLowerCase() === "origin" || name === "*")) return;
  reply.header("vary", [...names, "Origin"].join(", "));
}

export function sendPublicRefusal(reply: FastifyReply, refusal: PublicChatRefusal): FastifyReply {
  if (refusal.retryAfterSeconds !== undefined) reply.header("retry-after", String(refusal.retryAfterSeconds));
  // A refusal is about this request, now: nothing may replay it later.
  reply.header("cache-control", "no-store");
  return reply.status(refusal.status).send(publicRefusalBody(refusal));
}

const CLIENT_GONE: PublicChatRefusal = {
  status: 499,
  code: "client_closed_request",
  message: "The request was cancelled.",
};

export async function sendPublicChatResult(
  reply: FastifyReply,
  result: PublicChatResult,
  abort: AbortController,
): Promise<FastifyReply | void> {
  if (result.kind === "refused") return sendPublicRefusal(reply, result.refusal);
  reply.header("cache-control", "no-store");
  if (result.kind === "answer") {
    return reply.status(200).send({ message: result.message, toolCalls: result.toolCalls });
  }
  // The headers set so far (CORS above all) go out with the stream, and
  // every charge behind the answer settles only when it was delivered.
  const sent = await streamToReply(reply, result.chat, {
    meter: result.meter,
    abort,
    heartbeatMs: STREAM_HEARTBEAT_MS,
  });
  if (!sent.started) return sendPublicRefusal(reply, CLIENT_GONE);
  await result.finished(sent.outcome);
}

/**
 * The error handler of a public plugin. Fastify's own errors (a body that is
 * too large, JSON that does not parse) keep their status; anything else is a
 * 500 that says nothing about what failed.
 */
export function installPublicErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === "number" ? error.statusCode : 500;
    reply.header("cache-control", "no-store");
    if (status >= 400 && status < 500) {
      return reply.status(status).send({
        error: status === 429 ? "rate_limited" : "invalid_request",
        message:
          status === 413
            ? "The request is too large."
            : status === 429
              ? "Too many requests. Please wait a moment and try again."
              : "The request could not be read.",
      });
    }
    request.log.error({ err: error }, "public chat request failed");
    return reply.status(500).send({ error: "internal_error", message: "Something went wrong. Please try again." });
  });
}
