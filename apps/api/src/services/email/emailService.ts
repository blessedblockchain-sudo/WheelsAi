/**
 * Transactional email. One small interface, two transports:
 *   - resend: HTTPS API (RESEND_API_KEY, EMAIL_FROM)
 *   - log:    development only; writes the message (and its links) to the
 *             API log so flows can be exercised locally
 * With no provider configured, sendEmail throws EmailNotConfiguredError and
 * the routes that need email answer 501 instead of pretending to send.
 */
import { env } from "../../config/env.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("email");

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export class EmailNotConfiguredError extends Error {
  readonly code = "email_not_configured";
  constructor() {
    super("Email delivery is not configured on this server.");
    this.name = "EmailNotConfiguredError";
  }
}

export class EmailDeliveryError extends Error {
  readonly code = "email_delivery_failed";
  constructor(detail: string) {
    super(`Email delivery failed: ${detail}`);
    this.name = "EmailDeliveryError";
  }
}

export type EmailSender = (msg: EmailMessage) => Promise<void>;

export function emailProvider(): "resend" | "log" | null {
  if (env.EMAIL_PROVIDER) return env.EMAIL_PROVIDER;
  return env.NODE_ENV === "development" ? "log" : null;
}

export function isEmailConfigured(): boolean {
  return emailProvider() !== null;
}

async function sendViaResend(msg: EmailMessage, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new EmailDeliveryError(`${res.status} ${body.slice(0, 200)}`);
  }
}

export const sendEmail: EmailSender = async (msg) => {
  const provider = emailProvider();
  if (provider === "resend") return sendViaResend(msg);
  if (provider === "log") {
    logger.info({ to: msg.to, subject: msg.subject, text: msg.text }, "Email (log transport)");
    return;
  }
  throw new EmailNotConfiguredError();
};

// ============================================
// Templates
// ============================================

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(title: string, body: string, cta: { label: string; url: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#070b14;font-family:Inter,Arial,sans-serif;color:#e6ebf5">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="480" cellpadding="0" cellspacing="0" style="background:#0d1422;border:1px solid #1b2230;border-radius:12px;padding:32px">
<tr><td style="font-size:20px;font-weight:600;padding-bottom:16px">${escapeHtml(title)}</td></tr>
<tr><td style="font-size:14px;line-height:22px;color:#b7c0d0;padding-bottom:24px">${body}</td></tr>
<tr><td><a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 20px;border-radius:8px">${escapeHtml(cta.label)}</a></td></tr>
<tr><td style="font-size:12px;color:#8b95a8;padding-top:24px">If the button does not work, open this link:<br>${escapeHtml(cta.url)}</td></tr>
</table></td></tr></table></body></html>`;
}

export function verificationEmail(to: string, url: string, bonusDollars: number | null): EmailMessage {
  const bonusLine =
    bonusDollars !== null ? ` Verifying adds your $${bonusDollars} of free credits.` : "";
  return {
    to,
    subject: "Verify your email for WheelsAI",
    text: `Confirm this address for your WheelsAI account.${bonusLine}\n\n${url}\n\nThe link expires in 24 hours. If you did not sign up, ignore this email.`,
    html: layout(
      "Verify your email",
      `Confirm this address for your WheelsAI account.${escapeHtml(bonusLine)} The link expires in 24 hours. If you did not sign up, ignore this email.`,
      { label: "Verify email", url },
    ),
  };
}

export function passwordResetEmail(to: string, url: string): EmailMessage {
  return {
    to,
    subject: "Reset your WheelsAI password",
    text: `Someone asked to reset the password for this WheelsAI account.\n\n${url}\n\nThe link expires in 30 minutes. If it was not you, ignore this email; your password stays the same.`,
    html: layout(
      "Reset your password",
      "Someone asked to reset the password for this WheelsAI account. The link expires in 30 minutes. If it was not you, ignore this email; your password stays the same.",
      { label: "Choose a new password", url },
    ),
  };
}

export function teamInviteEmail(
  to: string,
  url: string,
  orgName: string,
  role: string,
): EmailMessage {
  return {
    to,
    subject: `You're invited to ${orgName} on WheelsAI`,
    text: `You have been invited to join ${orgName} on WheelsAI as ${role}.\n\n${url}\n\nThe invite expires in 7 days and only works for ${to}.`,
    html: layout(
      `Join ${orgName} on WheelsAI`,
      `You have been invited to join <strong>${escapeHtml(orgName)}</strong> as ${escapeHtml(role)}. The invite expires in 7 days and only works for ${escapeHtml(to)}.`,
      { label: "Accept invite", url },
    ),
  };
}
