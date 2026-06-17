/**
 * Prisma-backed loader for the fee-router BullMQ worker — row identity
 * (remediation D6a).
 *
 * Returns one row per treasury that has UNROUTED trades, where unrouted
 * means `feeRoutingBatchId IS NULL` — NOT a timestamp window. The old
 * `timestamp > lastFeeRoutedAt` watermark permanently excluded trades
 * that the at-least-once indexer delivered late (older timestamp,
 * inserted after the window already advanced); under row identity a
 * late-arriving trade is simply still NULL and joins the next batch.
 *
 * Two-step query rather than a single SQL aggregate:
 *   1. find programInitialized treasuries (with their tokenId + mint)
 *   2. per treasury, fetch unstamped trades (bounded by `limit`,
 *      oldest-first so backlogs drain fairly); sum solAmount
 *
 * Two-step keeps the test stub simple (no need to model GROUP BY).
 * The per-treasury batch is bounded by `limit` (default 500) so one
 * very active token can't grow an unbounded fee_receive batch.
 *
 * Fee math (integer — remediation D9): the 1% fee is computed entirely in
 * BigInt lamports, summing the trades' `sol_lamports` column (the raw
 * integer derived once at the indexer boundary) — never the Float
 * `sol_amount`. So no float error compounds across a batch and the
 * conservation invariant Σ routed ≤ 1% Σ volume holds exactly:
 *   feeAmountLamports = (sumLamports * FEE_BPS) / 10000   // BigInt, floors
 * BigInt division truncates toward zero = floor for non-negative volume —
 * never overpay. A batch whose fee floors to 0 lamports is NOT claimed
 * (trades stay NULL) so sub-lamport volume keeps accumulating until it
 * crosses 1 lamport with later trades.
 */

import { BPS_DENOMINATOR } from "../lib/tokenUnits.js";
import type { UnroutedFeeRow } from "./runFeeRouterTick.js";

/** Platform fee: 1% of routed SOL volume, in basis points. */
const FEE_BPS = 100n;
const BPS_DENOM = BigInt(BPS_DENOMINATOR);

/** Per-treasury per-tick trade cap (D6a: "bounded batch size"). */
export const DEFAULT_FEE_BATCH_TRADE_LIMIT = 500;

interface PrismaStub {
  agentTreasury: {
    findMany: (args: {
      where: { programInitialized: true };
      select: unknown;
    }) => Promise<
      Array<{
        id: string;
        programInitialized: boolean;
        token: {
          id: string;
          mintAddress: string;
        };
      }>
    >;
  };
  agentTokenTrade: {
    findMany: (args: {
      where: {
        tokenId: string;
        feeRoutingBatchId: null;
      };
      orderBy: { timestamp: "asc" };
      take: number;
      select: unknown;
    }) => Promise<
      Array<{
        id: string;
        solLamports: bigint;
        timestamp: Date;
      }>
    >;
  };
}

export interface LoadUnroutedFeesInput {
  now: Date;
  /** Max trades claimed per treasury per tick (default 500). */
  limit?: number;
}

export interface LoadUnroutedFeesDeps {
  prisma: PrismaStub;
}

export async function loadUnroutedFeesByPrisma(
  input: LoadUnroutedFeesInput,
  deps: LoadUnroutedFeesDeps,
): Promise<UnroutedFeeRow[]> {
  const limit = input.limit ?? DEFAULT_FEE_BATCH_TRADE_LIMIT;

  const treasuries = await deps.prisma.agentTreasury.findMany({
    where: { programInitialized: true },
    select: {
      id: true,
      programInitialized: true,
      token: { select: { id: true, mintAddress: true } },
    },
  });

  const rows: UnroutedFeeRow[] = [];
  for (const treasury of treasuries) {
    const trades = await deps.prisma.agentTokenTrade.findMany({
      where: {
        tokenId: treasury.token.id,
        feeRoutingBatchId: null,
      },
      orderBy: { timestamp: "asc" },
      take: limit,
      select: { id: true, solLamports: true, timestamp: true },
    });
    if (trades.length === 0) continue;

    let sumLamports = 0n;
    let latestTs = trades[0]!.timestamp;
    const tradeIds: string[] = [];
    for (const t of trades) {
      sumLamports += t.solLamports;
      tradeIds.push(t.id);
      if (t.timestamp > latestTs) latestTs = t.timestamp;
    }
    // 1% in BigInt — division truncates toward zero (floor for ≥0 volume),
    // so we never overpay. Sub-lamport volume stays UNCLAIMED (trades keep
    // feeRoutingBatchId NULL) until later trades push it over.
    const feeAmountLamports = (sumLamports * FEE_BPS) / BPS_DENOM;
    if (feeAmountLamports <= 0n) continue;

    rows.push({
      treasuryId: treasury.id,
      mintAddress: treasury.token.mintAddress,
      tradeIds,
      feeAmountLamports,
      latestTradeTimestamp: latestTs,
    });
  }

  return rows;
}
