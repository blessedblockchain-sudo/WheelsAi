/**
 * Drives apps/api/src/services/submitAttestationTx.ts — the pure tx
 * wrapper around submit_attestation. Pinning:
 *
 *   - guards run before the ix builder (so the worker can catch issues
 *     without needing a real blockhash)
 *   - the message payerKey is the attestor (signs + pays the fee)
 *   - exactly one instruction in the message (the program ix)
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const ATTESTOR = Keypair.generate().publicKey;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

function ok() {
  return {
    mint: MINT,
    attestor: ATTESTOR,
    uptimeSecondsDelta: BigInt(3600),
    messageCountDelta: BigInt(12),
    score: 85,
    unixTs: BigInt(1_700_000_000),
    recentBlockhash: BLOCKHASH,
  };
}

test("buildSubmitAttestationTx: returns a VersionedTransaction with attestor as payer", async () => {
  setupEnv();
  const { buildSubmitAttestationTx } = await import(
    "../services/submitAttestationTx.js"
  );
  const tx = buildSubmitAttestationTx(ok());
  assert.equal(tx.message.staticAccountKeys[0]!.toBase58(), ATTESTOR.toBase58());
  // Exactly one program ix in the v0 message.
  assert.equal(tx.message.compiledInstructions.length, 1);
});

test("buildSubmitAttestationTx: rejects negative deltas", async () => {
  setupEnv();
  const { buildSubmitAttestationTx } = await import(
    "../services/submitAttestationTx.js"
  );
  assert.throws(
    () =>
      buildSubmitAttestationTx({ ...ok(), uptimeSecondsDelta: BigInt(-1) }),
    /uptime.*>= 0|negative/i,
  );
  assert.throws(
    () =>
      buildSubmitAttestationTx({ ...ok(), messageCountDelta: BigInt(-1) }),
    /message.*>= 0|negative/i,
  );
});

test("buildSubmitAttestationTx: rejects u64 overflow on deltas", async () => {
  setupEnv();
  const { buildSubmitAttestationTx } = await import(
    "../services/submitAttestationTx.js"
  );
  const overflow = BigInt(2) ** BigInt(64);
  assert.throws(
    () =>
      buildSubmitAttestationTx({ ...ok(), uptimeSecondsDelta: overflow }),
    /uptime.*overflow|u64/i,
  );
  assert.throws(
    () =>
      buildSubmitAttestationTx({ ...ok(), messageCountDelta: overflow }),
    /message.*overflow|u64/i,
  );
});

test("buildSubmitAttestationTx: rejects score outside 0..=100", async () => {
  setupEnv();
  const { buildSubmitAttestationTx } = await import(
    "../services/submitAttestationTx.js"
  );
  assert.throws(
    () => buildSubmitAttestationTx({ ...ok(), score: -1 }),
    /score.*0\.\.=100|0..=100/i,
  );
  assert.throws(
    () => buildSubmitAttestationTx({ ...ok(), score: 101 }),
    /score.*0\.\.=100|0..=100/i,
  );
  assert.throws(
    () => buildSubmitAttestationTx({ ...ok(), score: 1.5 }),
    /integer/i,
  );
});

test("buildSubmitAttestationTx: rejects i64 out-of-range unixTs", async () => {
  setupEnv();
  const { buildSubmitAttestationTx } = await import(
    "../services/submitAttestationTx.js"
  );
  // i64 max + 1
  assert.throws(
    () =>
      buildSubmitAttestationTx({
        ...ok(),
        unixTs: BigInt("9223372036854775808"),
      }),
    /unixTs.*i64/i,
  );
});

test("buildSubmitAttestationTx: rejects empty recentBlockhash", async () => {
  setupEnv();
  const { buildSubmitAttestationTx } = await import(
    "../services/submitAttestationTx.js"
  );
  assert.throws(
    () => buildSubmitAttestationTx({ ...ok(), recentBlockhash: "" }),
    /recentBlockhash.*required/i,
  );
});
