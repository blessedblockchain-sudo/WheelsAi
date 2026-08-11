/**
 * GitHub `push` handling (W2) — what a commit actually causes.
 *
 * The honest scope matters here. There is no agent-runtime image in this
 * repo that consumes `AGENT_SOURCE_URL` and builds a pushed commit, so a
 * push CANNOT mean "your new code is live". Claiming that would be the
 * fabricated-success pattern this codebase has spent weeks removing.
 *
 * What a push does mean:
 *   1. Record an AgentVersion carrying the commit SHA — a real, auditable
 *      "this agent's source moved to <sha>".
 *   2. If (and only if) the agent opted in AND has a running deployment,
 *      re-submit it through the EXISTING admission path — quota and the
 *      credit reservation. Never around the money gate: a webhook is an
 *      unauthenticated-by-us trigger, and letting it bypass admission
 *      would let a push spend an org's credits without a human involved.
 *
 * Tenancy: the org comes from the STORED installation row, keyed by
 * `installation.id`. Never from `payload.repository.owner` or
 * `payload.sender` — the body is attacker-shaped to anyone who learns the
 * webhook secret, and trusting it would let one push write into another
 * org's agents.
 */

export interface PushPayload {
  ref?: string;
  after?: string;
  repository?: {
    full_name?: string;
    default_branch?: string;
  };
  pusher?: { name?: string };
  installation?: { id?: number | string };
}

export interface MatchedAgent {
  id: string;
  orgId: string;
  sourceUrl: string | null;
  /** Whether this agent opted into redeploy-on-push. */
  autoRedeploy: boolean;
  /** A running deployment to re-submit, when there is one. */
  runningDeploymentId: string | null;
}

export type RedeployOutcome =
  | { attempted: true; ok: true; deploymentId: string }
  | { attempted: true; ok: false; reason: string }
  | { attempted: false; reason: string };

export interface PushHandlerDeps {
  /** installation id → the org that owns it. Null when unknown. */
  resolveOrgByInstallation: (installationId: string) => Promise<string | null>;
  /** Agents in THAT org whose sourceUrl matches the repo. */
  findAgentsForRepo: (args: {
    orgId: string;
    repoFullName: string;
  }) => Promise<MatchedAgent[]>;
  recordVersion: (args: {
    agentId: string;
    commitSha: string;
    ref: string;
    pusher: string;
  }) => Promise<void>;
  /** Goes THROUGH quota + credit admission. */
  redeploy: (args: {
    agentId: string;
    orgId: string;
    deploymentId: string;
  }) => Promise<RedeployOutcome>;
  emitRefused?: (args: {
    orgId: string;
    agentId: string;
    reason: string;
  }) => Promise<void>;
}

export interface PushHandlerResult {
  handled: boolean;
  reason?: string;
  agentsMatched: number;
  versionsRecorded: number;
  redeploysAttempted: number;
  redeploysRefused: number;
}

const EMPTY: PushHandlerResult = {
  handled: false,
  agentsMatched: 0,
  versionsRecorded: 0,
  redeploysAttempted: 0,
  redeploysRefused: 0,
};

function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    // The protocol is OPTIONAL: an agent whose sourceUrl was stored as
    // `github.com/o/r` would otherwise never match its own repo, and its
    // pushes would silently do nothing.
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//, "");
}

export function repoMatchesSourceUrl(
  sourceUrl: string | null,
  repoFullName: string,
): boolean {
  if (!sourceUrl) return false;
  return normalizeRepoUrl(sourceUrl) === repoFullName.trim().toLowerCase();
}

export async function handleGitHubPush(
  payload: PushPayload,
  deps: PushHandlerDeps,
): Promise<PushHandlerResult> {
  const installationId = payload.installation?.id;
  const repoFullName = payload.repository?.full_name;
  const commitSha = payload.after;
  const ref = payload.ref;

  if (!installationId || !repoFullName || !commitSha || !ref) {
    return { ...EMPTY, reason: "incomplete push payload" };
  }

  // Tenancy from the stored row, never the payload.
  const orgId = await deps.resolveOrgByInstallation(String(installationId));
  if (!orgId) {
    return { ...EMPTY, reason: "unknown installation" };
  }

  // Only the default branch (or the agent's own tracked branch, which the
  // lookup encodes). A push to a feature branch is not a release.
  const defaultBranch = payload.repository?.default_branch ?? "main";
  if (ref !== `refs/heads/${defaultBranch}`) {
    return { ...EMPTY, reason: `ignoring push to ${ref}` };
  }

  const agents = await deps.findAgentsForRepo({ orgId, repoFullName });
  const matched = agents.filter((a) => repoMatchesSourceUrl(a.sourceUrl, repoFullName));
  if (matched.length === 0) {
    return { ...EMPTY, handled: true, reason: "no agents track this repo" };
  }

  let versionsRecorded = 0;
  let redeploysAttempted = 0;
  let redeploysRefused = 0;

  for (const agent of matched) {
    try {
      await deps.recordVersion({
        agentId: agent.id,
        commitSha,
        ref,
        pusher: payload.pusher?.name ?? "unknown",
      });
      versionsRecorded += 1;
    } catch {
      // A version write failing must not stop the other agents, and must
      // not silently become a redeploy either.
      continue;
    }

    if (!agent.autoRedeploy || !agent.runningDeploymentId) continue;

    redeploysAttempted += 1;
    try {
      const outcome = await deps.redeploy({
        agentId: agent.id,
        orgId,
        deploymentId: agent.runningDeploymentId,
      });
      if (outcome.attempted && !outcome.ok) {
        redeploysRefused += 1;
        // The author needs to know a push did NOT ship — silence here is
        // exactly the "looks deployed, isn't" failure.
        await deps.emitRefused
          ?.({ orgId, agentId: agent.id, reason: outcome.reason })
          .catch(() => {});
      } else if (!outcome.attempted) {
        redeploysRefused += 1;
        await deps.emitRefused
          ?.({ orgId, agentId: agent.id, reason: outcome.reason })
          .catch(() => {});
      }
    } catch (err) {
      redeploysRefused += 1;
      await deps.emitRefused
        ?.({
          orgId,
          agentId: agent.id,
          reason: err instanceof Error ? err.message : "redeploy failed",
        })
        .catch(() => {});
    }
  }

  return {
    handled: true,
    agentsMatched: matched.length,
    versionsRecorded,
    redeploysAttempted,
    redeploysRefused,
  };
}
