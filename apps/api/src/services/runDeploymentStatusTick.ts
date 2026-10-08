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
 * correct primitive is the Deployment object: `status` and `endpoints` (the
 * real public URLs, each with `online`), plus the events that explain a halt.
 * observeDeployment returns exactly that, normalised and never invented.
 *
 * Flow per row (AgentDeployment or model Deployment, both polled):
 *   1. observeDeployment(nosanaJobIds[0])                       (strict read)
 *   2. mapObservationToStatus -> target status or null
 *        running + >=1 ONLINE endpoint -> running  (none online = still
 *                                        provisioning; degraded for a running model row)
 *        error                        -> failed    (reason: latest Nosana event)
 *        insufficient_funds           -> failed    (reason: nosana_insufficient_funds)
 *        stopped / archived           -> stopped
 *        draft / starting / stopping  -> no change
 *      A MODEL row needs more than an online endpoint to become `running`:
 *      our own probe of that endpoint must be healthy too (the engine has the
 *      model loaded and it has answered a request). Until then it stays in its
 *      provisioning state, unbilled.
 *      Nosana's `online` is a hint and our probe decides the other way round
 *      as well: when Nosana reports nothing online for a model row, its
 *      endpoints are probed all the same (a waiting row after the grace
 *      period), and one that answers counts as online. Its record of a job can
 *      stay QUEUED while the node serves, and its flag drops when its own
 *      health check misses.
 *   2b. a row still waiting to serve (Nosana RUNNING, nothing online) is
 *      checked for a deployment Nosana cannot place: once it has waited past
 *      a short grace period its newest events are read, and a listing that
 *      keeps failing (JOB_LIST_ERROR newer than any JOB_LIST_CONFIRMED,
 *      repeated or persisting) fails the row with `nosana_list_failed`. A row
 *      that has waited past the provisioning limit fails with `no_capacity`
 *      (no job was ever listed) or `start_timeout` (a job was listed and never
 *      became ready). Either way the deployment is stopped on Nosana in the
 *      same pass, the hold is released once (step 5) and nothing is charged:
 *      the row never reached `running`.
 *      Endpoints exist from the moment the deployment is created, with
 *      online:false, and Nosana says RUNNING as soon as it schedules the LIST
 *      task, before any node holds the job. Only `online` says a node serves.
 *   3. null / same as current -> no write (only-on-change)
 *   4. otherwise persistTransition (CAS on {id, fromStatus} and, for model
 *      rows, the run generation that was loaded) - a concurrent writer (user
 *      stop, another replica's tick, the GPU billing worker) wins and this
 *      tick's stale observation becomes a no-op; so does an observation of a
 *      run the user has since restarted
 *   5. terminal -> release the credit hold (CAS on reservationReleasedAt);
 *      failed for a HALTED Nosana state (error, insufficient_funds) -> issue
 *      the stop in the same pass (stopHaltedDeployment): Nosana keeps retrying
 *      an INSUFFICIENT_FUNDS deployment and revives it after a top-up of the
 *      shared account. The reclaim sweep (8) confirms the stop and retries it
 *   6. model rows: reconcile DeploymentNode rows with the ONLINE endpoints
 *      (one node per endpoint URL - a load-balanced proxy per op, not a
 *      replica; fabricated and offline rows are deleted), then probe each
 *      node with the engine's own health path
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
 * an empty nodeUrl are not probed and stay "unknown". One exception: a probe
 * that does not know yet (`pending`) writes nothing for a node that was
 * healthy on a serving row; that node keeps its health and its last check.
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
  /** Nosana reports a node serving this URL now. Only these count, are probed and get nodes. */
  online: boolean;
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
  /** Model rows only - selects the readiness probe (vllm /health, ollama /api/ps, then one generated token). */
  engine?: string;
  /**
   * Model rows only: the name the engine serves the model under. The Ollama
   * probe is healthy only when this model is loaded and has answered.
   */
  servedModel?: string;
  /**
   * Since when the row has been waiting to serve: the last write to the row
   * (its submit). Absent = the provisioning rules below do not apply to it.
   */
  waitingSince?: Date;
  /**
   * Model rows only: this run has been billed (its billing cursor is set).
   * Such a row is never failed for placement: every placement ending tells
   * the customer that nothing was charged. A row that waits has never been
   * `running` in its run, so this is a second lock, not the first.
   */
  billedThisRun?: boolean;
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
  /**
   * Operator detail of a placement failure: Nosana's own message. Never
   * stored where a customer reads it; `reason` is the stable code.
   */
  detail?: string;
}

export interface DeploymentStatusTickInput {
  now: Date;
  /** How long a waiting row is left alone before its events are read. Default PROVISIONING_GRACE_MS. */
  provisioningGraceMs?: number;
  /** How long a row may wait to serve before it is failed. Default DEFAULT_PROVISIONING_LIMIT_MS. */
  provisioningLimitMs?: number;
}

// ============================================
// A deployment Nosana cannot place
// ============================================

/** statusReason: Nosana keeps failing to list the job (its message is in the log). */
export const LIST_FAILED_REASON = "nosana_list_failed";
/** statusReason: no GPU took the job within the provisioning limit. */
export const NO_CAPACITY_REASON = "no_capacity";
/** statusReason: a node took the job but it was not ready within the provisioning limit. */
export const START_TIMEOUT_REASON = "start_timeout";

export const PLACEMENT_FAILURE_REASONS = [
  LIST_FAILED_REASON,
  NO_CAPACITY_REASON,
  START_TIMEOUT_REASON,
] as const;
export type PlacementFailureReason = (typeof PLACEMENT_FAILURE_REASONS)[number];

/**
 * What a customer reads for each ending (the API's own surfaces, such as an
 * agent deployment's error; the dashboard has the same sentences in
 * apps/web/src/lib/deployments.ts). Product voice: what happened, and what
 * happened to the money. No configuration detail.
 */
export const PLACEMENT_FAILURE_SENTENCES: Readonly<Record<PlacementFailureReason, string>> = {
  [LIST_FAILED_REASON]:
    "This deployment could not be started on the GPU network. Nothing was charged and the credits held for it were returned.",
  [NO_CAPACITY_REASON]:
    "No GPU of this tier became available in time, so the deployment was not started. Nothing was charged and the credits held for it were returned.",
  [START_TIMEOUT_REASON]:
    "The model did not finish starting in time, so the deployment was stopped. Nothing was charged and the credits held for it were returned.",
};

export function isPlacementFailureReason(reason: unknown): reason is PlacementFailureReason {
  return (PLACEMENT_FAILURE_REASONS as readonly unknown[]).includes(reason);
}

/** A waiting row is left alone this long before its Nosana events are read. */
export const PROVISIONING_GRACE_MS = 60_000;
/** A row may wait this long to serve before it is failed (NOSANA_PROVISIONING_LIMIT_SECONDS). */
export const DEFAULT_PROVISIONING_LIMIT_MS = 30 * 60_000;
/** This many listing errors in a row, with no listing in between, are a failure. */
export const LIST_ERROR_MIN_REPEATS = 2;
/** So is one listing error nothing has followed for this long. */
export const LIST_ERROR_PERSIST_MS = 5 * 60_000;

const LIST_ERROR_EVENT = "JOB_LIST_ERROR";
const LIST_CONFIRMED_EVENT = "JOB_LIST_CONFIRMED";
const MAX_PLACEMENT_DETAIL_LENGTH = 500;

/** One Nosana deployment event, as the events route lists it. */
export interface PlacementEvent {
  type: string;
  message: string;
  /** ISO time; null when Nosana sent none. */
  createdAt: string | null;
}

export interface ListingAssessment {
  /**
   * The newest listing outcome: `confirmed` (a job was listed), `error` (the
   * newest attempt failed) or `none` (no listing event at all: still queued).
   */
  outcome: "none" | "confirmed" | "error";
  /** Listing errors since the last confirmed listing (0 unless `error`). */
  errorCount: number;
  /** When the current run of errors began; null when unknown or not `error`. */
  firstErrorAt: Date | null;
  /** Nosana's newest error message, for operators. */
  message?: string;
}

/**
 * Reads the listing outcome out of a deployment's events (`newestFirst`, as
 * the events route answers). Only JOB_LIST_ERROR and JOB_LIST_CONFIRMED
 * count: JOB_RESERVE_CONFIRMED precedes both and says nothing.
 */
export function assessListing(newestFirst: readonly PlacementEvent[]): ListingAssessment {
  let errorCount = 0;
  let firstErrorAt: Date | null = null;
  let message: string | undefined;
  for (const event of newestFirst) {
    if (event.type === LIST_CONFIRMED_EVENT) {
      if (errorCount === 0) return { outcome: "confirmed", errorCount: 0, firstErrorAt: null };
      break;
    }
    if (event.type !== LIST_ERROR_EVENT) continue;
    errorCount += 1;
    if (message === undefined) message = event.message.slice(0, MAX_PLACEMENT_DETAIL_LENGTH);
    const at = event.createdAt ? new Date(event.createdAt) : null;
    // Older than the ones before it: the list is newest first.
    firstErrorAt = at && !Number.isNaN(at.getTime()) ? at : firstErrorAt;
  }
  if (errorCount === 0) return { outcome: "none", errorCount: 0, firstErrorAt: null };
  return { outcome: "error", errorCount, firstErrorAt, ...(message !== undefined ? { message } : {}) };
}

/**
 * Whether a listing that is failing has failed for good: the error repeated
 * with no listing in between, or a single one has stood for
 * LIST_ERROR_PERSIST_MS. One error Nosana's next attempt gets past is not it.
 */
export function listingHasFailed(assessment: ListingAssessment, now: Date): boolean {
  if (assessment.outcome !== "error") return false;
  if (assessment.errorCount >= LIST_ERROR_MIN_REPEATS) return true;
  return (
    assessment.firstErrorAt !== null &&
    now.getTime() - assessment.firstErrorAt.getTime() >= LIST_ERROR_PERSIST_MS
  );
}

/** What the operator is told about a row failed for placement. */
export interface PlacementFailure {
  kind: DeploymentKind;
  id: string;
  orgId: string;
  nosanaDeploymentId: string;
  accessMode?: NosanaAccessModeName;
  reason: PlacementFailureReason;
  /** Nosana's own message, when its events gave one. */
  detail?: string;
  waitedSeconds: number;
  observedAt: Date;
}

/** What a readiness probe of a node says (see DeploymentStatusTickDeps.checkNodeHealth). */
export interface NodeProbeResult {
  healthy: boolean;
  latencyMs: number;
  /** Not known yet: the model is listed and its one-token request is unanswered. */
  pending?: boolean;
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
  /**
   * When the run ended in our records (the row's stoppedAt, an orphan's
   * createdAt). A start sent just before may still land: see
   * DRAFT_START_HOLD_MS.
   */
  endedAt?: Date | null;
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
  /**
   * HTTP readiness probe (checkNodeHealth never throws by contract). `model`
   * is the row's servedModel: the Ollama probe is healthy only when that
   * model is loaded and has answered the probe's own one-token request. An
   * Ollama node that answers without it is asked by the probe, in the
   * background, to load it (services/nosana.ts requestModelLoad): a
   * node that is not healthy gets no request, so nothing else would ever load
   * it. The tick never waits for that.
   *
   * `pending: true` (never with `healthy: true`): the model is listed and the
   * one-token request is not answered yet. The node is loading, or it is warm
   * and busy with a customer's answer (every node, after this process
   * restarts, until its request is answered); the probe cannot tell which. A
   * pending probe never makes a row `running`, and it does not take a node
   * that was healthy out of service: that node's health is left as it was.
   */
  checkNodeHealth: (
    nodeUrl: string,
    engine?: string,
    model?: string,
  ) => Promise<NodeProbeResult>;
  /**
   * Forgets that a node was seen answering (services/nosana.ts
   * forgetNodeAnswered). A node URL belongs to the deployment, not
   * to a container, so the tick says when the server behind it may have
   * changed: an endpoint Nosana reports offline, a node that is dropped, a
   * row that leaves service. Best effort; omit and only the probe forgets.
   */
  forgetNodeReadiness?: (nodeUrl: string) => void;
  /**
   * The newest events of a deployment, newest first (GET .../events). Read
   * only for a row that has waited past the grace period with nothing online.
   * Omit and only the provisioning limit ends such a row. A throw leaves the
   * row waiting (and, at the limit, fails it without Nosana's message).
   */
  readPlacementEvents?: (
    nosanaDeploymentId: string,
    accessMode?: NosanaAccessModeName,
  ) => Promise<PlacementEvent[]>;
  /**
   * Called after a row was failed for placement and its CAS won: for the
   * operator's log and view, with Nosana's own message. Best effort.
   */
  reportPlacementFailure?: (failure: PlacementFailure) => void;
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
  /**
   * Stops a deployment this tick has just moved to `failed` because Nosana
   * halted it (error / insufficient_funds) or could not place it (a failing
   * listing, the provisioning limit), through the credential that created it.
   * `stopRefused`: Nosana did not accept the stop. Throws when the
   * stop could not be sent. Either way the reclaim sweep asks again until the
   * stop is confirmed.
   */
  stopHaltedDeployment?: (
    nosanaDeploymentId: string,
    accessMode?: NosanaAccessModeName,
  ) => Promise<{ stopRefused?: boolean }>;
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
  /** Halted deployments whose stop Nosana accepted in the transition's pass. */
  haltedStops: number;
  /** Halted deployments whose stop was refused or could not be sent (the sweep retries). */
  haltedStopsFailed: number;
  /** Rows failed because Nosana could not place them or they never became ready. */
  placementFailures: number;
  /** Model rows with an endpoint online whose model is not loaded yet (left provisioning, unbilled). */
  awaitingReadiness: number;
  /** Endpoints Nosana reported offline that answered our probe, and were taken as online. */
  offlineEndpointsAnswering: number;
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
 * endpoint is ONLINE (and, for a model row, our own probe of it is healthy:
 * the tick applies that on top of this mapping). Nosana creates the endpoints with the deployment
 * (online:false) and reports RUNNING once it has scheduled the LIST task,
 * before any node is reserved, so neither proves anything is served; `online`
 * turns true only when a node's tunnel is up for a running job. Until then the
 * row stays in its provisioning state, and since `running` is what starts
 * per-second GPU billing, a deployment no node ever picks up is never billed.
 * A model deployment whose endpoints all go offline while `running` becomes
 * `degraded` (and recovers to `running` when one is online again); the agent
 * vocabulary has no degraded, so agents are left alone.
 */
export function mapObservationToStatus(
  kind: DeploymentKind,
  currentStatus: string,
  observation: DeploymentObservation,
): StatusDecision {
  switch (observation.state) {
    case "running": {
      if (observation.endpoints.some((e) => e.online === true) || observation.mock === true) {
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
/** Nosana states that halt a deployment without stopping it. */
const HALTED_STATES = new Set<ObservedDeploymentState>(["error", "insufficient_funds"]);
/** Statuses of a model row that serves, or served and may serve again. */
const SERVING_STATUSES = new Set(["running", "degraded"]);
/** Statuses of a row that has a Nosana deployment and has not served yet. */
const WAITING_STATUSES = new Set(["pending", "provisioning", "building", "deploying"]);
/** Nosana states in which a deployment may still come to serve. */
const WAITING_STATES = new Set<ObservedDeploymentState>(["draft", "starting", "running"]);

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
  let haltedStops = 0;
  let haltedStopsFailed = 0;
  let placementFailures = 0;
  let awaitingReadiness = 0;
  let offlineEndpointsAnswering = 0;
  const graceMs = input.provisioningGraceMs ?? PROVISIONING_GRACE_MS;
  const limitMs = input.provisioningLimitMs ?? DEFAULT_PROVISIONING_LIMIT_MS;
  const unreachable: UnreachableNosanaDeployment[] = [];

  for (const row of rows) {
    // The nodes this row is probed with. Replaced by the reconciled set when
    // syncNodes ran, so a freshly observed endpoint is probed immediately.
    let nodes: DeploymentNodeRow[] = row.nodes ?? [];
    // Probes already made for this row in this tick (the readiness gate), by
    // node URL, so the probe loop below does not repeat them.
    const probes = new Map<string, NodeProbeResult>();
    const forget = (nodeUrl: string) => {
      if (!nodeUrl || !deps.forgetNodeReadiness) return;
      try {
        deps.forgetNodeReadiness(nodeUrl);
      } catch {
        // Best effort: the probe forgets on its own when the node stops answering.
      }
    };

    try {
      const nosanaId = row.nosanaJobIds[0];
      if (!nosanaId) {
        unchanged += 1;
        continue;
      }
      let observation = await deps.observeDeployment(nosanaId, row.nosanaAccessMode);

      // Nosana's `online` is a hint; our own probe of the endpoint decides.
      // Its record can lag behind the node: on the second live vLLM run its
      // job list still said QUEUED, and the endpoint offline, half an hour
      // after the engine had begun answering there. Its flag also drops for
      // some seconds when its own health check misses. So when Nosana reports
      // nothing online for a model row, its endpoints are probed all the same,
      // and one whose probe is healthy (the node answered a generation for the
      // row's model) counts as online for the rest of this pass: the status,
      // the nodes that are kept and what requests are routed to. A waiting row
      // is probed only after the grace period, since nothing can answer in its
      // first minute. An endpoint with no container behind it fails the probe
      // in under a second.
      if (
        row.kind === "model" &&
        observation.mock !== true &&
        observation.state === "running" &&
        observation.endpoints.length > 0 &&
        !observation.endpoints.some((e) => e.online === true) &&
        (SERVING_STATUSES.has(row.status) ||
          (WAITING_STATUSES.has(row.status) &&
            row.waitingSince !== undefined &&
            input.now.getTime() - row.waitingSince.getTime() >= graceMs))
      ) {
        const answering = new Set<string>();
        // Not known yet, on a node that was serving: the probe's one-token
        // request is unanswered (`pending`), which is what a node busy with a
        // customer's answer looks like. As in the node loop below, that does
        // not take a healthy node of a running row out of service: its
        // endpoint is kept for this pass. Only a row that is `running`
        // already, so a pending probe never starts or resumes billing; the
        // probe itself stops reporting `pending` after a minute.
        const stillServing = new Set<string>();
        for (const endpoint of observation.endpoints) {
          try {
            const probe = await deps.checkNodeHealth(endpoint.url, row.engine, row.servedModel);
            probes.set(endpoint.url, probe);
            if (probe.healthy) {
              answering.add(endpoint.url);
            } else if (
              probe.pending === true &&
              row.status === "running" &&
              nodes.some((node) => node.nodeUrl === endpoint.url && node.healthStatus === "healthy")
            ) {
              stillServing.add(endpoint.url);
            }
          } catch {
            // An endpoint that cannot be probed stays as Nosana reported it.
          }
        }
        offlineEndpointsAnswering += answering.size;
        if (answering.size > 0 || stillServing.size > 0) {
          observation = {
            ...observation,
            endpoints: observation.endpoints.map((e) =>
              answering.has(e.url) || stillServing.has(e.url) ? { ...e, online: true } : e,
            ),
          };
        }
      }

      let decision = mapObservationToStatus(row.kind, row.status, observation);
      const online = observation.endpoints.filter((e) => e.online === true);
      // An endpoint nothing serves now: what answers there next may be a new
      // container, which lists its model while it is still loading.
      for (const endpoint of observation.endpoints) {
        if (endpoint.online !== true) forget(endpoint.url);
      }

      // Readiness gate. `running` is what starts per-second billing and what
      // /v1 routes on, and an online endpoint only says a server answers: an
      // Ollama server answers before the model is in GPU memory, and the first
      // request then waits for the load and for the node's first, slow,
      // generation. So a model row becomes `running` only when our own probe
      // of an online endpoint is healthy as well.
      if (
        row.kind === "model" &&
        decision.next === "running" &&
        row.status !== "running" &&
        observation.mock !== true
      ) {
        let ready = false;
        for (const endpoint of online) {
          try {
            const probe =
              probes.get(endpoint.url) ??
              (await deps.checkNodeHealth(endpoint.url, row.engine, row.servedModel));
            probes.set(endpoint.url, probe);
            if (probe.healthy) ready = true;
          } catch {
            // Counted by the probe loop below, which asks again.
          }
        }
        if (!ready) {
          decision = { next: null };
          awaitingReadiness += 1;
        }
      }

      // A row still waiting to serve. Two endings, both `failed` with a stable
      // reason: Nosana keeps failing to list the job, or the wait has passed
      // the provisioning limit. Nothing was ever billed: billing needs
      // `running`, no status ever returns from `running` or `degraded` to a
      // waiting one within a run, and a restart is a new run with its cursor
      // cleared. A row whose cursor is set all the same is left alone
      // (billedThisRun). The hold is released by the terminal path below.
      let placement: PlacementFailure | null = null;
      if (
        decision.next === null &&
        row.waitingSince !== undefined &&
        row.billedThisRun !== true &&
        WAITING_STATUSES.has(row.status) &&
        WAITING_STATES.has(observation.state) &&
        observation.mock !== true
      ) {
        const waitedMs = input.now.getTime() - row.waitingSince.getTime();
        const pastLimit = waitedMs >= limitMs;
        let listing: ListingAssessment | null = null;
        if (
          online.length === 0 &&
          deps.readPlacementEvents &&
          (pastLimit || (observation.state === "running" && waitedMs >= graceMs))
        ) {
          try {
            listing = assessListing(await deps.readPlacementEvents(nosanaId, row.nosanaAccessMode));
          } catch {
            // Unreadable events never fail a row early. At the limit the row
            // is failed all the same, so its hold cannot be kept for ever.
            listing = null;
          }
        }
        let reason: PlacementFailureReason | null = null;
        if (listing && (pastLimit ? listing.outcome === "error" : listingHasFailed(listing, input.now))) {
          reason = LIST_FAILED_REASON;
        } else if (pastLimit) {
          reason =
            online.length > 0 || listing?.outcome === "confirmed"
              ? START_TIMEOUT_REASON
              : NO_CAPACITY_REASON;
        }
        if (reason !== null) {
          placement = {
            kind: row.kind,
            id: row.id,
            orgId: row.orgId,
            nosanaDeploymentId: nosanaId,
            ...(row.nosanaAccessMode ? { accessMode: row.nosanaAccessMode } : {}),
            reason,
            ...(reason === LIST_FAILED_REASON && listing?.message ? { detail: listing.message } : {}),
            waitedSeconds: Math.max(0, Math.floor(waitedMs / 1000)),
            observedAt: input.now,
          };
          decision = { next: "failed", reason };
        }
      }

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
          ...(placement?.detail ? { detail: placement.detail } : {}),
        };
        const { count, reservationReleased } = await deps.persistTransition(transition);
        if (count > 0) {
          transitioned += 1;
          if (placement) {
            placementFailures += 1;
            try {
              deps.reportPlacementFailure?.(placement);
            } catch {
              // Reporting is for the log; it never fails the row.
            }
          }
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

          // Failed because Nosana halted it: stop it now. INSUFFICIENT_FUNDS
          // is recoverable on Nosana, so a halted deployment left alone comes
          // back to life when the shared balance is topped up - with our row
          // already terminal. Isolated: the transition is committed, and the
          // reclaim sweep below retries the stop until it is confirmed.
          // The same for a deployment failed for placement: Nosana still
          // reports it RUNNING and goes on trying to list it.
          if (
            decision.next === "failed" &&
            (HALTED_STATES.has(observation.state) || placement !== null) &&
            deps.stopHaltedDeployment
          ) {
            try {
              const stop = await deps.stopHaltedDeployment(nosanaId, row.nosanaAccessMode);
              if (stop.stopRefused === true) haltedStopsFailed += 1;
              else haltedStops += 1;
            } catch {
              haltedStopsFailed += 1;
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
          // Only what a node serves: /v1 routes to these nodes and the probe
          // below checks them. An offline endpoint's node is removed.
          endpoints = online;
        }
        if (endpoints !== null) {
          // Out of service: nothing seen answering for this row counts again.
          if (endpoints.length === 0) {
            for (const node of nodes) forget(node.nodeUrl);
            for (const endpoint of observation.endpoints) forget(endpoint.url);
          }
          try {
            const before = nodes;
            nodes = await deps.syncNodes({
              deploymentId: row.id,
              endpoints,
              ...(row.runGeneration !== undefined ? { runGeneration: row.runGeneration } : {}),
            });
            nodeSyncs += 1;
            // A node that was dropped: its URL is no longer served.
            const kept = new Set(nodes.map((node) => node.nodeUrl));
            for (const node of before) {
              if (!kept.has(node.nodeUrl)) forget(node.nodeUrl);
            }
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
        const probe =
          probes.get(node.nodeUrl) ??
          (await deps.checkNodeHealth(node.nodeUrl, row.engine, row.servedModel));
        // Not known yet (the model is listed, its one-token request is not
        // answered): a node that was serving stays as it was. After a restart
        // of this process that is every node that is busy with a customer's
        // answer, and marking it unhealthy would take a working deployment
        // out of service until the next tick. A node that was not healthy
        // gets no benefit of the doubt: it is written unhealthy as before.
        if (
          probe.pending === true &&
          !probe.healthy &&
          node.healthStatus === "healthy" &&
          SCALABLE_STATUSES.has(row.status)
        ) {
          nodesProbed += 1;
          continue;
        }
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
    haltedStops,
    haltedStopsFailed,
    placementFailures,
    awaitingReadiness,
    offlineEndpointsAnswering,
  };
}
