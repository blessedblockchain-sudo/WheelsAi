import { prisma } from "@wheelsai/db";
import { ensurePublisherProfile } from "./marketplace.js";
import { accruePendingContributorEarnings, type PendingAccrualTx } from "./contributorSplits.js";
import { createLogger } from "../utils/logger.js";

import {
  fractionToBps,
  bpsToFraction,
  BPS_DENOMINATOR,
} from "../lib/tokenUnits.js";

const logger = createLogger("collaboration-service");

// No wallet addresses: a contributor list must not map emails to wallets.
const USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
} as const;

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

/** The form an invited address is stored and matched in. */
export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A rejected invite. The message never depends on who the invitee is. */
export class ContributorInviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContributorInviteError";
  }
}

interface ContributorRow {
  id: string;
  agentId: string;
  role: string;
  revenueShare: number;
  revenueShareBps: number;
  invitedEmail: string | null;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  user: { id: string; email: string | null; displayName: string | null } | null;
}

/**
 * What an agent's owner sees of one contributor. Until the invitation is
 * accepted that is only the address it was sent to: no account, no
 * display name, no user id, so the list reads the same whether or not
 * the address belongs to an account.
 */
export function presentContributor(row: ContributorRow, earnedCents = 0) {
  const accepted = row.acceptedAt !== null;
  return {
    id: row.id,
    agentId: row.agentId,
    role: row.role,
    revenueShare: row.revenueShare,
    revenueShareBps: row.revenueShareBps,
    status: accepted ? ("accepted" as const) : ("pending" as const),
    invitedEmail: row.invitedEmail,
    acceptedAt: row.acceptedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    earnedCents: accepted ? earnedCents : 0,
    user: accepted ? row.user : null,
  };
}

export async function listContributors(agentId: string) {
  const contributors = await prisma.agentContributor.findMany({
    where: { agentId },
    include: { user: { select: USER_SELECT } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });
  const earned = await earnedByContributor(contributors.map((c) => c.id));
  return contributors.map((c) => presentContributor(c, earned.get(c.id) ?? 0));
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

/**
 * The address a user can claim email invitations with. Only a verified
 * address counts: otherwise registering someone else's email would be
 * enough to take the revenue share meant for them.
 */
async function claimableEmail(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  return user?.email && user.emailVerified ? normalizeInviteEmail(user.email) : null;
}

/** Rows that belong to this user: bound to them, or sent to their address and still unclaimed. */
function mineWhere(userId: string, email: string | null) {
  return email
    ? { OR: [{ userId }, { userId: null, invitedEmail: email, acceptedAt: null }] }
    : { userId };
}

/**
 * The first organization the user owns is where their shares are paid.
 * Makes sure it has a payout profile and credits anything recorded while
 * it had none. Runs outside every money transaction.
 */
export async function settleContributorPayouts(userId: string): Promise<void> {
  const org = await prisma.organization.findFirst({
    where: { ownerId: userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  if (!org) return;
  await ensurePublisherProfile(org.id, org.name);
  const result = await accruePendingContributorEarnings(
    {
      listPending: (uid) =>
        prisma.contributorEarning.findMany({
          where: { userId: uid, accruedAt: null },
          select: { id: true, amountCents: true },
          orderBy: { createdAt: "asc" },
          take: 500,
        }),
      inTransaction: (fn) => prisma.$transaction((tx) => fn(tx as unknown as PendingAccrualTx)),
    },
    { userId, recipientOrgId: org.id },
  );
  if (result.accrued > 0) {
    logger.info(
      { userId, orgId: org.id, accrued: result.accrued, amountCents: Number(result.amountCents) },
      "Accrued contributor shares that were recorded before the payout profile existed",
    );
  }
}

/**
 * The signed-in user's contributions across every agent: pending
 * invitations to accept or decline, and accepted shares with what they
 * have earned so far.
 */
export async function listMyContributions(userId: string) {
  const email = await claimableEmail(userId);
  const rows = await prisma.agentContributor.findMany({
    where: mineWhere(userId, email),
    include: { agent: { select: { id: true, name: true, slug: true } } },
    orderBy: { createdAt: "desc" },
  });
  // Contributors who accepted before acceptance created a payout profile
  // get one here, and whatever was recorded for them meanwhile is credited.
  if (rows.some((r) => r.acceptedAt !== null)) {
    await settleContributorPayouts(userId).catch((err) =>
      logger.error({ err, userId }, "Failed to settle contributor payouts"),
    );
  }
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
  const email = await claimableEmail(userId);
  const deleted = await prisma.agentContributor.deleteMany({
    where: { id: contributorId, acceptedAt: null, ...mineWhere(userId, email) },
  });
  if (deleted.count === 0) throw new Error("No pending invitation to decline");
  return { success: true };
}

/**
 * Invite a contributor by email (the dashboard) or by user id (API).
 *
 * An email is never resolved to an account here. The invitation is stored
 * under the address and bound to an account only when that account
 * accepts it, so every step (the duplicate check, the share check, the
 * row that appears in the list) is the same for an address with an
 * account and one without.
 */
export async function addContributor(
  agentId: string,
  invitee: { email: string } | { userId: string },
  role: string,
  revenueShare: number,
  addedBy: string
): Promise<{ created: boolean }> {
  const target =
    "email" in invitee
      ? { invitedEmail: normalizeInviteEmail(invitee.email) }
      : { userId: invitee.userId };

  // Inviting the same address (or user) again changes nothing and answers
  // the same as the first time.
  const duplicate = await prisma.agentContributor.findFirst({
    where: { agentId, ...target },
    select: { id: true },
  });
  if (duplicate) return { created: false };

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
    throw new ContributorInviteError(
      `Total revenue share would exceed 100%. Current: ${(totalExistingBps / 100).toFixed(1)}%, adding: ${(shareBps / 100).toFixed(1)}%`
    );
  }

  try {
    await prisma.agentContributor.create({
      data: {
        agentId,
        ...target,
        role,
        addedBy,
        revenueShareBps: shareBps,
        // Float mirror, derived from the bps source of truth (display only).
        revenueShare: bpsToFraction(shareBps),
      },
    });
  } catch (err) {
    // A concurrent identical invite won the unique constraint.
    if (isUniqueViolation(err)) return { created: false };
    // Only reachable by user id: the id names no account.
    if ((err as { code?: string }).code === "P2003") {
      throw new ContributorInviteError("No user with that id");
    }
    throw err;
  }
  return { created: true };
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
  const row = await prisma.agentContributor.findFirstOrThrow({
    where: { id: contributorId, agentId },
    include: { user: { select: USER_SELECT } },
  });
  return presentContributor(row);
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
  if (contributor.userId) {
    if (contributor.userId !== userId) throw new Error("Not your invitation");
  } else {
    // Sent to an address: it belongs to the account that has verified it.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerified: true },
    });
    const sentToMe =
      !!user?.email &&
      !!contributor.invitedEmail &&
      normalizeInviteEmail(user.email) === contributor.invitedEmail;
    if (!sentToMe) throw new Error("Not your invitation");
    if (!user.emailVerified) {
      throw new Error("Verify your email address to accept this invitation");
    }
  }
  if (contributor.acceptedAt) throw new Error("Already accepted");

  // Shares are paid into the organization the contributor owns. Its
  // publisher profile (the payout balance) is created now, outside any
  // money transaction, so settlement only ever updates it.
  const org = await prisma.organization.findFirst({
    where: { ownerId: userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  if (org) await ensurePublisherProfile(org.id, org.name);

  // Compare-and-swap on the pending row, binding it to this account. Not
  // inside a transaction, so the unique (agentId, userId) can be answered
  // cleanly: this account already holds a share on the agent.
  let accepted: { count: number };
  try {
    accepted = await prisma.agentContributor.updateMany({
      where: { id: contributorId, acceptedAt: null, userId: contributor.userId },
      data: { acceptedAt: new Date(), userId },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new Error("You are already a contributor to this agent");
    throw err;
  }
  if (accepted.count !== 1) throw new Error("Already accepted");

  return prisma.agentContributor.findUniqueOrThrow({ where: { id: contributorId } });
}
