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
 * paid exactly when, and as often as, the revenue row settles.
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
    }): Promise<Array<{ id: string; userId: string; revenueShareBps: number }>>;
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
    create(args: { data: { orgId: string; displayName: string; slug: string } }): Promise<unknown>;
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
        recipientOrgId: string;
        publisherId: string;
        shareBps: number;
        amountCents: bigint;
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
}

/**
 * Pay contributors their shares of `creatorCents` and return what the
 * publisher keeps. The caller credits the publisher with `publisherCents`.
 */
export async function splitCreatorRevenue(
  tx: Partial<ContributorSplitTx>,
  args: { revenueId: string; listingId: string; publisherId: string; creatorCents: bigint },
): Promise<SplitResult> {
  const none: SplitResult = { publisherCents: args.creatorCents, paid: [] };
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
  // recipient is the publisher itself (or who owns no organization) is
  // simply kept by the publisher.
  const recipients: Array<{ contributor: (typeof contributors)[number]; org: { id: string; name: string } }> = [];
  for (const contributor of contributors) {
    const org = await tx.organization.findFirst({
      where: { ownerId: contributor.userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    });
    if (org && org.id !== args.publisherId) recipients.push({ contributor, org });
  }
  if (recipients.length === 0) return none;

  const { amounts, publisherCents } = computeContributorSplit(
    args.creatorCents,
    recipients.map((r) => r.contributor.revenueShareBps),
  );

  const paid: SplitResult["paid"] = [];
  for (const [i, { contributor, org }] of recipients.entries()) {
    const amountCents = amounts[i] ?? 0n;
    if (amountCents <= 0n) continue;

    const profile = await tx.publisherProfile.findUnique({ where: { orgId: org.id }, select: { orgId: true } });
    if (!profile) {
      await tx.publisherProfile.create({
        data: { orgId: org.id, displayName: org.name, slug: `org-${org.id}` },
      });
    }
    await tx.publisherProfile.update({
      where: { orgId: org.id },
      data: { totalRevenueCents: { increment: amountCents }, pendingPayoutCents: { increment: amountCents } },
    });
    await tx.contributorEarning.create({
      data: {
        revenueId: args.revenueId,
        agentId: listing.agentId,
        contributorId: contributor.id,
        userId: contributor.userId,
        recipientOrgId: org.id,
        publisherId: args.publisherId,
        shareBps: contributor.revenueShareBps,
        amountCents,
      },
    });
    paid.push({ userId: contributor.userId, recipientOrgId: org.id, amountCents });
  }

  // Shares that rounded to zero stay with the publisher.
  const paidTotal = paid.reduce((sum, p) => sum + p.amountCents, 0n);
  return { publisherCents: args.creatorCents - paidTotal, paid };
}
