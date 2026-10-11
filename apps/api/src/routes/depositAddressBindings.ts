/**
 * Production wiring for the deposit address routes.
 *
 * Always mounted under /api/billing: while DEPOSITS_ENABLED is false the
 * routes answer 501 instead of 404ing, so a probe tells the truth about
 * why.
 *
 * The parts, each of which can be given a stand-in:
 *   - buildDepositAddressStore(db) (services/depositAddresses.ts): every
 *     read and write of deposit_addresses the routes make.
 *   - buildDepositUsdcChain(...) (services/depositUsdcAccount.ts): the one
 *     read and the one send against the shared Solana connection.
 *   - checkDepositsNow (services/buildDepositScanTickDeps.ts): the scan of
 *     one organization's address, the only thing here that credits.
 *
 * env.ts enforces at start that DEPOSITS_ENABLED has the wallet rail (and
 * so WALLET_MASTER_KEY, which the addresses derive from) and, outside
 * development, the scan worker.
 */

import type { FastifyPluginAsync } from "fastify";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { ensureSolanaCluster, getSolanaConnection } from "../lib/solana.js";
import { usdcMintForNetwork } from "../lib/solanaAssets.js";
import { checkDepositsNow } from "../services/buildDepositScanTickDeps.js";
import {
  buildDepositAddressStore,
  issueDepositAddress,
  readDepositAddress,
  readUsdcAccountOpen,
  type DepositAddressDeps,
  type DepositAddressStoreDb,
} from "../services/depositAddresses.js";
import { chainLabel } from "../services/depositTypes.js";
import {
  buildDepositUsdcChain,
  prepareUsdcAccount,
} from "../services/depositUsdcAccount.js";
import { hotWallet, solToLamports } from "../services/hotWallet.js";
import { deriveTopupDepositKeypair } from "../services/topupKeypairs.js";
import {
  createDepositAddressRoutes,
  type DepositAddressRouteDeps,
} from "./depositAddress.js";

export function buildProductionDepositAddressDeps(): DepositAddressRouteDeps {
  const network = chainLabel(env.SOLANA_NETWORK);
  const store = buildDepositAddressStore(prisma as unknown as DepositAddressStoreDb);
  const chain = buildDepositUsdcChain({
    getConnection: () => getSolanaConnection(),
    ensureCluster: () => ensureSolanaCluster(),
    usdcMint: usdcMintForNetwork(env.SOLANA_NETWORK),
    hotWalletKeypair: () => hotWallet.keypair(),
  });

  const addressDeps: DepositAddressDeps = {
    store,
    // enabled ⇒ present, enforced by env.ts; with no key this throws and
    // the route answers 503.
    deriveAddress: (orgId) =>
      deriveTopupDepositKeypair({
        masterKey: env.WALLET_MASTER_KEY ?? "",
        orgId,
      }).publicKey.toBase58(),
    network,
    usdcAccountExists: chain.usdcAccountExists,
  };

  return {
    enabled: env.DEPOSITS_ENABLED,
    network: env.SOLANA_NETWORK,
    solOffered: env.SOL_PRICE_SOURCE !== "off",

    readAddress: (orgId) => readDepositAddress(addressDeps, orgId),
    issueAddress: (orgId) => issueDepositAddress(addressDeps, orgId),
    usdcAccountOpen: (row, options) => readUsdcAccountOpen(addressDeps, row, options),

    prepareUsdcAccount: (orgId) =>
      prepareUsdcAccount(
        {
          readAddress: (id) => readDepositAddress(addressDeps, id),
          store,
          usdcAccountExists: chain.usdcAccountExists,
          ensureCluster: () => ensureSolanaCluster(),
          readHotWalletLamports: () => hotWallet.readLamports(),
          minHotWalletLamports: solToLamports(env.HOT_WALLET_MIN_SOL),
          dailyLimit: env.DEPOSIT_ACCOUNT_OPENS_PER_DAY,
          sendOpenUsdcAccount: chain.sendOpenUsdcAccount,
        },
        orgId,
      ),

    requestScan: async (orgId) => {
      await store.requestScan({ orgId, network, at: new Date() });
    },
    checkDepositsNow: (orgId) => checkDepositsNow(orgId),
    listDeposits: ({ orgId, limit }) =>
      store.listDirectReceipts({ orgId, network, limit }),
  };
}

export function createDepositAddressRoutesProduction(): FastifyPluginAsync {
  return createDepositAddressRoutes(buildProductionDepositAddressDeps());
}
