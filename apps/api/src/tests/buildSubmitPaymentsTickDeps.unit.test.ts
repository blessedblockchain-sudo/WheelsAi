import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/buildSubmitPaymentsTickDeps.ts —
// the full dep-wiring closure for the submit-payments BullMQ worker
// under the claim-first protocol (remediation D3/D5).
//
// Composes:
//   recovery: loadSubmittingPaymentsByPrisma, getBlockHeight,
//             getSignatureStatuses, persistRecoveryTransition
//   submit:   loadPendingPaymentsByPrisma, injected resolveRecipient,
//             prepare (sign-only), claimPendingPayment (CAS),
//             sendRawTransaction broadcast, persistSubmitTransition
//
// Recipient resolution is NOT performed by loadPendingBatch any more —
// the driver resolves per row (D5), so the loader closure must surface
// nosanaJobId + resolutionAttempts untouched.

const treasuryKeypair = Keypair.generate();

function makePrismaStub(opts: {
  pending?: Array<{
    id: string;
    treasuryId: string;
    amountLamports: bigint;
    nosanaJobId: string;
    resolutionAttempts?: number;
    treasury: { id: string; treasuryPdaAddress: string };
  }>;
  submitting?: Array<{
    id: string;
    txSignature: string | null;
    lastValidBlockHeight: bigint | null;
    signedTxB64: string | null;
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
          if (args.where.status === "SUBMITTING") return opts.submitting ?? [];
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
  /** Entry served by getSignatureStatuses (null = unseen). */
  signatureStatusEntry?: unknown;
  blockHeight?: number;
}) {
  const log: any[] = [];
  const treasuryAuthority =
    opts?.treasuryAuthority === undefined
      ? treasuryKeypair.publicKey
      : opts.treasuryAuthority;
  return {
    log,
    connection: {
      async getLatestBlockhash(commitment?: string) {
        log.push({ type: "getLatestBlockhash", commitment });
        return {
          // A valid base58 32-byte blockhash (using a Keypair pubkey
          // since blockhashes are the same byte length).
          blockhash: Keypair.generate().publicKey.toBase58(),
          lastValidBlockHeight: 100,
        };
      },
      async sendRawTransaction(raw: Uint8Array) {
        log.push({ type: "sendRawTransaction", raw });
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
      async getSignatureStatuses(sigs: string[], cfg: unknown) {
        log.push({ type: "getSignatureStatuses", sigs, cfg });
        return { value: [opts?.signatureStatusEntry ?? null] };
      },
      async getBlockHeight(commitment?: string) {
        log.push({ type: "getBlockHeight", commitment });
        return opts?.blockHeight ?? 90;
      },
    },
  };
}

function build(stub: ReturnType<typeof makePrismaStub>, conn: any, extra?: {
  treasurySignerFor?: (treasuryId: string) => Keypair;
  resolveRecipient?: (jobId: string) => Promise<string>;
  now?: () => Date;
}) {
  // Late import is done by callers; this just centralizes the input shape.
  return {
    prisma: stub.prisma as any,
    connection: conn as any,
    treasurySignerFor: extra?.treasurySignerFor ?? (() => treasuryKeypair),
    resolveRecipient:
      extra?.resolveRecipient ?? (async () => Keypair.generate().publicKey.toBase58()),
    batchLimit: 50,
    now: extra?.now ?? (() => new Date()),
  };
}

const legacyRow = {
  id: "cp_1",
  treasuryId: "treas_1",
  treasuryAddress: treasuryKeypair.publicKey.toBase58(),
  nosanaJobId: "job_1",
  amountLamports: 1_000_000n,
  programInitialized: false,
  mintAddress: null,
  resolutionAttempts: 0,
};

// ============================================
// Build shape
// ============================================

test("buildSubmitPaymentsTickDeps returns the full driver-shape keys (both phases)", async () => {
  setupEnv();
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  for (const key of [
    "loadSubmittingBatch",
    "getCurrentBlockHeight",
    "hasSignatureLanded",
    "broadcast",
    "persistRecoveryTransition",
    "loadPendingBatch",
    "resolveRecipient",
    "prepare",
    "claim",
    "persistTransition",
  ]) {
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
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  await deps.loadPendingBatch({ now: new Date("2026-04-26T11:00:00Z") });
  const findMany = stub.log.find((c) => c.type === "findMany");
  assert.equal(findMany.args.where.status, "PENDING");
  assert.equal(findMany.args.take, 50);
});

test("buildSubmitPaymentsTickDeps loadPendingBatch surfaces nosanaJobId + resolutionAttempts WITHOUT resolving the recipient (D5)", async () => {
  // Resolution moved into the driver's per-row loop; the loader closure
  // must not call resolveRecipient at all — a single poison job in the
  // batch used to abort every other treasury's payments forever.
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
        resolutionAttempts: 3,
        treasury: { id: "treas_1", treasuryPdaAddress: "TreasuryPDA" },
      },
    ],
  });
  const conn = makeConnectionStub();
  const resolveCalls: string[] = [];
  const deps = buildSubmitPaymentsTickDeps(
    build(stub, conn.connection, {
      resolveRecipient: async (jobId) => {
        resolveCalls.push(jobId);
        return `Host_${jobId}`;
      },
    }),
  );
  const rows = await deps.loadPendingBatch({ now: new Date() });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "cp_1");
  assert.equal(rows[0]!.treasuryAddress, "TreasuryPDA");
  assert.equal(rows[0]!.nosanaJobId, "job_1");
  assert.equal(rows[0]!.resolutionAttempts, 3);
  assert.equal(rows[0]!.amountLamports, 1_000_000n);
  // No recipientAddress on the loaded row and NO resolution side effects.
  assert.equal("recipientAddress" in rows[0]!, false);
  assert.deepEqual(resolveCalls, []);
});

test("buildSubmitPaymentsTickDeps resolveRecipient passes through the injected resolver", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps(
    build(stub, conn.connection, {
      resolveRecipient: async (jobId) => `Host_${jobId}`,
    }),
  );
  assert.equal(await deps.resolveRecipient("job_42"), "Host_job_42");
});

// ============================================
// prepare — sign-only, no broadcast
// ============================================

test("buildSubmitPaymentsTickDeps prepare signs (legacy mode) and returns the artifact WITHOUT broadcasting", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  const artifact = await deps.prepare(
    legacyRow,
    Keypair.generate().publicKey.toBase58(),
  );
  // Blockhash was fetched; NOTHING was sent.
  assert.ok(conn.log.some((c) => c.type === "getLatestBlockhash"));
  assert.equal(conn.log.some((c) => c.type === "sendRawTransaction"), false);
  // The artifact is internally coherent: bytes carry exactly txSignature.
  const tx = VersionedTransaction.deserialize(
    new Uint8Array(Buffer.from(artifact.signedTxB64, "base64")),
  );
  assert.equal(bs58.encode(tx.signatures[0]!), artifact.txSignature);
  assert.equal(artifact.lastValidBlockHeight, 100n);
});

test("buildSubmitPaymentsTickDeps prepare rejects on RPC blockhash failure (driver records FAILED)", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = {
    async getLatestBlockhash() {
      throw new Error("blockhash_unavailable");
    },
  };
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn));
  await assert.rejects(
    deps.prepare(legacyRow, Keypair.generate().publicKey.toBase58()),
    /blockhash_unavailable/,
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
  const deps = buildSubmitPaymentsTickDeps(
    build(stub, conn.connection, {
      treasurySignerFor: (treasuryId) => {
        observed.push(treasuryId);
        return treasuryKeypair;
      },
    }),
  );
  await deps.prepare(
    { ...legacyRow, treasuryId: "treas_xyz" },
    Keypair.generate().publicKey.toBase58(),
  );
  assert.deepEqual(observed, ["treas_xyz"]);
});

// ============================================
// Dual-mode dispatch (legacy vs. program-routed)
// ============================================

const programRow = {
  id: "cp_prog",
  treasuryId: "treas_prog",
  // In program mode the treasuryAddress is the on-chain PDA — its
  // value isn't validated by the dep-builder (the program's has_one
  // does that on-chain).
  treasuryAddress: "ProgPdaXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  nosanaJobId: "job_prog",
  amountLamports: 5_000_000n,
  programInitialized: true,
  // A real-looking SPL mint pubkey so PublicKey() doesn't throw.
  mintAddress: "So11111111111111111111111111111111111111112",
  resolutionAttempts: 0,
};

test("buildSubmitPaymentsTickDeps prepare routes to the program path when programInitialized=true", async () => {
  setupEnv();
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  const artifact = await deps.prepare(
    programRow,
    Keypair.generate().publicKey.toBase58(),
  );
  assert.ok(artifact.txSignature.length > 0);
  assert.equal(artifact.lastValidBlockHeight, 100n);
  // C1/C2 defense: the on-chain authority was read and verified BEFORE
  // the program-mode tx was signed.
  assert.ok(conn.log.some((c) => c.type === "getAccountInfo"));
  // Sign-only: still nothing broadcast.
  assert.equal(conn.log.some((c) => c.type === "sendRawTransaction"), false);
});

test("buildSubmitPaymentsTickDeps program-mode prepare rejects on authority_mismatch BEFORE signing", async () => {
  // The on-chain Treasury records someone ELSE's key as the
  // platform_authority (hijacked PDA or wrong WALLET_MASTER_KEY).
  // Signing+claiming would only waste work on a guaranteed has_one
  // rejection — the builder must fail the row loudly instead, before
  // any signature exists.
  setupEnv();
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const hijacker = Keypair.generate().publicKey;
  const conn = makeConnectionStub({ treasuryAuthority: hijacker });
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  await assert.rejects(
    deps.prepare(
      { ...programRow, id: "cp_hijack", treasuryId: "treas_hijack" },
      Keypair.generate().publicKey.toBase58(),
    ),
    (err: Error) => {
      assert.match(err.message, /authority_mismatch/);
      // Both keys appear in the message for incident triage.
      assert.ok(err.message.includes(hijacker.toBase58()));
      assert.ok(err.message.includes(treasuryKeypair.publicKey.toBase58()));
      return true;
    },
  );
  // The authority check pre-empted signing: no blockhash was even fetched,
  // and (obviously) nothing was sent.
  assert.equal(conn.log.some((c) => c.type === "getLatestBlockhash"), false);
  assert.equal(conn.log.some((c) => c.type === "sendRawTransaction"), false);
});

test("buildSubmitPaymentsTickDeps program-mode prepare rejects when the treasury account is missing on-chain", async () => {
  setupEnv();
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub({ treasuryAuthority: null });
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  await assert.rejects(
    deps.prepare(
      { ...programRow, id: "cp_missing", treasuryId: "treas_missing" },
      Keypair.generate().publicKey.toBase58(),
    ),
    /authority_mismatch.*<missing>/s,
  );
  assert.equal(conn.log.some((c) => c.type === "sendRawTransaction"), false);
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
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  const row = { ...programRow, treasuryId: "treas_cached" };
  const recipient = Keypair.generate().publicKey.toBase58();
  await deps.prepare({ ...row, id: "cp_a" }, recipient);
  await deps.prepare({ ...row, id: "cp_b" }, recipient);
  const reads = () =>
    conn.log.filter((c) => c.type === "getAccountInfo").length;
  assert.equal(reads(), 1, "one authority read for two same-treasury rows");

  // A fresh tick starts with loadPendingBatch — the cache resets and
  // the next prepare re-verifies.
  await deps.loadPendingBatch({ now: new Date() });
  await deps.prepare({ ...row, id: "cp_c" }, recipient);
  assert.equal(reads(), 2, "new tick re-reads the on-chain authority");
});

test("buildSubmitPaymentsTickDeps prepare fails fast when a program-mode row is missing mintAddress", async () => {
  // A row with programInitialized=true but no mintAddress is corrupt —
  // we can't derive the PDA. The dep-builder should refuse rather than
  // sign a tx the program would reject.
  setupEnv();
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  await assert.rejects(
    deps.prepare(
      { ...programRow, id: "cp_corrupt", mintAddress: null },
      Keypair.generate().publicKey.toBase58(),
    ),
    /program_mode_missing_mint/,
  );
  // Critically: no RPC was issued. Saves a wasted blockhash fetch.
  assert.equal(conn.log.some((c) => c.type === "getLatestBlockhash"), false);
  assert.equal(conn.log.some((c) => c.type === "sendRawTransaction"), false);
});

// ============================================
// claim wires through to the CAS writer
// ============================================

test("buildSubmitPaymentsTickDeps claim wires to updateMany WHERE status=PENDING → SUBMITTING with the artifact", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({ updateMatchCount: 1 });
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  const claimed = await deps.claim("cp_1", {
    txSignature: "SIG_1",
    lastValidBlockHeight: 123n,
    signedTxB64: "B64_BYTES",
  });
  assert.equal(claimed, true);
  const update = stub.log.find((c) => c.type === "updateMany");
  assert.equal(update.args.where.id, "cp_1");
  assert.equal(update.args.where.status, "PENDING");
  assert.equal(update.args.data.status, "SUBMITTING");
  assert.equal(update.args.data.txSignature, "SIG_1");
  assert.equal(update.args.data.lastValidBlockHeight, 123n);
  assert.equal(update.args.data.signedTxB64, "B64_BYTES");
});

test("buildSubmitPaymentsTickDeps claim returns false (no throw) when the CAS matches no row", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({ updateMatchCount: 0 });
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  const claimed = await deps.claim("cp_1", {
    txSignature: "SIG_1",
    lastValidBlockHeight: 123n,
    signedTxB64: "B64_BYTES",
  });
  assert.equal(claimed, false);
});

// ============================================
// broadcast — decodes the stored b64 verbatim
// ============================================

test("buildSubmitPaymentsTickDeps broadcast base64-decodes and sends the exact stored bytes", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  const bytes = Buffer.from([9, 8, 7, 6, 5]);
  await deps.broadcast(bytes.toString("base64"));
  const sent = conn.log.find((c) => c.type === "sendRawTransaction");
  assert.deepEqual(Array.from(sent.raw as Uint8Array), [9, 8, 7, 6, 5]);
});

// ============================================
// persistTransition wires through to Prisma updateMany
// ============================================

test("buildSubmitPaymentsTickDeps persistTransition('submitted') wires to updateMany WHERE status=SUBMITTING", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({ updateMatchCount: 1 });
  const conn = makeConnectionStub();
  const now = new Date("2026-04-26T11:00:00Z");
  const deps = buildSubmitPaymentsTickDeps(
    build(stub, conn.connection, { now: () => now }),
  );
  await deps.persistTransition("cp_1", {
    type: "submitted",
    txSignature: "SIG_1",
  });
  const update = stub.log.find((c) => c.type === "updateMany");
  assert.equal(update.args.where.id, "cp_1");
  assert.equal(update.args.where.status, "SUBMITTING");
  assert.equal(update.args.data.status, "SUBMITTED");
  assert.equal(
    (update.args.data.submittedAt as Date).toISOString(),
    now.toISOString(),
  );
});

// ============================================
// Recovery wiring
// ============================================

test("buildSubmitPaymentsTickDeps loadSubmittingBatch queries status=SUBMITTING", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({
    submitting: [
      {
        id: "cp_s",
        txSignature: "sig_s",
        lastValidBlockHeight: 99n,
        signedTxB64: "bytes_s",
      },
    ],
  });
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  const rows = await deps.loadSubmittingBatch({ now: new Date() });
  const findMany = stub.log.find((c) => c.type === "findMany");
  assert.equal(findMany.args.where.status, "SUBMITTING");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.signedTxB64, "bytes_s");
});

test("buildSubmitPaymentsTickDeps hasSignatureLanded uses searchTransactionHistory and maps entry presence", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const connSeen = makeConnectionStub({
    signatureStatusEntry: { confirmationStatus: "processed", err: null },
  });
  const depsSeen = buildSubmitPaymentsTickDeps(build(stub, connSeen.connection));
  assert.equal(await depsSeen.hasSignatureLanded("SIG"), true);
  const call = connSeen.log.find((c) => c.type === "getSignatureStatuses");
  assert.deepEqual(call.sigs, ["SIG"]);
  assert.deepEqual(call.cfg, { searchTransactionHistory: true });

  const connUnseen = makeConnectionStub({ signatureStatusEntry: null });
  const depsUnseen = buildSubmitPaymentsTickDeps(
    build(stub, connUnseen.connection),
  );
  assert.equal(await depsUnseen.hasSignatureLanded("SIG"), false);
});

test("buildSubmitPaymentsTickDeps getCurrentBlockHeight returns a bigint from connection.getBlockHeight", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({});
  const conn = makeConnectionStub({ blockHeight: 4242 });
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  const height = await deps.getCurrentBlockHeight();
  assert.equal(height, 4242n);
});

test("buildSubmitPaymentsTickDeps persistRecoveryTransition('expired') clears the claim fields back to PENDING", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const stub = makePrismaStub({ updateMatchCount: 1 });
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  await deps.persistRecoveryTransition("cp_s", { type: "expired" });
  const update = stub.log.find((c) => c.type === "updateMany");
  assert.equal(update.args.where.status, "SUBMITTING");
  assert.equal(update.args.data.status, "PENDING");
  assert.equal(update.args.data.txSignature, null);
  assert.equal(update.args.data.signedTxB64, null);
  assert.equal(update.args.data.lastValidBlockHeight, null);
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
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps);
  assert.deepEqual(result, {
    recovered: 0,
    submitted: 0,
    failed: 0,
    deferred: 0,
    parked: 0,
    skipped: 0,
  });
});

test("buildSubmitPaymentsTickDeps end-to-end: a legacy PENDING row flows claim→broadcast→SUBMITTED with the SAME bytes", async () => {
  const { buildSubmitPaymentsTickDeps } = await import(
    "../services/buildSubmitPaymentsTickDeps.js"
  );
  const { runSubmitPaymentsTick } = await import(
    "../services/runSubmitPaymentsTick.js"
  );
  const stub = makePrismaStub({
    pending: [
      {
        id: "cp_e2e",
        treasuryId: "treas_1",
        amountLamports: 1_000_000n,
        nosanaJobId: "job_1",
        resolutionAttempts: 0,
        treasury: {
          id: "treas_1",
          treasuryPdaAddress: treasuryKeypair.publicKey.toBase58(),
        },
      },
    ],
  });
  const conn = makeConnectionStub();
  const deps = buildSubmitPaymentsTickDeps(build(stub, conn.connection));
  const result = await runSubmitPaymentsTick({ now: new Date() }, deps);
  assert.equal(result.submitted, 1);

  // The claim persisted the b64 whose decoded bytes equal exactly what
  // was broadcast.
  const claimWrite = stub.log.find(
    (c) => c.type === "updateMany" && c.args.data.status === "SUBMITTING",
  );
  const sent = conn.log.find((c) => c.type === "sendRawTransaction");
  assert.deepEqual(
    Array.from(new Uint8Array(Buffer.from(claimWrite.args.data.signedTxB64, "base64"))),
    Array.from(sent.raw as Uint8Array),
  );

  // And the final transition write moved SUBMITTING → SUBMITTED.
  const submitWrite = stub.log.find(
    (c) => c.type === "updateMany" && c.args.data.status === "SUBMITTED",
  );
  assert.equal(submitWrite.args.where.status, "SUBMITTING");
});
