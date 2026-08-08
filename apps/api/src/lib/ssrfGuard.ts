/**
 * SSRF guard for outbound requests to user-supplied URLs.
 *
 * The platform makes outbound HTTP to addresses users control in several
 * places — the agent `http_request` tool, scheduled webhook tasks, alert
 * and integration webhook senders. Each is a path from "authenticated
 * user" to "request originating inside our network", which is how an
 * attacker reaches Redis, Postgres, the Nosana signer, or a cloud
 * metadata endpoint that hands out instance credentials.
 *
 * The guard this replaces compared the HOSTNAME against a short blocklist
 * (`localhost`, `127.0.0.1`, `169.254.169.254`, a few prefixes). Three
 * ways through it:
 *
 *   1. DNS. `evil.com` resolving to 127.0.0.1 passes a hostname check
 *      trivially — the name is not on the list.
 *   2. Encodings. `http://2130706433/`, `http://127.1/`, `http://[::1]/`
 *      are all loopback and none is on the list.
 *   3. Redirects. `fetch` follows them by default, so a public URL that
 *      302s to the metadata endpoint reaches it after the check passed.
 *
 * So this guard resolves the hostname and validates EVERY returned
 * address, parses IP literals properly instead of prefix-matching, and
 * refuses to auto-follow redirects — each hop is re-validated.
 *
 * Residual risk, stated honestly: between our DNS lookup and the socket
 * connect, a hostile resolver can change its answer (classic TOCTOU
 * rebinding). Closing that fully requires pinning the validated IP into
 * the connection, which needs a custom HTTP agent. This narrows the hole
 * enormously; it does not claim to seal it.
 */

import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export type IpClassification = "public" | "blocked" | "invalid";

/** Parses a dotted-quad into 4 octets, or null when not IPv4. */
function parseIpv4(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts;
}

function ipv4Blocked(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;
  // 0.0.0.0/8 — "this network"; 0.0.0.0 also means "all interfaces".
  if (a === 0) return true;
  // 10.0.0.0/8 private
  if (a === 10) return true;
  // 100.64.0.0/10 carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 loopback — covers 127.1, 127.0.0.1, etc.
  if (a === 127) return true;
  // 169.254.0.0/16 link-local — includes the cloud metadata endpoint.
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 private (NOT all of 172.*, which the old check blocked)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 IETF protocol assignments, 192.168.0.0/16 private
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved (includes 255.255.255.255)
  if (a >= 224) return true;
  return false;
}

/**
 * Classifies an IP literal. IPv4-mapped and NAT64-embedded IPv6 are
 * unwrapped and judged on the embedded IPv4 — otherwise `::ffff:127.0.0.1`
 * would read as an ordinary IPv6 address.
 */
export function classifyIp(ip: string): IpClassification {
  const version = isIP(ip);
  if (version === 0) return "invalid";

  if (version === 4) {
    const octets = parseIpv4(ip);
    if (!octets) return "invalid";
    return ipv4Blocked(octets) ? "blocked" : "public";
  }

  const lower = ip.toLowerCase();

  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) — judge the
  // embedded address, in either dotted or hex form.
  const embedded = lower.match(/(?:::ffff:|64:ff9b::)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (embedded?.[1]) {
    return classifyIp(embedded[1]);
  }

  // Unspecified (::) and loopback (::1)
  if (lower === "::" || lower === "::1") return "blocked";
  // fc00::/7 unique-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return "blocked";
  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return "blocked";
  // ff00::/8 multicast
  if (/^ff[0-9a-f]{2}:/.test(lower)) return "blocked";

  return "public";
}

/** Hostnames that resolve internally in common deployments. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

export interface UrlGuardDeps {
  /** Injected for tests; defaults to real DNS. */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export type UrlVerdict =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true });
  return records.map((r) => r.address);
}

/**
 * Validates a user-supplied URL for outbound use.
 *
 * Refuses non-http(s) schemes (file:, gopher:, and friends are classic
 * SSRF escalations), embedded credentials, and any hostname that resolves
 * to a non-public address. EVERY resolved address must be public — a
 * hostname answering with one public and one loopback record is refused,
 * since we cannot control which one the socket picks.
 */
export async function assertUrlAllowed(
  rawUrl: string,
  deps: UrlGuardDeps = {},
): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme ${url.protocol} is not allowed (http/https only)` };
  }
  // user:pass@host can smuggle credentials to an internal service.
  if (url.username || url.password) {
    return { ok: false, reason: "URLs with embedded credentials are not allowed" };
  }

  // URL keeps IPv6 literals bracketed.
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname.length === 0) {
    return { ok: false, reason: "URL has no host" };
  }
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    return { ok: false, reason: `host ${hostname} is internal` };
  }

  // An IP literal needs no DNS — judge it directly.
  if (isIP(hostname) !== 0) {
    const verdict = classifyIp(hostname);
    if (verdict !== "public") {
      return { ok: false, reason: `address ${hostname} is not a public address` };
    }
    return { ok: true, url };
  }

  let addresses: string[];
  try {
    addresses = await (deps.resolveHost ?? defaultResolve)(hostname);
  } catch {
    return { ok: false, reason: `could not resolve host ${hostname}` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: `host ${hostname} resolved to no addresses` };
  }
  for (const address of addresses) {
    const verdict = classifyIp(address);
    if (verdict !== "public") {
      return {
        ok: false,
        reason: `host ${hostname} resolves to ${address}, which is not a public address`,
      };
    }
  }

  return { ok: true, url };
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Redirect hops to follow, each re-validated. 0 = refuse redirects. */
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  guardDeps?: UrlGuardDeps;
}

export class SsrfBlockedError extends Error {}

/**
 * Fetches a user-supplied URL with the guard applied to the initial URL
 * AND to every redirect hop.
 *
 * `redirect: "manual"` is the important part: the default follow behavior
 * would let a validated public URL bounce to an internal one, which is
 * how a hostname-only check gets bypassed even when the first URL is
 * genuinely public.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? 3;
  const timeoutMs = options.timeoutMs ?? 10_000;

  let target = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const verdict = await assertUrlAllowed(target, options.guardDeps);
    if (!verdict.ok) {
      throw new SsrfBlockedError(`blocked outbound request: ${verdict.reason}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(verdict.url.toString(), {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
        redirect: "manual",
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status < 300 || res.status >= 400) {
      return res;
    }
    const location = res.headers.get("location");
    if (!location) return res;
    if (hop === maxRedirects) {
      throw new SsrfBlockedError("too many redirects");
    }
    // Resolve relative redirects against the current URL, then re-guard.
    target = new URL(location, verdict.url).toString();
  }

  throw new SsrfBlockedError("too many redirects");
}
