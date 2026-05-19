/**
 * Drives apps/api/src/services/submitFeeReceive.ts — the side-effect
 * orchestrator for the inflow path. Composes:
 *
 *   1. fetchLatestBlockhash             (Solana RPC)
 *   2. buildFeeReceiveTx                (pure)
 *   3. tx.sign([fromKeypair])
 *   4. sendRawTransaction               (Solana RPC)
 *
 * Returns the tx signature so the BullMQ fee-router can persist a
 * record and increment its "last_fee_routed_at" cursor.
 *
 * Same error-tag prefixes as the outflow orchestrator
 * (submitTreasuryPaymentViaProgram) so the worker layer can map both
 * uniformly into a single retryable-error policy.
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

function happyDeps() {
  const fromKeypair = Keypair.generate();
  const sentRaw: Uint8Array[] = [];
  return {
    fromKeypair,
    sentRaw,
    deps: {
      fromKeypair,
      fetchLatestBlockhash: async () => ({
        blockhash: VALID_BLOCKHASH,
        lastValidBlockHeight: 100,
      }),
      sendRawTransaction: async (raw: Uint8Array) => {
        sentRaw.push(raw);
        return "fee_sig_aaa";
      },
    },
  };
}

function happyInput(fromPubkey: PublicKey) {
  return {
    mint: new PublicKey("So11111111111111111111111111111111111111112"),
    from: fromPubkey,
    amountLamports: BigInt(2_500_000),
  };
}

test("submitFeeReceive: happy path returns tx signature", async () => {
  setupEnv();
  const { submitFeeReceive } = await import(
    "../services/submitFeeReceive.js"
  );
  const { fromKeypair, sentRaw, deps } = happyDeps();
  const result = await submitFeeReceive(
    happyInput(fromKeypair.publicKey),
    deps,
  );
  assert.equal(result.txSignature, "fee_sig_aaa");
  assert.equal(sentRaw.length, 1);
});

test("submitFeeReceive: throws if signer keypair pubkey != input.from", async () => {
  setupEnv();
  const { submitFeeReceive } = await import(
    "../services/submitFeeReceive.js"
  );
  const { deps } = happyDeps();
  const wrong = Keypair.generate().publicKey;
  await assert.rejects(
    () => submitFeeReceive(happyInput(wrong), deps),
    /from.*mismatch|keypair.*mismatch/i,
  );
});

test("submitFeeReceive: blockhash fetch error → blockhash_unavailable tag", async () => {
  setupEnv();
  const { submitFeeReceive } = await import(
    "../services/submitFeeReceive.js"
  );
  const fromKeypair = Keypair.generate();
  const deps = {
    fromKeypair,
    fetchLatestBlockhash: async (): Promise<{
      blockhash: string;
      lastValidBlockHeight: number;
    }> => {
      throw new Error("rpc 503");
    },
    sendRawTransaction: async () => "shouldnt_get_here",
  };
  await assert.rejects(
    () => submitFeeReceive(happyInput(fromKeypair.publicKey), deps),
    /blockhash_unavailable.*rpc 503/,
  );
});

test("submitFeeReceive: send error → rpc_submit tag", async () => {
  setupEnv();
  const { submitFeeReceive } = await import(
    "../services/submitFeeReceive.js"
  );
  const fromKeypair = Keypair.generate();
  const deps = {
    fromKeypair,
    fetchLatestBlockhash: async () => ({
      blockhash: VALID_BLOCKHASH,
      lastValidBlockHeight: 9,
    }),
    sendRawTransaction: async (): Promise<string> => {
      throw new Error("preflight: insufficient lamports");
    },
  };
  await assert.rejects(
    () => submitFeeReceive(happyInput(fromKeypair.publicKey), deps),
    /rpc_submit.*insufficient lamports/,
  );
});

test("submitFeeReceive: amount=0 rejected up front (pure tx builder catches)", async () => {
  setupEnv();
  const { submitFeeReceive } = await import(
    "../services/submitFeeReceive.js"
  );
  const { fromKeypair, deps } = happyDeps();
  await assert.rejects(
    () =>
      submitFeeReceive(
        { ...happyInput(fromKeypair.publicKey), amountLamports: BigInt(0) },
        deps,
      ),
    /amount.*positive/i,
  );
});
