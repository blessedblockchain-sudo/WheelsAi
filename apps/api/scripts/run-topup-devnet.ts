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
 * The session here is an email session with NO wallet on it: the payer
 * goes in the body of prepare (`payerAddress`), which is how any account
 * pays from whichever wallet it connects.
 *
 * Verifies afterwards, from primary sources:
 *   1. WalletTopUp row reached status=credited with the tx signature.
 *   2. creditTransaction rows (purchase + bonus) exist with
 *      referenceId = topup row id, [devnet] labeled.
 *   3. CreditBalance moved by exactly amount+bonus.
 *   4. ON-CHAIN: the transfer paid the HKDF deposit address the exact
 *      amount (lamports for SOL, USDC base units for USDC), and the memo
 *      carries the row id.
 *
 * Usage:
 *   npx tsx scripts/run-topup-devnet.ts <orgId> [amountUsd] [SOL|USDC]
 *
 * Env: DATABASE_URL, WALLET_MASTER_KEY, SOLANA_NETWORK=devnet,
 *      SOLANA_RPC_URL, WALLET_TOPUPS_ENABLED=true, TOPUP_PAYER_KEYPAIR
 *      (default ../../.devnet/payer.json).
 *      For SOL: SOL_PRICE_SOURCE=pyth (the live price, read through
 *      SOLANA_RPC_URL), or SOL_PRICE_SOURCE=static with
 *      SOL_PRICE_STATIC_USD on a local chain. With SOL_PRICE_SOURCE=off
 *      SOL is not offered and only USDC can be run.
 *      For USDC: the payer needs devnet USDC and a little SOL for the fee.
 */

import { readFileSync } from "node:fs";

import Fastify from "fastify";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";

import { env } from "../src/config/env.js";
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
  const [, , orgId, amountArg, assetArg] = process.argv;
  const asset = (assetArg ?? "SOL").toUpperCase();
  if (!orgId || (asset !== "SOL" && asset !== "USDC")) {
    console.error("usage: npx tsx scripts/run-topup-devnet.ts <orgId> [amountUsd] [SOL|USDC]");
    process.exit(2);
  }
  const amountUsd = amountArg ? Number(amountArg) : 50;
  if (asset === "SOL" && env.SOL_PRICE_SOURCE === "off") {
    fail(
      "SOL_PRICE_SOURCE is off, so SOL is not offered. Set SOL_PRICE_SOURCE=pyth (or static with SOL_PRICE_STATIC_USD on a local chain), or run this with USDC.",
    );
  }

  const payerPath = process.env.TOPUP_PAYER_KEYPAIR ?? "../../.devnet/payer.json";
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(payerPath, "utf8"))),
  );
  console.log(`payer (simulated browser wallet): ${payer.publicKey.toBase58()}`);

  // The production route factory over the production deps — what
  // index.ts mounts, minus the HTTP listener. The session carries no
  // wallet: the payer is named in the body of prepare.
  const app = Fastify({ logger: false });
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { auth: unknown }).auth = {
      userId: "t5-proof",
      orgId,
      type: "jwt",
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
    payload: { amountUsd, asset, payerAddress: payer.publicKey.toBase58() },
  });
  if (prepareRes.statusCode !== 200) {
    fail(`prepare -> ${prepareRes.statusCode}: ${prepareRes.body}`);
  }
  const prepared = prepareRes.json() as {
    topupId: string;
    unsignedTxBase64: string;
    depositAddress: string;
    payerAddress: string;
    asset: string;
    bonusUsd: number;
    amountRaw: string;
    quote: { solPriceUsd: number; validUntil: string } | null;
    opensUsdcAccount: boolean;
    expiresAt: string;
    message: string;
  };
  console.log(`\n[1] prepared ${prepared.asset} topup ${prepared.topupId}`);
  console.log(`    payer (from the body): ${prepared.payerAddress}`);
  console.log(`    deposit address: ${prepared.depositAddress}`);
  console.log(`    amount: ${prepared.amountRaw} base units, bonus $${prepared.bonusUsd}`);
  if (prepared.quote) {
    console.log(`    quote: $${prepared.quote.solPriceUsd}/SOL until ${prepared.quote.validUntil}`);
  }
  if (prepared.opensUsdcAccount) {
    console.log(`    this payment also opens the organization's USDC account`);
  }
  console.log(`    expires: ${prepared.expiresAt}`);
  console.log(`    message: ${prepared.message}`);
  if (prepared.payerAddress !== payer.publicKey.toBase58()) {
    fail("prepare did not take the payer from the body");
  }

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
    finalBody = submitRes.json();
    console.log(`[3] submit -> 202 ${String(finalBody.status)}; reconciling…`);
    console.log(`    message: ${String(finalBody.message)}`);
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
  console.log(`    message: ${String(finalBody.message)}`);

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
  let received: bigint;
  if (asset === "SOL") {
    const depositIndex = keys.indexOf(prepared.depositAddress);
    if (depositIndex < 0) fail("deposit address not in tx accounts");
    received =
      BigInt(parsed.meta!.postBalances[depositIndex] ?? 0) -
      BigInt(parsed.meta!.preBalances[depositIndex] ?? 0);
  } else {
    // USDC lands in a token account OWNED by the deposit address; a first
    // payment opens it, so it may be absent from the "before" list.
    const held = (balances: NonNullable<typeof parsed.meta>["postTokenBalances"]) =>
      (balances ?? [])
        .filter((b) => b.owner === prepared.depositAddress)
        .reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n);
    received = held(parsed.meta!.postTokenBalances) - held(parsed.meta!.preTokenBalances);
  }
  const memoSeen = (parsed.meta!.logMessages ?? []).some((l) =>
    l.includes(prepared.topupId),
  );
  console.log(`\n[5] on-chain verification (slot ${parsed.slot})`);
  console.log(`    deposit received: ${received} base units of ${asset} (row says ${row.amountRaw})`);
  console.log(`    memo carries row id: ${memoSeen}`);
  if (String(received) !== row.amountRaw) {
    fail("the amount received on-chain does not match the row's amountRaw");
  }
  if (row.amountRaw !== prepared.amountRaw) {
    fail("the row's amountRaw is not the amount prepare answered");
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
