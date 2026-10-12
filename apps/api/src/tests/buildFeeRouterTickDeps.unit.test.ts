/**
 * Drives apps/api/src/services/buildFeeRouterTickDeps.ts —
 * the full dep-wiring closure for the fee-router BullMQ worker
 * (row-identity routing + confirmation discipline, remediation D6a).
 *
 * Composes:
 *   loadStaleFeeBatchesByPrisma     → loadStaleBatches
 *   connection.getBlockHeight       → getCurrentBlockHeight
 *   connection.getSignatureStatuses → getSignatureStatus
 *   loadUnroutedFeesByPrisma        → loadUnrouted
 *   claimFeeRoutingBatch            → claimBatch
 *   prepareFeeReceive               → sign (sign-only — NO broadcast)
 *   persistFeeBatchTransition       → markSubmitted / persistBatch{Confirmed,Failed}
 *   connection.sendRawTransaction   → broadcast
 *   persistFeeRouterCursor          → persistCursor (display only)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";

import { solToLamports } from "../lib/tokenUnits.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

const fromKeypair = Keypair.generate();
const VALID_BLOCKHASH = Keypair.generate().publicKey.toBase58();
const MINT = new PublicKey("So11111111111111111111111111111111111111112").toBase58();

function makePrismaStub(opts: {
  treasuries?: any[];
  trades?: any[];
  staleBatches?: any[];
  updateMatchCount?: number;
  batchCasCount?: number;
  stampCount?: (tradeIds: string[]) => number;
}) {
  const log: any[] = [];
  const feeRoutingBatch = {
    async findMany(args: any) {
      log.push({ type: "batches.findMany", args });
      return opts.staleBatches ?? [];
    },
    async create(args: any) {
      log.push({ type: "batches.create", args });
      return { id: "batch_new" };
    },
    async updateMany(args: any) {
      log.push({ type: "batches.updateMany", args });
      return { count: opts.batchCasCount ?? 1 };
    },
  };
  const agentTokenTrade = {
    async findMany(args: any) {
      log.push({ type: "trades.findMany", args });
      return (opts.trades ?? [])
        .filter((t) => {
          if (args.where?.tokenId && t.tokenId !== args.where.tokenId) return false;
          // Row-identity predicate: only unstamped trades qualify.
          if (
            "feeRoutingBatchId" in (args.where ?? {}) &&
            args.where.feeRoutingBatchId === null &&
            (t.feeRoutingBatchId ?? null) !== null
          )
            return false;
          return true;
        })
        // The loader reads the integer solLamports column (D9); derive it
        // from the fixtures' readable SOL value here.
        .map((t) => ({ ...t, solLamports: solToLamports(t.solAmount) }));
    },
    async updateMany(args: any) {
      log.push({ type: "trades.updateMany", args });
      const count = opts.stampCount
        ? opts.stampCount(args.where?.id?.in ?? [])
        : args.where?.id?.in?.length ?? 1;
      return { count };
    },
  };
  return {
    log,
    prisma: {
      agentTreasury: {
        async findMany(args: any) {
          log.push({ type: "treasuries.findMany", args });
          return opts.treasuries ?? [];
        },
        async updateMany(args: any) {
          log.push({ type: "treasuries.updateMany", args });
          return { count: opts.updateMatchCount ?? 1 };
        },
      },
      agentTokenTrade,
      feeRoutingBatch,
      $transaction: async (fn: any) =>
        fn({ feeRoutingBatch, agentTokenTrade }),
    },
  };
}

function makeConnectionStub(opts: {
  signatureStatusValue?: any;
  blockHeight?: number;
  getLatestBlockhashThrows?: boolean;
} = {}) {
  const log: any[] = [];
  return {
    log,
    connection: {
      async getLatestBlockhash() {
        log.push({ type: "getLatestBlockhash" });
        if (opts.getLatestBlockhashThrows) throw new Error("rpc down");
        return { blockhash: VALID_BLOCKHASH, lastValidBlockHeight: 100 };
      },
      async sendRawTransaction(raw: Uint8Array) {
        log.push({ type: "sendRawTransaction", raw });
        return "FEE_SIG_FROM_STUB";
      },
      async getSignatureStatuses(sigs: string[], cfg: any) {
        log.push({ type: "getSignatureStatuses", sigs, cfg });
        return { value: [opts.signatureStatusValue ?? null] };
      },
      async getBlockHeight(commitment: string) {
        log.push({ type: "getBlockHeight", commitment });
        return opts.blockHeight ?? 1234;
      },
    },
  };
}

function buildDeps(stub: ReturnType<typeof makePrismaStub>, conn: any, extra: any = {}) {
  return {
    prisma: stub.prisma as any,
    connection: conn as any,
    routerKeypair: fromKeypair,
    ...extra,
  };
}

// ============================================
// Build shape
// ============================================

test("buildFeeRouterTickDeps returns every driver-shape key", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildFeeRouterTickDeps(buildDeps(stub, conn.connection));
  for (const key of [
    "loadStaleBatches",
    "getCurrentBlockHeight",
    "getSignatureStatus",
    "broadcast",
    "persistBatchConfirmed",
    "persistBatchFailed",
    "loadUnrouted",
    "claimBatch",
    "sign",
    "markSubmitted",
    "confirmSignature",
    "persistCursor",
  ]) {
    assert.ok(key in deps, `expected dep key "${key}"`);
  }
});

// ============================================
// loadUnrouted wires through to Prisma (row identity, 1% math pinned)
// ============================================

test("buildFeeRouterTickDeps loadUnrouted aggregates fee per treasury", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({
    treasuries: [
      {
        id: "treas_a",
        programInitialized: true,
        token: { id: "tok_a", mintAddress: "MintA", launchpad: "pumpfun" },
      },
    ],
    trades: [
      {
        id: "t1",
        tokenId: "tok_a",
        solAmount: 2,
        timestamp: new Date("2026-04-26T11:30:00Z"),
      },
    ],
  });
  const conn = makeConnectionStub();
  const deps = buildFeeRouterTickDeps(buildDeps(stub, conn.connection));

  const rows = await deps.loadUnrouted({ now: new Date() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.treasuryId, "treas_a");
  // 2 SOL × 0.01 = 0.02 SOL = 20_000_000 lamports — UNCHANGED math.
  assert.equal(rows[0]!.feeAmountLamports, 20_000_000n);
  // Row identity: the loader hands the claimed trade ids through.
  assert.deepEqual(rows[0]!.tradeIds, ["t1"]);
});

// ============================================
// sign wires through prepareFeeReceive — sign-only, NO broadcast
// ============================================

test("buildFeeRouterTickDeps sign produces a signed artifact WITHOUT broadcasting", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildFeeRouterTickDeps(buildDeps(stub, conn.connection));

  const artifact = await deps.sign({
    treasuryId: "treas_a",
    mintAddress: MINT,
    tradeIds: ["t1"],
    feeAmountLamports: 1_000_000n,
    latestTradeTimestamp: new Date(),
  });

  assert.ok(artifact.txSignature.length > 0);
  assert.equal(artifact.lastValidBlockHeight, 100n);
  // The artifact is a decodable transaction blob.
  assert.ok(Buffer.from(artifact.signedTxB64, "base64").length > 0);
  assert.ok(conn.log.some((c) => c.type === "getLatestBlockhash"));
  assert.equal(
    conn.log.filter((c) => c.type === "sendRawTransaction").length,
    0,
    "sign must NEVER broadcast — markSubmitted persists the artifact first",
  );
});

test("buildFeeRouterTickDeps sign rejects on blockhash failure (driver FAILs the batch)", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub({ getLatestBlockhashThrows: true });
  const deps = buildFeeRouterTickDeps(buildDeps(stub, conn.connection));

  await assert.rejects(
    () =>
      deps.sign({
        treasuryId: "treas_a",
        mintAddress: MINT,
        tradeIds: ["t1"],
        feeAmountLamports: 1n,
        latestTradeTimestamp: new Date(),
      }),
    /blockhash_unavailable/,
  );
});

// ============================================
// broadcast / RPC evidence wiring
// ============================================

test("buildFeeRouterTickDeps broadcast decodes base64 and hits sendRawTransaction", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildFeeRouterTickDeps(buildDeps(stub, conn.connection));
  await deps.broadcast(Buffer.from("exact bytes").toString("base64"));
  const sent = conn.log.find((c) => c.type === "sendRawTransaction");
  assert.ok(sent);
  assert.equal(Buffer.from(sent.raw).toString(), "exact bytes");
});

test("buildFeeRouterTickDeps getCurrentBlockHeight/getSignatureStatus wire the evidence RPCs", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub({
    blockHeight: 777,
    signatureStatusValue: { confirmationStatus: "confirmed", err: null },
  });
  const deps = buildFeeRouterTickDeps(buildDeps(stub, conn.connection));

  assert.equal(await deps.getCurrentBlockHeight(), 777n);
  const head = conn.log.find((c) => c.type === "getBlockHeight");
  assert.equal(head.commitment, "confirmed");

  const status = await deps.getSignatureStatus("sig_x");
  assert.deepEqual(status, { confirmationStatus: "confirmed", err: null });
  const query = conn.log.find((c) => c.type === "getSignatureStatuses");
  assert.deepEqual(query.sigs, ["sig_x"]);
  // Recovery must see dropped-but-old signatures too.
  assert.equal(query.cfg.searchTransactionHistory, true);
});

test("buildFeeRouterTickDeps getSignatureStatus maps a null RPC value to null (unseen)", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub({ signatureStatusValue: null });
  const deps = buildFeeRouterTickDeps(buildDeps(stub, conn.connection));
  assert.equal(await deps.getSignatureStatus("sig_unseen"), null);
});

// ============================================
// claimBatch / markSubmitted / transitions wiring
// ============================================

test("buildFeeRouterTickDeps claimBatch creates the CLAIMED batch and stamps trades in one transaction", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildFeeRouterTickDeps(buildDeps(stub, conn.connection));

  const batchId = await deps.claimBatch({
    treasuryId: "treas_a",
    mintAddress: MINT,
    tradeIds: ["t1", "t2"],
    feeAmountLamports: 20_000_000n,
    latestTradeTimestamp: new Date(),
  });
  assert.equal(batchId, "batch_new");

  const create = stub.log.find((c) => c.type === "batches.create");
  assert.deepEqual(create.args.data, {
    treasuryId: "treas_a",
    status: "CLAIMED",
    lamports: 20_000_000n,
    tradeCount: 2,
  });
  const stamp = stub.log.find((c) => c.type === "trades.updateMany");
  assert.deepEqual(stamp.args.where, {
    id: { in: ["t1", "t2"] },
    feeRoutingBatchId: null,
  });
});

test("buildFeeRouterTickDeps claimBatch returns null on a short stamp count (lost race)", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({ stampCount: () => 1 }); // 1 of 2
  const conn = makeConnectionStub();
  const deps = buildFeeRouterTickDeps(buildDeps(stub, conn.connection));
  const batchId = await deps.claimBatch({
    treasuryId: "treas_a",
    mintAddress: MINT,
    tradeIds: ["t1", "t2"],
    feeAmountLamports: 20_000_000n,
    latestTradeTimestamp: new Date(),
  });
  assert.equal(batchId, null);
});

test("buildFeeRouterTickDeps markSubmitted persists the artifact via the CLAIMED→SUBMITTED CAS", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildFeeRouterTickDeps(buildDeps(stub, conn.connection));
  const ok = await deps.markSubmitted("batch_1", {
    txSignature: "sig_abc",
    lastValidBlockHeight: 900n,
    signedTxB64: "Ynl0ZXM=",
  });
  assert.equal(ok, true);
  const cas = stub.log.find((c) => c.type === "batches.updateMany");
  assert.deepEqual(cas.args.where, { id: "batch_1", status: "CLAIMED" });
  assert.deepEqual(cas.args.data, {
    status: "SUBMITTED",
    txSignature: "sig_abc",
    lastValidBlockHeight: 900n,
    signedTxB64: "Ynl0ZXM=",
  });
});

test("buildFeeRouterTickDeps persistBatchConfirmed/Failed wire the CAS transitions", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildFeeRouterTickDeps(buildDeps(stub, conn.connection));

  await deps.persistBatchConfirmed("batch_1");
  const confirmed = stub.log.find((c) => c.type === "batches.updateMany");
  assert.deepEqual(confirmed.args.where, { id: "batch_1", status: "SUBMITTED" });
  assert.deepEqual(confirmed.args.data, { status: "CONFIRMED" });

  stub.log.length = 0;
  await deps.persistBatchFailed("batch_2");
  const failed = stub.log.find((c) => c.type === "batches.updateMany");
  assert.deepEqual(failed.args.where, {
    id: "batch_2",
    status: { in: ["CLAIMED", "SUBMITTED"] },
  });
  assert.deepEqual(failed.args.data, { status: "FAILED" });
  // The won CAS un-stamps the batch's trades (they rejoin a later batch).
  const unstamp = stub.log.find((c) => c.type === "trades.updateMany");
  assert.deepEqual(unstamp.args.where, { feeRoutingBatchId: "batch_2" });
  assert.deepEqual(unstamp.args.data, { feeRoutingBatchId: null });
});

// ============================================
// loadStaleBatches wiring
// ============================================

test("buildFeeRouterTickDeps loadStaleBatches queries SUBMITTED + aged CLAIMED rows", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const now = new Date("2026-04-26T12:00:00Z");
  const stub = makePrismaStub({
    staleBatches: [
      {
        id: "b1",
        treasuryId: "treas_a",
        status: "SUBMITTED",
        txSignature: "sig",
        lastValidBlockHeight: 900n,
        signedTxB64: "bytes",
      },
    ],
  });
  const conn = makeConnectionStub();
  const deps = buildFeeRouterTickDeps(
    buildDeps(stub, conn.connection, { claimedGraceMs: 60_000 }),
  );
  const rows = await deps.loadStaleBatches({ now });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "b1");

  const query = stub.log.find((c) => c.type === "batches.findMany");
  assert.deepEqual(query.args.where.OR[0], { status: "SUBMITTED" });
  // CLAIMED rows are only reaped past the grace window.
  assert.equal(query.args.where.OR[1].status, "CLAIMED");
  assert.equal(
    query.args.where.OR[1].createdAt.lt.getTime(),
    now.getTime() - 60_000,
  );
});

// ============================================
// persistCursor wires through to Prisma updateMany (display only)
// ============================================

test("buildFeeRouterTickDeps persistCursor wires to updateMany with progression guard", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildFeeRouterTickDeps(buildDeps(stub, conn.connection));
  const ts = new Date("2026-04-26T12:00:00Z");
  await deps.persistCursor("treas_a", ts);
  const update = stub.log.find((c) => c.type === "treasuries.updateMany");
  assert.equal(update.args.where.id, "treas_a");
  assert.deepEqual(update.args.where.OR, [
    { lastFeeRoutedAt: null },
    { lastFeeRoutedAt: { lt: ts } },
  ]);
  assert.deepEqual(update.args.data, { lastFeeRoutedAt: ts });
});

// ============================================
// End-to-end smoke (empty batch)
// ============================================

test("buildFeeRouterTickDeps drives runFeeRouterTick on an empty batch", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildFeeRouterTickDeps(buildDeps(stub, conn.connection));
  const result = await runFeeRouterTick({ now: new Date() }, deps);
  assert.deepEqual(result, {
    recovered: 0,
    routed: 0,
    submitted: 0,
    failed: 0,
    skipped: 0,
  });
});

// ============================================
// End-to-end smoke (one treasury routes to CONFIRMED)
// ============================================

test("buildFeeRouterTickDeps drives a full claim→sign→submit→confirm round trip", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const { runFeeRouterTick } = await import(
    "../services/runFeeRouterTick.js"
  );
  const stub = makePrismaStub({
    treasuries: [
      {
        id: "treas_a",
        programInitialized: true,
        token: { id: "tok_a", mintAddress: MINT, launchpad: "pumpfun" },
      },
    ],
    trades: [
      {
        id: "t1",
        tokenId: "tok_a",
        solAmount: 2,
        timestamp: new Date("2026-04-26T11:30:00Z"),
      },
    ],
  });
  const conn = makeConnectionStub({
    signatureStatusValue: { confirmationStatus: "confirmed", err: null },
  });
  const deps = buildFeeRouterTickDeps(
    buildDeps(stub, conn.connection, { confirmTimeoutMs: 0 }), // single status check
  );
  const result = await runFeeRouterTick({ now: new Date() }, deps);
  assert.deepEqual(result, {
    recovered: 0,
    routed: 1,
    submitted: 0,
    failed: 0,
    skipped: 0,
  });
  // The signed bytes were broadcast and the cursor bumped.
  assert.equal(conn.log.filter((c) => c.type === "sendRawTransaction").length, 1);
  assert.ok(stub.log.some((c) => c.type === "treasuries.updateMany"));
});
