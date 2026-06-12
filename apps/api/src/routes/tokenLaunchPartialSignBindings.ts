/**
 * Concrete-binding factory for createPartialSignTokenRoutes.
 *
 * Routes ship as DI factories so they're testable in isolation; this
 * file is the production wiring — it knows about pumpportal, the
 * Solana RPC, Prisma, and the prepare-token secret. Keep the wiring
 * thin: every binding is one or two lines that hand the route's
 * abstract dep its concrete equivalent.
 *
 * Mounted in src/index.ts under prefix `/api/tokens` → endpoints
 * become `/api/tokens/launch/prepare` and `/api/tokens/launch/submit`.
 */

import { PublicKey } from "@solana/web3.js";

import { prisma } from "@wheelsai/db";

import { env } from "../config/env.js";
import { getSolanaConnection } from "../lib/solana.js";
import { getLaunchpadAdapter } from "../services/launchpad/index.js";
import { loadEligibilityStateByPrisma } from "../services/loadEligibilityState.js";
import {
  createPartialSignTokenRoutes,
  type PartialSignTokenRouteDeps,
  type PersistAgentTokenWithTreasuryInput,
  type PersistAgentTokenWithTreasuryResult,
  type ReconcileLaunchResult,
} from "./tokenLaunchPartialSign.js";

const PUMPFUN_FRONTEND_BASE = "https://pump.fun";

// ============================================
// Eligibility deps
// ============================================
//
// The launch route doesn't care who the on-chain creator is — the
// authed user's walletAddress is what flows into the create body.
// loadEligibilityStateByPrisma requires a getCreatorAddress dep
// though (the legacy custodial flow's choice surface). For the
// partial-sign route we wire it to a no-op since the route ignores
// state.creatorAddress.

async function noopGetCreatorAddress(): Promise<string> {
  return "ignored-by-partial-sign-route";
}

// ============================================
// Persist: AgentToken + AgentTreasury in one tx
// ============================================
//
// Mirror of the inline persist in services/agentToken.createToken
// (the legacy custodial path) — pump.fun mint exists on-chain by
// the time we reach this function, so any DB failure here surfaces
// the mintAddress + txSignature so the launch wizard can show
// "your token is at <mint>; please retry persistence" instead of
// silently dropping it.

async function persistAgentTokenWithTreasury(
  input: PersistAgentTokenWithTreasuryInput,
): Promise<PersistAgentTokenWithTreasuryResult> {
  return prisma.$transaction(async (tx) => {
    // AgentListing has no orgId column; org scope lives on the related
    // Agent. Validate ownership by joining through agent and checking
    // its orgId matches the authenticated caller's org.
    const listing = await tx.agentListing.findUnique({
      where: { id: input.agentListingId },
      select: {
        id: true,
        title: true,
        iconUrl: true,
        agent: { select: { orgId: true } },
      },
    });
    if (!listing) {
      throw new Error(
        `persistAgentTokenWithTreasury: AgentListing ${input.agentListingId} not found`,
      );
    }
    if (listing.agent.orgId !== input.orgId) {
      throw new Error(
        `persistAgentTokenWithTreasury: listing's agent.orgId ${listing.agent.orgId} does not match input.orgId ${input.orgId}`,
      );
    }
    const created = await tx.agentToken.create({
      data: {
        agentListingId: listing.id,
        mintAddress: input.mintAddress,
        pumpfunUrl: `${PUMPFUN_FRONTEND_BASE}/coin/${input.mintAddress}`,
        creatorAddress: input.creatorAddress,
        // Creator-supplied token name (carried through the prepare token);
        // listing.title is only the ownership-check join, not the name.
        name: input.name,
        symbol: input.symbol,
        imageUri: input.imageUri ?? listing.iconUrl ?? undefined,
        launchpad: input.launchpad,
        meteoraConfigKey: input.meteoraConfigKey,
        creatorLockupEnd: input.creatorLockupEnd,
        status: "BONDING",
        treasuryAddress: input.treasuryPdaAddress,
      },
    });
    await tx.agentTreasury.create({
      data: {
        tokenId: created.id,
        treasuryPdaAddress: input.treasuryPdaAddress,
        authorityBump: input.treasuryAuthorityBump,
      },
    });
    return {
      tokenId: created.id,
      creatorLockupEnd: created.creatorLockupEnd ?? input.creatorLockupEnd,
    };
  });
}

// ============================================
// Reconcile: idempotent persist for the recovery path
// ============================================
//
// Called when the mint already broadcast on-chain but the original
// /submit persist failed. Returns the existing row if one was created
// (idempotent replay, incl. a race with a concurrent reconcile), else
// persists fresh.

async function reconcileLaunch(
  input: PersistAgentTokenWithTreasuryInput,
): Promise<ReconcileLaunchResult> {
  const existing = await prisma.agentToken.findUnique({
    where: { mintAddress: input.mintAddress },
    select: { id: true, creatorLockupEnd: true },
  });
  if (existing) {
    return {
      tokenId: existing.id,
      creatorLockupEnd: existing.creatorLockupEnd ?? input.creatorLockupEnd,
      alreadyExisted: true,
    };
  }
  try {
    const persisted = await persistAgentTokenWithTreasury(input);
    return { ...persisted, alreadyExisted: false };
  } catch (err) {
    // Lost a race with a concurrent reconcile? Return the now-existing row
    // (unique mintAddress means the insert collided) instead of surfacing
    // a constraint error to the user.
    const racy = await prisma.agentToken.findUnique({
      where: { mintAddress: input.mintAddress },
      select: { id: true, creatorLockupEnd: true },
    });
    if (racy) {
      return {
        tokenId: racy.id,
        creatorLockupEnd: racy.creatorLockupEnd ?? input.creatorLockupEnd,
        alreadyExisted: true,
      };
    }
    throw err;
  }
}

// ============================================
// Public factory
// ============================================

export function createPartialSignTokenRoutesProduction() {
  if (!env.WALLET_MASTER_KEY) {
    throw new Error(
      "createPartialSignTokenRoutesProduction: WALLET_MASTER_KEY is required (derives the prepare-token HMAC secret)",
    );
  }
  // Derive a process-stable prepare-token secret from the master key
  // with an explicit domain-separator. Rotating WALLET_MASTER_KEY
  // invalidates any in-flight prepare tokens (5min TTL ceiling), which
  // is the desired behavior for the planned A2 multisig rotation.
  const prepareTokenSecret = `${env.WALLET_MASTER_KEY}::prepare-token-v1`;

  const deps: PartialSignTokenRouteDeps = {
    loadEligibilityState: ({ agentId, orgId }) =>
      loadEligibilityStateByPrisma(
        { agentId, orgId },
        {
          // The companion service declares a loose PrismaStub shape so
          // it can be tested with a mock; the real Prisma client is
          // structurally compatible at runtime but its types are stricter.
          prisma: prisma as unknown as Parameters<
            typeof loadEligibilityStateByPrisma
          >[1]["prisma"],
          getCreatorAddress: noopGetCreatorAddress,
        },
      ),
    resolveAgentListingId: async ({ agentId, orgId }) => {
      // AgentListing has no orgId column — org scope lives on the
      // related Agent. Join through agent to enforce that the caller's
      // org actually owns the listing's agent.
      const agent = await prisma.agent.findFirst({
        where: { id: agentId, orgId },
        select: { listing: { select: { id: true } } },
      });
      return agent?.listing?.id ?? null;
    },
    launchpad: getLaunchpadAdapter(),
    persistAgentTokenWithTreasury,
    reconcileLaunch,
    confirmMintOnChain: async (mintAddress: string) => {
      const connection = getSolanaConnection();
      const info = await connection.getAccountInfo(new PublicKey(mintAddress));
      return info !== null;
    },
    prepareTokenSecret,
  };

  return createPartialSignTokenRoutes(deps);
}
