/**
 * Pure tx builder for the inflow side of plan A2/A3:
 *   fee-router worker → agent_treasury::fee_receive(amount) → treasury PDA balance grows
 *
 * Mirrors treasuryProgramTransferTx.ts (the outflow side); same error
 * shape so the worker layer can map both uniformly.
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

test("buildFeeReceiveTx: builds a single-ix v0 tx targeting the agent-treasury program", async () => {
  setupEnv();
  const { buildFeeReceiveTx } = await import(
    "../services/feeReceiveTx.js"
  );
  const { AGENT_TREASURY_PROGRAM_ID } = await import(
    "../lib/programs/agentTreasury.js"
  );

  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const from = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );
  const tx = buildFeeReceiveTx({
    mint,
    from,
    amountLamports: BigInt(1_000_000),
    recentBlockhash: VALID_BLOCKHASH,
  });

  assert.ok(tx instanceof VersionedTransaction);
  const compiled = tx.message.compiledInstructions;
  assert.equal(compiled.length, 1);
  const programKey = tx.message.staticAccountKeys[
    compiled[0]!.programIdIndex
  ];
  assert.equal(programKey?.toBase58(), AGENT_TREASURY_PROGRAM_ID.toBase58());
});

test("buildFeeReceiveTx: payer is the depositor (from)", async () => {
  setupEnv();
  const { buildFeeReceiveTx } = await import(
    "../services/feeReceiveTx.js"
  );
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const from = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );

  const tx = buildFeeReceiveTx({
    mint,
    from,
    amountLamports: BigInt(500_000),
    recentBlockhash: VALID_BLOCKHASH,
  });

  // The payer (account index 0) is also the signer. For inflows, the
  // depositor pays the tx fee + the deposited amount + signs.
  assert.equal(tx.message.staticAccountKeys[0]?.toBase58(), from.toBase58());
});

test("buildFeeReceiveTx: rejects zero / negative / oversized amount", async () => {
  setupEnv();
  const { buildFeeReceiveTx } = await import(
    "../services/feeReceiveTx.js"
  );
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const from = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );

  for (const amt of [BigInt(0), BigInt(-1)]) {
    assert.throws(
      () =>
        buildFeeReceiveTx({
          mint,
          from,
          amountLamports: amt,
          recentBlockhash: VALID_BLOCKHASH,
        }),
      /amount/i,
    );
  }
  assert.throws(
    () =>
      buildFeeReceiveTx({
        mint,
        from,
        amountLamports: BigInt(2) ** BigInt(64),
        recentBlockhash: VALID_BLOCKHASH,
      }),
    /overflow|exceeds/i,
  );
});

test("buildFeeReceiveTx: rejects empty blockhash", async () => {
  setupEnv();
  const { buildFeeReceiveTx } = await import(
    "../services/feeReceiveTx.js"
  );
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const from = new PublicKey(
    "9aE2qe8KzvLyxd5HPkdLVCDQyJ9LxhtzNPZkEmLbYEz4",
  );

  assert.throws(
    () =>
      buildFeeReceiveTx({
        mint,
        from,
        amountLamports: BigInt(1000),
        recentBlockhash: "",
      }),
    /blockhash.*required/i,
  );
});
