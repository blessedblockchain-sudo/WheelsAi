import { prisma } from "@wheelsai/db";
import { createLogger } from "../utils/logger.js";
import { env } from "../config/env.js";
import { getPumpFunClient } from "./pumpfun.js";
import {
  updateTokenStats,
  graduateToken,
  recordTrade,
  updateHolders,
  createSnapshot,
} from "./agentToken.js";

const logger = createLogger("token-indexer-worker");

let indexerInterval: NodeJS.Timeout | null = null;
let isTickRunning = false;

interface IndexerMetrics {
  enabled: boolean;
  running: boolean;
  startedAt: string | null;
  lastTickAt: string | null;
  lastTickDurationMs: number | null;
  lastError: string | null;
  ticks: number;
  tokensProcessed: number;
  tradesRecorded: number;
  graduationsDetected: number;
  snapshotsCreated: number;
}

const metrics: IndexerMetrics = {
  enabled: false,
  running: false,
  startedAt: null,
  lastTickAt: null,
  lastTickDurationMs: null,
  lastError: null,
  ticks: 0,
  tokensProcessed: 0,
  tradesRecorded: 0,
  graduationsDetected: 0,
  snapshotsCreated: 0,
};

export function getIndexerMetrics(): IndexerMetrics {
  return { ...metrics };
}

/**
 * Runs a single token indexer tick. Exported for use by the BullMQ worker.
 */
export async function runTokenIndexerTick(): Promise<void> {
  return tick();
}

async function tick(): Promise<void> {
  if (isTickRunning) {
    logger.debug("Skipping tick - previous tick still running");
    return;
  }

  isTickRunning = true;
  const startTime = Date.now();
  metrics.ticks++;

  try {
    const client = getPumpFunClient();

    // Get all active tokens (BONDING status)
    const activeTokens = await prisma.agentToken.findMany({
      where: { status: "BONDING" },
      select: { id: true, mintAddress: true },
    });

    logger.debug({ count: activeTokens.length }, "Processing active tokens");

    for (const token of activeTokens) {
      try {
        // 1. Fetch latest token info from pump.fun
        const info = await client.getTokenInfo(token.mintAddress);
        if (!info) continue;

        // 2. Update token stats
        await updateTokenStats(token.id, {
          priceUsd: info.priceUsd,
          marketCapUsd: info.marketCapUsd,
          volume24h: info.volume24h,
          holders: info.holders,
        });
        metrics.tokensProcessed++;

        // 3. Check for graduation
        if (info.isGraduated && info.raydiumPoolId) {
          await graduateToken(token.id, info.raydiumPoolId);
          metrics.graduationsDetected++;
          logger.info({ tokenId: token.id, mintAddress: token.mintAddress, raydiumPoolId: info.raydiumPoolId }, "Token graduated to Raydium");
        }

        // 4. Fetch and record recent trades
        const trades = await client.getTokenTrades(token.mintAddress, 20);
        for (const trade of trades) {
          try {
            await recordTrade({
              tokenId: token.id,
              txSignature: trade.txSignature,
              traderAddress: trade.traderAddress,
              side: trade.side,
              solAmount: trade.solAmount,
              tokenAmount: trade.tokenAmount,
              priceUsd: trade.priceUsd,
              timestamp: new Date(trade.timestamp),
            });
            metrics.tradesRecorded++;
          } catch (error) {
            // Duplicate trades are expected (upsert handles this), only log real errors
            if (!(error instanceof Error && error.message.includes("Unique constraint"))) {
              logger.debug({ error, txSignature: trade.txSignature }, "Failed to record trade");
            }
          }
        }

        // 5. Update holders
        const holders = await client.getTokenHolders(token.mintAddress);
        if (holders.length > 0) {
          await updateHolders(
            token.id,
            holders.map((h) => ({
              walletAddress: h.walletAddress,
              balance: h.balance,
              percentage: h.percentage,
            }))
          );
        }

        // 6. Create snapshot (one per tick per token)
        await createSnapshot(token.id);
        metrics.snapshotsCreated++;
      } catch (error) {
        logger.warn({ error, tokenId: token.id, mintAddress: token.mintAddress }, "Failed to process token");
      }
    }

    // Also check graduated tokens periodically for stats updates (less frequently)
    if (metrics.ticks % 10 === 0) {
      const graduatedTokens = await prisma.agentToken.findMany({
        where: { status: "GRADUATED" },
        select: { id: true, mintAddress: true },
      });

      for (const token of graduatedTokens) {
        try {
          const info = await client.getTokenInfo(token.mintAddress);
          if (info) {
            await updateTokenStats(token.id, {
              priceUsd: info.priceUsd,
              marketCapUsd: info.marketCapUsd,
              volume24h: info.volume24h,
              holders: info.holders,
            });
            await createSnapshot(token.id);
          }
        } catch (error) {
          logger.debug({ error, tokenId: token.id }, "Failed to update graduated token");
        }
      }
    }

    metrics.lastTickAt = new Date().toISOString();
    metrics.lastTickDurationMs = Date.now() - startTime;
    metrics.lastError = null;

    logger.debug({ durationMs: metrics.lastTickDurationMs, tokensProcessed: activeTokens.length }, "Indexer tick completed");
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    metrics.lastError = errMsg;
    logger.error({ error }, "Token indexer tick failed");
  } finally {
    isTickRunning = false;
  }
}

/**
 * @deprecated Use BullMQ queue instead — call `startTokenIndexerQueue()` from `../queues/index.js`.
 */
export function startTokenIndexerWorker(): () => void {
  const intervalMs = env.TOKEN_INDEXER_INTERVAL_MS;

  if (intervalMs <= 0) {
    logger.info("Token indexer worker disabled (interval <= 0)");
    return () => {};
  }

  logger.info({ intervalMs }, "Starting token indexer worker");
  metrics.enabled = true;
  metrics.running = true;
  metrics.startedAt = new Date().toISOString();

  // Run first tick after a short delay
  setTimeout(() => tick(), 5000);

  indexerInterval = setInterval(() => tick(), intervalMs);

  return () => {
    logger.info("Stopping token indexer worker");
    metrics.running = false;
    if (indexerInterval) {
      clearInterval(indexerInterval);
      indexerInterval = null;
    }
  };
}
