/**
 * Prisma-backed loader for the poll-confirmation BullMQ worker.
 *
 * Returns ComputePayment rows with status=SUBMITTED + non-null
 * txSignature, ordered submittedAt asc (older sigs polled first
 * since they're closer to blockhash expiry).
 *
 * The null-sig filter is defense-in-depth — the lifecycle shouldn't
 * allow a SUBMITTED row without a sig, but the poll dep crashes on
 * a null arg, so excluding them at the loader keeps the driver
 * robust against malformed history.
 *
 * `limit` is the per-tick batch size. Production likely runs at a
 * higher cadence + smaller batch than submit (poll is cheap, just an
 * RPC query, and faster confirmation reduces dashboard latency).
 */

import type { SubmittedPaymentRow } from "./runPollPaymentsTick.js";

interface PrismaStub {
  computePayment: {
    findMany: (args: {
      where: {
        status: "SUBMITTED";
        txSignature: { not: null };
      };
      orderBy: { submittedAt: "asc" };
      take: number;
    }) => Promise<
      Array<{
        id: string;
        txSignature: string | null;
      }>
    >;
  };
}

export interface LoadSubmittedPaymentsInput {
  limit: number;
}

export interface LoadSubmittedPaymentsDeps {
  prisma: PrismaStub;
}

export async function loadSubmittedPaymentsByPrisma(
  input: LoadSubmittedPaymentsInput,
  deps: LoadSubmittedPaymentsDeps,
): Promise<SubmittedPaymentRow[]> {
  const rows = await deps.prisma.computePayment.findMany({
    where: {
      status: "SUBMITTED",
      txSignature: { not: null },
    },
    orderBy: { submittedAt: "asc" },
    take: input.limit,
  });

  return rows.flatMap((r) =>
    r.txSignature ? [{ id: r.id, txSignature: r.txSignature }] : [],
  );
}
