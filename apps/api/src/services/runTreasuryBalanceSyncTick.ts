/**
 * Treasury balance-sync tick (remediation D1).
 *
 * Pure scan-and-mirror driver: for every program-initialized treasury,
 * read the on-chain PDA lamports and mirror the SPENDABLE balance
 * (lamports minus the rent-exempt reserve, clamped at 0) into
 * AgentTreasury.solBalanceLamports, stamping balanceSyncedAt.
 *
 * This is the writer the settlement loop was missing: without it the
 * column stays at its default 0 and decideTreasurySettlement marks every
 * payment FAILED('insufficient_funds'). The settlement cycle runs this
 * tick as its FIRST step so decisions always see a fresh mirror, and
 * loadSettlementBatch skips any treasury whose mirror is stale — so a
 * failure here degrades to "skip", never "pay on garbage data".
 *
 * Per-row failure isolation:
 *   - a PDA string that fails base58 decoding is counted failed; the
 *     rest of the batch proceeds
 *   - a null account (closed / never funded) is NOT a failure: the
 *     mirror is fresh and the spendable balance is 0n
 *   - a thrown getBalances (RPC down) fails the whole batch: nothing
 *     is persisted, counters report every row failed, and the stale
 *     guard keeps settlement safe
 *
 * Side effects (Prisma reads/writes, RPC) are dependency-injected; see
 * buildTreasuryBalanceSyncTickDeps for the production wiring.
 */

import { PublicKey } from "@solana/web3.js";

export interface TreasuryForBalanceSync {
  treasuryId: string;
  treasuryPdaAddress: string;
}

export interface TreasuryBalanceRow {
  treasuryId: string;
  /** Spendable lamports: on-chain balance minus rent reserve, >= 0. */
  solBalanceLamports: bigint;
  syncedAt: Date;
}

export interface BalanceSyncTickInput {
  now: Date;
}

export interface BalanceSyncTickDeps {
  /** Treasuries with programInitialized=true (id + PDA address). */
  loadTreasuries: () => Promise<TreasuryForBalanceSync[]>;
  /** Lamports per PDA, aligned by index; null = account not found. */
  getBalances: (pdas: PublicKey[]) => Promise<(number | null)[]>;
  /** Rent-exempt reserve withheld from the spendable balance. Called
   * exactly once per tick (production fetches it from the RPC). */
  getRentReserveLamports: () => Promise<bigint>;
  /** Batched mirror write: solBalanceLamports + balanceSyncedAt per row. */
  persistBalances: (rows: TreasuryBalanceRow[]) => Promise<void>;
}

export interface BalanceSyncTickResult {
  synced: number;
  failed: number;
}

export async function runTreasuryBalanceSyncTick(
  input: BalanceSyncTickInput,
  deps: BalanceSyncTickDeps,
): Promise<BalanceSyncTickResult> {
  const treasuries = await deps.loadTreasuries();
  if (treasuries.length === 0) return { synced: 0, failed: 0 };

  const rentReserve = await deps.getRentReserveLamports();

  // Per-row isolation for the one piece of per-row parsing we do: a
  // corrupt stored PDA must not block every other treasury's sync.
  let failed = 0;
  const valid: Array<{ treasuryId: string; pda: PublicKey }> = [];
  for (const t of treasuries) {
    try {
      valid.push({ treasuryId: t.treasuryId, pda: new PublicKey(t.treasuryPdaAddress) });
    } catch {
      failed += 1;
    }
  }
  if (valid.length === 0) return { synced: 0, failed };

  let balances: (number | null)[];
  try {
    balances = await deps.getBalances(valid.map((v) => v.pda));
  } catch {
    // RPC unreachable: nothing was synced this tick. The settlement
    // loader's staleness guard turns this into "skip", not "pay".
    return { synced: 0, failed: failed + valid.length };
  }

  const rows: TreasuryBalanceRow[] = [];
  for (let i = 0; i < valid.length; i++) {
    const entry = valid[i]!;
    const lamports = balances[i];
    if (lamports === undefined) {
      // getBalances returned fewer entries than PDAs — treat the
      // missing tail as failed rather than guessing.
      failed += 1;
      continue;
    }
    if (lamports === null) {
      // Account doesn't exist on chain: spendable balance is zero but
      // the mirror IS fresh — settlement must see 0n, not skip-stale.
      rows.push({
        treasuryId: entry.treasuryId,
        solBalanceLamports: 0n,
        syncedAt: input.now,
      });
      continue;
    }
    const spendable = BigInt(Math.max(0, Math.trunc(lamports))) - rentReserve;
    rows.push({
      treasuryId: entry.treasuryId,
      solBalanceLamports: spendable > 0n ? spendable : 0n,
      syncedAt: input.now,
    });
  }

  if (rows.length > 0) {
    // Persist failures bubble: a half-written mirror with fresh
    // balanceSyncedAt timestamps must not be reported as success.
    await deps.persistBalances(rows);
  }

  return { synced: rows.length, failed };
}
