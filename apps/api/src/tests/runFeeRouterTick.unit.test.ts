/**
 * Drives apps/api/src/services/runFeeRouterTick.ts — the pure
 * scan-and-dispatch driver for the fee-router BullMQ worker.
 *
 * Shape mirrors runSubmitPaymentsTick:
 *   1. loadUnrouted(now)                  → rows with non-zero owed fee
 *   2. for each row, submit(row)          → ok+sig OR err payload
 *   3. persistCursor(treasuryId, cursor)  → bump lastFeeRoutedAt
 *   4. counts {routed, failed} returned
 *
 * Per-row failure isolation: a thrown submit is caught and counted
 * as failed; the cursor is NOT advanced for failed rows so the next
 * tick retries.
 *
 * On success: cursor advance MUST happen — if we send a fee_receive
 * but fail to persist the cursor, the next tick double-pays. Hence
 * persist failures are NOT swallowed; the tick throws so BullMQ
 * retries and the loader sees the new state next time.
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
  feeAmountLamports: bigint;
  latestTradeTimestamp: Date;
}

interface SubmitOk { ok: true; txSignature: string }
interface SubmitErr { ok: false; error: string }

function makeDeps(opts: {
  unrouted?: UnroutedFee[];
  submit?: (row: UnroutedFee) => Promise<SubmitOk | SubmitErr>;
  persistShouldThrow?: boolean;
}) {
  const log: any[] = [];
  return {
    log,
    deps: {
      loadUnrouted: async ({ now }: { now: Date }) => {
        log.push({ type: "loadUnrouted", now });
        return opts.unrouted ?? [];
      },
      submit: async (row: UnroutedFee) => {
        log.push({ type: "submit", id: row.treasuryId });
        return (
          opts.submit?.(row) ??
          Promise.resolve({ ok: true as const, txSignature: `sig_${row.treasuryId}` })
        );
      },
      persistCursor: async (treasuryId: string, cursor: Date) => {
        log.push({ type: "persistCursor", treasuryId, cursor });
        if (opts.persistShouldThrow) throw new Error("persist failed");
      },
    },
  };
}

const sampleRow = (overrides: Partial<UnroutedFee> = {}): UnroutedFee => ({
  treasuryId: "treas_a",
  mintAddress: "MintAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  feeAmountLamports: 100_000n,
  latestTradeTimestamp: new Date("2026-04-26T11:00:00Z"),
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
  assert.deepEqual(result, { routed: 0, failed: 0 });
  assert.equal(log.filter((c) => c.type === "submit").length, 0);
});

// ============================================
// Happy path
// ============================================

test("runFeeRouterTick submits each row and advances cursor to latestTradeTimestamp", async () => {
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
  assert.deepEqual(result, { routed: 2, failed: 0 });

  // Each treasury's cursor advanced to its own latestTradeTimestamp.
  const cursors = log.filter((c) => c.type === "persistCursor");
  assert.equal(cursors.length, 2);
  assert.equal(cursors[0].treasuryId, "a");
  assert.equal(cursors[0].cursor.toISOString(), ts1.toISOString());
  assert.equal(cursors[1].treasuryId, "b");
  assert.equal(cursors[1].cursor.toISOString(), ts2.toISOString());
});

// ============================================
// Per-row failure isolation
// ============================================

test("runFeeRouterTick: a thrown submit is counted as failed AND cursor is NOT advanced", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({
    unrouted: [sampleRow({ treasuryId: "bad" })],
    submit: async () => {
      throw new Error("rpc_submit: insufficient lamports");
    },
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, { routed: 0, failed: 1 });
  // Cursor MUST NOT advance on a failed submit — next tick retries.
  assert.equal(
    log.some((c) => c.type === "persistCursor"),
    false,
  );
});

test("runFeeRouterTick: a submit returning ok=false is counted as failed AND cursor is NOT advanced", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { log, deps } = makeDeps({
    unrouted: [sampleRow({ treasuryId: "rejected" })],
    submit: async () => ({ ok: false, error: "preflight: bad mint" }),
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, { routed: 0, failed: 1 });
  assert.equal(
    log.some((c) => c.type === "persistCursor"),
    false,
  );
});

test("runFeeRouterTick: one bad row does not stop later rows from being processed", async () => {
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  let calls = 0;
  const { log, deps } = makeDeps({
    unrouted: [
      sampleRow({ treasuryId: "a" }),
      sampleRow({ treasuryId: "b" }),
      sampleRow({ treasuryId: "c" }),
    ],
    submit: async (row) => {
      calls += 1;
      if (row.treasuryId === "b") throw new Error("transient");
      return { ok: true, txSignature: `sig_${row.treasuryId}` };
    },
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps as any);
  assert.deepEqual(result, { routed: 2, failed: 1 });
  assert.equal(calls, 3, "all three rows must be attempted");
  const cursorIds = log
    .filter((c) => c.type === "persistCursor")
    .map((c) => c.treasuryId);
  assert.deepEqual(cursorIds, ["a", "c"]);
});

// ============================================
// Persist-failure escalation
// ============================================

test("runFeeRouterTick: persist failure on a successful row escalates (throws)", async () => {
  // If we sent the fee_receive tx but couldn't bump the cursor, the
  // next tick would re-route the same trades — paying twice. We
  // can't tolerate that silently; escalate to BullMQ retry.
  setupEnv();
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const { deps } = makeDeps({
    unrouted: [sampleRow()],
    persistShouldThrow: true,
  });
  await assert.rejects(
    () => runFeeRouterTick({ now: new Date() }, deps as any),
    /persist failed/,
  );
});
