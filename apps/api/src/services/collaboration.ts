import { prisma } from "@wheelsai/db";

export async function listContributors(agentId: string) {
  return prisma.agentContributor.findMany({
    where: { agentId },
    include: {
      user: { select: { id: true, email: true, displayName: true, walletAddress: true } },
    },
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
  // Validate total revenue share
  const existing = await prisma.agentContributor.findMany({
    where: { agentId },
    select: { revenueShare: true },
  });

  const totalExisting = existing.reduce((sum, c) => sum + c.revenueShare, 0);
  if (totalExisting + revenueShare > 1.0) {
    throw new Error(
      `Total revenue share would exceed 100%. Current: ${(totalExisting * 100).toFixed(1)}%, adding: ${(revenueShare * 100).toFixed(1)}%`
    );
  }

  return prisma.agentContributor.create({
    data: {
      agentId,
      userId,
      role,
      revenueShare,
      addedBy,
    },
    include: {
      user: { select: { id: true, email: true, displayName: true, walletAddress: true } },
    },
  });
}

export async function updateContributor(
  contributorId: string,
  agentId: string,
  updates: { role?: string; revenueShare?: number }
) {
  if (updates.revenueShare !== undefined) {
    const existing = await prisma.agentContributor.findMany({
      where: { agentId, id: { not: contributorId } },
      select: { revenueShare: true },
    });

    const totalOthers = existing.reduce((sum, c) => sum + c.revenueShare, 0);
    if (totalOthers + updates.revenueShare > 1.0) {
      throw new Error(
        `Total revenue share would exceed 100%. Others: ${(totalOthers * 100).toFixed(1)}%, setting: ${(updates.revenueShare * 100).toFixed(1)}%`
      );
    }
  }

  return prisma.agentContributor.update({
    where: { id: contributorId },
    data: updates,
    include: {
      user: { select: { id: true, email: true, displayName: true, walletAddress: true } },
    },
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
