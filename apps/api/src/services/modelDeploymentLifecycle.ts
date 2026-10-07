/**
 * The lifecycle steps of a model deployment that more than one caller runs:
 * the background submit to Nosana, and the restart of a stopped or failed
 * deployment.
 *
 * They lived inline in routes/deployments.ts. The restart is also what a
 * scheduled health check does when its deployment is down, and a second copy
 * of it would have had to repeat - and would sooner or later have missed - the
 * rules that keep a restart safe: the run-generation claim, the previous run's
 * vault, the old hold's refund and the new run's reservation. So the route and
 * the task call the one function here.
 *
 * Every effect is a dependency, as it was for the route: its tests drive this
 * code through the route with a fake Prisma and a fake Nosana port.
 */

import { prisma as defaultPrisma } from "@wheelsai/db";

import { env } from "../config/env.js";
import { rowAccessMode, type NosanaAccessMode } from "../config/nosanaAccess.js";
import { getNosanaDeployConfig } from "../config/nosanaDeploy.js";
import { createLogger } from "../utils/logger.js";
import { releaseDeploymentReservation, reserveDeploymentCredits } from "./deploymentCreditGate.js";
import {
  FineTunedModelGoneError,
  adapterForRun,
  buildAdapterServingDeps,
  lockReadyFineTunedModel,
  prepareAdapterServing,
  type AdapterServingDeps,
  type AdapterServingRefusal,
} from "./fineTunedModels.js";
import {
  generateJobDefinition,
  getNosanaClient,
  isMockNosanaId,
  type ModelDeploymentConfig,
  type NosanaClient,
  wheelsaiDeploymentName,
} from "./nosana.js";
import { NosanaLifecycleError } from "./nosanaDeploymentLifecycle.js";
import { recordNosanaOrphan, type NosanaOrphanPrisma } from "./nosanaOrphans.js";
import { isAccessModeUnavailable, runDeployPreflight } from "./nosanaPreflight.js";

const logger = createLogger("model-deployment");

export type Db = typeof defaultPrisma;
export type NosanaPort = Pick<
  NosanaClient,
  | "assertCanDeploy"
  | "createDeployment"
  | "stopDeployment"
  | "scaleDeployment"
  | "getDeploymentStatus"
  | "reclaimDeploymentVault"
> &
  // Optional so a port written before API-key access (every test fake) still
  // satisfies the type; callers fall back to assertCanDeploy.
  Partial<Pick<NosanaClient, "preflightDeploy">>;

/**
 * The name a run's Nosana deployment is created under. Deterministic, so a
 * deployment whose create call threw (it may exist on Nosana with no id here)
 * can be traced back to its row and run from Nosana's own list.
 */
export function modelDeploymentNosanaName(deploymentId: string, runGeneration: number): string {
  return wheelsaiDeploymentName("model", `${deploymentId}-r${runGeneration}`);
}

/** Statuses that count against the per-org active quota. */
export const ACTIVE_STATUSES = ["pending", "building", "deploying", "provisioning", "running", "degraded"];
export const RESTARTABLE_STATUSES = ["stopped", "failed"];
/** Deployment.statusReason of a deployment its owner stopped. */
export const OWNER_STOP_REASON = "user_stopped";

const STOPPED_BY_OWNER_MESSAGE =
  "The deployment was stopped by its owner; it is not restarted automatically.";

/** The record of automatic restarts (scheduledTasks/healthCheck.ts), cleared. */
export const NO_AUTO_RESTARTS = { autoRestartCount: 0, lastAutoRestartAt: null };
/** A credit hold is only released while the row is terminal (see releaseDeploymentReservation). */
export const TERMINAL_STATUSES = ["stopped", "failed"];

/**
 * What a deployment runs with when its config omits a value. Applied when a
 * deployment is created, submitted and read, so a row that lacks a key (older
 * rows, rows written by scripts) still answers with a complete config.
 */
export const DEFAULT_DEPLOYMENT_CONFIG = { maxTokens: 4096, gpuMemoryUtilization: 0.9 } as const;

/** The columns of an in-flight replica change, cleared. */
export const NO_REPLICA_CHANGE = {
  pendingReplicas: null,
  replicaChangeId: null,
  replicaChangeAt: null,
  replicaChangeHoldCents: null,
};

/**
 * Signals a failed admission from inside a transaction, so the row changes roll
 * back with it instead of being left half-applied.
 */
export class InsufficientCreditsError extends Error {
  constructor(readonly requiredCents: bigint) {
    super("insufficient_credits");
  }
}

/** A concurrent writer changed the deployment under a compare-and-set. */
export class DeploymentConflictError extends Error {
  constructor(message = "deployment_conflict") {
    super(message);
  }
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

// ============================================
// Restart
// ============================================

/** Starts the background submit of a run that has been claimed. */
export type SubmitDeployment = (
  deploymentId: string,
  config: ModelDeploymentConfig,
  gpuTier: string,
  replicas: number,
  runGeneration: number,
) => Promise<void>;

export interface RestartDeploymentDeps {
  prisma: Db;
  getNosana: () => Promise<NosanaPort>;
  now: () => Date;
  submit: SubmitDeployment;
  /** MAX_ACTIVE_DEPLOYMENTS_PER_ORG. */
  maxActiveDeployments: number;
  /** What serving a fine-tuned adapter needs; the server's own when omitted. */
  adapterServing?: AdapterServingDeps;
}

export type RestartDeploymentResult =
  /** Claimed, reserved and handed to the background submit. */
  | { ok: true; deploymentId: string; status: "pending"; runGeneration: number }
  | { ok: false; code: "not_found"; message: string }
  /** The platform cannot deploy this tier (Nosana or its market unconfigured). */
  | { ok: false; code: "preflight_failed"; message: string; error: unknown }
  /** The deployment serves a fine-tuned model that cannot be served now. */
  | { ok: false; code: "adapter_serving_refused"; message: string; refusal: AdapterServingRefusal }
  | {
      ok: false;
      code:
        | "deployment_not_restartable"
        | "deployment_quota_exceeded"
        | "previous_run_winding_down"
        /** The previous run belongs to a Nosana account this process holds no credential for. */
        | "previous_run_other_account"
        | "insufficient_credits";
      message: string;
    };

/**
 * Restarts a deployment of `orgId`.
 *
 * Only a stopped or failed deployment can be restarted. A restart is a NEW
 * Nosana deployment, so it takes a fresh credit reservation and re-checks
 * the org quota; the previous run's hold (if somehow still held) is
 * released first, and the previous run's vault must be reclaimed before its
 * id is forgotten.
 *
 * The claim bumps runGeneration: that is what makes every late write of the
 * previous run (a slow submit, stop, status or billing tick) miss this one.
 *
 * An `automatic` restart is one nobody asked for by hand (a health check's
 * remediation). It never starts a deployment its owner stopped: stopping is
 * how an owner stops paying, so the refusal is part of the claim itself and
 * holds against a Stop that lands while the restart is being prepared. A
 * restart by hand clears the record of automatic ones, which the health
 * check limits; an automatic one leaves it to its caller.
 *
 * A refusal is returned, never thrown; nothing was changed when it is.
 */
export async function restartModelDeployment(
  deps: RestartDeploymentDeps,
  args: { deploymentId: string; orgId: string; automatic?: boolean },
): Promise<RestartDeploymentResult> {
  const { prisma, getNosana, now, submit } = deps;
  const { deploymentId, orgId } = args;

  const deployment = await prisma.deployment.findFirst({
    where: { id: deploymentId, orgId },
    include: { model: true },
  });

  if (!deployment) {
    return { ok: false, code: "not_found", message: "Deployment not found" };
  }

  if (!RESTARTABLE_STATUSES.includes(deployment.status)) {
    return {
      ok: false,
      code: "deployment_not_restartable",
      message: `Only stopped or failed deployments can be restarted (status: ${deployment.status}).`,
    };
  }

  if (args.automatic && deployment.statusReason === OWNER_STOP_REASON) {
    return { ok: false, code: "deployment_not_restartable", message: STOPPED_BY_OWNER_MESSAGE };
  }

  // A deployment of a fine-tuned model: the model must still be ready and
  // servable, and this run gets an adapter URL of its own (the previous
  // run's names the previous generation and no longer answers). Built before
  // anything is claimed, so nothing it refuses leaves a claimed row behind.
  const runGeneration = deployment.runGeneration + 1;
  let adapter: ModelDeploymentConfig["adapter"];
  if (deployment.fineTunedModelId) {
    const serving = deps.adapterServing ?? buildAdapterServingDeps();
    const prepared = await prepareAdapterServing(
      { prisma, serving },
      {
        orgId,
        fineTunedModelId: deployment.fineTunedModelId,
        engine: deployment.engine,
        gpuTier: deployment.gpuTier,
      },
    );
    if (!prepared.ok) {
      return { ok: false, code: "adapter_serving_refused", message: prepared.message, refusal: prepared };
    }
    adapter = adapterForRun(serving, prepared.fineTunedModel, { deploymentId, runGeneration });
  }
  const fineTunedModelId = adapter ? deployment.fineTunedModelId : null;

  // Before anything is claimed or reserved: the static check and, with
  // API-key access, the platform's credit gate.
  const nosana = await getNosana();
  try {
    await runDeployPreflight(nosana, deployment.gpuTier, deployment.replicas);
  } catch (err) {
    return {
      ok: false,
      code: "preflight_failed",
      message: err instanceof Error ? err.message : String(err),
      error: err,
    };
  }

  const activeCount = await prisma.deployment.count({
    where: { orgId, status: { in: ACTIVE_STATUSES } },
  });
  if (activeCount >= deps.maxActiveDeployments) {
    return {
      ok: false,
      code: "deployment_quota_exceeded",
      message: `Organization already has ${activeCount} active deployments (limit ${deps.maxActiveDeployments}).`,
    };
  }

  // The previous run's Nosana id is about to be forgotten: make sure its
  // vault funds are back with the platform first, or they would be orphaned.
  // With API-key access there is no vault; "reclaimed" then means Nosana is no
  // longer running the previous run (a run that ended in error or out of funds
  // counts), so such a row can be restarted.
  const previousId = deployment.nosanaJobIds[0];
  if (previousId && !deployment.vaultReclaimedAt && !isMockNosanaId(previousId)) {
    let otherAccount = false;
    const outcome = await nosana
      .reclaimDeploymentVault(previousId, rowAccessMode(deployment.nosanaAccessMode))
      .catch((err) => {
        otherAccount = isAccessModeUnavailable(err);
        return null;
      });
    if (otherAccount) {
      // Not "retry in a minute": no retry from this process can ever reach it.
      return {
        ok: false,
        code: "previous_run_other_account",
        message:
          "The previous run cannot be confirmed stopped right now. Contact support.",
      };
    }
    if (!outcome?.reclaimed) {
      return {
        ok: false,
        code: "previous_run_winding_down",
        message: "The previous run is still being wound down on Nosana. Retry in a minute.",
      };
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
          // The reason as well as the status: a Stop pressed on a failed
          // row since it was read above leaves the status restartable.
          ...(args.automatic && {
            OR: [{ statusReason: null }, { statusReason: { not: OWNER_STOP_REASON } }],
          }),
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
          nosanaAccessMode: null,
          // A replica change the previous run never finished is void.
          ...NO_REPLICA_CHANGE,
          ...(args.automatic ? {} : NO_AUTO_RESTARTS),
        },
      });
      if (claimed.count === 0) throw new DeploymentConflictError();

      // Deleted since it was read above: the restart does not happen.
      if (
        fineTunedModelId &&
        !(await lockReadyFineTunedModel(tx as never, { id: fineTunedModelId, orgId, now: now() }))
      ) {
        throw new FineTunedModelGoneError();
      }

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
      return {
        ok: false,
        code: "insufficient_credits",
        message: `Restarting requires a reservation of $${(
          Number(err.requiredCents) / 100
        ).toFixed(2)} in credits. Add credits and retry.`,
      };
    }
    if (err instanceof DeploymentConflictError) {
      return {
        ok: false,
        code: "deployment_not_restartable",
        message: "The deployment changed while restarting; retry.",
      };
    }
    if (err instanceof FineTunedModelGoneError) {
      const refusal: AdapterServingRefusal = {
        ok: false,
        status: 409,
        code: "fine_tuned_model_not_ready",
        message: "This fine-tuned model has been deleted and can no longer be deployed.",
      };
      return { ok: false, code: "adapter_serving_refused", message: refusal.message, refusal };
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
      maxTokens: config.maxTokens ?? DEFAULT_DEPLOYMENT_CONFIG.maxTokens,
      gpuMemoryUtilization: config.gpuMemoryUtilization ?? DEFAULT_DEPLOYMENT_CONFIG.gpuMemoryUtilization,
      ...(adapter ? { adapter } : {}),
    },
    deployment.gpuTier,
    deployment.replicas,
    runGeneration,
  ).catch((err) => {
    logger.error({ err, deploymentId }, "Failed to restart deployment");
  });

  return { ok: true, deploymentId, status: "pending", runGeneration };
}

/**
 * The restart, bound to this server's database and Nosana client, for callers
 * that are not the HTTP route (a scheduled health check). Resolves with the
 * deployment's new status; a refusal throws with the reason the route would
 * have answered.
 */
export async function restartDeploymentForOrg(
  deploymentId: string,
  orgId: string,
): Promise<{ status: string }> {
  const base = { prisma: defaultPrisma, getNosana: getNosanaClient, now: () => new Date() };
  const restarted = await restartModelDeployment(
    {
      ...base,
      submit: (id, config, gpuTier, replicas, runGeneration) =>
        submitToNosana(base, id, config, gpuTier, replicas, runGeneration),
      maxActiveDeployments: env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG,
    },
    { deploymentId, orgId, automatic: true },
  );
  if (!restarted.ok) throw new Error(restarted.message);
  return { status: restarted.status };
}

// ============================================
// Submit
// ============================================

export interface SubmitDeps {
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
  // The credential that created it; undefined for the dev mock.
  let createdAccessMode: NosanaAccessMode | undefined;

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
      replicas,
      { name: modelDeploymentNosanaName(deploymentId, runGeneration) }
    );
    createdNosanaId = nosanaDeployment.id;
    createdAccessMode = nosanaDeployment.accessMode;

    // Store the Nosana Deployment-Manager id - but only while this run is still
    // in a submit state. If the user stopped it meanwhile (and perhaps
    // restarted it), the deployment we just started belongs to nobody: stop it
    // and recover its vault.
    const stored = await prisma.deployment.updateMany({
      where: { ...thisRun, status: { in: ["pending", "provisioning"] } },
      // The access mode in the same statement as the id it describes.
      data: {
        nosanaJobIds: [nosanaDeployment.id],
        nosanaAccessMode: createdAccessMode ?? null,
      },
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
        accessMode: createdAccessMode,
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
    const partialMode =
      createdAccessMode ?? (error instanceof NosanaLifecycleError ? error.accessMode : undefined);
    const stoppedAt = now();

    // The create call itself threw: the SDK parses the response after the
    // server has created the deployment, so one may exist on Nosana with no id
    // here. It was never started. Its name is all there is to find it by.
    if (error instanceof NosanaLifecycleError && error.mayExistOnNosana) {
      logger.error(
        {
          deploymentId,
          runGeneration,
          nosanaName: error.deploymentName ?? modelDeploymentNosanaName(deploymentId, runGeneration),
          accessMode: partialMode,
        },
        "A Nosana deployment may exist for this run without an id - look it up by name",
      );
    }

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
                nosanaAccessMode: partialMode ?? null,
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
        accessMode: partialMode,
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
  state: { stopped: boolean; reclaimed: boolean; reason: string; accessMode?: NosanaAccessMode },
): Promise<void> {
  const { prisma, getNosana, now } = deps;
  let { stopped, reclaimed } = state;

  if (!stopped) {
    try {
      // Through the credential that created it (undefined only for the mock).
      reclaimed = (await (await getNosana()).stopDeployment(nosanaId, state.accessMode)).reclaimed;
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
      data: {
        nosanaJobIds: [nosanaId],
        nosanaAccessMode: state.accessMode ?? null,
        vaultReclaimedAt: settled ? now() : null,
      },
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
    accessMode: state.accessMode,
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
