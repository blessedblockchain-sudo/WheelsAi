/**
 * Proves the treasury: shows that somebody holds the key of
 * TREASURY_WALLET_ADDRESS, so sweeps may send money there.
 *
 *   cd apps/api && npx tsx scripts/treasury-verify.ts [--dry-run]
 *
 * Before running it, send 0.1 SOL from the treasury wallet to the hot
 * wallet (the API logs the hot wallet's address at start; this script
 * prints it too when it finds no proof).
 *
 * It refuses, in plain words, when TREASURY_WALLET_ADDRESS is not an
 * ordinary wallet address, is still the default, or is the hot wallet or a
 * deposit address. Otherwise it reads the hot wallet's finalized history
 * (newest first, up to 1,000 signatures) for a transaction that did not
 * fail, that the treasury address signed, and that left the hot wallet
 * with at least 0.1 SOL more. Found: it writes the platform_wallets row
 * (role "treasury", this chain). Not found: it writes nothing and says
 * what to do. With --dry-run it writes nothing either way. An address
 * that changed since it was proven is proven again the same way.
 *
 * It sends nothing and signs nothing. Reads: the Solana node and the
 * database. Writes: one row.
 *
 * It reads the same settings the API reads (apps/api/.env through dotenv,
 * or the environment it is run in): DATABASE_URL, WALLET_MASTER_KEY,
 * SOLANA_NETWORK, SOLANA_RPC_URL, TREASURY_WALLET_ADDRESS.
 *
 * Exit code: 0 proven (or already proven), 1 refused or no proof found,
 * 2 bad arguments, 3 no proof found while some transactions could not be
 * loaded (run it again before sending anything).
 */

import "./quiet-queries.js";
import "dotenv/config";

import { PublicKey } from "@solana/web3.js";

import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { ensureSolanaCluster, getSolanaConnection } from "../src/lib/solana.js";
import {
  transactionFactsFromRpc,
  type RpcTransactionLike,
} from "../src/services/depositScan.js";
import { chainLabel } from "../src/services/depositTypes.js";
import { hotWallet } from "../src/services/hotWallet.js";
import { verifyTreasury } from "../src/services/treasuryVerify.js";

const USAGE = "Usage: npx tsx scripts/treasury-verify.ts [--dry-run]\n";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run")) {
    process.stderr.write(USAGE);
    return 2;
  }
  const dryRun = args.includes("--dry-run");
  const network = chainLabel(env.SOLANA_NETWORK);

  const result = await verifyTreasury(
    { dryRun },
    {
      network,
      checkCluster: () => ensureSolanaCluster(),
      treasurySetting: env.TREASURY_WALLET_ADDRESS,
      hotWalletAddress: () => hotWallet.address(),
      // The row of a deposit address, or the address a prepared top-up was
      // sent to: the same check the sweep makes.
      isDepositAddress: async (address) =>
        (await prisma.depositAddress.findUnique({ where: { address } })) !== null ||
        (await prisma.walletTopUp.findFirst({
          where: { depositAddress: address },
          select: { id: true },
        })) !== null,
      loadProof: () =>
        prisma.platformWallet.findUnique({
          where: { role_network: { role: "treasury", network } },
        }),
      listHotWalletSignatures: async ({ limit }) => {
        const page = await getSolanaConnection().getSignaturesForAddress(
          new PublicKey(hotWallet.address()),
          { limit },
          "finalized",
        );
        return page.map((entry) => ({
          signature: entry.signature,
          failed: entry.err !== null && entry.err !== undefined,
        }));
      },
      loadTransaction: async (signature) => {
        const response = await getSolanaConnection().getTransaction(signature, {
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        });
        return transactionFactsFromRpc(
          signature,
          response as unknown as RpcTransactionLike | null,
        );
      },
      saveProof: async ({ address, proofSignature, verifiedAt }) => {
        await prisma.platformWallet.upsert({
          where: { role_network: { role: "treasury", network } },
          create: { role: "treasury", network, address, verifiedAt, proofSignature },
          update: { address, verifiedAt, proofSignature },
        });
      },
    },
  );

  out(`Chain: ${network}`);
  out(result.message);
  if (result.outcome === "proven" || result.outcome === "already_proven") return 0;
  return result.outcome === "not_found" && result.unreadable > 0 ? 3 : 1;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    process.stderr.write(`treasury-verify failed: ${err instanceof Error ? err.message : String(err)}\n`);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
