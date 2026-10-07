import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createTrialFunding,
  TRIAL_REFUND_LEDGER_TYPE,
  TRIAL_USAGE_LEDGER_TYPE,
  type TrialFundingDb,
  type TrialFundingTx,
} from "../services/trialFunding.js";

// services/trialFunding.ts: the money behind a publisher-funded Try it
// message. What is pinned: a hold debits conditionally and never past the
// cap or the balance; every balance change has exactly one ledger row whose
// balanceAfter is the balance; settle and refund are each exactly-once and
// mutually exclusive.
//
// The store is in memory with real transaction semantics for this purpose:
// a transaction that throws undoes its own writes (and only its own).

const LISTING = "listing-1";
const PUBLISHER = "org-publisher";
const DAY = "2026-10-10";
const NOW = new Date("2026-10-10T12:00:00.000Z");
const PRICE = 3n;

interface Ledger {
  orgId: string;
  amountCents: bigint;
  type: string;
  description: string;
  referenceId: string;
  balanceAfter: bigint;
}

interface Charge {
  id: string;
  listingId: string;
  publisherId: string;
  day: string;
  amountCents: bigint;
  status: string;
  resolvedAt?: Date;
  failureReason?: string;
}

function store(initial: { balance?: bigint | null; funded?: number } = {}) {
  const balances = new Map<string, bigint>();
  if (initial.balance !== null) balances.set(PUBLISHER, initial.balance ?? 100n);
  const usage = new Map<string, { fundedCount: number }>();
  if (initial.funded !== undefined) usage.set(`${LISTING}:${DAY}`, { fundedCount: initial.funded });
  const ledger: Ledger[] = [];
  const charges = new Map<string, Charge>();
  const calls: string[] = [];
  let upsertError: unknown = null;

  const surface = (undo: Array<() => void>): TrialFundingTx => ({
    trialDailyUsage: {
      updateMany: async ({ where, data }) => {
        const row = usage.get(`${where.listingId}:${where.day}`);
        if (!row) return { count: 0 };
        const cond = where.fundedCount;
        const ok = "lt" in cond ? row.fundedCount < cond.lt : row.fundedCount > cond.gt;
        if (!ok) return { count: 0 };
        const delta = "increment" in data.fundedCount ? data.fundedCount.increment : -data.fundedCount.decrement;
        row.fundedCount += delta;
        undo.push(() => {
          row.fundedCount -= delta;
        });
        return { count: 1 };
      },
    },
    creditBalance: {
      updateMany: async ({ where, data }) => {
        const balance = balances.get(where.orgId);
        if (balance === undefined || balance < where.balanceCents.gte) return { count: 0 };
        balances.set(where.orgId, balance - data.balanceCents.decrement);
        undo.push(() => balances.set(where.orgId, balances.get(where.orgId)! + data.balanceCents.decrement));
        return { count: 1 };
      },
      update: async ({ where, data }) => {
        const balance = balances.get(where.orgId);
        if (balance === undefined) throw new Error("no credit balance row");
        balances.set(where.orgId, balance + data.balanceCents.increment);
        undo.push(() => balances.set(where.orgId, balances.get(where.orgId)! - data.balanceCents.increment));
        return { balanceCents: balances.get(where.orgId)! };
      },
      findUnique: async ({ where }) => {
        const balance = balances.get(where.orgId);
        return balance === undefined ? null : { balanceCents: balance };
      },
    },
    creditTransaction: {
      create: async ({ data }) => {
        ledger.push(data);
        undo.push(() => {
          ledger.splice(ledger.indexOf(data), 1);
        });
      },
    },
    trialCharge: {
      create: async ({ data }) => {
        charges.set(data.id, { ...data });
        undo.push(() => {
          charges.delete(data.id);
        });
      },
      updateMany: async ({ where, data }) => {
        const charge = charges.get(where.id);
        if (!charge || charge.status !== where.status) return { count: 0 };
        const before = { ...charge };
        Object.assign(charge, data);
        undo.push(() => {
          charges.set(where.id, before);
        });
        return { count: 1 };
      },
      findUnique: async ({ where }) => charges.get(where.id) ?? null,
    },
  });

  let queue: Promise<unknown> = Promise.resolve();
  const direct = surface([]);
  const db: TrialFundingDb = {
    ...direct,
    trialDailyUsage: {
      ...direct.trialDailyUsage,
      upsert: async ({ where }) => {
        calls.push("upsert");
        if (upsertError) throw upsertError;
        const key = `${where.listingId_day.listingId}:${where.listingId_day.day}`;
        if (!usage.has(key)) usage.set(key, { fundedCount: 0 });
      },
    },
    // One at a time, as the row locks of the real writes make them: a
    // transaction that debited a balance holds that row until it ends.
    $transaction: (fn) => {
      const run = async () => {
        calls.push("tx");
        const undo: Array<() => void> = [];
        try {
          return await fn(surface(undo));
        } catch (err) {
          for (const revert of undo.reverse()) revert();
          throw err;
        }
      };
      const result = queue.then(run, run);
      queue = result.catch(() => undefined);
      return result;
    },
  };

  return {
    db,
    ledger,
    charges,
    calls,
    balance: () => balances.get(PUBLISHER),
    funded: () => usage.get(`${LISTING}:${DAY}`)?.fundedCount ?? 0,
    failUpsertWith: (err: unknown) => {
      upsertError = err;
    },
  };
}

let ids = 0;
const funding = (s: ReturnType<typeof store>, price: bigint = PRICE) =>
  createTrialFunding(s.db, { messageCents: () => price, now: () => NOW, newId: () => `charge-${(ids += 1)}` });

const HOLD = { listingId: LISTING, publisherId: PUBLISHER, day: DAY, dailyCap: 5 };

test("hold: debits the publisher, writes one trial_usage ledger row with the balance after, and one held charge", async () => {
  const s = store({ balance: 100n });
  const held = await funding(s).hold(HOLD);
  assert.equal(held.ok, true);
  assert.ok(held.ok);

  assert.equal(s.balance(), 97n);
  assert.equal(s.funded(), 1);
  assert.deepEqual(s.ledger, [
    {
      orgId: PUBLISHER,
      amountCents: -3n,
      type: TRIAL_USAGE_LEDGER_TYPE,
      description: "Try it message paid for by the publisher (hold)",
      referenceId: held.chargeId,
      balanceAfter: 97n,
    },
  ]);
  assert.deepEqual([...s.charges.values()], [
    { id: held.chargeId, listingId: LISTING, publisherId: PUBLISHER, day: DAY, amountCents: 3n, status: "held" },
  ]);
  // The usage row is made sure of BEFORE the transaction, never inside it.
  assert.deepEqual(s.calls, ["upsert", "tx"]);
});

test("hold: a publisher who cannot pay is refused, and the whole transaction rolls back - no debit, no count, no rows", async () => {
  for (const balance of [2n, 0n, null]) {
    const s = store({ balance });
    const held = await funding(s).hold(HOLD);
    assert.deepEqual(held, { ok: false, reason: "insufficient_credits" });
    assert.equal(s.balance(), balance ?? undefined);
    assert.equal(s.funded(), 0, "the count taken before the debit is given back");
    assert.deepEqual(s.ledger, []);
    assert.equal(s.charges.size, 0);
  }
});

test("hold: exactly the balance is enough; the balance never goes below zero", async () => {
  const s = store({ balance: 3n });
  assert.equal((await funding(s).hold(HOLD)).ok, true);
  assert.equal(s.balance(), 0n);
  assert.deepEqual(await funding(s).hold(HOLD), { ok: false, reason: "insufficient_credits" });
  assert.equal(s.balance(), 0n);
  assert.equal(s.funded(), 1);
});

test("hold: at the cap the compare-and-set refuses and nothing is debited", async () => {
  const s = store({ balance: 100n, funded: 5 });
  assert.deepEqual(await funding(s).hold(HOLD), { ok: false, reason: "cap_reached" });
  assert.equal(s.balance(), 100n);
  assert.equal(s.funded(), 5);
  assert.deepEqual(s.ledger, []);
  assert.equal(s.charges.size, 0);
});

test("hold: a cap of zero, or a price that is not positive, holds nothing and touches nothing", async () => {
  const s = store();
  assert.deepEqual(await funding(s).hold({ ...HOLD, dailyCap: 0 }), { ok: false, reason: "cap_reached" });
  assert.deepEqual(await funding(s, 0n).hold(HOLD), { ok: false, reason: "cap_reached" });
  assert.deepEqual(s.calls, []);
  assert.equal(s.balance(), 100n);
});

test("hold: concurrent holds one below the cap - exactly one wins, and one message is paid for", async () => {
  const s = store({ balance: 100n, funded: 4 });
  const f = funding(s);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.hold(HOLD)));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.ok(results.filter((result) => !result.ok).every((result) => !result.ok && result.reason === "cap_reached"));
  assert.equal(s.funded(), 5);
  assert.equal(s.balance(), 97n);
  assert.equal(s.ledger.length, 1);
  assert.equal(s.charges.size, 1);
});

test("hold: concurrent holds against a balance that covers two - two win, the rest roll back cleanly", async () => {
  const s = store({ balance: 7n });
  const f = funding(s);
  const results = await Promise.all(Array.from({ length: 6 }, () => f.hold({ ...HOLD, dailyCap: 100 })));
  assert.equal(results.filter((result) => result.ok).length, 2);
  assert.equal(s.balance(), 1n);
  assert.equal(s.funded(), 2, "every refused hold gave its count back");
  assert.equal(s.ledger.length, 2);
  assert.deepEqual(s.ledger.map((row) => row.balanceAfter).sort(), [1n, 4n]);
});

test("hold: losing the race to create the day's usage row is not an error; any other failure is", async () => {
  // The row is there: the other request created it.
  const raced = store({ funded: 0 });
  raced.failUpsertWith(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
  assert.equal((await funding(raced).hold(HOLD)).ok, true);

  const down = store({ funded: 0 });
  down.failUpsertWith(new Error("connection refused"));
  await assert.rejects(funding(down).hold(HOLD), /connection refused/);
  assert.equal(down.balance(), 100n);
});

test("settle: held -> settled exactly once; the money was taken at the hold, so nothing else moves", async () => {
  const s = store({ balance: 100n });
  const f = funding(s);
  const held = await f.hold(HOLD);
  assert.ok(held.ok);

  assert.equal(await f.settle(held.chargeId), true);
  assert.equal(await f.settle(held.chargeId), false, "a second settle changes nothing");
  assert.equal(s.charges.get(held.chargeId)!.status, "settled");
  assert.deepEqual(s.charges.get(held.chargeId)!.resolvedAt, NOW);
  assert.equal(s.balance(), 97n);
  assert.equal(s.funded(), 1);
  assert.equal(s.ledger.length, 1);
});

test("refund: held -> refunded exactly once - credits back, one trial_usage_refund row, the day's count down by one", async () => {
  const s = store({ balance: 100n });
  const f = funding(s);
  const held = await f.hold(HOLD);
  assert.ok(held.ok);

  assert.equal(await f.refund(held.chargeId, "the model failed"), true);
  assert.equal(s.balance(), 100n);
  assert.equal(s.funded(), 0);
  assert.equal(s.charges.get(held.chargeId)!.status, "refunded");
  assert.equal(s.charges.get(held.chargeId)!.failureReason, "the model failed");
  assert.deepEqual(s.ledger[1], {
    orgId: PUBLISHER,
    amountCents: 3n,
    type: TRIAL_REFUND_LEDGER_TYPE,
    description: "Try it message refunded: the model failed",
    referenceId: held.chargeId,
    balanceAfter: 100n,
  });

  assert.equal(await f.refund(held.chargeId, "again"), false, "a second refund pays nothing");
  assert.equal(s.balance(), 100n);
  assert.equal(s.funded(), 0);
  assert.equal(s.ledger.length, 2);
});

test("settle and refund are mutually exclusive, in either order", async () => {
  const settled = store({ balance: 100n });
  const a = funding(settled);
  const first = await a.hold(HOLD);
  assert.ok(first.ok);
  assert.equal(await a.settle(first.chargeId), true);
  assert.equal(await a.refund(first.chargeId, "late"), false);
  assert.equal(settled.balance(), 97n, "a settled message is not paid back");
  assert.equal(settled.funded(), 1);
  assert.equal(settled.ledger.length, 1);

  const refunded = store({ balance: 100n });
  const b = funding(refunded);
  const second = await b.hold(HOLD);
  assert.ok(second.ok);
  assert.equal(await b.refund(second.chargeId, "client left"), true);
  assert.equal(await b.settle(second.chargeId), false);
  assert.equal(refunded.charges.get(second.chargeId)!.status, "refunded");
  assert.equal(refunded.balance(), 100n);
});

test("a settle and a refund racing on one charge: one happens, and the books agree with which", async () => {
  for (let round = 0; round < 10; round += 1) {
    const s = store({ balance: 100n });
    const f = funding(s);
    const held = await f.hold(HOLD);
    assert.ok(held.ok);
    const [settled, refunded] = await Promise.all(
      round % 2 === 0
        ? [f.settle(held.chargeId), f.refund(held.chargeId, "race")]
        : [f.refund(held.chargeId, "race"), f.settle(held.chargeId)].reverse(),
    );
    assert.notEqual(settled, refunded, "exactly one of them won");
    const status = s.charges.get(held.chargeId)!.status;
    assert.equal(s.balance(), status === "refunded" ? 100n : 97n);
    assert.equal(s.ledger.length, status === "refunded" ? 2 : 1);
  }
});

test("the meter a hold hands back settles or refunds that one charge", async () => {
  const s = store({ balance: 100n });
  const held = await funding(s).hold(HOLD);
  assert.ok(held.ok);
  await held.meter.refund("no answer was delivered");
  await held.meter.settle();
  await held.meter.refund("again");
  assert.equal(s.charges.get(held.chargeId)!.status, "refunded");
  assert.equal(s.balance(), 100n);
  assert.equal(s.ledger.length, 2);
});

test("a refund pays back what the charge recorded, not today's price", async () => {
  const s = store({ balance: 100n });
  const held = await funding(s, 3n).hold(HOLD);
  assert.ok(held.ok);
  // The price changed (or was removed) since.
  await funding(s, 50n).refund(held.chargeId, "reaped");
  assert.equal(s.balance(), 100n);
  assert.equal(s.ledger[1]!.amountCents, 3n);
});

test("a refund whose credit write fails rolls back whole: the charge stays held to be refunded again", async () => {
  const s = store({ balance: 100n });
  const f = funding(s);
  const held = await f.hold(HOLD);
  assert.ok(held.ok);
  const failing: TrialFundingDb = {
    ...s.db,
    $transaction: (fn) =>
      s.db.$transaction((tx) =>
        fn({
          ...tx,
          creditTransaction: {
            create: async () => {
              throw new Error("ledger write failed");
            },
          },
        }),
      ),
  };
  await assert.rejects(
    createTrialFunding(failing, { messageCents: () => PRICE, now: () => NOW }).refund(held.chargeId, "x"),
    /ledger write failed/,
  );
  assert.equal(s.charges.get(held.chargeId)!.status, "held");
  assert.equal(s.balance(), 97n);
  assert.equal(s.funded(), 1);
  assert.equal(await f.refund(held.chargeId, "second try"), true);
  assert.equal(s.balance(), 100n);
});

test("source pins: conditional debit, no unique-violation handling inside a transaction", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, "..", "services", "trialFunding.ts"), "utf8");
  assert.match(source, /balanceCents: \{ gte: args\.amountCents \}/);
  assert.match(source, /where: \{ id: args\.chargeId, status: "held" \}/);
  assert.match(source, /where: \{ id: chargeId, status: "held" \}/);
  // The only place P2002 is read is around the upsert that runs before the
  // transaction opens.
  const p2002 = source.indexOf("isUniqueViolation(err)");
  const transaction = source.indexOf("held = await db.$transaction");
  assert.ok(p2002 > 0 && transaction > p2002);
  assert.equal(source.split("isUniqueViolation(err)").length - 1, 1);
});
