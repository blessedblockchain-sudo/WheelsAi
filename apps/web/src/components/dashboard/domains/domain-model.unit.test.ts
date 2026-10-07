/**
 * What the custom-domain screens say. Run with:
 *   cd apps/web && npx tsx --test src/components/dashboard/domains/*.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CustomDomain, DnsRecords } from "@/lib/api";
import {
  certificateState,
  DEFAULT_POLICY,
  domainAllowanceHint,
  formatFingerprint,
  formatRequestCount,
  isSettling,
  ownershipState,
  pausedReasonText,
  planList,
  routingRecordPlan,
  routingState,
  servingState,
  timeUntil,
  usageSnippet,
} from "./domain-model";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const HOUR = 3_600_000;

const RECORDS: DnsRecords = {
  txtRecord: { name: "_wheels-verification.api.example.com", type: "TXT", value: "wheels-verify-abc" },
  cnameRecord: { name: "api.example.com", type: "CNAME", value: "edge.example.net" },
  aRecords: [{ name: "api.example.com", type: "A", value: "203.0.113.10" }],
  aaaaRecords: [{ name: "api.example.com", type: "AAAA", value: "2001:db8::10" }],
  recommended: "cname",
};

function domain(extra: Partial<CustomDomain> = {}): CustomDomain {
  return {
    id: "d1",
    orgId: "o1",
    domain: "api.example.com",
    subdomain: "api",
    rootDomain: "example.com",
    targetType: "agent",
    targetId: "a1",
    verificationStatus: "pending",
    verificationToken: "wheels-verify-abc",
    verificationMethod: "dns_txt",
    verifiedAt: null,
    lastCheckedAt: null,
    verificationError: null,
    verificationStartedAt: new Date(NOW - 24 * HOUR).toISOString(),
    verificationLostAt: null,
    routingStatus: "pending",
    routingCheckedAt: null,
    routingError: null,
    observedAddresses: [],
    isApex: false,
    sslStatus: "pending",
    sslProvider: null,
    sslIssuer: null,
    sslValidFrom: null,
    sslExpiresAt: null,
    sslFingerprint256: null,
    sslCheckedAt: null,
    sslError: null,
    routingMode: "proxy",
    forceHttps: true,
    headers: null,
    enabled: true,
    isActive: false,
    pausedReason: null,
    isPrimary: false,
    nextCheckAt: null,
    totalRequests: 0,
    lastRequestAt: null,
    createdAt: new Date(NOW - 24 * HOUR).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    dnsRecords: RECORDS,
    routing: { status: "pending", checkedAt: null, error: null, observedAddresses: [] },
    certificate: {
      status: "pending",
      provider: null,
      issuer: null,
      validFrom: null,
      expiresAt: null,
      fingerprint256: null,
      checkedAt: null,
      error: null,
    },
    ...extra,
  };
}

test("timeUntil counts down in days, hours, and never below now", () => {
  assert.equal(timeUntil(NOW + 13 * 24 * HOUR, NOW), "in 13 days");
  assert.equal(timeUntil(NOW + 30 * HOUR, NOW), "in 30 hours");
  assert.equal(timeUntil(NOW + 90 * 60_000, NOW), "in about an hour");
  assert.equal(timeUntil(NOW + 10 * 60_000, NOW), "in under an hour");
  assert.equal(timeUntil(NOW - 1, NOW), "now");
});

test("an unverified domain states the 14-day expiry from when verification started", () => {
  const state = ownershipState(domain(), DEFAULT_POLICY, NOW);
  assert.equal(state.label, "Not verified");
  assert.match(state.detail, /expires in 13 days \(14 days after it was added\)/);
});

test("the server's verification error is shown instead of the generic sentence", () => {
  const state = ownershipState(
    domain({ verificationError: "This domain is already verified by another organization." }),
    DEFAULT_POLICY,
    NOW,
  );
  assert.match(state.detail, /^This domain is already verified by another organization\./);
});

test("a verified domain whose record went missing states when serving stops", () => {
  const state = ownershipState(
    domain({
      verificationStatus: "verified",
      verifiedAt: new Date(NOW - 100 * HOUR).toISOString(),
      verificationLostAt: new Date(NOW - 24 * HOUR).toISOString(),
    }),
    DEFAULT_POLICY,
    NOW,
  );
  assert.equal(state.tone, "warning");
  assert.match(state.detail, /stops serving in 2 days/);
  assert.match(state.detail, /72 hours/);
});

test("the policy numbers come from the server, not from this file", () => {
  const state = ownershipState(
    domain(),
    { httpsEnforced: true, verificationGraceHours: 10, pendingExpiryDays: 3 },
    NOW,
  );
  assert.match(state.detail, /expires in 2 days \(3 days after it was added\)/);
});

test("routing reports the observed addresses and the server's diagnosis", () => {
  assert.equal(routingState(domain()).label, "Not checked");
  const ok = routingState(domain({ routingStatus: "ok", observedAddresses: ["203.0.113.10"] }));
  assert.equal(ok.tone, "success");
  assert.match(ok.detail, /203\.0\.113\.10/);
  const off = routingState(
    domain({ routingStatus: "misrouted", observedAddresses: ["104.16.0.1"], routingError: "Resolves to 104.16.0.1." }),
  );
  assert.equal(off.tone, "danger");
  assert.equal(off.detail, "Resolves to 104.16.0.1.");
  assert.equal(routingState(domain({ routingStatus: "unresolvable" })).tone, "warning");
});

test("no certificate state ever names an issuer or an expiry", () => {
  for (const sslStatus of ["pending", "provisioning", "active", "failed", "expired"] as const) {
    const state = certificateState(domain({ sslStatus }));
    assert.doesNotMatch(`${state.label} ${state.detail}`, /let'?s encrypt|zerossl|90 days|expires on/i, sslStatus);
  }
});

test("only an observed handshake reads as a valid certificate", () => {
  assert.equal(certificateState(domain({ sslStatus: "active" })).tone, "success");
  const waiting = certificateState(domain({ sslStatus: "provisioning" }));
  assert.equal(waiting.tone, "info");
  assert.match(waiting.detail, /none has been observed yet/);
  const none = certificateState(domain());
  assert.equal(none.label, "No certificate");
  assert.match(none.detail, /once ownership is verified and DNS points at the edge/);
  assert.equal(certificateState(domain({ sslStatus: "failed", sslError: "CERT_HAS_EXPIRED" })).detail, "CERT_HAS_EXPIRED");
});

test("a sha256 fingerprint is grouped; anything else is shown as stored", () => {
  assert.equal(formatFingerprint(null), null);
  assert.equal(formatFingerprint("ab".repeat(32)), Array(32).fill("AB").join(":"));
  assert.equal(formatFingerprint(Array(32).fill("AB").join(":")), Array(32).fill("AB").join(":"));
  assert.equal(formatFingerprint("short"), "short");
});

test("serving is the server's flag; a paused domain says why", () => {
  assert.equal(servingState(domain({ isActive: true })).label, "Serving");
  assert.equal(servingState(domain({ enabled: false, pausedReason: "disabled" })).label, "Switched off");
  const paused = servingState(domain({ pausedReason: "plan_inactive" }));
  assert.equal(paused.label, "Paused");
  assert.match(paused.detail, /plan no longer includes custom domains/);
  assert.equal(servingState(domain()).label, "Not serving yet");
  // A verified domain with a valid certificate is still not "Serving" unless the server says so.
  assert.equal(
    servingState(domain({ verificationStatus: "verified", routingStatus: "ok", sslStatus: "active" })).label,
    "Not serving yet",
  );
});

test("an unknown paused reason is shown, not hidden", () => {
  assert.equal(pausedReasonText(null), null);
  assert.equal(pausedReasonText("something_new"), "Paused (something_new).");
});

test("a subdomain is told to publish the CNAME, with the addresses as the other option", () => {
  const plan = routingRecordPlan(RECORDS);
  assert.equal(plan.available, true);
  assert.deepEqual(plan.recommended.map((r) => r.type), ["CNAME"]);
  assert.deepEqual(plan.alternative.map((r) => r.type), ["A", "AAAA"]);
});

test("an apex domain is told to publish every address and is never offered a CNAME", () => {
  const plan = routingRecordPlan({ ...RECORDS, recommended: "a" });
  assert.deepEqual(plan.recommended.map((r) => r.value), ["203.0.113.10", "2001:db8::10"]);
  assert.deepEqual(plan.alternative, []);
  assert.match(plan.note, /apex/);
});

test("with no edge configured there is no routing record to show", () => {
  const plan = routingRecordPlan({ ...RECORDS, cnameRecord: null, aRecords: [], aaaaRecords: [], recommended: null });
  assert.equal(plan.available, false);
  assert.deepEqual(plan.recommended, []);
  assert.match(plan.note, /not configured on this server/);
});

test("the page keeps re-reading only while the owner is waiting on DNS or a certificate", () => {
  assert.equal(isSettling(domain()), true);
  assert.equal(isSettling(domain({ verificationStatus: "verified", routingStatus: "ok", sslStatus: "provisioning" })), true);
  assert.equal(isSettling(domain({ isActive: true })), false);
  assert.equal(isSettling(domain({ enabled: false })), false);
  assert.equal(isSettling(domain({ verificationStatus: "expired" })), false);
  assert.equal(isSettling(domain({ pausedReason: "plan_inactive" })), false);
  assert.equal(isSettling(domain({ sslStatus: "failed" })), false);
});

test("the usage snippet is the domain's own /v1 base URL with an API key", () => {
  const snippet = usageSnippet({ domain: "api.example.com", targetType: "deployment" });
  assert.match(snippet, /https:\/\/api\.example\.com\/v1\/models/);
  assert.match(snippet, /https:\/\/api\.example\.com\/v1\/chat\/completions/);
  assert.match(snippet, /Authorization: Bearer \$WHEELSAI_API_KEY/);
  assert.doesNotMatch(snippet, /http:\/\//);
});

test("the domain allowance is the server's number, and nothing is shown before it is known", () => {
  assert.equal(domainAllowanceHint(3, undefined), undefined);
  assert.equal(domainAllowanceHint(3, { maxDomainsPerOrganization: 25 }), "of 25 allowed per organization");
  assert.match(domainAllowanceHint(25, { maxDomainsPerOrganization: 25 }) ?? "", /the most one organization can have \(25\)/);
  assert.match(domainAllowanceHint(26, { maxDomainsPerOrganization: 25 }) ?? "", /delete one to add another/);
});

test("plan names and request counts", () => {
  assert.equal(planList(["pro", "enterprise"]), "Pro and Enterprise");
  assert.equal(planList(["pro"]), "Pro");
  assert.equal(formatRequestCount(12345), "12,345");
  assert.equal(formatRequestCount("9007199254740993"), "9007199254740993");
});
