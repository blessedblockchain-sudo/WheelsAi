import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/reapStuckSubmissions.ts — closes the last
// edge case in A3. A SUBMITTED ComputePayment whose txSignature was never
// seen by the RPC (e.g. blockhash already expired when we submitted, RPC
// network drop) would hang in SUBMITTED forever. The poller never invents
// a transition from silence — that's the right discipline for a poller —
// so a separate reaper is responsible for force-FAILing rows past the
// timeout.
//
// Pure function. The BullMQ worker that wraps it is a thin shell.

const NOW = new Date("2026-04-27T12:00:00Z");
const MAX_AGE_SECONDS = 5 * 60; // 5 minutes — Solana blockhash validity is ~150 slots ≈ 60s

interface ReaperPayment {
  id: string;
  status: "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  txSignature: string | null;
  errorMessage: string | null;
  paidAt: Date | null;
  retryCount: number;
  submittedAt: Date | null;
}

function p(overrides: Partial<ReaperPayment> = {}): ReaperPayment {
  return {
    id: `cp_${Math.random().toString(36).slice(2, 7)}`,
    status: "SUBMITTED",
    txSignature: "sig_x",
    errorMessage: null,
    paidAt: null,
    retryCount: 0,
    submittedAt: new Date(NOW.getTime() - 30 * 1000), // 30s ago — fresh
    ...overrides,
  };
}

// ============================================
// Within window — no changes
// ============================================

test("reapStuckSubmissions returns no changes when every SUBMITTED row is within the window", async () => {
  setupEnv();
  const { reapStuckSubmissions } = await import(
    "../services/reapStuckSubmissions.js"
  );
  const payments = [
    p({ submittedAt: new Date(NOW.getTime() - 60 * 1000) }),
    p({ submittedAt: new Date(NOW.getTime() - 4 * 60 * 1000) }),
  ];
  const results = reapStuckSubmissions({
    payments,
    maxAgeSeconds: MAX_AGE_SECONDS,
    now: NOW,
  });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.changed === false));
  assert.ok(results.every((r) => r.payment.status === "SUBMITTED"));
});

test("reapStuckSubmissions returns an empty result for an empty input", async () => {
  const { reapStuckSubmissions } = await import(
    "../services/reapStuckSubmissions.js"
  );
  const results = reapStuckSubmissions({
    payments: [],
    maxAgeSeconds: MAX_AGE_SECONDS,
    now: NOW,
  });
  assert.deepEqual(results, []);
});

// ============================================
// Beyond window — mark failed
// ============================================

test("reapStuckSubmissions force-FAILs SUBMITTED rows older than maxAgeSeconds", async () => {
  const { reapStuckSubmissions } = await import(
    "../services/reapStuckSubmissions.js"
  );
  const stuck = p({
    id: "cp_stuck",
    submittedAt: new Date(NOW.getTime() - 10 * 60 * 1000), // 10 min ago
  });
  const fresh = p({
    id: "cp_fresh",
    submittedAt: new Date(NOW.getTime() - 30 * 1000),
  });
  const results = reapStuckSubmissions({
    payments: [stuck, fresh],
    maxAgeSeconds: MAX_AGE_SECONDS,
    now: NOW,
  });

  const stuckResult = results.find((r) => r.payment.id === "cp_stuck")!;
  assert.equal(stuckResult.changed, true);
  assert.equal(stuckResult.payment.status, "FAILED");
  assert.equal(stuckResult.payment.errorMessage, "blockhash_expired");

  const freshResult = results.find((r) => r.payment.id === "cp_fresh")!;
  assert.equal(freshResult.changed, false);
  assert.equal(freshResult.payment.status, "SUBMITTED");
});

test("reapStuckSubmissions preserves the original txSignature on FAILED so it can be looked up forensically", async () => {
  const { reapStuckSubmissions } = await import(
    "../services/reapStuckSubmissions.js"
  );
  const stuck = p({
    id: "cp_stuck",
    txSignature: "sig_for_forensics",
    submittedAt: new Date(NOW.getTime() - 10 * 60 * 1000),
  });
  const [result] = reapStuckSubmissions({
    payments: [stuck],
    maxAgeSeconds: MAX_AGE_SECONDS,
    now: NOW,
  });
  assert.equal(result!.payment.status, "FAILED");
  assert.equal(result!.payment.txSignature, "sig_for_forensics");
});

// ============================================
// Boundary
// ============================================

test("reapStuckSubmissions does NOT reap a row whose age is EXACTLY maxAgeSeconds (inclusive)", async () => {
  const { reapStuckSubmissions } = await import(
    "../services/reapStuckSubmissions.js"
  );
  const exactly = p({
    submittedAt: new Date(NOW.getTime() - MAX_AGE_SECONDS * 1000),
  });
  const [result] = reapStuckSubmissions({
    payments: [exactly],
    maxAgeSeconds: MAX_AGE_SECONDS,
    now: NOW,
  });
  assert.equal(result!.changed, false);
});

test("reapStuckSubmissions reaps a row 1ms past the threshold", async () => {
  const { reapStuckSubmissions } = await import(
    "../services/reapStuckSubmissions.js"
  );
  const justOver = p({
    submittedAt: new Date(NOW.getTime() - MAX_AGE_SECONDS * 1000 - 1),
  });
  const [result] = reapStuckSubmissions({
    payments: [justOver],
    maxAgeSeconds: MAX_AGE_SECONDS,
    now: NOW,
  });
  assert.equal(result!.changed, true);
  assert.equal(result!.payment.status, "FAILED");
});

// ============================================
// State scoping
// ============================================

test("reapStuckSubmissions skips PENDING rows (haven't been submitted yet)", async () => {
  const { reapStuckSubmissions } = await import(
    "../services/reapStuckSubmissions.js"
  );
  const pending = p({
    id: "cp_pending",
    status: "PENDING",
    txSignature: null,
    submittedAt: null,
  });
  const [result] = reapStuckSubmissions({
    payments: [pending],
    maxAgeSeconds: MAX_AGE_SECONDS,
    now: NOW,
  });
  assert.equal(result!.changed, false);
  assert.equal(result!.payment.status, "PENDING");
});

test("reapStuckSubmissions skips CONFIRMED rows (terminal success)", async () => {
  const { reapStuckSubmissions } = await import(
    "../services/reapStuckSubmissions.js"
  );
  const confirmed = p({
    id: "cp_confirmed",
    status: "CONFIRMED",
    paidAt: new Date(NOW.getTime() - 10 * 60 * 1000), // long ago
    submittedAt: new Date(NOW.getTime() - 10 * 60 * 1000),
  });
  const [result] = reapStuckSubmissions({
    payments: [confirmed],
    maxAgeSeconds: MAX_AGE_SECONDS,
    now: NOW,
  });
  assert.equal(result!.changed, false);
  assert.equal(result!.payment.status, "CONFIRMED");
});

test("reapStuckSubmissions skips already-FAILED rows (terminal)", async () => {
  const { reapStuckSubmissions } = await import(
    "../services/reapStuckSubmissions.js"
  );
  const failed = p({
    id: "cp_failed",
    status: "FAILED",
    errorMessage: "previous_failure",
    submittedAt: new Date(NOW.getTime() - 10 * 60 * 1000),
  });
  const [result] = reapStuckSubmissions({
    payments: [failed],
    maxAgeSeconds: MAX_AGE_SECONDS,
    now: NOW,
  });
  assert.equal(result!.changed, false);
  // Not double-failed — original errorMessage preserved.
  assert.equal(result!.payment.errorMessage, "previous_failure");
});

// ============================================
// Defensive
// ============================================

test("reapStuckSubmissions skips SUBMITTED rows with no submittedAt (treat as recently-touched)", async () => {
  // If submittedAt is null on a SUBMITTED row, our schema is in an inconsistent
  // state. Force-FAILing it would be hostile; the right behavior is to skip
  // and surface via metrics. Tests pin the safe choice.
  const { reapStuckSubmissions } = await import(
    "../services/reapStuckSubmissions.js"
  );
  const orphan = p({ id: "cp_orphan", submittedAt: null });
  const [result] = reapStuckSubmissions({
    payments: [orphan],
    maxAgeSeconds: MAX_AGE_SECONDS,
    now: NOW,
  });
  assert.equal(result!.changed, false);
  assert.equal(result!.payment.status, "SUBMITTED");
});

test("reapStuckSubmissions throws when maxAgeSeconds is non-positive (caller bug)", async () => {
  const { reapStuckSubmissions } = await import(
    "../services/reapStuckSubmissions.js"
  );
  for (const v of [0, -1]) {
    assert.throws(
      () =>
        reapStuckSubmissions({
          payments: [],
          maxAgeSeconds: v,
          now: NOW,
        }),
      /maxAgeSeconds/i,
    );
  }
});
