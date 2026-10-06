import { CliError } from "../errors.js";

/** Where a local development API listens. Shown as the default; a credential is never sent here unasked. */
export const DEFAULT_API_URL = "http://localhost:4000";

/** Strip whitespace and trailing slashes so URLs concatenate predictably. */
export function normalizeUrl(input: string): string {
  return input.trim().replace(/\/+$/, "");
}

/**
 * Check a base URL (API or web app) and return it normalized. `source` names where it
 * came from (`--url`, `WHEELSAI_API_URL`, ...) so the error points at the thing to fix.
 * Only http(s) is accepted, and a URL may not carry a user name, password, query or fragment:
 * requests are built by appending paths to it.
 */
export function parseBaseUrl(input: string, source: string): string {
  const text = normalizeUrl(input);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new CliError(`${source} is not a URL: expected something like https://api.example.com.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError(`${source} must start with https:// (or http:// for a local server).`);
  }
  if (url.username || url.password) {
    throw new CliError(`${source} must not contain a user name or password.`);
  }
  if (url.search || url.hash) {
    throw new CliError(`${source} must not contain a query string or fragment.`);
  }
  return normalizeUrl(url.origin + url.pathname);
}

/** localhost, *.localhost, 127.0.0.0/8 and ::1: traffic that never leaves this machine. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * A warning for a URL that would carry credentials in cleartext across a network,
 * or null when it is https or stays on this machine.
 */
export function plainHttpWarning(apiUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return null;
  return `${url.origin} is plain http: your API key, password and session token travel unencrypted. Use https.`;
}

/** Whether two base URLs name the same server (scheme, host and port). */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * The web app's base URL for an API URL, when no web URL is configured.
 *
 * The API does not publish its web URL, so this is a convention, not a lookup:
 *  - local development: the API on :4000 pairs with the web app on :3000;
 *  - `api.example.com` pairs with `example.com`;
 *  - anything else is assumed to serve the web app from the same origin.
 * Set `webUrl` (`wheelsai config set webUrl <url>` or `WHEELSAI_WEB_URL`) when that is wrong.
 */
export function deriveWebUrl(apiUrl: string): string {
  let url: URL;
  try {
    url = new URL(normalizeUrl(apiUrl));
  } catch {
    return normalizeUrl(apiUrl);
  }

  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (localHosts.has(url.hostname)) {
    url.port = "3000";
  } else if (url.hostname.startsWith("api.")) {
    url.hostname = url.hostname.slice("api.".length);
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return normalizeUrl(url.toString());
}

/** The public marketplace page for a listing slug. */
export function listingUrl(webUrl: string, slug: string): string {
  return `${normalizeUrl(webUrl)}/marketplace/${encodeURIComponent(slug)}`;
}
