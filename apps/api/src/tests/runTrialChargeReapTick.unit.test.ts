import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "./unitEnv.js";
import { bindTrialChargeReapTickDeps, type TrialChargeReapPrisma } from "../services/buildTrialChargeReapTickDeps.js";
import {
  runTrialChargeReapTick,
  TRIAL_CHARGE_HELD_MAX_MS,
  TRIAL_CHARGE_REAP_BATCH,
  TRIAL_CHARGE_REAP_REASON,
} from "../services/runTrialChargeReapTick.js";

// The reaper for publisher-funded Try it messages: a charge left `held` by a
// process that died mid-chat is refunded, once. A chat still in flight is
// left alone.

const NOW = new Date("2026-10-10T12:00:00.000Z");

test("the tick asks for charges held longer than any chat can last, and refunds each once", async () => {
  const asked: Array<{ createdBefore: Date; take: number }> = [];
  const refunded: Array<[string, string]> = [];
  const result = await runTrialChargeReapTick({
    findStaleHeld: async (args) => {
      asked.push(args);
      return ["c1", "c2"];
    },
    refund: async (id, reason) => {
      refunded.push([id, reason]);
      return true;
    },
    now: () => NOW,
  });
  assert.deepEqual(asked, [
    { createdBefore: new Date(NOW.getTime() - TRIAL_CHARGE_HELD_MAX_MS), take: TRIAL_CHARGE_REAP_BATCH },
  ]);
  assert.ok(TRIAL_CHARGE_HELD_MAX_MS >= 10 * 60_000, "longer than the longest chat (AGENT_CHAT_TIMEOUT_MS max)");
  assert.deepEqual(refunded, [
    ["c1", TRIAL_CHARGE_REAP_REASON],
    ["c2", TRIAL_CHARGE_REAP_REASON],
  ]);
  assert.deepEqual(result, { scanned: 2, refunded: 2, failed: 0 });
});

test("a charge the chat resolved in the meantime is not counted as refunded; a failing refund does not stop the rest", async () => {
  const errors: unknown[] = [];
  const result = await runTrialChargeReapTick({
    findStaleHeld: async () => ["settled-meanwhile", "breaks", "stale"],
    refund: async (id) => {
      if (id === "breaks") throw new Error("db down");
      return id === "stale";
    },
    now: () => NOW,
    logger: { error: (obj) => errors.push(obj) },
  });
  assert.deepEqual(result, { scanned: 3, refunded: 1, failed: 1 });
  assert.equal(errors.length, 1);
});

test("nothing stale: nothing is refunded", async () => {
  let refunds = 0;
  const result = await runTrialChargeReapTick({
    findStaleHeld: async () => [],
    refund: async () => {
      refunds += 1;
      return true;
    },
  });
  assert.deepEqual(result, { scanned: 0, refunded: 0, failed: 0 });
  assert.equal(refunds, 0);
});

// ============================================
// The binding: the query and the refund on a database surface
// ============================================

interface Row {
  id: string;
  listingId: string;
  publisherId: string;
  day: string;
  amountCents: bigint;
  status: string;
  createdAt: Date;
  failureReason?: string;
}

function db(rows: Row[]) {
  let balance = 10n;
  let fundedCount = rows.filter((row) => row.status !== "refunded").length;
  const ledger: Array<{ type: string; amountCents: bigint; balanceAfter: bigint; referenceId: string }> = [];
  const queries: unknown[] = [];
  const surface = {
    trialDailyUsage: {
      upsert: async () => undefined,
      updateMany: async () => {
        fundedCount -= 1;
        return { count: 1 };
      },
    },
    creditBalance: {
      updateMany: async () => ({ count: 0 }),
      update: async ({ data }: { data: { balanceCents: { increment: bigint } } }) => {
        balance += data.balanceCents.increment;
        return { balanceCents: balance };
      },
      findUnique: async () => ({ balanceCents: balance }),
    },
    creditTransaction: {
      create: async ({ data }: { data: (typeof ledger)[number] }) => {
        ledger.push(data);
      },
    },
    trialCharge: {
      create: async () => undefined,
      updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Partial<Row> }) => {
        const row = rows.find((candidate) => candidate.id === where.id && candidate.status === where.status);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((row) => row.id === where.id) ?? null,
      findMany: async (args: {
        where: { status: string; createdAt: { lt: Date } };
        orderBy: { createdAt: "asc" };
        take: number;
      }) => {
        queries.push(args);
        return rows
          .filter((row) => row.status === args.where.status && row.createdAt < args.where.createdAt.lt)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, args.take)
          .map((row) => ({ id: row.id }));
      },
    },
  };
  const prisma = {
    ...surface,
    $transaction: async <T>(fn: (tx: typeof surface) => Promise<T>) => fn(surface),
  } as unknown as TrialChargeReapPrisma;
  return { prisma, rows, ledger, queries, balance: () => balance, funded: () => fundedCount };
}

const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const charge = (id: string, status: string, minutes: number): Row => ({
  id,
  listingId: "listing-1",
  publisherId: "org-publisher",
  day: "2026-10-10",
  amountCents: 3n,
  status,
  createdAt: minutesAgo(minutes),
});

test("bound to a database: held charges past the cutoff are refunded with their ledger rows; recent and resolved ones are untouched", async () => {
  const store = db([
    charge("old-held", "held", 40),
    charge("older-held", "held", 90),
    charge("recent-held", "held", 2),
    charge("old-settled", "settled", 60),
    charge("old-refunded", "refunded", 60),
  ]);
  const deps = { ...bindTrialChargeReapTickDeps(store.prisma), now: () => NOW };

  const first = await runTrialChargeReapTick(deps);
  assert.deepEqual(first, { scanned: 2, refunded: 2, failed: 0 });
  assert.deepEqual(
    store.rows.map((row) => [row.id, row.status]),
    [
      ["old-held", "refunded"],
      ["older-held", "refunded"],
      ["recent-held", "held"],
      ["old-settled", "settled"],
      ["old-refunded", "refunded"],
    ],
  );
  assert.equal(store.balance(), 16n);
  assert.deepEqual(
    store.ledger.map((row) => [row.type, row.amountCents, row.balanceAfter, row.referenceId]),
    [
      // Oldest first.
      ["trial_usage_refund", 3n, 13n, "older-held"],
      ["trial_usage_refund", 3n, 16n, "old-held"],
    ],
  );
  assert.equal(store.rows[0]!.failureReason, TRIAL_CHARGE_REAP_REASON);
  assert.deepEqual(store.queries[0], {
    where: { status: "held", createdAt: { lt: new Date(NOW.getTime() - TRIAL_CHARGE_HELD_MAX_MS) } },
    orderBy: { createdAt: "asc" },
    take: TRIAL_CHARGE_REAP_BATCH,
    select: { id: true },
  });

  // The next tick finds nothing: a charge is refunded once.
  const second = await runTrialChargeReapTick(deps);
  assert.deepEqual(second, { scanned: 0, refunded: 0, failed: 0 });
  assert.equal(store.balance(), 16n);
  assert.equal(store.ledger.length, 2);
});

test("the queue runs the tick on the production deps, and the barrel exports its start and stop", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (relative: string) => readFileSync(path.join(here, "..", relative), "utf8");
  const queue = read("queues/trial-charge-reap.queue.ts");
  assert.match(queue, /buildTrialChargeReapTickDeps\(\)/);
  assert.match(queue, /runTrialChargeReapTick\(deps\)/);
  assert.match(queue, /concurrency: 1/);
  assert.match(read("queues/index.ts"), /startTrialChargeReapQueue, stopTrialChargeReapQueue/);
  assert.match(read("services/buildTrialChargeReapTickDeps.ts"), /bindTrialChargeReapTickDeps\(prisma as unknown as TrialChargeReapPrisma\)/);
});
