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

// Drives apps/api/src/services/buildSubmitPaymentsTickDeps.ts —
// the full dep-wiring closure for the submit-payments BullMQ worker.
//
// Composes:
//   loadPendingPaymentsByPrisma    → loadPendingBatch
//   submitTreasuryPayment + RPC    → submit
//   persistSubmitTransition        → persistTransition
//
// Plus a `resolveRecipient(nosanaJobId)` injected dep — the loader
// returns the DB-direct shape, and this closure adds the per-row
// host-address resolution at submit time. (Real wiring: query Nosana
// SDK; tests inject a stub.)

const treasuryKeypair = Keypair.generate();

function makePrismaStub(opts: {
  pending?: Array<{
    id: string;
    treasuryId: string;
    amountLamports: bigint;
    nosanaJobId: string;
    treasury: { id: string; treasuryPdaAddress: string };
  }>;
  updateMatchCount?: number;
}) {
  const log: any[] = [];
  return {
    log,
    prisma: {
      computePayment: {
        async findMany(args: any) {
          log.push({ type: "findMany", args });
          return opts.pending ?? [];
        },
        async updateMany(args: any) {
          log.push({ type: "updateMany", args });
          return { count: opts.updateMatchCount ?? 1 };
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
        return {
          // A valid base58 32-byte blockhash (using a Keypair pubkey
          // since blockhashes are the same byte length).
          blockhash: Keypair.generate().publicKey.toBase58(),
          lastValidBlockHeight: 100,
        };
      },
      async sendRawTransaction(raw: Uint8Array) {
        log.push({ type: "sendRawTransaction", rawLength: raw.length });
        return "REAL_SIG_FROM_STUB";
      },
    },
  };
}

// ============================================
// Build shape
// ============================================

test("buildSubmitPaymentsTickDeps returns the three driver-shape keys", async () => {
  setupEnv();
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    treasurySignerFor: () => treasuryKeypair,
    resolveRecipient: async () => "RecipientAddr",
    batchLimit: 50,
    now: () => new Date(),
  });
  for (const key of ["loadPendingBatch", "submit", "persistTransition"]) {
    assert.ok(key in deps, `expected dep key "${key}"`);
  }
});

// ============================================
// loadPendingBatch wires through to Prisma loader
// ============================================

test("buildSubmitPaymentsTickDeps loadPendingBatch hits Prisma findMany with status=PENDING + due", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    treasurySignerFor: () => treasuryKeypair,
    resolveRecipient: async () => "RecipientAddr",
    batchLimit: 50,
    now: () => new Date(),
  });
  await deps.loadPendingBatch({ now: new Date("2026-04-26T11:00:00Z") });
  const findMany = stub.log.find((c) => c.type === "findMany");
  assert.equal(findMany.args.where.status, "PENDING");
  assert.equal(findMany.args.take, 50);
});

test("buildSubmitPaymentsTickDeps loadPendingBatch flattens the row + adds recipientAddress", async () => {
  // The driver expects PendingPaymentRow with recipientAddress; the
  // builder enriches the loader's output with the resolved host.
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({
    pending: [
      {
        id: "cp_1",
        treasuryId: "treas_1",
        amountLamports: 1_000_000n,
        nosanaJobId: "job_1",
        treasury: { id: "treas_1", treasuryPdaAddress: "TreasuryPDA" },
      },
    ],
  });
  const conn = makeConnectionStub();
  const recipientLog: string[] = [];
  const deps = buildSubmitPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    treasurySignerFor: () => treasuryKeypair,
    resolveRecipient: async (nosanaJobId) => {
      recipientLog.push(nosanaJobId);
      return `Host_${nosanaJobId}`;
    },
    batchLimit: 50,
    now: () => new Date(),
  });
  const rows = await deps.loadPendingBatch({ now: new Date() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "cp_1");
  assert.equal(rows[0]!.treasuryAddress, "TreasuryPDA");
  assert.equal(rows[0]!.recipientAddress, "Host_job_1");
  assert.equal(rows[0]!.amountLamports, 1_000_000n);
  // resolveRecipient was called with the right job id.
  assert.deepEqual(recipientLog, ["job_1"]);
});

// ============================================
// submit wires through
// ============================================

test("buildSubmitPaymentsTickDeps submit calls connection RPC and returns ok+sig on success", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    treasurySignerFor: () => treasuryKeypair,
    resolveRecipient: async () => "RecipientAddr",
    batchLimit: 50,
    now: () => new Date(),
  });
  const outcome = await deps.submit({
    id: "cp_1",
    treasuryId: "treas_1",
    treasuryAddress: treasuryKeypair.publicKey.toBase58(),
    recipientAddress: Keypair.generate().publicKey.toBase58(),
    amountLamports: 1_000_000n,
    programInitialized: false,
    mintAddress: null,
  });
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.txSignature, "REAL_SIG_FROM_STUB");
  }
  // Both RPC calls fired.
  assert.ok(conn.log.some((c) => c.type === "getLatestBlockhash"));
  assert.ok(conn.log.some((c) => c.type === "sendRawTransaction"));
});

test("buildSubmitPaymentsTickDeps submit returns ok=false on RPC failure", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
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
  const deps = buildSubmitPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: conn as any,
    treasurySignerFor: () => treasuryKeypair,
    resolveRecipient: async () => Keypair.generate().publicKey.toBase58(),
    batchLimit: 50,
    now: () => new Date(),
  });
  const outcome = await deps.submit({
    id: "cp_1",
    treasuryId: "treas_1",
    treasuryAddress: treasuryKeypair.publicKey.toBase58(),
    recipientAddress: Keypair.generate().publicKey.toBase58(),
    amountLamports: 1_000_000n,
    programInitialized: false,
    mintAddress: null,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.error, /blockhash_unavailable/);
  }
});

// ============================================
// persistTransition wires through to Prisma updateMany
// ============================================

test("buildSubmitPaymentsTickDeps persistTransition wires to updateMany WHERE status=PENDING", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({ updateMatchCount: 1 });
  const conn = makeConnectionStub();
  const now = new Date("2026-04-26T11:00:00Z");
  const deps = buildSubmitPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    treasurySignerFor: () => treasuryKeypair,
    resolveRecipient: async () => "Host",
    batchLimit: 50,
    now: () => now,
  });
  await deps.persistTransition("cp_1", {
    type: "submitted",
    txSignature: "SIG_1",
  });
  const update = stub.log.find((c) => c.type === "updateMany");
  assert.equal(update.args.where.id, "cp_1");
  assert.equal(update.args.where.status, "PENDING");
  assert.equal(update.args.data.status, "SUBMITTED");
  assert.equal(update.args.data.txSignature, "SIG_1");
  assert.equal(
    (update.args.data.submittedAt as Date).toISOString(),
    now.toISOString(),
  );
});

// ============================================
// treasurySignerFor — per-treasury keypair
// ============================================

test("buildSubmitPaymentsTickDeps treasurySignerFor is called with the row's treasuryId", async () => {
  // Different agents → different treasury PDAs → different keypairs.
  // The closure must route the right keypair per row, not use a
  // global keypair.
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const observed: string[] = [];
  const deps = buildSubmitPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    treasurySignerFor: (treasuryId) => {
      observed.push(treasuryId);
      return treasuryKeypair;
    },
    resolveRecipient: async () => Keypair.generate().publicKey.toBase58(),
    batchLimit: 50,
    now: () => new Date(),
  });
  await deps.submit({
    id: "cp_1",
    treasuryId: "treas_xyz",
    treasuryAddress: treasuryKeypair.publicKey.toBase58(),
    recipientAddress: Keypair.generate().publicKey.toBase58(),
    amountLamports: 1n,
    programInitialized: false,
    mintAddress: null,
  });
  assert.deepEqual(observed, ["treas_xyz"]);
});

// ============================================
// Dual-mode dispatch (legacy vs. program-routed)
// ============================================

test("buildSubmitPaymentsTickDeps submit routes to program path when programInitialized=true", async () => {
  setupEnv();
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    treasurySignerFor: () => treasuryKeypair,
    resolveRecipient: async () => Keypair.generate().publicKey.toBase58(),
    batchLimit: 50,
    now: () => new Date(),
  });
  const outcome = await deps.submit({
    id: "cp_prog",
    treasuryId: "treas_prog",
    // In program mode the treasuryAddress is the on-chain PDA — its
    // value isn't validated by the dep-builder (the program's has_one
    // does that on-chain).
    treasuryAddress: "ProgPdaXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    recipientAddress: Keypair.generate().publicKey.toBase58(),
    amountLamports: 5_000_000n,
    programInitialized: true,
    // A real-looking SPL mint pubkey so PublicKey() doesn't throw.
    mintAddress: "So11111111111111111111111111111111111111112",
  });
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.txSignature, "REAL_SIG_FROM_STUB");
  // RPC closures still fired — both paths use the same connection.
  assert.ok(conn.log.some((c) => c.type === "sendRawTransaction"));
});

test("buildSubmitPaymentsTickDeps submit fails fast when program-mode row is missing mintAddress", async () => {
  // A row with programInitialized=true but no mintAddress is corrupt —
  // we can't derive the PDA. The dep-builder should refuse rather than
  // send a tx the program would reject.
  setupEnv();
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    treasurySignerFor: () => treasuryKeypair,
    resolveRecipient: async () => Keypair.generate().publicKey.toBase58(),
    batchLimit: 50,
    now: () => new Date(),
  });
  const outcome = await deps.submit({
    id: "cp_corrupt",
    treasuryId: "treas_corrupt",
    treasuryAddress: "WhateverPda",
    recipientAddress: Keypair.generate().publicKey.toBase58(),
    amountLamports: 1n,
    programInitialized: true,
    mintAddress: null,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.error, /program_mode_missing_mint/);
  }
  // Critically: no RPC was issued. Saves a wasted blockhash fetch.
  assert.equal(
    conn.log.some((c) => c.type === "sendRawTransaction"),
    false,
  );
});

// ============================================
// End-to-end smoke
// ============================================

test("buildSubmitPaymentsTickDeps result drives runSubmitPaymentsTick on an empty batch", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    treasurySignerFor: () => treasuryKeypair,
    resolveRecipient: async () => "Host",
    batchLimit: 50,
    now: () => new Date(),
  });
  const result = await runSubmitPaymentsTick(
    { now: new Date() },
    deps,
  );
  assert.deepEqual(result, { submitted: 0, failed: 0 });
});
