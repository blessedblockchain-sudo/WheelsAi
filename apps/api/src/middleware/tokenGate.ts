import { FastifyRequest, FastifyReply } from "fastify";
import { Redis } from "ioredis";
import { prisma } from "@wheelsai/db";
import { createLogger } from "../utils/logger.js";
import { env } from "../config/env.js";
import { tokensToRaw, rawToTokens } from "../lib/tokenUnits.js";

const logger = createLogger("token-gate");

// Shared Redis client — created lazily so test environments without Redis
// can still import this module without an immediate connection attempt.
let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;
  try {
    redis = new Redis(env.REDIS_URL, {
      // Prevent ioredis from retrying indefinitely when Redis is unavailable.
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    redis.on("error", (err) => {
      logger.warn({ err }, "Redis error in token-gate — cache disabled");
    });
    return redis;
  } catch (err) {
    logger.warn({ err }, "Failed to create Redis client for token-gate");
    return null;
  }
}

/** Close the cache connection (server shutdown, tests). */
export function disconnectTokenGateCache(): void {
  redis?.disconnect();
  redis = null;
}

type ListingCache = {
  id: string;
  pricingModel: string;
  agentToken: { id: string; symbol: string; mintAddress: string } | null;
} | null;

const LISTING_TTL_SECONDS = 60;
const HOLDER_TTL_SECONDS = 30;

async function cacheGet<T>(key: string): Promise<T | null> {
  const client = getRedis();
  if (!client) return null;
  try {
    const raw = await client.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn({ err, key }, "Redis GET failed — falling through to DB");
    return null;
  }
}

async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (err) {
    logger.warn({ err, key }, "Redis SET failed — continuing without caching");
  }
}

/**
 * Middleware factory that enforces token holding requirements
 * for tokenized marketplace listings.
 *
 * Works with two deployment types:
 * - Model deployments (inference route): resolves via AgentDeployment.modelDeploymentId
 * - Agent deployments: resolves via AgentDeployment.agentId
 */
export function requireTokenHolding(minBalance: number = 1) {
  return async function tokenGateHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const params = request.params as { deploymentSlug?: string; id?: string };
    const deploymentSlug = params.deploymentSlug;
    const deploymentId = params.id;

    if (!deploymentSlug && !deploymentId) {
      return;
    }

    // Try to find a tokenized listing associated with this deployment.
    // Path 1: Model deployment slug → find AgentDeployment referencing it → Agent → Listing
    // Path 2: Direct agent deployment id → Agent → Listing

    let listing: ListingCache = null;

    if (deploymentSlug) {
      const cacheKey = `tokengate:${deploymentSlug}`;
      const cached = await cacheGet<ListingCache>(cacheKey);

      if (cached !== null) {
        listing = cached;
      } else {
        // Inference route: find the model deployment, then look for agent deployments using it
        const modelDeployment = await prisma.deployment.findFirst({
          where: { slug: deploymentSlug },
          select: { id: true },
        });

        if (modelDeployment) {
          const agentDeployment = await prisma.agentDeployment.findFirst({
            where: { modelDeploymentId: modelDeployment.id },
            select: {
              agent: {
                select: {
                  listing: {
                    select: {
                      id: true,
                      pricingModel: true,
                      agentToken: {
                        select: { id: true, symbol: true, mintAddress: true },
                      },
                    },
                  },
                },
              },
            },
          });
          listing = agentDeployment?.agent?.listing ?? null;
        }

        await cacheSet(cacheKey, listing, LISTING_TTL_SECONDS);
      }
    }

    if (!listing && deploymentId) {
      const cacheKey = `tokengate:${deploymentId}`;
      const cached = await cacheGet<ListingCache>(cacheKey);

      if (cached !== null) {
        listing = cached;
      } else {
        // Try as agent deployment ID
        const agentDeployment = await prisma.agentDeployment.findFirst({
          where: { id: deploymentId },
          select: {
            agent: {
              select: {
                listing: {
                  select: {
                    id: true,
                    pricingModel: true,
                    agentToken: {
                      select: { id: true, symbol: true, mintAddress: true },
                    },
                  },
                },
              },
            },
          },
        });
        listing = agentDeployment?.agent?.listing ?? null;

        await cacheSet(cacheKey, listing, LISTING_TTL_SECONDS);
      }
    }

    if (!listing || listing.pricingModel !== "tokenized") {
      // Not a tokenized listing — pass through
      return;
    }

    const token = listing.agentToken;
    if (!token) {
      return reply.status(403).send({
        error: "Forbidden",
        message: "This agent requires a token that has not been created yet",
      });
    }

    // Check wallet address
    const walletAddress =
      (request as any).auth?.walletAddress ||
      (request as any).user?.walletAddress;

    if (!walletAddress) {
      return reply.status(403).send({
        error: "Forbidden",
        message:
          "Wallet required to access this tokenized agent. Please link a Solana wallet in Settings.",
        tokenSymbol: token.symbol,
        mintAddress: token.mintAddress,
      });
    }

    // The access decision is made in integer raw token units (D9): the
    // Float `balance` column accumulates rounding error and loses precision
    // near the 1e15-raw supply ceiling, so we compare `balanceRaw` instead.
    // minBalance is expressed in whole tokens (default 1).
    const minBalanceRaw = tokensToRaw(minBalance);

    // Look up holder record, with cache. The cache stores the raw balance
    // as a decimal string (BigInt isn't JSON-serializable); a versioned key
    // (`:raw:`) ensures stale numeric entries written by the pre-D9 code
    // are never reinterpreted as raw units.
    const holderCacheKey = `tokengate:holder:raw:${token.id}:${walletAddress}`;
    let currentBalanceRaw: bigint;

    const cachedBalance = await cacheGet<string>(holderCacheKey);
    if (cachedBalance !== null) {
      currentBalanceRaw = BigInt(cachedBalance);
    } else {
      const holder = await prisma.agentTokenHolder.findUnique({
        where: {
          tokenId_walletAddress: {
            tokenId: token.id,
            walletAddress,
          },
        },
        select: { balanceRaw: true },
      });

      currentBalanceRaw = holder ? holder.balanceRaw : 0n;
      await cacheSet(
        holderCacheKey,
        currentBalanceRaw.toString(),
        HOLDER_TTL_SECONDS,
      );
    }

    if (currentBalanceRaw < minBalanceRaw) {
      return reply.status(403).send({
        error: "Forbidden",
        message: `Insufficient ${token.symbol} holdings to access this agent`,
        tokenSymbol: token.symbol,
        mintAddress: token.mintAddress,
        requiredBalance: minBalance,
        currentBalance: rawToTokens(currentBalanceRaw),
      });
    }

    logger.debug(
      {
        walletAddress,
        tokenSymbol: token.symbol,
        balance: rawToTokens(currentBalanceRaw),
      },
      "Token gate passed"
    );
  };
}
