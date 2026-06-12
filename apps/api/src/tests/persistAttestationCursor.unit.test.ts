/**
 * Drives apps/api/src/services/persistAttestationCursor.ts — the atomic
 * CONFIRM writer for the reputation-attestation worker (confirmation
 * discipline, remediation D6b).
 *
 * Pinning:
 *   - mirror CAS (SUBMITTED→CONFIRMED) + cursor UPDATE run inside the
 *     same prisma.$transaction
 *   - the mirror CAS comes FIRST (ownership claim); count==0 → the
 *     cursor write is SKIPPED entirely (a lost race touches nothing)
 *   - the mirror CAS writes observedAt (confirmation-observation time)
 *     and the PDA-readback cumulatives; null readback stays null
 *     (truthful unknown — never delta-derived)
 *   - cursor WHERE filters by id + OR(null, lt:cursor) — the
 *     progression guard, so an old window confirming late can never
 *     rewind a newer cursor
 *   - $transaction throw propagates
 */

import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

const CURSOR = new Date("2026-05-14T10:00:00Z");
const OBSERVED_AT = new Date("2026-05-14T10:00:07Z");

const CUMULATIVES = {
  cumulativeUptimeSeconds: BigInt(7200),
  cumulativeMessageCount: BigInt(24),
  attestationCount: 2,
};

function happyInput(overrides: Partial<{
  mirrorId: string;
  tokenId: string;
  cursor: Date;
  observedAt: Date;
  cumulatives: typeof CUMULATIVES | null;
}> = {}) {
  return {
    mirrorId: "mirror_1",
    tokenId: "tok_1",
    cursor: CURSOR,
    observedAt: OBSERVED_AT,
    cumulatives: CUMULATIVES,
    ...overrides,
  };
}

function makePrisma(opts: { mirrorCasCount?: number } = {}) {
  const log: any[] = [];
  const prisma = {
    $transaction: async (fn: any) =>
      fn({
        onChainAttestation: {
          updateMany: async (args: any) => {
            log.push({ type: "mirror.updateMany", args });
            return { count: opts.mirrorCasCount ?? 1 };
          },
        },
        agentToken: {
          updateMany: async (args: any) => {
            log.push({ type: "cursor.updateMany", args });
            return { count: 1 };
          },
        },
      }),
  };
  return { log, prisma };
}

test("persistAttestationCursor: mirror CAS targets id + status=SUBMITTED and writes observedAt + cumulatives", async () => {
  setupEnv();
  const { persistAttestationCursor } = await import(
    "../services/persistAttestationCursor.js"
  );
  const { log, prisma } = makePrisma({});
  await persistAttestationCursor(happyInput(), { prisma: prisma as any });

  const mirror = log.find((c) => c.type === "mirror.updateMany");
  assert.deepEqual(mirror.args.where, { id: "mirror_1", status: "SUBMITTED" });
  assert.deepEqual(mirror.args.data, {
    status: "CONFIRMED",
    // observedAt is stamped at CONFIRMATION time — when we saw the
    // landing, not when we broadcast.
    observedAt: OBSERVED_AT,
    // Cumulatives are the AgentReputation PDA readback (program truth).
    cumulativeUptimeSeconds: BigInt(7200),
    cumulativeMessageCount: BigInt(24),
    attestationCount: 2,
  });
});

test("persistAttestationCursor: cursor UPDATE WHERE uses id + progression guard", async () => {
  setupEnv();
  const { persistAttestationCursor } = await import(
    "../services/persistAttestationCursor.js"
  );
  const { log, prisma } = makePrisma({});
  await persistAttestationCursor(happyInput(), { prisma: prisma as any });

  const cursor = log.find((c) => c.type === "cursor.updateMany");
  assert.equal(cursor.args.where.id, "tok_1");
  assert.deepEqual(cursor.args.where.OR, [
    { lastOnChainAttestationAt: null },
    { lastOnChainAttestationAt: { lt: CURSOR } },
  ]);
  assert.deepEqual(cursor.args.data, { lastOnChainAttestationAt: CURSOR });
});

test("persistAttestationCursor: mirror CAS count=0 (lost race) → cursor write SKIPPED", async () => {
  // The cursor advances ONLY for the worker that won the
  // SUBMITTED→CONFIRMED claim — a lost race must touch nothing.
  setupEnv();
  const { persistAttestationCursor } = await import(
    "../services/persistAttestationCursor.js"
  );
  const { log, prisma } = makePrisma({ mirrorCasCount: 0 });
  await persistAttestationCursor(happyInput(), { prisma: prisma as any });
  assert.equal(log.filter((c) => c.type === "cursor.updateMany").length, 0);
});

test("persistAttestationCursor: null readback → cumulative columns persisted as null (truthful unknown)", async () => {
  setupEnv();
  const { persistAttestationCursor } = await import(
    "../services/persistAttestationCursor.js"
  );
  const { log, prisma } = makePrisma({});
  await persistAttestationCursor(happyInput({ cumulatives: null }), {
    prisma: prisma as any,
  });
  const mirror = log.find((c) => c.type === "mirror.updateMany");
  assert.equal(mirror.args.data.cumulativeUptimeSeconds, null);
  assert.equal(mirror.args.data.cumulativeMessageCount, null);
  assert.equal(mirror.args.data.attestationCount, null);
  // Still CONFIRMED with observedAt — only the readback is unknown.
  assert.equal(mirror.args.data.status, "CONFIRMED");
  assert.equal(mirror.args.data.observedAt, OBSERVED_AT);
});

test("persistAttestationCursor: mirror CAS + cursor run inside the same prisma.$transaction", async () => {
  setupEnv();
  const { persistAttestationCursor } = await import(
    "../services/persistAttestationCursor.js"
  );
  let inTransaction = false;
  let mirrorRanInTx = false;
  let cursorRanInTx = false;
  await persistAttestationCursor(happyInput(), {
    prisma: {
      $transaction: async (fn: any) => {
        inTransaction = true;
        try {
          return await fn({
            onChainAttestation: {
              updateMany: async () => {
                mirrorRanInTx = inTransaction;
                return { count: 1 };
              },
            },
            agentToken: {
              updateMany: async () => {
                cursorRanInTx = inTransaction;
                return { count: 1 };
              },
            },
          });
        } finally {
          inTransaction = false;
        }
      },
    } as any,
  });
  assert.equal(mirrorRanInTx, true);
  assert.equal(cursorRanInTx, true);
});

test("persistAttestationCursor: mirror CAS runs BEFORE the cursor write (ownership claim first)", async () => {
  setupEnv();
  const { persistAttestationCursor } = await import(
    "../services/persistAttestationCursor.js"
  );
  const { log, prisma } = makePrisma({});
  await persistAttestationCursor(happyInput(), { prisma: prisma as any });
  const order = log.map((c) => c.type);
  assert.deepEqual(order, ["mirror.updateMany", "cursor.updateMany"]);
});

test("persistAttestationCursor: prisma.$transaction throw propagates", async () => {
  setupEnv();
  const { persistAttestationCursor } = await import(
    "../services/persistAttestationCursor.js"
  );
  await assert.rejects(
    () =>
      persistAttestationCursor(happyInput(), {
        prisma: {
          $transaction: async () => {
            throw new Error("connection lost");
          },
        } as any,
      }),
    /connection lost/,
  );
});
