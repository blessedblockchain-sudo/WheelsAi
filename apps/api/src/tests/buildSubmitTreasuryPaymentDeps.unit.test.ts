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

// Drives apps/api/src/services/buildSubmitTreasuryPaymentDeps.ts —
// dep-wiring closure for the BullMQ submit-payment driver.
//
// The orchestrator (submitTreasuryPayment) needs three things:
//   - signerKeypair          — Solana keypair (treasury PDA authority)
//   - fetchLatestBlockhash   — RPC: latest blockhash + lastValidBlockHeight
//   - sendRawTransaction     — RPC: serialized tx → signature
//
// The dep-builder wraps a Connection-like into the two closures and
// holds the signerKeypair reference. Tests stub the Connection-like
// with a minimal duck-typed surface.

interface ConnectionLike {
  getLatestBlockhash: (commitment?: any) => Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  sendRawTransaction: (raw: Uint8Array) => Promise<string>;
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
    async sendRawTransaction(raw: Uint8Array) {
      log.push({ type: "sendRawTransaction", rawLength: raw.length });
      return "SIG_FROM_STUB";
    },
  };
  return { log, connection };
}

const signerKeypair = Keypair.generate();

// ============================================
// Build shape
// ============================================

test("buildSubmitTreasuryPaymentDeps returns the three required dep keys", async () => {
  setupEnv();
  const { buildSubmitTreasuryPaymentDeps } = await import(
    "../services/buildSubmitTreasuryPaymentDeps.js"
  );
  const { connection } = makeConnectionStub();
  const deps = buildSubmitTreasuryPaymentDeps({
    connection: connection as any,
    signerKeypair,
  });
  for (const key of [
    "signerKeypair",
    "fetchLatestBlockhash",
    "sendRawTransaction",
  ]) {
    assert.ok(key in deps, `expected dep key "${key}"`);
  }
});

test("buildSubmitTreasuryPaymentDeps forwards signerKeypair by reference (same publicKey)", async () => {
  // The orchestrator validates signerKeypair.publicKey matches the
  // treasuryAddress on the input. A copy or wrong-keypair would fail
  // that check at runtime — must be the same reference passed through.
  const { buildSubmitTreasuryPaymentDeps } = await import(
    "../services/buildSubmitTreasuryPaymentDeps.js"
  );
  const { connection } = makeConnectionStub();
  const deps = buildSubmitTreasuryPaymentDeps({
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

test("buildSubmitTreasuryPaymentDeps fetchLatestBlockhash hits connection.getLatestBlockhash", async () => {
  const { buildSubmitTreasuryPaymentDeps } = await import(
    "../services/buildSubmitTreasuryPaymentDeps.js"
  );
  const stub = makeConnectionStub();
  const deps = buildSubmitTreasuryPaymentDeps({
    connection: stub.connection as any,
    signerKeypair,
  });
  const result = await deps.fetchLatestBlockhash();
  assert.equal(stub.log.filter((c) => c.type === "getLatestBlockhash").length, 1);
  assert.equal(result.blockhash, "BLOCKHASH123");
  assert.equal(result.lastValidBlockHeight, 100);
});

test("buildSubmitTreasuryPaymentDeps fetchLatestBlockhash uses confirmed commitment", async () => {
  // Submitting against a finalized blockhash would lose throughput;
  // 'processed' is too racy. 'confirmed' is the right balance for
  // payment txs — pin the wiring choice.
  const { buildSubmitTreasuryPaymentDeps } = await import(
    "../services/buildSubmitTreasuryPaymentDeps.js"
  );
  const stub = makeConnectionStub();
  const deps = buildSubmitTreasuryPaymentDeps({
    connection: stub.connection as any,
    signerKeypair,
  });
  await deps.fetchLatestBlockhash();
  const call = stub.log.find((c) => c.type === "getLatestBlockhash");
  assert.equal(call!.commitment, "confirmed");
});

// ============================================
// sendRawTransaction wires through to connection
// ============================================

test("buildSubmitTreasuryPaymentDeps sendRawTransaction hits connection.sendRawTransaction", async () => {
  const { buildSubmitTreasuryPaymentDeps } = await import(
    "../services/buildSubmitTreasuryPaymentDeps.js"
  );
  const stub = makeConnectionStub();
  const deps = buildSubmitTreasuryPaymentDeps({
    connection: stub.connection as any,
    signerKeypair,
  });
  const raw = new Uint8Array([1, 2, 3, 4]);
  const sig = await deps.sendRawTransaction(raw);
  const call = stub.log.find((c) => c.type === "sendRawTransaction");
  assert.equal(call!.rawLength, 4);
  assert.equal(sig, "SIG_FROM_STUB");
});

// ============================================
// Error semantics
// ============================================

test("buildSubmitTreasuryPaymentDeps fetchLatestBlockhash bubbles connection errors", async () => {
  // Driver layer relies on these throwing — markFailed('blockhash_unavailable')
  // is the proper handling. Swallowing here would leave the payment
  // stuck in PENDING.
  const { buildSubmitTreasuryPaymentDeps } = await import(
    "../services/buildSubmitTreasuryPaymentDeps.js"
  );
  const connection: ConnectionLike = {
    async getLatestBlockhash() {
      throw new Error("rpc unreachable");
    },
    async sendRawTransaction() {
      return "";
    },
  };
  const deps = buildSubmitTreasuryPaymentDeps({
    connection: connection as any,
    signerKeypair,
  });
  await assert.rejects(deps.fetchLatestBlockhash(), /rpc unreachable/);
});

test("buildSubmitTreasuryPaymentDeps sendRawTransaction bubbles connection errors", async () => {
  const { buildSubmitTreasuryPaymentDeps } = await import(
    "../services/buildSubmitTreasuryPaymentDeps.js"
  );
  const connection: ConnectionLike = {
    async getLatestBlockhash() {
      return { blockhash: "x", lastValidBlockHeight: 0 };
    },
    async sendRawTransaction() {
      throw new Error("simulation failed");
    },
  };
  const deps = buildSubmitTreasuryPaymentDeps({
    connection: connection as any,
    signerKeypair,
  });
  await assert.rejects(
    deps.sendRawTransaction(new Uint8Array()),
    /simulation failed/,
  );
});
