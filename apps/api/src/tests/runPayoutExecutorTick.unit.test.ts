import assert from "node:assert/strict";
import test from "node:test";

import {
  runPayoutExecutorTick,
  type ClaimablePayoutRow,
  type PayoutExecutorTickDeps,
} from "../services/runPayoutExecutorTick.js";
import type { PayoutSettleResult } from "../services/payoutExecutor.js";

// Drives the pure payout-executor tick (W2). Pins: claim-before-settle,
// per-method routing, the recovery path (processing rows skip the claim),
// and that only a `failed` outcome triggers reservation release.

function row(over: Partial<ClaimablePayoutRow> = {}): ClaimablePayoutRow {
  return {
    id: "p1",
    publisherId: "org",
    amountCents: 5_000n,
    payoutMethod: "credits",
    payoutAddress: null,
    txSignature: null,
    status: "pending",
    ...over,
  };
}

interface Recorded {
  claims: string[];
  credits: ClaimablePayoutRow[];
  cryptos: ClaimablePayoutRow[];
  restores: Array<{ id: string; reason: string }>;
}

function makeDeps(
  rows: ClaimablePayoutRow[],
  over: Partial<PayoutExecutorTickDeps> = {},
): { deps: PayoutExecutorTickDeps; rec: Recorded } {
  const rec: Recorded = { claims: [], credits: [], cryptos: [], restores: [] };
  const deps: PayoutExecutorTickDeps = {
    loadClaimablePayouts: async () => rows,
    claim: async (id) => {
      rec.claims.push(id);
      return true;
    },
    settleCredits: async (r) => {
      rec.credits.push(r);
      return { outcome: "completed" } as PayoutSettleResult;
    },
    settleCrypto: async (r) => {
      rec.cryptos.push(r);
      return { outcome: "completed", txSignature: "sig" } as PayoutSettleResult;
    },
    failAndRestore: async (r, reason) => {
      rec.restores.push({ id: r.id, reason });
    },
    ...over,
  };
  return { deps, rec };
}

test("a pending credits payout is claimed then settled via credits", async () => {
  const { deps, rec } = makeDeps([row()]);
  const res = await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.deepEqual(rec.claims, ["p1"]);
  assert.equal(rec.credits.length, 1);
  assert.equal(rec.cryptos.length, 0);
  assert.equal(res.completed, 1);
  assert.equal(res.claimable, 1);
});

test("a crypto payout routes to settleCrypto", async () => {
  const { deps, rec } = makeDeps([
    row({ payoutMethod: "crypto_sol", payoutAddress: "addr" }),
  ]);
  const res = await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.equal(rec.cryptos.length, 1);
  assert.equal(rec.credits.length, 0);
  assert.equal(res.completed, 1);
});

test("a lost claim skips settlement entirely", async () => {
  const { deps, rec } = makeDeps([row()], { claim: async () => false });
  const res = await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.equal(res.skipped, 1);
  assert.equal(res.completed, 0);
  assert.equal(rec.credits.length, 0);
});

test("an already-processing row (recovery) skips the claim and settles", async () => {
  const { deps, rec } = makeDeps([
    row({ status: "processing", payoutMethod: "crypto_sol", txSignature: "s" }),
  ]);
  const res = await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.deepEqual(rec.claims, [], "processing rows are not re-claimed");
  assert.equal(rec.cryptos.length, 1);
  assert.equal(res.completed, 1);
});

test("only a `failed` outcome releases the reservation", async () => {
  const { deps, rec } = makeDeps([row()], {
    settleCredits: async () => ({
      outcome: "failed",
      reason: "boom",
    }),
  });
  const res = await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.equal(res.failed, 1);
  assert.deepEqual(rec.restores, [{ id: "p1", reason: "boom" }]);
});

test("pending_confirmation counts as pending and does NOT restore", async () => {
  const { deps, rec } = makeDeps([
    row({ payoutMethod: "crypto_sol", payoutAddress: "a" }),
  ], {
    settleCrypto: async () => ({
      outcome: "pending_confirmation",
      txSignature: "s",
    }),
  });
  const res = await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.equal(res.pending, 1);
  assert.equal(res.failed, 0);
  assert.equal(rec.restores.length, 0, "in-flight money is never released");
});

test("an unsupported method fails the row rather than dropping it", async () => {
  const { deps, rec } = makeDeps([row({ payoutMethod: "carrier_pigeon" })]);
  const res = await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.equal(res.failed, 1);
  assert.equal(rec.restores.length, 1);
  assert.match(rec.restores[0]!.reason, /unsupported/);
});

test("one row throwing does not sink the batch", async () => {
  let calls = 0;
  const { deps } = makeDeps([row({ id: "a" }), row({ id: "b" })], {
    settleCredits: async (r) => {
      calls += 1;
      if (r.id === "a") throw new Error("db hiccup");
      return { outcome: "completed" };
    },
  });
  const res = await runPayoutExecutorTick({ limit: 10 }, deps);
  assert.equal(calls, 2, "both rows attempted");
  assert.equal(res.completed, 1);
  assert.equal(res.pending, 1, "the thrower stays processing for a retry");
});
