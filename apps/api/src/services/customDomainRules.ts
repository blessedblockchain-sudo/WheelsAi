/**
 * Custom-domain rules. Pure: no I/O, no clock, no environment.
 *
 * Everything that decides what a custom domain IS lives here, so the worker,
 * the "check now" button, the edge's certificate question and the tests all
 * agree:
 *
 *   normalizeDomainInput        what a customer may register
 *   txtContainsToken            has the ownership record been published
 *   classifyRouting             do the domain's addresses all belong to the edge
 *   classifyProbeError          what a failed TLS handshake means
 *   decideCertificateIssuance   may the edge obtain a certificate for a host
 *   decideIssuanceBudget        ... and is there room left for one more order
 *   interleaveByOrganization    no organization fills a checker batch
 *   decideDomainTransition      the ONLY place a domain changes state, and the
 *                               only place "serving" (isActive) is derived
 *   decideEnabledChange,        the owner's switch and "new token" button,
 *   reverifyDecision            expressed through the same rule
 *   mapEdgeRequest              what a request on a customer hostname reaches
 *
 * The rule the whole module protects: a status is written only from something
 * that was observed. A resolver error or an unreachable edge is the absence of
 * an observation and changes nothing; a certificate is "active" only after a
 * handshake presented a valid one.
 */

import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

import { parseIpv6 } from "../lib/ssrfGuard.js";

// ============================================
// Vocabulary
// ============================================

export type VerificationStatus = "pending" | "verified" | "expired";
export type RoutingStatus = "pending" | "ok" | "misrouted" | "unresolvable";
export type SslStatus = "pending" | "provisioning" | "active" | "failed" | "expired";
export type PausedReason =
  | "disabled"
  | "plan_inactive"
  | "target_missing"
  | "verification_lost"
  | "dns_not_routed"
  | "certificate_invalid";

export const VERIFICATION_RECORD_PREFIX = "_wheels-verification";
/** Path the edge forwards for the prober's proof that a host reaches this API. */
export const DOMAIN_PROOF_PATH = "/.well-known/wheelsai-domain";
export const SSL_PROVIDER_EDGE = "edge_acme";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A claim that never verifies expires after this long. */
export const PENDING_EXPIRY_MS = 14 * DAY;
/** A verified domain whose TXT record disappears keeps serving this long. */
export const VERIFICATION_GRACE_MS = 72 * HOUR;
/** A domain that qualifies for a certificate but never shows one is failed after this. */
export const PROVISIONING_GIVE_UP_MS = 7 * DAY;
/** Consecutive failed handshakes before an active certificate is called invalid. */
export const SSL_FAILURE_THRESHOLD = 3;
/** Consecutive not-ok DNS observations before a routed domain is called unrouted. */
export const ROUTING_FAILURE_THRESHOLD = 2;
/** A certificate this close to expiry was not renewed on schedule. */
export const SSL_EXPIRING_SOON_MS = 14 * DAY;

// ============================================
// Names
// ============================================

/**
 * Suffixes no customer can own or that only resolve inside a network. A
 * certificate request for one would fail, and several of them (the platform
 * hosts' own suffixes, `.internal`) would be a way to aim the edge at
 * infrastructure.
 */
export const RESERVED_SUFFIXES = [
  "fly.dev",
  "flycast",
  "internal",
  "netlify.app",
  "local",
  "localhost",
  "localdomain",
  "lan",
  "home",
  "corp",
  "test",
  "example",
  "invalid",
  "onion",
  "arpa",
] as const;

export interface ReservedHostSources {
  /** URLs or comma lists of URLs/origins (PUBLIC_API_URL, PUBLIC_WEB_URL, CORS_ORIGIN). */
  urls?: Array<string | undefined>;
  /** Bare host names (COOKIE_DOMAIN, the edge hostname, OPENCLAW_SUBDOMAIN_BASE). */
  hosts?: Array<string | undefined>;
}

/** The platform's own hosts, which (with their subdomains) can never be claimed. */
export function buildReservedHosts(sources: ReservedHostSources): string[] {
  const out = new Set<string>();
  const add = (host: string) => {
    const clean = host.trim().toLowerCase().replace(/^\./, "").replace(/\.$/, "");
    // A bare label ("localhost") or an IP can never pass normalisation anyway.
    if (clean.includes(".") && isIP(clean) === 0) out.add(clean);
  };
  for (const value of sources.urls ?? []) {
    for (const part of (value ?? "").split(",")) {
      const candidate = part.trim();
      if (!candidate) continue;
      try {
        add(new URL(candidate).hostname);
      } catch {
        // Not a URL: nothing to reserve.
      }
    }
  }
  for (const host of sources.hosts ?? []) {
    if (host?.trim()) add(host);
  }
  return [...out];
}

export type NormalizeDomainResult =
  | { ok: true; domain: string }
  | { ok: false; error: "invalid_domain" | "reserved_domain"; message: string };

const invalid = (message: string): NormalizeDomainResult => ({
  ok: false,
  error: "invalid_domain",
  message,
});

function isSameOrSubdomain(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/**
 * Turns what a customer typed into the one spelling a domain is stored and
 * looked up under (lowercase, no trailing dot, punycode), or says why it
 * cannot be a custom domain.
 */
export function normalizeDomainInput(
  input: unknown,
  options: { reservedHosts?: readonly string[] } = {},
): NormalizeDomainResult {
  if (typeof input !== "string") return invalid("Enter a domain name, like api.example.com.");
  let name = input.trim().toLowerCase();
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (!name) return invalid("Enter a domain name, like api.example.com.");

  if (name.includes("*")) {
    return invalid("Wildcard domains are not supported. Add each hostname separately.");
  }
  if (/[\s/:@?#\\[\]]/.test(name)) {
    return invalid("Enter only the domain name, without a scheme, port or path.");
  }
  if (isIP(name) !== 0) return invalid("An IP address cannot be a custom domain.");
  if (name.includes("_")) return invalid("Domain names cannot contain underscores.");

  // Internationalised names are stored (and resolved, and certified) in
  // their ASCII form; domainToASCII answers "" for a name it cannot encode.
  const ascii = domainToASCII(name);
  if (!ascii) return invalid("That is not a valid domain name.");
  name = ascii.toLowerCase();

  if (name.length > 253) return invalid("Domain names are at most 253 characters.");
  const labels = name.split(".");
  if (labels.length < 2) return invalid("Enter a full domain name, like api.example.com.");
  for (const label of labels) {
    if (label.length === 0) return invalid("Domain names cannot contain empty labels.");
    if (label.length > 63) return invalid("Each part of a domain name is at most 63 characters.");
    if (!/^[a-z0-9-]+$/.test(label) || label.startsWith("-") || label.endsWith("-")) {
      return invalid("Domain names may contain only letters, digits and inner hyphens.");
    }
  }
  if (/^\d+$/.test(labels[labels.length - 1]!)) {
    return invalid("That is not a valid domain name.");
  }

  for (const suffix of RESERVED_SUFFIXES) {
    if (isSameOrSubdomain(name, suffix)) {
      return {
        ok: false,
        error: "reserved_domain",
        message: `Names ending in .${suffix} cannot be used as a custom domain.`,
      };
    }
  }
  for (const host of options.reservedHosts ?? []) {
    if (isSameOrSubdomain(name, host)) {
      return {
        ok: false,
        error: "reserved_domain",
        message: "That name belongs to the platform and cannot be used as a custom domain.",
      };
    }
  }

  return { ok: true, domain: name };
}

export function verificationRecordName(domain: string): string {
  return `${VERIFICATION_RECORD_PREFIX}.${domain}`;
}

// ============================================
// DNS observations
// ============================================

export type TxtObservation =
  | { kind: "found"; records: string[][] }
  | { kind: "absent" }
  | { kind: "transient"; code: string };

export type AddressObservation =
  | { kind: "found"; addresses: string[] }
  | { kind: "absent" }
  | { kind: "transient"; code: string };

/**
 * One TXT record arrives as chunks of up to 255 bytes that belong together;
 * the record's value is their concatenation.
 */
export function txtContainsToken(records: readonly (readonly string[])[], token: string): boolean {
  if (!token) return false;
  return records.some((chunks) => chunks.join("").trim() === token);
}

/**
 * Only a name or record type that authoritatively does not exist is "absent".
 * Everything else (SERVFAIL, timeout, refused, cancelled) says nothing about
 * the customer's DNS and must not move a domain.
 */
export function classifyDnsError(error: unknown): "absent" | "transient" {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOTFOUND" || code === "ENODATA" ? "absent" : "transient";
}

export function dnsErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : "EUNKNOWN";
}

export interface EdgeAddresses {
  ipv4: readonly string[];
  ipv6: readonly string[];
}

/** IPv6 compares by bytes: `2A09:8280:1::1` and `2a09:8280:1:0:0:0:0:1` are one address. */
function addressKey(address: string): string | null {
  const version = isIP(address);
  if (version === 4) return `4:${address}`;
  if (version === 6) {
    const bytes = parseIpv6(address);
    return bytes ? `6:${Buffer.from(bytes).toString("hex")}` : null;
  }
  return null;
}

export interface RoutingVerdict {
  status: Exclude<RoutingStatus, "pending">;
  /** Observed addresses that are not the edge. */
  offEdge: string[];
}

/**
 * A domain is routed only when EVERY address it resolves to is the edge: one
 * stray A or AAAA record sends some visitors elsewhere, and a CDN-proxied
 * record sends all of them elsewhere.
 */
export function classifyRouting(addresses: readonly string[], edge: EdgeAddresses): RoutingVerdict {
  if (addresses.length === 0) return { status: "unresolvable", offEdge: [] };
  const edgeKeys = new Set(
    [...edge.ipv4, ...edge.ipv6].map(addressKey).filter((k): k is string => k !== null),
  );
  const offEdge = addresses.filter((address) => {
    const key = addressKey(address);
    return key === null || !edgeKeys.has(key);
  });
  return { status: offEdge.length === 0 ? "ok" : "misrouted", offEdge };
}

export interface CaaRecordLike {
  issue?: string;
  issuewild?: string;
}

/**
 * True when CAA records exist that name certificate authorities and none of
 * them is `issuer`. No `issue` records at all means any authority may issue.
 */
export function caaForbidsIssuer(records: readonly CaaRecordLike[], issuer: string): boolean {
  const issuers = records
    .filter((r) => typeof r.issue === "string")
    .map((r) => r.issue!.split(";")[0]!.trim().toLowerCase());
  return issuers.length > 0 && !issuers.includes(issuer.toLowerCase());
}

// ============================================
// TLS observations
// ============================================

export interface ObservedCertificate {
  issuer: string;
  validFrom: Date;
  validTo: Date;
  /** SHA-256 fingerprint, colon-separated upper-case hex as Node reports it. */
  fingerprint256: string;
  altNames: string[];
}

export type ProofResult =
  /** The edge forwarded the request to this API, which answered with this domain's proof. */
  | "ok"
  /** A response came back, but not this domain's proof. */
  | "mismatch"
  /** The edge answered 502/503/504 or went quiet: it could not reach the API. */
  | "upstream_unavailable"
  | "not_requested";

export type TlsProbeOutcome =
  | { kind: "valid"; certificate: ObservedCertificate; proof: ProofResult }
  /** A certificate was presented and failed verification (expired, wrong name, untrusted). */
  | { kind: "certificate_invalid"; code: string; message: string }
  /** The edge refused the handshake (a TLS alert): it has no certificate for the name. */
  | { kind: "handshake_refused"; code: string; message: string }
  /** No conclusion about the certificate: TCP failure or timeout. */
  | { kind: "unreachable"; code: string; message: string };

const CERTIFICATE_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_REJECTED",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_CHAIN_TOO_LONG",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "HOSTNAME_MISMATCH",
]);

/**
 * What a failed handshake says. Anything not recognised is "unreachable":
 * the conservative reading, because unreachable never changes a domain.
 */
export function classifyProbeError(
  code: string | undefined,
): "certificate_invalid" | "handshake_refused" | "unreachable" {
  if (!code) return "unreachable";
  if (CERTIFICATE_ERROR_CODES.has(code)) return "certificate_invalid";
  // OpenSSL-level failures: alerts from the peer, protocol/version mismatches.
  if (code.startsWith("ERR_SSL_") || code === "EPROTO") return "handshake_refused";
  return "unreachable";
}

/** The proof a verified domain's well-known path answers with. */
export function computeDomainProof(edgeSecret: string, domainId: string): string {
  return createHmac("sha256", edgeSecret).update(domainId).digest("hex");
}

// ============================================
// May the edge obtain a certificate?
// ============================================

export interface IssuanceFacts {
  verificationStatus: string;
  enabled: boolean;
  routingStatus: string;
  entitled: boolean;
  targetExists: boolean;
}

export type IssuanceDenial =
  | "not_verified"
  | "disabled"
  | "dns_not_routed"
  | "plan_inactive"
  | "target_missing";

export type IssuanceDecision = { allowed: true } | { allowed: false; reason: IssuanceDenial };

/**
 * A certificate is requested only for a domain that would be served. Routing
 * must be observed ok first: a validation attempt for a name that does not
 * point at the edge fails, and failures are rate-limited by the authority.
 */
export function decideCertificateIssuance(facts: IssuanceFacts): IssuanceDecision {
  if (facts.verificationStatus !== "verified") return { allowed: false, reason: "not_verified" };
  if (!facts.enabled) return { allowed: false, reason: "disabled" };
  if (facts.routingStatus !== "ok") return { allowed: false, reason: "dns_not_routed" };
  if (!facts.entitled) return { allowed: false, reason: "plan_inactive" };
  if (!facts.targetExists) return { allowed: false, reason: "target_missing" };
  return { allowed: true };
}

// ============================================
// Issuance budget
// ============================================

/**
 * Every "yes" to the edge about a name with no certificate makes it open an
 * order on the platform's ONE account with the certificate authority, and the
 * authority counts orders per account whether or not validation succeeds
 * (Let's Encrypt: 300 per 3 hours). An organization that verifies many names
 * could spend all of it, and then nobody's certificate is issued or renewed.
 * So a "yes" is granted from a budget: per name, per organization, and for
 * the platform as a whole.
 */
export const ISSUANCE_WINDOW_MS = 3 * HOUR;
/** The authority refuses a hostname after 5 failed validations in an hour anyway. */
export const ISSUANCE_NAME_WINDOW_MS = HOUR;
export const ISSUANCE_PER_NAME = 5;

export interface IssuanceBudgetLimits {
  /** Grants per organization per ISSUANCE_WINDOW_MS. */
  issuancePerOrg: number;
  /** Grants across all organizations per ISSUANCE_WINDOW_MS. */
  issuancePlatform: number;
}

/** Grants already made, counted inside the windows above. */
export interface IssuanceGrantCounts {
  name: number;
  organization: number;
  platform: number;
}

export type IssuanceBudgetDenial =
  | "issuance_budget_domain"
  | "issuance_budget_organization"
  | "issuance_budget_platform";

export type IssuanceBudgetDecision = { granted: true } | { granted: false; reason: IssuanceBudgetDenial };

/**
 * A name whose certificate was observed on the wire needs no budget: the edge
 * holds that certificate and answers from it, and renewing it is the edge's
 * own business. Everything else is a new order.
 */
export function needsIssuanceBudget(row: { sslStatus: string }): boolean {
  return row.sslStatus !== "active";
}

export function decideIssuanceBudget(
  counts: IssuanceGrantCounts,
  limits: IssuanceBudgetLimits,
): IssuanceBudgetDecision {
  // Narrowest first, so the answer names whose budget is spent.
  if (counts.name >= ISSUANCE_PER_NAME) return { granted: false, reason: "issuance_budget_domain" };
  if (counts.organization >= limits.issuancePerOrg) {
    return { granted: false, reason: "issuance_budget_organization" };
  }
  if (counts.platform >= limits.issuancePlatform) return { granted: false, reason: "issuance_budget_platform" };
  return { granted: true };
}

// ============================================
// Checker fairness
// ============================================

/** The most rows of one organization a single checker pass looks at. */
export const CHECK_BATCH_PER_ORG = 10;

/**
 * One checker batch out of each organization's due rows: one row from every
 * organization in turn, in the order given, until the batch is full. An
 * organization with a thousand due rows gets the same share of a pass as an
 * organization with one, so it delays only itself.
 */
export function interleaveByOrganization<T>(groups: readonly (readonly T[])[], limit: number): T[] {
  const batch: T[] = [];
  const longest = groups.reduce((max, group) => Math.max(max, group.length), 0);
  for (let round = 0; round < longest && batch.length < limit; round++) {
    for (const group of groups) {
      if (batch.length >= limit) break;
      if (round < group.length) batch.push(group[round]!);
    }
  }
  return batch;
}

// ============================================
// DNS instructions
// ============================================

export interface DnsRecordInstruction {
  name: string;
  type: "TXT" | "CNAME" | "A" | "AAAA";
  value: string;
}

export interface DnsInstructions {
  txtRecord: DnsRecordInstruction;
  /** Null while the edge is not configured: there is nothing true to point at. */
  cnameRecord: DnsRecordInstruction | null;
  aRecords: DnsRecordInstruction[];
  aaaaRecords: DnsRecordInstruction[];
  /** Which routing record fits this name; null while the edge is not configured. */
  recommended: "cname" | "a" | null;
}

export function buildDnsInstructions(
  domain: { domain: string; verificationToken: string; isApex: boolean | null },
  edge: (EdgeAddresses & { hostname: string }) | null,
): DnsInstructions {
  const txtRecord: DnsRecordInstruction = {
    name: verificationRecordName(domain.domain),
    type: "TXT",
    value: domain.verificationToken,
  };
  if (!edge) {
    return { txtRecord, cnameRecord: null, aRecords: [], aaaaRecords: [], recommended: null };
  }
  // DNS forbids a CNAME at a zone apex. Until the SOA check has run, a
  // two-label name is the best guess at "apex".
  const apex = domain.isApex ?? domain.domain.split(".").length === 2;
  return {
    txtRecord,
    cnameRecord: { name: domain.domain, type: "CNAME", value: edge.hostname },
    aRecords: edge.ipv4.map((value) => ({ name: domain.domain, type: "A" as const, value })),
    aaaaRecords: edge.ipv6.map((value) => ({ name: domain.domain, type: "AAAA" as const, value })),
    recommended: apex ? "a" : "cname",
  };
}

// ============================================
// State transitions
// ============================================

/** The columns a check reads. Never includes certificate key material. */
export interface CustomDomainCheckRow {
  id: string;
  orgId: string;
  domain: string;
  targetType: string;
  targetId: string;
  verificationToken: string;
  verificationStatus: string;
  verificationError: string | null;
  verifiedDomain: string | null;
  verifiedAt: Date | null;
  verificationStartedAt: Date;
  verificationLostAt: Date | null;
  routingStatus: string;
  routingFailures: number;
  routingError: string | null;
  observedAddresses: string[];
  isApex: boolean | null;
  sslStatus: string;
  sslFailures: number;
  sslProvisioningSince: Date | null;
  sslExpiresAt: Date | null;
  sslFingerprint256: string | null;
  sslError: string | null;
  enabled: boolean;
  isActive: boolean;
  pausedReason: string | null;
}

/** What one check found out. Each field is an observation or says there was none. */
export interface DomainObservation {
  txt: TxtObservation;
  addresses: AddressObservation;
  /** Null = not looked up, or the lookup was inconclusive. */
  isApex: boolean | null;
  entitled: boolean;
  targetExists: boolean;
  /** Null = no handshake was attempted, or its result is being disregarded. */
  probe: TlsProbeOutcome | null;
  /** Set when CAA records were found that do not allow the edge's authority. */
  caaDiagnostic?: string | null;
}

export interface CustomDomainPatch {
  lastCheckedAt?: Date;
  nextCheckAt?: Date | null;
  verificationStatus?: VerificationStatus;
  verifiedAt?: Date;
  verifiedDomain?: string | null;
  verificationError?: string | null;
  verificationLostAt?: Date | null;
  routingStatus?: RoutingStatus;
  routingFailures?: number;
  routingCheckedAt?: Date;
  routingError?: string | null;
  observedAddresses?: string[];
  isApex?: boolean;
  sslStatus?: SslStatus;
  sslProvider?: string | null;
  sslExpiresAt?: Date | null;
  sslValidFrom?: Date | null;
  sslIssuer?: string | null;
  sslFingerprint256?: string | null;
  sslCheckedAt?: Date | null;
  sslError?: string | null;
  sslFailures?: number;
  sslProvisioningSince?: Date | null;
  isActive?: boolean;
  pausedReason?: PausedReason | null;
}

export interface DomainEventInput {
  eventType: string;
  message: string;
  previousStatus?: string;
  newStatus?: string;
  details?: Record<string, unknown>;
}

export interface DomainDecision {
  patch: CustomDomainPatch;
  /** One entry per state CHANGE; a check that changes nothing logs nothing. */
  events: DomainEventInput[];
  nextCheckAt: Date | null;
  isActive: boolean;
  pausedReason: PausedReason | null;
  verificationStatus: VerificationStatus;
  routingStatus: RoutingStatus;
  sslStatus: SslStatus;
}

export const CLAIMED_ELSEWHERE_MESSAGE =
  "This domain is already verified by another organization, so it cannot be verified here.";

function verificationOf(row: Pick<CustomDomainCheckRow, "verificationStatus">): VerificationStatus {
  // 'failed' was written by earlier releases for resolver errors; it only
  // ever meant "still waiting".
  if (row.verificationStatus === "verified" || row.verificationStatus === "expired") {
    return row.verificationStatus;
  }
  return "pending";
}

function routingOf(row: Pick<CustomDomainCheckRow, "routingStatus">): RoutingStatus {
  const s = row.routingStatus;
  return s === "ok" || s === "misrouted" || s === "unresolvable" ? s : "pending";
}

function sslOf(row: Pick<CustomDomainCheckRow, "sslStatus">): SslStatus {
  const s = row.sslStatus;
  return s === "provisioning" || s === "active" || s === "failed" || s === "expired" ? s : "pending";
}

interface Step<S> {
  status: S;
  patch: CustomDomainPatch;
  events: DomainEventInput[];
}

function resolveVerification(row: CustomDomainCheckRow, txt: TxtObservation, now: Date): Step<VerificationStatus> {
  const current = verificationOf(row);
  // No answer from DNS is not an answer about the record.
  if (txt.kind === "transient") return { status: current, patch: {}, events: [] };

  const recordName = verificationRecordName(row.domain);
  const matches = txt.kind === "found" && txtContainsToken(txt.records, row.verificationToken);

  if (current !== "verified") {
    if (matches) {
      return {
        status: "verified",
        patch: {
          verificationStatus: "verified",
          verifiedAt: now,
          // Acquiring the claim: unique across organisations. If another
          // organisation holds it the write fails and nothing here applies.
          verifiedDomain: row.domain,
          verificationError: null,
          verificationLostAt: null,
        },
        events: [
          {
            eventType: "verification_success",
            message: `Ownership verified: the TXT record at ${recordName} matches.`,
            previousStatus: current,
            newStatus: "verified",
          },
        ],
      };
    }
    if (current === "expired") return { status: "expired", patch: {}, events: [] };

    if (now.getTime() - row.verificationStartedAt.getTime() >= PENDING_EXPIRY_MS) {
      return {
        status: "expired",
        patch: {
          verificationStatus: "expired",
          verificationError:
            "The domain was not verified within 14 days. Publish the TXT record and check again.",
        },
        events: [
          {
            eventType: "verification_expired",
            message: "Not verified within 14 days; the claim expired.",
            previousStatus: "pending",
            newStatus: "expired",
          },
        ],
      };
    }
    const error =
      txt.kind === "found"
        ? `A TXT record exists at ${recordName}, but its value does not match the verification token.`
        : `No TXT record was found at ${recordName}.`;
    return {
      status: "pending",
      patch: row.verificationError === error ? {} : { verificationError: error },
      events: [],
    };
  }

  if (matches) {
    // "Verified" and "holds the claim" are one fact. A row that is verified
    // without the claim (written before the claim existed) acquires it here,
    // or is told another organisation has it.
    const claim: CustomDomainPatch = row.verifiedDomain === row.domain ? {} : { verifiedDomain: row.domain };
    if (row.verificationLostAt === null) return { status: "verified", patch: claim, events: [] };
    return {
      status: "verified",
      patch: { ...claim, verificationLostAt: null, verificationError: null },
      events: [
        {
          eventType: "verification_restored",
          message: `The TXT record at ${recordName} is back.`,
        },
      ],
    };
  }

  if (row.verificationLostAt === null) {
    const deadline = new Date(now.getTime() + VERIFICATION_GRACE_MS);
    return {
      status: "verified",
      patch: {
        verificationLostAt: now,
        verificationError: `The TXT record at ${recordName} is missing. The domain keeps serving until ${deadline.toISOString()}; restore the record to keep it.`,
      },
      events: [
        {
          eventType: "verification_lost",
          message: `The TXT record at ${recordName} is missing. The domain keeps serving for 72 hours.`,
          details: { servingUntil: deadline.toISOString() },
        },
      ],
    };
  }

  if (now.getTime() - row.verificationLostAt.getTime() < VERIFICATION_GRACE_MS) {
    return { status: "verified", patch: {}, events: [] };
  }
  return {
    status: "expired",
    patch: {
      verificationStatus: "expired",
      // Releasing the claim: the name is free for whoever can prove it now.
      verifiedDomain: null,
      verificationError: `The TXT record at ${recordName} was missing for 72 hours, so verification expired. Publish it again and check the domain to restore it.`,
    },
    events: [
      {
        eventType: "verification_expired",
        message: "The TXT record was missing for 72 hours; verification expired and the domain stopped serving.",
        previousStatus: "verified",
        newStatus: "expired",
      },
    ],
  };
}

function sameAddresses(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function resolveRouting(
  row: CustomDomainCheckRow,
  observed: AddressObservation,
  edge: EdgeAddresses,
  now: Date,
): Step<RoutingStatus> {
  const current = routingOf(row);
  if (observed.kind === "transient") return { status: current, patch: {}, events: [] };

  const addresses = observed.kind === "found" ? [...observed.addresses].sort() : [];
  const verdict = classifyRouting(addresses, edge);
  const patch: CustomDomainPatch = { routingCheckedAt: now };
  if (!sameAddresses(addresses, row.observedAddresses)) patch.observedAddresses = addresses;

  if (verdict.status === "ok") {
    if (row.routingFailures !== 0) patch.routingFailures = 0;
    if (row.routingError !== null) patch.routingError = null;
    if (current === "ok") return { status: "ok", patch, events: [] };
    patch.routingStatus = "ok";
    return {
      status: "ok",
      patch,
      events: [
        {
          eventType: "routing_ok",
          message: `DNS for ${row.domain} points at the edge.`,
          previousStatus: current,
          newStatus: "ok",
          details: { addresses },
        },
      ],
    };
  }

  const error =
    verdict.status === "unresolvable"
      ? `${row.domain} has no A, AAAA or CNAME record.`
      : `${row.domain} resolves to ${verdict.offEdge.join(", ")}, which is not the edge. Remove the other records; if a CDN proxies the record, switch it to DNS only.`;
  if (row.routingError !== error) patch.routingError = error;

  if (current === "ok") {
    // One bad answer (a resolver hiccup, a half-propagated change) must not
    // take a live domain down; the next check is scheduled minutes away.
    const failures = row.routingFailures + 1;
    patch.routingFailures = failures;
    if (failures < ROUTING_FAILURE_THRESHOLD) return { status: "ok", patch, events: [] };
    patch.routingStatus = verdict.status;
    return {
      status: verdict.status,
      patch,
      events: [
        {
          eventType: "routing_lost",
          message: error,
          previousStatus: "ok",
          newStatus: verdict.status,
          details: { addresses },
        },
      ],
    };
  }

  if (current !== verdict.status) patch.routingStatus = verdict.status;
  return { status: verdict.status, patch, events: [] };
}

function describeProbeFailure(
  outcome: Exclude<TlsProbeOutcome, { kind: "valid" }>,
  caaDiagnostic: string | null | undefined,
): string {
  const base =
    outcome.kind === "certificate_invalid"
      ? `The certificate the edge presented is not valid (${outcome.code}).`
      : `The edge has no certificate for this domain yet (${outcome.code}).`;
  return caaDiagnostic ? `${base} ${caaDiagnostic}` : base;
}

const SSL_RESET: CustomDomainPatch = {
  sslStatus: "pending",
  sslProvider: null,
  sslExpiresAt: null,
  sslValidFrom: null,
  sslIssuer: null,
  sslFingerprint256: null,
  sslCheckedAt: null,
  sslError: null,
  sslFailures: 0,
  sslProvisioningSince: null,
};

function resolveSsl(
  row: CustomDomainCheckRow,
  obs: DomainObservation,
  verification: VerificationStatus,
  routing: RoutingStatus,
  now: Date,
): Step<SslStatus> {
  const current = sslOf(row);
  const events: DomainEventInput[] = [];

  if (verification !== "verified") {
    // Nothing is observing this certificate any more; a stale "active" would
    // be a claim nobody is checking.
    if (current === "pending") return { status: "pending", patch: {}, events };
    return { status: "pending", patch: { ...SSL_RESET }, events };
  }
  if (routing !== "ok") {
    // Waiting for DNS again. A certificate that WAS observed keeps its record
    // (with its sslCheckedAt); serving is paused by the routing state.
    if (current !== "provisioning") return { status: current, patch: {}, events };
    return {
      status: "pending",
      patch: { sslStatus: "pending", sslProvisioningSince: null, sslFailures: 0, sslError: null },
      events,
    };
  }

  const eligible = obs.entitled && obs.targetExists && row.enabled;
  let status = current;
  const patch: CustomDomainPatch = {};
  let provisioningSince = row.sslProvisioningSince;

  if (status === "pending" && eligible) {
    status = "provisioning";
    provisioningSince = now;
    patch.sslStatus = "provisioning";
    patch.sslProvisioningSince = now;
    patch.sslFailures = 0;
    events.push({
      eventType: "ssl_provisioning",
      message: "The domain is verified and routed; waiting for the edge to present a certificate.",
      previousStatus: "pending",
      newStatus: "provisioning",
    });
  }

  const probe = obs.probe;
  if (probe === null) return { status, patch, events };

  if (probe.kind === "valid" && (probe.proof === "ok" || probe.proof === "not_requested")) {
    const cert = probe.certificate;
    const renewed = current === "active" && row.sslFingerprint256 !== cert.fingerprint256;
    Object.assign(patch, {
      sslStatus: "active",
      sslProvider: SSL_PROVIDER_EDGE,
      sslIssuer: cert.issuer,
      sslValidFrom: cert.validFrom,
      sslExpiresAt: cert.validTo,
      sslFingerprint256: cert.fingerprint256,
      sslCheckedAt: now,
      sslError: null,
      sslFailures: 0,
      sslProvisioningSince: null,
    } satisfies CustomDomainPatch);
    if (current !== "active" || renewed) {
      events.push({
        eventType: renewed ? "ssl_renewed" : "ssl_observed",
        message: renewed
          ? `A renewed certificate was observed, valid until ${cert.validTo.toISOString()}.`
          : `A valid certificate issued by ${cert.issuer} was observed, valid until ${cert.validTo.toISOString()}.`,
        previousStatus: current,
        newStatus: "active",
        details: {
          issuer: cert.issuer,
          validFrom: cert.validFrom.toISOString(),
          validTo: cert.validTo.toISOString(),
          fingerprint256: cert.fingerprint256,
        },
      });
    }
    return { status: "active", patch, events };
  }

  // From here the handshake did not show a servable certificate.
  let lastError: string | null = null;
  if (probe.kind === "certificate_invalid" || probe.kind === "handshake_refused") {
    const failures = row.sslFailures + 1;
    lastError = describeProbeFailure(probe, obs.caaDiagnostic);
    patch.sslFailures = failures;
    patch.sslCheckedAt = now;
    patch.sslError = lastError;
    if (status === "active" && failures >= SSL_FAILURE_THRESHOLD) {
      status = probe.code === "CERT_HAS_EXPIRED" ? "expired" : "failed";
      patch.sslStatus = status;
      events.push({
        eventType: "ssl_invalid",
        message: lastError,
        previousStatus: "active",
        newStatus: status,
        details: { code: probe.code },
      });
    }
  } else if (probe.kind === "valid") {
    lastError =
      probe.proof === "upstream_unavailable"
        ? "The certificate is valid, but the edge could not reach the API."
        : "The certificate is valid, but requests for this domain did not reach the API.";
    // A handshake was made and this is what it showed, so the owner is told.
    // The certificate itself is not recorded: one that does not lead to this
    // API (a CDN in front, another host on the same address) is not the
    // domain's certificate here. An active domain keeps its record; one bad
    // answer from the API behind the edge says nothing about its certificate.
    if (status !== "active") {
      patch.sslCheckedAt = now;
      patch.sslError = lastError;
    }
  } else {
    lastError = `The edge could not be reached (${probe.code}).`;
  }

  if (
    status === "provisioning" &&
    provisioningSince !== null &&
    now.getTime() - provisioningSince.getTime() >= PROVISIONING_GIVE_UP_MS
  ) {
    status = "failed";
    patch.sslStatus = "failed";
    patch.sslCheckedAt = now;
    patch.sslError = `No valid certificate was observed within 7 days. Last result: ${lastError}`;
    events.push({
      eventType: "ssl_invalid",
      message: patch.sslError,
      previousStatus: "provisioning",
      newStatus: "failed",
    });
  }

  return { status, patch, events };
}

function derivePausedReason(input: {
  row: CustomDomainCheckRow;
  verification: VerificationStatus;
  routing: RoutingStatus;
  ssl: SslStatus;
  entitled: boolean;
  targetExists: boolean;
}): PausedReason | null {
  const { row, verification, routing, ssl } = input;
  if (!row.enabled) return "disabled";
  if (verification !== "verified") {
    // A domain that was never verified is not paused, it is not set up yet.
    return verification === "expired" && row.verifiedAt !== null ? "verification_lost" : null;
  }
  if (!input.entitled) return "plan_inactive";
  if (!input.targetExists) return "target_missing";
  if (routing !== "ok") return "dns_not_routed";
  if (ssl === "failed" || ssl === "expired") return "certificate_invalid";
  return null;
}

function nextCheckDelay(input: {
  row: CustomDomainCheckRow;
  patch: CustomDomainPatch;
  verification: VerificationStatus;
  routing: RoutingStatus;
  ssl: SslStatus;
  entitled: boolean;
  targetExists: boolean;
  now: Date;
}): number | null {
  const { row, patch, verification, routing, ssl, now } = input;
  if (verification === "expired") return null;
  if (verification === "pending") {
    const age = now.getTime() - row.verificationStartedAt.getTime();
    return age < HOUR ? 2 * MINUTE : 30 * MINUTE;
  }

  const delays: number[] = [];
  const lostAt = patch.verificationLostAt !== undefined ? patch.verificationLostAt : row.verificationLostAt;
  // In grace: look hourly so the record's return, or the deadline, is noticed.
  if (lostAt !== null) delays.push(HOUR);

  if (!input.entitled || !input.targetExists) {
    delays.push(HOUR);
  } else if (!row.enabled) {
    delays.push(6 * HOUR);
  } else if (routing !== "ok") {
    const verifiedAt = patch.verifiedAt ?? row.verifiedAt ?? now;
    const age = now.getTime() - verifiedAt.getTime();
    delays.push(age < HOUR ? 2 * MINUTE : age < DAY ? 15 * MINUTE : HOUR);
  } else {
    // A routed domain with one bad DNS answer on record: confirm it soon.
    if ((patch.routingFailures ?? row.routingFailures) > 0) delays.push(2 * MINUTE);

    if (ssl === "provisioning") {
      // Each check is a handshake, and a handshake can start an issuance
      // attempt. The authority allows 5 failed validations per name per hour;
      // this schedule makes at most 4 checks in any hour.
      const since = patch.sslProvisioningSince ?? row.sslProvisioningSince ?? now;
      const age = now.getTime() - since.getTime();
      delays.push(age < 2 * MINUTE ? 2 * MINUTE : age < 7 * MINUTE ? 5 * MINUTE : age < DAY ? 20 * MINUTE : HOUR);
    } else if (ssl === "active") {
      const failures = patch.sslFailures ?? row.sslFailures;
      const expiresAt = patch.sslExpiresAt !== undefined ? patch.sslExpiresAt : row.sslExpiresAt;
      if (failures > 0) delays.push(5 * MINUTE);
      else if (expiresAt !== null && expiresAt.getTime() - now.getTime() < SSL_EXPIRING_SOON_MS) delays.push(HOUR);
      else delays.push(6 * HOUR);
    } else {
      // failed / expired, or pending while not eligible.
      delays.push(30 * MINUTE);
    }
  }
  return Math.min(...delays);
}

/**
 * Whether this check should make a TLS handshake. Only for a domain that was
 * ALREADY stored as verified and routed and still is: the edge decides whether
 * to obtain a certificate from the stored row, so a handshake made in the same
 * check that verifies a domain would only be refused.
 */
export function wantsTlsProbe(
  row: CustomDomainCheckRow,
  obs: Omit<DomainObservation, "probe">,
  edge: EdgeAddresses,
  now: Date,
): boolean {
  if (verificationOf(row) !== "verified" || row.verifiedDomain !== row.domain) return false;
  if (routingOf(row) !== "ok") return false;
  if (!row.enabled || !obs.entitled || !obs.targetExists) return false;
  return (
    resolveVerification(row, obs.txt, now).status === "verified" &&
    resolveRouting(row, obs.addresses, edge, now).status === "ok"
  );
}

/**
 * The single place a domain changes state. Given the stored row and what one
 * check observed, returns the columns to write, the events to log (state
 * changes only), when to look again, and whether the domain is serving.
 */
export function decideDomainTransition(
  row: CustomDomainCheckRow,
  obs: DomainObservation,
  edge: EdgeAddresses,
  now: Date,
): DomainDecision {
  const verification = resolveVerification(row, obs.txt, now);
  const routing = resolveRouting(row, obs.addresses, edge, now);
  const ssl = resolveSsl(row, obs, verification.status, routing.status, now);

  const patch: CustomDomainPatch = {
    lastCheckedAt: now,
    ...verification.patch,
    ...routing.patch,
    ...ssl.patch,
  };
  const events = [...verification.events, ...routing.events, ...ssl.events];
  if (obs.isApex !== null && obs.isApex !== row.isApex) patch.isApex = obs.isApex;

  const pausedReason = derivePausedReason({
    row,
    verification: verification.status,
    routing: routing.status,
    ssl: ssl.status,
    entitled: obs.entitled,
    targetExists: obs.targetExists,
  });
  const isActive =
    row.enabled &&
    verification.status === "verified" &&
    routing.status === "ok" &&
    ssl.status === "active" &&
    obs.entitled &&
    obs.targetExists;

  if (pausedReason !== row.pausedReason) {
    patch.pausedReason = pausedReason;
    if (pausedReason === "plan_inactive") {
      events.push({
        eventType: "plan_paused",
        message: "The organization's plan no longer includes custom domains; the domain is paused.",
      });
    } else if (row.pausedReason === "plan_inactive") {
      events.push({
        eventType: "plan_resumed",
        message: "The organization's plan includes custom domains again.",
      });
    }
    if (pausedReason === "target_missing") {
      events.push({
        eventType: "target_missing",
        message: `The ${row.targetType} this domain points at no longer exists.`,
      });
    }
  }
  if (isActive !== row.isActive) {
    patch.isActive = isActive;
    events.push({
      eventType: isActive ? "serving_started" : "serving_stopped",
      message: isActive
        ? "The domain is serving requests."
        : `The domain stopped serving${pausedReason ? ` (${pausedReason})` : ""}.`,
      previousStatus: String(row.isActive),
      newStatus: String(isActive),
    });
  }

  const delay = nextCheckDelay({
    row,
    patch,
    verification: verification.status,
    routing: routing.status,
    ssl: ssl.status,
    entitled: obs.entitled,
    targetExists: obs.targetExists,
    now,
  });
  const nextCheckAt = delay === null ? null : new Date(now.getTime() + delay);
  patch.nextCheckAt = nextCheckAt;

  return {
    patch,
    events,
    nextCheckAt,
    isActive,
    pausedReason,
    verificationStatus: verification.status,
    routingStatus: routing.status,
    sslStatus: ssl.status,
  };
}

/**
 * What to write when the TXT record matched but another organisation already
 * holds the verified claim on the name: the row stays pending and says why.
 */
export function claimedElsewhereDecision(
  row: CustomDomainCheckRow,
  now: Date,
): { patch: CustomDomainPatch; events: DomainEventInput[] } {
  const nextCheckAt = new Date(now.getTime() + 30 * MINUTE);
  const patch: CustomDomainPatch = {
    lastCheckedAt: now,
    nextCheckAt,
    verificationError: CLAIMED_ELSEWHERE_MESSAGE,
  };
  const current = verificationOf(row);
  // An expired claim stays expired: it is looked at again only when its owner asks.
  if (current === "expired") patch.nextCheckAt = null;
  // A row cannot stay verified without the claim.
  if (current === "verified") {
    Object.assign(patch, {
      ...SSL_RESET,
      verificationStatus: "pending",
      verificationLostAt: null,
      isActive: false,
      pausedReason: null,
    } satisfies CustomDomainPatch);
  }
  return {
    patch,
    events:
      row.verificationError === CLAIMED_ELSEWHERE_MESSAGE
        ? []
        : [{ eventType: "claimed_elsewhere", message: CLAIMED_ELSEWHERE_MESSAGE }],
  };
}

// ============================================
// Owner actions
// ============================================

/** No DNS answer and no handshake: an owner's action observes nothing. */
function nothingObserved(facts: { entitled: boolean; targetExists: boolean }): DomainObservation {
  return {
    txt: { kind: "transient", code: "ENOTCHECKED" },
    addresses: { kind: "transient", code: "ENOTCHECKED" },
    isApex: null,
    entitled: facts.entitled,
    targetExists: facts.targetExists,
    probe: null,
  };
}

const NO_EDGE: EdgeAddresses = { ipv4: [], ipv6: [] };

/** How soon the checker looks at a domain its owner just switched on. */
const ENABLED_RECHECK_MS = 2 * MINUTE;

export type EnabledChangePatch = CustomDomainPatch & { enabled: boolean };

/**
 * The owner switched the domain on or off. Only the switch changes; whether
 * the domain serves is derived from it and from what was last observed, by
 * the same rule every check uses. Switching off therefore stops serving at
 * once, and switching on starts serving only if the stored observations
 * already allow it.
 */
export function decideEnabledChange(
  row: CustomDomainCheckRow,
  enabled: boolean,
  facts: { entitled: boolean; targetExists: boolean },
  now: Date,
): { patch: EnabledChangePatch; events: DomainEventInput[]; isActive: boolean; pausedReason: PausedReason | null } {
  const decision = decideDomainTransition({ ...row, enabled }, nothingObserved(facts), NO_EDGE, now);
  // Nothing was looked up, so the row's "last checked" time stays what it was.
  const { lastCheckedAt: _notChecked, ...patch } = decision.patch;
  let nextCheckAt = decision.nextCheckAt;
  if (enabled && nextCheckAt !== null) {
    // The stored observations may be old: have the checker confirm them soon.
    const soon = new Date(now.getTime() + ENABLED_RECHECK_MS);
    if (nextCheckAt.getTime() > soon.getTime()) nextCheckAt = soon;
  }
  return {
    patch: { ...patch, enabled, nextCheckAt },
    events: [
      {
        eventType: enabled ? "activated" : "deactivated",
        message: enabled ? "The domain was switched on." : "The domain was switched off.",
        previousStatus: String(row.enabled),
        newStatus: String(enabled),
      },
      ...decision.events,
    ],
    isActive: decision.isActive,
    pausedReason: decision.pausedReason,
  };
}

/**
 * A new token restarts the 14 days and the checker's fast first-hour schedule,
 * so it cannot be asked for over and over to keep an unverified name checked
 * every two minutes for ever.
 */
export const REVERIFY_SPACING_MS = 15 * MINUTE;

/** When a new token may next be issued; null when it may be issued now. */
export function reverifyAvailableAt(row: { verificationStartedAt: Date }, now: Date): Date | null {
  const at = row.verificationStartedAt.getTime() + REVERIFY_SPACING_MS;
  return at > now.getTime() ? new Date(at) : null;
}

export type ReverifyPatch = CustomDomainPatch & {
  verificationToken: string;
  verificationStartedAt: Date;
};

/**
 * The owner asked for a new verification token. The old proof of ownership is
 * void from this moment: the claim on the name is released, the domain stops
 * serving, the certificate record is cleared (nobody is observing it any
 * more) and the 14 days to verify start again.
 */
export function reverifyDecision(
  row: CustomDomainCheckRow,
  newToken: string,
  now: Date,
): { patch: ReverifyPatch; events: DomainEventInput[] } {
  const events: DomainEventInput[] = [
    {
      eventType: "reverification_started",
      message: "A new verification token was generated; the previous TXT record no longer verifies the domain.",
      previousStatus: verificationOf(row),
      newStatus: "pending",
    },
  ];
  if (row.isActive) {
    events.push({
      eventType: "serving_stopped",
      message: "The domain stopped serving (verification restarted).",
      previousStatus: "true",
      newStatus: "false",
    });
  }
  return {
    patch: {
      ...SSL_RESET,
      verificationToken: newToken,
      verificationStatus: "pending",
      verificationStartedAt: now,
      verifiedDomain: null,
      verificationError: null,
      verificationLostAt: null,
      isActive: false,
      pausedReason: row.enabled ? null : "disabled",
      nextCheckAt: new Date(now.getTime() + 2 * MINUTE),
    },
    events,
  };
}

// ============================================
// Response headers a customer may add
// ============================================

export const MAX_CUSTOM_HEADERS = 20;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/** Visible ASCII, space and tab: what an HTTP header value may carry. */
const HEADER_VALUE = /^[\t\x20-\x7E]{0,512}$/;

/**
 * Headers the platform itself decides. Letting a domain set them would let it
 * set cookies, redirect, break framing, or widen the HTTPS pin beyond the one
 * hostname that was verified.
 */
const FORBIDDEN_HEADERS = new Set([
  "set-cookie",
  "content-length",
  "transfer-encoding",
  "connection",
  "location",
  "strict-transport-security",
  "content-type",
  "content-encoding",
  "content-range",
  "host",
  "date",
  "upgrade",
  "keep-alive",
  "te",
  "trailer",
  "www-authenticate",
  "proxy-authenticate",
  "retry-after",
  "x-request-id",
  "x-should-retry",
]);
const FORBIDDEN_HEADER_PREFIXES = ["access-control-", "x-ratelimit-", "x-wheels-", "proxy-", "sec-"];

export function isForbiddenCustomHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return FORBIDDEN_HEADERS.has(lower) || FORBIDDEN_HEADER_PREFIXES.some((p) => lower.startsWith(p));
}

export type CustomHeadersResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; message: string };

/** Checks the response headers a customer wants added on their domain. */
export function validateCustomHeaders(input: unknown): CustomHeadersResult {
  if (input === null || input === undefined) return { ok: true, headers: {} };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "headers must be an object of header names to values." };
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_CUSTOM_HEADERS) {
    return { ok: false, message: `At most ${MAX_CUSTOM_HEADERS} headers can be set.` };
  }
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name)) {
      return { ok: false, message: `'${name.slice(0, 64)}' is not a valid header name.` };
    }
    if (isForbiddenCustomHeader(name)) {
      return { ok: false, message: `The ${name} header is set by the platform and cannot be overridden.` };
    }
    if (seen.has(name.toLowerCase())) {
      return { ok: false, message: `The ${name} header is given more than once.` };
    }
    seen.add(name.toLowerCase());
    if (typeof value !== "string" || !HEADER_VALUE.test(value)) {
      return {
        ok: false,
        message: `The value of ${name} must be at most 512 printable ASCII characters on one line.`,
      };
    }
    headers[name] = value;
  }
  return { ok: true, headers };
}

/**
 * The headers of a stored row that may be applied to a response. Rows written
 * before validation existed can hold anything, so what is stored is filtered
 * again on the way out; an entry that would not pass today is left out.
 */
export function applicableCustomHeaders(stored: unknown): Record<string, string> {
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(stored as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_CUSTOM_HEADERS) break;
    if (!HEADER_NAME.test(name) || isForbiddenCustomHeader(name)) continue;
    if (typeof value !== "string" || !HEADER_VALUE.test(value)) continue;
    out[name] = value;
  }
  return out;
}

// ============================================
// Requests arriving on a customer hostname
// ============================================

/**
 * HTTPS is pinned for the verified hostname only. The platform default adds
 * includeSubDomains, which on a customer's apex would force HTTPS on every
 * subdomain they run elsewhere for six months.
 */
export const EDGE_HSTS_VALUE = "max-age=15552000";

/** What the router knows about one verified hostname. */
export interface EdgeRoute {
  domainId: string;
  orgId: string;
  domain: string;
  targetType: string;
  /** The slug of the agent or deployment; null when it no longer exists. */
  targetSlug: string | null;
  /** The derived serving flag, and the plan still includes custom domains. */
  serving: boolean;
  headers: Record<string, string>;
}

export type EdgeAction =
  /** Hand the request to this canonical route of the API. */
  | { kind: "forward"; url: string }
  /** Answer the prober's question "does this hostname reach this API". */
  | { kind: "proof" }
  | { kind: "redirect"; location: string }
  /** The hostname is not serving (unknown, paused, or its target is gone). */
  | { kind: "unrouted" }
  /** The hostname serves, but not this path. */
  | { kind: "not_found" }
  /** The routing table could not be trusted; nothing is routed on a guess. */
  | { kind: "unavailable" };

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const MODELS_PATH = "/v1/models";

/** The endpoints a serving custom domain answers, for its not-found message. */
export const EDGE_ENDPOINTS = [`POST ${CHAT_COMPLETIONS_PATH}`, `GET ${MODELS_PATH}`] as const;

/**
 * The Host a request arrived for, as the edge reports it: port stripped, then
 * the same normalisation a registered domain went through. Null when it could
 * not be a registered domain at all.
 */
export function normalizeEdgeHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim().replace(/:\d{1,5}$/, "");
  const normalized = normalizeDomainInput(host);
  return normalized.ok ? normalized.domain : null;
}

/**
 * Where a request for a verified hostname goes. A custom domain is an
 * OpenAI-compatible base URL for ONE agent or model deployment:
 *
 *   POST /v1/chat/completions   the target's chat completions
 *   GET  /v1/models             the one model the domain serves
 *
 * Paths are matched exactly, on the raw request target, and anything else is
 * not found - so no other route of this API (login, the dashboard's API, other
 * agents) is reachable through a customer's hostname.
 */
export function mapEdgeRequest(input: {
  method: string;
  /** The raw request target: path and query. */
  url: string;
  /** Whether the client reached the edge over TLS. */
  https: boolean;
  route: EdgeRoute;
}): EdgeAction {
  const { route } = input;
  const method = input.method.toUpperCase();
  const queryAt = input.url.indexOf("?");
  const path = queryAt === -1 ? input.url : input.url.slice(0, queryAt);
  const query = queryAt === -1 ? "" : input.url.slice(queryAt);

  // Asked by the prober over the TLS connection it is judging. It must work
  // before the domain serves: a valid certificate plus this answer is what
  // makes the domain active in the first place.
  if (input.https && method === "GET" && path === DOMAIN_PROOF_PATH) return { kind: "proof" };

  if (!route.serving || route.targetSlug === null) return { kind: "unrouted" };

  // HTTPS is always enforced; there is no plain-HTTP serving.
  if (!input.https) {
    const target = input.url.startsWith("/") ? input.url : "/";
    return { kind: "redirect", location: `https://${route.domain}${target}` };
  }

  const slug = encodeURIComponent(route.targetSlug);
  if (route.targetType === "deployment") {
    if (method === "POST" && path === CHAT_COMPLETIONS_PATH) {
      return { kind: "forward", url: `/v1/${slug}/chat/completions${query}` };
    }
    // The customer's own query is dropped so it cannot name another deployment.
    if (method === "GET" && path === MODELS_PATH) {
      return { kind: "forward", url: `/v1/models?deployment=${slug}` };
    }
  } else if (route.targetType === "agent") {
    if (method === "POST" && path === CHAT_COMPLETIONS_PATH) {
      return { kind: "forward", url: `/v1/agents/${slug}/chat/completions${query}` };
    }
    if (method === "GET" && path === MODELS_PATH) {
      return { kind: "forward", url: `/v1/agents/${slug}/models` };
    }
  }
  return { kind: "not_found" };
}
