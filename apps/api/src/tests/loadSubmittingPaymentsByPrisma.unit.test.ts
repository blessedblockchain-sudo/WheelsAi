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

// Drives apps/api/src/services/loadSubmittingPaymentsByPrisma.ts —
// loader for the recovery phase of the submit-payments worker
// (claim-first protocol, remediation D3). Returns SUBMITTING rows with
// their persisted claim artifacts so recovery can settle them from
// on-chain evidence. Rows missing a signature or the signed bytes are
// schema-inconsistent and are EXCLUDED (we can neither check nor
// re-broadcast them — never guess).

interface FakeRow {
  id: string;
  txSignature: string | null;
  lastValidBlockHeight: bigint | null;
  signedTxB64: string | null;
}

function makePrismaStub(rows: FakeRow[]) {
  const observed: { findManyArgs?: any } = {};
  return {
    observed,
    prisma: {
      computePayment: {
        async findMany({ where, orderBy, take }: any) {
          observed.findManyArgs = { where, orderBy, take };
          let matched = rows;
          if (take) matched = matched.slice(0, take);
          return matched;
        },
      },
    },
  };
}

const row = (overrides: Partial<FakeRow> = {}): FakeRow => ({
  id: "cp_s",
  txSignature: "sig_s",
  lastValidBlockHeight: 500n,
  signedTxB64: "Ynl0ZXM=",
  ...overrides,
});

test("loadSubmittingPaymentsByPrisma scopes to status=SUBMITTING ordered by scheduledFor asc", async () => {
  setupEnv();
  const { loadSubmittingPaymentsByPrisma } = await import(
    "../services/loadSubmittingPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([row()]);
  const result = await loadSubmittingPaymentsByPrisma(
    { limit: 50 },
    { prisma: stub.prisma as any },
  );
  assert.equal(stub.observed.findManyArgs.where.status, "SUBMITTING");
  assert.equal(stub.observed.findManyArgs.orderBy.scheduledFor, "asc");
  assert.equal(stub.observed.findManyArgs.take, 50);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    id: "cp_s",
    txSignature: "sig_s",
    lastValidBlockHeight: 500n,
    signedTxB64: "Ynl0ZXM=",
  });
});

test("loadSubmittingPaymentsByPrisma excludes rows with a null txSignature or null signedTxB64", async () => {
  const { loadSubmittingPaymentsByPrisma } = await import(
    "../services/loadSubmittingPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([
    row({ id: "ok" }),
    row({ id: "no_sig", txSignature: null }),
    row({ id: "no_bytes", signedTxB64: null }),
  ]);
  const result = await loadSubmittingPaymentsByPrisma(
    { limit: 50 },
    { prisma: stub.prisma as any },
  );
  assert.deepEqual(
    result.map((r) => r.id),
    ["ok"],
  );
});

test("loadSubmittingPaymentsByPrisma keeps a null lastValidBlockHeight (recovery treats it as expiry-unprovable)", async () => {
  const { loadSubmittingPaymentsByPrisma } = await import(
    "../services/loadSubmittingPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([row({ lastValidBlockHeight: null })]);
  const result = await loadSubmittingPaymentsByPrisma(
    { limit: 50 },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.lastValidBlockHeight, null);
});

test("loadSubmittingPaymentsByPrisma respects the limit", async () => {
  const { loadSubmittingPaymentsByPrisma } = await import(
    "../services/loadSubmittingPaymentsByPrisma.js"
  );
  const stub = makePrismaStub([row({ id: "1" }), row({ id: "2" }), row({ id: "3" })]);
  const result = await loadSubmittingPaymentsByPrisma(
    { limit: 2 },
    { prisma: stub.prisma as any },
  );
  assert.equal(result.length, 2);
  assert.equal(stub.observed.findManyArgs.take, 2);
});
