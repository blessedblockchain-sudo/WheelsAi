// Requesting a payout, the core (services/payoutRequests.ts requestPayout)
// over an in-memory database.
//
// Launch review #25 (P0): the request once checked for an open payout
// OUTSIDE the transaction and took the balance unconditionally, so two
// concurrent requests could both reserve the full balance (a negative
// balance, two payable rows). The reservation is a conditional take made by
// the earnings ledger (services/earningsLedger.ts moveEarnings) in the same
// transaction as the payout row, the database lets one open payout in per
// creator, and nothing is reserved unless every check passed.
import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import { payoutRevenueBreakdown, requestPayout, type RequestPayoutResult } from "../services/payoutRequests.js";
import { fakeDb, NOW, ORG, OTHER_ORG, payoutRow, requestDepsOver, type RequestWorld } from "./payoutFakes.js";

const WALLET = Keypair.generate().publicKey.toBase58();
const PAYING_WALLET = Keypair.generate().publicKey.toBase58();
const TREASURY = Keypair.generate().publicKey.toBase58();
const DEPOSIT = Keypair.generate().publicKey.toBase58();
const [PROGRAM_OWNED] = PublicKey.findProgramAddressSync([Buffer.from("off-curve")], new PublicKey(TREASURY));
const OFF_CURVE = PROGRAM_OWNED.toBase58();

function world(balance: bigint | null, rows = [] as ReturnType<typeof payoutRow>[], over: RequestWorld = {}) {
  const { state, db } = fakeDb(rows, balance === null ? {} : { [ORG]: balance });
  const { deps, chainReads } = requestDepsOver(db, {
    platformAddresses: [PAYING_WALLET, TREASURY, DEPOSIT],
    ...over,
  });
  return { state, db, deps, chainReads };
}

function refusalOf(result: RequestPayoutResult) {
  assert.equal(result.outcome, "refused");
  return result.outcome === "refused" ? result.refusal : null;
}

function nothingWritten(state: ReturnType<typeof world>["state"], balance: bigint | undefined, payouts = 0) {
  assert.equal(state.balances[ORG], balance);
  assert.equal(state.payouts.length, payouts);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.balanceWrites + state.payoutInserts, 0);
}

// ---------------------------------------------------------------
// What a request writes
// ---------------------------------------------------------------

test("a credits request with no amount takes the whole balance: one row, one reservation, one ledger row", async () => {
  const { state, deps, chainReads } = world(2500n);
  const result = await requestPayout(deps, { orgId: ORG, payoutMethod: "credits" });
  assert.equal(result.outcome, "requested");
  if (result.outcome !== "requested") return;
  assert.equal(result.remainingCents, 0n);
  assert.equal(result.atCap, false);
  assert.equal(state.balances[ORG], 0n);
  assert.equal(state.payouts.length, 1);
  const row = state.payouts[0]!;
  assert.equal(result.payout.id, row.id);
  assert.deepEqual(
    {
      publisherId: row.publisherId,
      amountCents: row.amountCents,
      payoutMethod: row.payoutMethod,
      payoutAddress: row.payoutAddress,
      status: row.status,
      grossRevenueCents: row.grossRevenueCents,
      platformFeeCents: row.platformFeeCents,
      periodEnd: row.periodEnd,
      periodStart: row.periodStart,
    },
    {
      publisherId: ORG,
      amountCents: 2500n,
      payoutMethod: "credits",
      payoutAddress: null,
      status: "pending",
      // As before: what buyers paid for it, and the platform's tenth.
      grossRevenueCents: 2778n,
      platformFeeCents: 278n,
      periodEnd: NOW,
      periodStart: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
    },
  );
  assert.deepEqual(state.ledger, [
    {
      orgId: ORG,
      amountCents: -2500n,
      type: "payout_reserved",
      referenceId: row.id,
      description: "Payout requested",
      balanceAfter: 0n,
    },
  ]);
  assert.equal(chainReads.length, 0, "credits never read the chain");
});

test("the revenue breakdown is the same whole-cent arithmetic as before", () => {
  for (const cents of [500, 501, 999, 1000, 2500, 4120, 50_000, 123_457]) {
    const { grossRevenueCents, platformFeeCents } = payoutRevenueBreakdown(BigInt(cents));
    assert.equal(grossRevenueCents, BigInt(Math.round(cents / 0.9)), `${cents}`);
    assert.equal(platformFeeCents, grossRevenueCents - BigInt(cents));
  }
});

test("an amount asked for is the amount reserved; the rest stays", async () => {
  const { state, deps } = world(4120n);
  const result = await requestPayout(deps, { orgId: ORG, payoutMethod: "credits", amountCents: 1000 });
  assert.equal(result.outcome, "requested");
  assert.equal(result.outcome === "requested" && result.remainingCents, 3120n);
  assert.equal(state.balances[ORG], 3120n);
  assert.equal(state.payouts[0]!.amountCents, 1000n);
  assert.equal(state.ledger[0]!.amountCents, -1000n);
  assert.equal(state.ledger[0]!.balanceAfter, 3120n);
});

test("a wallet request stores the canonical address after ONE chain read", async () => {
  for (const [method, chain] of [
    ["crypto_usdc", "absent"],
    ["crypto_sol", "wallet"],
  ] as const) {
    const { state, deps, chainReads } = world(4120n, [], { chain });
    const result = await requestPayout(deps, { orgId: ORG, payoutMethod: method, payoutAddress: `  ${WALLET}\n` });
    assert.equal(result.outcome, "requested", method);
    assert.deepEqual(chainReads, [WALLET]);
    assert.equal(state.payouts[0]!.payoutAddress, WALLET);
    assert.equal(state.payouts[0]!.payoutMethod, method);
    assert.equal(state.payouts[0]!.amountCents, 4120n);
    assert.equal(state.balances[ORG], 0n);
  }
});

test("the default amount for a wallet is the largest allowed: the cap, then what is left today", async () => {
  // Above the cap: the cap is requested and the rest stays.
  const capped = world(74_000n);
  const first = await requestPayout(capped.deps, { orgId: ORG, payoutMethod: "crypto_usdc", payoutAddress: WALLET });
  assert.equal(first.outcome, "requested");
  if (first.outcome !== "requested") return;
  assert.equal(first.payout.amountCents, 50_000n);
  assert.equal(first.atCap, true);
  assert.equal(first.remainingCents, 24_000n);
  assert.equal(capped.state.balances[ORG], 24_000n);

  // $880 already taken to a wallet today: $120 is left of the day's $1,000.
  const earlier = payoutRow({
    id: "00000000-0000-4000-8000-000000000001",
    payoutMethod: "crypto_usdc",
    status: "completed",
    amountCents: 88_000n,
    requestedAt: new Date("2026-10-10T03:00:00Z"),
  });
  const dayLeft = world(74_000n, [earlier]);
  const second = await requestPayout(dayLeft.deps, { orgId: ORG, payoutMethod: "crypto_usdc", payoutAddress: WALLET });
  assert.equal(second.outcome, "requested");
  if (second.outcome !== "requested") return;
  assert.equal(second.payout.amountCents, 12_000n);
  assert.equal(second.atCap, false);
});

// ---------------------------------------------------------------
// What counts against the day
// ---------------------------------------------------------------

test("the day limit counts this creator's wallet payouts since midnight UTC that were not given back", async () => {
  const at = (iso: string) => new Date(iso);
  let n = 0;
  const earlier = (over: Parameters<typeof payoutRow>[0]) =>
    payoutRow({
      id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      payoutMethod: "crypto_usdc",
      status: "completed",
      amountCents: 40_000n,
      requestedAt: at("2026-10-10T01:00:00Z"),
      ...over,
    });
  const cases: Array<{ name: string; rows: ReturnType<typeof payoutRow>[]; usedCents: bigint }> = [
    { name: "completed today", rows: [earlier({})], usedCents: 40_000n },
    { name: "SOL counts with USDC", rows: [earlier({}), earlier({ payoutMethod: "crypto_sol" })], usedCents: 80_000n },
    { name: "at midnight exactly", rows: [earlier({ requestedAt: at("2026-10-10T00:00:00.000Z") })], usedCents: 40_000n },
    { name: "a millisecond before midnight", rows: [earlier({ requestedAt: at("2026-10-09T23:59:59.999Z") })], usedCents: 0n },
    { name: "credits never count", rows: [earlier({ payoutMethod: "credits" })], usedCents: 0n },
    { name: "cancelled gave it back", rows: [earlier({ status: "cancelled" })], usedCents: 0n },
    { name: "failed gave it back", rows: [earlier({ status: "failed" })], usedCents: 0n },
    { name: "another creator's", rows: [earlier({ publisherId: OTHER_ORG })], usedCents: 0n },
  ];
  for (const { name, rows, usedCents } of cases) {
    const { deps } = world(200_000n, rows);
    // Ask for everything the day has left, then one cent more.
    const left = 100_000n - usedCents;
    const fits = left > 50_000n ? 50_000n : left;
    const over = await requestPayout(deps, {
      orgId: ORG,
      payoutMethod: "crypto_usdc",
      payoutAddress: WALLET,
      amountCents: Number(left + 1n),
    });
    assert.ok(
      ["payout_daily_limit", "payout_above_limit"].includes(refusalOf(over)!.code),
      `${name}: one cent over is refused`,
    );
    if (left <= 50_000n) assert.equal(refusalOf(over)!.code, "payout_daily_limit", name);
    const ok = await requestPayout(deps, {
      orgId: ORG,
      payoutMethod: "crypto_usdc",
      payoutAddress: WALLET,
      amountCents: Number(fits),
    });
    assert.equal(ok.outcome, "requested", `${name}: exactly what is left goes through`);
  }
});

test("pending and processing wallet payouts count too, once the open one is out of the way", async () => {
  // An open payout refuses the request first, so the count of open payouts
  // only shows when that read cannot see it (a request racing the insert).
  for (const status of ["pending", "processing"]) {
    const open = payoutRow({ payoutMethod: "crypto_usdc", status, amountCents: 99_800n, requestedAt: NOW });
    const { state, deps } = world(200_000n, [open]);
    state.openPayoutVisible = false;
    const result = await requestPayout(deps, { orgId: ORG, payoutMethod: "crypto_usdc", payoutAddress: WALLET });
    assert.equal(refusalOf(result)!.code, "payout_daily_limit", status);
    nothingWritten(state, 200_000n, 1);
  }
});

// ---------------------------------------------------------------
// A refusal reserves nothing
// ---------------------------------------------------------------

test("every refusal leaves the balance, the payouts and the ledger as they were", async () => {
  const open = payoutRow({ status: "processing" });
  const cases: Array<{
    name: string;
    balance: bigint | null;
    rows?: ReturnType<typeof payoutRow>[];
    over?: RequestWorld;
    input: Record<string, unknown>;
    refusal: Record<string, unknown>;
    chainReads?: number;
  }> = [
    { name: "a method nobody knows", balance: 4120n, input: { payoutMethod: "paypal" }, refusal: { code: "invalid_payload" } },
    { name: "a fraction of a cent", balance: 4120n, input: { payoutMethod: "credits", amountCents: 1000.5 }, refusal: { code: "invalid_payload" } },
    { name: "zero", balance: 4120n, input: { payoutMethod: "credits", amountCents: 0 }, refusal: { code: "invalid_payload" } },
    { name: "a negative amount", balance: 4120n, input: { payoutMethod: "credits", amountCents: -1000 }, refusal: { code: "invalid_payload" } },
    { name: "an amount as text", balance: 4120n, input: { payoutMethod: "credits", amountCents: "1000" }, refusal: { code: "invalid_payload" } },
    { name: "an address that is not text", balance: 4120n, input: { payoutMethod: "crypto_usdc", payoutAddress: { a: 1 } }, refusal: { code: "invalid_payload" } },
    {
      name: "SOL while it cannot be priced",
      balance: 4120n,
      over: { settings: { solOffered: false } },
      input: { payoutMethod: "crypto_sol", payoutAddress: WALLET },
      refusal: { code: "payout_method_unavailable" },
    },
    { name: "a payout already open", balance: 4120n, rows: [open], input: { payoutMethod: "credits" }, refusal: { code: "payout_in_progress" } },
    { name: "a balance below the minimum", balance: 310n, input: { payoutMethod: "credits" }, refusal: { code: "payout_below_minimum", balanceCents: 310n } },
    { name: "no profile at all", balance: null, input: { payoutMethod: "credits" }, refusal: { code: "payout_below_minimum", balanceCents: 0n } },
    { name: "an amount below the minimum", balance: 4120n, input: { payoutMethod: "credits", amountCents: 499 }, refusal: { code: "payout_below_minimum" } },
    { name: "an amount above the balance", balance: 4120n, input: { payoutMethod: "credits", amountCents: 4121 }, refusal: { code: "payout_above_balance", balanceCents: 4120n } },
    {
      name: "an amount above the cap",
      balance: 74_000n,
      input: { payoutMethod: "crypto_usdc", payoutAddress: WALLET, amountCents: 50_001 },
      refusal: { code: "payout_above_limit", perPayoutCents: 50_000n },
    },
    { name: "no address", balance: 4120n, input: { payoutMethod: "crypto_usdc" }, refusal: { code: "payout_address_required" } },
    { name: "an empty address", balance: 4120n, input: { payoutMethod: "crypto_usdc", payoutAddress: "   " }, refusal: { code: "payout_address_required" } },
    {
      name: "not an address",
      balance: 4120n,
      input: { payoutMethod: "crypto_usdc", payoutAddress: "AttackerWa11et1111111111111111111111111111" },
      refusal: { code: "invalid_payout_address", problem: "not_an_address" },
    },
    {
      // A real address that no key controls: a token account or another
      // account a program owns. It is told so, without a chain read.
      name: "an address off the curve",
      balance: 4120n,
      input: { payoutMethod: "crypto_usdc", payoutAddress: OFF_CURVE },
      refusal: { code: "invalid_payout_address", problem: "not_a_wallet" },
    },
    ...[PAYING_WALLET, TREASURY, DEPOSIT].map((own, i) => ({
      name: `the platform's own address ${i}`,
      balance: 4120n,
      input: { payoutMethod: "crypto_sol", payoutAddress: own },
      refusal: { code: "invalid_payout_address", problem: "platform" },
    })),
    {
      name: "a token account or a program",
      balance: 4120n,
      over: { chain: "not_a_wallet" },
      input: { payoutMethod: "crypto_usdc", payoutAddress: WALLET },
      refusal: { code: "invalid_payout_address", problem: "not_a_wallet" },
      chainReads: 1,
    },
    {
      name: "the chain read answered nothing",
      balance: 4120n,
      over: { chain: "unavailable" },
      input: { payoutMethod: "crypto_usdc", payoutAddress: WALLET },
      refusal: { code: "payout_check_unavailable" },
      chainReads: 1,
    },
    {
      name: "the chain read threw",
      balance: 4120n,
      over: {
        chain: async () => {
          throw new Error("429 Too Many Requests: https://rpc.example");
        },
      },
      input: { payoutMethod: "crypto_usdc", payoutAddress: WALLET },
      refusal: { code: "payout_check_unavailable" },
      chainReads: 1,
    },
  ];
  for (const c of cases) {
    const { state, deps, chainReads } = world(c.balance, c.rows ?? [], c.over);
    const result = await requestPayout(deps, { orgId: ORG, ...c.input } as any);
    assert.deepEqual(refusalOf(result), c.refusal, c.name);
    nothingWritten(state, c.balance ?? undefined, c.rows?.length ?? 0);
    assert.equal(chainReads.length, c.chainReads ?? 0, `${c.name}: chain reads`);
  }
});

test("the checks run in the documented order: the first that fails is the answer", async () => {
  const open = payoutRow({ status: "pending" });
  // Everything wrong at once, then one thing put right at a time.
  const steps: Array<{ rows: ReturnType<typeof payoutRow>[]; balance: bigint; over?: RequestWorld; input: Record<string, unknown>; code: string }> = [
    { rows: [open], balance: 100n, over: { settings: { solOffered: false } }, input: { payoutMethod: "crypto_sol", amountCents: 60_000 }, code: "payout_method_unavailable" },
    { rows: [open], balance: 100n, input: { payoutMethod: "crypto_sol", amountCents: 60_000 }, code: "payout_in_progress" },
    { rows: [], balance: 100n, input: { payoutMethod: "crypto_sol", amountCents: 60_000 }, code: "payout_below_minimum" },
    { rows: [], balance: 55_000n, input: { payoutMethod: "crypto_sol", amountCents: 60_000 }, code: "payout_above_balance" },
    { rows: [], balance: 200_000n, input: { payoutMethod: "crypto_sol", amountCents: 60_000 }, code: "payout_above_limit" },
    { rows: [], balance: 200_000n, over: { settings: { perDayCents: 50_000n } }, input: { payoutMethod: "crypto_sol", amountCents: 50_000 }, code: "payout_address_required" },
    { rows: [], balance: 200_000n, over: { settings: { perDayCents: 49_999n } }, input: { payoutMethod: "crypto_sol", amountCents: 50_000 }, code: "payout_daily_limit" },
    { rows: [], balance: 200_000n, input: { payoutMethod: "crypto_sol", amountCents: 50_000, payoutAddress: "nope" }, code: "invalid_payout_address" },
    { rows: [], balance: 200_000n, over: { chain: "unavailable" }, input: { payoutMethod: "crypto_sol", amountCents: 50_000, payoutAddress: WALLET }, code: "payout_check_unavailable" },
  ];
  for (const step of steps) {
    const { deps } = world(step.balance, step.rows, step.over);
    const result = await requestPayout(deps, { orgId: ORG, ...step.input } as any);
    assert.equal(refusalOf(result)!.code, step.code);
  }
});

// ---------------------------------------------------------------
// Two at once
// ---------------------------------------------------------------

test("two requests at once: one payout, one reservation, the balance never below zero", async () => {
  for (const amountCents of [undefined, 1000]) {
    const { state, deps } = world(2500n);
    const results = await Promise.all([
      requestPayout(deps, { orgId: ORG, payoutMethod: "credits", amountCents }),
      requestPayout(deps, { orgId: ORG, payoutMethod: "credits", amountCents }),
    ]);
    const won = results.filter((r) => r.outcome === "requested");
    const lost = results.filter((r) => r.outcome === "refused");
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    // The database let one open payout in: the other is told one is in progress.
    assert.equal(refusalOf(lost[0]!)!.code, "payout_in_progress");
    const amount = BigInt(amountCents ?? 2500);
    assert.equal(state.balances[ORG], 2500n - amount);
    assert.equal(state.payouts.length, 1);
    assert.equal(state.payouts[0]!.amountCents, amount);
    assert.equal(state.balanceWrites, 1);
    assert.deepEqual(state.ledger, [
      {
        orgId: ORG,
        amountCents: -amount,
        type: "payout_reserved",
        referenceId: state.payouts[0]!.id,
        description: "Payout requested",
        balanceAfter: 2500n - amount,
      },
    ]);
  }
});

test("a reservation that loses the race writes no payout row", async () => {
  // The request read 2500; by the transaction the committed balance is 900.
  const { state, db, deps } = world(2500n);
  const racing = {
    ...deps,
    transaction: async <T>(fn: Parameters<typeof deps.transaction<T>>[0]) => {
      state.balances[ORG] = 900n;
      return deps.transaction(fn);
    },
  };
  void db;
  const result = await requestPayout(racing, { orgId: ORG, payoutMethod: "credits" });
  assert.deepEqual(refusalOf(result), { code: "payout_reservation_conflict" });
  assert.equal(state.balances[ORG], 900n);
  assert.equal(state.payouts.length, 0, "the payout row rolled back with the reservation");
  assert.equal(state.ledger.length, 0, "no ledger row for a reservation that did not happen");
  assert.equal(state.payoutInserts + state.balanceWrites, 0);
});

test("a payout that finished while the request waited on the chain cannot take the day past its limit", async () => {
  // The request read $0.00 used today. While it waited for the chain's word
  // on the address, an earlier payout of $990.00 was requested, sent and
  // completed: no payout is open, so the one-open-payout rule says nothing.
  const landed = payoutRow({
    id: "00000000-0000-4000-8000-000000000077",
    payoutMethod: "crypto_usdc",
    status: "completed",
    amountCents: 99_000n,
    requestedAt: NOW,
  });
  for (const [amountCents, fits] of [
    [1001, false],
    [undefined, false],
    [1000, true],
  ] as const) {
    const { state, deps } = world(74_000n);
    const racing = {
      ...deps,
      transaction: async <T>(fn: Parameters<typeof deps.transaction<T>>[0]) => {
        state.payouts.push({ ...landed });
        return deps.transaction(fn);
      },
    };
    const result = await requestPayout(racing, { orgId: ORG, payoutMethod: "crypto_usdc", payoutAddress: WALLET, amountCents });
    if (fits) {
      // Exactly what is left of the day still goes through.
      assert.equal(result.outcome, "requested");
      assert.equal(state.balances[ORG], 73_000n);
      assert.equal(state.payouts.length, 2);
      continue;
    }
    assert.deepEqual(refusalOf(result), { code: "payout_daily_limit" });
    assert.equal(state.balances[ORG], 74_000n, "nothing was reserved");
    assert.deepEqual(state.payouts.map((p) => p.id), [landed.id], "the new payout row rolled back");
    assert.equal(state.ledger.length, 0);
    assert.equal(state.payoutInserts + state.balanceWrites, 0);
  }
});

test("credits are never held to the day's limit, in the transaction either", async () => {
  const landed = payoutRow({
    id: "00000000-0000-4000-8000-000000000078",
    payoutMethod: "crypto_usdc",
    status: "completed",
    amountCents: 100_000n,
    requestedAt: NOW,
  });
  const { state, deps } = world(200_000n, [landed]);
  const result = await requestPayout(deps, { orgId: ORG, payoutMethod: "credits" });
  assert.equal(result.outcome, "requested");
  assert.equal(state.balances[ORG], 0n);
});

test("a profile that is gone at the reservation: the same conflict, and nothing is written", async () => {
  const { state, deps } = world(2500n);
  const racing = {
    ...deps,
    transaction: async <T>(fn: Parameters<typeof deps.transaction<T>>[0]) => {
      delete state.balances[ORG];
      return deps.transaction(fn);
    },
  };
  const result = await requestPayout(racing, { orgId: ORG, payoutMethod: "credits" });
  assert.deepEqual(refusalOf(result), { code: "payout_reservation_conflict" });
  assert.equal(state.payouts.length, 0);
  assert.equal(state.ledger.length, 0);
});

test("a database error is thrown as it is, with nothing written; it is the caller that answers", async () => {
  const { state, deps } = world(2500n);
  const failing = {
    ...deps,
    transaction: async <T>(fn: Parameters<typeof deps.transaction<T>>[0]) =>
      deps.transaction(async (tx) => {
        await fn(tx);
        throw new Error("Transaction API error: could not commit");
      }),
  };
  await assert.rejects(requestPayout(failing, { orgId: ORG, payoutMethod: "credits" }), /could not commit/);
  assert.equal(state.balances[ORG], 2500n);
  assert.equal(state.payouts.length, 0);
  assert.equal(state.ledger.length, 0);
});

test("after a cancel the creator can request again, and each move has its ledger row", async () => {
  const { cancelPayout, buildCancelPayoutDeps } = await import("../services/payoutRequests.js");
  const { state, db, deps } = world(2500n);
  const first = await requestPayout(deps, { orgId: ORG, payoutMethod: "credits" });
  assert.equal(first.outcome, "requested");
  if (first.outcome !== "requested") return;
  const cancelled = await cancelPayout(buildCancelPayoutDeps(db), { payoutId: first.payout.id, orgId: ORG });
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(state.balances[ORG], 2500n);
  const second = await requestPayout(deps, { orgId: ORG, payoutMethod: "credits", amountCents: 500 });
  assert.equal(second.outcome, "requested");
  assert.equal(state.balances[ORG], 2000n);
  assert.deepEqual(
    state.ledger.map((row) => [row.type, row.amountCents, row.balanceAfter]),
    [
      ["payout_reserved", -2500n, 0n],
      ["payout_restored", 2500n, 2500n],
      ["payout_reserved", -500n, 2000n],
    ],
  );
});
