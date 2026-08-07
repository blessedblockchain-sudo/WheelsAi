/**
 * B2/T5 proof: ONE wallet top-up end-to-end on devnet through the
 * PRODUCTION route + bindings code (createWalletTopupRoutes over
 * buildProductionWalletTopupDeps — the exact objects index.ts mounts).
 *
 * The ONLY substitution is the browser wallet: this script signs the
 * prepared transaction with a local devnet keypair, doing exactly what
 * wallet-adapter does (deserialize → sign → reserialize). Everything
 * else — deposit derivation, byte-equality verification, claim CAS,
 * broadcast, confirmation, the exactly-once credit grant — is
 * production code against real devnet + the real database.
 *
 * Verifies afterwards, from primary sources:
 *   1. WalletTopUp row reached status=credited with the tx signature.
 *   2. creditTransaction rows (purchase + bonus) exist with
 *      referenceId = topup row id, [devnet] labeled.
 *   3. CreditBalance moved by exactly amount+bonus.
 *   4. ON-CHAIN: the transfer paid the HKDF deposit address the exact
 *      lamports, and the memo carries the row id.
 *
 * Usage:
 *   npx tsx scripts/run-topup-devnet.ts <orgId> [amountUsd]
 *
 * Env: DATABASE_URL, WALLET_MASTER_KEY, SOLANA_NETWORK=devnet,
 *      WALLET_TOPUPS_ENABLED=true, ALLOW_DEVNET_WALLET_TOPUPS=true,
 *      WALLET_TOPUP_SOL_PRICE_USD, TOPUP_PAYER_KEYPAIR (default
 *      ../../.devnet/payer.json).
 */

import { readFileSync } from "node:fs";

import Fastify from "fastify";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";

import { prisma } from "../src/lib/prisma.js";
import { getSolanaConnection } from "../src/lib/solana.js";
import { createWalletTopupRoutes } from "../src/routes/walletTopup.js";
import { buildProductionWalletTopupDeps } from "../src/routes/walletTopupBindings.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(msg: string): never {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

async function main() {
  const [, , orgId, amountArg] = process.argv;
  if (!orgId) {
    console.error("usage: npx tsx scripts/run-topup-devnet.ts <orgId> [amountUsd]");
    process.exit(2);
  }
  const amountUsd = amountArg ? Number(amountArg) : 50;

  const payerPath = process.env.TOPUP_PAYER_KEYPAIR ?? "../../.devnet/payer.json";
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(payerPath, "utf8"))),
  );
  console.log(`payer (simulated browser wallet): ${payer.publicKey.toBase58()}`);

  // The production route factory over the production deps — what
  // index.ts mounts, minus the HTTP listener.
  const app = Fastify({ logger: false });
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { auth: unknown }).auth = {
      userId: "t5-proof",
      orgId,
      type: "jwt",
      walletAddress: payer.publicKey.toBase58(),
    };
  });
  await app.register(createWalletTopupRoutes(buildProductionWalletTopupDeps()));

  const balanceBefore = await prisma.creditBalance.findUnique({
    where: { orgId },
  });
  const beforeCents = balanceBefore?.balanceCents ?? 0n;
  console.log(`credit balance before: ${beforeCents} cents`);

  // ---- 1. prepare ----
  const prepareRes = await app.inject({
    method: "POST",
    url: "/topups/prepare",
    payload: { amountUsd, asset: "SOL" },
  });
  if (prepareRes.statusCode !== 200) {
    fail(`prepare -> ${prepareRes.statusCode}: ${prepareRes.body}`);
  }
  const prepared = prepareRes.json() as {
    topupId: string;
    unsignedTxBase64: string;
    depositAddress: string;
    bonusUsd: number;
    quotedSolPriceUsd: number;
    expiresAt: string;
  };
  console.log(`\n[1] prepared topup ${prepared.topupId}`);
  console.log(`    deposit address: ${prepared.depositAddress}`);
  console.log(`    quote: $${prepared.quotedSolPriceUsd}/SOL, bonus $${prepared.bonusUsd}`);
  console.log(`    expires: ${prepared.expiresAt}`);

  // ---- 2. wallet signature (deserialize → sign → reserialize) ----
  const tx = Transaction.from(Buffer.from(prepared.unsignedTxBase64, "base64"));
  tx.sign(payer);
  const signedTxBase64 = tx.serialize().toString("base64");
  console.log(`[2] signed by wallet`);

  // ---- 3. submit ----
  const submitRes = await app.inject({
    method: "POST",
    url: `/topups/${prepared.topupId}/submit`,
    payload: { signedTxBase64 },
  });
  let finalBody: Record<string, unknown>;
  if (submitRes.statusCode === 200) {
    finalBody = submitRes.json();
  } else if (submitRes.statusCode === 202) {
    console.log(`[3] submit -> 202 pending confirmation; reconciling…`);
    finalBody = {};
    for (let i = 0; i < 30; i++) {
      await sleep(2_000);
      const rec = await app.inject({
        method: "POST",
        url: `/topups/${prepared.topupId}/reconcile`,
        payload: {},
      });
      finalBody = rec.json();
      console.log(`    reconcile #${i + 1}: ${finalBody.status}`);
      if (
        finalBody.status === "credited" ||
        finalBody.status === "failed" ||
        finalBody.status === "expired"
      ) {
        break;
      }
    }
  } else {
    fail(`submit -> ${submitRes.statusCode}: ${submitRes.body}`);
  }
  if (finalBody.status !== "credited") {
    fail(`terminal status ${String(finalBody.status)}: ${JSON.stringify(finalBody)}`);
  }
  console.log(`[3] submit -> credited`);
  console.log(`    tx signature: ${String(finalBody.txSignature)}`);

  // ---- 4. verify: database ----
  const row = await prisma.walletTopUp.findUnique({
    where: { id: prepared.topupId },
  });
  if (!row || row.status !== "credited" || !row.txSignature) {
    fail(`row not credited: ${JSON.stringify(row)}`);
  }
  const ledger = await prisma.creditTransaction.findMany({
    where: { referenceId: prepared.topupId },
    orderBy: { createdAt: "asc" },
  });
  const balanceAfter = await prisma.creditBalance.findUnique({
    where: { orgId },
  });
  const afterCents = balanceAfter?.balanceCents ?? 0n;
  const expectedGrant = row.amountUsdCents + row.bonusCents;
  console.log(`\n[4] database verification`);
  console.log(`    row: status=${row.status} network=${row.network} amountRaw=${row.amountRaw}`);
  console.log(
    `    ledger rows for ${prepared.topupId}: ${ledger
      .map((l) => `${l.type}:${l.amountCents}c (balanceAfter ${l.balanceAfter})`)
      .join(", ")}`,
  );
  console.log(`    balance: ${beforeCents} -> ${afterCents} cents`);
  if (afterCents - beforeCents !== expectedGrant) {
    fail(`balance moved ${afterCents - beforeCents}, expected ${expectedGrant}`);
  }
  if (ledger.length !== (row.bonusCents > 0n ? 2 : 1)) {
    fail(`expected ${row.bonusCents > 0n ? 2 : 1} ledger rows, got ${ledger.length}`);
  }
  if (!ledger.every((l) => l.description?.startsWith("[devnet] "))) {
    fail("devnet grant rows must be [devnet]-labeled");
  }

  // ---- 5. verify: on-chain ----
  const connection = getSolanaConnection();
  const parsed = await connection.getParsedTransaction(row.txSignature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!parsed || parsed.meta?.err) {
    fail(`on-chain tx missing or errored: ${JSON.stringify(parsed?.meta?.err)}`);
  }
  const keys = parsed.transaction.message.accountKeys.map((k) =>
    (k.pubkey as PublicKey).toBase58(),
  );
  const depositIndex = keys.indexOf(prepared.depositAddress);
  if (depositIndex < 0) fail("deposit address not in tx accounts");
  const lamportsReceived =
    (parsed.meta!.postBalances[depositIndex] ?? 0) -
    (parsed.meta!.preBalances[depositIndex] ?? 0);
  const memoSeen = (parsed.meta!.logMessages ?? []).some((l) =>
    l.includes(prepared.topupId),
  );
  console.log(`\n[5] on-chain verification (slot ${parsed.slot})`);
  console.log(`    deposit received: ${lamportsReceived} lamports (row says ${row.amountRaw})`);
  console.log(`    memo carries row id: ${memoSeen}`);
  if (String(lamportsReceived) !== row.amountRaw) {
    fail("on-chain lamports do not match the row's amountRaw");
  }
  if (!memoSeen) fail("memo with the topup id not found in logs");

  console.log(`\n✅ wallet top-up proven end-to-end on devnet`);
  console.log(
    `   explorer: https://explorer.solana.com/tx/${row.txSignature}?cluster=devnet`,
  );

  await app.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
