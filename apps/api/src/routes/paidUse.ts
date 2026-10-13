/**
 * Paid use of a creator's agent, by the handle on its page.
 *
 *   GET  /api/a/:handle/access    what the caller may do with it right now
 *   POST /api/a/:handle/chat      one paid message
 *   POST /api/a/:handle/run       one paid run of a task agent
 *   GET  /api/a/:handle/results   a self-running agent's results, for a subscriber
 *
 * (GET /api/a/:handle itself is the public page's and needs no sign-in:
 * routes/publicAgent.ts.)
 *
 * Who: a session, or an API key. To pay (chat and run) a key must have been
 * granted agents:use by name; reading access or results needs no scope. The
 * auth guard counts one call of the buyer's plan for a key and none for a
 * session.
 *
 * Everything else is services/paidUse.ts: the order of one paid use, what a
 * buyer is told and what they are never told. This file turns its results
 * into HTTP and adds nothing to them.
 *
 * A stream is forwarded with streamToReply, which settles the charge only
 * when the answer reached the caller and refunds it otherwise. The answer
 * was complete and checked before the first byte: a "stream" here is the
 * whole answer in the public encoding, not word by word.
 *
 * Every paid answer says in its headers what its body's `billing` says
 * (services/usageHeaders.ts), set before the body for the whole answer and
 * the stream alike. They are written from that one object: nothing is read
 * or counted for a header.
 */

import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";

import { TASK_MAX_BODY_BYTES, TASK_MESSAGES, TASK_REFUSAL_STATUS } from "../services/agentTask.js";
import { abortOnClientClose } from "../services/chatStreamSettlement.js";
import {
  getUseAccess,
  listPaidResults,
  paidRefusalBody,
  PAID_USE_MESSAGES,
  runPaidChat,
  runPaidTask,
  type PaidCaller,
  type PaidStream,
  type PaidUseDeps,
  type PaidUseRefusal,
} from "../services/paidUse.js";
import { streamToReply } from "../services/sseReply.js";
import { clearUsageHeaders, refusalUsageHeadersOf, setUsageHeaders, usageHeadersOf } from "../services/usageHeaders.js";

/** A chat request is text: 20 messages of 4,000 characters fit several times over. */
export const PAID_CHAT_BODY_LIMIT_BYTES = 64 * 1024;

/** A held answer sends nothing while it is produced; idle proxies are kept open once it starts. */
const STREAM_HEARTBEAT_MS = 15_000;

export interface PaidUseGuards {
  /** Who are you. Paid use is not one of the caller's own API calls (middleware/auth.ts, countsAsApiCall). */
  auth: preHandlerAsyncHookHandler;
  /** An API key must have been granted agents:use by name; a session is not scoped. */
  use: preHandlerAsyncHookHandler;
}

export interface PaidUseRouteDeps {
  guards: PaidUseGuards;
  /** Built on first use, so registering the routes opens no connection. */
  paidUse: () => PaidUseDeps;
}

const CLIENT_GONE: PaidUseRefusal = {
  status: 499,
  code: "client_closed_request",
  message: PAID_USE_MESSAGES.cancelled,
};

export function sendPaidRefusal(reply: FastifyReply, refusal: PaidUseRefusal): FastifyReply {
  // Only a plan that is used up has any: the plan's count, with nothing remaining.
  setUsageHeaders(reply, refusalUsageHeadersOf(refusal));
  if (refusal.retryAfterSeconds !== undefined) reply.header("retry-after", String(refusal.retryAfterSeconds));
  // A refusal is about this request, now: nothing may replay it later.
  reply.header("cache-control", "no-store");
  return reply.status(refusal.status).send(paidRefusalBody(refusal));
}

function callerOf(request: FastifyRequest): PaidCaller {
  const auth = request.auth!;
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    type: auth.type,
    apiKeyId: auth.apiKeyId ?? null,
    scopes: auth.scopes ?? [],
  };
}

async function sendPaidStream(reply: FastifyReply, result: PaidStream, abort: AbortController): Promise<FastifyReply | void> {
  const sent = await streamToReply(reply, result.chat, {
    meter: result.meter,
    abort,
    heartbeatMs: STREAM_HEARTBEAT_MS,
  });
  if (!sent.started) {
    // The caller was gone before the first byte; streamToReply refunded.
    await result.finished({ ok: false, error: "client disconnected", toolCalls: [], code: "client_gone" });
    // No answer went out, so nothing says what one cost.
    clearUsageHeaders(reply);
    return sendPaidRefusal(reply, CLIENT_GONE);
  }
  await result.finished(sent.outcome);
}

export function createPaidUseRoutes(deps: PaidUseRouteDeps): FastifyPluginAsync {
  let paidUse: PaidUseDeps | null = null;
  const core = () => (paidUse ??= deps.paidUse());
  const { auth, use } = deps.guards;

  return async (app) => {
    // A body over the limit is refused by the parser before the handler
    // runs. For a run that is "your answers are too long". Anything else
    // goes on to the handler this plugin inherited.
    app.setErrorHandler((error: FastifyError, request, reply) => {
      if (error.statusCode !== 413) throw error;
      reply.header("cache-control", "no-store");
      if (request.url.split("?")[0]!.endsWith("/run")) {
        return reply
          .status(TASK_REFUSAL_STATUS.input_too_large)
          .send({ error: "input_too_large", message: TASK_MESSAGES.inputTooLarge });
      }
      return reply.status(413).send({ error: "invalid_request", message: "The request is too large." });
    });

    app.get<{ Params: { handle: string } }>(
      "/a/:handle/access",
      { preHandler: [auth], schema: { tags: ["Paid use"], description: "What the caller may do with a paid agent" } },
      async (request, reply) => {
        const result = await getUseAccess({ caller: callerOf(request), handle: request.params.handle }, core());
        if (result.kind === "refused") return sendPaidRefusal(reply, result.refusal);
        reply.header("cache-control", "no-store");
        return reply.status(200).send(result.view);
      },
    );

    app.post<{ Params: { handle: string } }>(
      "/a/:handle/chat",
      {
        preHandler: [auth, use],
        bodyLimit: PAID_CHAT_BODY_LIMIT_BYTES,
        schema: { tags: ["Paid use"], description: "Send one paid message to an agent" },
      },
      async (request, reply) => {
        // Wired before the first await: a caller who leaves stops the run,
        // and whatever was charged goes back.
        const abort = abortOnClientClose(reply.raw);
        const result = await runPaidChat(
          { caller: callerOf(request), handle: request.params.handle, body: request.body, signal: abort.signal },
          core(),
        );
        if (result.kind === "refused") return sendPaidRefusal(reply, result.refusal);
        reply.header("cache-control", "no-store");
        setUsageHeaders(reply, usageHeadersOf(result.billing));
        if (result.kind === "stream") return sendPaidStream(reply, result, abort);
        return reply
          .status(200)
          .send({ message: result.message, toolCalls: result.toolCalls, billing: result.billing });
      },
    );

    app.post<{ Params: { handle: string } }>(
      "/a/:handle/run",
      {
        preHandler: [auth, use],
        bodyLimit: TASK_MAX_BODY_BYTES,
        schema: { tags: ["Paid use"], description: "Run a paid task agent on one filled-in form" },
      },
      async (request, reply) => {
        const abort = abortOnClientClose(reply.raw);
        const result = await runPaidTask(
          { caller: callerOf(request), handle: request.params.handle, body: request.body, signal: abort.signal },
          core(),
        );
        if (result.kind === "refused") return sendPaidRefusal(reply, result.refusal);
        reply.header("cache-control", "no-store");
        setUsageHeaders(reply, usageHeadersOf(result.billing));
        if (result.kind === "stream") return sendPaidStream(reply, result, abort);
        return reply.status(200).send({ output: result.output, toolCalls: result.toolCalls, billing: result.billing });
      },
    );

    app.get<{ Params: { handle: string } }>(
      "/a/:handle/results",
      { preHandler: [auth], schema: { tags: ["Paid use"], description: "A self-running agent's results, for a subscriber" } },
      async (request, reply) => {
        const result = await listPaidResults({ caller: callerOf(request), handle: request.params.handle }, core());
        if (result.kind === "refused") return sendPaidRefusal(reply, result.refusal);
        reply.header("cache-control", "no-store");
        return reply.status(200).send({ results: result.results, hasMore: result.hasMore });
      },
    );
  };
}
