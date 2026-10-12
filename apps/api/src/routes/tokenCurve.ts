/**
 * Routes under /api/tokens/:id for a token on a Meteora curve: the curve's
 * state, a quote, a buy or sell, a creator fee claim and graduation.
 *
 * Every transaction here is built by the server, signed by the browser
 * wallet, checked to be the one that was built, and only then sent. A
 * submit may be posted again with the same body: a transaction that has
 * already succeeded is not sent a second time, it is recorded.
 *
 *   GET  /:id/curve              public   the curve's state
 *   POST /:id/trade/quote        public   what a buy or a sell would give
 *   POST /:id/trade/prepare      login    an unsigned buy or sell
 *   POST /:id/trade/submit       login    send it, write the trade row
 *   POST /:id/fees/prepare       login    the creator's fee claim, unsigned
 *   POST /:id/fees/submit        login    send it
 *   POST /:id/graduate/prepare   login    the next graduation step
 *   POST /:id/graduate/submit    login    send it, record the graduation
 *
 * What each refusal means:
 *   404 token_not_found          no AgentToken with this id
 *   404 not_a_curve_token        the token's launchpad is not "meteora"
 *   503 curve_unreadable         the pool could not be read; never a guess
 *   400 invalid_amount           not a positive amount the curve can take
 *   400 invalid_payload          another part of the body is wrong
 *   400 invalid_wallet           the wallet is not a Solana address
 *   409 curve_full               trading is over: the curve is full or graduated
 *   403 not_the_creator          the wallet is not the pool's creator on chain
 *   409 nothing_to_claim         no fees are waiting for the creator
 *   409 curve_not_full           graduation before the curve is full
 *   409 already_graduated        graduation after the pool has moved
 *   400 prepare_token_invalid    a bad or expired token, or one for another
 *                                token or another kind of transaction. A token
 *                                that ran out less than ten minutes ago still
 *                                serves to record a transaction that has
 *                                already succeeded, never to send one.
 *   403 prepare_token_not_yours  a token prepared by another user
 *   400 transaction_mismatch     the signed transaction is not the one built
 *                                (a wallet's own compute-budget and Lighthouse
 *                                instructions aside, when it alone signs), or
 *                                a signature is missing or is not a true one
 *                                over this transaction. It is not sent.
 *   502 send_failed              the node refused the transaction
 *   502 transaction_not_confirmed  sent, but not seen confirmed; carries the
 *                                signature, and the same submit may be posted
 *                                again to ask once more
 *   409 transaction_failed       the chain refused it; nothing is recorded
 *   500 persistence_failed       graduated on chain, the row was not written
 *   503 prepare_unavailable      the server has no secret to sign tokens with
 *
 * The factory takes its dependencies; tokenCurveBindings.ts is the
 * production wiring, loaded only when the plugin is registered so a test
 * of the factory never loads the settings, the database or the SDK.
 */

import { PublicKey, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { z } from "zod";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import {
  CURVE_COMPUTE_UNIT_LIMIT,
  CURVE_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  CURVE_PREPARE_GRACE_SECONDS,
  CURVE_QUOTE_MINT,
  CURVE_TOKEN_DECIMALS,
  CURVE_TOKEN_SUPPLY_RAW,
  CurveUnreadableError,
  LOCKER_COMPUTE_UNIT_LIMIT,
  SLIPPAGE_BPS_DEFAULT,
  SLIPPAGE_BPS_MAX,
  SLIPPAGE_BPS_MIN,
  SOL_DECIMALS,
  buildTradeQuote,
  buildTradeRow,
  checkSignedTransaction,
  compileCurveTransaction,
  createCurveReader,
  creatorLockupEndOf,
  deriveCurveState,
  describeCurve,
  formatUnits,
  nextGraduationStep,
  parseUnits,
  readTradeAmounts,
  signCurvePrepareToken,
  unitsThatLeftAccount,
  verifyCurvePrepareToken,
  type ConfirmedTransactionRead,
  type CurveChain,
  type CurvePrepareKind,
  type CurvePreparePayload,
  type CurveReading,
  type CurveSnapshot,
  type CurveTradeRow,
  type SignatureStatus,
  type SolanaNetwork,
  type TradeQuoteJson,
  type TradeSide,
} from "../services/meteoraCurve.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("token-curve");

// ============================================
// Schemas
// ============================================

const quoteBodySchema = z.object({
  side: z.enum(["buy", "sell"]),
  amount: z.string(),
  slippageBps: z.number().int().min(SLIPPAGE_BPS_MIN).max(SLIPPAGE_BPS_MAX).default(SLIPPAGE_BPS_DEFAULT),
});

const tradePrepareBodySchema = quoteBodySchema.extend({
  wallet: z.string().min(1),
});

const walletBodySchema = z.object({
  wallet: z.string().min(1),
});

const submitBodySchema = z.object({
  prepareToken: z.string().min(1),
  signedTransaction: z.string().min(1),
});

// ============================================
// DI surface
// ============================================

/** The columns of an AgentToken these routes need. */
export interface CurveTokenRow {
  id: string;
  mintAddress: string;
  launchpad: string;
  /** The pool: the saved address, or the one derived from the config and the mint. */
  poolAddress: string | null;
  status: string;
}

export interface TokenCurveRouteDeps {
  chain: CurveChain;
  /** null when there is no token with this id. */
  loadToken: (id: string) => Promise<CurveTokenRow | null>;
  /** Writes one AgentTokenTrade row. `created` is false when the signature is already there. */
  recordTrade: (row: CurveTradeRow) => Promise<{ created: boolean }>;
  /**
   * Writes status GRADUATED, graduatedAt and the DAMM v2 pool's address,
   * and, when it is not null, the date the creator's locked tokens start to
   * be released. A row that has already graduated is left as it is.
   */
  markGraduated: (input: {
    tokenId: string;
    graduatedPoolAddress: string;
    at: Date;
    creatorLockupEnd: Date | null;
  }) => Promise<void>;
  /** Dollars per SOL for a trade row's display price, or null when there is no price. */
  solUsd: () => Promise<number | null>;
  network: SolanaNetwork;
  /** null when the server has no secret: the login routes then answer 503. */
  prepareTokenSecret: string | null;
  /** How long a pool reading is kept, milliseconds (METEORA_CURVE_CACHE_MS). */
  cacheMs: number;
  now?: () => Date;
}

interface Refusal {
  status: number;
  body: Record<string, unknown>;
}

type Found<T> = ({ ok: true } & T) | { ok: false; refusal: Refusal };

function refuse(status: number, body: Record<string, unknown>): { ok: false; refusal: Refusal } {
  return { ok: false, refusal: { status, body } };
}

function isSolanaAddress(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

// ============================================
// Plugin
// ============================================

export function createTokenCurveRoutes(deps: TokenCurveRouteDeps): FastifyPluginAsync {
  const now = deps.now ?? (() => new Date());
  const { chain } = deps;
  const reader = createCurveReader({ chain, cacheMs: deps.cacheMs, now });

  /** The token, when it is one of ours on a curve with a pool to read. */
  async function curveToken(id: string): Promise<Found<{ token: CurveTokenRow; poolAddress: string }>> {
    const token = await deps.loadToken(id);
    if (!token) return refuse(404, { error: "token_not_found" });
    if (token.launchpad !== "meteora") return refuse(404, { error: "not_a_curve_token" });
    if (!token.poolAddress) {
      logger.error({ tokenId: token.id }, "a meteora token has neither a pool address nor a config to derive it from");
      return refuse(503, { error: "curve_unreadable" });
    }
    return { ok: true, token, poolAddress: token.poolAddress };
  }

  /**
   * A pool can graduate without us: on mainnet Meteora's own service does
   * it. The chain's word is what every answer here says; when our row still
   * says BONDING it is brought in line, on whichever read first sees it.
   */
  async function repairGraduatedRow(token: CurveTokenRow, snapshot: CurveSnapshot): Promise<void> {
    if (token.status !== "BONDING" || deriveCurveState(snapshot) !== "graduated") return;
    if (!snapshot.graduatedPoolAddress) return;
    try {
      await deps.markGraduated({
        tokenId: token.id,
        graduatedPoolAddress: snapshot.graduatedPoolAddress,
        at: now(),
        creatorLockupEnd: creatorLockupEndOf(snapshot),
      });
      logger.info({ tokenId: token.id }, "the pool graduated without us; the row was brought in line");
    } catch (err) {
      logger.error({ err, tokenId: token.id }, "graduated on chain; the row could not be brought in line");
    }
  }

  async function readCurve(
    token: CurveTokenRow,
    poolAddress: string,
    fresh = false,
  ): Promise<Found<{ reading: CurveReading }>> {
    try {
      const reading = await reader.read(poolAddress, { fresh });
      // A row that points at another token's pool must never be traded.
      if (reading.snapshot.mintAddress !== token.mintAddress) {
        logger.error(
          { tokenId: token.id, poolAddress, poolMint: reading.snapshot.mintAddress },
          "the pool saved for this token holds another mint",
        );
        return refuse(503, { error: "curve_unreadable" });
      }
      await repairGraduatedRow(token, reading.snapshot);
      return { ok: true, reading };
    } catch (err) {
      if (!(err instanceof CurveUnreadableError)) throw err;
      logger.warn({ err, tokenId: token.id, poolAddress }, "curve could not be read");
      return refuse(503, { error: "curve_unreadable" });
    }
  }

  /** Shared by the quote and the trade's prepare, so both give the same numbers. */
  function quoteTrade(
    reading: CurveReading,
    body: z.infer<typeof quoteBodySchema>,
  ): Found<{
    quote: TradeQuoteJson;
    amountInRaw: bigint;
    amountInUsedRaw: bigint;
    minimumOutRaw: bigint;
    amountOutRaw: bigint;
  }> {
    const { snapshot } = reading;
    const side: TradeSide = body.side;
    const amountInRaw = parseUnits(body.amount, side === "buy" ? SOL_DECIMALS : CURVE_TOKEN_DECIMALS);
    if (amountInRaw === null || amountInRaw <= 0n) return refuse(400, { error: "invalid_amount" });
    // Nobody holds more than the whole supply, which is fixed: a sell above
    // it is refused here, whatever the arithmetic behind the quote would say.
    if (side === "sell" && amountInRaw > CURVE_TOKEN_SUPPLY_RAW) return refuse(400, { error: "invalid_amount" });
    if (deriveCurveState(snapshot) !== "trading") return refuse(409, { error: "curve_full" });

    let swap;
    try {
      swap = chain.quoteSwap(snapshot, {
        sell: side === "sell",
        amountIn: amountInRaw,
        currentPoint: reading.currentPoint,
      });
    } catch (err) {
      // The SDK refuses what the curve cannot take. A buy of more SOL than
      // the curve has left to raise is not one of those any more: it is
      // quoted as a partial fill. What is left is said for a buy only: it is
      // an amount of SOL and says nothing about a sell.
      if (side === "sell") return refuse(400, { error: "invalid_amount", message: (err as Error).message });
      const remaining = snapshot.migrationQuoteThreshold - snapshot.quoteReserve;
      return refuse(400, {
        error: "invalid_amount",
        message: (err as Error).message,
        remainingLamports: remaining.toString(),
        remainingSol: formatUnits(remaining, SOL_DECIMALS),
      });
    }
    if (swap.amountOut <= 0n || swap.amountInUsed <= 0n) return refuse(400, { error: "invalid_amount" });

    const quote = buildTradeQuote({ side, amountInRaw, slippageBps: body.slippageBps, swap });
    return {
      ok: true,
      quote,
      amountInRaw,
      amountInUsedRaw: swap.amountInUsed,
      amountOutRaw: swap.amountOut,
      minimumOutRaw: BigInt(quote.minimumOutRaw),
    };
  }

  function badBody(error: z.ZodError): Refusal {
    const aboutAmount = error.issues.some((issue) => issue.path[0] === "amount");
    return aboutAmount
      ? { status: 400, body: { error: "invalid_amount" } }
      : { status: 400, body: { error: "invalid_payload", details: error.flatten() } };
  }

  /** What every login route checks first. Answers the refusal itself. */
  function signedIn(
    request: FastifyRequest,
    reply: FastifyReply,
  ): { auth: NonNullable<FastifyRequest["auth"]>; secret: string } | null {
    if (!request.auth) {
      void reply.status(401).send({ error: "unauthenticated" });
      return null;
    }
    if (!deps.prepareTokenSecret) {
      void reply.status(503).send({ error: "prepare_unavailable" });
      return null;
    }
    return { auth: request.auth, secret: deps.prepareTokenSecret };
  }

  /**
   * Compile, sign the prepare token, and answer with what is common to
   * every prepare: the transaction, the token and when it runs out.
   *
   * A transaction the wallet alone signs is given its compute budget here
   * (`unitLimit`), so the wallet has no reason to add its own. One the
   * server signs first (the build returns signers) is left as the SDK made
   * it, and must come back byte for byte.
   */
  async function prepared(input: {
    kind: CurvePrepareKind;
    token: CurveTokenRow;
    reading: CurveReading;
    wallet: string;
    auth: NonNullable<FastifyRequest["auth"]>;
    secret: string;
    unitLimit: number;
    build: () => Promise<TransactionInstruction[] | { instructions: TransactionInstruction[]; signers: Keypair[] }>;
    record: Pick<CurvePreparePayload, "trade" | "fees" | "graduate">;
  }): Promise<Found<{ transaction: string; prepareToken: string; expiresAt: string }>> {
    let compiled;
    let sentWith;
    let serverSignsFirst;
    try {
      const built = await input.build();
      const instructions = Array.isArray(built) ? built : built.instructions;
      const signers = Array.isArray(built) ? [] : built.signers;
      serverSignsFirst = signers.length > 0;
      sentWith = await chain.latestBlockhash();
      compiled = compileCurveTransaction({
        payer: input.wallet,
        blockhash: sentWith.blockhash,
        instructions,
        signers,
        computeBudget: serverSignsFirst
          ? undefined
          : { unitLimit: input.unitLimit, microLamports: CURVE_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS },
      });
    } catch (err) {
      logger.error({ err, tokenId: input.token.id, kind: input.kind }, "curve transaction could not be built");
      return refuse(502, { error: "build_failed", message: (err as Error).message });
    }
    const signed = signCurvePrepareToken({
      payload: {
        kind: input.kind,
        tokenId: input.token.id,
        mintAddress: input.token.mintAddress,
        poolAddress: input.reading.snapshot.poolAddress,
        quoteVault: input.reading.snapshot.quoteVault,
        baseVault: input.reading.snapshot.baseVault,
        wallet: input.wallet,
        userId: input.auth.userId,
        orgId: input.auth.orgId,
        messageHash: compiled.messageHash,
        message: compiled.messageBase64,
        strict: serverSignsFirst,
        lastValidBlockHeight: sentWith.lastValidBlockHeight,
        ...input.record,
      },
      secret: input.secret,
      now,
    });
    return {
      ok: true,
      transaction: compiled.base64,
      prepareToken: signed.token,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  /**
   * Everything a submit refuses before anything is sent: a bad or expired
   * token, a token for another route or token, another user's token, a
   * transaction that is not the one built, a missing signature, a
   * signature that is not the signer's own over this transaction.
   *
   * A token that ran out less than ten minutes ago comes through marked
   * `expired`, with every other check made: `landed` uses it only for a
   * transaction that has already succeeded.
   */
  function accepted(
    request: FastifyRequest,
    kind: CurvePrepareKind,
    auth: NonNullable<FastifyRequest["auth"]>,
    secret: string,
  ): Found<{ payload: CurvePreparePayload; raw: Uint8Array; blockhash: string; signature: string; expired: boolean }> {
    const parsed = submitBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return refuse(400, { error: "invalid_payload", details: parsed.error.flatten() });
    }
    const verified = verifyCurvePrepareToken({
      token: parsed.data.prepareToken,
      secret,
      now,
      graceSeconds: CURVE_PREPARE_GRACE_SECONDS,
    });
    if (!verified.ok) return refuse(400, { error: "prepare_token_invalid", reason: verified.reason });
    const payload = verified.payload;
    const { id } = request.params as { id: string };
    if (payload.kind !== kind) return refuse(400, { error: "prepare_token_invalid", reason: "wrong_kind" });
    if (payload.tokenId !== id) return refuse(400, { error: "prepare_token_invalid", reason: "wrong_token" });
    if (payload.userId !== auth.userId || payload.orgId !== auth.orgId) {
      return refuse(403, { error: "prepare_token_not_yours" });
    }
    const checked = checkSignedTransaction({
      signedBase64: parsed.data.signedTransaction,
      preparedMessageBase64: payload.message,
      strict: payload.strict,
    });
    if (!checked.ok) {
      logger.warn(
        { tokenId: payload.tokenId, kind, reason: checked.reason, difference: checked.difference },
        "a signed transaction was refused before it was sent",
      );
      return refuse(400, { error: "transaction_mismatch", reason: checked.reason });
    }
    if (!checked.identical) {
      logger.info({ tokenId: payload.tokenId, kind }, "the wallet added instructions of its own; the rest is as prepared");
    }
    return {
      ok: true,
      payload,
      raw: checked.raw,
      blockhash: checked.tx.message.recentBlockhash,
      signature: checked.signature,
      expired: verified.expired,
    };
  }

  /** One question to the chain. null when it could not be asked: the caller treats that as not seen. */
  async function statusOf(signature: string): Promise<SignatureStatus | null> {
    try {
      return await chain.signatureStatus(signature);
    } catch (err) {
      logger.warn({ err, signature }, "the status of a transaction could not be asked");
      return null;
    }
  }

  function failedOnChain(signature: string): { ok: false; refusal: Refusal } {
    return refuse(409, {
      error: "transaction_failed",
      signature,
      message: "The chain refused this transaction. Nothing was changed by it.",
    });
  }

  /**
   * Has the transaction landed? Answers its signature when it succeeded on
   * chain, whether this call sent it or an earlier one did.
   *
   * First the chain is asked about the signed transaction's own signature:
   * one that has already succeeded is not sent again, which is what makes a
   * submit safe to repeat. Only a token that has not run out sends
   * anything. After a send, a wait for the confirmation that fails or times
   * out is not the last word: the chain is asked once more, so a
   * transaction that did land does not lose its record. The remembered
   * reading is dropped whenever something may have changed the pool.
   */
  async function landed(
    payload: CurvePreparePayload,
    ok: { raw: Uint8Array; blockhash: string; signature: string; expired: boolean },
  ): Promise<Found<{ signature: string }>> {
    const before = await statusOf(ok.signature);
    if (before === "succeeded") {
      reader.drop(payload.poolAddress);
      return { ok: true, signature: ok.signature };
    }
    if (before === "failed") return failedOnChain(ok.signature);
    // Not seen. An expired token is never a reason to send something.
    if (ok.expired) return refuse(400, { error: "prepare_token_invalid", reason: "expired" });

    let signature: string;
    try {
      signature = await chain.send(ok.raw);
    } catch (err) {
      reader.drop(payload.poolAddress);
      logger.warn({ err, tokenId: payload.tokenId, kind: payload.kind }, "curve transaction was refused by the node");
      return refuse(502, { error: "send_failed", message: (err as Error).message });
    }
    try {
      await chain.confirm(signature, { blockhash: ok.blockhash, lastValidBlockHeight: payload.lastValidBlockHeight });
    } catch (err) {
      reader.drop(payload.poolAddress);
      const after = await statusOf(signature);
      if (after === "failed") {
        logger.warn({ err, signature, tokenId: payload.tokenId, kind: payload.kind }, "curve transaction failed on chain");
        return failedOnChain(signature);
      }
      if (after !== "succeeded") {
        logger.warn({ err, signature, tokenId: payload.tokenId, kind: payload.kind }, "curve transaction was not confirmed");
        return refuse(502, { error: "transaction_not_confirmed", signature, message: (err as Error).message });
      }
      logger.info(
        { signature, tokenId: payload.tokenId, kind: payload.kind },
        "the wait for the confirmation failed, but the transaction succeeded on chain",
      );
    }
    reader.drop(payload.poolAddress);
    return { ok: true, signature };
  }

  /** The confirmed transaction, or null: the caller has a fallback for null. */
  async function confirmedTransaction(signature: string): Promise<ConfirmedTransactionRead | null> {
    try {
      return await chain.readTransaction(signature);
    } catch (err) {
      logger.warn({ err, signature }, "confirmed transaction could not be read back");
      return null;
    }
  }

  return async (app) => {
    // ============================================
    // GET /:id/curve
    // ============================================
    app.get("/:id/curve", async (request, reply) => {
      const { id } = request.params as { id: string };
      const found = await curveToken(id);
      if (!found.ok) return reply.status(found.refusal.status).send(found.refusal.body);
      const read = await readCurve(found.token, found.poolAddress);
      if (!read.ok) return reply.status(read.refusal.status).send(read.refusal.body);
      return reply.status(200).send(describeCurve(read.reading, deps.network));
    });

    // ============================================
    // POST /:id/trade/quote
    // ============================================
    app.post("/:id/trade/quote", async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = quoteBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const refusal = badBody(parsed.error);
        return reply.status(refusal.status).send(refusal.body);
      }
      const found = await curveToken(id);
      if (!found.ok) return reply.status(found.refusal.status).send(found.refusal.body);
      const read = await readCurve(found.token, found.poolAddress);
      if (!read.ok) return reply.status(read.refusal.status).send(read.refusal.body);
      const quoted = quoteTrade(read.reading, parsed.data);
      if (!quoted.ok) return reply.status(quoted.refusal.status).send(quoted.refusal.body);
      return reply.status(200).send(quoted.quote);
    });

    // ============================================
    // POST /:id/trade/prepare
    // ============================================
    app.post("/:id/trade/prepare", async (request, reply) => {
      const session = signedIn(request, reply);
      if (!session) return reply;
      const { id } = request.params as { id: string };
      const parsed = tradePrepareBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const refusal = badBody(parsed.error);
        return reply.status(refusal.status).send(refusal.body);
      }
      const body = parsed.data;
      if (!isSolanaAddress(body.wallet)) return reply.status(400).send({ error: "invalid_wallet" });

      const found = await curveToken(id);
      if (!found.ok) return reply.status(found.refusal.status).send(found.refusal.body);
      const read = await readCurve(found.token, found.poolAddress);
      if (!read.ok) return reply.status(read.refusal.status).send(read.refusal.body);
      const quoted = quoteTrade(read.reading, body);
      if (!quoted.ok) return reply.status(quoted.refusal.status).send(quoted.refusal.body);

      const sell = body.side === "sell";
      // The swap is built with the whole amount typed: a buy is a partial
      // fill, so the chain takes of it only what the curve has left to
      // sell. What is to be recorded is what the quote says the trade takes.
      const result = await prepared({
        kind: "trade",
        token: found.token,
        reading: read.reading,
        wallet: body.wallet,
        auth: session.auth,
        secret: session.secret,
        unitLimit: CURVE_COMPUTE_UNIT_LIMIT,
        build: () =>
          chain.buildSwap({
            poolAddress: found.poolAddress,
            wallet: body.wallet,
            sell,
            amountIn: quoted.amountInRaw,
            minimumOut: quoted.minimumOutRaw,
          }),
        record: {
          trade: {
            side: body.side,
            solLamports: (sell ? quoted.amountOutRaw : quoted.amountInUsedRaw).toString(),
            tokenAmountRaw: (sell ? quoted.amountInRaw : quoted.amountOutRaw).toString(),
          },
        },
      });
      if (!result.ok) return reply.status(result.refusal.status).send(result.refusal.body);
      return reply.status(200).send({
        transaction: result.transaction,
        prepareToken: result.prepareToken,
        quote: quoted.quote,
        expiresAt: result.expiresAt,
      });
    });

    // ============================================
    // POST /:id/trade/submit
    // ============================================
    app.post("/:id/trade/submit", async (request, reply) => {
      const session = signedIn(request, reply);
      if (!session) return reply;
      const ok = accepted(request, "trade", session.auth, session.secret);
      if (!ok.ok) return reply.status(ok.refusal.status).send(ok.refusal.body);
      const { payload } = ok;
      const preparedTrade = payload.trade!;

      const sent = await landed(payload, ok);
      if (!sent.ok) return reply.status(sent.refusal.status).send(sent.refusal.body);
      const { signature } = sent;

      const confirmed = await confirmedTransaction(signature);
      const amounts = readTradeAmounts({
        side: preparedTrade.side,
        prepared: {
          solLamports: BigInt(preparedTrade.solLamports),
          tokenAmountRaw: BigInt(preparedTrade.tokenAmountRaw),
        },
        confirmed,
        mintAddress: payload.mintAddress,
        baseVault: payload.baseVault,
        quoteVault: payload.quoteVault,
      });
      if (!amounts.fromChain) {
        logger.warn(
          { signature, tokenId: payload.tokenId, side: preparedTrade.side },
          "the trade's amounts could not be read from the confirmed transaction; the prepared quote's numbers are written",
        );
      }

      let usdPerSol: number | null = null;
      try {
        usdPerSol = await deps.solUsd();
      } catch (err) {
        logger.warn({ err }, "no SOL price for the trade row; its dollar price is written as 0");
      }
      const row = buildTradeRow({
        tokenId: payload.tokenId,
        txSignature: signature,
        traderAddress: payload.wallet,
        side: preparedTrade.side,
        amounts,
        usdPerSol,
        timestamp: confirmed?.blockTime ? new Date(confirmed.blockTime * 1000) : now(),
      });
      // The trade is on chain whatever happens here, so a failed write is
      // logged and said in the answer, not turned into an error.
      let recorded = true;
      try {
        await deps.recordTrade(row);
      } catch (err) {
        recorded = false;
        // Everything the row held is in the log, so it can be written by hand.
        logger.error(
          {
            err,
            signature,
            tokenId: payload.tokenId,
            traderAddress: row.traderAddress,
            side: row.side,
            solLamports: row.solLamports.toString(),
            tokenAmountRaw: row.tokenAmountRaw.toString(),
            priceUsd: row.priceUsd,
            timestamp: row.timestamp.toISOString(),
          },
          "trade confirmed on chain but its row was not written",
        );
      }

      return reply.status(200).send({
        signature,
        trade: {
          side: preparedTrade.side,
          solLamports: amounts.solLamports.toString(),
          tokenAmountRaw: amounts.tokenAmountRaw.toString(),
        },
        recorded,
      });
    });

    // ============================================
    // POST /:id/fees/prepare
    // ============================================
    app.post("/:id/fees/prepare", async (request, reply) => {
      const session = signedIn(request, reply);
      if (!session) return reply;
      const { id } = request.params as { id: string };
      const parsed = walletBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid_payload", details: parsed.error.flatten() });
      }
      const { wallet } = parsed.data;
      if (!isSolanaAddress(wallet)) return reply.status(400).send({ error: "invalid_wallet" });

      const found = await curveToken(id);
      if (!found.ok) return reply.status(found.refusal.status).send(found.refusal.body);
      // Fresh: who the creator is and what waits for them is the chain's
      // word at this moment, not a reading from a few seconds ago.
      const read = await readCurve(found.token, found.poolAddress, true);
      if (!read.ok) return reply.status(read.refusal.status).send(read.refusal.body);
      const { snapshot } = read.reading;
      if (snapshot.creatorAddress !== wallet) return reply.status(403).send({ error: "not_the_creator" });
      if (snapshot.creatorClaimableLamports <= 0n) return reply.status(409).send({ error: "nothing_to_claim" });

      const result = await prepared({
        kind: "fees",
        token: found.token,
        reading: read.reading,
        wallet,
        auth: session.auth,
        secret: session.secret,
        unitLimit: CURVE_COMPUTE_UNIT_LIMIT,
        build: () => chain.buildClaim({ poolAddress: found.poolAddress, creator: wallet }),
        record: { fees: { claimableLamports: snapshot.creatorClaimableLamports.toString() } },
      });
      if (!result.ok) return reply.status(result.refusal.status).send(result.refusal.body);
      return reply.status(200).send({
        transaction: result.transaction,
        prepareToken: result.prepareToken,
        claimableLamports: snapshot.creatorClaimableLamports.toString(),
        claimableSol: formatUnits(snapshot.creatorClaimableLamports, SOL_DECIMALS),
        expiresAt: result.expiresAt,
      });
    });

    // ============================================
    // POST /:id/fees/submit
    // ============================================
    app.post("/:id/fees/submit", async (request, reply) => {
      const session = signedIn(request, reply);
      if (!session) return reply;
      const ok = accepted(request, "fees", session.auth, session.secret);
      if (!ok.ok) return reply.status(ok.refusal.status).send(ok.refusal.body);
      const { payload } = ok;

      const sent = await landed(payload, ok);
      if (!sent.ok) return reply.status(sent.refusal.status).send(sent.refusal.body);

      // What was claimed is what left the pool's SOL vault. When that cannot
      // be read, it is what was waiting when the claim was built.
      const confirmed = await confirmedTransaction(sent.signature);
      let claimed = confirmed ? unitsThatLeftAccount(confirmed, payload.quoteVault, CURVE_QUOTE_MINT) : null;
      if (claimed === null) {
        logger.warn(
          { signature: sent.signature, tokenId: payload.tokenId },
          "the claimed amount could not be read from the confirmed transaction; the prepared amount is answered",
        );
        claimed = BigInt(payload.fees!.claimableLamports);
      }
      return reply.status(200).send({ signature: sent.signature, claimedLamports: claimed.toString() });
    });

    // ============================================
    // POST /:id/graduate/prepare
    // ============================================
    app.post("/:id/graduate/prepare", async (request, reply) => {
      const session = signedIn(request, reply);
      if (!session) return reply;
      const { id } = request.params as { id: string };
      const parsed = walletBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid_payload", details: parsed.error.flatten() });
      }
      const { wallet } = parsed.data;
      if (!isSolanaAddress(wallet)) return reply.status(400).send({ error: "invalid_wallet" });

      const found = await curveToken(id);
      if (!found.ok) return reply.status(found.refusal.status).send(found.refusal.body);
      const read = await readCurve(found.token, found.poolAddress, true);
      if (!read.ok) return reply.status(read.refusal.status).send(read.refusal.body);
      const { snapshot } = read.reading;
      const state = deriveCurveState(snapshot);

      if (state === "graduated") {
        // Reading the curve has already brought a row that still said
        // BONDING in line (repairGraduatedRow).
        return reply.status(409).send({
          error: "already_graduated",
          graduatedPoolAddress: snapshot.graduatedPoolAddress,
        });
      }
      if (state !== "full") return reply.status(409).send({ error: "curve_not_full" });

      // Which step is next is the pool's own word (its migration progress),
      // not whether a locker account exists.
      const step = nextGraduationStep(snapshot);
      const lockupEnd = creatorLockupEndOf(snapshot);

      const result = await prepared({
        kind: "graduate",
        token: found.token,
        reading: read.reading,
        wallet,
        auth: session.auth,
        secret: session.secret,
        // The locker's cost was never measured. The move is signed by the
        // server first, so it keeps the limit the SDK gives it.
        unitLimit: LOCKER_COMPUTE_UNIT_LIMIT,
        build: () =>
          step === "locker"
            ? chain.buildLocker({ poolAddress: found.poolAddress, payer: wallet })
            : chain.buildMigration(snapshot, { payer: wallet }),
        record: {
          graduate: {
            step,
            graduatedPoolAddress: snapshot.graduatedPoolAddress,
            creatorLockupEnd: lockupEnd ? lockupEnd.toISOString() : null,
          },
        },
      });
      if (!result.ok) return reply.status(result.refusal.status).send(result.refusal.body);
      return reply.status(200).send({
        step,
        transaction: result.transaction,
        prepareToken: result.prepareToken,
        stepsLeftAfterThis: step === "locker" ? 1 : 0,
        expiresAt: result.expiresAt,
      });
    });

    // ============================================
    // POST /:id/graduate/submit
    // ============================================
    app.post("/:id/graduate/submit", async (request, reply) => {
      const session = signedIn(request, reply);
      if (!session) return reply;
      const ok = accepted(request, "graduate", session.auth, session.secret);
      if (!ok.ok) return reply.status(ok.refusal.status).send(ok.refusal.body);
      const { payload } = ok;
      const { step, graduatedPoolAddress, creatorLockupEnd } = payload.graduate!;

      const sent = await landed(payload, ok);
      if (!sent.ok) return reply.status(sent.refusal.status).send(sent.refusal.body);
      if (step === "locker") {
        return reply.status(200).send({ signature: sent.signature, step });
      }

      // The pool has moved. A failed write is answered with everything the
      // page needs; the next read of the curve brings the row in line.
      try {
        if (!graduatedPoolAddress) throw new Error("the graduated pool's address is not known");
        await deps.markGraduated({
          tokenId: payload.tokenId,
          graduatedPoolAddress,
          at: now(),
          creatorLockupEnd: creatorLockupEnd ? new Date(creatorLockupEnd) : null,
        });
      } catch (err) {
        logger.error(
          { err, signature: sent.signature, tokenId: payload.tokenId },
          "graduated on chain but the row was not written",
        );
        return reply.status(500).send({
          error: "persistence_failed",
          signature: sent.signature,
          step,
          graduatedPoolAddress,
          message: (err as Error).message,
        });
      }
      return reply.status(200).send({ signature: sent.signature, step, graduatedPoolAddress });
    });
  };
}

/**
 * The plugin src/index.ts mounts under /api/tokens. The bindings are
 * imported here, not at the top, so that importing this file for the
 * factory above loads nothing but the factory.
 */
export const tokenCurveRoutes: FastifyPluginAsync = async (app) => {
  const { buildTokenCurveRouteDeps } = await import("./tokenCurveBindings.js");
  await app.register(createTokenCurveRoutes(buildTokenCurveRouteDeps()));
};
