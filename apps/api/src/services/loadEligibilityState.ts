/**
 * Prisma-backed loadEligibilityState (companion to routes/tokenLaunch.ts).
 *
 * Resolves the snapshot the eligibility gate consumes:
 *   Agent (id, orgId scope)
 *     → agent.deployments — oldest running.createdAt → deploymentAgeDays
 *     → agent.listing.status → hasPublishedListing
 *     → agent.listing.agentToken → alreadyTokenized + mint (for on-chain read)
 *   ON-CHAIN: AgentReputation PDA (plan A4) → reputationScore (preferred)
 *   FALLBACK: PublisherProfile (orgId) → reputationScore (off-chain mirror)
 *   getCreatorAddress(orgId) (DI'd) → creatorAddress
 *
 * Why prefer on-chain: post-A4 the token-launch gate must read what
 * holders can independently verify. The off-chain PublisherProfile is
 * kept as the fallback for the transition period (pre-program-deploy
 * agents that don't yet have an AgentReputation PDA initialized).
 *
 * Why getCreatorAddress is injected rather than queried inline: the choice
 * of which wallet pays — org owner, agent-specific wallet, treasury —
 * is product policy that may change. Keeping it behind a dep means we
 * don't rewrite the loader when the policy shifts.
 */

import type { EligibilityState } from "../routes/tokenLaunch.js";

const MS_PER_DAY = 86_400 * 1000;

interface AgentRow {
  id: string;
  orgId: string;
  name: string;
  deployments: Array<{
    id: string;
    status: string;
    createdAt: Date;
    modelDeploymentId: string | null;
  }>;
  listing: {
    status: string;
    agentToken: { id: string; mintAddress: string } | null;
  } | null;
}

interface PrismaStub {
  agent: {
    findFirst: (args: {
      where: { id: string; orgId: string };
      include: unknown;
    }) => Promise<AgentRow | null>;
  };
  publisherProfile: {
    findUnique: (args: {
      where: { orgId: string };
      select: unknown;
    }) => Promise<{ orgId: string; reputationScore: number } | null>;
  };
  x402Payment: {
    count: (args: {
      where: {
        status: string;
        OR: Array<
          | { agentDeploymentId: { in: string[] } }
          | { deploymentId: { in: string[] } }
        >;
      };
    }) => Promise<number>;
  };
}

export interface OnChainReputationLite {
  cumulativeUptimeSeconds: bigint;
  lastScore: number;
  attestationCount: number;
}

export interface LoadEligibilityStateInput {
  agentId: string;
  orgId: string;
  /** Defaults to wall clock — overridable for deterministic tests. */
  now?: Date;
}

export interface LoadEligibilityStateDeps {
  prisma: PrismaStub;
  getCreatorAddress: (orgId: string) => Promise<string>;
  /**
   * Optional on-chain reader. When provided AND the agent has a tokenized
   * mint AND the PDA exists, the returned `lastScore` takes precedence
   * over the off-chain publisherProfile.reputationScore. Errors fall
   * through silently to the DB-backed score so an RPC outage doesn't
   * block the launch UI.
   */
  readOnChainReputation?: (mintAddress: string) => Promise<OnChainReputationLite | null>;
}

export async function loadEligibilityStateByPrisma(
  input: LoadEligibilityStateInput,
  deps: LoadEligibilityStateDeps,
): Promise<EligibilityState | null> {
  const now = input.now ?? new Date();

  const [agent, profile, creatorAddress] = await Promise.all([
    deps.prisma.agent.findFirst({
      where: { id: input.agentId, orgId: input.orgId },
      include: {
        deployments: {
          select: {
            id: true,
            status: true,
            createdAt: true,
            modelDeploymentId: true,
          },
        },
        listing: {
          select: {
            status: true,
            agentToken: { select: { id: true, mintAddress: true } },
          },
        },
      },
    }),
    deps.prisma.publisherProfile.findUnique({
      where: { orgId: input.orgId },
      select: { orgId: true, reputationScore: true },
    }),
    deps.getCreatorAddress(input.orgId),
  ]);

  if (!agent) return null;

  // Sybil discount input (B4/T7): SETTLED x402 payments attributed to
  // this agent — via its own agent deployments, or via the model
  // deployments it is bound to. The second clause over-attributes when a
  // model deployment is shared across agents; acceptable because each
  // counted payment is still real money received on-chain, and the
  // discount is capped in the gate.
  const agentDeploymentIds = agent.deployments.map((d) => d.id);
  const modelDeploymentIds = agent.deployments
    .map((d) => d.modelDeploymentId)
    .filter((id): id is string => id != null);
  let settledPaidRequests = 0;
  if (agentDeploymentIds.length > 0 || modelDeploymentIds.length > 0) {
    settledPaidRequests = await deps.prisma.x402Payment.count({
      where: {
        status: "settled",
        OR: [
          { agentDeploymentId: { in: agentDeploymentIds } },
          { deploymentId: { in: modelDeploymentIds } },
        ],
      },
    });
  }

  // Oldest running deployment determines uptime.
  const running = agent.deployments.filter((d) => d.status === "running");
  let deploymentAgeDays = 0;
  if (running.length > 0) {
    const oldest = running.reduce((a, b) =>
      a.createdAt < b.createdAt ? a : b,
    );
    deploymentAgeDays = Math.floor(
      (now.getTime() - oldest.createdAt.getTime()) / MS_PER_DAY,
    );
    if (deploymentAgeDays < 0) deploymentAgeDays = 0;
  }

  const hasPublishedListing =
    agent.listing !== null && agent.listing.status === "published";
  const alreadyTokenized =
    agent.listing !== null && agent.listing.agentToken !== null;

  // Prefer on-chain score when available. RPC failures fall through to
  // the off-chain mirror so a transient outage doesn't take down the
  // launch UI. (Eligibility is read often; freezing it on an RPC blip
  // would be a customer-visible regression.)
  let reputationScore = profile?.reputationScore ?? 0;
  const mintAddress = agent.listing?.agentToken?.mintAddress;
  if (deps.readOnChainReputation && mintAddress) {
    try {
      const onChain = await deps.readOnChainReputation(mintAddress);
      if (onChain) {
        reputationScore = onChain.lastScore;
      }
    } catch {
      // Intentional silent fall-through to DB mirror.
    }
  }

  return {
    agent: { id: agent.id, name: agent.name },
    reputationScore,
    deploymentAgeDays,
    hasPublishedListing,
    alreadyTokenized,
    creatorAddress,
    settledPaidRequests,
  };
}
