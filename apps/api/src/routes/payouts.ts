/**
 * A creator's payouts: request one, take one back, list them.
 *
 *   POST /payouts             request a payout (owner or admin, signed in)
 *   POST /payouts/:id/cancel  take back a payout that is still pending
 *   GET  /payouts             the payout history
 *
 * Mounted under /api/marketplace. `createPayoutRoutes(deps)` takes
 * everything it reads or writes; routes/payoutBindings.ts binds it to
 * Prisma, the chain and the settings.
 *
 * Every refusal is `{ error, message }` with a sentence this service wrote
 * (services/payoutSentences.ts). No thrown error's text is ever sent: an
 * error nobody expected is logged and answered with one fixed sentence.
 */

import { z } from "zod";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { PAYOUT_METHODS } from "@wheelsai/shared/payouts";

import { requireAuth, requireJwtAuth, requireRole } from "../middleware/auth.js";
import {
  payoutNotCancellableMessage,
  payoutView,
  PAYOUT_NOT_CANCELLABLE_CODE,
  type CancelPayoutResult,
  type PayoutRequestInput,
  type PayoutRow,
  type RequestPayoutResult,
} from "../services/payoutRequests.js";
import {
  payoutRefusalMessage,
  payoutRequestedMessage,
  PAYOUT_ACTION_FAILED_CODE,
  PAYOUT_ACTION_FAILED_MESSAGE,
  PAYOUT_REFUSAL_STATUS,
  PAYOUT_REQUEST_FAILED_CODE,
  PAYOUT_REQUEST_FAILED_MESSAGE,
  type PayoutRefusal,
} from "../services/payoutSentences.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("payout-routes");

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export interface PayoutRouteDeps {
  /** Payouts are running now: the rule GET /api/capabilities answers with. */
  payoutsAvailable(): boolean;
  requestPayout(input: PayoutRequestInput): Promise<RequestPayoutResult>;
  cancelPayout(input: { payoutId: string; orgId: string }): Promise<CancelPayoutResult>;
  /** The organization's payouts, newest first. */
  listPayouts(orgId: string): Promise<PayoutRow[]>;
  /** Tests only: stand-ins for the guards. Production uses middleware/auth.ts. */
  guards?: { signedIn: Guard[]; ownerOrAdminPerson: Guard[] };
}

const requestBody = z.object({
  payoutMethod: z.enum(PAYOUT_METHODS),
  payoutAddress: z.string().max(200).nullish(),
  amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
});

const PAYOUT_NOT_FOUND = { error: "payout_not_found", message: "Payout not found" };

export function createPayoutRoutes(deps: PayoutRouteDeps): FastifyPluginAsync {
  const signedIn = deps.guards?.signedIn ?? [requireAuth];
  // Human sessions only: the caller supplies the payout address, so an API
  // key (which bypasses role checks) must never be able to redirect a
  // creator's earnings.
  const ownerOrAdminPerson = deps.guards?.ownerOrAdminPerson ?? [
    requireAuth,
    requireJwtAuth,
    requireRole("owner", "admin"),
  ];

  function refuse(reply: FastifyReply, refusal: PayoutRefusal) {
    return reply
      .status(PAYOUT_REFUSAL_STATUS[refusal.code])
      .send({ error: refusal.code, message: payoutRefusalMessage(refusal) });
  }

  return async (app) => {
    /**
     * POST /payouts - Request a payout
     */
    app.post("/payouts", { preHandler: ownerOrAdminPerson }, async (request, reply) => {
      const { orgId } = request.auth!;
      try {
        // A request reserves the creator's earnings into the payout row,
        // and only the payout worker moves that row on. While it is not
        // running, refuse here, before anything is read, reserved or
        // written.
        if (!deps.payoutsAvailable()) return refuse(reply, { code: "payouts_unavailable" });

        const body = requestBody.safeParse(request.body);
        if (!body.success) return refuse(reply, { code: "invalid_payload" });

        const result = await deps.requestPayout({
          orgId,
          payoutMethod: body.data.payoutMethod,
          payoutAddress: body.data.payoutAddress ?? null,
          amountCents: body.data.amountCents ?? null,
        });
        if (result.outcome === "refused") {
          logger.info({ orgId, code: result.refusal.code }, "Payout request refused");
          return refuse(reply, result.refusal);
        }

        const { payout, remainingCents, atCap } = result;
        logger.info(
          { orgId, payoutId: payout.id, amount: Number(payout.amountCents), method: payout.payoutMethod },
          "Payout requested",
        );
        return reply.status(201).send({
          payout: payoutView(payout),
          remainingCents: Number(remainingCents),
          message: payoutRequestedMessage({
            payoutMethod: payout.payoutMethod,
            amountCents: payout.amountCents,
            remainingCents,
            atCap,
          }),
        });
      } catch (err) {
        logger.error({ err, orgId }, "Failed to request payout");
        return reply
          .status(500)
          .send({ error: PAYOUT_REQUEST_FAILED_CODE, message: PAYOUT_REQUEST_FAILED_MESSAGE });
      }
    });

    /**
     * POST /payouts/:id/cancel - Take back a payout that is still pending
     */
    // The same people who may request a payout may cancel one. It is NOT
    // refused while payouts are off: that is exactly when a pending payout
    // has to be cancellable, or its amount stays reserved.
    app.post("/payouts/:id/cancel", { preHandler: ownerOrAdminPerson }, async (request, reply) => {
      const { orgId } = request.auth!;

      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) return reply.status(404).send(PAYOUT_NOT_FOUND);

      try {
        const result = await deps.cancelPayout({ payoutId: params.data.id, orgId });
        if (result.outcome === "not_found") return reply.status(404).send(PAYOUT_NOT_FOUND);
        if (result.outcome === "not_cancellable") {
          return reply.status(409).send({
            error: PAYOUT_NOT_CANCELLABLE_CODE,
            message: payoutNotCancellableMessage(result.status),
          });
        }
        logger.info(
          { orgId, payoutId: result.payout.id, amount: Number(result.payout.amountCents) },
          "Payout cancelled, earnings restored",
        );
        return { payout: payoutView(result.payout) };
      } catch (err) {
        logger.error({ err, orgId, payoutId: params.data.id }, "Failed to cancel payout");
        return reply
          .status(500)
          .send({ error: PAYOUT_ACTION_FAILED_CODE, message: PAYOUT_ACTION_FAILED_MESSAGE });
      }
    });

    /**
     * GET /payouts - Get payout history
     */
    app.get("/payouts", { preHandler: signedIn }, async (request, reply) => {
      const { orgId } = request.auth!;
      try {
        // payoutView adds `cancellable` and `message`, and turns what was
        // recorded about a failure into a sentence written for the creator.
        const rows = await deps.listPayouts(orgId);
        return { payouts: rows.map((row) => payoutView(row)) };
      } catch (err) {
        logger.error({ err, orgId }, "Failed to list payouts");
        return reply
          .status(500)
          .send({ error: PAYOUT_ACTION_FAILED_CODE, message: PAYOUT_ACTION_FAILED_MESSAGE });
      }
    });
  };
}
