import assert from "node:assert/strict";
import test from "node:test";
import {
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/submitReputationAttestation.ts — the
// side-effect orchestrator that finishes A4. Until the Anchor reputation
// oracle program ships (real signed-account write), attestations live in
// memo-program transactions: the memo data is JSON containing both the
// canonical payload AND the attester's ed25519 signature over it.
//
// On-chain readers (the public transparency page, the token launchpad)
// pull the memo, parse the JSON, recompute the canonical bytes from the
// payload, and verify the signature against the attester pubkey. Storing
// the signature in the memo means we don't conflate "the attester signed
// the payload" with "the platform signed the tx" — those are different
// statements about different things.

const VALID_BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

function happyDeps() {
  const feePayer = Keypair.generate();
  const rpcCalls: Uint8Array[] = [];
  return {
    feePayer,
    rpcCalls,
    deps: {
      feePayerKeypair: feePayer,
      fetchLatestBlockhash: async () => ({
        blockhash: VALID_BLOCKHASH,
        lastValidBlockHeight: 1234,
      }),
      sendRawTransaction: async (raw: Uint8Array) => {
        rpcCalls.push(raw);
        return "attestation_tx_sig";
      },
    },
  };
}

function happyAttestation() {
  const attester = Keypair.generate();
  return {
    payload: {
      schema: "wheelsai.attestation.v1" as const,
      agentId: "agent_1",
      agentSlug: "eliza",
      attester: attester.publicKey.toBase58(),
      errorCount: 4,
      issuedAt: "2026-04-27T12:00:00.000Z",
      periodEnd: "2026-04-27T12:00:00.000Z",
      periodStart: "2026-04-26T12:00:00.000Z",
      reputationScore: 67,
      totalRequestCount: 300,
      uptimeSeconds: 86400,
    },
    signatureBase58:
      "5".repeat(88), // any base58 of plausible length — the orchestrator doesn't verify it
  };
}

// ============================================
// Happy path
// ============================================

test("submitReputationAttestation builds a tx whose only ix targets the memo program with attestation JSON", async () => {
  setupEnv();
  const { submitReputationAttestation } = await import(
    "../services/submitReputationAttestation.js"
  );
  const { rpcCalls, deps } = happyDeps();
  const attestation = happyAttestation();

  await submitReputationAttestation(attestation, deps);

  assert.equal(rpcCalls.length, 1);
  const submitted = VersionedTransaction.deserialize(rpcCalls[0]!);
  const decompiled = TransactionMessage.decompile(submitted.message);
  assert.equal(decompiled.instructions.length, 1);
  const ix = decompiled.instructions[0]!;
  assert.equal(ix.programId.toBase58(), MEMO_PROGRAM_ID);

  // Memo data: parseable JSON containing both the payload and signature.
  const memoText = new TextDecoder().decode(ix.data);
  const memo = JSON.parse(memoText);
  assert.equal(memo.payload.agentId, attestation.payload.agentId);
  assert.equal(memo.payload.reputationScore, 67);
  assert.equal(memo.signatureBase58, attestation.signatureBase58);
});

test("submitReputationAttestation sets feePayerKeypair as the tx fee payer + primary signer", async () => {
  const { submitReputationAttestation } = await import(
    "../services/submitReputationAttestation.js"
  );
  const { feePayer, rpcCalls, deps } = happyDeps();
  await submitReputationAttestation(happyAttestation(), deps);
  const submitted = VersionedTransaction.deserialize(rpcCalls[0]!);
  const decompiled = TransactionMessage.decompile(submitted.message);
  assert.equal(decompiled.payerKey.toBase58(), feePayer.publicKey.toBase58());
  // Primary signer slot populated (non-zero after sign).
  assert.ok(submitted.signatures[0]!.some((b) => b !== 0));
});

test("submitReputationAttestation returns the tx signature from the RPC", async () => {
  const { submitReputationAttestation } = await import(
    "../services/submitReputationAttestation.js"
  );
  const { deps } = happyDeps();
  const result = await submitReputationAttestation(happyAttestation(), deps);
  assert.equal(result.txSignature, "attestation_tx_sig");
});

test("submitReputationAttestation calls fetchLatestBlockhash exactly once", async () => {
  const { submitReputationAttestation } = await import(
    "../services/submitReputationAttestation.js"
  );
  const { feePayer } = happyDeps();
  let blockhashCalls = 0;
  await submitReputationAttestation(happyAttestation(), {
    feePayerKeypair: feePayer,
    fetchLatestBlockhash: async () => {
      blockhashCalls += 1;
      return { blockhash: VALID_BLOCKHASH, lastValidBlockHeight: 1 };
    },
    sendRawTransaction: async () => "x",
  });
  assert.equal(blockhashCalls, 1);
});

// ============================================
// Memo content — round-trip
// ============================================

test("submitReputationAttestation memo data round-trips through JSON to the same {payload, signatureBase58}", async () => {
  const { submitReputationAttestation } = await import(
    "../services/submitReputationAttestation.js"
  );
  const { rpcCalls, deps } = happyDeps();
  const attestation = happyAttestation();
  await submitReputationAttestation(attestation, deps);

  const submitted = VersionedTransaction.deserialize(rpcCalls[0]!);
  const decompiled = TransactionMessage.decompile(submitted.message);
  const memoText = new TextDecoder().decode(decompiled.instructions[0]!.data);
  const memo = JSON.parse(memoText);

  // Field-for-field equality with the input.
  assert.deepEqual(memo.payload, attestation.payload);
  assert.equal(memo.signatureBase58, attestation.signatureBase58);
});

// ============================================
// Validation (caller-bug catchers)
// ============================================

test("submitReputationAttestation throws labeled error on a memo larger than the Solana cap (566 bytes after overhead)", async () => {
  // Solana caps tx size to 1232 bytes; memo data is the largest variable
  // portion. Detect the bug locally rather than as a confusing RPC error.
  const { submitReputationAttestation } = await import(
    "../services/submitReputationAttestation.js"
  );
  const { deps } = happyDeps();
  const huge = happyAttestation();
  // Pad agentSlug with junk to push memo bytes past the cap.
  (huge.payload as any).agentSlug = "x".repeat(2000);
  await assert.rejects(
    () => submitReputationAttestation(huge, deps),
    /memo_too_large/i,
  );
});

test("submitReputationAttestation throws when payload is missing required fields (caller bug)", async () => {
  const { submitReputationAttestation } = await import(
    "../services/submitReputationAttestation.js"
  );
  const { deps } = happyDeps();
  const broken = { ...happyAttestation() };
  (broken as any).payload = { schema: "wheelsai.attestation.v1" }; // missing everything else
  await assert.rejects(
    () => submitReputationAttestation(broken as any, deps),
    /payload/i,
  );
});

test("submitReputationAttestation throws when signatureBase58 is empty (caller bug)", async () => {
  const { submitReputationAttestation } = await import(
    "../services/submitReputationAttestation.js"
  );
  const { deps } = happyDeps();
  const broken = { ...happyAttestation(), signatureBase58: "" };
  await assert.rejects(
    () => submitReputationAttestation(broken, deps),
    /signature/i,
  );
});

// ============================================
// Failure surfaces
// ============================================

test("submitReputationAttestation surfaces blockhash fetch failure as labeled error", async () => {
  const { submitReputationAttestation } = await import(
    "../services/submitReputationAttestation.js"
  );
  const { feePayer } = happyDeps();
  await assert.rejects(
    () =>
      submitReputationAttestation(happyAttestation(), {
        feePayerKeypair: feePayer,
        fetchLatestBlockhash: async () => {
          throw new Error("rpc unreachable");
        },
        sendRawTransaction: async () => "x",
      }),
    /blockhash_unavailable.*rpc unreachable/,
  );
});

test("submitReputationAttestation surfaces RPC submission failure as labeled error", async () => {
  const { submitReputationAttestation } = await import(
    "../services/submitReputationAttestation.js"
  );
  const { feePayer } = happyDeps();
  await assert.rejects(
    () =>
      submitReputationAttestation(happyAttestation(), {
        feePayerKeypair: feePayer,
        fetchLatestBlockhash: async () => ({
          blockhash: VALID_BLOCKHASH,
          lastValidBlockHeight: 1,
        }),
        sendRawTransaction: async () => {
          throw new Error("blockhash expired");
        },
      }),
    /rpc_submit.*blockhash expired/,
  );
});
