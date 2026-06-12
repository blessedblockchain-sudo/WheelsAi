/**
 * Drives apps/api/src/services/persistFeeBatchTransition.ts — the CAS
 * transition writer for FeeRoutingBatch rows (remediation D6a).
 *
 * Pinning:
 *   - "submitted": CAS CLAIMED→SUBMITTED persisting the artifacts;
 *     count 1 → true, count 0 (recovery failed the batch first) → false
 *   - "confirmed": CAS SUBMITTED→CONFIRMED; count 0 is benign (already
 *     settled) — idempotent: a second confirm changes nothing
 *   - "failed": batch CAS {CLAIMED,SUBMITTED}→FAILED FIRST, and the
 *     trade un-stamp runs ONLY when that CAS won — a batch that
 *     CONFIRMED elsewhere can never have its trades re-released
 *   - "failed" runs batch CAS + un-stamp inside one $transaction
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

const artifact = {
  txSignature: "sig_abc",
  lastValidBlockHeight: 900n,
  signedTxB64: "Ynl0ZXM=",
};

function makePrisma(opts: { batchCasCount?: number } = {}) {
  const log: any[] = [];
  const batchUpdateMany = async (args: any) => {
    log.push({ type: "batch.updateMany", args });
    return { count: opts.batchCasCount ?? 1 };
  };
  const prisma = {
    feeRoutingBatch: { updateMany: batchUpdateMany },
    $transaction: async (fn: any) =>
      fn({
        feeRoutingBatch: { updateMany: batchUpdateMany },
        agentTokenTrade: {
          updateMany: async (args: any) => {
            log.push({ type: "trade.updateMany", args });
            return { count: 3 };
          },
        },
      }),
  };
  return { log, prisma };
}

test("persistFeeBatchTransition submitted: CAS CLAIMED→SUBMITTED with artifacts; count 1 → true", async () => {
  setupEnv();
  const { persistFeeBatchTransition } = await import(
    "../services/persistFeeBatchTransition.js"
  );
  const { log, prisma } = makePrisma({});
  const ok = await persistFeeBatchTransition(
    "batch_1",
    { type: "submitted", artifact },
    { prisma: prisma as any },
  );
  assert.equal(ok, true);
  const update = log.find((c) => c.type === "batch.updateMany");
  assert.deepEqual(update.args.where, { id: "batch_1", status: "CLAIMED" });
  assert.deepEqual(update.args.data, {
    status: "SUBMITTED",
    txSignature: "sig_abc",
    lastValidBlockHeight: 900n,
    signedTxB64: "Ynl0ZXM=",
  });
});

test("persistFeeBatchTransition submitted: count 0 (recovery raced us) → false", async () => {
  setupEnv();
  const { persistFeeBatchTransition } = await import(
    "../services/persistFeeBatchTransition.js"
  );
  const { prisma } = makePrisma({ batchCasCount: 0 });
  const ok = await persistFeeBatchTransition(
    "batch_1",
    { type: "submitted", artifact },
    { prisma: prisma as any },
  );
  assert.equal(ok, false);
});

test("persistFeeBatchTransition confirmed: CAS SUBMITTED→CONFIRMED; double-confirm is a no-op", async () => {
  setupEnv();
  const { persistFeeBatchTransition } = await import(
    "../services/persistFeeBatchTransition.js"
  );
  {
    const { log, prisma } = makePrisma({});
    const ok = await persistFeeBatchTransition(
      "batch_1",
      { type: "confirmed" },
      { prisma: prisma as any },
    );
    assert.equal(ok, true);
    const update = log.find((c) => c.type === "batch.updateMany");
    assert.deepEqual(update.args.where, { id: "batch_1", status: "SUBMITTED" });
    assert.deepEqual(update.args.data, { status: "CONFIRMED" });
  }
  {
    // Second confirm (idempotent recovery): WHERE status=SUBMITTED no
    // longer matches → count 0 → benign false, nothing else written.
    const { log, prisma } = makePrisma({ batchCasCount: 0 });
    const ok = await persistFeeBatchTransition(
      "batch_1",
      { type: "confirmed" },
      { prisma: prisma as any },
    );
    assert.equal(ok, false);
    assert.equal(log.filter((c) => c.type === "trade.updateMany").length, 0);
  }
});

test("persistFeeBatchTransition failed: batch CAS won → trades un-stamped (rejoin next batch)", async () => {
  setupEnv();
  const { persistFeeBatchTransition } = await import(
    "../services/persistFeeBatchTransition.js"
  );
  const { log, prisma } = makePrisma({});
  const ok = await persistFeeBatchTransition(
    "batch_1",
    { type: "failed" },
    { prisma: prisma as any },
  );
  assert.equal(ok, true);

  const batchUpdate = log.find((c) => c.type === "batch.updateMany");
  assert.deepEqual(batchUpdate.args.where, {
    id: "batch_1",
    status: { in: ["CLAIMED", "SUBMITTED"] },
  });
  assert.deepEqual(batchUpdate.args.data, { status: "FAILED" });

  const unstamp = log.find((c) => c.type === "trade.updateMany");
  assert.deepEqual(unstamp.args.where, { feeRoutingBatchId: "batch_1" });
  assert.deepEqual(unstamp.args.data, { feeRoutingBatchId: null });
});

test("persistFeeBatchTransition failed: batch CAS lost (already CONFIRMED) → trades NOT un-stamped", async () => {
  // THE double-pay guard: if the batch confirmed elsewhere, releasing
  // its trades would route the same fee twice.
  setupEnv();
  const { persistFeeBatchTransition } = await import(
    "../services/persistFeeBatchTransition.js"
  );
  const { log, prisma } = makePrisma({ batchCasCount: 0 });
  const ok = await persistFeeBatchTransition(
    "batch_1",
    { type: "failed" },
    { prisma: prisma as any },
  );
  assert.equal(ok, false);
  assert.equal(log.filter((c) => c.type === "trade.updateMany").length, 0);
});

test("persistFeeBatchTransition failed: CAS + un-stamp share one $transaction", async () => {
  setupEnv();
  const { persistFeeBatchTransition } = await import(
    "../services/persistFeeBatchTransition.js"
  );
  let inTx = false;
  let batchRanInTx = false;
  let unstampRanInTx = false;
  const prisma = {
    feeRoutingBatch: {
      updateMany: async () => ({ count: 1 }),
    },
    $transaction: async (fn: any) => {
      inTx = true;
      try {
        return await fn({
          feeRoutingBatch: {
            updateMany: async () => {
              batchRanInTx = inTx;
              return { count: 1 };
            },
          },
          agentTokenTrade: {
            updateMany: async () => {
              unstampRanInTx = inTx;
              return { count: 1 };
            },
          },
        });
      } finally {
        inTx = false;
      }
    },
  };
  await persistFeeBatchTransition(
    "batch_1",
    { type: "failed" },
    { prisma: prisma as any },
  );
  assert.equal(batchRanInTx, true);
  assert.equal(unstampRanInTx, true);
});
