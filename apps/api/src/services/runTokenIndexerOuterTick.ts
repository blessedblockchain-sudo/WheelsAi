/**
 * Outer loop for the token-trade-indexer BullMQ worker.
 *
 * Each outer tick:
 *   1. loadActiveTokens()              → tokens to index
 *   2. for each, tickToken(token, since) → runTokenTradeIndexerTick
 *   3. counts {scanned, processed, failed} returned
 *
 * Per-token failure isolation: a thrown tickToken counts as failed
 * but does NOT stop iteration — the next token still runs. The
 * outer-loop's job is best-effort across many tokens.
 *
 * Different from the per-row drivers (submit/poll/reap), per-token
 * failures here do NOT bubble up. Re-running the whole batch on one
 * token's failure would re-poll the OK tokens and risk duplicate
 * fetchTrades calls (pumpportal pages overlap, dedup helps but isn't
 * free). The tick swallows; the next scheduled outer tick retries
 * the failed token naturally.
 *
 * loadActiveTokens errors DO bubble — if we can't even read the
 * active set, there's no point iterating.
 *
 * `sinceFor(tokenId)` is the per-token high-water-mark cursor —
 * usually the timestamp of the last successfully indexed trade for
 * that token. Different per token, so the dep takes a tokenId arg.
 */

interface ActiveToken {
  id: string;
  mintAddress: string;
}

export interface TokenIndexerOuterTickInput {
  now: Date;
}

export interface TokenIndexerOuterTickDeps {
  loadActiveTokens: () => Promise<ActiveToken[]>;
  tickToken: (
    token: ActiveToken,
    since: Date,
  ) => Promise<{
    inserted: number;
    holderCount: number;
    totalBalance: number;
  }>;
  sinceFor: (tokenId: string) => Date;
}

export interface TokenIndexerOuterTickResult {
  scanned: number;
  processed: number;
  failed: number;
}

export async function runTokenIndexerOuterTick(
  _input: TokenIndexerOuterTickInput,
  deps: TokenIndexerOuterTickDeps,
): Promise<TokenIndexerOuterTickResult> {
  const tokens = await deps.loadActiveTokens();

  let processed = 0;
  let failed = 0;

  for (const token of tokens) {
    try {
      const since = deps.sinceFor(token.id);
      await deps.tickToken(token, since);
      processed += 1;
    } catch {
      failed += 1;
    }
  }

  return { scanned: tokens.length, processed, failed };
}
