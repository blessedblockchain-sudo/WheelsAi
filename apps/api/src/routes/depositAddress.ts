/**
 * GET and POST /deposit-address, POST /deposit-address/usdc-account,
 * POST /deposit-address/check and GET /deposits: an organization's own
 * address, paid from anywhere (an exchange, any wallet) in USDC or SOL,
 * mounted under /api/billing.
 *
 *   GET  /deposit-address               reads; never creates or changes
 *   POST /deposit-address               issues the address (idempotent)
 *   POST /deposit-address/usdc-account  "Prepare address": the platform
 *                                       opens the USDC account
 *   POST /deposit-address/check         "Check now": asks the scan for
 *                                       this address and says what it
 *                                       credited
 *   GET  /deposits                      the last transfers sent straight
 *                                       to the address
 *
 * NO ROUTE HERE GRANTS A CREDIT. Credits come from the scan
 * (services/runDepositScanTick.ts), one receipt a transfer; "Check now"
 * only runs that same scan for one organization.
 *
 * A stored address that is not the one this server derives is never
 * shown: every route answers 503 deposit_address_unavailable.
 *
 * Every answer carries `message`, a sentence from
 * services/depositSentences.ts. Text from a node, the database or a
 * thrown error goes to the log, never into an answer.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import type {
  DepositAddressRead,
  DepositAddressRow,
  DepositReceiptRow,
} from "../services/depositAddresses.js";
import {
  checkSentence,
  depositAddressMessage,
  depositListStatus,
  depositRowSentence,
  depositSentence,
  formatDepositAmount,
  type DepositSentenceCode,
} from "../services/depositSentences.js";
import type { CheckDepositsNow } from "../services/depositTypes.js";
import type { PrepareUsdcAccountResult } from "../services/depositUsdcAccount.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("deposit-address");

/** How many deposits GET /deposits answers with. */
export const DEPOSIT_LIST_LIMIT = 20;

// ============================================
// DI surface
// ============================================

export interface DepositAddressRouteDeps {
  /** Master gate (DEPOSITS_ENABLED): when false every route answers 501. */
  enabled: boolean;
  network: "devnet" | "mainnet-beta";
  /** SOL is offered: SOL_PRICE_SOURCE is not "off". */
  solOffered: boolean;
  /** The organization's address on this network. Never writes. */
  readAddress: (orgId: string) => Promise<DepositAddressRead>;
  /** Issues it (idempotent). Never answers "none". */
  issueAddress: (
    orgId: string,
  ) => Promise<Exclude<DepositAddressRead, { kind: "none" }>>;
  /**
   * Whether the USDC account at the address exists. With `record` the
   * first sighting is stored; without it nothing is written. Never throws
   * for a failed read: that is "not open".
   */
  usdcAccountOpen: (
    row: DepositAddressRow,
    options: { record: boolean },
  ) => Promise<boolean>;
  /** "Prepare address" (services/depositUsdcAccount.ts). */
  prepareUsdcAccount: (orgId: string) => Promise<PrepareUsdcAccountResult>;
  /** Sets scanRequestedAt for the organization's address. */
  requestScan: (orgId: string) => Promise<void>;
  /** One scan of this organization's address, now. */
  checkDepositsNow: CheckDepositsNow;
  /** Receipts of transfers sent straight to the address, newest first. */
  listDeposits: (args: {
    orgId: string;
    limit: number;
  }) => Promise<DepositReceiptRow[]>;
}

// ============================================
// Plugin
// ============================================

const usd = (cents: bigint): number => Number(cents) / 100;

export function createDepositAddressRoutes(
  deps: DepositAddressRouteDeps,
): FastifyPluginAsync {
  const sentenceOptions = { solOffered: deps.solOffered };

  function refuse(
    reply: FastifyReply,
    status: number,
    error: string,
    sentence: DepositSentenceCode,
  ) {
    return reply
      .status(status)
      .send({ error, message: depositSentence(sentence, sentenceOptions) });
  }

  const addressUnavailable = (reply: FastifyReply) =>
    refuse(reply, 503, "deposit_address_unavailable", "deposit_address_unavailable");
  const notIssued = (reply: FastifyReply) =>
    refuse(reply, 404, "deposit_address_not_issued", "deposit_address_not_issued");

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
        logger.error({ err, route: name }, "deposit address route failed");
        return refuse(reply, 503, "deposits_unavailable", "unexpected");
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
      void refuse(reply, 501, "deposits_not_enabled", "deposits_not_enabled");
      return false;
    }
    return true;
  }

  /** What GET and POST /deposit-address answer with. */
  function addressAnswer(address: string | null, accountOpen: boolean) {
    return {
      address,
      network: deps.network,
      assets: [
        { asset: "USDC" as const, accountOpen },
        { asset: "SOL" as const, offered: deps.solOffered },
      ],
      message: depositAddressMessage({
        hasAddress: address !== null,
        solOffered: deps.solOffered,
      }),
    };
  }

  function depositView(row: DepositReceiptRow) {
    const status = depositListStatus(row.status);
    const credited = status === "credited";
    return {
      id: row.id,
      asset: row.asset,
      amount: formatDepositAmount(row.amountRaw, row.asset),
      status,
      creditedUsd: credited ? usd(row.amountUsdCents ?? 0n) : null,
      bonusUsd: credited ? usd(row.bonusCents) : 0,
      txSignature: row.txSignature,
      createdAt: row.createdAt.toISOString(),
      creditedAt: credited && row.creditedAt ? row.creditedAt.toISOString() : null,
      message: depositRowSentence(row),
    };
  }

  return async (app) => {
    // ============================================
    // GET /deposit-address: reads, and nothing else
    // ============================================
    app.get(
      "/deposit-address",
      guarded("get", async (request, reply) => {
        if (!gate(request, reply)) return reply;
        const read = await deps.readAddress(request.auth!.orgId);
        if (read.kind === "mismatch") return addressUnavailable(reply);
        if (read.kind === "none") {
          return reply.status(200).send(addressAnswer(null, false));
        }
        const accountOpen = await deps.usdcAccountOpen(read.row, { record: false });
        return reply.status(200).send(addressAnswer(read.row.address, accountOpen));
      }),
    );

    // ============================================
    // POST /deposit-address: issues the address
    // ============================================
    app.post(
      "/deposit-address",
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      guarded("issue", async (request, reply) => {
        if (!gate(request, reply)) return reply;
        const issued = await deps.issueAddress(request.auth!.orgId);
        if (issued.kind === "mismatch") return addressUnavailable(reply);
        const accountOpen = await deps.usdcAccountOpen(issued.row, { record: true });
        return reply.status(200).send(addressAnswer(issued.row.address, accountOpen));
      }),
    );

    // ============================================
    // POST /deposit-address/usdc-account: "Prepare address"
    // ============================================
    app.post(
      "/deposit-address/usdc-account",
      { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
      guarded("prepare", async (request, reply) => {
        if (!gate(request, reply)) return reply;
        const result = await deps.prepareUsdcAccount(request.auth!.orgId);
        switch (result.outcome) {
          case "open":
            return reply.status(200).send({
              accountOpen: true,
              message: depositSentence("prepared", sentenceOptions),
            });
          case "not_issued":
            return notIssued(reply);
          case "address_unavailable":
            return addressUnavailable(reply);
          case "not_eligible":
            return refuse(reply, 403, "not_eligible", "not_eligible");
          case "daily_limit":
            return refuse(reply, 429, "daily_limit", "daily_limit");
          case "unavailable":
            return refuse(reply, 503, "unavailable", "unavailable");
        }
      }),
    );

    // ============================================
    // POST /deposit-address/check: "Check now"
    // ============================================
    app.post(
      "/deposit-address/check",
      { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
      guarded("check", async (request, reply) => {
        if (!gate(request, reply)) return reply;
        const { orgId } = request.auth!;

        const read = await deps.readAddress(orgId);
        if (read.kind === "mismatch") return addressUnavailable(reply);
        if (read.kind === "none") return notIssued(reply);

        // Asked first: if this check cannot finish, the worker's next run
        // still reads this address ahead of the rest.
        await deps.requestScan(orgId);
        const result = await deps.checkDepositsNow(orgId);
        if (result.outcome === "not_issued") return notIssued(reply);
        if (result.outcome === "chain_unavailable") {
          return refuse(reply, 503, "chain_unavailable", "chain_unavailable");
        }

        return reply.status(200).send({
          credited: result.credited.map((one) => ({
            asset: one.asset,
            amount: formatDepositAmount(one.amountRaw, one.asset),
            creditedUsd: usd(one.creditedCents),
            bonusUsd: usd(one.bonusCents),
            txSignature: one.txSignature,
          })),
          waiting: result.waiting.map((one) => ({
            asset: one.asset,
            amount: formatDepositAmount(one.amountRaw, one.asset),
            txSignature: one.txSignature,
          })),
          message: checkSentence(result),
        });
      }),
    );

    // ============================================
    // GET /deposits: the last transfers sent straight to the address
    // ============================================
    app.get(
      "/deposits",
      guarded("list", async (request, reply) => {
        if (!gate(request, reply)) return reply;
        const { orgId } = request.auth!;
        const read = await deps.readAddress(orgId);
        if (read.kind === "mismatch") return addressUnavailable(reply);
        const rows = await deps.listDeposits({ orgId, limit: DEPOSIT_LIST_LIMIT });
        return reply.status(200).send({ deposits: rows.map(depositView) });
      }),
    );
  };
}
