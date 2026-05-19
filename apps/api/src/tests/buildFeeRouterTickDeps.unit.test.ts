/**
 * Drives apps/api/src/services/buildFeeRouterTickDeps.ts —
 * the full dep-wiring closure for the fee-router BullMQ worker.
 *
 * Composes:
 *   loadUnroutedFeesByPrisma     → loadUnrouted
 *   submitFeeReceive + RPC       → submit
 *   persistFeeRouterCursor       → persistCursor
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";

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

function makePrismaStub(opts: {
  treasuries?: any[];
  trades?: any[];
  updateMatchCount?: number;
}) {
  const log: any[] = [];
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
      agentTokenTrade: {
        async findMany(args: any) {
          log.push({ type: "trades.findMany", args });
          return (opts.trades ?? []).filter((t) => {
            if (args.where?.tokenId && t.tokenId !== args.where.tokenId) return false;
            if (
              args.where?.timestamp?.gt &&
              t.timestamp <= args.where.timestamp.gt
            )
              return false;
            return true;
          });
        },
      },
    },
  };
}

function makeConnectionStub() {
  const log: any[] = [];
  return {
    log,
    connection: {
      async getLatestBlockhash() {
        log.push({ type: "getLatestBlockhash" });
        return { blockhash: VALID_BLOCKHASH, lastValidBlockHeight: 100 };
      },
      async sendRawTransaction(raw: Uint8Array) {
        log.push({ type: "sendRawTransaction", rawLength: raw.length });
        return "FEE_SIG_FROM_STUB";
      },
    },
  };
}

// ============================================
// Build shape
// ============================================

test("buildFeeRouterTickDeps returns the three driver-shape keys", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildFeeRouterTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    routerKeypair: fromKeypair,
  });
  for (const key of ["loadUnrouted", "submit", "persistCursor"]) {
    assert.ok(key in deps, `expected dep key "${key}"`);
  }
});

// ============================================
// loadUnrouted wires through to Prisma
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
        lastFeeRoutedAt: null,
        token: { id: "tok_a", mintAddress: "MintA" },
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
  const deps = buildFeeRouterTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    routerKeypair: fromKeypair,
  });

  const rows = await deps.loadUnrouted({ now: new Date() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.treasuryId, "treas_a");
  // 2 SOL × 0.01 = 0.02 SOL = 20_000_000 lamports
  assert.equal(rows[0]!.feeAmountLamports, 20_000_000n);
});

// ============================================
// submit wires through to RPC and signs with router keypair
// ============================================

test("buildFeeRouterTickDeps submit returns ok+sig on success", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildFeeRouterTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    routerKeypair: fromKeypair,
  });

  const outcome = await deps.submit({
    treasuryId: "treas_a",
    mintAddress: new PublicKey("So11111111111111111111111111111111111111112").toBase58(),
    feeAmountLamports: 1_000_000n,
    latestTradeTimestamp: new Date(),
  });

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.txSignature, "FEE_SIG_FROM_STUB");
  assert.ok(conn.log.some((c) => c.type === "getLatestBlockhash"));
  assert.ok(conn.log.some((c) => c.type === "sendRawTransaction"));
});

test("buildFeeRouterTickDeps submit returns ok=false on RPC failure", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = {
    async getLatestBlockhash() {
      throw new Error("blockhash_unavailable");
    },
    async sendRawTransaction() {
      return "";
    },
  };
  const deps = buildFeeRouterTickDeps({
    prisma: stub.prisma as any,
    connection: conn as any,
    routerKeypair: fromKeypair,
  });

  const outcome = await deps.submit({
    treasuryId: "treas_a",
    mintAddress: new PublicKey("So11111111111111111111111111111111111111112").toBase58(),
    feeAmountLamports: 1n,
    latestTradeTimestamp: new Date(),
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.error, /blockhash_unavailable/);
});

// ============================================
// persistCursor wires through to Prisma updateMany
// ============================================

test("buildFeeRouterTickDeps persistCursor wires to updateMany with progression guard", async () => {
  setupEnv();
  const { buildFeeRouterTickDeps } = await import(
    "../services/buildFeeRouterTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildFeeRouterTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    routerKeypair: fromKeypair,
  });
  const ts = new Date("2026-04-26T12:00:00Z");
  await deps.persistCursor("treas_a", ts);
  const update = stub.log.find((c) => c.type === "treasuries.updateMany");
  assert.equal(update.args.where.id, "treas_a");
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
  const deps = buildFeeRouterTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    routerKeypair: fromKeypair,
  });
  const result = await runFeeRouterTick({ now: new Date() }, deps);
  assert.deepEqual(result, { routed: 0, failed: 0 });
});
