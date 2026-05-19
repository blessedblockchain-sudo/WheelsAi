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

// Drives apps/api/src/services/runSubmitPaymentsTick.ts — the
// scan-and-dispatch driver for the submit-payment BullMQ worker.
//
// Each tick:
//   1. loadPendingBatch(now)            → rows due for submission
//   2. for each row, submit(row)        → either ok+sig OR error
//   3. persistTransition(id, transition)
//   4. counts {submitted, failed} returned
//
// Concurrency model: BullMQ worker runs concurrency=1; single-process
// safe. No row-level lock needed — the loader's status filter + the
// persistTransition write are sufficient.
//
// Per-row failures are CAUGHT — one bad row can't kill the tick. The
// driver records the FAILED transition and continues.

interface PendingRow {
  id: string;
  treasuryId: string;
  treasuryAddress: string;
  recipientAddress: string;
  amountLamports: bigint;
}

interface SubmitOk { ok: true; txSignature: string }
interface SubmitErr { ok: false; error: string }
type SubmitResult = SubmitOk | SubmitErr;

interface Transition {
  type: "submitted" | "failed";
  txSignature?: string;
  errorMessage?: string;
}

function makeDeps(opts: {
  pending?: PendingRow[];
  submit?: (row: PendingRow) => Promise<SubmitResult>;
  persistShouldThrow?: boolean;
}) {
  const log: any[] = [];
  return {
    log,
    deps: {
      loadPendingBatch: async ({ now }: { now: Date }) => {
        log.push({ type: "loadPendingBatch", now });
        return opts.pending ?? [];
      },
      submit: async (row: PendingRow) => {
        log.push({ type: "submit", id: row.id });
        return (
          opts.submit?.(row) ?? Promise.resolve({ ok: true, txSignature: `sig_${row.id}` })
        );
      },
      persistTransition: async (id: string, transition: Transition) => {
        log.push({ type: "persistTransition", id, transition });
        if (opts.persistShouldThrow) throw new Error("persist failed");
      },
    },
  };
}

const sampleRow = (overrides: Partial<PendingRow> = {}): PendingRow => ({
  id: "cp_1",
  treasuryId: "treas_1",
  treasuryAddress: "TreasuryAddr",
  recipientAddress: "Host",
  amountLamports: 1_000_000n,
  ...overrides,
});

// ============================================
// Empty batch
// ============================================

test("runSubmitPaymentsTick returns zero counts and skips submit when no PENDING rows", async () => {
  setupEnv();
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({ pending: [] });
  const result = await runSubmitPaymentsTick(
    { now: new Date() },
    deps as any,
  );
  assert.deepEqual(result, { submitted: 0, failed: 0 });
  assert.equal(log.filter((c) => c.type === "submit").length, 0);
});

// ============================================
// Happy path
// ============================================

test("runSubmitPaymentsTick submits each PENDING row and records the SUBMITTED transition", async () => {
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    pending: [sampleRow({ id: "a" }), sampleRow({ id: "b" })],
  });
  const result = await runSubmitPaymentsTick(
    { now: new Date() },
    deps as any,
  );
  assert.equal(result.submitted, 2);
  assert.equal(result.failed, 0);
  // Two submits and two transitions, one per row, in order.
  const transitions = log.filter((c) => c.type === "persistTransition");
  assert.deepEqual(
    transitions.map((c) => [c.id, c.transition.type, c.transition.txSignature]),
    [
      ["a", "submitted", "sig_a"],
      ["b", "submitted", "sig_b"],
    ],
  );
});

// ============================================
// Per-row failure isolation
// ============================================

test("runSubmitPaymentsTick records FAILED for an ok=false submit and continues", async () => {
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    pending: [sampleRow({ id: "bad" }), sampleRow({ id: "good" })],
    submit: async (row) =>
      row.id === "bad"
        ? { ok: false, error: "blockhash_unavailable" }
        : { ok: true, txSignature: `sig_${row.id}` },
  });
  const result = await runSubmitPaymentsTick(
    { now: new Date() },
    deps as any,
  );
  assert.equal(result.submitted, 1);
  assert.equal(result.failed, 1);
  const transitions = log.filter((c) => c.type === "persistTransition");
  assert.equal(transitions[0]!.transition.type, "failed");
  assert.equal(transitions[0]!.transition.errorMessage, "blockhash_unavailable");
  assert.equal(transitions[1]!.transition.type, "submitted");
});

test("runSubmitPaymentsTick catches a thrown submit and records FAILED", async () => {
  // submit() can throw on RPC errors that aren't well-formed
  // ok-payloads. The driver normalizes throws → FAILED so the
  // payment doesn't stay PENDING forever.
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    pending: [sampleRow({ id: "throw" })],
    submit: async () => {
      throw new Error("simulation failed");
    },
  });
  const result = await runSubmitPaymentsTick(
    { now: new Date() },
    deps as any,
  );
  assert.equal(result.failed, 1);
  const transition = log.find((c) => c.type === "persistTransition");
  assert.equal(transition.transition.type, "failed");
  assert.match(transition.transition.errorMessage, /simulation failed/);
});

test("runSubmitPaymentsTick continues to the next row after a per-row throw", async () => {
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    pending: [
      sampleRow({ id: "boom" }),
      sampleRow({ id: "ok" }),
    ],
    submit: async (row) => {
      if (row.id === "boom") throw new Error("boom");
      return { ok: true, txSignature: `sig_${row.id}` };
    },
  });
  const result = await runSubmitPaymentsTick(
    { now: new Date() },
    deps as any,
  );
  assert.equal(result.submitted, 1);
  assert.equal(result.failed, 1);
  const submitCalls = log.filter((c) => c.type === "submit");
  assert.equal(submitCalls.length, 2);
});

// ============================================
// Persistence error handling
// ============================================

test("runSubmitPaymentsTick bubbles persistTransition errors so the worker can retry the tick", async () => {
  // If the DB write fails, we cannot leave half-done state where the
  // sig is on-chain but the row says PENDING. The whole tick must
  // throw so BullMQ retries and we re-poll authoritative on-chain
  // status (the next tick's loadPendingBatch will still surface it).
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { deps } = makeDeps({
    pending: [sampleRow()],
    persistShouldThrow: true,
  });
  await assert.rejects(
    runSubmitPaymentsTick({ now: new Date() }, deps as any),
    /persist failed/,
  );
});

// ============================================
// Batch ordering
// ============================================

test("runSubmitPaymentsTick processes rows in the order returned by loadPendingBatch", async () => {
  // The loader sorts by scheduledFor asc; the driver must preserve
  // that order so older payments don't get starved by a stream of
  // newer ones (some token's auto-pay loop could otherwise dominate).
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    pending: [
      sampleRow({ id: "older" }),
      sampleRow({ id: "newer" }),
    ],
  });
  await runSubmitPaymentsTick({ now: new Date() }, deps as any);
  const submitCalls = log.filter((c) => c.type === "submit");
  assert.deepEqual(
    submitCalls.map((c) => c.id),
    ["older", "newer"],
  );
});
