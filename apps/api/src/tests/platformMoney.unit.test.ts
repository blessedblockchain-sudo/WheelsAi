import assert from "node:assert/strict";
import { test } from "node:test";

import "./unitEnv.js";

import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  NO_TREASURY_ADDRESS,
  computePlatformMoney,
  creditsSold,
  parseUtcDay,
  reconcile,
  resolveMoneyRange,
  treasuryProven,
  type IncomeFacts,
  type MoneyRange,
  type PlatformMoneyDeps,
} from "../services/platformMoney.js";

const HOT = Keypair.generate().publicKey.toBase58();
const TREASURY = Keypair.generate().publicKey.toBase58();
const DEPOSIT_A = Keypair.generate().publicKey.toBase58();
const DEPOSIT_B = Keypair.generate().publicKey.toBase58();
const NOW = new Date("2026-10-11T12:30:00.000Z");
const RANGE: MoneyRange = { from: new Date("2026-10-01T00:00:00.000Z"), to: NOW };

// Above 2^53: a JSON number would lose the last digits.
const HUGE = 9_007_199_254_740_993_123n;

function income(over: Partial<IncomeFacts> = {}): IncomeFacts {
  return {
    walletTopups: [],
    deposits: [],
    stripe: { count: 0, amountCents: 0n },
    purchases: { count: 0, amountCents: 0n },
    bonusesGrantedCents: 0n,
    debits: [],
    marketplaceFeesCents: 0n,
    x402: [],
    ...over,
  };
}

function deps(over: Partial<PlatformMoneyDeps> = {}): PlatformMoneyDeps {
  return {
    adminKey: () => "an-admin-key-of-enough-length",
    now: () => NOW,
    network: () => "devnet",
    readCustomers: async () => ({ balanceCents: 123_456n, organizationsWithBalance: 7 }),
    readCreators: async () => ({
      owedCents: 50_000n,
      openPayouts: [
        { method: "crypto_usdc", count: 2, amountCents: 30_000n },
        { method: "credits", count: 1, amountCents: 1_000n },
      ],
      paidOutInRange: [{ method: "crypto_sol", count: 3, amountCents: 9_000n }],
    }),
    readIncome: async () =>
      income({
        walletTopups: [
          { asset: "USDC", count: 2, amountCents: 5_000n },
          { asset: "SOL", count: 1, amountCents: 2_500n },
        ],
        deposits: [{ asset: "USDC", count: 4, amountCents: 40_000n }],
        stripe: { count: 3, amountCents: 30_000n },
        purchases: { count: 12, amountCents: 80_000n },
        bonusesGrantedCents: 1_500n,
        debits: [
          { type: "usage", amountCents: -7_000n },
          { type: "marketplace_job", amountCents: -2_000n },
        ],
        marketplaceFeesCents: 800n,
        x402: [{ asset: "USDC", count: 5, amountUsd: 12.5 }],
      }),
    treasurySetting: () => TREASURY,
    hotWalletAddress: () => HOT,
    readTreasuryRow: async () => ({ address: TREASURY }),
    isDepositAddress: async () => false,
    readWallets: async (addresses) =>
      addresses.map((a) =>
        a === HOT
          ? { lamports: 2_000_000_000n, usdcRaw: 150_000_000n }
          : { lamports: 9_000_000_000n, usdcRaw: 4_000_000_000n },
      ),
    readDepositHoldings: async () => ({ count: 2, lamports: 3_000_000n, usdcRaw: 20_000_000n }),
    readSweeps: async () => ({
      sent: 1,
      landedInRange: [
        { kind: "sweep_to_treasury", asset: "USDC", count: 2, amountRaw: 80_000_000n },
        { kind: "sweep_to_hot", asset: "SOL", count: 1, amountRaw: 500_000_000n },
      ],
      failedInRange: 1,
    }),
    readLedger: async () => ({
      receivedUsdcRaw: 100_000_000n,
      receivedLamports: 503_005_000n,
      swept: [
        // USDC: the hot wallet paid the fee. It took nothing from the address.
        { asset: "USDC", fromAddress: DEPOSIT_A, feePayer: HOT, landed: true, amountRaw: 80_000_000n, feeLamports: 5_000n },
        // SOL: the address paid its own fee.
        { asset: "SOL", fromAddress: DEPOSIT_B, feePayer: DEPOSIT_B, landed: true, amountRaw: 500_000_000n, feeLamports: 5_000n },
      ],
    }),
    clusterCheck: async () => "ok",
    switches: () => ({
      walletTopups: true,
      deposits: true,
      depositScan: true,
      sweeps: false,
      payouts: true,
    }),
    solPrice: async () => ({ source: "pyth", ok: true, ageSeconds: 3 }),
    ...over,
  };
}

function ok<T extends { state: string }>(section: T): Extract<T, { state: "ok" }> {
  assert.equal(section.state, "ok");
  return section as Extract<T, { state: "ok" }>;
}

// ============================================
// The range
// ============================================

test("a day is read only when it is a real calendar day written YYYY-MM-DD", () => {
  assert.equal(parseUtcDay("2026-10-01")?.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(parseUtcDay("2024-02-29")?.toISOString(), "2024-02-29T00:00:00.000Z");
  for (const bad of ["2026-02-30", "2026-13-01", "2026-1-1", "10/01/2026", "yesterday", "", null, 20261001, ["2026-10-01"]]) {
    assert.equal(parseUtcDay(bad), null, String(bad));
  }
});

test("the range defaults to the first day of the current UTC month and to now", () => {
  const r = resolveMoneyRange({}, NOW);
  assert.ok(r.ok);
  assert.equal(r.range.from.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(r.range.to.toISOString(), NOW.toISOString());

  // Late on the last day of a month in UTC: still that month.
  const edge = resolveMoneyRange({}, new Date("2026-12-31T23:59:59.000Z"));
  assert.ok(edge.ok);
  assert.equal(edge.range.from.toISOString(), "2026-12-01T00:00:00.000Z");
});

test("a given `to` covers that whole day, and a range that cannot be read is refused", () => {
  const r = resolveMoneyRange({ from: "2026-09-01", to: "2026-09-30" }, NOW);
  assert.ok(r.ok);
  assert.equal(r.range.from.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(r.range.to.toISOString(), "2026-10-01T00:00:00.000Z");

  const oneDay = resolveMoneyRange({ from: "2026-09-30", to: "2026-09-30" }, NOW);
  assert.ok(oneDay.ok);

  assert.equal(resolveMoneyRange({ from: "nope" }, NOW).ok, false);
  assert.equal(resolveMoneyRange({ to: "2026-02-30" }, NOW).ok, false);
  assert.equal(resolveMoneyRange({ from: "2026-09-02", to: "2026-08-01" }, NOW).ok, false);
  // `from` in the future with `to` left at now.
  assert.equal(resolveMoneyRange({ from: "2027-01-01" }, NOW).ok, false);
});

// ============================================
// The figures
// ============================================

test("every figure is answered from its read, with amounts as strings", async () => {
  const seen: MoneyRange[] = [];
  const body = await computePlatformMoney(
    deps({
      readSweeps: async (range) => {
        seen.push(range);
        return { sent: 1, landedInRange: [], failedInRange: 0 };
      },
    }),
    RANGE,
  );

  assert.equal(body.generatedAt, NOW.toISOString());
  assert.equal(body.network, "devnet");
  assert.deepEqual(body.range, { from: "2026-10-01T00:00:00.000Z", to: NOW.toISOString() });
  assert.deepEqual(seen, [RANGE]);

  assert.deepEqual(body.customers, { state: "ok", balanceCents: "123456", organizationsWithBalance: 7 });

  assert.deepEqual(body.creators, {
    state: "ok",
    owedCents: "50000",
    openPayouts: [
      { method: "credits", count: 1, amountCents: "1000" },
      { method: "crypto_usdc", count: 2, amountCents: "30000" },
    ],
    paidOutInRange: [{ method: "crypto_sol", count: 3, amountCents: "9000" }],
  });

  assert.deepEqual(body.income, {
    state: "ok",
    creditsSold: [
      { rail: "wallet_topup", asset: "SOL", count: 1, amountCents: "2500" },
      { rail: "wallet_topup", asset: "USDC", count: 2, amountCents: "5000" },
      { rail: "deposit", asset: "USDC", count: 4, amountCents: "40000" },
      { rail: "stripe", asset: null, count: 3, amountCents: "30000" },
      // 80,000 of purchases less 77,500 the three rails explain; 12 rows less 10.
      { rail: "other", asset: null, count: 2, amountCents: "2500" },
    ],
    bonusesGrantedCents: "1500",
    creditsUsed: [
      { type: "marketplace_job", amountCents: "2000" },
      { type: "usage", amountCents: "7000" },
    ],
    marketplaceFeesCents: "800",
    x402Received: [{ asset: "USDC", count: 5, amountUsd: 12.5 }],
  });

  assert.deepEqual(body.onChain, {
    state: "ok",
    hotWallet: { address: HOT, lamports: "2000000000", usdcRaw: "150000000" },
    treasury: { address: TREASURY, proven: true, lamports: "9000000000", usdcRaw: "4000000000" },
    depositAddresses: { count: 2, lamports: "3000000", usdcRaw: "20000000" },
  });

  assert.deepEqual(body.sweeps, { state: "ok", sent: 1, landedInRange: [], failedInRange: 0 });

  assert.deepEqual(body.health, {
    cluster: "ok",
    walletTopups: true,
    deposits: true,
    depositScan: true,
    sweeps: false,
    payouts: true,
    solPrice: { source: "pyth", ok: true, ageSeconds: 3 },
  });
});

test("sweeps: what landed is listed by kind and asset", async () => {
  const body = await computePlatformMoney(deps(), RANGE);
  assert.deepEqual(body.sweeps, {
    state: "ok",
    sent: 1,
    landedInRange: [
      { kind: "sweep_to_hot", asset: "SOL", count: 1, amountRaw: "500000000" },
      { kind: "sweep_to_treasury", asset: "USDC", count: 2, amountRaw: "80000000" },
    ],
    failedInRange: 1,
  });
});

test("\"other\" is what no rail explains, and never below zero", () => {
  const rails = {
    walletTopups: [{ asset: "USDC", count: 2, amountCents: 5_000n }],
    deposits: [{ asset: "SOL", count: 1, amountCents: 1_000n }],
    stripe: { count: 1, amountCents: 4_000n },
  };
  const other = (purchases: { count: number; amountCents: bigint }) =>
    creditsSold(income({ ...rails, purchases })).find((r) => r.rail === "other");

  assert.deepEqual(other({ count: 6, amountCents: 12_000n }), {
    rail: "other", asset: null, count: 2, amountCents: 2_000n,
  });
  assert.deepEqual(other({ count: 4, amountCents: 10_000n }), {
    rail: "other", asset: null, count: 0, amountCents: 0n,
  });
  // The rails add up to more than the purchase rows in the range (a top-up
  // credited at the edge of it): zero, not a negative amount.
  assert.deepEqual(other({ count: 1, amountCents: 3_000n }), {
    rail: "other", asset: null, count: 0, amountCents: 0n,
  });

  // Nothing at all still answers the two rails that have no asset.
  assert.deepEqual(creditsSold(income()), [
    { rail: "stripe", asset: null, count: 0, amountCents: 0n },
    { rail: "other", asset: null, count: 0, amountCents: 0n },
  ]);
});

// ============================================
// Reconciliation
// ============================================

test("reconciliation: a fee the address paid is counted, a fee the hot wallet paid is not", async () => {
  const body = await computePlatformMoney(deps(), RANGE);
  const r = ok(body.reconciliation);

  // USDC: 100 received, 80 swept, 20 expected, 20 held.
  assert.deepEqual(r.usdc, {
    receivedRaw: "100000000",
    sweptRaw: "80000000",
    expectedRaw: "20000000",
    heldRaw: "20000000",
    differenceRaw: "0",
  });
  // SOL: 503,005,000 received, 500,000,000 swept, 5,000 fee paid by the
  // address (the 5,000 the hot wallet paid for the USDC sweep is not here).
  assert.deepEqual(r.sol, {
    receivedLamports: "503005000",
    sweptLamports: "500000000",
    feeLamports: "5000",
    expectedLamports: "3000000",
    heldLamports: "3000000",
    differenceLamports: "0",
  });
});

test("reconciliation: a difference is held less expected, above or below zero", () => {
  const ledger = {
    receivedUsdcRaw: 50_000_000n,
    receivedLamports: 1_000_000_000n,
    swept: [
      { asset: "USDC", fromAddress: DEPOSIT_A, feePayer: HOT, landed: true, amountRaw: 10_000_000n, feeLamports: 5_000n },
      { asset: "USDC", fromAddress: DEPOSIT_B, feePayer: HOT, landed: true, amountRaw: 5_000_000n, feeLamports: 5_000n },
      { asset: "SOL", fromAddress: DEPOSIT_A, feePayer: DEPOSIT_A, landed: true, amountRaw: 400_000_000n, feeLamports: 5_000n },
      { asset: "SOL", fromAddress: DEPOSIT_B, feePayer: DEPOSIT_B, landed: true, amountRaw: 100_000_000n, feeLamports: 10_000n },
    ],
  };
  const r = reconcile(ledger, { count: 2, lamports: 499_985_100n, usdcRaw: 34_000_000n });

  assert.equal(r.usdc.swept, 15_000_000n);
  assert.equal(r.usdc.expected, 35_000_000n);
  assert.equal(r.usdc.difference, -1_000_000n); // a USDC is missing

  assert.equal(r.sol.swept, 500_000_000n);
  assert.equal(r.sol.fee, 15_000n);
  assert.equal(r.sol.expected, 499_985_000n);
  assert.equal(r.sol.difference, 100n); // 100 lamports nobody recorded

  // A sweep that failed on the chain moved nothing, and its address still
  // paid the fee: the fee counts, the amount does not.
  const failed = reconcile(
    {
      receivedUsdcRaw: 0n,
      receivedLamports: 1_000_000_000n,
      swept: [
        { asset: "SOL", fromAddress: DEPOSIT_A, feePayer: DEPOSIT_A, landed: false, amountRaw: 999_104_120n, feeLamports: 5_000n },
        { asset: "USDC", fromAddress: DEPOSIT_B, feePayer: HOT, landed: false, amountRaw: 7_000_000n, feeLamports: 10_000n },
      ],
    },
    { count: 2, lamports: 999_995_000n, usdcRaw: 0n },
  );
  assert.equal(failed.sol.swept, 0n);
  assert.equal(failed.sol.fee, 5_000n);
  assert.equal(failed.sol.difference, 0n);
  assert.equal(failed.usdc.swept, 0n);
  assert.equal(failed.usdc.difference, 0n);

  // Nothing recorded and nothing held.
  const empty = reconcile(
    { receivedUsdcRaw: 0n, receivedLamports: 0n, swept: [] },
    { count: 0, lamports: 0n, usdcRaw: 0n },
  );
  assert.equal(empty.usdc.difference, 0n);
  assert.equal(empty.sol.difference, 0n);
});

// ============================================
// Strings
// ============================================

test("amounts are strings and keep every digit above 2^53", async () => {
  const body = await computePlatformMoney(
    deps({
      readCustomers: async () => ({ balanceCents: HUGE, organizationsWithBalance: 1 }),
      readCreators: async () => ({
        owedCents: HUGE,
        openPayouts: [{ method: "crypto_usdc", count: 1, amountCents: HUGE }],
        paidOutInRange: [],
      }),
      readIncome: async () =>
        income({
          deposits: [{ asset: "USDC", count: 1, amountCents: HUGE }],
          purchases: { count: 1, amountCents: HUGE + 1n },
          bonusesGrantedCents: HUGE,
          debits: [{ type: "usage", amountCents: -HUGE }],
          marketplaceFeesCents: HUGE,
        }),
      readWallets: async (addresses) => addresses.map(() => ({ lamports: HUGE, usdcRaw: HUGE })),
      readDepositHoldings: async () => ({ count: 1, lamports: HUGE, usdcRaw: HUGE }),
      readSweeps: async () => ({
        sent: 0,
        landedInRange: [{ kind: "sweep_to_hot", asset: "USDC", count: 1, amountRaw: HUGE }],
        failedInRange: 0,
      }),
      readLedger: async () => ({ receivedUsdcRaw: HUGE, receivedLamports: HUGE, swept: [] }),
    }),
    RANGE,
  );
  const text = "9007199254740993123";

  // The whole report goes through JSON, as the route sends it.
  const wire = JSON.parse(JSON.stringify(body)) as typeof body;
  assert.equal(ok(wire.customers).balanceCents, text);
  assert.equal(ok(wire.creators).owedCents, text);
  assert.equal(ok(wire.creators).openPayouts[0]?.amountCents, text);
  const sold = ok(wire.income);
  assert.equal(sold.creditsSold.find((r) => r.rail === "deposit")?.amountCents, text);
  assert.equal(sold.creditsSold.find((r) => r.rail === "other")?.amountCents, "1");
  assert.equal(sold.bonusesGrantedCents, text);
  assert.equal(sold.creditsUsed[0]?.amountCents, text);
  assert.equal(sold.marketplaceFeesCents, text);
  const chain = ok(wire.onChain);
  assert.equal(chain.hotWallet.lamports, text);
  assert.equal(chain.hotWallet.usdcRaw, text);
  assert.equal(chain.treasury?.usdcRaw, text);
  assert.equal(chain.depositAddresses.lamports, text);
  assert.equal(ok(wire.sweeps).landedInRange[0]?.amountRaw, text);
  const rec = ok(wire.reconciliation);
  assert.equal(rec.usdc.receivedRaw, text);
  assert.equal(rec.sol.heldLamports, text);
  assert.equal(rec.sol.differenceLamports, "0");

  // No amount anywhere in the report is a JSON number past what one can hold.
  const walk = (value: unknown): void => {
    if (typeof value === "number") assert.ok(Number.isSafeInteger(value) || !Number.isInteger(value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(wire);
});

// ============================================
// One section failing
// ============================================

test("one section throwing leaves the others answered and that one unreadable", async () => {
  const cases: Array<[keyof PlatformMoneyDeps, string]> = [
    ["readCustomers", "customers"],
    ["readCreators", "creators"],
    ["readIncome", "income"],
    ["readWallets", "onChain"],
    ["readSweeps", "sweeps"],
    ["readLedger", "reconciliation"],
  ];
  const sections = ["customers", "creators", "income", "onChain", "sweeps", "reconciliation"] as const;

  for (const [read, broken] of cases) {
    const reported: string[] = [];
    const body = await computePlatformMoney(
      deps({
        [read]: async () => {
          throw new Error("the read failed");
        },
        reportUnreadable: (name) => {
          reported.push(name);
        },
      } as Partial<PlatformMoneyDeps>),
      RANGE,
    );
    for (const name of sections) {
      if (name === broken) assert.deepEqual(body[name], { state: "unreadable" }, `${read}: ${name}`);
      else assert.equal(body[name].state, "ok", `${read}: ${name}`);
    }
    assert.deepEqual(reported, [broken]);
    assert.equal(body.health.cluster, "ok");
  }
});

test("the stored deposit figures failing takes the two sections that use them, and no other", async () => {
  let reads = 0;
  const body = await computePlatformMoney(
    deps({
      readDepositHoldings: async () => {
        reads += 1;
        throw new Error("no database");
      },
    }),
    RANGE,
  );
  assert.equal(reads, 1);
  assert.deepEqual(body.onChain, { state: "unreadable" });
  assert.deepEqual(body.reconciliation, { state: "unreadable" });
  assert.equal(body.customers.state, "ok");
  assert.equal(body.sweeps.state, "ok");
});

test("no master key: the on-chain section is unreadable and nothing is asked of the node", async () => {
  let asked = 0;
  const body = await computePlatformMoney(
    deps({
      hotWalletAddress: () => {
        throw new Error("WALLET_MASTER_KEY required (empty or missing)");
      },
      readWallets: async () => {
        asked += 1;
        return [];
      },
    }),
    RANGE,
  );
  assert.deepEqual(body.onChain, { state: "unreadable" });
  assert.equal(asked, 0);
  assert.equal(body.reconciliation.state, "ok");
});

test("a report that throws from its log, a cluster check or a price read still answers", async () => {
  const body = await computePlatformMoney(
    deps({
      readCustomers: async () => {
        throw new Error("down");
      },
      reportUnreadable: () => {
        throw new Error("the logger is down too");
      },
      clusterCheck: async () => {
        throw new Error("no node");
      },
      solPrice: async () => {
        throw new Error("no price");
      },
    }),
    RANGE,
  );
  assert.deepEqual(body.customers, { state: "unreadable" });
  assert.equal(body.health.cluster, "unreachable");
  assert.deepEqual(body.health.solPrice, { source: "unknown", ok: false, ageSeconds: null });
});

test("the cluster's answer is passed through", async () => {
  for (const cluster of ["ok", "wrong_cluster", "unreachable"] as const) {
    const body = await computePlatformMoney(deps({ clusterCheck: async () => cluster }), RANGE);
    assert.equal(body.health.cluster, cluster);
  }
});

// ============================================
// The treasury
// ============================================

test("proven follows rule 4", () => {
  const good = { setting: TREASURY, rowAddress: TREASURY, hotWalletAddress: HOT, isDepositAddress: false };
  assert.equal(treasuryProven(good), true);

  // No row, or a row for another address.
  assert.equal(treasuryProven({ ...good, rowAddress: null }), false);
  assert.equal(treasuryProven({ ...good, rowAddress: DEPOSIT_A }), false);
  // The default, nothing, and text that is not an address.
  assert.equal(
    treasuryProven({ ...good, setting: NO_TREASURY_ADDRESS, rowAddress: NO_TREASURY_ADDRESS }),
    false,
  );
  assert.equal(treasuryProven({ ...good, setting: undefined }), false);
  assert.equal(treasuryProven({ ...good, setting: "", rowAddress: "" }), false);
  assert.equal(treasuryProven({ ...good, setting: "not-an-address", rowAddress: "not-an-address" }), false);
  // A token account: a real address, not an ordinary wallet.
  const tokenAccount = getAssociatedTokenAddressSync(
    new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
    new PublicKey(TREASURY),
  ).toBase58();
  assert.equal(treasuryProven({ ...good, setting: tokenAccount, rowAddress: tokenAccount }), false);
  // The same address with a space after it is not "exactly" the setting.
  assert.equal(treasuryProven({ ...good, setting: `${TREASURY} `, rowAddress: `${TREASURY} ` }), false);
  // The hot wallet, and a deposit address.
  assert.equal(treasuryProven({ ...good, setting: HOT, rowAddress: HOT }), false);
  assert.equal(treasuryProven({ ...good, isDepositAddress: true }), false);
});

test("the report's treasury: null when none is set, shown unproven otherwise", async () => {
  // Not set (the default): null, and neither the row nor the node is asked about it.
  let rowReads = 0;
  let asked: string[] = [];
  const unset = await computePlatformMoney(
    deps({
      treasurySetting: () => NO_TREASURY_ADDRESS,
      readTreasuryRow: async () => {
        rowReads += 1;
        return { address: NO_TREASURY_ADDRESS };
      },
      readWallets: async (addresses) => {
        asked = addresses;
        return addresses.map(() => ({ lamports: 1n, usdcRaw: 2n }));
      },
    }),
    RANGE,
  );
  assert.equal(ok(unset.onChain).treasury, null);
  assert.equal(rowReads, 0);
  assert.deepEqual(asked, [HOT]);
  assert.equal(ok((await computePlatformMoney(deps({ treasurySetting: () => undefined }), RANGE)).onChain).treasury, null);

  // Set and read in the same call as the hot wallet.
  const both = await computePlatformMoney(
    deps({
      readWallets: async (addresses) => {
        asked = addresses;
        return addresses.map(() => ({ lamports: 1n, usdcRaw: 2n }));
      },
    }),
    RANGE,
  );
  assert.deepEqual(asked, [HOT, TREASURY]);
  assert.equal(ok(both.onChain).treasury?.proven, true);

  // No row: shown, read, not proven.
  const noRow = await computePlatformMoney(deps({ readTreasuryRow: async () => null }), RANGE);
  assert.deepEqual(ok(noRow.onChain).treasury, {
    address: TREASURY,
    proven: false,
    lamports: "9000000000",
    usdcRaw: "4000000000",
  });

  // A row for the address that was proven before the setting changed.
  const moved = await computePlatformMoney(
    deps({ readTreasuryRow: async () => ({ address: DEPOSIT_A }) }),
    RANGE,
  );
  assert.equal(ok(moved.onChain).treasury?.proven, false);

  // The setting is a deposit address, or the hot wallet.
  const deposit = await computePlatformMoney(deps({ isDepositAddress: async () => true }), RANGE);
  assert.equal(ok(deposit.onChain).treasury?.proven, false);
  const hot = await computePlatformMoney(
    deps({ treasurySetting: () => HOT, readTreasuryRow: async () => ({ address: HOT }) }),
    RANGE,
  );
  assert.equal(ok(hot.onChain).treasury?.proven, false);

  // Text that is not an address: shown as set, never read, never proven.
  const junk = await computePlatformMoney(
    deps({
      treasurySetting: () => "my treasury",
      readTreasuryRow: async () => ({ address: "my treasury" }),
      readWallets: async (addresses) => {
        asked = addresses;
        return addresses.map(() => ({ lamports: 1n, usdcRaw: 2n }));
      },
    }),
    RANGE,
  );
  assert.deepEqual(asked, [HOT]);
  assert.deepEqual(ok(junk.onChain).treasury, {
    address: "my treasury",
    proven: false,
    lamports: null,
    usdcRaw: null,
  });
});

test("a treasury setting that looks like an address but is not one never takes the hot wallet's figures with it", async () => {
  // 44 base58 characters that decode to more than 32 bytes.
  const tooLong = "z".repeat(44);
  let asked: string[] = [];
  const body = await computePlatformMoney(
    deps({
      treasurySetting: () => tooLong,
      readTreasuryRow: async () => ({ address: tooLong }),
      readWallets: async (addresses) => {
        asked = addresses;
        return addresses.map(() => ({ lamports: 1n, usdcRaw: 2n }));
      },
    }),
    RANGE,
  );
  assert.deepEqual(asked, [HOT]);
  const chain = ok(body.onChain);
  assert.deepEqual(chain.hotWallet, { address: HOT, lamports: "1", usdcRaw: "2" });
  assert.deepEqual(chain.treasury, { address: tooLong, proven: false, lamports: null, usdcRaw: null });
});

// ============================================
// A read that never answers
// ============================================

test("a read that hangs is unreadable after the ceiling, and the report still answers", async () => {
  const never = () => new Promise<never>(() => undefined);
  const reported: string[] = [];
  const started = Date.now();
  const body = await computePlatformMoney(
    deps({
      timeoutMs: 30,
      // The node hangs: the wallets, the cluster check and the price with it.
      readWallets: never,
      clusterCheck: never,
      solPrice: never,
      reportUnreadable: (name) => {
        reported.push(name);
      },
    }),
    RANGE,
  );
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(body.onChain, { state: "unreadable" });
  assert.deepEqual(reported, ["onChain"]);
  assert.equal(body.health.cluster, "unreachable");
  assert.deepEqual(body.health.solPrice, { source: "unknown", ok: false, ageSeconds: null });
  for (const name of ["customers", "creators", "income", "sweeps", "reconciliation"] as const) {
    assert.equal(body[name].state, "ok", name);
  }
});
