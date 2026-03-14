import { FastifyPluginAsync } from "fastify";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";
import { hashPassword, verifyPassword } from "../services/auth.js";

interface UpdateProfileBody {
  displayName?: string;
  email?: string;
}

interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

interface UpdateSettingsBody {
  notifications?: {
    deploymentStatus?: boolean;
    usageAlerts?: boolean;
    billing?: boolean;
    productUpdates?: boolean;
  };
  preferences?: {
    theme?: "light" | "dark" | "system";
    timezone?: string;
  };
}

export const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  // Apply auth middleware to all settings routes
  fastify.addHook("preHandler", requireAuth);

  // Get user profile
  fastify.get("/profile", async (request) => {
    const { userId } = request.user!;

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new Error("User not found");
    }

    return {
      profile: {
        id: user.id,
        email: user.email || "",
        displayName: user.displayName,
        walletAddress: user.walletAddress,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt.toISOString(),
      },
    };
  });

  // Update user profile
  fastify.patch<{ Body: UpdateProfileBody }>("/profile", async (request, reply) => {
    const { userId } = request.user!;
    const { displayName, email } = request.body;

    // Check if email is already taken
    if (email) {
      const existingUser = await prisma.user.findFirst({
        where: {
          email,
          id: { not: userId },
        },
      });

      if (existingUser) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Email is already in use",
        });
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(displayName !== undefined && { displayName }),
        ...(email !== undefined && { email, emailVerified: false }),
      },
    });

    return {
      profile: {
        id: updatedUser.id,
        email: updatedUser.email || "",
        displayName: updatedUser.displayName,
        walletAddress: updatedUser.walletAddress,
        emailVerified: updatedUser.emailVerified,
        createdAt: updatedUser.createdAt.toISOString(),
      },
    };
  });

  // Get user settings
  fastify.get("/", async (request) => {
    const { userId } = request.user!;

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    // Default settings (stored in user.metadata in production)
    const settings = (user?.metadata as any)?.settings || {
      notifications: {
        deploymentStatus: true,
        usageAlerts: true,
        billing: true,
        productUpdates: false,
      },
      preferences: {
        theme: "system",
        timezone: "UTC",
      },
    };

    return { settings };
  });

  // Update user settings
  fastify.patch<{ Body: UpdateSettingsBody }>("/", async (request) => {
    const { userId } = request.user!;
    const updates = request.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    const currentSettings = (user?.metadata as any)?.settings || {
      notifications: {
        deploymentStatus: true,
        usageAlerts: true,
        billing: true,
        productUpdates: false,
      },
      preferences: {
        theme: "system",
        timezone: "UTC",
      },
    };

    const newSettings = {
      notifications: {
        ...currentSettings.notifications,
        ...updates.notifications,
      },
      preferences: {
        ...currentSettings.preferences,
        ...updates.preferences,
      },
    };

    await prisma.user.update({
      where: { id: userId },
      data: {
        metadata: {
          ...((user?.metadata as any) || {}),
          settings: newSettings,
        },
      },
    });

    return { settings: newSettings };
  });

  // Change password
  fastify.post<{ Body: ChangePasswordBody }>("/password", async (request, reply) => {
    const { userId } = request.user!;
    const { currentPassword, newPassword } = request.body;

    if (!newPassword || newPassword.length < 8) {
      return reply.status(400).send({
        error: "Bad Request",
        message: "New password must be at least 8 characters",
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.passwordHash) {
      return reply.status(400).send({
        error: "Bad Request",
        message: "Password authentication not available for this account",
      });
    }

    const isValid = await verifyPassword(user.passwordHash, currentPassword);
    if (!isValid) {
      return reply.status(400).send({
        error: "Bad Request",
        message: "Current password is incorrect",
      });
    }

    const newPasswordHash = await hashPassword(newPassword);

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash },
    });

    return { message: "Password updated successfully" };
  });

  // Link Solana wallet
  fastify.post<{
    Body: { walletAddress: string; signature: string; message: string };
  }>("/link-wallet", async (request, reply) => {
    const { userId } = request.user!;
    const { walletAddress, signature, message } = request.body;

    if (!walletAddress || !signature || !message) {
      return reply.status(400).send({
        error: "Bad Request",
        message: "walletAddress, signature, and message are required",
      });
    }

    // Verify the wallet address is a valid Solana public key
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(walletAddress);
    } catch {
      return reply.status(400).send({
        error: "Bad Request",
        message: "Invalid Solana wallet address",
      });
    }

    // Verify ed25519 signature
    let isValid = false;
    try {
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = Buffer.from(signature, "base64");
      isValid = nacl.sign.detached.verify(
        messageBytes,
        signatureBytes,
        pubkey.toBytes()
      );
    } catch {
      return reply.status(400).send({
        error: "Bad Request",
        message: "Invalid wallet signature",
      });
    }

    if (!isValid) {
      return reply.status(400).send({
        error: "Bad Request",
        message: "Invalid wallet signature",
      });
    }

    // Check if another user already has this wallet linked
    const existing = await prisma.user.findFirst({
      where: {
        walletAddress,
        id: { not: userId },
      },
    });

    if (existing) {
      return reply.status(409).send({
        error: "Conflict",
        message: "This wallet is already linked to another account",
      });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { walletAddress },
    });

    return {
      walletAddress,
      message: "Wallet linked successfully",
    };
  });
};
