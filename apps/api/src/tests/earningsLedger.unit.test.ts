// The one way what a creator is owed changes: every change writes one row
// with the balance it left, a take can never go below zero, and a change that
// cannot be made writes nothing.
import "./unitEnv.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  EarningsLedgerError,
  moveEarnings,
  type EarningsEntryType,
  type EarningsLedgerTx,
} from "../services/earningsLedger.js";

interface Profile {
  pendingPayoutCents: bigint;
  totalRevenueCents: bigint;
}
type Row = Parameters<EarningsLedgerTx["earningsTransaction"]["create"]>[0]["data"];

function ledger(profiles: Record<string, Profile>) {
  const rows: Row[] = [];
  const calls: string[] = [];
  const tx: EarningsLedgerTx = {
    publisherProfile: {
      updateMany: async ({ where, data }) => {
        calls.push("updateMany");
        const profile = profiles[where.orgId];
        if (!profile) return { count: 0 };
        if (where.pendingPayoutCents && profile.pendingPayoutCents < where.pendingPayoutCents.gte) return { count: 0 };
        if ("increment" in data.pendingPayoutCents) profile.pendingPayoutCents += data.pendingPayoutCents.increment;
        else profile.pendingPayoutCents -= data.pendingPayoutCents.decrement;
        if (data.totalRevenueCents) profile.totalRevenueCents += data.totalRevenueCents.increment;
        return { count: 1 };
      },
      findUnique: async ({ where }) => {
        calls.push("findUnique");
        const profile = profiles[where.orgId];
        return profile ? { pendingPayoutCents: profile.pendingPayoutCents } : null;
      },
    },
    earningsTransaction: {
      create: async ({ data }) => {
        calls.push("create");
        rows.push(data);
        return data;
      },
    },
  };
  return { tx, rows, calls, profiles };
}

const ORG = "org_creator";

test("a sale adds to what is owed and to lifetime revenue, with one row and its balance", async () => {
  const l = ledger({ [ORG]: { pendingPayoutCents: 100n, totalRevenueCents: 900n } });
  const result = await moveEarnings(l.tx, { orgId: ORG, amountCents: 45n, type: "sale", referenceId: "rev_1", description: "Paid use" });
  assert.deepEqual(result, { moved: true, balanceAfterCents: 145n });
  assert.deepEqual(l.profiles[ORG], { pendingPayoutCents: 145n, totalRevenueCents: 945n });
  assert.deepEqual(l.rows, [
    { orgId: ORG, amountCents: 45n, type: "sale", referenceId: "rev_1", description: "Paid use", balanceAfter: 145n },
  ]);
});

test("every kind of income adds to lifetime revenue; a restored payout does not", async () => {
  for (const type of ["sale", "subscription", "job", "contributor_share"] as EarningsEntryType[]) {
    const l = ledger({ [ORG]: { pendingPayoutCents: 0n, totalRevenueCents: 0n } });
    await moveEarnings(l.tx, { orgId: ORG, amountCents: 10n, type });
    assert.deepEqual(l.profiles[ORG], { pendingPayoutCents: 10n, totalRevenueCents: 10n }, type);
  }
  const l = ledger({ [ORG]: { pendingPayoutCents: 0n, totalRevenueCents: 500n } });
  const result = await moveEarnings(l.tx, { orgId: ORG, amountCents: 500n, type: "payout_restored", referenceId: "pay_1" });
  assert.deepEqual(result, { moved: true, balanceAfterCents: 500n });
  assert.deepEqual(l.profiles[ORG], { pendingPayoutCents: 500n, totalRevenueCents: 500n }, "money put back is not new revenue");
  assert.equal(l.rows.length, 1);
  assert.equal(l.rows[0]!.type, "payout_restored");
  assert.equal(l.rows[0]!.description, null);
});

test("a payout takes from the balance, never from revenue, and the row is negative", async () => {
  const l = ledger({ [ORG]: { pendingPayoutCents: 1500n, totalRevenueCents: 2000n } });
  const result = await moveEarnings(l.tx, { orgId: ORG, amountCents: -1000n, type: "payout_reserved", referenceId: "pay_2" });
  assert.deepEqual(result, { moved: true, balanceAfterCents: 500n });
  assert.deepEqual(l.profiles[ORG], { pendingPayoutCents: 500n, totalRevenueCents: 2000n });
  assert.deepEqual(l.rows, [
    { orgId: ORG, amountCents: -1000n, type: "payout_reserved", referenceId: "pay_2", description: null, balanceAfter: 500n },
  ]);
});

test("a take larger than the balance changes nothing and writes nothing", async () => {
  const l = ledger({ [ORG]: { pendingPayoutCents: 999n, totalRevenueCents: 999n } });
  const result = await moveEarnings(l.tx, { orgId: ORG, amountCents: -1000n, type: "payout_reserved" });
  assert.deepEqual(result, { moved: false, reason: "balance_short" });
  assert.deepEqual(l.profiles[ORG], { pendingPayoutCents: 999n, totalRevenueCents: 999n });
  assert.equal(l.rows.length, 0);
});

test("taking the whole balance leaves exactly zero", async () => {
  const l = ledger({ [ORG]: { pendingPayoutCents: 1000n, totalRevenueCents: 1000n } });
  const result = await moveEarnings(l.tx, { orgId: ORG, amountCents: -1000n, type: "payout_reserved" });
  assert.deepEqual(result, { moved: true, balanceAfterCents: 0n });
  assert.equal(l.rows[0]!.balanceAfter, 0n);
});

test("two takes of the same balance: the second finds it gone", async () => {
  const l = ledger({ [ORG]: { pendingPayoutCents: 1000n, totalRevenueCents: 1000n } });
  const first = await moveEarnings(l.tx, { orgId: ORG, amountCents: -1000n, type: "payout_reserved", referenceId: "a" });
  const second = await moveEarnings(l.tx, { orgId: ORG, amountCents: -1000n, type: "payout_reserved", referenceId: "b" });
  assert.equal(first.moved, true);
  assert.deepEqual(second, { moved: false, reason: "balance_short" });
  assert.equal(l.rows.length, 1);
  assert.equal(l.profiles[ORG]!.pendingPayoutCents, 0n);
});

test("an organization with no publisher profile: nothing is written, either way", async () => {
  const l = ledger({});
  assert.deepEqual(await moveEarnings(l.tx, { orgId: ORG, amountCents: 5n, type: "sale" }), { moved: false, reason: "no_profile" });
  assert.deepEqual(await moveEarnings(l.tx, { orgId: ORG, amountCents: -5n, type: "payout_reserved" }), { moved: false, reason: "no_profile" });
  assert.deepEqual(await moveEarnings(l.tx, { orgId: ORG, amountCents: 0n, type: "sale" }), { moved: false, reason: "no_profile" });
  assert.equal(l.rows.length, 0);
});

test("an amount of zero changes nothing and writes no row", async () => {
  const l = ledger({ [ORG]: { pendingPayoutCents: 70n, totalRevenueCents: 70n } });
  for (const type of ["sale", "payout_reserved", "payout_restored"] as EarningsEntryType[]) {
    assert.deepEqual(await moveEarnings(l.tx, { orgId: ORG, amountCents: 0n, type }), { moved: true, balanceAfterCents: 70n });
  }
  assert.equal(l.rows.length, 0);
  assert.equal(l.calls.includes("updateMany"), false);
  assert.deepEqual(l.profiles[ORG], { pendingPayoutCents: 70n, totalRevenueCents: 70n });
});

test("a type whose sign does not fit the amount throws before anything is touched", async () => {
  const l = ledger({ [ORG]: { pendingPayoutCents: 70n, totalRevenueCents: 70n } });
  await assert.rejects(() => moveEarnings(l.tx, { orgId: ORG, amountCents: -5n, type: "sale" }), EarningsLedgerError);
  await assert.rejects(() => moveEarnings(l.tx, { orgId: ORG, amountCents: -5n, type: "payout_restored" }), EarningsLedgerError);
  await assert.rejects(() => moveEarnings(l.tx, { orgId: ORG, amountCents: 5n, type: "payout_reserved" }), EarningsLedgerError);
  await assert.rejects(
    () => moveEarnings(l.tx, { orgId: ORG, amountCents: 5 as unknown as bigint, type: "sale" }),
    EarningsLedgerError,
  );
  assert.equal(l.calls.length, 0);
  assert.equal(l.rows.length, 0);
});

test("the rows of a creator always add up to the balance", async () => {
  const l = ledger({ [ORG]: { pendingPayoutCents: 0n, totalRevenueCents: 0n } });
  const steps: Array<[bigint, EarningsEntryType]> = [
    [450n, "sale"],
    [900n, "subscription"],
    [-1000n, "payout_reserved"],
    [1000n, "payout_restored"],
    [125n, "contributor_share"],
    [-5000n, "payout_reserved"], // too much: refused, no row
    [-1475n, "payout_reserved"],
    [60n, "job"],
  ];
  for (const [amountCents, type] of steps) await moveEarnings(l.tx, { orgId: ORG, amountCents, type });
  const sum = l.rows.reduce((total, row) => total + row.amountCents, 0n);
  assert.equal(sum, l.profiles[ORG]!.pendingPayoutCents);
  assert.equal(l.profiles[ORG]!.pendingPayoutCents, 60n);
  assert.equal(l.rows.length, steps.length - 1);
  assert.equal(l.rows[l.rows.length - 1]!.balanceAfter, 60n);
  // Each row's balance is the running total up to and including it.
  let running = 0n;
  for (const row of l.rows) {
    running += row.amountCents;
    assert.equal(row.balanceAfter, running);
  }
  // Revenue counted income only: 450 + 900 + 125 + 60.
  assert.equal(l.profiles[ORG]!.totalRevenueCents, 1535n);
});

test("the ledger core imports nothing: no settings, no database client", () => {
  const source = readFileSync(new URL("../services/earningsLedger.ts", import.meta.url), "utf8");
  assert.equal(/^\s*import\s/m.test(source), false);
  assert.equal(/require\(|process\.env/.test(source), false);
});
