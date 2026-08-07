/**
 * B4/T7 proof: ONE x402-paid inference round trip on devnet through the
 * PRODUCTION route code, settled by the PRODUCTION settlement worker.
 *
 * The cycle:
 *   1. POST /v1/:slug/chat/completions WITHOUT X-Payment
 *        → 402 with the payment requirement (production
 *          resolveBilling + generatePaymentRequirement).
 *   2. Client builds + signs the SOL transfer the requirement asks for
 *      (payer → platform treasury, exact amount).
 *   3. Same POST WITH X-Payment
 *        → verifyPayment BROADCASTS the payment on devnet and confirms
 *          it (X402_SUBMIT_TRANSACTIONS=true), persists the X402Payment
 *          row, proxies the inference, returns the completion. Row =
 *          "verified".
 *   4. runX402SettlementTick() — the exact function the BullMQ worker
 *      runs — checks on-chain finality and flips verified → settled.
 *   5. Verify from primary sources: row settled; getParsedTransaction
 *      shows the treasury received exactly the required lamports.
 *
 * TWO substitutions, both at documented seams (the same class as the
 * D10 sim-host):
 *   - The GPU node is a localhost HTTP server returning an OpenAI-shaped
 *     completion — devnet has no payable Nosana hosts (C1 covers real
 *     ones). The URL passes the route's own SSRF allowlist (dev-only
 *     localhost pattern); everything from auth to billing to proxying is
 *     the production path.
 *   - The paying client is this script signing with the devnet payer —
 *     exactly what an x402-capable client does.
 *
 * Usage:
 *   npx tsx scripts/x402-devnet-proof.ts <orgId>
 *
 * Env: DATABASE_URL, SOLANA_NETWORK=devnet, X402_ENABLED=true,
 *      X402_INFERENCE_MODE=required, X402_DEFAULT_ASSET=SOL,
 *      X402_SUBMIT_TRANSACTIONS=true,
 *      TREASURY_WALLET_ADDRESS=<devnet treasury pubkey>,
 *      X402_PAYER_KEYPAIR (default ../../.devnet/payer.json).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import Fastify from "fastify";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

import { prisma } from "../src/lib/prisma.js";
import { getSolanaConnection } from "../src/lib/solana.js";
import { inferenceRoutes } from "../src/routes/inference.js";
import { runX402SettlementTick } from "../src/services/x402Settlement.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(msg: string): never {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
  );
}

async function main() {
  const [, , orgId] = process.argv;
  if (!orgId) {
    console.error("usage: npx tsx scripts/x402-devnet-proof.ts <orgId>");
    process.exit(2);
  }

  const payer = loadKeypair(process.env.X402_PAYER_KEYPAIR ?? "../../.devnet/payer.json");
  const treasuryPath = "../../.devnet/treasury.json";
  if (!existsSync(treasuryPath)) {
    const fresh = Keypair.generate();
    writeFileSync(treasuryPath, JSON.stringify(Array.from(fresh.secretKey)));
    console.log(`generated new devnet treasury keypair: ${fresh.publicKey.toBase58()}`);
  }
  const treasury = loadKeypair(treasuryPath);
  if (process.env.TREASURY_WALLET_ADDRESS !== treasury.publicKey.toBase58()) {
    fail(
      `TREASURY_WALLET_ADDRESS must be ${treasury.publicKey.toBase58()} (from .devnet/treasury.json) — got ${process.env.TREASURY_WALLET_ADDRESS ?? "(unset)"}`,
    );
  }

  const connection = getSolanaConnection();

  // The treasury account must exist on-chain before it can receive the
  // tiny x402 amounts (a transfer that would CREATE an account must be
  // rent-exempt; topping up an existing one has no minimum).
  const treasuryBalance = await connection.getBalance(treasury.publicKey);
  console.log(`treasury ${treasury.publicKey.toBase58()}: ${treasuryBalance} lamports`);
  if (treasuryBalance < 2_000_000) {
    console.log("funding treasury with 0.005 SOL from payer (rent exemption)…");
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: treasury.publicKey,
        lamports: 5_000_000,
      }),
    );
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    fundTx.recentBlockhash = blockhash;
    fundTx.lastValidBlockHeight = lastValidBlockHeight;
    fundTx.feePayer = payer.publicKey;
    fundTx.sign(payer);
    const fundSig = await connection.sendRawTransaction(fundTx.serialize());
    await connection.confirmTransaction(
      { signature: fundSig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    console.log(`  funded: ${fundSig}`);
  }

  // ---- localhost mock GPU node (documented substitution) ----
  const mockNode = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-x402proof",
          object: "chat.completion",
          model: "llama-3.1-8b",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content:
                  "x402 proof completion — this inference was paid per-request on devnet.",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => mockNode.listen(0, "127.0.0.1", resolve));
  const port = (mockNode.address() as AddressInfo).port;
  const nodeUrl = `http://127.0.0.1:${port}`;
  console.log(`mock GPU node listening at ${nodeUrl}`);

  // ---- seed deployment + healthy node ----
  const model = await prisma.model.findFirst({ where: { isActive: true } });
  if (!model) fail("no active Model row to attach the deployment to");
  const deployment = await prisma.deployment.upsert({
    where: { orgId_slug: { orgId, slug: "x402-proof" } },
    update: { status: "running" },
    create: {
      orgId,
      name: "x402 proof deployment",
      slug: "x402-proof",
      modelId: model.id,
      engine: model.defaultEngine,
      gpuTier: model.minGpuTier,
      replicas: 1,
      config: {},
      status: "running",
      nosanaJobIds: [],
    },
  });
  await prisma.deploymentNode.deleteMany({ where: { deploymentId: deployment.id } });
  await prisma.deploymentNode.create({
    data: {
      deploymentId: deployment.id,
      nosanaNodeId: "x402-proof-localhost",
      nodeUrl,
      healthStatus: "healthy",
      latencyMs: 1,
    },
  });
  console.log(`seeded deployment ${deployment.id} (slug x402-proof)`);

  // ---- the production route, auth stubbed for the proof tenant ----
  const app = Fastify({ logger: false });
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { auth: unknown }).auth = {
      userId: "x402-proof",
      orgId,
      role: "owner",
      type: "jwt",
    };
  });
  await app.register(inferenceRoutes);

  const chatBody = {
    messages: [{ role: "user" as const, content: "Prove x402 works." }],
    max_tokens: 32,
  };

  // ---- 1. no payment → 402 with the requirement ----
  const challenge = await app.inject({
    method: "POST",
    url: "/v1/x402-proof/chat/completions",
    payload: chatBody,
  });
  if (challenge.statusCode !== 402) {
    fail(`expected 402 challenge, got ${challenge.statusCode}: ${challenge.body}`);
  }
  const requirement = challenge.json().payment as {
    network: string;
    asset: string;
    amount: string;
    amountUsd: number;
    payTo: string;
  };
  console.log(`\n[1] 402 challenge received`);
  console.log(`    asset ${requirement.asset}, amount ${requirement.amount} lamports ($${requirement.amountUsd})`);
  console.log(`    payTo ${requirement.payTo}`);
  if (requirement.payTo !== treasury.publicKey.toBase58()) {
    fail("requirement payTo is not the treasury");
  }
  if (requirement.asset !== "SOL") fail("expected SOL asset for the devnet proof");

  // ---- 2. client signs the exact payment the requirement asks for ----
  const payTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: new PublicKey(requirement.payTo),
      lamports: BigInt(requirement.amount),
    }),
  );
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  payTx.recentBlockhash = blockhash;
  payTx.lastValidBlockHeight = lastValidBlockHeight;
  payTx.feePayer = payer.publicKey;
  payTx.sign(payer);
  const paymentHeader = JSON.stringify({
    signature: payTx.serialize().toString("base64"),
    network: requirement.network,
  });
  console.log(`[2] payment signed by ${payer.publicKey.toBase58()}`);

  // ---- 3. paid request → broadcast + verify + inference ----
  const paid = await app.inject({
    method: "POST",
    url: "/v1/x402-proof/chat/completions",
    payload: chatBody,
    headers: { "x-payment": paymentHeader },
  });
  if (paid.statusCode !== 200) {
    fail(`paid request -> ${paid.statusCode}: ${paid.body}`);
  }
  const completion = paid.json();
  const requestId = paid.headers["x-request-id"] as string;
  console.log(`[3] paid inference returned 200 (request ${requestId})`);
  console.log(`    completion: "${completion.choices[0].message.content}"`);

  const payment = await prisma.x402Payment.findFirst({
    where: { orgId, requestId },
  });
  if (!payment || payment.status !== "verified" || !payment.txSignature) {
    fail(`payment row not verified: ${JSON.stringify(payment)}`);
  }
  console.log(`    payment row ${payment.id}: status=${payment.status}`);
  console.log(`    tx signature: ${payment.txSignature}`);

  // ---- 4. settlement worker tick: verified → settled ----
  // The tick checks real on-chain finality; give devnet a moment.
  let settledRow = payment;
  for (let i = 0; i < 10; i++) {
    await runX402SettlementTick();
    settledRow = (await prisma.x402Payment.findUnique({
      where: { id: payment.id },
    }))!;
    if (settledRow.status === "settled") break;
    console.log(`    settlement tick #${i + 1}: still ${settledRow.status}; waiting…`);
    await sleep(3_000);
  }
  if (settledRow.status !== "settled") {
    fail(`payment never settled: ${JSON.stringify(settledRow)}`);
  }
  console.log(`[4] settlement worker settled the payment (settledAt ${settledRow.settledAt?.toISOString()})`);

  // ---- 5. on-chain verification ----
  const parsed = await connection.getParsedTransaction(payment.txSignature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!parsed || parsed.meta?.err) {
    fail(`on-chain tx missing or errored: ${JSON.stringify(parsed?.meta?.err)}`);
  }
  const keys = parsed.transaction.message.accountKeys.map((k) =>
    (k.pubkey as PublicKey).toBase58(),
  );
  const treasuryIndex = keys.indexOf(treasury.publicKey.toBase58());
  if (treasuryIndex < 0) fail("treasury not in tx accounts");
  const received =
    (parsed.meta!.postBalances[treasuryIndex] ?? 0) -
    (parsed.meta!.preBalances[treasuryIndex] ?? 0);
  console.log(`\n[5] on-chain verification (slot ${parsed.slot})`);
  console.log(`    treasury received: ${received} lamports (requirement: ${requirement.amount})`);
  if (String(received) !== requirement.amount) {
    fail("on-chain amount does not match the requirement");
  }

  console.log(`\n✅ x402 pay-per-request proven end-to-end on devnet`);
  console.log(
    `   explorer: https://explorer.solana.com/tx/${payment.txSignature}?cluster=devnet`,
  );

  await app.close();
  mockNode.close();
  await prisma.$disconnect();
  // web3.js keeps its websocket alive after confirmTransaction; exit
  // explicitly so the proof run terminates when the work is done.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
