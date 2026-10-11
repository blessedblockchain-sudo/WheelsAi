/**
 * x402 proof: paying for one request with an on-chain transfer, through the
 * PRODUCTION route code (createInferenceRoutes, the plugin index.ts mounts at
 * /v1) and the PRODUCTION settlement worker's own function.
 *
 * The chain is whatever the settings name: SOLANA_NETWORK and SOLANA_RPC_URL
 * choose it, TREASURY_WALLET_ADDRESS is who is paid, and the USDC mint is the
 * one the API itself uses for that network (lib/solanaAssets.ts). No address
 * is written in this file. It runs the same on a local chain, on devnet and
 * on mainnet (mainnet needs X402_PROOF_ALLOW_MAINNET=1: it spends real money,
 * a fraction of a cent a step plus the network fees).
 *
 * What it proves, one PASS or FAIL a step:
 *   USDC
 *     1. A request with no payment is answered 402 and asks for USDC at the
 *        treasury's token account, naming the mint.
 *     2. A payment by CHECKED transfer (what wallets send) to that account
 *        is accepted and the request is served. The row is "verified" with
 *        the signature, what was sent, and servedAt.
 *     3. The same signed transaction a second time is answered 409.
 *     4. A paid request whose node fails gets its payment RETURNED: the row
 *        is "refunded" for what was actually sent, the organization's carry
 *        and balance together grow by exactly that, and the answer says so.
 *   SOL
 *     5. The 402 asks for lamports and carries a quote (the rate lock).
 *     6. A payment of that many lamports, presented with the quote, is
 *        accepted and served; the lamports are the price at the quoted rate.
 *     7. The same signed transaction a second time is answered 409.
 *     8. A paid request whose node fails gets its payment returned, valued
 *        at the row's rate.
 *   Then
 *     9. The settlement worker's function settles the served payments, and
 *        no payment of this run is left "verified".
 *    10. The chain agrees: each payment moved exactly what was sent to the
 *        treasury (its USDC account, or the wallet for SOL).
 *
 * THREE substitutions, each at a seam the route already has:
 *   - The GPU node is an HTTP server on 127.0.0.1 that answers with an
 *     OpenAI-shaped completion, or with a 500 when a step needs a node that
 *     fails. The route's own allowlist lets a node on this machine through
 *     only in a development process with ALLOW_LOOPBACK_NODE_URLS=true; the
 *     script stops before anything is paid when that is not so.
 *   - The caller's session is given through the route's `auth` dependency
 *     (the organization on the command line). Everything after
 *     authentication is the production path.
 *   - The paying client is this script, signing with a local keypair:
 *     what an x402 client does.
 * One more thing a single run needs: the route asks for the asset in
 * X402_DEFAULT_ASSET, so the script sets that setting in this process to
 * prove USDC and then SOL in one run. Pass USDC or SOL as the second argument
 * to prove one asset only and leave the setting alone.
 *
 * Usage:
 *   npx tsx scripts/x402-devnet-proof.ts <orgId> [USDC|SOL]
 *
 * It reads the same settings the API reads (apps/api/.env through dotenv, or
 * the environment it is run in; what is set in the environment wins):
 * Settings: DATABASE_URL, SOLANA_NETWORK, SOLANA_RPC_URL, X402_ENABLED=true,
 *   X402_INFERENCE_MODE=required, X402_SUBMIT_TRANSACTIONS=true,
 *   NODE_ENV=development and ALLOW_LOOPBACK_NODE_URLS=true (the stand-in node),
 *   TREASURY_WALLET_ADDRESS (the treasury of that chain),
 *   X402_PAYER_KEYPAIR (default ../../.devnet/payer.json).
 *   For SOL: SOL_PRICE_SOURCE=pyth, or static with SOL_PRICE_STATIC_USD on a
 *   local chain. With SOL_PRICE_SOURCE=off the SOL steps fail by design.
 * The payer needs a little SOL for fees and, for the USDC steps, a USDC
 * account holding at least 10,000 base units (one cent). The treasury
 * wallet must exist on the chain; if it or its USDC account does not, the
 * payer opens it first (the rent is the payer's).
 */

import "dotenv/config";

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import Fastify from "fastify";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";

import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { MEMO_PROGRAM_ID, ensureSolanaCluster, getSolanaConnection } from "../src/lib/solana.js";
import { usdcMintForNetwork } from "../src/lib/solanaAssets.js";
import { createInferenceRoutes } from "../src/routes/inference.js";
import { isAllowedNodeUrl } from "../src/services/nodeUrlAllowlist.js";
import { nodeUrlAllowlistOptions } from "../src/services/nosana.js";
import { runX402SettlementTick } from "../src/services/x402Settlement.js";

type Asset = "USDC" | "SOL";

const SLUG = "x402-proof";
const USDC_DECIMALS = 6;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const MICRO_USD_PER_CENT = 10_000n;
/** Sent on top of the price in the "node fails" step: what is returned is what was SENT. */
const OVERPAY_RAW = 7n;
const RETURNED_MESSAGE =
  "Your payment for this request was returned to your credit balance. Amounts under a cent add up and appear once they reach a cent.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- PASS / FAIL ----

let failures = 0;
let stepNo = 0;

/** One numbered step: every check in it must hold. Prints PASS or FAIL. */
async function step(title: string, run: (check: (ok: boolean, what: string) => void) => Promise<void>) {
  stepNo += 1;
  const problems: string[] = [];
  const check = (ok: boolean, what: string) => {
    if (!ok) problems.push(what);
  };
  try {
    await run(check);
  } catch (err) {
    problems.push(`threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (problems.length === 0) {
    console.log(`PASS  ${stepNo}. ${title}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${stepNo}. ${title}`);
    for (const p of problems) console.log(`        - ${p}`);
  }
}

/** A problem that stops the run before any step: wrong settings, no funds. */
function stop(msg: string): never {
  console.error(`\nFAIL  cannot start: ${msg}`);
  process.exit(1);
}

// ---- the wire ----

interface Requirement {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  amountUsd: number;
  payTo: string;
  payToTokenAccount: string | null;
  mint: string | null;
  memo: string;
  validUntil: number;
  quote: string | null;
}

interface Challenge {
  requirement: Requirement;
  requestId: string;
}

interface SentPayment {
  asset: Asset;
  signature: string;
  header: string;
  sentRaw: bigint;
  requestId: string;
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

async function main() {
  const [, , orgId, assetArg] = process.argv;
  const only = assetArg?.toUpperCase();
  if (!orgId || (only !== undefined && only !== "USDC" && only !== "SOL")) {
    console.error("usage: npx tsx scripts/x402-devnet-proof.ts <orgId> [USDC|SOL]");
    process.exit(2);
  }
  const assets: Asset[] = only ? [only as Asset] : ["USDC", "SOL"];

  // ---- the settings this proof stands on ----
  if (!env.X402_ENABLED) stop("X402_ENABLED must be true");
  if (env.X402_INFERENCE_MODE !== "required") {
    stop("X402_INFERENCE_MODE must be required, so that every request is challenged whatever the credit balance");
  }
  if (!env.X402_SUBMIT_TRANSACTIONS) {
    stop("X402_SUBMIT_TRANSACTIONS must be true: with it off nothing is sent to the chain and nothing is proven");
  }
  if (env.SOLANA_NETWORK === "mainnet-beta" && process.env.X402_PROOF_ALLOW_MAINNET !== "1") {
    stop("SOLANA_NETWORK is mainnet-beta: this spends real money. Set X402_PROOF_ALLOW_MAINNET=1 to run it there");
  }
  // The stand-in node is on this machine. If the route would refuse its
  // address, a paid request could never be served: stop before any payment.
  if (!isAllowedNodeUrl("http://127.0.0.1:1", nodeUrlAllowlistOptions())) {
    stop(
      "the route refuses a GPU node on this machine: the stand-in node needs NODE_ENV=development and ALLOW_LOOPBACK_NODE_URLS=true",
    );
  }
  const cluster = await ensureSolanaCluster();
  if (!cluster.ok) stop("the node at SOLANA_RPC_URL does not answer for the chain in SOLANA_NETWORK");

  const network = `solana:${env.SOLANA_NETWORK === "mainnet-beta" ? "mainnet" : env.SOLANA_NETWORK}`;
  const treasury = new PublicKey(env.TREASURY_WALLET_ADDRESS);
  const usdcMint = usdcMintForNetwork(env.SOLANA_NETWORK);
  const treasuryUsdc = getAssociatedTokenAddressSync(usdcMint, treasury, true);
  const payer = loadKeypair(process.env.X402_PAYER_KEYPAIR ?? "../../.devnet/payer.json");
  const payerUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey, true);
  const connection = getSolanaConnection();

  console.log(`chain     ${env.SOLANA_NETWORK}`);
  console.log(`treasury  ${treasury.toBase58()}`);
  console.log(`payer     ${payer.publicKey.toBase58()}`);
  console.log(`assets    ${assets.join(", ")}\n`);

  /** Signs with the payer, sends and waits. Setup only: never a payment. */
  const sendSetup = async (instructions: TransactionInstruction[], what: string) => {
    const tx = new Transaction().add(...instructions);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    const sig = await connection.sendRawTransaction(tx.serialize());
    const result = await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (result.value.err) stop(`setup failed (${what}): ${sig}`);
    console.log(`setup     ${what}: ${sig}`);
  };

  // A transfer that would CREATE the treasury's account must leave it
  // rent-exempt, and an x402 payment is far smaller than that: the account
  // has to exist first.
  if (assets.includes("SOL")) {
    const rent = await connection.getMinimumBalanceForRentExemption(0);
    const held = await connection.getBalance(treasury);
    if (held < rent) {
      await sendSetup(
        [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: treasury, lamports: rent - held })],
        "treasury wallet brought up to the rent-exempt minimum",
      );
    }
  }
  if (assets.includes("USDC")) {
    if (!(await connection.getAccountInfo(treasuryUsdc))) {
      await sendSetup(
        [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, treasuryUsdc, treasury, usdcMint)],
        "treasury USDC account opened",
      );
    }
    const funds = await connection.getTokenAccountBalance(payerUsdc).catch(() => null);
    if (!funds || BigInt(funds.value.amount) < 10_000n) {
      stop(
        `the payer needs USDC of this chain (mint ${usdcMint.toBase58()}) in its token account ${payerUsdc.toBase58()}: at least 10000 base units (one cent)`,
      );
    }
  }

  // ---- the stand-in GPU node ----
  let nodeFails = false;
  const mockNode = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (nodeFails) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "x402 proof: this node fails on purpose" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-x402proof",
          object: "chat.completion",
          model: "x402-proof",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "x402 proof completion: this request was paid for on its own." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => mockNode.listen(0, "127.0.0.1", resolve));
  const nodeUrl = `http://127.0.0.1:${(mockNode.address() as AddressInfo).port}`;

  // ---- a deployment billed per request, with one healthy node ----
  const model = await prisma.model.findFirst({ where: { isActive: true } });
  if (!model) stop("no active Model row to attach the deployment to");
  const deployment = await prisma.deployment.upsert({
    where: { orgId_slug: { orgId, slug: SLUG } },
    update: { status: "running" },
    create: {
      orgId,
      name: "x402 proof deployment",
      slug: SLUG,
      modelId: model.id,
      engine: model.defaultEngine,
      gpuTier: model.minGpuTier,
      replicas: 1,
      config: {},
      status: "running",
      // No Nosana job: not billed per GPU-second, so requests are billed one
      // by one, which is where x402 applies.
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
  const nodeHealthy = () =>
    prisma.deploymentNode.updateMany({
      where: { deploymentId: deployment.id },
      data: { healthStatus: "healthy" },
    });

  // ---- the production route; only the session is given ----
  const app = Fastify({ logger: false });
  app.decorateRequest("auth", null);
  await app.register(
    createInferenceRoutes({
      auth: async (request) => {
        (request as unknown as { auth: unknown }).auth = {
          userId: "x402-proof",
          orgId,
          role: "owner",
          type: "jwt",
        };
      },
    }),
  );

  const url = `/v1/${SLUG}/chat/completions`;
  const chatBody = {
    messages: [{ role: "user" as const, content: "Prove x402 works." }],
    max_tokens: 32,
  };

  /** A request with no payment: the 402 and what it asks for. */
  const challengeFor = async (asset: Asset): Promise<Challenge> => {
    // The one setting this run changes, in this process only (see the header).
    if (!only) env.X402_DEFAULT_ASSET = asset;
    await nodeHealthy();
    const res = await app.inject({ method: "POST", url, payload: chatBody });
    if (res.statusCode !== 402) throw new Error(`expected a 402 challenge, got ${res.statusCode}: ${res.body}`);
    const body = res.json() as { payment: Requirement; requestId: string };
    // The same requirement is carried by the X-Payment-Required header.
    const header = res.headers["x-payment-required"];
    let inHeader: Partial<Requirement> | null = null;
    try {
      inHeader = typeof header === "string" ? (JSON.parse(header) as Partial<Requirement>) : null;
    } catch {
      inHeader = null;
    }
    if (!inHeader || inHeader.amount !== body.payment?.amount || inHeader.asset !== body.payment?.asset) {
      throw new Error("the X-Payment-Required header does not carry the requirement of the body");
    }
    return { requirement: body.payment, requestId: body.requestId };
  };

  /** Signs the transfer a challenge asks for. Nothing is sent: the API sends it. */
  const signPayment = async (asset: Asset, challenge: Challenge, extraRaw = 0n): Promise<SentPayment> => {
    const { requirement, requestId } = challenge;
    const sentRaw = BigInt(requirement.amount) + extraRaw;
    const transfer =
      asset === "USDC"
        ? createTransferCheckedInstruction(
            payerUsdc,
            new PublicKey(requirement.mint ?? ""),
            new PublicKey(requirement.payToTokenAccount ?? ""),
            payer.publicKey,
            sentRaw,
            USDC_DECIMALS,
          )
        : SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: new PublicKey(requirement.payTo),
            lamports: sentRaw,
          });
    // The memo is what a wallet may add, and it makes every payment's bytes
    // (and so its signature) its own, even two of one amount on one blockhash.
    const memo = new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(requirement.memo, "utf8"),
    });
    const tx = new Transaction().add(transfer, memo);
    const { blockhash } = await connection.getLatestBlockhash("finalized");
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    if (!tx.signature) throw new Error("the payment was not signed");
    return {
      asset,
      signature: bs58.encode(tx.signature),
      header: JSON.stringify({
        signature: tx.serialize().toString("base64"),
        network: requirement.network,
        ...(requirement.quote ? { quote: requirement.quote } : {}),
      }),
      sentRaw,
      requestId,
    };
  };

  const pay = (payment: SentPayment, requestId = payment.requestId) =>
    app.inject({
      method: "POST",
      url,
      payload: chatBody,
      headers: { "x-payment": payment.header, "x-request-id": requestId },
    });

  const rowOf = (payment: SentPayment) =>
    prisma.x402Payment.findUnique({ where: { txSignature: payment.signature } });

  /** What the organization holds: whole cents, and returns not yet a cent. */
  const holdings = async () => {
    const row = await prisma.creditBalance.findUnique({ where: { orgId } });
    return { cents: row?.balanceCents ?? 0n, carry: row?.x402RefundCarryMicroUsd ?? 0n };
  };

  const served: SentPayment[] = [];
  const returned: SentPayment[] = [];

  for (const asset of assets) {
    const unit = asset === "USDC" ? "USDC base units" : "lamports";
    // Filled by the steps as they pass; a later step needs the earlier one.
    const got: { challenge: Challenge | null; first: SentPayment | null } = { challenge: null, first: null };

    await step(`${asset}: a request with no payment is answered 402 and says where to pay`, async (check) => {
      const c = await challengeFor(asset);
      const r = c.requirement;
      check(r.asset === asset, `the 402 asks for ${r.asset}, not ${asset}`);
      if (r.asset !== asset) {
        if (asset === "SOL" && env.X402_DEFAULT_ASSET === "SOL") {
          check(false, "SOL is asked for only with a SOL price: set SOL_PRICE_SOURCE (pyth, or static on a local chain)");
        } else {
          check(false, `X402_DEFAULT_ASSET is ${env.X402_DEFAULT_ASSET}: set it to ${asset} to prove ${asset} alone`);
        }
        return;
      }
      check(r.scheme === "exact", `scheme is ${r.scheme}`);
      check(r.network === network, `network is ${r.network}, the settings say ${network}`);
      check(r.payTo === treasury.toBase58(), `payTo is ${r.payTo}, not the treasury`);
      check(/^[1-9]\d*$/.test(r.amount), `amount is not a whole number above zero: ${r.amount}`);
      check(r.validUntil > Math.floor(Date.now() / 1000), "validUntil is not in the future");
      check(typeof c.requestId === "string" && c.requestId.length > 0, "no requestId");
      if (asset === "USDC") {
        check(
          r.payToTokenAccount === treasuryUsdc.toBase58(),
          `payToTokenAccount is ${r.payToTokenAccount}, the treasury's USDC account is ${treasuryUsdc.toBase58()}`,
        );
        check(r.mint === usdcMint.toBase58(), `mint is ${r.mint}, the chain's USDC mint is ${usdcMint.toBase58()}`);
        check(r.quote === null, "a USDC challenge carries a quote");
      } else {
        check(r.payToTokenAccount === null && r.mint === null, "a SOL challenge names a token account or a mint");
        check(typeof r.quote === "string" && r.quote.length > 0, "a SOL challenge carries no quote");
      }
      got.challenge = c;
      console.log(`        asks for ${r.amount} ${unit} ($${r.amountUsd})`);
    });

    await step(
      asset === "USDC"
        ? "USDC: a payment by checked transfer is accepted and the request is served"
        : "SOL: a payment at the quoted rate is accepted and the request is served",
      async (check) => {
        const challenge = got.challenge;
        if (!challenge) throw new Error("no challenge to pay (the step above failed)");
        const payment = await signPayment(asset, challenge);
        const res = await pay(payment);
        check(res.statusCode === 200, `the paid request answered ${res.statusCode}: ${res.body}`);
        if (res.statusCode !== 200) return;
        const content = (res.json() as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message
          ?.content;
        check(typeof content === "string" && content.length > 0, "no completion in the answer");
        const row = await rowOf(payment);
        if (!row) throw new Error(`no payment row for signature ${payment.signature}`);
        check(row.orgId === orgId, "the row is another organization's");
        check(row.status === "verified" || row.status === "settled", `the row is ${row.status}`);
        check(row.servedAt !== null, "servedAt is not set on a served request");
        check(row.refundedAt === null, "a served request was returned");
        check(row.asset === asset, `the row's asset is ${row.asset}`);
        check(row.amountRaw === challenge.requirement.amount, `the row requires ${row.amountRaw}`);
        check(
          row.amountReceivedRaw === payment.sentRaw.toString(),
          `the row says ${row.amountReceivedRaw} was sent, the transfer carried ${payment.sentRaw}`,
        );
        check(row.signedTxB64 !== null && row.recentBlockhash !== null, "the signed bytes or the blockhash are not on the row");
        check(row.amountMicroUsd !== null && row.amountMicroUsd > 0n, "the price in micro-dollars is not on the row");
        if (asset === "USDC") {
          check(
            row.amountMicroUsd === BigInt(challenge.requirement.amount),
            `USDC base units must equal micro-dollars: ${row.amountMicroUsd} against ${challenge.requirement.amount}`,
          );
        } else if (row.amountMicroUsd !== null) {
          const rate = row.solMicroUsdPerSol;
          check(rate !== null && rate > 0n, "the quoted rate is not on the row");
          if (rate !== null && rate > 0n) {
            // Lamports for the price at the quoted rate, rounded up.
            const lamports = (row.amountMicroUsd * LAMPORTS_PER_SOL + rate - 1n) / rate;
            check(
              lamports.toString() === challenge.requirement.amount,
              `at the quoted rate the price is ${lamports} lamports, the 402 asked for ${challenge.requirement.amount}`,
            );
          }
        }
        got.first = payment;
        served.push(payment);
        console.log(`        signature ${payment.signature}`);
      },
    );

    await step(`${asset}: the same signature a second time is answered 409`, async (check) => {
      const first = got.first;
      if (!first) throw new Error("no served payment to present again (the step above failed)");
      const before = await prisma.x402Payment.count({ where: { orgId } });
      const res = await pay(first, `x402_proof_again_${Date.now()}`);
      check(res.statusCode === 409, `the second use answered ${res.statusCode}: ${res.body}`);
      const code = (res.json() as { error?: { code?: string } }).error?.code;
      check(code === "payment_already_used", `the error code is ${code}`);
      check((await prisma.x402Payment.count({ where: { orgId } })) === before, "the second use wrote a row");
    });

    await step(`${asset}: a paid request whose node fails has its payment returned`, async (check) => {
      const c = await challengeFor(asset);
      if (c.requirement.asset !== asset) throw new Error(`the 402 asks for ${c.requirement.asset}, not ${asset}`);
      // A little more than the price: what comes back is what was sent.
      const payment = await signPayment(asset, c, OVERPAY_RAW);
      const before = await holdings();
      nodeFails = true;
      let res;
      try {
        res = await pay(payment);
      } finally {
        nodeFails = false;
      }
      check(res.statusCode >= 500, `a request whose node failed answered ${res.statusCode}: ${res.body}`);
      const body = res.json() as {
        error?: unknown;
        payment?: { status?: string; amountUsd?: number; message?: string };
      };
      check(body.error !== undefined, "the answer has no error");
      check(body.payment?.status === "returned", `payment.status in the answer is ${body.payment?.status}`);
      check(body.payment?.message === RETURNED_MESSAGE, `payment.message in the answer is: ${body.payment?.message}`);

      const row = await rowOf(payment);
      if (!row) throw new Error(`no payment row for signature ${payment.signature}`);
      check(row.status === "refunded", `the row is ${row.status}, not refunded`);
      check(row.refundedAt !== null, "refundedAt is not set");
      check(row.servedAt === null, "servedAt is set on a request that was not served");
      check(row.amountReceivedRaw === payment.sentRaw.toString(), `the row says ${row.amountReceivedRaw} was sent`);

      // What was sent, in micro-dollars: USDC base units as they are; SOL at
      // the row's rate, rounded down.
      let sentMicroUsd: bigint | null = null;
      if (asset === "USDC") sentMicroUsd = payment.sentRaw;
      else if (row.solMicroUsdPerSol !== null) sentMicroUsd = (payment.sentRaw * row.solMicroUsdPerSol) / LAMPORTS_PER_SOL;
      check(sentMicroUsd !== null, "the quoted rate is not on the row");
      if (sentMicroUsd === null) return;
      check(row.refundMicroUsd === sentMicroUsd, `refundMicroUsd is ${row.refundMicroUsd}, what was sent is ${sentMicroUsd}`);

      const after = await holdings();
      const grew = after.carry - before.carry + (after.cents - before.cents) * MICRO_USD_PER_CENT;
      check(
        grew === sentMicroUsd,
        `the carry and the balance grew by ${grew} micro-dollars together, what was sent is ${sentMicroUsd}`,
      );
      check(after.carry >= 0n && after.carry < MICRO_USD_PER_CENT, `the carry holds a whole cent or more: ${after.carry}`);
      const centsMoved = after.cents - before.cents;
      const ledger = await prisma.creditTransaction.findMany({
        where: { orgId, type: "x402_refund", referenceId: row.id },
      });
      check(
        ledger.length === (centsMoved > 0n ? 1 : 0),
        `${ledger.length} ledger row(s) for this return, with ${centsMoved} whole cent(s) moved to the balance`,
      );
      if (ledger.length === 1) {
        check(ledger[0]!.amountCents === centsMoved, `the ledger row is for ${ledger[0]!.amountCents} cents`);
      }
      returned.push(payment);
      console.log(`        signature ${payment.signature}: ${sentMicroUsd} micro-dollars returned`);
    });
  }

  await step("the settlement worker settles the served payments and leaves none of this run verified", async (check) => {
    const all = [...served, ...returned];
    if (all.length === 0) throw new Error("no payment of this run landed");
    const signatures = all.map((p) => p.signature);
    // The worker settles a served payment once its transaction is final.
    let rows = await prisma.x402Payment.findMany({ where: { txSignature: { in: signatures } } });
    for (let i = 0; i < 30; i++) {
      await runX402SettlementTick();
      rows = await prisma.x402Payment.findMany({ where: { txSignature: { in: signatures } } });
      if (!rows.some((r) => r.status === "verified" || r.status === "submitted")) break;
      await sleep(3_000);
    }
    check(rows.length === all.length, `${rows.length} rows for ${all.length} payments`);
    for (const p of served) {
      const row = rows.find((r) => r.txSignature === p.signature);
      check(row?.status === "settled", `served ${p.asset} payment ${p.signature} is ${row?.status}, not settled`);
      check(row?.refundedAt === null, `served ${p.asset} payment ${p.signature} was returned`);
    }
    for (const p of returned) {
      const row = rows.find((r) => r.txSignature === p.signature);
      check(row?.status === "refunded", `returned ${p.asset} payment ${p.signature} is ${row?.status}`);
    }
    const left = await prisma.x402Payment.count({
      where: { orgId, deploymentId: deployment.id, status: "verified", txSignature: { in: signatures } },
    });
    check(left === 0, `${left} payment(s) of this run left verified`);
  });

  await step("the chain agrees: each payment moved exactly what was sent to the treasury", async (check) => {
    const all = [...served, ...returned];
    if (all.length === 0) throw new Error("no payment of this run landed");
    for (const p of all) {
      const tx = await connection.getTransaction(p.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || !tx.meta) {
        check(false, `${p.asset} ${p.signature}: the chain does not have it`);
        continue;
      }
      check(tx.meta.err === null, `${p.asset} ${p.signature}: it failed on the chain`);
      const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
      let received: bigint;
      if (p.asset === "SOL") {
        const i = keys.indexOf(treasury.toBase58());
        received = i < 0 ? -1n : BigInt(tx.meta.postBalances[i] ?? 0) - BigInt(tx.meta.preBalances[i] ?? 0);
      } else {
        const i = keys.indexOf(treasuryUsdc.toBase58());
        const amountAt = (balances: typeof tx.meta.postTokenBalances) =>
          BigInt(balances?.find((b) => b.accountIndex === i)?.uiTokenAmount.amount ?? "0");
        received = i < 0 ? -1n : amountAt(tx.meta.postTokenBalances) - amountAt(tx.meta.preTokenBalances);
      }
      check(received === p.sentRaw, `${p.asset} ${p.signature}: the treasury received ${received}, ${p.sentRaw} was sent`);
    }
  });

  console.log(
    failures === 0
      ? `\nPASS  every step, on ${env.SOLANA_NETWORK}`
      : `\nFAIL  ${failures} of ${stepNo} steps, on ${env.SOLANA_NETWORK}`,
  );

  await app.close();
  mockNode.close();
  await prisma.$disconnect();
  // web3.js keeps its connection alive: leave explicitly when the work is done.
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  console.error("\nFAIL  the proof stopped on an error");
  process.exit(1);
});
