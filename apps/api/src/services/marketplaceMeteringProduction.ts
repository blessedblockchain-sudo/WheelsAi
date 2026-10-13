/**
 * Composition root for marketplace per-request metering (W2).
 *
 * Binds the pure charge/settle/refund functions to real Prisma and gives
 * call sites two shapes:
 *
 *   beginMarketplaceMetering — for routes that need to answer 402 BEFORE
 *     writing any response bytes (the streaming playground), and that
 *     settle or refund at their own points in the handler.
 *   withMarketplaceMetering — the one-line wrapper for every other
 *     inference path: charge, run, settle-or-refund.
 *
 * Both are no-ops for agents that are not per-request marketplace
 * installs, which is the overwhelming majority of inference: one indexed
 * lookup, then straight through.
 *
 * Settlement failures never fail the caller's request. The buyer already
 * received the answer they paid for; a settle that could not commit
 * leaves the revenue row `pending` (buyer debited, creator not yet
 * credited) which is queryable and recoverable, and is logged loudly
 * here.
 */

import { prisma } from "../lib/prisma.js";
import {
  chargeMarketplaceRequest,
  MarketplaceLicenceRevokedError,
  MarketplacePaymentRequiredError,
  refundMarketplaceRequest,
  resolveInstallBilling,
  settleMarketplaceRequest,
  type GateToken,
  type MarketplaceCharge,
  type RevocationReason,
} from "./marketplaceMetering.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("marketplace-metering");

export interface MeteringHandle {
  /**
   * The money that was taken. Absent when the use was paid for another way:
   * an included use of a plan (services/useMeteringProduction.ts), which
   * takes one from the plan's count and gives it back on `refund`.
   */
  readonly charge?: MarketplaceCharge;
  /** Delivered — accrue the creator's share. Never throws. */
  settle(): Promise<void>;
  /** Not delivered — give the buyer their money back. Never throws. */
  refund(reason: string): Promise<void>;
}

export type BeginMeteringResult =
  /** Not a per-request marketplace install — nothing to bill. */
  | null
  | { ok: true; handle: MeteringHandle }
  | {
      ok: false;
      reason: "insufficient_credits";
      requiredCents: bigint;
      balanceCents: bigint;
      listingTitle: string;
    }
  /** The buyer's licence ended (uninstalled, lapsed, token not held). */
  | {
      ok: false;
      reason: "licence_revoked";
      listingTitle: string;
      revocation: RevocationReason;
      token?: GateToken;
    };

function makeHandle(charge: MarketplaceCharge): MeteringHandle {
  return {
    charge,
    settle: async () => {
      try {
        const result = await prisma.$transaction((tx) =>
          settleMarketplaceRequest(tx as never, { charge }),
        );
        if (!result.settled) {
          logger.warn(
            { revenueId: charge.revenueId, reason: result.reason },
            "marketplace charge was no longer pending at settle",
          );
        }
      } catch (err) {
        logger.error(
          { err, revenueId: charge.revenueId, buyerId: charge.install.buyerId },
          "marketplace settle failed — revenue row stays pending (buyer debited, creator not yet credited)",
        );
      }
    },
    refund: async (reason: string) => {
      try {
        const result = await prisma.$transaction((tx) =>
          refundMarketplaceRequest(tx as never, { charge, reason }),
        );
        if (!result.refunded) {
          logger.warn(
            { revenueId: charge.revenueId, reason: result.reason },
            "marketplace charge was no longer pending at refund",
          );
        }
      } catch (err) {
        logger.error(
          { err, revenueId: charge.revenueId, buyerId: charge.install.buyerId },
          "marketplace refund failed — buyer was charged for a request that did not deliver",
        );
      }
    },
  };
}

export async function beginMarketplaceMetering(args: {
  agentId: string;
  orgId: string;
  requestCount?: number;
}): Promise<BeginMeteringResult> {
  const billing = await resolveInstallBilling(prisma as never, {
    agentId: args.agentId,
    orgId: args.orgId,
  });
  if (billing.kind === "free") return null;
  if (billing.kind === "revoked") {
    return {
      ok: false,
      reason: "licence_revoked",
      listingTitle: billing.listingTitle,
      revocation: billing.reason,
      token: billing.token,
    };
  }

  const install = billing.install;
  const result = await prisma.$transaction((tx) =>
    chargeMarketplaceRequest(tx as never, {
      install,
      requestCount: args.requestCount,
    }),
  );

  if (!result.ok) {
    return {
      ok: false,
      reason: "insufficient_credits",
      requiredCents: result.requiredCents,
      balanceCents: result.balanceCents,
      listingTitle: install.listingTitle,
    };
  }

  logger.info(
    {
      revenueId: result.charge.revenueId,
      listingId: install.listingId,
      buyerId: install.buyerId,
      grossCents: String(result.charge.grossCents),
    },
    "marketplace request charged",
  );

  return { ok: true, handle: makeHandle(result.charge) };
}

/**
 * Charge, run, settle — or refund if `run` throws. Throws
 * MarketplacePaymentRequiredError when the buyer cannot pay, BEFORE the
 * agent runs.
 */
export async function withMarketplaceMetering<T>(
  args: { agentId: string; orgId: string; requestCount?: number },
  run: () => Promise<T>,
): Promise<T> {
  const metering = await beginMarketplaceMetering(args);
  if (metering === null) return run();

  if (!metering.ok) {
    throw metering.reason === "licence_revoked"
      ? new MarketplaceLicenceRevokedError(metering.listingTitle, metering.revocation, metering.token)
      : new MarketplacePaymentRequiredError({
          requiredCents: metering.requiredCents,
          balanceCents: metering.balanceCents,
          listingTitle: metering.listingTitle,
        });
  }

  let result: T;
  try {
    result = await run();
  } catch (err) {
    await metering.handle.refund(
      err instanceof Error ? err.message : "execution failed",
    );
    throw err;
  }

  await metering.handle.settle();
  return result;
}
