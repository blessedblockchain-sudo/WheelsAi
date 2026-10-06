/**
 * Contributor revenue splits (claims ledger M7).
 *
 * An agent's accepted contributors each own a share (basis points) of
 * the creator's earnings from its marketplace listing. When creator
 * revenue settles, each share goes to the contributor's own
 * organization: its publisher profile accrues the amount (so the normal
 * payout flow pays it) and a ContributorEarning row records it. The
 * publisher keeps the rest. Shares were stored before this but never
 * paid.
 *
 * Runs inside the transaction that settles the revenue, so a share is
 * recorded exactly when, and as often as, the revenue row settles.
 *
 * No accepted contributor is silently unpaid. A share whose recipient has
 * no payout profile yet (or owns no organization yet) is still taken out
 * of the publisher's amount and recorded as a ContributorEarning with
 * accruedAt null. accruePendingContributorEarnings adds it to the
 * recipient's balance later, exactly once, outside the money transaction
 * (which must never insert a profile: a unique violation would abort it).
 */

export const BPS_DENOMINATOR = 10_000n;

export interface ContributorSplitTx {
  agentListing: {
    findUnique(args: { where: { id: string }; select: { agentId: true } }): Promise<{ agentId: string } | null>;
  };
  agentContributor: {
    findMany(args: {
      where: { agentId: string; acceptedAt: { not: null }; revenueShareBps: { gt: number } };
      select: { id: true; userId: true; revenueShareBps: true };
      orderBy: { createdAt: "asc" };
    }): Promise<Array<{ id: string; userId: string | null; revenueShareBps: number }>>;
  };
  organization: {
    findFirst(args: {
      where: { ownerId: string };
      orderBy: { createdAt: "asc" };
      select: { id: true; name: true };
    }): Promise<{ id: string; name: string } | null>;
  };
  publisherProfile: {
    findUnique(args: { where: { orgId: string }; select: { orgId: true } }): Promise<{ orgId: string } | null>;
    update(args: {
      where: { orgId: string };
      data: { totalRevenueCents: { increment: bigint }; pendingPayoutCents: { increment: bigint } };
    }): Promise<unknown>;
  };
  contributorEarning: {
    create(args: {
      data: {
        revenueId: string;
        agentId: string;
        contributorId: string;
        userId: string;
        recipientOrgId: string | null;
        publisherId: string;
        shareBps: number;
        amountCents: bigint;
        accruedAt: Date | null;
      };
    }): Promise<unknown>;
  };
}

/** Floor each share; whatever rounding leaves over stays with the publisher. */
export function computeContributorSplit(
  creatorCents: bigint,
  sharesBps: number[],
): { amounts: bigint[]; publisherCents: bigint } {
  let remaining = creatorCents;
  const amounts = sharesBps.map((bps) => {
    const clamped = BigInt(Math.max(0, Math.min(Math.trunc(bps), 10_000)));
    const amount = (creatorCents * clamped) / BPS_DENOMINATOR;
    // Never pay out more than is left, even if stored shares exceed 100%.
    const paid = amount > remaining ? remaining : amount;
    remaining -= paid;
    return paid;
  });
  return { amounts, publisherCents: remaining };
}

export interface SplitResult {
  publisherCents: bigint;
  paid: Array<{ userId: string; recipientOrgId: string; amountCents: bigint }>;
  /** Recorded and owed, not yet in a payout balance. */
  pending: Array<{ userId: string; recipientOrgId: string | null; amountCents: bigint }>;
}

/**
 * Pay contributors their shares of `creatorCents` and return what the
 * publisher keeps. The caller credits the publisher with `publisherCents`.
 */
export async function splitCreatorRevenue(
  tx: Partial<ContributorSplitTx>,
  args: { revenueId: string; listingId: string; publisherId: string; creatorCents: bigint; now?: Date },
): Promise<SplitResult> {
  const none: SplitResult = { publisherCents: args.creatorCents, paid: [], pending: [] };
  if (
    args.creatorCents <= 0n ||
    !tx.agentListing?.findUnique ||
    !tx.agentContributor ||
    !tx.organization ||
    !tx.publisherProfile?.findUnique ||
    !tx.contributorEarning
  ) {
    return none;
  }

  const listing = await tx.agentListing.findUnique({ where: { id: args.listingId }, select: { agentId: true } });
  if (!listing) return none;

  const contributors = await tx.agentContributor.findMany({
    where: { agentId: listing.agentId, acceptedAt: { not: null }, revenueShareBps: { gt: 0 } },
    select: { id: true, userId: true, revenueShareBps: true },
    orderBy: { createdAt: "asc" },
  });
  if (contributors.length === 0) return none;

  // A contributor is paid into the organization they own. A share whose
  // recipient is the publisher itself is simply kept by the publisher.
  // One who owns no organization yet is still owed their share.
  type Recipient = {
    contributor: { id: string; userId: string; revenueShareBps: number };
    org: { id: string; name: string } | null;
  };
  const recipients: Recipient[] = [];
  for (const contributor of contributors) {
    // Accepting binds the invitation to an account; a row without one
    // cannot be accepted, but never guess a payee.
    const userId = contributor.userId;
    if (!userId) continue;
    const org = await tx.organization.findFirst({
      where: { ownerId: userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    });
    if (org?.id === args.publisherId) continue;
    recipients.push({ contributor: { ...contributor, userId }, org });
  }
  if (recipients.length === 0) return none;

  const { amounts } = computeContributorSplit(
    args.creatorCents,
    recipients.map((r) => r.contributor.revenueShareBps),
  );

  const now = args.now ?? new Date();
  const paid: SplitResult["paid"] = [];
  const pending: SplitResult["pending"] = [];
  for (const [i, { contributor, org }] of recipients.entries()) {
    const amountCents = amounts[i] ?? 0n;
    if (amountCents <= 0n) continue;

    // The profile is created when the invitation is accepted. Never insert
    // here: a unique violation would abort the whole money transaction.
    // Without one the share is recorded as owed and accrued later.
    const profile = org
      ? await tx.publisherProfile.findUnique({ where: { orgId: org.id }, select: { orgId: true } })
      : null;
    if (org && profile) {
      await tx.publisherProfile.update({
        where: { orgId: org.id },
        data: { totalRevenueCents: { increment: amountCents }, pendingPayoutCents: { increment: amountCents } },
      });
    }
    await tx.contributorEarning.create({
      data: {
        revenueId: args.revenueId,
        agentId: listing.agentId,
        contributorId: contributor.id,
        userId: contributor.userId,
        recipientOrgId: org?.id ?? null,
        publisherId: args.publisherId,
        shareBps: contributor.revenueShareBps,
        amountCents,
        accruedAt: org && profile ? now : null,
      },
    });
    if (org && profile) paid.push({ userId: contributor.userId, recipientOrgId: org.id, amountCents });
    else pending.push({ userId: contributor.userId, recipientOrgId: org?.id ?? null, amountCents });
  }

  // Shares that rounded to zero stay with the publisher. Owed shares do
  // not: they are the contributor's, whenever they can be credited.
  const owed = [...paid, ...pending].reduce((sum, p) => sum + p.amountCents, 0n);
  return { publisherCents: args.creatorCents - owed, paid, pending };
}

// ============================================
// Accruing owed shares
// ============================================

export interface PendingAccrualTx {
  contributorEarning: {
    updateMany(args: {
      where: { id: string; accruedAt: null };
      data: { accruedAt: Date; recipientOrgId: string };
    }): Promise<{ count: number }>;
  };
  publisherProfile: {
    update(args: {
      where: { orgId: string };
      data: { totalRevenueCents: { increment: bigint }; pendingPayoutCents: { increment: bigint } };
    }): Promise<unknown>;
  };
}

export interface PendingAccrualDeps {
  /** The user's earnings with accruedAt null. */
  listPending(userId: string): Promise<Array<{ id: string; amountCents: bigint }>>;
  inTransaction<T>(fn: (tx: PendingAccrualTx) => Promise<T>): Promise<T>;
}

/**
 * Add a contributor's owed shares to the payout balance of the
 * organization they own. Each earning is claimed by compare-and-swap on
 * accruedAt in the transaction that credits it, so concurrent callers
 * credit it once; a failed credit rolls its claim back and it stays owed.
 * The recipient's publisher profile must exist before this is called.
 */
export async function accruePendingContributorEarnings(
  deps: PendingAccrualDeps,
  args: { userId: string; recipientOrgId: string; now?: Date },
): Promise<{ accrued: number; amountCents: bigint }> {
  const now = args.now ?? new Date();
  const result = { accrued: 0, amountCents: 0n };
  for (const earning of await deps.listPending(args.userId)) {
    const credited = await deps.inTransaction(async (tx) => {
      const claimed = await tx.contributorEarning.updateMany({
        where: { id: earning.id, accruedAt: null },
        data: { accruedAt: now, recipientOrgId: args.recipientOrgId },
      });
      if (claimed.count !== 1) return false;
      await tx.publisherProfile.update({
        where: { orgId: args.recipientOrgId },
        data: {
          totalRevenueCents: { increment: earning.amountCents },
          pendingPayoutCents: { increment: earning.amountCents },
        },
      });
      return true;
    });
    if (credited) {
      result.accrued++;
      result.amountCents += earning.amountCents;
    }
  }
  return result;
}
