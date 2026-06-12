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

// Drives apps/api/src/services/persistRecoveryTransition.ts — the
// conditional-update writer for the recovery phase of the submit worker
// (claim-first protocol, remediation D3).
//
//   landed | rebroadcast → SUBMITTING → SUBMITTED (+ submittedAt)
//   expired             → SUBMITTING → PENDING with ALL claim fields
//                         cleared (txSignature/signedTxB64/
//                         lastValidBlockHeight) — clearing licenses the
//                         next tick to re-sign safely.
//
// count===0 is benign (another replica's recovery settled the row from
// the same on-chain facts).

function makePrismaStub(opts: { matchedCount: number }) {
  const log: any[] = [];
  return {
    log,
    prisma: {
      computePayment: {
        async updateMany(args: any) {
          log.push({ type: "updateMany", args });
          return { count: opts.matchedCount };
        },
      },
    },
  };
}

const NOW = new Date("2026-04-26T10:00:00Z");

test("persistRecoveryTransition landed → SUBMITTED + submittedAt, guarded on SUBMITTING", async () => {
  setupEnv();
  const { persistRecoveryTransition } = await import(
    "../services/persistRecoveryTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistRecoveryTransition(
    "cp_1",
    { type: "landed" },
    { prisma: stub.prisma as any, now: NOW },
  );
  const call = stub.log[0].args;
  assert.equal(call.where.id, "cp_1");
  assert.equal(call.where.status, "SUBMITTING");
  assert.equal(call.data.status, "SUBMITTED");
  assert.equal((call.data.submittedAt as Date).toISOString(), NOW.toISOString());
  assert.equal(call.data.errorMessage, null);
  // The claim fields stay — the sig is real and the poller polls it.
  assert.equal("txSignature" in call.data, false);
  assert.equal("signedTxB64" in call.data, false);
});

test("persistRecoveryTransition rebroadcast → SUBMITTED (same shape as landed)", async () => {
  const { persistRecoveryTransition } = await import(
    "../services/persistRecoveryTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistRecoveryTransition(
    "cp_1",
    { type: "rebroadcast" },
    { prisma: stub.prisma as any, now: NOW },
  );
  const call = stub.log[0].args;
  assert.equal(call.where.status, "SUBMITTING");
  assert.equal(call.data.status, "SUBMITTED");
  assert.equal((call.data.submittedAt as Date).toISOString(), NOW.toISOString());
});

test("persistRecoveryTransition expired → back to PENDING with ALL claim fields cleared", async () => {
  // Clearing is load-bearing: a future re-sign is only safe because the
  // old signature provably can never land AND nothing on the row still
  // points at it.
  const { persistRecoveryTransition } = await import(
    "../services/persistRecoveryTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await persistRecoveryTransition(
    "cp_1",
    { type: "expired" },
    { prisma: stub.prisma as any, now: NOW },
  );
  const call = stub.log[0].args;
  assert.equal(call.where.status, "SUBMITTING");
  assert.equal(call.data.status, "PENDING");
  assert.equal(call.data.txSignature, null);
  assert.equal(call.data.signedTxB64, null);
  assert.equal(call.data.lastValidBlockHeight, null);
});

test("persistRecoveryTransition treats count=0 as a benign race (no throw)", async () => {
  // Another replica's recovery settled the row milliseconds before us,
  // from the same on-chain evidence. There is no in-memory state to
  // lose — the artifacts are already durable on the row.
  const { persistRecoveryTransition } = await import(
    "../services/persistRecoveryTransition.js"
  );
  const stub = makePrismaStub({ matchedCount: 0 });
  await persistRecoveryTransition(
    "cp_1",
    { type: "landed" },
    { prisma: stub.prisma as any, now: NOW },
  );
  assert.equal(stub.log.length, 1);
});
