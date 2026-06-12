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

// sha256("account:Treasury")[..8] — pinned in isPdaAccountInitialized.ts.
const TREASURY_ACCOUNT_DISC = Buffer.from([
  238, 239, 123, 238, 89, 1, 168, 253,
]);

/** Synthetic on-chain Treasury account data: disc(8) + mint(32) +
 * platform_authority(32) + zero padding to the real 153-byte size. */
function makeTreasuryAccountData(platformAuthority: PublicKey): Buffer {
  const data = Buffer.alloc(153);
  TREASURY_ACCOUNT_DISC.copy(data, 0);
  // bytes 8..40 (owner_token_mint) stay zeroed — the reader ignores them.
  platformAuthority.toBuffer().copy(data, 40);
  return data;
}

function makeConnectionStub(opts?: {
  /** The platform_authority recorded in the synthetic on-chain Treasury
   * account that getAccountInfo serves. Defaults to the test-global
   * treasuryKeypair (= the derived signer), i.e. a verified match.
   * Pass null to simulate "no account on-chain". */
  treasuryAuthority?: PublicKey | null;
}) {
  const log: any[] = [];
  const treasuryAuthority =
    opts?.treasuryAuthority === undefined
      ? treasuryKeypair.publicKey
      : opts.treasuryAuthority;
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
      async getAccountInfo(pda: PublicKey) {
        log.push({ type: "getAccountInfo", pda: pda.toBase58() });
        if (treasuryAuthority === null) return null;
        return {
          data: makeTreasuryAccountData(treasuryAuthority),
          lamports: 1_000_000,
          executable: false,
          owner: PublicKey.default,
          rentEpoch: 0,
        };
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
  // C1/C2 defense: the on-chain authority was read and verified before
  // the program-mode tx was signed.
  assert.ok(conn.log.some((c) => c.type === "getAccountInfo"));
});

test("buildSubmitPaymentsTickDeps program-mode submit fails on authority_mismatch without sending a tx", async () => {
  // The on-chain Treasury records someone ELSE's key as the
  // platform_authority (hijacked PDA or wrong WALLET_MASTER_KEY).
  // Submitting would burn a fee on a guaranteed has_one rejection —
  // the builder must fail the row loudly instead.
  setupEnv();
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const hijacker = Keypair.generate().publicKey;
  const conn = makeConnectionStub({ treasuryAuthority: hijacker });
  const deps = buildSubmitPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    treasurySignerFor: () => treasuryKeypair,
    resolveRecipient: async () => Keypair.generate().publicKey.toBase58(),
    batchLimit: 50,
    now: () => new Date(),
  });
  const outcome = await deps.submit({
    id: "cp_hijack",
    treasuryId: "treas_hijack",
    treasuryAddress: "WhateverPda",
    recipientAddress: Keypair.generate().publicKey.toBase58(),
    amountLamports: 1n,
    programInitialized: true,
    mintAddress: "So11111111111111111111111111111111111111112",
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.error, /authority_mismatch/);
    // Both keys appear in the message for incident triage.
    assert.ok(outcome.error.includes(hijacker.toBase58()));
    assert.ok(outcome.error.includes(treasuryKeypair.publicKey.toBase58()));
  }
  // No tx was signed/sent.
  assert.equal(
    conn.log.some((c) => c.type === "sendRawTransaction"),
    false,
  );
});

test("buildSubmitPaymentsTickDeps program-mode submit fails when the treasury account is missing on-chain", async () => {
  setupEnv();
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub({ treasuryAuthority: null });
  const deps = buildSubmitPaymentsTickDeps({
    prisma: stub.prisma as any,
    connection: conn.connection as any,
    treasurySignerFor: () => treasuryKeypair,
    resolveRecipient: async () => Keypair.generate().publicKey.toBase58(),
    batchLimit: 50,
    now: () => new Date(),
  });
  const outcome = await deps.submit({
    id: "cp_missing",
    treasuryId: "treas_missing",
    treasuryAddress: "WhateverPda",
    recipientAddress: Keypair.generate().publicKey.toBase58(),
    amountLamports: 1n,
    programInitialized: true,
    mintAddress: "So11111111111111111111111111111111111111112",
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.error, /authority_mismatch/);
    assert.match(outcome.error, /<missing>/);
  }
  assert.equal(
    conn.log.some((c) => c.type === "sendRawTransaction"),
    false,
  );
});

test("buildSubmitPaymentsTickDeps caches positive authority verification per treasury per tick", async () => {
  // Two payments against the same treasury in one tick must cost
  // exactly ONE getAccountInfo read; a new tick (loadPendingBatch)
  // clears the cache so rotations/hijacks between ticks are caught.
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
  const row = {
    treasuryId: "treas_cached",
    treasuryAddress: "WhateverPda",
    recipientAddress: Keypair.generate().publicKey.toBase58(),
    amountLamports: 1n,
    programInitialized: true,
    mintAddress: "So11111111111111111111111111111111111111112",
  };
  const first = await deps.submit({ ...row, id: "cp_a" });
  const second = await deps.submit({ ...row, id: "cp_b" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const reads = () =>
    conn.log.filter((c) => c.type === "getAccountInfo").length;
  assert.equal(reads(), 1, "one authority read for two same-treasury rows");

  // A fresh tick starts with loadPendingBatch — the cache resets and
  // the next submit re-verifies.
  await deps.loadPendingBatch({ now: new Date() });
  const third = await deps.submit({ ...row, id: "cp_c" });
  assert.equal(third.ok, true);
  assert.equal(reads(), 2, "new tick re-reads the on-chain authority");
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
