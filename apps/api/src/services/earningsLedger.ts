/**
 * The one way the amount a creator is owed changes.
 *
 * `publisher_profiles.pending_payout_cents` is what a creator can ask to be
 * paid. Until now it was a bare number that seven places added to or took
 * from, with nothing behind it: "why is this creator owed $41.20" had no
 * answer, and a mistake in any one place could not be found afterwards.
 *
 * `moveEarnings` changes that number and writes one `earnings_transactions`
 * row for the change, with the balance it left, inside the transaction it is
 * given. It is the only code that may touch the number
 * (tests/earningsLedgerWiring.unit.test.ts reads the source to hold that).
 * The rows add up to the number, from an `opening_balance` row written by the
 * migration for every creator who was owed something before the ledger
 * existed.
 *
 * Pure: it takes the transaction as an argument and imports nothing.
 */

/** Why the amount changed. */
export type EarningsEntryType =
  /** A sale of use, per message or per run, was settled. */
  | "sale"
  /** A month of a subscription, the first or a renewal. */
  | "subscription"
  /** A hired job was settled. */
  | "job"
  /** A contributor's share of a sale of someone else's agent. */
  | "contributor_share"
  /** Taken out of the balance for a payout request. */
  | "payout_reserved"
  /** A payout that failed or was cancelled, put back. */
  | "payout_restored";

/** The types that are income: they also add to the creator's lifetime revenue. */
const INCOME_TYPES: ReadonlySet<EarningsEntryType> = new Set(["sale", "subscription", "job", "contributor_share"]);

/** The one type that takes from the balance. Every other type adds to it. */
const TAKING_TYPE: EarningsEntryType = "payout_reserved";

export class EarningsLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EarningsLedgerError";
  }
}

/** What `moveEarnings` needs of a transaction. Prisma's client satisfies it. */
export interface EarningsLedgerTx {
  publisherProfile: {
    updateMany(args: {
      where: { orgId: string; pendingPayoutCents?: { gte: bigint } };
      data: {
        pendingPayoutCents: { increment: bigint } | { decrement: bigint };
        totalRevenueCents?: { increment: bigint };
      };
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { orgId: string };
      select: { pendingPayoutCents: true };
    }): Promise<{ pendingPayoutCents: bigint } | null>;
  };
  earningsTransaction: {
    create(args: {
      data: {
        orgId: string;
        amountCents: bigint;
        type: string;
        referenceId: string | null;
        description: string | null;
        balanceAfter: bigint;
      };
    }): Promise<unknown>;
  };
}

export interface MoveEarningsArgs {
  /** The creator's organization. */
  orgId: string;
  /** Cents, signed: above zero adds to what is owed, below zero takes from it. */
  amountCents: bigint;
  type: EarningsEntryType;
  /** The row this change belongs to: a revenue row, a payout, a contributor earning. */
  referenceId?: string | null;
  /** A few plain words for a statement. */
  description?: string | null;
}

export type MoveEarningsResult =
  | { moved: true; balanceAfterCents: bigint }
  /**
   * Nothing was changed and no row was written.
   *   no_profile     the organization has no publisher profile
   *   balance_short  the balance is smaller than the amount to take
   */
  | { moved: false; reason: "no_profile" | "balance_short" };

/**
 * Change what a creator is owed, and write the row for it, in `tx`.
 *
 * An amount of zero changes nothing and writes nothing. A type whose sign
 * does not fit the amount is a mistake in the caller and throws, so the
 * caller's transaction rolls back. A missing profile or a balance too small
 * to take from is an answer, not a throw: nothing is written and the caller
 * decides what that means.
 */
export async function moveEarnings(tx: EarningsLedgerTx, args: MoveEarningsArgs): Promise<MoveEarningsResult> {
  const { orgId, amountCents, type } = args;
  if (typeof amountCents !== "bigint") {
    throw new EarningsLedgerError("moveEarnings: the amount must be a bigint of cents");
  }
  const takes = type === TAKING_TYPE;
  if ((takes && amountCents > 0n) || (!takes && amountCents < 0n)) {
    throw new EarningsLedgerError(`moveEarnings: ${type} cannot ${takes ? "add to" : "take from"} the balance`);
  }

  if (amountCents === 0n) {
    const current = await tx.publisherProfile.findUnique({ where: { orgId }, select: { pendingPayoutCents: true } });
    return current ? { moved: true, balanceAfterCents: current.pendingPayoutCents } : { moved: false, reason: "no_profile" };
  }

  if (takes) {
    const amount = -amountCents;
    // Conditional: two requests that both read the same balance cannot both
    // take it, and the balance can never go below zero.
    const taken = await tx.publisherProfile.updateMany({
      where: { orgId, pendingPayoutCents: { gte: amount } },
      data: { pendingPayoutCents: { decrement: amount } },
    });
    if (taken.count !== 1) {
      const profile = await tx.publisherProfile.findUnique({ where: { orgId }, select: { pendingPayoutCents: true } });
      return { moved: false, reason: profile ? "balance_short" : "no_profile" };
    }
  } else {
    const added = await tx.publisherProfile.updateMany({
      where: { orgId },
      data: {
        pendingPayoutCents: { increment: amountCents },
        ...(INCOME_TYPES.has(type) ? { totalRevenueCents: { increment: amountCents } } : {}),
      },
    });
    if (added.count !== 1) return { moved: false, reason: "no_profile" };
  }

  // Read inside the same transaction, after our own write: this is the
  // balance this change left.
  const after = await tx.publisherProfile.findUnique({ where: { orgId }, select: { pendingPayoutCents: true } });
  if (!after) throw new EarningsLedgerError("moveEarnings: the profile vanished inside the transaction");

  await tx.earningsTransaction.create({
    data: {
      orgId,
      amountCents,
      type,
      referenceId: args.referenceId ?? null,
      description: args.description ?? null,
      balanceAfter: after.pendingPayoutCents,
    },
  });
  return { moved: true, balanceAfterCents: after.pendingPayoutCents };
}
