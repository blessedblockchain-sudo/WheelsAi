/**
 * Token trade indexer tick (plan A1 + C5).
 *
 * One call = one tick of the BullMQ token-indexer worker per agent token.
 * Pure orchestration; every IO surface is dependency-injected.
 *
 * Flow:
 *   1. fetchTrades(mintAddress, since)        — pump.fun / pumpportal poll
 *   2. dedup by txSignature                    — overlapping pages from upstream
 *   3. persistTrades(rows)                     — upsert (returns inserted count)
 *   4. loadAllTrades(tokenId)                  — full history for snapshot
 *   5. computeHolderSnapshot                   — pure, already tested
 *   6. persistHolderSnapshot                   — bulk replace holder rows
 *
 * Failure semantics:
 *   - persistTrades fails → throw labeled, skip the snapshot recompute
 *     (recomputing against a stale view would just need to be redone)
 *   - persistHolderSnapshot fails → throw labeled, but trade insertions
 *     already committed are kept; next tick re-derives the snapshot
 */

import {
  computeHolderSnapshot,
  type HolderTrade,
} from "./holderSnapshot.js";

export interface IndexerTradeRow {
  txSignature: string;
  traderAddress: string;
  side: "buy" | "sell";
  // Float human units — display/charts only (D9).
  tokenAmount: number;
  solAmount: number;
  priceUsd: number;
  // Integer raw units — the money-path source of truth (D9). Derived once
  // at the indexer boundary; fee summation reads solLamports, holder
  // balances read tokenAmountRaw.
  solLamports: bigint;
  tokenAmountRaw: bigint;
  timestamp: Date;
}

export interface IndexerHolderSnapshotPayload {
  tokenId: string;
  holders: Array<{
    walletAddress: string;
    // Display Floats (D9). The integer `balanceRaw` is what the token gate
    // reads; balance/percentage are derived for the UI.
    balance: number;
    percentage: number;
    balanceRaw: bigint;
  }>;
  totalBalance: number;
}

export interface TokenTradeIndexerInput {
  token: { id: string; mintAddress: string };
  since: Date;
  now: Date;
  topN?: number;
}

export interface TokenTradeIndexerDeps {
  fetchTrades: (
    mintAddress: string,
    since: Date,
  ) => Promise<IndexerTradeRow[]>;
  persistTrades: (
    rows: IndexerTradeRow[],
  ) => Promise<{ inserted: number }>;
  loadAllTrades: (tokenId: string) => Promise<IndexerTradeRow[]>;
  persistHolderSnapshot: (
    payload: IndexerHolderSnapshotPayload,
  ) => Promise<void>;
}

export interface TokenTradeIndexerResult {
  inserted: number;
  holderCount: number;
  totalBalance: number;
}

function dedupBySignature(trades: IndexerTradeRow[]): IndexerTradeRow[] {
  const seen = new Set<string>();
  const out: IndexerTradeRow[] = [];
  for (const t of trades) {
    if (seen.has(t.txSignature)) continue;
    seen.add(t.txSignature);
    out.push(t);
  }
  return out;
}

function toHolderTrade(row: IndexerTradeRow): HolderTrade {
  return {
    traderAddress: row.traderAddress,
    side: row.side,
    tokenAmountRaw: row.tokenAmountRaw,
    timestamp: row.timestamp,
  };
}

export async function runTokenTradeIndexerTick(
  input: TokenTradeIndexerInput,
  deps: TokenTradeIndexerDeps,
): Promise<TokenTradeIndexerResult> {
  const fetched = await deps.fetchTrades(input.token.mintAddress, input.since);
  if (fetched.length === 0) {
    return { inserted: 0, holderCount: 0, totalBalance: 0 };
  }

  const deduped = dedupBySignature(fetched);

  let inserted: number;
  try {
    const result = await deps.persistTrades(deduped);
    inserted = result.inserted;
  } catch (err) {
    throw new Error(
      `persist_trades_failed: ${(err as Error).message ?? "unknown"}`,
      { cause: err as Error },
    );
  }

  const allTrades = await deps.loadAllTrades(input.token.id);
  const snap = computeHolderSnapshot({
    trades: allTrades.map(toHolderTrade),
    topN: input.topN,
  });

  try {
    await deps.persistHolderSnapshot({
      tokenId: input.token.id,
      holders: snap.holders,
      totalBalance: snap.totalBalance,
    });
  } catch (err) {
    throw new Error(
      `persist_holder_snapshot_failed: ${(err as Error).message ?? "unknown"}`,
      { cause: err as Error },
    );
  }

  return {
    inserted,
    holderCount: snap.holders.length,
    totalBalance: snap.totalBalance,
  };
}
