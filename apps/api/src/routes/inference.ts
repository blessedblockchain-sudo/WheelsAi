import { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { env } from "../config/env.js";
import { getNosanaDeployConfig } from "../config/nosanaDeploy.js";
import { createLogger } from "../utils/logger.js";
import { Prisma, prisma } from "@wheelsai/db";
import { PRICING_TIERS, calculateTokenCost } from "@wheelsai/shared";
import { getPricePerSecond } from "../services/computeMetering.js";
import { gpuBillingArrears } from "../services/gpuBilling.js";
import { isAllowedNodeUrl } from "../services/nodeUrlAllowlist.js";
import { isGpuBilledDeployment } from "../services/nosanaIds.js";
import { nodeUrlAllowlistOptions } from "../services/nosana.js";
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

interface NodeInfo {
  id: string;
  nodeUrl: string;
  healthStatus: string;
  latencyMs: number | null;
}

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
}

// ============================================
// Schemas
// ============================================

const chatCompletionSchema = z.object({
  model: z.string().optional(),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
    })
  ),
  // Bounded so every request has a worst-case cost the hold can cover.
  max_tokens: z.number().int().min(1).max(MAX_COMPLETION_TOKENS).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
});

// ============================================
// Routes
// ============================================

export function createInferenceRoutes(
  deps: InferenceRouteDeps = {}
): FastifyPluginAsync {
  const verifyPaymentFn = deps.verifyPaymentFn ?? verifyPayment;

  return async (app) => {
  /**
   * OpenAI-compatible chat completions endpoint
   * POST /v1/:deploymentSlug/chat/completions
   *
   * Serves only the CALLER'S OWN deployments (the lookup is org-scoped), so
   * there is no token gate here: the only party it could ever block is the
   * publisher. Buyers of a tokenized listing are gated in
   * services/tokenAccess.ts, on install and on every chat path.
   */
  app.post(
    "/v1/:deploymentSlug/chat/completions",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { deploymentSlug } = z
        .object({ deploymentSlug: z.string() })
        .parse(request.params);
      const body = chatCompletionSchema.parse(request.body);
      // Every request carries an explicit completion cap, forwarded to the
      // node, so credits holds and x402 quotes price the same bounded work.
      body.max_tokens = body.max_tokens ?? DEFAULT_COMPLETION_TOKENS;
      const { orgId } = request.auth!;

      // 1. Find deployment
      const deployment = await prisma.deployment.findFirst({
        where: {
          slug: deploymentSlug,
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
        return reply.status(404).send({
          error: "Not Found",
          message: `Deployment '${deploymentSlug}' not found or not running`,
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
      // the plan's API-call metering (requireAuth -> meterApiCall). A deployment
      // the worker does NOT bill (the dev-only mock) keeps per-request billing.
      const gpuBilled = isGpuBilledDeployment(deployment);
      // "Included in the GPU bill" is only true while something is billing the
      // GPU. With the per-second worker switched off (GPU_BILLING_INTERVAL_MS=0)
      // nothing charges a running deployment and nothing stops it when the org
      // runs out, so serving it here would be free inference. Per-token billing
      // is not a fallback either - the stop/degrade settlement still bills the
      // GPU seconds, so it would charge twice. Refuse.
      if (gpuBilled && getNosanaDeployConfig().gpuBillingIntervalMs <= 0) {
        return reply.status(503).send({
          error: "gpu_billing_disabled",
          message:
            "Per-second GPU billing is not running on this server (GPU_BILLING_INTERVAL_MS=0), so dedicated deployments cannot serve requests.",
        });
      }
      // The other way "included in the GPU bill" stops being true: the worker
      // runs but is not collecting for THIS deployment (see gpuBillingArrears) -
      // the org cannot pay and the stop keeps failing on Nosana, or the worker
      // is stuck. Either way nothing is paying for the GPU, so it is not served.
      if (gpuBilled) {
        const arrears = gpuBillingArrears({
          gpuTier: deployment.gpuTier,
          replicas: deployment.replicas ?? 1,
          billedThroughAt: deployment.billedThroughAt,
          now: new Date(),
          billingIntervalMs: getNosanaDeployConfig().gpuBillingIntervalMs,
          pricePerSecondUsd: getPricePerSecond,
        });
        if (arrears) {
          const balanceCents =
            (await prisma.creditBalance.findUnique({ where: { orgId } }))?.balanceCents ?? 0n;
          if (balanceCents < arrears.owedCents) {
            return reply.status(402).send({
              error: "Payment Required",
              message:
                "The GPU time this deployment has used is unpaid and your credits do not cover it. Add credits to continue.",
              requiredCents: Number(arrears.owedCents),
            });
          }
          return reply.status(503).send({
            error: "gpu_billing_stalled",
            message:
              "Per-second GPU billing has not been collected for this deployment for several billing intervals, so it is not serving requests. Retry shortly.",
          });
        }
      }
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
          body,
          creditBalanceCents: creditBalance?.balanceCents ?? null,
          verifyPaymentFn,
        });
      }

      if (!billingResolution) {
        return;
      }

      reply.header("X-Request-Id", billingResolution.requestId);

      // Credits mode: hold the worst-case cost BEFORE any GPU work.
      const pricingTier = deployment.model.pricingTier as keyof typeof PRICING_TIERS;
      const holdDescription = `Inference: ${deployment.name}`;
      let heldCents = 0n;
      if (billingResolution.mode === "credits") {
        const holdCents = BigInt(
          calculateTokenCost(
            Math.ceil(estimatePromptTokens(body.messages) * PROMPT_ESTIMATE_MARGIN),
            body.max_tokens,
            pricingTier,
          ),
        );
        const held = await prisma.$transaction((tx) =>
          holdInferenceCredits(tx as unknown as InferenceHoldPrisma, {
            orgId,
            holdCents,
            requestId: billingResolution.requestId,
            description: holdDescription,
          }),
        );
        if (!held.ok) {
          return reply.status(402).send({
            error: "Payment Required",
            message: "Insufficient credits for this request. Please add more credits to continue.",
            requiredCents: Number(held.requiredCents),
          });
        }
        heldCents = held.heldCents;
      }
      const releaseHold = async (reason: string) => {
        if (heldCents <= 0n) return;
        await prisma
          .$transaction((tx) =>
            releaseInferenceHold(tx as unknown as InferenceHoldPrisma, {
              orgId,
              heldCents,
              requestId: billingResolution.requestId,
              reason,
            }),
          )
          .catch((err) => logger.error({ err, orgId, heldCents }, "Failed to release inference hold"));
      };

      // 3. Select healthy node
      const node = selectNode(deployment.nodes as unknown as NodeInfo[]);
      if (!node) {
        await releaseHold("no healthy node");
        if (billingResolution.x402PaymentId) {
          await markX402PaymentFailed(
            billingResolution.x402PaymentId,
            "No healthy nodes available for this deployment"
          );
        }
        return reply.status(503).send({
          error: "Service Unavailable",
          message: "No healthy nodes available for this deployment",
        });
      }

      // 4. Proxy request to node
      const startTime = Date.now();
      let response: Response;
      let responseBody: any;

      try {
        response = await proxyToNode(node.nodeUrl, body, request);
        if (response.ok) {
          responseBody = await response.json();
        } else {
          await response.body?.cancel().catch(() => {});
        }
      } catch (error: any) {
        logger.error({ error, nodeUrl: node.nodeUrl }, "Node request failed");

        // Mark node as unhealthy
        await prisma.deploymentNode.update({
          where: { id: node.id },
          data: { healthStatus: "unhealthy" },
        });

        await releaseHold("inference node unreachable");
        if (billingResolution.x402PaymentId) {
          await markX402PaymentFailed(
            billingResolution.x402PaymentId,
            `Inference proxy failed: ${error?.message ?? "unknown error"}`
          );
        }

        return reply.status(502).send({
          error: "Bad Gateway",
          message: "Failed to reach inference node",
        });
      }

      // The node answered, but not with a completion. Nothing is charged for
      // it and its body is not relayed as if it were a 200.
      if (!response.ok) {
        logger.error(
          { nodeUrl: node.nodeUrl, status: response.status },
          "Node returned non-OK for /v1 chat completion",
        );
        await releaseHold(`inference node responded ${response.status}`);
        if (billingResolution.x402PaymentId) {
          await markX402PaymentFailed(
            billingResolution.x402PaymentId,
            `Inference node responded ${response.status}`
          );
        }
        return reply.status(502).send({
          error: "Bad Gateway",
          message: `Inference node responded ${response.status}`,
        });
      }

      const latencyMs = Date.now() - startTime;

      // 5. Calculate usage cost
      const usage = responseBody.usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
      };

      // What the ORG is charged for this request. Zero for a GPU-billed
      // deployment: the GPU seconds are billed by the worker, not per token.
      const costCents =
        billingResolution.mode === "gpu_included"
          ? 0
          : calculateTokenCost(usage.prompt_tokens, usage.completion_tokens, pricingTier);

      // 6. Apply billing side effects
      if (billingResolution.mode === "credits") {
        const settled = await prisma.$transaction((tx) =>
          settleInferenceHold(tx as unknown as InferenceHoldPrisma, {
            orgId,
            heldCents,
            actualCents: BigInt(costCents),
            requestId: billingResolution.requestId,
            description: holdDescription,
          }),
        );
        if (settled.shortfallCents > 0n) {
          logger.warn(
            { orgId, requestId: billingResolution.requestId, shortfallCents: Number(settled.shortfallCents) },
            "Inference usage exceeded the hold and the balance; charged the hold only",
          );
        }
      } else if (billingResolution.x402PaymentId) {
        // A5: "settled" means CONFIRMED ON-CHAIN, and only the settlement
        // worker may say so. The route has merely verified the payment's
        // signature/shape, so it records "verified"; the worker owns the
        // verified -> settled transition after broadcast + confirmation.
        await prisma.x402Payment.update({
          where: { id: billingResolution.x402PaymentId },
          data: {
            status: "verified",
            verifiedAt: new Date(),
          },
        });
      }

      // 7. Record usage metrics (async, non-blocking).
      // Compute metering uses the real Nosana tier price-per-second so
      // actualCostCents reflects measured GPU time, not an estimated split.
      recordUsage(
        orgId,
        deployment.id,
        usage,
        latencyMs,
        costCents,
        deployment.gpuTier,
      ).catch((err) => logger.error({ err }, "Failed to record usage"));

      // 8. Return response
      return responseBody;
    }
  );

  /**
   * List models endpoint (OpenAI compatible)
   */
  app.get("/v1/models", { preHandler: [requireAuth] }, async (request) => {
    const { orgId } = request.auth!;

    const deployments = await prisma.deployment.findMany({
      where: {
        orgId,
        status: "running",
      },
      include: {
        model: true,
      },
    });

    const models = deployments.map((d) => ({
      id: d.slug,
      object: "model",
      created: Math.floor(d.createdAt.getTime() / 1000),
      owned_by: "wheelsai",
      permission: [],
      root: d.model.hfId,
      parent: null,
    }));

    return {
      object: "list",
      data: models,
    };
  });
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
  body: z.infer<typeof chatCompletionSchema>;
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
      reply.status(409).send({
        error: "Conflict",
        message: "This payment transaction has already been used",
        paymentId: persistedPayment.payment.id,
        requestId,
      });
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
  reply.status(402);

  for (const [header, value] of Object.entries(paymentResponse.headers)) {
    reply.header(header, value);
  }
  reply.header("X-Request-Id", requestId);

  reply.send({
    ...paymentResponse.body,
    requestId,
    reason,
  });
  return null;
}

function replyWithCreditRequired(reply: FastifyReply): null {
  reply.status(402).send({
    error: "Payment Required",
    message: "Insufficient credits. Please add more credits to continue.",
    balance: 0,
  });
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

function getOrCreateRequestId(
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

function estimatePromptTokens(
  messages: Array<{ content: string }>
): number {
  const charCount = messages.reduce((acc, message) => acc + message.content.length, 0);
  return Math.max(1, Math.ceil(charCount / 4));
}

function estimateCompletionTokens(maxTokens?: number): number {
  const defaultOutputTokens = 512;
  return Math.max(64, Math.min(maxTokens ?? defaultOutputTokens, 8192));
}

// ============================================
// Helper Functions
// ============================================

function selectNode(nodes: NodeInfo[]): NodeInfo | null {
  if (nodes.length === 0) return null;

  // Filter to healthy nodes
  const healthyNodes = nodes.filter((n) => n.healthStatus === "healthy");
  if (healthyNodes.length === 0) return null;

  // Weighted random selection based on latency
  // Lower latency = higher weight
  const maxLatency = Math.max(...healthyNodes.map((n) => n.latencyMs ?? 1000));
  const weights = healthyNodes.map((n) => maxLatency - (n.latencyMs ?? 500) + 100);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let random = Math.random() * totalWeight;
  for (let i = 0; i < healthyNodes.length; i++) {
    random -= weights[i]!;
    if (random <= 0) {
      return healthyNodes[i]!;
    }
  }

  return healthyNodes[0]!;
}

// SSRF guard for node URLs lives in services/nodeUrlAllowlist.ts (multi-label
// Nosana hosts such as https://<id>.node.k8s.prd.nos.ci, https-only, no
// userinfo/path). Loopback needs a development process AND an explicit opt-in
// (ALLOW_LOOPBACK_NODE_URLS).
function isNodeUrlAllowed(url: string): boolean {
  return isAllowedNodeUrl(url, nodeUrlAllowlistOptions());
}

async function proxyToNode(
  nodeUrl: string,
  body: z.infer<typeof chatCompletionSchema>,
  _request: FastifyRequest
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.INFERENCE_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
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
  } finally {
    clearTimeout(timeout);
  }
}

async function recordUsage(
  orgId: string,
  deploymentId: string,
  usage: { prompt_tokens: number; completion_tokens: number },
  latencyMs: number,
  costCents: number,
  gpuTier: string,
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
      inputTokens: BigInt(usage.prompt_tokens),
      outputTokens: BigInt(usage.completion_tokens),
      totalLatencyMs: BigInt(latencyMs),
      errorCount: 0,
      costCents: BigInt(costCents),
      computeSeconds: BigInt(computeSeconds),
      actualCostCents: BigInt(actualCostCents),
    },
    update: {
      requestCount: { increment: 1 },
      inputTokens: { increment: usage.prompt_tokens },
      outputTokens: { increment: usage.completion_tokens },
      totalLatencyMs: { increment: latencyMs },
      costCents: { increment: BigInt(costCents) },
      computeSeconds: { increment: BigInt(computeSeconds) },
      actualCostCents: { increment: BigInt(actualCostCents) },
    },
  });
}
