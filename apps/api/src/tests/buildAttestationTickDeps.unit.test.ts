/**
 * Drives apps/api/src/services/buildAttestationTickDeps.ts — the full
 * wiring around the reputation-attestation worker (confirmation
 * discipline, remediation D6b).
 *
 * Pinning:
 *   - attestorAddress is the attestorKeypair pubkey base58
 *   - loadAgents delegates to the Prisma loader
 *   - aggregate: first run defaults to a 6h lookback window
 *   - aggregate: subsequent runs use lastOnChainAttestationAt as periodStart
 *   - aggregate: empty usage records → uptime/message deltas = 0
 *   - prepare signs WITHOUT broadcasting (sign-only artifact)
 *   - persistIntent inserts the SUBMITTED mirror row with the artifacts
 *     and NULL observedAt/cumulatives (those are confirmation-time facts)
 *   - persistMirrorConfirmed: mirror CAS (CONFIRMED + observedAt +
 *     readback cumulatives) then the cursor advance with its
 *     progression guard
 *   - persistMirrorFailed: CAS SUBMITTED→FAILED, cursor untouched
 *   - loadSubmittedMirrors queries the SUBMITTED backlog
 *   - readCumulatives maps the AgentReputation PDA readback
 *   - getSignatureStatus uses searchTransactionHistory
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

const NOW = new Date("2026-05-14T10:00:00Z");
const OBSERVED = new Date("2026-05-14T10:00:09Z");

function makeMint() {
  return new PublicKey("So11111111111111111111111111111111111111112").toBase58();
}

function makeConn(opts: {
  signatureStatusValue?: any;
  blockHeight?: number;
  accountInfoData?: Buffer | null;
} = {}) {
  const sent: Uint8Array[] = [];
  const log: any[] = [];
  return {
    sent,
    log,
    connection: {
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 100,
      }),
      sendRawTransaction: async (raw: Uint8Array) => {
        sent.push(raw);
        return "tx_sig_xxx";
      },
      getSignatureStatuses: async (sigs: string[], cfg: any) => {
        log.push({ type: "getSignatureStatuses", sigs, cfg });
        return { value: [opts.signatureStatusValue ?? null] };
      },
      getBlockHeight: async (commitment: string) => {
        log.push({ type: "getBlockHeight", commitment });
        return opts.blockHeight ?? 1234;
      },
      getAccountInfo: async (pda: PublicKey) => {
        log.push({ type: "getAccountInfo", pda: pda.toBase58() });
        if (opts.accountInfoData === undefined || opts.accountInfoData === null) {
          return null;
        }
        return { data: opts.accountInfoData };
      },
    },
  };
}

function emptyPrisma() {
  return {
    agentToken: {
      findMany: async () => [],
      updateMany: async () => ({ count: 1 }),
    },
    agent: { findFirst: async () => null },
    usageRecord: { findMany: async () => [] },
    onChainAttestation: {
      findMany: async () => [],
      create: async () => ({ id: "mirror_new" }),
      updateMany: async () => ({ count: 1 }),
    },
    $transaction: async (fn: any) =>
      fn({
        agentToken: { updateMany: async () => ({ count: 1 }) },
        onChainAttestation: { updateMany: async () => ({ count: 1 }) },
      }),
  } as any;
}

function loadedRow(overrides: Partial<{
  tokenId: string;
  mintAddress: string;
  lastOnChainAttestationAt: Date | null;
  agentId: string;
  orgId: string;
}> = {}) {
  return {
    tokenId: "tok_1",
    mintAddress: makeMint(),
    lastOnChainAttestationAt: null,
    agentId: "agt_1",
    orgId: "org_1",
    ...overrides,
  };
}

function sampleAggregate() {
  return {
    uptimeSecondsDelta: BigInt(60),
    messageCountDelta: BigInt(3),
    score: 75,
    periodEnd: NOW,
  };
}

test("buildAttestationTickDeps: attestorAddress is the keypair pubkey base58", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  const kp = Keypair.generate();
  const deps = buildAttestationTickDeps({
    prisma: emptyPrisma(),
    connection: makeConn().connection as any,
    attestorKeypair: kp,
  });
  assert.equal(deps.attestorAddress, kp.publicKey.toBase58());
});

test("buildAttestationTickDeps: loadAgents delegates to the Prisma loader", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  const prisma = {
    ...emptyPrisma(),
    agentToken: {
      findMany: async () => [
        {
          id: "tok_X",
          mintAddress: "MintX",
          lastOnChainAttestationAt: null,
          agentListing: { agentId: "agt_X", agent: { orgId: "org_X" } },
        },
      ],
      updateMany: async () => ({ count: 1 }),
    },
  };
  const deps = buildAttestationTickDeps({
    prisma,
    connection: makeConn().connection as any,
    attestorKeypair: Keypair.generate(),
  });
  const rows = await deps.loadAgents({ now: NOW });
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as any).tokenId, "tok_X");
});

test("buildAttestationTickDeps: aggregate first-run uses default 6h lookback", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  let observedPeriodStart: Date | null = null;
  let observedPeriodEnd: Date | null = null;
  const prisma = {
    ...emptyPrisma(),
    agent: {
      findFirst: async ({ where }: any) => {
        // Caught here so we record the period start the loader queries with.
        return {
          id: where.id,
          orgId: where.orgId,
          deployments: [{ status: "ACTIVE", modelDeploymentId: "md_1" }],
        };
      },
    },
    usageRecord: {
      findMany: async (args: any) => {
        observedPeriodStart = args.where.periodEnd.gte;
        observedPeriodEnd = args.where.periodStart.lt;
        return [];
      },
    },
  };
  const deps = buildAttestationTickDeps({
    prisma,
    connection: makeConn().connection as any,
    attestorKeypair: Keypair.generate(),
  });
  await deps.aggregate(loadedRow(), { now: NOW });
  const startedAt = observedPeriodStart as Date | null;
  const endedAt = observedPeriodEnd as Date | null;
  assert.ok(startedAt && startedAt.getTime());
  assert.ok(endedAt && endedAt.getTime());
  const lookbackMs = NOW.getTime() - startedAt!.getTime();
  // ~ 6h ± slop (no slop, set exactly to 6h)
  assert.equal(lookbackMs, 6 * 60 * 60 * 1000);
  assert.equal(endedAt!.getTime(), NOW.getTime());
});

test("buildAttestationTickDeps: aggregate subsequent runs use lastOnChainAttestationAt as periodStart", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  const lastCursor = new Date(NOW.getTime() - 30 * 60 * 1000); // 30 min ago
  let observedStart: Date | null = null;
  const prisma = {
    ...emptyPrisma(),
    agent: {
      findFirst: async ({ where }: any) => ({
        id: where.id,
        orgId: where.orgId,
        deployments: [{ status: "ACTIVE", modelDeploymentId: "md_1" }],
      }),
    },
    usageRecord: {
      findMany: async (args: any) => {
        observedStart = args.where.periodEnd.gte;
        return [];
      },
    },
  };
  const deps = buildAttestationTickDeps({
    prisma,
    connection: makeConn().connection as any,
    attestorKeypair: Keypair.generate(),
  });
  await deps.aggregate(
    loadedRow({ lastOnChainAttestationAt: lastCursor }),
    { now: NOW },
  );
  assert.equal((observedStart as Date | null)?.getTime(), lastCursor.getTime());
});

test("buildAttestationTickDeps: aggregate with empty usage records returns zero deltas", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  const prisma = {
    ...emptyPrisma(),
    agent: {
      findFirst: async ({ where }: any) => ({
        id: where.id,
        orgId: where.orgId,
        deployments: [{ status: "ACTIVE", modelDeploymentId: "md_1" }],
      }),
    },
    usageRecord: { findMany: async () => [] },
  };
  const deps = buildAttestationTickDeps({
    prisma,
    connection: makeConn().connection as any,
    attestorKeypair: Keypair.generate(),
  });
  const r = await deps.aggregate(loadedRow(), { now: NOW });
  assert.ok(r);
  assert.equal(r!.uptimeSecondsDelta, BigInt(0));
  assert.equal(r!.messageCountDelta, BigInt(0));
});

test("buildAttestationTickDeps: aggregate sums computeSeconds + requestCount", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  const prisma = {
    ...emptyPrisma(),
    agent: {
      findFirst: async ({ where }: any) => ({
        id: where.id,
        orgId: where.orgId,
        deployments: [{ status: "ACTIVE", modelDeploymentId: "md_1" }],
      }),
    },
    usageRecord: {
      findMany: async () => [
        {
          periodStart: new Date(NOW.getTime() - 30 * 60 * 1000),
          periodEnd: new Date(NOW.getTime() - 25 * 60 * 1000),
          requestCount: 5,
          errorCount: 0,
          computeSeconds: BigInt(300),
        },
        {
          periodStart: new Date(NOW.getTime() - 20 * 60 * 1000),
          periodEnd: new Date(NOW.getTime() - 15 * 60 * 1000),
          requestCount: 7,
          errorCount: 1,
          computeSeconds: BigInt(420),
        },
      ],
    },
  };
  const deps = buildAttestationTickDeps({
    prisma,
    connection: makeConn().connection as any,
    attestorKeypair: Keypair.generate(),
  });
  const r = await deps.aggregate(loadedRow(), { now: NOW });
  assert.equal(r!.uptimeSecondsDelta, BigInt(720));
  assert.equal(r!.messageCountDelta, BigInt(12));
  assert.equal(r!.periodEnd.getTime(), NOW.getTime());
  assert.ok(r!.score >= 0 && r!.score <= 100);
  assert.ok(Number.isInteger(r!.score));
});

test("buildAttestationTickDeps: aggregate returns null when periodEnd <= periodStart", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  const deps = buildAttestationTickDeps({
    prisma: emptyPrisma(),
    connection: makeConn().connection as any,
    attestorKeypair: Keypair.generate(),
  });
  // lastCursor = now → no window
  const r = await deps.aggregate(
    loadedRow({ lastOnChainAttestationAt: NOW }),
    { now: NOW },
  );
  assert.equal(r, null);
});

test("buildAttestationTickDeps: initialLookbackMs override is honored", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  let observedStart: Date | null = null;
  const prisma = {
    ...emptyPrisma(),
    agent: {
      findFirst: async ({ where }: any) => ({
        id: where.id,
        orgId: where.orgId,
        deployments: [{ status: "ACTIVE", modelDeploymentId: "md_1" }],
      }),
    },
    usageRecord: {
      findMany: async (args: any) => {
        observedStart = args.where.periodEnd.gte;
        return [];
      },
    },
  };
  const deps = buildAttestationTickDeps({
    prisma,
    connection: makeConn().connection as any,
    attestorKeypair: Keypair.generate(),
    initialLookbackMs: 60_000, // 1 minute
  });
  await deps.aggregate(loadedRow(), { now: NOW });
  const started = observedStart as Date | null;
  assert.ok(started);
  assert.equal(NOW.getTime() - started!.getTime(), 60_000);
});

// ============================================
// prepare: sign-only — NO broadcast
// ============================================

test("buildAttestationTickDeps: prepare signs the attestation WITHOUT broadcasting", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  const { sent, connection } = makeConn();
  const deps = buildAttestationTickDeps({
    prisma: emptyPrisma(),
    connection: connection as any,
    attestorKeypair: Keypair.generate(),
  });
  const artifact = await deps.prepare(loadedRow() as any, sampleAggregate());
  assert.ok(artifact.txSignature.length > 0);
  assert.equal(artifact.lastValidBlockHeight, 100n);
  assert.ok(Buffer.from(artifact.signedTxB64, "base64").length > 0);
  assert.equal(
    sent.length,
    0,
    "prepare must NEVER broadcast — persistIntent records the artifact first",
  );
});

// ============================================
// persistIntent: the SUBMITTED mirror row (claim-first INSERT)
// ============================================

test("buildAttestationTickDeps: persistIntent inserts the SUBMITTED mirror with artifacts and NULL confirmation fields", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  let createdWith: any = null;
  const prisma = {
    ...emptyPrisma(),
    onChainAttestation: {
      findMany: async () => [],
      create: async (a: any) => {
        createdWith = a.data;
        return { id: "mirror_42" };
      },
      updateMany: async () => ({ count: 1 }),
    },
  };
  const kp = Keypair.generate();
  const deps = buildAttestationTickDeps({
    prisma,
    connection: makeConn().connection as any,
    attestorKeypair: kp,
  });
  const artifact = {
    txSignature: "sigX",
    lastValidBlockHeight: 900n,
    signedTxB64: "Ynl0ZXM=",
  };
  const mirrorId = await deps.persistIntent(
    loadedRow() as any,
    sampleAggregate(),
    artifact,
    kp.publicKey.toBase58(),
  );
  assert.equal(mirrorId, "mirror_42");
  assert.equal(createdWith.tokenId, "tok_1");
  assert.equal(createdWith.txSignature, "sigX");
  assert.equal(createdWith.attestorAddress, kp.publicKey.toBase58());
  assert.equal(createdWith.score, 75);
  assert.equal(
    createdWith.attestorUnixTs,
    BigInt(Math.floor(NOW.getTime() / 1000)),
  );
  assert.equal(createdWith.status, "SUBMITTED");
  assert.equal(createdWith.signedTxB64, "Ynl0ZXM=");
  assert.equal(createdWith.lastValidBlockHeight, 900n);
  // Confirmation-time facts must be NULL on the intent row.
  assert.equal(createdWith.observedAt, null);
  assert.equal(createdWith.cumulativeUptimeSeconds, null);
  assert.equal(createdWith.cumulativeMessageCount, null);
  assert.equal(createdWith.attestationCount, null);
});

// ============================================
// persistMirrorConfirmed / persistMirrorFailed
// ============================================

test("buildAttestationTickDeps: persistMirrorConfirmed runs the mirror CAS (observedAt stamped) then the cursor", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  let mirrorWith: any = null;
  let cursorWith: any = null;
  const prisma = {
    ...emptyPrisma(),
    $transaction: async (fn: any) =>
      fn({
        onChainAttestation: {
          updateMany: async (a: any) => {
            mirrorWith = a;
            return { count: 1 };
          },
        },
        agentToken: {
          updateMany: async (a: any) => {
            cursorWith = a;
            return { count: 1 };
          },
        },
      }),
  };
  const deps = buildAttestationTickDeps({
    prisma,
    connection: makeConn().connection as any,
    attestorKeypair: Keypair.generate(),
    now: () => OBSERVED,
  });
  await deps.persistMirrorConfirmed({
    mirrorId: "mirror_42",
    tokenId: "tok_1",
    cursor: NOW,
    cumulatives: {
      cumulativeUptimeSeconds: BigInt(7200),
      cumulativeMessageCount: BigInt(24),
      attestationCount: 2,
    },
  });
  assert.deepEqual(mirrorWith.where, { id: "mirror_42", status: "SUBMITTED" });
  assert.equal(mirrorWith.data.status, "CONFIRMED");
  // observedAt = the injected wall clock — confirmation-observation time.
  assert.equal(mirrorWith.data.observedAt, OBSERVED);
  assert.equal(mirrorWith.data.cumulativeUptimeSeconds, BigInt(7200));
  assert.equal(cursorWith.where.id, "tok_1");
  assert.deepEqual(cursorWith.data, { lastOnChainAttestationAt: NOW });
});

test("buildAttestationTickDeps: persistMirrorFailed CASes SUBMITTED→FAILED and leaves the cursor alone", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  let failedWith: any = null;
  let cursorTouched = 0;
  const prisma = {
    ...emptyPrisma(),
    agentToken: {
      findMany: async () => [],
      updateMany: async () => {
        cursorTouched += 1;
        return { count: 1 };
      },
    },
    onChainAttestation: {
      findMany: async () => [],
      create: async () => ({ id: "x" }),
      updateMany: async (a: any) => {
        failedWith = a;
        return { count: 1 };
      },
    },
  };
  const deps = buildAttestationTickDeps({
    prisma,
    connection: makeConn().connection as any,
    attestorKeypair: Keypair.generate(),
  });
  await deps.persistMirrorFailed("mirror_42");
  assert.deepEqual(failedWith.where, { id: "mirror_42", status: "SUBMITTED" });
  assert.deepEqual(failedWith.data, { status: "FAILED" });
  assert.equal(cursorTouched, 0, "a FAILED mirror must never advance the cursor");
});

// ============================================
// Recovery wiring: loadSubmittedMirrors + chain evidence
// ============================================

test("buildAttestationTickDeps: loadSubmittedMirrors queries the SUBMITTED backlog with the token mint", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  let queryWith: any = null;
  const prisma = {
    ...emptyPrisma(),
    onChainAttestation: {
      findMany: async (a: any) => {
        queryWith = a;
        return [
          {
            id: "m1",
            tokenId: "tok_1",
            txSignature: "sig_1",
            lastValidBlockHeight: 900n,
            signedTxB64: "bytes_1",
            attestorUnixTs: BigInt(1_700_000_000),
            token: { mintAddress: "MintZ" },
          },
        ];
      },
      create: async () => ({ id: "x" }),
      updateMany: async () => ({ count: 1 }),
    },
  };
  const deps = buildAttestationTickDeps({
    prisma,
    connection: makeConn().connection as any,
    attestorKeypair: Keypair.generate(),
  });
  const rows = await deps.loadSubmittedMirrors({ now: NOW });
  assert.deepEqual(queryWith.where, { status: "SUBMITTED" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "m1");
  assert.equal(rows[0]!.mintAddress, "MintZ");
  assert.equal(rows[0]!.signedTxB64, "bytes_1");
});

test("buildAttestationTickDeps: getCurrentBlockHeight/getSignatureStatus wire the evidence RPCs", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  const conn = makeConn({
    blockHeight: 777,
    signatureStatusValue: { confirmationStatus: "finalized", err: null },
  });
  const deps = buildAttestationTickDeps({
    prisma: emptyPrisma(),
    connection: conn.connection as any,
    attestorKeypair: Keypair.generate(),
  });

  assert.equal(await deps.getCurrentBlockHeight(), 777n);
  const head = conn.log.find((c) => c.type === "getBlockHeight");
  assert.equal(head.commitment, "confirmed");

  const status = await deps.getSignatureStatus("sig_x");
  assert.deepEqual(status, { confirmationStatus: "finalized", err: null });
  const query = conn.log.find((c) => c.type === "getSignatureStatuses");
  assert.deepEqual(query.sigs, ["sig_x"]);
  // Recovery must see dropped-but-old signatures too.
  assert.equal(query.cfg.searchTransactionHistory, true);
});

test("buildAttestationTickDeps: broadcast decodes base64 and hits sendRawTransaction", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  const { sent, connection } = makeConn();
  const deps = buildAttestationTickDeps({
    prisma: emptyPrisma(),
    connection: connection as any,
    attestorKeypair: Keypair.generate(),
  });
  await deps.broadcast(Buffer.from("exact bytes").toString("base64"));
  assert.equal(sent.length, 1);
  assert.equal(Buffer.from(sent[0]!).toString(), "exact bytes");
});

// ============================================
// readCumulatives: AgentReputation PDA readback (program truth)
// ============================================

test("buildAttestationTickDeps: readCumulatives maps the on-chain AgentReputation PDA", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  // Hand-rolled AgentReputation account: discriminator + fixed layout.
  const data = Buffer.alloc(73);
  Buffer.from([245, 56, 239, 246, 36, 231, 227, 67]).copy(data, 0);
  new PublicKey(makeMint()).toBuffer().copy(data, 8);
  data.writeBigUInt64LE(BigInt(7200), 40); // cumulativeUptimeSeconds
  data.writeBigUInt64LE(BigInt(24), 48); // cumulativeMessageCount
  data.writeUInt32LE(80, 56); // lastScore
  data.writeBigInt64LE(BigInt(1_700_000_000), 60); // lastAttestationUnixTs
  data.writeUInt32LE(2, 68); // attestationCount
  data.writeUInt8(255, 72); // bump

  const conn = makeConn({ accountInfoData: data });
  const deps = buildAttestationTickDeps({
    prisma: emptyPrisma(),
    connection: conn.connection as any,
    attestorKeypair: Keypair.generate(),
  });
  const readback = await deps.readCumulatives(makeMint());
  assert.deepEqual(readback, {
    cumulativeUptimeSeconds: BigInt(7200),
    cumulativeMessageCount: BigInt(24),
    attestationCount: 2,
  });
});

test("buildAttestationTickDeps: readCumulatives returns null when the PDA is uninitialized", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  const conn = makeConn({ accountInfoData: null });
  const deps = buildAttestationTickDeps({
    prisma: emptyPrisma(),
    connection: conn.connection as any,
    attestorKeypair: Keypair.generate(),
  });
  assert.equal(await deps.readCumulatives(makeMint()), null);
});
