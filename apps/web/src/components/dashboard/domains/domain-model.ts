/**
 * What the custom-domain screens say about a domain. Pure: every sentence is
 * derived from fields the API returned, and those fields are observations
 * (what DNS answered, what a TLS handshake presented). Nothing here supplies a
 * value the server did not send - no default issuer, no assumed expiry.
 */
import type {
  CustomDomain,
  DnsRecordInstruction,
  DnsRecords,
  DomainPausedReason,
  DomainsConfig,
} from "@/lib/api";
import type { Tone } from "../workflows/format";

export interface DomainState {
  tone: Tone;
  /** Short, for a chip. */
  label: string;
  /** One or two sentences for the panel under the chip. */
  detail: string;
}

type Policy = DomainsConfig["policy"];

/** Used only until GET /config answers; the server's values replace it. */
export const DEFAULT_POLICY: Policy = { httpsEnforced: true, verificationGraceHours: 72, pendingExpiryDays: 14 };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function at(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** "in 3 days", "in 5 hours", "in under an hour"; "now" once the moment has passed. */
export function timeUntil(deadlineMs: number, nowMs: number): string {
  const left = deadlineMs - nowMs;
  if (left <= 0) return "now";
  if (left >= 2 * DAY) return `in ${Math.floor(left / DAY)} days`;
  if (left >= 2 * HOUR) return `in ${Math.floor(left / HOUR)} hours`;
  if (left >= HOUR) return "in about an hour";
  return "in under an hour";
}

// ---- ownership ----

export function ownershipState(domain: CustomDomain, policy: Policy, nowMs: number): DomainState {
  if (domain.verificationStatus === "verified") {
    const lost = at(domain.verificationLostAt);
    if (lost !== null) {
      const deadline = lost + policy.verificationGraceHours * HOUR;
      return {
        tone: "warning",
        label: "Record missing",
        detail:
          `The TXT record stopped being found on ${new Date(lost).toLocaleString()}. ` +
          `Put it back: the domain stops serving ${timeUntil(deadline, nowMs)} ` +
          `(${policy.verificationGraceHours} hours after it was first found missing).`,
      };
    }
    const verified = at(domain.verifiedAt);
    return {
      tone: "success",
      label: "Verified",
      detail:
        (verified !== null ? `The TXT record was found on ${new Date(verified).toLocaleString()}. ` : "") +
        "Keep the record in place: it is checked again regularly.",
    };
  }
  if (domain.verificationStatus === "expired") {
    return {
      tone: "danger",
      label: "Expired",
      detail:
        domain.verificationError ??
        "The verification expired. Generate a new token, publish it as the TXT record and check again.",
    };
  }
  const started = at(domain.verificationStartedAt);
  const deadline = started !== null ? started + policy.pendingExpiryDays * DAY : null;
  return {
    tone: "warning",
    label: "Not verified",
    detail:
      (domain.verificationError ?? "The TXT record has not been found yet.") +
      (deadline !== null
        ? ` An unverified domain expires ${timeUntil(deadline, nowMs)} (${policy.pendingExpiryDays} days after it was added).`
        : ""),
  };
}

// ---- routing ----

export function routingState(domain: CustomDomain): DomainState {
  const observed = domain.observedAddresses ?? [];
  switch (domain.routingStatus) {
    case "ok":
      return {
        tone: "success",
        label: "DNS points here",
        detail: `Every address the domain resolves to is the edge: ${observed.join(", ") || "none recorded"}.`,
      };
    case "misrouted":
      return {
        tone: "danger",
        label: "DNS points elsewhere",
        detail:
          domain.routingError ??
          `The domain resolves to ${observed.join(", ")}, which is not only the edge. A CDN or proxy in front of the record is not supported.`,
      };
    case "unresolvable":
      return {
        tone: "warning",
        label: "No address",
        detail: domain.routingError ?? "The domain has no A, AAAA or CNAME record that resolves.",
      };
    default:
      return {
        tone: "neutral",
        label: "Not checked",
        detail: "The domain's addresses have not been looked up yet.",
      };
  }
}

// ---- certificate ----

export function certificateState(domain: CustomDomain): DomainState {
  switch (domain.sslStatus) {
    case "active":
      return {
        tone: "success",
        label: "Certificate valid",
        detail: "A TLS handshake with the edge presented a valid certificate for this domain.",
      };
    case "provisioning":
      return {
        tone: "info",
        label: "Waiting for certificate",
        detail:
          domain.sslError ??
          "The domain qualifies for a certificate. The edge requests one on the first HTTPS connection; none has been observed yet.",
      };
    case "failed":
      return {
        tone: "danger",
        label: "Certificate failed",
        detail: domain.sslError ?? "No valid certificate was presented for this domain.",
      };
    case "expired":
      return {
        tone: "danger",
        label: "Certificate expired",
        detail: domain.sslError ?? "The certificate the edge presented has expired.",
      };
    default: {
      let why = "A certificate is requested once ownership is verified and DNS points at the edge.";
      if (domain.verificationStatus === "verified" && domain.routingStatus === "ok") {
        why = "No handshake has been made yet. The first one follows a few minutes after DNS is confirmed.";
      }
      return { tone: "neutral", label: "No certificate", detail: why };
    }
  }
}

/** Spaced sha256 fingerprint as browsers show it; the stored value otherwise. */
export function formatFingerprint(value: string | null): string | null {
  if (!value) return null;
  const hex = value.replace(/[^0-9a-fA-F]/g, "");
  if (hex.length !== 64) return value;
  return (hex.toUpperCase().match(/.{2}/g) ?? []).join(":");
}

// ---- serving ----

const PAUSED_TEXT: Record<DomainPausedReason, string> = {
  disabled: "Switched off. Requests to this domain are answered 404.",
  plan_inactive: "Paused: your plan no longer includes custom domains. It resumes when the plan does.",
  target_missing: "Paused: the agent or deployment this domain points at no longer exists.",
  verification_lost: "Paused: the TXT record was missing for longer than the grace period.",
  dns_not_routed: "Paused: the domain's DNS no longer points only at the edge.",
  certificate_invalid: "Paused: the edge stopped presenting a valid certificate for this domain.",
};

export function pausedReasonText(reason: DomainPausedReason | string | null): string | null {
  if (!reason) return null;
  return PAUSED_TEXT[reason as DomainPausedReason] ?? `Paused (${reason}).`;
}

export function servingState(domain: CustomDomain): DomainState {
  if (domain.isActive) {
    return { tone: "success", label: "Serving", detail: `Requests to https://${domain.domain} reach the target.` };
  }
  if (!domain.enabled) return { tone: "neutral", label: "Switched off", detail: PAUSED_TEXT.disabled };
  const paused = pausedReasonText(domain.pausedReason);
  if (paused) return { tone: "danger", label: "Paused", detail: paused };
  return {
    tone: "neutral",
    label: "Not serving yet",
    detail: "The domain serves once ownership, DNS and a valid certificate have all been observed.",
  };
}

// ---- DNS records ----

export interface RoutingRecordPlan {
  /** False while the server has no edge: there is no true record to show. */
  available: boolean;
  recommended: DnsRecordInstruction[];
  alternative: DnsRecordInstruction[];
  note: string;
}

/** Which routing record(s) to publish first, and the other valid option. */
export function routingRecordPlan(records: DnsRecords): RoutingRecordPlan {
  const addresses = [...records.aRecords, ...records.aaaaRecords];
  if (!records.cnameRecord || records.recommended === null) {
    return {
      available: false,
      recommended: [],
      alternative: [],
      note: "Custom domains are temporarily unavailable, so there is no address to point this domain at right now.",
    };
  }
  if (records.recommended === "a") {
    return {
      available: true,
      recommended: addresses,
      alternative: [],
      note: "This is a root (apex) domain, where DNS does not allow a CNAME. Publish every address record below and no others.",
    };
  }
  return {
    available: true,
    recommended: [records.cnameRecord],
    alternative: addresses,
    note: "Publish the CNAME. If your DNS provider cannot, publish every address record instead, and no others.",
  };
}

// ---- polling and usage ----

/**
 * Worth re-reading on a short interval: the owner is waiting on DNS or on the
 * first certificate. A domain that is serving, switched off, paused or expired
 * changes only when the owner acts, or on the checker's slow cadence.
 */
export function isSettling(domain: CustomDomain): boolean {
  if (!domain.enabled || domain.isActive) return false;
  if (domain.verificationStatus === "expired") return false;
  if (domain.pausedReason === "plan_inactive" || domain.pausedReason === "target_missing") return false;
  return domain.sslStatus !== "failed";
}

/** The base URL an OpenAI client is pointed at. */
export function domainBaseUrl(domain: Pick<CustomDomain, "domain">): string {
  return `https://${domain.domain}/v1`;
}

export function usageSnippet(domain: Pick<CustomDomain, "domain" | "targetType">): string {
  const base = domainBaseUrl(domain);
  const what = domain.targetType === "agent" ? "agent" : "model deployment";
  return [
    `# The one ${what} this domain serves`,
    `curl -s ${base}/models \\`,
    `  -H "Authorization: Bearer $WHEELSAI_API_KEY"`,
    ``,
    `curl -s ${base}/chat/completions \\`,
    `  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"model": "default", "messages": [{"role": "user", "content": "Hello"}]}'`,
  ].join("\n");
}

/**
 * How many domains the organization may have, as the server states it. Nothing
 * is shown until the server has said: the page never assumes a number.
 */
export function domainAllowanceHint(
  total: number,
  limits: DomainsConfig["limits"] | undefined,
): string | undefined {
  if (!limits) return undefined;
  const max = limits.maxDomainsPerOrganization;
  if (total >= max) return `the most one organization can have (${max}); delete one to add another`;
  return `of ${max} allowed per organization`;
}

/** Plan names as the pricing table spells them. */
export function planList(ids: readonly string[]): string {
  const names = ids.map((id) => id.charAt(0).toUpperCase() + id.slice(1));
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The API sends a count above 2^53 as a string; that one is shown as sent. */
export function formatRequestCount(value: number | string): string {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) ? n.toLocaleString("en-US") : String(value);
}
