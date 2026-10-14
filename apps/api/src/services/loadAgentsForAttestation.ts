/**
 * Prisma loader for the reputation-attestation worker (plan A4).
 *
 * Returns the AgentToken rows eligible for on-chain attestation this
 * tick. Eligibility:
 *   1. The token has a valid mintAddress (i.e. graduated past creation)
 *   2. reputationProgramInitialized = true
 *      (the AgentReputation PDA exists on-chain; otherwise submit
 *      would fail with "AccountNotInitialized" — wasted tx fee)
 *
 * The worker further filters out rows whose aggregate computes to zero
 * deltas (the runAttestationTick driver does that — see "skipped" in
 * its return type).
 *
 * Joined fields:
 *   - agentListing.agentId + agent.orgId — needed for the
 *     loadUsageRecordsForReputation call (multi-tenant scoping)
 *   - tokenId is the AgentToken row id, used to advance the cursor and
 *     to FK the OnChainAttestation mirror
 */

interface PrismaStub {
  agentToken: {
    findMany: (args: {
      where: {
        reputationProgramInitialized: true;
        mintAddress: { not: "" };
      };
      select: {
        id: true;
        mintAddress: true;
        lastOnChainAttestationAt: true;
        agentListing: {
          select: {
            agentId: true;
            agent: { select: { orgId: true } };
          };
        };
      };
    }) => Promise<
      Array<{
        id: string;
        mintAddress: string;
        lastOnChainAttestationAt: Date | null;
        // Both null on a listing that sells a workflow.
        agentListing: {
          agentId: string | null;
          agent: { orgId: string } | null;
        };
      }>
    >;
  };
}

export interface AttestableAgentLoadedRow {
  tokenId: string;
  mintAddress: string;
  lastOnChainAttestationAt: Date | null;
  agentId: string;
  orgId: string;
}

export interface LoadAgentsForAttestationDeps {
  prisma: PrismaStub;
}

export async function loadAgentsForAttestation(
  _input: { now: Date },
  deps: LoadAgentsForAttestationDeps,
): Promise<AttestableAgentLoadedRow[]> {
  const rows = await deps.prisma.agentToken.findMany({
    where: {
      reputationProgramInitialized: true,
      mintAddress: { not: "" },
    },
    select: {
      id: true,
      mintAddress: true,
      lastOnChainAttestationAt: true,
      agentListing: {
        select: {
          agentId: true,
          agent: { select: { orgId: true } },
        },
      },
    },
  });

  // What is attested is an agent's usage. A token is launched for an agent's
  // listing only, so a row whose listing has no agent has nothing to attest
  // and is dropped here, never a reason to fail the whole tick.
  return rows.flatMap((r) => {
    const { agentId, agent } = r.agentListing;
    if (agentId === null || agent === null) return [];
    return [
      {
        tokenId: r.id,
        mintAddress: r.mintAddress,
        lastOnChainAttestationAt: r.lastOnChainAttestationAt,
        agentId,
        orgId: agent.orgId,
      },
    ];
  });
}
