import { randomUUID } from "node:crypto";

import { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { createLogger } from "../utils/logger.js";
import {
  createDeploymentCompletionHandler,
  type DeploymentCompletionHandler,
} from "./inference.js";
import { prisma as defaultPrisma } from "@wheelsai/db";
import { triggerWebhook as defaultTriggerWebhook } from "../services/webhooks.js";
import { env } from "../config/env.js";
import { rowAccessMode, type NosanaAccessMode } from "../config/nosanaAccess.js";
import { deploymentEndpoint as buildDeploymentEndpoint } from "../services/publicEndpoints.js";
import {
  MarketNotConfiguredError,
  NosanaNotConfiguredError,
  getNosanaClient,
  isMockNosanaId,
  type ModelDeploymentConfig,
  type NosanaClient,
} from "../services/nosana.js";
import { scopedLatencyLoader, type ScopedLatency } from "../services/buildLatencySampleDeps.js";
import type { ScopedWindow } from "../services/latencyQueries.js";
import { NosanaLifecycleError } from "../services/nosanaDeploymentLifecycle.js";
import {
  COMPUTE_UNAVAILABLE_MESSAGE,
  computeRefusal,
  GPU_TIER_UNAVAILABLE_MESSAGE,
  isAccessModeUnavailable,
  runDeployPreflight,
} from "../services/nosanaPreflight.js";
import {
  ACTIVE_STATUSES,
  DEFAULT_DEPLOYMENT_CONFIG,
  DeploymentConflictError,
  InsufficientCreditsError,
  NO_REPLICA_CHANGE,
  OWNER_STOP_REASON,
  TERMINAL_STATUSES,
  restartModelDeployment,
  submitToNosana,
  type Db,
  type NosanaPort,
} from "../services/modelDeploymentLifecycle.js";
import {
  holdAdditionalReplicas,
  releaseDeploymentReservation,
  reserveDeploymentCredits,
  returnReplicaReservation,
  estimateDeploymentReservationCents,
} from "../services/deploymentCreditGate.js";
import { getPricePerSecond } from "../services/computeMetering.js";
import {
  FineTunedModelGoneError,
  adapterForRun,
  buildAdapterServingDeps,
  lockReadyFineTunedModel,
  prepareAdapterServing,
  type AdapterServingDeps,
} from "../services/fineTunedModels.js";
import {
  InsufficientGpuCreditsError,
  chargeGpuWindow,
  type GpuBillingTx,
} from "../services/gpuBilling.js";

const logger = createLogger("deployment-routes");

// Part of this module's surface: the submit and the restart themselves live in
// services/modelDeploymentLifecycle.ts, where the scheduler reaches them too.
export { DEFAULT_DEPLOYMENT_CONFIG, submitToNosana };

/** Another replica change already holds the claim on the deployment. */
class ReplicaChangeInProgressError extends Error {
  constructor() {
    super("replica_change_in_progress");
  }
}

/** Statuses from which a model deployment can still be stopped. */
const STOPPABLE_STATUSES = ["pending", "provisioning", "running", "degraded"];
const STOPPABLE_NOT_RUNNING = STOPPABLE_STATUSES.filter((status) => status !== "running");

// ============================================
// Schemas
// ============================================

const createDeploymentSchema = z.object({
  name: z.string().min(3).max(50),
  // Required unless fineTunedModelId is given (checked in the handler): the
  // base model then comes from the fine-tuned model.
  modelId: z.string().optional(),
  /** Serve this fine-tuned model's adapter on top of its base model (vLLM). */
  fineTunedModelId: z.string().uuid().optional(),
  gpuTier: z.string(),
  engine: z.enum(["vllm", "ollama"]).default("vllm"),
  replicas: z.number().int().min(1).max(10).default(1),
  config: z
    .object({
      maxTokens: z.number().int().min(256).max(32768).default(DEFAULT_DEPLOYMENT_CONFIG.maxTokens),
      gpuMemoryUtilization: z.number().min(0.5).max(0.95).default(DEFAULT_DEPLOYMENT_CONFIG.gpuMemoryUtilization),
    })
    .optional(),
});

const updateDeploymentSchema = z.object({
  replicas: z.number().int().min(1).max(10).optional(),
  config: z
    .object({
      maxTokens: z.number().int().min(256).max(32768).optional(),
    })
    .optional(),
});

// ============================================
// Helpers
// ============================================

/**
 * The OpenAI-compatible endpoint a customer calls: OUR API host's
 * /v1/<slug>/chat/completions (routes/inference.ts), never the raw Nosana node
 * URL. PUBLIC_API_URL when configured, otherwise a host-relative path.
 */
export function deploymentEndpoint(slug: string): string {
  return buildDeploymentEndpoint(slug, env.PUBLIC_API_URL);
}

/**
 * Maps a pre-flight failure onto an honest HTTP answer. Returns true when it
 * replied. Unconfigured means 501, never a fabricated success.
 */
function replyForPreflightError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof NosanaNotConfiguredError) {
    logger.warn({ code: error.code }, `Deploy refused: ${error.message}`);
    reply.status(501).send({ error: error.code, message: COMPUTE_UNAVAILABLE_MESSAGE });
    return true;
  }
  if (error instanceof MarketNotConfiguredError) {
    if (error.code === "unknown_tier") {
      reply.status(400).send({ error: "unknown_gpu_tier", message: error.message });
    } else {
      logger.warn({ tier: error.tier, network: error.network }, `Deploy refused: ${error.message}`);
      reply.status(501).send({ error: "gpu_market_not_configured", message: GPU_TIER_UNAVAILABLE_MESSAGE });
    }
    return true;
  }
  // The platform's own funding refused (credits low or unreadable, key
  // rejected, tier priced below cost): 503, with no amount in the message.
  const refusal = computeRefusal(error);
  if (refusal) {
    reply.status(refusal.status).send(refusal.body);
    return true;
  }
  return false;
}

/**
 * The answer when a row's Nosana deployment belongs to an access mode this
 * process holds no credential for. Nothing can be read, scaled or stopped for
 * it from here, and retrying will not change that.
 */
const OTHER_ACCOUNT_REPLY = {
  error: "nosana_access_mode_unavailable",
  message:
    "This deployment cannot be changed right now. Contact support.",
};

/**
 * A deployment row as its owner reads it: without the record of which platform
 * credential pays Nosana for it, which is the platform's business.
 */
function ownerView<T extends { nosanaAccessMode?: unknown }>(row: T): Omit<T, "nosanaAccessMode"> {
  const { nosanaAccessMode: _accessMode, ...rest } = row;
  return rest;
}

/** The slice of a transaction client the replica-change steps use. */
interface ReplicaChangeTx {
  deployment: {
    findUnique: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
}

/** One PATCH's replica change, as claimed on the row. */
interface ReplicaChange {
  deploymentId: string;
  orgId: string;
  gpuTier: string;
  /** The run and the Nosana deployment the request read. */
  runGeneration: number;
  nosanaId: string;
  /** The credential that created `nosanaId` (the row's stamp). */
  accessMode: NosanaAccessMode;
  from: number;
  to: number;
  /** This request's claim token (Deployment.replicaChangeId). */
  changeId: string;
}

/**
 * Claims a replica change. One transaction, before Nosana is called.
 *
 * `replicas` is NOT moved here: it is the confirmed count, the one billing
 * charges, and Nosana has confirmed nothing yet. The claim only records the
 * target under this request's token, by a CAS that requires no other change to
 * be in flight - so an overlapping PATCH loses (ReplicaChangeInProgressError)
 * and never reaches Nosana, and the row cannot be moved by a second request
 * while the first one's Nosana call is still open.
 *
 * Then, under the lock the claim took:
 *  - the GPU time used so far is charged at the current count (mode "tick": an
 *    org that cannot pay is refused before Nosana is touched, not forgiven);
 *  - a scale-up takes the hold for the added replicas (conditional decrement).
 *
 * Returns the cents the claim added to the hold (0 for a scale-down).
 */
async function claimReplicaChange(
  tx: ReplicaChangeTx,
  change: ReplicaChange,
  now: Date,
): Promise<bigint> {
  const claimed = await tx.deployment.updateMany({
    where: {
      id: change.deploymentId,
      status: "running",
      runGeneration: change.runGeneration,
      nosanaJobIds: { has: change.nosanaId },
      replicas: change.from,
      replicaChangeId: null,
    },
    data: {
      pendingReplicas: change.to,
      replicaChangeId: change.changeId,
      replicaChangeAt: now,
      replicaChangeHoldCents: null,
    },
  });
  if (claimed.count === 0) {
    const current = (await tx.deployment.findUnique({
      where: { id: change.deploymentId },
      select: { replicaChangeId: true },
    })) as { replicaChangeId: string | null } | null;
    if (current?.replicaChangeId) throw new ReplicaChangeInProgressError();
    throw new DeploymentConflictError();
  }

  const fresh = (await tx.deployment.findUnique({
    where: { id: change.deploymentId },
    select: { billedThroughAt: true },
  })) as { billedThroughAt: Date | null } | null;
  if (fresh?.billedThroughAt) {
    const settled = await chargeGpuWindow(tx as unknown as GpuBillingTx, {
      deploymentId: change.deploymentId,
      orgId: change.orgId,
      gpuTier: change.gpuTier,
      replicas: change.from,
      billedThroughAt: fresh.billedThroughAt,
      now,
      mode: "tick",
      pricePerSecondUsd: getPricePerSecond,
    });
    // Cannot happen under the claim's row lock; if it does, nothing was settled
    // and the claim must not stand.
    if (settled.kind === "cursor_lost") throw new DeploymentConflictError();
  }

  if (change.to <= change.from) return 0n;
  const hold = await holdAdditionalReplicas({
    tx: tx as never,
    deploymentId: change.deploymentId,
    orgId: change.orgId,
    gpuTier: change.gpuTier,
    addedReplicas: change.to - change.from,
  });
  if (!hold.ok) throw new InsufficientCreditsError(hold.requiredCents);
  await tx.deployment.updateMany({
    where: { id: change.deploymentId, replicaChangeId: change.changeId },
    data: { replicaChangeHoldCents: hold.reservedCents },
  });
  return hold.reservedCents;
}

/**
 * Commits a replica change Nosana has confirmed. One transaction: the new count
 * is written by CAS on this request's claim, everything up to `now` is charged
 * at the OLD count (rounded up, so no remainder is left to be billed at the new
 * one), and a scale-down hands back the removed replicas' share of the hold.
 *
 * False means the claim was no longer this request's to commit - the row left
 * service or was restarted, or the status worker resolved a claim it judged
 * abandoned. Nothing is written then.
 */
async function commitReplicaChange(
  tx: ReplicaChangeTx,
  change: ReplicaChange,
  now: Date,
): Promise<boolean> {
  const committed = await tx.deployment.updateMany({
    where: {
      id: change.deploymentId,
      runGeneration: change.runGeneration,
      replicaChangeId: change.changeId,
      status: { in: ["running", "degraded"] },
    },
    data: { replicas: change.to, ...NO_REPLICA_CHANGE },
  });
  if (committed.count === 0) return false;

  const fresh = (await tx.deployment.findUnique({
    where: { id: change.deploymentId },
    select: { status: true, billedThroughAt: true },
  })) as { status: string; billedThroughAt: Date | null } | null;
  // A degraded row has no open window: the degrade edge settled it.
  if (fresh?.status === "running" && fresh.billedThroughAt) {
    const settled = await chargeGpuWindow(tx as unknown as GpuBillingTx, {
      deploymentId: change.deploymentId,
      orgId: change.orgId,
      gpuTier: change.gpuTier,
      replicas: change.from,
      rowReplicas: change.to,
      billedThroughAt: fresh.billedThroughAt,
      now,
      mode: "replica_change",
      pricePerSecondUsd: getPricePerSecond,
    });
    // The new count must never stand over an unsettled window: roll back.
    if (settled.kind === "cursor_lost") throw new DeploymentConflictError();
  }

  if (change.to < change.from) {
    await returnReplicaReservation({
      tx: tx as never,
      deploymentId: change.deploymentId,
      orgId: change.orgId,
      cents: estimateDeploymentReservationCents(change.gpuTier, change.from - change.to),
      reason: `scale down x${change.from - change.to}`,
    });
  }
  return true;
}

/**
 * Drops a replica change Nosana did not apply. The CAS is on this request's own
 * claim token and `replicas` is not written at all, so it can neither undo
 * another request's change nor restore a count somebody else set. A scale-up
 * gets back exactly the hold its claim took - only if the claim was still there.
 */
async function clearReplicaChange(
  tx: ReplicaChangeTx,
  change: ReplicaChange,
  heldCents: bigint,
): Promise<void> {
  const cleared = await tx.deployment.updateMany({
    where: { id: change.deploymentId, replicaChangeId: change.changeId },
    data: NO_REPLICA_CHANGE,
  });
  if (cleared.count === 0 || heldCents <= 0n) return;
  await returnReplicaReservation({
    tx: tx as never,
    deploymentId: change.deploymentId,
    orgId: change.orgId,
    cents: heldCents,
    reason: "scale-up failed",
  });
}

/** Maps a failed replica-change claim onto its HTTP answer. True when it replied. */
function replyReplicaClaimError(reply: FastifyReply, err: unknown, what: string): boolean {
  if (err instanceof InsufficientCreditsError) {
    reply.status(402).send({
      error: "insufficient_credits",
      message: `${what} requires a reservation of $${(
        Number(err.requiredCents) / 100
      ).toFixed(2)} in credits. Add credits and retry.`,
    });
    return true;
  }
  if (err instanceof InsufficientGpuCreditsError) {
    reply.status(402).send({
      error: "insufficient_credits",
      message: `The GPU time used so far ($${(
        Number(err.requiredCents) / 100
      ).toFixed(2)}) must be paid before the replica count can change. Add credits and retry.`,
    });
    return true;
  }
  if (err instanceof ReplicaChangeInProgressError) {
    reply.status(409).send({
      error: "replica_change_in_progress",
      message:
        "Another replica change for this deployment has not finished yet. Retry once it has; an abandoned one is cleared automatically within a few minutes.",
    });
    return true;
  }
  if (err instanceof DeploymentConflictError) {
    reply.status(409).send({
      error: "deployment_conflict",
      message: "The deployment changed while scaling; retry.",
    });
    return true;
  }
  return false;
}

/**
 * What a FAILED scaleDeployment call left on Nosana: true = the new count is
 * live after all (a lost response), false = nothing changed, null = unknown.
 * An error says nothing about the outcome by itself, so Nosana is asked.
 */
async function replicaChangeOutcome(
  nosana: Pick<NosanaClient, "getDeploymentStatus">,
  change: ReplicaChange,
  error: unknown,
): Promise<boolean | null> {
  // Refused before anything was attempted: the deployment is not running.
  if (error instanceof NosanaLifecycleError && error.code === "nosana_not_running") return false;
  // Refused before Nosana was asked: no credential for the row's account, or
  // (API-key access) the credit gate for the added replicas.
  if (isAccessModeUnavailable(error) || computeRefusal(error)) return false;
  try {
    const { replicas } = await nosana.getDeploymentStatus(change.nosanaId, change.accessMode);
    if (replicas === change.to) return true;
    if (replicas === change.from) return false;
    return null;
  } catch {
    return null;
  }
}

export interface DeploymentRouteDeps {
  prisma?: Db;
  getNosana?: () => Promise<NosanaPort>;
  triggerWebhook?: typeof defaultTriggerWebhook;
  now?: () => Date;
  /** The dashboard playground's completion handler (routes/inference.ts). */
  chatCompletion?: DeploymentCompletionHandler;
  /**
   * Async submit to Nosana after the row + reservation exist. `runGeneration`
   * is the run the submit belongs to (Deployment.runGeneration as claimed by
   * the create / restart that started it).
   */
  submit?: (
    deploymentId: string,
    config: ModelDeploymentConfig,
    gpuTier: string,
    replicas: number,
    runGeneration: number,
  ) => Promise<void>;
  /**
   * deployment id -> the custom domain that serves it (services/domains.ts:
   * the primary serving domain of each). Only domains observed serving are
   * returned, so a URL shown here answers.
   */
  customDomains?: (orgId: string, deploymentIds: string[]) => Promise<Map<string, string>>;
  /** A deployment's measured latency (request_latency_samples), org-bound. */
  loadScopedLatency?: (window: ScopedWindow) => Promise<ScopedLatency>;
  /** What serving a fine-tuned adapter needs; the server's own when omitted. */
  adapterServing?: AdapterServingDeps;
}

/** The chat-completions URL on a deployment's own custom domain. */
export function customDomainEndpoint(domain: string): string {
  return `https://${domain}/v1/chat/completions`;
}

async function servingCustomDomains(orgId: string, deploymentIds: string[]): Promise<Map<string, string>> {
  const { domainsService } = await import("../services/domains.js");
  return (await domainsService()).servingDomainsFor(orgId, "deployment", deploymentIds);
}

// ============================================
// Routes
// ============================================

export function createDeploymentRoutes(
  deps: DeploymentRouteDeps = {},
): FastifyPluginAsync {
  const prisma = deps.prisma ?? defaultPrisma;
  const getNosana: () => Promise<NosanaPort> = deps.getNosana ?? getNosanaClient;
  const triggerWebhook = deps.triggerWebhook ?? defaultTriggerWebhook;
  const now = deps.now ?? (() => new Date());
  // Built on first use: the handler talks to the global Prisma client.
  let chatCompletion = deps.chatCompletion ?? null;
  // An injected database has no domains service behind it.
  // An injected database has no sample table behind it: nothing is measured.
  const loadScopedLatency =
    deps.loadScopedLatency ??
    (deps.prisma
      ? async (): Promise<ScopedLatency> => ({
          sampleCount: 0,
          avgMs: null,
          p50Ms: null,
          p95Ms: null,
          p99Ms: null,
        })
      : scopedLatencyLoader());
  const lookupCustomDomains =
    deps.customDomains ?? (deps.prisma ? async () => new Map<string, string>() : servingCustomDomains);
  // The custom endpoint is an extra; failing to read it must not fail the
  // deployment read. Unknown is shown as none.
  const customDomainsFor = async (orgId: string, ids: string[], log: FastifyRequest["log"]) => {
    try {
      return await lookupCustomDomains(orgId, ids);
    } catch (err) {
      log.warn({ err }, "Custom domains of deployments could not be read");
      return new Map<string, string>();
    }
  };
  // Built on first use: it reads the environment.
  let adapterServingDeps = deps.adapterServing ?? null;
  const adapterServing = () => (adapterServingDeps ??= buildAdapterServingDeps());
  const submit =
    deps.submit ??
    ((deploymentId, config, gpuTier, replicas, runGeneration) =>
      submitToNosana(
        { prisma, getNosana, now },
        deploymentId,
        config,
        gpuTier,
        replicas,
        runGeneration,
      ));

  return async (app) => {
    /**
     * List deployments
     */
    app.get("/", { preHandler: [requireAuth] }, async (request, _reply) => {
      const { orgId } = request.auth!;

      const deployments = await prisma.deployment.findMany({
        where: { orgId },
        include: {
          model: {
            select: {
              displayName: true,
              pricingTier: true,
            },
          },
          fineTunedModel: { select: { id: true, name: true, slug: true } },
          nodes: {
            select: {
              id: true,
              healthStatus: true,
              latencyMs: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      const customDomains = await customDomainsFor(
        orgId,
        deployments.filter((d) => d.status === "running").map((d) => d.id),
        request.log,
      );

      return {
        deployments: deployments.map((d) => ({
          id: d.id,
          name: d.name,
          slug: d.slug,
          model: d.model.displayName,
          // The adapter served on top of `model`, when there is one.
          fineTunedModel: d.fineTunedModel ?? null,
          engine: d.engine,
          gpuTier: d.gpuTier,
          replicas: d.replicas,
          status: d.status,
          statusReason: d.statusReason,
          endpoint: d.status === "running" ? deploymentEndpoint(d.slug) : null,
          customEndpoint: customDomains.has(d.id) ? customDomainEndpoint(customDomains.get(d.id)!) : null,
          healthyNodes: d.nodes.filter((n) => n.healthStatus === "healthy").length,
          totalNodes: d.nodes.length,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        })),
        total: deployments.length,
      };
    });

    /**
     * Get single deployment
     */
    app.get(
      "/:deploymentId",
      { preHandler: [requireAuth] },
      async (request, reply) => {
        const { orgId } = request.auth!;
        const { deploymentId } = z
          .object({ deploymentId: z.string() })
          .parse(request.params);

        const deployment = await prisma.deployment.findFirst({
          where: { id: deploymentId, orgId },
          include: {
            model: true,
            fineTunedModel: { select: { id: true, name: true, slug: true } },
            nodes: true,
          },
        });

        if (!deployment) {
          return reply.notFound("Deployment not found");
        }
        const customDomain =
          deployment.status === "running"
            ? (await customDomainsFor(orgId, [deployment.id], request.log)).get(deployment.id)
            : undefined;

        return {
          deployment: {
            ...ownerView(deployment),
            fineTunedModel: deployment.fineTunedModel ?? null,
            config: { ...DEFAULT_DEPLOYMENT_CONFIG, ...(deployment.config as Record<string, unknown> | null) },
            // Raw Nosana node URLs are unauthenticated GPU endpoints that would
            // bypass metering - callers go through `endpoint` (our /v1 proxy).
            nodes: deployment.nodes.map(({ nodeUrl: _nodeUrl, nosanaNodeId: _id, ...node }) => node),
            endpoint:
              deployment.status === "running"
                ? deploymentEndpoint(deployment.slug)
                : null,
            customEndpoint: customDomain ? customDomainEndpoint(customDomain) : null,
          },
        };
      }
    );

    /**
     * Create deployment
     */
    app.post("/", { preHandler: [requireAuth] }, async (request, reply) => {
      const { orgId } = request.auth!;
      const body = createDeploymentSchema.parse(request.body);

      // A fine-tuned model: it must be this organization's, ready, served by
      // vLLM, on a tier its base model fits, and this server must be
      // reachable from a GPU node (the container fetches the adapter from
      // here). All refused before the pre-flight and before anything is
      // reserved. The base model comes from the fine-tuned model.
      let fineTuned: Extract<Awaited<ReturnType<typeof prepareAdapterServing>>, { ok: true }> | null = null;
      if (body.fineTunedModelId) {
        const prepared = await prepareAdapterServing(
          { prisma, serving: adapterServing() },
          {
            orgId,
            fineTunedModelId: body.fineTunedModelId,
            engine: body.engine,
            gpuTier: body.gpuTier,
          },
        );
        if (!prepared.ok) {
          return reply.status(prepared.status).send({
            error: prepared.code,
            message: prepared.message,
            ...(prepared.requiredVramGb !== undefined && { requiredVramGb: prepared.requiredVramGb }),
          });
        }
        if (body.modelId !== undefined && body.modelId !== prepared.fineTunedModel.baseModelId) {
          return reply.status(400).send({
            error: "fine_tuned_model_base_mismatch",
            message: `This fine-tuned model was trained on '${prepared.fineTunedModel.baseModelId}'; leave modelId out or send that id.`,
          });
        }
        fineTuned = prepared;
      }
      const modelId = fineTuned?.fineTunedModel.baseModelId ?? body.modelId;
      if (modelId === undefined) {
        return reply.badRequest("modelId is required");
      }

      // Verify model exists
      const model = await prisma.model.findUnique({
        where: { id: modelId },
      });

      if (!model) {
        return reply.badRequest(`Model '${modelId}' not found`);
      }

      // Pre-flight BEFORE any credits are reserved: an unconfigured platform
      // (no Nosana credential, or no market for this GPU tier on this network)
      // answers 501 rather than taking money for a deployment that cannot run,
      // and a platform that cannot pay for the GPU right now answers 503.
      try {
        await runDeployPreflight(await getNosana(), body.gpuTier, body.replicas);
      } catch (err) {
        if (replyForPreflightError(reply, err)) return reply;
        throw err;
      }

      // A4: Nosana jobs are platform-paid — gate admission on a per-org
      // active-deployment quota and a credit reservation.
      const activeCount = await prisma.deployment.count({
        where: {
          orgId,
          status: { in: ACTIVE_STATUSES },
        },
      });
      if (activeCount >= env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG) {
        return reply.status(429).send({
          error: "deployment_quota_exceeded",
          message: `Organization already has ${activeCount} active deployments (limit ${env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG}).`,
        });
      }

      // Generate slug from name
      const baseSlug = body.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

      // A name with no ASCII letters or digits slugifies to "": that slug
      // has no /v1/<slug> path, so such a deployment gets a generated one.
      const rootSlug =
        baseSlug.length > 0 ? baseSlug : `deployment-${randomUUID().slice(0, 6)}`;

      // Ensure slug is unique for this org
      let slug = rootSlug;
      let counter = 0;
      while (
        await prisma.deployment.findUnique({
          where: { orgId_slug: { orgId, slug } },
        })
      ) {
        counter++;
        slug = `${rootSlug}-${counter}`;
      }

      const config = body.config ?? { ...DEFAULT_DEPLOYMENT_CONFIG };

      // The adapter URL names the deployment, so such a deployment's id is
      // chosen here: the URL is then built before the transaction, and nothing
      // after the reservation can refuse.
      const fineTunedDeploymentId = fineTuned ? randomUUID() : null;
      const adapter =
        fineTuned && fineTunedDeploymentId
          ? adapterForRun(adapterServing(), fineTuned.fineTunedModel, {
              deploymentId: fineTunedDeploymentId,
              // A new row's first run (the column's default).
              runGeneration: 0,
            })
          : undefined;

      // Create the deployment and take its credit reservation in ONE
      // transaction. Reserving first in a separate transaction meant a
      // failure before the row existed left the org charged with nothing to
      // show for it — and the old `deploy:<model>:<timestamp>` reference
      // could not be traced back to any deployment, so the money was
      // unrecoverable even by hand. The reserved amount is stored on the
      // row so the release refunds exactly what was held.
      let deployment: {
        id: string;
        name: string;
        slug: string;
        status: string;
        runGeneration: number;
      };
      try {
        deployment = await prisma.$transaction(async (tx) => {
          // Still ready, and locked against a delete racing this admission.
          if (
            fineTuned &&
            !(await lockReadyFineTunedModel(tx as never, {
              id: fineTuned.fineTunedModel.id,
              orgId,
              now: now(),
            }))
          ) {
            throw new FineTunedModelGoneError();
          }

          const created = await tx.deployment.create({
            data: {
              ...(fineTuned && fineTunedDeploymentId
                ? { id: fineTunedDeploymentId, fineTunedModelId: fineTuned.fineTunedModel.id, runGeneration: 0 }
                : {}),
              orgId,
              name: body.name,
              slug,
              modelId,
              engine: body.engine,
              gpuTier: body.gpuTier,
              replicas: body.replicas,
              config,
              status: "pending",
              nosanaJobIds: [],
            },
          });

          const reservation = await reserveDeploymentCredits({
            tx: tx as never,
            orgId,
            gpuTier: body.gpuTier,
            replicas: body.replicas,
            referenceId: created.id,
          });
          if (!reservation.ok) {
            // Roll the deployment back with the failed admission.
            throw new InsufficientCreditsError(reservation.requiredCents);
          }

          await tx.deployment.update({
            where: { id: created.id },
            data: { reservationCents: reservation.reservedCents },
          });
          return created;
        });
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return reply.status(402).send({
            error: "insufficient_credits",
            message: `Deploying requires a reservation of $${(
              Number(err.requiredCents) / 100
            ).toFixed(2)} in credits. Add credits and retry.`,
          });
        }
        if (err instanceof FineTunedModelGoneError) {
          return reply.status(409).send({
            error: "fine_tuned_model_not_ready",
            message: "This fine-tuned model has been deleted and can no longer be deployed.",
          });
        }
        throw err;
      }

      logger.info(
        { deploymentId: deployment.id, modelId },
        "Deployment created"
      );

      // Submit to Nosana (async)
      submit(
        deployment.id,
        {
          modelId,
          hfModelId: model.hfId,
          engine: body.engine,
          maxTokens: config.maxTokens,
          gpuMemoryUtilization: config.gpuMemoryUtilization,
          ...(adapter ? { adapter } : {}),
        },
        body.gpuTier,
        body.replicas,
        deployment.runGeneration,
      ).catch((err) => {
        logger.error({ err, deploymentId: deployment.id }, "Failed to submit to Nosana");
      });

      triggerWebhook(
        orgId,
        "deployment.started",
        { deploymentId: deployment.id, name: deployment.name, slug: deployment.slug },
        "deployment",
        deployment.id,
      ).catch((err) => logger.error({ err }, "webhook deployment.started failed"));

      reply.status(201);
      return {
        deployment: {
          id: deployment.id,
          name: deployment.name,
          slug: deployment.slug,
          status: deployment.status,
          ...(fineTuned && { fineTunedModelId: fineTuned.fineTunedModel.id }),
        },
        message: "Deployment created. Provisioning GPU node...",
      };
    });

    /**
     * Update deployment (scale, config changes)
     *
     * Replica changes are real: the Nosana deployment is scaled (extra replicas
     * are funded first) and the credit reservation follows. They are only
     * possible while the deployment is running, and one at a time: the change
     * is a claim on the row until Nosana has answered (409
     * replica_change_in_progress for an overlapping request). `replicas` moves
     * only once Nosana confirmed the new count. Config changes are stored and
     * take effect on the next restart - the running job is not modified.
     */
    app.patch(
      "/:deploymentId",
      { preHandler: [requireAuth] },
      async (request, reply) => {
        const { orgId } = request.auth!;
        const { deploymentId } = z
          .object({ deploymentId: z.string() })
          .parse(request.params);
        const updates = updateDeploymentSchema.parse(request.body);

        const deployment = await prisma.deployment.findFirst({
          where: { id: deploymentId, orgId },
        });

        if (!deployment) {
          return reply.notFound("Deployment not found");
        }

        const newReplicas = updates.replicas;
        if (newReplicas !== undefined && deployment.replicaChangeId) {
          // Also when the request names the current count: that count is about
          // to change, so "already there" would be a false answer.
          replyReplicaClaimError(reply, new ReplicaChangeInProgressError(), "");
          return reply;
        }
        if (newReplicas !== undefined && newReplicas !== deployment.replicas) {
          const nosanaId = deployment.nosanaJobIds[0];
          if (deployment.status !== "running" || !nosanaId) {
            return reply.status(409).send({
              error: "deployment_not_running",
              message: `Replicas can only be changed while a deployment is running (status: ${deployment.status}).`,
            });
          }

          const nosana = await getNosana();
          const change: ReplicaChange = {
            deploymentId,
            orgId,
            gpuTier: deployment.gpuTier,
            runGeneration: deployment.runGeneration,
            nosanaId,
            accessMode: rowAccessMode(deployment.nosanaAccessMode),
            from: deployment.replicas,
            to: newReplicas,
            changeId: randomUUID(),
          };
          const what =
            newReplicas > deployment.replicas
              ? `Adding ${newReplicas - deployment.replicas} replica(s)`
              : `Removing ${deployment.replicas - newReplicas} replica(s)`;

          // 1. Claim the change (see claimReplicaChange). The confirmed count
          //    stays where it is, so billing keeps charging what Nosana really
          //    runs for as long as the call below takes.
          let heldCents = 0n;
          try {
            heldCents = await prisma.$transaction((tx) =>
              claimReplicaChange(tx as unknown as ReplicaChangeTx, change, now()),
            );
          } catch (err) {
            if (replyReplicaClaimError(reply, err, what)) return reply;
            throw err;
          }

          // 2. Ask Nosana. true = applied, false = not applied, null = unknown.
          let applied: boolean | null = true;
          let scaleError: unknown;
          try {
            await nosana.scaleDeployment(
              nosanaId,
              newReplicas,
              deployment.gpuTier,
              change.accessMode,
            );
          } catch (err) {
            scaleError = err;
            applied = await replicaChangeOutcome(nosana, change, err);
            logger.error({ err, deploymentId, applied }, "Nosana replica change failed");
          }

          if (applied === null) {
            // Nosana may or may not run the new count. The claim stays on the
            // row: guessing either way would bill a count that is not running.
            // The status worker resolves it from Nosana's real replica count.
            return reply.status(502).send({
              error: "nosana_scale_unconfirmed",
              message:
                "Nosana did not confirm the replica change and its state could not be read. The deployment keeps its current replica count until the change is reconciled, which takes a few minutes.",
            });
          }

          if (!applied) {
            // 3a. Not applied: drop the claim (and a scale-up's hold with it).
            const cleared = await prisma
              .$transaction((tx) =>
                clearReplicaChange(tx as unknown as ReplicaChangeTx, change, heldCents),
              )
              .then(() => true)
              .catch((clearErr) => {
                logger.error(
                  { err: clearErr, deploymentId },
                  "Failed to clear a replica change Nosana refused; the status worker will",
                );
                return false;
              });
            if (
              scaleError instanceof NosanaLifecycleError &&
              scaleError.code === "nosana_not_running"
            ) {
              return reply.status(409).send({
                error: "deployment_not_running",
                message: "The Nosana deployment is not running; replicas were not changed.",
              });
            }
            if (isAccessModeUnavailable(scaleError)) {
              return reply.status(409).send(OTHER_ACCOUNT_REPLY);
            }
            // The platform's funding refused the added replicas.
            const refusal = computeRefusal(scaleError);
            if (refusal) {
              return reply.status(refusal.status).send({
                ...refusal.body,
                message:
                  "Replicas cannot be added right now because new GPU deployments are temporarily unavailable. Replicas were not changed, and nothing was reserved or charged.",
              });
            }
            return reply.status(502).send({
              error: "nosana_scale_failed",
              message: cleared
                ? "Nosana could not scale the deployment; replicas were not changed."
                : "Nosana could not scale the deployment; replicas were not changed. The pending change could not be cleared and will be within a few minutes - further replica changes are refused until then.",
            });
          }

          // 3b. Applied: commit the count, the old-count window and the hold
          //     together. If this throws the claim is still on the row and the
          //     status worker commits the count Nosana reports.
          const committed = await prisma.$transaction((tx) =>
            commitReplicaChange(tx as unknown as ReplicaChangeTx, change, now()),
          );
          if (!committed) {
            // Not ours any more (stopped, restarted, or already reconciled).
            // Whoever took the row owns its hold; only tidy our own claim.
            await prisma.deployment
              .updateMany({
                where: { id: deploymentId, replicaChangeId: change.changeId },
                data: NO_REPLICA_CHANGE,
              })
              .catch((err) =>
                logger.error({ err, deploymentId }, "Failed to clear a superseded replica change"),
              );
            return reply.status(409).send({
              error: "deployment_conflict",
              message: "The deployment changed while scaling; retry.",
            });
          }
        }

        if (updates.config) {
          await prisma.deployment.update({
            where: { id: deploymentId },
            data: {
              config: { ...(deployment.config as any), ...updates.config },
            },
          });
        }

        const updatedDeployment = await prisma.deployment.findFirst({
          where: { id: deploymentId, orgId },
        });
        return {
          deployment: updatedDeployment ? ownerView(updatedDeployment) : updatedDeployment,
          ...(updates.config
            ? { note: "Config changes apply the next time the deployment is restarted." }
            : {}),
        };
      }
    );

    /**
     * Delete/stop deployment
     *
     * Order matters: the GPU is stopped on Nosana FIRST. If that fails the row
     * stays as it was (and the platform keeps paying), so the caller gets a 502
     * and retries - marking a still-running deployment `stopped` would hide it
     * from every safeguard. Once Nosana confirms, one transaction marks the row
     * stopped, gives the admission reservation back (exactly once, via its
     * reservationReleasedAt CAS), settles the final unbilled GPU window and
     * removes the nodes.
     *
     * The Nosana stop is slow (stop + on-chain withdraw), so the claim names the
     * RUN that was stopped: the generation and the Nosana id this request read.
     * A row that was stopped and restarted meanwhile is a different run - it
     * must not be marked stopped, lose its hold, or be stamped with this run's
     * vault result.
     *
     * One exception to "Nosana first": a run created by a compute account this
     * process holds no credential for cannot be stopped from here by any retry,
     * and the billing worker does not charge for it either. Refusing would
     * leave the owner with a deployment they can never end, so the row is
     * marked stopped and the hold released WITHOUT a final charge. The row
     * keeps its Nosana id and its access-mode stamp with no reclaim stamp: the
     * status worker's sweep stops and releases it once the credential is back,
     * and until then the operator view lists it as unreachable.
     */
    app.delete(
      "/:deploymentId",
      { preHandler: [requireAuth] },
      async (request, reply) => {
        const { orgId } = request.auth!;
        const { deploymentId } = z
          .object({ deploymentId: z.string() })
          .parse(request.params);

        const deployment = await prisma.deployment.findFirst({
          where: { id: deploymentId, orgId },
        });

        if (!deployment) {
          return reply.notFound("Deployment not found");
        }

        if (!STOPPABLE_STATUSES.includes(deployment.status)) {
          // Already terminal: whoever moved it released the hold. Idempotent.
          return { message: "Deployment already stopped" };
        }

        const nosanaId = deployment.nosanaJobIds[0];
        const thisRun = {
          id: deploymentId,
          runGeneration: deployment.runGeneration,
          // Also the id slot as read: a submit that stored its Nosana id after
          // this request loaded an id-less row would otherwise be marked
          // stopped without that deployment ever being stopped.
          nosanaJobIds: nosanaId ? { has: nosanaId } : { isEmpty: true },
        };

        // 1. Stop the GPU on Nosana.
        let reclaimed = true;
        // Nosana had already stopped it before this call: when is not known.
        let alreadyStopped = false;
        // No credential here for the account that created it (see above).
        let unreachable = false;
        if (nosanaId) {
          try {
            const nosana = await getNosana();
            // Through the credential that created it, whatever the primary
            // mode is today.
            const stop = await nosana.stopDeployment(
              nosanaId,
              rowAccessMode(deployment.nosanaAccessMode),
            );
            reclaimed = stop.reclaimed;
            alreadyStopped = stop.alreadyStopped === true;
          } catch (err) {
            if (isAccessModeUnavailable(err)) {
              unreachable = true;
              reclaimed = false;
              logger.error(
                {
                  deploymentId,
                  nosanaId,
                  accessMode: rowAccessMode(deployment.nosanaAccessMode),
                },
                "Owner stopped a deployment whose compute account has no credential here: NOT stopped on Nosana - it stays for the reclaim sweep and the operator view",
              );
            } else {
              logger.error({ err, deploymentId, nosanaId }, "Failed to stop Nosana deployment");
              return reply.status(502).send({
                error: "nosana_stop_failed",
                message:
                  "Nosana did not confirm the stop. The deployment was left as it was; retry shortly.",
              });
            }
          }
        }

        // Record when the GPUs stopped, on its own, before the transaction
        // below. If that transaction fails the row stays as it was and the
        // request is retried later; the retry (or the status worker) must end
        // the final window HERE, not at its own clock. Set once per run.
        const stoppedAt = now();
        // Not for an unreachable run: nothing confirmed that its GPUs stopped.
        if (nosanaId && !alreadyStopped && !unreachable) {
          await prisma.deployment
            .updateMany({
              where: { ...thisRun, status: { in: STOPPABLE_STATUSES }, gpuStoppedAt: null },
              data: { gpuStoppedAt: stoppedAt },
            })
            .catch((err) =>
              logger.error({ err, deploymentId, nosanaId }, "Failed to record the GPU stop time"),
            );
        }

        // 2. One transaction: status CAS, reservation release, final GPU window.
        const claimedStop = await prisma.$transaction(async (tx) => {
          const stopData = {
            status: "stopped",
            stoppedAt,
            statusReason: OWNER_STOP_REASON,
            // Explicit either way: never inherit a stale "recovered" stamp from
            // an earlier run (the status worker's sweep keys off it).
            vaultReclaimedAt: nosanaId && reclaimed ? stoppedAt : null,
          };

          // Claim from `running` FIRST, on its own. Only a stop that took the
          // row out of `running` bills the tail of the GPU time: from
          // `degraded` the cursor is stale (the degrade edge already settled
          // everything up to it, and a degraded stretch is never billed), so
          // final-billing from there would charge time with no live endpoint.
          //
          // The other statuses are claimed WITHOUT `running`, and `running` is
          // then tried once more: the first claim takes no lock when it misses,
          // so the status worker can move a degraded row back to `running`
          // between the two. A claim over all stoppable statuses would stop
          // that row as "was not running" and skip the window since recovery.
          let wasRunning = false;
          let claimed = false;
          for (const status of ["running", { in: STOPPABLE_NOT_RUNNING }, "running"] as const) {
            const stop = await tx.deployment.updateMany({
              where: { ...thisRun, status },
              data: stopData,
            });
            if (stop.count > 0) {
              claimed = true;
              wasRunning = status === "running";
              break;
            }
          }
          // Another writer moved the row while Nosana was stopping. It owns
          // the release and the final settlement of whatever it moved.
          if (!claimed) return false;

          // Read fresh under the lock the claim took: a replica change or a
          // billing tick may have moved the cursor / replicas / hold since the
          // request loaded the row.
          const fresh = await tx.deployment.findUnique({
            where: { id: deploymentId },
            select: {
              reservationCents: true,
              reservationReleasedAt: true,
              billedThroughAt: true,
              replicas: true,
              gpuTier: true,
              gpuStoppedAt: true,
            },
          });

          // Release the hold first so it can cover the final window. The
          // release is its own CAS, so this is safe even when the status tick
          // (or a retried request) got here before us.
          if (
            fresh?.reservationCents &&
            fresh.reservationCents > 0n &&
            !fresh.reservationReleasedAt
          ) {
            await releaseDeploymentReservation({
              tx: tx as never,
              kind: "model",
              deploymentId,
              orgId,
              reservationCents: fresh.reservationCents,
              reason: "user_stopped",
              now: () => stoppedAt,
              onlyIfStatusIn: TERMINAL_STATUSES,
            });
          }

          // Final window, up to when the GPUs stopped: the recorded stop time
          // (this request's, or an earlier attempt's whose transaction failed).
          // With neither - Nosana had stopped it already at an unknown time -
          // the window ends at the cursor: time after the stop is not billed.
          // An unreachable run is not billed at all: it could not be observed.
          const windowEnd = unreachable
            ? null
            : (fresh?.gpuStoppedAt ?? (alreadyStopped ? null : stoppedAt));
          if (wasRunning && fresh?.billedThroughAt && windowEnd) {
            const settled = await chargeGpuWindow(tx as unknown as GpuBillingTx, {
              deploymentId,
              orgId,
              gpuTier: fresh.gpuTier,
              replicas: fresh.replicas,
              billedThroughAt: fresh.billedThroughAt,
              now: windowEnd,
              mode: "final",
              pricePerSecondUsd: getPricePerSecond,
            });
            // Cannot happen under the claim's row lock. If it does the stop
            // must not commit with its final window unbilled: roll back.
            if (settled.kind === "cursor_lost") throw new DeploymentConflictError();
          }

          await tx.deploymentNode.deleteMany({ where: { deploymentId } });
          return true;
        });

        if (!claimedStop) {
          // The withdraw this request verified still belongs to its own run:
          // stamp it there (same shape as the vault sweep's CAS), never on a
          // later run.
          if (nosanaId && reclaimed) {
            await prisma.deployment
              .updateMany({
                where: {
                  id: deploymentId,
                  runGeneration: deployment.runGeneration,
                  status: { in: TERMINAL_STATUSES },
                  nosanaJobIds: { has: nosanaId },
                  vaultReclaimedAt: null,
                },
                data: { vaultReclaimedAt: stoppedAt },
              })
              .catch((err) =>
                logger.error({ err, deploymentId, nosanaId }, "Failed to record the vault reclaim"),
              );
          }
          const current = await prisma.deployment.findFirst({
            where: { id: deploymentId, orgId },
          });
          if (
            current &&
            current.runGeneration === deployment.runGeneration &&
            TERMINAL_STATUSES.includes(current.status)
          ) {
            // Same run, ended by someone else (a retried request, the status
            // or billing worker). Idempotent.
            return { message: "Deployment already stopped" };
          }
          return reply.status(409).send({
            error: "deployment_conflict",
            message: "The deployment changed while it was being stopped; retry.",
          });
        }

        logger.info({ deploymentId, reclaimed }, "Deployment stopped");

        triggerWebhook(
          orgId,
          "deployment.stopped",
          { deploymentId, name: deployment.name },
          "deployment",
          deploymentId,
        ).catch((err) => logger.error({ err }, "webhook deployment.stopped failed"));

        return {
          message: "Deployment stopped",
          // false: Nosana is still winding the jobs down; the status worker
          // keeps retrying until the platform's funding is confirmed released
          // (a vault withdraw with wallet access; with an API key, Nosana
          // reporting the deployment stopped).
          fundsReleased: reclaimed,
          // The same value under its first name, kept for existing clients.
          vaultReclaimed: reclaimed,
        };
      }
    );

    /**
     * Restart deployment
     *
     * Only a stopped or failed deployment can be restarted. A restart is a NEW
     * Nosana deployment, so it takes a fresh credit reservation and re-checks
     * the org quota; the previous run's hold (if somehow still held) is
     * released first, and the previous run's vault must be reclaimed before its
     * id is forgotten.
     *
     * The claim bumps runGeneration: that is what makes every late write of the
     * previous run (a slow submit, stop, status or billing tick) miss this one.
     */
    app.post(
      "/:deploymentId/restart",
      { preHandler: [requireAuth] },
      async (request, reply) => {
        const { orgId } = request.auth!;
        const { deploymentId } = z
          .object({ deploymentId: z.string() })
          .parse(request.params);

        const restarted = await restartModelDeployment(
          {
            prisma,
            getNosana,
            now,
            submit,
            maxActiveDeployments: env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG,
            ...(deps.adapterServing ? { adapterServing: deps.adapterServing } : {}),
          },
          { deploymentId, orgId },
        );
        if (!restarted.ok) {
          switch (restarted.code) {
            case "not_found":
              return reply.notFound("Deployment not found");
            case "preflight_failed":
              if (replyForPreflightError(reply, restarted.error)) return reply;
              throw restarted.error;
            case "adapter_serving_refused":
              return reply
                .status(restarted.refusal.status)
                .send({ error: restarted.refusal.code, message: restarted.refusal.message });
            case "deployment_quota_exceeded":
              return reply.status(429).send({ error: restarted.code, message: restarted.message });
            case "insufficient_credits":
              return reply.status(402).send({ error: restarted.code, message: restarted.message });
            default:
              return reply.status(409).send({ error: restarted.code, message: restarted.message });
          }
        }

        return {
          message: "Deployment restarting",
          deployment: { id: deploymentId, status: "pending" },
        };
      }
    );

    /**
     * Get deployment logs
     *
     * What @nosana/sdk 0.4.74 exposes is the deployment's LIFECYCLE EVENTS
     * (`deployment.events`: started, job listed, extended, stopped, errors) -
     * there is no container stdout/stderr API. Those real events are returned;
     * nothing is ever synthesised. A deployment with no Nosana deployment yet has
     * no events (empty list); a mock one cannot have logs (501).
     */
    app.get(
      "/:deploymentId/logs",
      { preHandler: [requireAuth] },
      async (request, reply) => {
        const { orgId } = request.auth!;
        const { deploymentId } = z
          .object({ deploymentId: z.string() })
          .parse(request.params);
        const { lines } = z
          .object({
            lines: z.coerce.number().int().min(10).max(1000).default(100),
          })
          .parse(request.query);

        const deployment = await prisma.deployment.findFirst({
          where: { id: deploymentId, orgId },
        });

        if (!deployment) {
          return reply.notFound("Deployment not found");
        }

        const source = "nosana_deployment_events";
        const note =
          "Lifecycle events reported by Nosana for this deployment. Container stdout/stderr is not exposed by the Nosana SDK.";

        const nosanaId = deployment.nosanaJobIds[0];
        if (!nosanaId) {
          return { deploymentId, source, note, logs: [] };
        }
        if (isMockNosanaId(nosanaId)) {
          return reply.status(501).send({
            error: "logs_not_available",
            message: "This is a development mock deployment; there is nothing to read logs from.",
          });
        }

        try {
          const snapshot = await (await getNosana()).getDeploymentStatus(
            nosanaId,
            rowAccessMode(deployment.nosanaAccessMode),
          );
          const events = [...snapshot.events]
            .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
            .slice(-lines);
          return {
            deploymentId,
            source,
            note,
            logs: events.map((event) => ({
              timestamp: event.createdAt,
              level: /error|fail|insufficient/i.test(`${event.type} ${event.message}`)
                ? "error"
                : "info",
              type: event.type,
              message: event.message,
              ...(event.tx ? { tx: event.tx } : {}),
            })),
          };
        } catch (err) {
          logger.error({ err, deploymentId }, "Failed to read Nosana deployment events");
          return reply.status(502).send({
            error: "nosana_unavailable",
            message: "Could not read the deployment's events from Nosana. Retry shortly.",
          });
        }
      }
    );

    /**
     * Get deployment metrics
     */
    app.get(
      "/:deploymentId/metrics",
      { preHandler: [requireAuth] },
      async (request, reply) => {
        const { orgId } = request.auth!;
        const { deploymentId } = z
          .object({ deploymentId: z.string() })
          .parse(request.params);

        const deployment = await prisma.deployment.findFirst({
          where: { id: deploymentId, orgId },
        });

        if (!deployment) {
          return reply.notFound("Deployment not found");
        }

        // Get usage records for last 24 hours
        const until = now();
        const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);

        const usageRecords = await prisma.usageRecord.findMany({
          where: {
            deploymentId,
            periodStart: { gte: since },
          },
          orderBy: { periodStart: "asc" },
        });

        // Aggregate metrics
        const totals = usageRecords.reduce(
          (acc, r) => ({
            requests: acc.requests + r.requestCount,
            inputTokens: acc.inputTokens + Number(r.inputTokens),
            outputTokens: acc.outputTokens + Number(r.outputTokens),
            errors: acc.errors + r.errorCount,
          }),
          { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0 }
        );

        // Latency is the end-to-end time of the answered requests themselves,
        // over the same 24 hours. With none measured it is null: a
        // deployment nobody called did not answer in 0 ms.
        const latency = await loadScopedLatency({
          orgId,
          since,
          until,
          outcomes: ["ok"],
          deploymentIds: [deployment.id],
        });

        return {
          deploymentId,
          period: "24h",
          metrics: {
            requests: totals.requests,
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            avgLatencyMs: latency.avgMs,
            p50LatencyMs: latency.p50Ms,
            p95LatencyMs: latency.p95Ms,
            latencySampleCount: latency.sampleCount,
            errorRate:
              totals.requests > 0
                ? (totals.errors / totals.requests) * 100
                : 0,
          },
          byHour: usageRecords.map((r) => ({
            period: r.periodStart.toISOString(),
            requests: r.requestCount,
            inputTokens: Number(r.inputTokens),
            outputTokens: Number(r.outputTokens),
          })),
        };
      }
    );

    /**
     * Playground chat endpoint - the dashboard's way into a deployment.
     *
     * The same handler as POST /v1/:deploymentSlug/chat/completions, named by
     * id instead of slug. It used to be a second node proxy of its own, which
     * sent the engine no `model` (so vLLM refused every request), never
     * streamed, and skipped the GPU-billing admission checks the /v1 route
     * makes. One handler cannot drift from itself.
     */
    app.post(
      "/:deploymentId/chat",
      { preHandler: [requireAuth], bodyLimit: 4 * 1024 * 1024 },
      async (request, reply) => {
        const { deploymentId } = z
          .object({ deploymentId: z.string().uuid() })
          .parse(request.params);
        // Same handler, its own surface: dashboard chats are told apart
        // from API traffic in the latency samples.
        chatCompletion ??= createDeploymentCompletionHandler({ surface: "deployment_chat" });
        return chatCompletion(request, reply, { deploymentId });
      }
    );
  };
}

export const deploymentRoutes: FastifyPluginAsync = createDeploymentRoutes();
