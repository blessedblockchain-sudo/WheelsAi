/**
 * One-shot bootstrap: initialize the agent-treasury Anchor program PDA
 * for every existing AgentToken row that has a mintAddress but has not
 * yet been on-chain-initialized.
 *
 * Idempotent: re-running is safe. Each row is checked against the chain
 * before submitting an init tx; rows whose PDA already exists with the
 * right discriminator just get the DB flag flipped.
 *
 * Usage:
 *   BOOTSTRAP_PAYER_PRIVATE_KEY='[1,2,3,...]' \
 *   BOOTSTRAP_PLATFORM_AUTHORITY='<pubkey>' \
 *   SOLANA_NETWORK=devnet \
 *   tsx scripts/bootstrap-treasury.ts [--dry-run]
 *
 * Required env:
 *   BOOTSTRAP_PAYER_PRIVATE_KEY — JSON-encoded byte array of the funded
 *     wallet that pays rent for each Treasury account creation. Devnet:
 *     `solana-keygen new -o bootstrap.json && cat bootstrap.json`.
 *   BOOTSTRAP_PLATFORM_AUTHORITY — base58 pubkey to record as the
 *     treasury's platform_authority. This is the wallet that will sign
 *     future pay_nosana calls (the platform's auto-pay wallet). Usually
 *     derived from WALLET_MASTER_KEY; passed explicitly here so the
 *     operator can use a fresh key per environment without coupling
 *     bootstrap to the auto-pay derivation.
 *
 * Optional flags:
 *   --dry-run  Plan only; don't submit txs or write DB.
 *   --limit N  Process at most N rows (operator can iterate).
 *
 * Exit codes:
 *   0  Success (or dry-run completed)
 *   1  Configuration error (missing env, invalid keypair, etc.)
 *   2  At least one on-chain init or DB write failed; rerun safe.
 */

import { Keypair, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";

import { prisma } from "../src/lib/prisma.js";
import { getSolanaConnection } from "../src/lib/solana.js";
import {
  buildInitializeTreasuryIx,
  deriveTreasuryPda,
} from "../src/lib/programs/agentTreasury.js";
import {
  isPdaAccountInitialized,
  TREASURY_ACCOUNT_DISCRIMINATOR,
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

function loadPlatformAuthority(): PublicKey {
  const raw = process.env.BOOTSTRAP_PLATFORM_AUTHORITY;
  if (!raw) {
    console.error("BOOTSTRAP_PLATFORM_AUTHORITY is required (base58 pubkey)");
    process.exit(1);
  }
  try {
    return new PublicKey(raw);
  } catch (err) {
    console.error("BOOTSTRAP_PLATFORM_AUTHORITY is not a valid pubkey:", (err as Error).message);
    process.exit(1);
  }
}

async function main() {
  const { dryRun, limit } = parseArgs();
  const payer = loadPayerKeypair();
  const platformAuthority = loadPlatformAuthority();
  const connection = getSolanaConnection();

  console.error(
    `[bootstrap-treasury] payer=${payer.publicKey.toBase58()} authority=${platformAuthority.toBase58()} dryRun=${dryRun}${limit ? ` limit=${limit}` : ""}`,
  );

  // programInitialized lives on AgentTreasury (the Prisma mirror of the
  // on-chain Treasury PDA), not on AgentToken. Each candidate row must
  // already have an AgentTreasury — createToken (services/agentToken.ts)
  // writes both AgentToken and AgentTreasury atomically at tokenize
  // time, so any token created via the launch flow will appear here.
  // Older rows that predate that change may need a one-shot backfill.
  const rows = await prisma.agentTreasury.findMany({
    where: {
      programInitialized: false,
      token: { mintAddress: { not: "" } },
    },
    select: {
      id: true,
      token: { select: { id: true, mintAddress: true } },
    },
    ...(limit ? { take: limit } : {}),
  });

  console.error(`[bootstrap-treasury] candidates: ${rows.length}`);

  let alreadyOnChain = 0;
  let initialized = 0;
  let failed = 0;
  let dbOnly = 0;

  for (const row of rows) {
    const mint = new PublicKey(row.token.mintAddress);
    const [pda] = deriveTreasuryPda(mint);
    const tokenId = row.token.id;

    let onChain = false;
    try {
      onChain = await isPdaAccountInitialized(
        { pda, expectedDiscriminator: TREASURY_ACCOUNT_DISCRIMINATOR },
        { connection },
      );
    } catch (err) {
      console.error(`[bootstrap-treasury] tokenId=${tokenId} probe failed:`, (err as Error).message);
      failed += 1;
      continue;
    }

    if (onChain) {
      console.error(`[bootstrap-treasury] tokenId=${tokenId} pda=${pda.toBase58()} already on-chain; reconciling DB`);
      alreadyOnChain += 1;
      if (!dryRun) {
        await prisma.agentTreasury.update({
          where: { id: row.id },
          data: { programInitialized: true },
        });
        dbOnly += 1;
      }
      continue;
    }

    if (dryRun) {
      console.error(`[bootstrap-treasury] [DRY-RUN] would init tokenId=${tokenId} pda=${pda.toBase58()}`);
      continue;
    }

    try {
      const ix = buildInitializeTreasuryIx({
        mint,
        platformAuthority,
        payer: payer.publicKey,
      });
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
      });
      await prisma.agentTreasury.update({
        where: { id: row.id },
        data: { programInitialized: true },
      });
      initialized += 1;
      console.error(`[bootstrap-treasury] tokenId=${tokenId} initialized; sig=${sig}`);
    } catch (err) {
      failed += 1;
      console.error(
        `[bootstrap-treasury] tokenId=${tokenId} init failed:`,
        (err as Error).message,
      );
    }
  }

  const summary = { candidates: rows.length, initialized, alreadyOnChain, dbOnly, failed };
  console.error(`[bootstrap-treasury] done`, summary);

  await prisma.$disconnect();
  process.exit(failed > 0 ? 2 : 0);
}

main().catch(async (err) => {
  console.error("[bootstrap-treasury] fatal:", err);
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
