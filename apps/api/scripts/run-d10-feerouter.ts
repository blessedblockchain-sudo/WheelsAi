/**
 * D10 driver: run ONE fee-router tick through the PRODUCTION worker code
 * against real devnet — unrouted-trade batching, 1% BigInt fee math,
 * claim-first batch protocol, fee_receive signing by the router wallet,
 * broadcast, same-tick confirmation — then report the batch and the
 * treasury PDA balance.
 *
 * No substitutions: deps are exactly what the BullMQ worker builds.
 *
 * Usage:
 *   FEE_ROUTER_WALLET_PRIVATE_KEY='[...]' \
 *   tsx scripts/run-d10-feerouter.ts <treasuryPdaAddress>
 */

import { Keypair, PublicKey } from "@solana/web3.js";

import { prisma } from "../src/lib/prisma.js";
import { getSolanaConnection } from "../src/lib/solana.js";
import { buildFeeRouterTickDeps } from "../src/services/buildFeeRouterTickDeps.js";
import { runFeeRouterTick } from "../src/services/runFeeRouterTick.js";

async function main() {
  const [, , pdaArg] = process.argv;
  if (!pdaArg) {
    console.error("usage: tsx scripts/run-d10-feerouter.ts <treasuryPdaAddress>");
    process.exit(2);
  }
  const raw = process.env.FEE_ROUTER_WALLET_PRIVATE_KEY;
  if (!raw) {
    console.error("FEE_ROUTER_WALLET_PRIVATE_KEY required (JSON byte array)");
    process.exit(1);
  }
  const routerKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  const connection = getSolanaConnection();

  console.log(`router=${routerKeypair.publicKey.toBase58()}`);
  const before = await connection.getBalance(new PublicKey(pdaArg));
  console.log(`treasury PDA before: ${before} lamports`);

  const deps = buildFeeRouterTickDeps({
    prisma: prisma as never,
    connection,
    routerKeypair,
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps);
  console.log("[fee-router tick]", JSON.stringify(result, null, 2));

  const after = await connection.getBalance(new PublicKey(pdaArg));
  console.log(`treasury PDA after: ${after} lamports (delta ${after - before})`);

  const batch = await prisma.feeRoutingBatch.findFirst({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      lamports: true,
      tradeCount: true,
      txSignature: true,
    },
  });
  console.log(
    "[latest batch]",
    JSON.stringify(batch, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2),
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
