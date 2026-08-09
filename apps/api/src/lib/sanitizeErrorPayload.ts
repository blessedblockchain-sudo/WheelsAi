/**
 * Last-line scrubber for outgoing error responses.
 *
 * ~109 route handlers across 11 files follow the pattern
 *
 *   catch (error: any) { return reply.status(400).send({ error: error.message }) }
 *
 * which bypasses the global error handler entirely — the handler only
 * sees errors that are THROWN, and these are caught. That was fine while
 * error messages were short strings. Prisma's are not: a failed
 * `create()` renders the call site with an absolute path, a code frame of
 * the surrounding source, and **the full data payload**.
 *
 * Observed live before this scrubber, from `POST /api/webhooks` with a
 * field missing:
 *
 *   Invalid `prisma.webhook.create()` invocation in
 *   /home/bprime/Bounties/WheelsAi/apps/api/src/services/webhooks.ts:117:25
 *     115 const secret = crypto.randomBytes(32).toString("hex");
 *   → 117 return prisma.webhook.create({ data: { orgId: "...", name: "x",
 *           secret: "db1ad3456a0eb6bdd677511133f881d3f214de9d1f..."
 *
 * That response leaked the deployment's directory layout, verbatim source,
 * and a freshly generated HMAC signing secret — to any authenticated
 * caller who submitted an incomplete form.
 *
 * Fixing 109 call sites invites missing one, and the next handler someone
 * writes would reintroduce it. This runs as an `onSend` hook instead, so
 * every error body leaving the process is scrubbed regardless of which
 * layer produced it.
 *
 * The scrubber is deliberately conservative: it only replaces messages
 * carrying an internal-detail signature, so ordinary business errors
 * ("Agent not found", "Minimum payout amount is $10.00") reach clients
 * unchanged.
 */

const GENERIC_MESSAGE = "The request could not be completed.";

/** Signatures that mean the string carries implementation detail. */
const INTERNAL_SIGNATURES: RegExp[] = [
  // Prisma's rich invocation errors — the worst offender, because they
  // embed the data payload (secrets, tokens, hashes).
  /Invalid `prisma\./i,
  /invocation in\s/i,
  // Absolute filesystem paths.
  /(^|[\s"'(])\/(home|Users|root|var|srv|opt|app)\//,
  /[A-Za-z]:\\\\/,
  // Stack frames and code frames.
  /\n\s+at\s+\S+/,
  /→\s*\d+\s/,
  // Connection strings.
  /(postgres|postgresql|redis|mysql|mongodb):\/\/\S*:\S*@/i,
];

export function looksInternal(message: string): boolean {
  return INTERNAL_SIGNATURES.some((re) => re.test(message));
}

/**
 * Returns a client-safe message: the original when it is an ordinary
 * business error, a generic string when it carries internal detail.
 */
export function sanitizeMessage(message: unknown): unknown {
  if (typeof message !== "string") return message;
  if (message.length === 0) return message;
  return looksInternal(message) ? GENERIC_MESSAGE : message;
}

/** Fields that conventionally carry a human-readable failure string. */
const MESSAGE_FIELDS = ["error", "message", "detail", "details", "reason"];

/**
 * Scrubs an already-parsed JSON error body. Returns the same object when
 * nothing changed, so the caller can skip re-serializing.
 */
export function sanitizeErrorBody(body: unknown): {
  body: unknown;
  changed: boolean;
} {
  if (typeof body !== "object" || body === null) {
    const cleaned = sanitizeMessage(body);
    return { body: cleaned, changed: cleaned !== body };
  }
  if (Array.isArray(body)) return { body, changed: false };

  let changed = false;
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const field of MESSAGE_FIELDS) {
    const value = out[field];
    if (typeof value !== "string") continue;
    const cleaned = sanitizeMessage(value);
    if (cleaned !== value) {
      out[field] = cleaned;
      changed = true;
    }
  }
  return { body: changed ? out : body, changed };
}

/**
 * Fastify `onSend` hook. Only touches error responses (>= 400) carrying a
 * JSON body — success payloads and streams are passed through untouched.
 *
 * MUST be registered before the route plugins: hooks propagate to child
 * contexts created after they are added, exactly like setErrorHandler.
 */
export function sanitizeErrorPayloadHook(
  request: { log?: { warn: (o: unknown, m: string) => void } },
  reply: { statusCode: number },
  payload: unknown,
  done: (err: Error | null, payload?: unknown) => void,
): void {
  if (reply.statusCode < 400 || typeof payload !== "string" || payload.length === 0) {
    return done(null, payload);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Not JSON (HTML error page, plain text) — scrub the raw string.
    if (looksInternal(payload)) {
      return done(null, JSON.stringify({ error: GENERIC_MESSAGE }));
    }
    return done(null, payload);
  }

  const { body, changed } = sanitizeErrorBody(parsed);
  if (!changed) return done(null, payload);

  request.log?.warn(
    { statusCode: reply.statusCode },
    "scrubbed internal detail from an outgoing error response",
  );
  return done(null, JSON.stringify(body));
}
