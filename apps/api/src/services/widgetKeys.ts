/**
 * The small pure pieces of the web chat channel: the publishable key, the
 * origins a key may be used from, and how a visitor's address is bucketed
 * for rate limiting.
 *
 * What the origin check is and is not. `Origin` is set by browsers and
 * cannot be forged from a page, so the allowlist stops another SITE from
 * embedding somebody's widget. It does nothing against a script, which can
 * send any Origin it likes with a key copied from page source. The controls
 * that hold against that are the fail-closed limits (per address, per key,
 * per day) and the owner's plan. The key is an identifier, never a secret.
 *
 * Pure: no Prisma, no Redis, no environment.
 */

import { createHmac } from "node:crypto";
import { isIP } from "node:net";

import { nanoid } from "nanoid";

export const PUBLIC_KEY_PREFIX = "wpk_";
export const PUBLIC_KEY_PATTERN = /^wpk_[A-Za-z0-9_-]{32}$/;

/** How many origins one key may list. */
export const MAX_ALLOWED_ORIGINS = 20;

/**
 * A new publishable key. The prefix is deliberately not `wheels_`: the auth
 * hook treats that prefix as a secret API key, and this must never be taken
 * for one.
 */
export function generatePublicKey(): string {
  return `${PUBLIC_KEY_PREFIX}${nanoid(32)}`;
}

export function isPublicKey(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_KEY_PATTERN.test(value);
}

// ============================================
// Origins
// ============================================

export type OriginRefusal =
  | "empty"
  | "too_long"
  | "malformed"
  | "scheme_not_allowed"
  | "http_only_for_localhost"
  | "has_userinfo"
  | "has_path"
  | "has_query"
  | "has_fragment"
  | "bad_wildcard"
  | "wildcard_too_broad";

export type NormalizedOrigin =
  | { ok: true; origin: string }
  | { ok: false; reason: OriginRefusal; message: string };

const ORIGIN_MESSAGES: Record<OriginRefusal, string> = {
  empty: "an origin is required",
  too_long: "the origin is too long",
  malformed: "not an origin: write it as https://example.com",
  scheme_not_allowed: "only https:// origins are allowed (http:// for localhost)",
  http_only_for_localhost: "http:// is allowed for localhost only; use https://",
  has_userinfo: "an origin has no user name or password",
  has_path: "an origin has no path: write https://example.com, not a page address",
  has_query: "an origin has no query string",
  has_fragment: "an origin has no fragment",
  bad_wildcard: "a wildcard covers whole subdomains and comes first: https://*.example.com",
  wildcard_too_broad: "a wildcard needs a domain you own after it: https://*.example.com, not https://*.com",
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const WILDCARD_STANDIN = "wildcard-label-standin";

function refuse(reason: OriginRefusal): NormalizedOrigin {
  return { ok: false, reason, message: ORIGIN_MESSAGES[reason] };
}

/**
 * The canonical form of an origin an owner typed: lower-case
 * `scheme://host[:port]` with the default port dropped, or
 * `https://*.host[:port]` for every subdomain of a host.
 *
 * Anything that is more than an origin is refused rather than trimmed to
 * one: an owner who pastes `https://example.com/pricing` believes the widget
 * is limited to that page, and it would not be.
 */
export function normalizeOrigin(input: unknown): NormalizedOrigin {
  if (typeof input !== "string") return refuse("empty");
  const raw = input.trim();
  if (raw.length === 0) return refuse("empty");
  if (raw.length > 300) return refuse("too_long");

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (!scheme) return refuse("malformed");
  const protocol = scheme[1]!.toLowerCase();
  if (protocol !== "https" && protocol !== "http") return refuse("scheme_not_allowed");

  // Checked on the text: URL parsing would normalise these away, and each
  // says the owner meant something an origin cannot express.
  const rest = raw.slice(scheme[0].length);
  if (rest.includes("#")) return refuse("has_fragment");
  if (rest.includes("?")) return refuse("has_query");
  const slash = rest.indexOf("/");
  if (slash !== -1 && rest.slice(slash) !== "/") return refuse("has_path");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  if (authority.includes("@")) return refuse("has_userinfo");
  if (authority.length === 0 || /[\s\\]/.test(authority)) return refuse("malformed");

  const stars = authority.split("*").length - 1;
  const wildcard = authority.startsWith("*.");
  if (stars > 1 || (stars === 1 && !wildcard)) return refuse("bad_wildcard");
  // An address has no subdomains. (Checked on the text: with a label in
  // front of it, the URL parser no longer reads it as an address.)
  if (wildcard && isIP(authority.slice(2).replace(/:\d+$/, "")) !== 0) return refuse("bad_wildcard");

  let url: URL;
  try {
    url = new URL(`${protocol}://${wildcard ? `${WILDCARD_STANDIN}.${authority.slice(2)}` : authority}`);
  } catch {
    return refuse("malformed");
  }
  if (url.username || url.password) return refuse("has_userinfo");
  if (url.pathname !== "/" || url.search || url.hash) return refuse("malformed");

  const hostname = wildcard ? url.hostname.slice(WILDCARD_STANDIN.length + 1) : url.hostname;
  if (hostname.length === 0 || hostname.endsWith(".")) return refuse("malformed");

  if (wildcard) {
    // No public-suffix list here, so this cannot know that `*.co.uk` is as
    // broad as `*.com`. It refuses what it can tell: a wildcard directly
    // under a top-level name.
    if (hostname.split(".").length < 2) return refuse("wildcard_too_broad");
  }
  if (protocol === "http" && (wildcard || !LOCAL_HOSTS.has(hostname))) {
    return refuse("http_only_for_localhost");
  }

  const port = url.port ? `:${url.port}` : "";
  return { ok: true, origin: `${protocol}://${wildcard ? "*." : ""}${hostname}${port}` };
}

/** The exact origin a browser sent, in canonical form; null when it is not one. */
function requestOrigin(header: string | null | undefined): URL | null {
  if (typeof header !== "string" || header.length === 0 || header.length > 300) return null;
  // A sandboxed frame or a file:// page sends the literal "null".
  if (header === "null") return null;
  let url: URL;
  try {
    url = new URL(header);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  return url;
}

/**
 * Whether a request's Origin may use a key.
 *
 * `allowed` holds normalizeOrigin output. `appOrigins` are the platform's own
 * web origins, always allowed so an owner can preview the widget in the
 * dashboard before listing any site. A request with no Origin is refused: a
 * browser always sends one on the cross-origin calls the widget makes.
 */
export function originAllowed(
  header: string | null | undefined,
  allowed: readonly string[],
  appOrigins: readonly string[] = [],
): boolean {
  const url = requestOrigin(header);
  if (!url) return false;
  const origin = url.origin.toLowerCase();

  for (const entry of appOrigins) {
    const app = requestOrigin(entry);
    if (app && app.origin.toLowerCase() === origin) return true;
  }

  const host = url.hostname.toLowerCase();
  for (const entry of allowed) {
    if (entry === origin) return true;
    const wildcard = /^(https?):\/\/\*\.([^:/]+)(:\d+)?$/.exec(entry);
    if (!wildcard) continue;
    const [, protocol, base, port] = wildcard as unknown as [string, string, string, string | undefined];
    if (url.protocol !== `${protocol}:`) continue;
    if ((port ?? "") !== (url.port ? `:${url.port}` : "")) continue;
    // The dot is what keeps `evil-example.com` out of `*.example.com`. The
    // apex is not a subdomain of itself; an owner lists it separately.
    if (host.endsWith(`.${base}`) && host.length > base.length + 1) return true;
  }
  return false;
}

// ============================================
// Address buckets
// ============================================

/** Every address that cannot be read shares one bucket, and its limit. */
export const UNKNOWN_IP_BUCKET = "unknown";

function expandIpv6(address: string): number[] | null {
  const [head, tail, ...more] = address.split("::");
  if (more.length > 0 || head === undefined) return null;
  const groups = (part: string) => (part.length === 0 ? [] : part.split(":"));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const all = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  const words = all.map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN));
  return words.length === 8 && words.every((word) => !Number.isNaN(word)) ? words : null;
}

/**
 * The unit a per-address limit counts.
 *
 * An IPv4 address is its own bucket. An IPv6 address is reduced to its /64:
 * one subscriber is usually handed a whole /64 and can rotate through 2^64
 * addresses in it, so limiting each address separately limits nothing. An
 * IPv4 address written as IPv6 (`::ffff:a.b.c.d`, what a dual-stack socket
 * reports) is the IPv4 address.
 */
export function ipBucket(ip: string | null | undefined): string {
  if (typeof ip !== "string") return UNKNOWN_IP_BUCKET;
  let address = ip.trim().toLowerCase();
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);

  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return UNKNOWN_IP_BUCKET;

  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (dotted) {
    const [, prefix, v4] = dotted as unknown as [string, string, string];
    const [a, b, c, d] = v4.split(".").map(Number) as [number, number, number, number];
    address = `${prefix}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const words = expandIpv6(address);
  if (!words) return UNKNOWN_IP_BUCKET;

  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (mapped) {
    return `${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`;
  }
  return `${words
    .slice(0, 4)
    .map((word) => word.toString(16))
    .join(":")}::/64`;
}

/**
 * A bucket as it is written into limiter keys and session tokens: keyed, so
 * neither Redis nor a token a visitor holds contains an address anyone can
 * read back.
 */
export function hashBucket(bucket: string, secret: string): string {
  if (!secret || secret.length < 16) {
    throw new Error("hashBucket: secret must be at least 16 characters");
  }
  return createHmac("sha256", secret).update(`ip-bucket:${bucket}`).digest("base64url").slice(0, 22);
}
