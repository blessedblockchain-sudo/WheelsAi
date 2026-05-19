/**
 * Smoke-test seeder for the treasury-payment lifecycle.
 *
 * Inserts a single PENDING ComputePayment row tied to an existing
 * AgentTreasury so you can watch the four BullMQ workers move it
 * through the lifecycle on devnet:
 *
 *   PENDING ─submit─▶ SUBMITTED ─poll─▶ CONFIRMED
 *                       │  ─reap (>maxAge)─▶ FAILED
 *
 * Usage:
 *   tsx scripts/seed-test-payment.ts <treasuryId> <amountLamports> [nosanaJobId]
 *
 * Prerequisites:
 *   • DATABASE_URL points at a dev Postgres
 *   • AgentTreasury row exists (with valid treasuryPdaAddress + a known
 *     keypair behind it — set in PAYMENT_SUBMIT_TREASURY_KEYPAIRS or
 *     wired via treasurySignerFor)
 *   • The four payment workers' env intervals are non-zero so they fire:
 *       TREASURY_SETTLEMENT_INTERVAL_MS=60000
 *       PAYMENT_SUBMIT_INTERVAL_MS=30000
 *       PAYMENT_POLL_INTERVAL_MS=15000
 *       PAYMENT_REAP_INTERVAL_MS=120000
 *   • SOLANA_NETWORK=devnet (don't smoke-test on mainnet without funded keypair)
 *
 * Watch the row with:
 *   psql $DATABASE_URL -c "SELECT id, status, tx_signature, error_message, submitted_at, paid_at \
 *     FROM compute_payments WHERE id = '<id>' \\watch 5"
 */

import { prisma } from "../src/lib/prisma.js";

async function main() {
  const [, , treasuryIdArg, amountArg, jobIdArg] = process.argv;

  if (!treasuryIdArg || !amountArg) {
    console.error(
      "usage: tsx scripts/seed-test-payment.ts <treasuryId> <amountLamports> [nosanaJobId]",
    );
    process.exit(2);
  }

  let amountLamports: bigint;
  try {
    amountLamports = BigInt(amountArg);
  } catch {
    console.error(`amountLamports must be a bigint-parseable integer, got "${amountArg}"`);
    process.exit(2);
  }

  const treasury = await prisma.agentTreasury.findUnique({
    where: { id: treasuryIdArg },
    select: { id: true, treasuryPdaAddress: true, solBalanceLamports: true },
  });
  if (!treasury) {
    console.error(`AgentTreasury ${treasuryIdArg} not found`);
    process.exit(1);
  }

  if (treasury.solBalanceLamports < amountLamports) {
    console.warn(
      `WARNING: treasury balance (${treasury.solBalanceLamports}) < requested amount (${amountLamports}); the submit will likely RPC-fail`,
    );
  }

  const payment = await prisma.computePayment.create({
    data: {
      treasuryId: treasury.id,
      nosanaJobId: jobIdArg ?? `smoke-${Date.now()}`,
      amountLamports,
      computeSeconds: 60n,
      status: "PENDING",
      scheduledFor: new Date(),
      retryCount: 0,
    },
    select: {
      id: true,
      status: true,
      treasuryId: true,
      nosanaJobId: true,
      amountLamports: true,
      scheduledFor: true,
    },
  });

  console.log("Inserted PENDING compute_payment:");
  console.log(JSON.stringify(payment, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log("\nWatch lifecycle progression:");
  console.log(
    `  psql "$DATABASE_URL" -c "SELECT id, status, tx_signature, error_message, submitted_at, paid_at FROM compute_payments WHERE id = '${payment.id}'"`,
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  prisma.$disconnect().finally(() => process.exit(1));
});
