import assert from "node:assert/strict";
import test from "node:test";

import {
  assertUrlAllowed,
  classifyIp,
  safeFetch,
  SsrfBlockedError,
} from "../lib/ssrfGuard.js";

// Drives apps/api/src/lib/ssrfGuard.ts. The guard this replaced compared
// HOSTNAMES against a short blocklist, which three things walked past:
// DNS (a public name resolving to 127.0.0.1), encodings
// (http://2130706433/), and redirects (a public URL 302ing inward).
// Each of those is a test below.

// ============================================
// IP classification
// ============================================

test("loopback is blocked in every encoding, not just 127.0.0.1", () => {
  for (const ip of ["127.0.0.1", "127.1.2.3", "127.255.255.254"]) {
    assert.equal(classifyIp(ip), "blocked", ip);
  }
  assert.equal(classifyIp("::1"), "blocked", "IPv6 loopback");
  assert.equal(classifyIp("::ffff:127.0.0.1"), "blocked", "IPv4-mapped loopback");
});

test("cloud metadata and link-local are blocked", () => {
  assert.equal(classifyIp("169.254.169.254"), "blocked", "AWS/GCP metadata");
  assert.equal(classifyIp("169.254.0.1"), "blocked");
  assert.equal(classifyIp("fe80::1"), "blocked", "IPv6 link-local");
});

test("private ranges are blocked, including CGNAT", () => {
  for (const ip of [
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "fc00::1",
    "fd12:3456::1",
  ]) {
    assert.equal(classifyIp(ip), "blocked", ip);
  }
});

test("the old check's over-block is corrected: 172.32+ is public", () => {
  // The previous guard used hostname.startsWith("172."), blocking the
  // whole /8 — 172.32.0.0+ is ordinary public space.
  assert.equal(classifyIp("172.32.0.1"), "public");
  assert.equal(classifyIp("172.15.255.255"), "public");
});

test("ordinary public addresses pass", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"]) {
    assert.equal(classifyIp(ip), "public", ip);
  }
});

test("multicast and reserved space is blocked", () => {
  assert.equal(classifyIp("224.0.0.1"), "blocked");
  assert.equal(classifyIp("255.255.255.255"), "blocked");
  assert.equal(classifyIp("ff02::1"), "blocked");
});

// ============================================
// URL validation
// ============================================

const publicDns = async () => ["93.184.216.34"];

test("non-http schemes are refused — file:// is a classic escalation", async () => {
  for (const url of ["file:///etc/passwd", "gopher://x/", "ftp://x/"]) {
    const verdict = await assertUrlAllowed(url, { resolveHost: publicDns });
    assert.equal(verdict.ok, false, url);
  }
});

test("embedded credentials are refused", async () => {
  const verdict = await assertUrlAllowed("http://user:pass@example.com/", {
    resolveHost: publicDns,
  });
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /credentials/);
});

test("THE DNS BYPASS: a public hostname resolving to loopback is refused", async () => {
  // This is the bypass the hostname-only guard could not see.
  const verdict = await assertUrlAllowed("http://totally-innocent.com/", {
    resolveHost: async () => ["127.0.0.1"],
  });
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /127\.0\.0\.1/);
});

test("a hostname with ANY internal address is refused, even alongside public ones", async () => {
  // We cannot control which record the socket picks, so one bad answer
  // poisons the name.
  const verdict = await assertUrlAllowed("http://split-horizon.com/", {
    resolveHost: async () => ["93.184.216.34", "10.0.0.5"],
  });
  assert.equal(verdict.ok, false);
});

test("THE ENCODING BYPASS: integer and short-form loopback literals are refused", async () => {
  // http://127.1/ is loopback; a prefix check for "127.0.0.1" misses it.
  const short = await assertUrlAllowed("http://127.1/", { resolveHost: publicDns });
  assert.equal(short.ok, false);
  const v6 = await assertUrlAllowed("http://[::1]/", { resolveHost: publicDns });
  assert.equal(v6.ok, false, "bracketed IPv6 loopback");
});

test("localhost and metadata hostnames are refused without DNS", async () => {
  for (const host of [
    "http://localhost:6379/",
    "http://metadata.google.internal/",
    "http://app.localhost/",
  ]) {
    const verdict = await assertUrlAllowed(host, {
      resolveHost: async () => {
        throw new Error("DNS must not be consulted for known-internal names");
      },
    });
    assert.equal(verdict.ok, false, host);
  }
});

test("an unresolvable host is refused rather than attempted", async () => {
  const verdict = await assertUrlAllowed("http://nope.invalid/", {
    resolveHost: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  assert.equal(verdict.ok, false);
});

test("a genuinely public URL is allowed", async () => {
  const verdict = await assertUrlAllowed("https://example.com/webhook", {
    resolveHost: publicDns,
  });
  assert.equal(verdict.ok, true);
});

// ============================================
// safeFetch — redirects
// ============================================

function jsonOk(body = "ok"): Response {
  return new Response(body, { status: 200 });
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

test("safeFetch never auto-follows: redirect mode is manual", async () => {
  let sawInit: RequestInit | undefined;
  await safeFetch("https://example.com/", {
    guardDeps: { resolveHost: publicDns },
    fetchImpl: (async (_u: string, init: RequestInit) => {
      sawInit = init;
      return jsonOk();
    }) as unknown as typeof fetch,
  });
  assert.equal(sawInit?.redirect, "manual");
});

test("THE REDIRECT BYPASS: a public URL 302ing to metadata is blocked at the hop", async () => {
  let hops = 0;
  await assert.rejects(
    safeFetch("https://example.com/", {
      guardDeps: { resolveHost: publicDns },
      fetchImpl: (async () => {
        hops += 1;
        return redirectTo("http://169.254.169.254/latest/meta-data/");
      }) as unknown as typeof fetch,
    }),
    (err: unknown) =>
      err instanceof SsrfBlockedError && /169\.254\.169\.254/.test(err.message),
  );
  assert.equal(hops, 1, "the internal hop was never actually requested");
});

test("a redirect to another public URL is followed and re-validated", async () => {
  const requested: string[] = [];
  const res = await safeFetch("https://example.com/a", {
    guardDeps: { resolveHost: publicDns },
    fetchImpl: (async (u: string) => {
      requested.push(u);
      return requested.length === 1
        ? redirectTo("https://example.com/b")
        : jsonOk("final");
    }) as unknown as typeof fetch,
  });
  assert.equal(await res.text(), "final");
  assert.deepEqual(requested, ["https://example.com/a", "https://example.com/b"]);
});

test("a redirect loop is capped rather than spinning", async () => {
  await assert.rejects(
    safeFetch("https://example.com/", {
      maxRedirects: 2,
      guardDeps: { resolveHost: publicDns },
      fetchImpl: (async () =>
        redirectTo("https://example.com/again")) as unknown as typeof fetch,
    }),
    /too many redirects/,
  );
});

test("a relative redirect is resolved against the current URL before validation", async () => {
  const requested: string[] = [];
  await safeFetch("https://example.com/a/b", {
    guardDeps: { resolveHost: publicDns },
    fetchImpl: (async (u: string) => {
      requested.push(u);
      return requested.length === 1 ? redirectTo("/c") : jsonOk();
    }) as unknown as typeof fetch,
  });
  assert.equal(requested[1], "https://example.com/c");
});
