/**
 * Atomic batch-claim writer for the fee router — the row-identity
 * equivalent of claimPendingPayment (remediation D6a).
 *
 * In ONE Prisma interactive transaction:
 *   1. INSERT fee_routing_batches (status CLAIMED, lamports, tradeCount)
 *   2. UPDATE agent_token_trades
 *         SET fee_routing_batch_id = $batchId
 *       WHERE id IN ($tradeIds) AND fee_routing_batch_id IS NULL
 *
 * The `IS NULL` predicate is the compare-and-set: if another worker
 * (overlapping replica) stamped ANY of the selected trades first, the
 * update count comes up short. That partial claim must not survive — a
 * batch whose `lamports` was computed over N trades but which owns
 * fewer would over-pay the treasury. We THROW a sentinel inside the
 * transaction so Prisma rolls BOTH writes back (no batch row, stamps
 * restored), and the caller receives null: a BENIGN lost race — the
 * other worker routes those trades; ours rejoin a later batch.
 *
 * Any non-sentinel error (connection loss etc.) propagates — the tick
 * throws and BullMQ retries; a rolled-back claim left no state behind.
 */

export interface ClaimFeeRoutingBatchInput {
  treasuryId: string;
  tradeIds: string[];
  feeAmountLamports: bigint;
}

interface PrismaTxStub {
  feeRoutingBatch: {
    create: (args: {
      data: {
        treasuryId: string;
        status: "CLAIMED";
        lamports: bigint;
        tradeCount: number;
      };
    }) => Promise<{ id: string }>;
  };
  agentTokenTrade: {
    updateMany: (args: {
      where: { id: { in: string[] }; feeRoutingBatchId: null };
      data: { feeRoutingBatchId: string };
    }) => Promise<{ count: number }>;
  };
}

interface PrismaStub {
  $transaction: <T>(fn: (tx: PrismaTxStub) => Promise<T>) => Promise<T>;
}

export interface ClaimFeeRoutingBatchDeps {
  prisma: PrismaStub;
}

/** Sentinel thrown inside the $transaction to force a rollback on a
 * lost stamp race. Never escapes claimFeeRoutingBatch. */
class ClaimRaceLost extends Error {
  constructor() {
    super("fee_batch_claim_race_lost");
  }
}

export async function claimFeeRoutingBatch(
  input: ClaimFeeRoutingBatchInput,
  deps: ClaimFeeRoutingBatchDeps,
): Promise<string | null> {
  if (input.tradeIds.length === 0) return null;

  try {
    return await deps.prisma.$transaction(async (tx) => {
      const batch = await tx.feeRoutingBatch.create({
        data: {
          treasuryId: input.treasuryId,
          status: "CLAIMED",
          lamports: input.feeAmountLamports,
          tradeCount: input.tradeIds.length,
        },
      });

      const stamped = await tx.agentTokenTrade.updateMany({
        where: { id: { in: input.tradeIds }, feeRoutingBatchId: null },
        data: { feeRoutingBatchId: batch.id },
      });

      if (stamped.count !== input.tradeIds.length) {
        // Another worker stamped some of these trades between our SELECT
        // and now. Roll the whole claim back — partial ownership would
        // make `lamports` a lie.
        throw new ClaimRaceLost();
      }

      return batch.id;
    });
  } catch (err) {
    if (err instanceof ClaimRaceLost) return null;
    throw err;
  }
}
