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

// Drives apps/api/src/services/persistAgentTokenTrades.ts — the
// production persistTrades closure for runTokenTradeIndexerTick.
//
// The indexer's contract is `(rows: IndexerTradeRow[]) => { inserted }`,
// where rows have no tokenId — they're raw pump.fun/pumpportal output.
// The production loader takes tokenId via input and stamps it onto each
// row before writing.
//
// Idempotency: ConflictTarget = unique txSignature. createMany with
// skipDuplicates makes the indexer safe to retry against an overlapping
// page (which pumpportal returns by design — paginated by timestamp).

interface IndexerTradeRow {
  txSignature: string;
  traderAddress: string;
  side: "buy" | "sell";
  tokenAmount: number;
  solAmount: number;
  priceUsd: number;
  solLamports: bigint;
  tokenAmountRaw: bigint;
  timestamp: Date;
}

function makePrismaStub(opts: { existingSignatures?: string[] } = {}) {
  const existing = new Set(opts.existingSignatures ?? []);
  const observed: { createManyArgs?: any } = {};
  return {
    observed,
    written: [] as any[],
    prisma: {
      agentTokenTrade: {
        async createMany({ data, skipDuplicates }: any) {
          observed.createManyArgs = { data, skipDuplicates };
          let inserted = 0;
          for (const row of data) {
            if (existing.has(row.txSignature)) continue;
            existing.add(row.txSignature);
            inserted += 1;
          }
          return { count: inserted };
        },
      },
    },
  };
}

const sampleRow = (overrides: Partial<IndexerTradeRow> = {}): IndexerTradeRow => ({
  txSignature: "sig_a",
  traderAddress: "Alice",
  side: "buy",
  tokenAmount: 1_000,
  solAmount: 0.5,
  priceUsd: 0.001,
  solLamports: 500_000_000n, // 0.5 SOL
  tokenAmountRaw: 1_000_000_000n, // 1_000 tokens × 1e6
  timestamp: new Date("2026-04-26T12:00:00Z"),
  ...overrides,
});

// ============================================
// No-op + tokenId
// ============================================

test("persistAgentTokenTrades returns inserted=0 and skips the DB call when rows is empty", async () => {
  setupEnv();
  const { persistAgentTokenTrades } = await import(
    "../services/persistAgentTokenTrades.js"
  );
  const stub = makePrismaStub();
  const result = await persistAgentTokenTrades(
    { tokenId: "tok_1", rows: [] },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(result, { inserted: 0 });
  assert.equal(stub.observed.createManyArgs, undefined);
});

test("persistAgentTokenTrades stamps tokenId onto every row before writing", async () => {
  // The indexer's IndexerTradeRow has no tokenId — the loader is what
  // closes over it. If the stamp drops, we'd get a Prisma null-FK error.
  const { persistAgentTokenTrades } = await import(
    "../services/persistAgentTokenTrades.js"
  );
  const stub = makePrismaStub();
  await persistAgentTokenTrades(
    { tokenId: "tok_1", rows: [sampleRow(), sampleRow({ txSignature: "sig_b" })] },
    { prisma: stub.prisma as any },
  );
  const data = stub.observed.createManyArgs.data;
  assert.equal(data.length, 2);
  for (const row of data) {
    assert.equal(row.tokenId, "tok_1");
  }
});

// ============================================
// Field mapping
// ============================================

test("persistAgentTokenTrades writes the full IndexerTradeRow shape verbatim", async () => {
  const { persistAgentTokenTrades } = await import(
    "../services/persistAgentTokenTrades.js"
  );
  const stub = makePrismaStub();
  const ts = new Date("2026-04-26T12:00:00Z");
  await persistAgentTokenTrades(
    {
      tokenId: "tok_1",
      rows: [
        {
          txSignature: "sig_a",
          traderAddress: "Alice",
          side: "sell",
          tokenAmount: 12345.6789,
          solAmount: 0.42,
          priceUsd: 0.0009,
          solLamports: 420_000_000n,
          tokenAmountRaw: 12_345_678_900n,
          timestamp: ts,
        },
      ],
    },
    { prisma: stub.prisma as any },
  );
  const [row] = stub.observed.createManyArgs.data;
  assert.equal(row.tokenId, "tok_1");
  assert.equal(row.txSignature, "sig_a");
  assert.equal(row.traderAddress, "Alice");
  assert.equal(row.side, "sell");
  assert.equal(row.tokenAmount, 12345.6789);
  assert.equal(row.solAmount, 0.42);
  assert.equal(row.priceUsd, 0.0009);
  // Integer raw units carried verbatim — the money-path source of truth.
  assert.equal(row.solLamports, 420_000_000n);
  assert.equal(row.tokenAmountRaw, 12_345_678_900n);
  assert.equal((row.timestamp as Date).toISOString(), ts.toISOString());
});

test("persistAgentTokenTrades does not leak unrelated keys onto the row", async () => {
  // Defensive: a future IndexerTradeRow may grow fields the schema
  // rejects. The loader should explicitly project the contract, not
  // spread the row object.
  const { persistAgentTokenTrades } = await import(
    "../services/persistAgentTokenTrades.js"
  );
  const stub = makePrismaStub();
  await persistAgentTokenTrades(
    {
      tokenId: "tok_1",
      rows: [{ ...sampleRow(), nonsense: "drop me" } as any],
    },
    { prisma: stub.prisma as any },
  );
  const [row] = stub.observed.createManyArgs.data;
  assert.equal("nonsense" in row, false);
});

// ============================================
// Idempotency / dedup
// ============================================

test("persistAgentTokenTrades passes skipDuplicates=true so retries are safe", async () => {
  // pumpportal pages overlap at the seam — without skipDuplicates a
  // retry would crash on the unique txSignature. The indexer also
  // dedups in-memory but ALSO crashing on a duplicate from a *previous*
  // tick would be a real production fire.
  const { persistAgentTokenTrades } = await import(
    "../services/persistAgentTokenTrades.js"
  );
  const stub = makePrismaStub();
  await persistAgentTokenTrades(
    { tokenId: "tok_1", rows: [sampleRow()] },
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.observed.createManyArgs.skipDuplicates, true);
});

test("persistAgentTokenTrades reports inserted count from createMany.count (only new rows)", async () => {
  const { persistAgentTokenTrades } = await import(
    "../services/persistAgentTokenTrades.js"
  );
  const stub = makePrismaStub({ existingSignatures: ["sig_a"] });
  const result = await persistAgentTokenTrades(
    {
      tokenId: "tok_1",
      rows: [
        sampleRow({ txSignature: "sig_a" }),
        sampleRow({ txSignature: "sig_b" }),
        sampleRow({ txSignature: "sig_c" }),
      ],
    },
    { prisma: stub.prisma as any },
  );
  // sig_a is a duplicate; only sig_b + sig_c are new.
  assert.equal(result.inserted, 2);
});

test("persistAgentTokenTrades reports inserted=0 when every row is a duplicate", async () => {
  const { persistAgentTokenTrades } = await import(
    "../services/persistAgentTokenTrades.js"
  );
  const stub = makePrismaStub({ existingSignatures: ["sig_a", "sig_b"] });
  const result = await persistAgentTokenTrades(
    {
      tokenId: "tok_1",
      rows: [sampleRow({ txSignature: "sig_a" }), sampleRow({ txSignature: "sig_b" })],
    },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.inserted, 0);
});

// ============================================
// Error handling — bubble up
// ============================================

test("persistAgentTokenTrades surfaces Prisma errors so the indexer can label + skip the snapshot", async () => {
  // The indexer wraps with `persist_trades_failed` and skips the
  // holder-snapshot recompute. The loader must NOT swallow the error.
  const { persistAgentTokenTrades } = await import(
    "../services/persistAgentTokenTrades.js"
  );
  const prisma = {
    agentTokenTrade: {
      async createMany() {
        throw new Error("connection refused");
      },
    },
  };
  await assert.rejects(
    persistAgentTokenTrades(
      { tokenId: "tok_1", rows: [sampleRow()] },
      { prisma: prisma as any },
    ),
    /connection refused/,
  );
});
