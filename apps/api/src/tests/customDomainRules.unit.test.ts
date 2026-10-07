import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDnsInstructions,
  buildReservedHosts,
  caaForbidsIssuer,
  claimedElsewhereDecision,
  classifyDnsError,
  classifyProbeError,
  classifyRouting,
  CLAIMED_ELSEWHERE_MESSAGE,
  computeDomainProof,
  applicableCustomHeaders,
  decideCertificateIssuance,
  decideDomainTransition,
  decideEnabledChange,
  DOMAIN_PROOF_PATH,
  mapEdgeRequest,
  normalizeDomainInput,
  normalizeEdgeHost,
  reverifyDecision,
  validateCustomHeaders,
  txtContainsToken,
  verificationRecordName,
  wantsTlsProbe,
  type CustomDomainCheckRow,
  type DomainObservation,
  type EdgeRoute,
  type TlsProbeOutcome,
} from "../services/customDomainRules.js";
import {
  CHECK_BATCH_PER_ORG,
  decideIssuanceBudget,
  interleaveByOrganization,
  ISSUANCE_PER_NAME,
  needsIssuanceBudget,
  reverifyAvailableAt,
  REVERIFY_SPACING_MS,
} from "../services/customDomainRules.js";

// services/customDomainRules.ts - the pure rules of custom domains. The
// property under test throughout: a domain moves only on what was OBSERVED.
// A resolver error or an unreachable edge is no observation and moves nothing.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-06T12:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

const EDGE = { ipv4: ["137.66.10.1"], ipv6: ["2a09:8280:1::a:1"] };
const TOKEN = "wheels-verify-0123456789abcdef0123456789abcdef";

function row(over: Partial<CustomDomainCheckRow> = {}): CustomDomainCheckRow {
  return {
    id: "d1",
    orgId: "org1",
    domain: "api.customer.com",
    targetType: "agent",
    targetId: "a1",
    verificationToken: TOKEN,
    verificationStatus: "pending",
    verificationError: null,
    verifiedDomain: null,
    verifiedAt: null,
    verificationStartedAt: at(-10 * MINUTE),
    verificationLostAt: null,
    routingStatus: "pending",
    routingFailures: 0,
    routingError: null,
    observedAddresses: [],
    isApex: false,
    sslStatus: "pending",
    sslFailures: 0,
    sslProvisioningSince: null,
    sslExpiresAt: null,
    sslFingerprint256: null,
    sslError: null,
    enabled: true,
    isActive: false,
    pausedReason: null,
    ...over,
  };
}

/** A domain that is verified, routed and has an observed certificate. */
function servingRow(over: Partial<CustomDomainCheckRow> = {}): CustomDomainCheckRow {
  return row({
    verificationStatus: "verified",
    verifiedDomain: "api.customer.com",
    verifiedAt: at(-30 * DAY),
    routingStatus: "ok",
    observedAddresses: ["137.66.10.1"],
    sslStatus: "active",
    sslExpiresAt: at(60 * DAY),
    sslFingerprint256: "AA:BB",
    isActive: true,
    ...over,
  });
}

const TXT_OK = { kind: "found" as const, records: [[TOKEN]] };
const ON_EDGE = { kind: "found" as const, addresses: ["137.66.10.1"] };

function obs(over: Partial<DomainObservation> = {}): DomainObservation {
  return {
    txt: TXT_OK,
    addresses: ON_EDGE,
    isApex: null,
    entitled: true,
    targetExists: true,
    probe: null,
    ...over,
  };
}

const VALID: TlsProbeOutcome = {
  kind: "valid",
  proof: "ok",
  certificate: {
    issuer: "Let's Encrypt R11",
    validFrom: at(-DAY),
    validTo: at(89 * DAY),
    fingerprint256: "AA:BB",
    altNames: ["api.customer.com"],
  },
};
const REFUSED: TlsProbeOutcome = {
  kind: "handshake_refused",
  code: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
  message: "tlsv1 alert internal error",
};
const UNREACHABLE: TlsProbeOutcome = { kind: "unreachable", code: "ECONNREFUSED", message: "refused" };

const decide = (r: CustomDomainCheckRow, o: DomainObservation, now = NOW) =>
  decideDomainTransition(r, o, EDGE, now);
const eventTypes = (d: { events: Array<{ eventType: string }> }) => d.events.map((e) => e.eventType);

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

test("normalizeDomainInput: case, surrounding space and one trailing dot are normalised", () => {
  assert.deepEqual(normalizeDomainInput("  API.Example.COM. "), { ok: true, domain: "api.example.com" });
  assert.deepEqual(normalizeDomainInput("example.com"), { ok: true, domain: "example.com" });
  assert.deepEqual(normalizeDomainInput("a-b.c1.example.co.uk"), { ok: true, domain: "a-b.c1.example.co.uk" });
});

test("normalizeDomainInput: internationalised names are stored as punycode", () => {
  assert.deepEqual(normalizeDomainInput("bücher.example"), {
    ok: false,
    error: "reserved_domain",
    message: "Names ending in .example cannot be used as a custom domain.",
  });
  assert.deepEqual(normalizeDomainInput("Bücher.de"), { ok: true, domain: "xn--bcher-kva.de" });
  assert.deepEqual(normalizeDomainInput("api.münchen.de"), { ok: true, domain: "api.xn--mnchen-3ya.de" });
});

test("normalizeDomainInput: malformed names are invalid_domain", () => {
  const bad: unknown[] = [
    "",
    "   ",
    ".",
    undefined,
    42,
    "localhost-only",
    "a..example.com",
    ".example.com",
    `${"a".repeat(64)}.example.com`,
    `${Array.from({ length: 64 }, () => "abc").join(".")}.com`,
    "1.2.3.4",
    "::1",
    "[2a09:8280:1::a:1]",
    "*.example.com",
    "api.*.example.com",
    "my_api.example.com",
    "_wheels-verification.example.com",
    "example.123",
    "-api.example.com",
    "api-.example.com",
    "https://api.example.com",
    "api.example.com/path",
    "api.example.com:8443",
    "user@example.com",
    "api example.com",
    "api.example.com..",
  ];
  for (const input of bad) {
    const result = normalizeDomainInput(input);
    assert.equal(result.ok, false, `expected ${JSON.stringify(input)} to be refused`);
    if (!result.ok) assert.equal(result.error, "invalid_domain", JSON.stringify(input));
  }
});

test("normalizeDomainInput: a 253-character name passes and 254 does not", () => {
  const label = "a".repeat(61);
  const name253 = `${label}.${label}.${label}.${"a".repeat(63)}.com`; // 61*3 + 63 + 3 + 4 = 253
  assert.equal(name253.length, 253);
  assert.equal(normalizeDomainInput(name253).ok, true);
  const name254 = `${label}.${label}.${label}.${"a".repeat(63)}.info`;
  assert.equal(name254.length, 254);
  assert.equal(normalizeDomainInput(name254).ok, false);
});

test("normalizeDomainInput: special-use and infrastructure suffixes are reserved", () => {
  for (const name of [
    "wheelsai-api.fly.dev",
    "fly.dev",
    "wheelsai-api.internal",
    "top2.nearest.of.wheelsai-api.internal",
    "wheelsai-api.flycast",
    "mysite.netlify.app",
    "printer.local",
    "api.localhost",
    "foo.test",
    "foo.invalid",
    "hidden.onion",
    "1.0.0.127.in-addr.arpa",
    "router.lan",
  ]) {
    const result = normalizeDomainInput(name);
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.equal(result.error, "reserved_domain", name);
  }
  // A suffix is matched on a label boundary, not as a substring.
  assert.equal(normalizeDomainInput("butterfly.dev").ok, true);
  assert.equal(normalizeDomainInput("mytest.com").ok, true);
});

test("normalizeDomainInput: the platform's own hosts and their subdomains are reserved", () => {
  const reservedHosts = buildReservedHosts({
    urls: [
      "https://api.wheelsai.io",
      "https://app.wheelsai.io/dashboard",
      "https://wheelsai.netlify.app, https://preview.wheelsai.dev",
      "http://localhost:3000",
      undefined,
      "not a url",
    ],
    hosts: [".cookies.wheelsai.org", "edge.wheelsai.net", "openclaw.wheelsai.com", undefined, ""],
  });
  assert.deepEqual(
    [...reservedHosts].sort(),
    [
      "api.wheelsai.io",
      "app.wheelsai.io",
      "cookies.wheelsai.org",
      "edge.wheelsai.net",
      "openclaw.wheelsai.com",
      "preview.wheelsai.dev",
      "wheelsai.netlify.app",
    ].sort(),
  );

  for (const name of [
    "api.wheelsai.io",
    "API.wheelsai.io.",
    "evil.api.wheelsai.io",
    "app.wheelsai.io",
    "x.cookies.wheelsai.org",
    "cookies.wheelsai.org",
    "edge.wheelsai.net",
    "tenant.openclaw.wheelsai.com",
  ]) {
    const result = normalizeDomainInput(name, { reservedHosts });
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.equal(result.error, "reserved_domain", name);
  }
  // Siblings and look-alikes of a reserved host are ordinary names.
  assert.equal(normalizeDomainInput("docs.wheelsai.io", { reservedHosts }).ok, true);
  assert.equal(normalizeDomainInput("notapi.wheelsai.io", { reservedHosts }).ok, true);
  assert.equal(normalizeDomainInput("api.customer.com", { reservedHosts }).ok, true);
});

test("verificationRecordName prefixes the domain", () => {
  assert.equal(verificationRecordName("api.customer.com"), "_wheels-verification.api.customer.com");
});

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

test("txtContainsToken joins the chunks of one record and matches whole values only", () => {
  assert.equal(txtContainsToken([[TOKEN]], TOKEN), true);
  assert.equal(txtContainsToken([["v=spf1 -all"], [TOKEN]], TOKEN), true);
  // One record split into chunks is one value.
  assert.equal(txtContainsToken([[TOKEN.slice(0, 20), TOKEN.slice(20)]], TOKEN), true);
  // Two separate records are never glued together.
  assert.equal(txtContainsToken([[TOKEN.slice(0, 20)], [TOKEN.slice(20)]], TOKEN), false);
  assert.equal(txtContainsToken([[`${TOKEN}-extra`]], TOKEN), false);
  assert.equal(txtContainsToken([[`prefix ${TOKEN}`]], TOKEN), false);
  assert.equal(txtContainsToken([], TOKEN), false);
  assert.equal(txtContainsToken([[""]], ""), false);
});

test("classifyDnsError: only NXDOMAIN and NODATA are 'absent'", () => {
  assert.equal(classifyDnsError({ code: "ENOTFOUND" }), "absent");
  assert.equal(classifyDnsError({ code: "ENODATA" }), "absent");
  for (const code of ["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED", "ECANCELLED", "EREFUSED", "EBADRESP"]) {
    assert.equal(classifyDnsError({ code }), "transient", code);
  }
  assert.equal(classifyDnsError(new Error("boom")), "transient");
  assert.equal(classifyDnsError(null), "transient");
});

test("classifyRouting: every address must be the edge", () => {
  assert.deepEqual(classifyRouting(["137.66.10.1"], EDGE), { status: "ok", offEdge: [] });
  assert.deepEqual(classifyRouting(["137.66.10.1", "2a09:8280:1::a:1"], EDGE), { status: "ok", offEdge: [] });
  // One stray A record.
  assert.deepEqual(classifyRouting(["137.66.10.1", "203.0.113.9"], EDGE), {
    status: "misrouted",
    offEdge: ["203.0.113.9"],
  });
  // An AAAA record elsewhere while the A record is right.
  assert.deepEqual(classifyRouting(["137.66.10.1", "2606:4700::1"], EDGE), {
    status: "misrouted",
    offEdge: ["2606:4700::1"],
  });
  // A CDN in front: none of the addresses is the edge.
  assert.equal(classifyRouting(["104.16.0.1", "104.16.0.2"], EDGE).status, "misrouted");
  assert.deepEqual(classifyRouting([], EDGE), { status: "unresolvable", offEdge: [] });
  assert.equal(classifyRouting(["not-an-ip"], EDGE).status, "misrouted");
});

test("classifyRouting: IPv6 is compared by value, not by spelling", () => {
  for (const spelling of [
    "2a09:8280:1::a:1",
    "2A09:8280:1::A:1",
    "2a09:8280:0001:0000:0000:0000:000a:0001",
    "2a09:8280:1:0:0:0:a:1",
  ]) {
    assert.equal(classifyRouting([spelling], EDGE).status, "ok", spelling);
  }
  assert.equal(classifyRouting(["2a09:8280:1::a:2"], EDGE).status, "misrouted");
});

test("caaForbidsIssuer: only 'issue' records that leave the authority out forbid it", () => {
  assert.equal(caaForbidsIssuer([], "letsencrypt.org"), false);
  assert.equal(caaForbidsIssuer([{ issue: "letsencrypt.org" }], "letsencrypt.org"), false);
  assert.equal(caaForbidsIssuer([{ issue: "letsencrypt.org; validationmethods=http-01" }], "letsencrypt.org"), false);
  assert.equal(caaForbidsIssuer([{ issue: "digicert.com" }, { issue: "LetsEncrypt.org" }], "letsencrypt.org"), false);
  assert.equal(caaForbidsIssuer([{ issue: "digicert.com" }], "letsencrypt.org"), true);
  assert.equal(caaForbidsIssuer([{ issue: ";" }], "letsencrypt.org"), true);
  // issuewild alone says nothing about ordinary certificates.
  assert.equal(caaForbidsIssuer([{ issuewild: "digicert.com" }], "letsencrypt.org"), false);
});

// ---------------------------------------------------------------------------
// TLS classification, proof, issuance
// ---------------------------------------------------------------------------

test("classifyProbeError: certificate faults, refusals, and everything else", () => {
  for (const code of [
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  ]) {
    assert.equal(classifyProbeError(code), "certificate_invalid", code);
  }
  for (const code of ["ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR", "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "EPROTO"]) {
    assert.equal(classifyProbeError(code), "handshake_refused", code);
  }
  // Anything that is not a statement by the TLS layer is "unreachable".
  for (const code of ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "SOMETHING_NEW", undefined]) {
    assert.equal(classifyProbeError(code), "unreachable", String(code));
  }
});

test("computeDomainProof is a keyed, per-domain value", () => {
  const proof = computeDomainProof("s".repeat(32), "d1");
  assert.match(proof, /^[0-9a-f]{64}$/);
  assert.equal(proof, computeDomainProof("s".repeat(32), "d1"));
  assert.notEqual(proof, computeDomainProof("s".repeat(32), "d2"));
  assert.notEqual(proof, computeDomainProof("t".repeat(32), "d1"));
});

test("decideCertificateIssuance: only the all-green row is allowed, each fault has its reason", () => {
  const green = {
    verificationStatus: "verified",
    enabled: true,
    routingStatus: "ok",
    entitled: true,
    targetExists: true,
  };
  assert.deepEqual(decideCertificateIssuance(green), { allowed: true });

  const cases: Array<[Partial<typeof green>, string]> = [
    [{ verificationStatus: "pending" }, "not_verified"],
    [{ verificationStatus: "expired" }, "not_verified"],
    [{ verificationStatus: "failed" }, "not_verified"],
    [{ enabled: false }, "disabled"],
    [{ routingStatus: "pending" }, "dns_not_routed"],
    [{ routingStatus: "misrouted" }, "dns_not_routed"],
    [{ routingStatus: "unresolvable" }, "dns_not_routed"],
    [{ entitled: false }, "plan_inactive"],
    [{ targetExists: false }, "target_missing"],
  ];
  for (const [fault, reason] of cases) {
    assert.deepEqual(decideCertificateIssuance({ ...green, ...fault }), { allowed: false, reason });
  }
  // Every fault at once is still a denial.
  assert.equal(
    decideCertificateIssuance({
      verificationStatus: "pending",
      enabled: false,
      routingStatus: "misrouted",
      entitled: false,
      targetExists: false,
    }).allowed,
    false,
  );
});

// ---------------------------------------------------------------------------
// DNS instructions
// ---------------------------------------------------------------------------

test("buildDnsInstructions: CNAME for a subdomain, A/AAAA for an apex, nothing invented without an edge", () => {
  const edge = { hostname: "edge.wheelsai.io", ...EDGE };
  const sub = buildDnsInstructions({ domain: "api.customer.com", verificationToken: TOKEN, isApex: false }, edge);
  assert.deepEqual(sub.txtRecord, {
    name: "_wheels-verification.api.customer.com",
    type: "TXT",
    value: TOKEN,
  });
  assert.deepEqual(sub.cnameRecord, { name: "api.customer.com", type: "CNAME", value: "edge.wheelsai.io" });
  assert.deepEqual(sub.aRecords, [{ name: "api.customer.com", type: "A", value: "137.66.10.1" }]);
  assert.deepEqual(sub.aaaaRecords, [{ name: "api.customer.com", type: "AAAA", value: "2a09:8280:1::a:1" }]);
  assert.equal(sub.recommended, "cname");

  assert.equal(
    buildDnsInstructions({ domain: "customer.com", verificationToken: TOKEN, isApex: true }, edge).recommended,
    "a",
  );
  // A delegated subdomain can be an apex too: the SOA answer wins over the label count.
  assert.equal(
    buildDnsInstructions({ domain: "zone.customer.com", verificationToken: TOKEN, isApex: true }, edge).recommended,
    "a",
  );
  // Before the SOA check has run, the label count is the guess.
  assert.equal(
    buildDnsInstructions({ domain: "customer.com", verificationToken: TOKEN, isApex: null }, edge).recommended,
    "a",
  );
  assert.equal(
    buildDnsInstructions({ domain: "api.customer.com", verificationToken: TOKEN, isApex: null }, edge).recommended,
    "cname",
  );

  const unconfigured = buildDnsInstructions({ domain: "api.customer.com", verificationToken: TOKEN, isApex: false }, null);
  assert.equal(unconfigured.cnameRecord, null);
  assert.deepEqual(unconfigured.aRecords, []);
  assert.deepEqual(unconfigured.aaaaRecords, []);
  assert.equal(unconfigured.recommended, null);
  assert.equal(unconfigured.txtRecord.value, TOKEN);
});

// ---------------------------------------------------------------------------
// decideDomainTransition: verification
// ---------------------------------------------------------------------------

test("pending + matching TXT record -> verified, and the claim is acquired", () => {
  const d = decide(row(), obs());
  assert.equal(d.verificationStatus, "verified");
  assert.equal(d.patch.verificationStatus, "verified");
  assert.equal(d.patch.verifiedDomain, "api.customer.com");
  assert.deepEqual(d.patch.verifiedAt, NOW);
  assert.equal(d.patch.verificationError, null);
  assert.ok(eventTypes(d).includes("verification_success"));
});

test("pending + resolver error -> nothing about verification changes, and 'failed' is never written", () => {
  for (const code of ["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED"]) {
    const d = decide(row(), obs({ txt: { kind: "transient", code }, addresses: { kind: "transient", code } }));
    assert.equal(d.verificationStatus, "pending");
    assert.equal("verificationStatus" in d.patch, false);
    assert.equal("verificationError" in d.patch, false);
    assert.equal("routingStatus" in d.patch, false);
    assert.equal("routingCheckedAt" in d.patch, false);
    assert.deepEqual(d.events, []);
  }
  // Not even after the 14 days: an expiry needs an answer that the record is absent.
  const old = decide(row({ verificationStartedAt: at(-30 * DAY) }), obs({ txt: { kind: "transient", code: "ETIMEOUT" } }));
  assert.equal(old.verificationStatus, "pending");

  // No status this module can write is 'failed' for verification.
  const statuses = new Set<string>();
  for (const txt of [TXT_OK, { kind: "absent" as const }, { kind: "transient" as const, code: "ESERVFAIL" }]) {
    for (const r of [row(), row({ verificationStatus: "failed" }), servingRow(), row({ verificationStatus: "expired" })]) {
      statuses.add(decide(r, obs({ txt })).verificationStatus);
    }
  }
  assert.equal(statuses.has("failed" as never), false);
});

test("pending + no record -> stays pending and says what is missing, without an event", () => {
  const d = decide(row(), obs({ txt: { kind: "absent" } }));
  assert.equal(d.verificationStatus, "pending");
  assert.match(d.patch.verificationError ?? "", /No TXT record was found at _wheels-verification\.api\.customer\.com/);
  assert.equal(d.patch.verifiedDomain, undefined);
  assert.deepEqual(eventTypes(d).filter((t) => t.startsWith("verification")), []);

  const wrong = decide(row(), obs({ txt: { kind: "found", records: [["something-else"]] } }));
  assert.equal(wrong.verificationStatus, "pending");
  assert.match(wrong.patch.verificationError ?? "", /does not match/);
});

test("a legacy 'failed' row is treated as pending and can verify", () => {
  assert.equal(decide(row({ verificationStatus: "failed" }), obs()).verificationStatus, "verified");
});

test("pending for 14 days without the record -> expired, and it is not checked again", () => {
  const justUnder = decide(row({ verificationStartedAt: at(-14 * DAY + MINUTE) }), obs({ txt: { kind: "absent" } }));
  assert.equal(justUnder.verificationStatus, "pending");

  const d = decide(
    row({ verificationStartedAt: at(-14 * DAY), routingStatus: "ok", observedAddresses: ["137.66.10.1"] }),
    obs({ txt: { kind: "absent" } }),
  );
  assert.equal(d.verificationStatus, "expired");
  assert.equal(d.patch.verificationStatus, "expired");
  assert.equal(d.nextCheckAt, null);
  assert.equal(d.patch.nextCheckAt, null);
  assert.deepEqual(eventTypes(d), ["verification_expired"]);
  // Never verified, so it is not "paused": it was never set up.
  assert.equal(d.pausedReason, null);
});

test("a record published on day 20 still verifies a claim that is being checked", () => {
  const d = decide(row({ verificationStartedAt: at(-20 * DAY) }), obs());
  assert.equal(d.verificationStatus, "verified");
});

test("verified + record missing -> the 72 hour grace starts and the domain keeps serving", () => {
  const d = decide(servingRow(), obs({ txt: { kind: "absent" }, probe: VALID }));
  assert.equal(d.verificationStatus, "verified");
  assert.deepEqual(d.patch.verificationLostAt, NOW);
  assert.match(d.patch.verificationError ?? "", /keeps serving until 2026-10-09T12:00:00\.000Z/);
  assert.equal(d.isActive, true);
  assert.equal("verifiedDomain" in d.patch, false);
  assert.deepEqual(eventTypes(d), ["verification_lost"]);
  // In grace it is looked at hourly.
  assert.equal(d.nextCheckAt!.getTime() - NOW.getTime(), HOUR);
});

test("verified + record still missing inside the grace -> still serving, no repeated event", () => {
  const d = decide(servingRow({ verificationLostAt: at(-71 * HOUR) }), obs({ txt: { kind: "absent" } }));
  assert.equal(d.verificationStatus, "verified");
  assert.equal(d.isActive, true);
  assert.deepEqual(d.events, []);
});

test("verified + record missing for 72 hours -> expired, claim released, serving stops", () => {
  const d = decide(
    servingRow({ verificationLostAt: at(-72 * HOUR), sslProvisioningSince: null }),
    obs({ txt: { kind: "absent" } }),
  );
  assert.equal(d.verificationStatus, "expired");
  assert.equal(d.patch.verificationStatus, "expired");
  assert.equal(d.patch.verifiedDomain, null);
  assert.equal(d.isActive, false);
  assert.equal(d.patch.isActive, false);
  assert.equal(d.pausedReason, "verification_lost");
  assert.equal(d.nextCheckAt, null);
  // Nobody observes the certificate any more, so its record is cleared.
  assert.equal(d.patch.sslStatus, "pending");
  assert.equal(d.patch.sslExpiresAt, null);
  assert.equal(d.patch.sslIssuer, null);
  assert.deepEqual(eventTypes(d), ["verification_expired", "serving_stopped"]);
});

test("verified + resolver error during the grace -> the clock is not advanced into expiry", () => {
  const d = decide(servingRow({ verificationLostAt: at(-100 * HOUR) }), obs({ txt: { kind: "transient", code: "ESERVFAIL" } }));
  assert.equal(d.verificationStatus, "verified");
  assert.equal(d.isActive, true);
});

test("verified + record back -> grace cleared", () => {
  const d = decide(servingRow({ verificationLostAt: at(-10 * HOUR), verificationError: "missing" }), obs());
  assert.equal(d.patch.verificationLostAt, null);
  assert.equal(d.patch.verificationError, null);
  assert.deepEqual(eventTypes(d), ["verification_restored"]);
});

test("an expired claim verifies again when its record is found, and stays expired otherwise", () => {
  const back = decide(row({ verificationStatus: "expired", verifiedAt: at(-40 * DAY) }), obs());
  assert.equal(back.verificationStatus, "verified");
  assert.equal(back.patch.verifiedDomain, "api.customer.com");

  const still = decide(
    row({ verificationStatus: "expired", routingStatus: "ok", observedAddresses: ["137.66.10.1"] }),
    obs({ txt: { kind: "absent" } }),
  );
  assert.equal(still.verificationStatus, "expired");
  assert.equal(still.nextCheckAt, null);
  assert.deepEqual(still.events, []);
});

test("a verified row without the claim acquires it", () => {
  const d = decide(servingRow({ verifiedDomain: null }), obs());
  assert.equal(d.patch.verifiedDomain, "api.customer.com");
  assert.equal("verifiedDomain" in decide(servingRow(), obs()).patch, false);
});

test("claimedElsewhereDecision: stays pending with an honest error, logged once", () => {
  const first = claimedElsewhereDecision(row(), NOW);
  assert.equal(first.patch.verificationError, CLAIMED_ELSEWHERE_MESSAGE);
  assert.equal(first.patch.verificationStatus, undefined);
  assert.equal(first.patch.verifiedDomain, undefined);
  assert.deepEqual(eventTypes(first), ["claimed_elsewhere"]);
  assert.equal(first.patch.nextCheckAt!.getTime() - NOW.getTime(), 30 * MINUTE);

  const again = claimedElsewhereDecision(row({ verificationError: CLAIMED_ELSEWHERE_MESSAGE }), NOW);
  assert.deepEqual(again.events, []);

  // A row that claims to be verified without holding the name is put back.
  const demoted = claimedElsewhereDecision(servingRow({ verifiedDomain: null }), NOW);
  assert.equal(demoted.patch.verificationStatus, "pending");
  assert.equal(demoted.patch.isActive, false);
  assert.equal(demoted.patch.sslStatus, "pending");

  assert.equal(claimedElsewhereDecision(row({ verificationStatus: "expired" }), NOW).patch.nextCheckAt, null);
});

// ---------------------------------------------------------------------------
// decideDomainTransition: routing
// ---------------------------------------------------------------------------

test("routing: on the edge -> ok; elsewhere -> misrouted; nothing -> unresolvable", () => {
  const ok = decide(row(), obs({ txt: { kind: "absent" } }));
  assert.equal(ok.routingStatus, "ok");
  assert.deepEqual(ok.patch.observedAddresses, ["137.66.10.1"]);
  assert.deepEqual(ok.patch.routingCheckedAt, NOW);
  assert.ok(eventTypes(ok).includes("routing_ok"));

  const cdn = decide(row(), obs({ addresses: { kind: "found", addresses: ["104.16.0.1"] } }));
  assert.equal(cdn.routingStatus, "misrouted");
  assert.match(cdn.patch.routingError ?? "", /104\.16\.0\.1.*not the edge.*DNS only/);

  const none = decide(row(), obs({ addresses: { kind: "absent" } }));
  assert.equal(none.routingStatus, "unresolvable");
  assert.match(none.patch.routingError ?? "", /no A, AAAA or CNAME record/);
});

test("routing: one bad answer does not take a live domain down; the second does", () => {
  const stray = { kind: "found" as const, addresses: ["137.66.10.1", "203.0.113.9"] };

  const first = decide(servingRow(), obs({ addresses: stray, probe: VALID }));
  assert.equal(first.routingStatus, "ok");
  assert.equal(first.patch.routingFailures, 1);
  assert.equal("routingStatus" in first.patch, false);
  assert.equal(first.isActive, true);
  assert.deepEqual(first.events, []);
  // ...and it is looked at again within minutes, not in six hours.
  assert.equal(first.nextCheckAt!.getTime() - NOW.getTime(), 2 * MINUTE);

  const second = decide(servingRow({ routingFailures: 1 }), obs({ addresses: stray }));
  assert.equal(second.routingStatus, "misrouted");
  assert.equal(second.patch.routingStatus, "misrouted");
  assert.equal(second.isActive, false);
  assert.equal(second.pausedReason, "dns_not_routed");
  assert.deepEqual(eventTypes(second), ["routing_lost", "serving_stopped"]);
  // The certificate that WAS observed keeps its record.
  assert.equal("sslStatus" in second.patch, false);

  const recovered = decide(servingRow({ routingFailures: 1 }), obs({ probe: VALID }));
  assert.equal(recovered.patch.routingFailures, 0);
  assert.equal(recovered.isActive, true);
});

test("routing: a resolver error leaves the routing state exactly as it was", () => {
  const d = decide(servingRow(), obs({ addresses: { kind: "transient", code: "ESERVFAIL" } }));
  assert.equal(d.routingStatus, "ok");
  assert.equal("routingFailures" in d.patch, false);
  assert.equal("observedAddresses" in d.patch, false);
  assert.equal(d.isActive, true);
});

test("the apex answer is stored once it is known", () => {
  assert.equal(decide(row({ isApex: null }), obs({ isApex: true })).patch.isApex, true);
  assert.equal("isApex" in decide(row({ isApex: null }), obs({ isApex: null })).patch, false);
  assert.equal("isApex" in decide(row({ isApex: true }), obs({ isApex: true })).patch, false);
});

// ---------------------------------------------------------------------------
// decideDomainTransition: certificate and serving
// ---------------------------------------------------------------------------

test("verified and routed -> 'provisioning', never 'active', until a handshake shows a certificate", () => {
  const d = decide(row(), obs());
  assert.equal(d.sslStatus, "provisioning");
  assert.deepEqual(d.patch.sslProvisioningSince, NOW);
  assert.equal(d.isActive, false);
  assert.equal(d.patch.sslExpiresAt, undefined);
  assert.equal(d.patch.sslIssuer, undefined);
  assert.equal(d.pausedReason, null);
  assert.ok(eventTypes(d).includes("ssl_provisioning"));
});

test("no sequence of checks without a valid handshake ever yields an active certificate", () => {
  const outcomes: Array<TlsProbeOutcome | null> = [
    null,
    REFUSED,
    UNREACHABLE,
    { kind: "certificate_invalid", code: "CERT_HAS_EXPIRED", message: "expired" },
    { ...VALID, proof: "mismatch" } as TlsProbeOutcome,
    { ...VALID, proof: "upstream_unavailable" } as TlsProbeOutcome,
  ];
  let current = row();
  let now = NOW;
  for (let i = 0; i < 60; i++) {
    const d = decideDomainTransition(current, obs({ probe: outcomes[i % outcomes.length]! }), EDGE, now);
    assert.notEqual(d.sslStatus, "active");
    assert.equal(d.isActive, false);
    assert.equal(d.patch.sslExpiresAt ?? null, null);
    current = { ...current, ...(d.patch as Partial<CustomDomainCheckRow>) };
    now = d.nextCheckAt ?? new Date(now.getTime() + HOUR);
  }
});

test("a valid handshake -> active with exactly the observed certificate, and serving", () => {
  const provisioning = row({
    verificationStatus: "verified",
    verifiedDomain: "api.customer.com",
    verifiedAt: at(-5 * MINUTE),
    routingStatus: "ok",
    observedAddresses: ["137.66.10.1"],
    sslStatus: "provisioning",
    sslProvisioningSince: at(-3 * MINUTE),
    sslFailures: 1,
  });
  const d = decide(provisioning, obs({ probe: VALID }));
  assert.equal(d.sslStatus, "active");
  assert.equal(d.patch.sslStatus, "active");
  assert.equal(d.patch.sslProvider, "edge_acme");
  assert.equal(d.patch.sslIssuer, "Let's Encrypt R11");
  assert.deepEqual(d.patch.sslValidFrom, at(-DAY));
  assert.deepEqual(d.patch.sslExpiresAt, at(89 * DAY));
  assert.equal(d.patch.sslFingerprint256, "AA:BB");
  assert.deepEqual(d.patch.sslCheckedAt, NOW);
  assert.equal(d.patch.sslFailures, 0);
  assert.equal(d.patch.sslError, null);
  assert.equal(d.isActive, true);
  assert.equal(d.patch.isActive, true);
  assert.deepEqual(eventTypes(d), ["ssl_observed", "serving_started"]);
  assert.equal(d.nextCheckAt!.getTime() - NOW.getTime(), 6 * HOUR);
});

test("a certificate with a new fingerprint is recorded as a renewal; the same one logs nothing", () => {
  const renewed = decide(servingRow({ sslFingerprint256: "OLD" }), obs({ probe: VALID }));
  assert.deepEqual(eventTypes(renewed), ["ssl_renewed"]);
  assert.equal(renewed.patch.sslFingerprint256, "AA:BB");
  assert.deepEqual(decide(servingRow(), obs({ probe: VALID })).events, []);
});

test("a valid certificate without the proof is not servable", () => {
  const provisioning = row({
    verificationStatus: "verified",
    verifiedDomain: "api.customer.com",
    verifiedAt: at(-5 * MINUTE),
    routingStatus: "ok",
    sslStatus: "provisioning",
    sslProvisioningSince: at(-3 * MINUTE),
  });
  for (const proof of ["mismatch", "upstream_unavailable"] as const) {
    const d = decide(provisioning, obs({ probe: { ...VALID, proof } as TlsProbeOutcome }));
    assert.equal(d.sslStatus, "provisioning");
    assert.equal(d.isActive, false);
    // The handshake is reported as what it was, and none of the certificate's
    // details are recorded as this domain's.
    assert.deepEqual(d.patch.sslCheckedAt, NOW);
    assert.match(d.patch.sslError ?? "", /^The certificate is valid, but /);
    assert.equal("sslIssuer" in d.patch, false);
    assert.equal("sslExpiresAt" in d.patch, false);
    assert.equal("sslFingerprint256" in d.patch, false);
    assert.equal("sslFailures" in d.patch, false);
  }
  // ...and it never demotes a domain that is serving, or writes over its record.
  const active = decide(servingRow(), obs({ probe: { ...VALID, proof: "upstream_unavailable" } as TlsProbeOutcome }));
  assert.equal(active.sslStatus, "active");
  assert.equal(active.isActive, true);
  assert.equal("sslFailures" in active.patch, false);
  assert.equal("sslError" in active.patch, false);
  assert.equal("sslCheckedAt" in active.patch, false);
});

test("three consecutive invalid handshakes -> failed and not serving; fewer do not flip", () => {
  const invalid: TlsProbeOutcome = {
    kind: "certificate_invalid",
    code: "ERR_TLS_CERT_ALTNAME_INVALID",
    message: "altname",
  };
  const first = decide(servingRow(), obs({ probe: invalid }));
  assert.equal(first.sslStatus, "active");
  assert.equal(first.patch.sslFailures, 1);
  assert.equal(first.isActive, true);
  assert.equal(first.nextCheckAt!.getTime() - NOW.getTime(), 5 * MINUTE);

  const second = decide(servingRow({ sslFailures: 1 }), obs({ probe: invalid }));
  assert.equal(second.sslStatus, "active");
  assert.equal(second.isActive, true);

  const third = decide(servingRow({ sslFailures: 2 }), obs({ probe: invalid }));
  assert.equal(third.sslStatus, "failed");
  assert.equal(third.patch.sslStatus, "failed");
  assert.equal(third.isActive, false);
  assert.equal(third.pausedReason, "certificate_invalid");
  assert.match(third.patch.sslError ?? "", /ERR_TLS_CERT_ALTNAME_INVALID/);
  assert.deepEqual(eventTypes(third), ["ssl_invalid", "serving_stopped"]);

  const expired = decide(
    servingRow({ sslFailures: 2 }),
    obs({ probe: { kind: "certificate_invalid", code: "CERT_HAS_EXPIRED", message: "expired" } }),
  );
  assert.equal(expired.sslStatus, "expired");
  assert.equal(expired.pausedReason, "certificate_invalid");
});

test("a failed certificate recovers on the next valid handshake", () => {
  const d = decide(servingRow({ sslStatus: "failed", sslFailures: 5, isActive: false, pausedReason: "certificate_invalid" }), obs({ probe: VALID }));
  assert.equal(d.sslStatus, "active");
  assert.equal(d.isActive, true);
  assert.equal(d.patch.pausedReason, null);
});

test("an unreachable edge never flips serving, however often it happens", () => {
  let current = servingRow();
  for (let i = 0; i < 20; i++) {
    const d = decide(current, obs({ probe: UNREACHABLE }));
    assert.equal(d.sslStatus, "active");
    assert.equal(d.isActive, true);
    assert.equal("sslFailures" in d.patch, false);
    assert.equal("sslStatus" in d.patch, false);
    assert.equal("isActive" in d.patch, false);
    assert.deepEqual(d.events, []);
    current = { ...current, ...(d.patch as Partial<CustomDomainCheckRow>) };
  }
});

test("provisioning: refusals keep it provisioning; after 7 days it is failed with the last result", () => {
  const provisioning = (sinceMs: number, failures = 0) =>
    row({
      verificationStatus: "verified",
      verifiedDomain: "api.customer.com",
      verifiedAt: at(sinceMs),
      routingStatus: "ok",
      sslStatus: "provisioning",
      sslProvisioningSince: at(sinceMs),
      sslFailures: failures,
    });

  const early = decide(provisioning(-2 * DAY, 40), obs({ probe: REFUSED, caaDiagnostic: "CAA says no." }));
  assert.equal(early.sslStatus, "provisioning");
  assert.equal(early.patch.sslFailures, 41);
  assert.match(early.patch.sslError ?? "", /no certificate for this domain yet.*CAA says no\./);
  assert.equal(early.pausedReason, null);

  const late = decide(provisioning(-7 * DAY), obs({ probe: REFUSED }));
  assert.equal(late.sslStatus, "failed");
  assert.match(late.patch.sslError ?? "", /within 7 days/);
  assert.equal(late.pausedReason, "certificate_invalid");
  assert.ok(eventTypes(late).includes("ssl_invalid"));

  // Without a handshake result there is nothing to conclude from.
  assert.equal(decide(provisioning(-8 * DAY), obs({ probe: null })).sslStatus, "provisioning");
});

test("losing routing while provisioning goes back to 'pending'", () => {
  const r = row({
    verificationStatus: "verified",
    verifiedDomain: "api.customer.com",
    verifiedAt: at(-HOUR),
    routingStatus: "ok",
    routingFailures: 1,
    sslStatus: "provisioning",
    sslProvisioningSince: at(-HOUR),
  });
  const d = decide(r, obs({ addresses: { kind: "absent" } }));
  assert.equal(d.routingStatus, "unresolvable");
  assert.equal(d.sslStatus, "pending");
  assert.equal(d.patch.sslProvisioningSince, null);
});

test("plan lapse pauses with plan_inactive; plan return serves again", () => {
  const lapsed = decide(servingRow(), obs({ entitled: false }));
  assert.equal(lapsed.isActive, false);
  assert.equal(lapsed.pausedReason, "plan_inactive");
  assert.equal(lapsed.patch.pausedReason, "plan_inactive");
  assert.deepEqual(eventTypes(lapsed), ["plan_paused", "serving_stopped"]);
  assert.equal(lapsed.nextCheckAt!.getTime() - NOW.getTime(), HOUR);
  // The verified claim and the observed certificate are untouched.
  assert.equal("verifiedDomain" in lapsed.patch, false);
  assert.equal("sslStatus" in lapsed.patch, false);

  const back = decide(servingRow({ isActive: false, pausedReason: "plan_inactive" }), obs({ entitled: true }));
  assert.equal(back.isActive, true);
  assert.equal(back.pausedReason, null);
  assert.deepEqual(eventTypes(back), ["plan_resumed", "serving_started"]);
});

test("a missing target pauses with target_missing", () => {
  const d = decide(servingRow(), obs({ targetExists: false }));
  assert.equal(d.isActive, false);
  assert.equal(d.pausedReason, "target_missing");
  assert.deepEqual(eventTypes(d), ["target_missing", "serving_stopped"]);
});

test("a domain its owner disabled is never activated by a check", () => {
  const disabled = servingRow({ enabled: false, isActive: false, pausedReason: "disabled" });
  const d = decide(disabled, obs({ probe: VALID }));
  assert.equal(d.isActive, false);
  assert.equal(d.pausedReason, "disabled");
  assert.equal("isActive" in d.patch, false);
  assert.deepEqual(d.events, []);

  // Nor does a disabled, verified, routed domain start provisioning.
  const fresh = decide(row({ enabled: false }), obs());
  assert.equal(fresh.sslStatus, "pending");
  assert.equal(fresh.isActive, false);
  assert.equal(fresh.pausedReason, "disabled");
});

test("an unentitled organisation's domain does not start provisioning", () => {
  const d = decide(row(), obs({ entitled: false }));
  assert.equal(d.verificationStatus, "verified");
  assert.equal(d.sslStatus, "pending");
  assert.equal(d.pausedReason, "plan_inactive");
});

test("a check that changes nothing logs nothing", () => {
  assert.deepEqual(decide(servingRow(), obs({ probe: VALID })).events, []);
  assert.deepEqual(decide(servingRow(), obs()).events, []);
  const pending = row({ verificationError: "No TXT record was found at _wheels-verification.api.customer.com.", routingStatus: "ok", observedAddresses: ["137.66.10.1"] });
  const d = decide(pending, obs({ txt: { kind: "absent" } }));
  assert.deepEqual(d.events, []);
  assert.equal("verificationError" in d.patch, false);
});

// ---------------------------------------------------------------------------
// wantsTlsProbe
// ---------------------------------------------------------------------------

test("wantsTlsProbe: only a stored verified, routed, enabled, entitled domain with a target", () => {
  const base: Omit<DomainObservation, "probe"> = {
    txt: TXT_OK,
    addresses: ON_EDGE,
    isApex: null,
    entitled: true,
    targetExists: true,
  };
  const wants = (r: CustomDomainCheckRow, o = base) => wantsTlsProbe(r, o, EDGE, NOW);
  const provisioning = servingRow({ sslStatus: "provisioning", isActive: false });

  assert.equal(wants(servingRow()), true);
  assert.equal(wants(provisioning), true);
  // Verified in THIS check: the edge would still see the stored, unverified row.
  assert.equal(wants(row()), false);
  assert.equal(wants(servingRow({ verifiedDomain: null })), false);
  assert.equal(wants(servingRow({ routingStatus: "misrouted" })), false);
  assert.equal(wants(servingRow({ enabled: false })), false);
  assert.equal(wants(servingRow(), { ...base, entitled: false }), false);
  assert.equal(wants(servingRow(), { ...base, targetExists: false }), false);
  assert.equal(wants(servingRow({ verificationStatus: "expired" })), false);
  // Verification expiring in this check.
  assert.equal(wants(servingRow({ verificationLostAt: at(-80 * HOUR) }), { ...base, txt: { kind: "absent" } }), false);
  // Routing flipping in this check.
  assert.equal(wants(servingRow({ routingFailures: 1 }), { ...base, addresses: { kind: "absent" } }), false);
  // A first bad DNS answer has not flipped routing yet.
  assert.equal(wants(servingRow(), { ...base, addresses: { kind: "absent" } }), true);
  // Resolver errors leave the stored state, so the certificate is still watched.
  assert.equal(
    wants(servingRow(), { ...base, txt: { kind: "transient", code: "ETIMEOUT" }, addresses: { kind: "transient", code: "ETIMEOUT" } }),
    true,
  );
});

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

test("cadence: pending every 2 minutes for an hour, then every 30 minutes", () => {
  const delay = (startedMs: number) =>
    decide(row({ verificationStartedAt: at(startedMs) }), obs({ txt: { kind: "absent" } })).nextCheckAt!.getTime() - NOW.getTime();
  assert.equal(delay(-MINUTE), 2 * MINUTE);
  assert.equal(delay(-59 * MINUTE), 2 * MINUTE);
  assert.equal(delay(-61 * MINUTE), 30 * MINUTE);
  assert.equal(delay(-5 * DAY), 30 * MINUTE);
});

test("cadence: verified but not routed backs off from 2 minutes to hourly", () => {
  const delay = (verifiedMs: number) =>
    decide(
      row({ verificationStatus: "verified", verifiedDomain: "api.customer.com", verifiedAt: at(verifiedMs), routingStatus: "unresolvable" }),
      obs({ addresses: { kind: "absent" } }),
    ).nextCheckAt!.getTime() - NOW.getTime();
  assert.equal(delay(-10 * MINUTE), 2 * MINUTE);
  assert.equal(delay(-2 * HOUR), 15 * MINUTE);
  assert.equal(delay(-2 * DAY), HOUR);
});

test("cadence: active every 6 hours, hourly when the certificate is within 14 days of expiry", () => {
  const far = decide(servingRow(), obs({ probe: VALID }));
  assert.equal(far.nextCheckAt!.getTime() - NOW.getTime(), 6 * HOUR);
  const soon: TlsProbeOutcome = {
    ...VALID,
    certificate: { ...(VALID as Extract<TlsProbeOutcome, { kind: "valid" }>).certificate, validTo: at(10 * DAY) },
  } as TlsProbeOutcome;
  assert.equal(decide(servingRow(), obs({ probe: soon })).nextCheckAt!.getTime() - NOW.getTime(), HOUR);
  assert.equal(decide(servingRow({ sslExpiresAt: at(3 * DAY) }), obs()).nextCheckAt!.getTime() - NOW.getTime(), HOUR);
});

test("cadence: not entitled hourly, disabled every 6 hours, failed certificate every 30 minutes", () => {
  const delay = (r: CustomDomainCheckRow, o: DomainObservation) => decide(r, o).nextCheckAt!.getTime() - NOW.getTime();
  assert.equal(delay(servingRow(), obs({ entitled: false })), HOUR);
  assert.equal(delay(servingRow(), obs({ targetExists: false })), HOUR);
  assert.equal(delay(servingRow({ enabled: false }), obs()), 6 * HOUR);
  assert.equal(delay(servingRow({ sslStatus: "failed", isActive: false }), obs()), 30 * MINUTE);
});

test("cadence: a provisioning domain is never checked more than 4 times in any hour", () => {
  // Follow the schedule for two days from the check that starts provisioning,
  // with the edge refusing every handshake.
  let current = row();
  let now = NOW;
  const checks: number[] = [];
  let d = decideDomainTransition(current, obs(), EDGE, now);
  assert.equal(d.sslStatus, "provisioning");
  current = { ...current, ...(d.patch as Partial<CustomDomainCheckRow>) };
  while (d.nextCheckAt && d.nextCheckAt.getTime() - NOW.getTime() < 2 * DAY) {
    now = d.nextCheckAt;
    checks.push(now.getTime());
    d = decideDomainTransition(current, obs({ probe: REFUSED }), EDGE, now);
    assert.equal(d.sslStatus, "provisioning");
    current = { ...current, ...(d.patch as Partial<CustomDomainCheckRow>) };
  }
  assert.ok(checks.length > 50, `expected a long schedule, got ${checks.length} checks`);
  // The first probe comes soon, so a new domain is not left waiting.
  assert.equal(checks[0]! - NOW.getTime(), 2 * MINUTE);
  for (let i = 0; i < checks.length; i++) {
    const inWindow = checks.filter((t) => t >= checks[i]! && t < checks[i]! + HOUR).length;
    assert.ok(inWindow <= 4, `${inWindow} checks in the hour starting at check ${i}`);
  }
  // After a day it slows to hourly.
  const last = checks[checks.length - 1]!;
  assert.equal(last - checks[checks.length - 2]!, HOUR);
});

// ============================================
// Owner actions
// ============================================

test("switching a serving domain off stops serving at once, whatever the plan says", () => {
  for (const facts of [
    { entitled: true, targetExists: true },
    { entitled: false, targetExists: false },
  ]) {
    const d = decideEnabledChange(servingRow(), false, facts, NOW);
    assert.equal(d.patch.enabled, false);
    assert.equal(d.patch.isActive, false);
    assert.equal(d.patch.pausedReason, "disabled");
    assert.equal(d.isActive, false);
    assert.deepEqual(eventTypes(d), ["deactivated", "serving_stopped"]);
    // The certificate record is an observation and is not touched by a switch.
    assert.equal("sslStatus" in d.patch, false);
    assert.equal("verificationStatus" in d.patch, false);
    // Nothing was looked up, so "last checked" is not moved.
    assert.equal("lastCheckedAt" in d.patch, false);
  }
});

test("switching on serves only when the stored observations already allow it", () => {
  const off = (over: Partial<CustomDomainCheckRow> = {}) =>
    servingRow({ enabled: false, isActive: false, pausedReason: "disabled", ...over });
  const ok = { entitled: true, targetExists: true };

  const serving = decideEnabledChange(off(), true, ok, NOW);
  assert.equal(serving.patch.enabled, true);
  assert.equal(serving.patch.isActive, true);
  assert.equal(serving.patch.pausedReason, null);
  assert.deepEqual(eventTypes(serving), ["activated", "serving_started"]);
  // The stored certificate may be old: the checker confirms within minutes.
  assert.equal(serving.patch.nextCheckAt!.getTime(), NOW.getTime() + 2 * MINUTE);

  const cases: Array<[Partial<CustomDomainCheckRow>, typeof ok, string | null]> = [
    [{ sslStatus: "provisioning" }, ok, null],
    [{ sslStatus: "failed" }, ok, "certificate_invalid"],
    [{ routingStatus: "misrouted" }, ok, "dns_not_routed"],
    [{}, { entitled: false, targetExists: true }, "plan_inactive"],
    [{}, { entitled: true, targetExists: false }, "target_missing"],
    [{ verificationStatus: "pending", verifiedDomain: null, verifiedAt: null }, ok, null],
  ];
  for (const [over, facts, reason] of cases) {
    const d = decideEnabledChange(off(over), true, facts, NOW);
    assert.equal(d.isActive, false, JSON.stringify(over));
    assert.equal(d.patch.isActive, undefined, "serving was already false and stays unwritten");
    assert.equal(d.pausedReason, reason, JSON.stringify(over));
  }
});

test("switching on never writes an active certificate", () => {
  const d = decideEnabledChange(
    servingRow({ enabled: false, isActive: false, pausedReason: "disabled", sslStatus: "pending" }),
    true,
    { entitled: true, targetExists: true },
    NOW,
  );
  // Verified and routed, so it now waits for the edge - it is not called active.
  assert.equal(d.patch.sslStatus, "provisioning");
  assert.equal(d.isActive, false);
});

test("reverifyDecision voids the old proof: new token, claim released, serving stopped, clock restarted", () => {
  const d = reverifyDecision(servingRow({ verificationLostAt: at(-HOUR) }), "wheels-verify-new", NOW);
  assert.equal(d.patch.verificationToken, "wheels-verify-new");
  assert.equal(d.patch.verificationStatus, "pending");
  assert.equal(d.patch.verifiedDomain, null);
  assert.equal(d.patch.verificationLostAt, null);
  assert.equal(d.patch.verificationStartedAt.getTime(), NOW.getTime());
  assert.equal(d.patch.isActive, false);
  assert.equal(d.patch.pausedReason, null);
  // Nobody observes the certificate of an unverified name.
  assert.equal(d.patch.sslStatus, "pending");
  assert.equal(d.patch.sslIssuer, null);
  assert.equal(d.patch.sslExpiresAt, null);
  assert.equal(d.patch.sslFingerprint256, null);
  assert.deepEqual(eventTypes(d), ["reverification_started", "serving_stopped"]);
  assert.equal(d.patch.nextCheckAt!.getTime(), NOW.getTime() + 2 * MINUTE);

  const pending = reverifyDecision(row({ enabled: false, pausedReason: "disabled" }), "t2", NOW);
  assert.deepEqual(eventTypes(pending), ["reverification_started"]);
  assert.equal(pending.patch.pausedReason, "disabled");
});

// ============================================
// Custom response headers
// ============================================

test("validateCustomHeaders accepts ordinary headers and nothing at all", () => {
  assert.deepEqual(validateCustomHeaders(undefined), { ok: true, headers: {} });
  assert.deepEqual(validateCustomHeaders(null), { ok: true, headers: {} });
  assert.deepEqual(validateCustomHeaders({ "X-Robots-Tag": "noindex", "Cache-Control": "no-store" }), {
    ok: true,
    headers: { "X-Robots-Tag": "noindex", "Cache-Control": "no-store" },
  });
});

test("validateCustomHeaders refuses platform headers, bad names, bad values and too many", () => {
  const refused: unknown[] = [
    { "Set-Cookie": "a=b" },
    { "content-length": "1" },
    { "Transfer-Encoding": "chunked" },
    { Connection: "close" },
    { Location: "https://evil.example" },
    { "Strict-Transport-Security": "max-age=1; includeSubDomains" },
    { "Access-Control-Allow-Origin": "*" },
    { "X-Wheels-Edge-Token": "x" },
    { "Content-Type": "text/html" },
    { "bad name": "x" },
    { "x:y": "x" },
    { "": "x" },
    { ["a".repeat(65)]: "x" },
    { "X-A": "line\r\nInjected: 1" },
    { "X-A": "nul\u0000" },
    { "X-A": "é" },
    { "X-A": "v".repeat(513) },
    { "X-A": 5 },
    { "X-A": "1", "x-a": "2" },
    ["X-A"],
    "X-A: 1",
    Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-H${i}`, "v"])),
  ];
  for (const input of refused) {
    const result = validateCustomHeaders(input);
    assert.equal(result.ok, false, JSON.stringify(input));
  }
  const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`X-H${i}`, "v"]));
  assert.equal(validateCustomHeaders(twenty).ok, true);
  assert.equal(validateCustomHeaders({ "X-A": "v".repeat(512) }).ok, true);
});

test("applicableCustomHeaders drops whatever a stored row holds that would not pass today", () => {
  assert.deepEqual(
    applicableCustomHeaders({
      "X-Ok": "1",
      "Set-Cookie": "session=stolen",
      "Strict-Transport-Security": "max-age=1; includeSubDomains",
      "X-Bad": "a\r\nb",
      "X-Num": 3,
    }),
    { "X-Ok": "1" },
  );
  for (const junk of [null, undefined, "x", 3, ["a"]]) assert.deepEqual(applicableCustomHeaders(junk), {});
});

// ============================================
// Requests on a customer hostname
// ============================================

function edgeRoute(over: Partial<EdgeRoute> = {}): EdgeRoute {
  return {
    domainId: "d1",
    orgId: "org1",
    domain: "api.customer.com",
    targetType: "deployment",
    targetSlug: "llama-prod",
    serving: true,
    headers: {},
    ...over,
  };
}

const edge = (method: string, url: string, route = edgeRoute(), https = true) =>
  mapEdgeRequest({ method, url, https, route });

test("normalizeEdgeHost: port, case and a trailing dot are removed; junk is null", () => {
  assert.equal(normalizeEdgeHost("API.Customer.com"), "api.customer.com");
  assert.equal(normalizeEdgeHost("api.customer.com:443"), "api.customer.com");
  assert.equal(normalizeEdgeHost("api.customer.com."), "api.customer.com");
  assert.equal(normalizeEdgeHost(" api.customer.com.:8443 "), "api.customer.com");
  assert.equal(normalizeEdgeHost("bücher.example.com"), "xn--bcher-kva.example.com");
  for (const junk of ["", "localhost", "10.0.0.1", "[::1]:443", "a b.com", "api.customer.com/path", undefined, null, 5, ["a.com"]]) {
    assert.equal(normalizeEdgeHost(junk), null, String(junk));
  }
});

test("a deployment domain is an OpenAI base URL for that one deployment", () => {
  assert.deepEqual(edge("POST", "/v1/chat/completions"), {
    kind: "forward",
    url: "/v1/llama-prod/chat/completions",
  });
  assert.deepEqual(edge("post", "/v1/chat/completions?trace=1&x=y"), {
    kind: "forward",
    url: "/v1/llama-prod/chat/completions?trace=1&x=y",
  });
  assert.deepEqual(edge("GET", "/v1/models"), { kind: "forward", url: "/v1/models?deployment=llama-prod" });
  // The caller's query cannot name another deployment.
  assert.deepEqual(edge("GET", "/v1/models?deployment=someone-elses"), {
    kind: "forward",
    url: "/v1/models?deployment=llama-prod",
  });
});

test("an agent domain is an OpenAI base URL for that one agent", () => {
  const agent = edgeRoute({ targetType: "agent", targetSlug: "support-bot" });
  assert.deepEqual(edge("POST", "/v1/chat/completions?x=1", agent), {
    kind: "forward",
    url: "/v1/agents/support-bot/chat/completions?x=1",
  });
  assert.deepEqual(edge("GET", "/v1/models", agent), { kind: "forward", url: "/v1/agents/support-bot/models" });
});

test("a slug is encoded into one path segment", () => {
  const odd = edgeRoute({ targetSlug: "a/b?c#d" });
  assert.deepEqual(edge("POST", "/v1/chat/completions", odd), {
    kind: "forward",
    url: "/v1/a%2Fb%3Fc%23d/chat/completions",
  });
});

test("nothing else of the API is reachable through a customer hostname", () => {
  const paths: Array<[string, string]> = [
    ["POST", "/api/auth/login"],
    ["GET", "/api/agents"],
    ["GET", "/api/domains"],
    ["GET", "/health"],
    ["GET", "/metrics"],
    ["GET", "/docs"],
    ["GET", "/"],
    ["GET", "/internal/edge/ask?domain=a.com&token=x"],
    ["GET", "/__edge/respond"],
    // Another target's canonical routes.
    ["POST", "/v1/other-deployment/chat/completions"],
    ["POST", "/v1/agents/other-agent/chat/completions"],
    ["POST", "/v1/workflows/w/chat/completions"],
    // Near misses of the two paths that do exist.
    ["GET", "/v1/chat/completions"],
    ["POST", "/v1/models"],
    ["DELETE", "/v1/models"],
    ["OPTIONS", "/v1/chat/completions"],
    ["POST", "/v1/chat/completions/"],
    ["POST", "//v1/chat/completions"],
    ["POST", "/v1/chat/completions;x=1"],
    ["POST", "/v1/chat%2Fcompletions"],
    ["POST", "/V1/chat/completions"],
    ["POST", "/v1/../api/auth/login"],
    ["POST", "http://api.internal/v1/chat/completions"],
  ];
  for (const targetType of ["deployment", "agent"]) {
    for (const [method, url] of paths) {
      assert.deepEqual(
        edge(method, url, edgeRoute({ targetType })),
        { kind: "not_found" },
        `${targetType} ${method} ${url}`,
      );
    }
  }
  // A target type this router does not know serves nothing.
  assert.deepEqual(edge("POST", "/v1/chat/completions", edgeRoute({ targetType: "workflow" })), {
    kind: "not_found",
  });
});

test("the proof path answers for a verified domain that is not serving yet, over TLS only", () => {
  const notServing = edgeRoute({ serving: false });
  assert.deepEqual(edge("GET", DOMAIN_PROOF_PATH, notServing), { kind: "proof" });
  assert.deepEqual(edge("GET", `${DOMAIN_PROOF_PATH}?x=1`, notServing), { kind: "proof" });
  assert.deepEqual(edge("GET", DOMAIN_PROOF_PATH, edgeRoute({ targetSlug: null, serving: false })), { kind: "proof" });
  assert.deepEqual(edge("POST", DOMAIN_PROOF_PATH, notServing), { kind: "unrouted" });
  assert.deepEqual(edge("GET", DOMAIN_PROOF_PATH, notServing, false), { kind: "unrouted" });
});

test("a domain that is not serving routes nowhere", () => {
  for (const route of [edgeRoute({ serving: false }), edgeRoute({ targetSlug: null })]) {
    assert.deepEqual(edge("POST", "/v1/chat/completions", route), { kind: "unrouted" });
    assert.deepEqual(edge("GET", "/v1/models", route), { kind: "unrouted" });
    assert.deepEqual(edge("GET", "/anything", route), { kind: "unrouted" });
    // Not redirected either: there may be no certificate to redirect to.
    assert.deepEqual(edge("GET", "/v1/models", route, false), { kind: "unrouted" });
  }
});

test("plain HTTP on a serving domain is always redirected to HTTPS on the same host", () => {
  assert.deepEqual(edge("POST", "/v1/chat/completions?x=1", edgeRoute(), false), {
    kind: "redirect",
    location: "https://api.customer.com/v1/chat/completions?x=1",
  });
  assert.deepEqual(edge("GET", "/whatever", edgeRoute(), false), {
    kind: "redirect",
    location: "https://api.customer.com/whatever",
  });
  // An absolute-form target cannot turn the redirect toward another host.
  assert.deepEqual(edge("GET", "http://evil.example/x", edgeRoute(), false), {
    kind: "redirect",
    location: "https://api.customer.com/",
  });
  assert.deepEqual(edge("GET", "//evil.example/x", edgeRoute(), false), {
    kind: "redirect",
    location: "https://api.customer.com//evil.example/x",
  });
});

// ============================================
// Shared capacity: the issuance budget, the checker batch, new tokens
// ============================================

test("decideIssuanceBudget: grants below every limit, and names the narrowest budget that is spent", () => {
  const limits = { issuancePerOrg: 30, issuancePlatform: 200 };
  assert.deepEqual(decideIssuanceBudget({ name: 0, organization: 0, platform: 0 }, limits), { granted: true });
  assert.deepEqual(
    decideIssuanceBudget({ name: ISSUANCE_PER_NAME - 1, organization: 29, platform: 199 }, limits),
    { granted: true },
  );
  assert.deepEqual(decideIssuanceBudget({ name: ISSUANCE_PER_NAME, organization: 30, platform: 200 }, limits), {
    granted: false,
    reason: "issuance_budget_domain",
  });
  assert.deepEqual(decideIssuanceBudget({ name: 0, organization: 30, platform: 200 }, limits), {
    granted: false,
    reason: "issuance_budget_organization",
  });
  assert.deepEqual(decideIssuanceBudget({ name: 0, organization: 0, platform: 200 }, limits), {
    granted: false,
    reason: "issuance_budget_platform",
  });
});

test("needsIssuanceBudget: only a certificate observed on the wire is exempt", () => {
  assert.equal(needsIssuanceBudget({ sslStatus: "active" }), false);
  for (const sslStatus of ["pending", "provisioning", "failed", "expired", "anything"]) {
    assert.equal(needsIssuanceBudget({ sslStatus }), true, sslStatus);
  }
});

test("interleaveByOrganization: one row from each organization in turn until the batch is full", () => {
  const big = Array.from({ length: 40 }, (_, i) => `big${i}`);
  assert.deepEqual(interleaveByOrganization([big, ["a0"], ["b0", "b1"]], 6), ["big0", "a0", "b0", "big1", "b1", "big2"]);
  assert.deepEqual(interleaveByOrganization([big, ["a0"]], 2), ["big0", "a0"]);
  assert.deepEqual(interleaveByOrganization([["a0", "a1"]], 50), ["a0", "a1"]);
  assert.deepEqual(interleaveByOrganization([], 50), []);
  assert.deepEqual(interleaveByOrganization([big], 0), []);
  assert.ok(CHECK_BATCH_PER_ORG < 50, "one organization's share is less than a batch");
});

test("reverifyAvailableAt: a new token is spaced from the last one", () => {
  const started = new Date("2026-10-06T12:00:00Z");
  const row = { verificationStartedAt: started };
  assert.deepEqual(reverifyAvailableAt(row, started), new Date(started.getTime() + REVERIFY_SPACING_MS));
  assert.deepEqual(
    reverifyAvailableAt(row, new Date(started.getTime() + REVERIFY_SPACING_MS - 1)),
    new Date(started.getTime() + REVERIFY_SPACING_MS),
  );
  assert.equal(reverifyAvailableAt(row, new Date(started.getTime() + REVERIFY_SPACING_MS)), null);
});
