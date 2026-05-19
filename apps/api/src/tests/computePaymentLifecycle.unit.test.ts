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

// Drives apps/api/src/services/computePaymentLifecycle.ts — pure transition
// functions for the ComputePayment status enum. The Solana submission worker
// (the side-effect layer) calls these to compute the next-state patch it
// writes back to Postgres; the lifecycle module never touches Prisma or RPC.
//
//   PENDING ──submit──> SUBMITTED ──confirm──> CONFIRMED  (terminal)
//      └──────────────────────────────────────> FAILED     (terminal)
//                          └─────────────────> FAILED     (terminal)
//
// Illegal transitions throw — caller is buggy if it ever calls them.

interface FakePayment {
  id: string;
  status: "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  txSignature: string | null;
  errorMessage: string | null;
  paidAt: Date | null;
  retryCount: number;
}

function p(overrides: Partial<FakePayment> = {}): FakePayment {
  return {
    id: "cp_1",
    status: "PENDING",
    txSignature: null,
    errorMessage: null,
    paidAt: null,
    retryCount: 0,
    ...overrides,
  };
}

// ============================================
// markSubmitted
// ============================================

test("markSubmitted moves PENDING → SUBMITTED and stamps the tx signature", async () => {
  setupEnv();
  const { markSubmitted } = await import("../services/computePaymentLifecycle.js");
  const next = markSubmitted(p(), "sig_123");
  assert.equal(next.status, "SUBMITTED");
  assert.equal(next.txSignature, "sig_123");
  // Other fields unchanged.
  assert.equal(next.id, "cp_1");
  assert.equal(next.errorMessage, null);
});

test("markSubmitted throws on a non-PENDING payment", async () => {
  const { markSubmitted } = await import("../services/computePaymentLifecycle.js");
  for (const status of ["SUBMITTED", "CONFIRMED", "FAILED"] as const) {
    assert.throws(
      () => markSubmitted(p({ status }), "sig"),
      /illegal transition/i,
      `markSubmitted(${status}) should throw`,
    );
  }
});

test("markSubmitted requires a non-empty signature", async () => {
  const { markSubmitted } = await import("../services/computePaymentLifecycle.js");
  assert.throws(() => markSubmitted(p(), ""), /signature/i);
});

// ============================================
// markConfirmed
// ============================================

test("markConfirmed moves SUBMITTED → CONFIRMED and stamps paidAt", async () => {
  const { markConfirmed } = await import("../services/computePaymentLifecycle.js");
  const at = new Date("2026-04-26T12:34:56Z");
  const next = markConfirmed(p({ status: "SUBMITTED", txSignature: "sig" }), at);
  assert.equal(next.status, "CONFIRMED");
  assert.equal(next.paidAt!.toISOString(), at.toISOString());
});

test("markConfirmed throws on PENDING (you must submit first)", async () => {
  const { markConfirmed } = await import("../services/computePaymentLifecycle.js");
  assert.throws(
    () => markConfirmed(p({ status: "PENDING" }), new Date()),
    /illegal transition/i,
  );
});

test("markConfirmed throws on terminal states", async () => {
  const { markConfirmed } = await import("../services/computePaymentLifecycle.js");
  for (const status of ["CONFIRMED", "FAILED"] as const) {
    assert.throws(
      () => markConfirmed(p({ status }), new Date()),
      /illegal transition/i,
    );
  }
});

// ============================================
// markFailed
// ============================================

test("markFailed moves PENDING → FAILED with the error message", async () => {
  const { markFailed } = await import("../services/computePaymentLifecycle.js");
  const next = markFailed(p(), "rpc_timeout");
  assert.equal(next.status, "FAILED");
  assert.equal(next.errorMessage, "rpc_timeout");
});

test("markFailed moves SUBMITTED → FAILED (e.g. tx never confirmed)", async () => {
  const { markFailed } = await import("../services/computePaymentLifecycle.js");
  const next = markFailed(
    p({ status: "SUBMITTED", txSignature: "sig" }),
    "blockhash_expired",
  );
  assert.equal(next.status, "FAILED");
  assert.equal(next.errorMessage, "blockhash_expired");
  // Preserve the signature for forensics.
  assert.equal(next.txSignature, "sig");
});

test("markFailed refuses to overwrite a CONFIRMED payment", async () => {
  const { markFailed } = await import("../services/computePaymentLifecycle.js");
  assert.throws(
    () =>
      markFailed(
        p({ status: "CONFIRMED", paidAt: new Date(), txSignature: "sig" }),
        "late_failure",
      ),
    /illegal transition/i,
  );
});

test("markFailed is idempotent on an already-FAILED payment but can update the error", async () => {
  const { markFailed } = await import("../services/computePaymentLifecycle.js");
  const next = markFailed(
    p({ status: "FAILED", errorMessage: "first" }),
    "second",
  );
  assert.equal(next.status, "FAILED");
  assert.equal(next.errorMessage, "second");
});

// ============================================
// isTerminal
// ============================================

test("isTerminal classifies the four statuses", async () => {
  const { isTerminal } = await import("../services/computePaymentLifecycle.js");
  assert.equal(isTerminal("PENDING"), false);
  assert.equal(isTerminal("SUBMITTED"), false);
  assert.equal(isTerminal("CONFIRMED"), true);
  assert.equal(isTerminal("FAILED"), true);
});

// ============================================
// shouldRetry
// ============================================

test("shouldRetry returns true for PENDING below the retry cap", async () => {
  const { shouldRetry } = await import("../services/computePaymentLifecycle.js");
  assert.equal(shouldRetry(p({ status: "PENDING", retryCount: 0 }), 5), true);
  assert.equal(shouldRetry(p({ status: "PENDING", retryCount: 4 }), 5), true);
});

test("shouldRetry returns false for PENDING at or above the retry cap", async () => {
  const { shouldRetry } = await import("../services/computePaymentLifecycle.js");
  assert.equal(shouldRetry(p({ status: "PENDING", retryCount: 5 }), 5), false);
  assert.equal(shouldRetry(p({ status: "PENDING", retryCount: 99 }), 5), false);
});

test("shouldRetry returns false for SUBMITTED (already in flight; the confirm poller owns it)", async () => {
  const { shouldRetry } = await import("../services/computePaymentLifecycle.js");
  assert.equal(shouldRetry(p({ status: "SUBMITTED", retryCount: 0 }), 5), false);
});

test("shouldRetry returns true for FAILED below the retry cap", async () => {
  const { shouldRetry } = await import("../services/computePaymentLifecycle.js");
  assert.equal(shouldRetry(p({ status: "FAILED", retryCount: 1 }), 5), true);
});

test("shouldRetry returns false for FAILED at or above the retry cap (poison)", async () => {
  const { shouldRetry } = await import("../services/computePaymentLifecycle.js");
  assert.equal(shouldRetry(p({ status: "FAILED", retryCount: 5 }), 5), false);
});

test("shouldRetry returns false for CONFIRMED (terminal success)", async () => {
  const { shouldRetry } = await import("../services/computePaymentLifecycle.js");
  assert.equal(shouldRetry(p({ status: "CONFIRMED", retryCount: 0 }), 5), false);
});
