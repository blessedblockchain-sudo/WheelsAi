/**
 * Prisma-backed loader for the submit-payments BullMQ worker.
 *
 * Returns ComputePayment rows in PENDING status with scheduledFor <=
 * now, joined to AgentTreasury for the treasuryPdaAddress (the source
 * of funds for the on-chain transfer).
 *
 * Ordered by scheduledFor asc — fairness — so a token that keeps
 * emitting new PENDING rows can't starve an older payment.
 *
 * Pagination: `limit` controls per-tick batch size. The driver iterates
 * the batch sequentially (concurrency=1 BullMQ worker).
 *
 * The loader does NOT resolve the Nosana host / recipient address —
 * resolution is a side-effecting Nosana SDK call performed PER ROW by
 * runSubmitPaymentsTick (remediation D5), so one unresolvable job can
 * only fail its own row instead of aborting the whole batch load. The
 * loader surfaces nosanaJobId + resolutionAttempts for that purpose.
 */

interface PrismaStub {
  computePayment: {
    findMany: (args: {
      where: {
        status: "PENDING";
        scheduledFor: { lte: Date };
      };
      orderBy: { scheduledFor: "asc" };
      take: number;
      include: unknown;
    }) => Promise<
      Array<{
        id: string;
        treasuryId: string;
        amountLamports: bigint;
        nosanaJobId: string;
        // Recipient-resolution failures so far (D5 parking threshold).
        // Optional in the stub for pre-migration test fixtures; the
        // column is NOT NULL DEFAULT 0 in the schema.
        resolutionAttempts?: number;
        treasury: {
          id: string;
          treasuryPdaAddress: string;
          // Discriminator for the dual-mode submit dispatcher: when true,
          // the agent-treasury Anchor program has been initialized for
          // this treasury and the worker uses pay_nosana; when false
          // (default), it falls back to SystemProgram.transfer.
          programInitialized?: boolean;
          // Mint address is required for program-mode (PDA seed) but
          // unused in legacy mode. Loader always includes it via the
          // token join; dispatcher reads it only when programInitialized.
          token?: {
            mintAddress: string;
          };
        };
      }>
    >;
  };
}

export interface LoadPendingPaymentsInput {
  now: Date;
  limit: number;
}

export interface LoadPendingPaymentsDeps {
  prisma: PrismaStub;
}

export interface LoadedPendingPayment {
  id: string;
  treasuryId: string;
  treasuryAddress: string;
  amountLamports: bigint;
  nosanaJobId: string;
  /** True when the agent-treasury Anchor program has been initialized
   * for this row's treasury PDA — dispatcher routes to pay_nosana.
   * False (default) routes to legacy SystemProgram.transfer. */
  programInitialized: boolean;
  /** SPL mint that owns the treasury PDA. Always loaded via the
   * token join. Only used by the program-mode dispatcher; legacy
   * mode ignores it. */
  mintAddress: string | null;
  /** Recipient-resolution failures so far — the driver parks the row
   * once the next failure reaches MAX_RESOLUTION_ATTEMPTS. */
  resolutionAttempts: number;
}

export async function loadPendingPaymentsByPrisma(
  input: LoadPendingPaymentsInput,
  deps: LoadPendingPaymentsDeps,
): Promise<LoadedPendingPayment[]> {
  const rows = await deps.prisma.computePayment.findMany({
    where: {
      status: "PENDING",
      scheduledFor: { lte: input.now },
    },
    orderBy: { scheduledFor: "asc" },
    take: input.limit,
    include: {
      treasury: {
        select: {
          id: true,
          treasuryPdaAddress: true,
          programInitialized: true,
          token: { select: { mintAddress: true } },
        },
      },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    treasuryId: r.treasuryId,
    treasuryAddress: r.treasury.treasuryPdaAddress,
    amountLamports: r.amountLamports,
    nosanaJobId: r.nosanaJobId,
    programInitialized: r.treasury.programInitialized ?? false,
    mintAddress: r.treasury.token?.mintAddress ?? null,
    resolutionAttempts: r.resolutionAttempts ?? 0,
  }));
}
