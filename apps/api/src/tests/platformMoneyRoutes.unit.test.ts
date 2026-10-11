import assert from "node:assert/strict";
import { test } from "node:test";

import "./unitEnv.js";

import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import Fastify from "fastify";

import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import { createPlatformMoneyRoutes } from "../routes/platformMoney.js";
import {
  buildPlatformMoneyDeps,
  moneySwitches,
  usdcHeld,
  type BuildPlatformMoneyDepsInput,
  type ChainAccount,
  type PlatformMoneyPrisma,
} from "../routes/platformMoneyBindings.js";
import type {
  MoneyRange,
  PlatformMoneyDeps,
  PlatformMoneyResponse,
} from "../services/platformMoney.js";

const ADMIN_KEY = "an-admin-key-of-enough-length";
const NOW = new Date("2026-10-11T12:30:00.000Z");
const HOT = Keypair.generate().publicKey;
const TREASURY = Keypair.generate().publicKey;
const DEPOSIT_A = Keypair.generate().publicKey.toBase58();
const DEPOSIT_B = Keypair.generate().publicKey.toBase58();
const MINT = usdcMintForNetwork("devnet");
const CHAIN = "solana:devnet";
const OTHER_CHAIN = "solana:mainnet";

// ============================================
// An in-memory stand-in for the slice of Prisma the report reads
// ============================================

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond && !cond.in.includes(value)) return false;
      if ("gt" in cond && !(value !== null && value !== undefined && value > cond.gt)) return false;
      if ("lt" in cond && !(value !== null && value !== undefined && value < cond.lt)) return false;
      if ("gte" in cond && !(value !== null && value !== undefined && value >= cond.gte)) return false;
      if ("lte" in cond && !(value !== null && value !== undefined && value <= cond.lte)) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function summarize(rows: Row[], args: Row): Row {
  const out: Row = {};
  if (args._sum) {
    out._sum = {};
    for (const field of Object.keys(args._sum)) {
      // Prisma answers null for a sum over no rows.
      const first = rows[0];
      out._sum[field] = first === undefined ? null : rows.reduce((t, r) => t + r[field], first[field] - first[field]);
    }
  }
  if (args._count) out._count = { _all: rows.length };
  return out;
}

function table(rows: Row[], log: string[], name: string) {
  return {
    async aggregate(args: Row) {
      log.push(`${name}.aggregate`);
      return summarize(rows.filter((r) => matches(r, args.where)), args);
    },
    async groupBy(args: Row) {
      log.push(`${name}.groupBy`);
      const groups = new Map<string, Row[]>();
      for (const row of rows.filter((r) => matches(r, args.where))) {
        const key = JSON.stringify(args.by.map((f: string) => row[f]));
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      return [...groups.values()].map((group) => ({
        ...Object.fromEntries(args.by.map((f: string) => [f, group[0]?.[f]])),
        ...summarize(group, args),
      }));
    },
    async count(args: Row) {
      log.push(`${name}.count`);
      return rows.filter((r) => matches(r, args?.where)).length;
    },
    async findFirst(args: Row) {
      log.push(`${name}.findFirst`);
      return rows.find((r) => matches(r, args.where)) ?? null;
    },
    async findUnique(args: Row) {
      log.push(`${name}.findUnique`);
      const where = args.where.role_network ?? args.where;
      return rows.find((r) => matches(r, where)) ?? null;
    },
  };
}

interface Store {
  creditBalance: Row[];
  publisherProfile: Row[];
  creatorPayout: Row[];
  walletTopUp: Row[];
  onchainReceipt: Row[];
  stripePurchase: Row[];
  creditTransaction: Row[];
  marketplaceRevenue: Row[];
  x402Payment: Row[];
  depositAddress: Row[];
  chainTransfer: Row[];
  platformWallet: Row[];
}

function emptyStore(): Store {
  return {
    creditBalance: [],
    publisherProfile: [],
    creatorPayout: [],
    walletTopUp: [],
    onchainReceipt: [],
    stripePurchase: [],
    creditTransaction: [],
    marketplaceRevenue: [],
    x402Payment: [],
    depositAddress: [],
    chainTransfer: [],
    platformWallet: [],
  };
}

function fakePrisma(store: Store, log: string[] = []): PlatformMoneyPrisma {
  return Object.fromEntries(
    Object.entries(store).map(([name, rows]) => [name, table(rows, log, name)]),
  ) as unknown as PlatformMoneyPrisma;
}

// ============================================
// A stand-in for the node
// ============================================

function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): ChainAccount {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  return { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, data };
}

function wallet(lamports: number): ChainAccount {
  return { lamports, owner: SystemProgram.programId, data: new Uint8Array(0) };
}

function ata(owner: PublicKey): string {
  return getAssociatedTokenAddressSync(MINT, owner, true).toBase58();
}

function fakeNode(accounts: Record<string, ChainAccount>) {
  const calls: string[][] = [];
  return {
    calls,
    getMultipleAccounts: async (keys: PublicKey[]) => {
      calls.push(keys.map((k) => k.toBase58()));
      return keys.map((k) => accounts[k.toBase58()] ?? null);
    },
  };
}

const ALL_ON = {
  walletTopups: true,
  deposits: true,
  depositScan: true,
  sweeps: true,
  payouts: true,
};

function input(over: Partial<BuildPlatformMoneyDepsInput> = {}): BuildPlatformMoneyDepsInput {
  return {
    prisma: fakePrisma(emptyStore()),
    adminKey: () => ADMIN_KEY,
    now: () => NOW,
    solanaNetwork: () => "devnet",
    treasurySetting: () => TREASURY.toBase58(),
    hotWalletAddress: () => HOT.toBase58(),
    clusterCheck: async () => ({ ok: true }),
    getMultipleAccounts: fakeNode({}).getMultipleAccounts,
    switches: () => ALL_ON,
    solPriceSource: () => "off",
    getSolQuote: async () => ({ ok: false, code: "source_off" }),
    ...over,
  };
}

async function request(
  routeDeps: PlatformMoneyDeps,
  headers: Record<string, string> = {},
  query = "",
) {
  const app = Fastify({ logger: false });
  await app.register(createPlatformMoneyRoutes(routeDeps), { prefix: "/api/platform" });
  await app.ready();
  const res = await app.inject({ method: "GET", url: `/api/platform/money${query}`, headers });
  await app.close();
  return res;
}

function ok<T extends { state: string }>(section: T): Extract<T, { state: "ok" }> {
  assert.equal(section.state, "ok");
  return section as Extract<T, { state: "ok" }>;
}

// ============================================
// The gate
// ============================================

test("GET /api/platform/money: 503 by name when PLATFORM_ADMIN_KEY is unset, and nothing is read", async () => {
  const log: string[] = [];
  const node = fakeNode({});
  const res = await request(
    buildPlatformMoneyDeps(
      input({
        adminKey: () => undefined,
        prisma: fakePrisma(emptyStore(), log),
        getMultipleAccounts: node.getMultipleAccounts,
      }),
    ),
    { "x-admin-key": ADMIN_KEY },
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "platform_admin_not_configured");
  assert.deepEqual(log, []);
  assert.deepEqual(node.calls, []);
});

test("GET /api/platform/money: 401 with no key or a wrong key, and nothing is read", async () => {
  const log: string[] = [];
  const node = fakeNode({});
  const deps = buildPlatformMoneyDeps(
    input({ prisma: fakePrisma(emptyStore(), log), getMultipleAccounts: node.getMultipleAccounts }),
  );
  for (const headers of [{}, { "x-admin-key": "" }, { "x-admin-key": `${ADMIN_KEY}x` }, { "x-admin-key": ADMIN_KEY.slice(0, -1) }]) {
    const res = await request(deps, headers as Record<string, string>);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "invalid_admin_key" });
  }
  // A wrong key with a date that cannot be read is still 401: the gate is first.
  const res = await request(deps, { "x-admin-key": "wrong" }, "?from=nope");
  assert.equal(res.statusCode, 401);
  assert.deepEqual(log, []);
  assert.deepEqual(node.calls, []);
});

test("GET /api/platform/money: the right key answers the report, never cached", async () => {
  const res = await request(buildPlatformMoneyDeps(input()), { "x-admin-key": ADMIN_KEY });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  const body = res.json() as PlatformMoneyResponse;
  assert.equal(body.generatedAt, NOW.toISOString());
  assert.equal(body.network, "devnet");
  for (const name of ["customers", "creators", "income", "onChain", "sweeps", "reconciliation"] as const) {
    assert.equal(body[name].state, "ok", name);
  }
});

test("the key is read on every request", async () => {
  let key: string | undefined;
  const deps = buildPlatformMoneyDeps(input({ adminKey: () => key }));
  assert.equal((await request(deps, { "x-admin-key": ADMIN_KEY })).statusCode, 503);
  key = ADMIN_KEY;
  assert.equal((await request(deps, { "x-admin-key": ADMIN_KEY })).statusCode, 200);
  key = "another-admin-key-of-enough-length";
  assert.equal((await request(deps, { "x-admin-key": ADMIN_KEY })).statusCode, 401);
});

// ============================================
// The range
// ============================================

test("the range defaults to this UTC month up to now, and the reads are given it", async () => {
  const seen: MoneyRange[] = [];
  const base = buildPlatformMoneyDeps(input());
  const deps: PlatformMoneyDeps = {
    ...base,
    readIncome: async (range) => {
      seen.push(range);
      return base.readIncome(range);
    },
  };
  const res = await request(deps, { "x-admin-key": ADMIN_KEY });
  assert.deepEqual(res.json().range, { from: "2026-10-01T00:00:00.000Z", to: NOW.toISOString() });

  const given = await request(deps, { "x-admin-key": ADMIN_KEY }, "?from=2026-08-01&to=2026-08-31");
  assert.equal(given.statusCode, 200);
  assert.deepEqual(given.json().range, {
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-09-01T00:00:00.000Z",
  });
  assert.deepEqual(
    seen.map((r) => [r.from.toISOString(), r.to.toISOString()]),
    [
      ["2026-10-01T00:00:00.000Z", NOW.toISOString()],
      ["2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"],
    ],
  );
});

test("a date that cannot be read is 400 invalid_range, and nothing is read", async () => {
  const log: string[] = [];
  const deps = buildPlatformMoneyDeps(input({ prisma: fakePrisma(emptyStore(), log) }));
  for (const query of [
    "?from=nope",
    "?to=2026-02-30",
    "?from=2026-13-01",
    "?from=",
    "?from=2026-10-01T00:00:00Z",
    "?from=2026-09-02&to=2026-09-01",
    "?from=2026-09-01&from=2026-09-02",
  ]) {
    const res = await request(deps, { "x-admin-key": ADMIN_KEY }, query);
    assert.equal(res.statusCode, 400, query);
    assert.equal(res.json().error, "invalid_range", query);
    assert.equal(res.headers["cache-control"], "no-store");
  }
  assert.deepEqual(log, []);
});

// ============================================
// Every figure, from rows
// ============================================

const IN = new Date("2026-10-05T10:00:00.000Z");
const BEFORE = new Date("2026-09-30T23:59:59.999Z");
const FIRST = new Date("2026-10-01T00:00:00.000Z");

function fullStore(): Store {
  const s = emptyStore();
  s.creditBalance = [
    { orgId: "o1", balanceCents: 10_000n },
    { orgId: "o2", balanceCents: 2_500n },
    { orgId: "o3", balanceCents: 0n },
    // An organization in debt takes from the sum and is not counted as holding.
    { orgId: "o4", balanceCents: -300n },
  ];
  s.publisherProfile = [
    { orgId: "o1", pendingPayoutCents: 7_000n },
    { orgId: "o2", pendingPayoutCents: 500n },
  ];
  s.creatorPayout = [
    { payoutMethod: "crypto_usdc", status: "pending", amountCents: 2_000n, processedAt: null },
    { payoutMethod: "crypto_usdc", status: "processing", amountCents: 3_000n, processedAt: null },
    { payoutMethod: "crypto_sol", status: "pending", amountCents: 1_000n, processedAt: null },
    { payoutMethod: "credits", status: "completed", amountCents: 900n, processedAt: IN },
    { payoutMethod: "crypto_usdc", status: "completed", amountCents: 4_000n, processedAt: IN },
    { payoutMethod: "crypto_usdc", status: "completed", amountCents: 6_000n, processedAt: FIRST },
    // Outside the range, and not completed.
    { payoutMethod: "crypto_usdc", status: "completed", amountCents: 50_000n, processedAt: BEFORE },
    { payoutMethod: "crypto_usdc", status: "failed", amountCents: 60_000n, processedAt: IN },
    { payoutMethod: "crypto_usdc", status: "cancelled", amountCents: 70_000n, processedAt: IN },
  ];
  s.walletTopUp = [
    { id: "t1", asset: "USDC", status: "credited", amountUsdCents: 2_000n, creditedAt: IN, depositAddress: DEPOSIT_A },
    { id: "t2", asset: "USDC", status: "credited", amountUsdCents: 3_000n, creditedAt: IN, depositAddress: DEPOSIT_A },
    { id: "t3", asset: "SOL", status: "credited", amountUsdCents: 1_000n, creditedAt: IN, depositAddress: DEPOSIT_A },
    { id: "t4", asset: "USDC", status: "credited", amountUsdCents: 99_000n, creditedAt: BEFORE, depositAddress: DEPOSIT_A },
    { id: "t5", asset: "USDC", status: "submitted", amountUsdCents: 88_000n, creditedAt: null, depositAddress: DEPOSIT_A },
    { id: "t6", asset: "USDC", status: "failed", amountUsdCents: 77_000n, creditedAt: null, depositAddress: DEPOSIT_A },
  ];
  s.onchainReceipt = [
    // Direct, credited, in the range.
    { network: CHAIN, asset: "USDC", source: "direct", status: "credited", amountRaw: 40_000_000n, amountUsdCents: 4_000n, creditedAt: IN },
    { network: CHAIN, asset: "SOL", source: "direct", status: "credited", amountRaw: 600_000_000n, amountUsdCents: 9_000n, creditedAt: IN },
    // A prepared top-up's transfer: counted as a wallet top-up, not as a deposit.
    { network: CHAIN, asset: "USDC", source: "prepared", status: "credited", amountRaw: 50_000_000n, amountUsdCents: 5_000n, creditedAt: IN },
    // Waiting for a price, and ignored: received, never income.
    { network: CHAIN, asset: "SOL", source: "direct", status: "detected", amountRaw: 3_005_000n, amountUsdCents: null, creditedAt: null },
    { network: CHAIN, asset: "USDC", source: "direct", status: "ignored", amountRaw: 10_000_000n, amountUsdCents: null, creditedAt: null },
    // Credited before the range.
    { network: CHAIN, asset: "USDC", source: "direct", status: "credited", amountRaw: 20_000_000n, amountUsdCents: 2_000n, creditedAt: BEFORE },
    // Another chain: never part of this chain's reconciliation.
    { network: OTHER_CHAIN, asset: "USDC", source: "prepared", status: "credited", amountRaw: 777_000_000n, amountUsdCents: 77_700n, creditedAt: BEFORE },
  ];
  s.stripePurchase = [
    { status: "completed", amountCents: 5_000n, completedAt: IN },
    { status: "completed", amountCents: 2_000n, completedAt: IN },
    { status: "completed", amountCents: 44_000n, completedAt: BEFORE },
    { status: "created", amountCents: 33_000n, completedAt: null },
    { status: "expired", amountCents: 22_000n, completedAt: null },
  ];
  s.creditTransaction = [
    // 6,000 + 13,000 + 7,000 the rails explain, and 1,500 they do not.
    { type: "purchase", amountCents: 2_000n, createdAt: IN },
    { type: "purchase", amountCents: 3_000n, createdAt: IN },
    { type: "purchase", amountCents: 1_000n, createdAt: IN },
    { type: "purchase", amountCents: 4_000n, createdAt: IN },
    { type: "purchase", amountCents: 9_000n, createdAt: IN },
    { type: "purchase", amountCents: 5_000n, createdAt: IN },
    { type: "purchase", amountCents: 2_000n, createdAt: IN },
    { type: "purchase", amountCents: 1_500n, createdAt: IN },
    { type: "purchase", amountCents: 500_000n, createdAt: BEFORE },
    { type: "bonus", amountCents: 250n, createdAt: IN },
    { type: "bonus", amountCents: 500n, createdAt: IN },
    { type: "bonus", amountCents: 9_999n, createdAt: BEFORE },
    { type: "usage", amountCents: -1_200n, createdAt: IN },
    { type: "usage", amountCents: -800n, createdAt: IN },
    { type: "marketplace_job", amountCents: -3_000n, createdAt: IN },
    { type: "usage", amountCents: -99_000n, createdAt: BEFORE },
    // Money back is not credits used, and a payout taken as credits is not a sale.
    { type: "refund", amountCents: 700n, createdAt: IN },
    { type: "payout_credit", amountCents: 900n, createdAt: IN },
    // A negative adjustment is a use of credits under its own type.
    { type: "adjustment", amountCents: -50n, createdAt: IN },
  ];
  s.marketplaceRevenue = [
    { status: "settled", platformFeeCents: 300n, settledAt: IN },
    { status: "settled", platformFeeCents: 450n, settledAt: IN },
    { status: "settled", platformFeeCents: 9_000n, settledAt: BEFORE },
    { status: "pending", platformFeeCents: 8_000n, settledAt: null },
    { status: "refunded", platformFeeCents: 7_000n, settledAt: null },
  ];
  s.x402Payment = [
    { status: "settled", asset: "USDC", amountUsd: 1.25, settledAt: IN },
    { status: "settled", asset: "USDC", amountUsd: 0.5, settledAt: IN },
    { status: "settled", asset: "SOL", amountUsd: 2, settledAt: IN },
    { status: "settled", asset: "USDC", amountUsd: 100, settledAt: BEFORE },
    { status: "verified", asset: "USDC", amountUsd: 200, settledAt: null },
    { status: "failed", asset: "USDC", amountUsd: 300, settledAt: null },
  ];
  s.depositAddress = [
    // DEPOSIT_A paid the fee of two sweeps that failed on the chain: 10,000 lamports less.
    { orgId: "o1", address: DEPOSIT_A, network: CHAIN, lastSeenLamports: 2_990_000n, lastSeenUsdcRaw: 20_000_000n },
    { orgId: "o2", address: DEPOSIT_B, network: CHAIN, lastSeenLamports: 100_000_000n, lastSeenUsdcRaw: 20_000_000n },
    { orgId: "o9", address: "other-chain-address", network: OTHER_CHAIN, lastSeenLamports: 5n, lastSeenUsdcRaw: 777_000_000n },
  ];
  s.chainTransfer = [
    // Landed, from deposit addresses. USDC: the hot wallet pays. SOL: the address pays.
    { network: CHAIN, kind: "sweep_to_treasury", asset: "USDC", fromAddress: DEPOSIT_A, feePayer: HOT.toBase58(), status: "landed", amountRaw: 60_000_000n, feeLamports: 5_000n, settledAt: IN },
    { network: CHAIN, kind: "sweep_to_hot", asset: "USDC", fromAddress: DEPOSIT_B, feePayer: HOT.toBase58(), status: "landed", amountRaw: 20_000_000n, feeLamports: 5_000n, settledAt: BEFORE },
    { network: CHAIN, kind: "sweep_to_hot", asset: "SOL", fromAddress: DEPOSIT_B, feePayer: DEPOSIT_B, status: "landed", amountRaw: 500_000_000n, feeLamports: 5_000n, settledAt: IN },
    // The hot wallet's excess: a sweep, never something that left a deposit address.
    { network: CHAIN, kind: "hot_to_treasury", asset: "USDC", fromAddress: HOT.toBase58(), feePayer: HOT.toBase58(), status: "landed", amountRaw: 300_000_000n, feeLamports: 5_000n, settledAt: IN },
    // Not landed: none of these moved anything. The two that failed on the
    // chain still cost the address that paid for them its fee; the dead one
    // never reached the chain and cost nothing.
    { network: CHAIN, kind: "sweep_to_hot", asset: "USDC", fromAddress: DEPOSIT_A, feePayer: HOT.toBase58(), status: "sent", amountRaw: 11_000_000n, feeLamports: 5_000n, settledAt: null },
    { network: CHAIN, kind: "sweep_to_hot", asset: "SOL", fromAddress: DEPOSIT_A, feePayer: DEPOSIT_A, status: "failed", amountRaw: 12_000_000n, feeLamports: 5_000n, settledAt: IN },
    { network: CHAIN, kind: "sweep_to_hot", asset: "SOL", fromAddress: DEPOSIT_A, feePayer: DEPOSIT_A, status: "failed", amountRaw: 12_000_000n, feeLamports: 5_000n, settledAt: BEFORE },
    { network: CHAIN, kind: "sweep_to_hot", asset: "SOL", fromAddress: DEPOSIT_A, feePayer: DEPOSIT_A, status: "dead", amountRaw: 13_000_000n, feeLamports: 5_000n, settledAt: IN },
    // Another chain.
    { network: OTHER_CHAIN, kind: "sweep_to_hot", asset: "USDC", fromAddress: "x", feePayer: "y", status: "landed", amountRaw: 999_000_000n, feeLamports: 5_000n, settledAt: IN },
    { network: OTHER_CHAIN, kind: "sweep_to_hot", asset: "USDC", fromAddress: "x", feePayer: "y", status: "sent", amountRaw: 999_000_000n, feeLamports: 5_000n, settledAt: null },
  ];
  s.platformWallet = [
    { role: "treasury", network: CHAIN, address: TREASURY.toBase58() },
    { role: "treasury", network: OTHER_CHAIN, address: "a-mainnet-treasury" },
  ];
  return s;
}

function fullNode() {
  return fakeNode({
    [HOT.toBase58()]: wallet(2_000_000_000),
    [ata(HOT)]: tokenAccount(MINT, HOT, 150_000_000n),
    [TREASURY.toBase58()]: wallet(9_000_000_000),
    [ata(TREASURY)]: tokenAccount(MINT, TREASURY, 4_000_000_000n),
  });
}

test("every figure, from rows that exercise it", async () => {
  const node = fullNode();
  const res = await request(
    buildPlatformMoneyDeps(
      input({
        prisma: fakePrisma(fullStore()),
        getMultipleAccounts: node.getMultipleAccounts,
        solPriceSource: () => "pyth",
        getSolQuote: async () => ({
          ok: true,
          quote: {
            source: "pyth",
            midMicroUsdPerSol: 150_000_000n,
            confMicroUsdPerSol: 10_000n,
            publishTime: 1_760_000_000,
            ageSeconds: 4,
            account: "price-account",
          },
        }),
      }),
    ),
    { "x-admin-key": ADMIN_KEY },
  );
  assert.equal(res.statusCode, 200);
  const body = res.json() as PlatformMoneyResponse;

  assert.deepEqual(body.customers, { state: "ok", balanceCents: "12200", organizationsWithBalance: 2 });

  assert.deepEqual(body.creators, {
    state: "ok",
    owedCents: "7500",
    openPayouts: [
      { method: "crypto_sol", count: 1, amountCents: "1000" },
      { method: "crypto_usdc", count: 2, amountCents: "5000" },
    ],
    paidOutInRange: [
      { method: "credits", count: 1, amountCents: "900" },
      { method: "crypto_usdc", count: 2, amountCents: "10000" },
    ],
  });

  assert.deepEqual(body.income, {
    state: "ok",
    creditsSold: [
      { rail: "wallet_topup", asset: "SOL", count: 1, amountCents: "1000" },
      { rail: "wallet_topup", asset: "USDC", count: 2, amountCents: "5000" },
      { rail: "deposit", asset: "SOL", count: 1, amountCents: "9000" },
      { rail: "deposit", asset: "USDC", count: 1, amountCents: "4000" },
      { rail: "stripe", asset: null, count: 2, amountCents: "7000" },
      { rail: "other", asset: null, count: 1, amountCents: "1500" },
    ],
    bonusesGrantedCents: "750",
    creditsUsed: [
      { type: "adjustment", amountCents: "50" },
      { type: "marketplace_job", amountCents: "3000" },
      { type: "usage", amountCents: "2000" },
    ],
    marketplaceFeesCents: "750",
    x402Received: [
      { asset: "SOL", count: 1, amountUsd: 2 },
      { asset: "USDC", count: 2, amountUsd: 1.75 },
    ],
  });

  // One call to the node, for the four accounts.
  assert.deepEqual(node.calls, [[HOT.toBase58(), ata(HOT), TREASURY.toBase58(), ata(TREASURY)]]);
  assert.deepEqual(body.onChain, {
    state: "ok",
    hotWallet: { address: HOT.toBase58(), lamports: "2000000000", usdcRaw: "150000000" },
    treasury: {
      address: TREASURY.toBase58(),
      proven: true,
      lamports: "9000000000",
      usdcRaw: "4000000000",
    },
    depositAddresses: { count: 2, lamports: "102990000", usdcRaw: "40000000" },
  });

  assert.deepEqual(body.sweeps, {
    state: "ok",
    sent: 1,
    landedInRange: [
      { kind: "hot_to_treasury", asset: "USDC", count: 1, amountRaw: "300000000" },
      { kind: "sweep_to_hot", asset: "SOL", count: 1, amountRaw: "500000000" },
      { kind: "sweep_to_treasury", asset: "USDC", count: 1, amountRaw: "60000000" },
    ],
    failedInRange: 1,
  });

  // Over everything on this chain, not the range. USDC: 40 + 50 + 10 + 20
  // received, 60 + 20 swept (the fees were the hot wallet's), 40 held.
  // SOL: 600,000,000 + 3,005,000 received, 500,000,000 swept, 5,000 paid by
  // the address, 103,000,000 held.
  assert.deepEqual(body.reconciliation, {
    state: "ok",
    usdc: {
      receivedRaw: "120000000",
      sweptRaw: "80000000",
      expectedRaw: "40000000",
      heldRaw: "40000000",
      differenceRaw: "0",
    },
    sol: {
      receivedLamports: "603005000",
      sweptLamports: "500000000",
      feeLamports: "15000",
      expectedLamports: "102990000",
      heldLamports: "102990000",
      differenceLamports: "0",
    },
  });

  assert.deepEqual(body.health, {
    cluster: "ok",
    ...ALL_ON,
    solPrice: { source: "pyth", ok: true, ageSeconds: 4 },
  });
});

test("an empty database answers zeros, as strings", async () => {
  const res = await request(
    buildPlatformMoneyDeps(input({ treasurySetting: () => "11111111111111111111111111111111" })),
    { "x-admin-key": ADMIN_KEY },
  );
  const body = res.json() as PlatformMoneyResponse;
  assert.deepEqual(body.customers, { state: "ok", balanceCents: "0", organizationsWithBalance: 0 });
  assert.deepEqual(body.creators, { state: "ok", owedCents: "0", openPayouts: [], paidOutInRange: [] });
  assert.deepEqual(ok(body.income).creditsSold, [
    { rail: "stripe", asset: null, count: 0, amountCents: "0" },
    { rail: "other", asset: null, count: 0, amountCents: "0" },
  ]);
  // A hot wallet nobody has funded: no account, no USDC account.
  assert.deepEqual(body.onChain, {
    state: "ok",
    hotWallet: { address: HOT.toBase58(), lamports: "0", usdcRaw: "0" },
    treasury: null,
    depositAddresses: { count: 0, lamports: "0", usdcRaw: "0" },
  });
  assert.deepEqual(body.sweeps, { state: "ok", sent: 0, landedInRange: [], failedInRange: 0 });
  assert.equal(ok(body.reconciliation).usdc.differenceRaw, "0");
  assert.equal(ok(body.reconciliation).sol.differenceLamports, "0");
});

test("amounts above 2^53 reach the wire with every digit", async () => {
  const huge = 9_007_199_254_740_993_123n;
  const store = emptyStore();
  store.creditBalance = [{ orgId: "o1", balanceCents: huge }, { orgId: "o2", balanceCents: 1n }];
  store.depositAddress = [
    { orgId: "o1", address: DEPOSIT_A, network: CHAIN, lastSeenLamports: huge, lastSeenUsdcRaw: huge },
  ];
  store.onchainReceipt = [
    { network: CHAIN, asset: "USDC", source: "direct", status: "credited", amountRaw: huge, amountUsdCents: huge, creditedAt: IN },
    { network: CHAIN, asset: "SOL", source: "direct", status: "detected", amountRaw: huge, amountUsdCents: null, creditedAt: null },
  ];
  const node = fakeNode({ [ata(HOT)]: tokenAccount(MINT, HOT, 18_446_744_073_709_551_615n) });
  const res = await request(
    buildPlatformMoneyDeps(
      input({
        prisma: fakePrisma(store),
        getMultipleAccounts: node.getMultipleAccounts,
        treasurySetting: () => undefined,
      }),
    ),
    { "x-admin-key": ADMIN_KEY },
  );
  // The raw text, before any parser can round it.
  assert.match(res.payload, /"balanceCents":"9007199254740993124"/);
  assert.match(res.payload, /"usdcRaw":"18446744073709551615"/);
  assert.match(res.payload, /"receivedRaw":"9007199254740993123"/);
  assert.match(res.payload, /"heldLamports":"9007199254740993123"/);
  assert.match(res.payload, /"rail":"deposit","asset":"USDC","count":1,"amountCents":"9007199254740993123"/);
  const body = res.json() as PlatformMoneyResponse;
  assert.equal(ok(body.reconciliation).usdc.differenceRaw, "0");
});

// ============================================
// A section that cannot be read
// ============================================

test("a table that cannot be read leaves its section unreadable and the rest answered", async () => {
  const reported: string[] = [];
  const prisma = fakePrisma(fullStore());
  (prisma as any).creatorPayout.groupBy = async () => {
    throw new Error("relation does not exist");
  };
  const res = await request(
    buildPlatformMoneyDeps(
      input({
        prisma,
        getMultipleAccounts: fullNode().getMultipleAccounts,
        reportUnreadable: (section) => {
          reported.push(section);
        },
      }),
    ),
    { "x-admin-key": ADMIN_KEY },
  );
  assert.equal(res.statusCode, 200);
  const body = res.json() as PlatformMoneyResponse;
  assert.deepEqual(body.creators, { state: "unreadable" });
  for (const name of ["customers", "income", "onChain", "sweeps", "reconciliation"] as const) {
    assert.equal(body[name].state, "ok", name);
  }
  assert.deepEqual(reported, ["creators"]);
});

test("the node failing, or on the wrong cluster, leaves only the on-chain section unreadable", async () => {
  const down = await request(
    buildPlatformMoneyDeps(
      input({
        prisma: fakePrisma(fullStore()),
        getMultipleAccounts: async () => {
          throw new Error("fetch failed");
        },
      }),
    ),
    { "x-admin-key": ADMIN_KEY },
  );
  const downBody = down.json() as PlatformMoneyResponse;
  assert.deepEqual(downBody.onChain, { state: "unreadable" });
  assert.equal(downBody.reconciliation.state, "ok");
  assert.equal(downBody.health.cluster, "ok");

  for (const reason of ["wrong_cluster", "unreachable"] as const) {
    const node = fullNode();
    const res = await request(
      buildPlatformMoneyDeps(
        input({
          prisma: fakePrisma(fullStore()),
          clusterCheck: async () => ({ ok: false, reason }),
          getMultipleAccounts: node.getMultipleAccounts,
        }),
      ),
      { "x-admin-key": ADMIN_KEY },
    );
    const body = res.json() as PlatformMoneyResponse;
    assert.deepEqual(body.onChain, { state: "unreadable" });
    // A node on another chain is not asked what the wallets hold.
    assert.deepEqual(node.calls, []);
    assert.equal(body.health.cluster, reason);
    assert.equal(body.reconciliation.state, "ok");
    assert.equal(body.customers.state, "ok");
  }
});

test("a USDC account that is not this mint's token account is not read as zero", () => {
  assert.equal(usdcHeld(null, MINT), 0n);
  assert.equal(usdcHeld(tokenAccount(MINT, HOT, 42n), MINT), 42n);
  assert.throws(() => usdcHeld(wallet(1), MINT), /not a token account/);
  assert.throws(() => usdcHeld(tokenAccount(Keypair.generate().publicKey, HOT, 42n), MINT), /another mint/);
  assert.throws(
    () => usdcHeld({ lamports: 1, owner: TOKEN_PROGRAM_ID, data: new Uint8Array(10) }, MINT),
    /not a token account/,
  );
});

// ============================================
// The treasury, from rows
// ============================================

async function treasuryOf(over: Partial<BuildPlatformMoneyDepsInput>, change?: (s: Store) => void) {
  const store = fullStore();
  change?.(store);
  const node = fullNode();
  const res = await request(
    buildPlatformMoneyDeps(
      input({ prisma: fakePrisma(store), getMultipleAccounts: node.getMultipleAccounts, ...over }),
    ),
    { "x-admin-key": ADMIN_KEY },
  );
  return { treasury: ok((res.json() as PlatformMoneyResponse).onChain).treasury, node };
}

test("proven follows rule 4, from the rows and the setting", async () => {
  assert.equal((await treasuryOf({})).treasury?.proven, true);

  // No row for this chain (the other chain's row does not count).
  const noRow = await treasuryOf({}, (s) => {
    s.platformWallet = s.platformWallet.filter((r) => r.network !== CHAIN);
  });
  assert.equal(noRow.treasury?.proven, false);
  assert.equal(noRow.treasury?.lamports, "9000000000");

  // The setting changed since it was proven.
  const other = Keypair.generate().publicKey.toBase58();
  const moved = await treasuryOf({ treasurySetting: () => other });
  assert.deepEqual(moved.treasury, { address: other, proven: false, lamports: "0", usdcRaw: "0" });

  // The default and nothing: no treasury at all.
  assert.equal((await treasuryOf({ treasurySetting: () => "11111111111111111111111111111111" })).treasury, null);
  assert.equal((await treasuryOf({ treasurySetting: () => undefined })).treasury, null);

  // The hot wallet, even with a row that says so.
  const hot = await treasuryOf({ treasurySetting: () => HOT.toBase58() }, (s) => {
    s.platformWallet = [{ role: "treasury", network: CHAIN, address: HOT.toBase58() }];
  });
  assert.equal(hot.treasury?.proven, false);

  // An organization's deposit address, by its row.
  const deposit = await treasuryOf({ treasurySetting: () => DEPOSIT_A }, (s) => {
    s.platformWallet = [{ role: "treasury", network: CHAIN, address: DEPOSIT_A }];
    s.walletTopUp = [];
  });
  assert.equal(deposit.treasury?.proven, false);

  // The address a prepared top-up was sent to, with no deposit row.
  const prepared = await treasuryOf({ treasurySetting: () => DEPOSIT_A }, (s) => {
    s.platformWallet = [{ role: "treasury", network: CHAIN, address: DEPOSIT_A }];
    s.depositAddress = [];
  });
  assert.equal(prepared.treasury?.proven, false);

  // A token account: read, and not an ordinary wallet.
  const tokenAddress = ata(TREASURY);
  const token = await treasuryOf({ treasurySetting: () => tokenAddress }, (s) => {
    s.platformWallet = [{ role: "treasury", network: CHAIN, address: tokenAddress }];
  });
  assert.equal(token.treasury?.proven, false);
  assert.equal(token.treasury?.address, tokenAddress);

  // Not an address: shown, never asked of the node.
  const junk = await treasuryOf({ treasurySetting: () => "treasury.sol" }, (s) => {
    s.platformWallet = [{ role: "treasury", network: CHAIN, address: "treasury.sol" }];
  });
  assert.deepEqual(junk.treasury, { address: "treasury.sol", proven: false, lamports: null, usdcRaw: null });
  assert.deepEqual(junk.node.calls, [[HOT.toBase58(), ata(HOT)]]);
});

// ============================================
// Health
// ============================================

test("a rail is on only when it is switched on and its worker is scheduled", () => {
  const on = {
    WALLET_TOPUPS_ENABLED: true,
    TOPUP_RECONCILE_INTERVAL_MS: 15_000,
    DEPOSITS_ENABLED: true,
    DEPOSIT_SCAN_INTERVAL_MS: 60_000,
    SWEEPS_ENABLED: true,
    SWEEP_INTERVAL_MS: 300_000,
    PAYOUTS_ENABLED: true,
    PAYOUT_EXECUTOR_INTERVAL_MS: 30_000,
  };
  assert.deepEqual(moneySwitches(on), ALL_ON);
  assert.deepEqual(
    moneySwitches({
      ...on,
      TOPUP_RECONCILE_INTERVAL_MS: 0,
      DEPOSIT_SCAN_INTERVAL_MS: 0,
      SWEEP_INTERVAL_MS: 0,
      PAYOUT_EXECUTOR_INTERVAL_MS: 0,
    }),
    { walletTopups: false, deposits: true, depositScan: false, sweeps: false, payouts: false },
  );
  assert.deepEqual(
    moneySwitches({
      ...on,
      WALLET_TOPUPS_ENABLED: false,
      DEPOSITS_ENABLED: false,
      SWEEPS_ENABLED: false,
      PAYOUTS_ENABLED: false,
    }),
    { walletTopups: false, deposits: false, depositScan: false, sweeps: false, payouts: false },
  );
});

test("the price: off is not asked for, a refusal is not ok, a quote carries its age", async () => {
  let asked = 0;
  const price = async (source: string, result: Awaited<ReturnType<BuildPlatformMoneyDepsInput["getSolQuote"]>>) =>
    buildPlatformMoneyDeps(
      input({
        solPriceSource: () => source,
        getSolQuote: async () => {
          asked += 1;
          return result;
        },
      }),
    ).solPrice();

  assert.deepEqual(await price("off", { ok: false, code: "source_off" }), {
    source: "off",
    ok: false,
    ageSeconds: null,
  });
  assert.equal(asked, 0);
  assert.deepEqual(await price("pyth", { ok: false, code: "stale" }), {
    source: "pyth",
    ok: false,
    ageSeconds: null,
  });
  assert.deepEqual(
    await price("static", {
      ok: true,
      quote: {
        source: "static",
        midMicroUsdPerSol: 100_000_000n,
        confMicroUsdPerSol: 0n,
        publishTime: 1,
        ageSeconds: 0,
        account: null,
      },
    }),
    { source: "static", ok: true, ageSeconds: 0 },
  );
  assert.equal(asked, 2);
});
