import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "./unitEnv.js";
import { OWN_SCHEDULE_TIMEOUT_SECONDS } from "../services/agentOwnSchedule.js";
import {
  bindPendingUseSweepTickDeps,
  PENDING_COPY_MAX_MS,
  PENDING_USE_REVENUE_TYPE,
  PENDING_USE_SWEEP_HOLD_MAX,
  PENDING_USE_SWEEP_HOLD_MS,
  type PendingUseSweepPrisma,
} from "../services/buildPendingUseSweepTickDeps.js";
import {
  PENDING_USE_MAX_MS,
  PENDING_USE_SWEEP_BATCH,
  PENDING_USE_SWEEP_REASON,
  runPendingUseSweepTick,
  type StalePendingUse,
} from "../services/runPendingUseSweepTick.js";

// The sweeper for charges per use: a charge left `pending` by a process that
// died between the debit and the answer is given back to the buyer, once. A
// use still in flight is left alone, and so is every other type of row.

const NOW = new Date("2026-10-13T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(path.join(here, "..", file), "utf8");

const BUYER = "buyer-1";
const OTHER_BUYER = "buyer-2";
const PUBLISHER = "publisher-1";

// ============================================
// The core, on plain functions
// ============================================

function stale(revenueId: string, createdAt: Date = minutesAgo(20)): StalePendingUse {
  return { revenueId, buyerId: BUYER, grossCents: 5n, createdAt };
}

test("the tick asks for charges pending longer than any use can last, and refunds each once", async () => {
  const asked: Array<{ createdBefore: Date; take: number }> = [];
  const refunded: Array<[string, string]> = [];
  let counted = 0;
  const result = await runPendingUseSweepTick({
    findStalePending: async (args) => {
      asked.push(args);
      return [stale("r1"), stale("r2")];
    },
    countStalePending: async () => {
      counted += 1;
      return 99;
    },
    refund: async (charge, reason) => {
      refunded.push([charge.revenueId, reason]);
      return true;
    },
    now: () => NOW,
  });
  assert.equal(PENDING_USE_MAX_MS, 15 * 60_000);
  assert.deepEqual(asked, [{ createdBefore: minutesAgo(15), take: PENDING_USE_SWEEP_BATCH }]);
  assert.deepEqual(refunded, [
    ["r1", PENDING_USE_SWEEP_REASON],
    ["r2", PENDING_USE_SWEEP_REASON],
  ]);
  assert.deepEqual(result, { scanned: 2, refunded: 2, failed: 0, left: 0 });
  assert.equal(counted, 0, "a batch that was not full leaves nothing to count");
});

test("a charge resolved in the meantime is not counted as refunded; a failing refund does not stop the rest", async () => {
  const errors: unknown[] = [];
  const tried: string[] = [];
  const result = await runPendingUseSweepTick({
    findStalePending: async () => [stale("settled-meanwhile"), stale("breaks"), stale("stale")],
    countStalePending: async () => 0,
    refund: async (charge) => {
      tried.push(charge.revenueId);
      if (charge.revenueId === "breaks") throw new Error("db down");
      return charge.revenueId === "stale";
    },
    now: () => NOW,
    logger: { error: (obj) => errors.push(obj) },
  });
  assert.deepEqual(tried, ["settled-meanwhile", "breaks", "stale"]);
  assert.deepEqual(result, { scanned: 3, refunded: 1, failed: 1, left: 0 });
  assert.equal(errors.length, 1);
});

test("a read that answers with a fresh charge, or with more than was asked for, moves no money for them", async () => {
  const refunded: string[] = [];
  const result = await runPendingUseSweepTick({
    findStalePending: async () => [
      stale("old-1"),
      stale("fresh", minutesAgo(14)),
      stale("at-the-line", minutesAgo(15)),
      stale("old-2"),
      stale("old-3"),
    ],
    countStalePending: async () => 1,
    refund: async (charge) => {
      refunded.push(charge.revenueId);
      return true;
    },
    now: () => NOW,
    batch: 2,
  });
  assert.deepEqual(refunded, ["old-1", "old-2"]);
  assert.equal(result.scanned, 2);
});

test("a full batch says how many it left; a count that fails is said as unknown and fails nothing", async () => {
  const errors: unknown[] = [];
  const deps = {
    findStalePending: async () => [stale("r1"), stale("r2")],
    refund: async () => true,
    now: () => NOW,
    batch: 2,
    logger: { error: (obj: unknown) => errors.push(obj) },
  };
  assert.deepEqual(await runPendingUseSweepTick({ ...deps, countStalePending: async () => 7 }), {
    scanned: 2,
    refunded: 2,
    failed: 0,
    left: 7,
  });
  const unknown = await runPendingUseSweepTick({
    ...deps,
    countStalePending: async () => {
      throw new Error("db down");
    },
  });
  assert.deepEqual(unknown, { scanned: 2, refunded: 2, failed: 0, left: null });
  assert.equal(errors.length, 1);
});

test("nothing stale: nothing is refunded", async () => {
  let refunds = 0;
  const result = await runPendingUseSweepTick({
    findStalePending: async () => [],
    countStalePending: async () => 0,
    refund: async () => {
      refunds += 1;
      return true;
    },
  });
  assert.deepEqual(result, { scanned: 0, refunded: 0, failed: 0, left: 0 });
  assert.equal(refunds, 0);
});

// ============================================
// The binding: the query and the refund on a database surface
// ============================================

interface Revenue {
  id: string;
  type: string;
  status: string;
  listingId: string | null;
  installId: string | null;
  buyerId: string;
  publisherId: string;
  grossAmountCents: bigint;
  platformFeeCents: bigint;
  creatorAmountCents: bigint;
  requestCount: number;
  createdAt: Date;
  settledAt?: Date;
}

interface LedgerLine {
  orgId: string;
  amountCents: bigint;
  type: string;
  description: string;
  referenceId: string;
  balanceAfter: bigint;
}

function revenue(id: string, over: Partial<Revenue> = {}): Revenue {
  return {
    id,
    type: "per_request",
    status: "pending",
    listingId: "listing-1",
    installId: "licence-use",
    buyerId: BUYER,
    publisherId: PUBLISHER,
    grossAmountCents: 5n,
    platformFeeCents: 1n,
    creatorAmountCents: 4n,
    requestCount: 1,
    createdAt: minutesAgo(20),
    ...over,
  };
}

/**
 * The tables the sweeper reads and the refund writes, in memory. `where` is
 * honoured, so a compare-and-set can be lost; a transaction that throws
 * leaves nothing behind; the read gives way before it answers, so two ticks
 * started together both read before either claims.
 */
function db(rows: Revenue[], options: { afterRead?: () => void } = {}) {
  const balances = new Map<string, bigint>([
    [BUYER, 100n],
    [OTHER_BUYER, 100n],
  ]);
  const ledger: LedgerLine[] = [];
  const queries: unknown[] = [];
  const counts: unknown[] = [];
  /** Any write that would credit a creator or count a delivered use: the sweeper must make none. */
  const creatorWrites: string[] = [];
  const installs = [
    { id: "licence-use", kind: "use", listing: { title: "Tax Helper" } },
    { id: "licence-copy", kind: "copy", listing: { title: "Copy Cat" } },
  ];

  type Where = { type: string; status: string; createdAt: { lt: Date }; id?: { notIn: string[] } };
  const matches = (row: Revenue, where: Where) =>
    row.type === where.type &&
    row.status === where.status &&
    row.createdAt < where.createdAt.lt &&
    !where.id?.notIn.includes(row.id);

  const tx = {
    marketplaceRevenue: {
      updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Partial<Revenue> }) => {
        const row = rows.find((candidate) => candidate.id === where.id && candidate.status === where.status);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    creditBalance: {
      update: async ({ where, data }: { where: { orgId: string }; data: { balanceCents: { increment: bigint } } }) => {
        const before = balances.get(where.orgId);
        if (before === undefined) throw new Error("Record to update not found");
        balances.set(where.orgId, before + data.balanceCents.increment);
        return { balanceCents: before + data.balanceCents.increment };
      },
    },
    creditTransaction: {
      create: async ({ data }: { data: LedgerLine }) => {
        ledger.push(data);
      },
    },
    publisherProfile: {
      updateMany: async () => {
        creatorWrites.push("publisherProfile.updateMany");
        return { count: 1 };
      },
      findUnique: async () => null,
    },
    earningsTransaction: {
      create: async () => {
        creatorWrites.push("earningsTransaction.create");
      },
    },
    agentInstall: {
      update: async () => {
        creatorWrites.push("agentInstall.update");
      },
    },
    agentListing: {
      update: async () => {
        creatorWrites.push("agentListing.update");
      },
    },
  };

  const prisma = {
    marketplaceRevenue: {
      findMany: async (args: { where: Where; take: number }) => {
        queries.push(args);
        const found = rows
          .filter((row) => matches(row, args.where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, args.take)
          .map((row) => ({ ...row }));
        await new Promise((resolve) => setImmediate(resolve));
        options.afterRead?.();
        return found;
      },
      count: async (args: { where: Where }) => {
        counts.push(args);
        return rows.filter((row) => matches(row, args.where)).length;
      },
    },
    agentInstall: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        installs.filter((install) => where.id.in.includes(install.id)),
    },
    $transaction: async <T>(run: (inner: typeof tx) => Promise<T>): Promise<T> => {
      const before = { rows: rows.map((row) => ({ ...row })), balances: new Map(balances), ledger: ledger.length };
      try {
        return await run(tx);
      } catch (err) {
        rows.splice(0, rows.length, ...before.rows);
        balances.clear();
        for (const [orgId, cents] of before.balances) balances.set(orgId, cents);
        ledger.length = before.ledger;
        throw err;
      }
    },
  };

  const errors: unknown[] = [];
  /** The one clock of the tick and of its binding; a test moves it. */
  const clock = { now: NOW };
  const deps = {
    ...bindPendingUseSweepTickDeps(prisma as unknown as PendingUseSweepPrisma, () => clock.now),
    logger: { error: (obj: unknown) => errors.push(obj) },
  };
  return { deps, rows, balances, ledger, queries, counts, creatorWrites, errors, clock };
}

const statusOf = (rows: Revenue[], id: string) => rows.find((row) => row.id === id)?.status;

test("a charge for a use pending for more than 15 minutes is given back once: exactly what was held, and nothing to the creator", async () => {
  const state = db([revenue("r1", { grossAmountCents: 7n, platformFeeCents: 1n, creatorAmountCents: 6n })]);

  const first = await runPendingUseSweepTick(state.deps);
  assert.deepEqual(first, { scanned: 1, refunded: 1, failed: 0, left: 0 });
  assert.equal(statusOf(state.rows, "r1"), "refunded");
  assert.equal(state.rows[0]?.settledAt, undefined);
  assert.equal(state.balances.get(BUYER), 107n);
  // The ledger line a refunded use writes today, word for word.
  assert.deepEqual(state.ledger, [
    {
      orgId: BUYER,
      amountCents: 7n,
      type: "marketplace_refund",
      description: "Paid use refunded: Tax Helper",
      referenceId: "r1",
      balanceAfter: 107n,
    },
  ]);
  assert.deepEqual(state.creatorWrites, []);

  const second = await runPendingUseSweepTick(state.deps);
  assert.deepEqual(second, { scanned: 0, refunded: 0, failed: 0, left: 0 });
  assert.equal(state.balances.get(BUYER), 107n);
  assert.equal(state.ledger.length, 1);
});

test("a request of a buyer's own copy left pending is given back too, as its refund reads today", async () => {
  const state = db([
    revenue("r1", { installId: "licence-copy", grossAmountCents: 10n, requestCount: 2, createdAt: minutesAgo(80) }),
  ]);
  await runPendingUseSweepTick(state.deps);
  assert.equal(statusOf(state.rows, "r1"), "refunded");
  assert.equal(state.balances.get(BUYER), 110n);
  assert.equal(state.ledger[0]?.description, `Marketplace request refunded \u2014 Copy Cat (${PENDING_USE_SWEEP_REASON})`);
  assert.deepEqual(state.creatorWrites, []);
});

test("a request of a copy that may still be running is left pending: a copy's run can last an hour", async () => {
  const state = db([
    revenue("copy-20", { installId: "licence-copy", createdAt: minutesAgo(20) }),
    revenue("copy-at-the-line", { installId: "licence-copy", createdAt: new Date(NOW.getTime() - PENDING_COPY_MAX_MS) }),
  ]);
  const result = await runPendingUseSweepTick(state.deps);
  // Left out, not failed: nothing is counted and nothing is logged.
  assert.deepEqual(result, { scanned: 0, refunded: 0, failed: 0, left: 0 });
  assert.deepEqual(state.errors, []);
  assert.deepEqual(
    state.rows.map((row) => row.status),
    ["pending", "pending"],
  );
  assert.equal(state.balances.get(BUYER), 100n);
  assert.deepEqual(state.ledger, []);

  // Once it is older than any copy's run, it is given back.
  state.clock.now = new Date(NOW.getTime() + 60 * 60_000);
  const later = await runPendingUseSweepTick(state.deps);
  assert.deepEqual(later, { scanned: 2, refunded: 2, failed: 0, left: 0 });
  assert.equal(state.balances.get(BUYER), 110n);
});

test("the age of a use's charge is above every limit a paid use can last", () => {
  // A paid use of a creator's agent ends at the chat's time limit; the
  // ceiling of that setting is read from where it is set. Past it no use is
  // still running, so a charge that old was left by a process that died.
  const ceiling = /AGENT_CHAT_TIMEOUT_MS: z\.coerce\.number\(\)\.int\(\)\.min\([\d_]+\)\.max\(([\d_]+)\)/.exec(source("config/env.ts"));
  assert.ok(ceiling?.[1], "the ceiling of AGENT_CHAT_TIMEOUT_MS was not found in config/env.ts");
  assert.ok(PENDING_USE_MAX_MS > Number(ceiling[1].replaceAll("_", "")));
});

test("the age of a copy's request is above every limit a copy's run can have", () => {
  assert.ok(PENDING_COPY_MAX_MS > PENDING_USE_MAX_MS);
  // A scheduled task on a copy runs up to the task's own timeout.
  assert.ok(PENDING_COPY_MAX_MS > OWN_SCHEDULE_TIMEOUT_SECONDS.max * 1000);
  // A hired job whose agent is a copy runs up to JOB_MAX_RUN_MS; the
  // ceiling of that setting is read from where it is set.
  const ceiling = /JOB_MAX_RUN_MS: z\.coerce\.number\(\)\.int\(\)\.min\([\d_]+\)\.max\(([\d_]+)\)/.exec(source("config/env.ts"));
  assert.ok(ceiling?.[1], "the ceiling of JOB_MAX_RUN_MS was not found in config/env.ts");
  assert.ok(PENDING_COPY_MAX_MS > Number(ceiling[1].replaceAll("_", "")));
});

test("copies still running do not hold the batch: the charges behind them are given back on the next tick", async () => {
  const state = db([
    revenue("copy-a", { installId: "licence-copy", createdAt: minutesAgo(40) }),
    revenue("copy-b", { installId: "licence-copy", createdAt: minutesAgo(30) }),
    revenue("use", { buyerId: OTHER_BUYER, createdAt: minutesAgo(20) }),
  ]);
  const first = await runPendingUseSweepTick({ ...state.deps, batch: 2 });
  assert.equal(first.refunded, 0);
  const second = await runPendingUseSweepTick({ ...state.deps, batch: 2 });
  assert.deepEqual(second, { scanned: 1, refunded: 1, failed: 0, left: 0 });
  assert.equal(statusOf(state.rows, "use"), "refunded");
  assert.equal(state.balances.get(OTHER_BUYER), 105n);
  assert.equal(state.balances.get(BUYER), 100n);
});

test("charges that cannot be refunded do not hold the batch, and are tried again later", async () => {
  const state = db([
    revenue("no-licence", { installId: null, createdAt: minutesAgo(60) }),
    revenue("no-balance", { buyerId: "buyer-with-no-balance-row", createdAt: minutesAgo(50) }),
    revenue("fine", { buyerId: OTHER_BUYER, createdAt: minutesAgo(20) }),
  ]);
  const first = await runPendingUseSweepTick({ ...state.deps, batch: 2 });
  assert.deepEqual(first, { scanned: 2, refunded: 0, failed: 2, left: 1 });
  assert.equal(state.errors.length, 2);

  // The next tick reads past the two that failed.
  const second = await runPendingUseSweepTick({ ...state.deps, batch: 2 });
  assert.deepEqual(second, { scanned: 1, refunded: 1, failed: 0, left: 0 });
  assert.equal(state.balances.get(OTHER_BUYER), 105n);
  assert.deepEqual((state.queries[1] as { where: { id?: unknown } }).where.id, { notIn: ["no-licence", "no-balance"] });
  assert.equal(state.errors.length, 2, "a charge that is left out is not logged again every minute");

  // They are not forgotten: after the hold they are read and tried again.
  state.clock.now = new Date(NOW.getTime() + PENDING_USE_SWEEP_HOLD_MS);
  const third = await runPendingUseSweepTick({ ...state.deps, batch: 2 });
  // The count leaves out what is held, as the next read will.
  assert.deepEqual(third, { scanned: 2, refunded: 0, failed: 2, left: 0 });
  assert.equal((state.queries[2] as { where: { id?: unknown } }).where.id, undefined);
  assert.equal(statusOf(state.rows, "no-licence"), "pending");
  assert.equal(statusOf(state.rows, "no-balance"), "pending");
  assert.equal(state.balances.get(BUYER), 100n);
  assert.equal(PENDING_USE_SWEEP_HOLD_MS, 30 * 60_000);
});

test("the charges left out are bounded: past the limit the oldest is read again", async () => {
  const rows = Array.from({ length: PENDING_USE_SWEEP_HOLD_MAX + 5 }, (_, index) =>
    revenue(`broken-${index}`, { installId: null, createdAt: minutesAgo(5_000 - index) }),
  );
  const state = db(rows);
  for (let tick = 0; tick < rows.length / PENDING_USE_SWEEP_BATCH + 1; tick += 1) {
    await runPendingUseSweepTick(state.deps);
  }
  const last = state.queries.at(-1) as { where: { id?: { notIn: string[] } } };
  assert.ok((last.where.id?.notIn.length ?? 0) <= PENDING_USE_SWEEP_HOLD_MAX);
  assert.equal(state.balances.get(BUYER), 100n);
});

test("a charge younger than 15 minutes is never touched", async () => {
  const state = db([
    revenue("a-second-short", { createdAt: new Date(NOW.getTime() - PENDING_USE_MAX_MS + 1_000) }),
    revenue("at-the-line", { createdAt: minutesAgo(15) }),
    revenue("just-now", { createdAt: NOW }),
  ]);
  const result = await runPendingUseSweepTick(state.deps);
  assert.deepEqual(result, { scanned: 0, refunded: 0, failed: 0, left: 0 });
  assert.deepEqual(
    state.rows.map((row) => row.status),
    ["pending", "pending", "pending"],
  );
  assert.equal(state.balances.get(BUYER), 100n);
  assert.deepEqual(state.ledger, []);
  // The age and the status are in the query itself, not filtered afterwards.
  assert.deepEqual((state.queries[0] as { where: unknown }).where, {
    type: "per_request",
    status: "pending",
    createdAt: { lt: minutesAgo(15) },
  });
});

for (const meanwhile of ["settled", "refunded"]) {
  test(`a charge ${meanwhile} between the read and the claim is left alone, and nothing is paid twice`, async () => {
    const rows = [revenue("raced"), revenue("stale", { buyerId: OTHER_BUYER })];
    const state = db(rows, {
      afterRead: () => {
        const raced = rows.find((row) => row.id === "raced");
        if (raced) raced.status = meanwhile;
      },
    });
    const result = await runPendingUseSweepTick(state.deps);
    assert.deepEqual(result, { scanned: 2, refunded: 1, failed: 0, left: 0 });
    assert.equal(statusOf(state.rows, "raced"), meanwhile);
    assert.equal(state.balances.get(BUYER), 100n, "the buyer of the raced charge is paid nothing here");
    assert.equal(state.balances.get(OTHER_BUYER), 105n);
    assert.deepEqual(
      state.ledger.map((line) => line.referenceId),
      ["stale"],
    );
    assert.deepEqual(state.errors, []);
  });
}

test("two ticks at the same moment refund a charge once", async () => {
  const state = db([revenue("r1"), revenue("r2")]);
  const [a, b] = await Promise.all([runPendingUseSweepTick(state.deps), runPendingUseSweepTick(state.deps)]);
  assert.equal(a.scanned, 2);
  assert.equal(b.scanned, 2, "both ticks read both charges before either claimed");
  assert.equal(a.refunded + b.refunded, 2);
  assert.equal(state.balances.get(BUYER), 110n);
  assert.deepEqual(state.ledger.map((line) => line.referenceId).sort(), ["r1", "r2"]);
});

test("one charge that throws does not stop the others, and stays pending for the next tick", async () => {
  const state = db([
    revenue("before", { createdAt: minutesAgo(40) }),
    revenue("breaks", { createdAt: minutesAgo(30), buyerId: "buyer-with-no-balance-row" }),
    revenue("after", { createdAt: minutesAgo(20), buyerId: OTHER_BUYER }),
  ]);
  const result = await runPendingUseSweepTick(state.deps);
  assert.deepEqual(result, { scanned: 3, refunded: 2, failed: 1, left: 0 });
  assert.equal(statusOf(state.rows, "before"), "refunded");
  assert.equal(statusOf(state.rows, "breaks"), "pending");
  assert.equal(statusOf(state.rows, "after"), "refunded");
  assert.equal(state.balances.get(BUYER), 105n);
  assert.equal(state.balances.get(OTHER_BUYER), 105n);
  assert.equal(state.errors.length, 1);
  assert.equal((state.errors[0] as { revenueId: string }).revenueId, "breaks");
});

test("a charge whose licence cannot be read is refunded to nobody and stays pending", async () => {
  const state = db([
    revenue("no-licence", { installId: null }),
    revenue("licence-gone", { installId: "deleted" }),
    revenue("fine"),
  ]);
  const result = await runPendingUseSweepTick(state.deps);
  assert.deepEqual(result, { scanned: 3, refunded: 1, failed: 2, left: 0 });
  assert.equal(statusOf(state.rows, "no-licence"), "pending");
  assert.equal(statusOf(state.rows, "licence-gone"), "pending");
  assert.equal(state.balances.get(BUYER), 105n);
});

test("rows of other types are never touched: a subscription's first period, a renewal, a job", async () => {
  const state = db([
    revenue("first-period", { type: "subscription", grossAmountCents: 900n }),
    revenue("renewal", { type: "subscription_renewal", grossAmountCents: 900n }),
    revenue("job", { type: "job", installId: null, listingId: null, grossAmountCents: 2500n }),
    revenue("settled-use", { status: "settled" }),
    revenue("refunded-use", { status: "refunded" }),
  ]);
  const result = await runPendingUseSweepTick(state.deps);
  assert.deepEqual(result, { scanned: 0, refunded: 0, failed: 0, left: 0 });
  assert.deepEqual(
    state.rows.map((row) => row.status),
    ["pending", "pending", "pending", "settled", "refunded"],
  );
  assert.equal(state.balances.get(BUYER), 100n);
  assert.deepEqual(state.ledger, []);
  assert.equal(PENDING_USE_REVENUE_TYPE, "per_request");
});

test("the batch has a size limit, takes the oldest first and says how many it left", async () => {
  const state = db([
    revenue("r20", { createdAt: minutesAgo(20) }),
    revenue("r60", { createdAt: minutesAgo(60) }),
    revenue("r30", { createdAt: minutesAgo(30) }),
    revenue("r50", { createdAt: minutesAgo(50) }),
    revenue("r40", { createdAt: minutesAgo(40) }),
    revenue("fresh", { createdAt: minutesAgo(1) }),
  ]);
  const first = await runPendingUseSweepTick({ ...state.deps, batch: 2 });
  assert.deepEqual(first, { scanned: 2, refunded: 2, failed: 0, left: 3 });
  assert.deepEqual(
    state.ledger.map((line) => line.referenceId),
    ["r60", "r50"],
  );
  assert.equal((state.queries[0] as { take: number }).take, 2);
  // The count is of the same rows the read is of.
  assert.deepEqual((state.counts[0] as { where: unknown }).where, (state.queries[0] as { where: unknown }).where);

  const second = await runPendingUseSweepTick({ ...state.deps, batch: 2 });
  assert.deepEqual(second, { scanned: 2, refunded: 2, failed: 0, left: 1 });
  const third = await runPendingUseSweepTick({ ...state.deps, batch: 2 });
  assert.deepEqual(third, { scanned: 1, refunded: 1, failed: 0, left: 0 });
  assert.equal(statusOf(state.rows, "fresh"), "pending");
  assert.equal(state.balances.get(BUYER), 125n);
  assert.equal(PENDING_USE_SWEEP_BATCH, 100);
});

// ============================================
// The refund is the one a failed use makes
// ============================================

test("the sweeper calls the refund of a failed use and writes no status, balance or ledger line of its own", () => {
  const binding = source("services/buildPendingUseSweepTickDeps.ts");
  assert.match(binding, /refundMarketplaceRequest\(tx, \{ charge, reason \}\)/);
  for (const write of [/\.updateMany\(/, /\.update\(/, /\.create\(/, /\$executeRaw/, /\$queryRaw/, /moveEarnings/]) {
    assert.doesNotMatch(binding, write);
  }
  const core = source("services/runPendingUseSweepTick.ts");
  assert.doesNotMatch(core, /^import /m, "the core imports nothing: its reads, its refund and its clock are given");
});
