import { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import {
  setup2FA,
  verify2FASetup,
  verify2FA,
  disable2FA,
  regenerateBackupCodes,
  get2FAStatus,
  setRecoveryEmail,
  createChallenge,
  validateChallenge,
} from "../services/twoFactor.js";

// ============================================
// Two-Factor Authentication Routes
// ============================================

export async function twoFactorRoutes(app: FastifyInstance) {
  // ============================================
  // Authenticated routes (user managing their 2FA)
  // ============================================

  // Get 2FA status
  app.get("/status", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const status = await get2FAStatus(request.auth!.userId);
      return reply.send(status);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Setup 2FA (generates secret + QR code)
  app.post("/setup", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const result = await setup2FA(request.auth!.userId);
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Verify setup (user enters first TOTP code to confirm)
  app.post<{ Body: { token: string } }>("/verify-setup", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const result = await verify2FASetup(request.auth!.userId, request.body.token);
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Disable 2FA
  app.post<{ Body: { token: string } }>("/disable", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const result = await disable2FA(request.auth!.userId, request.body.token);
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Regenerate backup codes
  app.post<{ Body: { token: string } }>(
    "/backup-codes/regenerate",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const result = await regenerateBackupCodes(request.auth!.userId, request.body.token);
        return reply.send(result);
      } catch (error: any) {
        return reply.status(400).send({ error: error.message });
      }
    }
  );

  // Set recovery email
  app.post<{ Body: { email: string } }>(
    "/recovery-email",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const result = await setRecoveryEmail(request.auth!.userId, request.body.email);
        return reply.send(result);
      } catch (error: any) {
        return reply.status(400).send({ error: error.message });
      }
    }
  );

  // ============================================
  // Public routes (login flow)
  // ============================================

  // Create a 2FA challenge (called during login when 2FA is required)
  app.post<{ Body: { userId: string } }>("/challenge", async (request, reply) => {
    try {
      const result = await createChallenge(request.body.userId);
      if (!result) {
        return reply.send({ required: false });
      }
      return reply.send({ required: true, ...result });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Validate a 2FA challenge (user submits TOTP code)
  app.post<{ Body: { challengeToken: string; token: string } }>("/challenge/verify", async (request, reply) => {
    try {
      const result = await validateChallenge(request.body.challengeToken, request.body.token);
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });
}
