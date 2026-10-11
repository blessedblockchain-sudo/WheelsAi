/**
 * Drives apps/api/src/services/buildDepositScanTickDeps.ts: how the
 * deposit scan is bound to the database and to the node. Stand-ins only.
 *
 * Pinning:
 *   - ONE getMultipleAccountsInfo call at "finalized" covers 50 addresses
 *     and their 50 USDC accounts, and a chunk's scan time is one write;
 *   - the rows are asked for by chain, those whose owner asked first,
 *     then the least recently scanned;
 *   - waiting receipts are asked for by chain, oldest first;
 *   - an account that is not a token account is not an open USDC account;
 *   - progress is written as cursor and balance together;
 *   - the production wiring, and "Check now" while deposits are off.
 */

import "./unitEnv.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PublicKey } from "@solana/web3.js";

import {
  buildDepositScanDeps,
  buildProductionDepositScanDeps,
  checkDepositsNow,
} from "../services/buildDepositScanTickDeps.js";
import {
  DEPOSIT_WATCH_CHUNK,
  runDepositScanTick,
} from "../services/runDepositScanTick.js";
import {
  ORG_1,
  QUOTE_200,
  SYSTEM_PROGRAM,
  USDC_MINT,
  addressRow,
  depositAddressOf,
  makeChain,
  makeDb,
  usdcAccountOf,
} from "./depositStandIn.js";

const NOW = new Date("2026-10-11T09:00:00.000Z");
const HERE = path.dirname(fileURLToPath(import.meta.url));

function setup(init: Parameters<typeof makeDb>[0] = {}) {
  const data = makeDb(init);
  const chain = makeChain();
  const deps = buildDepositScanDeps({
    db: data.db,
    network: "solana:devnet",
    usdcMint: USDC_MINT,
    getConnection: () => chain.connection,
    checkCluster: async () => ({ ok: true }),
    deriveAddress: depositAddressOf,
    getSolQuote: async () => ({ ok: true, quote: QUOTE_200 }),
    solMarginBps: () => 0,
    now: () => NOW,
  });
  return { ...data, chain, deps };
}

test("one call covers 50 addresses and their 50 USDC accounts; a chunk's scan time is one write", async () => {
  assert.equal(DEPOSIT_WATCH_CHUNK, 50);
  const orgs = Array.from({ length: 120 }, (_, i) => `org-${String(i).padStart(3, "0")}`);
  const w = setup({
    addresses: orgs.map((orgId, i) =>
      addressRow(orgId, { lastScannedAt: new Date(NOW.getTime() - (200 - i) * 60_000) }),
    ),
  });
  const res = await runDepositScanTick(
    { enabled: true, intervalMs: 60_000, network: "solana:devnet", maxAddresses: 500, now: () => NOW },
    w.deps,
  );
  assert.equal(res.addressesWatched, 120);
  assert.equal(res.historiesRead, 0);
  const watch = w.chain.calls.getMultipleAccountsInfo;
  assert.deepEqual(watch.map((c) => c.keys.length), [100, 100, 40]);
  assert.ok(watch.every((c) => c.commitment === "finalized"));
  const first = orgs.slice(0, 50).map(depositAddressOf);
  assert.deepEqual(watch[0]!.keys, [...first, ...first.map(usdcAccountOf)]);
  assert.equal(w.chain.calls.getSignaturesForAddress.length, 0);

  const writes = w.calls.filter((c) => c.op === "depositAddress.updateMany");
  assert.equal(writes.length, 3, "one write a chunk");
  assert.deepEqual(writes.map((c) => c.args.where.orgId.in.length), [50, 50, 20]);
  assert.ok(writes.every((c) => c.args.data.lastScannedAt === NOW));
  assert.ok(w.state.addresses.every((r) => r.lastScannedAt === NOW));
});

test("the rows are asked for by chain: those whose owner asked first, then the least recently scanned", async () => {
  const w = setup();
  await w.deps.loadAddresses({ limit: 500 });
  assert.deepEqual(w.calls[0], {
    op: "depositAddress.findMany",
    args: {
      where: { network: "solana:devnet" },
      orderBy: [
        { scanRequestedAt: { sort: "asc", nulls: "last" } },
        { lastScannedAt: { sort: "asc", nulls: "first" } },
      ],
      take: 500,
    },
  });
});

test("waiting receipts are asked for by chain, oldest first, and by organization for a check", async () => {
  const w = setup();
  await w.deps.loadDetected({ limit: 100 });
  await w.deps.loadDetected({ limit: 100, orgId: ORG_1 });
  assert.deepEqual(
    w.calls.map((c) => c.args),
    [
      {
        where: { network: "solana:devnet", status: "detected" },
        orderBy: { createdAt: "asc" },
        take: 100,
      },
      {
        where: { network: "solana:devnet", status: "detected", orgId: ORG_1 },
        orderBy: { createdAt: "asc" },
        take: 100,
      },
    ],
  );
});

test("the watch reads lamports and the USDC account; an account that is not a token account is not open", async () => {
  const w = setup();
  const a = depositAddressOf("org-a");
  const b = depositAddressOf("org-b");
  const c = depositAddressOf("org-c");
  w.chain.setBalance(a, 7_000n, 1_250_000n);
  w.chain.setBalance(b, 5n, null);
  // Something else sits at c's USDC account address.
  w.chain.balances.set(usdcAccountOf(c), { lamports: 1n, usdcRaw: null });
  const targets = [a, b, c].map((address) => ({ address, usdcAccount: usdcAccountOf(address) }));
  assert.deepEqual(await w.deps.watch(targets), [
    { lamports: 7_000n, usdcAccountExists: true, usdcRaw: 1_250_000n },
    { lamports: 5n, usdcAccountExists: false, usdcRaw: 0n },
    { lamports: 0n, usdcAccountExists: false, usdcRaw: 0n },
  ]);
  assert.equal(w.chain.calls.getMultipleAccountsInfo.length, 1);
  assert.equal(SYSTEM_PROGRAM.length, 32);
});

test("a node that does not answer for every account is a failed watch", async () => {
  const w = setup();
  const address = depositAddressOf("org-a");
  const connection = {
    ...w.chain.connection,
    getMultipleAccountsInfo: async () => [null],
  };
  const deps = buildDepositScanDeps({
    db: w.db,
    network: "solana:devnet",
    usdcMint: USDC_MINT,
    getConnection: () => connection as never,
    checkCluster: async () => ({ ok: true }),
    deriveAddress: depositAddressOf,
    getSolQuote: async () => ({ ok: true, quote: QUOTE_200 }),
    solMarginBps: () => 0,
  });
  await assert.rejects(deps.watch([{ address, usdcAccount: usdcAccountOf(address) }]));
});

test("the USDC account is the associated token account of the address for our mint", () => {
  const w = setup();
  const address = depositAddressOf(ORG_1);
  assert.equal(w.deps.usdcAccountOf(address), usdcAccountOf(address));
  assert.equal(w.deps.usdcMint, USDC_MINT.toBase58());
  assert.ok(new PublicKey(w.deps.usdcAccountOf(address)));
});

test("progress is the cursor and the balance its transaction left, written together", async () => {
  const asked = new Date("2026-10-11T08:59:00.000Z");
  const w = setup({ addresses: [addressRow(ORG_1, { scanRequestedAt: asked })] });
  await w.deps.saveProgress({
    orgId: ORG_1,
    sol: { signature: "sig_s", lamports: 9n },
    usdc: { signature: "sig_u", usdcRaw: 4n },
    answeredRequestAt: asked,
    now: NOW,
  });
  const writes = w.calls.filter((c) => c.op === "depositAddress.updateMany").map((c) => c.args);
  assert.deepEqual(writes, [
    {
      where: { orgId: ORG_1 },
      data: {
        lastScannedAt: NOW,
        lastSolSignature: "sig_s",
        lastSeenLamports: 9n,
        lastUsdcSignature: "sig_u",
        lastSeenUsdcRaw: 4n,
      },
    },
    { where: { orgId: ORG_1, scanRequestedAt: asked }, data: { scanRequestedAt: null } },
  ]);

  // Nothing processed: no cursor and no balance is touched.
  const idle = setup({ addresses: [addressRow(ORG_1, { lastSolSignature: "kept", lastSeenLamports: 3n })] });
  await idle.deps.saveProgress({ orgId: ORG_1, answeredRequestAt: null, now: NOW });
  assert.deepEqual(
    idle.calls.filter((c) => c.op === "depositAddress.updateMany").map((c) => c.args.data),
    [{ lastScannedAt: NOW }],
  );
  assert.equal(idle.state.addresses[0]!.lastSolSignature, "kept");
  assert.equal(idle.state.addresses[0]!.lastSeenLamports, 3n);
});

test("the USDC account is recorded as open only while that is unknown", async () => {
  const w = setup({ addresses: [addressRow(ORG_1)] });
  await w.deps.markUsdcAccountOpen({ orgId: ORG_1, now: NOW });
  assert.deepEqual(w.calls.at(-1)!.args, {
    where: { orgId: ORG_1, usdcAccountOpenedAt: null },
    data: { usdcAccountOpenedAt: NOW },
  });
});

test("a known sweep is a chain_transfers row of this chain with that signature", async () => {
  const w = setup({
    chainTransfers: [
      { id: "ct-1", network: "solana:devnet", fromAddress: depositAddressOf(ORG_1), txSignature: "sig_sweep" },
      { id: "ct-2", network: "solana:mainnet", fromAddress: depositAddressOf(ORG_1), txSignature: "sig_mainnet" },
    ],
  });
  assert.equal(await w.deps.isKnownTransfer!("sig_sweep"), true);
  assert.equal(await w.deps.isKnownTransfer!("sig_mainnet"), false);
  assert.equal(await w.deps.isKnownTransfer!("sig_stranger"), false);
  assert.deepEqual(
    w.calls.filter((c) => c.op === "chainTransfer.findUnique").map((c) => c.args),
    [
      { where: { txSignature: "sig_sweep" } },
      { where: { txSignature: "sig_mainnet" } },
      { where: { txSignature: "sig_stranger" } },
    ],
  );
});

test("production: every dependency is bound, and no node is asked to build them", () => {
  const deps = buildProductionDepositScanDeps();
  for (const name of [
    "checkCluster",
    "deriveAddress",
    "usdcAccountOf",
    "loadDetected",
    "loadAddresses",
    "loadAddress",
    "watch",
    "listSignatures",
    "loadTransaction",
    "isKnownTransfer",
    "creditFoundTransfer",
    "creditDetectedReceipt",
    "markWatched",
    "markUsdcAccountOpen",
    "saveProgress",
    "log",
  ] as const) {
    assert.equal(typeof deps[name], "function", name);
  }
  // Tests run on devnet settings.
  assert.equal(deps.usdcMint, USDC_MINT.toBase58());
});

test("check now answers chain_unavailable while deposits are off, without reading anything", async () => {
  // DEPOSITS_ENABLED is off unless set: nothing is read, so this needs
  // no database and no node.
  assert.deepEqual(await checkDepositsNow(ORG_1), { outcome: "chain_unavailable" });
});

test("the binding reads only at finalized, and the queue exports the two names the wiring uses", () => {
  const binding = readFileSync(
    path.join(HERE, "..", "services", "buildDepositScanTickDeps.ts"),
    "utf8",
  );
  assert.ok(!/"confirmed"|"processed"/.test(binding), "no read below finalized");
  const queue = readFileSync(path.join(HERE, "..", "queues", "deposit-scan.queue.ts"), "utf8");
  assert.match(queue, /export async function startDepositScanQueue\(\): Promise<void>/);
  assert.match(queue, /export async function stopDepositScanQueue\(\): Promise<void>/);
  assert.match(queue, /repeat: \{ every: env\.DEPOSIT_SCAN_INTERVAL_MS \}/);
});
