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
 * Parses an IPv6 literal to its 16 bytes. Handles `::` compression and an
 * embedded dotted IPv4 tail (`::ffff:127.0.0.1`). Returns null for anything
 * that is not valid IPv6 - callers treat that as "invalid", never "public".
 */
export function parseIpv6(ip: string): Uint8Array | null {
  if (isIP(ip) !== 6) return null;
  let text = ip.toLowerCase();

  // A zone id (fe80::1%eth0) only ever names a local interface.
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);

  // An embedded IPv4 tail becomes two more hextets.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = parseIpv4(tail);
    if (!octets) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const head = toGroups(halves[0]!);
  const rear = halves.length === 2 ? toGroups(halves[1]!) : [];
  const missing = 8 - head.length - rear.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;

  const groups = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rear];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i]!;
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

const allZero = (bytes: Uint8Array, from: number, to: number) => {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return false;
  return true;
};

/**
 * Classifies an IP literal.
 *
 * IPv6 is judged on its BYTES, never its text: the URL parser rewrites
 * `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, and a textual check for the
 * dotted form classed that as public. Every IPv6 form that carries an IPv4
 * address is unwrapped and judged on the embedded IPv4:
 *
 *   ::ffff:0:0/96      IPv4-mapped
 *   ::ffff:0:0:0/96    IPv4-translated (SIIT)
 *   64:ff9b::/96       NAT64
 *   2002::/16          6to4 (IPv4 in bytes 2-5)
 *
 * The rest of ::/96 (IPv4-compatible, `::`, `::1`), the local-use NAT64
 * prefix, Teredo and the documentation range have no legitimate public
 * destination and are blocked outright.
 */
export function classifyIp(ip: string): IpClassification {
  const version = isIP(ip);
  if (version === 0) return "invalid";

  if (version === 4) {
    const octets = parseIpv4(ip);
    if (!octets) return "invalid";
    return ipv4Blocked(octets) ? "blocked" : "public";
  }

  // A zone id is only meaningful for a local interface.
  if (ip.includes("%")) return "blocked";

  const b = parseIpv6(ip);
  if (!b) return "invalid";

  const embedded = (from: number): IpClassification =>
    ipv4Blocked([b[from]!, b[from + 1]!, b[from + 2]!, b[from + 3]!]) ? "blocked" : "public";

  // ::/96 - unspecified, loopback, and deprecated IPv4-compatible addresses.
  if (allZero(b, 0, 12)) return "blocked";
  // ::ffff:0:0/96 - IPv4-mapped.
  if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return embedded(12);
  // ::ffff:0:0:0/96 - IPv4-translated (SIIT).
  if (allZero(b, 0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) {
    return embedded(12);
  }
  // 64:ff9b::/96 - NAT64 well-known prefix.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(b, 4, 12)) {
    return embedded(12);
  }
  // 64:ff9b:1::/48 - local-use NAT64: a translator inside the network.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0x00 && b[5] === 0x01) {
    return "blocked";
  }
  // 2002::/16 - 6to4: the IPv4 address is bytes 2-5.
  if (b[0] === 0x20 && b[1] === 0x02) return embedded(2);
  // 2001::/32 Teredo, 2001:db8::/32 documentation.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return "blocked";
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "blocked";
  // 100::/64 discard-only.
  if (b[0] === 0x01 && b[1] === 0x00 && allZero(b, 2, 8)) return "blocked";
  // fc00::/7 unique-local
  if ((b[0]! & 0xfe) === 0xfc) return "blocked";
  // fe80::/10 link-local, fec0::/10 (deprecated) site-local
  if (b[0] === 0xfe && ((b[1]! & 0xc0) === 0x80 || (b[1]! & 0xc0) === 0xc0)) return "blocked";
  // ff00::/8 multicast
  if (b[0] === 0xff) return "blocked";

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

/**
 * Why a URL was refused. `address` covers every case that depends on where a
 * host points (internal, unresolvable, resolves to a private address): those
 * reasons are deliberately NOT shown to whoever supplied the URL, because
 * "host X resolves to 10.0.3.7" turns the guard into an internal-address and
 * internal-DNS oracle. The other kinds only echo what the caller sent.
 */
export type UrlRefusalKind = "invalid" | "scheme" | "credentials" | "address";

export type UrlVerdict =
  | { ok: true; url: URL }
  | { ok: false; reason: string; kind: UrlRefusalKind };

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
    return { ok: false, reason: "not a valid URL", kind: "invalid" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme ${url.protocol} is not allowed (http/https only)`, kind: "scheme" };
  }
  // user:pass@host can smuggle credentials to an internal service.
  if (url.username || url.password) {
    return { ok: false, reason: "URLs with embedded credentials are not allowed", kind: "credentials" };
  }

  // URL keeps IPv6 literals bracketed.
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname.length === 0) {
    return { ok: false, reason: "URL has no host", kind: "invalid" };
  }
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    return { ok: false, reason: `host ${hostname} is internal`, kind: "address" };
  }

  // An IP literal needs no DNS — judge it directly.
  if (isIP(hostname) !== 0) {
    const verdict = classifyIp(hostname);
    if (verdict !== "public") {
      return { ok: false, reason: `address ${hostname} is not a public address`, kind: "address" };
    }
    return { ok: true, url };
  }

  let addresses: string[];
  try {
    addresses = await (deps.resolveHost ?? defaultResolve)(hostname);
  } catch {
    return { ok: false, reason: `could not resolve host ${hostname}`, kind: "address" };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: `host ${hostname} resolved to no addresses`, kind: "address" };
  }
  for (const address of addresses) {
    const verdict = classifyIp(address);
    if (verdict !== "public") {
      return {
        ok: false,
        kind: "address",
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
  /**
   * Caller cancellation. Combined with the internal timeout and kept live
   * for the response body too, so aborting also stops a slow body read.
   */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  guardDeps?: UrlGuardDeps;
}

/**
 * `message` is what may be shown to whoever supplied the URL - a model, a
 * graph author, a webhook owner - and never names an address the host
 * resolved to. Safe is the DEFAULT because most callers surface `err.message`
 * without thinking about it; an opt-in safe field left every one of them an
 * internal-address oracle. The full reason lives in `detail`, for logs only.
 *
 * `publicMessage` is kept as an alias of `message` for existing callers.
 */
export class SsrfBlockedError extends Error {
  /** The full reason, resolved address included. Log it; never return it. */
  readonly detail: string;
  readonly publicMessage: string;
  constructor(detail: string, publicMessage?: string) {
    super(publicMessage ?? detail);
    this.name = "SsrfBlockedError";
    this.detail = detail;
    this.publicMessage = this.message;
  }
}

const PUBLIC_ADDRESS_MESSAGE =
  "blocked outbound request: the host does not resolve to a public internet address";

/**
 * Headers that survive a redirect to a DIFFERENT origin. An allowlist, not a
 * blocklist: a caller-supplied `X-Api-Key` or `X-Auth-Token` is exactly as
 * sensitive as `Authorization`, and there is no way to enumerate every name a
 * credential can travel under.
 */
const CROSS_ORIGIN_SAFE_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "user-agent",
]);

interface HopRequest {
  method: string;
  headers: Record<string, string> | undefined;
  body: string | undefined;
}

const withoutHeaders = (
  headers: Record<string, string> | undefined,
  drop: (lowerName: string) => boolean,
): Record<string, string> | undefined => {
  if (!headers) return undefined;
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!drop(name.toLowerCase())) kept[name] = value;
  }
  return kept;
};

/**
 * What to send on the next hop, following the fetch spec's redirect rules
 * plus credential hygiene:
 *   - 301/302 after POST, and 303 for anything but HEAD, become a bodiless GET
 *     (and lose Content-Type / Content-Length with the body)
 *   - 307/308 keep method and body - but only same-origin; resending a body to
 *     another origin is refused
 *   - a hop to another origin (scheme, host OR port) keeps only a small
 *     allowlist of harmless headers: no Authorization, Cookie,
 *     Proxy-Authorization or caller-supplied API keys
 */
function nextHop(prev: HopRequest, status: number, from: URL, to: URL): HopRequest {
  let { method, headers, body } = prev;

  const preserves = status === 307 || status === 308;
  if (!preserves) {
    const toGet =
      status === 301 || status === 302 ? method === "POST" : method !== "HEAD";
    if (toGet) method = "GET";
    if (toGet || method === "HEAD") {
      body = undefined;
      headers = withoutHeaders(
        headers,
        (n) => n === "content-type" || n === "content-length",
      );
    }
  }

  if (from.origin !== to.origin) {
    if (body !== undefined && body !== "") {
      throw new SsrfBlockedError(
        "blocked outbound request: a redirect to another origin would resend the request body",
      );
    }
    headers = withoutHeaders(headers, (n) => !CROSS_ORIGIN_SAFE_HEADERS.has(n));
  }

  return { method, headers, body };
}

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
  let request: HopRequest = {
    method: (options.method ?? "GET").toUpperCase(),
    headers: options.headers,
    body: options.body,
  };

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (options.signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    const verdict = await assertUrlAllowed(target, options.guardDeps);
    if (!verdict.ok) {
      throw new SsrfBlockedError(
        `blocked outbound request: ${verdict.reason}`,
        verdict.kind === "address"
          ? PUBLIC_ADDRESS_MESSAGE
          : `blocked outbound request: ${verdict.reason}`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(verdict.url.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: options.signal
          ? AbortSignal.any([controller.signal, options.signal])
          : controller.signal,
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
    // The redirect response's body is never read; release its socket. This
    // comes BEFORE the hop limit: a refused redirect is never handed to the
    // caller, so nobody else could cancel it and a server trickling a body
    // behind its 302 would hold the connection until GC.
    await res.body?.cancel().catch(() => {});
    if (hop === maxRedirects) {
      throw new SsrfBlockedError("too many redirects");
    }

    // Resolve relative redirects against the current URL, then re-guard.
    const next = new URL(location, verdict.url);
    request = nextHop(request, res.status, verdict.url, next);
    target = next.toString();
  }

  throw new SsrfBlockedError("too many redirects");
}
