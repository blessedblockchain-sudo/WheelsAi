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

// Drives apps/api/src/services/buildTokenIndexerOuterTickDeps.ts — the
// composition root that wires the cursor-based indexer into production
// (plan D7), exercised end-to-end through runTokenIndexerOuterTick.
//
// Covers the wiring the queue relies on:
//   - per-token Postgres cursor load (null → epoch) and persist
//     (newest fetched trade timestamp, written only after trades commit)
//   - pagination bound passed through to the trade fetch
//   - trades persisted via createMany skipDuplicates
//   - legacy behaviors preserved per token: stats refresh, graduation
//     check (BONDING only), price-chart snapshot
//   - per-token failure isolation with the failure counter

interface FakeTokenRow {
  id: string;
  mintAddress: string;
  status: "BONDING" | "GRADUATED";
  tradeIndexCursor: Date | null;
}

interface RawTrade {
  txSignature: string;
  traderAddress: string;
  side: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  priceUsd: number;
  timestamp: string;
}

function trade(sig: string, timestamp: string): RawTrade {
  return {
    txSignature: sig,
    traderAddress: "Trader1",
    side: "buy",
    solAmount: 1,
    tokenAmount: 100,
    priceUsd: 0.01,
    timestamp,
  };
}

const tokenInfo = (overrides: Record<string, unknown> = {}) => ({
  mintAddress: "Mint1",
  name: "Tok",
  symbol: "TOK",
  description: "",
  priceUsd: 0.02,
  marketCapUsd: 20_000,
  volume24h: 500,
  holders: 12,
  bondingCurveProgress: 40,
  isGraduated: false,
  createdAt: "2026-06-01T00:00:00Z",
  ...overrides,
});

function makePrismaStub(tokens: FakeTokenRow[]) {
  const log: Array<{ op: string; args: unknown }> = [];
  const cursorWrites: Array<{ id: string; cursor: Date }> = [];

  const txDelegate = {
    agentTokenHolder: {
      deleteMany: async (args: unknown) => {
        log.push({ op: "holder.deleteMany", args });
        return { count: 0 };
      },
      createMany: async (args: unknown) => {
        log.push({ op: "holder.createMany", args });
        return { count: 1 };
      },
    },
  };

  const prisma = {
    agentToken: {
      findMany: async (args: unknown) => {
        log.push({ op: "agentToken.findMany", args });
        return tokens;
      },
      updateMany: async (args: {
        where: { id: string };
        data: { tradeIndexCursor: Date };
      }) => {
        log.push({ op: "agentToken.updateMany", args });
        cursorWrites.push({
          id: args.where.id,
          cursor: args.data.tradeIndexCursor,
        });
        return { count: 1 };
      },
    },
    agentTokenTrade: {
      createMany: async (args: { data: unknown[]; skipDuplicates: boolean }) => {
        log.push({ op: "trade.createMany", args });
        return { count: args.data.length };
      },
      findMany: async (args: unknown) => {
        log.push({ op: "trade.findMany", args });
        return [];
      },
    },
    agentTokenHolder: txDelegate.agentTokenHolder,
    $transaction: async <T>(work: (tx: unknown) => Promise<T>) => work(txDelegate),
  };

  return { prisma, log, cursorWrites };
}

function makeStatsRecorder(info: ReturnType<typeof tokenInfo> | null = tokenInfo()) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  return {
    calls,
    stats: {
      getTokenInfo: async (...args: unknown[]) => {
        calls.push({ op: "getTokenInfo", args });
        return info as never;
      },
      updateTokenStats: async (...args: unknown[]) => {
        calls.push({ op: "updateTokenStats", args });
      },
      graduateToken: async (...args: unknown[]) => {
        calls.push({ op: "graduateToken", args });
      },
      createSnapshot: async (...args: unknown[]) => {
        calls.push({ op: "createSnapshot", args });
      },
    },
  };
}

const NOW = new Date("2026-06-12T12:00:00Z");

async function buildAndRun(opts: {
  tokens: FakeTokenRow[];
  pages?: Record<string, RawTrade[][]>; // mintAddress → pages
  getTradesPage?: (mint: string, limit: number, offset: number) => Promise<RawTrade[]>;
  stats?: ReturnType<typeof makeStatsRecorder>;
  maxPagesPerToken?: number;
}) {
  setupEnv();
  const { buildTokenIndexerOuterTickDeps } = await import(
    "../services/buildTokenIndexerOuterTickDeps.js"
  );
  const { runTokenIndexerOuterTick } = await import(
    "../services/runTokenIndexerOuterTick.js"
  );

  const stub = makePrismaStub(opts.tokens);
  const statsRec = opts.stats ?? makeStatsRecorder();
  const pageCalls: Array<{ mint: string; limit: number; offset: number }> = [];

  const getTradesPage =
    opts.getTradesPage ??
    (async (mint: string, limit: number, offset: number) => {
      pageCalls.push({ mint, limit, offset });
      const pages = opts.pages?.[mint] ?? [[]];
      return pages[offset / limit] ?? [];
    });

  const deps = buildTokenIndexerOuterTickDeps({
    prisma: stub.prisma as never,
    getTradesPage: getTradesPage as never,
    stats: statsRec.stats as never,
    maxPagesPerToken: opts.maxPagesPerToken,
    now: () => NOW,
  });

  const result = await runTokenIndexerOuterTick({ now: NOW }, deps);
  return { result, stub, statsRec, pageCalls };
}

const bondingToken = (overrides: Partial<FakeTokenRow> = {}): FakeTokenRow => ({
  id: "tok_1",
  mintAddress: "Mint1",
  status: "BONDING",
  tradeIndexCursor: null,
  ...overrides,
});

// ============================================
// Cursor load: null → epoch, value → that value
// ============================================

test("outer deps: null cursor fetches from epoch (full history on first index)", async () => {
  const { pageCalls, stub } = await buildAndRun({
    tokens: [bondingToken({ tradeIndexCursor: null })],
    pages: { Mint1: [[trade("s1", "2026-06-12T11:00:00Z")]] },
  });
  // The fetch ran (one page call) — with since=epoch nothing is filtered.
  assert.equal(pageCalls.length, 1);
  const persisted = stub.log.find((l) => l.op === "trade.createMany");
  assert.ok(persisted, "trades were persisted");
});

test("outer deps: existing cursor filters already-indexed trades", async () => {
  const cursor = new Date("2026-06-12T11:00:00Z");
  const { stub } = await buildAndRun({
    tokens: [bondingToken({ tradeIndexCursor: cursor })],
    pages: {
      Mint1: [
        [
          trade("new", "2026-06-12T11:30:00Z"),
          trade("already-indexed", "2026-06-12T11:00:00Z"),
        ],
      ],
    },
  });
  const persisted = stub.log.find((l) => l.op === "trade.createMany") as
    | { args: { data: Array<{ txSignature: string }> } }
    | undefined;
  assert.deepEqual(
    persisted!.args.data.map((d) => d.txSignature),
    ["new"],
  );
});

// ============================================
// Cursor persist: newest fetched timestamp, only when trades arrived
// ============================================

test("outer deps: persists the newest fetched trade timestamp as the new cursor", async () => {
  const { stub } = await buildAndRun({
    tokens: [bondingToken()],
    pages: {
      Mint1: [
        [
          trade("newest", "2026-06-12T11:45:00Z"),
          trade("mid", "2026-06-12T11:30:00Z"),
          trade("oldest", "2026-06-12T11:15:00Z"),
        ],
      ],
    },
  });
  assert.equal(stub.cursorWrites.length, 1);
  assert.equal(stub.cursorWrites[0]!.id, "tok_1");
  assert.equal(
    stub.cursorWrites[0]!.cursor.toISOString(),
    "2026-06-12T11:45:00.000Z",
  );
  // Ordering invariant: the cursor write happens AFTER the trades are
  // persisted — advancing first would lose the window on a crash.
  const ops = stub.log.map((l) => l.op);
  assert.ok(
    ops.indexOf("trade.createMany") < ops.indexOf("agentToken.updateMany"),
    `cursor write must follow trade persist (got ${ops.join(",")})`,
  );
});

test("outer deps: no new trades → cursor untouched", async () => {
  const { stub, result } = await buildAndRun({
    tokens: [bondingToken({ tradeIndexCursor: new Date("2026-06-12T11:00:00Z") })],
    pages: { Mint1: [[]] },
  });
  assert.equal(stub.cursorWrites.length, 0);
  assert.equal(result.processed, 1);
});

// ============================================
// Pagination bound passes through
// ============================================

test("outer deps: maxPagesPerToken bounds the per-token pagination", async () => {
  // Full pages forever, all newer than the (epoch) cursor.
  let calls = 0;
  const { result } = await buildAndRun({
    tokens: [bondingToken()],
    maxPagesPerToken: 3,
    getTradesPage: async (_mint, limit, offset) => {
      calls += 1;
      // Page of exactly `limit` rows, strictly newer than epoch and
      // unique per page.
      return Array.from({ length: limit }, (_, i) =>
        trade(`p${offset}_${i}`, new Date(2026, 5, 12, 10, 0, offset + i).toISOString()),
      );
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.processed, 1);
});

// ============================================
// Legacy behaviors preserved (the old tokenIndexer.ts tick)
// ============================================

test("outer deps: stats refresh + price snapshot run per token after trade indexing", async () => {
  const statsRec = makeStatsRecorder(tokenInfo());
  await buildAndRun({
    tokens: [bondingToken()],
    pages: { Mint1: [[trade("s1", "2026-06-12T11:00:00Z")]] },
    stats: statsRec,
  });
  const ops = statsRec.calls.map((c) => c.op);
  assert.deepEqual(ops, ["getTokenInfo", "updateTokenStats", "createSnapshot"]);
  const update = statsRec.calls.find((c) => c.op === "updateTokenStats")!;
  assert.equal(update.args[0], "tok_1");
  assert.deepEqual(update.args[1], {
    priceUsd: 0.02,
    marketCapUsd: 20_000,
    volume24h: 500,
    holders: 12,
  });
});

test("outer deps: BONDING token with graduated info triggers graduateToken", async () => {
  const statsRec = makeStatsRecorder(
    tokenInfo({ isGraduated: true, raydiumPoolId: "Pool1" }),
  );
  await buildAndRun({
    tokens: [bondingToken({ status: "BONDING" })],
    pages: { Mint1: [[]] },
    stats: statsRec,
  });
  const grad = statsRec.calls.find((c) => c.op === "graduateToken");
  assert.ok(grad, "graduateToken invoked");
  assert.deepEqual(grad!.args, ["tok_1", "Pool1"]);
});

test("outer deps: GRADUATED token never re-graduates (lockup would reset)", async () => {
  const statsRec = makeStatsRecorder(
    tokenInfo({ isGraduated: true, raydiumPoolId: "Pool1" }),
  );
  await buildAndRun({
    tokens: [bondingToken({ status: "GRADUATED" })],
    pages: { Mint1: [[]] },
    stats: statsRec,
  });
  assert.equal(
    statsRec.calls.filter((c) => c.op === "graduateToken").length,
    0,
  );
});

test("outer deps: getTokenInfo null (upstream down) skips stats trio without failing the token", async () => {
  const statsRec = makeStatsRecorder(null);
  const { result } = await buildAndRun({
    tokens: [bondingToken()],
    pages: { Mint1: [[trade("s1", "2026-06-12T11:00:00Z")]] },
    stats: statsRec,
  });
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(
    statsRec.calls.map((c) => c.op),
    ["getTokenInfo"], // trio skipped
  );
});

// ============================================
// Per-token failure isolation through the real composition
// ============================================

test("outer deps: one token's upstream throw doesn't stop the others; cursor untouched for the failed one", async () => {
  const { result, stub } = await buildAndRun({
    tokens: [
      bondingToken({ id: "tok_bad", mintAddress: "MintBad" }),
      bondingToken({ id: "tok_ok", mintAddress: "MintOk" }),
    ],
    getTradesPage: async (mint) => {
      if (mint === "MintBad") throw new Error("pumpfun 502");
      return [trade("ok1", "2026-06-12T11:00:00Z")];
    },
  });
  assert.equal(result.scanned, 2);
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 1);
  // Only the OK token's cursor advanced.
  assert.deepEqual(
    stub.cursorWrites.map((w) => w.id),
    ["tok_ok"],
  );
});

test("outer deps: trade persist failure fails the token and leaves its cursor untouched", async () => {
  setupEnv();
  const { buildTokenIndexerOuterTickDeps } = await import(
    "../services/buildTokenIndexerOuterTickDeps.js"
  );
  const { runTokenIndexerOuterTick } = await import(
    "../services/runTokenIndexerOuterTick.js"
  );

  const stub = makePrismaStub([bondingToken()]);
  stub.prisma.agentTokenTrade.createMany = async () => {
    throw new Error("db down");
  };
  const statsRec = makeStatsRecorder();

  const deps = buildTokenIndexerOuterTickDeps({
    prisma: stub.prisma as never,
    getTradesPage: (async () => [trade("s1", "2026-06-12T11:00:00Z")]) as never,
    stats: statsRec.stats as never,
    now: () => NOW,
  });
  const result = await runTokenIndexerOuterTick({ now: NOW }, deps);

  assert.equal(result.failed, 1);
  assert.equal(stub.cursorWrites.length, 0); // cursor NOT advanced past unpersisted trades
  assert.equal(statsRec.calls.length, 0); // legacy trio not reached
});
