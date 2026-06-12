/**
 * Drives apps/api/src/services/prepareTreasuryPaymentViaProgram.ts —
 * program-mode counterpart to prepareTreasuryPayment.ts (sign-only half
 * of the claim-first protocol, remediation D3). Composes:
 *
 *   1. fetchLatestBlockhash                          (Solana RPC)
 *   2. buildTreasuryProgramTransferTx                (pure, already tested)
 *   3. tx.sign([platformAuthorityKeypair])           (in-memory)
 *   4. return { txSignature, lastValidBlockHeight, signedTxB64 }
 *
 * NEVER broadcasts — its deps shape has no sendRawTransaction at all.
 *
 * In program mode, the signer is the `platform_authority` recorded
 * on-chain — verified by the Anchor program's `has_one` constraint.
 * The orchestrator validates `signer.publicKey === platformAuthority`
 * up front so a misconfiguration fails before we sign a tx that the
 * program will reject anyway.
 */

import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
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

function basePayment() {
  return {
    id: "cp_42",
    status: "PENDING" as const,
    txSignature: null,
    errorMessage: null,
    paidAt: null,
    retryCount: 0,
  };
}

function happyDeps() {
  const authority = Keypair.generate();
  return {
    authority,
    deps: {
      platformAuthorityKeypair: authority,
      fetchLatestBlockhash: async () => ({
        blockhash: VALID_BLOCKHASH,
        lastValidBlockHeight: 9000,
      }),
    },
  };
}

function happyInput(authorityPubkey: PublicKey) {
  return {
    payment: basePayment(),
    mint: new PublicKey("So11111111111111111111111111111111111111112"),
    platformAuthority: authorityPubkey,
    recipient: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    amountLamports: BigInt(1_000_000),
  };
}

// ----------------------------------------------------------------------
// Happy path
// ----------------------------------------------------------------------

test("prepareTreasuryPaymentViaProgram: happy path returns a signed artifact without broadcasting", async () => {
  setupEnv();
  const { prepareTreasuryPaymentViaProgram } = await import(
    "../services/prepareTreasuryPaymentViaProgram.js"
  );

  const { authority, deps } = happyDeps();
  const input = happyInput(authority.publicKey);

  const artifact = await prepareTreasuryPaymentViaProgram(input, deps);

  const tx = VersionedTransaction.deserialize(
    new Uint8Array(Buffer.from(artifact.signedTxB64, "base64")),
  );
  assert.ok(tx.signatures[0]!.some((b) => b !== 0), "tx must be signed");
  assert.equal(artifact.txSignature, bs58.encode(tx.signatures[0]!));
  // The program-mode path now CAPTURES lastValidBlockHeight (the old
  // submit orchestrator discarded it — the reaper was blind, D4).
  assert.equal(artifact.lastValidBlockHeight, 9000n);
});

// ----------------------------------------------------------------------
// Up-front guards
// ----------------------------------------------------------------------

test("prepareTreasuryPaymentViaProgram: throws if payment is not PENDING", async () => {
  setupEnv();
  const { prepareTreasuryPaymentViaProgram } = await import(
    "../services/prepareTreasuryPaymentViaProgram.js"
  );

  const { authority, deps } = happyDeps();
  const input = {
    ...happyInput(authority.publicKey),
    payment: { ...basePayment(), status: "SUBMITTED" as const },
  };

  await assert.rejects(
    () => prepareTreasuryPaymentViaProgram(input, deps),
    /not.*PENDING|double-submit/i,
  );
});

test("prepareTreasuryPaymentViaProgram: throws if signer pubkey != platformAuthority", async () => {
  setupEnv();
  const { prepareTreasuryPaymentViaProgram } = await import(
    "../services/prepareTreasuryPaymentViaProgram.js"
  );

  const { deps } = happyDeps();
  // Pass an unrelated platformAuthority — the on-chain has_one constraint
  // would reject this tx, but we should fail before even building it.
  const wrongAuthority = Keypair.generate().publicKey;
  const input = happyInput(wrongAuthority);

  await assert.rejects(
    () => prepareTreasuryPaymentViaProgram(input, deps),
    /authority|mismatch/i,
  );
});

// ----------------------------------------------------------------------
// Failure-mode mappings
// ----------------------------------------------------------------------

test("prepareTreasuryPaymentViaProgram: blockhash fetch error → blockhash_unavailable", async () => {
  setupEnv();
  const { prepareTreasuryPaymentViaProgram } = await import(
    "../services/prepareTreasuryPaymentViaProgram.js"
  );

  const { authority } = happyDeps();
  const input = happyInput(authority.publicKey);
  const deps = {
    platformAuthorityKeypair: authority,
    fetchLatestBlockhash: async (): Promise<{
      blockhash: string;
      lastValidBlockHeight: number;
    }> => {
      throw new Error("rpc 503");
    },
  };

  await assert.rejects(
    () => prepareTreasuryPaymentViaProgram(input, deps),
    /blockhash_unavailable.*rpc 503/,
  );
});

// ----------------------------------------------------------------------
// Artifact pair coherence
// ----------------------------------------------------------------------

test("prepareTreasuryPaymentViaProgram: the b64 bytes carry exactly txSignature", async () => {
  setupEnv();
  const { prepareTreasuryPaymentViaProgram } = await import(
    "../services/prepareTreasuryPaymentViaProgram.js"
  );
  const { authority, deps } = happyDeps();
  const artifact = await prepareTreasuryPaymentViaProgram(
    happyInput(authority.publicKey),
    deps,
  );
  const decoded = VersionedTransaction.deserialize(
    new Uint8Array(Buffer.from(artifact.signedTxB64, "base64")),
  );
  assert.equal(bs58.encode(decoded.signatures[0]!), artifact.txSignature);
});
