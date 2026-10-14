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
 *
 * The x402 door (services/paidUseX402.ts): while it is open, a POST to chat
 * or run that carries NO credential at all (no Authorization header, even
 * an empty one, and no session cookie) passes the two guards
 * (`anonymousDoor`) and is answered by the door: a 402 with
 * PAYMENT-REQUIRED, or one use paid from a wallet, released with
 * PAYMENT-RESPONSE once the chain confirms it. A handle the door does not
 * serve gets today's 401, byte for byte, with nothing counted and no header
 * set. A request with any credential, valid or not, takes today's path and
 * its PAYMENT-SIGNATURE is ignored; GET access and results keep their
 * guards; the door closed, every address is what it was.
 */

import type {
  FastifyError,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";

import { presentsNoCredential, replyAuthenticationRequired } from "../middleware/auth.js";
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
import { runX402Use, type X402UseDeps, type X402UseKind } from "../services/paidUseX402.js";
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
  /**
   * The x402 door: true lets a POST to chat or run past `auth` and `use`
   * with `request.auth` null, for the door to answer. Production:
   * x402DoorApplies with x402DoorOpen (no credential at all, the door open).
   * Left out, or false, the two guards run as they always did.
   */
  anonymousDoor?: (request: FastifyRequest) => boolean;
}

/** The x402 door as a route takes it (services/buildPaidUseX402Deps.ts, productionX402Door). */
export interface PaidUseX402Door {
  /** The door's deps, built on first use. */
  use(): X402UseDeps;
  /** The use address as the published format names it. Throws when there is none. */
  resourceUrl(path: string): string;
  /** A caller's address bucket: never a raw address. */
  bucketOf(ip: string | undefined): string;
}

export interface PaidUseRouteDeps {
  guards: PaidUseGuards;
  /** Built on first use, so registering the routes opens no connection. */
  paidUse: () => PaidUseDeps;
  /** The x402 door. Left out, or null, a request the door let through gets today's 401. */
  x402?: () => PaidUseX402Door | null;
}

/** One call at the door, built from the request before the door judges it. */
export interface X402DoorCall {
  /** The door's deps, with the claim watched. */
  deps: X402UseDeps;
  resourceUrl: string;
  bucket: string;
  arrivedAt: Date;
  /** Fires when the caller leaves, once the door serves the listing. */
  gone: AbortController;
  /** The door serves the listing: only now is the caller's leaving watched. */
  onServed(): void;
  /**
   * Whether the use reached its claim (step 10). A refusal from then on must
   * not be sent again by itself: the same payment would only be refused as
   * presented twice.
   */
  claimed(): boolean;
}

/**
 * What a call at the door needs, or null when the door cannot take it: no
 * door, a credential that was sent, or a door that cannot be built. The
 * route then answers its own 401 as it always did. Nothing here sets a
 * header or watches the connection.
 */
export function x402DoorCallOf(
  request: FastifyRequest,
  reply: FastifyReply,
  door: (() => PaidUseX402Door | null) | undefined,
): X402DoorCall | null {
  if (!presentsNoCredential(request)) return null;
  let binding: PaidUseX402Door | null;
  let deps: X402UseDeps;
  let resourceUrl: string;
  let bucket: string;
  try {
    binding = door?.() ?? null;
    if (!binding) return null;
    deps = binding.use();
    resourceUrl = binding.resourceUrl(request.url.split("?")[0]!);
    bucket = binding.bucketOf(request.ip);
  } catch (err) {
    request.log.error({ err }, "x402 door could not be built; answered as a call with no credential");
    return null;
  }
  let claimed = false;
  const payments = deps.payments;
  const gone = new AbortController();
  return {
    deps: {
      ...deps,
      payments: {
        ...payments,
        insertHeld: (row) => {
          claimed = true;
          return payments.insertHeld(row);
        },
      },
    },
    resourceUrl,
    bucket,
    // On the door's own clock, which every bound of the use is measured on.
    arrivedAt: deps.now(),
    gone,
    onServed: () => {
      const watched = abortOnClientClose(reply.raw);
      if (watched.signal.aborted) gone.abort();
      else watched.signal.addEventListener("abort", () => gone.abort(), { once: true });
    },
    claimed: () => claimed,
  };
}

/** The door's headers (PAYMENT-REQUIRED or PAYMENT-RESPONSE), set before the first byte. */
export function setX402Headers(reply: FastifyReply, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
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

/**
 * One use of an agent at the x402 door, for a request that reached a paid
 * handler with no credential. Anything the door does not serve is today's
 * 401, before any header is set or the connection watched.
 */
async function useAtDoor(
  request: FastifyRequest<{ Params: { handle: string } }>,
  reply: FastifyReply,
  kind: X402UseKind,
  door: (() => PaidUseX402Door | null) | undefined,
): Promise<FastifyReply | void> {
  const call = x402DoorCallOf(request, reply, door);
  if (!call) return replyAuthenticationRequired(reply);
  const result = await runX402Use(
    {
      kind,
      handle: request.params.handle,
      body: request.body,
      headers: request.headers,
      bucket: call.bucket,
      arrivedAt: call.arrivedAt,
      resourceUrl: call.resourceUrl,
      signal: call.gone.signal,
      onServed: call.onServed,
    },
    call.deps,
  );
  // No route check of the body is handed in here, so the core never refuses
  // one for the route: both are a handle the door does not serve.
  if (result.kind === "not_served" || result.kind === "body_refused") return replyAuthenticationRequired(reply);
  if (result.kind === "refusal") {
    setX402Headers(reply, result.headers);
    return sendPaidRefusal(reply, result.refusal);
  }

  // Paid and confirmed: what was paid rides in the headers, set before the body.
  reply.header("cache-control", "no-store");
  setX402Headers(reply, result.headers);
  setUsageHeaders(reply, usageHeadersOf(result.billing));
  if (result.stream) {
    // The whole checked answer replayed; nothing to settle, it is paid.
    const sent = await streamToReply(reply, result.stream, { meter: null, abort: call.gone, heartbeatMs: STREAM_HEARTBEAT_MS });
    if (!sent.started) {
      // The payment went through and its sale is written; the caller left
      // between the two. Nothing reads this answer.
      request.log.error({ handle: request.params.handle }, "x402 door: a paid answer was not delivered; the caller left after the sale");
      return reply.status(499).send();
    }
    return;
  }
  if (call.gone.signal.aborted) {
    // As above: paid and written, and the caller is gone before the answer.
    request.log.error({ handle: request.params.handle }, "x402 door: a paid answer was not delivered; the caller left after the sale");
  }
  if (kind === "chat") {
    return reply
      .status(200)
      .send({ message: { role: "assistant", content: result.text }, toolCalls: result.toolCalls, billing: result.billing });
  }
  return reply
    .status(200)
    .send({ output: { format: "text", text: result.text }, toolCalls: result.toolCalls, billing: result.billing });
}

export function createPaidUseRoutes(deps: PaidUseRouteDeps): FastifyPluginAsync {
  let paidUse: PaidUseDeps | null = null;
  const core = () => (paidUse ??= deps.paidUse());
  const { auth, use, anonymousDoor } = deps.guards;
  // The two guards of a paid POST, opened only for a request the door takes.
  const orDoor = (guard: preHandlerAsyncHookHandler): preHandlerAsyncHookHandler => {
    if (!anonymousDoor) return guard;
    return async function (this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
      if (anonymousDoor(request) === true) return;
      return guard.call(this, request, reply);
    };
  };
  const payGuards = [orDoor(auth), orDoor(use)];

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
        preHandler: payGuards,
        bodyLimit: PAID_CHAT_BODY_LIMIT_BYTES,
        schema: { tags: ["Paid use"], description: "Send one paid message to an agent" },
      },
      async (request, reply) => {
        // No credential got this far: only the door lets one through.
        if (!request.auth) return useAtDoor(request, reply, "chat", deps.x402);
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
        preHandler: payGuards,
        bodyLimit: TASK_MAX_BODY_BYTES,
        schema: { tags: ["Paid use"], description: "Run a paid task agent on one filled-in form" },
      },
      async (request, reply) => {
        if (!request.auth) return useAtDoor(request, reply, "run", deps.x402);
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
