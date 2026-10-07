/**
 * Authentication of the training container's callbacks
 * (POST /api/training/jobs/:jobId/events).
 *
 * The container signs every event it posts:
 *
 *   X-WheelsAI-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>
 *
 * (infra/training/wheelsai_trainer/callbacks.py). The secret is derived per
 * job AND per submit attempt:
 *
 *   HMAC-SHA256(JWT_SECRET, "training-callback-v1:<jobId>:<submitNonce>")
 *
 * so it needs no column, a container of one job cannot sign for another, and
 * what an earlier attempt of the same job was given signs nothing for a later
 * one. The nonce travels in the callback URL (?n=), which lets the signature
 * be checked before any row is read.
 *
 * The signature covers the RAW body: verify the bytes that arrived, never a
 * re-serialised object. A timestamp more than five minutes from this clock is
 * refused, which bounds how long a captured request can be replayed; the
 * event's rising `seq` (checked by the job service) closes the rest.
 *
 * Pure but for the default secret, which is read lazily from the environment.
 */

import crypto from "node:crypto";

const DOMAIN = "training-callback-v1";

/** The header the trainer sends. Fastify lower-cases header names. */
export const TRAINING_CALLBACK_SIGNATURE_HEADER = "x-wheelsai-signature";

/** How far the signed timestamp may be from this clock, either way. */
export const TRAINING_CALLBACK_TOLERANCE_SECONDS = 300;

/** The largest callback body accepted, in bytes (the trainer's own line limit). */
export const TRAINING_CALLBACK_MAX_BYTES = 65_536;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE_PATTERN = /^[a-z0-9]{8,32}$/;
/** Exactly what the trainer prints: no spaces, a decimal time, a hex digest. */
const SIGNATURE_PATTERN = /^t=([0-9]{1,12}),v1=([0-9a-f]{64})$/;

function defaultSecret(): string {
  // Read lazily so tests can set process.env before first use.
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required to derive training callback secrets");
  return secret;
}

/**
 * The CALLBACK_SECRET of one submit attempt, as 64 hex characters. Throws on
 * a job id or nonce that is not what this service generates: both are placed
 * in a job definition.
 */
export function deriveTrainingCallbackSecret(
  jobId: string,
  submitNonce: string,
  secret: string = defaultSecret(),
): string {
  if (!UUID_PATTERN.test(jobId)) throw new RangeError("jobId is not a UUID");
  if (!NONCE_PATTERN.test(submitNonce)) throw new RangeError("submitNonce is malformed");
  return crypto.createHmac("sha256", secret).update(`${DOMAIN}:${jobId}:${submitNonce}`).digest("hex");
}

/** The header value for a body, as the trainer computes it. For tests and tools. */
export function signTrainingCallback(
  callbackSecret: string,
  timestampSeconds: number,
  rawBody: string | Buffer,
): string {
  const digest = crypto
    .createHmac("sha256", callbackSecret)
    .update(`${timestampSeconds}.`)
    .update(rawBody)
    .digest("hex");
  return `t=${timestampSeconds},v1=${digest}`;
}

export type TrainingCallbackVerdict =
  | { ok: true; timestampSeconds: number }
  | { ok: false; reason: "missing" | "malformed" | "bad_signature" | "stale" };

/**
 * Checks a signature header against the raw body. The digest is compared
 * first and in constant time; the timestamp is only believed once it holds.
 */
export function verifyTrainingCallbackSignature(args: {
  callbackSecret: string;
  header: unknown;
  rawBody: string | Buffer;
  nowMs: number;
  toleranceSeconds?: number;
}): TrainingCallbackVerdict {
  if (args.header === undefined || args.header === null || args.header === "") {
    return { ok: false, reason: "missing" };
  }
  if (typeof args.header !== "string" || args.header.length > 200) {
    return { ok: false, reason: "malformed" };
  }
  const match = SIGNATURE_PATTERN.exec(args.header);
  if (!match) return { ok: false, reason: "malformed" };
  const timestampSeconds = Number(match[1]);

  const expected = crypto
    .createHmac("sha256", args.callbackSecret)
    .update(`${match[1]}.`)
    .update(args.rawBody)
    .digest();
  const presented = Buffer.from(match[2]!, "hex");
  if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  const tolerance = args.toleranceSeconds ?? TRAINING_CALLBACK_TOLERANCE_SECONDS;
  if (Math.abs(args.nowMs / 1000 - timestampSeconds) > tolerance) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true, timestampSeconds };
}

/** Whether a string can be a submit nonce (the ?n= of a callback URL). */
export function isTrainingSubmitNonce(value: unknown): value is string {
  return typeof value === "string" && NONCE_PATTERN.test(value);
}
