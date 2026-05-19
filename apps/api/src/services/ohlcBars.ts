/**
 * OHLC bar aggregator (plan A1 + dashboard price chart).
 *
 * Pure: turns AgentTokenTrade rows into Open/High/Low/Close price bars
 * for the per-agent price chart. Convention:
 *
 *   - Bars are UTC-aligned to the interval grid. An hourly bar starts at
 *     HH:00:00.000Z; a 5-minute bar starts at :00, :05, :10. The bar's
 *     openTime is the floor(timestamp / interval) * interval.
 *   - Sparse output: empty intervals emit no bar. The frontend can
 *     forward-fill if it wants a continuous chart.
 *   - Closed-open membership: a trade at exactly the boundary belongs to
 *     the bar STARTING at that timestamp, [start, start + interval).
 *   - Output is chronologically sorted, deterministic regardless of
 *     input trade order.
 */

const MS_PER_SECOND = 1000;

export interface OhlcTrade {
  timestamp: Date;
  priceUsd: number;
  solAmount: number;
}

export interface OhlcBar {
  openTime: Date;
  closeTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeSol: number;
  tradeCount: number;
}

export interface AggregateOhlcInput {
  trades: OhlcTrade[];
  /** Bar interval in seconds. Common: 60 (1m), 300 (5m), 3600 (1h), 86400 (1d). */
  intervalSeconds: number;
  /** Optional window filter — trades outside [from, to] are dropped. */
  from?: Date;
  to?: Date;
}

interface BarAcc {
  openMs: number;
  firstTradeMs: number;
  lastTradeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeSol: number;
  tradeCount: number;
}

export function aggregateOhlcBars(input: AggregateOhlcInput): OhlcBar[] {
  if (
    !Number.isFinite(input.intervalSeconds) ||
    input.intervalSeconds <= 0
  ) {
    throw new Error(
      `aggregateOhlcBars: intervalSeconds must be a positive finite number, got ${input.intervalSeconds}`,
    );
  }
  const intervalMs = input.intervalSeconds * MS_PER_SECOND;

  const fromMs = input.from?.getTime();
  const toMs = input.to?.getTime();

  const buckets = new Map<number, BarAcc>();

  for (const trade of input.trades) {
    const ts = trade.timestamp.getTime();
    if (fromMs !== undefined && ts < fromMs) continue;
    if (toMs !== undefined && ts > toMs) continue;

    const openMs = Math.floor(ts / intervalMs) * intervalMs;
    let acc = buckets.get(openMs);
    if (!acc) {
      acc = {
        openMs,
        firstTradeMs: ts,
        lastTradeMs: ts,
        open: trade.priceUsd,
        high: trade.priceUsd,
        low: trade.priceUsd,
        close: trade.priceUsd,
        volumeSol: trade.solAmount,
        tradeCount: 1,
      };
      buckets.set(openMs, acc);
      continue;
    }

    if (ts < acc.firstTradeMs) {
      acc.firstTradeMs = ts;
      acc.open = trade.priceUsd;
    }
    if (ts > acc.lastTradeMs) {
      acc.lastTradeMs = ts;
      acc.close = trade.priceUsd;
    }
    if (trade.priceUsd > acc.high) acc.high = trade.priceUsd;
    if (trade.priceUsd < acc.low) acc.low = trade.priceUsd;
    acc.volumeSol += trade.solAmount;
    acc.tradeCount += 1;
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.openMs - b.openMs)
    .map((acc) => ({
      openTime: new Date(acc.openMs),
      closeTime: new Date(acc.openMs + intervalMs),
      open: acc.open,
      high: acc.high,
      low: acc.low,
      close: acc.close,
      volumeSol: acc.volumeSol,
      tradeCount: acc.tradeCount,
    }));
}
