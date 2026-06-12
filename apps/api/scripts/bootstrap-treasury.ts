/**
 * One-shot bootstrap: initialize the agent-treasury Anchor program PDA
 * for every existing AgentToken row that has a mintAddress but has not
 * yet been on-chain-initialized.
 *
 * Idempotent: re-running is safe. Each row is checked against the chain
 * before submitting an init tx; rows whose PDA already exists with the
 * right discriminator AND the expected platform_authority just get the
 * DB flag flipped. Rows whose PDA exists with a DIFFERENT authority are
 * flagged loudly and the script exits non-zero (hijack/misconfig
 * detection) — programInitialized is NOT flipped for those.
 *
 * Usage:
 *   BOOTSTRAP_PAYER_PRIVATE_KEY='[1,2,3,...]' \
 *   BOOTSTRAP_ADMIN_KEYPAIR='<base58 secret key>' \
 *   WALLET_MASTER_KEY='<same master key the payment worker uses>' \
 *   SOLANA_NETWORK=devnet \
 *   tsx scripts/bootstrap-treasury.ts [--dry-run] [--init-config] [--limit N]
 *
 * Required env:
 *   BOOTSTRAP_PAYER_PRIVATE_KEY — JSON-encoded byte array of the funded
 *     wallet that pays rent for each Treasury account creation. Devnet:
 *     `solana-keygen new -o bootstrap.json && cat bootstrap.json`.
 *   BOOTSTRAP_ADMIN_KEYPAIR — base58-encoded 64-byte secret key of the
 *     TreasuryConfig admin. initialize_treasury is admin-gated (C1), so
 *     this key must co-sign every init. With --init-config it is also
 *     the key that becomes the config admin.
 *   WALLET_MASTER_KEY — the SAME master secret the payment-submit
 *     worker uses. The per-treasury platform_authority is derived from
 *     it via makeTreasurySignerProvider (HKDF over masterKey +
 *     treasuryId) so the key recorded on-chain is byte-identical to the
 *     key the worker will later sign pay_nosana with (C2). This
 *     replaces the old single global BOOTSTRAP_PLATFORM_AUTHORITY env.
 *
 * Optional flags:
 *   --dry-run      Plan only; don't submit txs or write DB.
 *   --init-config  One-time: call initialize_config if the config PDA
 *                  doesn't exist yet (run once after program deploy).
 *   --limit N      Process at most N rows (operator can iterate).
 *
 * Exit codes:
 *   0  Success (or dry-run completed)
 *   1  Configuration error (missing env, invalid keypair, missing
 *      config PDA without --init-config, etc.)
 *   2  At least one on-chain init or DB write failed; rerun safe.
 *   3  AUTHORITY MISMATCH detected: at least one existing on-chain
 *      treasury records a platform_authority that differs from the
 *      derived expectation. Possible hijack or wrong WALLET_MASTER_KEY.
 *      Nothing was flipped for those rows; investigate before rerun.
 */

import { Keypair, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

import { prisma } from "../src/lib/prisma.js";
import { getSolanaConnection } from "../src/lib/solana.js";
import {
  buildInitializeConfigIx,
  buildInitializeTreasuryIx,
  deriveTreasuryConfigPda,
  deriveTreasuryPda,
} from "../src/lib/programs/agentTreasury.js";
import {
  isPdaAccountInitialized,
  readTreasuryPlatformAuthority,
  TREASURY_ACCOUNT_DISCRIMINATOR,
  TREASURY_CONFIG_ACCOUNT_DISCRIMINATOR,
} from "../src/services/isPdaAccountInitialized.js";
import { makeTreasurySignerProvider } from "../src/services/treasuryKeypairs.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const initConfig = args.includes("--init-config");
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
  return { dryRun, initConfig, limit };
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

function loadAdminKeypair(): Keypair {
  const raw = process.env.BOOTSTRAP_ADMIN_KEYPAIR;
  if (!raw) {
    console.error("BOOTSTRAP_ADMIN_KEYPAIR is required (base58 secret key)");
    process.exit(1);
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch (err) {
    console.error(
      "BOOTSTRAP_ADMIN_KEYPAIR is set but not a valid base58 secret key:",
      (err as Error).message,
    );
    process.exit(1);
  }
}

function loadMasterKey(): string {
  const raw = process.env.WALLET_MASTER_KEY;
  if (!raw) {
    console.error(
      "WALLET_MASTER_KEY is required — must be the SAME master key the payment worker uses (per-treasury authority derivation, C2)",
    );
    process.exit(1);
  }
  return raw;
}

/** Dedupe signers by pubkey so payer === admin doesn't double-sign. */
function uniqueSigners(signers: Keypair[]): Keypair[] {
  const seen = new Set<string>();
  return signers.filter((kp) => {
    const k = kp.publicKey.toBase58();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function main() {
  const { dryRun, initConfig, limit } = parseArgs();
  const payer = loadPayerKeypair();
  const admin = loadAdminKeypair();
  const masterKey = loadMasterKey();
  const connection = getSolanaConnection();

  // Same provider the payment-submit worker wires up
  // (queues/payment-submit.queue.ts) — derivation parity is what makes
  // the recorded authority signable later.
  const authorityFor = makeTreasurySignerProvider({ masterKey });

  console.error(
    `[bootstrap-treasury] payer=${payer.publicKey.toBase58()} admin=${admin.publicKey.toBase58()} dryRun=${dryRun}${limit ? ` limit=${limit}` : ""}`,
  );

  // ------------------------------------------------------------------
  // Config PDA: initialize_treasury is admin-gated, so the singleton
  // TreasuryConfig must exist before any treasury init can land.
  // ------------------------------------------------------------------
  const [configPda] = deriveTreasuryConfigPda();
  let configExists = false;
  try {
    configExists = await isPdaAccountInitialized(
      { pda: configPda, expectedDiscriminator: TREASURY_CONFIG_ACCOUNT_DISCRIMINATOR },
      { connection },
    );
  } catch (err) {
    console.error("[bootstrap-treasury] config PDA probe failed:", (err as Error).message);
    process.exit(2);
  }

  if (!configExists) {
    if (!initConfig) {
      console.error(
        `[bootstrap-treasury] TreasuryConfig PDA ${configPda.toBase58()} does not exist. ` +
          `Run once with --init-config (the BOOTSTRAP_ADMIN_KEYPAIR becomes the config admin).`,
      );
      process.exit(1);
    }
    if (dryRun) {
      console.error(
        `[bootstrap-treasury] [DRY-RUN] would initialize_config at ${configPda.toBase58()} with admin=${admin.publicKey.toBase58()}`,
      );
    } else {
      try {
        const ix = buildInitializeConfigIx({ admin: admin.publicKey });
        const tx = new Transaction().add(ix);
        // The admin pays the config PDA rent (it is the `payer` in the
        // Rust InitializeConfig struct); the payer covers the tx fee.
        const sig = await sendAndConfirmTransaction(
          connection,
          tx,
          uniqueSigners([payer, admin]),
          { commitment: "confirmed" },
        );
        console.error(`[bootstrap-treasury] initialize_config landed; sig=${sig}`);
      } catch (err) {
        console.error("[bootstrap-treasury] initialize_config failed:", (err as Error).message);
        process.exit(2);
      }
    }
  } else if (initConfig) {
    console.error(
      `[bootstrap-treasury] config PDA ${configPda.toBase58()} already exists; --init-config is a no-op`,
    );
  }

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
  let authorityMismatches = 0;

  for (const row of rows) {
    const mint = new PublicKey(row.token.mintAddress);
    const [pda] = deriveTreasuryPda(mint);
    const tokenId = row.token.id;
    // Per-treasury authority — derived from WALLET_MASTER_KEY + the
    // AgentTreasury row id, exactly like the payment worker does.
    const expectedAuthority = authorityFor(row.id).publicKey;

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
      // The PDA exists. Before reconciling the DB flag, verify the
      // recorded platform_authority matches our derivation — an
      // attacker-initialized (pre-C1) or wrong-master-key treasury
      // must NOT be marked programInitialized, or the fee router would
      // deposit funds the worker can never move (or worse, that an
      // attacker can).
      let recorded: PublicKey | null = null;
      try {
        recorded = await readTreasuryPlatformAuthority(connection, pda);
      } catch (err) {
        console.error(
          `[bootstrap-treasury] tokenId=${tokenId} authority read failed:`,
          (err as Error).message,
        );
        failed += 1;
        continue;
      }

      if (!recorded || !recorded.equals(expectedAuthority)) {
        authorityMismatches += 1;
        console.error(
          `[bootstrap-treasury] !!! AUTHORITY MISMATCH tokenId=${tokenId} pda=${pda.toBase58()}: ` +
            `on-chain=${recorded ? recorded.toBase58() : "<unreadable>"} expected=${expectedAuthority.toBase58()}. ` +
            `Possible hijack or wrong WALLET_MASTER_KEY — NOT flipping programInitialized.`,
        );
        continue;
      }

      console.error(`[bootstrap-treasury] tokenId=${tokenId} pda=${pda.toBase58()} already on-chain with expected authority; reconciling DB`);
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
      console.error(
        `[bootstrap-treasury] [DRY-RUN] would init tokenId=${tokenId} pda=${pda.toBase58()} authority=${expectedAuthority.toBase58()}`,
      );
      continue;
    }

    try {
      const ix = buildInitializeTreasuryIx({
        mint,
        platformAuthority: expectedAuthority,
        admin: admin.publicKey,
        payer: payer.publicKey,
      });
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(
        connection,
        tx,
        uniqueSigners([payer, admin]),
        { commitment: "confirmed" },
      );
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

  const summary = {
    candidates: rows.length,
    initialized,
    alreadyOnChain,
    dbOnly,
    failed,
    authorityMismatches,
  };
  console.error(`[bootstrap-treasury] done`, summary);

  await prisma.$disconnect();
  // Mismatch (3) outranks plain failures (2): it's the
  // hijack/misconfig signal and must not be masked by a retryable
  // RPC hiccup elsewhere in the batch.
  if (authorityMismatches > 0) process.exit(3);
  process.exit(failed > 0 ? 2 : 0);
}

main().catch(async (err) => {
  console.error("[bootstrap-treasury] fatal:", err);
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
