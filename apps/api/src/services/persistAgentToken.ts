/**
 * Prisma-backed persistAgentToken (companion to routes/tokenLaunch.ts).
 *
 * Atomic write: looks up the AgentListing for the agent (1:1, unique on
 * agentId), then creates the AgentToken row inside a single $transaction.
 *
 * The launch route's failure-recovery contract — "if persistence fails AFTER
 * pumpfun submit succeeded, the 500 response surfaces mintAddress so the
 * mint isn't lost" — depends on this function being a single atomic write,
 * not a multi-statement sequence that can half-succeed.
 */

import type {
  PersistAgentTokenInput,
  PersistAgentTokenResult,
} from "../routes/tokenLaunch.js";

const PUMPFUN_FRONTEND_BASE = "https://pump.fun";

interface TxClient {
  agentListing: {
    findUnique: (args: {
      where: { agentId: string };
    }) => Promise<{ id: string; agentId: string; orgId: string } | null>;
  };
  agentToken: {
    create: (args: { data: Record<string, unknown> }) => Promise<{
      id: string;
      creatorLockupEnd: Date;
    }>;
  };
}

interface PrismaWithTx {
  $transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
}

export interface PersistAgentTokenDeps {
  prisma: PrismaWithTx;
}

export async function persistAgentTokenByPrisma(
  input: PersistAgentTokenInput,
  deps: PersistAgentTokenDeps,
): Promise<PersistAgentTokenResult> {
  return deps.prisma.$transaction(async (tx) => {
    const listing = await tx.agentListing.findUnique({
      where: { agentId: input.agentId },
    });
    if (!listing) {
      throw new Error(
        `persistAgentToken: no AgentListing for agentId=${input.agentId}; agent must be published before tokenization`,
      );
    }

    const data: Record<string, unknown> = {
      agentListingId: listing.id,
      mintAddress: input.mintAddress,
      pumpfunUrl: `${PUMPFUN_FRONTEND_BASE}/coin/${input.mintAddress}`,
      creatorAddress: input.creatorAddress,
      name: input.name,
      symbol: input.symbol,
      creatorLockupEnd: input.creatorLockupEnd,
    };
    if (input.imageUri) data.imageUri = input.imageUri;

    const created = await tx.agentToken.create({ data });

    return {
      tokenId: created.id,
      creatorLockupEnd: created.creatorLockupEnd,
    };
  });
}
