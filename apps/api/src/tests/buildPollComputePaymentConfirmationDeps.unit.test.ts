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

// Drives apps/api/src/services/buildPollComputePaymentConfirmationDeps.ts —
// dep-wiring closure for the BullMQ poll-confirmation driver.
//
// One dep: getSignatureStatus(sig) → SignatureStatusResult | null.
// The orchestrator transitions a SUBMITTED payment to:
//   - CONFIRMED  if confirmationStatus is "confirmed" or "finalized"
//   - FAILED     if err is non-null
//   - unchanged  if confirmationStatus is "processed" or null
//
// Wraps Connection.getSignatureStatuses (note: the plural method —
// connection has no singular form; the wrapper picks element [0]).

interface ConnectionLike {
  getSignatureStatuses: (
    sigs: string[],
    cfg?: any,
  ) => Promise<{
    value: Array<{
      confirmationStatus:
        | "processed"
        | "confirmed"
        | "finalized"
        | null
        | undefined;
      err: unknown | null;
    } | null>;
  }>;
}

function makeConnectionStub(
  responses: Array<{
    confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
    err?: unknown;
  } | null>,
) {
  const log: any[] = [];
  let i = 0;
  const connection: ConnectionLike = {
    async getSignatureStatuses(sigs: string[], cfg?: any) {
      log.push({ type: "getSignatureStatuses", sigs, cfg });
      const r = responses[i++] ?? null;
      return {
        value: [
          r
            ? {
                confirmationStatus: r.confirmationStatus ?? null,
                err: r.err ?? null,
              }
            : null,
        ],
      };
    },
  };
  return { log, connection };
}

// ============================================
// Build shape
// ============================================

test("buildPollComputePaymentConfirmationDeps returns the getSignatureStatus key", async () => {
  setupEnv();
  const { buildPollComputePaymentConfirmationDeps } = await import(
    "../services/buildPollComputePaymentConfirmationDeps.js"
  );
  const { connection } = makeConnectionStub([]);
  const deps = buildPollComputePaymentConfirmationDeps({
    connection: connection as any,
  });
  assert.ok("getSignatureStatus" in deps);
});

// ============================================
// getSignatureStatus wrapping
// ============================================

test("buildPollComputePaymentConfirmationDeps unwraps getSignatureStatuses[0] for a single signature", async () => {
  // Solana's RPC has no singular getSignatureStatus — we always batch
  // [sig] → [response[0]]. This is the unwrap layer.
  const { buildPollComputePaymentConfirmationDeps } = await import(
    "../services/buildPollComputePaymentConfirmationDeps.js"
  );
  const stub = makeConnectionStub([
    { confirmationStatus: "confirmed", err: null },
  ]);
  const deps = buildPollComputePaymentConfirmationDeps({
    connection: stub.connection as any,
  });
  const result = await deps.getSignatureStatus("SIG_1");
  assert.equal(stub.log[0]!.sigs[0], "SIG_1");
  assert.equal(result?.confirmationStatus, "confirmed");
  assert.equal(result?.err, null);
});

test("buildPollComputePaymentConfirmationDeps maps a missing-signature response (null) to null", async () => {
  // Solana returns null in value[0] for sigs that haven't propagated
  // yet (or that don't exist). The orchestrator handles null → leaves
  // payment SUBMITTED. The wrapper must pass null through.
  const { buildPollComputePaymentConfirmationDeps } = await import(
    "../services/buildPollComputePaymentConfirmationDeps.js"
  );
  const stub = makeConnectionStub([null]);
  const deps = buildPollComputePaymentConfirmationDeps({
    connection: stub.connection as any,
  });
  const result = await deps.getSignatureStatus("SIG_UNKNOWN");
  assert.equal(result, null);
});

test("buildPollComputePaymentConfirmationDeps preserves err payload as the orchestrator expects", async () => {
  // FAILED transitions read err — InstructionError, custom Anchor
  // codes, etc. Wrapper must preserve the shape, not stringify.
  const { buildPollComputePaymentConfirmationDeps } = await import(
    "../services/buildPollComputePaymentConfirmationDeps.js"
  );
  const errPayload = { InstructionError: [0, "Custom"] };
  const stub = makeConnectionStub([
    { confirmationStatus: "confirmed", err: errPayload },
  ]);
  const deps = buildPollComputePaymentConfirmationDeps({
    connection: stub.connection as any,
  });
  const result = await deps.getSignatureStatus("SIG_FAILED");
  assert.deepEqual(result?.err, errPayload);
});

test("buildPollComputePaymentConfirmationDeps coerces undefined confirmationStatus to null", async () => {
  // Some RPC providers omit the field entirely on early-stage txs.
  // The orchestrator's check is `=== null`, so undefined would slip
  // through as truthy junk if not normalized.
  const { buildPollComputePaymentConfirmationDeps } = await import(
    "../services/buildPollComputePaymentConfirmationDeps.js"
  );
  const stub = makeConnectionStub([{ err: null }]);
  const deps = buildPollComputePaymentConfirmationDeps({
    connection: stub.connection as any,
  });
  const result = await deps.getSignatureStatus("SIG_EARLY");
  assert.equal(result?.confirmationStatus, null);
});

test("buildPollComputePaymentConfirmationDeps requests searchTransactionHistory=true", async () => {
  // Solana drops sig info from the cache after ~150 slots; without
  // searchTransactionHistory, polls older than ~1 minute would
  // misreport "missing" and the payment would languish.
  const { buildPollComputePaymentConfirmationDeps } = await import(
    "../services/buildPollComputePaymentConfirmationDeps.js"
  );
  const stub = makeConnectionStub([null]);
  const deps = buildPollComputePaymentConfirmationDeps({
    connection: stub.connection as any,
  });
  await deps.getSignatureStatus("SIG_OLD");
  const call = stub.log[0];
  assert.equal(call.cfg?.searchTransactionHistory, true);
});

// ============================================
// Error semantics
// ============================================

test("buildPollComputePaymentConfirmationDeps bubbles connection errors", async () => {
  // The orchestrator rethrows on bubble — the driver above counts +
  // schedules retry. Swallow here would mark stuck payments as
  // CONFIRMED with a fake null status.
  const { buildPollComputePaymentConfirmationDeps } = await import(
    "../services/buildPollComputePaymentConfirmationDeps.js"
  );
  const connection: ConnectionLike = {
    async getSignatureStatuses() {
      throw new Error("rpc unreachable");
    },
  };
  const deps = buildPollComputePaymentConfirmationDeps({
    connection: connection as any,
  });
  await assert.rejects(
    deps.getSignatureStatus("SIG_X"),
    /rpc unreachable/,
  );
});

// ============================================
// End-to-end with the actual orchestrator
// ============================================

test("buildPollComputePaymentConfirmationDeps drives pollComputePaymentConfirmation to CONFIRMED on a confirmed status", async () => {
  const { buildPollComputePaymentConfirmationDeps } = await import(
    "../services/buildPollComputePaymentConfirmationDeps.js"
  );
  const { pollComputePaymentConfirmation } = await import(
    "../services/pollComputePaymentConfirmation.js"
  );
  const stub = makeConnectionStub([
    { confirmationStatus: "confirmed", err: null },
  ]);
  const deps = buildPollComputePaymentConfirmationDeps({
    connection: stub.connection as any,
  });
  const result = await pollComputePaymentConfirmation(
    {
      payment: {
        id: "cp_1",
        status: "SUBMITTED",
        txSignature: "SIG_1",
        errorMessage: null,
        paidAt: null,
        retryCount: 0,
      },
    },
    deps,
  );
  assert.equal(result.payment.status, "CONFIRMED");
});
