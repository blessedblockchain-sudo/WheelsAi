/**
 * Composition root for the treasury balance-sync tick (D1).
 *
 * Wires:
 *   loadTreasuriesForBalanceSyncByPrisma → loadTreasuries
 *   connection.getMultipleAccountsInfo   → getBalances (chunks of 100,
 *                                          the RPC method's hard limit)
 *   getMinimumBalanceForRentExemption    → getRentReserveLamports
 *                                          (Treasury::SIZE = 153 bytes;
 *                                          the orchestrator calls this
 *                                          once per tick)
 *   persistTreasuryBalances              → persistBalances
 *
 * The settlement cycle builder (buildTreasurySettlementCycleDeps) uses
 * this to compose its syncBalances first-step; tests stub the tick deps
 * directly and never touch RPC or Prisma.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { Connection, PublicKey } from "@solana/web3.js";

import { loadTreasuriesForBalanceSyncByPrisma } from "./loadTreasuriesForBalanceSyncByPrisma.js";
import { persistTreasuryBalances } from "./persistTreasuryBalances.js";
import type { BalanceSyncTickDeps } from "./runTreasuryBalanceSyncTick.js";

/** getMultipleAccountsInfo accepts at most 100 pubkeys per call. */
const ACCOUNTS_PER_RPC_BATCH = 100;

/** Anchor Treasury account allocation (programs/agent-treasury: Treasury::SIZE).
 * Lamports below the rent-exempt minimum for this size are not spendable —
 * draining them would deallocate the PDA. */
const TREASURY_ACCOUNT_SPACE = 153;

type BalanceSyncPrismaSurface =
  | Pick<PrismaClient, "agentTreasury">
  | {
      agentTreasury: {
        findMany: (
          args: Prisma.AgentTreasuryFindManyArgs,
        ) => Promise<unknown[]>;
        updateMany: (
          args: Prisma.AgentTreasuryUpdateManyArgs,
        ) => Promise<{ count: number }>;
      };
    };

export type BalanceSyncConnection = Pick<
  Connection,
  "getMultipleAccountsInfo" | "getMinimumBalanceForRentExemption"
>;

export interface BuildTreasuryBalanceSyncTickDepsInput {
  prisma: BalanceSyncPrismaSurface;
  connection: BalanceSyncConnection;
}

export function buildTreasuryBalanceSyncTickDeps(
  input: BuildTreasuryBalanceSyncTickDepsInput,
): BalanceSyncTickDeps {
  return {
    loadTreasuries: () =>
      loadTreasuriesForBalanceSyncByPrisma({
        prisma: input.prisma as never,
      }),

    getBalances: async (pdas: PublicKey[]) => {
      const out: (number | null)[] = [];
      for (let i = 0; i < pdas.length; i += ACCOUNTS_PER_RPC_BATCH) {
        const chunk = pdas.slice(i, i + ACCOUNTS_PER_RPC_BATCH);
        const infos = await input.connection.getMultipleAccountsInfo(chunk);
        for (const info of infos) {
          out.push(info ? info.lamports : null);
        }
      }
      return out;
    },

    getRentReserveLamports: async () =>
      BigInt(
        await input.connection.getMinimumBalanceForRentExemption(
          TREASURY_ACCOUNT_SPACE,
        ),
      ),

    persistBalances: (rows) =>
      persistTreasuryBalances(rows, {
        prisma: input.prisma as never,
      }),
  };
}
