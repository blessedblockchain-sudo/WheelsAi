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
  return prisma.agentContributor.findMany({
    where: { agentId },
    include: { user: { select: USER_SELECT } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });
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

  return prisma.agentContributor.update({
    where: { id: contributorId },
    data,
    include: { user: { select: USER_SELECT } },
  });
}

export async function removeContributor(contributorId: string) {
  return prisma.agentContributor.delete({ where: { id: contributorId } });
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
