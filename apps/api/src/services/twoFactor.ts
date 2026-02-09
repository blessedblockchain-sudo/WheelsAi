import { prisma } from "@wheelsai/db";
import crypto from "crypto";

// ============================================
// TOTP Helpers
// ============================================

function generateSecret(): Buffer {
  return crypto.randomBytes(20);
}

function generateBackupCodes(count: number = 10): string[] {
  return Array.from({ length: count }, () =>
    crypto.randomBytes(4).toString("hex").toUpperCase()
  );
}

function base32Encode(buffer: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, "0");
  }
  let result = "";
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.substring(i, i + 5).padEnd(5, "0");
    result += alphabet[parseInt(chunk, 2)];
  }
  return result;
}

function generateTOTP(secret: Buffer, time?: number, digits: number = 6, period: number = 30): string {
  const counter = Math.floor((time || Date.now() / 1000) / period);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(0, 0);
  counterBuffer.writeUInt32BE(counter, 4);

  const hmac = crypto.createHmac("sha1", secret);
  hmac.update(counterBuffer);
  const hash = hmac.digest();

  const offset = hash[hash.length - 1]! & 0x0f;
  const code =
    ((hash[offset]! & 0x7f) << 24) |
    ((hash[offset + 1]! & 0xff) << 16) |
    ((hash[offset + 2]! & 0xff) << 8) |
    (hash[offset + 3]! & 0xff);

  return (code % Math.pow(10, digits)).toString().padStart(digits, "0");
}

function verifyTOTP(secret: Buffer, token: string, window: number = 1): boolean {
  const now = Math.floor(Date.now() / 1000);
  for (let i = -window; i <= window; i++) {
    const expected = generateTOTP(secret, now + i * 30);
    if (expected === token) return true;
  }
  return false;
}

// ============================================
// 2FA Setup
// ============================================

export async function setup2FA(userId: string) {
  // Check if already exists
  const existing = await prisma.twoFactorAuth.findUnique({ where: { userId } });
  if (existing?.isEnabled) {
    throw new Error("2FA is already enabled. Disable it first to reconfigure.");
  }

  const secret = generateSecret();
  const backupCodes = generateBackupCodes(10);
  const backupCodesBuffer = Buffer.from(JSON.stringify(backupCodes));

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found");

  const twoFactor = await prisma.twoFactorAuth.upsert({
    where: { userId },
    create: {
      userId,
      secret,
      backupCodes: backupCodesBuffer,
      backupCodesTotal: 10,
      isEnabled: false,
      isVerified: false,
    },
    update: {
      secret,
      backupCodes: backupCodesBuffer,
      backupCodesUsed: 0,
      backupCodesTotal: 10,
      isEnabled: false,
      isVerified: false,
    },
  });

  const base32Secret = base32Encode(secret);
  const issuer = "WheelsAI";
  const accountName = user.email || user.walletAddress || userId;
  const otpauthUrl = `otpauth://totp/${issuer}:${accountName}?secret=${base32Secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

  return {
    id: twoFactor.id,
    secret: base32Secret,
    otpauthUrl,
    qrCodeUrl: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(otpauthUrl)}`,
    backupCodes,
  };
}

export async function verify2FASetup(userId: string, token: string) {
  const twoFactor = await prisma.twoFactorAuth.findUnique({ where: { userId } });
  if (!twoFactor) throw new Error("2FA not set up. Call setup first.");
  if (twoFactor.isEnabled) throw new Error("2FA is already enabled.");

  const isValid = verifyTOTP(twoFactor.secret, token);
  if (!isValid) throw new Error("Invalid verification code. Please try again.");

  await prisma.twoFactorAuth.update({
    where: { userId },
    data: { isEnabled: true, isVerified: true, lastUsedAt: new Date(), lastMethod: "totp" },
  });

  return { success: true, message: "2FA enabled successfully" };
}

// ============================================
// 2FA Verification (Login)
// ============================================

export async function verify2FA(userId: string, token: string): Promise<{ valid: boolean; method: string }> {
  const twoFactor = await prisma.twoFactorAuth.findUnique({ where: { userId } });
  if (!twoFactor || !twoFactor.isEnabled) {
    return { valid: true, method: "none" }; // 2FA not enabled, skip
  }

  // Try TOTP first
  if (verifyTOTP(twoFactor.secret, token)) {
    await prisma.twoFactorAuth.update({
      where: { userId },
      data: { lastUsedAt: new Date(), lastMethod: "totp" },
    });
    return { valid: true, method: "totp" };
  }

  // Try backup code
  if (twoFactor.backupCodes) {
    const codes: string[] = JSON.parse(twoFactor.backupCodes.toString());
    const upperToken = token.toUpperCase();
    const codeIndex = codes.indexOf(upperToken);

    if (codeIndex !== -1) {
      codes.splice(codeIndex, 1);
      await prisma.twoFactorAuth.update({
        where: { userId },
        data: {
          backupCodes: Buffer.from(JSON.stringify(codes)),
          backupCodesUsed: { increment: 1 },
          lastUsedAt: new Date(),
          lastMethod: "backup_code",
        },
      });
      return { valid: true, method: "backup_code" };
    }
  }

  return { valid: false, method: "failed" };
}

// ============================================
// 2FA Management
// ============================================

export async function disable2FA(userId: string, token: string) {
  const result = await verify2FA(userId, token);
  if (!result.valid) throw new Error("Invalid verification code");

  await prisma.twoFactorAuth.delete({ where: { userId } });
  return { success: true, message: "2FA disabled successfully" };
}

export async function regenerateBackupCodes(userId: string, token: string) {
  const result = await verify2FA(userId, token);
  if (!result.valid) throw new Error("Invalid verification code");

  const newCodes = generateBackupCodes(10);
  await prisma.twoFactorAuth.update({
    where: { userId },
    data: {
      backupCodes: Buffer.from(JSON.stringify(newCodes)),
      backupCodesUsed: 0,
      backupCodesTotal: 10,
    },
  });

  return { backupCodes: newCodes };
}

export async function get2FAStatus(userId: string) {
  const twoFactor = await prisma.twoFactorAuth.findUnique({ where: { userId } });
  if (!twoFactor) {
    return { isEnabled: false, isVerified: false };
  }

  return {
    isEnabled: twoFactor.isEnabled,
    isVerified: twoFactor.isVerified,
    lastUsedAt: twoFactor.lastUsedAt,
    lastMethod: twoFactor.lastMethod,
    backupCodesRemaining: twoFactor.backupCodesTotal - twoFactor.backupCodesUsed,
    recoveryEmail: twoFactor.recoveryEmail,
  };
}

export async function setRecoveryEmail(userId: string, email: string) {
  const twoFactor = await prisma.twoFactorAuth.findUnique({ where: { userId } });
  if (!twoFactor) throw new Error("2FA not set up");

  await prisma.twoFactorAuth.update({
    where: { userId },
    data: { recoveryEmail: email },
  });

  return { success: true };
}

// ============================================
// 2FA Challenge (for login flow)
// ============================================

export async function createChallenge(userId: string) {
  const twoFactor = await prisma.twoFactorAuth.findUnique({ where: { userId } });
  if (!twoFactor || !twoFactor.isEnabled) {
    return null; // No 2FA needed
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  const challenge = await prisma.twoFactorChallenge.create({
    data: { userId, token, expiresAt },
  });

  return { challengeToken: challenge.token, expiresAt };
}

export async function validateChallenge(challengeToken: string, totpToken: string) {
  const challenge = await prisma.twoFactorChallenge.findUnique({
    where: { token: challengeToken },
  });

  if (!challenge) throw new Error("Invalid challenge");
  if (challenge.isUsed) throw new Error("Challenge already used");
  if (challenge.expiresAt < new Date()) throw new Error("Challenge expired");

  const result = await verify2FA(challenge.userId, totpToken);
  if (!result.valid) throw new Error("Invalid verification code");

  await prisma.twoFactorChallenge.update({
    where: { id: challenge.id },
    data: { isUsed: true },
  });

  return { userId: challenge.userId, valid: true };
}
