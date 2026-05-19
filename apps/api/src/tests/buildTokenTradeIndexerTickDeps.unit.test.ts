import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/buildTokenTradeIndexerTickDeps.ts —
// dep-wiring for runTokenTradeIndexerTick.
//
// Composes:
//   fetchTrades              (injected — pump.fun side-effect)
//   persistAgentTokenTrades  (Prisma)  → persistTrades
//   loadAllAgentTokenTrades  (Prisma)  → loadAllTrades
//   persistHolderSnapshot    (Prisma)  → persistHolderSnapshot
//
// One tick = one call against ONE token. The BullMQ wrapper iterates
// over active tokens and calls the tick per token.

interface FetchTradesArgs {
  mintAddress: string;
  since: Date;
}

function makePrismaStub() {
  const log: any[] = [];
  return {
    log,
    prisma: {
      agentTokenTrade: {
        async createMany(args: any) {
          log.push({ type: "trade.createMany", args });
          return { count: args.data.length };
        },
        async findMany(args: any) {
          log.push({ type: "trade.findMany", args });
          return [];
        },
      },
      agentTokenHolder: {
        async deleteMany(args: any) {
          log.push({ type: "holder.deleteMany", args });
          return { count: 0 };
        },
        async createMany(args: any) {
          log.push({ type: "holder.createMany", args });
          return { count: args.data.length };
        },
      },
      async $transaction(work: any) {
        log.push({ type: "transaction" });
        return await work({
          agentTokenHolder: this.agentTokenHolder,
        });
      },
    },
  };
}

// ============================================
// Build shape
// ============================================

test("buildTokenTradeIndexerTickDeps returns the four required dep keys", async () => {
  setupEnv();
  const { buildTokenTradeIndexerTickDeps } = await import(
    "../services/buildTokenTradeIndexerTickDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildTokenTradeIndexerTickDeps({
    prisma: stub.prisma as any,
    tokenId: "tok_1",
    fetchTrades: async () => [],
  });
  for (const key of [
    "fetchTrades",
    "persistTrades",
    "loadAllTrades",
    "persistHolderSnapshot",
  ]) {
    assert.ok(key in deps, `expected dep key "${key}"`);
  }
});

// ============================================
// fetchTrades is forwarded
// ============================================

test("buildTokenTradeIndexerTickDeps forwards fetchTrades verbatim", async () => {
  const { buildTokenTradeIndexerTickDeps } = await import(
    "../services/buildTokenTradeIndexerTickDeps.js"
  );
  const stub = makePrismaStub();
  const observed: FetchTradesArgs[] = [];
  const deps = buildTokenTradeIndexerTickDeps({
    prisma: stub.prisma as any,
    tokenId: "tok_1",
    fetchTrades: async (mintAddress, since) => {
      observed.push({ mintAddress, since });
      return [];
    },
  });
  const since = new Date("2026-04-26T00:00:00Z");
  await deps.fetchTrades("MintAddr", since);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]!.mintAddress, "MintAddr");
  assert.equal(observed[0]!.since.toISOString(), since.toISOString());
});

// ============================================
// persistTrades wires through to persistAgentTokenTrades + binds tokenId
// ============================================

test("buildTokenTradeIndexerTickDeps persistTrades stamps tokenId from input", async () => {
  // The indexer's contract (rows: IndexerTradeRow[]) — no tokenId per
  // row. The dep-builder closes over tokenId from input.
  const { buildTokenTradeIndexerTickDeps } = await import(
    "../services/buildTokenTradeIndexerTickDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildTokenTradeIndexerTickDeps({
    prisma: stub.prisma as any,
    tokenId: "tok_xyz",
    fetchTrades: async () => [],
  });
  await deps.persistTrades([
    {
      txSignature: "sig_a",
      traderAddress: "Alice",
      side: "buy",
      tokenAmount: 1_000,
      solAmount: 0.5,
      priceUsd: 0.001,
      timestamp: new Date("2026-04-26T12:00:00Z"),
    },
  ]);
  const calls = stub.log.filter((c) => c.type === "trade.createMany");
  assert.equal(calls.length, 1);
  for (const row of calls[0]!.args.data) {
    assert.equal(row.tokenId, "tok_xyz");
  }
});

test("buildTokenTradeIndexerTickDeps persistTrades returns inserted-count from createMany", async () => {
  const { buildTokenTradeIndexerTickDeps } = await import(
    "../services/buildTokenTradeIndexerTickDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildTokenTradeIndexerTickDeps({
    prisma: stub.prisma as any,
    tokenId: "tok_1",
    fetchTrades: async () => [],
  });
  const result = await deps.persistTrades([
    {
      txSignature: "sig_a",
      traderAddress: "Alice",
      side: "buy",
      tokenAmount: 1_000,
      solAmount: 0.5,
      priceUsd: 0.001,
      timestamp: new Date(),
    },
  ]);
  assert.equal(result.inserted, 1);
});

// ============================================
// loadAllTrades wires through to loadAllAgentTokenTrades
// ============================================

test("buildTokenTradeIndexerTickDeps loadAllTrades scopes findMany by the runtime tokenId", async () => {
  // The indexer passes tokenId at call-time (input.token.id). The
  // dep-builder MUST forward that argument, not the build-time tokenId
  // — agent A's tick must not load agent B's history.
  const { buildTokenTradeIndexerTickDeps } = await import(
    "../services/buildTokenTradeIndexerTickDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildTokenTradeIndexerTickDeps({
    prisma: stub.prisma as any,
    tokenId: "tok_1",
    fetchTrades: async () => [],
  });
  await deps.loadAllTrades("tok_runtime");
  const calls = stub.log.filter((c) => c.type === "trade.findMany");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.args.where.tokenId, "tok_runtime");
});

// ============================================
// persistHolderSnapshot wires through with $transaction
// ============================================

test("buildTokenTradeIndexerTickDeps persistHolderSnapshot wraps writes in a $transaction", async () => {
  const { buildTokenTradeIndexerTickDeps } = await import(
    "../services/buildTokenTradeIndexerTickDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildTokenTradeIndexerTickDeps({
    prisma: stub.prisma as any,
    tokenId: "tok_1",
    fetchTrades: async () => [],
  });
  await deps.persistHolderSnapshot({
    tokenId: "tok_1",
    holders: [{ walletAddress: "Alice", balance: 100, percentage: 100 }],
    totalBalance: 100,
  });
  const types = stub.log.map((c) => c.type);
  // Order matters: transaction wraps deleteMany + createMany.
  assert.equal(types[0], "transaction");
  assert.ok(types.includes("holder.deleteMany"));
  assert.ok(types.includes("holder.createMany"));
});

// ============================================
// End-to-end: feed built deps into the actual tick
// ============================================

test("buildTokenTradeIndexerTickDeps result drives runTokenTradeIndexerTick on an empty page", async () => {
  // The tick early-returns when fetchTrades produces nothing.
  const { buildTokenTradeIndexerTickDeps } = await import(
    "../services/buildTokenTradeIndexerTickDeps.js"
  );
  const { runTokenTradeIndexerTick } = await import(
    "../services/tokenTradeIndexer.js"
  );
  const stub = makePrismaStub();
  const deps = buildTokenTradeIndexerTickDeps({
    prisma: stub.prisma as any,
    tokenId: "tok_1",
    fetchTrades: async () => [],
  });
  const result = await runTokenTradeIndexerTick(
    {
      token: { id: "tok_1", mintAddress: "MintAddr" },
      since: new Date("2026-04-26T00:00:00Z"),
      now: new Date("2026-04-26T01:00:00Z"),
    },
    deps,
  );
  assert.equal(result.inserted, 0);
  assert.equal(result.holderCount, 0);
});
