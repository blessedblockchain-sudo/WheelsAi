import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma } from "@prisma/client";

import {
  PLAN_WARNING_PERCENT,
  giveBackIncludedUse,
  takeIncludedUse,
  warningLevel,
  type PlanUseRead,
  type PlanUseTx,
} from "../services/planUse.js";

// The count of a plan. What these pin: of two requests for the last use one
// takes it; a use is taken only from the period and the terms that were
// read; a use is given back only into the period it was taken from and the
// count never goes below zero; and the warnings start at 85% and at 100%.

// Prisma's transaction client is accepted where the count's narrow one is asked for.
export const acceptsPrisma = (tx: Prisma.TransactionClient): PlanUseTx => tx;

const START = new Date("2026-10-01T00:00:00Z");
const NEXT_START = new Date("2026-10-31T00:00:00Z");

interface Row {
  id: string;
  status: string;
  currentPeriodStart: Date;
  includedUses: number | null;
  carriedUses: number;
  usedInPeriod: number;
}

const row = (over: Partial<Row> = {}): Row => ({
  id: "sub_1",
  status: "active",
  currentPeriodStart: START,
  includedUses: 500,
  carriedUses: 0,
  usedInPeriod: 0,
  ...over,
});

/**
 * A table of subscriptions that answers updateMany the way the database
 * does: the conditions are checked against the row as it is at that moment,
 * and the change is made in the same step.
 */
function table(rows: Row[]) {
  const statements: Array<Parameters<PlanUseTx["agentSubscription"]["updateMany"]>[0]> = [];
  const tx: PlanUseTx = {
    agentSubscription: {
      async updateMany(args) {
        statements.push(args);
        // Arrives a tick later, as a statement sent over a connection does.
        await Promise.resolve();
        const { where, data } = args;
        const matched = rows.filter(
          (r) =>
            r.id === where.id &&
            r.currentPeriodStart.getTime() === where.currentPeriodStart.getTime() &&
            (where.status === undefined || where.status.in.includes(r.status)) &&
            (where.includedUses === undefined || r.includedUses === where.includedUses) &&
            (where.carriedUses === undefined || r.carriedUses === where.carriedUses) &&
            ("lt" in where.usedInPeriod ? r.usedInPeriod < where.usedInPeriod.lt : r.usedInPeriod > where.usedInPeriod.gt),
        );
        for (const r of matched) {
          r.usedInPeriod += "increment" in data.usedInPeriod ? data.usedInPeriod.increment : -data.usedInPeriod.decrement;
        }
        return { count: matched.length };
      },
    },
  };
  return { tx, rows, statements };
}

const readOf = (r: Row): PlanUseRead => ({
  subscriptionId: r.id,
  periodStart: r.currentPeriodStart,
  includedUses: r.includedUses ?? 0,
  carriedUses: r.carriedUses,
});

// ============================================
// Taking a use
// ============================================

test("a use is taken with one conditional statement, and the answer names its period", async () => {
  const t = table([row({ usedInPeriod: 12 })]);
  const result = await takeIncludedUse(t.tx, readOf(t.rows[0]!));
  assert.deepEqual(result, { taken: true, periodStart: START });
  assert.equal(t.rows[0]!.usedInPeriod, 13);
  // The database decides: the row's state is in the condition, and nothing is read first.
  assert.deepEqual(t.statements, [
    {
      where: {
        id: "sub_1",
        currentPeriodStart: START,
        status: { in: ["active", "past_due"] },
        includedUses: 500,
        carriedUses: 0,
        usedInPeriod: { lt: 500 },
      },
      data: { usedInPeriod: { increment: 1 } },
    },
  ]);
});

test("two takers for the last use: exactly one wins", async () => {
  const t = table([row({ usedInPeriod: 499 })]);
  // Both read the row with one use left.
  const read = readOf(t.rows[0]!);
  const results = await Promise.all([takeIncludedUse(t.tx, read), takeIncludedUse(t.tx, read)]);
  assert.deepEqual(results.map((r) => r.taken).sort(), [false, true]);
  assert.equal(t.rows[0]!.usedInPeriod, 500);
  // And nobody after them.
  assert.deepEqual(await takeIncludedUse(t.tx, read), { taken: false });
  assert.equal(t.rows[0]!.usedInPeriod, 500);
});

test("many takers never take more than the plan includes", async () => {
  const t = table([row({ includedUses: 5, usedInPeriod: 2 })]);
  const read = readOf(t.rows[0]!);
  const results = await Promise.all(Array.from({ length: 20 }, () => takeIncludedUse(t.tx, read)));
  assert.equal(results.filter((r) => r.taken).length, 3);
  assert.equal(t.rows[0]!.usedInPeriod, 5);
});

test("a take against a row whose period start has moved takes nothing", async () => {
  const t = table([row({ usedInPeriod: 40 })]);
  const read = readOf(t.rows[0]!);
  // The renewal ran between the read and the take: a new period, the count at zero.
  t.rows[0]!.currentPeriodStart = NEXT_START;
  t.rows[0]!.usedInPeriod = 0;
  assert.deepEqual(await takeIncludedUse(t.tx, read), { taken: false });
  assert.equal(t.rows[0]!.usedInPeriod, 0);
  // Read again, it takes one from the new period.
  assert.deepEqual(await takeIncludedUse(t.tx, readOf(t.rows[0]!)), { taken: true, periodStart: NEXT_START });
  assert.equal(t.rows[0]!.usedInPeriod, 1);
});

test("a take against terms that changed since the read takes nothing", async () => {
  // A smaller count than the one read: the limit worked out from the read is not the row's.
  const smaller = table([row({ includedUses: 500, usedInPeriod: 100 })]);
  const readBig = readOf(smaller.rows[0]!);
  smaller.rows[0]!.includedUses = 50;
  assert.deepEqual(await takeIncludedUse(smaller.tx, readBig), { taken: false });
  assert.equal(smaller.rows[0]!.usedInPeriod, 100);

  // Carried uses that are gone.
  const carried = table([row({ includedUses: 10, carriedUses: 5, usedInPeriod: 12 })]);
  const readCarried = readOf(carried.rows[0]!);
  carried.rows[0]!.carriedUses = 0;
  assert.deepEqual(await takeIncludedUse(carried.tx, readCarried), { taken: false });
  assert.equal(carried.rows[0]!.usedInPeriod, 12);

  // A row that is no longer a plan at all.
  const none = table([row({ usedInPeriod: 1 })]);
  const readPlan = readOf(none.rows[0]!);
  none.rows[0]!.includedUses = null;
  assert.deepEqual(await takeIncludedUse(none.tx, readPlan), { taken: false });
});

test("a use is taken only from a subscription that is open, and only from its own row", async () => {
  for (const status of ["cancelled", "expired"]) {
    const t = table([row({ status })]);
    assert.deepEqual(await takeIncludedUse(t.tx, readOf(t.rows[0]!)), { taken: false }, status);
    assert.equal(t.rows[0]!.usedInPeriod, 0);
  }
  // A renewal that is being retried: the buyer keeps what was left of the count.
  const grace = table([row({ status: "past_due", usedInPeriod: 498 })]);
  assert.equal((await takeIncludedUse(grace.tx, readOf(grace.rows[0]!))).taken, true);

  const two = table([row({ id: "sub_1", usedInPeriod: 500 }), row({ id: "sub_2", usedInPeriod: 3 })]);
  assert.deepEqual(await takeIncludedUse(two.tx, readOf(two.rows[0]!)), { taken: false });
  assert.equal(two.rows[1]!.usedInPeriod, 3);
  assert.equal((await takeIncludedUse(two.tx, readOf(two.rows[1]!))).taken, true);
  assert.deepEqual(two.rows.map((r) => r.usedInPeriod), [500, 4]);
});

test("carried uses extend the limit", async () => {
  const t = table([row({ includedUses: 10, carriedUses: 3, usedInPeriod: 10 })]);
  const read = readOf(t.rows[0]!);
  for (const used of [11, 12, 13]) {
    assert.equal((await takeIncludedUse(t.tx, read)).taken, true);
    assert.equal(t.rows[0]!.usedInPeriod, used);
  }
  assert.deepEqual(await takeIncludedUse(t.tx, read), { taken: false });
  assert.equal(t.rows[0]!.usedInPeriod, 13);
  // The same count without them is used up.
  const without = table([row({ includedUses: 10, carriedUses: 0, usedInPeriod: 10 })]);
  assert.deepEqual(await takeIncludedUse(without.tx, readOf(without.rows[0]!)), { taken: false });
});

// ============================================
// Giving a use back
// ============================================

test("a use that was taken and not answered is given back into its period", async () => {
  const t = table([row({ usedInPeriod: 12 })]);
  const taken = await takeIncludedUse(t.tx, readOf(t.rows[0]!));
  assert.ok(taken.taken);
  assert.equal(t.rows[0]!.usedInPeriod, 13);
  assert.deepEqual(await giveBackIncludedUse(t.tx, { subscriptionId: "sub_1", periodStart: taken.periodStart }), {
    givenBack: true,
  });
  assert.equal(t.rows[0]!.usedInPeriod, 12);
  assert.deepEqual(t.statements[1], {
    where: { id: "sub_1", currentPeriodStart: START, usedInPeriod: { gt: 0 } },
    data: { usedInPeriod: { decrement: 1 } },
  });
});

test("give back after a renewal changes nothing", async () => {
  const t = table([row({ usedInPeriod: 499 })]);
  const taken = await takeIncludedUse(t.tx, readOf(t.rows[0]!));
  assert.ok(taken.taken);
  // The renewal: a new period, and the count back at zero. Then three uses of the new period.
  t.rows[0]!.currentPeriodStart = NEXT_START;
  t.rows[0]!.usedInPeriod = 3;
  assert.deepEqual(await giveBackIncludedUse(t.tx, { subscriptionId: "sub_1", periodStart: taken.periodStart }), {
    givenBack: false,
  });
  // The new period's count is not lowered by a use it never held.
  assert.equal(t.rows[0]!.usedInPeriod, 3);
});

test("give back with the count at 0 changes nothing", async () => {
  const t = table([row({ usedInPeriod: 0 })]);
  assert.deepEqual(await giveBackIncludedUse(t.tx, { subscriptionId: "sub_1", periodStart: START }), {
    givenBack: false,
  });
  assert.equal(t.rows[0]!.usedInPeriod, 0);
});

test("a use is still given back after the subscription was cancelled, into the same period", async () => {
  const t = table([row({ usedInPeriod: 7 })]);
  const taken = await takeIncludedUse(t.tx, readOf(t.rows[0]!));
  assert.ok(taken.taken);
  t.rows[0]!.status = "cancelled";
  assert.equal((await giveBackIncludedUse(t.tx, { subscriptionId: "sub_1", periodStart: taken.periodStart })).givenBack, true);
  assert.equal(t.rows[0]!.usedInPeriod, 7);
});

// ============================================
// The warning a count is at
// ============================================

test("the warning levels at 84, 85, 99 and 100 percent", () => {
  assert.equal(PLAN_WARNING_PERCENT, 85);
  assert.equal(warningLevel(0, 100, 0), 0);
  assert.equal(warningLevel(84, 100, 0), 0);
  assert.equal(warningLevel(85, 100, 0), 85);
  assert.equal(warningLevel(99, 100, 0), 85);
  assert.equal(warningLevel(100, 100, 0), 100);
  // Past the count, on a plan that charges for each extra use.
  assert.equal(warningLevel(140, 100, 0), 100);
});

test("the warning is worked out in whole numbers, over the included and the carried uses", () => {
  // 85% of 500 is 425.
  assert.equal(warningLevel(424, 500, 0), 0);
  assert.equal(warningLevel(425, 500, 0), 85);
  assert.equal(warningLevel(499, 500, 0), 85);
  assert.equal(warningLevel(500, 500, 0), 100);
  // 85% of 7 is 5.95: five uses is not there yet, six is.
  assert.equal(warningLevel(5, 7, 0), 0);
  assert.equal(warningLevel(6, 7, 0), 85);
  // 100 included and 100 carried: 85% is 170, and all of them is 200.
  assert.equal(warningLevel(100, 100, 100), 0);
  assert.equal(warningLevel(169, 100, 100), 0);
  assert.equal(warningLevel(170, 100, 100), 85);
  assert.equal(warningLevel(200, 100, 100), 100);
  // A plan of one use.
  assert.equal(warningLevel(0, 1, 0), 0);
  assert.equal(warningLevel(1, 1, 0), 100);
});
