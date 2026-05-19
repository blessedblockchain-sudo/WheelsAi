/**
 * Pure tx builder for the program-backed pay path (plan A2/A3).
 *
 * Mirrors `treasuryTransferTx.ts` but produces a VersionedTransaction
 * whose single instruction is `agent_treasury::pay_nosana(amount)` —
 * the on-chain program checks `has_one = platform_authority` and
 * directly mutates lamports from the treasury PDA to the recipient.
 *
 * Once the program is deployed to devnet and AgentTreasury rows carry
 * an `ownerTokenMint` column, the BullMQ submit worker will swap
 * buildTreasuryTransferTx → buildTreasuryProgramTransferTx and the
 * treasury auto-pay flow becomes fully program-mediated.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

const VALID_BLOCKHASH = Keypair.generate().publicKey.toBase58();

test("buildTreasuryProgramTransferTx: builds a single-ix v0 tx", async () => {
  setupEnv();
  const { buildTreasuryProgramTransferTx } = await import(
    "../services/treasuryProgramTransferTx.js"
  );
  const { AGENT_TREASURY_PROGRAM_ID } = await import(
    "../lib/programs/agentTreasury.js"
  );

  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const platformAuthority = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );
  const recipient = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );
  const tx = buildTreasuryProgramTransferTx({
    mint,
    platformAuthority,
    recipient,
    amountLamports: BigInt(1_000_000),
    recentBlockhash: VALID_BLOCKHASH,
  });

  assert.ok(tx instanceof VersionedTransaction);
  // Exactly one ix, targeting the agent-treasury program.
  const compiled = tx.message.compiledInstructions;
  assert.equal(compiled.length, 1);
  const programKey = tx.message.staticAccountKeys[
    compiled[0]!.programIdIndex
  ];
  assert.equal(programKey?.toBase58(), AGENT_TREASURY_PROGRAM_ID.toBase58());
});

test("buildTreasuryProgramTransferTx: payer is the platform authority", async () => {
  setupEnv();
  const { buildTreasuryProgramTransferTx } = await import(
    "../services/treasuryProgramTransferTx.js"
  );

  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const platformAuthority = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );
  const recipient = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );

  const tx = buildTreasuryProgramTransferTx({
    mint,
    platformAuthority,
    recipient,
    amountLamports: BigInt(500),
    recentBlockhash: VALID_BLOCKHASH,
  });

  // The payer is always the first account in a compiled v0 message — and
  // it's always a signer. The platform authority pays tx fees AND signs
  // the program ix; both are the same key in this design.
  assert.equal(
    tx.message.staticAccountKeys[0]?.toBase58(),
    platformAuthority.toBase58(),
  );
});

test("buildTreasuryProgramTransferTx: rejects zero / negative / oversized amount", async () => {
  setupEnv();
  const { buildTreasuryProgramTransferTx } = await import(
    "../services/treasuryProgramTransferTx.js"
  );

  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const platformAuthority = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );
  const recipient = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );

  for (const amt of [BigInt(0), BigInt(-1)]) {
    assert.throws(
      () =>
        buildTreasuryProgramTransferTx({
          mint,
          platformAuthority,
          recipient,
          amountLamports: amt,
          recentBlockhash: VALID_BLOCKHASH,
        }),
      /amount/i,
    );
  }
  // Just over u64::MAX
  assert.throws(
    () =>
      buildTreasuryProgramTransferTx({
        mint,
        platformAuthority,
        recipient,
        amountLamports: BigInt(2) ** BigInt(64),
        recentBlockhash: VALID_BLOCKHASH,
      }),
    /overflow|exceeds/i,
  );
});

test("buildTreasuryProgramTransferTx: rejects empty blockhash", async () => {
  setupEnv();
  const { buildTreasuryProgramTransferTx } = await import(
    "../services/treasuryProgramTransferTx.js"
  );
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const platformAuthority = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );
  const recipient = new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  );

  assert.throws(
    () =>
      buildTreasuryProgramTransferTx({
        mint,
        platformAuthority,
        recipient,
        amountLamports: BigInt(1000),
        recentBlockhash: "",
      }),
    /blockhash.*required/i,
  );
});
