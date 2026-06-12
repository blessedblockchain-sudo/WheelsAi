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
// Claim-first machine (remediation D3/D5):
//
//   PENDING ──claim──> SUBMITTING ──broadcast──> SUBMITTED ──confirm──> CONFIRMED (terminal)
//      │                   │                         └────fail────────> FAILED    (terminal)
//      │                   └──safe-expiry recovery──> PENDING
//      ├───────fail──────────────────────────────────> FAILED   (terminal)
//      └───────park (resolution attempts exhausted)──> PARKED   (terminal until operator)
//
// Illegal transitions throw — caller is buggy if it ever calls them.

type Status =
  | "PENDING"
  | "SUBMITTING"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED"
  | "PARKED";

interface FakePayment {
  id: string;
  status: Status;
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
// markClaimed
// ============================================

test("markClaimed moves PENDING → SUBMITTING and stamps the (pre-broadcast) tx signature", async () => {
  setupEnv();
  const { markClaimed } = await import("../services/computePaymentLifecycle.js");
  const next = markClaimed(p(), "sig_claimed");
  assert.equal(next.status, "SUBMITTING");
  assert.equal(next.txSignature, "sig_claimed");
  // Other fields unchanged.
  assert.equal(next.id, "cp_1");
  assert.equal(next.errorMessage, null);
});

test("markClaimed throws on a non-PENDING payment", async () => {
  const { markClaimed } = await import("../services/computePaymentLifecycle.js");
  for (const status of [
    "SUBMITTING",
    "SUBMITTED",
    "CONFIRMED",
    "FAILED",
    "PARKED",
  ] as const) {
    assert.throws(
      () => markClaimed(p({ status }), "sig"),
      /illegal transition/i,
      `markClaimed(${status}) should throw`,
    );
  }
});

test("markClaimed requires a non-empty signature", async () => {
  const { markClaimed } = await import("../services/computePaymentLifecycle.js");
  assert.throws(() => markClaimed(p(), ""), /signature/i);
});

// ============================================
// markSubmitted
// ============================================

test("markSubmitted moves SUBMITTING → SUBMITTED and stamps the tx signature", async () => {
  setupEnv();
  const { markSubmitted } = await import("../services/computePaymentLifecycle.js");
  const next = markSubmitted(
    p({ status: "SUBMITTING", txSignature: "sig_123" }),
    "sig_123",
  );
  assert.equal(next.status, "SUBMITTED");
  assert.equal(next.txSignature, "sig_123");
  // Other fields unchanged.
  assert.equal(next.id, "cp_1");
  assert.equal(next.errorMessage, null);
});

test("markSubmitted throws on a non-SUBMITTING payment (claim must come first)", async () => {
  const { markSubmitted } = await import("../services/computePaymentLifecycle.js");
  for (const status of [
    "PENDING",
    "SUBMITTED",
    "CONFIRMED",
    "FAILED",
    "PARKED",
  ] as const) {
    assert.throws(
      () => markSubmitted(p({ status }), "sig"),
      /illegal transition/i,
      `markSubmitted(${status}) should throw`,
    );
  }
});

test("markSubmitted requires a non-empty signature", async () => {
  const { markSubmitted } = await import("../services/computePaymentLifecycle.js");
  assert.throws(
    () => markSubmitted(p({ status: "SUBMITTING" }), ""),
    /signature/i,
  );
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

test("markConfirmed throws on PENDING and SUBMITTING (you must broadcast first)", async () => {
  const { markConfirmed } = await import("../services/computePaymentLifecycle.js");
  for (const status of ["PENDING", "SUBMITTING"] as const) {
    assert.throws(
      () => markConfirmed(p({ status }), new Date()),
      /illegal transition/i,
    );
  }
});

test("markConfirmed throws on terminal states", async () => {
  const { markConfirmed } = await import("../services/computePaymentLifecycle.js");
  for (const status of ["CONFIRMED", "FAILED", "PARKED"] as const) {
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

test("markFailed refuses to fail a SUBMITTING payment (its bytes may be on-chain; recovery owns it)", async () => {
  const { markFailed } = await import("../services/computePaymentLifecycle.js");
  assert.throws(
    () =>
      markFailed(p({ status: "SUBMITTING", txSignature: "sig" }), "whoops"),
    /illegal transition/i,
  );
});

test("markFailed refuses to fail a PARKED payment (operator-owned)", async () => {
  const { markFailed } = await import("../services/computePaymentLifecycle.js");
  assert.throws(
    () => markFailed(p({ status: "PARKED" }), "whoops"),
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
// markParked
// ============================================

test("markParked moves PENDING → PARKED with the error message", async () => {
  const { markParked } = await import("../services/computePaymentLifecycle.js");
  const next = markParked(p(), "Nosana job not found: job_zzz");
  assert.equal(next.status, "PARKED");
  assert.equal(next.errorMessage, "Nosana job not found: job_zzz");
});

test("markParked throws on a non-PENDING payment", async () => {
  const { markParked } = await import("../services/computePaymentLifecycle.js");
  for (const status of [
    "SUBMITTING",
    "SUBMITTED",
    "CONFIRMED",
    "FAILED",
    "PARKED",
  ] as const) {
    assert.throws(
      () => markParked(p({ status }), "x"),
      /illegal transition/i,
      `markParked(${status}) should throw`,
    );
  }
});

// ============================================
// isTerminal
// ============================================

test("isTerminal classifies all six statuses", async () => {
  const { isTerminal } = await import("../services/computePaymentLifecycle.js");
  assert.equal(isTerminal("PENDING"), false);
  assert.equal(isTerminal("SUBMITTING"), false);
  assert.equal(isTerminal("SUBMITTED"), false);
  assert.equal(isTerminal("CONFIRMED"), true);
  assert.equal(isTerminal("FAILED"), true);
  assert.equal(isTerminal("PARKED"), true);
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

test("shouldRetry returns false for SUBMITTING (claimed; the recovery scan owns it)", async () => {
  const { shouldRetry } = await import("../services/computePaymentLifecycle.js");
  assert.equal(shouldRetry(p({ status: "SUBMITTING", retryCount: 0 }), 5), false);
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

test("shouldRetry returns false for PARKED (operator must re-PENDING explicitly)", async () => {
  const { shouldRetry } = await import("../services/computePaymentLifecycle.js");
  assert.equal(shouldRetry(p({ status: "PARKED", retryCount: 0 }), 5), false);
});
