import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { brandingSchema } from "@wheelsai/types";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";
import { hashPassword, verifyPassword } from "../services/auth.js";
import { sendVerificationEmail } from "./emailAuth.js";
import { createLinkWalletRoutes } from "./linkWallet.js";
import { buildLinkWalletDeps } from "./linkWalletBindings.js";

const updateProfileSchema = z.object({
  displayName: z.string().max(100).optional(),
  email: z.string().email().optional(),
  // Required to change the email of an account that has a password: a
  // hijacked session must not be able to take over the account's
  // recovery address.
  currentPassword: z.string().min(1).optional(),
}).strict();

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

const updateSettingsSchema = z.object({
  notifications: z.object({
    deploymentStatus: z.boolean().optional(),
    usageAlerts: z.boolean().optional(),
    billing: z.boolean().optional(),
    productUpdates: z.boolean().optional(),
  }).optional(),
  preferences: z.object({
    theme: z.enum(["light", "dark", "system"]).optional(),
    timezone: z.string().max(50).optional(),
  }).optional(),
}).strict();

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
  fastify.patch("/profile", async (request, reply) => {
    const { userId } = request.user!;
    const { displayName, email: requestedEmail, currentPassword } = updateProfileSchema.parse(request.body);

    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, passwordHash: true },
    });
    // Re-submitting the current address is not a change.
    const email =
      requestedEmail && requestedEmail.toLowerCase() !== current?.email?.toLowerCase()
        ? requestedEmail
        : undefined;

    if (email && current?.passwordHash) {
      if (!currentPassword || !(await verifyPassword(current.passwordHash, currentPassword))) {
        return reply.status(403).send({
          error: "reauthentication_required",
          message: "Enter your current password to change your email.",
        });
      }
    }

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

    // A new address is unverified until its link is used.
    const verificationSent =
      email && updatedUser.email
        ? await sendVerificationEmail({ id: updatedUser.id, email: updatedUser.email })
        : false;

    return {
      profile: {
        id: updatedUser.id,
        email: updatedUser.email || "",
        displayName: updatedUser.displayName,
        walletAddress: updatedUser.walletAddress,
        emailVerified: updatedUser.emailVerified,
        createdAt: updatedUser.createdAt.toISOString(),
      },
      verificationSent,
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
  fastify.patch("/", async (request) => {
    const { userId } = request.user!;
    const updates = updateSettingsSchema.parse(request.body);

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
  fastify.post("/password", async (request, reply) => {
    const { userId } = request.user!;
    const { currentPassword, newPassword } = changePasswordSchema.parse(request.body);

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

  // Wallet linking: POST /link-wallet/nonce and POST /link-wallet
  // (routes/linkWallet.ts). Registered here so the paths stay under
  // /api/settings and the auth hook above covers them.
  await fastify.register(createLinkWalletRoutes(buildLinkWalletDeps()));

  // ============================================
  // Branding / White-label
  // ============================================

  fastify.get(
    "/branding",
    { preHandler: [requireAuth] },
    async (request) => {
      const orgId = request.auth!.orgId;
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
      });
      return { branding: (org as any)?.branding ?? {} };
    }
  );

  fastify.put(
    "/branding",
    { preHandler: [requireAuth] },
    async (request) => {
      const orgId = request.auth!.orgId;
      const branding = brandingSchema.parse(request.body);

      await prisma.organization.update({
        where: { id: orgId },
        data: { branding: branding as any },
      });

      return { branding, message: "Branding updated" };
    }
  );
};
