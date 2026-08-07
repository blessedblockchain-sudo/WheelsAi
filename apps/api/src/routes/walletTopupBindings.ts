/**
 * Production wiring for the wallet top-up rail (B2/T5).
 *
 * Always mounted under /api/billing — when WALLET_TOPUPS_ENABLED is
 * false the routes answer 501 honestly (mirroring the checkout gate)
 * instead of 404ing, so a probe tells the truth about why.
 *
 * env.ts enforces the config invariants at boot:
 *   - WALLET_TOPUPS_ENABLED ⇒ WALLET_MASTER_KEY present (deposit
 *     addresses derive from it), in every environment.
 *   - ALLOW_DEVNET_WALLET_TOPUPS is boot-fatal in production — the SOL
 *     rail prices from an operator quote, not an oracle.
 */

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { getSolanaConnection } from "../lib/solana.js";
import { deriveTopupDepositKeypair } from "../services/topupKeypairs.js";
import {
  makeCreditTopup,
  type TopupCreditDb,
} from "../services/walletTopup.js";
import { USDC_MINT } from "../services/x402.js";
import {
  createWalletTopupRoutes,
  type WalletTopupRouteDeps,
} from "./walletTopup.js";
import type { FastifyPluginAsync } from "fastify";

export function buildProductionWalletTopupDeps(): WalletTopupRouteDeps {
  const connection = () => getSolanaConnection();
  const network = env.SOLANA_NETWORK;

  return {
    enabled: env.WALLET_TOPUPS_ENABLED,
    network,
    devnetSolRailEnabled:
      env.ALLOW_DEVNET_WALLET_TOPUPS && network === "devnet",
    solPriceUsd: env.WALLET_TOPUP_SOL_PRICE_USD,
    usdcMint:
      network === "mainnet-beta"
        ? USDC_MINT.mainnet.toBase58()
        : USDC_MINT.devnet.toBase58(),

    deriveDepositAddress: (orgId) =>
      deriveTopupDepositKeypair({
        // enabled ⇒ present, enforced by env.ts; the fallback only makes
        // the closure safe to construct while the rail is disabled.
        masterKey: env.WALLET_MASTER_KEY ?? "",
        orgId,
      }).publicKey.toBase58(),

    getLatestBlockhash: async () => {
      const { blockhash, lastValidBlockHeight } =
        await connection().getLatestBlockhash("confirmed");
      return { blockhash, lastValidBlockHeight };
    },

    createTopup: async (data) => {
      await prisma.walletTopUp.create({
        data: {
          id: data.id,
          orgId: data.orgId,
          asset: data.asset,
          network: data.network,
          amountUsdCents: data.amountUsdCents,
          bonusCents: data.bonusCents,
          amountRaw: data.amountRaw,
          quotedSolPriceUsd: data.quotedSolPriceUsd,
          payerAddress: data.payerAddress,
          depositAddress: data.depositAddress,
          unsignedMessageB64: data.unsignedMessageB64,
          expiresAt: data.expiresAt,
          lastValidBlockHeight: data.lastValidBlockHeight,
        },
      });
    },

    findTopup: async ({ id, orgId }) => {
      const row = await prisma.walletTopUp.findFirst({
        where: { id, orgId },
      });
      if (!row) return null;
      return {
        id: row.id,
        orgId: row.orgId,
        asset: row.asset,
        network: row.network,
        amountUsdCents: row.amountUsdCents,
        bonusCents: row.bonusCents,
        amountRaw: row.amountRaw,
        quotedSolPriceUsd: row.quotedSolPriceUsd,
        payerAddress: row.payerAddress,
        depositAddress: row.depositAddress,
        unsignedMessageB64: row.unsignedMessageB64,
        txSignature: row.txSignature,
        status: row.status,
        failureReason: row.failureReason,
        expiresAt: row.expiresAt,
        lastValidBlockHeight: row.lastValidBlockHeight,
      };
    },

    claimForSubmit: async ({ id, txSignature }) => {
      try {
        const result = await prisma.walletTopUp.updateMany({
          where: { id, status: "prepared" },
          data: { status: "submitting", txSignature },
        });
        return result.count === 1 ? "claimed" : "lost";
      } catch (err) {
        if ((err as { code?: string }).code === "P2002") {
          return "duplicate_signature";
        }
        throw err;
      }
    },

    markStatus: async ({ id, from, to, failureReason }) => {
      const result = await prisma.walletTopUp.updateMany({
        where: { id, status: { in: from } },
        data: {
          status: to,
          ...(failureReason !== undefined ? { failureReason } : {}),
        },
      });
      return result.count === 1;
    },

    expireStalePrepared: async ({ orgId, now }) => {
      await prisma.walletTopUp.updateMany({
        where: { orgId, status: "prepared", expiresAt: { lt: now } },
        data: { status: "expired" },
      });
    },

    sendRawTransaction: async (rawTxBase64) => {
      try {
        await connection().sendRawTransaction(
          Buffer.from(rawTxBase64, "base64"),
          { skipPreflight: false, maxRetries: 3 },
        );
        return { ok: true };
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        return {
          ok: false,
          kind: /blockhash not found/i.test(message)
            ? "blockhash_expired"
            : "rejected",
          message,
        };
      }
    },

    confirmTransaction: async ({ signature, blockhash, lastValidBlockHeight }) => {
      try {
        const res = await connection().confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          "confirmed",
        );
        if (res.value.err) {
          return {
            outcome: "failed_on_chain",
            err: JSON.stringify(res.value.err),
          };
        }
        return { outcome: "confirmed" };
      } catch {
        // Expiry watchers and websocket hiccups both land here. The row
        // stays 'submitted'; reconcile settles it against the chain.
        return { outcome: "unresolved" };
      }
    },

    getSignatureStatus: async (signature) => {
      const res = await connection().getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const status = res.value[0];
      if (!status) return { found: false, confirmed: false, err: null };
      return {
        found: true,
        confirmed:
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized",
        err: status.err ? JSON.stringify(status.err) : null,
      };
    },

    getBlockHeight: () => connection().getBlockHeight("confirmed"),

    creditTopup: makeCreditTopup(prisma as unknown as TopupCreditDb),
  };
}

export function createWalletTopupRoutesProduction(): FastifyPluginAsync {
  return createWalletTopupRoutes(buildProductionWalletTopupDeps());
}
