/**
 * Publisher-funded Try it messages.
 *
 * Every published listing can be tried on the platform's free models, up to
 * a number of messages a day that the platform pays for. A publisher who
 * wants more sets a daily cap of their own and pays a fixed price per
 * message above the platform's (TRIAL_FUNDED_MESSAGE_CENTS). This file moves
 * that money:
 *
 *   hold     BEFORE the model is called. One transaction: the listing's
 *            funded count for the day rises by compare-and-set (never past
 *            the cap), the publisher's credits fall by a conditional
 *            decrement (never below zero), one ledger row `trial_usage`, one
 *            TrialCharge row `held`. If the publisher cannot pay, the whole
 *            transaction rolls back and the count with it.
 *   settle   held -> settled, once. The answer reached the visitor; the
 *            money was already taken, so nothing else moves.
 *   refund   held -> refunded, once. The credits go back, one ledger row
 *            `trial_usage_refund`, and the day's funded count falls by one
 *            (the message was not had).
 *
 * settle and refund are both a compare-and-set from `held`, so they cannot
 * both happen and neither can happen twice. A process that dies between
 * hold and either leaves the charge `held`; the reaper
 * (services/runTrialChargeReapTick.ts) refunds it.
 *
 * The funded count lives in the database, not in the limiter's Redis: a
 * Redis restart must not be able to charge a publisher past their cap.
 *
 * The visitor is never charged anything, here or anywhere.
 */

import { randomUUID } from "node:crypto";

import type { SettleableMeter } from "./chatStreamSettlement.js";

export const TRIAL_USAGE_LEDGER_TYPE = "trial_usage";
export const TRIAL_REFUND_LEDGER_TYPE = "trial_usage_refund";

export interface TrialChargeRow {
  id: string;
  listingId: string;
  publisherId: string;
  day: string;
  amountCents: bigint;
  status: string;
}

/** What a hold, a settle and a refund touch. A Prisma client or transaction client. */
export interface TrialFundingTx {
  trialDailyUsage: {
    updateMany(args: {
      where: { listingId: string; day: string; fundedCount: { lt: number } | { gt: number } };
      data: { fundedCount: { increment: number } | { decrement: number } };
    }): Promise<{ count: number }>;
  };
  creditBalance: {
    updateMany(args: {
      where: { orgId: string; balanceCents: { gte: bigint } };
      data: { balanceCents: { decrement: bigint } };
    }): Promise<{ count: number }>;
    update(args: {
      where: { orgId: string };
      data: { balanceCents: { increment: bigint } };
    }): Promise<{ balanceCents: bigint }>;
    findUnique(args: { where: { orgId: string } }): Promise<{ balanceCents: bigint } | null>;
  };
  creditTransaction: {
    create(args: {
      data: {
        orgId: string;
        amountCents: bigint;
        type: string;
        description: string;
        referenceId: string;
        balanceAfter: bigint;
      };
    }): Promise<unknown>;
  };
  trialCharge: {
    create(args: {
      data: {
        id: string;
        listingId: string;
        publisherId: string;
        day: string;
        amountCents: bigint;
        status: "held";
      };
    }): Promise<unknown>;
    updateMany(args: {
      where: { id: string; status: "held" };
      data: { status: "settled" | "refunded"; resolvedAt: Date; failureReason?: string };
    }): Promise<{ count: number }>;
    findUnique(args: { where: { id: string } }): Promise<TrialChargeRow | null>;
  };
}

export interface TrialFundingDb extends TrialFundingTx {
  trialDailyUsage: TrialFundingTx["trialDailyUsage"] & {
    upsert(args: {
      where: { listingId_day: { listingId: string; day: string } };
      create: { listingId: string; day: string };
      update: Record<string, never>;
    }): Promise<unknown>;
  };
  $transaction<T>(fn: (tx: TrialFundingTx) => Promise<T>): Promise<T>;
}

export interface TrialHoldArgs {
  chargeId: string;
  listingId: string;
  /** The publisher's organization: whose credits pay. */
  publisherId: string;
  /** UTC `YYYY-MM-DD`. */
  day: string;
  /** Publisher-funded messages a day (AgentListing.trialFundedDailyCap). */
  dailyCap: number;
  amountCents: bigint;
}

export type TrialHoldResult = { ok: true; chargeId: string } | { ok: false; reason: "cap_reached" | "insufficient_credits" };

/** Thrown inside the hold's transaction to undo the count it already took. */
class HoldRolledBack extends Error {
  constructor() {
    super("trial hold rolled back: the publisher's credits do not cover it");
    this.name = "HoldRolledBack";
  }
}

/**
 * Run inside a transaction. The (listing, day) usage row must already exist
 * (createTrialFunding makes sure of it before opening the transaction).
 * Throws HoldRolledBack - which the caller's transaction must not swallow -
 * when the publisher cannot pay.
 */
export async function holdTrialMessage(tx: TrialFundingTx, args: TrialHoldArgs): Promise<TrialHoldResult> {
  if (args.amountCents <= 0n || args.dailyCap <= 0) return { ok: false, reason: "cap_reached" };

  // The cap first: at the cap nothing has changed and nothing needs undoing.
  const counted = await tx.trialDailyUsage.updateMany({
    where: { listingId: args.listingId, day: args.day, fundedCount: { lt: args.dailyCap } },
    data: { fundedCount: { increment: 1 } },
  });
  if (counted.count === 0) return { ok: false, reason: "cap_reached" };

  const debited = await tx.creditBalance.updateMany({
    where: { orgId: args.publisherId, balanceCents: { gte: args.amountCents } },
    data: { balanceCents: { decrement: args.amountCents } },
  });
  if (debited.count === 0) throw new HoldRolledBack();

  const after = await tx.creditBalance.findUnique({ where: { orgId: args.publisherId } });
  await tx.creditTransaction.create({
    data: {
      orgId: args.publisherId,
      amountCents: -args.amountCents,
      type: TRIAL_USAGE_LEDGER_TYPE,
      description: "Try it message paid for by the publisher (hold)",
      referenceId: args.chargeId,
      balanceAfter: after?.balanceCents ?? 0n,
    },
  });
  await tx.trialCharge.create({
    data: {
      id: args.chargeId,
      listingId: args.listingId,
      publisherId: args.publisherId,
      day: args.day,
      amountCents: args.amountCents,
      status: "held",
    },
  });
  return { ok: true, chargeId: args.chargeId };
}

/** held -> settled. False when the charge was already settled or refunded. */
export async function settleTrialCharge(tx: Pick<TrialFundingTx, "trialCharge">, chargeId: string, at: Date): Promise<boolean> {
  const settled = await tx.trialCharge.updateMany({
    where: { id: chargeId, status: "held" },
    data: { status: "settled", resolvedAt: at },
  });
  return settled.count === 1;
}

/**
 * held -> refunded, and the money back. Run inside a transaction. False when
 * the charge was already settled or refunded; then nothing moves.
 */
export async function refundTrialCharge(
  tx: TrialFundingTx,
  args: { chargeId: string; reason: string; at: Date },
): Promise<boolean> {
  // The compare-and-set is the gate: only the caller that wins it pays back.
  const claimed = await tx.trialCharge.updateMany({
    where: { id: args.chargeId, status: "held" },
    data: { status: "refunded", resolvedAt: args.at, failureReason: args.reason.slice(0, 500) },
  });
  if (claimed.count === 0) return false;

  const charge = await tx.trialCharge.findUnique({ where: { id: args.chargeId } });
  if (!charge) throw new Error(`trial charge ${args.chargeId} vanished inside its own refund`);

  const after = await tx.creditBalance.update({
    where: { orgId: charge.publisherId },
    data: { balanceCents: { increment: charge.amountCents } },
  });
  await tx.creditTransaction.create({
    data: {
      orgId: charge.publisherId,
      amountCents: charge.amountCents,
      type: TRIAL_REFUND_LEDGER_TYPE,
      description: `Try it message refunded: ${args.reason}`.slice(0, 500),
      referenceId: charge.id,
      balanceAfter: after.balanceCents,
    },
  });
  // The message was not had, so it does not count against the day's cap.
  await tx.trialDailyUsage.updateMany({
    where: { listingId: charge.listingId, day: charge.day, fundedCount: { gt: 0 } },
    data: { fundedCount: { decrement: 1 } },
  });
  return true;
}

// ============================================
// Bound to a database
// ============================================

export interface TrialFunding {
  /** What services/publicChat.ts calls as `holdFundedMessage`. */
  hold(args: {
    listingId: string;
    publisherId: string;
    day: string;
    dailyCap: number;
  }): Promise<{ ok: true; meter: SettleableMeter; chargeId: string } | { ok: false; reason: "cap_reached" | "insufficient_credits" }>;
  settle(chargeId: string): Promise<boolean>;
  refund(chargeId: string, reason: string): Promise<boolean>;
}

export interface TrialFundingOptions {
  /** The price of one funded message, read on each hold. */
  messageCents(): bigint;
  now?: () => Date;
  newId?: () => string;
}

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === "P2002";

export function createTrialFunding(db: TrialFundingDb, options: TrialFundingOptions): TrialFunding {
  const now = options.now ?? (() => new Date());

  const settle = (chargeId: string) => settleTrialCharge(db, chargeId, now());
  const refund = (chargeId: string, reason: string) =>
    db.$transaction((tx) => refundTrialCharge(tx, { chargeId, reason, at: now() }));

  return {
    settle,
    refund,
    async hold({ listingId, publisherId, day, dailyCap }) {
      const amountCents = options.messageCents();
      if (amountCents <= 0n || dailyCap <= 0) return { ok: false, reason: "cap_reached" };

      // Outside the transaction: two first funded messages of a day can race
      // on the row's key, and a unique violation inside a transaction would
      // abort it. Losing the race here means the row exists, which is all
      // this is for.
      try {
        await db.trialDailyUsage.upsert({
          where: { listingId_day: { listingId, day } },
          create: { listingId, day },
          update: {},
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }

      const chargeId = (options.newId ?? randomUUID)();
      let held: TrialHoldResult;
      try {
        held = await db.$transaction((tx) =>
          holdTrialMessage(tx, { chargeId, listingId, publisherId, day, dailyCap, amountCents }),
        );
      } catch (err) {
        if (err instanceof HoldRolledBack) return { ok: false, reason: "insufficient_credits" };
        throw err;
      }
      if (!held.ok) return held;

      return {
        ok: true,
        chargeId,
        meter: {
          settle: async () => {
            await settle(chargeId);
          },
          refund: async (reason) => {
            await refund(chargeId, reason);
          },
        },
      };
    },
  };
}
