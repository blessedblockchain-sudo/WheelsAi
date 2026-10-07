/**
 * Email verification and password reset (mounted under /api/auth).
 *
 *   POST /email/verify/request   signed-in user: (re)send the verification link
 *   POST /email/verify/confirm   { token }: verify, grant the signup bonus once
 *   POST /password/forgot        { email }: send a reset link if the account exists
 *   POST /password/reset         { token, password }: set a new password
 *
 * With no email provider configured these answer 501 rather than pretend
 * to send. /password/forgot answers 202 whether or not the account exists,
 * so it cannot be used to probe for registered addresses.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "@wheelsai/db";
import { env } from "../config/env.js";
import { requireAuth, requireJwtAuth } from "../middleware/auth.js";
import { hashPassword, loginAttempts } from "../services/auth.js";
import {
  confirmEmailVerification,
  InvalidEmailTokenError,
  issueEmailToken,
  resetPasswordWithToken,
  SIGNUP_BONUS_CENTS,
  type EmailTokenDb,
} from "../services/emailTokens.js";
import {
  EmailNotConfiguredError,
  isEmailConfigured,
  passwordResetEmail,
  sendEmail as defaultSendEmail,
  verificationEmail,
  type EmailSender,
} from "../services/email/emailService.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("email-auth");

export function webBaseUrl(): string {
  return (env.PUBLIC_WEB_URL ?? env.CORS_ORIGIN).replace(/\/+$/, "");
}

/**
 * Issue and send a verification link. Returns false (never throws) so
 * callers like registration can report the outcome without failing.
 */
export async function sendVerificationEmail(
  user: { id: string; email: string },
  opts: { sendEmail?: EmailSender; db?: Pick<EmailTokenDb, "emailToken"> } = {},
): Promise<boolean> {
  if (!isEmailConfigured()) return false;
  try {
    const token = await issueEmailToken(opts.db ?? (prisma as unknown as EmailTokenDb), {
      userId: user.id,
      email: user.email,
      purpose: "verify_email",
    });
    const bonus = await bonusStillAvailable(user.id);
    await (opts.sendEmail ?? defaultSendEmail)(
      verificationEmail(
        user.email,
        `${webBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`,
        bonus ? Number(SIGNUP_BONUS_CENTS) / 100 : null,
      ),
    );
    return true;
  } catch (err) {
    logger.error({ err, userId: user.id }, "Failed to send verification email");
    return false;
  }
}

async function bonusStillAvailable(userId: string): Promise<boolean> {
  const org = await prisma.organization.findFirst({
    where: { ownerId: userId },
    orderBy: { createdAt: "asc" },
    select: { signupBonusGrantedAt: true },
  });
  return !!org && org.signupBonusGrantedAt === null;
}

export function createEmailAuthRoutes(
  deps: { sendEmail?: EmailSender } = {},
): FastifyPluginAsync {
  const send = deps.sendEmail ?? defaultSendEmail;
  const db = prisma as unknown as EmailTokenDb;

  return async (app) => {
    app.post(
      "/email/verify/request",
      {
        preHandler: [requireAuth, requireJwtAuth],
        config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
      },
      async (request, reply) => {
        const userId = request.auth!.userId!;
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, email: true, emailVerified: true },
        });
        if (!user?.email) {
          return reply.status(400).send({
            error: "no_email",
            message: "Add an email address in settings first.",
          });
        }
        if (user.emailVerified) {
          return reply.send({ sent: false, alreadyVerified: true });
        }
        if (!isEmailConfigured()) {
          return reply.status(501).send({
            error: "email_not_configured",
            message: new EmailNotConfiguredError().message,
          });
        }
        const sent = await sendVerificationEmail({ id: user.id, email: user.email }, { sendEmail: send });
        if (!sent) {
          return reply.status(502).send({
            error: "email_delivery_failed",
            message: "We could not send the email right now. Please try again shortly.",
          });
        }
        return reply.send({ sent: true });
      },
    );

    app.post(
      "/email/verify/confirm",
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const { token } = z.object({ token: z.string().min(16).max(256) }).parse(request.body);
        try {
          const result = await prisma.$transaction((tx) =>
            confirmEmailVerification(tx as unknown as EmailTokenDb, { token }),
          );
          logger.info(
            { userId: result.userId, bonusCents: Number(result.bonusGrantedCents) },
            "Email verified",
          );
          return reply.send({
            verified: true,
            bonusGrantedCents: Number(result.bonusGrantedCents),
          });
        } catch (err) {
          if (err instanceof InvalidEmailTokenError) {
            return reply.status(400).send({ error: err.code, message: err.message });
          }
          throw err;
        }
      },
    );

    app.post(
      "/password/forgot",
      { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const { email } = z.object({ email: z.string().email() }).parse(request.body);
        if (!isEmailConfigured()) {
          return reply.status(501).send({
            error: "email_not_configured",
            message: "Password reset by email is temporarily unavailable. Try again later, or contact support.",
          });
        }
        const user = await prisma.user.findUnique({
          where: { email },
          select: { id: true, email: true, passwordHash: true },
        });
        if (user?.email && user.passwordHash) {
          try {
            const token = await issueEmailToken(db, {
              userId: user.id,
              email: user.email,
              purpose: "reset_password",
            });
            await send(
              passwordResetEmail(
                user.email,
                `${webBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`,
              ),
            );
          } catch (err) {
            logger.error({ err, userId: user.id }, "Failed to send password reset email");
          }
        }
        // Same answer either way: no account enumeration.
        return reply.status(202).send({
          message: "If an account uses that email, a reset link is on its way.",
        });
      },
    );

    app.post(
      "/password/reset",
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const body = z
          .object({
            token: z.string().min(16).max(256),
            password: z.string().min(8, "Password must be at least 8 characters"),
          })
          .parse(request.body);
        const passwordHash = await hashPassword(body.password);
        try {
          const result = await prisma.$transaction((tx) =>
            resetPasswordWithToken(tx as unknown as EmailTokenDb, { token: body.token, passwordHash }),
          );
          await loginAttempts.clear(result.email);
          logger.info({ userId: result.userId }, "Password reset");
          return reply.send({ reset: true });
        } catch (err) {
          if (err instanceof InvalidEmailTokenError) {
            return reply.status(400).send({ error: err.code, message: err.message });
          }
          throw err;
        }
      },
    );
  };
}

export const emailAuthRoutes = createEmailAuthRoutes();
