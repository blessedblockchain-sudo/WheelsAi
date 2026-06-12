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

// Drives apps/api/src/services/buildReapStuckTickDeps.ts —
// the full dep-wiring closure for the stuck-submission reaper.
//
// Composes:
//   loadStuckCandidatesByPrisma     → loadStuckCandidates
//   connection.getBlockHeight       → getCurrentBlockHeight
//   connection.getSignatureStatuses → hasSignatureLanded
//   persistReapTransition           → persistTransition
//
// D4: the reaper now carries RPC closures — age alone never fails a row.

function makePrismaStub(opts: { matchedCount?: number } = {}) {
  const log: any[] = [];
  return {
    log,
    prisma: {
      computePayment: {
        async findMany(args: any) {
          log.push({ type: "findMany", args });
          return [];
        },
        async updateMany(args: any) {
          log.push({ type: "updateMany", args });
          return { count: opts.matchedCount ?? 1 };
        },
      },
    },
  };
}

function makeConnectionStub(opts?: {
  blockHeight?: number;
  signatureStatusEntry?: unknown;
}) {
  const log: any[] = [];
  return {
    log,
    connection: {
      async getBlockHeight(commitment?: string) {
        log.push({ type: "getBlockHeight", commitment });
        return opts?.blockHeight ?? 1234;
      },
      async getSignatureStatuses(sigs: string[], cfg: unknown) {
        log.push({ type: "getSignatureStatuses", sigs, cfg });
        return { value: [opts?.signatureStatusEntry ?? null] };
      },
    },
  };
}

const NOW = new Date("2026-04-26T10:00:00Z");

function build(stub: ReturnType<typeof makePrismaStub>, conn?: any) {
  return {
    prisma: stub.prisma as any,
    connection: (conn ?? makeConnectionStub().connection) as any,
    batchLimit: 100,
    maxAgeSeconds: 300,
  };
}

// ============================================
// Build shape
// ============================================

test("buildReapStuckTickDeps returns the four driver-shape keys", async () => {
  setupEnv();
  const { buildReapStuckTickDeps } = await import(
    "../services/buildReapStuckTickDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildReapStuckTickDeps(build(stub));
  for (const key of [
    "loadStuckCandidates",
    "getCurrentBlockHeight",
    "hasSignatureLanded",
    "persistTransition",
  ]) {
    assert.ok(key in deps, `expected dep key "${key}"`);
  }
});

// ============================================
// loadStuckCandidates
// ============================================

test("buildReapStuckTickDeps loadStuckCandidates hits Prisma findMany with status=SUBMITTED + cutoff", async () => {
  const { buildReapStuckTickDeps } = await import(
    "../services/buildReapStuckTickDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildReapStuckTickDeps(build(stub));
  await deps.loadStuckCandidates({ now: NOW });
  const findMany = stub.log.find((c) => c.type === "findMany");
  assert.equal(findMany.args.where.status, "SUBMITTED");
  // cutoff = NOW - 300s = 09:55:00.
  const cutoff = new Date(NOW.getTime() - 300 * 1000);
  assert.equal(
    (findMany.args.where.submittedAt.lt as Date).toISOString(),
    cutoff.toISOString(),
  );
  assert.equal(findMany.args.take, 100);
});

test("buildReapStuckTickDeps loadStuckCandidates uses the batchLimit verbatim", async () => {
  const { buildReapStuckTickDeps } = await import(
    "../services/buildReapStuckTickDeps.js"
  );
  const stub = makePrismaStub();
  const deps = buildReapStuckTickDeps({ ...build(stub), batchLimit: 25 });
  await deps.loadStuckCandidates({ now: NOW });
  assert.equal(
    stub.log.find((c) => c.type === "findMany").args.take,
    25,
  );
});

// ============================================
// Chain-evidence closures (D4)
// ============================================

test("buildReapStuckTickDeps getCurrentBlockHeight maps connection.getBlockHeight to bigint at confirmed commitment", async () => {
  const { buildReapStuckTickDeps } = await import(
    "../services/buildReapStuckTickDeps.js"
  );
  const stub = makePrismaStub();
  const conn = makeConnectionStub({ blockHeight: 98765 });
  const deps = buildReapStuckTickDeps(build(stub, conn.connection));
  const height = await deps.getCurrentBlockHeight();
  assert.equal(height, 98765n);
  const call = conn.log.find((c) => c.type === "getBlockHeight");
  assert.equal(call.commitment, "confirmed");
});

test("buildReapStuckTickDeps hasSignatureLanded queries with searchTransactionHistory and maps presence", async () => {
  const { buildReapStuckTickDeps } = await import(
    "../services/buildReapStuckTickDeps.js"
  );
  const stub = makePrismaStub();
  const connSeen = makeConnectionStub({
    signatureStatusEntry: { confirmationStatus: "finalized", err: null },
  });
  const depsSeen = buildReapStuckTickDeps(build(stub, connSeen.connection));
  assert.equal(await depsSeen.hasSignatureLanded("SIG_X"), true);
  const call = connSeen.log.find((c) => c.type === "getSignatureStatuses");
  assert.deepEqual(call.sigs, ["SIG_X"]);
  // Without this flag, sigs older than ~150 slots would read "unseen"
  // and the reaper would fail payments that landed — the exact D4 bug.
  assert.deepEqual(call.cfg, { searchTransactionHistory: true });

  const connUnseen = makeConnectionStub({ signatureStatusEntry: null });
  const depsUnseen = buildReapStuckTickDeps(build(stub, connUnseen.connection));
  assert.equal(await depsUnseen.hasSignatureLanded("SIG_X"), false);
});

test("buildReapStuckTickDeps RPC closures bubble connection errors (the tick's silence discipline relies on the throw)", async () => {
  const { buildReapStuckTickDeps } = await import(
    "../services/buildReapStuckTickDeps.js"
  );
  const stub = makePrismaStub();
  const conn = {
    async getBlockHeight() {
      throw new Error("rpc down");
    },
    async getSignatureStatuses() {
      throw new Error("rpc down");
    },
  };
  const deps = buildReapStuckTickDeps(build(stub, conn));
  await assert.rejects(deps.getCurrentBlockHeight(), /rpc down/);
  await assert.rejects(deps.hasSignatureLanded("SIG"), /rpc down/);
});

// ============================================
// persistTransition
// ============================================

test("buildReapStuckTickDeps persistTransition wires to updateMany WHERE status=SUBMITTED with FAILED + errorMessage", async () => {
  const { buildReapStuckTickDeps } = await import(
    "../services/buildReapStuckTickDeps.js"
  );
  const stub = makePrismaStub({ matchedCount: 1 });
  const deps = buildReapStuckTickDeps(build(stub));
  await deps.persistTransition("cp_1", { errorMessage: "blockhash_expired" });
  const update = stub.log.find((c) => c.type === "updateMany");
  assert.equal(update.args.where.id, "cp_1");
  assert.equal(update.args.where.status, "SUBMITTED");
  assert.equal(update.args.data.status, "FAILED");
  assert.equal(update.args.data.errorMessage, "blockhash_expired");
});

test("buildReapStuckTickDeps persistTransition throws when count=0 (poll worker confirmed first)", async () => {
  const { buildReapStuckTickDeps } = await import(
    "../services/buildReapStuckTickDeps.js"
  );
  const stub = makePrismaStub({ matchedCount: 0 });
  const deps = buildReapStuckTickDeps(build(stub));
  await assert.rejects(
    deps.persistTransition("cp_1", { errorMessage: "blockhash_expired" }),
    /not in SUBMITTED/,
  );
});

// ============================================
// End-to-end smoke
// ============================================

test("buildReapStuckTickDeps result drives runReapStuckTick on an empty batch", async () => {
  const { buildReapStuckTickDeps } = await import(
    "../services/buildReapStuckTickDeps.js"
  );
  const { runReapStuckTick } = await import(
    "../services/runReapStuckTick.js"
  );
  const stub = makePrismaStub();
  const deps = buildReapStuckTickDeps(build(stub));
  const result = await runReapStuckTick(
    { now: NOW, maxAgeSeconds: 300 },
    deps,
  );
  assert.deepEqual(result, { reaped: 0, scanned: 0 });
});
