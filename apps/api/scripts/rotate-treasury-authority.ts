/**
 * Operator runbook: rotate every treasury's platform_authority after a
 * WALLET_MASTER_KEY rotation (C3).
 *
 * Background: the per-treasury pay_nosana signer is HKDF-derived from
 * WALLET_MASTER_KEY + treasuryId (services/treasuryKeypairs.ts). When
 * the master key rotates — the standard response to a suspected
 * compromise — every derived key changes, and every on-chain Treasury
 * still records the OLD key as platform_authority. This script walks
 * all programInitialized treasuries and performs the two-step on-chain
 * rotation per treasury:
 *
 *   1. propose_platform_authority(newKey)   — signed by the OLD key
 *   2. accept_platform_authority()          — signed by the NEW key
 *
 * The accept step proves the new key is real and signable BEFORE the
 * old one loses power, so a typo'd master key can never strand funds.
 *
 * Usage:
 *   OLD_WALLET_MASTER_KEY='<the master key currently recorded on-chain>' \
 *   NEW_WALLET_MASTER_KEY='<the master key to rotate to>' \
 *   BOOTSTRAP_PAYER_PRIVATE_KEY='[1,2,3,...]' \
 *   SOLANA_NETWORK=devnet \
 *   tsx scripts/rotate-treasury-authority.ts [--execute] [--limit N]
 *
 * Required env:
 *   OLD_WALLET_MASTER_KEY  — master key the treasuries were bootstrapped
 *     with (derives the CURRENT on-chain platform_authority per row).
 *   NEW_WALLET_MASTER_KEY  — master key the payment worker will use
 *     after the rotation (derives the successor authority per row).
 *   BOOTSTRAP_PAYER_PRIVATE_KEY — JSON byte array of a funded wallet
 *     that pays the tx fees (the derived authorities hold no SOL).
 *
 * Flags:
 *   --execute  Actually submit the propose+accept transactions.
 *              Without it the script is a read-only dry-run that prints
 *              the plan (what would rotate, what's already done, what
 *              looks wrong).
 *   --limit N  Process at most N treasuries.
 *
 * Per-row outcomes (summary table at the end):
 *   rotate / rotated   — old key on-chain; needs / received the two-step
 *   already-rotated    — on-chain authority already equals the new key
 *   missing            — no Treasury account at the PDA (DB drift)
 *   mismatch           — on-chain authority equals NEITHER derivation:
 *                        wrong master keys or a hijacked PDA. Never
 *                        touched; investigate before re-running.
 *   failed             — tx submission failed (rerun safe: the two-step
 *                        is idempotent — re-proposing overwrites the
 *                        pending slot, accepting twice is a no-op fail)
 *
 * Exit codes:
 *   0  Success (or dry-run completed, no mismatches)
 *   1  Configuration error (missing env, invalid keypair)
 *   2  At least one rotation failed; rerun safe.
 *   3  AUTHORITY MISMATCH detected on at least one treasury (neither
 *      old nor new derivation matches). Investigate before rerun.
 */

import {
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";

import { prisma } from "../src/lib/prisma.js";
import { getSolanaConnection } from "../src/lib/solana.js";
import {
  buildAcceptPlatformAuthorityIx,
  buildProposePlatformAuthorityIx,
  deriveTreasuryPda,
} from "../src/lib/programs/agentTreasury.js";
import { readTreasuryPlatformAuthority } from "../src/services/isPdaAccountInitialized.js";
import { makeTreasurySignerProvider } from "../src/services/treasuryKeypairs.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
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
  return { execute, limit };
}

function loadMasterKey(envName: string): string {
  const raw = process.env[envName];
  if (!raw) {
    console.error(`${envName} is required`);
    process.exit(1);
  }
  return raw;
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
    console.error(
      "BOOTSTRAP_PAYER_PRIVATE_KEY is set but invalid JSON:",
      (err as Error).message,
    );
    process.exit(1);
  }
}

interface RowResult {
  treasuryId: string;
  mint: string;
  onChain: string;
  oldKey: string;
  newKey: string;
  outcome:
    | "rotate (dry-run)"
    | "rotated"
    | "already-rotated"
    | "missing"
    | "mismatch"
    | "failed";
  detail?: string;
}

async function main() {
  const { execute, limit } = parseArgs();
  const oldMasterKey = loadMasterKey("OLD_WALLET_MASTER_KEY");
  const newMasterKey = loadMasterKey("NEW_WALLET_MASTER_KEY");
  const payer = loadPayerKeypair();
  const connection = getSolanaConnection();

  // Same derivation provider the payment worker + bootstrap use, one
  // per master key. Parity here is the whole point: the key we accept
  // with MUST be the key the worker derives after the env flips over.
  const oldAuthorityFor = makeTreasurySignerProvider({ masterKey: oldMasterKey });
  const newAuthorityFor = makeTreasurySignerProvider({ masterKey: newMasterKey });

  console.error(
    `[rotate-treasury-authority] payer=${payer.publicKey.toBase58()} mode=${execute ? "EXECUTE" : "dry-run"}${limit ? ` limit=${limit}` : ""}`,
  );

  const rows = await prisma.agentTreasury.findMany({
    where: {
      programInitialized: true,
      token: { mintAddress: { not: "" } },
    },
    select: {
      id: true,
      token: { select: { mintAddress: true } },
    },
    ...(limit ? { take: limit } : {}),
  });

  console.error(`[rotate-treasury-authority] candidates: ${rows.length}`);

  const results: RowResult[] = [];

  for (const row of rows) {
    const mint = new PublicKey(row.token.mintAddress);
    const [pda] = deriveTreasuryPda(mint);
    const oldKp = oldAuthorityFor(row.id);
    const newKp = newAuthorityFor(row.id);

    const base = {
      treasuryId: row.id,
      mint: mint.toBase58(),
      oldKey: oldKp.publicKey.toBase58(),
      newKey: newKp.publicKey.toBase58(),
    };

    let onChain: PublicKey | null;
    try {
      onChain = await readTreasuryPlatformAuthority(connection, pda);
    } catch (err) {
      results.push({
        ...base,
        onChain: "<read-error>",
        outcome: "failed",
        detail: (err as Error).message,
      });
      continue;
    }

    if (!onChain) {
      // programInitialized=true in the DB but no Treasury on-chain —
      // DB drift; nothing to rotate. Surface it, don't fail the run.
      results.push({ ...base, onChain: "<missing>", outcome: "missing" });
      continue;
    }

    if (onChain.equals(newKp.publicKey)) {
      // A previous (possibly partial) run already completed this row.
      results.push({
        ...base,
        onChain: onChain.toBase58(),
        outcome: "already-rotated",
      });
      continue;
    }

    if (!onChain.equals(oldKp.publicKey)) {
      // Neither derivation matches: wrong master key(s) or a hijacked
      // treasury. Never sign anything against this row.
      results.push({
        ...base,
        onChain: onChain.toBase58(),
        outcome: "mismatch",
        detail: "on-chain authority matches neither OLD nor NEW derivation",
      });
      console.error(
        `[rotate-treasury-authority] !!! MISMATCH treasuryId=${row.id} pda=${pda.toBase58()} on-chain=${onChain.toBase58()}`,
      );
      continue;
    }

    if (!execute) {
      results.push({
        ...base,
        onChain: onChain.toBase58(),
        outcome: "rotate (dry-run)",
      });
      continue;
    }

    try {
      // Step 1: propose, signed by the OLD authority (has_one check).
      const proposeIx = buildProposePlatformAuthorityIx({
        mint,
        platformAuthority: oldKp.publicKey,
        newAuthority: newKp.publicKey,
      });
      const proposeSig = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(proposeIx),
        [payer, oldKp],
        { commitment: "confirmed" },
      );

      // Step 2: accept, signed by the NEW authority. Submitted only
      // after the propose confirmed, so ordering is guaranteed.
      const acceptIx = buildAcceptPlatformAuthorityIx({
        mint,
        newAuthority: newKp.publicKey,
      });
      const acceptSig = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(acceptIx),
        [payer, newKp],
        { commitment: "confirmed" },
      );

      results.push({
        ...base,
        onChain: onChain.toBase58(),
        outcome: "rotated",
        detail: `propose=${proposeSig} accept=${acceptSig}`,
      });
      console.error(
        `[rotate-treasury-authority] treasuryId=${row.id} rotated; propose=${proposeSig} accept=${acceptSig}`,
      );
    } catch (err) {
      results.push({
        ...base,
        onChain: onChain.toBase58(),
        outcome: "failed",
        detail: (err as Error).message,
      });
      console.error(
        `[rotate-treasury-authority] treasuryId=${row.id} rotation failed:`,
        (err as Error).message,
      );
    }
  }

  // Summary table — operator-facing, so stdout via console.table.
  console.table(
    results.map((r) => ({
      treasuryId: r.treasuryId,
      outcome: r.outcome,
      onChain: r.onChain,
      newKey: r.newKey,
      detail: r.detail ?? "",
    })),
  );

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  console.error(`[rotate-treasury-authority] done`, counts);

  await prisma.$disconnect();
  if ((counts["mismatch"] ?? 0) > 0) process.exit(3);
  if ((counts["failed"] ?? 0) > 0) process.exit(2);
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[rotate-treasury-authority] fatal:", err);
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
