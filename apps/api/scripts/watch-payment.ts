/**
 * Tails one ComputePayment row and prints lifecycle changes.
 *
 * Usage:
 *   tsx scripts/watch-payment.ts <paymentId> [pollIntervalMs]
 *
 * Polls every 2s by default; prints whenever (status, txSignature,
 * errorMessage, submittedAt, paidAt) changes. Exits when the row hits
 * a terminal state (CONFIRMED or FAILED) or after 10 minutes.
 */

import { prisma } from "../src/lib/prisma.js";

const TERMINAL_STATES = new Set(["CONFIRMED", "FAILED"]);
const MAX_RUNTIME_MS = 10 * 60 * 1000;

interface Snapshot {
  status: string;
  txSignature: string | null;
  errorMessage: string | null;
  submittedAt: Date | null;
  paidAt: Date | null;
}

function snapshotKey(s: Snapshot): string {
  return JSON.stringify([
    s.status,
    s.txSignature,
    s.errorMessage,
    s.submittedAt?.toISOString() ?? null,
    s.paidAt?.toISOString() ?? null,
  ]);
}

async function main() {
  const [, , paymentId, intervalArg] = process.argv;
  if (!paymentId) {
    console.error("usage: tsx scripts/watch-payment.ts <paymentId> [pollIntervalMs]");
    process.exit(2);
  }
  const intervalMs = intervalArg ? Number(intervalArg) : 2000;

  let lastKey = "";
  const startedAt = Date.now();

  while (Date.now() - startedAt < MAX_RUNTIME_MS) {
    const row = await prisma.computePayment.findUnique({
      where: { id: paymentId },
      select: {
        status: true,
        txSignature: true,
        errorMessage: true,
        submittedAt: true,
        paidAt: true,
      },
    });

    if (!row) {
      console.error(`payment ${paymentId} not found`);
      process.exit(1);
    }

    const key = snapshotKey(row);
    if (key !== lastKey) {
      const ts = new Date().toISOString();
      console.log(`[${ts}] ${JSON.stringify(row)}`);
      lastKey = key;
    }

    if (TERMINAL_STATES.has(row.status)) {
      console.log(`reached terminal state: ${row.status}`);
      break;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  prisma.$disconnect().finally(() => process.exit(1));
});
