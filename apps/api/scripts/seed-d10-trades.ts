/**
 * D10 trade seeder: insert unrouted AgentTokenTrade rows for a token so
 * the fee-router worker has fees to sweep into the treasury PDA.
 *
 * On devnet there is no live launchpad emitting real trades (the trade
 * indexer's upstream is the C1/Wave-2 build), so trades are seeded
 * directly — the same documented substitution the other D10 legs make.
 * Everything downstream (batch claim, 1% fee math in BigInt, fee_receive
 * signing, broadcast, confirmation) is the production worker code.
 *
 * Usage:
 *   tsx scripts/seed-d10-trades.ts <mintAddress> <tradeSolAmount> <count>
 */

import { prisma } from "../src/lib/prisma.js";

const LAMPORTS_PER_SOL = 1_000_000_000n;

async function main() {
  const [, , mintArg, solArg, countArg] = process.argv;
  if (!mintArg || !solArg || !countArg) {
    console.error(
      "usage: tsx scripts/seed-d10-trades.ts <mintAddress> <tradeSolAmount> <count>",
    );
    process.exit(2);
  }
  const solAmount = Number(solArg);
  const count = Number(countArg);

  const token = await prisma.agentToken.findUnique({
    where: { mintAddress: mintArg },
    select: { id: true, name: true },
  });
  if (!token) {
    console.error(`No AgentToken with mint ${mintArg}`);
    process.exit(1);
  }

  const solLamports =
    (BigInt(Math.round(solAmount * 1e9)) * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL;
  const stamp = Date.now();
  const created = [];
  for (let i = 0; i < count; i++) {
    const trade = await prisma.agentTokenTrade.create({
      data: {
        tokenId: token.id,
        // Honest label: these are seeded devnet rows, not indexed
        // launchpad trades. The unique constraint needs distinct values.
        txSignature: `d10-seeded-trade-${stamp}-${i}`,
        traderAddress: "D10SeededTrader1111111111111111111111111111",
        side: i % 2 === 0 ? "buy" : "sell",
        solAmount,
        tokenAmount: solAmount * 10_000,
        priceUsd: 0,
        solLamports,
        tokenAmountRaw: BigInt(Math.round(solAmount * 10_000)) * 1_000_000n,
        timestamp: new Date(stamp - (count - i) * 60_000),
      },
      select: { id: true, txSignature: true, solLamports: true },
    });
    created.push(trade);
  }

  const totalLamports = created.reduce((s, t) => s + t.solLamports, 0n);
  console.log(
    JSON.stringify(
      {
        tokenId: token.id,
        trades: created.length,
        totalVolumeLamports: totalLamports.toString(),
        expectedFeeLamports: (totalLamports / 100n).toString(),
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
