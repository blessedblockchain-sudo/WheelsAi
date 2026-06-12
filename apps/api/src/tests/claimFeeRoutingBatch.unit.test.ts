/**
 * Drives apps/api/src/services/claimFeeRoutingBatch.ts — the atomic
 * batch-claim writer (row-identity fee routing, remediation D6a).
 *
 * Pinning:
 *   - batch INSERT + trade stamps run inside ONE prisma.$transaction
 *   - the stamp updateMany uses `feeRoutingBatchId: null` as the CAS
 *   - stamped count == tradeIds.length → returns the batch id
 *   - stamped count short (another worker raced) → the WHOLE transaction
 *     rolls back and the claim returns null (benign)
 *   - non-race errors (connection loss) propagate
 *   - empty tradeIds → null without touching the DB
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

function makePrisma(opts: {
  stampCount?: number;
  createThrows?: boolean;
}) {
  const log: any[] = [];
  let rolledBack = false;
  const prisma = {
    $transaction: async (fn: any) => {
      try {
        return await fn({
          feeRoutingBatch: {
            create: async (args: any) => {
              log.push({ type: "create", args });
              if (opts.createThrows) throw new Error("connection lost");
              return { id: "batch_new" };
            },
          },
          agentTokenTrade: {
            updateMany: async (args: any) => {
              log.push({ type: "stamp", args });
              return { count: opts.stampCount ?? args.where.id.in.length };
            },
          },
        });
      } catch (err) {
        rolledBack = true; // a throw inside fn = Prisma rollback
        throw err;
      }
    },
  };
  return { log, prisma, wasRolledBack: () => rolledBack };
}

const input = {
  treasuryId: "treas_a",
  tradeIds: ["t1", "t2", "t3"],
  feeAmountLamports: 30_000_000n,
};

test("claimFeeRoutingBatch: creates CLAIMED batch + stamps trades via null-CAS in one transaction", async () => {
  setupEnv();
  const { claimFeeRoutingBatch } = await import(
    "../services/claimFeeRoutingBatch.js"
  );
  const { log, prisma } = makePrisma({});
  const batchId = await claimFeeRoutingBatch(input, { prisma: prisma as any });
  assert.equal(batchId, "batch_new");

  const create = log.find((c) => c.type === "create");
  assert.deepEqual(create.args.data, {
    treasuryId: "treas_a",
    status: "CLAIMED",
    lamports: 30_000_000n,
    tradeCount: 3,
  });

  const stamp = log.find((c) => c.type === "stamp");
  assert.deepEqual(stamp.args.where, {
    id: { in: ["t1", "t2", "t3"] },
    feeRoutingBatchId: null, // the compare-and-set
  });
  assert.deepEqual(stamp.args.data, { feeRoutingBatchId: "batch_new" });
});

test("claimFeeRoutingBatch: short stamp count (lost race) → transaction rolled back, returns null", async () => {
  setupEnv();
  const { claimFeeRoutingBatch } = await import(
    "../services/claimFeeRoutingBatch.js"
  );
  const { prisma, wasRolledBack } = makePrisma({ stampCount: 2 }); // 2 of 3
  const batchId = await claimFeeRoutingBatch(input, { prisma: prisma as any });
  assert.equal(batchId, null);
  assert.equal(
    wasRolledBack(),
    true,
    "a partial claim must roll back the batch row AND the stamps together",
  );
});

test("claimFeeRoutingBatch: non-race errors propagate (BullMQ retries the tick)", async () => {
  setupEnv();
  const { claimFeeRoutingBatch } = await import(
    "../services/claimFeeRoutingBatch.js"
  );
  const { prisma } = makePrisma({ createThrows: true });
  await assert.rejects(
    () => claimFeeRoutingBatch(input, { prisma: prisma as any }),
    /connection lost/,
  );
});

test("claimFeeRoutingBatch: empty tradeIds → null, DB untouched", async () => {
  setupEnv();
  const { claimFeeRoutingBatch } = await import(
    "../services/claimFeeRoutingBatch.js"
  );
  let txCalled = 0;
  const prisma = {
    $transaction: async () => {
      txCalled += 1;
      return "never";
    },
  };
  const batchId = await claimFeeRoutingBatch(
    { ...input, tradeIds: [] },
    { prisma: prisma as any },
  );
  assert.equal(batchId, null);
  assert.equal(txCalled, 0);
});
