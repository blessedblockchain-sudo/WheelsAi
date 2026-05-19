/**
 * Drives apps/api/src/services/persistFeeRouterCursor.ts —
 * conditional-update writer that bumps AgentTreasury.lastFeeRoutedAt.
 *
 * Conditional clause: `WHERE id = X AND (lastFeeRoutedAt IS NULL OR
 * lastFeeRoutedAt < newCursor)`. This guards against a stale tick
 * regressing the cursor: if two ticks somehow run concurrently and
 * the second tries to write an older timestamp, the WHERE clause
 * filters it out.
 */

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

function makePrismaStub(opts: { matchCount?: number } = {}) {
  const log: any[] = [];
  return {
    log,
    prisma: {
      agentTreasury: {
        async updateMany(args: any) {
          log.push({ type: "updateMany", args });
          return { count: opts.matchCount ?? 1 };
        },
      },
    },
  };
}

test("persistFeeRouterCursor issues updateMany with id + cursor-progression guard", async () => {
  setupEnv();
  const { persistFeeRouterCursor } = await import(
    "../services/persistFeeRouterCursor.js"
  );
  const stub = makePrismaStub({});
  const cursor = new Date("2026-04-26T11:30:00Z");
  await persistFeeRouterCursor("treas_a", cursor, {
    prisma: stub.prisma as any,
  });

  const update = stub.log.find((c) => c.type === "updateMany");
  assert.equal(update.args.where.id, "treas_a");
  // Stale-cursor guard: only update if NULL or older than the new cursor
  assert.deepEqual(update.args.where.OR, [
    { lastFeeRoutedAt: null },
    { lastFeeRoutedAt: { lt: cursor } },
  ]);
  assert.deepEqual(update.args.data, { lastFeeRoutedAt: cursor });
});

test("persistFeeRouterCursor: no-op when count=0 (cursor already ahead)", async () => {
  // A concurrent tick already advanced the cursor past our value.
  // Not an error — just a no-op. We don't throw because the more-recent
  // cursor is correct.
  setupEnv();
  const { persistFeeRouterCursor } = await import(
    "../services/persistFeeRouterCursor.js"
  );
  const stub = makePrismaStub({ matchCount: 0 });
  await persistFeeRouterCursor("treas_a", new Date(), {
    prisma: stub.prisma as any,
  });
  // Did not throw — that's the point.
});
