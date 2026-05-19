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

// Drives apps/api/src/services/pollComputePaymentConfirmation.ts — the
// SUBMITTED → CONFIRMED|FAILED half of the auto-pay loop. Composes the
// existing markConfirmed / markFailed transitions on top of an injected
// getSignatureStatus call.
//
// Returns { payment, changed }:
//   - changed=true  → caller writes the patch via prisma.update
//   - changed=false → caller leaves the row unchanged and re-polls later
//
// The stuck-row reaper (timeout SUBMITTED rows older than N minutes) is
// a separate slice; this orchestrator never invents a state transition
// from RPC silence.

const NOW = new Date("2026-04-26T12:00:00Z");

function submittedPayment(overrides: Partial<any> = {}) {
  return {
    id: "cp_1",
    status: "SUBMITTED" as const,
    txSignature: "sig_abc",
    errorMessage: null,
    paidAt: null,
    retryCount: 0,
    ...overrides,
  };
}

function deps(opts: {
  status?: {
    confirmationStatus: "processed" | "confirmed" | "finalized" | null;
    err: unknown | null;
  } | null;
  rpcError?: Error;
}) {
  return {
    getSignatureStatus: async (_sig: string) => {
      if (opts.rpcError) throw opts.rpcError;
      return opts.status ?? null;
    },
    now: () => NOW,
  };
}

// ============================================
// Confirmation success
// ============================================

test("pollComputePaymentConfirmation transitions SUBMITTED → CONFIRMED on confirmationStatus='confirmed'", async () => {
  setupEnv();
  const { pollComputePaymentConfirmation } = await import(
    "../services/pollComputePaymentConfirmation.js"
  );
  const result = await pollComputePaymentConfirmation(
    { payment: submittedPayment() },
    deps({ status: { confirmationStatus: "confirmed", err: null } }),
  );
  assert.equal(result.changed, true);
  assert.equal(result.payment.status, "CONFIRMED");
  assert.equal(result.payment.paidAt!.toISOString(), NOW.toISOString());
});

test("pollComputePaymentConfirmation also transitions on 'finalized' (terminal-stronger confirmation)", async () => {
  const { pollComputePaymentConfirmation } = await import(
    "../services/pollComputePaymentConfirmation.js"
  );
  const result = await pollComputePaymentConfirmation(
    { payment: submittedPayment() },
    deps({ status: { confirmationStatus: "finalized", err: null } }),
  );
  assert.equal(result.changed, true);
  assert.equal(result.payment.status, "CONFIRMED");
});

// ============================================
// On-chain failure
// ============================================

test("pollComputePaymentConfirmation transitions SUBMITTED → FAILED when RPC reports err on the tx", async () => {
  const { pollComputePaymentConfirmation } = await import(
    "../services/pollComputePaymentConfirmation.js"
  );
  const result = await pollComputePaymentConfirmation(
    { payment: submittedPayment() },
    deps({
      status: {
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, "InsufficientFunds"] },
      },
    }),
  );
  assert.equal(result.changed, true);
  assert.equal(result.payment.status, "FAILED");
  // Error message preserves enough info for forensics, even if the structure
  // came from the RPC opaque object.
  assert.ok(
    typeof result.payment.errorMessage === "string" &&
      result.payment.errorMessage.length > 0,
    "errorMessage should be populated",
  );
});

// ============================================
// Still pending (no transition)
// ============================================

test("pollComputePaymentConfirmation returns changed=false when RPC returns null (tx not yet seen)", async () => {
  const { pollComputePaymentConfirmation } = await import(
    "../services/pollComputePaymentConfirmation.js"
  );
  const original = submittedPayment();
  const result = await pollComputePaymentConfirmation(
    { payment: original },
    deps({ status: null }),
  );
  assert.equal(result.changed, false);
  assert.equal(result.payment.status, "SUBMITTED");
  assert.equal(result.payment.txSignature, "sig_abc");
});

test("pollComputePaymentConfirmation returns changed=false on 'processed' (too soon to commit)", async () => {
  const { pollComputePaymentConfirmation } = await import(
    "../services/pollComputePaymentConfirmation.js"
  );
  const result = await pollComputePaymentConfirmation(
    { payment: submittedPayment() },
    deps({ status: { confirmationStatus: "processed", err: null } }),
  );
  assert.equal(result.changed, false);
  assert.equal(result.payment.status, "SUBMITTED");
});

test("pollComputePaymentConfirmation returns changed=false when confirmationStatus is null (RPC saw the sig but isn't sure yet)", async () => {
  const { pollComputePaymentConfirmation } = await import(
    "../services/pollComputePaymentConfirmation.js"
  );
  const result = await pollComputePaymentConfirmation(
    { payment: submittedPayment() },
    deps({ status: { confirmationStatus: null, err: null } }),
  );
  assert.equal(result.changed, false);
});

// ============================================
// Caller-bug guards
// ============================================

test("pollComputePaymentConfirmation throws when the payment is not SUBMITTED", async () => {
  const { pollComputePaymentConfirmation } = await import(
    "../services/pollComputePaymentConfirmation.js"
  );
  for (const status of ["PENDING", "CONFIRMED", "FAILED"] as const) {
    await assert.rejects(
      () =>
        pollComputePaymentConfirmation(
          { payment: submittedPayment({ status }) },
          deps({ status: null }),
        ),
      /not submitted|status/i,
      `should reject ${status}`,
    );
  }
});

test("pollComputePaymentConfirmation throws when the payment has no txSignature", async () => {
  const { pollComputePaymentConfirmation } = await import(
    "../services/pollComputePaymentConfirmation.js"
  );
  await assert.rejects(
    () =>
      pollComputePaymentConfirmation(
        { payment: submittedPayment({ txSignature: null }) },
        deps({ status: null }),
      ),
    /txSignature/i,
  );
});

// ============================================
// RPC error surfaced
// ============================================

test("pollComputePaymentConfirmation surfaces RPC errors as labeled rpc_status_unavailable", async () => {
  const { pollComputePaymentConfirmation } = await import(
    "../services/pollComputePaymentConfirmation.js"
  );
  await assert.rejects(
    () =>
      pollComputePaymentConfirmation(
        { payment: submittedPayment() },
        deps({ rpcError: new Error("rpc disconnected") }),
      ),
    /rpc_status_unavailable.*rpc disconnected/,
  );
});
