import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/buildPrepareTreasuryPaymentDeps.ts —
// dep-wiring closure for the sign-only prepare orchestrators
// (claim-first protocol, remediation D3).
//
// The orchestrator (prepareTreasuryPayment) needs two things:
//   - signerKeypair          — Solana keypair (treasury PDA authority)
//   - fetchLatestBlockhash   — RPC: latest blockhash + lastValidBlockHeight
//
// Deliberately NO sendRawTransaction: broadcast happens only after the
// PENDING → SUBMITTING claim persisted the signed bytes, via the
// separate broadcast closure in buildSubmitPaymentsTickDeps.

interface ConnectionLike {
  getLatestBlockhash: (commitment?: any) => Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
}

function makeConnectionStub() {
  const log: any[] = [];
  const connection: ConnectionLike = {
    async getLatestBlockhash(commitment?: any) {
      log.push({ type: "getLatestBlockhash", commitment });
      return {
        blockhash: "BLOCKHASH123",
        lastValidBlockHeight: 100,
      };
    },
  };
  return { log, connection };
}

const signerKeypair = Keypair.generate();

// ============================================
// Build shape
// ============================================

test("buildPrepareTreasuryPaymentDeps returns the two required dep keys and NO broadcast closure", async () => {
  setupEnv();
  const { buildPrepareTreasuryPaymentDeps } = await import(
    "../services/buildPrepareTreasuryPaymentDeps.js"
  );
  const { connection } = makeConnectionStub();
  const deps = buildPrepareTreasuryPaymentDeps({
    connection: connection as any,
    signerKeypair,
  });
  for (const key of ["signerKeypair", "fetchLatestBlockhash"]) {
    assert.ok(key in deps, `expected dep key "${key}"`);
  }
  // The claim-first invariant at the type boundary: prepare deps carry
  // no way to broadcast.
  assert.equal("sendRawTransaction" in deps, false);
});

test("buildPrepareTreasuryPaymentDeps forwards signerKeypair by reference (same publicKey)", async () => {
  // The orchestrator validates signerKeypair.publicKey matches the
  // treasuryAddress on the input. A copy or wrong-keypair would fail
  // that check at runtime — must be the same reference passed through.
  const { buildPrepareTreasuryPaymentDeps } = await import(
    "../services/buildPrepareTreasuryPaymentDeps.js"
  );
  const { connection } = makeConnectionStub();
  const deps = buildPrepareTreasuryPaymentDeps({
    connection: connection as any,
    signerKeypair,
  });
  assert.equal(
    deps.signerKeypair.publicKey.toBase58(),
    signerKeypair.publicKey.toBase58(),
  );
});

// ============================================
// fetchLatestBlockhash wires through to connection
// ============================================

test("buildPrepareTreasuryPaymentDeps fetchLatestBlockhash hits connection.getLatestBlockhash", async () => {
  const { buildPrepareTreasuryPaymentDeps } = await import(
    "../services/buildPrepareTreasuryPaymentDeps.js"
  );
  const stub = makeConnectionStub();
  const deps = buildPrepareTreasuryPaymentDeps({
    connection: stub.connection as any,
    signerKeypair,
  });
  const result = await deps.fetchLatestBlockhash();
  assert.equal(stub.log.filter((c) => c.type === "getLatestBlockhash").length, 1);
  assert.equal(result.blockhash, "BLOCKHASH123");
  assert.equal(result.lastValidBlockHeight, 100);
});

test("buildPrepareTreasuryPaymentDeps fetchLatestBlockhash uses confirmed commitment", async () => {
  // Signing against a finalized blockhash would lose throughput;
  // 'processed' is too racy. 'confirmed' is the right balance for
  // payment txs — pin the wiring choice.
  const { buildPrepareTreasuryPaymentDeps } = await import(
    "../services/buildPrepareTreasuryPaymentDeps.js"
  );
  const stub = makeConnectionStub();
  const deps = buildPrepareTreasuryPaymentDeps({
    connection: stub.connection as any,
    signerKeypair,
  });
  await deps.fetchLatestBlockhash();
  const call = stub.log.find((c) => c.type === "getLatestBlockhash");
  assert.equal(call!.commitment, "confirmed");
});

// ============================================
// Error semantics
// ============================================

test("buildPrepareTreasuryPaymentDeps fetchLatestBlockhash bubbles connection errors", async () => {
  // The orchestrator relies on this throwing — it maps the throw to
  // `blockhash_unavailable: …` and the driver records the per-row
  // FAILED transition. Swallowing here would leave the payment stuck
  // in PENDING.
  const { buildPrepareTreasuryPaymentDeps } = await import(
    "../services/buildPrepareTreasuryPaymentDeps.js"
  );
  const connection: ConnectionLike = {
    async getLatestBlockhash() {
      throw new Error("rpc unreachable");
    },
  };
  const deps = buildPrepareTreasuryPaymentDeps({
    connection: connection as any,
    signerKeypair,
  });
  await assert.rejects(deps.fetchLatestBlockhash(), /rpc unreachable/);
});
