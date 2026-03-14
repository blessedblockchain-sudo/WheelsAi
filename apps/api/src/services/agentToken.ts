import { prisma } from "@wheelsai/db";
import { createLogger } from "../utils/logger.js";
import { env } from "../config/env.js";
import { getPumpFunClient } from "./pumpfun.js";

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
  creatorAddress: string;
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

const MIN_REPUTATION_SCORE = 50;
const MIN_DEPLOYMENT_DAYS = 7;
const CREATOR_LOCKUP_DAYS = 30;

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
 * Create a new token on pump.fun and record in database
 */
export async function createToken(params: CreateTokenParams) {
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

  // Create token on pump.fun
  const pumpfunClient = getPumpFunClient();
  const pumpfunResult = await pumpfunClient.createToken({
    name: params.name,
    symbol: params.symbol,
    description: listing.shortDescription,
    imageUri: listing.iconUrl || undefined,
    creatorAddress: params.creatorAddress,
    website: undefined,
    twitter: undefined,
    telegram: undefined,
  });

  // Calculate initial creator lockup end (placeholder - will be updated on graduation)
  const creatorLockupEnd = new Date();
  creatorLockupEnd.setDate(creatorLockupEnd.getDate() + CREATOR_LOCKUP_DAYS);

  // Create token record in database
  const token = await prisma.agentToken.create({
    data: {
      agentListingId: params.agentListingId,
      mintAddress: pumpfunResult.mintAddress,
      bondingCurveAddress: pumpfunResult.bondingCurveAddress,
      pumpfunUrl: pumpfunResult.pumpfunUrl,
      creatorAddress: params.creatorAddress,
      name: params.name,
      symbol: params.symbol,
      imageUri: listing.iconUrl || undefined,
      creatorLockupEnd,
      status: "BONDING",
    },
    include: {
      agentListing: true,
    },
  });

  logger.info(
    { tokenId: token.id, mintAddress: token.mintAddress },
    "Agent token created successfully"
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
