/**
 * Composition root for the deployment-status poll tick (plan D8, reworked for
 * the Nosana Deployment Manager in W2).
 *
 * Wires for runDeploymentStatusTick:
 *   loadDeployments    -> AgentDeployment + model Deployment rows in
 *                         non-terminal states that have a Nosana deployment
 *                         id; model rows carry their DeploymentNodes and engine
 *   observeDeployment  -> NosanaClient.getDeploymentStatus (STRICT: throws on
 *                         API failure so rows stay untouched), normalised into
 *                         {state, endpoints, detail}; the env-gated dev mock
 *                         short-circuit returns a labelled mock observation
 *   persistTransition  -> compare-and-set updateMany on {id, fromStatus} and,
 *                         for model rows, the run generation that was loaded;
 *                         stamps statusReason / billedThroughAt (model rows).
 *                         A model row leaving `running` is settled in the same
 *                         transaction, AFTER the status CAS won: the open GPU
 *                         window is charged, and on a terminal edge the
 *                         admission hold is released first so it can cover it.
 *   reconcileReplicas  -> one transaction: CAS the confirmed replica count to
 *                         what Nosana runs (resolving a stale replica-change
 *                         claim), settle the window at the old count, adjust
 *                         the hold
 *                         An agent deployment that ends has no vault stamp, so
 *                         its Nosana id is handed to the orphan sweep
 *   syncNodes          -> reconcile DeploymentNode rows with Nosana's real,
 *                         ONLINE endpoints (one node per endpoint URL: a
 *                         load-balanced proxy per op, not a replica)
 *   stopHaltedDeployment -> NosanaClient.stopDeployment for a row the tick
 *                         has just failed because Nosana halted it
 *   checkNodeHealth    -> NosanaClient.checkNodeHealth (engine-specific HTTP
 *                         probe, never throws; for Ollama it is given the
 *                         row's served model and is healthy only when that
 *                         model is loaded and has answered a request)
 *   readPlacementEvents -> NosanaClient.listDeploymentEvents, for a row that
 *                         has waited with nothing online: a listing Nosana
 *                         keeps failing ends the row (nosana_list_failed)
 *   persistNodeHealth  -> updateMany by node id (race-safe: the node may
 *                         have been cascade-deleted with its deployment
 *                         between load and write - count=0 beats P2025)
 *   vault reclaim      -> retry vault.withdraw for stopped/failed model
 *                         deployments, and for untracked Nosana deployments
 *                         (nosana_orphan_deployments), until funds are VERIFIED
 *                         recovered
 *   reservation sweep  -> retry the credit-hold release of terminal rows whose
 *                         hold is still unreleased (the release after a
 *                         transition is best-effort; this is what retries it)
 *
 * Status vocabularies (schema comments are the source of truth):
 *   AgentDeployment: pending | building | deploying | running | stopped | failed
 *   Deployment:      pending | provisioning | running | degraded | stopped | failed
 *
 * "running" rows ARE polled: a running deployment that Nosana stops or errors
 * must be observed into stopped/failed.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { rowAccessMode, type NosanaAccessMode } from "../config/nosanaAccess.js";
import { startMayBeInFlight, type DeploymentSnapshot } from "./nosanaDeploymentLifecycle.js";
import {
  isPlacementFailureReason,
  PLACEMENT_FAILURE_SENTENCES,
} from "./runDeploymentStatusTick.js";
import type {
  DeploymentNodeRow,
  DeploymentObservation,
  DeploymentStatusRow,
  DeploymentStatusTickDeps,
  NodeHealthObservation,
  ObservedEndpoint,
  VaultReclaimCandidate,
} from "./runDeploymentStatusTick.js";
import { getPricePerSecond } from "./computeMetering.js";
import {
  holdAdditionalReplicas,
  releaseDeploymentReservation,
  replicaHoldReturnCents,
  returnReplicaReservation,
} from "./deploymentCreditGate.js";
import { chargeGpuWindow, type GpuBillingTx } from "./gpuBilling.js";
import { isMockNosanaId } from "./nosanaIds.js";
import { recordNosanaOrphan, type NosanaOrphanPrisma } from "./nosanaOrphans.js";

/** Everything except stopped/failed - rows worth polling. */
export const AGENT_DEPLOYMENT_NON_TERMINAL_STATUSES = [
  "pending",
  "building",
  "deploying",
  "running",
];
export const MODEL_DEPLOYMENT_NON_TERMINAL_STATUSES = [
  "pending",
  "provisioning",
  "running",
  "degraded",
];

/** How many stopped/failed deployments one tick retries a vault withdraw for. */
export const VAULT_RECLAIM_BATCH_SIZE = 25;
/** How many unreleased terminal holds one tick retries the release of. */
export const RESERVATION_SWEEP_BATCH_SIZE = 50;
/** Statuses in which a deployment's credit hold is over and must be released. */
export const TERMINAL_STATUSES_FOR_RELEASE = ["stopped", "failed"];
const DEFAULT_RECLAIM_MAX_AGE_HOURS = 72;

interface AgentDeploymentDelegateStub {
  findMany: (args: {
    where: {
      status: { in: string[] };
      nosanaJobIds: { isEmpty: false };
    };
    // AgentDeployment has no orgId column - the org comes through the
    // agent join (webhook emission needs it).
    select: {
      id: true;
      status: true;
      nosanaJobIds: true;
      nosanaAccessMode: true;
      updatedAt: true;
      reservationCents: true;
      reservationReleasedAt: true;
      agent: { select: { orgId: true } };
    };
  }) => Promise<
    Array<{
      id: string;
      status: string;
      nosanaJobIds: string[];
      nosanaAccessMode?: string | null;
      updatedAt?: Date | null;
      reservationCents: bigint | null;
      reservationReleasedAt: Date | null;
      agent: { orgId: string };
    }>
  >;
  updateMany: (args: {
    where: { id: string; status: string };
    data: {
      status: string;
      stoppedAt?: Date;
      lastError?: string;
    };
  }) => Promise<{ count: number }>;
}

interface ModelLoadArgs {
  where: {
    status: { in: string[] };
    nosanaJobIds: { isEmpty: false };
  };
  select: {
    id: true;
    orgId: true;
    status: true;
    engine: true;
    nosanaJobIds: true;
    nosanaAccessMode: true;
    updatedAt: true;
    billedThroughAt: true;
    runGeneration: true;
    replicas: true;
    pendingReplicas: true;
    replicaChangeId: true;
    replicaChangeAt: true;
    replicaChangeHoldCents: true;
    reservationCents: true;
    reservationReleasedAt: true;
    model: { select: { hfId: true } };
    nodes: { select: { id: true; nodeUrl: true; healthStatus: true } };
  };
}

interface ModelReclaimArgs {
  where: {
    status: { in: string[] };
    vaultReclaimedAt: null;
    nosanaJobIds: { isEmpty: false };
    stoppedAt: { gte: Date };
  };
  select: { id: true; nosanaJobIds: true; nosanaAccessMode: true; stoppedAt: true };
  orderBy: { stoppedAt: "asc" };
  take: number;
}

interface ModelDeploymentDelegateStub {
  findMany(args: ModelLoadArgs): Promise<
    Array<{
      id: string;
      orgId: string;
      status: string;
      engine: string;
      nosanaJobIds: string[];
      nosanaAccessMode?: string | null;
      updatedAt?: Date | null;
      billedThroughAt?: Date | null;
      model?: { hfId: string } | null;
      runGeneration: number;
      replicas: number;
      pendingReplicas?: number | null;
      replicaChangeId?: string | null;
      replicaChangeAt?: Date | null;
      replicaChangeHoldCents?: bigint | null;
      reservationCents: bigint | null;
      reservationReleasedAt: Date | null;
      nodes: Array<{ id: string; nodeUrl: string; healthStatus: string }>;
    }>
  >;
  findMany(
    args: ModelReclaimArgs,
  ): Promise<
    Array<{ id: string; nosanaJobIds: string[]; nosanaAccessMode?: string | null; stoppedAt?: Date | null }>
  >;
  findFirst: (args: {
    where: { id: string; status: { in: string[] }; runGeneration?: number };
    select: { id: true };
  }) => Promise<{ id: string } | null>;
  updateMany: (args: {
    where: {
      id: string;
      status?: string | { in: string[] };
      runGeneration?: number;
      vaultReclaimedAt?: null;
      nosanaJobIds?: { has: string };
      replicas?: number;
      replicaChangeId?: string | null;
    };
    data: {
      status?: string;
      stoppedAt?: Date;
      statusReason?: string | null;
      billedThroughAt?: Date;
      vaultReclaimedAt?: Date | null;
      replicas?: number;
      pendingReplicas?: null;
      replicaChangeId?: null;
      replicaChangeAt?: null;
      replicaChangeHoldCents?: null;
    };
  }) => Promise<{ count: number }>;
}

/** Terminal rows whose credit hold was never released (see the sweep). */
interface UnreleasedReservationRow {
  id: string;
  status: string;
  orgId: string;
  reservationCents: bigint | null;
}

/** What a settlement reads back under the row lock its claim took. */
const SETTLE_SELECT = {
  orgId: true,
  status: true,
  gpuTier: true,
  replicas: true,
  billedThroughAt: true,
  reservationCents: true,
  reservationReleasedAt: true,
  gpuStoppedAt: true,
} as const;

/**
 * The transaction surface of the two settling writes: persistTransition's
 * running edge and reconcileReplicas.
 */
interface SettleTx extends GpuBillingTx {
  deployment: GpuBillingTx["deployment"] & {
    findUnique(args: { where: { id: string }; select: typeof SETTLE_SELECT }): Promise<{
      orgId: string;
      status: string;
      gpuTier: string;
      replicas: number;
      billedThroughAt: Date | null;
      reservationCents: bigint | null;
      reservationReleasedAt: Date | null;
      gpuStoppedAt?: Date | null;
    } | null>;
    updateMany: ModelDeploymentDelegateStub["updateMany"];
  };
}

/** nosana_orphan_deployments, as the vault sweep uses it. */
interface NosanaOrphanDelegateStub extends Pick<NosanaOrphanPrisma, "nosanaOrphanDeployment"> {
  nosanaOrphanDeployment: NosanaOrphanPrisma["nosanaOrphanDeployment"] & {
    findMany(args: {
      where: { reclaimedAt: null; createdAt: { gte: Date } };
      select: { id: true; nosanaDeploymentId: true; accessMode: true; createdAt: true };
      orderBy: { createdAt: "asc" };
      take: number;
    }): Promise<
      Array<{ id: string; nosanaDeploymentId: string; accessMode?: string | null; createdAt?: Date | null }>
    >;
    updateMany(args: {
      where: { id: string; reclaimedAt: null };
      data: { reclaimedAt: Date };
    }): Promise<{ count: number }>;
  };
}

interface DeploymentNodeDelegateStub {
  updateMany: (args: {
    where: { id: string };
    data: {
      healthStatus: string;
      lastHealthCheck: Date;
      latencyMs: number;
    };
  }) => Promise<{ count: number }>;
  findMany: (args: {
    where: { deploymentId: string };
    select: { id: true; nodeUrl: true; healthStatus: true };
    orderBy: { createdAt: "asc" };
  }) => Promise<DeploymentNodeRow[]>;
  create: (args: {
    data: {
      deploymentId: string;
      nosanaNodeId: string;
      nodeUrl: string;
      healthStatus: string;
    };
    select: { id: true; nodeUrl: true; healthStatus: true };
  }) => Promise<DeploymentNodeRow>;
  deleteMany: (args: {
    where: { id: { in: string[] } };
  }) => Promise<{ count: number }>;
}

type DeploymentStatusPrismaSurface =
  | Pick<
      PrismaClient,
      | "agentDeployment"
      | "deployment"
      | "deploymentNode"
      | "nosanaOrphanDeployment"
      | "$transaction"
    >
  | {
      // $transaction is needed for the reservation release (the CAS flag
      // and the credit must move together or a crash between them either
      // double-refunds or loses the refund) and for node reconciliation.
      $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
      agentDeployment: AgentDeploymentDelegateStub;
      deployment: ModelDeploymentDelegateStub;
      deploymentNode: DeploymentNodeDelegateStub;
      /** Optional for callers that wire no vault sweep. */
      nosanaOrphanDeployment?: NosanaOrphanDelegateStub["nosanaOrphanDeployment"];
    };

// Type-level guard: the stub findMany/updateMany args must remain valid
// Prisma args for their delegates.
type _AgentArgsCheck = Parameters<
  AgentDeploymentDelegateStub["findMany"]
>[0] extends Prisma.AgentDeploymentFindManyArgs
  ? true
  : never;
type _ModelArgsCheck = ModelLoadArgs extends Prisma.DeploymentFindManyArgs
  ? true
  : never;
type _ModelReclaimArgsCheck = ModelReclaimArgs extends Prisma.DeploymentFindManyArgs
  ? true
  : never;
type _NodeArgsCheck = Parameters<
  DeploymentNodeDelegateStub["updateMany"]
>[0] extends Prisma.DeploymentNodeUpdateManyArgs
  ? true
  : never;
const _argsCheck: [
  _AgentArgsCheck,
  _ModelArgsCheck,
  _ModelReclaimArgsCheck,
  _NodeArgsCheck,
] = [true, true, true, true];
void _argsCheck;

export interface BuildDeploymentStatusTickDepsInput {
  prisma: DeploymentStatusPrismaSurface;
  /**
   * STRICT Deployment-Manager read (NosanaClient.getDeploymentStatus) - must
   * THROW on API failure. `accessMode` is the row's stamp: the read goes
   * through the credential that created the deployment.
   */
  getDeploymentStatus: (
    nosanaDeploymentId: string,
    accessMode?: NosanaAccessMode,
  ) => Promise<DeploymentSnapshot>;
  /**
   * HTTP readiness probe (NosanaClient.checkNodeHealth - never throws).
   * `pending`: the model is listed and has not answered yet (not known).
   */
  checkNodeHealth: (
    nodeUrl: string,
    engine?: string,
    model?: string,
  ) => Promise<{ healthy: boolean; latencyMs: number; pending?: boolean }>;
  /**
   * Forgets that a node was seen answering (services/nosana.ts
   * forgetNodeAnswered): the tick calls it for an endpoint that is
   * offline, a node that is dropped and a row that leaves service.
   */
  forgetNodeReadiness?: (nodeUrl: string) => void;
  /**
   * The name an engine serves a model under (services/nosana.ts
   * servedModelName): what the Ollama readiness probe looks for. Omit and
   * the probe is given no model.
   */
  servedModelName?: (engine: string, hfId: string) => string;
  /**
   * The newest events of a Nosana deployment, newest first
   * (NosanaClient.listDeploymentEvents), through the credential that created
   * it. Omit and a deployment Nosana cannot place is ended only by the
   * provisioning limit.
   */
  listDeploymentEvents?: (
    nosanaDeploymentId: string,
    accessMode?: NosanaAccessMode,
  ) => Promise<DeploymentSnapshot["events"]>;
  /** For the operator's log and view: a row failed for placement, with Nosana's message. */
  reportPlacementFailure?: DeploymentStatusTickDeps["reportPlacementFailure"];
  /**
   * env.ALLOW_NOSANA_MOCK. Dev-only: mock ids are treated as running
   * instead of being queried. Production boot REJECTS the flag
   * (validateEnv), so this branch cannot run there.
   */
  allowMock: boolean;
  /** Webhook emission for observed transitions (queue wires triggerWebhook). */
  emitTransition: DeploymentStatusTickDeps["emitTransition"];
  /**
   * Retry of the vault withdraw (NosanaClient.reclaimDeploymentVault). Omit to
   * disable the reclaim sweep. With API-key access nothing is withdrawn:
   * `reclaimed` then means Nosana no longer runs the deployment.
   */
  reclaimVault?: (
    nosanaDeploymentId: string,
    accessMode?: NosanaAccessMode,
    /**
     * `startMayBeInFlight`: the run ended so recently that a start sent for it
     * may still land, so an unstarted DRAFT is not yet released.
     */
    options?: { startMayBeInFlight?: boolean },
  ) => Promise<{ reclaimed: boolean }>;
  /**
   * Called once per tick with the ids skipped because this process holds no
   * credential for the access mode that created them (the queue logs it).
   */
  reportAccessModeUnavailable?: DeploymentStatusTickDeps["reportAccessModeUnavailable"];
  /**
   * NosanaClient.stopDeployment, for a deployment the tick has just moved to
   * failed because Nosana halted it (error / insufficient_funds). Omit and
   * only the reclaim sweep stops it.
   */
  stopDeployment?: (
    nosanaDeploymentId: string,
    accessMode?: NosanaAccessMode,
  ) => Promise<{ stopRefused?: boolean }>;
  /** Give up retrying a vault withdraw this long after the deployment ended. */
  reclaimMaxAgeHours?: number;
  /** USD/second per replica for a GPU tier; defaults to the production table. */
  pricePerSecondUsd?: (tier: string) => number;
  /** Injectable clock (tests). */
  now?: () => Date;
}

const FAILURE_EVENT = /error|fail|insufficient|reject|abort/i;
const MAX_DETAIL_LENGTH = 500;

/**
 * The most recent Nosana event that explains a failure, for statusReason. Falls
 * back to the most recent event of any kind; undefined when there are none
 * (the tick then records the generic "nosana_error").
 */
export function pickFailureDetail(
  events: DeploymentSnapshot["events"],
): string | undefined {
  if (events.length === 0) return undefined;
  const newestFirst = [...events].sort((a, b) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  );
  const match =
    newestFirst.find((e) => FAILURE_EVENT.test(e.type) || FAILURE_EVENT.test(e.message)) ??
    newestFirst[0];
  const text = match ? `${match.type}: ${match.message}`.trim() : undefined;
  return text ? text.slice(0, MAX_DETAIL_LENGTH) : undefined;
}

/** Stable per-endpoint identity for DeploymentNode.nosanaNodeId. */
function endpointNodeId(endpoint: ObservedEndpoint): string {
  try {
    return new URL(endpoint.url).host;
  } catch {
    return endpoint.url;
  }
}

/*
 * WAITING_CLOCK: since when a row has been waiting to serve.
 *
 * It is the row's `updatedAt`, which Prisma stamps on every write to the row
 * itself (not to its nodes). That is a sound clock only because nothing
 * writes a waiting row (pending, provisioning, building, deploying) on a
 * timer. The writes to such a row are, in order:
 *   - the create and the reservation stored with it (routes/deployments.ts,
 *     routes/agents.ts), or the restart claim (modelDeploymentLifecycle.ts);
 *   - the submit: pending -> provisioning / building -> deploying, then the
 *     Nosana id and access mode. This is the last one, so the clock starts
 *     when Nosana has the deployment;
 *   - the status change that ends the wait (this file, the stop routes).
 * The periodic writers do not reach it: the billing cursor and the runway
 * check act on `running` rows only (buildGpuBillingTickDeps.ts), the replica
 * reconcile on `running`/`degraded`, the vault reclaim stamp on
 * `stopped`/`failed`, the automatic-restart claim on a stopped or failed row,
 * and the node probe and node sync write DeploymentNode rows.
 * A customer's own edit of a waiting model deployment (PATCH config) writes
 * the row once and so restarts the clock once. That is accepted: it delays
 * the provisioning limit by at most one limit per edit and is not periodic.
 * A writer added later that touches waiting rows on a timer would stop the
 * limit from ever firing; it must then get its own column.
 */

export function buildDeploymentStatusTickDeps(
  input: BuildDeploymentStatusTickDepsInput,
): DeploymentStatusTickDeps {
  const prisma = input.prisma as {
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
    agentDeployment: AgentDeploymentDelegateStub;
    deployment: ModelDeploymentDelegateStub;
    deploymentNode: DeploymentNodeDelegateStub;
    nosanaOrphanDeployment?: NosanaOrphanDelegateStub["nosanaOrphanDeployment"];
  };
  const orphans = prisma.nosanaOrphanDeployment;
  const now = input.now ?? (() => new Date());
  const pricePerSecondUsd = input.pricePerSecondUsd ?? getPricePerSecond;
  const reclaimMaxAgeMs =
    (input.reclaimMaxAgeHours ?? DEFAULT_RECLAIM_MAX_AGE_HOURS) * 3_600_000;

  const deps: DeploymentStatusTickDeps = {
    loadDeployments: async () => {
      const [agentRows, modelRows] = await Promise.all([
        prisma.agentDeployment.findMany({
          where: {
            status: { in: AGENT_DEPLOYMENT_NON_TERMINAL_STATUSES },
            nosanaJobIds: { isEmpty: false },
          },
          select: {
            id: true,
            status: true,
            nosanaJobIds: true,
            nosanaAccessMode: true,
            updatedAt: true,
            reservationCents: true,
            reservationReleasedAt: true,
            agent: { select: { orgId: true } },
          },
        }),
        prisma.deployment.findMany({
          where: {
            status: { in: MODEL_DEPLOYMENT_NON_TERMINAL_STATUSES },
            nosanaJobIds: { isEmpty: false },
          },
          select: {
            id: true,
            orgId: true,
            status: true,
            engine: true,
            nosanaJobIds: true,
            nosanaAccessMode: true,
            updatedAt: true,
            billedThroughAt: true,
            runGeneration: true,
            replicas: true,
            pendingReplicas: true,
            replicaChangeId: true,
            replicaChangeAt: true,
            replicaChangeHoldCents: true,
            reservationCents: true,
            reservationReleasedAt: true,
            model: { select: { hfId: true } },
            nodes: { select: { id: true, nodeUrl: true, healthStatus: true } },
          },
        }),
      ]);

      const rows: DeploymentStatusRow[] = [
        ...agentRows.map((r) => ({
          kind: "agent" as const,
          id: r.id,
          orgId: r.agent.orgId,
          status: r.status,
          nosanaJobIds: r.nosanaJobIds,
          nosanaAccessMode: rowAccessMode(r.nosanaAccessMode),
          // The waiting clock: see WAITING_CLOCK below.
          ...(r.updatedAt ? { waitingSince: r.updatedAt } : {}),
          reservationCents: r.reservationCents,
          reservationReleasedAt: r.reservationReleasedAt,
        })),
        ...modelRows.map((r) => ({
          kind: "model" as const,
          id: r.id,
          orgId: r.orgId,
          status: r.status,
          engine: r.engine,
          ...(input.servedModelName && r.model?.hfId
            ? { servedModel: input.servedModelName(r.engine, r.model.hfId) }
            : {}),
          nosanaJobIds: r.nosanaJobIds,
          nosanaAccessMode: rowAccessMode(r.nosanaAccessMode),
          ...(r.updatedAt ? { waitingSince: r.updatedAt } : {}),
          // Set only while a run is billed (the restart claim clears it). A
          // row with it set is never ended as "could not be placed": those
          // endings tell the customer nothing was charged.
          ...(r.billedThroughAt ? { billedThisRun: true } : {}),
          runGeneration: r.runGeneration,
          replicas: r.replicas,
          replicaChange:
            r.replicaChangeId && r.pendingReplicas != null && r.replicaChangeAt
              ? {
                  id: r.replicaChangeId,
                  to: r.pendingReplicas,
                  claimedAt: r.replicaChangeAt,
                  holdCents: r.replicaChangeHoldCents ?? null,
                }
              : null,
          reservationCents: r.reservationCents,
          reservationReleasedAt: r.reservationReleasedAt,
          nodes: r.nodes,
        })),
      ];
      return rows;
    },

    observeDeployment: async (nosanaDeploymentId, accessMode): Promise<DeploymentObservation> => {
      if (input.allowMock && isMockNosanaId(nosanaDeploymentId)) {
        // Dev-only (env-gated): mock deployments never reach Nosana, so there
        // is no endpoint to report. Labelled so the tick lets `running`
        // through without one.
        return { state: "running", endpoints: [], mock: true };
      }
      // Strict: a throw here leaves the row untouched upstream.
      const snapshot = await input.getDeploymentStatus(nosanaDeploymentId, accessMode);
      return {
        state: snapshot.status,
        endpoints: snapshot.endpoints,
        replicas: snapshot.replicas,
        ...(snapshot.status === "error"
          ? { detail: pickFailureDetail(snapshot.events) }
          : {}),
      };
    },

    persistTransition: async (t) => {
      // Compare-and-set: WHERE includes the observed fromStatus, so a
      // concurrent writer (user stop, billing worker, another replica) wins and
      // this tick's stale observation becomes a count=0 no-op.
      const terminal = t.toStatus === "stopped" || t.toStatus === "failed";
      const base = {
        status: t.toStatus,
        // Both models have stoppedAt; neither has startedAt. Record the
        // observation time when the deployment leaves service.
        ...(terminal ? { stoppedAt: t.observedAt } : {}),
      };

      if (t.kind === "agent") {
        const moved = await prisma.agentDeployment.updateMany({
          where: { id: t.id, status: t.fromStatus },
          data: {
            ...base,
            // AgentDeployment carries a lastError surface; record why. It is
            // shown to the customer, so a placement failure is its sentence,
            // never the code or Nosana's own message.
            ...(t.toStatus === "failed"
              ? {
                  lastError: isPlacementFailureReason(t.reason)
                    ? PLACEMENT_FAILURE_SENTENCES[t.reason]
                    : (t.reason ?? "Nosana reported deployment failure"),
                }
              : {}),
          },
        });
        // AgentDeployment has no vaultReclaimedAt and terminal rows are never
        // loaded again, so the row sweep cannot recover this vault: hand the
        // Nosana id to the orphan sweep (which also stops lingering jobs).
        if (moved.count > 0 && terminal && t.nosanaDeploymentId && orphans) {
          await recordNosanaOrphan(
            { nosanaOrphanDeployment: orphans },
            {
              nosanaDeploymentId: t.nosanaDeploymentId,
              sourceKind: "agent",
              sourceId: t.id,
              reason: `agent_deployment_${t.toStatus}`,
              accessMode: t.nosanaAccessMode,
            },
          );
        }
        return moved;
      }
      // The run generation is part of the CAS: an observation of a run the user
      // has since stopped and restarted (same row, same status string once the
      // new run is up) must not mark the new run stopped or failed.
      const modelWhere = {
        id: t.id,
        status: t.fromStatus,
        ...(t.runGeneration !== undefined ? { runGeneration: t.runGeneration } : {}),
      };
      const modelData = {
        ...base,
        // Always written so a recovery (degraded -> running) clears the
        // reason instead of leaving a stale one behind.
        statusReason: t.reason ?? null,
        // GPU billing cursor: billing starts (or resumes after a degraded
        // spell) from the moment capacity is OBSERVED live - never from
        // submission, and never for time the deployment had no endpoint.
        ...(t.toStatus === "running" ? { billedThroughAt: t.observedAt } : {}),
        // A run that ends starts with an unrecovered vault. Explicit, so a
        // stale stamp from an earlier run can never mark this one recovered.
        ...(terminal ? { vaultReclaimedAt: null } : {}),
      };

      // Leaving `running` ends a billable spell. The window since the last
      // billing tick is settled in the SAME transaction as the status change:
      // a degraded stretch is never billed, so without this the time between
      // the last tick and the degrade edge would be dropped when the cursor is
      // reset on recovery, and a terminal transition would never bill its tail.
      const leavesRunning =
        t.fromStatus === "running" && (t.toStatus === "degraded" || terminal);
      if (!leavesRunning) {
        return prisma.deployment.updateMany({ where: modelWhere, data: modelData });
      }
      return prisma.$transaction(async (rawTx) => {
        const tx = rawTx as SettleTx;
        // Claim first, bill second. Settling before the status CAS charged the
        // org even when the CAS then lost - a second tick, or a stop, had
        // already ended the spell, so that was GPU time with no live endpoint.
        // The claim also takes the row lock, which makes the cursor read below
        // current: the billing tick and a replica change both wait on it.
        const moved = await tx.deployment.updateMany({ where: modelWhere, data: modelData });
        if (moved.count === 0) return moved;

        const fresh = await tx.deployment.findUnique({
          where: { id: t.id },
          select: SETTLE_SELECT,
        });
        if (!fresh) return moved;

        // A run that ended gives its admission hold back BEFORE the final
        // window is charged, so the hold can cover it (as the stop route and
        // the credit-exhaustion stop do). Charging first took only what the
        // balance held, forgave the rest, and the whole hold was refunded after.
        let reservationReleased = false;
        if (
          terminal &&
          fresh.reservationCents &&
          fresh.reservationCents > 0n &&
          !fresh.reservationReleasedAt
        ) {
          const release = await releaseDeploymentReservation({
            tx: tx as never,
            kind: "model",
            deploymentId: t.id,
            orgId: fresh.orgId,
            reservationCents: fresh.reservationCents,
            reason: t.toStatus,
            now: () => t.observedAt,
            onlyIfStatusIn: TERMINAL_STATUSES_FOR_RELEASE,
            ...(t.runGeneration !== undefined ? { onlyIfRunGeneration: t.runGeneration } : {}),
          });
          reservationReleased = release.released;
        }

        if (fresh.billedThroughAt) {
          // A stop that Nosana confirmed but whose own transaction failed left
          // the time the GPUs stopped on the row: nothing is billed past it.
          const windowEnd =
            fresh.gpuStoppedAt && fresh.gpuStoppedAt < t.observedAt
              ? fresh.gpuStoppedAt
              : t.observedAt;
          const settled = await chargeGpuWindow(tx, {
            deploymentId: t.id,
            orgId: fresh.orgId,
            gpuTier: fresh.gpuTier,
            replicas: fresh.replicas,
            billedThroughAt: fresh.billedThroughAt,
            now: windowEnd,
            mode: "settle",
            pricePerSecondUsd,
          });
          // Cannot happen under the claim's row lock. If it does, the spell
          // must not end with its window unbilled (a recovery resets the
          // cursor; a terminal row is never billed again): roll back, and the
          // next tick observes the row afresh.
          if (settled.kind === "cursor_lost") {
            throw new Error(`GPU billing cursor of deployment ${t.id} moved under its status claim`);
          }
        }
        return { count: moved.count, reservationReleased };
      });
    },

    reconcileReplicas: async ({
      id,
      orgId,
      runGeneration,
      replicas,
      claim,
      observedReplicas,
      observedAt,
    }) =>
      prisma.$transaction(async (rawTx) => {
        const tx = rawTx as SettleTx;
        // The row exactly as it was loaded: same run, same confirmed count,
        // same claim (or none). The request that owns a claim commits or clears
        // it by the same token, so exactly one of the two resolves it; a PATCH
        // that claimed after the load makes this miss.
        const claimed = await tx.deployment.updateMany({
          where: {
            id,
            status: { in: ["running", "degraded"] },
            ...(runGeneration !== undefined ? { runGeneration } : {}),
            replicas,
            replicaChangeId: claim?.id ?? null,
          },
          data: {
            replicas: observedReplicas,
            pendingReplicas: null,
            replicaChangeId: null,
            replicaChangeAt: null,
            replicaChangeHoldCents: null,
          },
        });
        if (claimed.count === 0) return { reconciled: false };

        const fresh = await tx.deployment.findUnique({ where: { id }, select: SETTLE_SELECT });
        if (!fresh) return { reconciled: true };

        // Close the window at the count that was billed until now, so the next
        // tick starts at the new one. (Degraded: no open window.)
        if (observedReplicas !== replicas && fresh.status === "running" && fresh.billedThroughAt) {
          const settled = await chargeGpuWindow(tx, {
            deploymentId: id,
            orgId,
            gpuTier: fresh.gpuTier,
            replicas,
            rowReplicas: observedReplicas,
            billedThroughAt: fresh.billedThroughAt,
            now: observedAt,
            mode: "replica_change",
            pricePerSecondUsd,
          });
          if (settled.kind === "cursor_lost") {
            throw new Error(`GPU billing cursor of deployment ${id} moved under its replica claim`);
          }
        }

        // The hold follows the count Nosana runs.
        const heldFor = claim && claim.to > replicas ? claim.to : replicas;
        const giveBack = replicaHoldReturnCents({
          gpuTier: fresh.gpuTier,
          from: replicas,
          to: claim?.to ?? null,
          actual: observedReplicas,
          claimHoldCents: claim?.holdCents ?? null,
          pricePerSecondUsd,
        });
        if (giveBack > 0n) {
          await returnReplicaReservation({
            tx: tx as never,
            deploymentId: id,
            orgId,
            cents: giveBack,
            reason: `replicas reconciled to x${observedReplicas}`,
          });
        } else if (observedReplicas > heldFor && !fresh.reservationReleasedAt) {
          // More replicas run than the hold covers. Take the difference if the
          // org has it; if not the count is still the truth, and the billing
          // tick stops the deployment when it cannot be paid for.
          await holdAdditionalReplicas({
            tx: tx as never,
            deploymentId: id,
            orgId,
            gpuTier: fresh.gpuTier,
            addedReplicas: observedReplicas - heldFor,
            pricePerSecondUsd,
          });
        }
        return { reconciled: true };
      }),

    syncNodes: async ({ deploymentId, endpoints, runGeneration }) =>
      prisma.$transaction(async (rawTx) => {
        const tx = rawTx as unknown as {
          deployment: Pick<ModelDeploymentDelegateStub, "findFirst">;
          deploymentNode: DeploymentNodeDelegateStub;
        };

        // Never create nodes for a deployment that has left service between
        // load and write - /v1 would route to a stopped deployment's URL.
        if (endpoints.length > 0) {
          const inService = await tx.deployment.findFirst({
            where: {
              id: deploymentId,
              status: { in: MODEL_DEPLOYMENT_NON_TERMINAL_STATUSES },
              // Nor for a later run: these endpoints are the observed run's.
              ...(runGeneration !== undefined ? { runGeneration } : {}),
            },
            select: { id: true },
          });
          if (!inService) return [];
        }

        const existing = await tx.deploymentNode.findMany({
          where: { deploymentId },
          select: { id: true, nodeUrl: true, healthStatus: true },
          orderBy: { createdAt: "asc" },
        });

        const wanted = new Set(endpoints.map((e) => e.url));
        const kept = new Map<string, DeploymentNodeRow>();
        const staleIds: string[] = [];
        for (const node of existing) {
          // Fabricated rows (empty url / not an observed endpoint) and
          // duplicates of an already-kept url are removed.
          if (wanted.has(node.nodeUrl) && !kept.has(node.nodeUrl)) {
            kept.set(node.nodeUrl, node);
          } else {
            staleIds.push(node.id);
          }
        }
        if (staleIds.length > 0) {
          await tx.deploymentNode.deleteMany({ where: { id: { in: staleIds } } });
        }

        const created: DeploymentNodeRow[] = [];
        const seenNew = new Set<string>();
        for (const endpoint of endpoints) {
          if (kept.has(endpoint.url) || seenNew.has(endpoint.url)) continue;
          seenNew.add(endpoint.url);
          created.push(
            await tx.deploymentNode.create({
              data: {
                deploymentId,
                // Deployment.endpoints carries no node id. The endpoint's
                // host is the stable identity of this URL: one load-balanced
                // proxy per op, the same for every replica and every job.
                nosanaNodeId: endpointNodeId(endpoint),
                nodeUrl: endpoint.url,
                healthStatus: "unknown",
              },
              select: { id: true, nodeUrl: true, healthStatus: true },
            }),
          );
        }
        return [...kept.values(), ...created];
      }),

    checkNodeHealth: (nodeUrl, engine, model) => input.checkNodeHealth(nodeUrl, engine, model),
    ...(input.forgetNodeReadiness ? { forgetNodeReadiness: input.forgetNodeReadiness } : {}),
    ...(input.listDeploymentEvents
      ? {
          readPlacementEvents: async (nosanaDeploymentId: string, accessMode?: NosanaAccessMode) =>
            (await input.listDeploymentEvents!(nosanaDeploymentId, accessMode)).map((event) => ({
              type: event.type,
              message: event.message,
              createdAt: event.createdAt,
            })),
        }
      : {}),
    ...(input.reportPlacementFailure ? { reportPlacementFailure: input.reportPlacementFailure } : {}),

    persistNodeHealth: async (obs: NodeHealthObservation) => {
      // updateMany, not update: the node may have been cascade-deleted
      // with its deployment between load and write - count=0 beats a
      // thrown P2025 killing the row's remaining probes.
      await prisma.deploymentNode.updateMany({
        where: { id: obs.nodeId },
        data: {
          healthStatus: obs.healthStatus,
          lastHealthCheck: obs.checkedAt,
          latencyMs: obs.latencyMs,
        },
      });
    },

    emitTransition: input.emitTransition,
    ...(input.reportAccessModeUnavailable
      ? { reportAccessModeUnavailable: input.reportAccessModeUnavailable }
      : {}),
    ...(input.stopDeployment
      ? {
          stopHaltedDeployment: async (nosanaDeploymentId: string, accessMode?: NosanaAccessMode) => {
            const stop = await input.stopDeployment!(nosanaDeploymentId, accessMode);
            return stop.stopRefused === true ? { stopRefused: true } : {};
          },
        }
      : {}),

    // Refund the admission hold. The CAS on reservationReleasedAt lives
    // inside releaseDeploymentReservation, and the whole thing runs in
    // one transaction so the flag and the credit move together.
    //
    // The amount credited is re-read under the barrier (a replica change can
    // have resized the hold since this tick loaded the row), and the barrier
    // only opens while the row is still terminal - a late release must not
    // claim the live hold of a run the user restarted in the meantime.
    releaseReservation: async (args) => {
      const result = await prisma.$transaction((tx: unknown) =>
        releaseDeploymentReservation({
          tx: tx as never,
          kind: args.kind,
          deploymentId: args.id,
          orgId: args.orgId,
          reservationCents: args.reservationCents,
          reason: args.reason,
          onlyIfStatusIn: TERMINAL_STATUSES_FOR_RELEASE,
          ...(args.kind === "model" && args.runGeneration !== undefined
            ? { onlyIfRunGeneration: args.runGeneration }
            : {}),
        }),
      );
      return { released: result.released };
    },

    // Retry of a release that failed (or never ran) after the row went
    // terminal. loadDeployments only loads NON-terminal rows, so without this a
    // failed release was never retried by anyone.
    loadUnreleasedReservations: async () => {
      const db = prisma as unknown as {
        deployment: { findMany(args: unknown): Promise<UnreleasedReservationRow[]> };
        agentDeployment: {
          findMany(args: unknown): Promise<
            Array<{
              id: string;
              status: string;
              reservationCents: bigint | null;
              agent: { orgId: string };
            }>
          >;
        };
      };
      const where = {
        status: { in: TERMINAL_STATUSES_FOR_RELEASE },
        reservationReleasedAt: null,
        reservationCents: { gt: 0n },
      };
      const [models, agents] = await Promise.all([
        db.deployment.findMany({
          where,
          select: { id: true, status: true, orgId: true, reservationCents: true },
          orderBy: { updatedAt: "asc" },
          take: RESERVATION_SWEEP_BATCH_SIZE,
        } satisfies Prisma.DeploymentFindManyArgs),
        db.agentDeployment.findMany({
          where,
          select: {
            id: true,
            status: true,
            reservationCents: true,
            agent: { select: { orgId: true } },
          },
          orderBy: { updatedAt: "asc" },
          take: RESERVATION_SWEEP_BATCH_SIZE,
        } satisfies Prisma.AgentDeploymentFindManyArgs),
      ]);
      return [
        ...models.map((r) => ({
          kind: "model" as const,
          id: r.id,
          orgId: r.orgId,
          status: r.status,
          reservationCents: r.reservationCents ?? 0n,
        })),
        ...agents.map((r) => ({
          kind: "agent" as const,
          id: r.id,
          orgId: r.agent.orgId,
          status: r.status,
          reservationCents: r.reservationCents ?? 0n,
        })),
      ];
    },
  };

  const reclaim = input.reclaimVault;
  if (reclaim) {
    deps.loadVaultReclaimCandidates = async (): Promise<VaultReclaimCandidate[]> => {
      const oldest = new Date(now().getTime() - reclaimMaxAgeMs);
      const rows = await prisma.deployment.findMany({
        where: {
          status: { in: ["stopped", "failed"] },
          vaultReclaimedAt: null,
          nosanaJobIds: { isEmpty: false },
          stoppedAt: { gte: oldest },
        },
        select: { id: true, nosanaJobIds: true, nosanaAccessMode: true, stoppedAt: true },
        orderBy: { stoppedAt: "asc" },
        take: VAULT_RECLAIM_BATCH_SIZE,
      });
      // Untracked deployments first: no row says they exist, and one whose stop
      // never landed is still running on platform funds. Same give-up age.
      const untracked = orphans
        ? await orphans.findMany({
            where: { reclaimedAt: null, createdAt: { gte: oldest } },
            select: { id: true, nosanaDeploymentId: true, accessMode: true, createdAt: true },
            orderBy: { createdAt: "asc" },
            take: VAULT_RECLAIM_BATCH_SIZE,
          })
        : [];
      return [
        ...untracked.map((o) => ({
          id: o.id,
          nosanaDeploymentId: o.nosanaDeploymentId,
          orphan: true,
          accessMode: rowAccessMode(o.accessMode),
          ...(o.createdAt ? { endedAt: o.createdAt } : {}),
        })),
        ...rows.flatMap((r) => {
          const nosanaDeploymentId = r.nosanaJobIds[0];
          // Mock ids never had a vault.
          return nosanaDeploymentId && !isMockNosanaId(nosanaDeploymentId)
            ? [
                {
                  id: r.id,
                  nosanaDeploymentId,
                  accessMode: rowAccessMode(r.nosanaAccessMode),
                  ...(r.stoppedAt ? { endedAt: r.stoppedAt } : {}),
                },
              ]
            : [];
        }),
      ];
    };

    deps.reclaimVault = async (candidate) => {
      // `reclaim` stops a deployment that is still running on Nosana before it
      // withdraws (lifecycle reclaimVault), which is what an orphan whose stop
      // failed needs. It goes through the credential that created the
      // deployment; with none for it here the call throws the named error and
      // the tick skips the candidate.
      // A run that failed at its start moments ago may still read DRAFT with
      // the start on its way: it is not released until that can no longer be.
      const outcome = await reclaim(candidate.nosanaDeploymentId, candidate.accessMode, {
        startMayBeInFlight: startMayBeInFlight(candidate.endedAt, now()),
      });
      if (outcome.reclaimed && candidate.orphan) {
        await orphans?.updateMany({
          where: { id: candidate.id, reclaimedAt: null },
          data: { reclaimedAt: now() },
        });
      } else if (outcome.reclaimed) {
        // The CAS names the EXACT Nosana deployment that was reclaimed and
        // requires the row to still be terminal. Keyed on the row id alone, a
        // run the user restarted while this withdraw was in flight (new
        // nosanaJobIds, `pending`, vaultReclaimedAt reset to null) would be
        // stamped "recovered" for the OLD run's vault, and its own NOS would
        // never be reclaimed.
        await prisma.deployment.updateMany({
          where: {
            id: candidate.id,
            vaultReclaimedAt: null,
            nosanaJobIds: { has: candidate.nosanaDeploymentId },
            status: { in: ["stopped", "failed"] },
          },
          data: { vaultReclaimedAt: now() },
        });
      }
      return { reclaimed: outcome.reclaimed };
    };
  }

  return deps;
}
