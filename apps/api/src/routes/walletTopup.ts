/**
 * POST /topups/prepare, /topups/:id/submit, /topups/:id/reconcile and
 * GET /topups/:id — the Solana wallet top-up rail (B2/T5), mounted
 * under /api/billing.
 *
 * Flow (mirrors the token-launch partial-sign shape):
 *
 *   prepare  → server builds the FULL unsigned transfer (deposit
 *              address, amount, blockhash, memo carrying the row id),
 *              persists the WalletTopUp row with the exact message
 *              bytes, returns the unsigned tx for the wallet to sign.
 *              Zero side effects beyond the row on every failure path.
 *   submit   → byte-equality gate (the wallet signed EXACTLY what we
 *              prepared), then claim-before-broadcast: the status CAS
 *              prepared→submitting records the tx signature BEFORE the
 *              RPC send, so every later state is recoverable from the
 *              chain. Confirmation → credits, granted atomically with
 *              the credited flip.
 *   reconcile→ recovery for rows whose confirmation was interrupted
 *              (crash, timeout): consults the chain by signature and
 *              settles the row to credited / failed / expired. Safe to
 *              call repeatedly; crediting stays exactly-once via the
 *              same CAS.
 *
 * Money invariant: credits are granted ONLY inside deps.creditTopup
 * (makeCreditTopup), only after the transaction is CONFIRMED on-chain,
 * and at most once per row regardless of submit/reconcile races.
 */

import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";

import {
  blockhashFromMessageB64,
  buildTopupTransaction,
  computeTopupAmounts,
  newTopupId,
  TOPUP_WALLCLOCK_TTL_SECONDS,
  verifySignedTopupTransaction,
  type CreditTopupArgs,
  type CreditTopupResult,
} from "../services/walletTopup.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("wallet-topup");

// ============================================
// Schemas
// ============================================

const prepareBodySchema = z.object({
  amountUsd: z.number(),
  asset: z.enum(["SOL", "USDC"]),
});

const submitBodySchema = z.object({
  signedTxBase64: z.string().min(1),
});

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

// ============================================
// DI surface
// ============================================

export interface TopupRowView {
  id: string;
  orgId: string;
  asset: string;
  network: string;
  amountUsdCents: bigint;
  bonusCents: bigint;
  amountRaw: string;
  quotedSolPriceUsd: number | null;
  payerAddress: string;
  depositAddress: string;
  unsignedMessageB64: string;
  txSignature: string | null;
  status: string;
  failureReason: string | null;
  expiresAt: Date;
  lastValidBlockHeight: bigint;
}

export interface WalletTopupRouteDeps {
  /** Master gate — when false every endpoint answers 501 honestly. */
  enabled: boolean;
  network: "devnet" | "mainnet-beta";
  /** ALLOW_DEVNET_WALLET_TOPUPS && network === devnet. */
  devnetSolRailEnabled: boolean;
  /** Operator-stated SOL/USD quote; absent ⇒ SOL prepare refuses. */
  solPriceUsd?: number;
  /** Network-appropriate USDC mint, base58. */
  usdcMint: string;
  deriveDepositAddress: (orgId: string) => string;
  getLatestBlockhash: () => Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  createTopup: (data: {
    id: string;
    orgId: string;
    asset: string;
    network: string;
    amountUsdCents: bigint;
    bonusCents: bigint;
    amountRaw: string;
    quotedSolPriceUsd?: number;
    payerAddress: string;
    depositAddress: string;
    unsignedMessageB64: string;
    expiresAt: Date;
    lastValidBlockHeight: bigint;
  }) => Promise<void>;
  findTopup: (args: {
    id: string;
    orgId: string;
  }) => Promise<TopupRowView | null>;
  /**
   * The claim: updateMany {id, status: "prepared"} → {status:
   * "submitting", txSignature}. "lost" when the CAS matched nothing;
   * "duplicate_signature" when the txSignature unique constraint fired.
   */
  claimForSubmit: (args: {
    id: string;
    txSignature: string;
  }) => Promise<"claimed" | "lost" | "duplicate_signature">;
  /** Status CAS; returns whether a row transitioned. */
  markStatus: (args: {
    id: string;
    from: string[];
    to: string;
    failureReason?: string;
  }) => Promise<boolean>;
  /** Housekeeping: flip this org's overdue prepared rows to expired. */
  expireStalePrepared: (args: { orgId: string; now: Date }) => Promise<void>;
  sendRawTransaction: (
    rawTxBase64: string,
  ) => Promise<
    | { ok: true }
    | { ok: false; kind: "blockhash_expired" | "rejected"; message: string }
  >;
  confirmTransaction: (args: {
    signature: string;
    blockhash: string;
    lastValidBlockHeight: number;
  }) => Promise<
    | { outcome: "confirmed" }
    | { outcome: "failed_on_chain"; err: string }
    | { outcome: "unresolved" }
  >;
  getSignatureStatus: (signature: string) => Promise<{
    found: boolean;
    confirmed: boolean;
    err: string | null;
  }>;
  getBlockHeight: () => Promise<number>;
  creditTopup: (args: CreditTopupArgs) => Promise<CreditTopupResult>;
  newId?: () => string;
  now?: () => Date;
}

// ============================================
// Plugin
// ============================================

export function createWalletTopupRoutes(
  deps: WalletTopupRouteDeps,
): FastifyPluginAsync {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? newTopupId;

  const disabledReply = {
    error: "wallet_topups_not_enabled",
    message: "Wallet top-ups are not enabled on this deployment.",
  };

  return async (app) => {
    // ============================================
    // POST /topups/prepare
    // ============================================
    app.post("/topups/prepare", async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: "unauthenticated" });
      }
      if (!deps.enabled) {
        return reply.status(501).send(disabledReply);
      }
      const { orgId, walletAddress } = request.auth;
      if (!walletAddress) {
        return reply.status(400).send({
          error: "wallet_required",
          message:
            "Connect a Solana wallet first — the top-up is signed by your wallet.",
        });
      }

      const parsed = prepareBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_payload",
          details: parsed.error.flatten(),
        });
      }
      const body = parsed.data;

      if (body.asset === "SOL" && !deps.devnetSolRailEnabled) {
        return reply.status(400).send({
          error: "asset_unavailable",
          message:
            "SOL top-ups are a devnet testing rail and are not enabled here. Use USDC.",
        });
      }

      const amounts = computeTopupAmounts({
        asset: body.asset,
        amountUsd: body.amountUsd,
        solPriceUsd: deps.solPriceUsd,
      });
      if (!amounts.ok) {
        return reply.status(400).send({
          error: "invalid_amount",
          message: amounts.error,
        });
      }

      const currentTime = now();
      try {
        await deps.expireStalePrepared({ orgId, now: currentTime });
      } catch (err) {
        // Housekeeping only — never blocks a purchase.
        logger.warn({ err, orgId }, "expireStalePrepared failed");
      }

      let blockhashInfo: { blockhash: string; lastValidBlockHeight: number };
      try {
        blockhashInfo = await deps.getLatestBlockhash();
      } catch (err) {
        logger.error({ err }, "getLatestBlockhash failed");
        return reply.status(502).send({
          error: "rpc_unavailable",
          message: "Could not reach Solana RPC to prepare the transaction.",
        });
      }

      const topupId = newId();
      const depositAddress = deps.deriveDepositAddress(orgId);
      const network =
        deps.network === "mainnet-beta" ? "solana:mainnet" : "solana:devnet";

      let built: { unsignedTxBase64: string; unsignedMessageB64: string };
      try {
        built = buildTopupTransaction({
          asset: body.asset,
          payerAddress: walletAddress,
          depositAddress,
          amountRaw: amounts.amountRaw,
          topupId,
          blockhash: blockhashInfo.blockhash,
          lastValidBlockHeight: blockhashInfo.lastValidBlockHeight,
          usdcMint: deps.usdcMint,
        });
      } catch (err) {
        logger.error({ err, orgId }, "buildTopupTransaction failed");
        return reply.status(502).send({
          error: "prepare_failed",
          message: (err as Error).message,
        });
      }

      const expiresAt = new Date(
        currentTime.getTime() + TOPUP_WALLCLOCK_TTL_SECONDS * 1000,
      );
      await deps.createTopup({
        id: topupId,
        orgId,
        asset: body.asset,
        network,
        amountUsdCents: amounts.amountUsdCents,
        bonusCents: amounts.bonusCents,
        amountRaw: amounts.amountRaw,
        quotedSolPriceUsd: amounts.quotedSolPriceUsd,
        payerAddress: walletAddress,
        depositAddress,
        unsignedMessageB64: built.unsignedMessageB64,
        expiresAt,
        lastValidBlockHeight: BigInt(blockhashInfo.lastValidBlockHeight),
      });

      return reply.status(200).send({
        topupId,
        unsignedTxBase64: built.unsignedTxBase64,
        depositAddress,
        asset: body.asset,
        amountUsd: body.amountUsd,
        bonusUsd: Number(amounts.bonusCents) / 100,
        quotedSolPriceUsd: amounts.quotedSolPriceUsd,
        expiresAt: expiresAt.toISOString(),
      });
    });

    // ============================================
    // POST /topups/:id/submit
    // ============================================
    app.post("/topups/:id/submit", async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: "unauthenticated" });
      }
      if (!deps.enabled) {
        return reply.status(501).send(disabledReply);
      }
      const { orgId } = request.auth;

      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(404).send({ error: "topup_not_found" });
      }
      const parsed = submitBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_payload",
          details: parsed.error.flatten(),
        });
      }

      const row = await deps.findTopup({ id: params.data.id, orgId });
      if (!row) {
        return reply.status(404).send({ error: "topup_not_found" });
      }

      if (row.status === "credited") {
        return reply
          .status(200)
          .send({ status: "credited", alreadyCredited: true });
      }
      if (row.status === "submitting" || row.status === "submitted") {
        return reply.status(409).send({
          error: "in_flight",
          message:
            "This top-up is already being processed — call reconcile to settle it.",
        });
      }
      if (row.status === "failed") {
        return reply.status(410).send({
          error: "topup_failed",
          reason: row.failureReason,
        });
      }
      if (row.status === "expired") {
        return reply.status(410).send({ error: "topup_expired" });
      }

      // status === "prepared"
      if (now().getTime() > row.expiresAt.getTime()) {
        await deps.markStatus({ id: row.id, from: ["prepared"], to: "expired" });
        return reply.status(410).send({ error: "topup_expired" });
      }

      const verified = verifySignedTopupTransaction({
        signedTxBase64: parsed.data.signedTxBase64,
        unsignedMessageB64: row.unsignedMessageB64,
        payerAddress: row.payerAddress,
      });
      if (!verified.ok) {
        // Row untouched: the user can retry with correctly signed bytes.
        return reply.status(400).send({ error: verified.error });
      }

      const claim = await deps.claimForSubmit({
        id: row.id,
        txSignature: verified.txSignatureB58,
      });
      if (claim === "lost") {
        return reply.status(409).send({
          error: "in_flight",
          message: "A concurrent submit claimed this top-up first.",
        });
      }
      if (claim === "duplicate_signature") {
        return reply.status(409).send({
          error: "duplicate_signature",
          message: "This signed transaction already belongs to another top-up.",
        });
      }

      const sent = await deps.sendRawTransaction(verified.rawTxBase64);
      if (!sent.ok) {
        if (sent.kind === "blockhash_expired") {
          await deps.markStatus({
            id: row.id,
            from: ["submitting"],
            to: "expired",
          });
          return reply.status(410).send({ error: "topup_expired" });
        }
        await deps.markStatus({
          id: row.id,
          from: ["submitting"],
          to: "failed",
          failureReason: sent.message,
        });
        logger.error(
          { topupId: row.id, message: sent.message },
          "top-up broadcast rejected",
        );
        return reply.status(502).send({
          error: "broadcast_failed",
          message: sent.message,
        });
      }

      await deps.markStatus({
        id: row.id,
        from: ["submitting"],
        to: "submitted",
      });

      const confirmation = await deps.confirmTransaction({
        signature: verified.txSignatureB58,
        // The blockhash is pinned inside the message bytes we prepared.
        blockhash: blockhashFromMessageB64(row.unsignedMessageB64),
        lastValidBlockHeight: Number(row.lastValidBlockHeight),
      });

      if (confirmation.outcome === "failed_on_chain") {
        await deps.markStatus({
          id: row.id,
          from: ["submitted"],
          to: "failed",
          failureReason: confirmation.err,
        });
        return reply.status(502).send({
          error: "transaction_failed_on_chain",
          message: confirmation.err,
          txSignature: verified.txSignatureB58,
        });
      }
      if (confirmation.outcome === "unresolved") {
        // Not a failure: the tx may still land. Reconcile settles it.
        return reply.status(202).send({
          status: "submitted",
          pendingConfirmation: true,
          txSignature: verified.txSignatureB58,
        });
      }

      const credit = await deps.creditTopup({
        topupId: row.id,
        orgId,
        amountUsdCents: row.amountUsdCents,
        bonusCents: row.bonusCents,
        asset: row.asset,
        network: row.network,
      });
      if (!credit.credited) {
        // CAS lost — a concurrent reconcile credited it. Same outcome.
        return reply.status(200).send({
          status: "credited",
          alreadyCredited: true,
          txSignature: verified.txSignatureB58,
        });
      }
      return reply.status(200).send({
        status: "credited",
        txSignature: verified.txSignatureB58,
        grantedUsd: Number(credit.grantedCents) / 100,
        balanceUsd: Number(credit.balanceAfterCents) / 100,
      });
    });

    // ============================================
    // POST /topups/:id/reconcile
    // ============================================
    app.post("/topups/:id/reconcile", async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: "unauthenticated" });
      }
      if (!deps.enabled) {
        return reply.status(501).send(disabledReply);
      }
      const { orgId } = request.auth;

      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(404).send({ error: "topup_not_found" });
      }
      const row = await deps.findTopup({ id: params.data.id, orgId });
      if (!row) {
        return reply.status(404).send({ error: "topup_not_found" });
      }

      if (
        row.status === "credited" ||
        row.status === "failed" ||
        row.status === "expired"
      ) {
        return reply.status(200).send({
          status: row.status,
          reason: row.failureReason ?? undefined,
          txSignature: row.txSignature ?? undefined,
        });
      }

      if (row.status === "prepared" || !row.txSignature) {
        if (now().getTime() > row.expiresAt.getTime()) {
          await deps.markStatus({
            id: row.id,
            from: [row.status],
            to: "expired",
          });
          return reply.status(200).send({ status: "expired" });
        }
        return reply
          .status(200)
          .send({ status: row.status, pendingSignature: true });
      }

      // submitting | submitted with a recorded signature: the chain is
      // the source of truth.
      const sigStatus = await deps.getSignatureStatus(row.txSignature);
      if (sigStatus.found && sigStatus.err) {
        await deps.markStatus({
          id: row.id,
          from: ["submitting", "submitted"],
          to: "failed",
          failureReason: sigStatus.err,
        });
        return reply.status(200).send({
          status: "failed",
          reason: sigStatus.err,
          txSignature: row.txSignature,
        });
      }
      if (sigStatus.found && sigStatus.confirmed) {
        const credit = await deps.creditTopup({
          topupId: row.id,
          orgId,
          amountUsdCents: row.amountUsdCents,
          bonusCents: row.bonusCents,
          asset: row.asset,
          network: row.network,
        });
        return reply.status(200).send({
          status: "credited",
          alreadyCredited: !credit.credited,
          txSignature: row.txSignature,
          ...(credit.credited
            ? {
                grantedUsd: Number(credit.grantedCents) / 100,
                balanceUsd: Number(credit.balanceAfterCents) / 100,
              }
            : {}),
        });
      }
      if (!sigStatus.found) {
        const height = await deps.getBlockHeight();
        if (height > Number(row.lastValidBlockHeight)) {
          await deps.markStatus({
            id: row.id,
            from: ["submitting", "submitted"],
            to: "expired",
          });
          return reply.status(200).send({ status: "expired" });
        }
      }
      return reply.status(200).send({
        status: row.status,
        pendingConfirmation: true,
        txSignature: row.txSignature,
      });
    });

    // ============================================
    // GET /topups/:id — client polling view
    // ============================================
    app.get("/topups/:id", async (request, reply) => {
      if (!request.auth) {
        return reply.status(401).send({ error: "unauthenticated" });
      }
      if (!deps.enabled) {
        return reply.status(501).send(disabledReply);
      }
      const params = idParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(404).send({ error: "topup_not_found" });
      }
      const row = await deps.findTopup({
        id: params.data.id,
        orgId: request.auth.orgId,
      });
      if (!row) {
        return reply.status(404).send({ error: "topup_not_found" });
      }
      return reply.status(200).send({
        id: row.id,
        status: row.status,
        asset: row.asset,
        amountUsd: Number(row.amountUsdCents) / 100,
        bonusUsd: Number(row.bonusCents) / 100,
        txSignature: row.txSignature ?? undefined,
        failureReason: row.failureReason ?? undefined,
        depositAddress: row.depositAddress,
        expiresAt: row.expiresAt.toISOString(),
      });
    });
  };
}
