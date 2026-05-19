/**
 * Drives apps/api/src/services/buildAttestationTickDeps.ts — the full
 * wiring around the reputation-attestation worker.
 *
 * Pinning:
 *   - attestorAddress is the attestorKeypair pubkey base58
 *   - loadAgents delegates to the Prisma loader
 *   - aggregate: first run defaults to a 6h lookback window
 *   - aggregate: subsequent runs use lastOnChainAttestationAt as periodStart
 *   - aggregate: empty usage records → uptime/message deltas = 0
 *   - submit success returns ok+txSignature; mismatch keypair surfaces
 *     as a tagged "rpc_submit" failure (or the upstream guard, depending)
 *   - persistCursor invokes the underlying writer with the right shape
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

function makeMint() {
  return new PublicKey("So11111111111111111111111111111111111111112").toBase58();
}

function makeConn() {
  const sent: Uint8Array[] = [];
  return {
    sent,
    connection: {
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 100,
      }),
      sendRawTransaction: async (raw: Uint8Array) => {
        sent.push(raw);
        return "tx_sig_xxx";
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
    onChainAttestation: { create: async () => ({}) },
    $transaction: async (fn: any) =>
      fn({
        agentToken: { updateMany: async () => ({ count: 1 }) },
        onChainAttestation: { create: async () => ({}) },
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

test("buildAttestationTickDeps: persistCursor delegates to the writer with mirror payload", async () => {
  setupEnv();
  const { buildAttestationTickDeps } = await import(
    "../services/buildAttestationTickDeps.js"
  );
  let createdWith: any = null;
  let cursorWith: any = null;
  const prisma = {
    ...emptyPrisma(),
    $transaction: async (fn: any) =>
      fn({
        agentToken: {
          updateMany: async (a: any) => {
            cursorWith = a;
            return { count: 1 };
          },
        },
        onChainAttestation: {
          create: async (a: any) => {
            createdWith = a.data;
            return {};
          },
        },
      }),
  };
  const kp = Keypair.generate();
  const deps = buildAttestationTickDeps({
    prisma,
    connection: makeConn().connection as any,
    attestorKeypair: kp,
  });
  await deps.persistCursor(
    loadedRow() as any,
    {
      uptimeSecondsDelta: BigInt(60),
      messageCountDelta: BigInt(3),
      score: 75,
      periodEnd: NOW,
    },
    {
      ok: true,
      txSignature: "sigX",
      cumulativeUptimeSeconds: BigInt(60),
      cumulativeMessageCount: BigInt(3),
      attestationCount: 1,
    },
    kp.publicKey.toBase58(),
  );
  assert.equal(cursorWith.where.id, "tok_1");
  assert.equal(createdWith.txSignature, "sigX");
  assert.equal(createdWith.attestorAddress, kp.publicKey.toBase58());
  assert.equal(createdWith.score, 75);
  assert.equal(createdWith.attestorUnixTs, BigInt(Math.floor(NOW.getTime() / 1000)));
});

test("buildAttestationTickDeps: submit calls Solana RPC and returns the tx sig", async () => {
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
  const outcome = await deps.submit(
    loadedRow() as any,
    {
      uptimeSecondsDelta: BigInt(60),
      messageCountDelta: BigInt(3),
      score: 75,
      periodEnd: NOW,
    },
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.txSignature, "tx_sig_xxx");
  assert.equal(sent.length, 1);
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
