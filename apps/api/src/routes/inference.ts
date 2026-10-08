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
} from "../services/openaiCompat.js";
import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";
import { Prisma, prisma } from "@wheelsai/db";
import { PRICING_TIERS, calculateTokenCost } from "@wheelsai/shared";
import { abortOnClientClose, CLIENT_GONE } from "../services/chatStreamSettlement.js";
import { proxyToNode, recordDeploymentUsage as recordUsage } from "../services/buildDeploymentChatDeps.js";
import { recordLatencySample } from "../services/buildLatencySampleDeps.js";
import {
  buildLatencySample,
  classifyUpstreamOutcome,
  providerForDeployment,
  type DeploymentSurface,
  type LatencyOutcome,
  type RecordLatency,
} from "../services/latencySamples.js";
import {
  MIN_INFERENCE_BALANCE_CENTS,
  completionChars,
  estimatePromptTokens,
  inferenceHoldCents,
  nodeErrorMessage,
  nodeStatusError,
  pricedUsage,
  reportedNodeUsage,
  retryAfterOf,
  startNodeDeadline,
  type NodeUsage,
} from "../services/deploymentChat.js";
import { gpuBillingBlock, selectNode, type NodeInfo } from "../services/hostedModel.js";
import { passthroughStream } from "../services/mastra-runtime.js";
import { isGpuBilledDeployment } from "../services/nosanaIds.js";
import { servedModelNameFor } from "../services/nosana.js";
import { streamToReply } from "../services/sseReply.js";
import {
  DEFAULT_COMPLETION_TOKENS,
  MAX_COMPLETION_TOKENS,
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

// The node-facing helpers live with the deployment chat service, which a
// workflow's model step uses too; these two are part of this module's surface.
export { nodeErrorMessage, nodeStatusError };

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
  /**
   * Takes one latency sample per request that reached a node. Synchronous;
   * defaults to the process sink (services/buildLatencySampleDeps.ts).
   */
  recordLatency?: RecordLatency;
  /** Which way in this handler serves; the dashboard's is "deployment_chat". */
  surface?: Exclude<DeploymentSurface, "deployment_step">;
}

/** What billing needs to know about a request before the node is called. */
interface BillableRequest {
  messages: NormalizedMessage[];
  /** Always set: the completion cap the node is given. */
  max_tokens: number;
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
 * Statuses of a deployment that exists and will serve, or will serve again,
 * without its owner doing anything: a request for it is answered 503, not 404.
 */
const NOT_SERVING_YET_STATUSES = ["pending", "provisioning", "degraded"] as const;

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
  const recordLatency = deps.recordLatency ?? recordLatencySample;
  const surface = deps.surface ?? "v1";

  return async (request, reply, target) => {
    // When the API received the request: latency is measured from here, so
    // it includes the guard, admission and billing, not just the node call.
    // (elapsedTime is 0 where Fastify keeps no start time; the clock then
    // starts at this handler, which understates and never invents.)
    const receivedAt = Date.now() - reply.elapsedTime;
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
        // Set when the deployment serves an adapter: its name is what the
        // engine must be asked for.
        fineTunedModel: { select: { slug: true } },
      },
    });

    if (!deployment) {
      // A deployment that exists and is not serving at this moment is not "not
      // found". A client gives up on a 404 and tries a 503 again, and the
      // second is right here: a deployment that is starting will serve, and one
      // that lost its node comes back when the node does (first live vLLM run,
      // 2026-10-08: half a minute of 404s while the deployment read degraded).
      const notServing = await prisma.deployment.findFirst({
        where: {
          ...("deploymentSlug" in target ? { slug: target.deploymentSlug } : { id: target.deploymentId }),
          orgId,
          status: { in: [...NOT_SERVING_YET_STATUSES] },
        },
        select: { status: true },
      });
      if (notServing) {
        return refuse("service_unavailable", {
          message:
            notServing.status === "degraded"
              ? "This deployment is not serving requests right now. Try again in a moment."
              : "This deployment is still starting. Try again once it is running.",
        });
      }
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
      const holdCents = inferenceHoldCents(billable.messages, billable.max_tokens, pricingTier);
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
      const priced = pricedUsage(reported, billable.messages, generatedChars);

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

    // One latency sample per request that got as far as a node, however it
    // ended. Always called after the money has been settled or released, and
    // after the answer's status is known; it cannot fail the request.
    let firstTokenAt: number | null = null;
    const sample = (outcome: LatencyOutcome, extra: { outputTokens?: number } = {}) => {
      try {
        const at = Date.now();
        recordLatency(
          buildLatencySample(
            {
              orgId,
              surface,
              deploymentId: deployment.id,
              model: deployment.model.hfId,
              provider: providerForDeployment(deployment),
              streamed: chat.stream,
              outcome,
              statusCode: reply.statusCode,
              totalMs: at - receivedAt,
              upstreamMs: at - startTime,
              ...(firstTokenAt !== null && { firstTokenMs: firstTokenAt - receivedAt }),
              ...extra,
            },
            new Date(at),
          ),
        );
      } catch (err) {
        logger.warn({ err }, "Failed to record a latency sample");
      }
    };
    /** Samples a refusal after it has been written, so its status is the one sent. */
    const sampled = <T>(outcome: LatencyOutcome, sent: T): T => {
      sample(outcome);
      return sent;
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
    // HF id on vLLM, the pulled tag on Ollama, the adapter's name for a
    // deployment of a fine-tuned model). Callers send whatever names
    // the deployment to THEM - its slug, as /v1/models lists it - so the
    // name is rewritten here rather than forwarded for the engine to 404.
    const hasTools = chat.tools.length > 0;
    const { parallel_tool_calls: parallelToolCalls, ...sampling } = chat.params;
    const nodeBody: Record<string, unknown> = {
      ...sampling,
      max_tokens: maxTokens,
      model: servedModelNameFor({
        engine: deployment.engine,
        hfId: deployment.model.hfId,
        fineTunedSlug: deployment.fineTunedModel?.slug,
      }),
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
        return sampled("cancelled", refuse("client_closed_request"));
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
      return sampled(
        classifyUpstreamOutcome({ timedOut: deadline.expired() }),
        deadline.expired()
          ? refuse("upstream_timeout", { message: "The inference node did not answer in time." })
          : refuse("upstream_error", { message: "Failed to reach inference node" }, 502),
      );
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
      return sampled(
        "error",
        sendOpenAiError(
          reply,
          nodeStatusError(response.status, nodeErrorMessage(text), retryAfterOf(response)),
        ),
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
        return sampled(
          "error",
          refuse("upstream_error", {
            message: "The inference node did not answer the streaming request with a stream.",
          }),
        );
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
        () => {
          firstTokenAt = Date.now();
        },
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
      // What the CALLER got: a finished answer, one they hung up on, or none.
      const streamOutcome = generated.ok
        ? "ok"
        : classifyUpstreamOutcome({ clientGone: callerLeft, timedOut: generated.code === "deadline" });
      if (!sent.started) return sampled(streamOutcome, refuse("client_closed_request"));
      sample(streamOutcome, { ...(generated.ok && reported && { outputTokens: reported.completion_tokens }) });
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
        return sampled("cancelled", refuse("client_closed_request"));
      }
      logger.error({ error, nodeUrl: node.nodeUrl }, "Node answered 200 with a body that is not JSON");
      await abandon("inference node answered with an unreadable body", { countError: true });
      return sampled(
        classifyUpstreamOutcome({ timedOut: deadline.expired(), httpOk: true, hasAnswer: false }),
        deadline.expired()
          ? refuse("upstream_timeout", { message: "The inference node did not finish answering in time." })
          : refuse("upstream_error", { message: "The inference node answered with a body that is not a completion." }),
      );
    }
    deadline.clear();

    if (typeof responseBody !== "object" || responseBody === null || !Array.isArray(responseBody.choices)) {
      logger.error({ nodeUrl: node.nodeUrl }, "Node answered 200 without choices");
      await abandon("inference node answered without a completion", { countError: true });
      return sampled(
        "error",
        refuse("upstream_error", {
          message: "The inference node answered with a body that is not a completion.",
        }),
      );
    }

    const reported = reportedNodeUsage(responseBody);
    await charge(reported, completionChars(responseBody.choices));
    sample("ok", { ...(reported && { outputTokens: reported.completion_tokens }) });

    return { ...responseBody, model: deployment.slug };
  };
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
  const hasSufficientCredits =
    creditBalanceCents !== null && creditBalanceCents >= MIN_INFERENCE_BALANCE_CENTS;
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

function estimateCompletionTokens(maxTokens?: number): number {
  const defaultOutputTokens = 512;
  return Math.max(64, Math.min(maxTokens ?? defaultOutputTokens, 8192));
}
