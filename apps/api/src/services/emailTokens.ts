/**
 * One-time email links: verify an address, reset a password.
 *
 * Only sha256(token) is stored; the token lives in the email alone. Each
 * token is single-use (compare-and-swap on usedAt), expires, and is pinned
 * to the address it was sent to, so a verification link dies if the
 * account's email changes. Issuing a new token of the same purpose retires
 * the older unused ones.
 *
 * Verifying the owner's email is what grants an organization's signup
 * bonus: exactly once per org, guarded by a compare-and-swap on
 * Organization.signupBonusGrantedAt, with its own ledger row. Signups used
 * to receive $5 immediately, with no verification, which made the credits
 * farmable with throwaway accounts.
 */
import { createHash, randomBytes } from "node:crypto";

export type EmailTokenPurpose = "verify_email" | "reset_password";

export const TOKEN_TTL_MS: Record<EmailTokenPurpose, number> = {
  verify_email: 24 * 60 * 60 * 1000,
  reset_password: 30 * 60 * 1000,
};

export const SIGNUP_BONUS_CENTS = 500n;

export function hashEmailToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newEmailToken(): string {
  return randomBytes(32).toString("base64url");
}

export class InvalidEmailTokenError extends Error {
  readonly code = "invalid_or_expired_token";
  constructor() {
    super("This link is invalid or has expired. Request a new one.");
    this.name = "InvalidEmailTokenError";
  }
}

interface TokenRow {
  id: string;
  userId: string;
  purpose: string;
  email: string;
  expiresAt: Date;
  usedAt: Date | null;
}

/** Structural Prisma surface (tests pass fakes). */
export interface EmailTokenDb {
  emailToken: {
    create(args: {
      data: { userId: string; purpose: string; email: string; tokenHash: string; expiresAt: Date };
    }): Promise<unknown>;
    updateMany(args: {
      where: { id?: string; userId?: string; purpose?: string; usedAt: null };
      data: { usedAt: Date };
    }): Promise<{ count: number }>;
    findUnique(args: { where: { tokenHash: string } }): Promise<TokenRow | null>;
  };
  user: {
    findUnique(args: { where: { id: string } }): Promise<{ id: string; email: string | null } | null>;
    update(args: {
      where: { id: string };
      data: { emailVerified?: boolean; passwordHash?: string };
    }): Promise<unknown>;
  };
  organization: {
    findFirst(args: {
      where: { ownerId: string };
      orderBy: { createdAt: "asc" };
    }): Promise<{ id: string } | null>;
    updateMany(args: {
      where: { id: string; signupBonusGrantedAt: null };
      data: { signupBonusGrantedAt: Date };
    }): Promise<{ count: number }>;
  };
  creditBalance: {
    upsert(args: {
      where: { orgId: string };
      update: { balanceCents: { increment: bigint } };
      create: { orgId: string; balanceCents: bigint };
    }): Promise<{ balanceCents: bigint }>;
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
}

export async function issueEmailToken(
  db: Pick<EmailTokenDb, "emailToken">,
  args: { userId: string; email: string; purpose: EmailTokenPurpose; now?: Date },
): Promise<string> {
  const now = args.now ?? new Date();
  await db.emailToken.updateMany({
    where: { userId: args.userId, purpose: args.purpose, usedAt: null },
    data: { usedAt: now },
  });
  const token = newEmailToken();
  await db.emailToken.create({
    data: {
      userId: args.userId,
      purpose: args.purpose,
      email: args.email,
      tokenHash: hashEmailToken(token),
      expiresAt: new Date(now.getTime() + TOKEN_TTL_MS[args.purpose]),
    },
  });
  return token;
}

/** Single-use claim. Run inside the caller's transaction. */
async function consume(
  db: EmailTokenDb,
  token: string,
  purpose: EmailTokenPurpose,
  now: Date,
): Promise<TokenRow & { currentEmail: string }> {
  const row = await db.emailToken.findUnique({ where: { tokenHash: hashEmailToken(token) } });
  if (!row || row.purpose !== purpose || row.usedAt !== null || row.expiresAt <= now) {
    throw new InvalidEmailTokenError();
  }
  const claimed = await db.emailToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) throw new InvalidEmailTokenError();
  const user = await db.user.findUnique({ where: { id: row.userId } });
  // The address changed since the link was sent: the link is for the old one.
  if (!user || !user.email || user.email.toLowerCase() !== row.email.toLowerCase()) {
    throw new InvalidEmailTokenError();
  }
  return { ...row, currentEmail: user.email };
}

export async function confirmEmailVerification(
  db: EmailTokenDb,
  args: { token: string; now?: Date },
): Promise<{ userId: string; bonusGrantedCents: bigint }> {
  const now = args.now ?? new Date();
  const row = await consume(db, args.token, "verify_email", now);
  await db.user.update({ where: { id: row.userId }, data: { emailVerified: true } });

  const org = await db.organization.findFirst({
    where: { ownerId: row.userId },
    orderBy: { createdAt: "asc" },
  });
  if (!org) return { userId: row.userId, bonusGrantedCents: 0n };

  const won = await db.organization.updateMany({
    where: { id: org.id, signupBonusGrantedAt: null },
    data: { signupBonusGrantedAt: now },
  });
  if (won.count !== 1) return { userId: row.userId, bonusGrantedCents: 0n };

  const after = await db.creditBalance.upsert({
    where: { orgId: org.id },
    update: { balanceCents: { increment: SIGNUP_BONUS_CENTS } },
    create: { orgId: org.id, balanceCents: SIGNUP_BONUS_CENTS },
  });
  await db.creditTransaction.create({
    data: {
      orgId: org.id,
      amountCents: SIGNUP_BONUS_CENTS,
      type: "bonus",
      description: "Signup bonus (email verified)",
      referenceId: `signup-bonus:${org.id}`,
      balanceAfter: after.balanceCents,
    },
  });
  return { userId: row.userId, bonusGrantedCents: SIGNUP_BONUS_CENTS };
}

export async function resetPasswordWithToken(
  db: EmailTokenDb,
  args: { token: string; passwordHash: string; now?: Date },
): Promise<{ userId: string; email: string }> {
  const now = args.now ?? new Date();
  const row = await consume(db, args.token, "reset_password", now);
  await db.user.update({ where: { id: row.userId }, data: { passwordHash: args.passwordHash } });
  // Retire any other outstanding reset links for this account.
  await db.emailToken.updateMany({
    where: { userId: row.userId, purpose: "reset_password", usedAt: null },
    data: { usedAt: now },
  });
  return { userId: row.userId, email: row.currentEmail };
}
