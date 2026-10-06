import assert from "node:assert/strict";
import test from "node:test";

import {
  InsufficientGpuCreditsError,
  chargeGpuWindow,
  computeGpuCharge,
  pricePerSecondMicroUsd,
  type GpuBillingTx,
} from "../services/gpuBilling.js";

// Drives apps/api/src/services/gpuBilling.ts - per-second GPU billing math and
// the CAS -> conditional decrement -> ledger transaction. Uses an in-memory
// database with real transaction rollback, so "the cursor rolls back when the
// org cannot pay" is actually exercised.

const T0 = new Date("2026-09-30T10:00:00.000Z");
const at = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

// Retail USD/second per replica used across the tests (== MARKETS).
const PRICE: Record<string, number> = {
  "3060": 0.0001,
  "4070": 0.00015,
  "4090": 0.00025,
  a100: 0.0008,
  h100: 0.0015,
};
const priceOf = (tier: string) => PRICE[tier] ?? 0;

// ============================================
// price conversion
// ============================================

test("pricePerSecondMicroUsd converts USD/second to exact integer micro-dollars", () => {
  assert.equal(pricePerSecondMicroUsd(0.0001), 100n);
  assert.equal(pricePerSecondMicroUsd(0.00015), 150n);
  assert.equal(pricePerSecondMicroUsd(0.00025), 250n);
  assert.equal(pricePerSecondMicroUsd(0.0008), 800n);
  assert.equal(pricePerSecondMicroUsd(0.0015), 1500n);
  assert.equal(pricePerSecondMicroUsd(0), 0n);
  assert.throws(() => pricePerSecondMicroUsd(-1), RangeError);
  assert.throws(() => pricePerSecondMicroUsd(Number.NaN), RangeError);
});

// ============================================
// computeGpuCharge - exact cents
// ============================================

const FROM = T0.getTime();

test("4090 for 60s: exactly 1 whole cent, and the cursor advances only the 40s that cent pays for", () => {
  // 250 uUSD/s x 60 s = 15,000 uUSD = 1.5 cents -> bill 1, carry the half cent.
  const c = computeGpuCharge({
    rateMicroUsdPerSecondPerReplica: 250n,
    replicas: 1,
    fromMs: FROM,
    toMs: FROM + 60_000,
    rounding: "floor",
  });
  assert.equal(c.cents, 1n);
  assert.equal(c.coveredMs, 40_000);
  assert.equal(c.newCursorMs, FROM + 40_000);
  assert.equal(c.elapsedMs, 60_000);
});

test("a sub-cent window bills nothing and leaves the cursor where it is", () => {
  // 3060: 100 uUSD/s x 60 s = 6,000 uUSD = 0.6 cent
  const c = computeGpuCharge({
    rateMicroUsdPerSecondPerReplica: 100n,
    replicas: 1,
    fromMs: FROM,
    toMs: FROM + 60_000,
    rounding: "floor",
  });
  assert.equal(c.cents, 0n);
  assert.equal(c.coveredMs, 0);
  assert.equal(c.newCursorMs, FROM);
});

test("replicas multiply the rate", () => {
  // 4090 x2 for 60 s = 30,000 uUSD = exactly 3 cents, all 60 s covered.
  const c = computeGpuCharge({
    rateMicroUsdPerSecondPerReplica: 250n,
    replicas: 2,
    fromMs: FROM,
    toMs: FROM + 60_000,
    rounding: "floor",
  });
  assert.equal(c.cents, 3n);
  assert.equal(c.coveredMs, 60_000);
});

test("final settlement rounds the last partial cent UP and covers the whole window", () => {
  // 4090 for 30 s = 7,500 uUSD = 0.75 cent -> 1 cent, cursor to the stop time.
  const c = computeGpuCharge({
    rateMicroUsdPerSecondPerReplica: 250n,
    replicas: 1,
    fromMs: FROM,
    toMs: FROM + 30_000,
    rounding: "ceil",
  });
  assert.equal(c.cents, 1n);
  assert.equal(c.coveredMs, 30_000);
  assert.equal(c.newCursorMs, FROM + 30_000);
});

test("sub-second windows bill nothing; a non-positive window is empty", () => {
  const base = { rateMicroUsdPerSecondPerReplica: 250n, replicas: 1, fromMs: FROM, rounding: "floor" as const };
  assert.equal(computeGpuCharge({ ...base, toMs: FROM + 999 }).coveredMs, 0);
  assert.equal(computeGpuCharge({ ...base, toMs: FROM }).cents, 0n);
  assert.equal(computeGpuCharge({ ...base, toMs: FROM - 5_000 }).cents, 0n, "clock skew never bills backwards");
});

test("a free tier advances the cursor without charging", () => {
  const c = computeGpuCharge({
    rateMicroUsdPerSecondPerReplica: 0n,
    replicas: 3,
    fromMs: FROM,
    toMs: FROM + 120_000,
    rounding: "floor",
  });
  assert.equal(c.cents, 0n);
  assert.equal(c.coveredMs, 120_000);
});

test("invalid replicas are rejected", () => {
  for (const replicas of [0, -1, 1.5]) {
    assert.throws(
      () =>
        computeGpuCharge({
          rateMicroUsdPerSecondPerReplica: 1n,
          replicas,
          fromMs: 0,
          toMs: 1000,
          rounding: "floor",
        }),
      RangeError,
    );
  }
});

test("billing every minute for an hour charges the hour's cost (no per-tick rounding drift)", () => {
  // The point of carrying the sub-cent remainder in the cursor: rounding each
  // 1-minute window would be off by up to a third.
  const cases: Array<[tier: string, replicas: number, expectedCents: bigint, exact: boolean]> = [
    ["4090", 1, 90n, true], // 0.00025 x 3600 = $0.90
    ["3060", 1, 36n, true], // 0.0001  x 3600 = $0.36
    ["a100", 1, 288n, true], // 0.0008  x 3600 = $2.88 (1 cent = 12.5 s: needs ms resolution)
    ["h100", 2, 1080n, true], // 0.0015  x 3600 x 2 = $10.80
    ["4070", 1, 54n, false], // 0.00015 x 3600 = $0.54 (1 cent = 66.666.. s)
  ];
  for (const [tier, replicas, expectedCents, exact] of cases) {
    let cursor = FROM;
    let total = 0n;
    for (let minute = 1; minute <= 60; minute += 1) {
      const c = computeGpuCharge({
        rateMicroUsdPerSecondPerReplica: pricePerSecondMicroUsd(priceOf(tier)),
        replicas,
        fromMs: cursor,
        toMs: FROM + minute * 60_000,
        rounding: "floor",
      });
      total += c.cents;
      cursor = c.newCursorMs;
    }
    if (exact) {
      assert.equal(total, expectedCents, `${tier} x${replicas} for one hour`);
    } else {
      // Non-terminating cent: the cursor rounds up by < 1 ms per tick, so the
      // very last cent may land one tick late - but never early, never over.
      assert.ok(
        total <= expectedCents && total >= expectedCents - 1n,
        `${tier} x${replicas}: ${total} vs ${expectedCents}`,
      );
    }
  }
});

test("property: the org is never charged for time the cursor did not advance over", () => {
  // cents x 10_000 x 1000 <= rate x coveredMs, and coveredMs <= elapsed.
  for (const rate of [1n, 7n, 100n, 150n, 250n, 800n, 1500n, 9999n, 10_000n, 15_000n, 123_456n]) {
    for (const replicas of [1, 2, 3, 10]) {
      for (const elapsed of [1, 2, 3, 29, 60, 61, 119, 600, 3599, 86_400]) {
        const c = computeGpuCharge({
          rateMicroUsdPerSecondPerReplica: rate,
          replicas,
          fromMs: FROM,
          toMs: FROM + elapsed * 1000,
          rounding: "floor",
        });
        const fullRate = rate * BigInt(replicas);
        assert.ok(c.coveredMs <= elapsed * 1000, `covered<=elapsed (${rate}x${replicas}/${elapsed}s)`);
        // cents x 10,000 uUSD <= (uUSD/s) x (covered ms / 1000)
        assert.ok(
          c.cents * 10_000n * 1000n <= fullRate * BigInt(c.coveredMs),
          `never over-charged (${rate}x${replicas}/${elapsed}s)`,
        );
        if (c.cents > 0n) {
          assert.ok(c.coveredMs > 0, "a charge always advances the cursor");
        }
      }
    }
  }
});

// ============================================
// chargeGpuWindow - the transaction
// ============================================

interface DepRow {
  id: string;
  orgId: string;
  status: string;
  replicas: number;
  billedThroughAt: Date | null;
  reservationCents: bigint | null;
  reservationReleasedAt: Date | null;
}
interface DbState {
  deployments: DepRow[];
  balances: Record<string, bigint>;
  ledger: Array<{ orgId: string; amountCents: bigint; type: string; referenceId: string; balanceAfter: bigint; description: string }>;
}

function makeTxDb(initial: { deployment: Partial<DepRow>; balance: bigint }) {
  const state: DbState = {
    deployments: [
      {
        id: "dep_1",
        orgId: "org_1",
        status: "running",
        replicas: 1,
        billedThroughAt: T0,
        reservationCents: null,
        reservationReleasedAt: null,
        ...initial.deployment,
      },
    ],
    balances: { org_1: initial.balance },
    ledger: [],
  };
  const sameDate = (a: Date | null, b: Date | null) =>
    a === null || b === null ? a === b : a.getTime() === b.getTime();

  const tx: GpuBillingTx = {
    deployment: {
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const d of state.deployments) {
          if (
            d.id === where.id &&
            (where.status === undefined || d.status === where.status) &&
            (where.replicas === undefined || d.replicas === where.replicas) &&
            sameDate(d.billedThroughAt, where.billedThroughAt)
          ) {
            d.billedThroughAt = data.billedThroughAt;
            count += 1;
          }
        }
        return { count };
      },
    },
    creditBalance: {
      updateMany: async ({ where, data }) => {
        const bal = state.balances[where.orgId] ?? 0n;
        if (bal < where.balanceCents.gte) return { count: 0 };
        state.balances[where.orgId] = bal - data.balanceCents.decrement;
        return { count: 1 };
      },
      findUnique: async ({ where }) => ({ balanceCents: state.balances[where.orgId] ?? 0n }),
    },
    creditTransaction: {
      create: async ({ data }) => {
        state.ledger.push({ ...data });
        return {};
      },
    },
  };

  // A real transaction: the whole callback is undone if it throws.
  const transaction = async <T>(fn: (t: GpuBillingTx) => Promise<T>): Promise<T> => {
    const snapshot = structuredClone(state);
    try {
      return await fn(tx);
    } catch (err) {
      state.deployments = snapshot.deployments;
      state.balances = snapshot.balances;
      state.ledger = snapshot.ledger;
      throw err;
    }
  };
  return { state, tx, transaction };
}

const baseArgs = {
  deploymentId: "dep_1",
  orgId: "org_1",
  gpuTier: "4090",
  replicas: 1,
  pricePerSecondUsd: priceOf,
};

test("chargeGpuWindow: debits exact cents, advances the cursor by the covered time, writes a gpu_usage ledger row", async () => {
  const db = makeTxDb({ deployment: {}, balance: 500n });
  const out = await chargeGpuWindow(db.tx, {
    ...baseArgs,
    billedThroughAt: T0,
    now: at(T0, 100), // 100 s x 250 uUSD = 25,000 uUSD = 2.5 cents -> 2 cents, 80 s covered
    mode: "tick",
  });

  assert.equal(out.kind, "charged");
  assert.ok(out.kind === "charged");
  assert.equal(out.cents, 2n);
  assert.equal(out.coveredSeconds, 80);
  assert.equal(out.balanceAfter, 498n);
  assert.equal(db.state.balances.org_1, 498n);
  assert.deepEqual(db.state.deployments[0]!.billedThroughAt, at(T0, 80));
  assert.equal(db.state.ledger.length, 1);
  const row = db.state.ledger[0]!;
  assert.equal(row.type, "gpu_usage");
  assert.equal(row.referenceId, "dep_1");
  assert.equal(row.amountCents, -2n);
  assert.equal(row.balanceAfter, 498n, "balanceAfter is read inside the same transaction");
  assert.equal(row.orgId, "org_1");
});

test("chargeGpuWindow: a sub-cent window writes nothing at all", async () => {
  const db = makeTxDb({ deployment: {}, balance: 500n });
  const out = await chargeGpuWindow(db.tx, {
    ...baseArgs,
    gpuTier: "3060",
    billedThroughAt: T0,
    now: at(T0, 30),
    mode: "tick",
  });
  assert.deepEqual(out, { kind: "nothing_to_bill" });
  assert.equal(db.state.balances.org_1, 500n);
  assert.equal(db.state.ledger.length, 0);
  assert.deepEqual(db.state.deployments[0]!.billedThroughAt, T0, "cursor untouched");
});

test("chargeGpuWindow: a lost cursor CAS bills NOTHING (a concurrent tick already billed the window)", async () => {
  // The row's cursor is already at T0+80; the caller still holds T0.
  const db = makeTxDb({ deployment: { billedThroughAt: at(T0, 80) }, balance: 500n });
  const out = await chargeGpuWindow(db.tx, {
    ...baseArgs,
    billedThroughAt: T0,
    now: at(T0, 100),
    mode: "tick",
  });
  assert.deepEqual(out, { kind: "cursor_lost" });
  assert.equal(db.state.balances.org_1, 500n, "no debit");
  assert.equal(db.state.ledger.length, 0, "no ledger row");
});

test("chargeGpuWindow: only a RUNNING deployment is billed in tick mode", async () => {
  const db = makeTxDb({ deployment: { status: "stopped" }, balance: 500n });
  const out = await chargeGpuWindow(db.tx, {
    ...baseArgs,
    billedThroughAt: T0,
    now: at(T0, 100),
    mode: "tick",
  });
  assert.deepEqual(out, { kind: "cursor_lost" });
  assert.equal(db.state.balances.org_1, 500n);
});

test("chargeGpuWindow: an org that cannot pay throws and the WHOLE transaction (cursor too) rolls back", async () => {
  const db = makeTxDb({ deployment: {}, balance: 1n }); // owes 2 cents, has 1
  await assert.rejects(
    () =>
      db.transaction((tx) =>
        chargeGpuWindow(tx, {
          ...baseArgs,
          billedThroughAt: T0,
          now: at(T0, 100),
          mode: "tick",
        }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof InsufficientGpuCreditsError);
      assert.equal(err.deploymentId, "dep_1");
      assert.equal(err.requiredCents, 2n);
      return true;
    },
  );
  assert.equal(db.state.balances.org_1, 1n, "the balance never goes negative");
  assert.deepEqual(db.state.deployments[0]!.billedThroughAt, T0, "cursor rolled back: nothing was billed");
  assert.equal(db.state.ledger.length, 0);
});

test("chargeGpuWindow: the balance can be drained to exactly zero but never below", async () => {
  const db = makeTxDb({ deployment: {}, balance: 2n });
  const out = await chargeGpuWindow(db.tx, { ...baseArgs, billedThroughAt: T0, now: at(T0, 100), mode: "tick" });
  assert.ok(out.kind === "charged");
  assert.equal(db.state.balances.org_1, 0n);
});

test("final mode: rounds up, takes what the org has, and reports the shortfall", async () => {
  const db = makeTxDb({ deployment: { status: "stopped" }, balance: 1n });
  const out = await chargeGpuWindow(db.tx, {
    ...baseArgs,
    billedThroughAt: T0,
    now: at(T0, 100), // ceil(2.5) = 3 cents owed
    mode: "final",
  });
  assert.ok(out.kind === "charged");
  assert.equal(out.cents, 1n, "charged what the org had");
  assert.equal(out.shortfallCents, 2n);
  assert.equal(db.state.balances.org_1, 0n);
  assert.equal(db.state.ledger[0]!.amountCents, -1n);
  assert.match(db.state.ledger[0]!.description, /final/);
  assert.deepEqual(db.state.deployments[0]!.billedThroughAt, at(T0, 100), "cursor reaches the stop time");
});

test("final mode with a full balance charges the rounded-up amount", async () => {
  const db = makeTxDb({ deployment: { status: "stopped" }, balance: 100n });
  const out = await chargeGpuWindow(db.tx, { ...baseArgs, billedThroughAt: T0, now: at(T0, 100), mode: "final" });
  assert.ok(out.kind === "charged");
  assert.equal(out.cents, 3n);
  assert.equal(out.shortfallCents, 0n);
  assert.equal(db.state.balances.org_1, 97n);
});

test("final mode also respects the cursor CAS (a concurrent tick billing the same window wins once)", async () => {
  const db = makeTxDb({ deployment: { status: "stopped", billedThroughAt: at(T0, 50) }, balance: 100n });
  const out = await chargeGpuWindow(db.tx, { ...baseArgs, billedThroughAt: T0, now: at(T0, 100), mode: "final" });
  assert.deepEqual(out, { kind: "cursor_lost" });
  assert.equal(db.state.balances.org_1, 100n);
});

test("two billing ticks that read the SAME cursor cannot both bill the window", async () => {
  // Interleaved like two workers: both loaded cursor T0, both try to charge.
  // Transactions serialise (a row lock in Postgres); the loser's CAS matches
  // zero rows.
  const db = makeTxDb({ deployment: {}, balance: 1000n });
  let chain: Promise<unknown> = Promise.resolve();
  const serialised = <T>(fn: (t: GpuBillingTx) => Promise<T>): Promise<T> => {
    const run = chain.then(() => db.transaction(fn));
    chain = run.catch(() => undefined);
    return run;
  };
  const args = { ...baseArgs, billedThroughAt: T0, now: at(T0, 100), mode: "tick" as const };
  const [a, b] = await Promise.all([
    serialised((tx) => chargeGpuWindow(tx, args)),
    serialised((tx) => chargeGpuWindow(tx, args)),
  ]);
  const kinds = [a.kind, b.kind].sort();
  assert.deepEqual(kinds, ["charged", "cursor_lost"]);
  assert.equal(db.state.balances.org_1, 998n, "billed once: 2 cents, not 4");
  assert.equal(db.state.ledger.length, 1);
});

// ============================================
// Review #6: the cursor CAS includes the replica count
// ============================================

test("a window billed at a stale replica count LOSES the CAS and bills nothing (review #6)", async () => {
  // The tick loaded replicas=2; a PATCH changed the row to 3 before it charged.
  const db = makeTxDb({ deployment: { replicas: 3 }, balance: 500n });
  const out = await chargeGpuWindow(db.tx, {
    ...baseArgs,
    replicas: 2,
    billedThroughAt: T0,
    now: at(T0, 100),
    mode: "tick",
  });
  assert.deepEqual(out, { kind: "cursor_lost" });
  assert.equal(db.state.balances.org_1, 500n);
  assert.equal(db.state.ledger.length, 0);
  assert.deepEqual(db.state.deployments[0]!.billedThroughAt, T0, "untouched: re-read and billed next tick at the real count");
});

test("the CAS is issued with the replica count in every mode", async () => {
  for (const mode of ["tick", "settle", "final"] as const) {
    const wheres: any[] = [];
    const db = makeTxDb({ deployment: {}, balance: 500n });
    const inner = db.tx.deployment.updateMany;
    db.tx.deployment.updateMany = async (args) => {
      wheres.push(args.where);
      return inner(args);
    };
    await chargeGpuWindow(db.tx, { ...baseArgs, replicas: 1, billedThroughAt: T0, now: at(T0, 100), mode });
    assert.equal(wheres[0].replicas, 1, mode);
  }
});

// ============================================
// Review #5: "settle" mode (status worker edges)
// ============================================

test("settle mode: floor rounding, no status requirement, and it is labelled in the ledger", async () => {
  // The row is already `degraded`/`stopped` in another statement of the same transaction.
  const db = makeTxDb({ deployment: { status: "degraded" }, balance: 500n });
  const out = await chargeGpuWindow(db.tx, {
    ...baseArgs,
    billedThroughAt: T0,
    now: at(T0, 100), // 2.5 cents -> floor 2 (NOT 3 as final would)
    mode: "settle",
  });
  assert.ok(out.kind === "charged");
  assert.equal(out.cents, 2n);
  assert.equal(out.coveredSeconds, 80);
  assert.deepEqual(db.state.deployments[0]!.billedThroughAt, at(T0, 80));
  assert.match(db.state.ledger[0]!.description, /settled/);
  assert.doesNotMatch(db.state.ledger[0]!.description, /final/);
});

test("settle mode takes what the org has and NEVER throws (the deployment is leaving service anyway)", async () => {
  const db = makeTxDb({ deployment: {}, balance: 1n });
  const out = await chargeGpuWindow(db.tx, { ...baseArgs, billedThroughAt: T0, now: at(T0, 100), mode: "settle" });
  assert.ok(out.kind === "charged");
  assert.equal(out.cents, 1n);
  assert.equal(out.shortfallCents, 1n);
  assert.equal(db.state.balances.org_1, 0n);

  const broke = makeTxDb({ deployment: {}, balance: 0n });
  const none = await chargeGpuWindow(broke.tx, { ...baseArgs, billedThroughAt: T0, now: at(T0, 100), mode: "settle" });
  assert.ok(none.kind === "charged");
  assert.equal(none.cents, 0n);
  assert.equal(broke.state.ledger.length, 0, "no zero-value ledger row");
});

test("settle mode is still cursor-CAS guarded: a window already billed past `now` bills nothing", async () => {
  const db = makeTxDb({ deployment: { billedThroughAt: at(T0, 200) }, balance: 500n });
  const out = await chargeGpuWindow(db.tx, { ...baseArgs, billedThroughAt: at(T0, 200), now: at(T0, 100), mode: "settle" });
  assert.deepEqual(out, { kind: "nothing_to_bill" });
  assert.equal(db.state.balances.org_1, 500n);
});

// ============================================
// "replica_change": closing the window at the OLD count when a change commits
// ============================================

test("replica_change closes the WHOLE window at the old count: rounded up, cursor at now, nothing left for the new rate", async () => {
  // The replica change has already written the new count (claim first, bill
  // second), so the cursor CAS must match the row's NEW count while the charge
  // is computed at the OLD one.
  const db = makeTxDb({ deployment: { replicas: 10 }, balance: 500n });
  const out = await chargeGpuWindow(db.tx, {
    ...baseArgs,
    replicas: 1,
    rowReplicas: 10,
    billedThroughAt: T0,
    now: at(T0, 30), // 30 s x1 = 0.75 cents: "tick" mode would bill nothing and leave the cursor
    mode: "replica_change",
  });
  assert.ok(out.kind === "charged");
  assert.equal(out.cents, 1n);
  assert.deepEqual(db.state.deployments[0]!.billedThroughAt, at(T0, 30));
  assert.match(db.state.ledger[0]!.description, /4090 x1, 30s, before replica change/);

  // The next tick, at the new count, starts exactly at the change.
  const next = await chargeGpuWindow(db.tx, {
    ...baseArgs,
    replicas: 10,
    billedThroughAt: at(T0, 30),
    now: at(T0, 34), // 4 s x10 = exactly 1 cent
    mode: "tick",
  });
  assert.ok(next.kind === "charged");
  assert.equal(next.cents, 1n);
});

test("replica_change without rowReplicas, or against a row that holds another count, loses the cursor CAS", async () => {
  const db = makeTxDb({ deployment: { replicas: 10 }, balance: 500n });
  const args = { ...baseArgs, replicas: 1, billedThroughAt: T0, now: at(T0, 100), mode: "replica_change" as const };
  assert.deepEqual(await chargeGpuWindow(db.tx, args), { kind: "cursor_lost" });
  assert.deepEqual(await chargeGpuWindow(db.tx, { ...args, rowReplicas: 3 }), { kind: "cursor_lost" });
  assert.equal(db.state.ledger.length, 0);
  assert.equal(db.state.balances.org_1, 500n);
});

test("replica_change takes what the org has (Nosana already applied the change) and reports the shortfall", async () => {
  const db = makeTxDb({ deployment: { replicas: 2 }, balance: 1n });
  const out = await chargeGpuWindow(db.tx, {
    ...baseArgs,
    replicas: 1,
    rowReplicas: 2,
    billedThroughAt: T0,
    now: at(T0, 100), // 2.5 -> 3 cents
    mode: "replica_change",
  });
  assert.ok(out.kind === "charged");
  assert.equal(out.cents, 1n);
  assert.equal(out.shortfallCents, 2n);
  assert.equal(db.state.balances.org_1, 0n);
  assert.deepEqual(db.state.deployments[0]!.billedThroughAt, at(T0, 100));
});
