import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";
import {
  X402_DEAD_AFTER_MS,
  X402_REQUEST_GRACE_MS,
  X402_UNSERVED_AFTER_MS,
  settleX402Row,
  takeX402Payment,
  markX402Served,
} from "../services/x402Payments.js";
import type { SignatureFate } from "../services/signatureFate.js";
import { makeWorld, usdcPayment, type World } from "./x402StandIns.js";

// The settlement worker finishes a payment from what the chain says and
// nothing else. No count of attempts ends a row.

const MINUTE = 60_000;

/** A payment whose request gave up waiting: the row is "submitted". */
async function submitted(world: World, amount = 12_000n) {
  world.fates = ["in_flight"];
  const result = await takeX402Payment(
    {
      orgId: "org-1",
      deploymentId: "dep-1",
      requestId: "req-1",
      microUsd: 3_000n,
      header: { signature: usdcPayment({ amount }), network: "solana:devnet", quote: null },
      hasHealthyNode: true,
    },
    world.deps,
  );
  assert.deepEqual(result, { outcome: "refused", reason: "payment_not_confirmed" });
  assert.equal(world.db.only().status, "submitted");
  world.fateReads = 0;
  return world.db.only().id;
}

/** A payment that landed and whose request is being served: "verified". */
async function verified(world: World, amount = 12_000n) {
  world.fates = ["landed_ok"];
  const result = await takeX402Payment(
    {
      orgId: "org-1",
      deploymentId: "dep-1",
      requestId: "req-1",
      microUsd: 3_000n,
      header: { signature: usdcPayment({ amount }), network: "solana:devnet", quote: null },
      hasHealthyNode: true,
    },
    world.deps,
  );
  assert.equal(result.outcome, "taken");
  world.fateReads = 0;
  return world.db.only().id;
}

const run = (world: World) => settleX402Row(world.db.only(), world.settlementDeps);

// ============================================
// "submitted"
// ============================================

test("submitted, landed after its request gave up: never served, so the payment is returned in full", async () => {
  const world = makeWorld();
  const id = await submitted(world, 12_000n);
  world.nowMs += MINUTE;
  world.fates = ["landed_ok"];

  assert.equal(await run(world), "returned");
  const row = world.db.only();
  assert.equal(row.status, "refunded");
  assert.equal(row.refundMicroUsd, 12_000n);
  assert.deepEqual(world.db.balances.get("org-1"), { balanceCents: 1n, x402RefundCarryMicroUsd: 2_000n });
  assert.equal(world.db.ledger.length, 1);
  assert.equal(world.db.ledger[0]!.referenceId, id);

  // And only once, however often the worker comes back.
  assert.equal(await run(world), "skipped");
  assert.equal(await run(world), "skipped");
  assert.equal(world.db.ledger.length, 1);
});

test("submitted, landed and failed: 'failed', nothing returned", async () => {
  const world = makeWorld();
  await submitted(world);
  world.nowMs += MINUTE;
  world.fates = ["landed_failed"];
  assert.equal(await run(world), "failed");
  assert.equal(world.db.only().status, "failed");
  assert.equal(world.db.balances.size, 0);
});

test("submitted and dead: 'failed' only once the row is three minutes old", async () => {
  const world = makeWorld();
  await submitted(world);
  const writtenAt = world.db.only().submittedAt!.getTime();
  world.fates = ["dead"];

  // A blockhash too new to be finalized also reads as expired: not yet.
  world.nowMs = writtenAt + X402_DEAD_AFTER_MS - 1;
  assert.equal(await run(world), "waiting");
  assert.equal(world.db.only().status, "submitted");

  world.nowMs = writtenAt + X402_DEAD_AFTER_MS;
  assert.equal(await run(world), "failed");
  assert.equal(world.db.only().status, "failed");
  assert.equal(world.db.balances.size, 0);
});

for (const fate of ["unknown", "in_flight"] as SignatureFate[]) {
  test(`submitted and '${fate}': nothing changes, however often and however long`, async () => {
    const world = makeWorld();
    await submitted(world);
    world.fates = [fate];
    const before = { ...world.db.only() };
    world.db.writes.length = 0;

    for (let i = 0; i < 200; i += 1) {
      world.nowMs += MINUTE;
      assert.equal(await run(world), "waiting");
    }
    assert.deepEqual(world.db.only(), before);
    assert.deepEqual(world.db.writes, []);
    assert.equal(world.fateReads, 200);

    // More than three hours later the chain answers, and the row is finished by that answer.
    world.fates = ["landed_ok"];
    assert.equal(await run(world), "returned");
  });
}

test("a submitted row is left to its own request while that request can still be waiting", async () => {
  const world = makeWorld({ confirmWaitMs: 30_000 });
  await submitted(world);
  const writtenAt = world.db.only().submittedAt!.getTime();
  world.fates = ["landed_ok"];

  world.nowMs = writtenAt + 30_000 + X402_REQUEST_GRACE_MS - 1;
  assert.equal(await run(world), "waiting");
  assert.equal(world.fateReads, 0, "the chain is not even asked");
  assert.equal(world.db.only().status, "submitted");

  world.nowMs = writtenAt + 30_000 + X402_REQUEST_GRACE_MS;
  assert.equal(await run(world), "returned");
});

// ============================================
// "verified"
// ============================================

test("verified and served: settled once the payment is finalized, not while it is only confirmed", async () => {
  const world = makeWorld();
  const id = await verified(world);
  await markX402Served(id, world.deps);

  world.fates = [{ fate: "landed_ok", confirmationStatus: "confirmed" }];
  assert.equal(await run(world), "waiting");
  assert.equal(world.db.only().status, "verified");

  world.fates = [{ fate: "unknown", confirmationStatus: null }];
  assert.equal(await run(world), "waiting");

  world.fates = [{ fate: "landed_ok", confirmationStatus: "finalized" }];
  assert.equal(await run(world), "settled");
  const row = world.db.only();
  assert.equal(row.status, "settled");
  assert.ok(row.settledAt instanceof Date);
  assert.equal(world.db.balances.size, 0, "a served payment is never returned");
});

test("verified and served is never returned, whatever the chain says and however old it is", async () => {
  for (const fate of ["unknown", "in_flight", "dead", "landed_failed"] as SignatureFate[]) {
    const world = makeWorld();
    const id = await verified(world);
    await markX402Served(id, world.deps);
    world.nowMs += 24 * 60 * MINUTE;
    world.fates = [fate];
    assert.equal(await run(world), "waiting", fate);
    assert.equal(world.db.only().status, "verified");
    assert.equal(world.db.only().refundedAt, null);
    assert.equal(world.db.balances.size, 0);
  }
});

test("verified and not served: left alone for ten minutes, then returned (the process died mid-request)", async () => {
  const world = makeWorld();
  await verified(world, 12_000n);
  const verifiedAt = world.db.only().verifiedAt!.getTime();

  world.nowMs = verifiedAt + X402_UNSERVED_AFTER_MS - 1;
  assert.equal(await run(world), "waiting");
  assert.equal(world.db.only().status, "verified");
  assert.equal(world.db.balances.size, 0);

  world.nowMs = verifiedAt + X402_UNSERVED_AFTER_MS;
  assert.equal(await run(world), "returned");
  assert.equal(world.db.only().status, "refunded");
  assert.deepEqual(world.db.balances.get("org-1"), { balanceCents: 1n, x402RefundCarryMicroUsd: 2_000n });
  assert.equal(world.fateReads, 0, "it had already landed: the chain is not asked again");
});

test("a request that answers just as the worker gives up on it: served or returned, never both", async () => {
  for (let round = 0; round < 6; round += 1) {
    const world = makeWorld();
    const id = await verified(world);
    world.nowMs += X402_UNSERVED_AFTER_MS;
    const stale = world.db.only();
    const racers = [
      () => markX402Served(id, world.deps),
      () => settleX402Row(stale, world.settlementDeps).then((o) => o === "returned"),
    ];
    if (round % 2 === 1) racers.reverse();
    const [a, b] = await Promise.all(racers.map((r) => r()));
    assert.notEqual(a, b, `round ${round}`);
    const row = world.db.only();
    assert.ok((row.servedAt !== null) !== (row.refundedAt !== null));
  }
});

test("rows the worker has no business with are skipped untouched", async () => {
  const world = makeWorld();
  await verified(world);
  for (const status of ["pending", "failed", "settled", "refunded"]) {
    const row = { ...world.db.only(), status };
    world.db.payments.set(row.id, row);
    world.db.writes.length = 0;
    world.nowMs += 60 * MINUTE;
    assert.equal(await run(world), "skipped", status);
    assert.deepEqual(world.db.writes, []);
  }
  assert.equal(world.fateReads, 0);
});

test("a submitted row is never decided with broadcasting off: nothing is read from the chain", async () => {
  const world = makeWorld();
  await submitted(world);
  world.settings = { ...world.settings, submitTransactions: false };
  world.nowMs += 60 * MINUTE;
  world.fates = ["dead"];
  assert.equal(await run(world), "waiting");
  assert.equal(world.fateReads, 0);
  assert.equal(world.db.only().status, "submitted");
});

test("a node on another chain decides nothing: its 'never landed' fails no payment and its silence settles none", async () => {
  // Sent, and old enough to be called dead: the wrong chain has no record of it.
  const world = makeWorld();
  await submitted(world);
  world.nowMs += 60 * MINUTE;
  world.fates = ["dead"];
  world.clusterOk = false;
  world.db.writes.length = 0;
  for (let i = 0; i < 5; i += 1) assert.equal(await run(world), "waiting");
  assert.equal(world.fateReads, 0, "the chain is not read through that node");
  assert.equal(world.db.only().status, "submitted");
  assert.deepEqual(world.db.writes, []);

  // The right node again: the payment had landed, and it goes back.
  world.clusterOk = true;
  world.fates = ["landed_ok"];
  assert.equal(await run(world), "returned");

  // A served row is not settled through it either.
  const other = makeWorld();
  const id = await verified(other);
  await markX402Served(id, other.deps);
  other.clusterOk = false;
  other.fates = [{ fate: "landed_ok", confirmationStatus: "finalized" }];
  assert.equal(await run(other), "waiting");
  assert.equal(other.fateReads, 0);
  assert.equal(other.db.only().status, "verified");
});

test("the run's cluster check is asked once, a throw is 'not ok', and a wrong chain is remembered for the run", async () => {
  const { buildX402SettlementDeps } = await import("../services/x402Settlement.js");
  let asked = 0;
  const wrong = buildX402SettlementDeps(async () => {
    asked += 1;
    return { ok: false };
  });
  assert.equal(await wrong.clusterOk(), false);
  assert.equal(await wrong.clusterOk(), false);
  assert.equal(asked, 1);

  const broken = buildX402SettlementDeps(async () => {
    throw new Error("RPC-NODE-SAID: connection refused");
  });
  assert.equal(await broken.clusterOk(), false);

  const right = buildX402SettlementDeps(async () => ({ ok: true }));
  assert.equal(await right.clusterOk(), true);
});

// ============================================
// The run itself, bound to Prisma
// ============================================

test("a run takes only open rows of this chain, with no count of attempts, and every write names the status it expects", async () => {
  const [{ runX402SettlementTick, getX402SettlementWorkerMetrics }, { env }, { prisma }] = await Promise.all([
    import("../services/x402Settlement.js"),
    import("../config/env.js"),
    import("@wheelsai/db"),
  ]);
  const prismaAny = prisma as any;
  const saved = {
    x402Payment: prismaAny.x402Payment,
    creditBalance: prismaAny.creditBalance,
    creditTransaction: prismaAny.creditTransaction,
    transaction: prismaAny.$transaction,
    executeRaw: prismaAny.$executeRaw,
    submit: (env as any).X402_SUBMIT_TRANSACTIONS,
    webhook: (env as any).X402_ALERT_WEBHOOK_URL,
  };
  // Nothing is read from the chain in this test: broadcasting is off.
  (env as any).X402_SUBMIT_TRANSACTIONS = false;
  (env as any).X402_ALERT_WEBHOOK_URL = undefined;

  const now = Date.now();
  const rows = [
    // Served: settled at once in this mode.
    { id: "served", status: "verified", servedAt: new Date(now), verifiedAt: new Date(now) },
    // Landed eleven minutes ago and never served: returned.
    { id: "died", status: "verified", servedAt: null, verifiedAt: new Date(now - 11 * MINUTE) },
    // Landed a minute ago, still being served: left.
    { id: "running", status: "verified", servedAt: null, verifiedAt: new Date(now - MINUTE) },
  ].map((row) => ({
    txSignature: `sig_${row.id}`,
    recentBlockhash: "hash",
    refundedAt: null,
    submittedAt: null,
    createdAt: row.verifiedAt,
    ...row,
  }));
  let findManyArgs: any = null;
  const updates: Array<{ where: any; data: any }> = [];
  const balance = { balanceCents: 0n, x402RefundCarryMicroUsd: 0n };
  const ledger: any[] = [];

  const x402Payment = {
    findMany: async (args: any) => {
      findManyArgs = args;
      return rows;
    },
    findUnique: async () => ({
      id: "died",
      orgId: "org-1",
      asset: "USDC",
      amountReceivedRaw: "25000",
      solMicroUsdPerSol: null,
    }),
    updateMany: async ({ where, data }: any) => {
      updates.push({ where, data });
      return { count: 1 };
    },
    groupBy: async () => [],
    count: async () => 0,
    findFirst: async () => null,
  };
  prismaAny.x402Payment = x402Payment;
  const tx = {
    x402Payment,
    creditBalance: {
      upsert: async ({ update }: any) => {
        balance.x402RefundCarryMicroUsd += update.x402RefundCarryMicroUsd.increment;
        return { ...balance };
      },
      update: async ({ data }: any) => {
        balance.balanceCents += data.balanceCents.increment;
        balance.x402RefundCarryMicroUsd -= data.x402RefundCarryMicroUsd.decrement;
        return { ...balance };
      },
    },
    creditTransaction: {
      create: async ({ data }: any) => {
        ledger.push(data);
        return data;
      },
    },
  };
  prismaAny.$transaction = async (fn: any) => fn(tx);
  prismaAny.$executeRaw = async () => 0;

  try {
    const before = getX402SettlementWorkerMetrics();
    await runX402SettlementTick();
    const after = getX402SettlementWorkerMetrics();

    assert.deepEqual(findManyArgs.where, {
      status: { in: ["submitted", "verified"] },
      network: "solana:devnet",
    });
    assert.equal(JSON.stringify(findManyArgs).includes("retryCount"), false);

    assert.equal(after.settled - before.settled, 1);
    assert.equal(after.returned - before.returned, 1);
    assert.equal(after.retried - before.retried, 1);
    assert.equal(after.failed - before.failed, 0);
    assert.equal(after.processed - before.processed, 3);

    const settled = updates.find((u) => u.data.status === "settled")!;
    assert.deepEqual(settled.where, {
      id: "served",
      status: "verified",
      servedAt: { not: null },
      refundedAt: null,
    });
    const refunded = updates.find((u) => u.data.status === "refunded")!;
    assert.deepEqual(refunded.where, {
      id: "died",
      status: { in: ["verified"] },
      servedAt: null,
      refundedAt: null,
    });
    assert.equal(refunded.data.refundMicroUsd, 25_000n);
    assert.equal(updates.length, 2, "the row still being served was not written to");
    assert.deepEqual(balance, { balanceCents: 2n, x402RefundCarryMicroUsd: 5_000n });
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].type, "x402_refund");
    assert.equal(ledger[0].referenceId, "died");
    for (const update of updates) {
      assert.equal("retryCount" in update.data, false);
    }
  } finally {
    prismaAny.x402Payment = saved.x402Payment;
    prismaAny.creditBalance = saved.creditBalance;
    prismaAny.creditTransaction = saved.creditTransaction;
    prismaAny.$transaction = saved.transaction;
    prismaAny.$executeRaw = saved.executeRaw;
    (env as any).X402_SUBMIT_TRANSACTIONS = saved.submit;
    (env as any).X402_ALERT_WEBHOOK_URL = saved.webhook;
  }
});
