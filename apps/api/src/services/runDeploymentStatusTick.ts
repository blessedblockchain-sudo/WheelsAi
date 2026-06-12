/**
 * Deployment-status poll tick (plan D8).
 *
 * One call = one tick of the BullMQ deployment-status worker. Pure
 * orchestration; every IO surface is dependency-injected.
 *
 * Replaces the setTimeout(8000) "Simulate deployment completion" in
 * routes/agents.ts (and its 5s twin in routes/deployments.ts): status
 * transitions are now OBSERVED from Nosana job state, persisted via
 * compare-and-set, and survive restarts — there is no in-memory state,
 * so a redeploy mid-provisioning simply gets observed on the next tick.
 *
 * Flow per row (AgentDeployment or model Deployment, both polled):
 *   1. getJobState(jobId) for every nosanaJobId on the row
 *   2. mapJobStatesToDeploymentStatus → target status or null
 *   3. null / same as current → no write (only-on-change)
 *   4. otherwise persistTransition (CAS on {id, fromStatus}) — a
 *      concurrent writer (user-initiated stop, another replica's tick)
 *      wins and this tick's stale observation becomes a no-op
 *
 * Failure semantics:
 *   - getJobState throw (SDK/RPC outage) → that row is counted failed
 *     and left UNTOUCHED; remaining rows still run (per-row isolation).
 *     An RPC outage must never fabricate or destroy deployment status.
 *   - loadDeployments errors bubble — if the candidate set can't be
 *     read there is nothing to isolate, and BullMQ should see the
 *     failure.
 */

export type NosanaJobPollState = "queued" | "running" | "completed" | "failed";

export type DeploymentKind = "agent" | "model";

export interface DeploymentStatusRow {
  kind: DeploymentKind;
  id: string;
  /** Current persisted status — the CAS guard for the transition. */
  status: string;
  nosanaJobIds: string[];
}

export interface DeploymentStatusTransition {
  kind: DeploymentKind;
  id: string;
  fromStatus: string;
  toStatus: string;
  observedAt: Date;
}

export interface DeploymentStatusTickInput {
  now: Date;
}

export interface DeploymentStatusTickDeps {
  loadDeployments: () => Promise<DeploymentStatusRow[]>;
  /** Strict job-state read — THROWS on SDK/RPC failure. */
  getJobState: (jobId: string) => Promise<NosanaJobPollState>;
  /** CAS updateMany on {id, fromStatus}; count=0 means a concurrent writer won. */
  persistTransition: (
    transition: DeploymentStatusTransition,
  ) => Promise<{ count: number }>;
}

export interface DeploymentStatusTickResult {
  scanned: number;
  transitioned: number;
  unchanged: number;
  failed: number;
}

/**
 * Map the observed Nosana job states of a deployment's replicas onto the
 * deployment-status vocabulary (schema comments are the source of truth):
 *
 *   AgentDeployment: pending | building | deploying | running | stopped | failed
 *   Deployment:      pending | provisioning | running | degraded | stopped | failed
 *
 * Table (top rule wins):
 *   all failed                          → failed
 *   any running + any failed (model)    → degraded   (partial capacity —
 *                                         agent vocabulary has no degraded,
 *                                         so agents stay running)
 *   any running                         → running
 *   all ended, none failed              → stopped    (jobs completed)
 *   all ended, some failed              → failed
 *   otherwise (queued still in flight)  → null       (not an observation —
 *                                         keep whatever the submit path set:
 *                                         building/deploying/provisioning)
 *
 * Returns null when the states do not justify a transition.
 */
export function mapJobStatesToDeploymentStatus(
  kind: DeploymentKind,
  jobStates: NosanaJobPollState[],
): string | null {
  if (jobStates.length === 0) return null;

  const anyRunning = jobStates.some((s) => s === "running");
  const anyFailed = jobStates.some((s) => s === "failed");
  const allFailed = jobStates.every((s) => s === "failed");
  const allEnded = jobStates.every(
    (s) => s === "completed" || s === "failed",
  );

  if (allFailed) return "failed";
  if (anyRunning && anyFailed && kind === "model") return "degraded";
  if (anyRunning) return "running";
  if (allEnded) return anyFailed ? "failed" : "stopped";
  return null;
}

export async function runDeploymentStatusTick(
  input: DeploymentStatusTickInput,
  deps: DeploymentStatusTickDeps,
): Promise<DeploymentStatusTickResult> {
  const rows = await deps.loadDeployments();

  let transitioned = 0;
  let unchanged = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const states: NosanaJobPollState[] = [];
      for (const jobId of row.nosanaJobIds) {
        states.push(await deps.getJobState(jobId));
      }

      const next = mapJobStatesToDeploymentStatus(row.kind, states);
      if (next === null || next === row.status) {
        unchanged += 1;
        continue;
      }

      const { count } = await deps.persistTransition({
        kind: row.kind,
        id: row.id,
        fromStatus: row.status,
        toStatus: next,
        observedAt: input.now,
      });
      if (count > 0) {
        transitioned += 1;
      } else {
        // CAS miss — a concurrent writer already moved the row.
        unchanged += 1;
      }
    } catch {
      // SDK/RPC error (or persist failure) — row left untouched, the
      // next tick retries. Other rows still run.
      failed += 1;
    }
  }

  return { scanned: rows.length, transitioned, unchanged, failed };
}
