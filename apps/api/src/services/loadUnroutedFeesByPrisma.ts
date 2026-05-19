/**
 * Prisma-backed loader for the fee-router BullMQ worker.
 *
 * Returns one row per treasury that has unrouted trade volume since
 * its `lastFeeRoutedAt` cursor (null = since creation).
 *
 * Two-step query rather than a single SQL aggregate:
 *   1. find programInitialized treasuries (with their tokenId + mint)
 *   2. per treasury, fetch trades after cursor; sum solAmount
 *
 * Two-step keeps the test stub simple (no need to model GROUP BY)
 * and the per-treasury count of trades is bounded by tick interval × token
 * trade rate — usually <100. If load grows, swap step 2 for a single
 * grouped aggregate.
 *
 * Fee math:
 *   feeAmountLamports = floor(sumSolAmount * 0.01 * 1e9)
 * Floor rounding is intentional — never overpay. Sub-lamport residue
 * is acceptable; it accumulates in subsequent windows naturally.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;
const FEE_RATE = 0.01;

interface PrismaStub {
  agentTreasury: {
    findMany: (args: {
      where: { programInitialized: true };
      select: unknown;
    }) => Promise<
      Array<{
        id: string;
        programInitialized: boolean;
        lastFeeRoutedAt: Date | null;
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
        timestamp?: { gt: Date };
      };
      orderBy: { timestamp: "asc" };
      select: unknown;
    }) => Promise<
      Array<{
        id: string;
        solAmount: number;
        timestamp: Date;
      }>
    >;
  };
}

export interface LoadUnroutedFeesInput {
  now: Date;
}

export interface LoadUnroutedFeesDeps {
  prisma: PrismaStub;
}

export interface UnroutedFeeRow {
  treasuryId: string;
  mintAddress: string;
  feeAmountLamports: bigint;
  latestTradeTimestamp: Date;
}

export async function loadUnroutedFeesByPrisma(
  _input: LoadUnroutedFeesInput,
  deps: LoadUnroutedFeesDeps,
): Promise<UnroutedFeeRow[]> {
  const treasuries = await deps.prisma.agentTreasury.findMany({
    where: { programInitialized: true },
    select: {
      id: true,
      programInitialized: true,
      lastFeeRoutedAt: true,
      token: { select: { id: true, mintAddress: true } },
    },
  });

  const rows: UnroutedFeeRow[] = [];
  for (const treasury of treasuries) {
    const cursor = treasury.lastFeeRoutedAt;
    const trades = await deps.prisma.agentTokenTrade.findMany({
      where: {
        tokenId: treasury.token.id,
        ...(cursor ? { timestamp: { gt: cursor } } : {}),
      },
      orderBy: { timestamp: "asc" },
      select: { id: true, solAmount: true, timestamp: true },
    });
    if (trades.length === 0) continue;

    let sumSol = 0;
    let latestTs = trades[0]!.timestamp;
    for (const t of trades) {
      sumSol += t.solAmount;
      if (t.timestamp > latestTs) latestTs = t.timestamp;
    }
    // Floor: never overpay. Sub-lamport residue stays in the float
    // accumulator until the next window naturally crosses 1 lamport.
    const feeAmountLamports = BigInt(
      Math.floor(sumSol * FEE_RATE * LAMPORTS_PER_SOL),
    );
    if (feeAmountLamports <= BigInt(0)) continue;

    rows.push({
      treasuryId: treasury.id,
      mintAddress: treasury.token.mintAddress,
      feeAmountLamports,
      latestTradeTimestamp: latestTs,
    });
  }

  return rows;
}
