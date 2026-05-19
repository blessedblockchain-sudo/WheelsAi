import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/reputationAttestationSign.ts — the off-chain
// signing + verification half of A4. Together with reputationAttestation.ts
// (the canonical builder) this gives us the full lifecycle:
//
//   compute → buildReputationAttestation → signAttestation → store on-chain
//                                                                      ↓
//   read on-chain payload + signature → verifyAttestationSignature → boolean
//
// Pure functions, no IO. The eventual on-chain submitter wraps these.
//
// Verify must NEVER throw on hostile input — return false. A verifier that
// throws on bad signatures becomes a DoS vector.

const PERIOD_START = new Date("2026-04-26T12:00:00Z");
const PERIOD_END = new Date("2026-04-27T12:00:00Z");
const ISSUED_AT = PERIOD_END;

function happyInput(attester: Keypair, overrides: Partial<any> = {}) {
  return {
    agentId: "agent_1",
    agentSlug: "eliza",
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    uptimeSeconds: 86_400,
    totalRequestCount: 1234,
    errorCount: 7,
    reputationScore: 67,
    attesterPubkey: attester.publicKey.toBase58(),
    issuedAt: ISSUED_AT,
    ...overrides,
  };
}

// ============================================
// signAttestation — basics
// ============================================

test("signAttestation returns 64-byte signature + base58 encoding of those bytes", async () => {
  setupEnv();
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const { signAttestation } = await import(
    "../services/reputationAttestationSign.js"
  );
  const attester = Keypair.generate();
  const { messageBytes } = buildReputationAttestation(happyInput(attester));

  const sig = signAttestation({
    messageBytes,
    signerKeypair: attester,
  });

  assert.equal(sig.signatureBytes.length, 64);
  assert.equal(typeof sig.signatureBase58, "string");
  assert.ok(sig.signatureBase58.length > 0);
});

test("signAttestation is deterministic: same message + key → identical signature (ed25519 property)", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const { signAttestation } = await import(
    "../services/reputationAttestationSign.js"
  );
  const attester = Keypair.generate();
  const { messageBytes } = buildReputationAttestation(happyInput(attester));

  const a = signAttestation({ messageBytes, signerKeypair: attester });
  const b = signAttestation({ messageBytes, signerKeypair: attester });
  assert.deepEqual(Array.from(a.signatureBytes), Array.from(b.signatureBytes));
  assert.equal(a.signatureBase58, b.signatureBase58);
});

// ============================================
// verifyAttestationSignature — happy + hostile
// ============================================

test("verifyAttestationSignature accepts a freshly-signed attestation (round trip)", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const { signAttestation, verifyAttestationSignature } = await import(
    "../services/reputationAttestationSign.js"
  );
  const attester = Keypair.generate();
  const { messageBytes } = buildReputationAttestation(happyInput(attester));
  const { signatureBase58 } = signAttestation({
    messageBytes,
    signerKeypair: attester,
  });

  const ok = verifyAttestationSignature({
    messageBytes,
    signatureBase58,
    attesterPubkey: attester.publicKey.toBase58(),
  });
  assert.equal(ok, true);
});

test("verifyAttestationSignature rejects a tampered messageBytes", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const { signAttestation, verifyAttestationSignature } = await import(
    "../services/reputationAttestationSign.js"
  );
  const attester = Keypair.generate();
  const { messageBytes } = buildReputationAttestation(happyInput(attester));
  const { signatureBase58 } = signAttestation({
    messageBytes,
    signerKeypair: attester,
  });

  // Flip a single byte.
  const tampered = new Uint8Array(messageBytes);
  tampered[10] = tampered[10]! ^ 0xff;

  const ok = verifyAttestationSignature({
    messageBytes: tampered,
    signatureBase58,
    attesterPubkey: attester.publicKey.toBase58(),
  });
  assert.equal(ok, false);
});

test("verifyAttestationSignature rejects a different attester pubkey", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const { signAttestation, verifyAttestationSignature } = await import(
    "../services/reputationAttestationSign.js"
  );
  const attester = Keypair.generate();
  const impostor = Keypair.generate();
  const { messageBytes } = buildReputationAttestation(happyInput(attester));
  const { signatureBase58 } = signAttestation({
    messageBytes,
    signerKeypair: attester,
  });

  const ok = verifyAttestationSignature({
    messageBytes,
    signatureBase58,
    attesterPubkey: impostor.publicKey.toBase58(),
  });
  assert.equal(ok, false);
});

test("verifyAttestationSignature returns false on a base58 signature of the wrong length (no throw)", async () => {
  const { verifyAttestationSignature } = await import(
    "../services/reputationAttestationSign.js"
  );
  const attester = Keypair.generate();
  const ok = verifyAttestationSignature({
    messageBytes: new TextEncoder().encode("anything"),
    signatureBase58: "abc", // way too short
    attesterPubkey: attester.publicKey.toBase58(),
  });
  assert.equal(ok, false);
});

test("verifyAttestationSignature returns false on garbage non-base58 signature (no throw)", async () => {
  const { verifyAttestationSignature } = await import(
    "../services/reputationAttestationSign.js"
  );
  const attester = Keypair.generate();
  const ok = verifyAttestationSignature({
    messageBytes: new TextEncoder().encode("anything"),
    signatureBase58: "!!! not base58 !!!",
    attesterPubkey: attester.publicKey.toBase58(),
  });
  assert.equal(ok, false);
});

test("verifyAttestationSignature returns false on a malformed pubkey (no throw)", async () => {
  const { verifyAttestationSignature } = await import(
    "../services/reputationAttestationSign.js"
  );
  const ok = verifyAttestationSignature({
    messageBytes: new TextEncoder().encode("anything"),
    signatureBase58: "1".repeat(88),
    attesterPubkey: "not-a-pubkey",
  });
  assert.equal(ok, false);
});

// ============================================
// payloadToCanonicalBytes — verify side
// ============================================

test("payloadToCanonicalBytes reproduces buildReputationAttestation.messageBytes byte-for-byte", async () => {
  // The verifier reads an on-chain payload (already-validated by the issuer)
  // and must produce the same bytes the issuer signed. The two helpers
  // *must* agree.
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const { payloadToCanonicalBytes } = await import(
    "../services/reputationAttestationSign.js"
  );
  const attester = Keypair.generate();
  const { payload, messageBytes } = buildReputationAttestation(
    happyInput(attester),
  );
  const recomputed = payloadToCanonicalBytes(payload);
  assert.deepEqual(Array.from(recomputed), Array.from(messageBytes));
});

test("payloadToCanonicalBytes is deterministic regardless of input field order", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const { payloadToCanonicalBytes } = await import(
    "../services/reputationAttestationSign.js"
  );
  const attester = Keypair.generate();
  const { payload } = buildReputationAttestation(happyInput(attester));

  // Caller hands us payload fields in a different order.
  const reorderedPayload = {
    uptimeSeconds: payload.uptimeSeconds,
    totalRequestCount: payload.totalRequestCount,
    schema: payload.schema,
    reputationScore: payload.reputationScore,
    periodStart: payload.periodStart,
    periodEnd: payload.periodEnd,
    issuedAt: payload.issuedAt,
    errorCount: payload.errorCount,
    attester: payload.attester,
    agentSlug: payload.agentSlug,
    agentId: payload.agentId,
  };

  const a = payloadToCanonicalBytes(payload);
  const b = payloadToCanonicalBytes(reorderedPayload);
  assert.deepEqual(Array.from(a), Array.from(b));
});

// ============================================
// End-to-end: verify-from-payload (the on-chain reader's path)
// ============================================

test("end-to-end: build → sign → verify FROM PAYLOAD (the on-chain reader path) succeeds", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const {
    signAttestation,
    verifyAttestationSignature,
    payloadToCanonicalBytes,
  } = await import("../services/reputationAttestationSign.js");

  const attester = Keypair.generate();
  const { payload, messageBytes } = buildReputationAttestation(
    happyInput(attester),
  );
  const { signatureBase58 } = signAttestation({
    messageBytes,
    signerKeypair: attester,
  });

  // The verifier ONLY sees the payload + signature (e.g. read from chain).
  // It must recompute the messageBytes and verify.
  const verifierBytes = payloadToCanonicalBytes(payload);
  const ok = verifyAttestationSignature({
    messageBytes: verifierBytes,
    signatureBase58,
    attesterPubkey: payload.attester,
  });
  assert.equal(ok, true);
});

test("end-to-end: tampering with payload.reputationScore after signing breaks verification", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const {
    signAttestation,
    verifyAttestationSignature,
    payloadToCanonicalBytes,
  } = await import("../services/reputationAttestationSign.js");

  const attester = Keypair.generate();
  const { payload, messageBytes } = buildReputationAttestation(
    happyInput(attester),
  );
  const { signatureBase58 } = signAttestation({
    messageBytes,
    signerKeypair: attester,
  });

  // Forge: bump the reputation score after the signer signed. Verify must catch it.
  const forged = { ...payload, reputationScore: 99 };
  const verifierBytes = payloadToCanonicalBytes(forged);
  const ok = verifyAttestationSignature({
    messageBytes: verifierBytes,
    signatureBase58,
    attesterPubkey: forged.attester,
  });
  assert.equal(ok, false);
});
