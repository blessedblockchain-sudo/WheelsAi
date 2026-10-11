import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import {
  createDepositAddressRoutes,
  DEPOSIT_LIST_LIMIT,
  type DepositAddressRouteDeps,
} from "../routes/depositAddress.js";
import {
  buildDepositAddressStore,
  issueDepositAddress,
  readDepositAddress,
  readUsdcAccountOpen,
  type DepositAddressDeps,
} from "../services/depositAddresses.js";
import type { CheckDepositsResult } from "../services/depositTypes.js";
import {
  prepareUsdcAccount,
  type PrepareUsdcAccountResult,
} from "../services/depositUsdcAccount.js";
import { deriveTopupDepositKeypair } from "../services/topupKeypairs.js";
import {
  addressFromSeed,
  addressRow,
  HOSTILE,
  makeFakeDb,
  type FakeDb,
  type FakeReceiptRow,
} from "./depositFakes.js";

// Drives apps/api/src/routes/depositAddress.ts against THE CONTRACT of the
// payments pass, batch 5. The routes run over the real address and
// "Prepare address" cores and the real store, bound to a stand-in database;
// the chain and the scan are stand-ins.
//
// The rules these tests hold the routes to:
//   - GET never creates or changes anything;
//   - a stored address that is not the derived one is never shown, on any
//     of the five routes;
//   - every answer carries `message`, a sentence from depositSentences.ts,
//     and no answer carries text from a node, the database or a throw.

const MASTER_KEY = "unit-test-master-key-0123456789abcdef";
const ORG = "11111111-1111-4111-8111-111111111111";
const ADDRESS = deriveTopupDepositKeypair({ masterKey: MASTER_KEY, orgId: ORG }).publicKey.toBase58();
const NOW = new Date("2026-10-11T12:00:00.000Z");

const SHOWN_SOL =
  "Send USDC or SOL on Solana to this address. It belongs to your organization only. USDC is credited one dollar for one USDC. SOL is credited at its dollar value when we see your transfer, usually within a few minutes.";
const SHOWN_USDC_ONLY =
  "Send USDC on Solana to this address. It belongs to your organization only. USDC is credited one dollar for one USDC, usually within a few minutes.";
const NOT_ISSUED = "Your organization has no deposit address yet.";
const PAUSED =
  "Deposits are paused for a moment. Nothing sent to your address is lost. Try again shortly.";

interface World {
  db: FakeDb;
  /** Whether the USDC account is on the chain; an Error makes the read throw. */
  usdcAccount: boolean | Error;
  chainReads: number;
  sends: string[];
  check: CheckDepositsResult | Error;
  checkCalls: Array<{ orgId: string; scanRequestedAt: Date | null }>;
}

function makeWorld(): World {
  return {
    db: makeFakeDb(),
    usdcAccount: false,
    chainReads: 0,
    sends: [],
    check: { outcome: "scanned", credited: [], waiting: [] },
    checkCalls: [],
  };
}

function makeDeps(
  world: World,
  over: Partial<DepositAddressRouteDeps> = {},
): DepositAddressRouteDeps {
  const store = buildDepositAddressStore(world.db);
  const usdcAccountExists = async () => {
    world.chainReads += 1;
    if (world.usdcAccount instanceof Error) throw world.usdcAccount;
    return world.usdcAccount;
  };
  const addressDeps: DepositAddressDeps = {
    store,
    deriveAddress: (orgId) =>
      deriveTopupDepositKeypair({ masterKey: MASTER_KEY, orgId }).publicKey.toBase58(),
    network: "solana:devnet",
    usdcAccountExists,
    now: () => NOW,
  };
  return {
    enabled: true,
    network: "devnet",
    solOffered: true,
    readAddress: (orgId) => readDepositAddress(addressDeps, orgId),
    issueAddress: (orgId) => issueDepositAddress(addressDeps, orgId),
    usdcAccountOpen: (row, options) => readUsdcAccountOpen(addressDeps, row, options),
    prepareUsdcAccount: (orgId) =>
      prepareUsdcAccount(
        {
          readAddress: (id) => readDepositAddress(addressDeps, id),
          store,
          usdcAccountExists,
          ensureCluster: async () => ({ ok: true }),
          readHotWalletLamports: async () => 1_000_000_000n,
          minHotWalletLamports: 50_000_000n,
          dailyLimit: 25,
          sendOpenUsdcAccount: async (address) => {
            world.sends.push(address);
            world.usdcAccount = true;
          },
          now: () => NOW,
          sleep: async () => {},
        },
        orgId,
      ),
    requestScan: async (orgId) => {
      await store.requestScan({ orgId, network: "solana:devnet", at: NOW });
    },
    checkDepositsNow: async (orgId) => {
      world.checkCalls.push({
        orgId,
        scanRequestedAt: world.db.addresses.get(orgId)?.scanRequestedAt ?? null,
      });
      if (world.check instanceof Error) throw world.check;
      return world.check;
    },
    listDeposits: ({ orgId, limit }) =>
      store.listDirectReceipts({ orgId, network: "solana:devnet", limit }),
    ...over,
  };
}

async function makeApp(deps: DepositAddressRouteDeps, opts: { authed?: boolean } = {}) {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.authed !== false) {
      request.auth = { userId: "u1", orgId: ORG, type: "jwt" } as typeof request.auth;
    }
  });
  await app.register(createDepositAddressRoutes(deps), { prefix: "/api/billing" });
  await app.ready();
  return app;
}

const ROUTES: Array<{ method: "GET" | "POST"; url: string }> = [
  { method: "GET", url: "/api/billing/deposit-address" },
  { method: "POST", url: "/api/billing/deposit-address" },
  { method: "POST", url: "/api/billing/deposit-address/usdc-account" },
  { method: "POST", url: "/api/billing/deposit-address/check" },
  { method: "GET", url: "/api/billing/deposits" },
];

function snapshot(db: FakeDb): string {
  return JSON.stringify([...db.addresses.values()], (_, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

function issue(world: World, over: Record<string, unknown> = {}) {
  world.db.addresses.set(ORG, addressRow({ orgId: ORG, address: ADDRESS, ...over }));
}

function receipt(id: string, over: Partial<FakeReceiptRow> = {}): FakeReceiptRow {
  return {
    id,
    orgId: ORG,
    network: "solana:devnet",
    source: "direct",
    asset: "USDC",
    amountRaw: 50_000_000n,
    status: "credited",
    ignoredReason: null,
    amountUsdCents: 5_000n,
    bonusCents: 0n,
    txSignature: `sig-${id}`,
    createdAt: NOW,
    creditedAt: NOW,
    ...over,
  };
}

// ============================================
// The gates
// ============================================

test("while deposits are off every route answers 501 deposits_not_enabled, and nothing is read or written", async () => {
  const world = makeWorld();
  issue(world);
  const before = snapshot(world.db);
  const app = await makeApp(makeDeps(world, { enabled: false }));
  try {
    for (const route of ROUTES) {
      const res = await app.inject(route);
      assert.equal(res.statusCode, 501, route.url);
      assert.deepEqual(res.json(), { error: "deposits_not_enabled", message: PAUSED });
    }
    assert.equal(snapshot(world.db), before);
    assert.deepEqual(world.db.writes, []);
    assert.equal(world.chainReads, 0);
    assert.deepEqual(world.checkCalls, []);
  } finally {
    await app.close();
  }
});

test("without a session every route answers 401 with a sentence", async () => {
  const world = makeWorld();
  const app = await makeApp(makeDeps(world), { authed: false });
  try {
    for (const route of ROUTES) {
      const res = await app.inject(route);
      assert.equal(res.statusCode, 401, route.url);
      assert.deepEqual(res.json(), {
        error: "unauthenticated",
        message: "Sign in to add credits.",
      });
    }
    assert.deepEqual(world.db.writes, []);
  } finally {
    await app.close();
  }
});

test("'Prepare address' is limited to 3 a minute and 'Check now' to 6", async () => {
  const app = Fastify();
  const limits: Record<string, unknown> = {};
  app.addHook("onRoute", (route) => {
    limits[`${String(route.method)} ${route.url}`] = (
      route.config as { rateLimit?: unknown } | undefined
    )?.rateLimit;
  });
  await app.register(createDepositAddressRoutes(makeDeps(makeWorld())), {
    prefix: "/api/billing",
  });
  await app.ready();
  try {
    assert.deepEqual(limits["POST /api/billing/deposit-address/usdc-account"], {
      max: 3,
      timeWindow: "1 minute",
    });
    assert.deepEqual(limits["POST /api/billing/deposit-address/check"], {
      max: 6,
      timeWindow: "1 minute",
    });
  } finally {
    await app.close();
  }
});

// ============================================
// GET /deposit-address
// ============================================

test("GET with no address: address null, the 'not issued yet' sentence, and nothing is created or read from the chain", async () => {
  const world = makeWorld();
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({ method: "GET", url: "/api/billing/deposit-address" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      address: null,
      network: "devnet",
      assets: [
        { asset: "USDC", accountOpen: false },
        { asset: "SOL", offered: true },
      ],
      message: NOT_ISSUED,
    });
    assert.equal(world.db.addresses.size, 0);
    assert.deepEqual(world.db.writes, []);
    assert.equal(world.chainReads, 0);
  } finally {
    await app.close();
  }
});

test("GET with an address shows it with both sentences, and never writes even when the USDC account is seen", async () => {
  const world = makeWorld();
  issue(world);
  world.usdcAccount = true;
  const before = snapshot(world.db);
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({ method: "GET", url: "/api/billing/deposit-address" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      address: ADDRESS,
      network: "devnet",
      assets: [
        { asset: "USDC", accountOpen: true },
        { asset: "SOL", offered: true },
      ],
      message: SHOWN_SOL,
    });
    assert.equal(world.chainReads, 1);
    assert.equal(snapshot(world.db), before);
    assert.deepEqual(world.db.writes, []);
  } finally {
    await app.close();
  }
});

test("GET: a recorded opening is accountOpen true with no chain read", async () => {
  const world = makeWorld();
  issue(world, { usdcAccountOpenedAt: NOW });
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({ method: "GET", url: "/api/billing/deposit-address" });
    assert.equal(res.json().assets[0].accountOpen, true);
    assert.equal(world.chainReads, 0);
  } finally {
    await app.close();
  }
});

test("GET: a chain read that fails is accountOpen false, still 200, with none of the error's text", async () => {
  const world = makeWorld();
  issue(world);
  world.usdcAccount = new Error(HOSTILE);
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({ method: "GET", url: "/api/billing/deposit-address" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().address, ADDRESS);
    assert.equal(res.json().assets[0].accountOpen, false);
    assert.ok(!res.body.includes("SECRET"));
  } finally {
    await app.close();
  }
});

test("with SOL not offered the answer and its sentences say USDC only", async () => {
  const world = makeWorld();
  issue(world);
  const app = await makeApp(makeDeps(world, { solOffered: false, network: "mainnet-beta" }));
  try {
    const res = await app.inject({ method: "GET", url: "/api/billing/deposit-address" });
    assert.equal(res.json().message, SHOWN_USDC_ONLY);
    assert.equal(res.json().network, "mainnet-beta");
    assert.deepEqual(res.json().assets[1], { asset: "SOL", offered: false });
  } finally {
    await app.close();
  }
});

test("GET: a row of another network reads as no address, and is left as it was", async () => {
  const world = makeWorld();
  issue(world, { network: "solana:mainnet", lastSolSignature: "sigA" });
  const before = snapshot(world.db);
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({ method: "GET", url: "/api/billing/deposit-address" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().address, null);
    assert.equal(res.json().message, NOT_ISSUED);
    assert.equal(snapshot(world.db), before);
  } finally {
    await app.close();
  }
});

// ============================================
// POST /deposit-address
// ============================================

test("POST issues the address and answers as GET does; issuing twice makes one row", async () => {
  const world = makeWorld();
  const app = await makeApp(makeDeps(world));
  try {
    const first = await app.inject({ method: "POST", url: "/api/billing/deposit-address" });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), {
      address: ADDRESS,
      network: "devnet",
      assets: [
        { asset: "USDC", accountOpen: false },
        { asset: "SOL", offered: true },
      ],
      message: SHOWN_SOL,
    });
    const second = await app.inject({ method: "POST", url: "/api/billing/deposit-address" });
    assert.deepEqual(second.json(), first.json());
    assert.equal(world.db.addresses.size, 1);
    assert.equal(world.db.addresses.get(ORG)!.network, "solana:devnet");
    assert.deepEqual(world.db.writes, ["create"]);

    const read = await app.inject({ method: "GET", url: "/api/billing/deposit-address" });
    assert.deepEqual(read.json(), first.json());
  } finally {
    await app.close();
  }
});

test("POST records the USDC account the first time it is seen", async () => {
  const world = makeWorld();
  world.usdcAccount = true;
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({ method: "POST", url: "/api/billing/deposit-address" });
    assert.equal(res.json().assets[0].accountOpen, true);
    const stored = world.db.addresses.get(ORG)!;
    assert.equal(stored.usdcAccountOpenedAt?.getTime(), NOW.getTime());
    assert.equal(stored.usdcAccountOpenedBy, null);
  } finally {
    await app.close();
  }
});

test("POST re-labels a row of another network and clears what was read there", async () => {
  const world = makeWorld();
  issue(world, {
    network: "solana:mainnet",
    usdcAccountOpenedAt: NOW,
    usdcAccountOpenedBy: "platform",
    usdcAccountRequestedAt: NOW,
    lastSolSignature: "sigA",
    lastUsdcSignature: "sigB",
    lastSeenLamports: 5n,
    lastSeenUsdcRaw: 6n,
    scanRequestedAt: NOW,
    lastScannedAt: NOW,
  });
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({ method: "POST", url: "/api/billing/deposit-address" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().address, ADDRESS);
    // The account that was open on the other network is not open on this one.
    assert.equal(res.json().assets[0].accountOpen, false);
    const stored = world.db.addresses.get(ORG)!;
    assert.equal(stored.network, "solana:devnet");
    assert.equal(stored.lastSolSignature, null);
    assert.equal(stored.lastUsdcSignature, null);
    assert.equal(stored.lastSeenLamports, 0n);
    assert.equal(stored.lastSeenUsdcRaw, 0n);
    assert.equal(stored.usdcAccountOpenedAt, null);
    assert.equal(stored.usdcAccountOpenedBy, null);
    assert.equal(stored.usdcAccountRequestedAt, null);
    assert.equal(stored.scanRequestedAt, null);
    assert.equal(stored.lastScannedAt, null);
    assert.equal(world.db.addresses.size, 1);
  } finally {
    await app.close();
  }
});

// ============================================
// A wrong stored address
// ============================================

test("a stored address that is not the derived one is never shown: 503 on all five routes, and nothing changes", async () => {
  const world = makeWorld();
  const wrong = addressFromSeed(77);
  world.db.addresses.set(ORG, addressRow({ orgId: ORG, address: wrong }));
  world.db.members.push({ orgId: ORG, userId: "u1", emailVerified: true });
  world.db.receipts.push(receipt("r1"));
  const before = snapshot(world.db);
  const app = await makeApp(makeDeps(world));
  try {
    for (const route of ROUTES) {
      const res = await app.inject(route);
      assert.equal(res.statusCode, 503, route.url);
      assert.deepEqual(res.json(), {
        error: "deposit_address_unavailable",
        message: PAUSED,
      });
      assert.ok(!res.body.includes(wrong), route.url);
      assert.ok(!res.body.includes(ADDRESS), route.url);
    }
    assert.equal(snapshot(world.db), before);
    assert.deepEqual(world.db.writes, []);
    assert.equal(world.chainReads, 0);
    assert.deepEqual(world.sends, []);
    assert.deepEqual(world.checkCalls, []);
  } finally {
    await app.close();
  }
});

// ============================================
// POST /deposit-address/usdc-account
// ============================================

test("prepare: no address is 404 deposit_address_not_issued", async () => {
  const world = makeWorld();
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/billing/deposit-address/usdc-account",
    });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), {
      error: "deposit_address_not_issued",
      message: NOT_ISSUED,
    });
    assert.deepEqual(world.sends, []);
  } finally {
    await app.close();
  }
});

test("prepare: already open answers 200 and sends nothing", async () => {
  const world = makeWorld();
  issue(world);
  world.usdcAccount = true;
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/billing/deposit-address/usdc-account",
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      accountOpen: true,
      message: "Your address can now receive USDC.",
    });
    assert.deepEqual(world.sends, []);
    assert.equal(world.db.addresses.get(ORG)!.usdcAccountOpenedBy, null);
  } finally {
    await app.close();
  }
});

test("prepare: not eligible is 403 and sends nothing", async () => {
  const world = makeWorld();
  issue(world);
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/billing/deposit-address/usdc-account",
    });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), {
      error: "not_eligible",
      message: "Verify your email or make one purchase first, then prepare the address.",
    });
    assert.deepEqual(world.sends, []);
  } finally {
    await app.close();
  }
});

test("prepare: an eligible organization gets one send, and the opening is recorded as the platform's", async () => {
  const world = makeWorld();
  issue(world);
  world.db.members.push({ orgId: ORG, userId: "u1", emailVerified: true });
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/billing/deposit-address/usdc-account",
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      accountOpen: true,
      message: "Your address can now receive USDC.",
    });
    assert.deepEqual(world.sends, [ADDRESS]);
    const stored = world.db.addresses.get(ORG)!;
    assert.equal(stored.usdcAccountOpenedBy, "platform");
    assert.equal(stored.usdcAccountRequestedAt?.getTime(), NOW.getTime());

    // Pressing again spends nothing.
    const again = await app.inject({
      method: "POST",
      url: "/api/billing/deposit-address/usdc-account",
    });
    assert.equal(again.statusCode, 200);
    assert.deepEqual(world.sends, [ADDRESS]);

    const read = await app.inject({ method: "GET", url: "/api/billing/deposit-address" });
    assert.equal(read.json().assets[0].accountOpen, true);
  } finally {
    await app.close();
  }
});

test("prepare: each refusal of the core has its status, code and sentence", async () => {
  const cases: Array<{
    result: PrepareUsdcAccountResult;
    solOffered: boolean;
    status: number;
    body: Record<string, unknown>;
  }> = [
    {
      result: { outcome: "daily_limit" },
      solOffered: true,
      status: 429,
      body: {
        error: "daily_limit",
        message: "The address cannot be prepared right now. Send SOL, or try again later.",
      },
    },
    {
      result: { outcome: "daily_limit" },
      solOffered: false,
      status: 429,
      body: {
        error: "daily_limit",
        message: "The address cannot be prepared right now. Try again later.",
      },
    },
    {
      result: { outcome: "unavailable", reason: "hot_wallet_low" },
      solOffered: true,
      status: 503,
      body: {
        error: "unavailable",
        message: "The address cannot be prepared right now. Send SOL, or try again later.",
      },
    },
    {
      result: { outcome: "unavailable", reason: "send_failed" },
      solOffered: false,
      status: 503,
      body: {
        error: "unavailable",
        message: "The address cannot be prepared right now. Try again later.",
      },
    },
    {
      result: { outcome: "not_eligible" },
      solOffered: true,
      status: 403,
      body: {
        error: "not_eligible",
        message: "Verify your email or make one purchase first, then prepare the address.",
      },
    },
    {
      result: { outcome: "not_issued" },
      solOffered: true,
      status: 404,
      body: { error: "deposit_address_not_issued", message: NOT_ISSUED },
    },
    {
      result: { outcome: "address_unavailable" },
      solOffered: true,
      status: 503,
      body: { error: "deposit_address_unavailable", message: PAUSED },
    },
    {
      result: { outcome: "open", sent: true },
      solOffered: true,
      status: 200,
      body: { accountOpen: true, message: "Your address can now receive USDC." },
    },
  ];
  for (const one of cases) {
    const app = await makeApp(
      makeDeps(makeWorld(), {
        solOffered: one.solOffered,
        prepareUsdcAccount: async () => one.result,
      }),
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/billing/deposit-address/usdc-account",
      });
      assert.equal(res.statusCode, one.status, one.result.outcome);
      // The reason is for the log, never for the answer.
      assert.deepEqual(res.json(), one.body, one.result.outcome);
    } finally {
      await app.close();
    }
  }
});

// ============================================
// POST /deposit-address/check
// ============================================

test("check: no address is 404, and the scan is not called", async () => {
  const world = makeWorld();
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({ method: "POST", url: "/api/billing/deposit-address/check" });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), {
      error: "deposit_address_not_issued",
      message: NOT_ISSUED,
    });
    assert.deepEqual(world.checkCalls, []);
  } finally {
    await app.close();
  }
});

test("check: scanRequestedAt is set before the scan is called, and nothing new has its sentence", async () => {
  const world = makeWorld();
  issue(world);
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({ method: "POST", url: "/api/billing/deposit-address/check" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      credited: [],
      waiting: [],
      message: "No new transfer yet. Transfers usually arrive within a few minutes.",
    });
    assert.equal(world.checkCalls.length, 1);
    assert.equal(world.checkCalls[0]!.orgId, ORG);
    assert.equal(world.checkCalls[0]!.scanRequestedAt?.getTime(), NOW.getTime());
  } finally {
    await app.close();
  }
});

test("check: one credited transfer with a bonus, in the contract's shape", async () => {
  const world = makeWorld();
  issue(world);
  world.check = {
    outcome: "scanned",
    credited: [
      {
        asset: "USDC",
        amountRaw: 50_000_000n,
        creditedCents: 5_000n,
        bonusCents: 500n,
        txSignature: "sigUsdc",
      },
    ],
    waiting: [],
  };
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({ method: "POST", url: "/api/billing/deposit-address/check" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      credited: [
        {
          asset: "USDC",
          amount: "50.00",
          creditedUsd: 50,
          bonusUsd: 5,
          txSignature: "sigUsdc",
        },
      ],
      waiting: [],
      message: "Credited $55.00 from your transfer: $50.00 sent and a $5.00 bonus.",
    });
  } finally {
    await app.close();
  }
});

test("check: several credited and one waiting; the amounts are in whole units", async () => {
  const world = makeWorld();
  issue(world);
  world.check = {
    outcome: "scanned",
    credited: [
      { asset: "USDC", amountRaw: 50_000_000n, creditedCents: 5_000n, bonusCents: 500n, txSignature: "s1" },
      { asset: "SOL", amountRaw: 37_000_000n, creditedCents: 740n, bonusCents: 0n, txSignature: "s2" },
      { asset: "USDC", amountRaw: 1_234_567n, creditedCents: 123n, bonusCents: 0n, txSignature: "s3" },
    ],
    waiting: [{ asset: "SOL", amountRaw: 1_000n, txSignature: "s4" }],
  };
  const app = await makeApp(makeDeps(world));
  try {
    const body = (
      await app.inject({ method: "POST", url: "/api/billing/deposit-address/check" })
    ).json();
    assert.deepEqual(
      body.credited.map((one: { amount: string }) => one.amount),
      ["50.00", "0.037", "1.234567"],
    );
    assert.deepEqual(body.credited[1], {
      asset: "SOL",
      amount: "0.037",
      creditedUsd: 7.4,
      bonusUsd: 0,
      txSignature: "s2",
    });
    assert.deepEqual(body.waiting, [{ asset: "SOL", amount: "0.000001", txSignature: "s4" }]);
    assert.equal(body.message, "Credited $63.63 from 3 transfers.");
  } finally {
    await app.close();
  }
});

test("check: nothing credited and a transfer waiting for a price", async () => {
  const world = makeWorld();
  issue(world);
  world.check = {
    outcome: "scanned",
    credited: [],
    waiting: [{ asset: "SOL", amountRaw: 500_000_000n, txSignature: "sigSol" }],
  };
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({ method: "POST", url: "/api/billing/deposit-address/check" });
    assert.deepEqual(res.json(), {
      credited: [],
      waiting: [{ asset: "SOL", amount: "0.5", txSignature: "sigSol" }],
      message:
        "We have seen your transfer of 0.5 SOL. It is credited as soon as we can get a current SOL price.",
    });
  } finally {
    await app.close();
  }
});

test("check: the chain cannot be read is 503 chain_unavailable; the request for a scan stays for the worker", async () => {
  const world = makeWorld();
  issue(world);
  world.check = { outcome: "chain_unavailable" };
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({ method: "POST", url: "/api/billing/deposit-address/check" });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: "chain_unavailable", message: PAUSED });
    assert.equal(world.db.addresses.get(ORG)!.scanRequestedAt?.getTime(), NOW.getTime());
  } finally {
    await app.close();
  }
});

test("check: the scan saying 'not issued' is 404", async () => {
  const world = makeWorld();
  issue(world);
  world.check = { outcome: "not_issued" };
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({ method: "POST", url: "/api/billing/deposit-address/check" });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), {
      error: "deposit_address_not_issued",
      message: NOT_ISSUED,
    });
  } finally {
    await app.close();
  }
});

// ============================================
// GET /deposits
// ============================================

test("deposits: credited, waiting and ignored, newest first, in the contract's shape", async () => {
  const world = makeWorld();
  issue(world);
  const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);
  world.db.receipts.push(
    receipt("bonus", { createdAt: at(30), creditedAt: at(29), bonusCents: 500n }),
    receipt("waiting", {
      createdAt: at(1),
      asset: "SOL",
      amountRaw: 500_000_000n,
      status: "detected",
      amountUsdCents: null,
      creditedAt: null,
    }),
    receipt("ignored", {
      createdAt: at(10),
      amountRaw: 9_999n,
      status: "ignored",
      ignoredReason: "below_one_cent",
      amountUsdCents: null,
      creditedAt: null,
    }),
    receipt("plain", { createdAt: at(20), creditedAt: at(19), amountRaw: 12_340_000n, amountUsdCents: 1_234n }),
    // Not shown: a prepared top-up's receipt, and another organization's.
    receipt("prepared", { source: "prepared" }),
    receipt("theirs", { orgId: "22222222-2222-4222-8222-222222222222" }),
  );
  const app = await makeApp(makeDeps(world));
  try {
    const res = await app.inject({ method: "GET", url: "/api/billing/deposits" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      deposits: [
        {
          id: "waiting",
          asset: "SOL",
          amount: "0.5",
          status: "waiting",
          creditedUsd: null,
          bonusUsd: 0,
          txSignature: "sig-waiting",
          createdAt: at(1).toISOString(),
          creditedAt: null,
          message:
            "We have seen your transfer of 0.5 SOL. It is credited as soon as we can get a current SOL price.",
        },
        {
          id: "ignored",
          asset: "USDC",
          amount: "0.009999",
          status: "ignored",
          creditedUsd: null,
          bonusUsd: 0,
          txSignature: "sig-ignored",
          createdAt: at(10).toISOString(),
          creditedAt: null,
          message: "This transfer was too small to credit.",
        },
        {
          id: "plain",
          asset: "USDC",
          amount: "12.34",
          status: "credited",
          creditedUsd: 12.34,
          bonusUsd: 0,
          txSignature: "sig-plain",
          createdAt: at(20).toISOString(),
          creditedAt: at(19).toISOString(),
          message: "Credited $12.34.",
        },
        {
          id: "bonus",
          asset: "USDC",
          amount: "50.00",
          status: "credited",
          creditedUsd: 50,
          bonusUsd: 5,
          txSignature: "sig-bonus",
          createdAt: at(30).toISOString(),
          creditedAt: at(29).toISOString(),
          message: "Credited $55.00: $50.00 sent and a $5.00 bonus.",
        },
      ],
    });
    assert.deepEqual(world.db.writes, []);
  } finally {
    await app.close();
  }
});

test("deposits: the last 20 only, and an organization with no address has an empty list", async () => {
  assert.equal(DEPOSIT_LIST_LIMIT, 20);
  const world = makeWorld();
  const app = await makeApp(makeDeps(world));
  try {
    const empty = await app.inject({ method: "GET", url: "/api/billing/deposits" });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { deposits: [] });

    issue(world);
    for (let i = 0; i < 25; i += 1) {
      world.db.receipts.push(
        receipt(`r${i}`, { createdAt: new Date(NOW.getTime() - i * 1_000) }),
      );
    }
    const res = await app.inject({ method: "GET", url: "/api/billing/deposits" });
    const ids = res.json().deposits.map((one: { id: string }) => one.id);
    assert.equal(ids.length, 20);
    assert.equal(ids[0], "r0");
    assert.equal(ids[19], "r19");
  } finally {
    await app.close();
  }
});

// ============================================
// No thrown text in any answer
// ============================================

test("an unexpected throw on any route is 503 with the 'paused' sentence and none of the error's text", async () => {
  const boom = async (): Promise<never> => {
    throw new Error(HOSTILE);
  };
  const world = makeWorld();
  const app = await makeApp(
    makeDeps(world, {
      readAddress: boom,
      issueAddress: boom,
      prepareUsdcAccount: boom,
      listDeposits: boom,
    }),
  );
  try {
    for (const route of ROUTES) {
      const res = await app.inject(route);
      assert.equal(res.statusCode, 503, route.url);
      assert.deepEqual(res.json(), { error: "deposits_unavailable", message: PAUSED });
      for (const leak of ["ECONNREFUSED", "SECRET", "rpc.example", "Prisma", "P2002", "<script>"]) {
        assert.ok(!res.body.includes(leak), `${route.url} leaked ${leak}`);
      }
    }
  } finally {
    await app.close();
  }
});

test("a scan that throws, a store that throws and a list that throws leak nothing either", async () => {
  const world = makeWorld();
  issue(world);
  world.check = new Error(HOSTILE);
  const app = await makeApp(
    makeDeps(world, {
      listDeposits: async () => {
        throw new Error(HOSTILE);
      },
      usdcAccountOpen: async () => {
        throw new Error(HOSTILE);
      },
    }),
  );
  try {
    for (const route of [ROUTES[0]!, ROUTES[1]!, ROUTES[3]!, ROUTES[4]!]) {
      const res = await app.inject(route);
      assert.equal(res.statusCode, 503, route.url);
      assert.deepEqual(res.json(), { error: "deposits_unavailable", message: PAUSED });
      assert.ok(!res.body.includes("SECRET"), route.url);
    }
  } finally {
    await app.close();
  }
});

test("a database that fails mid-read is the 'paused' sentence, never 'no address'", async () => {
  const world = makeWorld();
  issue(world);
  const app = await makeApp(makeDeps(world));
  try {
    world.db.failNext.find = new Error(HOSTILE);
    const res = await app.inject({ method: "GET", url: "/api/billing/deposit-address" });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: "deposits_unavailable", message: PAUSED });
  } finally {
    await app.close();
  }
});

// ============================================
// GET /packages
// ============================================

test("GET /packages: rails.deposits is true when DEPOSITS_ENABLED is on, and false when it is off", async () => {
  const { billingRoutes } = await import("../routes/billing.js");
  const { env } = await import("../config/env.js");

  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request) => {
    // Stand in for the global auth hook: the billing routes ask for a
    // signed-in principal.
    (request as unknown as { auth: unknown }).auth = {
      userId: "user_1",
      orgId: "org_1",
      role: "owner",
      type: "jwt",
    };
  });
  await app.register(billingRoutes, { prefix: "/api/billing" });

  const settings = env as unknown as Record<string, unknown>;
  const saved = settings.DEPOSITS_ENABLED;
  const railsWith = async (enabled: boolean) => {
    settings.DEPOSITS_ENABLED = enabled;
    const res = await app.inject({ method: "GET", url: "/api/billing/packages" });
    assert.equal(res.statusCode, 200);
    return res.json().rails as Record<string, unknown>;
  };
  try {
    assert.equal((await railsWith(false)).deposits, false);
    const on = await railsWith(true);
    assert.equal(on.deposits, true);
    // The rails that were there are still there.
    for (const key of ["stripeCheckout", "proSubscription", "mockCheckout", "wallet", "walletAssets", "network"]) {
      assert.ok(key in on, key);
    }
  } finally {
    settings.DEPOSITS_ENABLED = saved;
    await app.close();
  }
});
