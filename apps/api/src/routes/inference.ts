import { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { requireTokenHolding } from "../middleware/tokenGate.js";
import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";
import { Prisma, prisma } from "@wheelsai/db";
import { PRICING_TIERS, calculateTokenCost } from "@wheelsai/shared";
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

type BillingMode = "credits" | "x402";

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
  max_tokens: z.number().optional(),
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
   */
  app.post(
    "/v1/:deploymentSlug/chat/completions",
    { preHandler: [requireAuth, requireTokenHolding()] },
    async (request, reply) => {
      const { deploymentSlug } = z
        .object({ deploymentSlug: z.string() })
        .parse(request.params);
      const body = chatCompletionSchema.parse(request.body);
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

      // 2. Resolve billing mode (credits or X402)
      const creditBalance = await prisma.creditBalance.findUnique({
        where: { orgId },
      });

      const billingResolution = await resolveBilling({
        request,
        reply,
        orgId,
        deploymentId: deployment.id,
        modelTier: deployment.model.pricingTier as keyof typeof PRICING_TIERS,
        body,
        creditBalanceCents: creditBalance?.balanceCents ?? null,
        verifyPaymentFn,
      });

      if (!billingResolution) {
        return;
      }

      reply.header("X-Request-Id", billingResolution.requestId);

      // 3. Select healthy node
      const node = selectNode(deployment.nodes as unknown as NodeInfo[]);
      if (!node) {
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
        responseBody = await response.json();
      } catch (error: any) {
        logger.error({ error, nodeUrl: node.nodeUrl }, "Node request failed");

        // Mark node as unhealthy
        await prisma.deploymentNode.update({
          where: { id: node.id },
          data: { healthStatus: "unhealthy" },
        });

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

      const latencyMs = Date.now() - startTime;

      // 5. Calculate usage cost
      const usage = responseBody.usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
      };

      const costCents = calculateTokenCost(
        usage.prompt_tokens,
        usage.completion_tokens,
        deployment.model.pricingTier as keyof typeof PRICING_TIERS
      );

      // 6. Apply billing side effects
      if (billingResolution.mode === "credits") {
        if (!creditBalance) {
          return reply.status(402).send({
            error: "Payment Required",
            message: "Insufficient credits. Please add more credits to continue.",
            balance: 0,
          });
        }

        await prisma.$transaction([
          prisma.creditBalance.update({
            where: { orgId },
            data: {
              balanceCents: {
                decrement: costCents,
              },
            },
          }),
          prisma.creditTransaction.create({
            data: {
              orgId,
              amountCents: -costCents,
              type: "usage",
              description: `Inference: ${deployment.name}`,
              referenceId: deployment.id,
              balanceAfter: creditBalance.balanceCents - BigInt(costCents),
            },
          }),
        ]);
      } else if (billingResolution.x402PaymentId) {
        await prisma.x402Payment.update({
          where: { id: billingResolution.x402PaymentId },
          data: {
            status: "settled",
            settledAt: new Date(),
          },
        });
      }

      // 7. Record usage metrics (async, non-blocking)
      recordUsage(orgId, deployment.id, usage, latencyMs, costCents).catch((err) =>
        logger.error({ err }, "Failed to record usage")
      );

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

async function proxyToNode(
  nodeUrl: string,
  body: z.infer<typeof chatCompletionSchema>,
  request: FastifyRequest
): Promise<Response> {
  const targetUrl = `${nodeUrl}/v1/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Forward authorization if present (for nodes that need it)
  const authHeader = request.headers.authorization;
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.INFERENCE_TIMEOUT_MS);

  try {
    return await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function recordUsage(
  orgId: string,
  deploymentId: string,
  usage: { prompt_tokens: number; completion_tokens: number },
  latencyMs: number,
  costCents: number
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

  // Upsert usage record
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
    },
    update: {
      requestCount: { increment: 1 },
      inputTokens: { increment: usage.prompt_tokens },
      outputTokens: { increment: usage.completion_tokens },
      totalLatencyMs: { increment: latencyMs },
      costCents: { increment: BigInt(costCents) },
    },
  });
}
