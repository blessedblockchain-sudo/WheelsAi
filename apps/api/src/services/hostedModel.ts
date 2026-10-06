/**
 * Agents on WheelsAI-hosted models: `wheelsai/<model id>`.
 *
 * The agent wizard offers "WheelsAI Hosted" models and stores them as
 * `wheelsai/llama-3.1-8b`. Nothing resolved that id, so such an agent could
 * not chat at all. It names a model the organization runs on its own GPU
 * deployment, so it resolves to THAT deployment: the newest running one of
 * the caller's organization for the model, through one of its healthy nodes.
 *
 * Money: a dedicated deployment is billed per GPU-second by the GPU billing
 * worker, and an agent chat on it is included in that time - exactly as a
 * /v1 request to the deployment is (routes/inference.ts). The same admission
 * checks apply, from the same function, so the agent path can never serve a
 * deployment the /v1 path would refuse as unpaid. A deployment that is billed
 * per request instead (the development mock) is not served from here: an
 * agent chat has no credit hold to settle against it.
 */

import { prisma } from "@wheelsai/db";

import { getNosanaDeployConfig } from "../config/nosanaDeploy.js";
import { getPricePerSecond } from "./computeMetering.js";
import { gpuBillingArrears } from "./gpuBilling.js";
import type { ResolvedModel } from "./mastra-runtime.js";
import { isAllowedNodeUrl } from "./nodeUrlAllowlist.js";
import { isGpuBilledDeployment } from "./nosanaIds.js";
import { nodeUrlAllowlistOptions, servedModelName } from "./nosana.js";

export const HOSTED_MODEL_PREFIX = "wheelsai/";

export interface NodeInfo {
  id: string;
  nodeUrl: string;
  healthStatus: string;
  latencyMs: number | null;
}

/** A healthy node, weighted towards the faster ones; null when there is none. */
export function selectNode(nodes: NodeInfo[], random: () => number = Math.random): NodeInfo | null {
  if (nodes.length === 0) return null;

  // Filter to healthy nodes
  const healthyNodes = nodes.filter((n) => n.healthStatus === "healthy");
  if (healthyNodes.length === 0) return null;

  // Weighted random selection based on latency
  // Lower latency = higher weight
  const maxLatency = Math.max(...healthyNodes.map((n) => n.latencyMs ?? 1000));
  const weights = healthyNodes.map((n) => maxLatency - (n.latencyMs ?? 500) + 100);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let pick = random() * totalWeight;
  for (let i = 0; i < healthyNodes.length; i++) {
    pick -= weights[i]!;
    if (pick <= 0) {
      return healthyNodes[i]!;
    }
  }

  return healthyNodes[0]!;
}

export interface GpuBillingBlock {
  code: "service_unavailable" | "insufficient_credits";
  message: string;
  extra: Record<string, unknown>;
}

/**
 * Why a GPU-billed deployment may not serve right now, or null when it may.
 *
 * "Included in the GPU bill" is only true while something is billing the GPU.
 * With the per-second worker switched off (GPU_BILLING_INTERVAL_MS=0) nothing
 * charges a running deployment and nothing stops it when the org runs out, so
 * serving it would be free inference. Per-token billing is not a fallback
 * either - the stop/degrade settlement still bills the GPU seconds, so it
 * would charge twice.
 *
 * The other way it stops being true: the worker runs but is not collecting
 * for THIS deployment (see gpuBillingArrears) - the org cannot pay and the
 * stop keeps failing on Nosana, or the worker is stuck. Either way nothing is
 * paying for the GPU, so it is not served.
 */
export async function gpuBillingBlock(
  deployment: { gpuTier: string; replicas: number | null; billedThroughAt: Date | null },
  orgId: string,
  db: Pick<typeof prisma, "creditBalance"> = prisma,
): Promise<GpuBillingBlock | null> {
  const billingIntervalMs = getNosanaDeployConfig().gpuBillingIntervalMs;
  if (billingIntervalMs <= 0) {
    return {
      code: "service_unavailable",
      message:
        "Per-second GPU billing is not running on this server (GPU_BILLING_INTERVAL_MS=0), so dedicated deployments cannot serve requests.",
      extra: { reason: "gpu_billing_disabled" },
    };
  }
  const arrears = gpuBillingArrears({
    gpuTier: deployment.gpuTier,
    replicas: deployment.replicas ?? 1,
    billedThroughAt: deployment.billedThroughAt,
    now: new Date(),
    billingIntervalMs,
    pricePerSecondUsd: getPricePerSecond,
  });
  if (!arrears) return null;

  const balanceCents = (await db.creditBalance.findUnique({ where: { orgId } }))?.balanceCents ?? 0n;
  if (balanceCents < arrears.owedCents) {
    return {
      code: "insufficient_credits",
      message:
        "The GPU time this deployment has used is unpaid and your credits do not cover it. Add credits to continue.",
      extra: { requiredCents: Number(arrears.owedCents) },
    };
  }
  return {
    code: "service_unavailable",
    message:
      "Per-second GPU billing has not been collected for this deployment for several billing intervals, so it is not serving requests. Retry shortly.",
    extra: { reason: "gpu_billing_stalled" },
  };
}

export type HostedModelResolution =
  | { ok: true; resolved: ResolvedModel; deploymentId: string }
  | { ok: false; message: string };

type HostedModelDb = Pick<typeof prisma, "deployment" | "creditBalance">;

/**
 * `wheelsai/<model id>` -> the organization's own running deployment of that
 * model. Read-only: nothing is charged or reserved by resolving.
 */
export async function resolveHostedModel(
  args: { orgId: string; modelId: string },
  db: HostedModelDb = prisma,
): Promise<HostedModelResolution> {
  const catalogId = args.modelId.slice(HOSTED_MODEL_PREFIX.length);
  const deployment = catalogId
    ? await db.deployment.findFirst({
        where: { orgId: args.orgId, modelId: catalogId, status: "running" },
        orderBy: { createdAt: "desc" },
        include: { nodes: { where: { healthStatus: "healthy" } }, model: true },
      })
    : null;
  if (!deployment) {
    return {
      ok: false,
      message: `This agent uses the WheelsAI-hosted model "${catalogId}", and your organization has no running deployment of it. Deploy the model (Deployments > New), or give the agent another model.`,
    };
  }

  if (!isGpuBilledDeployment(deployment)) {
    return {
      ok: false,
      message: `The deployment "${deployment.slug}" is billed per request, which agent chat cannot settle. Agents run on dedicated (per-second billed) deployments.`,
    };
  }
  const blocked = await gpuBillingBlock(deployment, args.orgId, db);
  if (blocked) return { ok: false, message: blocked.message };

  const node = selectNode(deployment.nodes as unknown as NodeInfo[]);
  if (!node) {
    return {
      ok: false,
      message: `The deployment "${deployment.slug}" has no healthy node right now. Retry shortly.`,
    };
  }
  // The same SSRF guard the /v1 proxy applies to DB-sourced node URLs.
  if (!isAllowedNodeUrl(node.nodeUrl, nodeUrlAllowlistOptions())) {
    return {
      ok: false,
      message: `The deployment "${deployment.slug}" has no usable node right now. Retry shortly.`,
    };
  }

  return {
    ok: true,
    deploymentId: deployment.id,
    resolved: {
      // Nodes take no key; the caller's own credentials are never forwarded.
      apiKey: "",
      baseUrl: `${node.nodeUrl}/v1`,
      modelName: servedModelName(deployment.engine, deployment.model.hfId),
      // The node is run by a third party: a redirect off the allowlisted
      // host is refused, not followed.
      refuseRedirects: true,
      // vLLM and Ollama both report usage on a stream when asked.
      streamUsage: true,
    },
  };
}
