import type { FastifyPluginAsync, FastifyRequest, FastifyReply, preHandlerHookHandler } from "fastify";

import {
  createOpenAiAuth,
  openAiErrorHandler,
  sendOpenAiError,
} from "../middleware/openaiAuth.js";
import {
  createOpenAiStreamAdapter,
  newCompletionId,
  openAiError,
  parseChatCompletionRequest,
  type CompletionMeta,
  type NormalizedMessage,
  type OpenAiErrorResponse,
} from "../services/openaiCompat.js";
import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";
import { Prisma, prisma } from "@wheelsai/db";
import { PRICING_TIERS, calculateTokenCost } from "@wheelsai/shared";
import { abortOnClientClose, CLIENT_GONE } from "../services/chatStreamSettlement.js";
import { getPricePerSecond } from "../services/computeMetering.js";
import { gpuBillingBlock, selectNode, type NodeInfo } from "../services/hostedModel.js";
import { passthroughStream, type Deadline } from "../services/mastra-runtime.js";
import { isAllowedNodeUrl } from "../services/nodeUrlAllowlist.js";
import { isGpuBilledDeployment } from "../services/nosanaIds.js";
import { nodeUrlAllowlistOptions, servedModelName } from "../services/nosana.js";
import { streamToReply } from "../services/sseReply.js";
import {
  DEFAULT_COMPLETION_TOKENS,
  MAX_COMPLETION_TOKENS,
  PROMPT_ESTIMATE_MARGIN,
  holdInferenceCredits,
  releaseInferenceHold,
  settleInferenceHold,
  type InferenceHoldPrisma,
} from "../services/inferenceCreditHold.js";
import {
  create402Response,
  createPaymentRequestId,
  estimatePrice,
  generatePaymentRequirement,
  getPaymentFromHeaders,
  hasPaymentHeader,
  parsePaymentHeader,
  verifyPayment,
  type PaymentRequirement,
} from "../services/x402.js";

const logger = createLogger("inference-routes");

// ============================================
// Types
// ============================================

/**
 * "credits" / "x402": per-request billing. "gpu_included": the deployment is
 * billed per GPU-second by the GPU billing worker (services/gpuBilling.ts), so
 * the request itself is free of a per-token hold / charge and of x402.
 */
type BillingMode = "credits" | "x402" | "gpu_included";

interface BillingResolution {
  mode: BillingMode;
  requestId: string;
  x402PaymentId?: string;
}

interface InferenceRouteDeps {
  verifyPaymentFn?: typeof verifyPayment;
  /** The /v1 guard; defaults to createOpenAiAuth(). */
  auth?: preHandlerHookHandler;
  /** Keep-alive comment interval on a stream; 0 turns it off. */
  heartbeatMs?: number;
}

/** What billing needs to know about a request before the node is called. */
interface BillableRequest {
  messages: NormalizedMessage[];
  /** Always set: the completion cap the node is given. */
  max_tokens: number;
}

interface NodeUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

/**
 * Conversations with tool results in them are larger than Fastify's 1 MiB
 * default allows; the message cap in openaiCompat bounds what is accepted.
 * (Same value as V1_BODY_LIMIT_BYTES in routes/agentCompletions.ts, which
 * imports nothing from here.)
 */
const DEPLOYMENT_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

/** Keeps an idle proxy from cutting a stream while the model is thinking. */
const STREAM_HEARTBEAT_MS = 15_000;

// ============================================
// Node errors
// ============================================

const NODE_ERROR_MESSAGE_CHARS = 500;

/**
 * The human-readable part of an inference server's error body: vLLM answers
 * `{ object: "error", message }`, OpenAI-style servers `{ error: { message } }`
 * and Ollama `{ error: "…" }`. Bounded, and null when there is none.
 */
export function nodeErrorMessage(body: string): string | null {
  let text: unknown = null;
  try {
    const json = JSON.parse(body) as Record<string, unknown> | null;
    if (json && typeof json === "object") {
      const error = json.error;
      text =
        typeof json.message === "string"
          ? json.message
          : typeof error === "string"
            ? error
            : typeof (error as { message?: unknown } | null)?.message === "string"
              ? (error as { message: string }).message
              : typeof json.detail === "string"
                ? json.detail
                : null;
    }
  } catch {
    // Not JSON (a proxy's HTML page): nothing worth relaying.
  }
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > NODE_ERROR_MESSAGE_CHARS
    ? `${trimmed.slice(0, NODE_ERROR_MESSAGE_CHARS)}…`
    : trimmed;
}

/**
 * What the caller is told when the inference node answered with an error
 * status. The status is passed through, in OpenAI's error shape, so a client
 * can tell its own mistake (a 400 for a `tools` request the model server
 * cannot parse) from an outage (a 5xx it may retry).
 *
 * Three statuses are NOT passed through, because of what an OpenAI SDK does
 * with them on this API: 401 and 403 would read as "your WheelsAI key is
 * wrong", and 404 as "no such deployment", when the deployment was found and
 * the key accepted - the node refusing us is a fault on our side of the
 * proxy, so those answer 502.
 *
 * A 4xx carries the model server's own message: it describes the caller's
 * request to the caller's own deployment. A 5xx does not.
 */
export function nodeStatusError(
  status: number,
  nodeMessage: string | null,
  retryAfterSeconds: number | null,
): OpenAiErrorResponse {
  if (status === 401 || status === 403) {
    return openAiError("provider_auth_failed", {
      message: `The inference node refused the request (status ${status}).`,
    });
  }
  if (status === 404) {
    return openAiError("provider_model_not_found", {
      message: "The inference node does not serve this deployment's model.",
    });
  }
  if (status === 408 || status === 504) {
    return { ...openAiError("upstream_timeout", { message: "The inference node timed out." }), status };
  }
  if (status === 429) {
    return openAiError("provider_rate_limited", {
      message: "The inference node is at capacity. Retry shortly.",
      ...(retryAfterSeconds !== null && { retryAfterSeconds }),
    });
  }
  if (status >= 400 && status < 500) {
    return {
      ...openAiError("provider_rejected_request", {
        message: nodeMessage
          ? `The model server rejected the request: ${nodeMessage}`
          : `The model server rejected the request (status ${status}).`,
      }),
      status,
    };
  }
  const passed = status >= 500 && status <= 599 ? status : 502;
  return {
    ...openAiError(passed === 503 ? "service_unavailable" : "upstream_error", {
      message: `The inference node answered ${status}.`,
    }),
    status: passed,
  };
}

function retryAfterOf(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

// ============================================
// Node call deadline
// ============================================

interface NodeDeadline extends Deadline {
  signal: AbortSignal;
  /** Restarts the clock: called for every chunk a stream delivers. */
  touch(): void;
}

/**
 * INFERENCE_TIMEOUT_MS as a limit on SILENCE, kept alive until the body has
 * been read. It used to be cleared when the response headers arrived, which
 * left the body read with no limit at all; as a wall-clock limit it would cut
 * every long streamed answer. So: the node has this long to answer, and a
 * stream has this long between chunks. The client going away aborts too.
 */
function startNodeDeadline(idleMs: number, client: AbortSignal): NodeDeadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error("inference node timed out")), idleMs);
  };
  arm();
  return {
    signal: AbortSignal.any([client, controller.signal]),
    expired: () => controller.signal.aborted,
    touch: arm,
    clear: () => clearTimeout(timer),
  };
}

// ============================================
// Deployment completion
// ============================================

/** A deployment of the caller's organization, named by slug or by id. */
export type DeploymentTarget = { deploymentSlug: string } | { deploymentId: string };

export type DeploymentCompletionHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
  target: DeploymentTarget,
) => Promise<unknown>;

/**
 * One chat completion against a model deployment of the caller's own
 * organization, in OpenAI's wire format: request (tools and tool_choice
 * included), response, SSE stream and errors.
 *
 * Shared by POST /v1/:deploymentSlug/chat/completions, the unified POST
 * /v1/chat/completions (routes/openaiV1.ts) and the dashboard's deployment
 * playground (routes/deployments.ts), so a deployment is admitted and billed
 * identically whichever URL named it.
 */
export function createDeploymentCompletionHandler(
  deps: InferenceRouteDeps = {},
): DeploymentCompletionHandler {
  const verifyPaymentFn = deps.verifyPaymentFn ?? verifyPayment;
  const heartbeatMs = deps.heartbeatMs ?? STREAM_HEARTBEAT_MS;

  return async (request, reply, target) => {
    // Wired before the first await: a client that leaves stops the node call.
    const abort = abortOnClientClose(reply.raw);

    const refuse = (
      code: Parameters<typeof openAiError>[0],
      detail: Parameters<typeof openAiError>[1] = {},
      status?: number,
    ) => {
      const error = openAiError(code, detail);
      return sendOpenAiError(reply, status === undefined ? error : { ...error, status });
    };

    const parsed = parseChatCompletionRequest(request.body);
    if (!parsed.ok) return sendOpenAiError(reply, parsed.error);
    const chat = parsed.request;

    // Every request carries an explicit completion cap, forwarded to the
    // node, so credits holds and x402 quotes price the same bounded work.
    const maxTokens = chat.params.max_tokens ?? DEFAULT_COMPLETION_TOKENS;
    if (maxTokens > MAX_COMPLETION_TOKENS) {
      return refuse("validation_failed", {
        param: "max_tokens",
        message: `max_tokens: a model deployment generates at most ${MAX_COMPLETION_TOKENS} tokens per request.`,
      });
    }
    const billable: BillableRequest = { messages: chat.messages, max_tokens: maxTokens };
    const { orgId } = request.auth!;

    // 1. Find deployment
    const deployment = await prisma.deployment.findFirst({
      where: {
        ...("deploymentSlug" in target ? { slug: target.deploymentSlug } : { id: target.deploymentId }),
        orgId,
        status: "running",
      },
      include: {
        nodes: {
          where: {
            healthStatus: "healthy",
          },
        },
        model: true,
      },
    });

    if (!deployment) {
      return refuse("model_not_found", {
        message:
          "deploymentSlug" in target
            ? `No running model deployment has the slug '${target.deploymentSlug}'. GET /v1/models lists what this key can call; agents are named 'agent/<slug>'.`
            : "This deployment does not exist or is not running.",
      });
    }

    // 2. Resolve billing mode.
    //
    // A deployment with a real Nosana id is billed per GPU-second by the GPU
    // billing worker (price(tier) x replicas x seconds, ledger `gpu_usage`):
    // that is what the org pays for dedicated hardware. Taking a per-token
    // hold/charge or an x402 payment here as well would bill the same GPU
    // twice, so such requests are admitted on the checks that remain - the
    // deployment is running (queried above), a healthy node exists (below) and
    // the plan's API-call metering (the /v1 guard -> meterApiCall). A
    // deployment the worker does NOT bill (the dev-only mock) keeps
    // per-request billing.
    const gpuBilled = isGpuBilledDeployment(deployment);
    // "Included in the GPU bill" is only true while the GPU is being billed:
    // the worker is on, and it is collecting for this deployment
    // (services/hostedModel.ts, shared with agents on hosted models).
    const blocked = gpuBilled ? await gpuBillingBlock(deployment, orgId) : null;
    if (blocked) return refuse(blocked.code, { message: blocked.message, extra: blocked.extra });
    let billingResolution: BillingResolution | null;
    if (gpuBilled) {
      billingResolution = {
        mode: "gpu_included",
        requestId: getOrCreateRequestId(request.headers),
      };
    } else {
      // Credits or X402
      const creditBalance = await prisma.creditBalance.findUnique({
        where: { orgId },
      });

      billingResolution = await resolveBilling({
        request,
        reply,
        orgId,
        deploymentId: deployment.id,
        modelTier: deployment.model.pricingTier as keyof typeof PRICING_TIERS,
        body: billable,
        creditBalanceCents: creditBalance?.balanceCents ?? null,
        verifyPaymentFn,
      });
    }

    if (!billingResolution) {
      return;
    }
    const billing = billingResolution;

    reply.header("X-Request-Id", billing.requestId);

    // Credits mode: hold the worst-case cost BEFORE any GPU work.
    const pricingTier = deployment.model.pricingTier as keyof typeof PRICING_TIERS;
    const holdDescription = `Inference: ${deployment.name}`;
    let heldCents = 0n;
    if (billing.mode === "credits") {
      const holdCents = BigInt(
        calculateTokenCost(
          Math.ceil(estimatePromptTokens(billable.messages) * PROMPT_ESTIMATE_MARGIN),
          billable.max_tokens,
          pricingTier,
        ),
      );
      const held = await prisma.$transaction((tx) =>
        holdInferenceCredits(tx as unknown as InferenceHoldPrisma, {
          orgId,
          holdCents,
          requestId: billing.requestId,
          description: holdDescription,
        }),
      );
      if (!held.ok) {
        return refuse("insufficient_credits", {
          message: "Insufficient credits for this request. Please add more credits to continue.",
          extra: { requiredCents: Number(held.requiredCents) },
        });
      }
      heldCents = held.heldCents;
    }

    // Exactly one of `abandon` and `charge` runs for a request that got this
    // far, and only its first call does anything: the hold is released or
    // settled once, never both and never twice.
    const startTime = Date.now();
    let closed = false;

    /** Nothing was produced: the hold goes back and an x402 payment is failed. */
    const abandon = async (reason: string, options: { countError?: boolean } = {}) => {
      if (closed) return;
      closed = true;
      if (heldCents > 0n) {
        await prisma
          .$transaction((tx) =>
            releaseInferenceHold(tx as unknown as InferenceHoldPrisma, {
              orgId,
              heldCents,
              requestId: billing.requestId,
              reason,
            }),
          )
          .catch((err) => logger.error({ err, orgId, heldCents }, "Failed to release inference hold"));
      }
      if (billing.x402PaymentId) await markX402PaymentFailed(billing.x402PaymentId, reason);
      if (options.countError) {
        recordUsage(orgId, deployment.id, null, Date.now() - startTime, 0, deployment.gpuTier, true).catch(
          (err) => logger.error({ err }, "Failed to record usage"),
        );
      }
    };

    /**
     * An answer was produced. `reported` is the node's own token count; when
     * the node sent none, a per-request charge is priced on an estimate of
     * what was generated (the hold already bounds it) rather than on zero,
     * which would make the request free.
     */
    const charge = async (reported: NodeUsage | null, generatedChars: number) => {
      if (closed) return;
      closed = true;
      const latencyMs = Date.now() - startTime;
      const priced: NodeUsage = reported ?? {
        prompt_tokens: estimatePromptTokens(billable.messages),
        completion_tokens: Math.ceil(generatedChars / 4),
      };

      // What the ORG is charged for this request. Zero for a GPU-billed
      // deployment: the GPU seconds are billed by the worker, not per token.
      const costCents =
        billing.mode === "gpu_included"
          ? 0
          : calculateTokenCost(priced.prompt_tokens, priced.completion_tokens, pricingTier);
      if (!reported && billing.mode !== "gpu_included") {
        logger.warn(
          { orgId, requestId: billing.requestId, deploymentId: deployment.id },
          "Inference node reported no usage; charged on an estimate of the generated text",
        );
      }

      if (billing.mode === "credits") {
        const settled = await prisma.$transaction((tx) =>
          settleInferenceHold(tx as unknown as InferenceHoldPrisma, {
            orgId,
            heldCents,
            actualCents: BigInt(costCents),
            requestId: billing.requestId,
            description: holdDescription,
          }),
        );
        if (settled.shortfallCents > 0n) {
          logger.warn(
            { orgId, requestId: billing.requestId, shortfallCents: Number(settled.shortfallCents) },
            "Inference usage exceeded the hold and the balance; charged the hold only",
          );
        }
      } else if (billing.x402PaymentId) {
        // A5: "settled" means CONFIRMED ON-CHAIN, and only the settlement
        // worker may say so. The route has merely verified the payment's
        // signature/shape, so it records "verified"; the worker owns the
        // verified -> settled transition after broadcast + confirmation.
        await prisma.x402Payment.update({
          where: { id: billing.x402PaymentId },
          data: {
            status: "verified",
            verifiedAt: new Date(),
          },
        });
      }

      // Record usage metrics (async, non-blocking). Compute metering uses the
      // real Nosana tier price-per-second so actualCostCents reflects measured
      // GPU time, not an estimated split. Only REPORTED tokens are added to
      // the usage rollup; an estimate is a billing basis, not a measurement.
      recordUsage(orgId, deployment.id, reported, latencyMs, costCents, deployment.gpuTier, false).catch(
        (err) => logger.error({ err }, "Failed to record usage"),
      );
    };

    // 3. Select healthy node
    const node = selectNode(deployment.nodes as NodeInfo[]);
    if (!node) {
      await abandon("No healthy nodes available for this deployment");
      return refuse("service_unavailable", {
        message: "No healthy nodes available for this deployment",
      });
    }

    // 4. Proxy request to node
    //
    // The engine only answers to the name it was started with (the model's
    // HF id on vLLM, the pulled tag on Ollama). Callers send whatever names
    // the deployment to THEM - its slug, as /v1/models lists it - so the
    // name is rewritten here rather than forwarded for the engine to 404.
    const hasTools = chat.tools.length > 0;
    const { parallel_tool_calls: parallelToolCalls, ...sampling } = chat.params;
    const nodeBody: Record<string, unknown> = {
      ...sampling,
      max_tokens: maxTokens,
      model: servedModelName(deployment.engine, deployment.model.hfId),
      messages: chat.messages,
      stream: chat.stream,
      // Always asked for, whatever the caller wants to SEE: a per-request
      // charge is settled on the node's own token count. The adapter below
      // forwards the usage chunk only to a caller that asked.
      ...(chat.stream && { stream_options: { include_usage: true } }),
      ...(hasTools && {
        tools: chat.tools,
        ...(chat.toolChoice !== null && { tool_choice: chat.toolChoice }),
        ...(parallelToolCalls !== undefined && { parallel_tool_calls: parallelToolCalls }),
      }),
    };

    const deadline = startNodeDeadline(env.INFERENCE_TIMEOUT_MS, abort.signal);
    let response: Response;
    try {
      response = await proxyToNode(node.nodeUrl, nodeBody, deadline.signal);
    } catch (error: any) {
      deadline.clear();
      if (abort.signal.aborted) {
        await abandon(CLIENT_GONE);
        return refuse("client_closed_request");
      }
      logger.error({ error, nodeUrl: node.nodeUrl }, "Node request failed");

      // Mark node as unhealthy. Best effort: a failure here must not skip the
      // release of the hold just below.
      await prisma.deploymentNode
        .update({
          where: { id: node.id },
          data: { healthStatus: "unhealthy" },
        })
        .catch((err) => logger.error({ err, nodeId: node.id }, "Failed to mark node unhealthy"));

      await abandon(
        deadline.expired() ? "inference node timed out" : "inference node unreachable",
        { countError: true },
      );
      return deadline.expired()
        ? refuse("upstream_timeout", { message: "The inference node did not answer in time." })
        : refuse("upstream_error", { message: "Failed to reach inference node" }, 502);
    }

    // The node answered, but not with a completion. Nothing is charged for
    // it; the caller gets the node's status in OpenAI's error shape. The node
    // is NOT marked unhealthy: it is up and answering, and a 400 for one
    // caller's request must not take it away from everyone else.
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      deadline.clear();
      logger.error(
        { nodeUrl: node.nodeUrl, status: response.status, body: text.slice(0, 2_000) },
        "Node returned non-OK for /v1 chat completion",
      );
      await abandon(`Inference node responded ${response.status}`, { countError: true });
      return sendOpenAiError(
        reply,
        nodeStatusError(response.status, nodeErrorMessage(text), retryAfterOf(response)),
      );
    }

    const meta: CompletionMeta = {
      id: newCompletionId(),
      created: Math.floor(startTime / 1000),
      // What /v1/models calls this deployment, not the engine's own name.
      model: deployment.slug,
    };

    // 5a. Streamed: the node's SSE is piped to the client as it arrives.
    if (chat.stream) {
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.body || !contentType.includes("text/event-stream")) {
        await response.body?.cancel().catch(() => {});
        deadline.clear();
        logger.error(
          { nodeUrl: node.nodeUrl, contentType },
          "Node did not answer a streaming request with an event stream",
        );
        await abandon("inference node did not stream", { countError: true });
        return refuse("upstream_error", {
          message: "The inference node did not answer the streaming request with a stream.",
        });
      }

      const watched = passthroughStream(
        response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              deadline.touch();
              controller.enqueue(chunk);
            },
          }),
        ),
        abort.signal,
        deadline,
      );

      // No meter: forwardAndSettle's settle-or-refund follows DELIVERY, which
      // is the right rule for a marketplace charge and the wrong one for GPU
      // work billed per token (below).
      const sent = await streamToReply(reply, watched, {
        meter: null,
        abort,
        heartbeatMs,
        transform: (upstream) =>
          createOpenAiStreamAdapter(upstream, { ...meta, includeUsage: chat.includeUsage }),
      });
      deadline.clear();

      // Billing follows what the node GENERATED, read from the node's own
      // stream rather than from what reached the socket:
      //   - a finished answer is charged on the node's token count;
      //   - an answer the caller hung up on is charged for the part generated
      //     until then (an estimate: the node's count comes with its last
      //     chunk). Refunding it would make every answer free to a client
      //     that disconnects before the final byte;
      //   - a stream the NODE failed (error event, cut off, silent, empty) is
      //     not charged at all.
      const generated = await watched.outcome;
      const progress = watched.progress();
      const reported: NodeUsage | null = progress.usage
        ? { prompt_tokens: progress.usage.inputTokens, completion_tokens: progress.usage.outputTokens }
        : null;
      const callerLeft = !generated.ok && generated.code === "client_gone";
      if (generated.ok || (callerLeft && progress.contentChars > 0)) {
        await charge(reported, progress.contentChars);
      } else {
        if (!callerLeft) {
          logger.warn(
            { nodeUrl: node.nodeUrl, deploymentId: deployment.id, reason: generated.error },
            "Streamed /v1 deployment completion produced no answer",
          );
        }
        // A stream that failed is not a node that is down: health is the
        // status worker's call, from /health.
        await abandon(generated.error, { countError: !callerLeft });
      }
      if (!sent.started) return refuse("client_closed_request");
      return;
    }

    // 5b. Not streamed: one JSON body, read under the same deadline.
    let responseBody: any;
    try {
      responseBody = await response.json();
    } catch (error) {
      deadline.clear();
      if (abort.signal.aborted) {
        await abandon(CLIENT_GONE);
        return refuse("client_closed_request");
      }
      logger.error({ error, nodeUrl: node.nodeUrl }, "Node answered 200 with a body that is not JSON");
      await abandon("inference node answered with an unreadable body", { countError: true });
      return deadline.expired()
        ? refuse("upstream_timeout", { message: "The inference node did not finish answering in time." })
        : refuse("upstream_error", { message: "The inference node answered with a body that is not a completion." });
    }
    deadline.clear();

    if (typeof responseBody !== "object" || responseBody === null || !Array.isArray(responseBody.choices)) {
      logger.error({ nodeUrl: node.nodeUrl }, "Node answered 200 without choices");
      await abandon("inference node answered without a completion", { countError: true });
      return refuse("upstream_error", {
        message: "The inference node answered with a body that is not a completion.",
      });
    }

    const reported: NodeUsage | null =
      typeof responseBody.usage?.prompt_tokens === "number"
        ? {
            prompt_tokens: responseBody.usage.prompt_tokens,
            completion_tokens:
              typeof responseBody.usage.completion_tokens === "number"
                ? responseBody.usage.completion_tokens
                : 0,
          }
        : null;
    await charge(reported, completionChars(responseBody.choices));

    return { ...responseBody, model: deployment.slug };
  };
}

/** Characters of generated text and tool-call arguments in a completion. */
function completionChars(choices: unknown[]): number {
  let chars = 0;
  for (const choice of choices) {
    const message = (choice as { message?: { content?: unknown; tool_calls?: unknown } } | null)?.message;
    if (typeof message?.content === "string") chars += message.content.length;
    if (Array.isArray(message?.tool_calls)) {
      for (const call of message.tool_calls as Array<{ function?: { arguments?: unknown } }>) {
        if (typeof call?.function?.arguments === "string") chars += call.function.arguments.length;
      }
    }
  }
  return chars;
}

// ============================================
// Routes
// ============================================

export function createInferenceRoutes(
  deps: InferenceRouteDeps = {}
): FastifyPluginAsync {
  const complete = createDeploymentCompletionHandler(deps);
  const auth = deps.auth ?? createOpenAiAuth();

  return async (app) => {
  // Zod, body-size and rate-limit failures on this route are answered in
  // OpenAI's shape, like everything else it says.
  app.setErrorHandler(openAiErrorHandler);

  /**
   * OpenAI-compatible chat completions endpoint
   * POST /v1/:deploymentSlug/chat/completions
   *
   * Serves only the CALLER'S OWN deployments (the lookup is org-scoped), so
   * there is no token gate here: the only party it could ever block is the
   * publisher. Buyers of a tokenized listing are gated in
   * services/tokenAccess.ts, on install and on every chat path.
   *
   * GET /v1/models and the unified POST /v1/chat/completions live in
   * routes/openaiV1.ts.
   */
  app.post(
    "/v1/:deploymentSlug/chat/completions",
    {
      preHandler: [auth],
      bodyLimit: DEPLOYMENT_BODY_LIMIT_BYTES,
      schema: {
        tags: ["OpenAI-compatible"],
        description:
          "OpenAI chat completions served by a running model deployment: streaming, tools and tool_choice.",
        security: [{ bearerAuth: [] }],
      },
    },
    async (request, reply) => {
      const { deploymentSlug } = request.params as { deploymentSlug: string };
      return complete(request, reply, { deploymentSlug });
    }
  );
  };
}

export const inferenceRoutes = createInferenceRoutes();

// ============================================
// Billing Resolution
// ============================================

export async function resolveBilling(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  orgId: string;
  deploymentId: string;
  modelTier: keyof typeof PRICING_TIERS;
  body: BillableRequest;
  creditBalanceCents: bigint | null;
  verifyPaymentFn: typeof verifyPayment;
}): Promise<BillingResolution | null> {
  const {
    request,
    reply,
    orgId,
    deploymentId,
    modelTier,
    body,
    creditBalanceCents,
    verifyPaymentFn,
  } = params;
  const minBalance = BigInt(10); // 10 cents minimum
  const hasSufficientCredits =
    creditBalanceCents !== null && creditBalanceCents >= minBalance;
  const requestId = getOrCreateRequestId(request.headers);

  const x402Mode = env.X402_ENABLED ? env.X402_INFERENCE_MODE : "off";
  if (x402Mode === "off") {
    if (!hasSufficientCredits) {
      return replyWithCreditRequired(reply);
    }
    return { mode: "credits", requestId };
  }

  const estimatedInputTokens = estimatePromptTokens(body.messages);
  const estimatedOutputTokens = estimateCompletionTokens(body.max_tokens);
  const quote = estimatePrice(estimatedInputTokens, estimatedOutputTokens, modelTier);
  const requirement = generatePaymentRequirement(
    quote,
    env.X402_DEFAULT_ASSET,
    `deployment:${deploymentId};request:${requestId}`
  );

  if (hasPaymentHeader(request.headers)) {
    const rawHeader = getPaymentFromHeaders(request.headers);
    if (!rawHeader) {
      if (x402Mode === "required" || !hasSufficientCredits) {
        return replyWithX402Required(reply, requirement, requestId, "Missing X-Payment header");
      }
      return { mode: "credits", requestId };
    }

    const parsedHeader = parsePaymentHeader(rawHeader);
    if (!parsedHeader) {
      if (x402Mode === "required" || !hasSufficientCredits) {
        return replyWithX402Required(reply, requirement, requestId, "Invalid X-Payment header format");
      }
      return { mode: "credits", requestId };
    }

    const verification = await verifyPaymentFn(parsedHeader, requirement);

    const persistedPayment = await persistX402Payment({
      orgId,
      deploymentId,
      requestId,
      requirement,
      verification,
    });

    if (persistedPayment.replayDetected) {
      sendOpenAiError(
        reply,
        openAiError("payment_already_used", {
          extra: { paymentId: persistedPayment.payment.id, requestId },
        }),
      );
      return null;
    }

    if (!verification.isValid) {
      if (x402Mode === "required" || !hasSufficientCredits) {
        return replyWithX402Required(
          reply,
          requirement,
          requestId,
          verification.error ?? "Payment verification failed"
        );
      }
      return { mode: "credits", requestId };
    }

    return {
      mode: "x402",
      requestId,
      x402PaymentId: persistedPayment.payment.id,
    };
  }

  if (x402Mode === "required" || !hasSufficientCredits) {
    return replyWithX402Required(reply, requirement, requestId);
  }

  return { mode: "credits", requestId };
}

async function persistX402Payment(params: {
  orgId: string;
  deploymentId: string;
  requestId: string;
  requirement: PaymentRequirement;
  verification: Awaited<ReturnType<typeof verifyPayment>>;
}): Promise<{ payment: { id: string }; replayDetected: boolean }> {
  const { orgId, deploymentId, requestId, requirement, verification } = params;
  const txSignature = verification.txSignature ?? null;

  if (txSignature) {
    const existing = await prisma.x402Payment.findUnique({
      where: { txSignature },
      select: { id: true },
    });
    if (existing) {
      return { payment: existing, replayDetected: true };
    }
  }

  const status = verification.isValid ? "verified" : "failed";
  const data = {
    orgId,
    deploymentId,
    requestId,
    network: requirement.network,
    asset: requirement.asset,
    amountRaw: requirement.amount,
    amountUsd: requirement.amountUsd,
    payerAddress: verification.payer || "unknown",
    payeeAddress: requirement.payTo,
    txSignature,
    status,
    verifiedAt: verification.isValid ? new Date() : null,
    failureReason: verification.isValid ? null : verification.error ?? "Payment verification failed",
  };

  try {
    const payment = await prisma.x402Payment.create({
      data,
      select: { id: true },
    });
    return { payment, replayDetected: false };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      txSignature
    ) {
      const existing = await prisma.x402Payment.findUnique({
        where: { txSignature },
        select: { id: true },
      });
      if (existing) {
        return { payment: existing, replayDetected: true };
      }
    }
    throw error;
  }
}

function replyWithX402Required(
  reply: FastifyReply,
  requirement: PaymentRequirement,
  requestId: string,
  reason?: string
): null {
  const paymentResponse = create402Response(requirement);

  for (const [header, value] of Object.entries(paymentResponse.headers)) {
    reply.header(header, value);
  }
  reply.header("X-Request-Id", requestId);

  // `payment`, `requestId` and `reason` stay at the top level, where x402
  // clients read them; `error` is OpenAI's object so an OpenAI SDK prints the
  // reason instead of "[object Object]".
  const error = openAiError("x402_payment_required", {
    message: reason
      ? `${paymentResponse.body.message}: ${reason}`
      : paymentResponse.body.message,
  });
  for (const [header, value] of Object.entries(error.headers)) reply.header(header, value);
  reply.status(402).send({
    ...error.body,
    payment: paymentResponse.body.payment,
    requestId,
    reason,
  });
  return null;
}

function replyWithCreditRequired(reply: FastifyReply): null {
  sendOpenAiError(
    reply,
    openAiError("insufficient_credits", {
      message: "Insufficient credits. Please add more credits to continue.",
    }),
  );
  return null;
}

async function markX402PaymentFailed(paymentId: string, reason: string): Promise<void> {
  await prisma.x402Payment.update({
    where: { id: paymentId },
    data: {
      status: "failed",
      failureReason: reason,
    },
  });
}

export function getOrCreateRequestId(
  headers: FastifyRequest["headers"]
): string {
  const requestIdHeader = headers["x-request-id"];
  if (typeof requestIdHeader === "string" && requestIdHeader.trim().length > 0) {
    return requestIdHeader.trim();
  }

  if (Array.isArray(requestIdHeader) && requestIdHeader[0]) {
    return requestIdHeader[0].trim();
  }

  return createPaymentRequestId();
}

function estimatePromptTokens(messages: NormalizedMessage[]): number {
  let charCount = 0;
  for (const message of messages) {
    charCount += message.content?.length ?? 0;
    if (message.role === "assistant") {
      // Replayed tool calls are prompt too.
      for (const call of message.tool_calls ?? []) {
        charCount += call.function.name.length + call.function.arguments.length;
      }
    }
  }
  return Math.max(1, Math.ceil(charCount / 4));
}

function estimateCompletionTokens(maxTokens?: number): number {
  const defaultOutputTokens = 512;
  return Math.max(64, Math.min(maxTokens ?? defaultOutputTokens, 8192));
}

// ============================================
// Helper Functions
// ============================================

// SSRF guard for node URLs lives in services/nodeUrlAllowlist.ts (multi-label
// Nosana hosts such as https://<id>.node.k8s.prd.nos.ci, https-only, no
// userinfo/path). Loopback needs a development process AND an explicit opt-in
// (ALLOW_LOOPBACK_NODE_URLS).
function isNodeUrlAllowed(url: string): boolean {
  return isAllowedNodeUrl(url, nodeUrlAllowlistOptions());
}

async function proxyToNode(
  nodeUrl: string,
  body: Record<string, unknown>,
  // The caller's deadline: it outlives this function, because the body is
  // read (or streamed) after the headers arrive.
  signal: AbortSignal,
): Promise<Response> {
  // Validate node URL to prevent SSRF
  if (!isNodeUrlAllowed(nodeUrl)) {
    throw new Error(`Node URL not allowed: ${nodeUrl}`);
  }

  const targetUrl = `${nodeUrl}/v1/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Do NOT forward the caller's auth header to inference nodes —
    // it would leak JWTs/API keys to potentially untrusted endpoints.
  };

  const response = await fetch(targetUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
    // Never follow a redirect off the allowlisted host: the node is run by a
    // third party, and a 307 to loopback or an internal address would have
    // this server re-POST the caller's body there and relay the answer.
    redirect: "manual",
  });
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Node answered with a redirect (${response.status}); refusing to follow it`);
  }
  return response;
}

async function recordUsage(
  orgId: string,
  deploymentId: string,
  // null = the node reported none; nothing is added to the token totals.
  usage: NodeUsage | null,
  latencyMs: number,
  costCents: number,
  gpuTier: string,
  failed: boolean,
): Promise<void> {
  // Get current hour boundary
  const now = new Date();
  const periodStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours()
  );
  const periodEnd = new Date(periodStart.getTime() + 60 * 60 * 1000);

  // Per-request compute metering: latencyMs is wall-clock GPU time for a
  // single inference. We convert to seconds and price at the tier's
  // authoritative rate. Batching + idle GPU time are reconciled by the
  // treasury-settlement worker against real Nosana job durations (plan A3).
  const computeSeconds = Math.max(0, Math.round(latencyMs / 1000));
  const pricePerSecondUsd = getPricePerSecond(gpuTier);
  const actualCostCents = Math.round(computeSeconds * pricePerSecondUsd * 100);
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;

  await prisma.usageRecord.upsert({
    where: {
      orgId_deploymentId_periodStart: {
        orgId,
        deploymentId,
        periodStart,
      },
    },
    create: {
      orgId,
      deploymentId,
      periodStart,
      periodEnd,
      requestCount: 1,
      inputTokens: BigInt(inputTokens),
      outputTokens: BigInt(outputTokens),
      totalLatencyMs: BigInt(latencyMs),
      errorCount: failed ? 1 : 0,
      costCents: BigInt(costCents),
      computeSeconds: BigInt(computeSeconds),
      actualCostCents: BigInt(actualCostCents),
    },
    update: {
      requestCount: { increment: 1 },
      inputTokens: { increment: inputTokens },
      outputTokens: { increment: outputTokens },
      totalLatencyMs: { increment: latencyMs },
      ...(failed && { errorCount: { increment: 1 } }),
      costCents: { increment: BigInt(costCents) },
      computeSeconds: { increment: BigInt(computeSeconds) },
      actualCostCents: { increment: BigInt(actualCostCents) },
    },
  });
}
