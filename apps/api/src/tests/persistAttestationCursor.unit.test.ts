/**
 * Drives apps/api/src/services/persistAttestationCursor.ts.
 *
 * Pinning:
 *   - cursor UPDATE + mirror INSERT run inside the same prisma.$transaction
 *   - count==0 from the cursor UPDATE skips the mirror INSERT (stale-tick
 *     guard avoids an orphan attestation row without a cursor bump)
 *   - WHERE clause filters by id + OR(null, lt:cursor) — the progression guard
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

const NOW = new Date("2026-05-14T10:00:00Z");

function happyMirror() {
  return {
    tokenId: "tok_1",
    txSignature: "sig_a",
    attestorAddress: "ATT",
    uptimeSecondsDelta: BigInt(3600),
    messageCountDelta: BigInt(12),
    score: 80,
    cumulativeUptimeSeconds: BigInt(3600),
    cumulativeMessageCount: BigInt(12),
    attestationCount: 1,
    attestorUnixTs: BigInt(1_700_000_000),
  };
}

test("persistAttestationCursor: cursor UPDATE WHERE uses id + progression guard", async () => {
  setupEnv();
  const { persistAttestationCursor } = await import(
    "../services/persistAttestationCursor.js"
  );
  let observed: any = null;
  await persistAttestationCursor(
    { tokenId: "tok_1", cursor: NOW, mirror: happyMirror() },
    {
      prisma: {
        $transaction: async (fn: any) =>
          fn({
            agentToken: {
              updateMany: async (args: any) => {
                observed = args;
                return { count: 1 };
              },
            },
            onChainAttestation: {
              create: async () => ({}),
            },
          }),
      } as any,
    },
  );
  assert.equal(observed.where.id, "tok_1");
  assert.deepEqual(observed.where.OR, [
    { lastOnChainAttestationAt: null },
    { lastOnChainAttestationAt: { lt: NOW } },
  ]);
  assert.deepEqual(observed.data, { lastOnChainAttestationAt: NOW });
});

test("persistAttestationCursor: count=0 from UPDATE → mirror INSERT is SKIPPED", async () => {
  setupEnv();
  const { persistAttestationCursor } = await import(
    "../services/persistAttestationCursor.js"
  );
  let inserted = 0;
  await persistAttestationCursor(
    { tokenId: "tok_1", cursor: NOW, mirror: happyMirror() },
    {
      prisma: {
        $transaction: async (fn: any) =>
          fn({
            agentToken: {
              updateMany: async () => ({ count: 0 }),
            },
            onChainAttestation: {
              create: async () => {
                inserted += 1;
                return {};
              },
            },
          }),
      } as any,
    },
  );
  assert.equal(inserted, 0);
});

test("persistAttestationCursor: count=1 from UPDATE → mirror row inserted with the input shape", async () => {
  setupEnv();
  const { persistAttestationCursor } = await import(
    "../services/persistAttestationCursor.js"
  );
  let createdWith: any = null;
  const mirror = happyMirror();
  await persistAttestationCursor(
    { tokenId: "tok_1", cursor: NOW, mirror },
    {
      prisma: {
        $transaction: async (fn: any) =>
          fn({
            agentToken: {
              updateMany: async () => ({ count: 1 }),
            },
            onChainAttestation: {
              create: async (args: any) => {
                createdWith = args.data;
                return {};
              },
            },
          }),
      } as any,
    },
  );
  assert.deepEqual(createdWith, mirror);
});

test("persistAttestationCursor: cursor + mirror run inside the same prisma.$transaction", async () => {
  setupEnv();
  const { persistAttestationCursor } = await import(
    "../services/persistAttestationCursor.js"
  );
  let inTransaction = false;
  let cursorRanInTx = false;
  let mirrorRanInTx = false;
  await persistAttestationCursor(
    { tokenId: "tok_1", cursor: NOW, mirror: happyMirror() },
    {
      prisma: {
        $transaction: async (fn: any) => {
          inTransaction = true;
          try {
            return await fn({
              agentToken: {
                updateMany: async () => {
                  cursorRanInTx = inTransaction;
                  return { count: 1 };
                },
              },
              onChainAttestation: {
                create: async () => {
                  mirrorRanInTx = inTransaction;
                  return {};
                },
              },
            });
          } finally {
            inTransaction = false;
          }
        },
      } as any,
    },
  );
  assert.equal(cursorRanInTx, true);
  assert.equal(mirrorRanInTx, true);
});

test("persistAttestationCursor: prisma.$transaction throw propagates", async () => {
  setupEnv();
  const { persistAttestationCursor } = await import(
    "../services/persistAttestationCursor.js"
  );
  await assert.rejects(
    () =>
      persistAttestationCursor(
        { tokenId: "tok_1", cursor: NOW, mirror: happyMirror() },
        {
          prisma: {
            $transaction: async () => {
              throw new Error("connection lost");
            },
          } as any,
        },
      ),
    /connection lost/,
  );
});
