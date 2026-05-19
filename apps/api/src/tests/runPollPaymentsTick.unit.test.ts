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

// Drives apps/api/src/services/runPollPaymentsTick.ts — the
// scan-and-dispatch driver for the poll-confirmation BullMQ worker.
//
// Each tick:
//   1. loadSubmittedBatch(now)        → SUBMITTED rows ready to poll
//   2. for each row, pollOne(row)     → confirmed | failed | unchanged
//   3. persistTransition(id, ...)     ONLY if changed
//   4. counts {confirmed, failed, unchanged} returned
//
// Per-row failure isolation: thrown poll counts as `unchanged` (next
// tick will retry). Throws on persist DO bubble — half-state would
// hide a CONFIRMED tx behind a stale SUBMITTED row.

interface SubmittedRow {
  id: string;
  txSignature: string;
}

type PollOutcome =
  | { type: "confirmed" }
  | { type: "failed"; errorMessage: string }
  | { type: "unchanged" };

function makeDeps(opts: {
  rows?: SubmittedRow[];
  poll?: (row: SubmittedRow) => Promise<PollOutcome>;
  persistShouldThrow?: boolean;
}) {
  const log: any[] = [];
  return {
    log,
    deps: {
      loadSubmittedBatch: async ({ now }: { now: Date }) => {
        log.push({ type: "loadSubmittedBatch", now });
        return opts.rows ?? [];
      },
      pollOne: async (row: SubmittedRow) => {
        log.push({ type: "pollOne", id: row.id });
        return (
          opts.poll?.(row) ?? Promise.resolve({ type: "unchanged" } as PollOutcome)
        );
      },
      persistTransition: async (id: string, outcome: PollOutcome) => {
        log.push({ type: "persistTransition", id, outcome });
        if (opts.persistShouldThrow) throw new Error("persist failed");
      },
    },
  };
}

const sampleRow = (overrides: Partial<SubmittedRow> = {}): SubmittedRow => ({
  id: "cp_1",
  txSignature: "sig_1",
  ...overrides,
});

// ============================================
// Empty batch
// ============================================

test("runPollPaymentsTick returns zero counts and skips poll when no SUBMITTED rows", async () => {
  setupEnv();
  const { runPollPaymentsTick } = await import(
    "../services/runPollPaymentsTick.js"
  );
  const { log, deps } = makeDeps({ rows: [] });
  const result = await runPollPaymentsTick(
    { now: new Date() },
    deps as any,
  );
  assert.deepEqual(result, { confirmed: 0, failed: 0, unchanged: 0 });
  assert.equal(log.filter((c) => c.type === "pollOne").length, 0);
});

// ============================================
// Outcomes
// ============================================

test("runPollPaymentsTick records confirmed transition + increments confirmed count", async () => {
  const { runPollPaymentsTick } = await import(
    "../services/runPollPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    rows: [sampleRow()],
    poll: async () => ({ type: "confirmed" }),
  });
  const result = await runPollPaymentsTick(
    { now: new Date() },
    deps as any,
  );
  assert.equal(result.confirmed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.unchanged, 0);
  const transition = log.find((c) => c.type === "persistTransition");
  assert.equal(transition.outcome.type, "confirmed");
});

test("runPollPaymentsTick records failed transition + increments failed count", async () => {
  const { runPollPaymentsTick } = await import(
    "../services/runPollPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    rows: [sampleRow()],
    poll: async () => ({
      type: "failed",
      errorMessage: "InstructionError [0, Custom]",
    }),
  });
  const result = await runPollPaymentsTick(
    { now: new Date() },
    deps as any,
  );
  assert.equal(result.failed, 1);
  const transition = log.find((c) => c.type === "persistTransition");
  assert.equal(transition.outcome.type, "failed");
  assert.equal(transition.outcome.errorMessage, "InstructionError [0, Custom]");
});

test("runPollPaymentsTick increments unchanged count and DOES NOT call persistTransition", async () => {
  // Skipping the DB write on unchanged is the throughput optimization
  // — most polls during normal operation hit "still confirming".
  const { runPollPaymentsTick } = await import(
    "../services/runPollPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    rows: [sampleRow()],
    poll: async () => ({ type: "unchanged" }),
  });
  const result = await runPollPaymentsTick(
    { now: new Date() },
    deps as any,
  );
  assert.equal(result.unchanged, 1);
  assert.equal(log.filter((c) => c.type === "persistTransition").length, 0);
});

// ============================================
// Per-row throw isolation
// ============================================

test("runPollPaymentsTick treats a thrown pollOne as unchanged and continues", async () => {
  // RPC blip on one sig shouldn't poison the whole tick. Counts as
  // unchanged so the next tick will retry the same row naturally.
  const { runPollPaymentsTick } = await import(
    "../services/runPollPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    rows: [sampleRow({ id: "boom" }), sampleRow({ id: "ok" })],
    poll: async (row) => {
      if (row.id === "boom") throw new Error("rpc blip");
      return { type: "confirmed" };
    },
  });
  const result = await runPollPaymentsTick(
    { now: new Date() },
    deps as any,
  );
  assert.equal(result.unchanged, 1);
  assert.equal(result.confirmed, 1);
  assert.equal(log.filter((c) => c.type === "pollOne").length, 2);
  // No persist for the boomed row.
  const persists = log.filter((c) => c.type === "persistTransition");
  assert.equal(persists.length, 1);
  assert.equal(persists[0]!.id, "ok");
});

// ============================================
// Persistence error → bubble
// ============================================

test("runPollPaymentsTick bubbles persistTransition errors so BullMQ retries", async () => {
  const { runPollPaymentsTick } = await import(
    "../services/runPollPaymentsTick.js"
  );
  const { deps } = makeDeps({
    rows: [sampleRow()],
    poll: async () => ({ type: "confirmed" }),
    persistShouldThrow: true,
  });
  await assert.rejects(
    runPollPaymentsTick({ now: new Date() }, deps as any),
    /persist failed/,
  );
});

// ============================================
// Mixed batch
// ============================================

test("runPollPaymentsTick handles a mixed batch of confirmed/failed/unchanged", async () => {
  const { runPollPaymentsTick } = await import(
    "../services/runPollPaymentsTick.js"
  );
  const { log, deps } = makeDeps({
    rows: [
      sampleRow({ id: "c" }),
      sampleRow({ id: "u" }),
      sampleRow({ id: "f" }),
    ],
    poll: async (row) => {
      if (row.id === "c") return { type: "confirmed" };
      if (row.id === "u") return { type: "unchanged" };
      return { type: "failed", errorMessage: "err" };
    },
  });
  const result = await runPollPaymentsTick(
    { now: new Date() },
    deps as any,
  );
  assert.deepEqual(result, { confirmed: 1, failed: 1, unchanged: 1 });
  // Two persist calls (skip the unchanged).
  assert.equal(log.filter((c) => c.type === "persistTransition").length, 2);
});
