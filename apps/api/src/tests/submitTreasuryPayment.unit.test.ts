import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, VersionedTransaction } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/submitTreasuryPayment.ts — the side-effect
// orchestrator that finishes A3. Composes:
//
//   1. fetchLatestBlockhash                       (Solana RPC)
//   2. buildTreasuryTransferTx                    (pure, already tested)
//   3. tx.sign([signerKeypair])                   (in-memory)
//   4. sendRawTransaction                         (Solana RPC)
//   5. markSubmitted(payment, txSignature)        (pure, already tested)
//
// Until the agent-treasury Anchor program (plan A2) ships, the "treasury"
// is just a regular wallet whose keypair is held server-side. The signer's
// pubkey must equal the recorded treasuryAddress — this orchestrator
// validates that up front so we don't accidentally drain the wrong wallet.

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
  const rpcCalls: Uint8Array[] = [];
  return {
    signer,
    rpcCalls,
    deps: {
      signerKeypair: signer,
      fetchLatestBlockhash: async () => ({
        blockhash: VALID_BLOCKHASH,
        lastValidBlockHeight: 1234,
      }),
      sendRawTransaction: async (raw: Uint8Array) => {
        rpcCalls.push(raw);
        return "submit_sig_xyz";
      },
    },
  };
}

// ============================================
// Happy path
// ============================================

test("submitTreasuryPayment fetches blockhash, builds, signs, submits, and returns markSubmitted patch", async () => {
  setupEnv();
  const { submitTreasuryPayment } = await import(
    "../services/submitTreasuryPayment.js"
  );
  const { signer, rpcCalls, deps } = happyDeps();

  const result = await submitTreasuryPayment(
    {
      payment: basePayment(),
      treasuryAddress: signer.publicKey.toBase58(),
      recipientAddress: NOSANA_HOST,
      amountLamports: 4_500_000n,
    },
    deps,
  );

  assert.equal(result.payment.status, "SUBMITTED");
  assert.equal(result.payment.txSignature, "submit_sig_xyz");
  assert.equal(result.txSignature, "submit_sig_xyz");

  // The submitted tx is signed.
  assert.equal(rpcCalls.length, 1);
  const submitted = VersionedTransaction.deserialize(rpcCalls[0]!);
  assert.ok(submitted.signatures[0]!.some((b) => b !== 0));
});

test("submitTreasuryPayment calls fetchLatestBlockhash exactly once", async () => {
  const { submitTreasuryPayment } = await import(
    "../services/submitTreasuryPayment.js"
  );
  const { signer } = happyDeps();
  let blockhashCalls = 0;
  await submitTreasuryPayment(
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
      sendRawTransaction: async () => "x",
    },
  );
  assert.equal(blockhashCalls, 1);
});

// ============================================
// Validation
// ============================================

test("submitTreasuryPayment throws when signerKeypair pubkey doesn't match treasuryAddress", async () => {
  const { submitTreasuryPayment } = await import(
    "../services/submitTreasuryPayment.js"
  );
  const { deps } = happyDeps();
  const wrongTreasury = Keypair.generate().publicKey.toBase58();

  await assert.rejects(
    () =>
      submitTreasuryPayment(
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

test("submitTreasuryPayment throws when payment is not PENDING (don't double-submit)", async () => {
  const { submitTreasuryPayment } = await import(
    "../services/submitTreasuryPayment.js"
  );
  const { signer, deps } = happyDeps();

  for (const status of ["SUBMITTED", "CONFIRMED", "FAILED"] as const) {
    await assert.rejects(
      () =>
        submitTreasuryPayment(
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

test("submitTreasuryPayment rejects zero amounts (caught by tx builder)", async () => {
  const { submitTreasuryPayment } = await import(
    "../services/submitTreasuryPayment.js"
  );
  const { signer, deps } = happyDeps();
  await assert.rejects(
    () =>
      submitTreasuryPayment(
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

test("submitTreasuryPayment surfaces blockhash fetch failure with a labeled error", async () => {
  const { submitTreasuryPayment } = await import(
    "../services/submitTreasuryPayment.js"
  );
  const { signer } = happyDeps();
  await assert.rejects(
    () =>
      submitTreasuryPayment(
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
          sendRawTransaction: async () => "x",
        },
      ),
    /blockhash_unavailable.*rpc unreachable/,
  );
});

test("submitTreasuryPayment surfaces RPC submission failure with a labeled error", async () => {
  const { submitTreasuryPayment } = await import(
    "../services/submitTreasuryPayment.js"
  );
  const { signer } = happyDeps();
  await assert.rejects(
    () =>
      submitTreasuryPayment(
        {
          payment: basePayment(),
          treasuryAddress: signer.publicKey.toBase58(),
          recipientAddress: NOSANA_HOST,
          amountLamports: 1000n,
        },
        {
          signerKeypair: signer,
          fetchLatestBlockhash: async () => ({
            blockhash: VALID_BLOCKHASH,
            lastValidBlockHeight: 1,
          }),
          sendRawTransaction: async () => {
            throw new Error("blockhash expired");
          },
        },
      ),
    /rpc_submit.*blockhash expired/,
  );
});
