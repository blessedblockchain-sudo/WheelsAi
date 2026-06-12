/**
 * Drives apps/api/src/services/runFeeRouterTick.ts — the pure
 * scan-and-dispatch driver for the fee-router BullMQ worker
 * (row-identity routing + confirmation discipline, remediation D6a).
 *
 * Pinning:
 *   - phase 1 happy path: claim → sign → markSubmitted (CAS BEFORE
 *     broadcast) → broadcast → confirm → batch CONFIRMED + display
 *     cursor advanced to latestTradeTimestamp
 *   - claim race (claimBatch null) → benign skip, nothing signed/sent
 *   - sign throw → batch FAILED (trades un-stamped), cursor NOT advanced,
 *     later rows still processed
 *   - markSubmitted lost race → NO broadcast (the artifact is orphaned)
 *   - broadcast throw → batch LEFT SUBMITTED (recovery owns it)
 *   - confirm "failed" (landed with err) → batch FAILED, no cursor
 *   - confirm timeout → batch left SUBMITTED, no cursor
 *   - phase 0 recovery: CLAIMED → failed; SUBMITTED landed → confirmed
 *     (idempotent CAS); SUBMITTED expired+unseen → failed (un-stamp);
 *     SUBMITTED unexpired+unseen → re-broadcast the SAME bytes;
 *     RPC silence → untouched
 *   - DB persist failure on a successful row escalates (throws)
 */

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

interface UnroutedFee {
  treasuryId: string;
  mintAddress: string;
  tradeIds: string[];
  feeAmountLamports: bigint;
  latestTradeTimestamp: Date;
}

interface StaleBatch {
  id: string;
  treasuryId: string;
  status: "CLAIMED" | "SUBMITTED";
  txSignature: string | null;
  lastValidBlockHeight: bigint | null;
  signedTxB64: string | null;
}

type SigStatus = {
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  err: unknown | null;
} | null;

function makeDeps(opts: {
  unrouted?: UnroutedFee[];
  staleBatches?: StaleBatch[];
  currentBlockHeight?: bigint;
  blockHeightThrows?: boolean;
  signatureStatus?: (sig: string) => SigStatus;
  signatureStatusThrows?: boolean;
  claimResult?: (row: UnroutedFee) => string | null;
  signShouldThrow?: (row: UnroutedFee) => boolean;
  markSubmittedResult?: boolean;
  broadcastShouldThrow?: boolean;
  confirmOutcome?: (sig: string) =>
    | { status: "confirmed" }
    | { status: "failed"; error: string }
    | { status: "timeout" };
  persistConfirmedShouldThrow?: boolean;
}) {
  const log: any[] = [];
  let claimSeq = 0;
  return {
    log,
    deps: {
      // phase 0
      loadStaleBatches: async ({ now }: { now: Date }) => {
        log.push({ type: "loadStaleBatches", now });
        return opts.staleBatches ?? [];
      },
      getCurrentBlockHeight: async () => {
        log.push({ type: "getCurrentBlockHeight" });
        if (opts.blockHeightThrows) throw new Error("rpc down");
        return opts.currentBlockHeight ?? 1_000n;
      },
      getSignatureStatus: async (sig: string) => {
        log.push({ type: "getSignatureStatus", sig });
        if (opts.signatureStatusThrows) throw new Error("rpc down");
        return opts.signatureStatus?.(sig) ?? null;
      },
      broadcast: async (signedTxB64: string) => {
        log.push({ type: "broadcast", signedTxB64 });
        if (opts.broadcastShouldThrow) throw new Error("send failed");
      },
      persistBatchConfirmed: async (batchId: string) => {
        log.push({ type: "persistBatchConfirmed", batchId });
        if (opts.persistConfirmedShouldThrow) throw new Error("persist failed");
      },
      persistBatchFailed: async (batchId: string) => {
        log.push({ type: "persistBatchFailed", batchId });
      },
      // phase 1
      loadUnrouted: async ({ now }: { now: Date }) => {
        log.push({ type: "loadUnrouted", now });
        return opts.unrouted ?? [];
      },
      claimBatch: async (row: UnroutedFee) => {
        log.push({ type: "claimBatch", treasuryId: row.treasuryId });
        if (opts.claimResult) return opts.claimResult(row);
        claimSeq += 1;
        return `batch_${claimSeq}`;
      },
      sign: async (row: UnroutedFee) => {
        log.push({ type: "sign", treasuryId: row.treasuryId });
        if (opts.signShouldThrow?.(row)) {
          throw new Error("blockhash_unavailable: nope");
        }
        return {
          txSignature: `sig_${row.treasuryId}`,
          lastValidBlockHeight: 900n,
          signedTxB64: `bytes_${row.treasuryId}`,
        };
      },
      markSubmitted: async (batchId: string, artifact: any) => {
        log.push({ type: "markSubmitted", batchId, artifact });
        return opts.markSubmittedResult ?? true;
      },
      confirmSignature: async (sig: string) => {
        log.push({ type: "confirmSignature", sig });
        return opts.confirmOutcome?.(sig) ?? { status: "confirmed" as const };
      },
      persistCursor: async (treasuryId: string, cursor: Date) => {
        log.push({ type: "persistCursor", treasuryId, cursor });
      },
    },
  };
}

const sampleRow = (overrides: Partial<UnroutedFee> = {}): UnroutedFee => ({
  treasuryId: "treas_a",
  mintAddress: "MintAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  tradeIds: ["t1", "t2"],
  feeAmountLamports: 100_000n,
  latestTradeTimestamp: new Date("2026-04-26T11:00:00Z"),
  ...overrides,
});

const submittedBatch = (overrides: Partial<StaleBatch> = {}): StaleBatch => ({
  id: "batch_old",
  treasuryId: "treas_a",
  status: "SUBMITTED",
  txSignature: "old_sig",
  lastValidBlockHeight: 500n,
  signedTxB64: "old_bytes",
  ...overrides,
});

// ============================================
// Empty batch
// ============================================

test("runFeeRouterTick returns zero counts and skips submit when no unrouted rows", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({ unrouted: [] });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, {
    recovered: 0,
    routed: 0,
    submitted: 0,
    failed: 0,
    skipped: 0,
  });
  assert.equal(log.filter((c) => c.type === "sign").length, 0);
  assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
});

// ============================================
// Happy path
// ============================================

test("runFeeRouterTick routes each row and advances cursor to latestTradeTimestamp", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const ts1 = new Date("2026-04-26T10:00:00Z");
  const ts2 = new Date("2026-04-26T10:30:00Z");
  const { log, deps } = makeDeps({
    unrouted: [
      sampleRow({ treasuryId: "a", latestTradeTimestamp: ts1 }),
      sampleRow({ treasuryId: "b", latestTradeTimestamp: ts2 }),
    ],
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, {
    recovered: 0,
    routed: 2,
    submitted: 0,
    failed: 0,
    skipped: 0,
  });

  // Each treasury's display cursor advanced to its own latestTradeTimestamp.
  const cursors = log.filter((c) => c.type === "persistCursor");
  assert.equal(cursors.length, 2);
  assert.equal(cursors[0].treasuryId, "a");
  assert.equal(cursors[0].cursor.toISOString(), ts1.toISOString());
  assert.equal(cursors[1].treasuryId, "b");
  assert.equal(cursors[1].cursor.toISOString(), ts2.toISOString());
});

test("runFeeRouterTick: markSubmitted (artifact persist) happens BEFORE broadcast", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({ unrouted: [sampleRow()] });
  await runFeeRouterTick({ now: new Date() }, deps as any);
  const order = log.map((c) => c.type);
  const markIdx = order.indexOf("markSubmitted");
  const broadcastIdx = order.indexOf("broadcast");
  assert.ok(markIdx >= 0 && broadcastIdx >= 0);
  assert.ok(
    markIdx < broadcastIdx,
    "claim-first: the artifact must be durable before any broadcast",
  );
  // The persisted artifact is exactly what gets broadcast.
  const marked = log.find((c) => c.type === "markSubmitted");
  const sent = log.find((c) => c.type === "broadcast");
  assert.equal(marked.artifact.signedTxB64, sent.signedTxB64);
});

// ============================================
// Per-row failure isolation
// ============================================

test("runFeeRouterTick: a thrown sign FAILs the batch (un-stamp) AND cursor is NOT advanced", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({
    unrouted: [sampleRow({ treasuryId: "bad" })],
    signShouldThrow: () => true,
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, {
    recovered: 0,
    routed: 0,
    submitted: 0,
    failed: 1,
    skipped: 0,
  });
  // Cursor MUST NOT advance on a failed batch — trades rejoin next tick.
  assert.equal(
    log.some((c) => c.type === "persistCursor"),
    false,
  );
  // The claimed batch was released (un-stamped) for the next tick.
  assert.equal(
    log.filter((c) => c.type === "persistBatchFailed").length,
    1,
  );
  assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
});

test("runFeeRouterTick: confirm 'failed' (landed with err) FAILs the batch AND cursor is NOT advanced", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({
    unrouted: [sampleRow({ treasuryId: "rejected" })],
    confirmOutcome: () => ({ status: "failed", error: "InstructionError" }),
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, {
    recovered: 0,
    routed: 0,
    submitted: 0,
    failed: 1,
    skipped: 0,
  });
  assert.equal(
    log.some((c) => c.type === "persistCursor"),
    false,
  );
  assert.equal(log.filter((c) => c.type === "persistBatchFailed").length, 1);
});

test("runFeeRouterTick: one bad row does not stop later rows from being processed", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({
    unrouted: [
      sampleRow({ treasuryId: "a" }),
      sampleRow({ treasuryId: "b" }),
      sampleRow({ treasuryId: "c" }),
    ],
    signShouldThrow: (row) => row.treasuryId === "b",
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, {
    recovered: 0,
    routed: 2,
    submitted: 0,
    failed: 1,
    skipped: 0,
  });
  assert.equal(
    log.filter((c) => c.type === "sign").length,
    3,
    "all three rows must be attempted",
  );
  const cursorIds = log
    .filter((c) => c.type === "persistCursor")
    .map((c) => c.treasuryId);
  assert.deepEqual(cursorIds, ["a", "c"]);
});

// ============================================
// Claim/CAS races (benign skips)
// ============================================

test("runFeeRouterTick: lost claim race (claimBatch null) → benign skip, nothing signed or sent", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({
    unrouted: [sampleRow()],
    claimResult: () => null,
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, {
    recovered: 0,
    routed: 0,
    submitted: 0,
    failed: 0,
    skipped: 1,
  });
  assert.equal(log.filter((c) => c.type === "sign").length, 0);
  assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
});

test("runFeeRouterTick: lost markSubmitted CAS → NO broadcast (artifact is orphaned by design)", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({
    unrouted: [sampleRow()],
    markSubmittedResult: false,
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, {
    recovered: 0,
    routed: 0,
    submitted: 0,
    failed: 0,
    skipped: 1,
  });
  assert.equal(
    log.filter((c) => c.type === "broadcast").length,
    0,
    "an artifact whose durable record was raced away must never be broadcast",
  );
});

// ============================================
// Broadcast / confirm indeterminacy → recovery owns the batch
// ============================================

test("runFeeRouterTick: broadcast throw leaves the batch SUBMITTED (no FAIL, no cursor)", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({
    unrouted: [sampleRow()],
    broadcastShouldThrow: true,
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, {
    recovered: 0,
    routed: 0,
    submitted: 1,
    failed: 0,
    skipped: 0,
  });
  // The send may have reached the cluster — NEVER un-stamp here.
  assert.equal(log.filter((c) => c.type === "persistBatchFailed").length, 0);
  assert.equal(log.filter((c) => c.type === "persistCursor").length, 0);
});

test("runFeeRouterTick: confirm timeout leaves the batch SUBMITTED for next-tick recovery", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({
    unrouted: [sampleRow()],
    confirmOutcome: () => ({ status: "timeout" }),
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, {
    recovered: 0,
    routed: 0,
    submitted: 1,
    failed: 0,
    skipped: 0,
  });
  assert.equal(log.filter((c) => c.type === "persistBatchFailed").length, 0);
  assert.equal(log.filter((c) => c.type === "persistBatchConfirmed").length, 0);
  assert.equal(log.filter((c) => c.type === "persistCursor").length, 0);
});

// ============================================
// Phase 0: recovery
// ============================================

test("runFeeRouterTick recovery: stale CLAIMED batch → FAILED (un-stamp); nothing broadcast", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({
    staleBatches: [
      {
        id: "claimed_1",
        treasuryId: "treas_a",
        status: "CLAIMED",
        txSignature: null,
        lastValidBlockHeight: null,
        signedTxB64: null,
      },
    ],
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, {
    recovered: 1,
    routed: 0,
    submitted: 0,
    failed: 0,
    skipped: 0,
  });
  assert.deepEqual(
    log.filter((c) => c.type === "persistBatchFailed").map((c) => c.batchId),
    ["claimed_1"],
  );
  assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
});

test("runFeeRouterTick recovery: SUBMITTED batch landed (confirmed) → persistBatchConfirmed", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({
    staleBatches: [submittedBatch()],
    signatureStatus: () => ({ confirmationStatus: "finalized", err: null }),
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, {
    recovered: 1,
    routed: 0,
    submitted: 0,
    failed: 0,
    skipped: 0,
  });
  assert.deepEqual(
    log.filter((c) => c.type === "persistBatchConfirmed").map((c) => c.batchId),
    ["batch_old"],
  );
  // Idempotent: nothing is re-broadcast, no trades touched.
  assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
  assert.equal(log.filter((c) => c.type === "persistBatchFailed").length, 0);
});

test("runFeeRouterTick recovery: SUBMITTED landed WITH err → FAILED (trades rejoin)", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({
    staleBatches: [submittedBatch()],
    signatureStatus: () => ({
      confirmationStatus: "confirmed",
      err: { InstructionError: [0, "Custom"] },
    }),
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.equal(result.recovered, 1);
  assert.deepEqual(
    log.filter((c) => c.type === "persistBatchFailed").map((c) => c.batchId),
    ["batch_old"],
  );
});

test("runFeeRouterTick recovery: expired + unseen → FAILED (un-stamp; trades rejoin next batch)", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({
    staleBatches: [submittedBatch({ lastValidBlockHeight: 500n })],
    currentBlockHeight: 501n, // strictly past the bound
    signatureStatus: () => null, // unseen even with searchTransactionHistory
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, {
    recovered: 1,
    routed: 0,
    submitted: 0,
    failed: 0,
    skipped: 0,
  });
  assert.deepEqual(
    log.filter((c) => c.type === "persistBatchFailed").map((c) => c.batchId),
    ["batch_old"],
  );
  assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
});

test("runFeeRouterTick recovery: unexpired + unseen → re-broadcast the SAME stored bytes", async () => {
  // Crash between broadcast and confirm: the batch sits SUBMITTED with
  // its artifact. Recovery must re-send those EXACT bytes (same
  // signature ⇒ cluster dedupes ⇒ no double-pay) — never re-sign.
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({
    staleBatches: [
      submittedBatch({ lastValidBlockHeight: 500n, signedTxB64: "exact_bytes" }),
    ],
    currentBlockHeight: 400n, // still inside the validity window
    signatureStatus: () => null,
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, {
    recovered: 1,
    routed: 0,
    submitted: 0,
    failed: 0,
    skipped: 0,
  });
  const sends = log.filter((c) => c.type === "broadcast");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].signedTxB64, "exact_bytes");
  // No transition: still SUBMITTED; the next tick confirms or expires it.
  assert.equal(log.filter((c) => c.type === "persistBatchFailed").length, 0);
  assert.equal(log.filter((c) => c.type === "persistBatchConfirmed").length, 0);
});

test("runFeeRouterTick recovery: RPC silence (status throw / head unknown) leaves batches untouched", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  // status throws → untouched
  {
    const { log, deps } = makeDeps({
      staleBatches: [submittedBatch()],
      signatureStatusThrows: true,
    });
    const result = await runFeeRouterTick({ now: new Date() }, deps as any);
    assert.equal(result.skipped, 1);
    assert.equal(result.recovered, 0);
    assert.equal(log.filter((c) => c.type.startsWith("persistBatch")).length, 0);
  }
  // head unknown + unseen → expiry unprovable → untouched (no broadcast
  // either: without the head we can't even prove it's still valid).
  {
    const { log, deps } = makeDeps({
      staleBatches: [submittedBatch()],
      blockHeightThrows: true,
      signatureStatus: () => null,
    });
    const result = await runFeeRouterTick({ now: new Date() }, deps as any);
    assert.equal(result.skipped, 1);
    assert.equal(log.filter((c) => c.type === "broadcast").length, 0);
  }
});

test("runFeeRouterTick recovery: 'processed' status is indeterminate → left SUBMITTED", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({
    staleBatches: [submittedBatch()],
    signatureStatus: () => ({ confirmationStatus: "processed", err: null }),
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.equal(result.skipped, 1);
  assert.equal(log.filter((c) => c.type.startsWith("persistBatch")).length, 0);
});

// ============================================
// Persist-failure escalation
// ============================================

test("runFeeRouterTick: persist failure on a confirmed row escalates (throws)", async () => {
  // If the fee_receive CONFIRMED on-chain but we couldn't record it,
  // the durable state must not silently drift — escalate to BullMQ
  // retry; the recovery scan then re-derives CONFIRMED from the chain.
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { deps } = makeDeps({
    unrouted: [sampleRow()],
    persistConfirmedShouldThrow: true,
  });
  await assert.rejects(
    () => runFeeRouterTick({ now: new Date() }, deps as any),
    /persist failed/,
  );
});

// ============================================
// Two-tick composition: a FAILED batch's trades rejoin a later batch
// ============================================

test("runFeeRouterTick: trades un-stamped by a FAILED batch rejoin the next tick's batch", async () => {
  // Stateful stub modeling the actual DB contract: claimBatch stamps
  // trades, persistBatchFailed un-stamps them, loadUnrouted selects by
  // feeRoutingBatchId IS NULL. Tick 1's sign throws → batch FAILED →
  // trades released. Tick 2 must pick up the SAME trade ids and route
  // them to CONFIRMED — no fee is ever stranded by a failed batch.
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );

  const trades = new Map<string, string | null>([
    ["t1", null],
    ["t2", null],
  ]);
  const batchTrades = new Map<string, string[]>();
  let batchSeq = 0;
  let signThrows = true;
  const claimedRows: string[][] = [];

  const deps = {
    loadStaleBatches: async () => [],
    getCurrentBlockHeight: async () => 1_000n,
    getSignatureStatus: async () => null,
    broadcast: async () => {},
    persistBatchConfirmed: async () => {},
    persistBatchFailed: async (batchId: string) => {
      for (const id of batchTrades.get(batchId) ?? []) trades.set(id, null);
    },
    loadUnrouted: async () => {
      const unstamped = [...trades.entries()]
        .filter(([, b]) => b === null)
        .map(([id]) => id);
      if (unstamped.length === 0) return [];
      return [
        {
          treasuryId: "treas_a",
          mintAddress: "MintA",
          tradeIds: unstamped,
          feeAmountLamports: 10_000n,
          latestTradeTimestamp: new Date("2026-04-26T11:00:00Z"),
        },
      ];
    },
    claimBatch: async (row: UnroutedFee) => {
      batchSeq += 1;
      const id = `batch_${batchSeq}`;
      for (const t of row.tradeIds) trades.set(t, id);
      batchTrades.set(id, [...row.tradeIds]);
      claimedRows.push([...row.tradeIds]);
      return id;
    },
    sign: async (row: UnroutedFee) => {
      if (signThrows) throw new Error("blockhash_unavailable: nope");
      return {
        txSignature: `sig_${row.treasuryId}`,
        lastValidBlockHeight: 900n,
        signedTxB64: "bytes",
      };
    },
    markSubmitted: async () => true,
    confirmSignature: async () => ({ status: "confirmed" as const }),
    persistCursor: async () => {},
  };

  // Tick 1: sign throws → batch FAILED, trades un-stamped.
  const tick1 = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.equal(tick1.failed, 1);
  assert.deepEqual([...trades.values()], [null, null], "trades released");

  // Tick 2: the SAME trades are claimed again and route to CONFIRMED.
  signThrows = false;
  const tick2 = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.equal(tick2.routed, 1);
  assert.deepEqual(claimedRows, [
    ["t1", "t2"],
    ["t1", "t2"],
  ]);
  assert.deepEqual([...trades.values()], ["batch_2", "batch_2"]);
});
