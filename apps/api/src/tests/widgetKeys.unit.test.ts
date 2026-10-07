import assert from "node:assert/strict";
import test from "node:test";

import {
  generatePublicKey,
  hashBucket,
  ipBucket,
  isPublicKey,
  normalizeOrigin,
  originAllowed,
  UNKNOWN_IP_BUCKET,
} from "../services/widgetKeys.js";

// Drives services/widgetKeys.ts: the publishable key, the origins a key may
// be used from, and how a visitor's address is bucketed for the limiter.

const ok = (input: string) => {
  const result = normalizeOrigin(input);
  assert.ok(result.ok, `${input}: ${result.ok ? "" : result.reason}`);
  return result.origin;
};
const reason = (input: unknown) => {
  const result = normalizeOrigin(input);
  assert.ok(!result.ok, `${String(input)} should be refused`);
  assert.ok(result.message.length > 0);
  return result.reason;
};

test("a publishable key has its own prefix and is never taken for a secret API key", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const key = generatePublicKey();
    assert.match(key, /^wpk_[A-Za-z0-9_-]{32}$/);
    assert.ok(!key.startsWith("wheels_"), "the auth hook reads wheels_ as an API key");
    assert.ok(isPublicKey(key));
    seen.add(key);
  }
  assert.equal(seen.size, 50);
  for (const bad of ["wpk_short", "wheels_live_" + "a".repeat(32), `wpk_${"a".repeat(33)}`, `wpk_${"a".repeat(31)}!`, 42, null]) {
    assert.equal(isPublicKey(bad), false);
  }
});

test("an origin is normalised to lower-case scheme://host[:port]", () => {
  assert.equal(ok("https://Example.COM"), "https://example.com");
  assert.equal(ok("https://example.com/"), "https://example.com");
  assert.equal(ok("  https://shop.example.com:8443  "), "https://shop.example.com:8443");
  assert.equal(ok("https://example.com:443"), "https://example.com", "the default port is not part of an origin");
  assert.equal(ok("http://localhost:3000"), "http://localhost:3000");
  assert.equal(ok("http://127.0.0.1:5173"), "http://127.0.0.1:5173");
  assert.equal(ok("https://*.Example.com"), "https://*.example.com");
  assert.equal(ok("https://*.shop.example.com:8443"), "https://*.shop.example.com:8443");
});

test("anything that is more than an origin is refused, not trimmed to one", () => {
  assert.equal(reason("https://example.com/pricing"), "has_path");
  assert.equal(reason("https://example.com/?a=1"), "has_query");
  assert.equal(reason("https://example.com?a=1"), "has_query");
  assert.equal(reason("https://example.com#top"), "has_fragment");
  assert.equal(reason("https://user:pw@example.com"), "has_userinfo");
  assert.equal(reason("https://user@example.com"), "has_userinfo");
  assert.equal(reason("ftp://example.com"), "scheme_not_allowed");
  assert.equal(reason("javascript://example.com"), "scheme_not_allowed");
  assert.equal(reason("example.com"), "malformed");
  assert.equal(reason("https://"), "malformed");
  assert.equal(reason("https://exa mple.com"), "malformed");
  assert.equal(reason(""), "empty");
  assert.equal(reason(undefined), "empty");
  assert.equal(reason(`https://${"a".repeat(400)}.com`), "too_long");
});

test("http is for localhost only", () => {
  assert.equal(reason("http://example.com"), "http_only_for_localhost");
  assert.equal(reason("http://192.168.1.10"), "http_only_for_localhost");
  assert.equal(reason("http://*.example.com"), "http_only_for_localhost");
  assert.equal(reason("http://localhost.evil.com"), "http_only_for_localhost");
});

test("a wildcard covers whole subdomains of a domain, and nothing broader", () => {
  assert.equal(reason("https://*.com"), "wildcard_too_broad");
  assert.equal(reason("https://*"), "bad_wildcard");
  assert.equal(reason("https://foo.*.example.com"), "bad_wildcard");
  assert.equal(reason("https://*foo.example.com"), "bad_wildcard");
  assert.equal(reason("https://*.*.example.com"), "bad_wildcard");
  assert.equal(reason("https://*.10.0.0.1"), "bad_wildcard");
});

test("originAllowed: exact origins match exactly", () => {
  const allowed = ["https://example.com", "https://shop.example.com:8443"];
  assert.equal(originAllowed("https://example.com", allowed), true);
  assert.equal(originAllowed("https://EXAMPLE.com", allowed), true);
  assert.equal(originAllowed("https://shop.example.com:8443", allowed), true);
  assert.equal(originAllowed("https://shop.example.com", allowed), false, "another port is another origin");
  assert.equal(originAllowed("http://example.com", allowed), false, "another scheme is another origin");
  assert.equal(originAllowed("https://www.example.com", allowed), false);
  assert.equal(originAllowed("https://example.com.evil.net", allowed), false);
});

test("originAllowed: a wildcard matches subdomains, not the apex and not a look-alike", () => {
  const allowed = ["https://*.example.com"];
  assert.equal(originAllowed("https://www.example.com", allowed), true);
  assert.equal(originAllowed("https://a.b.example.com", allowed), true);
  assert.equal(originAllowed("https://example.com", allowed), false, "the apex is listed separately");
  assert.equal(originAllowed("https://evil-example.com", allowed), false);
  assert.equal(originAllowed("https://example.com.evil.net", allowed), false);
  assert.equal(originAllowed("http://www.example.com", allowed), false);
  assert.equal(originAllowed("https://www.example.com:8443", allowed), false);
  assert.equal(originAllowed("https://www.example.com:8443", ["https://*.example.com:8443"]), true);
});

test("originAllowed: no Origin is refused, and the app's own origins always pass", () => {
  assert.equal(originAllowed(undefined, ["https://example.com"]), false);
  assert.equal(originAllowed(null, ["https://example.com"]), false);
  assert.equal(originAllowed("", ["https://example.com"]), false);
  assert.equal(originAllowed("null", ["https://example.com"]), false, "a sandboxed frame sends the literal null");
  assert.equal(originAllowed("not an origin", ["https://example.com"]), false);
  assert.equal(originAllowed("https://example.com/path", ["https://example.com"]), false);

  // A key with no origins refuses every site, and still previews in the dashboard.
  assert.equal(originAllowed("https://example.com", []), false);
  assert.equal(originAllowed("https://app.wheelsai.test", [], ["https://app.wheelsai.test/"]), true);
  assert.equal(originAllowed("http://localhost:3000", [], ["http://localhost:3000", "garbage"]), true);
  assert.equal(originAllowed("https://evil.test", [], ["https://app.wheelsai.test"]), false);
});

test("ipBucket: IPv4 is its own bucket, mapped IPv4 is IPv4, IPv6 is its /64", () => {
  assert.equal(ipBucket("203.0.113.7"), "203.0.113.7");
  assert.equal(ipBucket("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(ipBucket("::FFFF:CB00:7107"), "203.0.113.7");
  assert.equal(ipBucket("[2001:db8:1:2:aaaa:bbbb:cccc:dddd]"), "2001:db8:1:2::/64");

  // A subscriber rotating through its /64 stays in one bucket...
  const one = ipBucket("2001:db8:1:2::1");
  assert.equal(one, "2001:db8:1:2::/64");
  assert.equal(ipBucket("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"), one);
  assert.equal(ipBucket("2001:db8:1:2:1::"), one);
  // ...and the next /64 is somebody else.
  assert.notEqual(ipBucket("2001:db8:1:3::1"), one);
  assert.equal(ipBucket("::1"), "0:0:0:0::/64");
  assert.equal(ipBucket("fe80::1%eth0"), "fe80:0:0:0::/64");
});

test("ipBucket: an address that cannot be read shares one bucket, never a bucket of its own", () => {
  for (const bad of [undefined, null, "", "not-an-ip", "1.2.3", "1.2.3.4.5", "2001:db8::1::2", "12345::"]) {
    assert.equal(ipBucket(bad as string), UNKNOWN_IP_BUCKET);
  }
});

test("hashBucket is keyed and stable, and does not contain the address", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const hashed = hashBucket("203.0.113.7", secret);
  assert.equal(hashed, hashBucket("203.0.113.7", secret));
  assert.notEqual(hashed, hashBucket("203.0.113.8", secret));
  assert.notEqual(hashed, hashBucket("203.0.113.7", "another-secret-of-enough-length"));
  assert.ok(!hashed.includes("203"));
  assert.match(hashed, /^[A-Za-z0-9_-]{22}$/);
  assert.throws(() => hashBucket("203.0.113.7", "short"));
});
