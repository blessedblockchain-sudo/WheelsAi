/**
 * Cursor-bounded paginated trade fetch for the token indexer (plan D7).
 *
 * The legacy indexer fetched a fixed last-20 page per tick — any token
 * trading more than 20 times per interval silently lost trades (under-
 * routing fees, corrupting charts/holders). This helper pages through
 * the upstream feed (newest-first, limit/offset) until one of:
 *
 *   1. a page's oldest trade is at-or-before the cursor (`since`) —
 *      everything new has been seen;
 *   2. a short page — upstream has no more rows;
 *   3. the maxPages bound — a runaway guard so a pathological burst (or
 *      a cursor far in the past) can't pin the tick on one token. The
 *      next tick resumes from the advanced cursor.
 *
 * Rows at-or-before `since` are filtered out; rows already persisted are
 * additionally deduped downstream by tx_signature (skipDuplicates), so
 * page overlap across ticks is harmless.
 *
 * Upstream failures THROW (the hardened PumpFunClient no longer
 * swallows) — the outer tick counts the token as failed and proceeds
 * to the next token.
 */

import { solToLamports, tokensToRaw } from "../lib/tokenUnits.js";
import type { TokenTrade } from "./pumpfun.js";
import type { IndexerTradeRow } from "./tokenTradeIndexer.js";

export const TRADE_FETCH_DEFAULT_PAGE_SIZE = 100;
export const TRADE_FETCH_DEFAULT_MAX_PAGES = 10;

export interface FetchTokenTradesSinceInput {
  mintAddress: string;
  /** High-water-mark cursor: only trades strictly newer are returned. */
  since: Date;
}

export interface FetchTokenTradesSinceDeps {
  /** One upstream page (newest-first). PumpFunClient.getTokenTrades. */
  getTradesPage: (
    mintAddress: string,
    limit: number,
    offset: number,
  ) => Promise<TokenTrade[]>;
  pageSize?: number;
  maxPages?: number;
}

function toIndexerRow(trade: TokenTrade): IndexerTradeRow {
  return {
    txSignature: trade.txSignature,
    traderAddress: trade.traderAddress,
    side: trade.side,
    // Keep the human-unit Floats for display, and derive the integer raw
    // units HERE — the single boundary where upstream Float data enters
    // the system (D9). Every money path reads the raw fields below.
    tokenAmount: trade.tokenAmount,
    solAmount: trade.solAmount,
    priceUsd: trade.priceUsd,
    solLamports: solToLamports(trade.solAmount),
    tokenAmountRaw: tokensToRaw(trade.tokenAmount),
    timestamp: new Date(trade.timestamp),
  };
}

export async function fetchTokenTradesSince(
  input: FetchTokenTradesSinceInput,
  deps: FetchTokenTradesSinceDeps,
): Promise<IndexerTradeRow[]> {
  const pageSize = deps.pageSize ?? TRADE_FETCH_DEFAULT_PAGE_SIZE;
  const maxPages = deps.maxPages ?? TRADE_FETCH_DEFAULT_MAX_PAGES;
  const sinceMs = input.since.getTime();

  const out: IndexerTradeRow[] = [];

  for (let page = 0; page < maxPages; page++) {
    const rows = await deps.getTradesPage(
      input.mintAddress,
      pageSize,
      page * pageSize,
    );

    let oldestMs = Number.POSITIVE_INFINITY;
    for (const trade of rows) {
      const row = toIndexerRow(trade);
      const ts = row.timestamp.getTime();
      if (ts < oldestMs) oldestMs = ts;
      if (ts > sinceMs) out.push(row);
    }

    // Short page → upstream exhausted.
    if (rows.length < pageSize) break;
    // Cursor reached → every newer trade is already collected.
    if (oldestMs <= sinceMs) break;
  }

  return out;
}
