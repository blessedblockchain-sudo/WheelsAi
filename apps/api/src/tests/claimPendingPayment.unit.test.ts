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

// Drives apps/api/src/services/claimPendingPayment.ts — the
// compare-and-set claim at the heart of the claim-first protocol
// (remediation D3). PENDING → SUBMITTING persisting the signed
// artifacts BEFORE any broadcast; count semantics arbitrate replica
// overlap (exactly one worker ever owns a broadcastable artifact).

const ARTIFACT = {
  txSignature: "SIG_CLAIM",
  lastValidBlockHeight: 777n,
  signedTxB64: "U0lHTkVEX0JZVEVT",
};

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

test("claimPendingPayment issues a CAS: WHERE {id, status: PENDING} → SUBMITTING + all three claim fields", async () => {
  setupEnv();
  const { claimPendingPayment } = await import(
    "../services/claimPendingPayment.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  const claimed = await claimPendingPayment("cp_1", ARTIFACT, {
    prisma: stub.prisma as any,
  });
  assert.equal(claimed, true);
  const call = stub.log[0].args;
  assert.equal(call.where.id, "cp_1");
  assert.equal(call.where.status, "PENDING");
  assert.equal(call.data.status, "SUBMITTING");
  // The full artifact is durable BEFORE any broadcast — this is the
  // double-spend kill: recovery can only ever re-send these bytes.
  assert.equal(call.data.txSignature, "SIG_CLAIM");
  assert.equal(call.data.lastValidBlockHeight, 777n);
  assert.equal(call.data.signedTxB64, "U0lHTkVEX0JZVEVT");
});

test("claimPendingPayment returns false on a lost race (count 0) without throwing", async () => {
  // Another replica claimed the row between our load and our CAS —
  // expected steady-state under 2 replicas, not an anomaly. The caller
  // skips the row; the winner's artifact is the only one that exists.
  const { claimPendingPayment } = await import(
    "../services/claimPendingPayment.js"
  );
  const stub = makePrismaStub({ matchedCount: 0 });
  const claimed = await claimPendingPayment("cp_1", ARTIFACT, {
    prisma: stub.prisma as any,
  });
  assert.equal(claimed, false);
});

test("claimPendingPayment never writes SUBMITTED/submittedAt — the claim is not the broadcast acknowledgement", async () => {
  const { claimPendingPayment } = await import(
    "../services/claimPendingPayment.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  await claimPendingPayment("cp_1", ARTIFACT, { prisma: stub.prisma as any });
  const data = stub.log[0].args.data;
  assert.notEqual(data.status, "SUBMITTED");
  assert.equal("submittedAt" in data, false);
});
