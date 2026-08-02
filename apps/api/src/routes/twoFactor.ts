import { FastifyInstance } from "fastify";
import { requireJwtAuth } from "../middleware/auth.js";
import {
  setup2FA,
  verify2FASetup,
  disable2FA,
  regenerateBackupCodes,
  get2FAStatus,
  setRecoveryEmail,
} from "../services/twoFactor.js";

// ============================================
// Two-Factor Authentication Routes
// ============================================

export async function twoFactorRoutes(app: FastifyInstance) {
  // ============================================
  // Authenticated routes (user managing their 2FA)
  // ============================================

  // Get 2FA status
  app.get("/status", { preHandler: requireJwtAuth }, async (request, reply) => {
    try {
      const status = await get2FAStatus(request.auth!.userId!);
      return reply.send(status);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Setup 2FA (generates secret + QR code)
  app.post("/setup", { preHandler: requireJwtAuth }, async (request, reply) => {
    try {
      const result = await setup2FA(request.auth!.userId!);
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Verify setup (user enters first TOTP code to confirm)
  app.post<{ Body: { token: string } }>("/verify-setup", { preHandler: requireJwtAuth }, async (request, reply) => {
    try {
      const result = await verify2FASetup(request.auth!.userId!, request.body.token);
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Disable 2FA
  app.post<{ Body: { token: string } }>("/disable", { preHandler: requireJwtAuth }, async (request, reply) => {
    try {
      const result = await disable2FA(request.auth!.userId!, request.body.token);
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Regenerate backup codes
  app.post<{ Body: { token: string } }>(
    "/backup-codes/regenerate",
    { preHandler: requireJwtAuth },
    async (request, reply) => {
      try {
        const result = await regenerateBackupCodes(request.auth!.userId!, request.body.token);
        return reply.send(result);
      } catch (error: any) {
        return reply.status(400).send({ error: error.message });
      }
    }
  );

  // Set recovery email
  app.post<{ Body: { email: string } }>(
    "/recovery-email",
    { preHandler: requireJwtAuth },
    async (request, reply) => {
      try {
        const result = await setRecoveryEmail(request.auth!.userId!, request.body.email);
        return reply.send(result);
      } catch (error: any) {
        return reply.status(400).send({ error: error.message });
      }
    }
  );

  // ============================================
  // Public routes (login flow)
  // ============================================

  // The public POST /challenge and /challenge/verify routes that used to
  // live here are GONE (B5):
  //
  //   - /challenge accepted a raw userId from anyone and answered
  //     `{required: true|false}` — an unauthenticated oracle for "does
  //     this user id exist and have 2FA on", plus a way to mint
  //     challenge rows for other people at will.
  //   - /challenge/verify consumed a challenge but issued no session, so
  //     it could only ever burn a legitimate user's challenge.
  //
  // Challenges are now minted by POST /api/auth/login (and the wallet
  // login) only after the first factor passes, and redeemed for a real
  // session by POST /api/auth/login/2fa.
}
