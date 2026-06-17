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
 *
 * Money-path integers (D9): balances are summed in BigInt raw token units
 * (`tokenAmountRaw`) so no float error compounds across a long trade
 * stream and a whale holding near the 1e15-raw supply ceiling doesn't lose
 * precision against 2^53. `balanceRaw` is what the token gate reads; the
 * Float `balance` / `percentage` are derived for display only.
 */

import { rawToTokens } from "../lib/tokenUnits.js";

export interface HolderTrade {
  traderAddress: string;
  side: "buy" | "sell";
  /** Raw integer token units (tokens × 1e6) — the money-path amount. */
  tokenAmountRaw: bigint;
  timestamp: Date;
}

export interface HolderSnapshotInput {
  trades: HolderTrade[];
  /** If set, return only the top N holders (sorted by balance desc). */
  topN?: number;
}

export interface HolderEntry {
  walletAddress: string;
  /** Raw integer token units — the access-decision source of truth. */
  balanceRaw: bigint;
  /** Whole tokens (= balanceRaw / 1e6) — display only. */
  balance: number;
  /** Percentage of totalBalance, rounded to 4 decimal places for display. */
  percentage: number;
}

export interface HolderSnapshotResult {
  holders: HolderEntry[];
  /** Sum of positive holdings across the FULL set (whole tokens, display). */
  totalBalance: number;
}

function round4dp(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function computeHolderSnapshot(
  input: HolderSnapshotInput,
): HolderSnapshotResult {
  // 1. Compute net per-trader balances in raw integer units (exact).
  const balances = new Map<string, bigint>();
  for (const trade of input.trades) {
    const delta =
      trade.side === "buy" ? trade.tokenAmountRaw : -trade.tokenAmountRaw;
    const next = (balances.get(trade.traderAddress) ?? 0n) + delta;
    balances.set(trade.traderAddress, next);
  }

  // 2. Drop non-positive balances (zero or negative-clamped).
  const positives: Array<{ walletAddress: string; balanceRaw: bigint }> = [];
  for (const [walletAddress, balanceRaw] of balances.entries()) {
    if (balanceRaw > 0n) positives.push({ walletAddress, balanceRaw });
  }

  // 3. Sort by balance desc, ties broken alphabetically for determinism.
  positives.sort((a, b) => {
    if (b.balanceRaw !== a.balanceRaw) return b.balanceRaw > a.balanceRaw ? 1 : -1;
    return a.walletAddress.localeCompare(b.walletAddress);
  });

  // 4. totalBalanceRaw is across the full positive set (NOT post-truncation).
  const totalBalanceRaw = positives.reduce((sum, h) => sum + h.balanceRaw, 0n);
  const totalBalanceNum = Number(totalBalanceRaw);

  // 5. Truncate to topN if requested.
  const limited =
    input.topN !== undefined ? positives.slice(0, input.topN) : positives;

  // 6. Attach display Float balance + percentage (4dp). Percentages are
  //    truth-summed when no topN — adjust the last entry's rounding so the
  //    displayed percentages sum to exactly 100. The ratio is computed in
  //    Float (display only); the underlying balanceRaw stays exact.
  const holders: HolderEntry[] = limited.map((h) => ({
    walletAddress: h.walletAddress,
    balanceRaw: h.balanceRaw,
    balance: rawToTokens(h.balanceRaw),
    percentage:
      totalBalanceRaw > 0n
        ? round4dp((Number(h.balanceRaw) / totalBalanceNum) * 100)
        : 0,
  }));

  if (input.topN === undefined && holders.length > 0 && totalBalanceRaw > 0n) {
    const summed = holders.reduce((s, h) => s + h.percentage, 0);
    const drift = round4dp(100 - summed);
    if (drift !== 0) {
      holders[holders.length - 1]!.percentage = round4dp(
        holders[holders.length - 1]!.percentage + drift,
      );
    }
  }

  return { holders, totalBalance: rawToTokens(totalBalanceRaw) };
}
