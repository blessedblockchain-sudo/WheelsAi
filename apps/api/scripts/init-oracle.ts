/**
 * One-shot: initialize the reputation-oracle singleton OracleConfig PDA
 * and seed the platform attestor whitelist.
 *
 * Runs once per environment (devnet, mainnet, etc.). After this the
 * per-agent bootstrap-reputation.ts can be used to allocate individual
 * AgentReputation PDAs, and the reputation-attestation BullMQ worker
 * can submit attestations signed by the whitelisted attestor key.
 *
 * Idempotent on initialize_oracle: if the config PDA already exists with
 * the right discriminator, the script skips the init and proceeds to
 * the attestor add. add_attestor itself surfaces AttestorAlreadyExists
 * as a non-zero exit so the operator notices duplicate runs.
 *
 * Usage:
 *   BOOTSTRAP_PAYER_PRIVATE_KEY='[1,2,3,...]' \
 *   BOOTSTRAP_ATTESTOR_PUBKEY='<base58>' \
 *   SOLANA_NETWORK=devnet \
 *   tsx scripts/init-oracle.ts [--dry-run] [--skip-attestor]
 *
 * Required env:
 *   BOOTSTRAP_PAYER_PRIVATE_KEY — JSON byte array of the admin keypair.
 *     Whoever calls initialize_oracle BECOMES the oracle admin; pick the
 *     wallet you want to hold that authority (rotate later via
 *     propose_admin + accept_admin to a multisig before mainnet — Phase 3A).
 *   BOOTSTRAP_ATTESTOR_PUBKEY — base58 pubkey to add to the attestor
 *     whitelist. Optional if --skip-attestor is passed.
 *
 * Optional flags:
 *   --dry-run         Plan only; submit no txs.
 *   --skip-attestor   Initialize the oracle but don't add an attestor.
 *
 * Exit codes:
 *   0  Success (or dry-run completed)
 *   1  Configuration error
 *   2  At least one on-chain op failed; rerun safe.
 */

import {
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";

import { getSolanaConnection } from "../src/lib/solana.js";
import {
  buildAddAttestorIx,
  buildInitializeOracleIx,
  deriveOracleConfigPda,
} from "../src/lib/programs/reputationOracle.js";
import {
  isPdaAccountInitialized,
  ORACLE_CONFIG_ACCOUNT_DISCRIMINATOR,
} from "../src/services/isPdaAccountInitialized.js";

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes("--dry-run"),
    skipAttestor: args.includes("--skip-attestor"),
  };
}

function loadAdminKeypair(): Keypair {
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

function loadAttestorPubkey(): PublicKey | null {
  const raw = process.env.BOOTSTRAP_ATTESTOR_PUBKEY;
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch (err) {
    console.error(
      "BOOTSTRAP_ATTESTOR_PUBKEY is not a valid pubkey:",
      (err as Error).message,
    );
    process.exit(1);
  }
}

async function main() {
  const { dryRun, skipAttestor } = parseArgs();
  const admin = loadAdminKeypair();
  const attestor = skipAttestor ? null : loadAttestorPubkey();
  if (!skipAttestor && !attestor) {
    console.error(
      "BOOTSTRAP_ATTESTOR_PUBKEY is required unless --skip-attestor is set",
    );
    process.exit(1);
  }
  const connection = getSolanaConnection();
  const [config] = deriveOracleConfigPda();

  console.error(
    `[init-oracle] admin=${admin.publicKey.toBase58()} config=${config.toBase58()} attestor=${attestor?.toBase58() ?? "(skipped)"} dryRun=${dryRun}`,
  );

  let failed = 0;

  // Step 1: initialize_oracle (idempotent against the on-chain probe)
  const alreadyInitialized = await isPdaAccountInitialized(
    { pda: config, expectedDiscriminator: ORACLE_CONFIG_ACCOUNT_DISCRIMINATOR },
    { connection },
  );

  if (alreadyInitialized) {
    console.error(
      `[init-oracle] OracleConfig already initialized at ${config.toBase58()}; skipping init`,
    );
  } else if (dryRun) {
    console.error(`[init-oracle] [DRY-RUN] would initialize_oracle`);
  } else {
    try {
      const ix = buildInitializeOracleIx({ admin: admin.publicKey });
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(connection, tx, [admin], {
        commitment: "confirmed",
      });
      console.error(`[init-oracle] initialize_oracle ok; sig=${sig}`);
    } catch (err) {
      failed += 1;
      console.error(
        `[init-oracle] initialize_oracle failed:`,
        (err as Error).message,
      );
    }
  }

  // Step 2: add_attestor (only if step 1 succeeded or was a no-op)
  if (attestor && failed === 0) {
    if (dryRun) {
      console.error(
        `[init-oracle] [DRY-RUN] would add_attestor ${attestor.toBase58()}`,
      );
    } else {
      try {
        const ix = buildAddAttestorIx({
          admin: admin.publicKey,
          attestor,
        });
        const tx = new Transaction().add(ix);
        const sig = await sendAndConfirmTransaction(connection, tx, [admin], {
          commitment: "confirmed",
        });
        console.error(
          `[init-oracle] add_attestor ${attestor.toBase58()} ok; sig=${sig}`,
        );
      } catch (err) {
        failed += 1;
        const msg = (err as Error).message;
        // The program returns AttestorAlreadyExists when the pubkey is
        // already on the whitelist; surface as a non-zero exit so the
        // operator notices, but the system is still in the desired state.
        console.error(`[init-oracle] add_attestor failed:`, msg);
      }
    }
  }

  console.error(`[init-oracle] done failed=${failed}`);
  process.exit(failed > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error("[init-oracle] fatal:", err);
  process.exit(1);
});
