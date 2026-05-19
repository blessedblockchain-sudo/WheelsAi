/**
 * Conditional cursor-update writer for the fee-router worker.
 *
 * Bumps AgentTreasury.lastFeeRoutedAt to a new value, but only if
 * the new value is strictly greater than the current one (or current
 * is NULL). This guards against a stale tick — if BullMQ retries an
 * older tick after a newer one already advanced the cursor, the
 * older tick's write is filtered out by the WHERE clause and the
 * count comes back zero.
 *
 * count=0 is NOT an error: it means "the cursor is already at or
 * beyond what I tried to write" — equivalent to a successful no-op.
 * No throw, no log noise.
 */

interface PrismaStub {
  agentTreasury: {
    updateMany: (args: {
      where: {
        id: string;
        OR: Array<
          | { lastFeeRoutedAt: null }
          | { lastFeeRoutedAt: { lt: Date } }
        >;
      };
      data: { lastFeeRoutedAt: Date };
    }) => Promise<{ count: number }>;
  };
}

export interface PersistFeeRouterCursorDeps {
  prisma: PrismaStub;
}

export async function persistFeeRouterCursor(
  treasuryId: string,
  cursor: Date,
  deps: PersistFeeRouterCursorDeps,
): Promise<void> {
  await deps.prisma.agentTreasury.updateMany({
    where: {
      id: treasuryId,
      OR: [
        { lastFeeRoutedAt: null },
        { lastFeeRoutedAt: { lt: cursor } },
      ],
    },
    data: { lastFeeRoutedAt: cursor },
  });
  // count==0 is a successful no-op (cursor already at/past the target).
}
