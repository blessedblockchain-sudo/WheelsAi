/**
 * ONE creator payout end to end on devnet, through the PRODUCTION request
 * and worker code.
 *
 * Cycle:
 *   1. Seed the creator's earnings through the earnings ledger (the ONE
 *      documented seam: the real money-in caller, a sale, is proven
 *      elsewhere). The seed is a ledger row like any other, so the balance
 *      still adds up from its rows.
 *   2. requestPayoutProduction (routes/payoutBindings.ts): the route's own
 *      checks, then ONE transaction that creates the payout row and
 *      reserves the amount.
 *   3. Fund the paying wallet from the devnet payer (SOL payouts only; for
 *      USDC put devnet USDC in it by hand, and watch the payout wait as
 *      `wallet_low` until you do).
 *   4. runPayoutExecutorTick over buildPayoutExecutorTickDeps, wired as
 *      queues/payout-executor.queue.ts wires it: the checks, the claim that
 *      stores the signed transfer BEFORE it is sent, the send, and on later
 *      runs what the chain says became of the signature.
 *   5. Verify from primary sources: the row is completed with a signature;
 *      the earnings are what they were before the seed (the reservation was
 *      consumed, not given back); on the chain the receiving wallet got
 *      exactly the base units stored on the row.
 *
 * Usage:
 *   npx tsx scripts/run-payout-devnet.ts <publisherOrgId> [amountUsd] [crypto_sol|crypto_usdc]
 *
 * Env: DATABASE_URL, WALLET_MASTER_KEY, SOLANA_NETWORK=devnet,
 *      SOLANA_RPC_URL, and for a SOL payout a price: SOL_PRICE_SOURCE=pyth,
 *      or on a local chain SOL_PRICE_SOURCE=static with SOL_PRICE_STATIC_USD.
 *      There is no fallback price: with SOL_PRICE_SOURCE=off a SOL payout is
 *      not offered and this script stops before it reserves anything.
 *      PAYOUT_MAX_PER_PAYOUT_USD, PAYOUT_MAX_PER_DAY_USD,
 *      PAYOUT_PLATFORM_MAX_PER_DAY_USD and PAYOUT_MAX_ATTEMPTS apply as they
 *      do in the API. PAYOUT_PAYER_KEYPAIR (default ../../.devnet/payer.json)
 *      is the devnet wallet that fills the paying wallet.
 */

import { readFileSync } from "node:fs";

import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";

import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { ensureSolanaCluster, getSolanaConnection } from "../src/lib/solana.js";
import { usdcMintForNetwork } from "../src/lib/solanaAssets.js";
import { requestPayoutProduction } from "../src/routes/payoutBindings.js";
import {
  buildPayoutExecutorTickDeps,
  type PayoutExecutorDb,
} from "../src/services/buildPayoutExecutorTickDeps.js";
import { readSignatureFate } from "../src/services/buildSignatureFateDeps.js";
import { getSolQuote, getSolQuoteMarginBps } from "../src/services/buildSolPriceDeps.js";
import { moveEarnings } from "../src/services/earningsLedger.js";
import {
  PAYING_WALLET_KEEP_LAMPORTS,
  PAYOUT_FEE_LAMPORTS,
  solPayoutAmount,
} from "../src/services/payoutExecutor.js";
import { derivePayoutKeypair } from "../src/services/payoutKeypair.js";
import { runPayoutExecutorTick } from "../src/services/runPayoutExecutorTick.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(msg: string): never {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

async function main() {
  const [, , publisherId, amountArg, methodArg] = process.argv;
  if (!publisherId) {
    console.error(
      "usage: npx tsx scripts/run-payout-devnet.ts <publisherOrgId> [amountUsd] [crypto_sol|crypto_usdc]",
    );
    process.exit(2);
  }
  const amountUsd = amountArg ? Number(amountArg) : 50;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) fail(`amountUsd is not a number above zero: ${amountArg}`);
  const amountCents = BigInt(Math.round(amountUsd * 100));
  const method = methodArg ?? "crypto_sol";
  if (method !== "crypto_sol" && method !== "crypto_usdc") fail(`unknown method ${method}`);

  if (env.SOLANA_NETWORK !== "devnet") fail("this proof runs on devnet only: set SOLANA_NETWORK=devnet");
  const cluster = await ensureSolanaCluster();
  if (!cluster.ok) fail(`the node behind SOLANA_RPC_URL is not usable: ${cluster.reason}`);
  if (!env.WALLET_MASTER_KEY) fail("WALLET_MASTER_KEY required");

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
  const payoutWallet = derivePayoutKeypair(env.WALLET_MASTER_KEY);
  const recipient = Keypair.generate(); // a fresh creator wallet to receive
  const connection = getSolanaConnection();

  console.log(`paying wallet (HKDF): ${payoutWallet.publicKey.toBase58()}`);
  console.log(`recipient (creator):  ${recipient.publicKey.toBase58()}`);

  // ---- 1. seed the creator's earnings (documented seam) ----
  const org = await prisma.organization.findUnique({ where: { id: publisherId } });
  if (!org) fail(`no organization ${publisherId}`);
  await prisma.publisherProfile.upsert({
    where: { orgId: publisherId },
    update: {},
    create: {
      orgId: publisherId,
      displayName: org.name,
      slug: `payout-proof-${publisherId.slice(0, 8)}`,
    },
  });
  const before = await prisma.publisherProfile.findUnique({ where: { orgId: publisherId } });
  const balanceBefore = before?.pendingPayoutCents ?? 0n;
  const seeded = await prisma.$transaction((tx) =>
    moveEarnings(tx, {
      orgId: publisherId,
      amountCents,
      type: "sale",
      referenceId: null,
      description: "[devnet-proof] seeded earnings",
    }),
  );
  if (!seeded.moved) fail(`could not seed the earnings: ${seeded.reason}`);
  console.log(`\n[1] seeded ${amountCents} cents of earnings through the ledger (balance ${seeded.balanceAfterCents})`);

  // ---- 2. request the payout (production checks and reservation) ----
  const requested = await requestPayoutProduction({
    orgId: publisherId,
    payoutMethod: method,
    payoutAddress: recipient.publicKey.toBase58(),
    amountCents,
  });
  if (requested.outcome !== "requested") {
    fail(`the request was refused: ${JSON.stringify(requested.refusal)}`);
  }
  const payoutId = requested.payout.id;
  console.log(`[2] requested payout ${payoutId}`);
  console.log(`    earnings after the reservation: ${requested.remainingCents} (must be ${balanceBefore})`);
  if (requested.remainingCents !== balanceBefore) {
    fail("the reservation did not take exactly the amount requested");
  }

  // ---- 3. fund the paying wallet on devnet ----
  let expectedRaw: bigint | null = null;
  if (method === "crypto_sol") {
    // The amount the worker will work out a moment from now may differ by
    // a little (a newer price), so this is filled with room to spare.
    const quoted = solPayoutAmount(await getSolQuote(), amountCents, getSolQuoteMarginBps());
    if (!quoted.ok) fail(`no SOL price, so no amount: ${quoted.detail}`);
    const needLamports =
      (quoted.lamports * 11n) / 10n + PAYOUT_FEE_LAMPORTS + PAYING_WALLET_KEEP_LAMPORTS;
    const balance = BigInt(await connection.getBalance(payoutWallet.publicKey));
    if (balance < needLamports) {
      const top = needLamports - balance;
      console.log(`[3] funding the paying wallet with ${top} lamports from the payer…`);
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
      console.log(`[3] the paying wallet is already funded (${balance} lamports)`);
    }
  } else {
    expectedRaw = amountCents * 10_000n;
    console.log(
      `[3] USDC payout: the paying wallet needs ${expectedRaw} base units of devnet USDC and some SOL for the fee. ` +
        "It is filled by hand; while it is short the payout waits as wallet_low.",
    );
  }
  const recipientBefore = BigInt(await connection.getBalance(recipient.publicKey));

  // ---- 4. run the production worker ----
  const deps = buildPayoutExecutorTickDeps({
    prisma: prisma as unknown as PayoutExecutorDb,
    connection,
    payoutWallet,
    usdcMint: usdcMintForNetwork(env.SOLANA_NETWORK),
    maxAttempts: env.PAYOUT_MAX_ATTEMPTS,
    platformMaxPerDayUsd: env.PAYOUT_PLATFORM_MAX_PER_DAY_USD,
    checkCluster: ensureSolanaCluster,
    getSolQuote,
    solQuoteMarginBps: getSolQuoteMarginBps,
    readSignatureFate,
    log: (event) => console.log(`    ${JSON.stringify(event)}`),
  });
  console.log(`\n[4] worker runs`);
  // The first run claims and sends. Later runs ask the chain what became of
  // the signature: the payout completes once the transfer is confirmed.
  for (let i = 0; i < 20; i++) {
    const tick = await runPayoutExecutorTick({ limit: env.PAYOUT_EXECUTOR_BATCH_SIZE }, deps);
    console.log(`    run ${i + 1}: ${JSON.stringify(tick)}`);
    const row = await prisma.creatorPayout.findUnique({ where: { id: payoutId } });
    if (!row) fail("the payout row is gone");
    if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") break;
    if (row.status === "pending" && row.waitingReason) {
      console.log(`    waiting: ${row.waitingReason}`);
    }
    await sleep(3_000);
  }

  // ---- 5. verify ----
  const finalRow = await prisma.creatorPayout.findUnique({
    where: { id: payoutId },
  });
  if (!finalRow || finalRow.status !== "completed" || !finalRow.txSignature) {
    fail(
      `payout not completed: ${JSON.stringify(finalRow, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      )}`,
    );
  }
  const finalProfile = await prisma.publisherProfile.findUnique({
    where: { orgId: publisherId },
  });
  console.log(`\n[5] verification`);
  console.log(`    row status: ${finalRow.status}, tx: ${finalRow.txSignature}, attempts: ${finalRow.attemptCount}`);
  console.log(`    earnings: ${finalProfile?.pendingPayoutCents} (stays ${balanceBefore}: the reservation was consumed)`);
  if (finalProfile?.pendingPayoutCents !== balanceBefore) {
    fail("the earnings were wrongly given back on a SUCCESSFUL payout");
  }
  if (!finalRow.amountRaw) fail("the row does not say what was sent");
  const sentRaw = BigInt(finalRow.amountRaw);
  if (expectedRaw !== null && sentRaw !== expectedRaw) {
    fail(`the row says ${sentRaw} base units were sent, not ${expectedRaw}`);
  }

  const parsed = await connection.getParsedTransaction(finalRow.txSignature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!parsed || parsed.meta?.err) {
    fail(`on-chain tx missing or errored: ${JSON.stringify(parsed?.meta?.err)}`);
  }
  if (method === "crypto_sol") {
    const recipientAfter = BigInt(await connection.getBalance(recipient.publicKey));
    const received = recipientAfter - recipientBefore;
    console.log(
      `    recipient received: ${received} lamports (the row says ${sentRaw}, at ${finalRow.quotePriceMicroUsd} micro-dollars per SOL from ${finalRow.quoteSource})`,
    );
    if (received !== sentRaw) {
      fail("the recipient did not receive the amount stored on the row");
    }
  } else {
    const balances = parsed.meta?.postTokenBalances ?? [];
    const got = balances.find((b) => b.owner === recipient.publicKey.toBase58());
    console.log(`    recipient USDC after the transfer: ${got?.uiTokenAmount.amount ?? "not found"} base units`);
    if (!got || BigInt(got.uiTokenAmount.amount) !== sentRaw) {
      fail("the recipient did not receive the amount stored on the row");
    }
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
