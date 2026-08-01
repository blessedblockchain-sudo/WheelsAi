/**
 * D10 driver: run ONE compute payment through the PRODUCTION submit and
 * poll tick code paths against real devnet — claim-first CAS
 * (PENDING → SUBMITTING → SUBMITTED), HKDF-derived platform authority,
 * client-side on-chain authority verification, program-mode
 * agent-treasury::pay_nosana, broadcast, then confirmation polling to
 * CONFIRMED.
 *
 * ONE substitution, at the DI seam the architecture defines for it:
 * `resolveRecipient` returns a fixed devnet wallet instead of looking up
 * the Nosana host for the job id. Devnet has no payable Nosana hosts —
 * a real host lookup is exercised on mainnet in the C1 spike. Everything
 * else is the same code the BullMQ workers run.
 *
 * Usage:
 *   tsx scripts/run-d10-payment.ts <paymentId> <recipientPubkey>
 *
 * Env: DATABASE_URL, SOLANA_RPC_URL, SOLANA_NETWORK=devnet,
 *      WALLET_MASTER_KEY (same one bootstrap-treasury recorded on-chain).
 */

import { prisma } from "../src/lib/prisma.js";
import { getSolanaConnection } from "../src/lib/solana.js";
import { buildSubmitPaymentsTickDeps } from "../src/services/buildSubmitPaymentsTickDeps.js";
import { runSubmitPaymentsTick } from "../src/services/runSubmitPaymentsTick.js";
import { buildPollPaymentsTickDeps } from "../src/services/buildPollPaymentsTickDeps.js";
import { runPollPaymentsTick } from "../src/services/runPollPaymentsTick.js";
import { makeTreasurySignerProvider } from "../src/services/treasuryKeypairs.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [, , paymentId, recipient] = process.argv;
  if (!paymentId || !recipient) {
    console.error("usage: tsx scripts/run-d10-payment.ts <paymentId> <recipientPubkey>");
    process.exit(2);
  }
  const masterKey = process.env.WALLET_MASTER_KEY;
  if (!masterKey) {
    console.error("WALLET_MASTER_KEY required");
    process.exit(1);
  }

  const connection = getSolanaConnection();
  const treasurySignerFor = makeTreasurySignerProvider({ masterKey });

  const show = async (label: string) => {
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
    console.log(`[${label}]`, JSON.stringify(row, null, 2));
    return row;
  };

  await show("before");

  // ---- submit tick (production deps; recipient seam substituted) ----
  const submitDeps = buildSubmitPaymentsTickDeps({
    prisma: prisma as never,
    connection,
    treasurySignerFor,
    // Devnet substitution — see header. The job id is ignored on purpose.
    resolveRecipient: async () => recipient,
    batchLimit: 10,
    now: () => new Date(),
  });
  const submitResult = await runSubmitPaymentsTick({ now: new Date() }, submitDeps);
  console.log("[submit tick]", JSON.stringify(submitResult));
  const afterSubmit = await show("after submit");
  if (afterSubmit?.status !== "SUBMITTED") {
    console.error("Payment did not reach SUBMITTED; aborting before poll.");
    await prisma.$disconnect();
    process.exit(2);
  }

  // ---- poll tick(s) — production deps, unmodified ----
  for (let i = 0; i < 10; i++) {
    await sleep(5_000);
    const pollDeps = buildPollPaymentsTickDeps({
      prisma: prisma as never,
      connection,
      batchLimit: 10,
      now: () => new Date(),
    });
    const pollResult = await runPollPaymentsTick({ now: new Date() }, pollDeps);
    console.log(`[poll tick ${i + 1}]`, JSON.stringify(pollResult));
    const row = await show(`after poll ${i + 1}`);
    if (row?.status === "CONFIRMED" || row?.status === "FAILED") break;
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
