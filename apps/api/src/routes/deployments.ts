import { randomUUID } from "node:crypto";

import { FastifyPluginAsync, FastifyReply } from "fastify";
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
import { deploymentEndpoint as buildDeploymentEndpoint } from "../services/publicEndpoints.js";
import { getNosanaDeployConfig } from "../config/nosanaDeploy.js";
import {
  MarketNotConfiguredError,
  NosanaNotConfiguredError,
  generateJobDefinition,
  getNosanaClient,
  isMockNosanaId,
  type ModelDeploymentConfig,
  type NosanaClient,
} from "../services/nosana.js";
import { NosanaLifecycleError } from "../services/nosanaDeploymentLifecycle.js";
import { recordNosanaOrphan, type NosanaOrphanPrisma } from "../services/nosanaOrphans.js";
import {
  holdAdditionalReplicas,
  releaseDeploymentReservation,
  reserveDeploymentCredits,
  returnReplicaReservation,
  estimateDeploymentReservationCents,
} from "../services/deploymentCreditGate.js";
import { getPricePerSecond } from "../services/computeMetering.js";
import {
  InsufficientGpuCreditsError,
  chargeGpuWindow,
  type GpuBillingTx,
} from "../services/gpuBilling.js";

const logger = createLogger("deployment-routes");

/**
 * Signals a failed admission from inside a transaction, so the row changes roll
 * back with it instead of being left half-applied.
 */
class InsufficientCreditsError extends Error {
  constructor(readonly requiredCents: bigint) {
    super("insufficient_credits");
  }
}

/** A concurrent writer changed the deployment under a compare-and-set. */
class DeploymentConflictError extends Error {
  constructor(message = "deployment_conflict") {
    super(message);
  }
}

/** Another replica change already holds the claim on the deployment. */
class ReplicaChangeInProgressError extends Error {
  constructor() {
    super("replica_change_in_progress");
  }
}

/** Statuses from which a model deployment can still be stopped. */
const STOPPABLE_STATUSES = ["pending", "provisioning", "running", "degraded"];
const STOPPABLE_NOT_RUNNING = STOPPABLE_STATUSES.filter((status) => status !== "running");
/** Statuses that count against the per-org active quota. */
const ACTIVE_STATUSES = ["pending", "building", "deploying", "provisioning", "running", "degraded"];
const RESTARTABLE_STATUSES = ["stopped", "failed"];
/** A credit hold is only released while the row is terminal (see releaseDeploymentReservation). */
const TERMINAL_STATUSES = ["stopped", "failed"];

// ============================================
// Schemas
// ============================================

const createDeploymentSchema = z.object({
  name: z.string().min(3).max(50),
  modelId: z.string(),
  gpuTier: z.string(),
  engine: z.enum(["vllm", "ollama"]).default("vllm"),
  replicas: z.number().int().min(1).max(10).default(1),
  config: z
    .object({
      maxTokens: z.number().int().min(256).max(32768).default(4096),
      gpuMemoryUtilization: z.number().min(0.5).max(0.95).default(0.9),
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

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function failureReason(error: unknown): string {
  if (error instanceof NosanaLifecycleError) {
    return truncate(`${error.code}: ${error.message}`);
  }
  return truncate(error instanceof Error ? error.message : "submit_failed");
}

/**
 * Maps a pre-flight failure onto an honest HTTP answer. Returns true when it
 * replied. Unconfigured means 501, never a fabricated success.
 */
function replyForPreflightError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof NosanaNotConfiguredError) {
    reply.status(501).send({ error: error.code, message: error.message });
    return true;
  }
  if (error instanceof MarketNotConfiguredError) {
    if (error.code === "unknown_tier") {
      reply.status(400).send({ error: "unknown_gpu_tier", message: error.message });
    } else {
      reply.status(501).send({ error: "gpu_market_not_configured", message: error.message });
    }
    return true;
  }
  return false;
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
  from: number;
  to: number;
  /** This request's claim token (Deployment.replicaChangeId). */
  changeId: string;
}

const NO_REPLICA_CHANGE = {
  pendingReplicas: null,
  replicaChangeId: null,
  replicaChangeAt: null,
  replicaChangeHoldCents: null,
};

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
  try {
    const { replicas } = await nosana.getDeploymentStatus(change.nosanaId);
    if (replicas === change.to) return true;
    if (replicas === change.from) return false;
    return null;
  } catch {
    return null;
  }
}

type Db = typeof defaultPrisma;
type NosanaPort = Pick<
  NosanaClient,
  | "assertCanDeploy"
  | "createDeployment"
  | "stopDeployment"
  | "scaleDeployment"
  | "getDeploymentStatus"
  | "reclaimDeploymentVault"
>;

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

      return {
        deployments: deployments.map((d) => ({
          id: d.id,
          name: d.name,
          slug: d.slug,
          model: d.model.displayName,
          engine: d.engine,
          gpuTier: d.gpuTier,
          replicas: d.replicas,
          status: d.status,
          statusReason: d.statusReason,
          endpoint: d.status === "running" ? deploymentEndpoint(d.slug) : null,
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
            nodes: true,
          },
        });

        if (!deployment) {
          return reply.notFound("Deployment not found");
        }

        return {
          deployment: {
            ...deployment,
            // Raw Nosana node URLs are unauthenticated GPU endpoints that would
            // bypass metering - callers go through `endpoint` (our /v1 proxy).
            nodes: deployment.nodes.map(({ nodeUrl: _nodeUrl, nosanaNodeId: _id, ...node }) => node),
            endpoint:
              deployment.status === "running"
                ? deploymentEndpoint(deployment.slug)
                : null,
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

      // Verify model exists
      const model = await prisma.model.findUnique({
        where: { id: body.modelId },
      });

      if (!model) {
        return reply.badRequest(`Model '${body.modelId}' not found`);
      }

      // Pre-flight BEFORE any credits are reserved: an unconfigured platform
      // (no Nosana wallet, or no market for this GPU tier on this network)
      // answers 501 rather than taking money for a deployment that cannot run.
      try {
        (await getNosana()).assertCanDeploy(body.gpuTier);
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

      const config = body.config ?? {
        maxTokens: 4096,
        gpuMemoryUtilization: 0.9,
      };

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
          const created = await tx.deployment.create({
            data: {
              orgId,
              name: body.name,
              slug,
              modelId: body.modelId,
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
        throw err;
      }

      logger.info(
        { deploymentId: deployment.id, modelId: body.modelId },
        "Deployment created"
      );

      // Submit to Nosana (async)
      submit(
        deployment.id,
        {
          modelId: body.modelId,
          hfModelId: model.hfId,
          engine: body.engine,
          maxTokens: config.maxTokens,
          gpuMemoryUtilization: config.gpuMemoryUtilization,
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
            await nosana.scaleDeployment(nosanaId, newReplicas, deployment.gpuTier);
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
          deployment: updatedDeployment,
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
        if (nosanaId) {
          try {
            const nosana = await getNosana();
            const stop = await nosana.stopDeployment(nosanaId);
            reclaimed = stop.reclaimed;
            alreadyStopped = stop.alreadyStopped === true;
          } catch (err) {
            logger.error({ err, deploymentId, nosanaId }, "Failed to stop Nosana deployment");
            return reply.status(502).send({
              error: "nosana_stop_failed",
              message:
                "Nosana did not confirm the stop. The deployment was left as it was; retry shortly.",
            });
          }
        }

        // Record when the GPUs stopped, on its own, before the transaction
        // below. If that transaction fails the row stays as it was and the
        // request is retried later; the retry (or the status worker) must end
        // the final window HERE, not at its own clock. Set once per run.
        const stoppedAt = now();
        if (nosanaId && !alreadyStopped) {
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
            statusReason: "user_stopped",
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
          const windowEnd = fresh?.gpuStoppedAt ?? (alreadyStopped ? null : stoppedAt);
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
          // keeps retrying the vault withdraw.
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

        const deployment = await prisma.deployment.findFirst({
          where: { id: deploymentId, orgId },
          include: { model: true },
        });

        if (!deployment) {
          return reply.notFound("Deployment not found");
        }

        if (!RESTARTABLE_STATUSES.includes(deployment.status)) {
          return reply.status(409).send({
            error: "deployment_not_restartable",
            message: `Only stopped or failed deployments can be restarted (status: ${deployment.status}).`,
          });
        }

        const nosana = await getNosana();
        try {
          nosana.assertCanDeploy(deployment.gpuTier);
        } catch (err) {
          if (replyForPreflightError(reply, err)) return reply;
          throw err;
        }

        const activeCount = await prisma.deployment.count({
          where: { orgId, status: { in: ACTIVE_STATUSES } },
        });
        if (activeCount >= env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG) {
          return reply.status(429).send({
            error: "deployment_quota_exceeded",
            message: `Organization already has ${activeCount} active deployments (limit ${env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG}).`,
          });
        }

        // The previous run's Nosana id is about to be forgotten: make sure its
        // vault funds are back with the platform first, or they would be orphaned.
        const previousId = deployment.nosanaJobIds[0];
        if (previousId && !deployment.vaultReclaimedAt && !isMockNosanaId(previousId)) {
          const outcome = await nosana.reclaimDeploymentVault(previousId).catch(() => null);
          if (!outcome?.reclaimed) {
            return reply.status(409).send({
              error: "previous_run_winding_down",
              message:
                "The previous run is still being wound down on Nosana. Retry in a minute.",
            });
          }
        }

        try {
          await prisma.$transaction(async (tx) => {
            // Claim the restart. Only one concurrent request can win this CAS,
            // and only against the row as this request read it: the same run,
            // still holding exactly the Nosana id whose vault was checked above.
            // An id recorded since (an orphan cleanup, or a faster restart that
            // has already failed) would be forgotten unreclaimed by the reset
            // below; the miss is a 409 and the retry checks that vault first.
            const claimed = await tx.deployment.updateMany({
              where: {
                id: deploymentId,
                status: { in: RESTARTABLE_STATUSES },
                runGeneration: deployment.runGeneration,
                nosanaJobIds: previousId ? { has: previousId } : { isEmpty: true },
              },
              data: {
                runGeneration: { increment: 1 },
                status: "pending",
                stoppedAt: null,
                statusReason: null,
                billedThroughAt: null,
                vaultReclaimedAt: null,
                gpuStoppedAt: null,
                nosanaJobIds: [],
                // A replica change the previous run never finished is void.
                ...NO_REPLICA_CHANGE,
              },
            });
            if (claimed.count === 0) throw new DeploymentConflictError();

            // A previous hold that was never released is refunded, not
            // overwritten (overwriting would lose the org's money).
            const old = await tx.deployment.findUnique({
              where: { id: deploymentId },
              select: { reservationCents: true, reservationReleasedAt: true },
            });
            if (old?.reservationCents && old.reservationCents > 0n && !old.reservationReleasedAt) {
              await releaseDeploymentReservation({
                tx: tx as never,
                kind: "model",
                deploymentId,
                orgId,
                reservationCents: old.reservationCents,
                reason: "restart",
                now,
              });
            }

            const reservation = await reserveDeploymentCredits({
              tx: tx as never,
              orgId,
              gpuTier: deployment.gpuTier,
              replicas: deployment.replicas,
              referenceId: deploymentId,
            });
            if (!reservation.ok) throw new InsufficientCreditsError(reservation.requiredCents);

            await tx.deployment.update({
              where: { id: deploymentId },
              data: {
                reservationCents: reservation.reservedCents,
                reservationReleasedAt: null,
              },
            });
          });
        } catch (err) {
          if (err instanceof InsufficientCreditsError) {
            return reply.status(402).send({
              error: "insufficient_credits",
              message: `Restarting requires a reservation of $${(
                Number(err.requiredCents) / 100
              ).toFixed(2)} in credits. Add credits and retry.`,
            });
          }
          if (err instanceof DeploymentConflictError) {
            return reply.status(409).send({
              error: "deployment_not_restartable",
              message: "The deployment changed while restarting; retry.",
            });
          }
          throw err;
        }

        // Re-submit to Nosana
        const config = (deployment.config ?? {}) as {
          maxTokens?: number;
          gpuMemoryUtilization?: number;
        };
        submit(
          deploymentId,
          {
            modelId: deployment.modelId,
            hfModelId: deployment.model.hfId,
            engine: deployment.engine as "vllm" | "ollama",
            maxTokens: config.maxTokens ?? 4096,
            gpuMemoryUtilization: config.gpuMemoryUtilization ?? 0.9,
          },
          deployment.gpuTier,
          deployment.replicas,
          deployment.runGeneration + 1,
        ).catch((err) => {
          logger.error({ err, deploymentId }, "Failed to restart deployment");
        });

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
          const snapshot = await (await getNosana()).getDeploymentStatus(nosanaId);
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
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

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
            totalLatencyMs: acc.totalLatencyMs + Number(r.totalLatencyMs),
            errors: acc.errors + r.errorCount,
          }),
          { requests: 0, inputTokens: 0, outputTokens: 0, totalLatencyMs: 0, errors: 0 }
        );

        return {
          deploymentId,
          period: "24h",
          metrics: {
            requests: totals.requests,
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            avgLatencyMs:
              totals.requests > 0
                ? Math.round(totals.totalLatencyMs / totals.requests)
                : 0,
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
        chatCompletion ??= createDeploymentCompletionHandler();
        return chatCompletion(request, reply, { deploymentId });
      }
    );
  };
}

export const deploymentRoutes: FastifyPluginAsync = createDeploymentRoutes();

// ============================================
// Helper Functions
// ============================================

interface SubmitDeps {
  prisma: Db;
  getNosana: () => Promise<NosanaPort>;
  now: () => Date;
}

/**
 * Creates, funds and starts the Nosana deployment for a row that already holds
 * its credit reservation.
 *
 * The row stays `provisioning` until the deployment-status worker OBSERVES the
 * deployment running with a real endpoint (queues/deployment-status.queue.ts);
 * DeploymentNodes are created there from Nosana's reported endpoints - there are
 * no nodes and no URLs before that, and none are invented here.
 *
 * createDeployment takes seconds (several Solana transactions), long enough for
 * the user to stop AND restart the row. Every write below is therefore
 * conditional on `runGeneration`, the run this submit was started for: a submit
 * that outlived its run can neither hand its Nosana id to the new run nor fail
 * it and release its hold. The deployment it created is then stopped and its id
 * kept where the vault sweep finds it (retireUnownedNosanaDeployment).
 */
export async function submitToNosana(
  deps: SubmitDeps,
  deploymentId: string,
  config: ModelDeploymentConfig,
  gpuTier: string,
  replicas: number,
  runGeneration: number,
): Promise<void> {
  const { prisma, getNosana, now } = deps;
  const thisRun = { id: deploymentId, runGeneration };
  let createdNosanaId: string | undefined;

  try {
    // pending -> provisioning by CAS: a deployment stopped before we got here
    // must not be revived.
    const claimed = await prisma.deployment.updateMany({
      where: { ...thisRun, status: "pending" },
      data: { status: "provisioning" },
    });
    if (claimed.count === 0) {
      logger.info({ deploymentId }, "Deployment left pending before submit; not submitting");
      return;
    }

    // Generate job definition. The HF token (when configured) goes only into a
    // CONFIDENTIAL job definition (createDeployment always sets that).
    const jobDefinition = generateJobDefinition({
      ...config,
      hfToken: getNosanaDeployConfig().hfToken,
    });

    // Get Nosana client and submit
    const nosana = await getNosana();
    const nosanaDeployment = await nosana.createDeployment(
      jobDefinition,
      gpuTier,
      replicas
    );
    createdNosanaId = nosanaDeployment.id;

    // Store the Nosana Deployment-Manager id - but only while this run is still
    // in a submit state. If the user stopped it meanwhile (and perhaps
    // restarted it), the deployment we just started belongs to nobody: stop it
    // and recover its vault.
    const stored = await prisma.deployment.updateMany({
      where: { ...thisRun, status: { in: ["pending", "provisioning"] } },
      data: { nosanaJobIds: [nosanaDeployment.id] },
    });
    if (stored.count === 0) {
      logger.warn(
        { deploymentId, nosanaId: nosanaDeployment.id },
        "Deployment was stopped during submit; stopping the Nosana deployment just created"
      );
      await retireUnownedNosanaDeployment(deps, thisRun, nosanaDeployment.id, {
        stopped: false,
        reclaimed: false,
        reason: "stopped_during_submit",
      });
      return;
    }

    logger.info(
      { deploymentId, nosanaId: nosanaDeployment.id },
      "Submitted to Nosana"
    );
  } catch (error) {
    logger.error({ error, deploymentId }, "Failed to submit to Nosana");

    // A failure after creation carries the Nosana id and whether its vault was
    // recovered; persist both so the status worker can retry the reclaim.
    const partialId =
      error instanceof NosanaLifecycleError ? error.deploymentId : createdNosanaId;
    const cleanup = error instanceof NosanaLifecycleError ? error.cleanup : undefined;
    const stoppedAt = now();

    const failed = await prisma.deployment
      .updateMany({
        where: { ...thisRun, status: { in: ["pending", "provisioning"] } },
        data: {
          status: "failed",
          stoppedAt,
          statusReason: failureReason(error),
          ...(partialId
            ? {
                nosanaJobIds: [partialId],
                // Explicit either way, as on every other terminal write.
                vaultReclaimedAt: cleanup?.reclaimed ? stoppedAt : null,
              }
            : {}),
        },
      })
      .catch((err) => {
        logger.error({ err, deploymentId }, "failed to mark deployment failed");
        return null;
      });

    // The run was stopped (or restarted) while the create was failing, so the
    // update above did not record the partial id. It may still be running and
    // its vault may still be funded: never drop it.
    if (partialId && (!failed || failed.count === 0)) {
      await retireUnownedNosanaDeployment(deps, thisRun, partialId, {
        stopped: cleanup?.stopped ?? false,
        reclaimed: cleanup?.reclaimed ?? false,
        reason: "submit_failed_after_stop",
      });
    }

    // Submit never happened, so no capacity was ever delivered — give the
    // admission hold back. This is the path that actually fires in
    // practice (a submit failure leaves the row with NO job ids, so the
    // status worker never polls it and would never release it either).
    await refundDeploymentReservation(prisma, thisRun, "submit_failed", now);

    throw error;
  }
}

/**
 * A submit created a Nosana deployment its run no longer wants (the run was
 * stopped, or stopped and restarted, while createDeployment was in flight).
 * Stops it, then keeps its id somewhere the vault sweep reads:
 *
 *  - on the row, when the row is still this submit's own run, terminal and
 *    holding no id (the plain "stopped during submit" case);
 *  - otherwise in nosana_orphan_deployments - the row now belongs to a later
 *    run, or its single id slot is taken.
 *
 * Only a deployment that is verified stopped AND drained may be forgotten.
 */
async function retireUnownedNosanaDeployment(
  deps: SubmitDeps,
  thisRun: { id: string; runGeneration: number },
  nosanaId: string,
  state: { stopped: boolean; reclaimed: boolean; reason: string },
): Promise<void> {
  const { prisma, getNosana, now } = deps;
  let { stopped, reclaimed } = state;

  if (!stopped) {
    try {
      reclaimed = (await (await getNosana()).stopDeployment(nosanaId)).reclaimed;
      stopped = true;
    } catch (err) {
      // Left to the sweep, which stops a deployment that is terminal in our
      // records but still running on Nosana.
      logger.error(
        { err, deploymentId: thisRun.id, nosanaId },
        "Failed to stop an orphaned Nosana deployment"
      );
    }
  }
  const settled = stopped && reclaimed;

  const kept = await prisma.deployment
    .updateMany({
      where: {
        ...thisRun,
        status: { in: TERMINAL_STATUSES },
        nosanaJobIds: { isEmpty: true },
      },
      data: { nosanaJobIds: [nosanaId], vaultReclaimedAt: settled ? now() : null },
    })
    .catch((err) => {
      logger.error({ err, deploymentId: thisRun.id, nosanaId }, "Failed to record an orphan's id");
      return { count: 0 };
    });
  if (kept.count > 0 || settled) return;

  await recordNosanaOrphan(prisma as unknown as NosanaOrphanPrisma, {
    nosanaDeploymentId: nosanaId,
    sourceKind: "model",
    sourceId: thisRun.id,
    reason: state.reason,
  });
}

/**
 * Releases a deployment's credit hold after a terminal outcome that the
 * status worker will never observe.
 *
 * The worker only polls rows carrying Nosana job ids; a deployment that
 * failed to submit has none, so without this the org stays charged for a
 * deployment that never existed. Best-effort by design — a refund
 * failure must not mask the original submit error.
 */
async function refundDeploymentReservation(
  prisma: Db,
  thisRun: { id: string; runGeneration: number },
  reason: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  const deploymentId = thisRun.id;
  try {
    const row = await prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { orgId: true, reservationCents: true },
    });
    if (!row?.reservationCents || row.reservationCents <= 0n) return;

    await prisma.$transaction((tx) =>
      releaseDeploymentReservation({
        tx: tx as never,
        kind: "model",
        deploymentId,
        orgId: row.orgId,
        reservationCents: row.reservationCents!,
        reason,
        now,
        // Only while the row is terminal AND still this submit's run: a late
        // refund must not claim the live hold of a run the user restarted in
        // the meantime - nor that run's hold once it has itself gone terminal
        // (its own writer releases it).
        onlyIfStatusIn: TERMINAL_STATUSES,
        onlyIfRunGeneration: thisRun.runGeneration,
      }),
    );
  } catch (err) {
    logger.error({ err, deploymentId }, "failed to release deployment reservation");
  }
}
