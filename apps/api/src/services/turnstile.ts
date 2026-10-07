/**
 * Cloudflare Turnstile verification: the human check an anonymous visitor
 * passes before Try it gives them a session.
 *
 * It fails closed. `ok` is returned only when Cloudflare said the token is
 * good AND the token was issued for this action, this site and this listing.
 * A verification that could not be made (network error, timeout, 5xx,
 * unreadable body) is `unavailable`, which callers answer 503 - never a
 * pass. Tokens are single-use and live 300 seconds on Cloudflare's side.
 *
 * The endpoint is Cloudflare's fixed address, not a user-supplied URL, so it
 * does not go through the SSRF guard. The secret is sent in the form body
 * and appears in nothing this module returns or throws.
 *
 * Pure: the secret and fetch are injected.
 */

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The widget action Try it renders with; a token for another form fails. */
export const TRY_IT_TURNSTILE_ACTION = "try_it";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TOKEN_LENGTH = 2048;

export interface TurnstileInput {
  token: string | null | undefined;
  remoteIp?: string | null;
  expectedAction: string;
  /** The web app's hostname the widget was rendered on. */
  expectedHostname: string;
  /** What the page bound the token to (the listing id). */
  expectedCdata?: string;
}

export interface TurnstileDeps {
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type TurnstileResult =
  | { status: "ok" }
  /** No token was sent; nothing was asked of Cloudflare. */
  | { status: "required" }
  /** Cloudflare refused it, or it was issued for something else. */
  | { status: "failed"; codes: string[] }
  /** The check could not be made. Not a pass. */
  | { status: "unavailable"; reason: "network" | "timeout" | "upstream_error" | "bad_response" };

export async function verifyTurnstile(input: TurnstileInput, deps: TurnstileDeps): Promise<TurnstileResult> {
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (token.length === 0) return { status: "required" };
  if (token.length > MAX_TOKEN_LENGTH) return { status: "failed", codes: ["invalid-input-response"] };

  const form = new URLSearchParams({ secret: deps.secret, response: token });
  if (input.remoteIp) form.set("remoteip", input.remoteIp);

  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: timeout,
      redirect: "error",
    });
  } catch {
    // The error is not passed on: a fetch failure can quote its request.
    return { status: "unavailable", reason: timeout.aborted ? "timeout" : "network" };
  }
  if (res.status >= 500) return { status: "unavailable", reason: "upstream_error" };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: "unavailable", reason: "bad_response" };
  }
  if (typeof body !== "object" || body === null || typeof (body as { success?: unknown }).success !== "boolean") {
    return { status: "unavailable", reason: "bad_response" };
  }
  const answer = body as {
    success: boolean;
    "error-codes"?: unknown;
    action?: unknown;
    hostname?: unknown;
    cdata?: unknown;
  };

  if (!answer.success) {
    const codes = Array.isArray(answer["error-codes"])
      ? answer["error-codes"].filter((code): code is string => typeof code === "string").slice(0, 10)
      : [];
    // Cloudflare's own trouble is reported as an error code on a 200.
    if (codes.includes("internal-error")) return { status: "unavailable", reason: "upstream_error" };
    return { status: "failed", codes: codes.length > 0 ? codes : ["verification-failed"] };
  }

  // A real token, solved somewhere else or for something else, is not a
  // pass here: without these a token farmed on any other Turnstile form of
  // this account would open every listing.
  const mismatches: string[] = [];
  if (answer.action !== input.expectedAction) mismatches.push("action-mismatch");
  if (
    typeof answer.hostname !== "string" ||
    answer.hostname.toLowerCase() !== input.expectedHostname.toLowerCase()
  ) {
    mismatches.push("hostname-mismatch");
  }
  if (input.expectedCdata !== undefined && answer.cdata !== input.expectedCdata) {
    mismatches.push("cdata-mismatch");
  }
  return mismatches.length > 0 ? { status: "failed", codes: mismatches } : { status: "ok" };
}
