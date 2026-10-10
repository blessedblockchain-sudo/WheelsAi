/**
 * POST /topups/prepare, /topups/:id/submit, /topups/:id/reconcile,
 * GET /topups/:id and GET /topups: adding credits from a Solana wallet,
 * in USDC or SOL, mounted under /api/billing.
 *
 *   prepare  → server builds the FULL unsigned transfer (deposit
 *              address, amount, blockhash, memo carrying the row id),
 *              persists the WalletTopUp row with the exact message
 *              bytes, returns the unsigned tx for the wallet to sign.
 *              The payer is whichever wallet is named in the body, else
 *              the one on the session; no wallet has to be linked.
 *              Nothing but the row is written on any path.
 *   submit   → the signed transaction must be the prepared transfer
 *              (acceptSignedTopupTransaction), then claim-before-
 *              broadcast: the status CAS prepared→submitting records the
 *              signature AND the signed bytes BEFORE the send, so every
 *              later state is recoverable from the chain.
 *   reconcile→ asks the chain what happened to the signature and ends
 *              the row accordingly. Safe to call repeatedly; the worker
 *              (services/runTopupReconcileTick.ts) does the same on a
 *              timer, so a closed tab loses nothing.
 *
 * CHAIN EVIDENCE ENDS A ROW. Once a signature is stored, only
 * signatureFate may make the row final: landed_ok credits, landed_failed
 * fails it, dead expires it, in_flight and unknown change nothing. A send
 * that throws may still have reached the chain, so a send error ends
 * nothing: the row stays `submitting` and the answer is 202.
 *
 * Money invariant: credits are granted ONLY inside deps.creditTopup
 * (makeCreditTopup), only after the chain says the transfer landed, and
 * at most once per row regardless of submit/reconcile/worker races.
 *
 * Every answer carries `message`, a sentence from
 * services/topupSentences.ts. Text from a node, the database or a thrown
 * error goes to the log and to `failure_reason`, never into an answer.
 */

import { z } from "zod";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import {
  MAX_PURCHASE_DOLLARS,
  MIN_PURCHASE_DOLLARS,
} from "../services/creditPackages.js";
import {
  describeSignatureFate,
  type SignatureFateAnswer,
  type SignatureFateInput,
} from "../services/signatureFate.js";
import type { SolPriceResult } from "../services/solPrice.js";
import {
  TOPUP_FAILURE_CODES,
  topupRowSentence,
  topupSentence,
  type TopupFailureCode,
  type TopupSentenceCode,
  type TopupSentenceValues,
} from "../services/topupSentences.js";
import {
  acceptSignedTopupTransaction,
  blockhashFromMessageB64,
  buildTopupTransaction,
  checkPayerAddress,
  checkTopupAmount,
  computeTopupAmounts,
  newTopupId,
  signatureOfSignedTransaction,
  TOPUP_SOL_TTL_SECONDS,
  topupTtlSeconds,
  type CreditTopupArgs,
  type CreditTopupResult,
} from "../services/walletTopup.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("wallet-topup");

/** How many top-ups GET /topups answers with. */
export const TOPUP_LIST_LIMIT = 20;

/**
 * What a SOL payer needs on top of the amount: the fee of a transaction
 * with one signature. The balance check is advisory, so this is the base
 * fee and no more.
 */
export const SOL_FEE_ALLOWANCE_LAMPORTS = 5_000n;

/** The most of a node's own words kept on a row for operators. */
const FAILURE_REASON_MAX_LENGTH = 500;

// ============================================
// Schemas
// ============================================

const prepareBodySchema = z.object({
  amountUsd: z.number(),
  asset: z.enum(["SOL", "USDC"]),
  payerAddress: z.string().optional(),
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

/**
 * A top-up as the routes see it. `failure_reason` is deliberately not
 * here: what cannot be read cannot be sent.
 */
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
  failureCode: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastValidBlockHeight: bigint;
}

export interface PayerBalances {
  /** The payer's SOL, in lamports; null when it could not be read. */
  lamports: bigint | null;
  /** The payer's USDC, in base units (0 with no token account); null
   * when it could not be read or was not asked for. */
  usdcRaw: bigint | null;
  /** Whether the organization's USDC account exists yet; null when not
   * known. */
  depositUsdcAccountExists: boolean | null;
}

export interface WalletTopupRouteDeps {
  /** Master gate: when false every endpoint answers 501. */
  enabled: boolean;
  network: "devnet" | "mainnet-beta";
  /** SOL is offered: SOL_PRICE_SOURCE is not "off". */
  solEnabled: boolean;
  /** Network-appropriate USDC mint, base58. */
  usdcMint: string;
  deriveDepositAddress: (orgId: string) => string;
  /**
   * The platform's own addresses, which can never be a payer: the
   * organization's deposit address and the payout wallet.
   */
  platformAddresses: (orgId: string) => string[];
  /** Is the node on the cluster the settings name? Never throws. */
  ensureCluster: () => Promise<{ ok: boolean; reason?: string }>;
  /** The live SOL price: a quote or a refusal. Never throws. */
  getSolQuote: () => Promise<SolPriceResult>;
  /** The margin every SOL quote carries, basis points. */
  solMarginBps: () => number;
  /** One read of what the payer holds. Advisory; may throw. */
  readPayerBalances: (args: {
    payerAddress: string;
    depositAddress: string;
    asset: "SOL" | "USDC";
  }) => Promise<PayerBalances>;
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
    quotePriceMicroUsd?: bigint;
    quotePublishTime?: Date;
    quoteSource?: string;
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
  /** The organization's latest top-ups, newest first. */
  listTopups: (args: {
    orgId: string;
    limit: number;
  }) => Promise<TopupRowView[]>;
  /**
   * The claim: updateMany {id, status: "prepared"} → {status:
   * "submitting", txSignature, signedTxB64, submittedAt}. "lost" when the
   * CAS matched nothing; "duplicate_signature" when the txSignature
   * unique constraint fired.
   */
  claimForSubmit: (args: {
    id: string;
    txSignature: string;
    signedTxB64: string;
    submittedAt: Date;
  }) => Promise<"claimed" | "lost" | "duplicate_signature">;
  /** Status CAS; returns whether a row transitioned. */
  markStatus: (args: {
    id: string;
    from: string[];
    to: string;
    failureCode?: TopupFailureCode;
    failureReason?: string;
  }) => Promise<boolean>;
  /** Housekeeping: flip this org's overdue prepared rows to expired. */
  expireStalePrepared: (args: { orgId: string; now: Date }) => Promise<void>;
  /**
   * Hand the signed bytes to the network. A refusal or a throw says
   * nothing about whether the transfer reached the chain; `detail` is for
   * the log only.
   */
  sendRawTransaction: (
    rawTxBase64: string,
  ) => Promise<{ ok: true } | { ok: false; detail: string }>;
  /**
   * Wait a bounded time for the node to say something about the
   * signature. It decides nothing: the fate is read afterwards.
   */
  waitForConfirmation: (args: {
    signature: string;
    blockhash: string;
    lastValidBlockHeight: number;
  }) => Promise<void>;
  /** What happened to this signature (services/signatureFate.ts). */
  readSignatureFate: (input: SignatureFateInput) => Promise<SignatureFateAnswer>;
  creditTopup: (args: CreditTopupArgs) => Promise<CreditTopupResult>;
  /** The organization's credit balance, for an answer about a top-up
   * that was credited earlier. Optional and advisory. */
  readBalanceCents?: (orgId: string) => Promise<bigint | null>;
  newId?: () => string;
  now?: () => Date;
}

// ============================================
// Plugin
// ============================================

const usd = (cents: bigint): number => Number(cents) / 100;

const isInFlight = (status: string): boolean =>
  status === "submitting" || status === "submitted";

/** A credit this very request made, with the balance it left. */
interface FreshCredit {
  grantedCents: bigint;
  balanceAfterCents: bigint;
}

type Settled =
  | { kind: "credited"; row: TopupRowView; credit: FreshCredit }
  | { kind: "row"; row: TopupRowView };

export function createWalletTopupRoutes(
  deps: WalletTopupRouteDeps,
): FastifyPluginAsync {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? newTopupId;

  function refuse(
    reply: FastifyReply,
    status: number,
    error: string,
    sentence: TopupSentenceCode,
    values?: TopupSentenceValues,
  ) {
    return reply
      .status(status)
      .send({ error, message: topupSentence(sentence, values) });
  }

  /**
   * Anything a handler did not expect ends here: the error is logged and
   * the answer is one fixed sentence, so no thrown text can leak.
   */
  function guarded(
    name: string,
    handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  ) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request, reply);
      } catch (err) {
        logger.error({ err, route: name }, "wallet top-up route failed");
        return refuse(reply, 500, "internal_error", "internal_error");
      }
    };
  }

  /** The gates every route shares. Answers and returns false on refusal. */
  function gate(request: FastifyRequest, reply: FastifyReply): boolean {
    if (!request.auth) {
      void refuse(reply, 401, "unauthenticated", "unauthenticated");
      return false;
    }
    if (!deps.enabled) {
      void refuse(
        reply,
        501,
        "wallet_topups_not_enabled",
        "wallet_topups_not_enabled",
      );
      return false;
    }
    return true;
  }

  async function clusterOk(): Promise<boolean> {
    try {
      const check = await deps.ensureCluster();
      if (!check.ok) {
        logger.error({ reason: check.reason }, "Solana cluster check refused");
      }
      return check.ok === true;
    } catch (err) {
      logger.error({ err }, "Solana cluster check threw");
      return false;
    }
  }

  async function reread(row: TopupRowView): Promise<TopupRowView> {
    return (await deps.findTopup({ id: row.id, orgId: row.orgId })) ?? row;
  }

  async function balanceUsd(orgId: string): Promise<number | undefined> {
    if (!deps.readBalanceCents) return undefined;
    try {
      const cents = await deps.readBalanceCents(orgId);
      return cents === null ? undefined : usd(cents);
    } catch (err) {
      logger.warn({ err, orgId }, "credit balance read failed");
      return undefined;
    }
  }

  /**
   * Ask the chain about a row in flight and end it if the chain says so.
   * The one place a row with a signature becomes final in these routes.
   */
  async function settleFromChain(row: TopupRowView): Promise<Settled> {
    if (!row.txSignature || !isInFlight(row.status)) return { kind: "row", row };

    let answer: SignatureFateAnswer;
    try {
      answer = await deps.readSignatureFate({
        signature: row.txSignature,
        lastValidBlockHeight: row.lastValidBlockHeight,
      });
    } catch (err) {
      // The bound form never throws; a stand-in might. Nothing is
      // inferred from an error.
      logger.warn({ err, topupId: row.id }, "signature fate read threw");
      return { kind: "row", row };
    }
    // A page follows a top-up every few seconds: only an answer that
    // ends the row is worth a line at info.
    const undecided = answer.fate === "in_flight" || answer.fate === "unknown";
    logger[undecided ? "debug" : "info"](
      { topupId: row.id, ...describeSignatureFate(answer) },
      "top-up signature fate",
    );

    if (answer.fate === "landed_ok") {
      const credit = await deps.creditTopup({
        topupId: row.id,
        orgId: row.orgId,
        amountUsdCents: row.amountUsdCents,
        bonusCents: row.bonusCents,
        asset: row.asset,
        network: row.network,
      });
      if (credit.credited) {
        return {
          kind: "credited",
          row: { ...row, status: "credited" },
          credit: {
            grantedCents: credit.grantedCents,
            balanceAfterCents: credit.balanceAfterCents,
          },
        };
      }
      // CAS lost: someone else ended the row first. Say what it is now.
      return { kind: "row", row: await reread(row) };
    }

    if (answer.fate === "landed_failed" || answer.fate === "dead") {
      const failed = answer.fate === "landed_failed";
      await deps.markStatus({
        id: row.id,
        from: ["submitting", "submitted"],
        to: failed ? "failed" : "expired",
        failureCode: failed
          ? TOPUP_FAILURE_CODES.failedOnChain
          : TOPUP_FAILURE_CODES.neverLanded,
        failureReason: (answer.error ?? answer.reason).slice(
          0,
          FAILURE_REASON_MAX_LENGTH,
        ),
      });
      // Won or lost, the row says how it ended.
      return { kind: "row", row: await reread(row) };
    }

    // in_flight or unknown: nothing changes.
    return { kind: "row", row };
  }

  /** The body for a credited top-up. */
  async function creditedBody(row: TopupRowView, fresh: FreshCredit | null) {
    const balance = fresh
      ? usd(fresh.balanceAfterCents)
      : await balanceUsd(row.orgId);
    return {
      status: "credited" as const,
      message: topupSentence("credited", {
        paidCents: row.amountUsdCents,
        bonusCents: row.bonusCents,
      }),
      ...(row.txSignature ? { txSignature: row.txSignature } : {}),
      grantedUsd: usd(fresh ? fresh.grantedCents : row.amountUsdCents + row.bonusCents),
      ...(balance === undefined ? {} : { balanceUsd: balance }),
      ...(fresh ? {} : { alreadyCredited: true }),
    };
  }

  /** The answer of POST /submit for a row in whatever state it is in. */
  async function submitAnswer(reply: FastifyReply, settled: Settled) {
    const { row } = settled;
    if (settled.kind === "credited") {
      return reply.status(200).send(await creditedBody(row, settled.credit));
    }
    if (row.status === "credited") {
      return reply.status(200).send(await creditedBody(row, null));
    }
    if (isInFlight(row.status)) {
      return reply.status(202).send({
        status: row.status,
        message: topupRowSentence(row),
        txSignature: row.txSignature ?? undefined,
        pendingConfirmation: true,
      });
    }
    return reply.status(410).send({
      error: row.status === "failed" ? "topup_failed" : "topup_expired",
      message: topupRowSentence(row),
    });
  }

  /** The answer of POST /reconcile: always 200, the state in `status`. */
  async function reconcileAnswer(reply: FastifyReply, settled: Settled) {
    const { row } = settled;
    if (settled.kind === "credited") {
      return reply.status(200).send(await creditedBody(row, settled.credit));
    }
    if (row.status === "credited") {
      return reply.status(200).send(await creditedBody(row, null));
    }
    return reply.status(200).send({
      status: row.status,
      message: topupRowSentence(row),
      ...(row.txSignature ? { txSignature: row.txSignature } : {}),
      ...(isInFlight(row.status) ? { pendingConfirmation: true } : {}),
      ...(row.status === "prepared" ? { pendingSignature: true } : {}),
    });
  }

  /** A prepared row past its time, never signed: nothing was sent. */
  async function expireUnsigned(row: TopupRowView): Promise<TopupRowView> {
    await deps.markStatus({
      id: row.id,
      from: ["prepared"],
      to: "expired",
      failureCode: TOPUP_FAILURE_CODES.unsignedExpired,
    });
    return reread(row);
  }

  function view(row: TopupRowView) {
    return {
      id: row.id,
      status: row.status,
      message: topupRowSentence(row),
      asset: row.asset,
      amountUsd: usd(row.amountUsdCents),
      bonusUsd: usd(row.bonusCents),
      ...(row.txSignature ? { txSignature: row.txSignature } : {}),
      depositAddress: row.depositAddress,
      payerAddress: row.payerAddress,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  return async (app) => {
    // ============================================
    // POST /topups/prepare
    // ============================================
    app.post(
      "/topups/prepare",
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      guarded("prepare", async (request, reply) => {
        if (!gate(request, reply)) return reply;
        const { orgId, walletAddress } = request.auth!;

        const parsed = prepareBodySchema.safeParse(request.body);
        if (!parsed.success) {
          return refuse(reply, 400, "invalid_payload", "invalid_payload");
        }
        const body = parsed.data;

        const amount = checkTopupAmount(body.amountUsd);
        if (!amount.ok) {
          return refuse(reply, 400, "invalid_amount", "invalid_amount", {
            minUsd: MIN_PURCHASE_DOLLARS,
            maxUsd: MAX_PURCHASE_DOLLARS,
          });
        }

        // The payer: the wallet named in the body, else the one on the
        // session. It signs the transfer, so it needs no link to the
        // account.
        const namedPayer = body.payerAddress ?? walletAddress;
        if (namedPayer === undefined || namedPayer === null) {
          return refuse(reply, 400, "wallet_required", "wallet_required");
        }
        const depositAddress = deps.deriveDepositAddress(orgId);
        const payer = checkPayerAddress(namedPayer, [
          depositAddress,
          ...deps.platformAddresses(orgId),
        ]);
        if (!payer.ok) {
          return refuse(
            reply,
            400,
            "invalid_payer_address",
            "invalid_payer_address",
          );
        }
        const payerAddress = payer.address;

        if (body.asset === "SOL" && !deps.solEnabled) {
          return refuse(reply, 400, "asset_unavailable", "asset_unavailable");
        }

        if (!(await clusterOk())) {
          return refuse(reply, 503, "chain_unavailable", "chain_unavailable");
        }

        // SOL: a quote or nothing. USDC never asks for a price.
        let quote = null;
        if (body.asset === "SOL") {
          const priced = await deps.getSolQuote();
          if (!priced.ok) {
            logger.warn(
              { code: priced.code, detail: priced.detail },
              "SOL quote refused; SOL top-up not prepared",
            );
            return refuse(reply, 503, "price_unavailable", "price_unavailable");
          }
          quote = priced.quote;
        }

        const amounts = computeTopupAmounts({
          asset: body.asset,
          amountUsd: body.amountUsd,
          quote,
          marginBps: body.asset === "SOL" ? deps.solMarginBps() : undefined,
        });
        if (!amounts.ok) {
          logger.warn(
            { code: amounts.code, detail: amounts.detail, asset: body.asset },
            "top-up amounts refused",
          );
          if (amounts.code === "invalid_amount") {
            return refuse(reply, 400, "invalid_amount", "invalid_amount", {
              minUsd: MIN_PURCHASE_DOLLARS,
              maxUsd: MAX_PURCHASE_DOLLARS,
            });
          }
          return refuse(reply, 503, "price_unavailable", "price_unavailable");
        }
        const amountRaw = BigInt(amounts.amountRaw);

        // What the payer holds. Advisory: the chain is what decides, so a
        // read that fails is no reason to refuse.
        let opensUsdcAccount = false;
        try {
          const held = await deps.readPayerBalances({
            payerAddress,
            depositAddress,
            asset: body.asset,
          });
          if (body.asset === "USDC") {
            if (held.usdcRaw !== null && held.usdcRaw < amountRaw) {
              return refuse(
                reply,
                409,
                "wallet_balance_short",
                "wallet_balance_short",
                { heldRaw: held.usdcRaw, asset: "USDC" },
              );
            }
            opensUsdcAccount = held.depositUsdcAccountExists === false;
          } else if (
            held.lamports !== null &&
            held.lamports < amountRaw + SOL_FEE_ALLOWANCE_LAMPORTS
          ) {
            return refuse(
              reply,
              409,
              "wallet_balance_short",
              "wallet_balance_short",
              { heldRaw: held.lamports, asset: "SOL" },
            );
          }
        } catch (err) {
          logger.warn({ err, orgId }, "payer balance read failed; carrying on");
        }

        const currentTime = now();
        try {
          await deps.expireStalePrepared({ orgId, now: currentTime });
        } catch (err) {
          // Housekeeping only — never blocks a purchase.
          logger.warn({ err, orgId }, "expireStalePrepared failed");
        }

        const topupId = newId();
        const network =
          deps.network === "mainnet-beta" ? "solana:mainnet" : "solana:devnet";
        const expiresAt = new Date(
          currentTime.getTime() + topupTtlSeconds(body.asset) * 1000,
        );

        let built: { unsignedTxBase64: string; unsignedMessageB64: string };
        try {
          const blockhashInfo = await deps.getLatestBlockhash();
          built = buildTopupTransaction({
            asset: body.asset,
            payerAddress,
            depositAddress,
            amountRaw: amounts.amountRaw,
            topupId,
            blockhash: blockhashInfo.blockhash,
            lastValidBlockHeight: blockhashInfo.lastValidBlockHeight,
            usdcMint: deps.usdcMint,
          });
          await deps.createTopup({
            id: topupId,
            orgId,
            asset: body.asset,
            network,
            amountUsdCents: amounts.amountUsdCents,
            bonusCents: amounts.bonusCents,
            amountRaw: amounts.amountRaw,
            quotedSolPriceUsd: amounts.quotedSolPriceUsd,
            quotePriceMicroUsd: amounts.quotePriceMicroUsd,
            quotePublishTime: amounts.quotePublishTime,
            quoteSource: amounts.quoteSource,
            payerAddress,
            depositAddress,
            unsignedMessageB64: built.unsignedMessageB64,
            expiresAt,
            lastValidBlockHeight: BigInt(blockhashInfo.lastValidBlockHeight),
          });
        } catch (err) {
          // Nothing was handed out, so nothing can be signed or sent.
          logger.error({ err, orgId }, "top-up could not be prepared");
          return refuse(reply, 502, "rpc_unavailable", "rpc_unavailable");
        }

        const solPriceUsd = amounts.quotedSolPriceUsd;
        return reply.status(200).send({
          topupId,
          unsignedTxBase64: built.unsignedTxBase64,
          depositAddress,
          payerAddress,
          asset: body.asset,
          amountUsd: usd(amounts.amountUsdCents),
          bonusUsd: usd(amounts.bonusCents),
          amountRaw: amounts.amountRaw,
          ...(solPriceUsd === undefined ? {} : { quotedSolPriceUsd: solPriceUsd }),
          quote:
            solPriceUsd === undefined
              ? null
              : { solPriceUsd, validUntil: expiresAt.toISOString() },
          opensUsdcAccount,
          expiresAt: expiresAt.toISOString(),
          message:
            solPriceUsd !== undefined
              ? topupSentence("prepared_sol", {
                  solPriceUsd,
                  holdSeconds: TOPUP_SOL_TTL_SECONDS,
                })
              : topupSentence(
                  opensUsdcAccount
                    ? "prepared_usdc_opens_account"
                    : "prepared_usdc",
                ),
        });
      }),
    );

    // ============================================
    // POST /topups/:id/submit
    // ============================================
    app.post(
      "/topups/:id/submit",
      guarded("submit", async (request, reply) => {
        if (!gate(request, reply)) return reply;
        const { orgId } = request.auth!;

        const params = idParamsSchema.safeParse(request.params);
        if (!params.success) {
          return refuse(reply, 404, "topup_not_found", "topup_not_found");
        }
        const parsed = submitBodySchema.safeParse(request.body);
        if (!parsed.success) {
          return refuse(
            reply,
            400,
            "unreadable_transaction",
            "unreadable_transaction",
          );
        }
        const signedTxBase64 = parsed.data.signedTxBase64;

        const row = await deps.findTopup({ id: params.data.id, orgId });
        if (!row) {
          return refuse(reply, 404, "topup_not_found", "topup_not_found");
        }

        // An ended row is answered from the row alone: no chain needed.
        if (!isInFlight(row.status) && row.status !== "prepared") {
          return submitAnswer(reply, { kind: "row", row });
        }

        if (isInFlight(row.status)) {
          // The same signed transfer sent again gets its current state.
          // Anything else for a top-up in flight is a conflict.
          const signature = signatureOfSignedTransaction(signedTxBase64);
          if (!signature || signature !== row.txSignature) {
            return refuse(reply, 409, "in_flight", "in_flight_conflict");
          }
          // This transfer was already handed to the network, so the
          // "paused, nothing was taken" answer would not be certain. With
          // the cluster in doubt no chain is read and the row is answered
          // as it stands, as reconcile does.
          if (!(await clusterOk())) {
            return submitAnswer(reply, { kind: "row", row });
          }
          return submitAnswer(reply, await settleFromChain(row));
        }

        // status === "prepared": nothing has been sent, and from here the
        // chain is written and read.
        if (!(await clusterOk())) {
          return refuse(reply, 503, "chain_unavailable", "chain_unavailable");
        }

        if (now().getTime() > row.expiresAt.getTime()) {
          return submitAnswer(reply, {
            kind: "row",
            row: await expireUnsigned(row),
          });
        }

        const accepted = acceptSignedTopupTransaction({
          signedTxBase64,
          unsignedMessageB64: row.unsignedMessageB64,
          payerAddress: row.payerAddress,
        });
        if (!accepted.ok) {
          // Row untouched: the customer can sign the prepared transfer.
          logger.warn(
            { topupId: row.id, reason: accepted.reason },
            "signed top-up not accepted",
          );
          return refuse(reply, 400, accepted.code, accepted.code);
        }
        const txSignature = accepted.txSignatureB58;

        // Claim before broadcast: the signature and the signed bytes are
        // on the row before the network sees them.
        const claim = await deps.claimForSubmit({
          id: row.id,
          txSignature,
          signedTxB64: accepted.rawTxBase64,
          submittedAt: now(),
        });
        if (claim === "duplicate_signature") {
          return refuse(reply, 409, "duplicate_signature", "duplicate_signature");
        }
        if (claim === "lost") {
          // A concurrent submit claimed it. If it carried these same
          // bytes, this request gets that top-up's state.
          const current = await reread(row);
          if (isInFlight(current.status) && current.txSignature !== txSignature) {
            return refuse(reply, 409, "in_flight", "in_flight_conflict");
          }
          if (current.status === "prepared") {
            return refuse(reply, 409, "in_flight", "in_flight_conflict");
          }
          return submitAnswer(reply, await settleFromChain(current));
        }

        const claimed: TopupRowView = { ...row, status: "submitting", txSignature };

        let sent: { ok: true } | { ok: false; detail: string };
        try {
          sent = await deps.sendRawTransaction(accepted.rawTxBase64);
        } catch (err) {
          sent = { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
        if (!sent.ok) {
          // A send that errored may still have reached the chain. The row
          // stays `submitting`; the worker ends it from the chain.
          logger.error(
            { topupId: row.id, txSignature, detail: sent.detail },
            "top-up send errored; left for the reconcile worker",
          );
          return submitAnswer(reply, { kind: "row", row: claimed });
        }

        await deps.markStatus({
          id: row.id,
          from: ["submitting"],
          to: "submitted",
        });
        const submitted: TopupRowView = { ...claimed, status: "submitted" };

        try {
          await deps.waitForConfirmation({
            signature: txSignature,
            // The blockhash is pinned inside the message bytes we prepared.
            blockhash: blockhashFromMessageB64(row.unsignedMessageB64),
            lastValidBlockHeight: Number(row.lastValidBlockHeight),
          });
        } catch (err) {
          // The wait decides nothing; the fate below does.
          logger.warn({ err, topupId: row.id }, "confirmation wait ended early");
        }

        return submitAnswer(reply, await settleFromChain(submitted));
      }),
    );

    // ============================================
    // POST /topups/:id/reconcile
    // ============================================
    app.post(
      "/topups/:id/reconcile",
      guarded("reconcile", async (request, reply) => {
        if (!gate(request, reply)) return reply;
        const { orgId } = request.auth!;

        const params = idParamsSchema.safeParse(request.params);
        if (!params.success) {
          return refuse(reply, 404, "topup_not_found", "topup_not_found");
        }
        const row = await deps.findTopup({ id: params.data.id, orgId });
        if (!row) {
          return refuse(reply, 404, "topup_not_found", "topup_not_found");
        }

        if (row.status === "prepared") {
          if (!row.txSignature && now().getTime() > row.expiresAt.getTime()) {
            return reconcileAnswer(reply, {
              kind: "row",
              row: await expireUnsigned(row),
            });
          }
          return reconcileAnswer(reply, { kind: "row", row });
        }

        // In flight with a signature: the chain is the source of truth,
        // and only the right chain. With the cluster in doubt nothing is
        // read and nothing changes.
        if (isInFlight(row.status) && row.txSignature && (await clusterOk())) {
          return reconcileAnswer(reply, await settleFromChain(row));
        }
        return reconcileAnswer(reply, { kind: "row", row });
      }),
    );

    // ============================================
    // GET /topups — the organization's latest, newest first
    // ============================================
    app.get(
      "/topups",
      guarded("list", async (request, reply) => {
        if (!gate(request, reply)) return reply;
        const rows = await deps.listTopups({
          orgId: request.auth!.orgId,
          limit: TOPUP_LIST_LIMIT,
        });
        return reply.status(200).send({ topups: rows.map(view) });
      }),
    );

    // ============================================
    // GET /topups/:id — client polling view
    // ============================================
    app.get(
      "/topups/:id",
      guarded("get", async (request, reply) => {
        if (!gate(request, reply)) return reply;
        const params = idParamsSchema.safeParse(request.params);
        if (!params.success) {
          return refuse(reply, 404, "topup_not_found", "topup_not_found");
        }
        const row = await deps.findTopup({
          id: params.data.id,
          orgId: request.auth!.orgId,
        });
        if (!row) {
          return refuse(reply, 404, "topup_not_found", "topup_not_found");
        }
        return reply.status(200).send(view(row));
      }),
    );
  };
}
