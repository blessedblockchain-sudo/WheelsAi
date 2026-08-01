/**
 * D10 driver: run ONE reputation-attestation tick through the PRODUCTION
 * worker code against real devnet — usage aggregation, score computation,
 * attestor signing, on-chain submit_attestation, and the DB mirror —
 * then read the AgentReputation PDA back from chain to prove the write.
 *
 * No substitutions: the deps are exactly what the BullMQ worker builds
 * (buildAttestationTickDeps with the whitelisted attestor keypair).
 *
 * Usage:
 *   REPUTATION_ATTESTOR_PRIVATE_KEY='[...]' \
 *   tsx scripts/run-d10-attestation.ts <mintAddress>
 */

import { Keypair, PublicKey } from "@solana/web3.js";

import { prisma } from "../src/lib/prisma.js";
import { getSolanaConnection } from "../src/lib/solana.js";
import { buildAttestationTickDeps } from "../src/services/buildAttestationTickDeps.js";
import { runAttestationTick } from "../src/services/runAttestationTick.js";
import { readAgentReputationFromChain } from "../src/services/readAgentReputationFromChain.js";

async function main() {
  const [, , mintArg] = process.argv;
  if (!mintArg) {
    console.error("usage: tsx scripts/run-d10-attestation.ts <mintAddress>");
    process.exit(2);
  }
  const raw = process.env.REPUTATION_ATTESTOR_PRIVATE_KEY;
  if (!raw) {
    console.error("REPUTATION_ATTESTOR_PRIVATE_KEY required (JSON byte array)");
    process.exit(1);
  }
  const attestorKeypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  const connection = getSolanaConnection();

  console.log(`attestor=${attestorKeypair.publicKey.toBase58()}`);

  const deps = buildAttestationTickDeps({
    prisma: prisma as never,
    connection,
    attestorKeypair,
  });
  const result = await runAttestationTick({ now: new Date() }, deps);
  console.log("[attestation tick]", JSON.stringify(result, null, 2));

  const onChain = await readAgentReputationFromChain(
    { mint: new PublicKey(mintArg) },
    { connection },
  );
  console.log(
    "[on-chain AgentReputation]",
    JSON.stringify(
      onChain,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );

  const mirror = await prisma.onChainAttestation.findFirst({
    orderBy: { createdAt: "desc" },
    select: { id: true, txSignature: true, status: true, score: true },
  });
  console.log("[db mirror]", JSON.stringify(mirror, null, 2));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
