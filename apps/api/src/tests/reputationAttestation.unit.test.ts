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

// Drives apps/api/src/services/reputationAttestation.ts — A4 first piece.
//
// Every N hours the platform publishes an on-chain attestation stating
// "agent X had Y uptime and Z requests in the period [start, end] and
// holds reputation score R, signed by attester A". The token launchpad
// (and the public transparency page) read these instead of trusting the
// platform's local DB score.
//
// This module is the PURE construction half:
//
//   buildReputationAttestation(...)
//     → { payload, messageBytes }
//
// `messageBytes` is what the attester signs and what the verifier
// recomputes from the on-chain payload. JSON canonicalization (sorted
// keys, UTF-8) guarantees both sides produce identical bytes.
//
// The submit-on-chain side is a separate slice; this one is unit-testable
// with no Solana, no fetch, no IO.

const NOW = new Date("2026-04-27T12:00:00Z");
const PERIOD_START = new Date("2026-04-26T12:00:00Z");
const PERIOD_END = NOW;

function happyInput(overrides: Partial<any> = {}) {
  return {
    agentId: "agent_1",
    agentSlug: "eliza",
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    uptimeSeconds: 86_400,
    totalRequestCount: 1234,
    errorCount: 7,
    reputationScore: 67,
    attesterPubkey: "11111111111111111111111111111111",
    issuedAt: NOW,
    ...overrides,
  };
}

// ============================================
// Happy path
// ============================================

test("buildReputationAttestation produces a payload with every required field", async () => {
  setupEnv();
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const { payload } = buildReputationAttestation(happyInput());
  assert.equal(payload.schema, "wheelsai.attestation.v1");
  assert.equal(payload.agentId, "agent_1");
  assert.equal(payload.agentSlug, "eliza");
  assert.equal(payload.periodStart, PERIOD_START.toISOString());
  assert.equal(payload.periodEnd, PERIOD_END.toISOString());
  assert.equal(payload.uptimeSeconds, 86_400);
  assert.equal(payload.totalRequestCount, 1234);
  assert.equal(payload.errorCount, 7);
  assert.equal(payload.reputationScore, 67);
  assert.equal(payload.attester, "11111111111111111111111111111111");
  assert.equal(payload.issuedAt, NOW.toISOString());
});

// ============================================
// Canonicalization
// ============================================

test("buildReputationAttestation messageBytes are deterministic across calls (canonical JSON)", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const { messageBytes: a } = buildReputationAttestation(happyInput());
  const { messageBytes: b } = buildReputationAttestation(happyInput());
  assert.deepEqual(Array.from(a), Array.from(b));
});

test("buildReputationAttestation produces JSON with sorted keys (verifier reproducibility)", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const { messageBytes } = buildReputationAttestation(happyInput());
  const decoded = new TextDecoder().decode(messageBytes);
  // Reading raw bytes — keys must appear in alphabetical order.
  const keyOrder = decoded
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((kv) => kv.split(":")[0]!.replace(/^"|"$/g, ""));
  const sorted = [...keyOrder].sort();
  assert.deepEqual(keyOrder, sorted);
});

test("buildReputationAttestation messageBytes round-trip through JSON.parse to the payload", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const { payload, messageBytes } = buildReputationAttestation(happyInput());
  const decoded = new TextDecoder().decode(messageBytes);
  const reparsed = JSON.parse(decoded);
  assert.deepEqual(reparsed, payload);
});

test("buildReputationAttestation messageBytes are byte-identical regardless of input field order", async () => {
  // Two invocations with the same logical input but different key order
  // in the input object should produce identical messageBytes — that's
  // what canonicalization is for.
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const a = buildReputationAttestation(happyInput());
  const b = buildReputationAttestation({
    issuedAt: NOW,
    attesterPubkey: "11111111111111111111111111111111",
    reputationScore: 67,
    errorCount: 7,
    totalRequestCount: 1234,
    uptimeSeconds: 86_400,
    periodEnd: PERIOD_END,
    periodStart: PERIOD_START,
    agentSlug: "eliza",
    agentId: "agent_1",
  });
  assert.deepEqual(Array.from(a.messageBytes), Array.from(b.messageBytes));
});

// ============================================
// Validation
// ============================================

test("buildReputationAttestation throws on negative uptime / requestCount / errorCount", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  assert.throws(
    () => buildReputationAttestation(happyInput({ uptimeSeconds: -1 })),
    /uptimeSeconds/i,
  );
  assert.throws(
    () => buildReputationAttestation(happyInput({ totalRequestCount: -1 })),
    /totalRequestCount/i,
  );
  assert.throws(
    () => buildReputationAttestation(happyInput({ errorCount: -1 })),
    /errorCount/i,
  );
});

test("buildReputationAttestation throws when periodEnd <= periodStart", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  assert.throws(
    () =>
      buildReputationAttestation(
        happyInput({ periodEnd: PERIOD_START }), // equal → invalid
      ),
    /period/i,
  );
  assert.throws(
    () =>
      buildReputationAttestation(
        happyInput({
          periodStart: PERIOD_END,
          periodEnd: PERIOD_START,
        }),
      ),
    /period/i,
  );
});

test("buildReputationAttestation requires reputationScore in [0, 100]", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  for (const score of [-0.01, 100.01, 1000]) {
    assert.throws(
      () => buildReputationAttestation(happyInput({ reputationScore: score })),
      /reputationScore/i,
      `should reject score=${score}`,
    );
  }
});

test("buildReputationAttestation accepts the boundary reputationScore values 0 and 100", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  for (const score of [0, 100]) {
    const { payload } = buildReputationAttestation(
      happyInput({ reputationScore: score }),
    );
    assert.equal(payload.reputationScore, score);
  }
});

test("buildReputationAttestation throws when attesterPubkey is not valid base58 (Solana pubkey)", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  assert.throws(
    () =>
      buildReputationAttestation(
        happyInput({ attesterPubkey: "not-base58-not-32-bytes!" }),
      ),
    /attester/i,
  );
});

test("buildReputationAttestation accepts a real Solana pubkey", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const kp = Keypair.generate();
  const { payload } = buildReputationAttestation(
    happyInput({ attesterPubkey: kp.publicKey.toBase58() }),
  );
  assert.equal(payload.attester, kp.publicKey.toBase58());
});

test("buildReputationAttestation rejects empty agentId / agentSlug", async () => {
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  assert.throws(
    () => buildReputationAttestation(happyInput({ agentId: "" })),
    /agentId/i,
  );
  assert.throws(
    () => buildReputationAttestation(happyInput({ agentSlug: "" })),
    /agentSlug/i,
  );
});
