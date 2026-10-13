/**
 * What the Billing page reads, mounted under /api/billing:
 *
 *   GET /balance              what is available, what is held, and both
 *   GET /holds                each thing that holds credits, and why
 *   GET /usage                this UTC month: spending by kind, GPU hours,
 *                             requests and tokens
 *   GET /transactions         the credit ledger, newest first, a page at a
 *                             time (limit, cursor, filter)
 *   GET /transactions/export  the ledger of a range of days as a CSV file,
 *                             for every plan
 *   GET /marketplace-usage    the Usage page: the one balance, then what the
 *                             organization has used and spent on each listing
 *                             it pays to use (services/buyerUsage.ts)
 *
 * Every route reads the caller's own organization (a session or an API key
 * of it) and nothing else. No route here writes.
 *
 * Every sentence in an answer comes from services/billingLedger.ts. Text
 * from the database or from a thrown error goes to the log, never into an
 * answer.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { requireAuth } from "../middleware/auth.js";
import {
  BILLING_LEDGER_SENTENCES,
  exportTransactions,
  listTransactions,
  readBalance,
  readHolds,
  readUsage,
  type BillingLedgerDeps,
  type BillingLedgerRefusalCode,
} from "../services/billingLedger.js";
import { readBuyerUsage, type BuyerUsageDeps } from "../services/buyerUsage.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("billing-ledger");

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export interface BillingLedgerRouteDeps {
  ledger: BillingLedgerDeps;
  /** The reads of GET /marketplace-usage. Without them that route is not mounted. */
  usage?: BuyerUsageDeps;
  /** Tests pass a stand-in; production uses requireAuth. */
  guards?: { signedIn: Guard[] };
}

export function createBillingLedgerRoutes(deps: BillingLedgerRouteDeps): FastifyPluginAsync {
  const signedIn = deps.guards?.signedIn ?? [requireAuth];

  function refuse(reply: FastifyReply, status: number, code: BillingLedgerRefusalCode) {
    return reply.status(status).send({ error: code, message: BILLING_LEDGER_SENTENCES[code] });
  }

  /**
   * Runs a handler for the caller's organization. Anything it did not expect
   * ends here: the error is logged and the answer is one fixed sentence, so
   * no thrown text can leak.
   */
  function guarded(
    name: string,
    handler: (orgId: string, request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  ) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) return refuse(reply, 401, "unauthenticated");
      try {
        return await handler(orgId, request, reply);
      } catch (err) {
        logger.error({ err, route: name }, "billing ledger route failed");
        return refuse(reply, 500, "billing_unavailable");
      }
    };
  }

  const queryOf = (request: FastifyRequest) =>
    (request.query ?? {}) as Record<string, unknown>;

  return async (app) => {
    app.get(
      "/balance",
      { preHandler: signedIn },
      guarded("balance", (orgId) => readBalance(deps.ledger, orgId)),
    );

    app.get(
      "/holds",
      { preHandler: signedIn },
      guarded("holds", (orgId) => readHolds(deps.ledger, orgId)),
    );

    app.get(
      "/usage",
      { preHandler: signedIn },
      guarded("usage", (orgId) => readUsage(deps.ledger, orgId)),
    );

    app.get(
      "/transactions",
      { preHandler: signedIn },
      guarded("transactions", async (orgId, request, reply) => {
        const { limit, cursor, filter } = queryOf(request);
        const result = await listTransactions(deps.ledger, orgId, { limit, cursor, filter });
        if (!result.ok) return refuse(reply, 400, result.code);
        return { transactions: result.transactions, nextCursor: result.nextCursor };
      }),
    );

    // The whole ledger of a range of days as a file. Every plan has it.
    app.get(
      "/transactions/export",
      { preHandler: signedIn },
      guarded("export", async (orgId, request, reply) => {
        const { from, to } = queryOf(request);
        const result = await exportTransactions(deps.ledger, orgId, { from, to });
        if (!result.ok) return refuse(reply, 400, result.code);
        return reply
          .header("content-disposition", `attachment; filename="${result.filename}"`)
          .type("text/csv; charset=utf-8")
          .send(result.csv);
      }),
    );

    // A read like the others: requireAuth does not count a GET as an API call.
    const { usage } = deps;
    if (usage) {
      app.get(
        "/marketplace-usage",
        { preHandler: signedIn },
        guarded("marketplace-usage", (orgId) => readBuyerUsage(usage, orgId)),
      );
    }
  };
}
