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

// 32+ chars; service rejects shorter. Hex chars are arbitrary — just a stable
// secret for the unit tests.
const MASTER_KEY_A =
  "0000000000000000000000000000000000000000000000000000000000000001";
const MASTER_KEY_B =
  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

test("deriveTreasuryKeypair: same (masterKey, treasuryId) → same Keypair", async () => {
  setupEnv();
  const { deriveTreasuryKeypair } = await import(
    "../services/treasuryKeypairs.js"
  );

  const kp1 = deriveTreasuryKeypair({
    masterKey: MASTER_KEY_A,
    treasuryId: "treasury-abc-123",
  });
  const kp2 = deriveTreasuryKeypair({
    masterKey: MASTER_KEY_A,
    treasuryId: "treasury-abc-123",
  });

  assert.equal(
    kp1.publicKey.toBase58(),
    kp2.publicKey.toBase58(),
    "derivation must be deterministic",
  );
  assert.deepEqual(
    Array.from(kp1.secretKey),
    Array.from(kp2.secretKey),
    "secret key must be deterministic",
  );
});

test("deriveTreasuryKeypair: different treasuryIds → different Keypairs", async () => {
  setupEnv();
  const { deriveTreasuryKeypair } = await import(
    "../services/treasuryKeypairs.js"
  );

  const kpA = deriveTreasuryKeypair({
    masterKey: MASTER_KEY_A,
    treasuryId: "treasury-aaa",
  });
  const kpB = deriveTreasuryKeypair({
    masterKey: MASTER_KEY_A,
    treasuryId: "treasury-bbb",
  });

  assert.notEqual(
    kpA.publicKey.toBase58(),
    kpB.publicKey.toBase58(),
    "different treasuries MUST not collide",
  );
});

test("deriveTreasuryKeypair: different masterKeys → different Keypairs for same treasury", async () => {
  setupEnv();
  const { deriveTreasuryKeypair } = await import(
    "../services/treasuryKeypairs.js"
  );

  const kpA = deriveTreasuryKeypair({
    masterKey: MASTER_KEY_A,
    treasuryId: "treasury-x",
  });
  const kpB = deriveTreasuryKeypair({
    masterKey: MASTER_KEY_B,
    treasuryId: "treasury-x",
  });

  assert.notEqual(kpA.publicKey.toBase58(), kpB.publicKey.toBase58());
});

test("deriveTreasuryKeypair: produces a Keypair that signs (round-trip)", async () => {
  setupEnv();
  const { deriveTreasuryKeypair } = await import(
    "../services/treasuryKeypairs.js"
  );

  const kp = deriveTreasuryKeypair({
    masterKey: MASTER_KEY_A,
    treasuryId: "treasury-sign-check",
  });

  // Round-trip via fromSecretKey to confirm the secret key is valid Ed25519.
  const reconstructed = Keypair.fromSecretKey(kp.secretKey);
  assert.equal(
    reconstructed.publicKey.toBase58(),
    kp.publicKey.toBase58(),
    "Keypair.fromSecretKey must accept the derived secret",
  );
  // Public key must be on the Ed25519 curve (not a PDA-style off-curve key).
  assert.equal(
    PublicKey.isOnCurve(kp.publicKey.toBytes()),
    true,
    "treasury signer must be a real keypair (on curve)",
  );
});

test("deriveTreasuryKeypair: rejects empty masterKey", async () => {
  setupEnv();
  const { deriveTreasuryKeypair } = await import(
    "../services/treasuryKeypairs.js"
  );

  assert.throws(
    () =>
      deriveTreasuryKeypair({
        masterKey: "",
        treasuryId: "treasury-x",
      }),
    /master.*key.*required|empty/i,
  );
});

test("deriveTreasuryKeypair: rejects too-short masterKey (security floor)", async () => {
  setupEnv();
  const { deriveTreasuryKeypair } = await import(
    "../services/treasuryKeypairs.js"
  );

  assert.throws(
    () =>
      deriveTreasuryKeypair({
        masterKey: "short", // < 32 chars
        treasuryId: "treasury-x",
      }),
    /at least 32/i,
  );
});

test("deriveTreasuryKeypair: rejects empty treasuryId", async () => {
  setupEnv();
  const { deriveTreasuryKeypair } = await import(
    "../services/treasuryKeypairs.js"
  );

  assert.throws(
    () =>
      deriveTreasuryKeypair({
        masterKey: MASTER_KEY_A,
        treasuryId: "",
      }),
    /treasuryId.*required|empty/i,
  );
});

// ----------------------------------------------------------------------
// makeTreasurySignerProvider — synchronous factory that the BullMQ
// payment-submit shell injects as `treasurySignerFor`. Trivial wrapper —
// downstream submitTreasuryPayment is the layer that defensively checks
// signer.publicKey vs row.treasuryAddress before sending the tx, so this
// factory only owns the masterKey closure.
// ----------------------------------------------------------------------

test("makeTreasurySignerProvider: returns the derived signer for a treasuryId", async () => {
  setupEnv();
  const { deriveTreasuryKeypair, makeTreasurySignerProvider } = await import(
    "../services/treasuryKeypairs.js"
  );

  const expected = deriveTreasuryKeypair({
    masterKey: MASTER_KEY_A,
    treasuryId: "t-1",
  });

  const treasurySignerFor = makeTreasurySignerProvider({
    masterKey: MASTER_KEY_A,
  });

  const signer = treasurySignerFor("t-1");
  assert.equal(signer.publicKey.toBase58(), expected.publicKey.toBase58());
});

test("makeTreasurySignerProvider: caches per-treasury signers (no rederivation per call)", async () => {
  setupEnv();
  const { makeTreasurySignerProvider } = await import(
    "../services/treasuryKeypairs.js"
  );

  const treasurySignerFor = makeTreasurySignerProvider({
    masterKey: MASTER_KEY_A,
  });

  const a1 = treasurySignerFor("t-1");
  const a2 = treasurySignerFor("t-1");
  // Same Keypair *instance* — derivation is deterministic so we can cache
  // across the worker process lifetime.
  assert.equal(a1, a2, "must return the same Keypair object on repeat calls");
});
