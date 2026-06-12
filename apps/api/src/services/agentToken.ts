import { Keypair, PublicKey } from "@solana/web3.js";

import { prisma } from "@wheelsai/db";
import { createLogger } from "../utils/logger.js";
import { env } from "../config/env.js";
import { getSolanaConnection } from "../lib/solana.js";
import { buildPumpfunCreateRequest } from "./pumpfunTxBuilder.js";
import { submitPumpfunCreate } from "./submitPumpfunCreate.js";
import { deriveCreatorKeypair } from "./creatorKeypairs.js";
import { deriveTreasuryPda } from "../lib/programs/agentTreasury.js";
import {
  ELIGIBILITY_DEFAULTS,
  CREATOR_LOCKUP_DAYS,
} from "./tokenEligibility.js";

const logger = createLogger("agent-token-service");

// ============================================
// Types
// ============================================

export interface TokenEligibilityResult {
  eligible: boolean;
  reasons: string[];
}

export interface CreateTokenParams {
  agentListingId: string;
  orgId: string;
  name: string;
  symbol: string;
  /**
   * Off-chain identity hint (typically the user's wallet address). Recorded
   * for audit only — the actual on-chain creator is the deterministic
   * per-org keypair derived from WALLET_MASTER_KEY (see creatorKeypairs.ts).
   */
  creatorAddress: string;
}

/**
 * Optional DI surface for createToken — injected only in tests. Production
 * callers omit and the function builds the real connection + keypairs.
 */
export interface CreateTokenDeps {
  deriveCreatorKeypair?: (orgId: string) => import("@solana/web3.js").Keypair;
  generateMintKeypair?: () => import("@solana/web3.js").Keypair;
  fetchFn?: typeof fetch;
  sendRawTransaction?: (raw: Uint8Array) => Promise<string>;
  connection?: import("@solana/web3.js").Connection;
}

export interface ListTokensParams {
  status?: string;
  sortBy?: "market_cap" | "volume" | "newest" | "holders";
  search?: string;
  page?: number;
  limit?: number;
}

export interface RecordTradeParams {
  tokenId: string;
  txSignature: string;
  traderAddress: string;
  side: string;
  solAmount: number;
  tokenAmount: number;
  priceUsd: number;
  timestamp: Date;
}

export interface UpdateTokenStatsParams {
  priceUsd?: number;
  marketCapUsd?: number;
  volume24h?: number;
  holders?: number;
}

export interface HolderData {
  walletAddress: string;
  balance: number;
  percentage: number;
}

// ============================================
// Constants
// ============================================

// Single source of truth lives in services/tokenEligibility.ts; alias here
// so the rest of this file reads unchanged and the values can't drift.
const MIN_REPUTATION_SCORE = ELIGIBILITY_DEFAULTS.minReputation;
const MIN_DEPLOYMENT_DAYS = ELIGIBILITY_DEFAULTS.minDeploymentAgeDays;

// ============================================
// Eligibility Checks
// ============================================

/**
 * Check if an agent listing is eligible for token creation
 */
export async function checkTokenEligibility(
  agentListingId: string,
  orgId: string
): Promise<TokenEligibilityResult> {
  const reasons: string[] = [];

  try {
    // Check if listing exists and belongs to org
    const listing = await prisma.agentListing.findUnique({
      where: { id: agentListingId },
      include: {
        agent: {
          include: {
            deployments: {
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
    });

    if (!listing) {
      reasons.push("Agent listing not found");
      return { eligible: false, reasons };
    }

    if (listing.publisherId !== orgId) {
      reasons.push("Agent listing does not belong to your organization");
      return { eligible: false, reasons };
    }

    // Check if listing is published
    if (listing.status !== "published") {
      reasons.push("Agent listing must be published before creating a token");
    }

    // Check if token already exists
    const existingToken = await prisma.agentToken.findUnique({
      where: { agentListingId },
    });

    if (existingToken) {
      reasons.push("Token already exists for this agent listing");
    }

    // Check publisher reputation
    const publisherProfile = await prisma.publisherProfile.findUnique({
      where: { orgId: listing.publisherId },
    });

    if (!publisherProfile) {
      reasons.push("Publisher profile not found");
    } else if (publisherProfile.reputationScore < MIN_REPUTATION_SCORE) {
      reasons.push(
        `Publisher reputation score (${publisherProfile.reputationScore}) must be at least ${MIN_REPUTATION_SCORE}`
      );
    }

    // Check agent deployment age
    const oldestDeployment =
      listing.agent.deployments.length > 0 ? listing.agent.deployments[0] : null;

    if (!oldestDeployment) {
      reasons.push("Agent must have at least one deployment");
    } else {
      const deploymentAge = Date.now() - oldestDeployment.createdAt.getTime();
      const deploymentDays = deploymentAge / (1000 * 60 * 60 * 24);

      if (deploymentDays < MIN_DEPLOYMENT_DAYS) {
        reasons.push(
          `Agent must be deployed for at least ${MIN_DEPLOYMENT_DAYS} days (current: ${Math.floor(deploymentDays)} days)`
        );
      }
    }

    return {
      eligible: reasons.length === 0,
      reasons,
    };
  } catch (error) {
    logger.error({ error, agentListingId, orgId }, "Error checking token eligibility");
    reasons.push("An error occurred while checking eligibility");
    return { eligible: false, reasons };
  }
}

// ============================================
// Token Creation
// ============================================

/**
 * Create a new token on pump.fun and record in database.
 *
 * @deprecated Custodial server-signed path. No UI surface reaches it — the
 * live flow is browser-partial-sign via routes/tokenLaunchPartialSign.ts +
 * the launchpad adapters. NOTE: this path still passes `listing.iconUrl`
 * straight into the create `uri` (line below) without the IPFS metadata
 * upload the adapter does, so any token minted here would get broken
 * on-chain metadata. Do not revive without wiring services/pumpfunIpfs.ts
 * (see services/launchpad/pumpfunAdapter.ts for the correct flow).
 *
 * Phase 1C: uses the real `submitPumpfunCreate` flow — POST
 * pumpportal `/api/trade-local` → sign with creator+mint keypairs →
 * broadcast via Solana RPC. The creator keypair is derived
 * deterministically from `WALLET_MASTER_KEY` + orgId
 * (see services/creatorKeypairs.ts). The mint keypair is generated
 * fresh per create and discarded after broadcast.
 *
 * The legacy `pumpfunClient.createToken()` path (hosted pumpportal
 * endpoint that never shipped) is gone. Caller's `creatorAddress`
 * input becomes an off-chain identity hint only; the on-chain creator
 * is whatever the derived keypair resolves to. The DB stores the
 * derived pubkey so reads match the chain.
 */
export async function createToken(
  params: CreateTokenParams,
  deps: CreateTokenDeps = {},
) {
  logger.info(
    {
      agentListingId: params.agentListingId,
      name: params.name,
      symbol: params.symbol,
    },
    "Creating agent token"
  );

  // Check eligibility first
  const eligibility = await checkTokenEligibility(params.agentListingId, params.orgId);
  if (!eligibility.eligible) {
    throw new Error(`Token creation not eligible: ${eligibility.reasons.join(", ")}`);
  }

  // Get agent listing details
  const listing = await prisma.agentListing.findUnique({
    where: { id: params.agentListingId },
  });

  if (!listing) {
    throw new Error("Agent listing not found");
  }

  // Idempotency: agentListingId is @unique on AgentToken, so a duplicate
  // create would surface as a Prisma P2002 deep in the persist step. Check
  // up front so the failure is a clear domain error before any pumpportal
  // call (which would otherwise burn a real on-chain mint with no DB row).
  const existing = await prisma.agentToken.findUnique({
    where: { agentListingId: params.agentListingId },
    select: { id: true, mintAddress: true },
  });
  if (existing) {
    throw new Error(
      `Token already exists for this listing (mint=${existing.mintAddress})`,
    );
  }

  if (!env.WALLET_MASTER_KEY) {
    throw new Error("WALLET_MASTER_KEY not configured; cannot derive creator keypair");
  }

  // Derive deterministic per-org creator keypair (MVP custodial).
  // Browser-partial-sign is Phase 1.5 — see creatorKeypairs.ts.
  const creatorKeypair = deps.deriveCreatorKeypair
    ? deps.deriveCreatorKeypair(params.orgId)
    : deriveCreatorKeypair({ masterKey: env.WALLET_MASTER_KEY, orgId: params.orgId });
  const creatorPubkey = creatorKeypair.publicKey.toBase58();

  // Ephemeral mint keypair — must sign its own creation, discarded after.
  const mintKeypair = deps.generateMintKeypair
    ? deps.generateMintKeypair()
    : Keypair.generate();
  const mintAddress = mintKeypair.publicKey.toBase58();

  // pumpportal requires a non-empty uri. Until proper IPFS metadata
  // upload ships (Phase 1.5), the listing's iconUrl doubles as the
  // metadata uri — pumpfun shows it directly. If absent, fail loud
  // rather than burn an on-chain mint with a broken metadata pointer.
  const uri = listing.iconUrl ?? "";
  if (!uri) {
    throw new Error(
      "Listing must have an iconUrl set before tokenization (pumpfun requires metadata uri)",
    );
  }

  const pumpfunBody = buildPumpfunCreateRequest({
    creatorPubkey,
    mintPubkey: mintAddress,
    name: params.name,
    symbol: params.symbol,
    uri,
  });

  const connection = deps.connection ?? getSolanaConnection();
  const fetchFn = deps.fetchFn ?? fetch;
  const sendRawTransaction =
    deps.sendRawTransaction ??
    (async (raw: Uint8Array) =>
      connection.sendRawTransaction(raw, { skipPreflight: false }));

  const submitted = await submitPumpfunCreate(
    {
      body: pumpfunBody,
      creatorKeypair,
      mintKeypair,
    },
    { fetchFn, sendRawTransaction },
  );

  // Calculate initial creator lockup end (placeholder - will be updated on graduation)
  const creatorLockupEnd = new Date();
  creatorLockupEnd.setDate(creatorLockupEnd.getDate() + CREATOR_LOCKUP_DAYS);

  // Derive the on-chain agent-treasury PDA address up front so the AgentToken
  // + AgentTreasury rows land atomically with the correct linkage. Without
  // this the fee-router has no row to route to and bootstrap-treasury.ts
  // has no candidate (it scans AgentTreasury, not AgentToken).
  const [treasuryPda, treasuryBump] = deriveTreasuryPda(
    new PublicKey(submitted.mintAddress),
  );

  // Create token + treasury in a single transaction. If either insert fails
  // we don't want a half-written DB next to a successful on-chain mint.
  const token = await prisma.$transaction(async (tx) => {
    const created = await tx.agentToken.create({
      data: {
        agentListingId: params.agentListingId,
        mintAddress: submitted.mintAddress,
        pumpfunUrl: `https://pump.fun/coin/${submitted.mintAddress}`,
        creatorAddress: creatorPubkey,
        name: params.name,
        symbol: params.symbol,
        imageUri: listing.iconUrl || undefined,
        creatorLockupEnd,
        status: "BONDING",
        treasuryAddress: treasuryPda.toBase58(),
      },
      include: {
        agentListing: true,
      },
    });
    await tx.agentTreasury.create({
      data: {
        tokenId: created.id,
        treasuryPdaAddress: treasuryPda.toBase58(),
        authorityBump: treasuryBump,
        // programInitialized stays false — bootstrap-treasury.ts flips it
        // after the on-chain initialize_treasury instruction lands.
      },
    });
    return created;
  });

  logger.info(
    {
      tokenId: token.id,
      mintAddress: token.mintAddress,
      treasuryPdaAddress: treasuryPda.toBase58(),
    },
    "Agent token + treasury created successfully"
  );

  return token;
}

// ============================================
// Token Retrieval
// ============================================

/**
 * Get token by ID
 */
export async function getToken(id: string) {
  return prisma.agentToken.findUnique({
    where: { id },
    include: {
      agentListing: true,
    },
  });
}

/**
 * Get token by mint address
 */
export async function getTokenByMint(mintAddress: string) {
  return prisma.agentToken.findUnique({
    where: { mintAddress },
    include: {
      agentListing: true,
    },
  });
}

/**
 * List tokens with filtering and sorting
 */
export async function listTokens(params: ListTokensParams = {}) {
  const { status, sortBy = "market_cap", search, page = 1, limit = 20 } = params;

  const skip = (page - 1) * limit;

  // Build where clause
  const where: any = {};
  if (status) {
    where.status = status;
  }
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { symbol: { contains: search, mode: "insensitive" } },
      { mintAddress: { contains: search, mode: "insensitive" } },
      {
        agentListing: {
          is: {
            title: { contains: search, mode: "insensitive" },
          },
        },
      },
    ];
  }

  // Build orderBy clause
  let orderBy: any = {};
  switch (sortBy) {
    case "market_cap":
      orderBy = { marketCapUsd: "desc" };
      break;
    case "volume":
      orderBy = { volume24h: "desc" };
      break;
    case "holders":
      orderBy = { holders: "desc" };
      break;
    case "newest":
      orderBy = { createdAt: "desc" };
      break;
    default:
      orderBy = { marketCapUsd: "desc" };
  }

  const [tokens, total] = await Promise.all([
    prisma.agentToken.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      include: {
        agentListing: true,
      },
    }),
    prisma.agentToken.count({ where }),
  ]);

  return { tokens, total };
}

/**
 * Get trending tokens by 24h volume
 */
export async function getTrendingTokens(limit = 10) {
  return prisma.agentToken.findMany({
    orderBy: { volume24h: "desc" },
    take: limit,
    include: {
      agentListing: true,
    },
  });
}

// ============================================
// Token Trades
// ============================================

/**
 * Get paginated trades for a token
 */
export async function getTokenTrades(tokenId: string, page = 1, limit = 50) {
  const skip = (page - 1) * limit;

  const [trades, total] = await Promise.all([
    prisma.agentTokenTrade.findMany({
      where: { tokenId },
      orderBy: { timestamp: "desc" },
      skip,
      take: limit,
    }),
    prisma.agentTokenTrade.count({ where: { tokenId } }),
  ]);

  return { trades, total };
}

/**
 * Record a trade from the indexer (idempotent)
 */
export async function recordTrade(params: RecordTradeParams) {
  return prisma.agentTokenTrade.upsert({
    where: { txSignature: params.txSignature },
    create: {
      tokenId: params.tokenId,
      txSignature: params.txSignature,
      traderAddress: params.traderAddress,
      side: params.side,
      solAmount: params.solAmount,
      tokenAmount: params.tokenAmount,
      priceUsd: params.priceUsd,
      timestamp: params.timestamp,
    },
    update: {
      traderAddress: params.traderAddress,
      side: params.side,
      solAmount: params.solAmount,
      tokenAmount: params.tokenAmount,
      priceUsd: params.priceUsd,
      timestamp: params.timestamp,
    },
  });
}

// ============================================
// Token Holders
// ============================================

/**
 * Get holders list for a token
 */
export async function getTokenHolders(tokenId: string) {
  return prisma.agentTokenHolder.findMany({
    where: { tokenId },
    orderBy: { percentage: "desc" },
  });
}

/**
 * Update holders for a token (upsert)
 */
export async function updateHolders(tokenId: string, holders: HolderData[]) {
  logger.info({ tokenId, count: holders.length }, "Updating token holders");

  // Use transaction to update all holders atomically
  const operations = holders.map((holder) =>
    prisma.agentTokenHolder.upsert({
      where: {
        tokenId_walletAddress: {
          tokenId,
          walletAddress: holder.walletAddress,
        },
      },
      create: {
        tokenId,
        walletAddress: holder.walletAddress,
        balance: holder.balance,
        percentage: holder.percentage,
      },
      update: {
        balance: holder.balance,
        percentage: holder.percentage,
      },
    })
  );

  await prisma.$transaction(operations);
}

// ============================================
// Token Stats & Updates
// ============================================

/**
 * Update token statistics
 */
export async function updateTokenStats(tokenId: string, stats: UpdateTokenStatsParams) {
  const updateData: any = {};

  if (stats.priceUsd !== undefined) updateData.priceUsd = stats.priceUsd;
  if (stats.marketCapUsd !== undefined) updateData.marketCapUsd = stats.marketCapUsd;
  if (stats.volume24h !== undefined) updateData.volume24h = stats.volume24h;
  if (stats.holders !== undefined) updateData.holders = stats.holders;

  return prisma.agentToken.update({
    where: { id: tokenId },
    data: updateData,
  });
}

/**
 * Mark token as graduated to Raydium
 */
export async function graduateToken(tokenId: string, raydiumPoolId: string) {
  logger.info({ tokenId, raydiumPoolId }, "Graduating token to Raydium");

  // Set creator lockup to 30 days from now
  const creatorLockupEnd = new Date();
  creatorLockupEnd.setDate(creatorLockupEnd.getDate() + CREATOR_LOCKUP_DAYS);

  return prisma.agentToken.update({
    where: { id: tokenId },
    data: {
      status: "GRADUATED",
      graduatedAt: new Date(),
      raydiumPoolId,
      creatorLockupEnd,
    },
  });
}

// ============================================
// Token Snapshots
// ============================================

/**
 * Create a price snapshot from current token data
 */
export async function createSnapshot(tokenId: string) {
  const token = await prisma.agentToken.findUnique({
    where: { id: tokenId },
  });

  if (!token) {
    throw new Error("Token not found");
  }

  return prisma.agentTokenSnapshot.create({
    data: {
      tokenId,
      priceUsd: token.priceUsd,
      marketCapUsd: token.marketCapUsd,
      volume24h: token.volume24h,
      holders: token.holders,
    },
  });
}

/**
 * Get price snapshots for charting
 */
export async function getTokenChart(
  tokenId: string,
  period: "1h" | "24h" | "7d" | "30d" = "24h"
) {
  // Calculate the time cutoff
  const now = new Date();
  let cutoff = new Date();

  switch (period) {
    case "1h":
      cutoff.setHours(cutoff.getHours() - 1);
      break;
    case "24h":
      cutoff.setHours(cutoff.getHours() - 24);
      break;
    case "7d":
      cutoff.setDate(cutoff.getDate() - 7);
      break;
    case "30d":
      cutoff.setDate(cutoff.getDate() - 30);
      break;
  }

  return prisma.agentTokenSnapshot.findMany({
    where: {
      tokenId,
      timestamp: {
        gte: cutoff,
      },
    },
    orderBy: { timestamp: "asc" },
  });
}

// ============================================
// Leaderboards
// ============================================

/**
 * Get token leaderboard by various metrics
 */
export async function getLeaderboard(
  metric: "market_cap" | "volume" | "holders" | "newest" = "market_cap",
  limit = 100
) {
  let orderBy: any = {};

  switch (metric) {
    case "market_cap":
      orderBy = { marketCapUsd: "desc" };
      break;
    case "volume":
      orderBy = { volume24h: "desc" };
      break;
    case "holders":
      orderBy = { holders: "desc" };
      break;
    case "newest":
      orderBy = { createdAt: "desc" };
      break;
    default:
      orderBy = { marketCapUsd: "desc" };
  }

  return prisma.agentToken.findMany({
    orderBy,
    take: limit,
    include: {
      agentListing: {
        select: {
          id: true,
          title: true,
          slug: true,
          shortDescription: true,
          iconUrl: true,
          publisherName: true,
          category: true,
        },
      },
    },
  });
}
