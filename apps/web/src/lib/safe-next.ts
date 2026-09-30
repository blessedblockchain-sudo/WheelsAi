/**
 * Where to send a user after sign-in or sign-up. Only same-origin paths are
 * allowed. The old check (starts with "/" but not "//") let "/\evil.com"
 * through, which browsers normalise to "//evil.com": an open redirect.
 */
export function safeNextPath(fallback = "/dashboard"): string {
  if (typeof window === "undefined") return fallback;
  const next = new URLSearchParams(window.location.search).get("next");
  return resolveSafeNext(next, window.location.origin, fallback);
}

export function resolveSafeNext(next: string | null, origin: string, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/")) return fallback;
  try {
    const url = new URL(next, origin);
    if (url.origin !== origin) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

/** Carry the current ?next= across the login/register links. */
export function withNext(path: string): string {
  if (typeof window === "undefined") return path;
  const next = new URLSearchParams(window.location.search).get("next");
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}
