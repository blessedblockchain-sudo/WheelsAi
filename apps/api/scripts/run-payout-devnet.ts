/**
 * W2 money keystone proof: ONE creator payout end-to-end on devnet
 * through the PRODUCTION request + executor code.
 *
 * Cycle:
 *   1. Seed the publisher's pendingPayoutCents (the ONE documented seam —
 *      the real money-in caller, per-request marketplace metering, is a
 *      separate keystone; the audit pairs metering + executor and this
 *      proves the executor leg, exactly as D10 seeded usage/trades).
 *   2. requestPayout(publisherId, "crypto_sol", recipient) — production
 *      code: RESERVES the balance into a CreatorPayout row in one
 *      transaction (the fund-loss fix), zeroing pendingPayoutCents.
 *   3. Fund the HKDF platform payout wallet from the devnet payer.
 *   4. runPayoutExecutorTick over buildPayoutExecutorTickDeps — the exact
 *      objects the BullMQ worker runs: claim (pending -> processing),
 *      build + sign + record-sig-before-broadcast + confirm + complete.
 *   5. Verify from primary sources: row completed with a signature;
 *      pendingPayoutCents stayed 0 (reservation consumed, not stranded);
 *      on-chain the recipient received exactly the quoted lamports.
 *
 * Usage:
 *   npx tsx scripts/run-payout-devnet.ts <publisherOrgId> [amountUsd]
 *
 * Env: DATABASE_URL, WALLET_MASTER_KEY, SOLANA_NETWORK=devnet,
 *      PAYOUT_SOL_PRICE_USD, PAYOUT_PAYER_KEYPAIR (default
 *      ../../.devnet/payer.json).
 */

import { readFileSync } from "node:fs";

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

import { prisma } from "../src/lib/prisma.js";
import { getSolanaConnection } from "../src/lib/solana.js";
import { buildPayoutExecutorTickDeps } from "../src/services/buildPayoutExecutorTickDeps.js";
import { derivePayoutKeypair } from "../src/services/payoutKeypair.js";
import { requestPayout } from "../src/services/marketplace.js";
import { runPayoutExecutorTick } from "../src/services/runPayoutExecutorTick.js";
import { USDC_MINT } from "../src/services/x402.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(msg: string): never {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

async function main() {
  const [, , publisherId, amountArg] = process.argv;
  if (!publisherId) {
    console.error("usage: npx tsx scripts/run-payout-devnet.ts <publisherOrgId> [amountUsd]");
    process.exit(2);
  }
  const amountUsd = amountArg ? Number(amountArg) : 50;
  const amountCents = Math.round(amountUsd * 100);

  const masterKey = process.env.WALLET_MASTER_KEY;
  if (!masterKey) fail("WALLET_MASTER_KEY required");
  const solPrice = Number(process.env.PAYOUT_SOL_PRICE_USD ?? "200");

  const payer = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        readFileSync(
          process.env.PAYOUT_PAYER_KEYPAIR ?? "../../.devnet/payer.json",
          "utf8",
        ),
      ),
    ),
  );
  const payoutWallet = derivePayoutKeypair(masterKey);
  const recipient = Keypair.generate(); // a fresh creator wallet to receive
  const connection = getSolanaConnection();

  console.log(`payout wallet (HKDF): ${payoutWallet.publicKey.toBase58()}`);
  console.log(`recipient (creator):  ${recipient.publicKey.toBase58()}`);

  // ---- 1. seed the publisher's pending balance (documented seam) ----
  // Upsert a minimal PublisherProfile if the org doesn't have one — part
  // of the documented seed, standing in for the real money-in caller.
  const org = await prisma.organization.findUnique({ where: { id: publisherId } });
  if (!org) fail(`no organization ${publisherId}`);
  await prisma.publisherProfile.upsert({
    where: { orgId: publisherId },
    update: { pendingPayoutCents: BigInt(amountCents) },
    create: {
      orgId: publisherId,
      displayName: org.name,
      slug: `payout-proof-${publisherId.slice(0, 8)}`,
      pendingPayoutCents: BigInt(amountCents),
    },
  });
  console.log(`\n[1] seeded pendingPayoutCents = ${amountCents} (documented money-in seam)`);

  // ---- 2. request the payout (production reservation) ----
  const requested = await requestPayout(
    publisherId,
    "crypto_sol",
    recipient.publicKey.toBase58(),
  );
  const payoutId = requested.payout.id;
  const afterReserve = await prisma.publisherProfile.findUnique({
    where: { orgId: publisherId },
  });
  console.log(`[2] requested payout ${payoutId}`);
  console.log(`    pendingPayoutCents after reserve: ${afterReserve?.pendingPayoutCents} (must be 0)`);
  if (Number(afterReserve?.pendingPayoutCents) !== 0) {
    fail("reservation did not zero pendingPayoutCents");
  }

  // ---- 3. fund the payout wallet on devnet ----
  const balance = await connection.getBalance(payoutWallet.publicKey);
  const needLamports = Math.round((amountUsd / solPrice) * 1e9) + 10_000_000; // amount + fees/rent buffer
  if (balance < needLamports) {
    const top = needLamports - balance;
    console.log(`[3] funding payout wallet with ${top} lamports from payer…`);
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    const fund = new Transaction({
      feePayer: payer.publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payoutWallet.publicKey,
        lamports: top,
      }),
    );
    fund.sign(payer);
    const sig = await connection.sendRawTransaction(fund.serialize());
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    console.log(`    funded: ${sig}`);
  } else {
    console.log(`[3] payout wallet already funded (${balance} lamports)`);
  }
  const recipientBefore = await connection.getBalance(recipient.publicKey);

  // ---- 4. run the production executor tick ----
  const deps = buildPayoutExecutorTickDeps({
    prisma,
    connection,
    payoutWallet,
    solPriceUsd: solPrice,
    usdcMint: new PublicKey(USDC_MINT.devnet.toBase58()),
  });
  let tickResult = await runPayoutExecutorTick({ limit: 10 }, deps);
  console.log(`\n[4] executor tick: ${JSON.stringify(tickResult)}`);
  // If the first tick left it pending_confirmation, run again after a beat.
  for (let i = 0; i < 5 && tickResult.pending > 0; i++) {
    await sleep(3_000);
    tickResult = await runPayoutExecutorTick({ limit: 10 }, deps);
    console.log(`    retry tick: ${JSON.stringify(tickResult)}`);
  }

  // ---- 5. verify ----
  const finalRow = await prisma.creatorPayout.findUnique({
    where: { id: payoutId },
  });
  if (!finalRow || finalRow.status !== "completed" || !finalRow.txSignature) {
    fail(`payout not completed: ${JSON.stringify(finalRow)}`);
  }
  const finalProfile = await prisma.publisherProfile.findUnique({
    where: { orgId: publisherId },
  });
  console.log(`\n[5] verification`);
  console.log(`    row status: ${finalRow.status}, tx: ${finalRow.txSignature}`);
  console.log(`    pendingPayoutCents: ${finalProfile?.pendingPayoutCents} (stays 0 — reservation consumed)`);
  if (Number(finalProfile?.pendingPayoutCents) !== 0) {
    fail("pendingPayoutCents was wrongly restored on a SUCCESSFUL payout");
  }

  const parsed = await connection.getParsedTransaction(finalRow.txSignature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!parsed || parsed.meta?.err) {
    fail(`on-chain tx missing or errored: ${JSON.stringify(parsed?.meta?.err)}`);
  }
  const recipientAfter = await connection.getBalance(recipient.publicKey);
  const received = recipientAfter - recipientBefore;
  const expectedLamports = Math.round((amountUsd / solPrice) * 1e9);
  console.log(`    recipient received: ${received} lamports (expected ${expectedLamports})`);
  if (received !== expectedLamports) {
    fail("recipient did not receive the quoted amount");
  }

  console.log(`\n✅ creator payout proven end-to-end on devnet`);
  console.log(
    `   explorer: https://explorer.solana.com/tx/${finalRow.txSignature}?cluster=devnet`,
  );

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
