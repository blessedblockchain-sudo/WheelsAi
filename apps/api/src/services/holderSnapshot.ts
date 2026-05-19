/**
 * Token holder distribution from trade history (plan A1 + C5).
 *
 * Pure aggregation: turns a trade history into the current holder
 * distribution. Used by:
 *   - dashboard's holder-distribution chart
 *   - public transparency page (/a/:slug)'s top-holders panel
 *
 * Verifier semantics: anyone with the trade history can reconstruct the
 * holder set deterministically. Production indexers seed initial holdings
 * from on-chain account state on top of this; tests pin the
 * reconstruction logic on its own.
 *
 * Negative-balance guard: if the trade stream is missing seed buys (e.g.
 * indexer joined late), a bare sell would push a holder negative. We
 * clamp to zero rather than emit a negative balance, so percentage math
 * stays sensible and the dashboard doesn't render nonsense.
 */

export interface HolderTrade {
  traderAddress: string;
  side: "buy" | "sell";
  tokenAmount: number;
  timestamp: Date;
}

export interface HolderSnapshotInput {
  trades: HolderTrade[];
  /** If set, return only the top N holders (sorted by balance desc). */
  topN?: number;
}

export interface HolderEntry {
  walletAddress: string;
  balance: number;
  /** Percentage of totalBalance, rounded to 4 decimal places for display. */
  percentage: number;
}

export interface HolderSnapshotResult {
  holders: HolderEntry[];
  /** Sum of positive holdings across the FULL set, not just topN. */
  totalBalance: number;
}

function round4dp(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function computeHolderSnapshot(
  input: HolderSnapshotInput,
): HolderSnapshotResult {
  // 1. Compute net per-trader balances.
  const balances = new Map<string, number>();
  for (const trade of input.trades) {
    const delta = trade.side === "buy" ? trade.tokenAmount : -trade.tokenAmount;
    const next = (balances.get(trade.traderAddress) ?? 0) + delta;
    balances.set(trade.traderAddress, next);
  }

  // 2. Drop non-positive balances (zero or negative-clamped).
  const positives: Array<{ walletAddress: string; balance: number }> = [];
  for (const [walletAddress, balance] of balances.entries()) {
    if (balance > 0) positives.push({ walletAddress, balance });
  }

  // 3. Sort by balance desc, ties broken alphabetically for determinism.
  positives.sort((a, b) => {
    if (b.balance !== a.balance) return b.balance - a.balance;
    return a.walletAddress.localeCompare(b.walletAddress);
  });

  // 4. totalBalance is across the full positive set (NOT post-truncation).
  const totalBalance = positives.reduce((sum, h) => sum + h.balance, 0);

  // 5. Truncate to topN if requested.
  const limited =
    input.topN !== undefined ? positives.slice(0, input.topN) : positives;

  // 6. Attach percentage (4dp), truth-summed when no topN — adjust last
  //    entry's rounding so the displayed percentages sum to exactly 100.
  const holders: HolderEntry[] = limited.map((h) => ({
    walletAddress: h.walletAddress,
    balance: h.balance,
    percentage: totalBalance > 0 ? round4dp((h.balance / totalBalance) * 100) : 0,
  }));

  if (input.topN === undefined && holders.length > 0 && totalBalance > 0) {
    const summed = holders.reduce((s, h) => s + h.percentage, 0);
    const drift = round4dp(100 - summed);
    if (drift !== 0) {
      holders[holders.length - 1]!.percentage = round4dp(
        holders[holders.length - 1]!.percentage + drift,
      );
    }
  }

  return { holders, totalBalance };
}
