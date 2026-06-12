/**
 * Drives apps/api/src/services/awaitSignatureConfirmation.ts — the
 * best-effort same-tick confirmation poll shared by the fee-router and
 * reputation-attestation workers (remediation D6).
 *
 * Pinning:
 *   - err present (any confirmationStatus) → "failed" with the err string
 *   - 'confirmed' | 'finalized' with err == null → "confirmed"
 *   - null result / 'processed' / RPC throw → keep polling; budget
 *     exhausted → "timeout" (indeterminate — never invent a verdict)
 *   - timeoutMs <= 0 degenerates to exactly ONE status check
 *   - timeout is an OUTCOME, not an exception
 */

import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

type SigStatus = {
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  err: unknown | null;
} | null;

/** Deterministic harness: a fake clock advanced only by sleep(). */
function makeHarness(statuses: Array<SigStatus | "throw">, opts: {
  timeoutMs: number;
  pollIntervalMs: number;
}) {
  let nowMs = 0;
  let calls = 0;
  return {
    calls: () => calls,
    deps: {
      getSignatureStatus: async () => {
        const next = statuses[Math.min(calls, statuses.length - 1)];
        calls += 1;
        if (next === "throw") throw new Error("rpc blip");
        return next ?? null;
      },
      timeoutMs: opts.timeoutMs,
      pollIntervalMs: opts.pollIntervalMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
      nowMs: () => nowMs,
    },
  };
}

test("awaitSignatureConfirmation: confirmed status → confirmed outcome", async () => {
  setupEnv();
  const { awaitSignatureConfirmation } = await import(
    "../services/awaitSignatureConfirmation.js"
  );
  for (const confirmationStatus of ["confirmed", "finalized"] as const) {
    const h = makeHarness([{ confirmationStatus, err: null }], {
      timeoutMs: 8000,
      pollIntervalMs: 1000,
    });
    const outcome = await awaitSignatureConfirmation("sig", h.deps);
    assert.deepEqual(outcome, { status: "confirmed" });
    assert.equal(h.calls(), 1);
  }
});

test("awaitSignatureConfirmation: err present → failed with the formatted err (landed but errored)", async () => {
  setupEnv();
  const { awaitSignatureConfirmation } = await import(
    "../services/awaitSignatureConfirmation.js"
  );
  const h = makeHarness(
    [
      {
        confirmationStatus: "confirmed",
        err: { InstructionError: [0, "Custom"] },
      },
    ],
    { timeoutMs: 8000, pollIntervalMs: 1000 },
  );
  const outcome = await awaitSignatureConfirmation("sig", h.deps);
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") {
    assert.match(outcome.error, /InstructionError/);
  }
});

test("awaitSignatureConfirmation: 'processed' and null are indeterminate — polls until the verdict", async () => {
  setupEnv();
  const { awaitSignatureConfirmation } = await import(
    "../services/awaitSignatureConfirmation.js"
  );
  const h = makeHarness(
    [
      null, // unseen yet
      { confirmationStatus: "processed", err: null }, // not finality
      { confirmationStatus: "confirmed", err: null },
    ],
    { timeoutMs: 8000, pollIntervalMs: 1000 },
  );
  const outcome = await awaitSignatureConfirmation("sig", h.deps);
  assert.deepEqual(outcome, { status: "confirmed" });
  assert.equal(h.calls(), 3);
});

test("awaitSignatureConfirmation: RPC throws are swallowed and polling continues", async () => {
  setupEnv();
  const { awaitSignatureConfirmation } = await import(
    "../services/awaitSignatureConfirmation.js"
  );
  const h = makeHarness(
    ["throw", { confirmationStatus: "finalized", err: null }],
    { timeoutMs: 8000, pollIntervalMs: 1000 },
  );
  const outcome = await awaitSignatureConfirmation("sig", h.deps);
  assert.deepEqual(outcome, { status: "confirmed" });
  assert.equal(h.calls(), 2);
});

test("awaitSignatureConfirmation: budget exhausted with no verdict → timeout (never a throw)", async () => {
  setupEnv();
  const { awaitSignatureConfirmation } = await import(
    "../services/awaitSignatureConfirmation.js"
  );
  const h = makeHarness([null], { timeoutMs: 3000, pollIntervalMs: 1000 });
  const outcome = await awaitSignatureConfirmation("sig", h.deps);
  assert.deepEqual(outcome, { status: "timeout" });
  // 3s budget at 1s polls: checks at t=0,1,2,3 then the next poll would
  // overshoot — bounded, deterministic.
  assert.ok(h.calls() <= 4);
});

test("awaitSignatureConfirmation: timeoutMs <= 0 → exactly one status check", async () => {
  setupEnv();
  const { awaitSignatureConfirmation } = await import(
    "../services/awaitSignatureConfirmation.js"
  );
  // Indeterminate result → immediate timeout after the single check.
  {
    const h = makeHarness([null], { timeoutMs: 0, pollIntervalMs: 1000 });
    const outcome = await awaitSignatureConfirmation("sig", h.deps);
    assert.deepEqual(outcome, { status: "timeout" });
    assert.equal(h.calls(), 1);
  }
  // A verdict on that single check is still honored.
  {
    const h = makeHarness([{ confirmationStatus: "confirmed", err: null }], {
      timeoutMs: 0,
      pollIntervalMs: 1000,
    });
    const outcome = await awaitSignatureConfirmation("sig", h.deps);
    assert.deepEqual(outcome, { status: "confirmed" });
    assert.equal(h.calls(), 1);
  }
});
