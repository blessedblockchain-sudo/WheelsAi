import assert from "node:assert/strict";
import test from "node:test";

import { createDomainDns, DNS_TIMEOUT_MS, DNS_TRIES, type DnsResolverLike } from "../services/domainDns.js";

// services/domainDns.ts with a fake Resolver: no network. The adapter must
// never throw, and must tell "there is no such record" (absent) apart from
// "DNS did not answer" (transient).

const dnsError = (code: string) => Object.assign(new Error(code), { code });

interface Zone {
  txt?: Record<string, string[][] | string>;
  a?: Record<string, string[] | string>;
  aaaa?: Record<string, string[] | string>;
  soa?: Record<string, true | string>;
  caa?: Record<string, Array<{ issue?: string; issuewild?: string }> | string>;
}

function fakeResolver(zone: Zone) {
  const calls: string[] = [];
  const servers: string[][] = [];
  const answer = <T>(kind: string, table: Record<string, T | string> | undefined, name: string): T => {
    calls.push(`${kind} ${name}`);
    const value = table?.[name];
    if (value === undefined) throw dnsError("ENOTFOUND");
    if (typeof value === "string") throw dnsError(value);
    return value;
  };
  const resolver: DnsResolverLike = {
    setServers: (list) => {
      servers.push(list);
    },
    resolveTxt: async (name) => answer("TXT", zone.txt, name),
    resolve4: async (name) => answer("A", zone.a, name),
    resolve6: async (name) => answer("AAAA", zone.aaaa, name),
    resolveSoa: async (name) => answer("SOA", zone.soa, name),
    resolveCaa: async (name) => answer("CAA", zone.caa, name),
  };
  return { resolver, calls, servers };
}

function dnsFor(zone: Zone, options: { servers?: string[] } = {}) {
  const fake = fakeResolver(zone);
  const created: Array<{ timeout: number; tries: number }> = [];
  const dns = createDomainDns({
    ...options,
    createResolver: (resolverOptions) => {
      created.push(resolverOptions);
      return fake.resolver;
    },
  });
  return { dns, created, ...fake };
}

test("the resolver gets the configured servers, a timeout and a retry count", async () => {
  const { dns, created, servers } = dnsFor({}, { servers: ["1.1.1.1", "8.8.8.8"] });
  await dns.lookupTxt("_wheels-verification.api.customer.com");
  await dns.lookupAddresses("api.customer.com");
  // One resolver, configured once.
  assert.deepEqual(created, [{ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES }]);
  assert.deepEqual(servers, [["1.1.1.1", "8.8.8.8"]]);
  assert.equal(DNS_TIMEOUT_MS, 3_000);
  assert.equal(DNS_TRIES, 2);
});

test("without configured servers the host's resolvers are left alone", async () => {
  const { dns, servers } = dnsFor({});
  await dns.lookupTxt("x.customer.com");
  assert.deepEqual(servers, []);
});

test("lookupTxt: found (chunks intact), absent, transient", async () => {
  const { dns } = dnsFor({
    txt: {
      "found.customer.com": [["part-one-", "part-two"], ["v=spf1 -all"]],
      "empty.customer.com": [],
      "nodata.customer.com": "ENODATA",
      "servfail.customer.com": "ESERVFAIL",
      "timeout.customer.com": "ETIMEOUT",
    },
  });
  assert.deepEqual(await dns.lookupTxt("found.customer.com"), {
    kind: "found",
    records: [["part-one-", "part-two"], ["v=spf1 -all"]],
  });
  assert.deepEqual(await dns.lookupTxt("empty.customer.com"), { kind: "absent" });
  assert.deepEqual(await dns.lookupTxt("nodata.customer.com"), { kind: "absent" });
  assert.deepEqual(await dns.lookupTxt("nxdomain.customer.com"), { kind: "absent" });
  assert.deepEqual(await dns.lookupTxt("servfail.customer.com"), { kind: "transient", code: "ESERVFAIL" });
  assert.deepEqual(await dns.lookupTxt("timeout.customer.com"), { kind: "transient", code: "ETIMEOUT" });
});

test("lookupAddresses returns the union of A and AAAA", async () => {
  const { dns, calls } = dnsFor({
    a: { "both.customer.com": ["137.66.10.1", "137.66.10.2"], "v4.customer.com": ["137.66.10.1"] },
    aaaa: { "both.customer.com": ["2a09:8280:1::a:1"], "v4.customer.com": "ENODATA", "v6.customer.com": ["2a09:8280:1::a:1"] },
  });
  assert.deepEqual(await dns.lookupAddresses("both.customer.com"), {
    kind: "found",
    addresses: ["137.66.10.1", "137.66.10.2", "2a09:8280:1::a:1"],
  });
  assert.deepEqual(await dns.lookupAddresses("v4.customer.com"), { kind: "found", addresses: ["137.66.10.1"] });
  assert.deepEqual(await dns.lookupAddresses("v6.customer.com"), { kind: "found", addresses: ["2a09:8280:1::a:1"] });
  assert.deepEqual(await dns.lookupAddresses("nothing.customer.com"), { kind: "absent" });
  assert.ok(calls.includes("A both.customer.com") && calls.includes("AAAA both.customer.com"));
});

test("lookupAddresses: half an answer is no answer", async () => {
  const { dns } = dnsFor({
    a: { "half.customer.com": ["137.66.10.1"], "other.customer.com": "ETIMEOUT" },
    aaaa: { "half.customer.com": "ESERVFAIL", "other.customer.com": ["2a09:8280:1::a:1"] },
  });
  // The family that failed might point anywhere, so "routed" cannot be concluded.
  assert.deepEqual(await dns.lookupAddresses("half.customer.com"), { kind: "transient", code: "ESERVFAIL" });
  assert.deepEqual(await dns.lookupAddresses("other.customer.com"), { kind: "transient", code: "ETIMEOUT" });
});

test("isZoneApex: an SOA at the name means apex; NODATA means not; anything else is unknown", async () => {
  const { dns } = dnsFor({
    soa: { "customer.com": true, "api.customer.com": "ENODATA", "broken.customer.com": "ESERVFAIL" },
  });
  assert.equal(await dns.isZoneApex("customer.com"), true);
  assert.equal(await dns.isZoneApex("api.customer.com"), false);
  assert.equal(await dns.isZoneApex("broken.customer.com"), null);
  assert.equal(await dns.isZoneApex("nxdomain.customer.com"), null);
});

test("lookupCaa walks up to the closest ancestor that has records, stopping before the TLD", async () => {
  const { dns, calls } = dnsFor({
    caa: {
      "deep.api.customer.com": "ENODATA",
      "api.customer.com": [],
      "customer.com": [{ issue: "digicert.com" }],
    },
  });
  assert.deepEqual(await dns.lookupCaa("deep.api.customer.com"), {
    kind: "found",
    name: "customer.com",
    records: [{ issue: "digicert.com" }],
  });
  assert.deepEqual(
    calls.filter((c) => c.startsWith("CAA")),
    ["CAA deep.api.customer.com", "CAA api.customer.com", "CAA customer.com"],
  );

  const none = dnsFor({});
  assert.deepEqual(await none.dns.lookupCaa("api.other.org"), { kind: "absent" });
  assert.deepEqual(none.calls, ["CAA api.other.org", "CAA other.org"]);

  const broken = dnsFor({ caa: { "api.customer.com": "ETIMEOUT" } });
  assert.deepEqual(await broken.dns.lookupCaa("api.customer.com"), { kind: "transient", code: "ETIMEOUT" });
});

test("caaDiagnostic: a sentence only when the governing records exclude the authority", async () => {
  const { dns } = dnsFor({
    caa: {
      "blocked.com": [{ issue: "digicert.com" }],
      "allowed.com": [{ issue: "letsencrypt.org" }],
      "broken.com": "ESERVFAIL",
    },
  });
  const message = await dns.caaDiagnostic("api.blocked.com", "letsencrypt.org");
  assert.match(message ?? "", /CAA records on blocked\.com do not allow letsencrypt\.org/);
  assert.equal(await dns.caaDiagnostic("api.allowed.com", "letsencrypt.org"), null);
  assert.equal(await dns.caaDiagnostic("api.nocaa.com", "letsencrypt.org"), null);
  // Not knowing is not a diagnosis.
  assert.equal(await dns.caaDiagnostic("api.broken.com", "letsencrypt.org"), null);
});

test("nothing throws: resolver methods that throw, reject oddly, or cannot be built", async () => {
  const hostile: DnsResolverLike = {
    setServers: () => undefined,
    resolveTxt: () => {
      throw new TypeError("synchronous throw");
    },
    resolve4: () => Promise.reject("a string, not an Error"),
    resolve6: () => Promise.reject(null),
    resolveSoa: () => Promise.reject(undefined),
    resolveCaa: () => {
      throw dnsError("ECANCELLED");
    },
  };
  const dns = createDomainDns({ createResolver: () => hostile });
  assert.deepEqual(await dns.lookupTxt("x.customer.com"), { kind: "transient", code: "EUNKNOWN" });
  assert.deepEqual(await dns.lookupAddresses("x.customer.com"), { kind: "transient", code: "EUNKNOWN" });
  assert.equal(await dns.isZoneApex("x.customer.com"), null);
  assert.deepEqual(await dns.lookupCaa("x.customer.com"), { kind: "transient", code: "ECANCELLED" });
  assert.equal(await dns.caaDiagnostic("x.customer.com", "letsencrypt.org"), null);

  // A resolver that cannot even be configured (a bad server address).
  const unbuildable = createDomainDns({
    servers: ["not-an-ip"],
    createResolver: () => ({
      ...hostile,
      setServers: () => {
        throw dnsError("ERR_INVALID_IP_ADDRESS");
      },
    }),
  });
  assert.deepEqual(await unbuildable.lookupTxt("x.customer.com"), {
    kind: "transient",
    code: "ERR_INVALID_IP_ADDRESS",
  });
  assert.equal(await unbuildable.isZoneApex("x.customer.com"), null);
});

test("the real Resolver is constructed with a bad server without throwing or touching the network", async () => {
  const dns = createDomainDns({ servers: ["definitely not an address"] });
  const result = await dns.lookupTxt("x.customer.com");
  assert.equal(result.kind, "transient");
});
