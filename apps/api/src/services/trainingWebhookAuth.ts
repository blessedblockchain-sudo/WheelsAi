/**
 * Per-job auth for the Nosana training webhook (REMEDIATION_PLAN A6).
 *
 * The webhook endpoint mutates job status/logs/outputPath and previously
 * had no authentication — anyone with a jobId could spoof completion.
 * Each job's webhook URL now carries a token derived as
 * HMAC-SHA256(JWT_SECRET, "training-webhook-v1:<jobId>"), so the token is
 * job-scoped, deterministic (no schema change), and verifiable without a
 * lookup. Comparison is constant-time.
 */

import crypto from "node:crypto";

const DOMAIN = "training-webhook-v1";

function defaultSecret(): string {
  // Read lazily so tests can set process.env before first use.
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required to derive webhook tokens");
  return secret;
}

export function deriveTrainingWebhookToken(
  jobId: string,
  secret: string = defaultSecret()
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${DOMAIN}:${jobId}`)
    .digest("hex");
}

export function verifyTrainingWebhookToken(
  jobId: string,
  presented: string | undefined | null,
  secret: string = defaultSecret()
): boolean {
  if (!presented) return false;
  const expected = deriveTrainingWebhookToken(jobId, secret);
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(presented, "hex");
    b = Buffer.from(expected, "hex");
  } catch {
    return false;
  }
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
