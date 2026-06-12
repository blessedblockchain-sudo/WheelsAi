import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
import { Keypair, VersionedTransaction } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/prepareTreasuryPayment.ts — the sign-only
// half of the claim-first protocol (remediation D3). Composes:
//
//   1. fetchLatestBlockhash                       (Solana RPC)
//   2. buildTreasuryTransferTx                    (pure, already tested)
//   3. tx.sign([signerKeypair])                   (in-memory)
//   4. return { txSignature, lastValidBlockHeight, signedTxB64 }
//
// CRITICAL INVARIANT: prepare NEVER broadcasts. Its deps shape has no
// sendRawTransaction at all — broadcast happens only AFTER the claim
// (PENDING → SUBMITTING compare-and-set) persisted these artifacts, so
// a crash can only re-broadcast the same signature, never re-sign.
//
// The signer's pubkey must equal the recorded treasuryAddress — this
// orchestrator validates that up front so we don't accidentally drain
// the wrong wallet.

const NOSANA_HOST = Keypair.generate().publicKey.toBase58();
const VALID_BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";

function basePayment() {
  return {
    id: "cp_1",
    status: "PENDING" as const,
    txSignature: null,
    errorMessage: null,
    paidAt: null,
    retryCount: 0,
  };
}

function happyDeps() {
  const signer = Keypair.generate();
  return {
    signer,
    deps: {
      signerKeypair: signer,
      fetchLatestBlockhash: async () => ({
        blockhash: VALID_BLOCKHASH,
        lastValidBlockHeight: 1234,
      }),
    },
  };
}

// ============================================
// Happy path
// ============================================

test("prepareTreasuryPayment fetches blockhash, builds, signs, and returns the artifact WITHOUT broadcasting", async () => {
  setupEnv();
  const { prepareTreasuryPayment } = await import(
    "../services/prepareTreasuryPayment.js"
  );
  const { signer, deps } = happyDeps();

  const artifact = await prepareTreasuryPayment(
    {
      payment: basePayment(),
      treasuryAddress: signer.publicKey.toBase58(),
      recipientAddress: NOSANA_HOST,
      amountLamports: 4_500_000n,
    },
    deps,
  );

  // The artifact's bytes deserialize to a SIGNED tx.
  const tx = VersionedTransaction.deserialize(
    new Uint8Array(Buffer.from(artifact.signedTxB64, "base64")),
  );
  assert.ok(tx.signatures[0]!.some((b) => b !== 0), "tx must be signed");

  // txSignature is the bs58 of the signed tx's first signature — exactly
  // what sendRawTransaction would return later.
  assert.equal(artifact.txSignature, bs58.encode(tx.signatures[0]!));

  // The expiry bound is captured (as bigint) for recovery/reaper proofs.
  assert.equal(artifact.lastValidBlockHeight, 1234n);
});

test("prepareTreasuryPayment calls fetchLatestBlockhash exactly once", async () => {
  const { prepareTreasuryPayment } = await import(
    "../services/prepareTreasuryPayment.js"
  );
  const { signer } = happyDeps();
  let blockhashCalls = 0;
  await prepareTreasuryPayment(
    {
      payment: basePayment(),
      treasuryAddress: signer.publicKey.toBase58(),
      recipientAddress: NOSANA_HOST,
      amountLamports: 4_500_000n,
    },
    {
      signerKeypair: signer,
      fetchLatestBlockhash: async () => {
        blockhashCalls += 1;
        return { blockhash: VALID_BLOCKHASH, lastValidBlockHeight: 1 };
      },
    },
  );
  assert.equal(blockhashCalls, 1);
});

// ============================================
// Validation
// ============================================

test("prepareTreasuryPayment throws when signerKeypair pubkey doesn't match treasuryAddress", async () => {
  const { prepareTreasuryPayment } = await import(
    "../services/prepareTreasuryPayment.js"
  );
  const { deps } = happyDeps();
  const wrongTreasury = Keypair.generate().publicKey.toBase58();

  await assert.rejects(
    () =>
      prepareTreasuryPayment(
        {
          payment: basePayment(),
          treasuryAddress: wrongTreasury,
          recipientAddress: NOSANA_HOST,
          amountLamports: 1000n,
        },
        deps,
      ),
    /signer.*treasury|mismatch/i,
  );
});

test("prepareTreasuryPayment throws when payment is not PENDING (don't double-submit)", async () => {
  const { prepareTreasuryPayment } = await import(
    "../services/prepareTreasuryPayment.js"
  );
  const { signer, deps } = happyDeps();

  for (const status of [
    "SUBMITTING",
    "SUBMITTED",
    "CONFIRMED",
    "FAILED",
    "PARKED",
  ] as const) {
    await assert.rejects(
      () =>
        prepareTreasuryPayment(
          {
            payment: { ...basePayment(), status },
            treasuryAddress: signer.publicKey.toBase58(),
            recipientAddress: NOSANA_HOST,
            amountLamports: 1000n,
          },
          deps,
        ),
      /illegal transition|not pending/i,
      `should reject ${status}`,
    );
  }
});

test("prepareTreasuryPayment rejects zero amounts (caught by tx builder)", async () => {
  const { prepareTreasuryPayment } = await import(
    "../services/prepareTreasuryPayment.js"
  );
  const { signer, deps } = happyDeps();
  await assert.rejects(
    () =>
      prepareTreasuryPayment(
        {
          payment: basePayment(),
          treasuryAddress: signer.publicKey.toBase58(),
          recipientAddress: NOSANA_HOST,
          amountLamports: 0n,
        },
        deps,
      ),
    /amount/i,
  );
});

// ============================================
// Failure surfaces
// ============================================

test("prepareTreasuryPayment surfaces blockhash fetch failure with a labeled error", async () => {
  const { prepareTreasuryPayment } = await import(
    "../services/prepareTreasuryPayment.js"
  );
  const { signer } = happyDeps();
  await assert.rejects(
    () =>
      prepareTreasuryPayment(
        {
          payment: basePayment(),
          treasuryAddress: signer.publicKey.toBase58(),
          recipientAddress: NOSANA_HOST,
          amountLamports: 1000n,
        },
        {
          signerKeypair: signer,
          fetchLatestBlockhash: async () => {
            throw new Error("rpc unreachable");
          },
        },
      ),
    /blockhash_unavailable.*rpc unreachable/,
  );
});

// ============================================
// Artifact pair coherence
// ============================================

test("prepareTreasuryPayment artifact round-trips: the b64 bytes carry exactly txSignature", async () => {
  // The claim persists {txSignature, signedTxB64} as a pair; recovery
  // polls txSignature and re-broadcasts signedTxB64. If they ever
  // disagreed, recovery would poll one tx and re-send a different one.
  const { prepareTreasuryPayment } = await import(
    "../services/prepareTreasuryPayment.js"
  );
  const { signer, deps } = happyDeps();
  const artifact = await prepareTreasuryPayment(
    {
      payment: basePayment(),
      treasuryAddress: signer.publicKey.toBase58(),
      recipientAddress: NOSANA_HOST,
      amountLamports: 777n,
    },
    deps,
  );
  const decoded = VersionedTransaction.deserialize(
    new Uint8Array(Buffer.from(artifact.signedTxB64, "base64")),
  );
  assert.equal(bs58.encode(decoded.signatures[0]!), artifact.txSignature);
});
