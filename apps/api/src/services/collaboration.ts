import { prisma } from "@wheelsai/db";

import {
  fractionToBps,
  bpsToFraction,
  BPS_DENOMINATOR,
} from "../lib/tokenUnits.js";

const USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  walletAddress: true,
} as const;

export async function listContributors(agentId: string) {
  const contributors = await prisma.agentContributor.findMany({
    where: { agentId },
    include: { user: { select: USER_SELECT } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });
  const earned = await earnedByContributor(contributors.map((c) => c.id));
  return contributors.map((c) => ({ ...c, earnedCents: earned.get(c.id) ?? 0 }));
}

async function earnedByContributor(contributorIds: string[]): Promise<Map<string, number>> {
  if (contributorIds.length === 0) return new Map();
  const sums = await prisma.contributorEarning.groupBy({
    by: ["contributorId"],
    where: { contributorId: { in: contributorIds } },
    _sum: { amountCents: true },
  });
  return new Map(sums.map((row) => [row.contributorId, Number(row._sum.amountCents ?? 0n)]));
}

/** Resolve an invitee by account email (case-insensitive). */
export async function findUserIdByEmail(email: string): Promise<string | null> {
  const user = await prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    select: { id: true },
  });
  return user?.id ?? null;
}

/**
 * The signed-in user's contributions across every agent: pending
 * invitations to accept or decline, and accepted shares with what they
 * have earned so far.
 */
export async function listMyContributions(userId: string) {
  const rows = await prisma.agentContributor.findMany({
    where: { userId },
    include: { agent: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: "desc" },
  });
  const earned = await earnedByContributor(rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    agentName: r.agent.name,
    role: r.role,
    revenueShareBps: r.revenueShareBps,
    acceptedAt: r.acceptedAt,
    createdAt: r.createdAt,
    earnedCents: earned.get(r.id) ?? 0,
  }));
}

/** An invitee turns down a pending invitation. */
export async function declineInvitation(contributorId: string, userId: string) {
  const deleted = await prisma.agentContributor.deleteMany({
    where: { id: contributorId, userId, acceptedAt: null },
  });
  if (deleted.count === 0) throw new Error("No pending invitation to decline");
  return { success: true };
}

export async function addContributor(
  agentId: string,
  userId: string,
  role: string,
  revenueShare: number,
  addedBy: string
) {
  // Validate the total revenue share in integer basis points (D9). The
  // old Float sum could reject a legitimate split — 0.1 + 0.2 + 0.7 sums
  // to 1.0000000000000002 > 1.0 in IEEE-754; 1000 + 2000 + 7000 = 10000
  // is exact.
  const shareBps = fractionToBps(revenueShare);
  const existing = await prisma.agentContributor.findMany({
    where: { agentId },
    select: { revenueShareBps: true },
  });

  const totalExistingBps = existing.reduce(
    (sum, c) => sum + c.revenueShareBps,
    0,
  );
  if (totalExistingBps + shareBps > BPS_DENOMINATOR) {
    throw new Error(
      `Total revenue share would exceed 100%. Current: ${(totalExistingBps / 100).toFixed(1)}%, adding: ${(shareBps / 100).toFixed(1)}%`
    );
  }

  return prisma.agentContributor.create({
    data: {
      agentId,
      userId,
      role,
      addedBy,
      revenueShareBps: shareBps,
      // Float mirror, derived from the bps source of truth (display only).
      revenueShare: bpsToFraction(shareBps),
    },
    include: { user: { select: USER_SELECT } },
  });
}

export async function updateContributor(
  contributorId: string,
  agentId: string,
  updates: { role?: string; revenueShare?: number }
) {
  const data: { role?: string; revenueShareBps?: number; revenueShare?: number } =
    {};
  if (updates.role !== undefined) data.role = updates.role;

  if (updates.revenueShare !== undefined) {
    const shareBps = fractionToBps(updates.revenueShare);
    const existing = await prisma.agentContributor.findMany({
      where: { agentId, id: { not: contributorId } },
      select: { revenueShareBps: true },
    });

    const totalOthersBps = existing.reduce(
      (sum, c) => sum + c.revenueShareBps,
      0,
    );
    if (totalOthersBps + shareBps > BPS_DENOMINATOR) {
      throw new Error(
        `Total revenue share would exceed 100%. Others: ${(totalOthersBps / 100).toFixed(1)}%, setting: ${(shareBps / 100).toFixed(1)}%`
      );
    }

    data.revenueShareBps = shareBps;
    data.revenueShare = bpsToFraction(shareBps);
  }

  // Constrain to the agent the ROUTE verified. The route checks the agent
  // belongs to the caller's org, but the contributor row was resolved by
  // bare id — so a caller could pass a contributorId from another org's
  // agent and rewrite its revenue split.
  const updated = await prisma.agentContributor.updateMany({
    where: { id: contributorId, agentId },
    data,
  });
  if (updated.count === 0) {
    throw new Error("Contributor not found for this agent");
  }
  return prisma.agentContributor.findFirstOrThrow({
    where: { id: contributorId, agentId },
    include: { user: { select: USER_SELECT } },
  });
}

export async function removeContributor(contributorId: string, agentId: string) {
  const deleted = await prisma.agentContributor.deleteMany({
    where: { id: contributorId, agentId },
  });
  if (deleted.count === 0) {
    throw new Error("Contributor not found for this agent");
  }
  return { success: true };
}

export async function acceptInvitation(contributorId: string, userId: string) {
  const contributor = await prisma.agentContributor.findUnique({
    where: { id: contributorId },
  });

  if (!contributor) throw new Error("Invitation not found");
  if (contributor.userId !== userId) throw new Error("Not your invitation");
  if (contributor.acceptedAt) throw new Error("Already accepted");

  return prisma.agentContributor.update({
    where: { id: contributorId },
    data: { acceptedAt: new Date() },
  });
}
