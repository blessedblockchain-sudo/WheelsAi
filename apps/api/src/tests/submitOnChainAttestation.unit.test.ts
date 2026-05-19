/**
 * Drives apps/api/src/services/submitOnChainAttestation.ts — the
 * side-effect orchestrator wrapping submit_attestation. Same error-tag
 * prefixes as the inflow orchestrator (submitFeeReceive) so the worker
 * layer can map both into a single retry policy.
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
const VALID_BLOCKHASH = Keypair.generate().publicKey.toBase58();

function happyDeps() {
  const attestorKeypair = Keypair.generate();
  const sentRaw: Uint8Array[] = [];
  return {
    attestorKeypair,
    sentRaw,
    deps: {
      attestorKeypair,
      fetchLatestBlockhash: async () => ({
        blockhash: VALID_BLOCKHASH,
        lastValidBlockHeight: 100,
      }),
      sendRawTransaction: async (raw: Uint8Array) => {
        sentRaw.push(raw);
        return "att_sig_zzz";
      },
    },
  };
}

function happyInput(attestor: PublicKey) {
  return {
    mint: MINT,
    attestor,
    uptimeSecondsDelta: BigInt(3600),
    messageCountDelta: BigInt(12),
    score: 80,
    unixTs: BigInt(1_700_000_000),
  };
}

test("submitOnChainAttestation: happy path returns tx signature", async () => {
  setupEnv();
  const { submitOnChainAttestation } = await import(
    "../services/submitOnChainAttestation.js"
  );
  const { attestorKeypair, sentRaw, deps } = happyDeps();
  const result = await submitOnChainAttestation(
    happyInput(attestorKeypair.publicKey),
    deps,
  );
  assert.equal(result.txSignature, "att_sig_zzz");
  assert.equal(sentRaw.length, 1);
});

test("submitOnChainAttestation: throws when keypair/attestor mismatch", async () => {
  setupEnv();
  const { submitOnChainAttestation } = await import(
    "../services/submitOnChainAttestation.js"
  );
  const { deps } = happyDeps();
  const wrong = Keypair.generate().publicKey;
  await assert.rejects(
    () => submitOnChainAttestation(happyInput(wrong), deps),
    /attestor.*mismatch|keypair.*mismatch/i,
  );
});

test("submitOnChainAttestation: blockhash fetch error → blockhash_unavailable", async () => {
  setupEnv();
  const { submitOnChainAttestation } = await import(
    "../services/submitOnChainAttestation.js"
  );
  const attestorKeypair = Keypair.generate();
  const deps = {
    attestorKeypair,
    fetchLatestBlockhash: async (): Promise<{
      blockhash: string;
      lastValidBlockHeight: number;
    }> => {
      throw new Error("rpc 503");
    },
    sendRawTransaction: async () => "no",
  };
  await assert.rejects(
    () =>
      submitOnChainAttestation(happyInput(attestorKeypair.publicKey), deps),
    /blockhash_unavailable.*rpc 503/,
  );
});

test("submitOnChainAttestation: send error → rpc_submit", async () => {
  setupEnv();
  const { submitOnChainAttestation } = await import(
    "../services/submitOnChainAttestation.js"
  );
  const attestorKeypair = Keypair.generate();
  const deps = {
    attestorKeypair,
    fetchLatestBlockhash: async () => ({
      blockhash: VALID_BLOCKHASH,
      lastValidBlockHeight: 9,
    }),
    sendRawTransaction: async (): Promise<string> => {
      throw new Error("attestor not whitelisted");
    },
  };
  await assert.rejects(
    () =>
      submitOnChainAttestation(happyInput(attestorKeypair.publicKey), deps),
    /rpc_submit.*not whitelisted/,
  );
});

test("submitOnChainAttestation: score=101 rejected up-front by tx builder", async () => {
  setupEnv();
  const { submitOnChainAttestation } = await import(
    "../services/submitOnChainAttestation.js"
  );
  const { attestorKeypair, deps } = happyDeps();
  await assert.rejects(
    () =>
      submitOnChainAttestation(
        { ...happyInput(attestorKeypair.publicKey), score: 101 },
        deps,
      ),
    /score.*0\.\.=100|0..=100/i,
  );
});
