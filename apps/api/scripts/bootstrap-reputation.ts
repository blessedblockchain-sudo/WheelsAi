/**
 * One-shot bootstrap: initialize the reputation-oracle AgentReputation
 * PDA for every existing AgentToken row that has a mintAddress but has
 * not yet had its on-chain reputation PDA created.
 *
 * Mirrors bootstrap-treasury.ts in shape; the only differences:
 *   - calls `initialize_agent_reputation` on the reputation-oracle program
 *   - flips `reputationProgramInitialized` (not `programInitialized`)
 *
 * Pre-requisite: the OracleConfig PDA must exist on-chain (created via
 * `initialize_oracle`, called once per environment). The bootstrap will
 * skip that prerequisite check by design — the operator runs both
 * scripts in order, and a missing OracleConfig surfaces clearly when
 * the first `initialize_agent_reputation` tx fails with
 * "AccountNotInitialized" against the config seed.
 *
 * Usage:
 *   BOOTSTRAP_PAYER_PRIVATE_KEY='[1,2,3,...]' \
 *   SOLANA_NETWORK=devnet \
 *   tsx scripts/bootstrap-reputation.ts [--dry-run] [--limit N]
 *
 * Required env:
 *   BOOTSTRAP_PAYER_PRIVATE_KEY — JSON-encoded byte array of the funded
 *     wallet that pays rent for each AgentReputation account creation.
 *     Does NOT need to be the oracle's admin or an attestor; rent is
 *     unprivileged.
 *
 * Optional flags:
 *   --dry-run  Plan only; don't submit txs or write DB.
 *   --limit N  Process at most N rows.
 *
 * Exit codes:
 *   0  Success (or dry-run completed)
 *   1  Configuration error
 *   2  At least one on-chain init or DB write failed; rerun safe.
 */

import { Keypair, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";

import { prisma } from "../src/lib/prisma.js";
import { getSolanaConnection } from "../src/lib/solana.js";
import {
  buildInitializeAgentReputationIx,
  deriveAgentReputationPda,
} from "../src/lib/programs/reputationOracle.js";
import {
  isPdaAccountInitialized,
  AGENT_REPUTATION_ACCOUNT_DISCRIMINATOR,
} from "../src/services/isPdaAccountInitialized.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  let limit: number | null = null;
  const limitIdx = args.indexOf("--limit");
  if (limitIdx >= 0) {
    const v = Number(args[limitIdx + 1]);
    if (!Number.isInteger(v) || v <= 0) {
      console.error("--limit requires a positive integer");
      process.exit(1);
    }
    limit = v;
  }
  return { dryRun, limit };
}

function loadPayerKeypair(): Keypair {
  const raw = process.env.BOOTSTRAP_PAYER_PRIVATE_KEY;
  if (!raw) {
    console.error("BOOTSTRAP_PAYER_PRIVATE_KEY is required (JSON byte array)");
    process.exit(1);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch (err) {
    console.error("BOOTSTRAP_PAYER_PRIVATE_KEY is set but invalid JSON:", (err as Error).message);
    process.exit(1);
  }
}

async function main() {
  const { dryRun, limit } = parseArgs();
  const payer = loadPayerKeypair();
  const connection = getSolanaConnection();

  console.error(
    `[bootstrap-reputation] payer=${payer.publicKey.toBase58()} dryRun=${dryRun}${limit ? ` limit=${limit}` : ""}`,
  );

  const rows = await prisma.agentToken.findMany({
    where: {
      reputationProgramInitialized: false,
      mintAddress: { not: "" },
    },
    select: { id: true, mintAddress: true },
    ...(limit ? { take: limit } : {}),
  });

  console.error(`[bootstrap-reputation] candidates: ${rows.length}`);

  let alreadyOnChain = 0;
  let initialized = 0;
  let failed = 0;
  let dbOnly = 0;

  for (const row of rows) {
    const mint = new PublicKey(row.mintAddress);
    const [pda] = deriveAgentReputationPda(mint);

    let onChain = false;
    try {
      onChain = await isPdaAccountInitialized(
        { pda, expectedDiscriminator: AGENT_REPUTATION_ACCOUNT_DISCRIMINATOR },
        { connection },
      );
    } catch (err) {
      console.error(`[bootstrap-reputation] tokenId=${row.id} probe failed:`, (err as Error).message);
      failed += 1;
      continue;
    }

    if (onChain) {
      console.error(`[bootstrap-reputation] tokenId=${row.id} pda=${pda.toBase58()} already on-chain; reconciling DB`);
      alreadyOnChain += 1;
      if (!dryRun) {
        await prisma.agentToken.update({
          where: { id: row.id },
          data: { reputationProgramInitialized: true },
        });
        dbOnly += 1;
      }
      continue;
    }

    if (dryRun) {
      console.error(`[bootstrap-reputation] [DRY-RUN] would init tokenId=${row.id} pda=${pda.toBase58()}`);
      continue;
    }

    try {
      const ix = buildInitializeAgentReputationIx({
        mint,
        payer: payer.publicKey,
      });
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
      });
      await prisma.agentToken.update({
        where: { id: row.id },
        data: { reputationProgramInitialized: true },
      });
      initialized += 1;
      console.error(`[bootstrap-reputation] tokenId=${row.id} initialized; sig=${sig}`);
    } catch (err) {
      failed += 1;
      console.error(
        `[bootstrap-reputation] tokenId=${row.id} init failed:`,
        (err as Error).message,
      );
    }
  }

  const summary = { candidates: rows.length, initialized, alreadyOnChain, dbOnly, failed };
  console.error(`[bootstrap-reputation] done`, summary);

  await prisma.$disconnect();
  process.exit(failed > 0 ? 2 : 0);
}

main().catch(async (err) => {
  console.error("[bootstrap-reputation] fatal:", err);
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
