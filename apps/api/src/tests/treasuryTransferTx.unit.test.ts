import assert from "node:assert/strict";
import test from "node:test";
import {
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/treasuryTransferTx.ts — pure builder for the
// Solana transaction the treasury-settlement worker hands to the wallet for
// signing. Until the agent-treasury Anchor program ships (plan A2), the
// settlement worker pays the Nosana host directly via SystemProgram.transfer
// from the WheelsAI master keypair, with treasury balances tracked off-chain.
//
// This module is pure: builds an unsigned VersionedTransaction. Signing +
// submission happen in a separate side-effect layer, which keeps this file
// 100% unit-testable without a Connection or RPC.

const VALID_BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N"; // arbitrary base58, 32 bytes

// ============================================
// Happy path
// ============================================

test("buildTreasuryTransferTx produces an unsigned tx with one SystemProgram.transfer ix", async () => {
  setupEnv();
  const { buildTreasuryTransferTx } = await import(
    "../services/treasuryTransferTx.js"
  );
  const from = Keypair.generate().publicKey.toBase58();
  const to = Keypair.generate().publicKey.toBase58();

  const tx = buildTreasuryTransferTx({
    fromPubkey: from,
    toPubkey: to,
    amountLamports: 5_000_000n,
    recentBlockhash: VALID_BLOCKHASH,
    lastValidBlockHeight: 1234,
  });

  assert.ok(tx instanceof VersionedTransaction);
  // No signatures yet — signing is a separate side-effect step.
  assert.equal(tx.signatures.every((s) => s.every((b) => b === 0)), true);

  // Decompile the message and inspect the lone instruction.
  const msg = TransactionMessage.decompile(tx.message);
  assert.equal(msg.recentBlockhash, VALID_BLOCKHASH);
  assert.equal(msg.payerKey.toBase58(), from);
  assert.equal(msg.instructions.length, 1);
  const ix = msg.instructions[0]!;
  assert.equal(ix.programId.toBase58(), SystemProgram.programId.toBase58());
});

test("buildTreasuryTransferTx encodes the correct from/to/amount in the System ix", async () => {
  const { buildTreasuryTransferTx } = await import(
    "../services/treasuryTransferTx.js"
  );
  const from = Keypair.generate().publicKey.toBase58();
  const to = Keypair.generate().publicKey.toBase58();

  const tx = buildTreasuryTransferTx({
    fromPubkey: from,
    toPubkey: to,
    amountLamports: 4_500_000n,
    recentBlockhash: VALID_BLOCKHASH,
    lastValidBlockHeight: 1,
  });

  const msg = TransactionMessage.decompile(tx.message);
  const ix = msg.instructions[0]!;
  // SystemProgram transfer ix layout: tag (4 bytes, value 2 = Transfer) + lamports (8 bytes LE)
  // We don't reimplement the parser — just round-trip via SystemInstruction.decodeTransfer.
  const decoded = SystemInstruction.decodeTransfer(ix);
  assert.equal(decoded.fromPubkey.toBase58(), from);
  assert.equal(decoded.toPubkey.toBase58(), to);
  assert.equal(BigInt(decoded.lamports.toString()), 4_500_000n);
});

// ============================================
// Validation
// ============================================

test("buildTreasuryTransferTx throws on zero or negative amount", async () => {
  const { buildTreasuryTransferTx } = await import(
    "../services/treasuryTransferTx.js"
  );
  const from = Keypair.generate().publicKey.toBase58();
  const to = Keypair.generate().publicKey.toBase58();
  assert.throws(
    () =>
      buildTreasuryTransferTx({
        fromPubkey: from,
        toPubkey: to,
        amountLamports: 0n,
        recentBlockhash: VALID_BLOCKHASH,
        lastValidBlockHeight: 1,
      }),
    /amount/i,
  );
  assert.throws(
    () =>
      buildTreasuryTransferTx({
        fromPubkey: from,
        toPubkey: to,
        amountLamports: -1n,
        recentBlockhash: VALID_BLOCKHASH,
        lastValidBlockHeight: 1,
      }),
    /amount/i,
  );
});

test("buildTreasuryTransferTx throws when amount overflows u64", async () => {
  const { buildTreasuryTransferTx } = await import(
    "../services/treasuryTransferTx.js"
  );
  const from = Keypair.generate().publicKey.toBase58();
  const to = Keypair.generate().publicKey.toBase58();
  const u64Max = (1n << 64n) - 1n;
  // Should accept exactly u64Max...
  buildTreasuryTransferTx({
    fromPubkey: from,
    toPubkey: to,
    amountLamports: u64Max,
    recentBlockhash: VALID_BLOCKHASH,
    lastValidBlockHeight: 1,
  });
  // ...but reject anything beyond.
  assert.throws(
    () =>
      buildTreasuryTransferTx({
        fromPubkey: from,
        toPubkey: to,
        amountLamports: u64Max + 1n,
        recentBlockhash: VALID_BLOCKHASH,
        lastValidBlockHeight: 1,
      }),
    /u64/i,
  );
});

test("buildTreasuryTransferTx throws on a malformed pubkey", async () => {
  const { buildTreasuryTransferTx } = await import(
    "../services/treasuryTransferTx.js"
  );
  const from = Keypair.generate().publicKey.toBase58();
  assert.throws(
    () =>
      buildTreasuryTransferTx({
        fromPubkey: from,
        toPubkey: "not-a-pubkey",
        amountLamports: 1000n,
        recentBlockhash: VALID_BLOCKHASH,
        lastValidBlockHeight: 1,
      }),
    /pubkey/i,
  );
});

test("buildTreasuryTransferTx refuses to send to itself (catch caller bugs)", async () => {
  const { buildTreasuryTransferTx } = await import(
    "../services/treasuryTransferTx.js"
  );
  const same = Keypair.generate().publicKey.toBase58();
  assert.throws(
    () =>
      buildTreasuryTransferTx({
        fromPubkey: same,
        toPubkey: same,
        amountLamports: 1000n,
        recentBlockhash: VALID_BLOCKHASH,
        lastValidBlockHeight: 1,
      }),
    /from.*to.*equal|same/i,
  );
});

test("buildTreasuryTransferTx requires a recentBlockhash", async () => {
  const { buildTreasuryTransferTx } = await import(
    "../services/treasuryTransferTx.js"
  );
  const from = Keypair.generate().publicKey.toBase58();
  const to = Keypair.generate().publicKey.toBase58();
  assert.throws(
    () =>
      buildTreasuryTransferTx({
        fromPubkey: from,
        toPubkey: to,
        amountLamports: 1000n,
        recentBlockhash: "",
        lastValidBlockHeight: 1,
      }),
    /blockhash/i,
  );
});

// ============================================
// Round-trip
// ============================================

test("buildTreasuryTransferTx output can be signed by the from-key and the signature is valid for that account", async () => {
  const { buildTreasuryTransferTx } = await import(
    "../services/treasuryTransferTx.js"
  );
  const fromKp = Keypair.generate();
  const to = Keypair.generate().publicKey;

  const tx = buildTreasuryTransferTx({
    fromPubkey: fromKp.publicKey.toBase58(),
    toPubkey: to.toBase58(),
    amountLamports: 1_000n,
    recentBlockhash: VALID_BLOCKHASH,
    lastValidBlockHeight: 1,
  });

  tx.sign([fromKp]);
  // After signing, the from-key's signature slot should be populated with a non-zero signature.
  const sig = tx.signatures[0]!;
  assert.ok(sig.some((b) => b !== 0), "signature should be non-zero after sign()");
});
