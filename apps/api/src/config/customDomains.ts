/**
 * Configuration for custom domains (Pro plan): the edge proxy that terminates
 * TLS for customer hostnames, and the checker that observes DNS and
 * certificates.
 *
 * This module parses its OWN environment variables (like config/skills.ts) and
 * NEVER fails the boot. Custom domains need infrastructure that may not exist
 * yet - an edge app with its own addresses. Until every edge setting is
 * present and valid, `edge` is null and `unavailableReason` says why; the API
 * then answers 501 custom_domains_not_configured and the dashboard shows a
 * "not configured" banner. A half-set or malformed configuration is treated
 * exactly like an unset one, plus `error` naming the variable, so a typo reads
 * as "misconfigured" instead of half-working.
 *
 * Environment variables
 * ---------------------
 *
 * CUSTOM_DOMAIN_EDGE_HOSTNAME        (required to enable)
 *   The DNS name of the edge proxy, e.g. "edge.wheelsai.io". Customers point a
 *   CNAME at it. Must be a plain DNS name the platform controls.
 *
 * CUSTOM_DOMAIN_EDGE_IPV4            (comma list; at least one address in
 * CUSTOM_DOMAIN_EDGE_IPV6             IPV4 or IPV6 is required to enable)
 *   EVERY public address the edge answers on. Customers with an apex domain
 *   point A/AAAA records at them, and the checker calls a domain "routed" only
 *   when all of its addresses are in this set - so an address the edge
 *   hostname resolves to but that is missing here makes every CNAME customer
 *   read as misrouted. The certificate prober connects to these addresses and
 *   to nothing else. Private, loopback and reserved addresses are refused.
 *
 * CUSTOM_DOMAIN_ASK_TOKEN            (required to enable; >= 32 characters)
 *   Shared with the edge. The edge sends it when it asks the API whether it
 *   may obtain a certificate for a hostname. It travels in a URL, so it is
 *   deliberately separate from the forwarding secret below.
 *
 * CUSTOM_DOMAIN_EDGE_SECRET          (required to enable; >= 32 characters,
 *                                     different from the ask token)
 *   Shared with the edge. The edge sends it in a header on every request it
 *   forwards; only requests carrying it are routed by customer hostname. It
 *   also keys the per-domain proof the prober checks.
 *
 * CUSTOM_DOMAIN_DNS_SERVERS          (optional comma list of IP addresses)
 *   Recursive resolvers the checker queries, e.g. "1.1.1.1,8.8.8.8". Unset =
 *   the host's resolvers.
 *
 * CUSTOM_DOMAIN_CHECK_INTERVAL_MS    (default 60000; 0 disables the worker)
 *   How often the checker looks for domains whose next check is due.
 *
 * CUSTOM_DOMAIN_ROUTE_REFRESH_MS     (default 10000, range 1000..60000)
 *   How often the in-memory host routing table is reloaded.
 *
 * CUSTOM_DOMAIN_PROBE_TIMEOUT_MS     (default 20000, range 1000..120000)
 *   Wall-clock limit of one certificate probe. The first handshake for a new
 *   hostname waits while the edge obtains the certificate, so keep it long.
 *
 * CUSTOM_DOMAIN_PROBE_EXTRA_CA_PEM   (optional; refused when NODE_ENV=production)
 *   One or more PEM certificates the prober trusts IN ADDITION to the public
 *   roots, so a staging run can use the Let's Encrypt staging CA. In
 *   production the prober trusts public roots only: a certificate browsers
 *   would reject must never be recorded as valid.
 *
 * The three limits below protect what every organization shares: the edge's
 * one account with the certificate authority (Let's Encrypt allows 300 new
 * orders per account per 3 hours, counted even when validation fails) and the
 * checker's capacity. They are platform safety limits, not plan limits: the
 * plan table says only whether custom domains are included.
 *
 * CUSTOM_DOMAIN_MAX_PER_ORG          (default 25, range 1..10000)
 *   How many custom domains one organization may have, counting every row
 *   whatever its state. Creating one more answers 403 domain_limit_reached.
 *
 * CUSTOM_DOMAIN_ISSUANCE_ORG_LIMIT   (default 30, range 1..10000)
 *   How many times in 3 hours the edge may be told "yes, obtain a certificate"
 *   for one organization's hostnames that have no observed certificate yet.
 *
 * CUSTOM_DOMAIN_ISSUANCE_PLATFORM_LIMIT (default 200, range 1..10000)
 *   The same count across all organizations. Keep it below the certificate
 *   authority's account limit: renewals of existing certificates are made by
 *   the edge on its own and are not counted here.
 */

import { isIP } from "node:net";

import { classifyIp } from "../lib/ssrfGuard.js";

export interface CustomDomainEdgeConfig {
  /** CNAME target customers point subdomains at. */
  hostname: string;
  ipv4: string[];
  ipv6: string[];
  askToken: string;
  edgeSecret: string;
}

export interface CustomDomainConfig {
  /** The edge, or null while custom domains are not configured on this server. */
  edge: CustomDomainEdgeConfig | null;
  /** Why `edge` is null; null exactly when `edge` is set. */
  unavailableReason: string | null;
  /** Set when a variable was present but malformed (as opposed to unset). */
  error: string | null;
  checkIntervalMs: number;
  routeRefreshMs: number;
  dnsServers: string[];
  probeTimeoutMs: number;
  extraCaPem: string | null;
  limits: CustomDomainLimits;
}

/** Platform safety limits; see the header. */
export interface CustomDomainLimits {
  maxDomainsPerOrg: number;
  issuancePerOrg: number;
  issuancePlatform: number;
}

export const DEFAULT_DOMAIN_LIMITS: CustomDomainLimits = {
  maxDomainsPerOrg: 25,
  issuancePerOrg: 30,
  issuancePlatform: 200,
};

export const CUSTOM_DOMAINS_NOT_CONFIGURED =
  "Custom domains are not configured on this server: the edge proxy settings (CUSTOM_DOMAIN_EDGE_HOSTNAME, CUSTOM_DOMAIN_EDGE_IPV4/IPV6, CUSTOM_DOMAIN_ASK_TOKEN, CUSTOM_DOMAIN_EDGE_SECRET) are not set.";

const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_ROUTE_REFRESH_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
const MIN_SECRET_LENGTH = 32;

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

class Misconfigured extends Error {}

/** Empty strings in a .env file mean "unset", not "configured as empty". */
function read(source: Record<string, string | undefined>, name: string): string | undefined {
  const value = source[name]?.trim();
  return value ? value : undefined;
}

function list(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))];
}

function intInRange(
  source: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
  unit = " of milliseconds",
): number {
  const raw = read(source, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Misconfigured(`${name} must be a whole number${unit}`);
  const value = Number(raw);
  if (value < min || value > max) {
    throw new Misconfigured(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function edgeAddresses(
  source: Record<string, string | undefined>,
  name: string,
  version: 4 | 6,
): string[] {
  const addresses = list(read(source, name));
  for (const address of addresses) {
    if (isIP(address) !== version) {
      throw new Misconfigured(`${name} entry '${address}' is not an IPv${version} address`);
    }
    // The prober connects to these, and customers are told to point DNS at
    // them: neither makes sense for an address that is not publicly routable.
    if (classifyIp(address) !== "public") {
      throw new Misconfigured(`${name} entry '${address}' is not a public address`);
    }
  }
  return addresses;
}

function secret(source: Record<string, string | undefined>, name: string): string | undefined {
  const value = read(source, name);
  if (value !== undefined && value.length < MIN_SECRET_LENGTH) {
    throw new Misconfigured(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return value;
}

function parse(source: Record<string, string | undefined>): CustomDomainConfig {
  const checkIntervalMs = intInRange(
    source,
    "CUSTOM_DOMAIN_CHECK_INTERVAL_MS",
    DEFAULT_CHECK_INTERVAL_MS,
    0,
    3_600_000,
  );
  if (checkIntervalMs !== 0 && checkIntervalMs < 5_000) {
    throw new Misconfigured("CUSTOM_DOMAIN_CHECK_INTERVAL_MS must be 0 (disabled) or at least 5000");
  }
  const routeRefreshMs = intInRange(
    source,
    "CUSTOM_DOMAIN_ROUTE_REFRESH_MS",
    DEFAULT_ROUTE_REFRESH_MS,
    1_000,
    60_000,
  );
  const probeTimeoutMs = intInRange(
    source,
    "CUSTOM_DOMAIN_PROBE_TIMEOUT_MS",
    DEFAULT_PROBE_TIMEOUT_MS,
    1_000,
    120_000,
  );

  const limit = (name: string, fallback: number) => intInRange(source, name, fallback, 1, 10_000, "");
  const limits: CustomDomainLimits = {
    maxDomainsPerOrg: limit("CUSTOM_DOMAIN_MAX_PER_ORG", DEFAULT_DOMAIN_LIMITS.maxDomainsPerOrg),
    issuancePerOrg: limit("CUSTOM_DOMAIN_ISSUANCE_ORG_LIMIT", DEFAULT_DOMAIN_LIMITS.issuancePerOrg),
    issuancePlatform: limit(
      "CUSTOM_DOMAIN_ISSUANCE_PLATFORM_LIMIT",
      DEFAULT_DOMAIN_LIMITS.issuancePlatform,
    ),
  };

  const dnsServers = list(read(source, "CUSTOM_DOMAIN_DNS_SERVERS"));
  for (const server of dnsServers) {
    if (isIP(server) === 0) {
      throw new Misconfigured(`CUSTOM_DOMAIN_DNS_SERVERS entry '${server}' is not an IP address`);
    }
  }

  const extraCaPem = read(source, "CUSTOM_DOMAIN_PROBE_EXTRA_CA_PEM") ?? null;
  if (extraCaPem !== null) {
    if (read(source, "NODE_ENV") === "production") {
      throw new Misconfigured(
        "CUSTOM_DOMAIN_PROBE_EXTRA_CA_PEM is refused in production: the prober must trust public roots only",
      );
    }
    if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(extraCaPem)) {
      throw new Misconfigured("CUSTOM_DOMAIN_PROBE_EXTRA_CA_PEM is not a PEM certificate");
    }
  }

  const hostname = read(source, "CUSTOM_DOMAIN_EDGE_HOSTNAME")?.toLowerCase().replace(/\.$/, "");
  const ipv4 = edgeAddresses(source, "CUSTOM_DOMAIN_EDGE_IPV4", 4);
  const ipv6 = edgeAddresses(source, "CUSTOM_DOMAIN_EDGE_IPV6", 6);
  const askToken = secret(source, "CUSTOM_DOMAIN_ASK_TOKEN");
  const edgeSecret = secret(source, "CUSTOM_DOMAIN_EDGE_SECRET");

  const shared = { checkIntervalMs, routeRefreshMs, dnsServers, probeTimeoutMs, extraCaPem, limits };

  const anySet =
    hostname !== undefined ||
    ipv4.length > 0 ||
    ipv6.length > 0 ||
    askToken !== undefined ||
    edgeSecret !== undefined;
  if (!anySet) {
    return { edge: null, unavailableReason: CUSTOM_DOMAINS_NOT_CONFIGURED, error: null, ...shared };
  }

  // Partly set: name what is missing rather than run with half an edge.
  const missing = [
    hostname === undefined && "CUSTOM_DOMAIN_EDGE_HOSTNAME",
    ipv4.length === 0 && ipv6.length === 0 && "CUSTOM_DOMAIN_EDGE_IPV4 or CUSTOM_DOMAIN_EDGE_IPV6",
    askToken === undefined && "CUSTOM_DOMAIN_ASK_TOKEN",
    edgeSecret === undefined && "CUSTOM_DOMAIN_EDGE_SECRET",
  ].filter((name): name is string => typeof name === "string");
  if (missing.length > 0) {
    throw new Misconfigured(`the edge is only partly configured - missing ${missing.join(", ")}`);
  }

  if (!HOSTNAME.test(hostname!)) {
    throw new Misconfigured("CUSTOM_DOMAIN_EDGE_HOSTNAME is not a valid DNS name");
  }
  if (askToken === edgeSecret) {
    throw new Misconfigured(
      "CUSTOM_DOMAIN_ASK_TOKEN and CUSTOM_DOMAIN_EDGE_SECRET must be different values",
    );
  }

  return {
    edge: { hostname: hostname!, ipv4, ipv6, askToken: askToken!, edgeSecret: edgeSecret! },
    unavailableReason: null,
    error: null,
    ...shared,
  };
}

/**
 * Parses custom-domain configuration from an environment map. Never throws:
 * a malformed value yields `edge: null` with `error` and `unavailableReason`
 * naming the variable, and the worker interval set to 0.
 */
export function loadCustomDomainConfig(
  source: Record<string, string | undefined> = process.env,
): CustomDomainConfig {
  try {
    return parse(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      edge: null,
      unavailableReason: `Custom domains are misconfigured on this server: ${message}.`,
      error: message,
      checkIntervalMs: 0,
      routeRefreshMs: DEFAULT_ROUTE_REFRESH_MS,
      dnsServers: [],
      probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      extraCaPem: null,
      limits: DEFAULT_DOMAIN_LIMITS,
    };
  }
}

let cached: CustomDomainConfig | null = null;

/** Memoised view of the process environment. */
export function getCustomDomainConfig(): CustomDomainConfig {
  cached ??= loadCustomDomainConfig(process.env);
  return cached;
}

/** Test hook: forget the memoised configuration. */
export function resetCustomDomainConfigCache(): void {
  cached = null;
}
