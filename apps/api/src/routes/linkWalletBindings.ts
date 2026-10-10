/**
 * Binds the link-wallet routes (routes/linkWallet.ts) to Prisma and to the
 * nonce and signature helpers of services/auth.ts.
 */

import { prisma } from "../lib/prisma.js";
import {
  claimNonce,
  findUserById,
  generateNonce,
  verifySolanaSignature,
} from "../services/auth.js";
import type { LinkWalletDeps } from "./linkWallet.js";

/** The slice of Prisma the link itself needs, so a test can stand in for it. */
export interface LinkWalletDb {
  user: {
    findFirst(args: {
      where: { walletAddress: string; id: { not: string } };
      select: { id: true };
    }): Promise<{ id: string } | null>;
    update(args: { where: { id: string }; data: { walletAddress: string } }): Promise<unknown>;
  };
}

function prismaCode(err: unknown): string | null {
  return (err as { code?: string } | null)?.code ?? null;
}

export function makeLinkWallet(db: LinkWalletDb): LinkWalletDeps["linkWallet"] {
  return async ({ userId, walletAddress }) => {
    const other = await db.user.findFirst({
      where: { walletAddress, id: { not: userId } },
      select: { id: true },
    });
    if (other) return "in_use";

    try {
      await db.user.update({ where: { id: userId }, data: { walletAddress } });
    } catch (err) {
      // users.wallet_address is unique: another account took the wallet
      // between the read and the write.
      if (prismaCode(err) === "P2002") return "in_use";
      if (prismaCode(err) === "P2025") return "user_missing";
      throw err;
    }
    return "linked";
  };
}

/** What the session claims are read from: the user and their memberships as they are now. */
export interface LinkWalletSessionUser {
  id: string;
  email: string | null;
  walletAddress: string | null;
  memberships: Array<{ role: string; org: { id: string } }>;
}

/**
 * The claims for the new session token, as POST /api/auth/refresh builds
 * them: from the stored user, never from the old token, so the wallet just
 * linked is on it. Null when the user is gone or has left the organization.
 */
export function makeLoadSession(
  findUser: (userId: string) => Promise<LinkWalletSessionUser | null>,
): LinkWalletDeps["loadSession"] {
  return async ({ userId, orgId }) => {
    const user = await findUser(userId);
    const membership = user?.memberships.find((m) => m.org.id === orgId);
    if (!user || !membership) return null;
    return {
      userId: user.id,
      orgId: membership.org.id,
      email: user.email ?? undefined,
      walletAddress: user.walletAddress ?? undefined,
      role: membership.role,
    };
  };
}

export function buildLinkWalletDeps(): LinkWalletDeps {
  return {
    generateNonce,
    claimNonce,
    verifySignature: verifySolanaSignature,
    linkWallet: makeLinkWallet(prisma as unknown as LinkWalletDb),
    loadSession: makeLoadSession(findUserById),
  };
}
