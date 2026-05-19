/**
 * Drives apps/api/src/services/submitTreasuryPaymentViaProgram.ts —
 * program-mode counterpart to submitTreasuryPayment.ts. Composes:
 *
 *   1. fetchLatestBlockhash                          (Solana RPC)
 *   2. buildTreasuryProgramTransferTx                (pure, already tested)
 *   3. tx.sign([platformAuthorityKeypair])           (in-memory)
 *   4. sendRawTransaction                            (Solana RPC)
 *   5. markSubmitted(payment, txSignature)           (pure, already tested)
 *
 * In program mode, the signer is the `platform_authority` recorded
 * on-chain — verified by the Anchor program's `has_one` constraint.
 * The orchestrator validates `signer.publicKey === platformAuthority`
 * up front so a misconfiguration fails before we send a tx that the
 * program will reject anyway.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";

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
  const sentRaw: Uint8Array[] = [];
  return {
    authority,
    sentRaw,
    deps: {
      platformAuthorityKeypair: authority,
      fetchLatestBlockhash: async () => ({
        blockhash: VALID_BLOCKHASH,
        lastValidBlockHeight: 9000,
      }),
      sendRawTransaction: async (raw: Uint8Array) => {
        sentRaw.push(raw);
        return "prog_sig_aaa";
      },
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

test("submitTreasuryPaymentViaProgram: happy path returns submitted payment + signature", async () => {
  setupEnv();
  const { submitTreasuryPaymentViaProgram } = await import(
    "../services/submitTreasuryPaymentViaProgram.js"
  );

  const { authority, sentRaw, deps } = happyDeps();
  const input = happyInput(authority.publicKey);

  const result = await submitTreasuryPaymentViaProgram(input, deps);

  assert.equal(result.txSignature, "prog_sig_aaa");
  assert.equal(result.payment.status, "SUBMITTED");
  assert.equal(result.payment.txSignature, "prog_sig_aaa");
  assert.equal(sentRaw.length, 1, "should send exactly one tx");
});

// ----------------------------------------------------------------------
// Up-front guards
// ----------------------------------------------------------------------

test("submitTreasuryPaymentViaProgram: throws if payment is not PENDING", async () => {
  setupEnv();
  const { submitTreasuryPaymentViaProgram } = await import(
    "../services/submitTreasuryPaymentViaProgram.js"
  );

  const { authority, deps } = happyDeps();
  const input = {
    ...happyInput(authority.publicKey),
    payment: { ...basePayment(), status: "SUBMITTED" as const },
  };

  await assert.rejects(
    () => submitTreasuryPaymentViaProgram(input, deps),
    /not.*PENDING|double-submit/i,
  );
});

test("submitTreasuryPaymentViaProgram: throws if signer pubkey != platformAuthority", async () => {
  setupEnv();
  const { submitTreasuryPaymentViaProgram } = await import(
    "../services/submitTreasuryPaymentViaProgram.js"
  );

  const { deps } = happyDeps();
  // Pass an unrelated platformAuthority — the on-chain has_one constraint
  // would reject this tx, but we should fail before even building it.
  const wrongAuthority = Keypair.generate().publicKey;
  const input = happyInput(wrongAuthority);

  await assert.rejects(
    () => submitTreasuryPaymentViaProgram(input, deps),
    /authority|mismatch/i,
  );
});

// ----------------------------------------------------------------------
// Failure-mode mappings
// ----------------------------------------------------------------------

test("submitTreasuryPaymentViaProgram: blockhash fetch error → blockhash_unavailable", async () => {
  setupEnv();
  const { submitTreasuryPaymentViaProgram } = await import(
    "../services/submitTreasuryPaymentViaProgram.js"
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
    sendRawTransaction: async () => "shouldnt_get_here",
  };

  await assert.rejects(
    () => submitTreasuryPaymentViaProgram(input, deps),
    /blockhash_unavailable.*rpc 503/,
  );
});

test("submitTreasuryPaymentViaProgram: send error → rpc_submit", async () => {
  setupEnv();
  const { submitTreasuryPaymentViaProgram } = await import(
    "../services/submitTreasuryPaymentViaProgram.js"
  );

  const { authority } = happyDeps();
  const input = happyInput(authority.publicKey);
  const deps = {
    platformAuthorityKeypair: authority,
    fetchLatestBlockhash: async () => ({
      blockhash: VALID_BLOCKHASH,
      lastValidBlockHeight: 1,
    }),
    sendRawTransaction: async (): Promise<string> => {
      throw new Error("preflight failed: HasOne");
    },
  };

  await assert.rejects(
    () => submitTreasuryPaymentViaProgram(input, deps),
    /rpc_submit.*HasOne/,
  );
});
