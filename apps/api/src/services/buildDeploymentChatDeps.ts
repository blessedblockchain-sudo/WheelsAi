/**
 * Composition root for the deployment chat service
 * (services/deploymentChat.ts): binds it to Prisma, the credit hold, the GPU
 * billing admission checks, node selection and the node call.
 *
 * The node call and the usage row are the ones the /v1 route itself uses
 * (routes/inference.ts imports them from here), so a deployment is reached
 * through one guarded fetch and counted in one rollup whichever caller it was.
 */

import { prisma } from "@wheelsai/db";

import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";
import { getPricePerSecond } from "./computeMetering.js";
import {
  runDeploymentChat,
  type DeploymentChatDeps,
  type DeploymentChatRequest,
  type DeploymentChatResult,
  type DeploymentForChat,
  type NodeUsage,
} from "./deploymentChat.js";
import { gpuBillingBlock, selectNode, type NodeInfo } from "./hostedModel.js";
import {
  holdInferenceCredits,
  releaseInferenceHold,
  settleInferenceHold,
  type InferenceHoldPrisma,
} from "./inferenceCreditHold.js";
import { isAllowedNodeUrl } from "./nodeUrlAllowlist.js";
import { isGpuBilledDeployment } from "./nosanaIds.js";
import { nodeUrlAllowlistOptions, servedModelName } from "./nosana.js";
import { createPaymentRequestId } from "./x402.js";

const logger = createLogger("deployment-chat");

/**
 * POSTs a chat completion to an inference node.
 *
 * SSRF guard for node URLs lives in services/nodeUrlAllowlist.ts (multi-label
 * Nosana hosts such as https://<id>.node.k8s.prd.nos.ci, https-only, no
 * userinfo/path). Loopback needs a development process AND an explicit opt-in
 * (ALLOW_LOOPBACK_NODE_URLS).
 */
export async function proxyToNode(
  nodeUrl: string,
  body: Record<string, unknown>,
  // The caller's deadline: it outlives this function, because the body is
  // read (or streamed) after the headers arrive.
  signal: AbortSignal,
): Promise<Response> {
  // Validate node URL to prevent SSRF
  if (!isAllowedNodeUrl(nodeUrl, nodeUrlAllowlistOptions())) {
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

/** One request against a deployment, added to its hourly usage rollup. */
export async function recordDeploymentUsage(
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

export function buildDeploymentChatDeps(): DeploymentChatDeps {
  return {
    findRunningDeployment: async ({ orgId, deploymentId }) => {
      const deployment = await prisma.deployment.findFirst({
        where: { id: deploymentId, orgId, status: "running" },
        include: { nodes: { where: { healthStatus: "healthy" } }, model: true },
      });
      return deployment as unknown as DeploymentForChat | null;
    },
    isGpuBilled: isGpuBilledDeployment,
    gpuBillingBlock: (deployment, orgId) => gpuBillingBlock(deployment, orgId),
    x402Required: () => env.X402_ENABLED && env.X402_INFERENCE_MODE === "required",
    balanceCents: async (orgId) =>
      (await prisma.creditBalance.findUnique({ where: { orgId } }))?.balanceCents ?? null,
    hold: (args) =>
      prisma.$transaction((tx) => holdInferenceCredits(tx as unknown as InferenceHoldPrisma, args)),
    settle: (args) =>
      prisma.$transaction((tx) => settleInferenceHold(tx as unknown as InferenceHoldPrisma, args)),
    release: (args) =>
      prisma.$transaction((tx) => releaseInferenceHold(tx as unknown as InferenceHoldPrisma, args)),
    selectNode: (nodes: NodeInfo[]) => selectNode(nodes),
    servedModelName,
    callNode: proxyToNode,
    markNodeUnhealthy: async (nodeId) => {
      await prisma.deploymentNode.update({
        where: { id: nodeId },
        data: { healthStatus: "unhealthy" },
      });
    },
    recordUsage: (args) =>
      recordDeploymentUsage(
        args.orgId,
        args.deploymentId,
        args.usage,
        args.latencyMs,
        args.costCents,
        args.gpuTier,
        args.failed,
      ),
    idleTimeoutMs: env.INFERENCE_TIMEOUT_MS,
    newRequestId: createPaymentRequestId,
    logger,
  };
}

/**
 * Sends one chat to a model deployment of `orgId` under that deployment's
 * billing rules. Throws DeploymentChatError with a named reason when it
 * cannot, and the caller's abort when it was cancelled.
 */
export function chatWithDeployment(request: DeploymentChatRequest): Promise<DeploymentChatResult> {
  return runDeploymentChat(request, buildDeploymentChatDeps());
}
