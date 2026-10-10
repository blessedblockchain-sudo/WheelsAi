/**
 * Drives apps/api/src/routes/walletTopupBindings.ts: the store (every
 * read and write of wallet_topups), the chain reads, and the production
 * wiring, against stand-ins. No database, no network.
 *
 * Pinning:
 *   - the claim is ONE compare-and-set that stores the signature, the
 *     signed bytes and the time: won, lost, duplicate signature;
 *   - a status change is a compare-and-set that carries the reason code;
 *   - reads and the list are scoped to the organization, and the raw
 *     failure reason never leaves the store;
 *   - the payer's balances come from one call;
 *   - SOL is offered when SOL_PRICE_SOURCE is not "off", and the two
 *     removed settings are read nowhere.
 */

import "./unitEnv.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";

import { env } from "../config/env.js";
import {
  buildProductionWalletTopupDeps,
  buildWalletTopupChain,
  buildWalletTopupStore,
  type TopupConnection,
  type TopupDbRow,
  type TopupStoreDb,
} from "../routes/walletTopupBindings.js";
import { derivePayoutKeypair } from "../services/payoutKeypair.js";
import { deriveTopupDepositKeypair } from "../services/topupKeypairs.js";

const NOW = new Date("2026-08-07T12:00:00.000Z");
const HOSTILE = "node said: https://rpc.example.invalid/?api-key=SECRET-KEY-123 refused";

type StoredRow = TopupDbRow & {
  failureReason: string | null;
  signedTxB64: string | null;
  submittedAt: Date | null;
} & Record<string, unknown>;

function storedRow(over: Partial<StoredRow> = {}): StoredRow {
  return {
    id: "row_1",
    orgId: "org_1",
    asset: "USDC",
    network: "solana:devnet",
    amountUsdCents: 5_000n,
    bonusCents: 500n,
    amountRaw: "50000000",
    quotedSolPriceUsd: null,
    payerAddress: "payer",
    depositAddress: "deposit",
    unsignedMessageB64: "bWVzc2FnZQ==",
    txSignature: null,
    status: "prepared",
    failureCode: null,
    failureReason: null,
    signedTxB64: null,
    submittedAt: null,
    createdAt: new Date(NOW.getTime() - 10_000),
    expiresAt: new Date(NOW.getTime() + 60_000),
    lastValidBlockHeight: 1_000n,
    ...over,
  };
}

/** An in-memory wallet_topups that honours `where` the way Prisma does
 * for the few shapes the store uses, and the UNIQUE on tx_signature. */
function makeDb(rows: StoredRow[], balances: Record<string, bigint> = {}) {
  const calls: Array<{ op: string; args: any }> = [];

  const matches = (row: StoredRow, where: Record<string, any>): boolean => {
    for (const [key, want] of Object.entries(where)) {
      const have = row[key];
      if (want !== null && typeof want === "object" && !(want instanceof Date)) {
        if ("in" in want && !want.in.includes(have)) return false;
        if ("lt" in want && !((have as Date).getTime() < want.lt.getTime())) return false;
      } else if (have !== want) {
        return false;
      }
    }
    return true;
  };

  const db: TopupStoreDb = {
    walletTopUp: {
      create: async (args) => {
        calls.push({ op: "create", args });
        rows.push(storedRow(args.data as Partial<StoredRow>));
        return {};
      },
      findFirst: async (args) => {
        calls.push({ op: "findFirst", args });
        return rows.find((row) => matches(row, args.where)) ?? null;
      },
      findMany: async (args) => {
        calls.push({ op: "findMany", args });
        return rows
          .filter((row) => matches(row, args.where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, args.take);
      },
      updateMany: async (args) => {
        calls.push({ op: "updateMany", args });
        const hit = rows.filter((row) => matches(row, args.where));
        const signature = args.data.txSignature;
        if (
          signature !== undefined &&
          hit.length > 0 &&
          rows.some((row) => row.txSignature === signature && !hit.includes(row))
        ) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        for (const row of hit) Object.assign(row, args.data);
        return { count: hit.length };
      },
    },
    creditBalance: {
      findUnique: async (args) => {
        calls.push({ op: "balance", args });
        const cents = balances[args.where.orgId];
        return cents === undefined ? null : { balanceCents: cents };
      },
    },
  };
  return { db, calls };
}

// ============================================
// The claim
// ============================================

test("the claim, won: one compare-and-set stores the signature, the bytes and the time", async () => {
  const row = storedRow();
  const { db, calls } = makeDb([row]);
  const store = buildWalletTopupStore(db);
  const result = await store.claimForSubmit({
    id: "row_1",
    txSignature: "sig_1",
    signedTxB64: "c2lnbmVk",
    submittedAt: NOW,
  });
  assert.equal(result, "claimed");
  assert.deepEqual(calls, [
    {
      op: "updateMany",
      args: {
        where: { id: "row_1", status: "prepared" },
        data: {
          status: "submitting",
          txSignature: "sig_1",
          signedTxB64: "c2lnbmVk",
          submittedAt: NOW,
        },
      },
    },
  ]);
  assert.equal(row.status, "submitting");
  assert.equal(row.txSignature, "sig_1");
  assert.equal(row.signedTxB64, "c2lnbmVk");
  assert.equal(row.submittedAt, NOW);
});

test("the claim, lost: a row no longer prepared is not touched", async () => {
  for (const status of ["submitting", "submitted", "credited", "failed", "expired"]) {
    const row = storedRow({ status, txSignature: "first_sig", signedTxB64: "Zmlyc3Q=" });
    const { db } = makeDb([row]);
    const result = await buildWalletTopupStore(db).claimForSubmit({
      id: "row_1",
      txSignature: "second_sig",
      signedTxB64: "c2Vjb25k",
      submittedAt: NOW,
    });
    assert.equal(result, "lost", status);
    assert.equal(row.status, status);
    assert.equal(row.txSignature, "first_sig", "the first claim's signature stays");
    assert.equal(row.signedTxB64, "Zmlyc3Q=");
  }
  // A row that does not exist is a lost claim too.
  const { db } = makeDb([]);
  assert.equal(
    await buildWalletTopupStore(db).claimForSubmit({
      id: "nope",
      txSignature: "s",
      signedTxB64: "cw==",
      submittedAt: NOW,
    }),
    "lost",
  );
});

test("the claim, duplicate signature: the unique constraint is a named answer", async () => {
  const other = storedRow({ id: "row_0", status: "submitted", txSignature: "sig_1" });
  const row = storedRow();
  const { db } = makeDb([other, row]);
  const result = await buildWalletTopupStore(db).claimForSubmit({
    id: "row_1",
    txSignature: "sig_1",
    signedTxB64: "c2lnbmVk",
    submittedAt: NOW,
  });
  assert.equal(result, "duplicate_signature");
  assert.equal(row.status, "prepared", "the row is still there to be signed");
  assert.equal(row.txSignature, null);
});

test("the claim does not swallow any other database error", async () => {
  const { db } = makeDb([storedRow()]);
  db.walletTopUp.updateMany = async () => {
    throw Object.assign(new Error("connection lost"), { code: "P1001" });
  };
  await assert.rejects(
    buildWalletTopupStore(db).claimForSubmit({
      id: "row_1",
      txSignature: "sig_1",
      signedTxB64: "c2lnbmVk",
      submittedAt: NOW,
    }),
    /connection lost/,
  );
});

// ============================================
// The status change
// ============================================

test("a status change is a compare-and-set that carries the code and the raw reason", async () => {
  const row = storedRow({ status: "submitted", txSignature: "sig_1" });
  const { db, calls } = makeDb([row]);
  const store = buildWalletTopupStore(db);
  const changed = await store.markStatus({
    id: "row_1",
    from: ["submitting", "submitted"],
    to: "failed",
    failureCode: "failed_on_chain",
    failureReason: HOSTILE,
  });
  assert.equal(changed, true);
  assert.deepEqual(calls[0]!.args, {
    where: { id: "row_1", status: { in: ["submitting", "submitted"] } },
    data: { status: "failed", failureCode: "failed_on_chain", failureReason: HOSTILE },
  });
  assert.equal(row.status, "failed");
  assert.equal(row.failureCode, "failed_on_chain");
  assert.equal(row.failureReason, HOSTILE);
});

test("a status change that lost the race changes nothing and says so", async () => {
  const row = storedRow({ status: "credited", txSignature: "sig_1" });
  const { db } = makeDb([row]);
  const changed = await buildWalletTopupStore(db).markStatus({
    id: "row_1",
    from: ["submitting", "submitted"],
    to: "expired",
    failureCode: "never_landed",
  });
  assert.equal(changed, false);
  assert.equal(row.status, "credited");
  assert.equal(row.failureCode, null);
});

test("a status change with no code writes no code", async () => {
  const row = storedRow({ status: "submitting", txSignature: "sig_1" });
  const { db, calls } = makeDb([row]);
  await buildWalletTopupStore(db).markStatus({
    id: "row_1",
    from: ["submitting"],
    to: "submitted",
  });
  assert.deepEqual(calls[0]!.args.data, { status: "submitted" });
  assert.equal(row.status, "submitted");
});

test("housekeeping expires only this organization's unsigned, overdue, prepared rows", async () => {
  const past = new Date(NOW.getTime() - 1_000);
  const overdue = storedRow({ id: "overdue", expiresAt: past });
  const fresh = storedRow({ id: "fresh" });
  const otherOrg = storedRow({ id: "other", orgId: "org_2", expiresAt: past });
  const inFlight = storedRow({
    id: "flying",
    status: "submitting",
    txSignature: "sig",
    expiresAt: past,
  });
  // Cannot happen (the claim sets both at once), and still must not be
  // ended by the clock: it has a signature.
  const signedPrepared = storedRow({ id: "odd", txSignature: "sig2", expiresAt: past });
  const { db } = makeDb([overdue, fresh, otherOrg, inFlight, signedPrepared]);
  await buildWalletTopupStore(db).expireStalePrepared({ orgId: "org_1", now: NOW });
  assert.equal(overdue.status, "expired");
  assert.equal(overdue.failureCode, "unsigned_expired");
  assert.equal(fresh.status, "prepared");
  assert.equal(otherOrg.status, "prepared");
  assert.equal(inFlight.status, "submitting");
  assert.equal(signedPrepared.status, "prepared");
});

// ============================================
// Reads
// ============================================

test("a top-up is found only inside its own organization, without its raw reason", async () => {
  const row = storedRow({ status: "failed", failureCode: "failed_on_chain", failureReason: HOSTILE });
  const { db } = makeDb([row]);
  const store = buildWalletTopupStore(db);
  assert.equal(await store.findTopup({ id: "row_1", orgId: "org_2" }), null);
  const found = await store.findTopup({ id: "row_1", orgId: "org_1" });
  assert.ok(found);
  assert.equal(found.failureCode, "failed_on_chain");
  assert.ok(!JSON.stringify(found, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).includes("SECRET"));
  assert.deepEqual(Object.keys(found).sort(), [
    "amountRaw",
    "amountUsdCents",
    "asset",
    "bonusCents",
    "createdAt",
    "depositAddress",
    "expiresAt",
    "failureCode",
    "id",
    "lastValidBlockHeight",
    "network",
    "orgId",
    "payerAddress",
    "quotedSolPriceUsd",
    "status",
    "txSignature",
    "unsignedMessageB64",
  ]);
});

test("the list is the organization's own, newest first, and no longer than asked", async () => {
  const rows = [
    storedRow({ id: "old", createdAt: new Date(NOW.getTime() - 30_000) }),
    storedRow({ id: "theirs", orgId: "org_2", createdAt: new Date(NOW.getTime() - 1_000) }),
    storedRow({ id: "new", createdAt: new Date(NOW.getTime() - 5_000), failureReason: HOSTILE }),
    storedRow({ id: "mid", createdAt: new Date(NOW.getTime() - 20_000) }),
  ];
  const { db, calls } = makeDb(rows);
  const store = buildWalletTopupStore(db);
  const listed = await store.listTopups({ orgId: "org_1", limit: 20 });
  assert.deepEqual(listed.map((row) => row.id), ["new", "mid", "old"]);
  assert.deepEqual(calls[0]!.args, {
    where: { orgId: "org_1" },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  assert.ok(listed.every((row) => !("failureReason" in row)));
  assert.deepEqual(
    (await store.listTopups({ orgId: "org_1", limit: 2 })).map((row) => row.id),
    ["new", "mid"],
  );
  assert.deepEqual(await store.listTopups({ orgId: "org_3", limit: 20 }), []);
});

test("a new top-up is written with the price it was worked out from", async () => {
  const { db, calls } = makeDb([]);
  const publishTime = new Date("2026-08-07T11:59:58.000Z");
  await buildWalletTopupStore(db).createTopup({
    id: "row_9",
    orgId: "org_1",
    asset: "SOL",
    network: "solana:devnet",
    amountUsdCents: 5_000n,
    bonusCents: 500n,
    amountRaw: "250000000",
    quotedSolPriceUsd: 200,
    quotePriceMicroUsd: 200_000_000n,
    quotePublishTime: publishTime,
    quoteSource: "pyth",
    payerAddress: "payer",
    depositAddress: "deposit",
    unsignedMessageB64: "bWVzc2FnZQ==",
    expiresAt: NOW,
    lastValidBlockHeight: 1_000n,
  });
  assert.deepEqual(calls[0]!.args.data, {
    id: "row_9",
    orgId: "org_1",
    asset: "SOL",
    network: "solana:devnet",
    amountUsdCents: 5_000n,
    bonusCents: 500n,
    amountRaw: "250000000",
    quotedSolPriceUsd: 200,
    quotePriceMicroUsd: 200_000_000n,
    quotePublishTime: publishTime,
    quoteSource: "pyth",
    payerAddress: "payer",
    depositAddress: "deposit",
    unsignedMessageB64: "bWVzc2FnZQ==",
    expiresAt: NOW,
    lastValidBlockHeight: 1_000n,
  });
});

test("the credit balance is the organization's, and nothing when it has no row", async () => {
  const { db } = makeDb([], { org_1: 6_500n });
  const store = buildWalletTopupStore(db);
  assert.equal(await store.readBalanceCents!("org_1"), 6_500n);
  assert.equal(await store.readBalanceCents!("org_2"), 0n);
});

// ============================================
// The chain
// ============================================

const MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const PAYER = Keypair.fromSeed(new Uint8Array(32).fill(31)).publicKey;
const DEPOSIT = Keypair.fromSeed(new Uint8Array(32).fill(32)).publicKey;

function tokenAccount(amount: bigint, owner: PublicKey = TOKEN_PROGRAM_ID) {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(amount, 64);
  return { owner, data, lamports: 2_039_280, executable: false };
}

function makeConnection(over: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const connection = {
    getLatestBlockhash: async (...args: unknown[]) => {
      calls.push({ method: "getLatestBlockhash", args });
      return { blockhash: "hash", lastValidBlockHeight: 1_000 };
    },
    getMultipleAccountsInfo: async (...args: unknown[]) => {
      calls.push({ method: "getMultipleAccountsInfo", args });
      return [];
    },
    sendRawTransaction: async (...args: unknown[]) => {
      calls.push({ method: "sendRawTransaction", args });
      return "sig";
    },
    confirmTransaction: async (...args: unknown[]) => {
      calls.push({ method: "confirmTransaction", args });
      return { context: { slot: 1 }, value: { err: null } };
    },
    ...over,
  } as unknown as TopupConnection;
  return { connection, calls };
}

test("a USDC payer's balances come from ONE call for three accounts", async () => {
  const { connection, calls } = makeConnection({
    getMultipleAccountsInfo: async (...args: unknown[]) => {
      calls.push({ method: "getMultipleAccountsInfo", args });
      return [
        { owner: new PublicKey("11111111111111111111111111111111"), data: Buffer.alloc(0), lamports: 7_000_000 },
        tokenAccount(3_200_000n),
        null,
      ];
    },
  });
  const chain = buildWalletTopupChain({ getConnection: () => connection, usdcMint: MINT });
  const held = await chain.readPayerBalances({
    payerAddress: PAYER.toBase58(),
    depositAddress: DEPOSIT.toBase58(),
    asset: "USDC",
  });
  assert.deepEqual(held, {
    lamports: 7_000_000n,
    usdcRaw: 3_200_000n,
    depositUsdcAccountExists: false,
  });
  assert.equal(calls.length, 1);
  const [keys, commitment] = calls[0]!.args as [PublicKey[], string];
  assert.equal(commitment, "confirmed");
  assert.deepEqual(
    keys.map((key) => key.toBase58()),
    [
      PAYER.toBase58(),
      getAssociatedTokenAddressSync(MINT, PAYER).toBase58(),
      getAssociatedTokenAddressSync(MINT, DEPOSIT).toBase58(),
    ],
  );
});

test("no token account is a balance of nothing; an account that is no token account is not a balance", async () => {
  const read = async (accounts: unknown[]) => {
    const { connection } = makeConnection({ getMultipleAccountsInfo: async () => accounts });
    return buildWalletTopupChain({ getConnection: () => connection, usdcMint: MINT }).readPayerBalances({
      payerAddress: PAYER.toBase58(),
      depositAddress: DEPOSIT.toBase58(),
      asset: "USDC",
    });
  };
  assert.deepEqual(await read([null, null, tokenAccount(1n)]), {
    lamports: 0n,
    usdcRaw: 0n,
    depositUsdcAccountExists: true,
  });
  const notAToken = await read([null, tokenAccount(9n, PAYER), tokenAccount(1n)]);
  assert.equal(notAToken.usdcRaw, null);
  const tooShort = await read([
    null,
    { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(10), lamports: 1 },
    null,
  ]);
  assert.equal(tooShort.usdcRaw, null);
  // A node that answers for fewer accounts than asked is a failed read.
  await assert.rejects(read([null]), /every account/);
});

test("a SOL payer's balance is one account, and says nothing about USDC", async () => {
  const { connection, calls } = makeConnection({
    getMultipleAccountsInfo: async (...args: unknown[]) => {
      calls.push({ method: "getMultipleAccountsInfo", args });
      return [{ owner: PAYER, data: Buffer.alloc(0), lamports: 250_005_000 }];
    },
  });
  const held = await buildWalletTopupChain({
    getConnection: () => connection,
    usdcMint: MINT,
  }).readPayerBalances({
    payerAddress: PAYER.toBase58(),
    depositAddress: DEPOSIT.toBase58(),
    asset: "SOL",
  });
  assert.deepEqual(held, {
    lamports: 250_005_000n,
    usdcRaw: null,
    depositUsdcAccountExists: null,
  });
  assert.equal((calls[0]!.args[0] as PublicKey[]).length, 1);
});

test("a send hands over the signed bytes as they are; an error is a detail with no address in it", async () => {
  const good = makeConnection();
  const chain = buildWalletTopupChain({ getConnection: () => good.connection, usdcMint: MINT });
  const raw = Buffer.from("signed bytes").toString("base64");
  assert.deepEqual(await chain.sendRawTransaction(raw), { ok: true });
  assert.deepEqual(good.calls[0]!.args[0], Buffer.from("signed bytes"));

  const bad = makeConnection({
    sendRawTransaction: async () => {
      throw new Error(HOSTILE);
    },
  });
  const result = await buildWalletTopupChain({
    getConnection: () => bad.connection,
    usdcMint: MINT,
  }).sendRawTransaction(raw);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && !result.detail.includes("SECRET-KEY-123"));
  assert.ok(!result.ok && result.detail.includes("<address>"));
});

test("the wait never throws and never outlasts its limit", async () => {
  const args = { signature: "sig", blockhash: "hash", lastValidBlockHeight: 1_000 };
  const throwing = makeConnection({
    confirmTransaction: async () => {
      throw new Error(HOSTILE);
    },
  });
  await buildWalletTopupChain({
    getConnection: () => throwing.connection,
    usdcMint: MINT,
  }).waitForConfirmation(args);

  const unbuildable = buildWalletTopupChain({
    getConnection: () => {
      throw new Error("no connection");
    },
    usdcMint: MINT,
  });
  await unbuildable.waitForConfirmation(args);

  let release = () => {};
  const hanging = makeConnection({
    confirmTransaction: () => new Promise((resolve) => (release = () => resolve(null))),
  });
  const started = Date.now();
  await buildWalletTopupChain({
    getConnection: () => hanging.connection,
    usdcMint: MINT,
    confirmWaitMs: 20,
  }).waitForConfirmation(args);
  assert.ok(Date.now() - started < 2_000);
  release();
});

test("the blockhash is read at confirmed", async () => {
  const { connection, calls } = makeConnection();
  const answer = await buildWalletTopupChain({
    getConnection: () => connection,
    usdcMint: MINT,
  }).getLatestBlockhash();
  assert.deepEqual(answer, { blockhash: "hash", lastValidBlockHeight: 1_000 });
  assert.deepEqual(calls[0], { method: "getLatestBlockhash", args: ["confirmed"] });
});

// ============================================
// Production wiring
// ============================================

function withEnv(values: Record<string, unknown>, fn: () => void) {
  const target = env as unknown as Record<string, unknown>;
  const before: Record<string, unknown> = {};
  for (const key of Object.keys(values)) before[key] = target[key];
  Object.assign(target, values);
  try {
    fn();
  } finally {
    Object.assign(target, before);
  }
}

test("SOL is offered when SOL_PRICE_SOURCE is not off, and by nothing else", () => {
  for (const [source, offered] of [
    ["off", false],
    ["pyth", true],
    ["static", true],
  ] as const) {
    withEnv({ SOL_PRICE_SOURCE: source }, () => {
      assert.equal(buildProductionWalletTopupDeps().solEnabled, offered, source);
    });
  }
});

test("the two removed settings are read nowhere in the top-up code", () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const file of [
    "routes/walletTopupBindings.ts",
    "routes/walletTopup.ts",
    "services/walletTopup.ts",
    "services/topupSentences.ts",
  ]) {
    const code = readFileSync(path.join(src, file), "utf8");
    assert.ok(!code.includes("ALLOW_DEVNET_WALLET_TOPUPS"), file);
    assert.ok(!code.includes("WALLET_TOPUP_SOL_PRICE_USD"), file);
  }
  // The rails of GET /packages follow the same rule.
  const billing = readFileSync(path.join(src, "routes/billing.ts"), "utf8");
  assert.ok(!billing.includes("ALLOW_DEVNET_WALLET_TOPUPS"));
  assert.ok(!billing.includes("WALLET_TOPUP_SOL_PRICE_USD"));
});

test("the gate, the network and the mint follow the settings", () => {
  withEnv({ WALLET_TOPUPS_ENABLED: true, SOLANA_NETWORK: "devnet" }, () => {
    const deps = buildProductionWalletTopupDeps();
    assert.equal(deps.enabled, true);
    assert.equal(deps.network, "devnet");
    assert.equal(deps.usdcMint, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  });
  withEnv({ WALLET_TOPUPS_ENABLED: false, SOLANA_NETWORK: "mainnet-beta" }, () => {
    const deps = buildProductionWalletTopupDeps();
    assert.equal(deps.enabled, false);
    assert.equal(deps.usdcMint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });
});

test("the platform's own addresses are the organization's deposit address and the payout wallet", () => {
  const masterKey = "unit-test-master-key-".padEnd(40, "x");
  withEnv({ WALLET_MASTER_KEY: masterKey }, () => {
    const deps = buildProductionWalletTopupDeps();
    const deposit = deriveTopupDepositKeypair({ masterKey, orgId: "org_1" }).publicKey.toBase58();
    const payout = derivePayoutKeypair(masterKey).publicKey.toBase58();
    assert.equal(deps.deriveDepositAddress("org_1"), deposit);
    assert.deepEqual(deps.platformAddresses("org_1"), [deposit, payout]);
    assert.notEqual(deps.deriveDepositAddress("org_2"), deposit);
  });
});

test("the production deps carry everything the routes ask for", () => {
  const deps = buildProductionWalletTopupDeps();
  for (const name of [
    "deriveDepositAddress",
    "platformAddresses",
    "ensureCluster",
    "getSolQuote",
    "solMarginBps",
    "readPayerBalances",
    "getLatestBlockhash",
    "createTopup",
    "findTopup",
    "listTopups",
    "claimForSubmit",
    "markStatus",
    "expireStalePrepared",
    "sendRawTransaction",
    "waitForConfirmation",
    "readSignatureFate",
    "creditTopup",
    "readBalanceCents",
  ] as const) {
    assert.equal(typeof deps[name], "function", name);
  }
});
