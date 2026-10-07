import assert from "node:assert/strict";
import test from "node:test";

import { loadCustomDomainConfig } from "../config/customDomains.js";

// config/customDomains.ts: custom domains need an edge the founder has not
// set up yet. Until every edge setting is present and valid the feature is
// unavailable WITH A REASON - never half-working, never boot-fatal.

const ASK = "a".repeat(32);
const SECRET = "b".repeat(32);
const FULL = {
  CUSTOM_DOMAIN_EDGE_HOSTNAME: "edge.wheelsai.io",
  CUSTOM_DOMAIN_EDGE_IPV4: "137.66.10.1",
  CUSTOM_DOMAIN_EDGE_IPV6: "2a09:8280:1::a:1",
  CUSTOM_DOMAIN_ASK_TOKEN: ASK,
  CUSTOM_DOMAIN_EDGE_SECRET: SECRET,
};

function misconfigured(env: Record<string, string | undefined>, pattern: RegExp) {
  const config = loadCustomDomainConfig(env);
  assert.equal(config.edge, null);
  assert.match(config.error ?? "", pattern);
  assert.match(config.unavailableReason ?? "", /misconfigured/);
  // A misconfigured server must not run the checker either.
  assert.equal(config.checkIntervalMs, 0);
}

test("nothing set: unavailable with a reason, and no error", () => {
  const config = loadCustomDomainConfig({});
  assert.equal(config.edge, null);
  assert.equal(config.error, null);
  assert.match(config.unavailableReason ?? "", /not configured on this server/);
  assert.match(config.unavailableReason ?? "", /CUSTOM_DOMAIN_EDGE_HOSTNAME/);
});

test("empty strings count as unset", () => {
  const config = loadCustomDomainConfig({
    CUSTOM_DOMAIN_EDGE_HOSTNAME: "",
    CUSTOM_DOMAIN_ASK_TOKEN: "  ",
  });
  assert.equal(config.edge, null);
  assert.equal(config.error, null);
});

test("a complete configuration yields the edge and no reason", () => {
  const config = loadCustomDomainConfig({
    ...FULL,
    CUSTOM_DOMAIN_EDGE_HOSTNAME: "Edge.WheelsAI.io.",
    CUSTOM_DOMAIN_EDGE_IPV4: "137.66.10.1, 137.66.10.2",
  });
  assert.deepEqual(config.edge, {
    hostname: "edge.wheelsai.io",
    ipv4: ["137.66.10.1", "137.66.10.2"],
    ipv6: ["2a09:8280:1::a:1"],
    askToken: ASK,
    edgeSecret: SECRET,
  });
  assert.equal(config.unavailableReason, null);
  assert.equal(config.error, null);
});

test("one address family is enough", () => {
  assert.ok(loadCustomDomainConfig({ ...FULL, CUSTOM_DOMAIN_EDGE_IPV6: undefined }).edge);
  assert.ok(loadCustomDomainConfig({ ...FULL, CUSTOM_DOMAIN_EDGE_IPV4: undefined }).edge);
});

test("a partial configuration is misconfigured and names what is missing", () => {
  misconfigured(
    { CUSTOM_DOMAIN_EDGE_HOSTNAME: "edge.wheelsai.io" },
    /partly configured.*CUSTOM_DOMAIN_EDGE_IPV4 or CUSTOM_DOMAIN_EDGE_IPV6.*CUSTOM_DOMAIN_ASK_TOKEN.*CUSTOM_DOMAIN_EDGE_SECRET/,
  );
  misconfigured({ ...FULL, CUSTOM_DOMAIN_EDGE_SECRET: undefined }, /missing CUSTOM_DOMAIN_EDGE_SECRET/);
  misconfigured(
    { ...FULL, CUSTOM_DOMAIN_EDGE_IPV4: undefined, CUSTOM_DOMAIN_EDGE_IPV6: undefined },
    /missing CUSTOM_DOMAIN_EDGE_IPV4 or CUSTOM_DOMAIN_EDGE_IPV6/,
  );
});

test("short or shared secrets are refused", () => {
  misconfigured({ ...FULL, CUSTOM_DOMAIN_ASK_TOKEN: "short" }, /CUSTOM_DOMAIN_ASK_TOKEN must be at least 32/);
  misconfigured({ ...FULL, CUSTOM_DOMAIN_EDGE_SECRET: "c".repeat(31) }, /CUSTOM_DOMAIN_EDGE_SECRET must be at least 32/);
  misconfigured({ ...FULL, CUSTOM_DOMAIN_EDGE_SECRET: ASK }, /must be different values/);
});

test("edge addresses must be public and of the right family", () => {
  for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.1", "0.0.0.0"]) {
    misconfigured({ ...FULL, CUSTOM_DOMAIN_EDGE_IPV4: address }, /not a public address/);
  }
  for (const address of ["::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "fdaa:0:1::3"]) {
    misconfigured({ ...FULL, CUSTOM_DOMAIN_EDGE_IPV6: address }, /not a public address/);
  }
  misconfigured({ ...FULL, CUSTOM_DOMAIN_EDGE_IPV4: "2a09:8280:1::a:1" }, /not an IPv4 address/);
  misconfigured({ ...FULL, CUSTOM_DOMAIN_EDGE_IPV6: "137.66.10.1" }, /not an IPv6 address/);
  misconfigured({ ...FULL, CUSTOM_DOMAIN_EDGE_IPV4: "edge.wheelsai.io" }, /not an IPv4 address/);
});

test("the edge hostname must be a DNS name", () => {
  for (const hostname of ["https://edge.wheelsai.io", "edge", "137.66.10.1", "edge_.wheelsai.io", "-edge.wheelsai.io"]) {
    misconfigured({ ...FULL, CUSTOM_DOMAIN_EDGE_HOSTNAME: hostname }, /not a valid DNS name/);
  }
});

test("the check interval defaults to 60000 and 0 disables it", () => {
  assert.equal(loadCustomDomainConfig(FULL).checkIntervalMs, 60_000);
  assert.equal(loadCustomDomainConfig({ ...FULL, CUSTOM_DOMAIN_CHECK_INTERVAL_MS: "0" }).checkIntervalMs, 0);
  assert.equal(loadCustomDomainConfig({ ...FULL, CUSTOM_DOMAIN_CHECK_INTERVAL_MS: "15000" }).checkIntervalMs, 15_000);
  // 0 disables the worker, not the feature.
  assert.ok(loadCustomDomainConfig({ ...FULL, CUSTOM_DOMAIN_CHECK_INTERVAL_MS: "0" }).edge);
  misconfigured({ ...FULL, CUSTOM_DOMAIN_CHECK_INTERVAL_MS: "100" }, /0 \(disabled\) or at least 5000/);
  misconfigured({ ...FULL, CUSTOM_DOMAIN_CHECK_INTERVAL_MS: "soon" }, /whole number/);
});

test("the other timings have defaults and ranges", () => {
  const config = loadCustomDomainConfig(FULL);
  assert.equal(config.routeRefreshMs, 10_000);
  assert.equal(config.probeTimeoutMs, 20_000);
  assert.deepEqual(config.dnsServers, []);
  assert.equal(config.extraCaPem, null);
  misconfigured({ ...FULL, CUSTOM_DOMAIN_ROUTE_REFRESH_MS: "5" }, /CUSTOM_DOMAIN_ROUTE_REFRESH_MS must be between/);
  misconfigured({ ...FULL, CUSTOM_DOMAIN_PROBE_TIMEOUT_MS: "999999" }, /CUSTOM_DOMAIN_PROBE_TIMEOUT_MS must be between/);
});

test("DNS servers are a list of IP addresses", () => {
  assert.deepEqual(
    loadCustomDomainConfig({ ...FULL, CUSTOM_DOMAIN_DNS_SERVERS: "1.1.1.1, 2606:4700:4700::1111" }).dnsServers,
    ["1.1.1.1", "2606:4700:4700::1111"],
  );
  misconfigured({ ...FULL, CUSTOM_DOMAIN_DNS_SERVERS: "dns.google" }, /CUSTOM_DOMAIN_DNS_SERVERS entry/);
});

test("an extra probe CA is accepted outside production and refused in production", () => {
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
  const staging = loadCustomDomainConfig({ ...FULL, NODE_ENV: "staging", CUSTOM_DOMAIN_PROBE_EXTRA_CA_PEM: pem });
  assert.equal(staging.extraCaPem, pem);
  assert.ok(staging.edge);

  const production = loadCustomDomainConfig({
    ...FULL,
    NODE_ENV: "production",
    CUSTOM_DOMAIN_PROBE_EXTRA_CA_PEM: pem,
  });
  assert.equal(production.edge, null);
  assert.equal(production.extraCaPem, null);
  assert.match(production.error ?? "", /refused in production/);

  misconfigured({ ...FULL, CUSTOM_DOMAIN_PROBE_EXTRA_CA_PEM: "not a pem" }, /not a PEM certificate/);
});

test("loading never throws, whatever the input", () => {
  assert.doesNotThrow(() =>
    loadCustomDomainConfig({
      CUSTOM_DOMAIN_EDGE_HOSTNAME: "\u0000",
      CUSTOM_DOMAIN_EDGE_IPV4: ",,,",
      CUSTOM_DOMAIN_CHECK_INTERVAL_MS: "-1",
    }),
  );
});

test("the shared-capacity limits have defaults, can be set, and a bad value is a misconfiguration", () => {
  assert.deepEqual(loadCustomDomainConfig(FULL).limits, {
    maxDomainsPerOrg: 25,
    issuancePerOrg: 30,
    issuancePlatform: 200,
  });
  // Unset edge, still the limits: GET /config states them either way.
  assert.equal(loadCustomDomainConfig({}).limits.maxDomainsPerOrg, 25);

  const set = loadCustomDomainConfig({
    ...FULL,
    CUSTOM_DOMAIN_MAX_PER_ORG: "100",
    CUSTOM_DOMAIN_ISSUANCE_ORG_LIMIT: "10",
    CUSTOM_DOMAIN_ISSUANCE_PLATFORM_LIMIT: "150",
  });
  assert.ok(set.edge);
  assert.deepEqual(set.limits, { maxDomainsPerOrg: 100, issuancePerOrg: 10, issuancePlatform: 150 });

  // "0" or "unlimited" must not silently switch a protection off.
  for (const name of [
    "CUSTOM_DOMAIN_MAX_PER_ORG",
    "CUSTOM_DOMAIN_ISSUANCE_ORG_LIMIT",
    "CUSTOM_DOMAIN_ISSUANCE_PLATFORM_LIMIT",
  ]) {
    for (const bad of ["0", "-1", "unlimited", "10001"]) {
      const config = loadCustomDomainConfig({ ...FULL, [name]: bad });
      assert.equal(config.edge, null, `${name}=${bad}`);
      assert.match(config.error ?? "", new RegExp(name));
      assert.equal(config.limits.maxDomainsPerOrg, 25);
    }
  }
  assert.doesNotMatch(loadCustomDomainConfig({ ...FULL, CUSTOM_DOMAIN_MAX_PER_ORG: "x" }).error ?? "", /milliseconds/);
});
