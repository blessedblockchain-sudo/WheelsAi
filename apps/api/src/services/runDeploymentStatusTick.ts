/**
 * Deployment-status poll tick (plan D8, reworked for the Nosana Deployment
 * Manager in W2).
 *
 * One call = one tick of the BullMQ deployment-status worker. Pure
 * orchestration; every IO surface is dependency-injected.
 *
 * What a row's `nosanaJobIds[0]` is
 * ---------------------------------
 * The Nosana DEPLOYMENT-MANAGER id returned by createDeployment - not an
 * on-chain job address. The old tick polled it with `sdk.jobs.get(...)`, which
 * throws for such ids, so model deployments sat in `provisioning` forever. The
 * correct primitive is the Deployment object: `status`, `endpoints` (the real
 * public URLs), `jobs`, `events`. observeDeployment returns exactly that,
 * normalised and never invented.
 *
 * Flow per row (AgentDeployment or model Deployment, both polled):
 *   1. observeDeployment(nosanaJobIds[0])                       (strict read)
 *   2. mapObservationToStatus -> target status or null
 *        running + >=1 endpoint       -> running   (no URL yet = still provisioning)
 *        error                        -> failed    (reason: latest Nosana event)
 *        insufficient_funds           -> failed    (reason: nosana_insufficient_funds)
 *        stopped / archived           -> stopped
 *        draft / starting / stopping  -> no change
 *   3. null / same as current -> no write (only-on-change)
 *   4. otherwise persistTransition (CAS on {id, fromStatus} and, for model
 *      rows, the run generation that was loaded) - a concurrent writer (user
 *      stop, another replica's tick, the GPU billing worker) wins and this
 *      tick's stale observation becomes a no-op; so does an observation of a
 *      run the user has since restarted
 *   5. terminal -> release the credit hold (CAS on reservationReleasedAt)
 *   6. model rows: reconcile DeploymentNode rows with the observed endpoints
 *      (one node per endpoint URL; fabricated rows are deleted), then probe
 *      each node with the engine's own health path
 *   7. model rows still in service: reconcile the replica count with what
 *      Nosana really runs - a replica-change claim its request never finished
 *      (crash, ambiguous Nosana failure) once it is stale, or a count that
 *      differs with no claim at all
 *   8. sweeps (after the row loop): retry the credit-hold release of terminal
 *      rows whose hold is still unreleased (step 5 is best-effort and terminal
 *      rows are never loaded again, so this is what retries it), and retry
 *      `vault.withdraw` for stopped/failed model deployments whose vault funds
 *      were not yet verified recovered, and for Nosana deployments no row
 *      tracks (nosana_orphan_deployments)
 *
 * Node health (plan A2): this tick is the ONLY writer that can mark a
 * DeploymentNode healthy. Health is persisted on EVERY probe, not only on
 * change: lastHealthCheck is a freshness signal the deploy UI reads. Nodes with
 * an empty nodeUrl are not probed and stay "unknown".
 *
 * Failure semantics:
 *   - observeDeployment throw (API/RPC outage) -> that row is counted failed
 *     and left UNTOUCHED; remaining rows still run (per-row isolation). An
 *     outage must never fabricate or destroy deployment status.
 *   - node probes are isolated PER NODE and run even when the row's observation
 *     failed - an API outage says nothing about whether a node's HTTP endpoint
 *     is up.
 *   - loadDeployments errors bubble - if the candidate set can't be read there
 *     is nothing to isolate, and BullMQ should see the failure.
 *   - a row or reclaim candidate whose Nosana id was created by an access mode
 *     this process holds no credential for (error code
 *     nosana_access_mode_unavailable) is SKIPPED, not failed: no retry from
 *     here can reach it. They are counted and reported once per tick
 *     (reportAccessModeUnavailable).
 */

/** "wallet" | "api_key": the Nosana credential that created an id. */
export type NosanaAccessModeName = "wallet" | "api_key";

/** Code of the error a NosanaClient call throws for a mode it has no credential for. */
export const ACCESS_MODE_UNAVAILABLE_CODE = "nosana_access_mode_unavailable";

function isAccessModeUnavailable(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === ACCESS_MODE_UNAVAILABLE_CODE;
}

/** A Nosana id this tick could not act on for want of its account's credential. */
export interface UnreachableNosanaDeployment {
  /** "row": a live deployment row; "reclaim": a sweep candidate. */
  source: "row" | "reclaim";
  /** The deployment row, or the orphan record when `orphan`. */
  id: string;
  kind?: DeploymentKind;
  orphan?: boolean;
  nosanaDeploymentId: string;
  accessMode?: NosanaAccessModeName;
}

export type DeploymentKind = "agent" | "model";

/** Normalised Nosana deployment states (see nosanaDeploymentLifecycle.ts). */
export type ObservedDeploymentState =
  | "draft"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "insufficient_funds"
  | "error"
  | "archived";

export interface ObservedEndpoint {
  url: string;
  port: number | string;
  opId: string;
}

export interface DeploymentObservation {
  state: ObservedDeploymentState;
  /** Real endpoints reported by Nosana. Never synthesised. */
  endpoints: ObservedEndpoint[];
  /** Latest Nosana event message, used as the failure reason for `error`. */
  detail?: string;
  /** Dev-only mock observation: `running` is acceptable without endpoints. */
  mock?: boolean;
  /** The replica count Nosana reports for the deployment. */
  replicas?: number;
}

/** A replica change claimed on a model row (PATCH /deployments/:id) and not yet resolved. */
export interface PendingReplicaChange {
  /** Deployment.replicaChangeId - the claim's token. */
  id: string;
  to: number;
  claimedAt: Date;
  /** Credits a scale-up claim added to the hold. */
  holdCents: bigint | null;
}

/**
 * How long a replica-change claim may sit before the tick resolves it from
 * Nosana's real count. Generous on purpose: a scale-up funds the vault on-chain
 * before it changes the count, and resolving a claim whose request is still
 * working would only be corrected a tick later.
 */
export const REPLICA_CHANGE_STALE_MS = 5 * 60_000;

export interface DeploymentNodeRow {
  id: string;
  nodeUrl: string;
  healthStatus: string;
}

export interface DeploymentStatusRow {
  kind: DeploymentKind;
  id: string;
  /** Owning org - carried so observed transitions can emit webhooks. */
  orgId: string;
  /** Current persisted status - the CAS guard for the transition. */
  status: string;
  /** nosanaJobIds[0] is the Nosana Deployment-Manager id. */
  nosanaJobIds: string[];
  /**
   * The credential that created nosanaJobIds (the row's stamp; a null column
   * is wallet). Omitted = the primary mode, as before the stamp existed.
   */
  nosanaAccessMode?: NosanaAccessModeName;
  /**
   * Model rows only: Deployment.runGeneration as loaded. A restart reuses the
   * row for a new Nosana deployment, so every write this tick makes for the row
   * is conditional on it (an agent deployment row is never reused).
   */
  runGeneration?: number;
  /** Model rows only: the CONFIRMED replica count (what billing charges). */
  replicas?: number;
  /** Model rows only: a replica change in flight, if any. */
  replicaChange?: PendingReplicaChange | null;
  /** Model rows only - AgentDeployment has no nodes relation. */
  nodes?: DeploymentNodeRow[];
  /** Model rows only - selects the health path (vllm /health, ollama /api/tags). */
  engine?: string;
  /** Credit hold taken at admission; null once released. */
  reservationCents?: bigint | null;
  reservationReleasedAt?: Date | null;
}

export interface DeploymentStatusTransition {
  kind: DeploymentKind;
  id: string;
  orgId: string;
  fromStatus: string;
  toStatus: string;
  observedAt: Date;
  /** Why the deployment left service (failed / stopped transitions). */
  reason?: string;
  /** Model rows only: the run that was observed (part of the CAS). */
  runGeneration?: number;
  /** The Nosana deployment the observation was made of. */
  nosanaDeploymentId?: string;
  /** The credential that created it (carried to the orphan record). */
  nosanaAccessMode?: NosanaAccessModeName;
}

export interface DeploymentStatusTickInput {
  now: Date;
}

export interface NodeHealthObservation {
  nodeId: string;
  healthStatus: "healthy" | "unhealthy";
  latencyMs: number;
  checkedAt: Date;
}

/**
 * A Nosana deployment whose vault is not yet verified empty: a stopped/failed
 * model deployment's, or one no row tracks (`orphan`, where `id` is the
 * nosana_orphan_deployments row).
 */
export interface VaultReclaimCandidate {
  id: string;
  /** The Nosana Deployment-Manager id. */
  nosanaDeploymentId: string;
  orphan?: boolean;
  /** The credential that created it; the reclaim goes through the same one. */
  accessMode?: NosanaAccessModeName;
}

export interface DeploymentStatusTickDeps {
  loadDeployments: () => Promise<DeploymentStatusRow[]>;
  /**
   * Strict Deployment-Manager read - THROWS on API failure (and on ids that
   * cannot be queried). Endpoints are exactly what Nosana reported.
   */
  observeDeployment: (
    nosanaDeploymentId: string,
    accessMode?: NosanaAccessModeName,
  ) => Promise<DeploymentObservation>;
  /**
   * CAS updateMany on {id, fromStatus} (plus runGeneration when the transition
   * carries one); count=0 means a concurrent writer won - and then nothing
   * else was written either. A model row leaving `running` is settled in the
   * same transaction as its status change; when that also released the
   * admission hold (a terminal edge) it says so.
   */
  persistTransition: (
    transition: DeploymentStatusTransition,
  ) => Promise<{ count: number; reservationReleased?: boolean }>;
  /**
   * Model rows only: makes the row's confirmed replica count equal what Nosana
   * runs and resolves the pending claim, if any - by CAS on the row as loaded
   * (run, count, claim token), settling the window at the old count and
   * adjusting the hold in the same transaction. `reconciled: false` means a
   * concurrent writer got there first.
   */
  reconcileReplicas?: (args: {
    id: string;
    orgId: string;
    runGeneration?: number;
    /** The confirmed count as loaded. */
    replicas: number;
    claim: PendingReplicaChange | null;
    /** What Nosana reports. */
    observedReplicas: number;
    observedAt: Date;
  }) => Promise<{ reconciled: boolean }>;
  /**
   * Model rows only: makes the deployment's DeploymentNode rows equal the
   * observed endpoints (create missing, delete the rest, keep health of
   * unchanged ones) and returns the resulting rows. An empty list removes all
   * nodes. Must not create nodes for a deployment that is no longer in service.
   */
  syncNodes?: (args: {
    deploymentId: string;
    endpoints: ObservedEndpoint[];
    /** The run the endpoints were observed for; a later run gets no nodes from it. */
    runGeneration?: number;
  }) => Promise<DeploymentNodeRow[]>;
  /** HTTP readiness probe (checkNodeHealth never throws by contract). */
  checkNodeHealth: (
    nodeUrl: string,
    engine?: string,
  ) => Promise<{ healthy: boolean; latencyMs: number }>;
  /** Race-safe write of a probe result (updateMany by node id). */
  persistNodeHealth: (observation: NodeHealthObservation) => Promise<void>;
  /**
   * Fired after a transition WINS its CAS - the tick-observed side of the
   * deployment.* webhook events (running/failed and job-ended stopped; the
   * user-initiated started/stopped emit at the routes). Best-effort: a throw
   * here never fails the row.
   */
  emitTransition: (transition: DeploymentStatusTransition) => Promise<void>;
  /**
   * Gives the admission credit hold back when a deployment reaches a terminal
   * state. Idempotent by CAS on reservationReleasedAt, so a concurrent tick
   * cannot double-refund. Best-effort at THIS layer: a throw is counted and
   * retried next tick rather than failing the row's status transition, which
   * has already been persisted.
   */
  releaseReservation?: (args: {
    kind: DeploymentKind;
    id: string;
    orgId: string;
    reservationCents: bigint;
    reason: string;
    /** Set on the transition path: release only this run's hold. */
    runGeneration?: number;
  }) => Promise<{ released: boolean }>;
  /**
   * Terminal (stopped/failed) rows of either kind whose credit hold is STILL
   * unreleased (reservationReleasedAt null, reservationCents > 0). loadDeployments
   * only loads non-terminal rows, so a release that failed after its
   * transition - here, at the stop route, or at a submit failure - would
   * otherwise never be retried by anyone. Each row is released through
   * releaseReservation (idempotent by its CAS).
   */
  loadUnreleasedReservations?: () => Promise<
    Array<{
      kind: DeploymentKind;
      id: string;
      orgId: string;
      /** Terminal status of the row; recorded as the release reason. */
      status: string;
      reservationCents: bigint;
    }>
  >;
  /**
   * Stopped/failed model deployments still holding unrecovered vault funds,
   * and untracked Nosana deployments recorded for this sweep.
   */
  loadVaultReclaimCandidates?: () => Promise<VaultReclaimCandidate[]>;
  /**
   * Retries the vault withdraw for one candidate and, when the funds are
   * verified recovered, records it (vaultReclaimedAt). `reclaimed: false`
   * means "not yet" (e.g. Nosana still winding the jobs down) - retried next tick.
   */
  reclaimVault?: (candidate: VaultReclaimCandidate) => Promise<{ reclaimed: boolean }>;
  /**
   * Called at most ONCE per tick, with every id that was skipped because its
   * access mode has no credential here. For the operator's log. Best effort.
   */
  reportAccessModeUnavailable?: (skipped: UnreachableNosanaDeployment[]) => void;
}

export interface DeploymentStatusTickResult {
  scanned: number;
  transitioned: number;
  unchanged: number;
  failed: number;
  nodesProbed: number;
  reservationsReleased: number;
  /** Releases that failed (in the transition path or the sweep) and will be retried. */
  reservationReleasesFailed: number;
  nodesUnhealthy: number;
  nodeProbesFailed: number;
  nodeSyncs: number;
  nodeSyncsFailed: number;
  vaultsReclaimed: number;
  vaultsPending: number;
  vaultReclaimsFailed: number;
  /** Rows whose replica count (or stale claim) was brought in line with Nosana. */
  replicasReconciled: number;
  replicaReconcilesFailed: number;
  /** Rows and reclaim candidates skipped: no credential for their access mode. */
  accessModeUnavailable: number;
}

export interface StatusDecision {
  next: string | null;
  reason?: string;
}

/**
 * Map one Nosana observation onto the deployment-status vocabulary (schema
 * comments are the source of truth):
 *
 *   AgentDeployment: pending | building | deploying | running | stopped | failed
 *   Deployment:      pending | provisioning | running | degraded | stopped | failed
 *
 * A deployment is `running` only when Nosana reports RUNNING AND at least one
 * real endpoint exists - a RUNNING deployment with no URL cannot serve
 * traffic, so it stays in its provisioning state. A model deployment that
 * loses every endpoint while `running` becomes `degraded` (and recovers to
 * `running` when an endpoint returns); the agent vocabulary has no degraded,
 * so agents are left alone.
 */
export function mapObservationToStatus(
  kind: DeploymentKind,
  currentStatus: string,
  observation: DeploymentObservation,
): StatusDecision {
  switch (observation.state) {
    case "running": {
      if (observation.endpoints.length > 0 || observation.mock === true) {
        return { next: "running" };
      }
      if (kind === "model" && currentStatus === "running") {
        return { next: "degraded", reason: "no_live_endpoint" };
      }
      return { next: null };
    }
    case "error":
      return { next: "failed", reason: observation.detail?.trim() || "nosana_error" };
    case "insufficient_funds":
      return { next: "failed", reason: "nosana_insufficient_funds" };
    case "stopped":
    case "archived":
      return { next: "stopped", reason: "nosana_stopped" };
    case "draft":
    case "starting":
    case "stopping":
      return { next: null };
  }
}

/** States where the deployment will never deliver further capacity. */
const TERMINAL_STATUSES = new Set(["failed", "stopped"]);
/** Statuses in which a model deployment may legitimately own DeploymentNodes. */
const NODE_OWNING_STATUSES = new Set(["pending", "provisioning", "running", "degraded"]);
/** Statuses in which a replica count is live on Nosana and can be reconciled. */
const SCALABLE_STATUSES = new Set(["running", "degraded"]);

export async function runDeploymentStatusTick(
  input: DeploymentStatusTickInput,
  deps: DeploymentStatusTickDeps,
): Promise<DeploymentStatusTickResult> {
  const rows = await deps.loadDeployments();

  let transitioned = 0;
  let unchanged = 0;
  let failed = 0;
  let nodesProbed = 0;
  let reservationsReleased = 0;
  let reservationReleasesFailed = 0;
  let nodesUnhealthy = 0;
  let nodeProbesFailed = 0;
  let nodeSyncs = 0;
  let nodeSyncsFailed = 0;
  let replicasReconciled = 0;
  let replicaReconcilesFailed = 0;
  const unreachable: UnreachableNosanaDeployment[] = [];

  for (const row of rows) {
    // The nodes this row is probed with. Replaced by the reconciled set when
    // syncNodes ran, so a freshly observed endpoint is probed immediately.
    let nodes: DeploymentNodeRow[] = row.nodes ?? [];

    try {
      const nosanaId = row.nosanaJobIds[0];
      if (!nosanaId) {
        unchanged += 1;
        continue;
      }
      const observation = await deps.observeDeployment(nosanaId, row.nosanaAccessMode);
      const decision = mapObservationToStatus(row.kind, row.status, observation);

      // The status the row is in AFTER this tick, or null when unknown (lost
      // the CAS - a concurrent writer moved it, so don't touch its nodes).
      let effectiveStatus: string | null = row.status;

      if (decision.next === null || decision.next === row.status) {
        unchanged += 1;
      } else {
        const transition: DeploymentStatusTransition = {
          kind: row.kind,
          id: row.id,
          orgId: row.orgId,
          fromStatus: row.status,
          toStatus: decision.next,
          observedAt: input.now,
          ...(decision.reason ? { reason: decision.reason } : {}),
          ...(row.runGeneration !== undefined ? { runGeneration: row.runGeneration } : {}),
          nosanaDeploymentId: nosanaId,
          ...(row.nosanaAccessMode ? { nosanaAccessMode: row.nosanaAccessMode } : {}),
        };
        const { count, reservationReleased } = await deps.persistTransition(transition);
        if (count > 0) {
          transitioned += 1;
          if (reservationReleased) reservationsReleased += 1;
          effectiveStatus = decision.next;
          // Only the CAS winner announces - a loser emitting would
          // duplicate the event from whichever writer actually moved
          // the row.
          await deps.emitTransition(transition).catch(() => {});

          // A terminal deployment's admission hold is over: `failed`
          // delivered no capacity at all, and `stopped` is billed for what it
          // consumed by the GPU billing worker. Holding either forever turns
          // the ticket into a silent fee. (A model row that left `running` had
          // its hold released inside persistTransition, where it can cover the
          // final window; this call is then a no-op by its CAS.)
          if (
            TERMINAL_STATUSES.has(decision.next) &&
            deps.releaseReservation &&
            row.reservationCents &&
            row.reservationCents > 0n &&
            !row.reservationReleasedAt
          ) {
            try {
              const outcome = await deps.releaseReservation({
                kind: row.kind,
                id: row.id,
                orgId: row.orgId,
                reservationCents: row.reservationCents,
                reason: decision.next,
                ...(row.runGeneration !== undefined
                  ? { runGeneration: row.runGeneration }
                  : {}),
              });
              if (outcome.released) reservationsReleased += 1;
            } catch {
              // The status change is already committed; the refund is
              // retried by the unreleased-reservation sweep below on this and
              // later ticks (the row still has a null reservationReleasedAt,
              // which is what selects it).
              reservationReleasesFailed += 1;
            }
          }
        } else {
          // CAS miss - a concurrent writer already moved the row.
          unchanged += 1;
          effectiveStatus = null;
        }
      }

      // Reconcile nodes with what Nosana actually reports. Isolated so a node
      // write failure cannot undo the status observation above.
      if (row.kind === "model" && deps.syncNodes && effectiveStatus !== null) {
        let endpoints: ObservedEndpoint[] | null = null;
        if (TERMINAL_STATUSES.has(effectiveStatus)) {
          endpoints = []; // out of service: no node may keep serving traffic
        } else if (
          NODE_OWNING_STATUSES.has(effectiveStatus) &&
          observation.state === "running"
        ) {
          endpoints = observation.endpoints;
        }
        if (endpoints !== null) {
          try {
            nodes = await deps.syncNodes({
              deploymentId: row.id,
              endpoints,
              ...(row.runGeneration !== undefined ? { runGeneration: row.runGeneration } : {}),
            });
            nodeSyncs += 1;
          } catch {
            nodeSyncsFailed += 1;
          }
        }
      }

      // Replica count. `replicas` on the row is what billing charges, so it
      // must be what Nosana runs. Two cases are corrected here, both from the
      // count Nosana itself reports:
      //   - a claim nobody resolved (the request crashed, or Nosana's answer
      //     was ambiguous), once it is stale;
      //   - no claim, but the counts differ.
      // A fresh claim is left alone: its request is still talking to Nosana.
      const observedReplicas = observation.replicas;
      if (
        row.kind === "model" &&
        deps.reconcileReplicas &&
        effectiveStatus !== null &&
        SCALABLE_STATUSES.has(effectiveStatus) &&
        observation.state === "running" &&
        observation.mock !== true &&
        row.replicas !== undefined &&
        observedReplicas !== undefined &&
        Number.isInteger(observedReplicas) &&
        observedReplicas >= 1
      ) {
        const claim = row.replicaChange ?? null;
        const due = claim
          ? input.now.getTime() - claim.claimedAt.getTime() >= REPLICA_CHANGE_STALE_MS
          : observedReplicas !== row.replicas;
        if (due) {
          try {
            const outcome = await deps.reconcileReplicas({
              id: row.id,
              orgId: row.orgId,
              ...(row.runGeneration !== undefined ? { runGeneration: row.runGeneration } : {}),
              replicas: row.replicas,
              claim,
              observedReplicas,
              observedAt: input.now,
            });
            if (outcome.reconciled) replicasReconciled += 1;
          } catch {
            replicaReconcilesFailed += 1; // nothing was written; retried next tick
          }
        }
      }
    } catch (err) {
      if (isAccessModeUnavailable(err)) {
        // Not an outage: this process cannot reach the row's Nosana account at
        // all. Left untouched and named, never retried into the failure count.
        unreachable.push({
          source: "row",
          id: row.id,
          kind: row.kind,
          nosanaDeploymentId: row.nosanaJobIds[0] ?? "",
          ...(row.nosanaAccessMode ? { accessMode: row.nosanaAccessMode } : {}),
        });
      } else {
        // API/RPC error (or persist failure) - row left untouched, the next
        // tick retries. Other rows still run.
        failed += 1;
      }
    }

    // Node health probes - outside the status try/catch: an API outage says
    // nothing about a node's HTTP endpoint, so a blinded row still gets its
    // nodes probed. Isolated per node so one bad persist can't stop the rest.
    for (const node of nodes) {
      // Nothing to probe -> the node honestly stays "unknown" rather than being
      // fabricated unhealthy.
      if (!node.nodeUrl) continue;
      try {
        const probe = await deps.checkNodeHealth(node.nodeUrl, row.engine);
        await deps.persistNodeHealth({
          nodeId: node.id,
          healthStatus: probe.healthy ? "healthy" : "unhealthy",
          latencyMs: probe.latencyMs,
          checkedAt: input.now,
        });
        nodesProbed += 1;
        if (!probe.healthy) nodesUnhealthy += 1;
      } catch {
        nodeProbesFailed += 1;
      }
    }
  }

  // Unreleased-reservation sweep: terminal rows whose hold is still held (a
  // failed release above, at the stop route, or at a submit failure). Every
  // failure is isolated; the row stays selected until a release wins its CAS.
  if (deps.loadUnreleasedReservations && deps.releaseReservation) {
    let unreleased: Awaited<ReturnType<NonNullable<typeof deps.loadUnreleasedReservations>>> = [];
    try {
      unreleased = await deps.loadUnreleasedReservations();
    } catch {
      reservationReleasesFailed += 1;
    }
    for (const held of unreleased) {
      try {
        const outcome = await deps.releaseReservation({
          kind: held.kind,
          id: held.id,
          orgId: held.orgId,
          reservationCents: held.reservationCents,
          reason: held.status,
        });
        if (outcome.released) reservationsReleased += 1;
      } catch {
        reservationReleasesFailed += 1;
      }
    }
  }

  // Vault reclaim sweep (runs after the loop so a deployment that just went
  // terminal is retried in the same tick). Every failure is isolated.
  let vaultsReclaimed = 0;
  let vaultsPending = 0;
  let vaultReclaimsFailed = 0;
  if (deps.loadVaultReclaimCandidates && deps.reclaimVault) {
    let candidates: VaultReclaimCandidate[] = [];
    try {
      candidates = await deps.loadVaultReclaimCandidates();
    } catch {
      vaultReclaimsFailed += 1;
    }
    for (const candidate of candidates) {
      try {
        const outcome = await deps.reclaimVault(candidate);
        if (outcome.reclaimed) vaultsReclaimed += 1;
        else vaultsPending += 1;
      } catch (err) {
        if (isAccessModeUnavailable(err)) {
          unreachable.push({
            source: "reclaim",
            id: candidate.id,
            ...(candidate.orphan ? { orphan: true } : {}),
            nosanaDeploymentId: candidate.nosanaDeploymentId,
            ...(candidate.accessMode ? { accessMode: candidate.accessMode } : {}),
          });
        } else {
          vaultReclaimsFailed += 1;
        }
      }
    }
  }

  if (unreachable.length > 0 && deps.reportAccessModeUnavailable) {
    try {
      deps.reportAccessModeUnavailable(unreachable);
    } catch {
      // Reporting is for the log; it never fails the tick.
    }
  }

  return {
    scanned: rows.length,
    transitioned,
    unchanged,
    failed,
    nodesProbed,
    reservationsReleased,
    reservationReleasesFailed,
    nodesUnhealthy,
    nodeProbesFailed,
    nodeSyncs,
    nodeSyncsFailed,
    vaultsReclaimed,
    vaultsPending,
    vaultReclaimsFailed,
    replicasReconciled,
    replicaReconcilesFailed,
    accessModeUnavailable: unreachable.length,
  };
}
