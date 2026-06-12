/**
 * Drives apps/api/src/services/buildTreasuryBalanceSyncTickDeps.ts — the
 * composition root binding runTreasuryBalanceSyncTick to Prisma + RPC
 * (remediation D1).
 *
 * Wiring under test:
 *   loadTreasuries        → prisma.agentTreasury.findMany(programInitialized)
 *   getBalances           → connection.getMultipleAccountsInfo in chunks
 *                           of 100 (the RPC method's hard limit)
 *   getRentReserveLamports→ getMinimumBalanceForRentExemption(153) as BigInt
 *   persistBalances       → prisma.agentTreasury.updateMany per row
 */

import assert from "node:assert/strict";
import test from "node:test";

import { PublicKey } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

const PDA_A = "So11111111111111111111111111111111111111112";

function makeStubs(opts: {
  treasuryRows?: Array<{ id: string; treasuryPdaAddress: string }>;
  lamportsPerAccount?: number | null;
  rentExemptMinimum?: number;
} = {}) {
  const log: any[] = [];
  const prisma = {
    agentTreasury: {
      async findMany(args: any) {
        log.push({ type: "findMany", args });
        return opts.treasuryRows ?? [];
      },
      async updateMany(args: any) {
        log.push({ type: "updateMany", args });
        return { count: 1 };
      },
    },
  };
  const connection = {
    async getMultipleAccountsInfo(pdas: PublicKey[]) {
      log.push({ type: "getMultipleAccountsInfo", count: pdas.length });
      return pdas.map(() =>
        opts.lamportsPerAccount === null
          ? null
          : { lamports: opts.lamportsPerAccount ?? 2_000_000 },
      );
    },
    async getMinimumBalanceForRentExemption(space: number) {
      log.push({ type: "getMinimumBalanceForRentExemption", space });
      return opts.rentExemptMinimum ?? 1_500_000;
    },
  };
  return { log, prisma, connection };
}

test("buildTreasuryBalanceSyncTickDeps loadTreasuries queries programInitialized treasuries and maps id → treasuryId", async () => {
  setupEnv();
  const { buildTreasuryBalanceSyncTickDeps } = await import(
    "../services/buildTreasuryBalanceSyncTickDeps.js"
  );
  const stubs = makeStubs({
    treasuryRows: [{ id: "t_1", treasuryPdaAddress: PDA_A }],
  });
  const deps = buildTreasuryBalanceSyncTickDeps({
    prisma: stubs.prisma as any,
    connection: stubs.connection as any,
  });
  const rows = await deps.loadTreasuries();
  const call = stubs.log.find((c) => c.type === "findMany")!;
  assert.equal(call.args.where.programInitialized, true);
  assert.deepEqual(rows, [{ treasuryId: "t_1", treasuryPdaAddress: PDA_A }]);
});

test("buildTreasuryBalanceSyncTickDeps getBalances chunks getMultipleAccountsInfo at 100 pubkeys per call", async () => {
  const { buildTreasuryBalanceSyncTickDeps } = await import(
    "../services/buildTreasuryBalanceSyncTickDeps.js"
  );
  const stubs = makeStubs({ lamportsPerAccount: 42 });
  const deps = buildTreasuryBalanceSyncTickDeps({
    prisma: stubs.prisma as any,
    connection: stubs.connection as any,
  });
  const pdas = Array.from({ length: 250 }, () => new PublicKey(PDA_A));
  const balances = await deps.getBalances(pdas);
  assert.equal(balances.length, 250);
  assert.ok(balances.every((b) => b === 42));
  const calls = stubs.log.filter((c) => c.type === "getMultipleAccountsInfo");
  assert.deepEqual(
    calls.map((c) => c.count),
    [100, 100, 50],
  );
});

test("buildTreasuryBalanceSyncTickDeps getBalances maps missing accounts to null", async () => {
  const { buildTreasuryBalanceSyncTickDeps } = await import(
    "../services/buildTreasuryBalanceSyncTickDeps.js"
  );
  const stubs = makeStubs({ lamportsPerAccount: null });
  const deps = buildTreasuryBalanceSyncTickDeps({
    prisma: stubs.prisma as any,
    connection: stubs.connection as any,
  });
  const balances = await deps.getBalances([new PublicKey(PDA_A)]);
  assert.deepEqual(balances, [null]);
});

test("buildTreasuryBalanceSyncTickDeps getRentReserveLamports converts the Treasury-size minimum to BigInt", async () => {
  const { buildTreasuryBalanceSyncTickDeps } = await import(
    "../services/buildTreasuryBalanceSyncTickDeps.js"
  );
  const stubs = makeStubs({ rentExemptMinimum: 1_950_000 });
  const deps = buildTreasuryBalanceSyncTickDeps({
    prisma: stubs.prisma as any,
    connection: stubs.connection as any,
  });
  const reserve = await deps.getRentReserveLamports();
  assert.equal(reserve, 1_950_000n);
  const call = stubs.log.find(
    (c) => c.type === "getMinimumBalanceForRentExemption",
  )!;
  // Treasury::SIZE from the agent-treasury Anchor program.
  assert.equal(call.space, 153);
});

test("buildTreasuryBalanceSyncTickDeps persistBalances writes solBalanceLamports + balanceSyncedAt per row", async () => {
  const { buildTreasuryBalanceSyncTickDeps } = await import(
    "../services/buildTreasuryBalanceSyncTickDeps.js"
  );
  const stubs = makeStubs();
  const deps = buildTreasuryBalanceSyncTickDeps({
    prisma: stubs.prisma as any,
    connection: stubs.connection as any,
  });
  const syncedAt = new Date("2026-04-26T12:00:00Z");
  await deps.persistBalances([
    { treasuryId: "t_1", solBalanceLamports: 500_000n, syncedAt },
  ]);
  const call = stubs.log.find((c) => c.type === "updateMany")!;
  assert.equal(call.args.where.id, "t_1");
  assert.equal(call.args.data.solBalanceLamports, 500_000n);
  assert.equal(
    (call.args.data.balanceSyncedAt as Date).toISOString(),
    syncedAt.toISOString(),
  );
});
